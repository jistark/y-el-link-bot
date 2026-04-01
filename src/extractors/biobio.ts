import type { Article } from '../types.js';

/**
 * Remove all div blocks with a specific class by tracking div nesting depth.
 * Avoids greedy regex that can cross between multiple blocks.
 */
function removeDivBlocks(html: string, className: string): string {
  const marker = `<div class="${className}"`;
  let result = html;
  let idx = result.indexOf(marker);
  while (idx !== -1) {
    let depth = 0;
    let pos = idx;
    let endPos = -1;
    while (pos < result.length) {
      const nextOpen = result.indexOf('<div', pos + 1);
      const nextClose = result.indexOf('</div>', pos + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen;
      } else {
        if (depth === 0) {
          endPos = nextClose + '</div>'.length;
          break;
        }
        depth--;
        pos = nextClose;
      }
    }
    if (endPos > idx) {
      result = result.slice(0, idx) + result.slice(endPos);
    } else {
      break;
    }
    idx = result.indexOf(marker);
  }
  return result;
}

/**
 * Clean BioBio content HTML: remove ads, social embeds, lee-tambien blocks,
 * convert destacadores and headings for Telegraph.
 */
function cleanContent(contentHtml: string): string {
  let c = contentHtml;
  // Social embeds
  c = c.replace(/<blockquote class="twitter-tweet"[\s\S]*?<\/blockquote>/gi, '');
  c = c.replace(/<blockquote class="instagram-media"[\s\S]*?<\/blockquote>/gi, '');
  c = c.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  c = c.replace(/<figure class="wp-block-embed[\s\S]*?<\/figure>/gi, '');
  c = c.replace(/<input[^>]*>/gi, '');
  // Lee-tambien blocks (depth-tracked removal)
  c = removeDivBlocks(c, 'lee-tambien-bbcl');
  c = removeDivBlocks(c, 'lee-tambien-block');
  c = removeDivBlocks(c, 'related-box');
  // Ads
  c = c.replace(/<div class="ads-[^"]*"[^>]*>\s*<\/div>/gi, '');
  // Destacadores → énfasis
  c = c.replace(/<span class="destacador">([^<]+)<\/span>/gi, '<em>$1</em>');
  // h2 → h3 para Telegraph
  c = c.replace(/<h2[^>]*>([^<]+)<\/h2>/g, '<h3>$1</h3>');
  return c;
}

/**
 * Extract ordered paragraphs and headings from cleaned HTML.
 */
function extractElements(contentHtml: string): string {
  const elements: { pos: number; html: string }[] = [];

  // h3
  const h3Regex = /<h3>([^<]+)<\/h3>/gi;
  let h3Match;
  while ((h3Match = h3Regex.exec(contentHtml)) !== null) {
    elements.push({ pos: h3Match.index, html: `<h3>${h3Match[1]}</h3>` });
  }

  // Párrafos (con o sin atributos)
  const pRegex = /<p[^>]*>([^<]*(?:<(?!\/p>)[^<]*)*)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(contentHtml)) !== null) {
    let text = pMatch[1];
    // Mantener em/strong, limpiar el resto
    text = text.replace(/<(?!em|\/em|strong|\/strong)[^>]+>/g, '');
    text = text.replace(/&#8220;/g, '\u201c').replace(/&#8221;/g, '\u201d');
    text = text.replace(/&#8216;/g, '\u2018').replace(/&#8217;/g, '\u2019');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.trim();
    if (text && text.length > 10) {
      elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
    }
  }

  elements.sort((a, b) => a.pos - b.pos);
  return elements.map(e => e.html).join('\n');
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();
  const isPagina7 = url.includes('pagina7.cl');

  // JSON-LD: fuente primaria de metadata y contenido
  // BioBio usa objeto directo {}, Pagina7 usa @graph []
  let title: string | undefined;
  let subtitle: string | undefined;
  let author: string | undefined;
  let date: string | undefined;
  let imageUrl: string | undefined;
  let jsonLdBody: string | undefined;

  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);

      // Find the NewsArticle — could be root object, in @graph, or in an array
      let article: any = null;
      const graph: any[] = data['@graph'] || [];
      if (graph.length > 0) {
        article = graph.find((item: any) => item['@type'] === 'NewsArticle' || item['@type'] === 'Article');
      } else if (data['@type'] === 'NewsArticle' || data['@type'] === 'Article') {
        article = data;
      }

      if (article && !title) {
        title = article.headline;
        date = article.datePublished;
        // Description como subtitle
        if (article.description) {
          const desc = article.description.replace(/<[^>]+>/g, '').trim();
          if (!desc.endsWith('...')) subtitle = desc;
        }
        // Author: puede ser directo o referencia a Person en @graph
        if (article.author?.name) {
          author = article.author.name;
        } else if (article.author?.['@id'] && graph) {
          const person = graph.find((item: any) => item['@id'] === article.author['@id']);
          if (person?.name) author = person.name;
        }
        // Imagen: puede ser directa o referencia en @graph
        if (article.image?.url) {
          imageUrl = article.image.url;
        } else if (article.image?.['@id'] && graph) {
          const imgNode = graph.find((item: any) => item['@id'] === article.image['@id']);
          if (imgNode?.url) imageUrl = imgNode.url;
        }
        // articleBody (BioBio tiene HTML completo, Pagina7 tiene vacío)
        if (article.articleBody && article.articleBody.length > 100) {
          jsonLdBody = article.articleBody;
        }
      }
    } catch {
      // JSON inválido
    }
  }

  // Fallback metadata desde meta tags
  if (!title) {
    const titleMatch = html.match(/<meta property="og:title" content=['"]([^'"]+)['"]/);
    title = titleMatch?.[1];
  }
  if (!title) {
    throw new Error('No se pudo extraer el título del artículo');
  }
  if (!author) {
    const authorMatch = html.match(/<meta property="article:author" content="([^"]+)"/);
    author = authorMatch?.[1];
  }
  if (!imageUrl) {
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    imageUrl = imageMatch?.[1];
  }

  // Contenido: para BioBio, preferir JSON-LD articleBody si disponible
  // Para Pagina7, usar HTML (no tiene JSON-LD articleBody)
  let contentHtml = '';

  if (isPagina7) {
    const contentMatch = html.match(
      /<div class="main-single__text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/
    );
    if (contentMatch) {
      contentHtml = contentMatch[1];
    }
  } else if (jsonLdBody) {
    // JSON-LD articleBody tiene el contenido completo con HTML
    contentHtml = jsonLdBody;
  }

  // Fallback: HTML parsing de banners-contenido-nota
  if (!contentHtml && !isPagina7) {
    let contentMatch = html.match(
      /<div[^>]*class="banners-contenido-nota-\d+[^"]*"[^>]*>([\s\S]+?)<div class="contenedor-correcciones/
    );
    if (!contentMatch) {
      contentMatch = html.match(
        /<div[^>]*class="contenido-nota banners-contenido-nota"[^>]*>([\s\S]+?)<div class="contenedor-correcciones/
      );
    }
    if (!contentMatch) {
      contentMatch = html.match(
        /<div[^>]*class="banners-contenido-nota-\d+[^"]*"[^>]*>([\s\S]+?)(?:<div class="section-body"|<\/article>)/
      );
    }
    if (contentMatch) {
      contentHtml = contentMatch[1];
    }
  }

  if (!contentHtml) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Limpiar y extraer
  contentHtml = cleanContent(contentHtml);
  const body = extractElements(contentHtml);

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const images: Article['images'] = [];
  if (imageUrl) {
    images.push({ url: imageUrl });
  }

  return {
    title,
    subtitle,
    author,
    date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'biobio',
  };
}

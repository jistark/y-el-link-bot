import type { Article } from '../types.js';

/**
 * Remove all div blocks with a specific class by tracking div nesting depth.
 * This avoids the regex [\s\S]*?</div></div></div> pattern which can cross
 * between multiple blocks and eat content in between.
 */
function removeDivBlocks(html: string, className: string): string {
  const marker = `<div class="${className}"`;
  let result = html;
  let idx = result.indexOf(marker);
  while (idx !== -1) {
    // Find the end of this div block by counting nested divs
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
      break; // malformed HTML, bail
    }
    idx = result.indexOf(marker);
  }
  return result;
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();
  const isPagina7 = url.includes('pagina7.cl');

  // JSON-LD para metadatos
  const jsonLdMatch = html.match(
    /<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/
  );

  let title: string | undefined;
  let date: string | undefined;
  let jsonLdBody: string | undefined;

  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      title = data.headline;
      date = data.datePublished;
      // Guardar articleBody del JSON-LD como fallback
      if (data.articleBody && data.articleBody.length > 100) {
        jsonLdBody = data.articleBody;
      }
    } catch {
      // JSON inválido
    }
  }

  // Fallback título
  if (!title) {
    const titleMatch = html.match(/<meta property="og:title" content=['"]([^'"]+)['"]/);
    title = titleMatch?.[1];
  }

  if (!title) {
    throw new Error('No se pudo extraer el título del artículo');
  }

  // Autor
  const authorMatch = html.match(/<meta property="article:author" content="([^"]+)"/);
  const author = authorMatch?.[1];

  // Imagen
  const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  const imageUrl = imageMatch?.[1];

  // Contenido - diferente según el sitio
  let contentHtml = '';

  if (isPagina7) {
    // Pagina7: buscar en main-single__text
    const contentMatch = html.match(
      /<div class="main-single__text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/
    );
    if (contentMatch) {
      contentHtml = contentMatch[1];
    }
  } else {
    // BioBioChile: buscar en banners-contenido-nota, terminar en contenedor-correcciones
    // La clase puede tener sufijos extra: "banners-contenido-nota-123 nota-content"
    let contentMatch = html.match(
      /<div[^>]*class="banners-contenido-nota-\d+[^"]*"[^>]*>([\s\S]+?)<div class="contenedor-correcciones/
    );
    // Patrón 2: sin número (noticias nuevas - dopamina, etc)
    if (!contentMatch) {
      contentMatch = html.match(
        /<div[^>]*class="contenido-nota banners-contenido-nota"[^>]*>([\s\S]+?)<div class="contenedor-correcciones/
      );
    }
    // Patrón 3: BioBioTV y otros sin contenedor-correcciones — el div puede tener id antes de class
    if (!contentMatch) {
      contentMatch = html.match(
        /<div[^>]*class="banners-contenido-nota-\d+[^"]*"[^>]*>([\s\S]+?)(?:<div class="section-body"|<\/article>)/
      );
    }
    if (contentMatch) {
      contentHtml = contentMatch[1];
    }
  }

  // Fallback: usar articleBody del JSON-LD si el HTML parsing no encontró contenido
  if (!contentHtml && jsonLdBody) {
    contentHtml = jsonLdBody;
  }

  if (!contentHtml) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Limpiar elementos no deseados (común a ambos)
  contentHtml = contentHtml.replace(/<blockquote class="twitter-tweet"[\s\S]*?<\/blockquote>/gi, '');
  contentHtml = contentHtml.replace(/<blockquote class="instagram-media"[\s\S]*?<\/blockquote>/gi, '');
  contentHtml = contentHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  contentHtml = contentHtml.replace(/<figure class="wp-block-embed[\s\S]*?<\/figure>/gi, '');
  contentHtml = contentHtml.replace(/<input[^>]*>/gi, '');

  // BioBio específico: remover bloques "lee también" sin comerse contenido intermedio
  // El regex lazy [\s\S]*?</div></div></div> puede cruzar entre múltiples bloques lee-tambien,
  // así que removemos cada uno individualmente buscando su cierre por conteo de divs
  contentHtml = removeDivBlocks(contentHtml, 'lee-tambien-bbcl');
  contentHtml = contentHtml.replace(/<div class="ads-[^"]*"[^>]*>\s*<\/div>/gi, '');

  // Pagina7 específico
  contentHtml = removeDivBlocks(contentHtml, 'lee-tambien-block');
  contentHtml = removeDivBlocks(contentHtml, 'related-box');

  // Convertir destacadores a énfasis
  contentHtml = contentHtml.replace(/<span class="destacador">([^<]+)<\/span>/gi, '<em>$1</em>');

  // Convertir <h2> a <h3> para Telegraph
  contentHtml = contentHtml.replace(/<h2[^>]*>([^<]+)<\/h2>/g, '<h3>$1</h3>');

  // Extraer párrafos y subtítulos manteniendo orden
  const elements: { pos: number; html: string }[] = [];

  // Extraer h3
  const h3Regex = /<h3>([^<]+)<\/h3>/gi;
  let h3Match;
  while ((h3Match = h3Regex.exec(contentHtml)) !== null) {
    elements.push({ pos: h3Match.index, html: `<h3>${h3Match[1]}</h3>` });
  }

  // Extraer párrafos
  const pRegex = /<p>([^<]*(?:<(?!\/p>)[^<]*)*)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(contentHtml)) !== null) {
    let text = pMatch[1];
    // Limpiar tags internos excepto em/strong
    text = text.replace(/<(?!em|\/em|strong|\/strong)[^>]+>/g, '');
    // Decodificar entidades HTML
    text = text.replace(/&#8220;/g, '"').replace(/&#8221;/g, '"');
    text = text.replace(/&#8216;/g, "'").replace(/&#8217;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');
    text = text.trim();
    if (text && text.length > 10) {
      elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
    }
  }

  // Ordenar por posición y construir body
  elements.sort((a, b) => a.pos - b.pos);
  const body = elements.map((e) => e.html).join('\n');

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const images: Article['images'] = [];
  if (imageUrl) {
    images.push({ url: imageUrl });
  }

  return {
    title,
    author,
    date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'biobio',
  };
}

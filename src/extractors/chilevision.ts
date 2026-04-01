import type { Article } from '../types.js';

// WordPress con JSON-LD @graph (Yoast SEO)
// NewsArticle en @graph tiene articleBody y author.name
// Fallback a main-single__text HTML parsing

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  let title: string | undefined;
  let subtitle: string | undefined;
  let author: string | undefined;
  let date: string | undefined;
  let imageUrl: string | undefined;

  // JSON-LD @graph (Yoast SEO genera array dentro de @graph)
  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);

      // @graph pattern
      if (data['@graph']) {
        for (const item of data['@graph']) {
          if (item['@type'] === 'NewsArticle' || item['@type'] === 'Article') {
            title = item.headline;
            subtitle = item.description;
            date = item.datePublished;
            // Author puede ser un objeto con @id referenciando a Person en el graph
            if (item.author?.name) {
              author = item.author.name;
            } else if (item.author?.['@id']) {
              // Buscar Person en el graph
              const person = data['@graph'].find((g: any) => g['@id'] === item.author['@id']);
              if (person?.name) author = person.name;
            }
            // Imagen referencia a otro nodo en graph
            if (item.image?.['@id']) {
              const imgNode = data['@graph'].find((g: any) => g['@id'] === item.image['@id']);
              if (imgNode?.url) imageUrl = imgNode.url;
            }
          }
          if (item['@type'] === 'ImageObject' && !imageUrl && item.url) {
            imageUrl = item.url;
          }
        }
      }

      // Direct NewsArticle (no graph)
      if (!title && (data['@type'] === 'NewsArticle' || data['@type'] === 'Article')) {
        title = data.headline;
        subtitle = data.description;
        date = data.datePublished;
        if (data.author?.name) author = data.author.name;
      }
    } catch {
      // JSON inválido
    }
  }

  // Fallback metadata desde meta tags
  if (!title) {
    const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
    title = ogTitle?.[1];
  }
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    title = h1?.[1]?.replace(/<[^>]+>/g, '').trim();
  }
  if (!title) throw new Error('No se pudo extraer el título del artículo');

  if (!imageUrl) {
    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
    imageUrl = ogImage?.[1];
  }
  if (!date) {
    const dateMeta = html.match(/<meta\s+property="article:published_time"\s+content="([^"]+)"/);
    date = dateMeta?.[1];
  }

  // Body: preferir HTML parsing sobre JSON-LD articleBody
  // El articleBody de CHV suele estar truncado/incompleto
  let body = '';

  // HTML parsing del body — class puede ser compuesto ("main-single__text | main-single-text | the-text")
  if (!body) {
    const selectors = ['main-single__text', 'main-single-text', 'the-text', 'entry-content'];
    for (const selector of selectors) {
      const idx = html.indexOf(selector);
      if (idx === -1) continue;

      const chunk = html.slice(idx, idx + 30000);
      const endIdx = chunk.search(/<\/div>\s*(?:<div class="(?:tags-container|share-buttons|sidebar-content|bloque-)|<footer|<aside|<section class="(?:related-articles|sidebar))/);
      // Also check for common end markers further out
      const altEnd = chunk.search(/<div[^>]*class="[^"]*(?:u-container-comments|post-comments|pie-nota)[^"]*"/);
      const effectiveEnd = [endIdx, altEnd].filter(i => i > 0).sort((a, b) => a - b)[0];
      let content = effectiveEnd > 0 ? chunk.slice(0, effectiveEnd) : chunk.slice(0, 15000);

      // Limpiar
      content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      content = content.replace(/<div[^>]*class="[^"]*(?:ad|banner|pub|dfp|outbrain|taboola)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
      content = content.replace(/<blockquote class="twitter-tweet"[\s\S]*?<\/blockquote>/gi, '');
      content = content.replace(/<blockquote class="instagram-media"[\s\S]*?<\/blockquote>/gi, '');

      const elements: { pos: number; html: string }[] = [];

      // Subtítulos
      const hRegex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
      let hMatch;
      while ((hMatch = hRegex.exec(content)) !== null) {
        const text = hMatch[1].replace(/<[^>]+>/g, '').trim();
        if (text && text.length > 3) {
          elements.push({ pos: hMatch.index, html: `<h3>${text}</h3>` });
        }
      }

      // Párrafos
      const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      let pMatch;
      while ((pMatch = pRegex.exec(content)) !== null) {
        let text = pMatch[1].trim();
        if (!text || text === '&nbsp;') continue;
        text = text.replace(/<(?!\/?(em|strong|a|b|i)\b)[^>]+>/g, '');
        text = text.replace(/&nbsp;/g, ' ').trim();
        if (text.length > 20) {
          elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
        }
      }

      // Imágenes
      const figRegex = /<figure[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*\/?>[\s\S]*?(?:<figcaption[^>]*>([\s\S]*?)<\/figcaption>)?[\s\S]*?<\/figure>/gi;
      let figMatch;
      while ((figMatch = figRegex.exec(content)) !== null) {
        const figUrl = figMatch[1];
        const caption = figMatch[2]?.replace(/<[^>]+>/g, '').trim();
        elements.push({
          pos: figMatch.index,
          html: `<figure><img src="${figUrl}"/>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`,
        });
      }

      if (elements.length > 0) {
        elements.sort((a, b) => a.pos - b.pos);
        body = elements.map(e => e.html).join('\n');
        break;
      }
    }
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const images: Article['images'] = [];
  if (imageUrl) images.push({ url: imageUrl });

  return {
    title: title
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\u201c/g, '"')
      .replace(/\u201d/g, '"'),
    subtitle,
    author,
    date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'chilevision',
  };
}

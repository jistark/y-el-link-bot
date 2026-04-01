import type { Article } from '../types.js';

// WordPress con tema Tagdiv (td-post-content)
// Sin JSON-LD articleBody útil — usar og: meta + HTML parsing

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Metadata desde meta tags
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const title = ogTitle?.[1];
  if (!title) throw new Error('No se pudo extraer el título del artículo');

  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
  const subtitle = ogDesc?.[1];

  const authorMeta = html.match(/<meta\s+name="author"\s+content="([^"]+)"/);
  const author = authorMeta?.[1];

  const dateMeta = html.match(/<meta\s+property="article:published_time"\s+content="([^"]+)"/);
  const date = dateMeta?.[1];

  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const imageUrl = ogImage?.[1];

  // Body: extraer de td-post-content
  let body = '';
  const contentMatch = html.match(/class="td-post-content tagdiv-type"[^>]*>([\s\S]*?)(?:<div class="(?:td-post-sharing|td_block_wrap|td-post-next-prev|td-a-rec|tagdiv-type)|<footer)/);

  if (contentMatch) {
    let content = contentMatch[1];

    // Limpiar elementos no deseados
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<div[^>]*class="[^"]*(?:td-a-rec|td_block_wrap|tdi_|td-adspot|ads-|code-block)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    content = content.replace(/<blockquote class="twitter-tweet"[\s\S]*?<\/blockquote>/gi, '');
    content = content.replace(/<blockquote class="instagram-media"[\s\S]*?<\/blockquote>/gi, '');
    content = content.replace(/<figure class="wp-block-embed[\s\S]*?<\/figure>/gi, '');
    // Remover bloques de "Te puede interesar" / relacionados
    content = content.replace(/<div[^>]*class="[^"]*(?:td-post-featured-image|td-related-[^"]*)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

    // Extraer elementos manteniendo orden
    const elements: { pos: number; html: string }[] = [];

    // Subtítulos h2 → h3
    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    let h2Match;
    while ((h2Match = h2Regex.exec(content)) !== null) {
      const text = h2Match[1].replace(/<[^>]+>/g, '').trim();
      if (text && text.length > 3) {
        elements.push({ pos: h2Match.index, html: `<h3>${text}</h3>` });
      }
    }

    // H3
    const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let h3Match;
    while ((h3Match = h3Regex.exec(content)) !== null) {
      const text = h3Match[1].replace(/<[^>]+>/g, '').trim();
      if (text && text.length > 3) {
        elements.push({ pos: h3Match.index, html: `<h3>${text}</h3>` });
      }
    }

    // Párrafos
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(content)) !== null) {
      let text = pMatch[1].trim();
      if (!text || text === '&nbsp;') continue;
      // Mantener em, strong, a
      text = text.replace(/<(?!\/?(em|strong|a|b|i)\b)[^>]+>/g, '');
      text = text.replace(/&nbsp;/g, ' ').trim();
      // Decodificar entidades HTML comunes
      text = text.replace(/&#8220;/g, '\u201c').replace(/&#8221;/g, '\u201d');
      text = text.replace(/&#8216;/g, '\u2018').replace(/&#8217;/g, '\u2019');
      if (text.length > 10) {
        elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
      }
    }

    // Imágenes en figuras
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

    elements.sort((a, b) => a.pos - b.pos);
    body = elements.map(e => e.html).join('\n');
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const images: Article['images'] = [];
  if (imageUrl) images.push({ url: imageUrl });

  return {
    title: title.replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    subtitle,
    author,
    date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'elfiltrador',
  };
}

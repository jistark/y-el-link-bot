import type { Article } from '../types.js';

// WordPress con tema Astra
// Sin JSON-LD articleBody, usa og: meta + entry-content div para body

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

  // Body: extraer de entry-content clear (Astra theme)
  let body = '';
  const contentIdx = html.indexOf('entry-content clear');
  if (contentIdx > -1) {
    const chunk = html.slice(contentIdx, contentIdx + 30000);
    const endIdx = chunk.indexOf('</div><!-- .entry-content');
    const content = endIdx > 0 ? chunk.slice(0, endIdx) : chunk.slice(0, 15000);

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

    // Párrafos
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(content)) !== null) {
      let text = pMatch[1].trim();
      if (!text || text === '&nbsp;') continue;
      // Mantener em, strong, a
      text = text.replace(/<(?!\/?(em|strong|a|b|i)\b)[^>]+>/g, '');
      text = text.replace(/&nbsp;/g, ' ').trim();
      text = text.replace(/&#8220;/g, '\u201c').replace(/&#8221;/g, '\u201d');
      text = text.replace(/&#8216;/g, '\u2018').replace(/&#8217;/g, '\u2019');
      if (text.length > 10) {
        elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
      }
    }

    // Imágenes en figuras (no embeds de WP)
    const figRegex = /<figure[^>]*(?:wp-block-image)[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*\/?>[\s\S]*?(?:<figcaption[^>]*>([\s\S]*?)<\/figcaption>)?[\s\S]*?<\/figure>/gi;
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
    source: 'ojoalatele',
  };
}

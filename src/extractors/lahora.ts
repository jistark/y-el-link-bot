import type { Article } from '../types.js';

// DastCMS - content server-rendered in div.entry-main-content
// Metadata from og: meta tags, author from dataLayer

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Metadata from og: meta tags
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const title = ogTitle?.[1];
  if (!title) throw new Error('No se pudo extraer el título del artículo');

  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
  const subtitle = ogDesc?.[1];

  // Author from dataLayer
  const authorMatch = html.match(/author_name[^:]*:\s*'([^']+)'/);
  const author = authorMatch?.[1];

  // Date from JSON-LD
  const dateMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  const date = dateMatch?.[1];

  // Image from og:image
  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const imageUrl = ogImage?.[1];

  // Body from entry-main-content
  let body = '';
  const contentIdx = html.indexOf('class="entry-main-content">');
  if (contentIdx > -1) {
    const startIdx = contentIdx + 'class="entry-main-content">'.length;
    const chunk = html.slice(startIdx, startIdx + 30000);

    // Find end boundary — sidebar, aside, or footer
    const endMatch = chunk.match(/<(?:div class="entry-bottom|aside|div class="sidebar|footer)/);
    const content = endMatch ? chunk.slice(0, endMatch.index) : chunk.slice(0, 15000);

    const elements: { pos: number; html: string }[] = [];

    // Paragraphs
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(content)) !== null) {
      let text = pMatch[1].trim();
      if (!text || text === '&nbsp;') continue;
      // Keep inline formatting: em, strong, a, b, i
      text = text.replace(/<(?!\/?(em|strong|a|b|i)\b)[^>]+>/g, '');
      text = text.replace(/&nbsp;/g, ' ').trim();
      if (text.length > 10) {
        elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
      }
    }

    // Headers
    const hRegex = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let hMatch;
    while ((hMatch = hRegex.exec(content)) !== null) {
      const text = hMatch[2].replace(/<[^>]+>/g, '').trim();
      if (text && text.length > 3) {
        elements.push({ pos: hMatch.index, html: `<h3>${text}</h3>` });
      }
    }

    // Images in figures
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

    // Standalone images (not in figures)
    const imgRegex = /<img[^>]*src="(https:\/\/img\.lahora\.cl[^"]+)"[^>]*\/?>/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(content)) !== null) {
      // Skip if already captured in a figure
      const nearbyFigure = content.slice(Math.max(0, imgMatch.index - 50), imgMatch.index).includes('<figure');
      if (!nearbyFigure) {
        elements.push({
          pos: imgMatch.index,
          html: `<figure><img src="${imgMatch[1]}"/></figure>`,
        });
      }
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
    source: 'lahora',
  };
}

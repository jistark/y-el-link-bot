import type { Article } from '../types.js';

// Drupal CMS (theme: interferencia_a)
// No JSON-LD, usa og: meta + Drupal field-name-body para body
// Author está en el HTML byline, no en meta tags

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

  const dateMeta = html.match(/<meta\s+property="article:published_time"\s+content="([^"]+)"/);
  const date = dateMeta?.[1];

  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const imageUrl = ogImage?.[1];

  // Autor: buscar en el byline del HTML (Drupal field)
  let author: string | undefined;
  const bylineMatch = html.match(/class="[^"]*field-name-field-autor[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  if (bylineMatch) {
    author = bylineMatch[1].replace(/<[^>]+>/g, '').trim();
  }
  // Fallback: buscar en byline genérico
  if (!author) {
    const byline2 = html.match(/class="[^"]*byline[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
    if (byline2) {
      author = byline2[1].replace(/<[^>]+>/g, '').trim();
      // Limpiar "Por:" u otras etiquetas
      author = author.replace(/^por:?\s*/i, '').trim();
    }
  }

  // Body: Drupal usa field-name-field-body (no field-name-body)
  // Estructura: <div class="field field-name-field-body ..."><div class="field-items"><div class="field-item even">...</div></div></div>
  let body = '';

  // Buscar field-body y field-subhead
  const bodyFieldMatch = html.match(/class="[^"]*field-name-field-body[^"]*"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*<\/div>\s*(?:<div class="field |<\/div>|<section|<footer))/);
  // También capturar la bajada/subhead
  const subheadMatch = html.match(/class="[^"]*field-name-field-subhead[^"]*"[^>]*>[\s\S]*?<div class="field-item[^"]*"[^>]*>([\s\S]*?)<\/div>/);

  let content = '';
  if (bodyFieldMatch) {
    content = bodyFieldMatch[1];
  } else {
    // Fallback: buscar en el article completo
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
    if (articleMatch) content = articleMatch[1];
  }

  if (content) {
    // Limpiar
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<div[^>]*class="[^"]*(?:ad|banner|pub|comment)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

    const elements: { pos: number; html: string }[] = [];

    // Subtítulos
    const hRegex = /<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi;
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
      if (text.length > 10) {
        elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
      }
    }

    // Imágenes
    const imgRegex = /<img[^>]*src="([^"]+)"[^>]*(?:alt="([^"]*)")?[^>]*\/?>/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(content)) !== null) {
      let imgUrl = imgMatch[1];
      if (imgUrl.startsWith('/')) imgUrl = `https://interferencia.cl${imgUrl}`;
      if (imgUrl.includes('/modules/') || imgUrl.includes('/misc/') || imgUrl.includes('/themes/')) continue;
      const alt = imgMatch[2]?.trim();
      elements.push({
        pos: imgMatch.index,
        html: `<figure><img src="${imgUrl}"/>${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`,
      });
    }

    elements.sort((a, b) => a.pos - b.pos);
    body = elements.map(e => e.html).join('\n');
  }

  // Agregar bajada al inicio
  if (subheadMatch) {
    const bajada = subheadMatch[1].replace(/<[^>]+>/g, '').trim();
    if (bajada && bajada.length > 10) {
      body = `<p><em>${bajada}</em></p>\n${body}`;
    }
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
    source: 'interferencia',
  };
}

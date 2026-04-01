import type { Article } from '../types.js';
import { fetchBypass } from './fetch-bypass.js';

// WordPress + Cloudflare (Bun native fetch bypasses)
// No JSON-LD, usa og: meta + the-content class para body
// Requiere limpieza agresiva de ads intercalados

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const html = await response.text();
  if (html.includes('Just a moment') && html.includes('cf_chl_opt')) {
    throw new Error('Cloudflare challenge');
  }
  return html;
}

export async function extract(url: string): Promise<Article> {
  let html: string;
  try {
    html = await fetchHtml(url);
  } catch {
    // Bun bypass falló, intentar con curl_cffi
    html = await fetchBypass(url);
  }

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

  // Body: extraer de the-content
  let body = '';

  // Buscar todo el contenido de the-content (puede terminar en tags, share, related, etc.)
  const contentStart = html.indexOf('class="the-content"');
  if (contentStart > -1) {
    // Tomar un chunk grande y buscar el cierre
    const chunk = html.slice(contentStart, contentStart + 50000);
    const contentEnd = chunk.search(/<\/div>\s*(?:<div class="(?:tags|share|related|bloque-tc-newsletter|bloque-tc-bottom)|<footer|<aside class="sidebar)/);
    let content = contentEnd > 0 ? chunk.slice(0, contentEnd) : chunk.slice(0, 20000);

    // Limpieza agresiva de ads y bloques editoriales
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    // Ads Google DFP
    content = content.replace(/<div[^>]*class="bloque-dfp"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '');
    // Artículos recomendados
    content = content.replace(/<aside[^>]*class="[^"]*bloque-tc-dos-recomendados[^"]*"[^>]*>[\s\S]*?<\/aside>/gi, '');
    // Otros bloques editoriales
    content = content.replace(/<div[^>]*class="[^"]*(?:bloque-tc-|banner|ad-slot|wp-block-embed)[^"]*"[^>]*>[\s\S]*?<\/div>(?:\s*<\/div>)*/gi, '');
    // Blockquotes de redes sociales
    content = content.replace(/<blockquote class="twitter-tweet"[\s\S]*?<\/blockquote>/gi, '');
    content = content.replace(/<blockquote class="instagram-media"[\s\S]*?<\/blockquote>/gi, '');

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

    // Párrafos
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(content)) !== null) {
      let text = pMatch[1].trim();
      if (!text || text === '&nbsp;') continue;
      // Mantener formato inline
      text = text.replace(/<(?!\/?(em|strong|a|b|i)\b)[^>]+>/g, '');
      text = text.replace(/&nbsp;/g, ' ').trim();
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
    source: 'theclinic',
  };
}

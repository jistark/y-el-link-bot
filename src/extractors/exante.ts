import type { Article } from '../types.js';
import { fetchBypass } from './fetch-bypass.js';

// WordPress con tema custom (wp-theme-exante) + Cloudflare
// Bun native fetch bypasses Cloudflare
// No JSON-LD, usa og: meta + contenido-noticia class para body

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

  // Body: el contenido real está en class="contenido-noticia" (después del h1 y autor)
  let body = '';

  // Buscar contenido-noticia primero
  const contentIdx = html.indexOf('class="contenido-noticia"');
  let content = '';
  if (contentIdx > -1) {
    const chunk = html.slice(contentIdx, contentIdx + 30000);
    // El contenido termina antes de sidebar, footer, o bloques de newsletter
    const endIdx = chunk.search(/<(?:footer|div[^>]*class="[^"]*(?:sidebar|relacionad|newsletter|bloque-bottom|sticky-share)[^"]*")/);
    content = endIdx > 0 ? chunk.slice(0, endIdx) : chunk.slice(0, 15000);
  }

  // Fallback: buscar en detalle-noticia completo, después del h1
  if (!content) {
    const h1Idx = html.indexOf('<h1');
    if (h1Idx > -1) {
      const chunk = html.slice(h1Idx, h1Idx + 30000);
      const endIdx = chunk.search(/<(?:footer|div[^>]*class="[^"]*(?:sidebar|relacionad|newsletter)[^"]*")/);
      content = endIdx > 0 ? chunk.slice(0, endIdx) : chunk.slice(0, 15000);
    }
  }

  if (content) {
    // Limpiar
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<div[^>]*class="[^"]*(?:banner|ad-slot|ads|publi|newsletter|compartir|share)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
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
      text = text.replace(/&#8220;/g, '\u201c').replace(/&#8221;/g, '\u201d');
      text = text.replace(/&#8216;/g, '\u2018').replace(/&#8217;/g, '\u2019');
      if (text.length > 10) {
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
    source: 'exante',
  };
}

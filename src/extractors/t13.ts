import type { Article } from '../types.js';

// Extractor para t13.cl y 13.cl (mismo CMS Drupal)
// T13: noticias con texto. 13.cl: clips de programas con video + texto.
// JSON-LD tiene metadata pero NO articleBody. Body viene del HTML.

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();
  const hostname = new URL(url).hostname;
  const source: Article['source'] = hostname.includes('13.cl') && !hostname.includes('t13.cl') ? '13cl' : 't13';

  // JSON-LD para metadata
  let title: string | undefined;
  let subtitle: string | undefined;
  let author: string | undefined;
  let date: string | undefined;
  let imageUrl: string | undefined;
  let videoUrl: string | undefined;
  let videoDuration: string | undefined;

  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/g);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      if (data['@type'] === 'NewsArticle' || data['@type'] === 'Article') {
        title = data.headline;
        subtitle = data.description;
        date = data.datePublished;
        if (data.image) {
          imageUrl = Array.isArray(data.image) ? data.image[0] : (typeof data.image === 'string' ? data.image : data.image.url);
        }
        if (data.author?.name) author = data.author.name;
      } else if (data['@type'] === 'VideoObject') {
        if (!title) title = data.name;
        if (!subtitle) subtitle = data.description;
        if (!date) date = data.uploadDate;
        videoUrl = data.contentUrl || data.embedUrl;
        videoDuration = data.duration;
        if (!imageUrl && data.thumbnailUrl) {
          imageUrl = Array.isArray(data.thumbnailUrl) ? data.thumbnailUrl[0] : data.thumbnailUrl;
        }
      }
    } catch {
      // JSON inválido
    }
  }

  // Fallback título desde meta/HTML
  if (!title) {
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle?.[1];
  }
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    title = h1?.[1]?.replace(/<[^>]+>/g, '').trim();
  }
  if (!title) throw new Error('No se pudo extraer el título del artículo');

  // Autor desde HTML si no vino del JSON-LD
  if (!author) {
    const autorDiv = html.match(/class="autor"[^>]*>[\s\S]*?Por:\s*([\s\S]*?)<\/div>/);
    if (autorDiv) {
      author = autorDiv[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  // Imagen desde og:image si no vino del JSON-LD
  if (!imageUrl) {
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/);
    imageUrl = ogImage?.[1];
  }

  // Video embed: extraer URL del player rudo.video
  if (!videoUrl) {
    const playerMatch = html.match(/data-url-video='([^']+)'/);
    if (playerMatch) videoUrl = playerMatch[1];
  }
  // También capturar imagen del video
  const videoImageMatch = html.match(/data-url-imagen='([^']+)'/);
  const videoImageUrl = videoImageMatch?.[1];

  // Body: extraer de cuerpo-content
  let body = '';
  const bodyMatch = html.match(/class="cuerpo-content"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*<(?:footer|section|div class="(?:tags|relacionad|pub |sidebar)))/);

  if (bodyMatch) {
    let content = bodyMatch[1];

    // Limpiar ads y elementos no deseados
    content = content.replace(/<div[^>]*class="[^"]*ads13[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    content = content.replace(/<div[^>]*class="[^"]*pub [^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '');
    content = content.replace(/<div[^>]*class="[^"]*ad[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '');
    content = content.replace(/<div[^>]*class="[^"]*sev-en-body[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
    content = content.replace(/<div[^>]*class="[^"]*cuerpo-share[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<center>[\s\S]*?<\/center>/gi, '');

    // Extraer elementos manteniendo orden
    const elements: { pos: number; html: string }[] = [];

    // Párrafos
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(content)) !== null) {
      let text = pMatch[1].trim();
      if (!text || text === '&nbsp;' || text === ' ') continue;

      // Procesar imágenes inline
      const imgMatch = text.match(/<figure[^>]*>[\s\S]*?<img[^>]*(?:src|data-lazy)="([^"]+)"[^>]*\/>[\s\S]*?(?:<figcaption>([\s\S]*?)<\/figcaption>)?[\s\S]*?<\/figure>/);
      if (imgMatch) {
        const figHtml = `<figure><img src="${imgMatch[1]}"/>${imgMatch[2] ? `<figcaption>${imgMatch[2].replace(/<[^>]+>/g, '')}</figcaption>` : ''}</figure>`;
        elements.push({ pos: pMatch.index, html: figHtml });
        continue;
      }

      // Texto normal - mantener em, strong, a
      text = text.replace(/<(?!\/?(em|strong|a|b|i)\b)[^>]+>/g, '');
      text = text.replace(/&nbsp;/g, ' ').trim();
      if (text.length > 5) {
        elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
      }
    }

    // Subtítulos h2
    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    let h2Match;
    while ((h2Match = h2Regex.exec(content)) !== null) {
      const text = h2Match[1].replace(/<[^>]+>/g, '').trim();
      if (text) {
        elements.push({ pos: h2Match.index, html: `<h3>${text}</h3>` });
      }
    }

    // Listas
    const ulRegex = /<ul[^>]*>([\s\S]*?)<\/ul>/gi;
    let ulMatch;
    while ((ulMatch = ulRegex.exec(content)) !== null) {
      const items = [...ulMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
      if (items.length > 0) {
        const listHtml = items
          .map(li => `<li>${li[1].replace(/<[^>]+>/g, '').trim()}</li>`)
          .filter(li => li.length > 10)
          .join('');
        if (listHtml) {
          elements.push({ pos: ulMatch.index, html: `<ul>${listHtml}</ul>` });
        }
      }
    }

    elements.sort((a, b) => a.pos - b.pos);
    body = elements.map(e => e.html).join('\n');
  }

  // Si hay bajada y no está en el body, agregarla
  const bajadaMatch = html.match(/class="bajada"[^>]*>([\s\S]*?)<\/p>/);
  const bajada = bajadaMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
  if (bajada && !body.includes(bajada.slice(0, 50))) {
    body = `<p><em>${bajada}</em></p>\n${body}`;
  }

  // Si hay video, agregar al inicio como imagen clickeable
  if (videoUrl && videoImageUrl) {
    const videoEmbed = `<figure><a href="${videoUrl}"><img src="${videoImageUrl}"/></a><figcaption>Ver video${videoDuration ? ` (${videoDuration.replace('T', '').toLowerCase()})` : ''}</figcaption></figure>`;
    body = `${videoEmbed}\n${body}`;
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
    source,
  };
}

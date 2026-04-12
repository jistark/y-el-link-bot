import type { Article } from '../types.js';

const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

interface FusionContent {
  headlines?: { basic?: string };
  subheadlines?: { basic?: string };
  credits?: { by?: { name?: string }[] };
  display_date?: string;
  content_elements?: ContentElement[];
  promo_items?: {
    basic?: { url?: string; caption?: string };
  };
}

interface ContentElement {
  type: string;
  content?: string;
  url?: string;
  caption?: string;
  items?: { content?: string }[];
  // Para embeds
  subtype?: string;
  raw_oembed?: {
    provider_name?: string;
    html?: string;
    url?: string;
    title?: string;
  };
  embed?: {
    url?: string;
  };
}

function extractEmbedUrl(el: ContentElement): string | null {
  // Intentar obtener URL del embed
  if (el.raw_oembed?.url) return el.raw_oembed.url;
  if (el.embed?.url) return el.embed.url;
  if (el.url) return el.url;

  // Extraer de HTML embebido (iframes, etc.)
  if (el.raw_oembed?.html) {
    const iframeMatch = el.raw_oembed.html.match(/src="([^"]+)"/);
    if (iframeMatch) return iframeMatch[1];
  }

  return null;
}

function parseContentElements(elements: ContentElement[]): string {
  const parts: string[] = [];

  for (const el of elements) {
    switch (el.type) {
      case 'text':
        if (el.content) parts.push(el.content);
        break;

      case 'header':
        if (el.content) parts.push(`<h3>${el.content}</h3>`);
        break;

      case 'image':
        if (el.url) {
          const caption = el.caption ? `<figcaption>${el.caption}</figcaption>` : '';
          parts.push(`<figure><img src="${el.url}">${caption}</figure>`);
        }
        break;

      case 'list':
        if (el.items) {
          const items = el.items
            .map((i) => `<li>${i.content || ''}</li>`)
            .join('');
          parts.push(`<ul>${items}</ul>`);
        }
        break;

      case 'oembed_response':
      case 'social_media': {
        const embedUrl = extractEmbedUrl(el);
        const provider = el.raw_oembed?.provider_name || el.subtype || 'embed';
        const title = el.raw_oembed?.title || '';

        if (embedUrl) {
          // Telegraph soporta iframes para YouTube, Vimeo, Twitter
          if (embedUrl.includes('youtube.com') || embedUrl.includes('youtu.be')) {
            const videoId = embedUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)?.[1];
            if (videoId) {
              parts.push(`<figure><iframe src="https://www.youtube.com/embed/${videoId}"></iframe></figure>`);
            }
          } else if (embedUrl.includes('vimeo.com')) {
            const videoId = embedUrl.match(/vimeo\.com\/(\d+)/)?.[1];
            if (videoId) {
              parts.push(`<figure><iframe src="https://player.vimeo.com/video/${videoId}"></iframe></figure>`);
            }
          } else if (embedUrl.includes('twitter.com') || embedUrl.includes('x.com')) {
            // Twitter/X - mostrar como link
            parts.push(`<p><a href="${embedUrl}">[Ver en ${provider}]</a></p>`);
          } else if (embedUrl.includes('instagram.com')) {
            parts.push(`<p><a href="${embedUrl}">[Ver en Instagram]</a></p>`);
          } else if (embedUrl.includes('tiktok.com')) {
            parts.push(`<p><a href="${embedUrl}">[Ver en TikTok]</a></p>`);
          } else {
            // Otros embeds - mostrar como link
            parts.push(`<p><a href="${embedUrl}">[${provider}: ${title || 'Ver contenido'}]</a></p>`);
          }
        }
        break;
      }

      case 'video': {
        const videoUrl = el.url || el.embed?.url;
        if (videoUrl) {
          // Telegraph no soporta video directo, mostrar como link
          parts.push(`<p><a href="${videoUrl}">[Ver video]</a></p>`);
        }
        break;
      }

      case 'raw_html':
        // Intentar extraer iframes de YouTube/Vimeo
        if (el.content) {
          const iframeMatch = el.content.match(/<iframe[^>]+src="([^"]+)"[^>]*>/i);
          if (iframeMatch) {
            const src = iframeMatch[1];
            if (src.includes('youtube.com') || src.includes('vimeo.com')) {
              parts.push(`<figure><iframe src="${src}"></iframe></figure>`);
            }
          }
        }
        break;
    }
  }

  return parts.join('\n');
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': GOOGLEBOT_UA,
      'X-Forwarded-For': '66.249.66.1',
      'Referer': 'https://www.google.com/',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Extraer Fusion.globalContent del script
  const match = html.match(/Fusion\.globalContent\s*=\s*({.+?});?\s*Fusion\./s);
  if (!match) {
    throw new Error('No se encontró Fusion.globalContent en la página');
  }

  let data: FusionContent;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('Error parseando Fusion.globalContent');
  }

  const title = data.headlines?.basic;
  if (!title) {
    throw new Error('Artículo sin título');
  }

  const body = data.content_elements
    ? parseContentElements(data.content_elements)
    : '';

  const images: Article['images'] = [];
  if (data.promo_items?.basic?.url) {
    images.push({
      url: data.promo_items.basic.url,
      caption: data.promo_items.basic.caption,
    });
  }

  return {
    title,
    subtitle: data.subheadlines?.basic,
    author: data.credits?.by?.[0]?.name,
    date: data.display_date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'latercera',
  };
}

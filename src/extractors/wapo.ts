import type { Article } from '../types.js';

const WAPO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

interface JsonLdArticle {
  '@type'?: string;
  headline?: string;
  articleBody?: string;
  author?: { name?: string } | { name?: string }[] | string;
  datePublished?: string;
  image?: string | { url?: string };
}

interface FusionContent {
  headlines?: { basic?: string };
  publish_date?: string;
  promo_items?: { basic?: { url?: string } };
  content_elements?: { type: string; content?: string }[];
}

function extractAuthor(author: JsonLdArticle['author']): string | undefined {
  if (!author) return undefined;

  if (Array.isArray(author)) {
    const names = author.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean);
    return names.length > 0 ? names.join(', ') : undefined;
  }

  if (typeof author === 'object') {
    return author.name || undefined;
  }

  return String(author) || undefined;
}

function extractImage(image: JsonLdArticle['image']): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image;
  if (typeof image === 'object') return image.url;
  return undefined;
}

function extractFromJsonLd(html: string): Article | null {
  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json"[^>]*>(.+?)<\/script>/gs);

  for (const match of jsonLdMatches) {
    try {
      let data: JsonLdArticle = JSON.parse(match[1]);

      if (Array.isArray(data)) {
        const found = data.find((d) => d.articleBody);
        if (!found) continue;
        data = found;
      }

      if (!data.articleBody) continue;

      // Convert plain text to HTML paragraphs
      const paragraphs = data.articleBody.split(/\n+/).filter((p) => p.trim());
      const body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');

      const imageUrl = extractImage(data.image);

      return {
        title: data.headline || 'Sin título',
        author: extractAuthor(data.author),
        date: data.datePublished,
        body,
        images: imageUrl ? [{ url: imageUrl }] : undefined,
        url: '',
        source: 'wapo',
      };
    } catch {
      continue;
    }
  }

  return null;
}

function extractFromFusion(html: string): Article | null {
  const fusionMatch = html.match(/Fusion\.globalContent\s*=\s*({.+?});\s*Fusion\./s);
  if (!fusionMatch) return null;

  try {
    const data: FusionContent = JSON.parse(fusionMatch[1]);

    const textElements = data.content_elements?.filter((e) => e.type === 'text') || [];
    const body = textElements.map((e) => `<p>${e.content}</p>`).join('\n');

    if (!body) return null;

    return {
      title: data.headlines?.basic || 'Sin título',
      date: data.publish_date,
      body,
      images: data.promo_items?.basic?.url ? [{ url: data.promo_items.basic.url }] : undefined,
      url: '',
      source: 'wapo',
    };
  } catch {
    return null;
  }
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { headers: WAPO_HEADERS });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Try JSON-LD first
  let article = extractFromJsonLd(html);

  // Fallback to Fusion.globalContent
  if (!article) {
    article = extractFromFusion(html);
  }

  if (!article) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  article.url = url;
  return article;
}

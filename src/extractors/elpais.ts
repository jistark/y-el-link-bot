import type { Article } from '../types.js';

const ELPAIS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

interface JsonLdArticle {
  '@type'?: string;
  headline?: string;
  articleBody?: string;
  description?: string;
  author?: { name?: string } | { name?: string }[] | string;
  datePublished?: string;
  image?: string | { url?: string } | { url?: string }[];
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
  if (Array.isArray(image)) {
    const first = image[0];
    return typeof first === 'string' ? first : first?.url;
  }
  if (typeof image === 'object') return image.url;
  return undefined;
}

function extractBodyFromHtml(html: string): string | null {
  // El País: article body is in <article> with paragraphs
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (!articleMatch) return null;

  const articleHtml = articleMatch[1];
  const paragraphs: string[] = [];

  // Extract paragraphs from article-body div
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(articleHtml)) !== null) {
    let text = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (text && text.length > 20) {
      paragraphs.push(text);
    }
  }

  if (paragraphs.length === 0) return null;
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n');
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { headers: ELPAIS_HEADERS });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Extract JSON-LD
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdData: JsonLdArticle | null = null;

  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      // Handle array of JSON-LD objects
      const article = Array.isArray(data)
        ? data.find((d) => d['@type'] === 'NewsArticle' || d['@type'] === 'Article')
        : data['@type'] === 'NewsArticle' || data['@type'] === 'Article'
          ? data
          : null;

      if (article) {
        jsonLdData = article;
        break;
      }
    } catch {
      continue;
    }
  }

  // Get body from JSON-LD articleBody or extract from HTML
  let body: string | null = null;

  if (jsonLdData?.articleBody) {
    body = jsonLdData.articleBody
      .split(/\n+/)
      .filter((p) => p.trim())
      .map((p) => `<p>${p}</p>`)
      .join('\n');
  } else {
    body = extractBodyFromHtml(html);
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Get title from JSON-LD or og:title
  let title = jsonLdData?.headline;
  if (!title) {
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle?.[1];
  }

  if (!title) {
    throw new Error('No se pudo extraer el título');
  }

  const imageUrl = extractImage(jsonLdData?.image);

  return {
    title,
    subtitle: jsonLdData?.description,
    author: extractAuthor(jsonLdData?.author),
    date: jsonLdData?.datePublished,
    body,
    images: imageUrl ? [{ url: imageUrl }] : undefined,
    url,
    source: 'elpais',
  };
}

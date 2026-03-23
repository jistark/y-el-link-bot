import type { Article } from '../types.js';

// Financial Times uses special Outbrain User-Agent + Google Referer to bypass paywall
const FT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Java) outbrain',
  'Referer': 'https://www.google.com/',
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
  // FT: article body in article-body or content-body
  const bodyMatch = html.match(/<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (!bodyMatch) return null;

  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = pRegex.exec(bodyMatch[1])) !== null) {
    let text = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (text && text.length > 10) {
      paragraphs.push(text);
    }
  }

  if (paragraphs.length === 0) return null;
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n');
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { headers: FT_HEADERS, signal: AbortSignal.timeout(15000) });
    if (response.ok) return response.text();
    // Cloudflare intermittently returns 403 — retry with backoff
    if (response.status === 403 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }
  throw new Error('Error al obtener artículo: reintentos agotados');
}

export async function extract(url: string): Promise<Article> {
  const html = await fetchWithRetry(url);

  // Extract JSON-LD
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdData: JsonLdArticle | null = null;

  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
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

  // Get body
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

  // Get title
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
    source: 'ft',
  };
}

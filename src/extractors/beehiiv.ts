import type { Article } from '../types.js';

const BEEHIIV_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

interface BeehiivJsonLd {
  '@type'?: string;
  headline?: string;
  description?: string;
  author?: { name?: string }[] | { name?: string };
  datePublished?: string;
  image?: { url?: string } | string;
}

function extractJsonLd(html: string): BeehiivJsonLd | null {
  const scriptRegex = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data)) {
        const article = data.find(
          (d: any) => d['@type'] === 'Article' || d['@type'] === 'NewsArticle'
        );
        if (article) return article;
      } else if (
        data['@type'] === 'Article' ||
        data['@type'] === 'NewsArticle'
      ) {
        return data;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractAuthor(author: BeehiivJsonLd['author']): string | undefined {
  if (!author) return undefined;
  if (Array.isArray(author)) {
    const names = author.map((a) => a.name).filter(Boolean);
    return names.length > 0 ? names.join(', ') : undefined;
  }
  return author.name || undefined;
}

function extractBodyFromHtml(html: string): string {
  // Extract from <div id="content-blocks">
  const contentMatch = html.match(
    /<div[^>]*id="content-blocks"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*id="(?!content-blocks))/i
  );

  let content = contentMatch?.[1] || '';

  if (!content) {
    // Broader fallback
    const fallback = html.match(
      /<div[^>]*id="content-blocks"[^>]*>([\s\S]*?)<\/article>/i
    );
    content = fallback?.[1] || '';
  }

  if (!content) {
    throw new Error('No se encontró el contenido del artículo');
  }

  // Clean Beehiiv-specific elements
  content = content
    // Remove newsletter signup widgets
    .replace(/<div[^>]*class="[^"]*(?:newsletter-signup|subscribe-widget|signup-form)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    // Remove ad blocks
    .replace(/<div[^>]*class="[^"]*(?:ad-block|sponsor|advertisement)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    // Remove share buttons
    .replace(/<div[^>]*class="[^"]*share[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    // Remove empty paragraphs
    .replace(/<p>\s*<\/p>/g, '');

  return content;
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { headers: BEEHIIV_HEADERS });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }
  const html = await response.text();

  const jsonLd = extractJsonLd(html);

  // Extract title
  let title = jsonLd?.headline;
  if (!title) {
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle?.[1];
  }
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    title = h1?.[1];
  }
  if (!title) {
    throw new Error('No se pudo extraer el título');
  }

  const author = extractAuthor(jsonLd?.author);

  const body = extractBodyFromHtml(html);

  // Extract image
  const images: Article['images'] = [];
  if (jsonLd?.image) {
    const imgUrl =
      typeof jsonLd.image === 'string' ? jsonLd.image : jsonLd.image.url;
    if (imgUrl) {
      images.push({ url: imgUrl });
    }
  }

  return {
    title,
    subtitle: jsonLd?.description || undefined,
    author,
    date: jsonLd?.datePublished || undefined,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'beehiiv',
  };
}

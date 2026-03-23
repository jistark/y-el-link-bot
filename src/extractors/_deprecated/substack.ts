import type { Article } from '../types.js';

interface SubstackJsonLd {
  '@type'?: string;
  headline?: string;
  description?: string;
  author?: { name?: string }[] | { name?: string };
  datePublished?: string;
  image?: { url?: string } | string;
  isAccessibleForFree?: boolean | string;
}

function extractJsonLd(html: string): SubstackJsonLd | null {
  const scriptRegex = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data)) {
        const article = data.find(
          (d: any) => d['@type'] === 'NewsArticle' || d['@type'] === 'Article'
        );
        if (article) return article;
      } else if (
        data['@type'] === 'NewsArticle' ||
        data['@type'] === 'Article'
      ) {
        return data;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractAuthor(author: SubstackJsonLd['author']): string | undefined {
  if (!author) return undefined;
  if (Array.isArray(author)) {
    const names = author.map((a) => a.name).filter(Boolean);
    return names.length > 0 ? names.join(', ') : undefined;
  }
  return author.name || undefined;
}

function extractBodyFromHtml(html: string): string {
  // Extract from <div class="body markup"> inside available-content
  const availableMatch = html.match(
    /<div[^>]*class="[^"]*available-content[^"]*"[^>]*>([\s\S]*?)(?:<\/div>\s*<div[^>]*class="[^"]*(?:paywall|subscription)[^"]*"|$)/i
  );
  const scope = availableMatch?.[1] || html;

  const bodyMatch = scope.match(
    /<div[^>]*class="[^"]*body markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*class="[^"]*(?:footer|post-footer|subscription))/i
  );

  let content = bodyMatch?.[1] || '';

  if (!content) {
    // Fallback: try to find .body.markup more broadly
    const fallback = html.match(
      /<div[^>]*class="[^"]*body markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
    );
    content = fallback?.[1] || '';
  }

  if (!content) {
    throw new Error('No se encontró el contenido del artículo');
  }

  // Clean Substack-specific widgets and buttons
  content = content
    // Remove subscribe buttons/widgets
    .replace(/<div[^>]*class="[^"]*subscription-widget[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*button-wrapper[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*share[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    // Remove Substack embedded posts
    .replace(/<div[^>]*class="[^"]*embedded-post[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '')
    // Remove empty paragraphs
    .replace(/<p>\s*<\/p>/g, '');

  return content;
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }
  const html = await response.text();

  const jsonLd = extractJsonLd(html);

  // Extract title from JSON-LD or HTML
  let title = jsonLd?.headline;
  if (!title) {
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle?.[1];
  }
  if (!title) {
    const h1 = html.match(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>([^<]+)<\/h1>/);
    title = h1?.[1];
  }
  if (!title) {
    throw new Error('No se pudo extraer el título');
  }

  // Extract subtitle
  let subtitle = jsonLd?.description;
  if (!subtitle) {
    const h3 = html.match(/<h3[^>]*class="[^"]*subtitle[^"]*"[^>]*>([^<]+)<\/h3>/);
    subtitle = h3?.[1];
  }

  // Extract author
  const author = extractAuthor(jsonLd?.author);

  // Extract body
  let body = extractBodyFromHtml(html);

  // Check if paid content
  const isFree = jsonLd?.isAccessibleForFree;
  if (isFree === false || isFree === 'False') {
    body += '<p><i>Artículo de pago: contenido parcial</i></p>';
  }

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
    subtitle: subtitle || undefined,
    author,
    date: jsonLd?.datePublished || undefined,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'substack',
  };
}

export interface JsonLdArticle {
  // schema.org allows @type as a single string or an array of types
  '@type'?: string | string[];
  headline?: string;
  name?: string;
  articleBody?: string;
  description?: string;
  author?: { name?: string } | { name?: string }[] | string;
  datePublished?: string;
  image?: string | { url?: string } | { url?: string }[];
}

const ARTICLE_TYPES = new Set(['NewsArticle', 'Article', 'BlogPosting', 'ReportageNewsArticle']);

/**
 * Returns true if the value's @type matches a known article schema, handling
 * both single-string and array forms (e.g. ["NewsArticle", "Article"]).
 */
export function isJsonLdArticle(node: unknown): node is JsonLdArticle {
  if (!node || typeof node !== 'object') return false;
  const t = (node as { '@type'?: unknown })['@type'];
  if (typeof t === 'string') return ARTICLE_TYPES.has(t);
  if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && ARTICLE_TYPES.has(x));
  return false;
}

/**
 * Walk a JSON-LD document and return the first article-shaped node.
 * Handles single objects, arrays of objects, and `@graph` envelopes.
 */
export function findArticleNode(data: unknown): JsonLdArticle | null {
  if (!data || typeof data !== 'object') return null;
  if (isJsonLdArticle(data)) return data;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findArticleNode(item);
      if (found) return found;
    }
    return null;
  }
  const graph = (data as { '@graph'?: unknown })['@graph'];
  if (Array.isArray(graph)) return findArticleNode(graph);
  return null;
}

export function extractAuthor(author: JsonLdArticle['author']): string | undefined {
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

export function extractImage(image: JsonLdArticle['image']): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    const first = image[0];
    return typeof first === 'string' ? first : first?.url;
  }
  if (typeof image === 'object') return image.url;
  return undefined;
}

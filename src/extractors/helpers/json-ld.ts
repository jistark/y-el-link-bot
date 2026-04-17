export interface JsonLdArticle {
  '@type'?: string;
  headline?: string;
  name?: string;
  articleBody?: string;
  description?: string;
  author?: { name?: string } | { name?: string }[] | string;
  datePublished?: string;
  image?: string | { url?: string } | { url?: string }[];
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

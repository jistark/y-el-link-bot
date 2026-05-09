import type { Article } from '../types.js';
import { type JsonLdArticle, extractAuthor, extractImage, findArticleNode } from './helpers/json-ld.js';

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Buscar todos los JSON-LD en la página. findArticleNode handles single
  // objects, arrays, @graph envelopes, and @type as array (["NewsArticle", ...]).
  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">(.+?)<\/script>/gs);

  let article: JsonLdArticle | null = null;

  for (const match of jsonLdMatches) {
    try {
      const found = findArticleNode(JSON.parse(match[1]));
      if (found) { article = found; break; }
    } catch {
      // JSON inválido, continuar
    }
  }

  if (!article) {
    throw new Error('No se encontró JSON-LD NewsArticle');
  }

  if (!article.headline) {
    throw new Error('Artículo sin título');
  }

  const author = extractAuthor(article.author);
  const mainImage = extractImage(article.image);
  const images: Article['images'] = mainImage ? [{ url: mainImage }] : undefined;

  // Convertir articleBody (texto plano) a HTML con párrafos
  const body = (article.articleBody || '')
    .split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<p>${p.trim()}</p>`)
    .join('\n');

  return {
    title: article.headline,
    subtitle: article.description,
    author,
    date: article.datePublished,
    body,
    images,
    url,
    source: 'theverge',
  };
}

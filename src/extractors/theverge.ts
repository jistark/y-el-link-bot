import type { Article } from '../types.js';

interface JsonLdArticle {
  '@type': string;
  headline: string;
  description?: string;
  articleBody: string;
  author?: { name: string }[] | { name: string };
  datePublished?: string;
  image?: (string | { url: string })[];
  url?: string;
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Buscar todos los JSON-LD en la página
  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">(.+?)<\/script>/gs);

  let article: JsonLdArticle | null = null;

  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);

      // Puede ser un array o un objeto
      if (Array.isArray(data)) {
        const found = data.find(d => d['@type'] === 'NewsArticle' || d['@type'] === 'Article');
        if (found) {
          article = found;
          break;
        }
      } else if (data['@type'] === 'NewsArticle' || data['@type'] === 'Article') {
        article = data;
        break;
      }
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

  // Extraer autor
  let author: string | undefined;
  if (article.author) {
    if (Array.isArray(article.author)) {
      author = article.author.map(a => a.name).join(', ');
    } else {
      author = article.author.name;
    }
  }

  // Extraer imágenes
  const images: Article['images'] = [];
  if (article.image) {
    for (const img of article.image) {
      const imgUrl = typeof img === 'string' ? img : img.url;
      if (imgUrl) {
        images.push({ url: imgUrl });
      }
    }
  }

  // Convertir articleBody (texto plano) a HTML con párrafos
  const body = article.articleBody
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
    images: images.length > 0 ? images : undefined,
    url: article.url || url,
    source: 'theverge',
  };
}

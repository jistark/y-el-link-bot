import type { Article } from '../types.js';

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Buscar JSON-LD NewsArticle
  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/g);

  let article: any = null;
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data)) {
        article = data.find(d => d['@type'] === 'NewsArticle' || d['@type'] === 'Article');
      } else if (data['@type'] === 'NewsArticle' || data['@type'] === 'Article') {
        article = data;
      }
      if (article) break;
    } catch {
      // JSON inválido, continuar
    }
  }

  if (!article?.headline) {
    throw new Error('No se encontró JSON-LD NewsArticle');
  }

  // Autor
  let author: string | undefined;
  if (article.author) {
    if (Array.isArray(article.author)) {
      author = article.author.map((a: any) => typeof a === 'string' ? a : a.name).filter(Boolean).join(', ');
    } else {
      author = typeof article.author === 'string' ? article.author : article.author.name;
    }
  }
  // Fallback a meta tag
  if (!author) {
    const authorMeta = html.match(/<meta\s+(?:property|name)="article:author"\s+content="([^"]+)"/);
    author = authorMeta?.[1];
  }

  // Imagen
  const images: Article['images'] = [];
  if (article.image) {
    const img = article.image;
    const imgUrl = typeof img === 'string' ? img : img.url;
    if (imgUrl) images.push({ url: imgUrl, caption: img.caption });
  }

  // Body: articleBody es texto plano, split por doble salto de línea
  let body = '';
  if (article.articleBody) {
    body = article.articleBody
      .split(/\n\n+/)
      .filter((p: string) => p.trim())
      .map((p: string) => `<p>${p.trim()}</p>`)
      .join('\n');
  }

  if (!body) {
    // Fallback: extraer párrafos del HTML
    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim())
      .filter(p => p.length > 40);
    if (paragraphs.length > 0) {
      body = paragraphs.map(p => `<p>${p}</p>`).join('\n');
    }
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  return {
    title: article.headline,
    subtitle: article.description,
    author,
    date: article.datePublished,
    body,
    images: images.length > 0 ? images : undefined,
    url: article.url || url,
    source: 'adnradio',
  };
}

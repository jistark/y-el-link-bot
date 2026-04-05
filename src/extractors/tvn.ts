import type { Article } from '../types.js';

// Extractor compartido para tvn.cl y 24horas.cl (mismo CMS)
// JSON-LD NewsArticle con articleBody que contiene HTML

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();
  const hostname = new URL(url).hostname;
  const source: Article['source'] = hostname.includes('24horas') ? '24horas' : 'tvn';

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
      // JSON inválido
    }
  }

  if (!article?.headline) {
    // Fallback a og:title
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    if (!ogTitle) throw new Error('No se pudo extraer el título del artículo');
    article = { headline: ogTitle[1] };
  }

  // Autor
  let author: string | undefined;
  if (article.author) {
    if (typeof article.author === 'string') {
      author = article.author;
    } else if (article.author.name) {
      author = article.author.name;
    }
  }

  // Imagen
  const images: Article['images'] = [];
  if (article.image) {
    const img = article.image;
    const imgUrl = typeof img === 'string' ? img : Array.isArray(img) ? img[0] : img.url;
    if (imgUrl) images.push({ url: imgUrl });
  }
  if (images.length === 0) {
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (ogImage) images.push({ url: ogImage[1] });
  }

  // Body: articleBody contiene HTML con <p>, <strong>, <a>, etc.
  let body = '';
  if (article.articleBody) {
    body = article.articleBody
      // Limpiar scripts y ads
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .trim();
  }

  // Fallback: extraer del HTML
  if (!body) {
    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map(m => m[1].trim())
      .filter(p => p.replace(/<[^>]+>/g, '').length > 40);
    body = paragraphs.map(p => `<p>${p}</p>`).join('\n');
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  return {
    title: article.headline.replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    subtitle: article.description,
    author,
    date: article.datePublished,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source,
  };
}

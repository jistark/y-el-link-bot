import type { Article } from '../types.js';

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // JSON-LD tiene metadatos (título, autor, fecha, imagen)
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/);

  let title: string | undefined;
  let subtitle: string | undefined;
  let author: string | undefined;
  let date: string | undefined;
  let imageUrl: string | undefined;

  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      title = data.headline;
      subtitle = data.description;
      author = typeof data.author === 'string' ? data.author : data.author?.name;
      date = data.datePublished;
      imageUrl = data.image?.url;
    } catch {
      // JSON inválido, continuar con parsing HTML
    }
  }

  // Fallback para título desde meta tags
  if (!title) {
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle?.[1];
  }

  if (!title) {
    throw new Error('No se pudo extraer el título del artículo');
  }

  // Epígrafe (bajada)
  const epigraphMatch = html.match(/<p class="epigraph">([^<]+)<\/p>/);
  const bajada = epigraphMatch?.[1]?.trim();

  // Contenido principal: div después del <hr> que sigue al epígrafe
  let body = '';
  const contentMatch = html.match(/<p class="epigraph">[\s\S]*?<hr>\s*<div>([\s\S]*?)<\/div>\s*(?:<div class="js_post_tags"|$)/);

  if (contentMatch) {
    let content = contentMatch[1];
    // Limpiar ads y elementos innecesarios
    content = content.replace(/<div[^>]*class="[^"]*ad[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    content = content.replace(/<div[^>]*class="the-banner"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
    // Convertir <h2> a subtítulos
    content = content.replace(/<h2>([^<]+)<\/h2>/g, '<p><strong>$1</strong></p>');
    // Mantener párrafos
    content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '<p>$1</p>');
    // Limpiar tags inline pero mantener texto
    content = content.replace(/<\/?(?:strong|b|em|i|a|span)[^>]*>/gi, '');
    // Limpiar otros tags
    content = content.replace(/<(?!p|\/p)[^>]+>/g, '');
    // Limpiar espacios excesivos
    content = content.replace(/\s+/g, ' ').trim();

    body = content;
  }

  // Fallback: buscar contenido en article-details
  if (!body) {
    const paragraphs = html.match(/<div class="article-details[\s\S]*?<div>\s*([\s\S]*?)\s*<\/div>\s*<div class="js_post_tags/);
    if (paragraphs) {
      let content = paragraphs[1];
      content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '<p>$1</p>');
      content = content.replace(/<(?!p|\/p)[^>]+>/g, '');
      body = content.replace(/\s+/g, ' ').trim();
    }
  }

  // Agregar bajada al inicio si existe
  if (bajada) {
    body = `<p><em>${bajada}</em></p>\n${body}`;
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const images: Article['images'] = [];
  if (imageUrl) {
    images.push({ url: imageUrl });
  }

  return {
    title,
    subtitle,
    author,
    date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'cnnchile',
  };
}

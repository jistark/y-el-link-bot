import type { Article } from '../types.js';

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }
  const html = await response.text();

  // Extract Ghost Content API key and URL from the portal script tag
  const keyMatch = html.match(/data-key="([^"]+)"/);
  const apiMatch = html.match(/data-api="([^"]+)"/);

  if (!keyMatch || !apiMatch) {
    throw new Error('No se encontró la API key de Ghost');
  }

  const key = keyMatch[1];
  const apiUrl = apiMatch[1];

  // Extract slug from URL (last non-empty path segment)
  const slug = new URL(url).pathname.replace(/\/$/, '').split('/').pop();
  if (!slug) {
    throw new Error('No se pudo extraer el slug de la URL');
  }

  // Call Ghost Content API
  const apiResponse = await fetch(
    `${apiUrl}posts/slug/${slug}/?key=${key}&include=authors`,
    { signal: AbortSignal.timeout(15_000) }
  );
  if (!apiResponse.ok) {
    throw new Error(`Error en Ghost API: ${apiResponse.status}`);
  }

  const data = await apiResponse.json();
  const post = data.posts?.[0];
  if (!post) {
    throw new Error('Artículo no encontrado en Ghost API');
  }

  // Clean HTML content
  let body = post.html || '';

  // Remove Ghost card markers
  body = body.replace(/<!--kg-card-begin[^>]*-->/g, '');
  body = body.replace(/<!--kg-card-end[^>]*-->/g, '');

  // Remove Outpost paywall divs
  body = body.replace(/<div[^>]*class="[^"]*outpost-pub-container[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Remove 404 Media newsletter CTA blocks (🌘 emoji + Subscribe paragraphs)
  body = body.replace(/<p>\s*🌘\s*<\/p>/g, '');
  body = body.replace(/<p>[\s\S]*?404media\.co\/signup\/[\s\S]*?<\/p>/gi, '');

  // Remove empty paragraphs
  body = body.replace(/<p>\s*<\/p>/g, '');

  // Extract feature image
  const images: Article['images'] = [];
  if (post.feature_image) {
    images.push({
      url: post.feature_image,
      caption: post.feature_image_caption?.replace(/<[^>]+>/g, '') || undefined,
    });
  }

  // Note if content is truncated (members-only)
  if (post.visibility === 'members' && post.access === false) {
    body += '<p><i>Artículo de pago: contenido parcial</i></p>';
  }

  return {
    title: post.title,
    subtitle: post.custom_excerpt || post.excerpt || undefined,
    author: post.primary_author?.name || undefined,
    date: post.published_at || undefined,
    body,
    images: images.length > 0 ? images : undefined,
    url: post.url || url,
    source: '404media',
  };
}

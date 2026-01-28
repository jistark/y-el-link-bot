import type { Article } from '../types.js';

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();
  const isPagina7 = url.includes('pagina7.cl');

  // JSON-LD para metadatos
  const jsonLdMatch = html.match(
    /<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/
  );

  let title: string | undefined;
  let date: string | undefined;

  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      title = data.headline;
      date = data.datePublished;
    } catch {
      // JSON inválido
    }
  }

  // Fallback título
  if (!title) {
    const titleMatch = html.match(/<meta property="og:title" content=['"]([^'"]+)['"]/);
    title = titleMatch?.[1];
  }

  if (!title) {
    throw new Error('No se pudo extraer el título del artículo');
  }

  // Autor
  const authorMatch = html.match(/<meta property="article:author" content="([^"]+)"/);
  const author = authorMatch?.[1];

  // Imagen
  const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  const imageUrl = imageMatch?.[1];

  // Contenido - diferente según el sitio
  let contentHtml = '';

  if (isPagina7) {
    // Pagina7: buscar en main-single__text
    const contentMatch = html.match(
      /<div class="main-single__text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/
    );
    if (contentMatch) {
      contentHtml = contentMatch[1];
    }
  } else {
    // BioBioChile: buscar en banners-contenido-nota (con o sin número)
    // Patrón 1: con número (noticias antiguas)
    let contentMatch = html.match(
      /<div class="banners-contenido-nota-\d+">([\s\S]*?)\n\s*<\/div>\s*\n\s*<\/div>/
    );
    // Patrón 2: sin número (noticias nuevas - dopamina, etc)
    if (!contentMatch) {
      contentMatch = html.match(
        /<div class="contenido-nota banners-contenido-nota">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="contenedor-correcciones/
      );
    }
    if (contentMatch) {
      contentHtml = contentMatch[1];
    }
  }

  if (!contentHtml) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Limpiar elementos no deseados (común a ambos)
  contentHtml = contentHtml.replace(/<blockquote class="twitter-tweet"[\s\S]*?<\/blockquote>/gi, '');
  contentHtml = contentHtml.replace(/<blockquote class="instagram-media"[\s\S]*?<\/blockquote>/gi, '');
  contentHtml = contentHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  contentHtml = contentHtml.replace(/<figure class="wp-block-embed[\s\S]*?<\/figure>/gi, '');
  contentHtml = contentHtml.replace(/<input[^>]*>/gi, '');

  // BioBio específico
  contentHtml = contentHtml.replace(/<div class="lee-tambien-bbcl">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
  contentHtml = contentHtml.replace(/<div class="ads-[^"]*"[\s\S]*?<\/div>/gi, '');

  // Pagina7 específico
  contentHtml = contentHtml.replace(/<div class="lee-tambien-block[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
  contentHtml = contentHtml.replace(/<div class="related-box[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');

  // Convertir destacadores a énfasis
  contentHtml = contentHtml.replace(/<span class="destacador">([^<]+)<\/span>/gi, '<em>$1</em>');

  // Convertir <h2> a <h3> para Telegraph
  contentHtml = contentHtml.replace(/<h2[^>]*>([^<]+)<\/h2>/g, '<h3>$1</h3>');

  // Extraer párrafos y subtítulos manteniendo orden
  const elements: { pos: number; html: string }[] = [];

  // Extraer h3
  const h3Regex = /<h3>([^<]+)<\/h3>/gi;
  let h3Match;
  while ((h3Match = h3Regex.exec(contentHtml)) !== null) {
    elements.push({ pos: h3Match.index, html: `<h3>${h3Match[1]}</h3>` });
  }

  // Extraer párrafos
  const pRegex = /<p>([^<]*(?:<(?!\/p>)[^<]*)*)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(contentHtml)) !== null) {
    let text = pMatch[1];
    // Limpiar tags internos excepto em/strong
    text = text.replace(/<(?!em|\/em|strong|\/strong)[^>]+>/g, '');
    // Decodificar entidades HTML
    text = text.replace(/&#8220;/g, '"').replace(/&#8221;/g, '"');
    text = text.replace(/&#8216;/g, "'").replace(/&#8217;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');
    text = text.trim();
    if (text && text.length > 10) {
      elements.push({ pos: pMatch.index, html: `<p>${text}</p>` });
    }
  }

  // Ordenar por posición y construir body
  elements.sort((a, b) => a.pos - b.pos);
  const body = elements.map((e) => e.html).join('\n');

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const images: Article['images'] = [];
  if (imageUrl) {
    images.push({ url: imageUrl });
  }

  return {
    title,
    author,
    date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'biobio',
  };
}

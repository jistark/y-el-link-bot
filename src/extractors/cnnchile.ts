import type { Article } from '../types.js';
import { type JsonLdArticle, extractAuthor, extractImage, findArticleNode } from './helpers/json-ld.js';

// CNN Chile a veces emite saltos de línea crudos dentro de strings JSON-LD
// (articleBody con un \n al final), lo que rompe JSON.parse. Escapamos
// control chars solo cuando estamos dentro de un string.
function sanitizeJsonControlChars(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      out += ch;
      if (ch === '"') inString = true;
    }
  }
  return out;
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // El JSON-LD ahora viene en `@graph`. findArticleNode camina envoltorios.
  // Permitir whitespace en `<script type="application/ld+json" >` (cnnchile lo emite así).
  const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json"\s*>([\s\S]+?)<\/script>/g);

  let article: (JsonLdArticle & { thumbnailUrl?: string }) | null = null;
  for (const match of jsonLdMatches) {
    try {
      const found = findArticleNode(JSON.parse(sanitizeJsonControlChars(match[1])));
      if (found) { article = found as JsonLdArticle & { thumbnailUrl?: string }; break; }
    } catch {
      // JSON inválido, continuar
    }
  }

  // og:* fallbacks aceptan single y double quotes (cnnchile usa simples).
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=(?:"([^"]+)"|'([^']+)')/);
  const ogDescription = html.match(/<meta\s+property=["']og:description["']\s+content=(?:"([^"]+)"|'([^']+)')/);
  const ogImage = html.match(/<meta\s+property=["']og:image["']\s+content=(?:"([^"]+)"|'([^']+)')/);

  const title = article?.headline ?? ogTitle?.[1] ?? ogTitle?.[2];
  if (!title) {
    throw new Error('No se pudo extraer el título del artículo');
  }

  const subtitle = article?.description ?? ogDescription?.[1] ?? ogDescription?.[2];
  const author = extractAuthor(article?.author);
  const date = article?.datePublished;

  // image en cnnchile suele ser una referencia ({"@id": "...#primaryimage"}),
  // que extractImage no puede resolver — caer a thumbnailUrl o og:image.
  const imageUrl =
    extractImage(article?.image) ??
    article?.thumbnailUrl ??
    ogImage?.[1] ??
    ogImage?.[2];

  // Body: contenedor con la clase `article-details` (lista mixta de tokens).
  // Cierra antes de `<div class="main-socials`.
  const bodyMatch = html.match(
    /<div class="[^"]*\barticle-details\b[^"]*">([\s\S]*?)<\/div>\s*<div class="main-socials/,
  );

  let body = '';
  if (bodyMatch) {
    let content = bodyMatch[1];
    // Quitar el input hidden de ads
    content = content.replace(/<input[^>]*>/gi, '');
    // Quitar iframes (no renderean en Telegraph)
    content = content.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    // h2 → párrafo en negrita
    content = content.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '<p><strong>$1</strong></p>');
    // Normalizar párrafos (quitar atributos como class="rtejustify")
    content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '<p>$1</p>');
    // Quitar tags inline manteniendo el texto
    content = content.replace(/<\/?(?:strong|b|em|i|a|span|br)[^>]*>/gi, '');
    // Quitar el resto de tags excepto <p>/</p>
    content = content.replace(/<(?!\/?p\b)[^>]+>/g, '');
    // Colapsar espacios
    body = content.replace(/\s+/g, ' ').trim();
  }

  if (subtitle && body) {
    body = `<p><em>${subtitle}</em></p>\n${body}`;
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const images: Article['images'] = imageUrl ? [{ url: imageUrl }] : undefined;

  return {
    title,
    subtitle,
    author,
    date,
    body,
    images,
    url,
    source: 'cnnchile',
  };
}

import type { Article } from '../types.js';
import { fetchBypass } from './fetch-bypass.js';
import { type JsonLdArticle, extractAuthor, extractImage } from './helpers/json-ld.js';

function extractBodyFromHtml(html: string): string | null {
  // NYT stores article body in <section name="articleBody">
  const sectionMatch = html.match(/<section[^>]*name="articleBody"[^>]*>([\s\S]*?)<\/section>/i);
  if (!sectionMatch) return null;

  const sectionHtml = sectionMatch[1];

  // Extract paragraphs
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*class="[^"]*css-[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(sectionHtml)) !== null) {
    // Clean HTML tags but keep text
    let text = match[1]
      .replace(/<[^>]+>/g, '') // Remove HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .trim();

    if (text) {
      paragraphs.push(text);
    }
  }

  if (paragraphs.length === 0) return null;

  return paragraphs.map((p) => `<p>${p}</p>`).join('\n');
}

export async function extract(url: string): Promise<Article> {
  // NYT started returning 403 to Google-InspectionTool. Chrome TLS impersonation
  // still gets server-rendered HTML with the article body under
  // <section name="articleBody">, which extractBodyFromHtml parses below.
  // JSON-LD headline/author metadata are present; articleBody there is empty.
  // Intentionally NOT using recipe.useragent_custom (Google-InspectionTool) —
  // we override with chrome mode here. Recipe still useful for cookie strip.
  const html = await fetchBypass(url, {
    referer: 'https://www.google.com/',
    mode: 'chrome',
  });

  // Extract JSON-LD for metadata
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdData: JsonLdArticle | null = null;

  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data['@type'] === 'NewsArticle' || data['@type'] === 'Article') {
        jsonLdData = data;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!jsonLdData) {
    throw new Error('No se encontró JSON-LD del artículo');
  }

  // Get body - first try JSON-LD articleBody, then extract from HTML
  let body = jsonLdData.articleBody
    ? jsonLdData.articleBody.split(/\n+/).filter((p) => p.trim()).map((p) => `<p>${p}</p>`).join('\n')
    : extractBodyFromHtml(html);

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  const imageUrl = extractImage(jsonLdData.image);

  return {
    title: jsonLdData.headline || 'Sin título',
    author: extractAuthor(jsonLdData.author),
    date: jsonLdData.datePublished,
    body,
    images: imageUrl ? [{ url: imageUrl }] : undefined,
    url,
    source: 'nyt',
  };
}

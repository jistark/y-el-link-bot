import type { Article } from '../types.js';
import { getRecipe } from './recipes.js';
import { fetchBypass } from './fetch-bypass.js';
import { type JsonLdArticle, extractAuthor, extractImage } from './helpers/json-ld.js';

export async function extract(url: string): Promise<Article> {
  const html = await fetchWithRecipe(url);

  // Waterfall extraction: JSON-LD -> __NEXT_DATA__ -> HTML fallback
  const article = extractJsonLd(html) || extractNextData(html) || extractHtmlFallback(html);

  if (!article || !article.title || !article.body) {
    throw new Error('No se pudo extraer contenido del artículo');
  }

  // Quality gate: at least 2 paragraphs with >40 chars of text
  const paragraphs = article.body
    .split(/<\/p>|<\/li>|\n\n/)
    .filter(p => p.replace(/<[^>]+>/g, '').trim().length > 40);
  if (paragraphs.length < 2) {
    throw new Error('Contenido insuficiente (menos de 2 párrafos)');
  }

  article.url = url;
  article.source = 'generic';
  return article as Article;
}

async function fetchWithRecipe(url: string): Promise<string> {
  const recipe = getRecipe(url);

  if (!recipe) {
    // No recipe -- try plain fetch with browser-like headers
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  const allHeaders = { ...recipe.headers };
  if (recipe.stripCookies) allHeaders['Cookie'] = '';

  // Try native fetch first (lightweight, no Python)
  try {
    const res = await fetch(url, {
      headers: allHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return await res.text();
    // If 403/503, fall through to curl_cffi
    if (res.status !== 403 && res.status !== 503) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.startsWith('HTTP ')) throw err;
    // Network error -- fall through to curl_cffi
  }

  // Cloudflare fallback: use Python curl_cffi with TLS impersonation
  const isGooglebot = allHeaders['User-Agent']?.includes('Googlebot');
  const mode = isGooglebot ? 'googlebot' as const : 'chrome' as const;
  return fetchBypass(url, allHeaders['Referer'], mode);
}

const ARTICLE_TYPES = new Set([
  'NewsArticle', 'Article', 'ReportageNewsArticle', 'BlogPosting', 'OpinionNewsArticle',
]);

function extractJsonLd(html: string): Partial<Article> | null {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      let data = JSON.parse(match[1]);
      // Handle array of JSON-LD objects
      if (Array.isArray(data)) {
        data = data.find((d: JsonLdArticle) => d['@type'] && ARTICLE_TYPES.has(d['@type']));
      }
      if (!data || !data['@type'] || !ARTICLE_TYPES.has(data['@type'])) continue;

      const articleBody: string | undefined = data.articleBody;
      if (!articleBody) continue;

      // Convert plain text to HTML paragraphs
      const body = articleBody.includes('<p>')
        ? articleBody
        : articleBody
            .split(/\n\n+/)
            .filter((p: string) => p.trim())
            .map((p: string) => `<p>${p.trim()}</p>`)
            .join('\n');

      return {
        title: data.headline || data.name,
        subtitle: data.description,
        author: extractAuthor(data.author),
        date: data.datePublished,
        body,
        images: data.image
          ? [{ url: extractImage(data.image) || '' }].filter(i => i.url)
          : undefined,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function extractNextData(html: string): Partial<Article> | null {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);
    const gc = data?.props?.pageProps?.globalContent;
    if (!gc) return null;

    const textElements =
      gc.content_elements?.filter(
        (e: { type?: string; content?: string }) => e.type === 'text' && e.content,
      ) || [];
    if (textElements.length === 0) return null;

    const body = textElements
      .map((e: { content: string }) => `<p>${e.content}</p>`)
      .join('\n');
    const authors = gc.credits?.by
      ?.map((a: { name?: string }) => a.name)
      .filter(Boolean)
      .join(', ');
    const imageUrl: string | undefined = gc.promo_items?.basic?.url;

    return {
      title: gc.headlines?.basic,
      subtitle: gc.subheadlines?.basic,
      author: authors || undefined,
      date: gc.publish_date,
      body,
      images: imageUrl ? [{ url: imageUrl }] : undefined,
    };
  } catch {
    return null;
  }
}

function extractHtmlFallback(html: string): Partial<Article> | null {
  // Title from meta
  const titleMatch =
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
  if (!title) return null;

  // Image from meta
  const imageMatch = html.match(
    /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
  );

  // Author from meta
  const authorMatch = html.match(
    /<meta\s+(?:name|property)=["'](?:author|article:author)["']\s+content=["']([^"']+)["']/i,
  );

  // Date from meta
  const dateMatch = html.match(
    /<meta\s+property=["']article:published_time["']\s+content=["']([^"']+)["']/i,
  );

  // Subtitle from meta
  const subtitleMatch = html.match(
    /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
  );

  // Body: find <article> or main content
  let bodyHtml = '';
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    bodyHtml = articleMatch[1];
  } else {
    // Fallback: use the full page
    bodyHtml = html;
  }

  // Extract paragraphs
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = pMatch[1].replace(/<[^>]+>/g, '').trim();
    if (text.length > 40) {
      // Keep the HTML version (with links, bold, etc.)
      paragraphs.push(`<p>${pMatch[1].trim()}</p>`);
    }
  }

  if (paragraphs.length < 2) return null;

  return {
    title,
    subtitle: subtitleMatch?.[1],
    author: authorMatch?.[1],
    date: dateMatch?.[1],
    body: paragraphs.join('\n'),
    images: imageMatch ? [{ url: imageMatch[1] }] : undefined,
  };
}

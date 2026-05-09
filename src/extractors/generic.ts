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
  if (recipe.stripCookies) delete allHeaders['Cookie'];

  // Try native fetch first (lightweight, no Python)
  try {
    const res = await fetch(url, {
      headers: allHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return await res.text();
    // On bot-protection blocks, fall through to curl_cffi / Web Unblocker.
    // 401: Reuters (Cloudflare configured to challenge with 401 from datacenter IPs)
    // 402: paywall-via-status (rare but seen)
    // 403/429: Cloudflare / generic block / rate limit
    // 451: geo-blocking (proxy from a friendly country may unblock)
    // 503/52x: Cloudflare service-unavailable / origin issues
    const PROXY_FALLBACK_STATUSES = new Set([401, 402, 403, 429, 451, 503]);
    if (!PROXY_FALLBACK_STATUSES.has(res.status)
      && !(res.status >= 520 && res.status <= 530)) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.startsWith('HTTP ')) throw err;
    // Network error -- fall through to curl_cffi
  }

  // Cloudflare fallback: use Python curl_cffi with TLS impersonation.
  // Pass the full recipe headers so per-domain bypass strategies (haaretz
  // mobile UA, headers_custom, X-Forwarded-For) survive proxy escalation.
  const isGooglebot = allHeaders['User-Agent']?.includes('Googlebot');
  const isInspectionTool = allHeaders['User-Agent']?.includes('Google-InspectionTool');
  const mode = isInspectionTool ? 'inspectiontool' as const
    : isGooglebot ? 'googlebot' as const
    : 'chrome' as const;
  return fetchBypass(url, {
    referer: allHeaders['Referer'],
    headers: allHeaders,
    mode,
  });
}

const ARTICLE_TYPES = new Set([
  'NewsArticle', 'Article', 'ReportageNewsArticle', 'BlogPosting', 'OpinionNewsArticle',
]);

// Turn a JSON-LD articleBody (plain text, sometimes without line breaks) into
// HTML paragraphs. Tries \n\n, then \n, then falls back to grouping sentences
// into ~300-char chunks so single-blob bodies still render as multiple <p>s
// and pass the quality gate downstream.
function articleBodyToHtml(text: string): string {
  if (text.includes('<p>')) return text;
  let parts: string[];
  if (/\n\n/.test(text)) parts = text.split(/\n\n+/);
  else if (/\n/.test(text)) parts = text.split(/\n+/);
  else {
    const sentences = text.split(/(?<=[.!?])\s+/);
    parts = [];
    let cur = '';
    for (const s of sentences) {
      cur += (cur ? ' ' : '') + s;
      if (cur.length >= 300) { parts.push(cur); cur = ''; }
    }
    if (cur.trim()) parts.push(cur);
  }
  return parts
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p}</p>`)
    .join('\n');
}

// Flatten a JSON-LD root into candidate article nodes.
// Handles three common shapes:
//   1. single object: {"@type": "NewsArticle", ...}
//   2. top-level array: [{...}, {...}]
//   3. schema.org @graph: {"@context": "...", "@graph": [{...}, {...}]}
function collectArticleCandidates(data: unknown): JsonLdArticle[] {
  const out: JsonLdArticle[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    const obj = node as Record<string, unknown>;
    // schema.org allows @type to be a single string OR an array of strings
    // (e.g. ["NewsArticle", "Article"]). Handle both shapes.
    const t = obj['@type'];
    const types = typeof t === 'string' ? [t] : Array.isArray(t) ? t : [];
    if (types.some(x => typeof x === 'string' && ARTICLE_TYPES.has(x))) {
      out.push(obj as JsonLdArticle);
    }
    if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
  };
  visit(data);
  return out;
}

function extractJsonLd(html: string): Partial<Article> | null {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const root = JSON.parse(match[1]);
      // Try every article-like node in the tree; keep the one with articleBody.
      const candidates = collectArticleCandidates(root);
      const data = candidates.find(c => c.articleBody) || candidates[0];
      if (!data) continue;

      const articleBody: string | undefined = data.articleBody;
      if (!articleBody) continue;

      const body = articleBodyToHtml(articleBody);

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

  // Body: try a series of progressively-broader containers. Falling back to
  // the full page is a last resort because it pulls nav/footer/cookie-banner
  // <p> tags into the body and slows the regex scan over hundreds of KB.
  let bodyHtml = '';
  const containerPatterns: RegExp[] = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<div[^>]+id=["']content["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of containerPatterns) {
    const m = html.match(re);
    if (m) { bodyHtml = m[1]; break; }
  }
  if (!bodyHtml) bodyHtml = html; // último recurso

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

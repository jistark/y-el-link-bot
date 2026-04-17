import type { Article } from '../types.js';
import { fetchBypass } from './fetch-bypass.js';
import { type JsonLdArticle, extractAuthor, extractImage } from './helpers/json-ld.js';

function extractBodyFromHtml(html: string): string | null {
  // FT's markup has shifted over time. Try current selectors first,
  // then fall back to legacy ones for older cached pages.
  const bodyMatch =
    html.match(/<div[^>]*class="[^"]*article__content[^"]*"[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (!bodyMatch) return null;

  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = pRegex.exec(bodyMatch[1])) !== null) {
    let text = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (text && text.length > 10) {
      paragraphs.push(text);
    }
  }

  if (paragraphs.length === 0) return null;
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n');
}

async function fetchArticleHtml(url: string): Promise<string> {
  // Strip tracking/syndication query params (e.g. ?syn-25a6b1a6=1) —
  // they don't affect content but can skew CDN rate-limit buckets.
  const cleanUrl = url.replace(/\?.*$/, '');

  // Strategy 1: Bun's native fetch with Google referer.
  // Bun's TLS fingerprint (BoringSSL) is far less targeted by Cloudflare
  // than curl_cffi's Chrome impersonation, avoiding datacenter-IP 429s.
  try {
    const res = await fetch(cleanUrl, {
      headers: {
        Referer: 'https://www.google.com/',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      if (html.includes('articleBody') || html.includes('article__content')) {
        return html;
      }
    }
  } catch {
    // Fall through to curl_cffi
  }

  // Strategy 2: curl_cffi Chrome TLS impersonation (fallback)
  return fetchBypass(cleanUrl, 'https://www.google.com/');
}

export async function extract(url: string): Promise<Article> {
  const html = await fetchArticleHtml(url);

  // Extract JSON-LD
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdData: JsonLdArticle | null = null;

  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const article = Array.isArray(data)
        ? data.find((d) => d['@type'] === 'NewsArticle' || d['@type'] === 'Article')
        : data['@type'] === 'NewsArticle' || data['@type'] === 'Article'
          ? data
          : null;

      if (article) {
        jsonLdData = article;
        break;
      }
    } catch {
      continue;
    }
  }

  // Get body
  let body: string | null = null;

  if (jsonLdData?.articleBody) {
    body = jsonLdData.articleBody
      .split(/\n+/)
      .filter((p) => p.trim())
      .map((p) => `<p>${p}</p>`)
      .join('\n');
  } else {
    body = extractBodyFromHtml(html);
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Get title
  let title = jsonLdData?.headline;
  if (!title) {
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle?.[1];
  }

  if (!title) {
    throw new Error('No se pudo extraer el título');
  }

  const imageUrl = extractImage(jsonLdData?.image);

  return {
    title,
    subtitle: jsonLdData?.description,
    author: extractAuthor(jsonLdData?.author),
    date: jsonLdData?.datePublished,
    body,
    images: imageUrl ? [{ url: imageUrl }] : undefined,
    url,
    source: 'ft',
  };
}

/**
 * Helpers shared between the Chorus and Clay extractors.
 *
 * Both stacks share a few HTML-sanitation needs (filtering UI chrome,
 * de-duplicating responsive image variants, stripping schema-JSON literals
 * that NY Mag templates inject into the article DOM) but their primary
 * extraction strategies differ — Chorus reads JSON-LD `articleBody`, Clay
 * scrapes `.article-content` — so the strategy-specific code lives in
 * separate modules.
 */

import type { JsonLdArticle } from '../helpers/json-ld.js';

/**
 * Convert a JSON-LD articleBody (plain text) into HTML paragraphs. Tries
 * `\n\n` then `\n` then sentence-grouped chunks of ~300 chars. Mirrors the
 * fallback ladder in generic.ts so behavior stays consistent for sites
 * whose articleBody style changes over time.
 *
 * Vox uses single `\n` between paragraphs; The Verge has used `\n\n` in the
 * past. The waterfall handles both without per-site config.
 */
export function articleBodyToHtml(text: string): string {
  if (text.includes('<p>')) return text;
  let parts: string[];
  if (/\n\n/.test(text)) parts = text.split(/\n\n+/);
  else if (/\n/.test(text)) parts = text.split(/\n+/);
  else {
    // No newlines at all — group sentences into ~300-char chunks so the
    // result is at least readable. JSON-LD articleBody rarely lacks
    // newlines but cheap CMSs sometimes flatten everything to one line.
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
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p}</p>`)
    .join('\n');
}

/**
 * Patterns we drop from Clay article-content scraping. Each is a substring
 * (case-insensitive) tested against paragraph text. These are NY Mag UI
 * chrome that survive the `.article-content` selector because the template
 * renders them inside the prose container alongside real paragraphs.
 *
 * Conservative on purpose — short-but-meaningful prose like "Yes." or
 * "Reader, I married him." should never match. Patterns are full UI strings
 * rather than fragments to avoid false-positives.
 */
const CLAY_UI_CHROME_PATTERNS: RegExp[] = [
  /^\s*save\s*$/i,
  /^\s*saved\s*$/i,
  /^\s*comment\s*$/i,
  /^\s*Save this article to read it later\.?\s*$/i,
  /^\s*Find this story in your account.{0,80}section\.?\s*$/i,
  /^\s*This article was featured in New York['’]s/i,
  /^\s*Sign up here\.?\s*$/i,
  // Photo-essay gallery navigation
  /^\s*photogrid:\s/i,
];

export function isUIChrome(text: string): boolean {
  return CLAY_UI_CHROME_PATTERNS.some((re) => re.test(text));
}

/**
 * Some Clay templates render the article's schema.org metadata as a literal
 * `<p>` inside `.article-content` (presumably for client-side hydration of
 * paywall logic). When the Telegraph formatter splits the multi-line `<p>`
 * by newlines, the result is dozens of one-line `<p>` tags containing `{`,
 * `"@id": …`, etc. We drop any paragraph that starts with a JSON literal
 * marker before it ever reaches the formatter.
 */
export function isInlineSchemaJson(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // A multi-line schema dump always starts with `{` and contains schema.org
  // markers within the first few lines. Single `{` would be too aggressive
  // (could match legitimate prose), so require co-occurrence with `@id`,
  // `@context`, or `@type` somewhere in the block.
  if (!t.startsWith('{')) return false;
  return /["']@(id|context|type)["']\s*:/.test(t);
}

/**
 * NY Mag and The Cut embed multiple variants of the same image (different
 * crop/width for responsive layouts) as separate `<figure>` elements. They
 * share a base URL up to a `.<variant>.w<width>` suffix:
 *
 *   .../IMG.rvertical.w570.jpg
 *   .../IMG.1x.rsocial.w1200.jpg
 *
 * Group by the base path (everything before the first dotted variant
 * suffix) so we keep one figure per image source.
 */
export function imageBaseKey(url: string): string {
  // Strip everything after the last `/` to get the filename, then drop
  // any `.<variant>` suffixes before the extension.
  const filename = url.split('/').pop() || url;
  // Match `<basename>.<modifiers>.<ext>` — modifiers can be `.w570`,
  // `.rvertical`, `.1x`, `.rsocial`, etc. We collapse them all by taking
  // the portion up to the first dot.
  const baseName = filename.split('.')[0];
  return baseName;
}

/**
 * Filter helper that yields one image per `imageBaseKey`, preserving the
 * order of first occurrence. Used to collapse responsive variants emitted
 * by NY Mag templates without losing genuinely distinct images.
 */
export function dedupeImages<T extends { url: string }>(images: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const img of images) {
    const key = imageBaseKey(img.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(img);
  }
  return out;
}

/**
 * Joins author names from a JSON-LD `author` field, handling all the shapes
 * schema.org allows: single string, single object, array of strings, array
 * of objects, mixed. Returns undefined if no names recoverable.
 */
export function authorsFromJsonLd(author: JsonLdArticle['author']): string | undefined {
  if (!author) return undefined;
  const items = Array.isArray(author) ? author : [author];
  const names = items
    .map((a) => (typeof a === 'string' ? a : a?.name))
    .filter((n): n is string => Boolean(n && n.trim()));
  return names.length ? names.join(', ') : undefined;
}

/**
 * Clay extractor — New York Magazine's CMS, kept independent of Vox's Chorus
 * after the 2019 merger. Used by nymag.com (and its Intelligencer /
 * Strategist sections), vulture.com, thecut.com, grubstreet.com, curbed.com.
 *
 * Strategy: scrape the `.article-content` container, but match prose by the
 * semantic `clay-paragraph` class rather than tag-name. NY Mag templates
 * inject UI chrome (save/comment buttons), responsive-image variants, and
 * even literal `<script type="application/ld+json">` blocks inside
 * `.article-content` — matching by class lets us walk past that noise
 * without per-element sanitization.
 *
 * Photo galleries (e.g. The Cut's `image-gallery-*` slideshows) are out of
 * scope here; they'll fall through to whatever the gallery-specific path
 * looks like in a future revision.
 */

import type { Article } from '../../types.js';
import { decodeEntities } from '../../utils/shared.js';
import { dedupeImages, isInlineSchemaJson, isUIChrome } from './shared.js';

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

function decode(s: string): string {
  return decodeEntities(s);
}

function metaContent(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const re = new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]+)"`, 'i');
  const m = html.match(re);
  return m ? decode(m[1]) : undefined;
}

interface LedeImage {
  url: string;
  caption?: string;
}

/**
 * Finds the article's lede (cover) image. NY Mag emits
 *   <img class="lede-image" src="…">
 * followed by a sibling
 *   <div class="lede-image-data">
 *     <div class="caption">…</div>
 *     <div class="attribution"><span class="credit">Photo: …</span></div>
 *   </div>
 *
 * Both caption and credit can be present; we join them with em-dash. Returns
 * null when no lede image is found (the article may still have inline
 * images).
 */
function extractLedeImage(html: string): LedeImage | null {
  // The lede-image lives inside or near the article header. We don't pin
  // attribute order — Clay templates emit both `<img src="…" class="lede-…">`
  // and `<img data-src="…" class="lede-…">`, sometimes with `src` before
  // `class` and sometimes after.
  const ledeM = html.match(
    /<img[^>]*\bclass="[^"]*\blede-image\b[^"]*"[^>]*>([\s\S]{0,2000})/,
  );
  if (!ledeM) return null;
  const tag = ledeM[0];
  const srcM = tag.match(/\b(?:src|data-src)="([^"]+)"/);
  if (!srcM) return null;
  return parseLedeContext(decode(srcM[1]), ledeM[1]);
}

function parseLedeContext(url: string, context: string): LedeImage {
  const caption: string[] = [];
  // Both caption and credit can appear under .lede-image-data, but Clay
  // varies by site (some include only credit). Match each independently.
  const captionM = context.match(/<div[^>]*\bclass="[^"]*\bcaption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (captionM) {
    const text = stripTags(captionM[1]);
    if (text) caption.push(decode(text));
  }
  const creditM = context.match(/<span[^>]*\bclass="[^"]*\bcredit\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  if (creditM) {
    const text = stripTags(creditM[1]);
    if (text) caption.push(decode(text));
  }
  return { url, caption: caption.length ? caption.join(' — ') : undefined };
}

/**
 * Walks `.article-content` and emits prose paragraphs and inline figures in
 * document order.
 *
 * Prose: restricted to `<p class="clay-paragraph*">` — that label is
 * applied exclusively to author-authored prose; UI controls (save buttons,
 * cookie banners) use other classes and stripped-down `<p>` tags inside
 * hydration scripts have no class at all.
 *
 * Inline images: `class="article-image"` (Vulture, The Cut, Curbed) or
 * `class="img-data"` (The Cut, NY Mag, Curbed). Both are NY Mag templates
 * applied to the same conceptual element; we match either.
 *
 * No section-header extraction: investigated across 7 Clay samples (vulture,
 * thecut, intelligencer, grubstreet, curbed), no consistent semantic class
 * exists for in-article subheaders. All `<h2|h3>` elements inside
 * `.article-content` are either the article's own headline or UI widgets
 * (newsletter signup, most-viewed, related stories).
 */
function extractArticleBody(html: string): { body: string; inlineImages: LedeImage[] } | null {
  // Find the article-content container.
  const startM = html.match(/<div[^>]*\bclass="[^"]*\barticle-content\b[^"]*"[^>]*>/);
  if (!startM) return null;
  const start = startM.index! + startM[0].length;
  // We don't try to find the closing </div> — div nesting makes that unreliable
  // without a real parser. Instead, scan a generous window (~250KB) which
  // easily covers the longest NY Mag features we've measured (~210KB body).
  const region = html.slice(start, start + 250_000);

  // Two-alternative pattern so paragraphs and figures emerge in order.
  // For <img>, we don't pin attribute order — Clay templates emit
  // `<img data-src="…" class="img-data">` as well as `<img src="…"
  // class="lede-image">`, so we require the class anywhere in the tag and
  // pull src/data-src in a second pass on the matched tag.
  const pattern =
    /(?:<p[^>]+class="[^"]*\bclay-paragraph(?:_[a-z-]+)?\b[^"]*"[^>]*>([\s\S]*?)<\/p>)|(?:<img[^>]*\bclass="[^"]*\b(?:article-image|img-data)\b[^"]*"[^>]*>([\s\S]{0,1500}))/g;

  const blocks: string[] = [];
  const inlineImages: LedeImage[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = pattern.exec(region)) !== null) {
    if (mm[1] !== undefined) {
      // clay-paragraph
      let inner = mm[1].trim();
      // Strip HTML comments (rare but present in some Clay templates)
      inner = inner.replace(/<!--[\s\S]*?-->/g, '');
      // Collapse whitespace including embedded newlines
      inner = inner.replace(/\s+/g, ' ').trim();
      const plain = stripTags(inner);
      if (!plain) continue;
      // Some `clay-paragraph` elements are template-inserted UI: the
      // "One Great Story" newsletter promo at the top of NY Mag features,
      // "Save this article" overlays, etc. They share the class with real
      // prose, so we filter by content pattern. Inline-schema JSON ought
      // to be impossible in a clay-paragraph but check defensively.
      if (isUIChrome(plain) || isInlineSchemaJson(plain)) continue;
      blocks.push(`<p>${inner}</p>`);
    } else if (mm[2] !== undefined) {
      // inline figure — recover src or data-src from the matched <img> tag
      // (mm[0]) since attribute order varies, then look for caption/credit
      // in the following 1500 chars.
      const tag = mm[0];
      const srcM = tag.match(/\b(?:src|data-src)="([^"]+)"/);
      if (!srcM) continue;
      const url = decode(srcM[1]);
      const fig = parseLedeContext(url, mm[2]);
      const figureHtml = fig.caption
        ? `<figure><img src="${fig.url}"><figcaption>${fig.caption}</figcaption></figure>`
        : `<figure><img src="${fig.url}"></figure>`;
      blocks.push(figureHtml);
      inlineImages.push(fig);
    }
  }

  return { body: blocks.join('\n'), inlineImages };
}

export function parseClayArticle(html: string): Partial<Article> | null {
  const title = metaContent(html, 'property', 'og:title');
  const ogDesc = metaContent(html, 'property', 'og:description');
  const author = metaContent(html, 'name', 'author');
  const date = metaContent(html, 'property', 'article:published_time');
  const ogImage = metaContent(html, 'property', 'og:image');

  if (!title) return null;

  const parsed = extractArticleBody(html);
  if (!parsed) return null;
  // Quality gate: NY Mag photo galleries (image-gallery-*) and stub pages
  // can have under 3 prose paragraphs; we fall through to let the caller
  // try other paths rather than emit a sparse article.
  const paragraphCount = (parsed.body.match(/<p>/g) || []).length;
  if (paragraphCount < 3) return null;

  const lede = extractLedeImage(html);
  const cover = lede
    ? { url: lede.url, ...(lede.caption ? { caption: lede.caption } : {}) }
    : ogImage
      ? { url: ogImage }
      : undefined;

  // Combine cover and inline images, dedupe by base URL so responsive
  // variants (.w570, .w1200, etc.) don't show up twice.
  const allImages = dedupeImages([
    ...(cover ? [cover] : []),
    ...parsed.inlineImages,
  ]);

  return {
    title: decode(title),
    subtitle: ogDesc,
    author,
    date,
    body: parsed.body,
    images: allImages.length ? allImages : undefined,
  };
}

import type { Article } from '../types.js';
import { fetchBypass } from './fetch-bypass.js';
import { decodeEntities } from '../utils/shared.js';

// Bloomberg ships two coexisting article layouts:
//
//   * "modern" — used by /news/articles/* and /news/features/*. The page is a
//     Next.js app and the structured story (headline, body blocks, byline,
//     lede image) is embedded in `__NEXT_DATA__`. JSON-LD is present but
//     paywall-stripped (no articleBody).
//
//   * "feature" — used by /features/*. No __NEXT_DATA__. JSON-LD has the
//     metadata (headline, description, authors, date, image) but no body. The
//     body lives in the SSR DOM under semantic classes `ds--paragraph`,
//     `ds--*` for headers, and `ds--*` for figures.
//
// extractFromNextData runs first; on null, extractFromFeatureDOM picks up
// /features/ URLs. If both fail we surface a hard error rather than fall
// through to a naïve <p>-scrape — the previous fallback caught CSS-in-JS and
// minified scripts that Bloomberg embeds inside `<p>` tags.

interface BodyNode {
  type: string;
  value?: string;
  content?: BodyNode[];
  data?: Record<string, unknown>;
  subType?: string;
}

interface MediaPhoto {
  caption?: string;
  credit?: string;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

// Truthy `[]` and empty strings would defeat `a || b` fallbacks (Bloomberg's
// `story.abstract` arrives as `[]` for many articles, hiding `story.summary`).
function firstNonEmpty<T>(values: Array<T | null | undefined>): T | undefined {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return undefined;
}

function joinCaption(parts: Array<string | undefined>): string {
  return parts.map((p) => (p ? stripTags(p) : '')).filter(Boolean).join(' — ');
}

// ---------- modern layout (__NEXT_DATA__) ----------

function collectInline(node: BodyNode): string {
  if (node.type === 'text') return node.value || '';
  if (node.type === 'link' && node.content) {
    const href = (node.data as { href?: string } | undefined)?.href;
    const inner = node.content.map(collectInline).join('');
    return href ? `<a href="${href}">${inner}</a>` : inner;
  }
  if (node.type === 'italic' && node.content) {
    return `<i>${node.content.map(collectInline).join('')}</i>`;
  }
  if (node.type === 'bold' && node.content) {
    return `<b>${node.content.map(collectInline).join('')}</b>`;
  }
  if (node.content) return node.content.map(collectInline).join('');
  return '';
}

function extractMediaFigure(block: BodyNode): string | null {
  const d = block.data as
    | { remoteContent?: Array<{ link?: { destination?: { web?: string } } }>; photo?: MediaPhoto; chart?: MediaPhoto }
    | undefined;
  const web = d?.remoteContent?.[0]?.link?.destination?.web;
  if (!web || typeof web !== 'string') return null;
  // Bloomberg's interactive charts are HTML pages embedded via iframe;
  // Telegraph can't render them. Skip — the surrounding prose carries the
  // takeaway anyway.
  if (/\.(html?|aspx)(\?|$)/i.test(web)) return null;
  const meta = d.photo || d.chart;
  const caption = joinCaption([meta?.caption, meta?.credit]);
  return `<figure><img src="${web}">${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

interface BloombergStory {
  headline?: string;
  title?: string;
  abstract?: unknown;
  summary?: unknown;
  authors?: Array<{ name?: string }>;
  byline?: string;
  publishedAt?: string;
  updatedAt?: string;
  ledeImageUrl?: string;
  ledeImage?: MediaPhoto;
  thumbnailImage?: { url?: string };
  body?: { content?: BodyNode[] };
}

function extractFromNextData(html: string): Partial<Article> | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;

  let parsed: { props?: { pageProps?: { story?: BloombergStory } } };
  try { parsed = JSON.parse(m[1]); } catch { return null; }

  const story = parsed?.props?.pageProps?.story;
  if (!story?.body?.content) return null;

  const blocks: string[] = [];
  for (const block of story.body.content) {
    if (block.type === 'paragraph' && block.content) {
      const inner = block.content.map(collectInline).join('').trim();
      if (inner) blocks.push(`<p>${inner}</p>`);
    } else if (block.type === 'heading' && block.content) {
      const text = stripTags(block.content.map(collectInline).join(''));
      if (text) blocks.push(`<h3>${text}</h3>`);
    } else if (block.type === 'media') {
      const figure = extractMediaFigure(block);
      if (figure) blocks.push(figure);
    }
    // ad / inline-newsletter / inline-recirc → drop
  }
  const body = blocks.join('\n');
  if (!body) return null;

  // Subtitle: abstract (string), else summary (often `<p>…</p>`)
  const abstract = typeof story.abstract === 'string' ? story.abstract : undefined;
  const summary = typeof story.summary === 'string' ? stripTags(story.summary) : undefined;
  const subtitleRaw = firstNonEmpty([abstract, summary]);
  const subtitle = subtitleRaw ? decodeEntities(subtitleRaw).trim() : undefined;

  const authorNames = (story.authors || [])
    .map((a) => a.name)
    .filter((n): n is string => Boolean(n));
  const author = authorNames.length
    ? authorNames.join(', ')
    : (typeof story.byline === 'string' ? story.byline : undefined);

  const ledeUrl = story.ledeImageUrl || story.thumbnailImage?.url;
  const ledeCaption = joinCaption([story.ledeImage?.caption, story.ledeImage?.credit]);
  const images = ledeUrl ? [{ url: ledeUrl, ...(ledeCaption ? { caption: ledeCaption } : {}) }] : undefined;

  return {
    title: story.headline || story.title,
    subtitle,
    author,
    date: story.publishedAt || story.updatedAt,
    body,
    images,
  };
}

// ---------- legacy /features/ layout (DS classes + JSON-LD) ----------

interface JsonLdAuthor { name?: string }
interface JsonLdImage { url?: string }
interface JsonLdNewsArticle {
  headline?: string;
  description?: string;
  author?: JsonLdAuthor | JsonLdAuthor[];
  datePublished?: string;
  image?: string | JsonLdImage | Array<string | JsonLdImage>;
}

function parseJsonLd(html: string): JsonLdNewsArticle {
  const m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return {};
  try { return JSON.parse(m[1]) as JsonLdNewsArticle; } catch { return {}; }
}

function extractFromFeatureDOM(html: string): Partial<Article> | null {
  const ld = parseJsonLd(html);

  // Title cascade: prefer the <h1> visible on the page (matches what the user
  // sees), fall back to the JSON-LD headline (Bloomberg ships a separate SEO
  // headline for share/social — useful if the DOM <h1> is missing).
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const h1Title = h1M ? stripTags(h1M[1]) : '';
  const title = h1Title || ld.headline;
  if (!title) return null;

  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
  const subtitleRaw = ld.description || (ogDesc ? decodeEntities(ogDesc[1]) : undefined);
  const subtitle = subtitleRaw?.trim();

  let author: string | undefined;
  if (Array.isArray(ld.author)) {
    const names = ld.author.map((a) => a.name).filter((n): n is string => Boolean(n));
    if (names.length) author = names.join(', ');
  } else if (ld.author && typeof ld.author === 'object' && ld.author.name) {
    author = ld.author.name;
  }

  // Body: scan after </h1> so navigation & header chrome (which sometimes
  // contains <p class="...other..."> tags with cookie banners) doesn't
  // pollute results. Match ds--paragraph for prose, ds--* headers for
  // section breaks, and ds--* figures for inline images.
  const bodyStart = h1M ? (h1M.index ?? 0) + h1M[0].length : 0;
  const region = html.slice(bodyStart);
  const blockPattern = /(?:<p[^>]+class="[^"]*\bds--paragraph\b[^"]*"[^>]*>([\s\S]*?)<\/p>)|(?:<h([23])[^>]+class="[^"]*\bds--[^"]*"[^>]*>([\s\S]*?)<\/h\2>)|(?:<figure[^>]+class="[^"]*\bds--[^"]*"[^>]*>([\s\S]*?)<\/figure>)/g;

  const parts: string[] = [];
  const inlineImages: Array<{ url: string; caption?: string }> = [];
  let mm: RegExpExecArray | null;
  while ((mm = blockPattern.exec(region)) !== null) {
    if (mm[1] !== undefined) {
      let inner = mm[1].replace(/<!--[\s\S]*?-->/g, '');
      // Bloomberg's terminal/security links emit <a> tags with empty href
      // (the link target lives in a `data-bbg` attribute we can't follow).
      // Strip the wrapper so the text doesn't become a broken link.
      inner = inner.replace(
        /<a\s+(?![^>]*\bhref="[^"]+")[^>]*>([\s\S]*?)<\/a>/g,
        '$1'
      );
      inner = inner.replace(/\s+/g, ' ').trim();
      if (stripTags(inner)) parts.push(`<p>${inner}</p>`);
    } else if (mm[3] !== undefined) {
      const text = stripTags(mm[3].replace(/<!--[\s\S]*?-->/g, ''));
      if (text) parts.push(`<h${mm[2]}>${text}</h${mm[2]}>`);
    } else if (mm[4] !== undefined) {
      const finner = mm[4];
      const srcM = finner.match(/<img[^>]+src="([^"]+)"/);
      if (!srcM) continue;
      const src = decodeEntities(srcM[1]);
      const capM = finner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/);
      const caption = capM ? stripTags(capM[1]).replace(/\s+/g, ' ').trim() : undefined;
      inlineImages.push({ url: src, ...(caption ? { caption } : {}) });
    }
  }
  // Quality gate: a real Bloomberg feature has many paragraphs. < 3 means
  // either we matched the wrong page (e.g. paywall stub) or the layout is
  // unfamiliar.
  if (parts.length < 3) return null;

  // Lede image from JSON-LD; appended *before* inline images so the cover
  // shows up at the top of the Telegraph page.
  const ldImage = Array.isArray(ld.image) ? ld.image[0] : ld.image;
  const coverUrl = typeof ldImage === 'string' ? ldImage : ldImage?.url;
  const images = coverUrl
    ? [{ url: coverUrl }, ...inlineImages]
    : inlineImages.length ? inlineImages : undefined;

  return {
    title,
    subtitle,
    author,
    date: ld.datePublished,
    body: parts.join('\n'),
    images,
  };
}

// ---------- public entry point ----------

export function parseArticle(html: string): Partial<Article> | null {
  return extractFromNextData(html) ?? extractFromFeatureDOM(html);
}

export async function extract(url: string): Promise<Article> {
  const html = await fetchBypass(url, 'https://www.google.com/');
  const data = parseArticle(html);

  if (!data?.title || !data?.body) {
    throw new Error('No se pudo extraer el contenido de Bloomberg');
  }

  return {
    title: data.title,
    subtitle: data.subtitle,
    author: data.author,
    date: data.date,
    body: data.body,
    images: data.images,
    url,
    source: 'bloomberg',
  };
}

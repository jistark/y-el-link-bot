import type { Article } from '../types.js';
import { escapeHtmlMinimal } from '../utils/shared.js';

// Whitelist-based sanitizer for El Mercurio markup tags.
// Converts known proprietary tags to standard HTML; strips unknown tags
// but preserves their text content.
export function sanitizeMercurioMarkup(input: string): string {
  if (!input) return '';
  let s = input;

  // Self-closing first (accept attributes)
  s = s.replace(/<dropcap(\s[^>]*)?\s*\/?>/gi, '');

  // Wrappers we want to drop entirely (outer container only — content kept)
  s = s.replace(/<\/?body(\s[^>]*)?>/gi, '');
  s = s.replace(/<\/?head_label(\s[^>]*)?>/gi, '');
  s = s.replace(/<\/?head_deck(\s[^>]*)?>/gi, '');
  s = s.replace(/<\/?byline(\s[^>]*)?>/gi, '');
  s = s.replace(/<\/?byline_credit(\s[^>]*)?>/gi, '');
  s = s.replace(/<\/?head(\s[^>]*)?>/gi, '');
  s = s.replace(/<\/?quote(\s[^>]*)?>/gi, '');

  // Tag substitutions (accept attributes on opening tags)
  s = s.replace(/<bold_intro(\s[^>]*)?>([\s\S]*?)<\/bold_intro>/gi, '<p><b>$2</b></p>');
  s = s.replace(/<leadin(\s[^>]*)?>([\s\S]*?)<\/leadin>/gi, '<b>$2</b>');
  s = s.replace(/<subhead(\s[^>]*)?>([\s\S]*?)<\/subhead>/gi, '<h3>$2</h3>');
  s = s.replace(/<bold(\s[^>]*)?>/gi, '<b>').replace(/<\/bold>/gi, '</b>');
  s = s.replace(/<italic(\s[^>]*)?>/gi, '<i>').replace(/<\/italic>/gi, '</i>');
  s = s.replace(/<P(\s[^>]*)?>/gi, '<p>').replace(/<\/P>/gi, '</p>');

  // Strip <highlight> wrapper but keep content
  s = s.replace(/<\/?highlight(\s[^>]*)?>/gi, '');

  // Strip any remaining unknown tags (preserve content)
  // Allowed: p, b, i, h3, h4, blockquote, figure, img, figcaption, br, a, hr, aside
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]*)(\s[^>]*)?>/g, (m, tag) => {
    const allowed = new Set(['p', 'b', 'i', 'h3', 'h4', 'blockquote', 'figure', 'img', 'figcaption', 'br', 'a', 'hr', 'aside', 'em', 'strong']);
    return allowed.has(tag.toLowerCase()) ? m : '';
  });

  return s.trim();
}

// Respuesta de la API JSON de digital.elmercurio.com
export interface MercurioImage {
  path: string;
  caption?: string;
  credits?: string;
  name?: string;
  noExport?: boolean;
  infographic?: boolean;
  width?: number;
  height?: number;
}

interface MercurioJsonArticle {
  title?: string;
  head?: string;
  head_label?: string;
  head_deck?: string;
  byline?: string;
  body?: string;
  quotes?: { quote: string }[];
  images?: MercurioImage[];
}

/**
 * Pure-function image filter exposed for unit tests.
 *
 * Rules:
 *  - Treat absent `noExport` / `infographic` as INCLUDE (only `=== true`
 *    excludes). Many real records omit these fields entirely.
 *  - Drop images smaller than 100×100 (decorative glyphs, print ornaments).
 *  - DO NOT filter by `name` starting with `NO_WEB_` — main article photos
 *    use that prefix.
 */
export function filterMercurioImages(
  images: MercurioImage[] | undefined,
): MercurioImage[] {
  if (!images) return [];
  return images.filter(img =>
    img.noExport !== true
    && img.infographic !== true
    && img.path
    && (img.width ?? 0) >= 100
    && (img.height ?? 0) >= 100
  );
}

// Respuesta de newsapi.ecn.cl (igual que La Segunda)
interface NewsApiResponse {
  _index: string;
  _source: {
    titulo: string;
    texto: string;
    autor?: string;
    bajada?: { texto: string }[];
    fechaPublicacion?: string;
    permalink?: string;
    tablas?: {
      tablaMedios?: { Url: string; Bajada?: string }[];
    };
  };
}

// Artículo listado en una página del papel digital
export interface PageArticleInfo {
  id: string;
  title: string;
  name: string;
  width: number;
  height: number;
  noExport?: boolean;
}

export interface StoryGroup {
  anchor: PageArticleInfo;
  recuadros: PageArticleInfo[];
}

export interface PageArticleGrouping {
  groups: StoryGroup[];
  standalone: PageArticleInfo[];
}

// Detecta el tipo de URL y extrae los parámetros necesarios
function parseUrl(url: string): {
  type: 'digital' | 'digital-page' | 'beta' | 'blogs' | 'subsitio';
  date?: string;
  articleId?: string;
  pageId?: string;
  slug?: string;
  index?: string;
} | null {
  // Mobile: digital.elmercurio.com/mobile#2026/04/05/B/6G4KN09U
  const mobileMatch = url.match(
    /digital\.elmercurio\.com\/mobile#(\d{4})\/(\d{2})\/(\d{2})\/\w+\/(\w+)/
  );
  if (mobileMatch) {
    const [, year, month, day, pageId] = mobileMatch;
    return {
      type: 'digital-page',
      date: `${year}/${month}/${day}`,
      pageId,
    };
  }

  // digital.elmercurio.com/2026/01/27/A/0H4K1D2V (5 partes → página)
  // digital.elmercurio.com/2026/01/26/A/NG4K1CL9/UC4K1CT6 (6 partes → artículo)
  const digitalMatch = url.match(
    /digital\.elmercurio\.com\/(\d{4})\/(\d{2})\/(\d{2})\/\w+\/(\w+)(?:\/(\w+))?/
  );
  if (digitalMatch) {
    const [, year, month, day, part1, part2] = digitalMatch;
    if (part2) {
      // 6 partes: part2 es el article ID
      return {
        type: 'digital',
        date: `${year}/${month}/${day}`,
        articleId: part2,
      };
    }
    // 5 partes: part1 es el page ID
    return {
      type: 'digital-page',
      date: `${year}/${month}/${day}`,
      pageId: part1,
    };
  }

  // beta.elmercurio.com/2026/01/26/internacional/45209/slug
  const betaMatch = url.match(
    /beta\.elmercurio\.com\/(\d{4})\/(\d{2})\/(\d{2})\/\w+\/\d+\/([^/?#]+)/
  );
  if (betaMatch) {
    const [, year, month, day, slug] = betaMatch;
    return {
      type: 'beta',
      date: `${year}/${month}/${day}`,
      slug,
    };
  }

  // elmercurio.com/blogs/2026/01/25/130773/slug
  const blogsMatch = url.match(
    /elmercurio\.com\/blogs\/\d{4}\/\d{2}\/\d{2}\/(\d+)/
  );
  if (blogsMatch) {
    return {
      type: 'blogs',
      articleId: blogsMatch[1],
      index: 'blogs',
    };
  }

  // elmercurio.com/inversiones/.../ID/slug
  // elmercurio.com/campo/.../ID/slug
  // elmercurio.com/legal/.../ID/slug
  // Usar \d{6,} para evitar capturar años (2026) de la URL
  const subsitioMatch = url.match(
    /elmercurio\.com\/(inversiones|campo|legal)\/.*\/(\d{6,})\//i
  );
  if (subsitioMatch) {
    return {
      type: 'subsitio',
      articleId: subsitioMatch[2],
      index: subsitioMatch[1].toLowerCase(),
    };
  }

  // www.elmercurio.com/blogs/YYYY/MM/DD/ID/slug (sin www. antes)
  const wwwBlogsMatch = url.match(
    /(?:www\.)?elmercurio\.com\/blogs\/\d{4}\/\d{2}\/\d{2}\/(\d+)/i
  );
  if (wwwBlogsMatch) {
    return {
      type: 'blogs',
      articleId: wwwBlogsMatch[1],
      index: 'blogs',
    };
  }

  return null;
}

// Procesa macros del texto (similar a La Segunda)
function processMacros(text: string): string {
  let processed = text;

  // {IMAGEN url} → <img>
  processed = processed.replace(
    /\{IMAGEN\s+([^}]+)\}/gi,
    '<figure><img src="$1"></figure>'
  );

  // {ACCION ...} → eliminar (multilínea OK)
  processed = processed.replace(/\{ACCION[\s\S]*?\}/gi, '');

  // Otras macros desconocidas → eliminar (multilínea OK)
  processed = processed.replace(/\{[A-Z]+[\s\S]*?\}/g, '');

  return processed;
}

// Extrae desde la API JSON de digital.elmercurio.com
async function extractFromDigitalJson(date: string, articleId: string, pageId?: string): Promise<Article> {
  const jsonUrl = `https://digital.elmercurio.com/${date}/content/articles/${articleId}.json`;
  const response = await fetch(jsonUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }
  return extractFromDigitalJsonResponse(await response.json(), date, articleId, pageId);
}

/**
 * Build the printed-page-cover URL for a given digital edition page.
 * Returns null when pageId is missing — single-article URLs without a
 * page context don't have a printed-page concept.
 */
export function buildMercurioPageCoverUrl(date: string, pageId: string | undefined): string | null {
  if (!pageId) return null;
  return `https://digital.elmercurio.com/${date}/content/pages/img/mid/${pageId}.jpg`;
}

/**
 * Apply the explicit-cover policy used by both single-article and
 * story-group extraction paths: first per-article image becomes the
 * cover, the rest stay in `images`, and the printed-page image is
 * appended as a footer figure for context. When the article has no
 * per-article images, the printed page is the cover (no footer).
 *
 * Returns the (possibly-modified) body, the cover, and the remaining
 * image array. Caller wires these into the returned Article.
 */
export function applyMercurioCoverPolicy(
  body: string,
  images: Article['images'],
  pageCoverUrl: string | null,
): { body: string; coverImage: Article['coverImage']; images: Article['images'] } {
  if (images && images.length > 0) {
    const [first, ...rest] = images;
    let outBody = body;
    if (pageCoverUrl) {
      outBody += `\n<hr>\n<figure><img src="${pageCoverUrl}"><figcaption>Edición impresa</figcaption></figure>`;
    }
    return {
      body: outBody,
      coverImage: { url: first.url, caption: first.caption },
      images: rest.length > 0 ? rest : undefined,
    };
  }
  // No per-article images.
  return {
    body,
    coverImage: pageCoverUrl ? { url: pageCoverUrl } : undefined,
    images: undefined,
  };
}

function extractFromDigitalJsonResponse(
  data: MercurioJsonArticle,
  date: string,
  articleId: string,
  pageId?: string,
): Article {
  // Title: prefer `title`, fall back to `head`. Sanitize either way.
  const rawTitle = data.title || data.head;
  if (!rawTitle) {
    throw new Error('Artículo sin título');
  }
  const title = sanitizeAndStripMercurio(rawTitle);

  // Kicker (volada/antetítulo)
  const kicker = data.head_label
    ? sanitizeAndStripMercurio(data.head_label)
    : undefined;

  // Subtitle (bajada)
  const subtitle = data.head_deck
    ? sanitizeAndStripMercurio(data.head_deck)
    : undefined;

  // Author
  const author = data.byline
    ? sanitizeAndStripMercurio(data.byline).replace(/^Por\s+/i, '').trim()
    : undefined;

  // Quotes block (rendered as blockquotes prepended to body)
  const quoteBlocks = (data.quotes || [])
    .map(q => sanitizeMercurioMarkup(q.quote || ''))
    .filter(Boolean)
    .map(q => `<blockquote>${q}</blockquote>`)
    .join('\n');

  // Body sanitized
  const sanitizedBody = sanitizeMercurioMarkup(data.body || '');
  const body = quoteBlocks
    ? `${quoteBlocks}\n${sanitizedBody}`
    : sanitizedBody;

  const images = (filterMercurioImages(data.images) || [])
    .map(img => {
      const url = `https://digital.elmercurio.com/${date}/content/pages/img/mid/${img.path}`;
      let caption = img.caption ? sanitizeAndStripMercurio(img.caption) : undefined;
      if (img.credits) {
        caption = caption ? `${caption} (Foto: ${img.credits})` : `Foto: ${img.credits}`;
      }
      return { url, caption };
    });

  // Apply cover policy when we know the page (selector flow); otherwise
  // fall back to legacy "first image is og:image" behavior, which leaves
  // coverImage unset and Telegraph picks the first <img> automatically.
  const pageCoverUrl = buildMercurioPageCoverUrl(date, pageId);
  const policy = pageId
    ? applyMercurioCoverPolicy(body, images.length > 0 ? images : undefined, pageCoverUrl)
    : { body, coverImage: undefined, images: images.length > 0 ? images : undefined };

  return {
    title,
    kicker,
    subtitle,
    author,
    body: policy.body,
    images: policy.images,
    coverImage: policy.coverImage,
    url: `https://digital.elmercurio.com/${date}/content/articles/${articleId}`,
    source: 'elmercurio',
  };
}

// Extrae desde newsapi.ecn.cl
async function extractFromNewsApi(index: string, articleId: string, originalUrl: string): Promise<Article> {
  const apiUrl = `https://newsapi.ecn.cl/NewsApi/${index}/noticia/${articleId}`;

  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const data: NewsApiResponse = await response.json();
  const source = data._source;

  if (!source.titulo) {
    throw new Error('Artículo sin título');
  }

  let body = processMacros(source.texto || '');

  // Extraer bajada
  let subtitle: string | undefined;
  if (source.bajada?.length) {
    subtitle = source.bajada.map(b => b.texto).join(' ');
  }

  // Imágenes de tablaMedios
  const images: Article['images'] = [];
  if (source.tablas?.tablaMedios) {
    for (const media of source.tablas.tablaMedios) {
      if (media.Url) {
        images.push({ url: media.Url, caption: media.Bajada });
      }
    }
  }

  return {
    title: source.titulo,
    subtitle,
    author: source.autor,
    date: source.fechaPublicacion,
    body,
    images: images.length > 0 ? images : undefined,
    url: originalUrl,
    source: 'elmercurio',
  };
}

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Extrae desde elmercurio.com/blogs haciendo scraping
async function extractFromBlogs(originalUrl: string): Promise<Article> {
  const response = await fetch(originalUrl, {
    headers: { 'User-Agent': GOOGLEBOT_UA },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Extraer título
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                     html.match(/<h1[^>]*class="titulo_despliegue_nota"[^>]*>([^<]+)/i);
  const title = titleMatch?.[1]?.trim();
  if (!title) {
    throw new Error('No se pudo extraer el título');
  }

  // Extraer bajada
  const subtitleMatch = html.match(/<h3[^>]*class="bajada_despliegue_nota"[^>]*>([^<]+)/i) ||
                        html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  const subtitle = subtitleMatch?.[1]?.trim();

  // Extraer autor
  const authorMatch = html.match(/<div class="txt_autor"><a[^>]*>([^<]+)/i);
  const author = authorMatch?.[1]?.trim();

  // Extraer cuerpo - está dentro de #CajaCuerpo, después del autor
  let body = '';
  const cajaMatch = html.match(/id="CajaCuerpo"[^>]*>([\s\S]*?)<!--RECUADROS-->/i);
  if (cajaMatch) {
    body = cajaMatch[1]
      // Remover div del autor
      .replace(/<div class="content_autor_despliegue">[\s\S]*?<\/div><\/div>/i, '')
      // Convertir <br><br> a párrafos
      .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '</p><p>')
      .replace(/<br\s*\/?>/gi, ' ')
      .trim();
    if (body && !body.startsWith('<p>')) body = '<p>' + body;
    if (body && !body.endsWith('</p>')) body += '</p>';
  }

  return {
    title,
    subtitle,
    author,
    body,
    url: originalUrl,
    source: 'elmercurio',
  };
}

const ELASTICSEARCH_URL = 'https://cache-elastic-pandora.ecn.cl/elmercurio-digital/noticia,articulo/_search';

interface ElasticSearchHit {
  _source: {
    titulo: string;
    permalink: string;
    fechaPublicacion: string;
  };
}

interface ElasticSearchResponse {
  hits: {
    hits: ElasticSearchHit[];
  };
}

// Busca en ElasticSearch por palabras clave y fecha
async function searchElasticSearch(keywords: string, date: string): Promise<{ articleId: string; date: string } | null> {
  // Usar match_phrase con slop para permitir algo de flexibilidad
  const query = {
    query: {
      bool: {
        must: [
          { match_phrase: { titulo: { query: keywords, slop: 3 } } },
          { range: { fechaPublicacion: { gte: date, lte: date } } },
        ],
      },
    },
    size: 5,
  };

  const encodedQuery = encodeURIComponent(JSON.stringify(query));
  const url = `${ELASTICSEARCH_URL}?source=${encodedQuery}&source_content_type=application/json`;

  let response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`ElasticSearch primary query failed: HTTP ${response.status}`);
  let data: ElasticSearchResponse = await response.json();

  // Si no hay resultados con match_phrase, intentar con match normal
  if (!data.hits?.hits?.length) {
    const fallbackQuery = {
      query: {
        bool: {
          must: [
            { match: { titulo: { query: keywords, minimum_should_match: '60%' } } },
            { range: { fechaPublicacion: { gte: date, lte: date } } },
          ],
        },
      },
      size: 5,
    };
    const fallbackEncoded = encodeURIComponent(JSON.stringify(fallbackQuery));
    response = await fetch(`${ELASTICSEARCH_URL}?source=${fallbackEncoded}&source_content_type=application/json`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`ElasticSearch fallback query failed: HTTP ${response.status}`);
    data = await response.json();
  }

  if (!data.hits?.hits?.length) {
    return null;
  }

  // Extraer articleId y fecha del permalink
  const permalink = data.hits.hits[0]._source.permalink;
  // permalink: https://digital.elmercurio.com/2026/01/26/A/NG4K1CL8/8L4K8IJJ
  const permalinkMatch = permalink.match(/digital\.elmercurio\.com\/(\d{4}\/\d{2}\/\d{2})\/\w+\/\w+\/(\w+)$/);
  if (permalinkMatch) {
    return { articleId: permalinkMatch[2], date: permalinkMatch[1] };
  }

  return null;
}

// Extrae desde beta.elmercurio.com buscando en ElasticSearch
async function extractFromBeta(date: string, slug: string, originalUrl: string): Promise<Article> {
  // Convertir slug a palabras clave (reemplazar guiones por espacios)
  // Mantener stopwords para match_phrase
  const keywords = slug.replace(/-/g, ' ').trim();

  // Buscar en ElasticSearch
  const result = await searchElasticSearch(keywords, date.replace(/\//g, '-'));

  if (result) {
    // Usar el JSON API de digital con la fecha del resultado
    const article = await extractFromDigitalJson(result.date, result.articleId);
    article.url = originalUrl; // Mantener URL original
    return article;
  }

  throw new Error('No se encontró el artículo en ElasticSearch');
}

// Verifica si una URL es de página (necesita selección de artículo)
export function isPageUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed?.type === 'digital-page';
}

// Obtiene la lista de artículos de una página del papel digital
export async function fetchPageArticles(url: string): Promise<{
  articles: PageArticleInfo[];
  date: string;
  pageId: string;
  sectionName: string;
  page: number;
} | null> {
  const parsed = parseUrl(url);
  if (!parsed || parsed.type !== 'digital-page' || !parsed.pageId || !parsed.date) {
    return null;
  }

  const pageUrl = `https://digital.elmercurio.com/${parsed.date}/content/pages/${parsed.pageId}.json`;
  const response = await fetch(pageUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;

  const data = await response.json();

  const articles: PageArticleInfo[] = (data.articles || [])
    .map((a: any) => ({
      id: a.id,
      title: (a.title || '').toString(),
      name: a.name || '',
      width: a.width || 0,
      height: a.height || 0,
      noExport: a.noExport === true,
    }))
    .filter((a: PageArticleInfo) => a.id && a.title);

  return {
    articles,
    date: parsed.date,
    pageId: parsed.pageId,
    sectionName: data.category_name || data.section_name || '',
    page: data.page || 0,
  };
}

// Extrae un artículo específico por ID y fecha (para uso desde el selector de página).
// Cuando pageId está disponible (flujo de página, no URL directa al artículo),
// se aplica la cover-policy con printed-page footer — la misma que usa
// extractStoryGroup para reportajes con recuadros.
export async function extractByArticleId(articleId: string, date: string, pageId?: string): Promise<Article> {
  return extractFromDigitalJson(date, articleId, pageId);
}

export async function extract(url: string): Promise<Article> {
  const parsed = parseUrl(url);
  if (!parsed) {
    throw new Error('URL de El Mercurio no válida');
  }

  switch (parsed.type) {
    case 'digital':
      return extractFromDigitalJson(parsed.date!, parsed.articleId!);

    case 'digital-page':
      throw new Error('URL de página requiere selección de artículo');

    case 'beta':
      return extractFromBeta(parsed.date!, parsed.slug!, url);

    case 'blogs':
      return extractFromBlogs(url);

    case 'subsitio':
      return extractFromNewsApi(parsed.index!, parsed.articleId!, url);

    default:
      throw new Error('Tipo de URL no soportado');
  }
}

// Strips all HTML tags, preserving text content. Used after sanitizeMercurioMarkup
// for fields rendered as plain text (title, kicker, subtitle, author).
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Convenience: sanitize El Mercurio markup and strip all tags to plain text.
export function sanitizeAndStripMercurio(input: string): string {
  return stripTags(sanitizeMercurioMarkup(input));
}

export interface ParsedArticleName {
  topicKey: string | null;       // e.g. "T1" if name starts with T<digits>_
  isRecuadro: boolean;            // ends in _R<digits>.ART
  recuadroIndex: number | null;   // the N from _R<N>
  normalizedKey: string;          // name minus _R<N>.ART and minus second _<digit>_ after T<N>_
  isValid: boolean;               // true if name ends in .ART (not .AR1 banner etc)
}

export function parseArticleName(name: string): ParsedArticleName {
  if (!name || !name.endsWith('.ART')) {
    return { topicKey: null, isRecuadro: false, recuadroIndex: null, normalizedKey: name, isValid: false };
  }
  let stem = name.slice(0, -4); // strip .ART

  const recuadroMatch = stem.match(/_R(\d+)$/);
  let isRecuadro = false;
  let recuadroIndex: number | null = null;
  if (recuadroMatch) {
    isRecuadro = true;
    recuadroIndex = parseInt(recuadroMatch[1], 10);
    stem = stem.slice(0, -recuadroMatch[0].length);
  }

  const topicMatch = stem.match(/^(T\d+)_/);
  const topicKey = topicMatch ? topicMatch[1] : null;

  let normalizedKey = stem;
  if (topicKey) {
    const positional = normalizedKey.match(/^(T\d+)_(\d+)_(.+)$/);
    if (positional) {
      normalizedKey = `${positional[1]}_${positional[3]}`;
    }
  }

  return { topicKey, isRecuadro, recuadroIndex, normalizedKey, isValid: true };
}

export function groupPageArticles(articles: PageArticleInfo[]): PageArticleGrouping {
  const valid = articles.filter(a => {
    if (!a.name) return false;
    if (a.noExport === true) return false;
    if (a.name.startsWith('NO_WEB_')) return false;
    if (!parseArticleName(a.name).isValid) return false;
    return true;
  });

  const anchors = new Map<string, PageArticleInfo>();
  const recuadrosByKey = new Map<string, PageArticleInfo[]>();

  for (const a of valid) {
    const parsed = parseArticleName(a.name);
    if (parsed.isRecuadro) {
      const arr = recuadrosByKey.get(parsed.normalizedKey) || [];
      arr.push(a);
      recuadrosByKey.set(parsed.normalizedKey, arr);
    } else {
      anchors.set(parsed.normalizedKey, a);
    }
  }

  const groups: StoryGroup[] = [];
  const consumedAnchorKeys = new Set<string>();
  const looseStandalones: PageArticleInfo[] = [];

  for (const [key, recuadros] of recuadrosByKey) {
    const anchor = anchors.get(key);
    if (anchor) {
      const sorted = recuadros.slice().sort((a, b) => {
        const ai = parseArticleName(a.name).recuadroIndex || 0;
        const bi = parseArticleName(b.name).recuadroIndex || 0;
        return ai - bi;
      });
      groups.push({ anchor, recuadros: sorted });
      consumedAnchorKeys.add(key);
    } else {
      looseStandalones.push(...recuadros);
    }
  }

  for (const [key, anchor] of anchors) {
    if (!consumedAnchorKeys.has(key)) {
      looseStandalones.push(anchor);
    }
  }

  const orderIndex = new Map(articles.map((a, i) => [a.id, i]));
  looseStandalones.sort((a, b) => (orderIndex.get(a.id) || 0) - (orderIndex.get(b.id) || 0));

  return { groups, standalone: looseStandalones };
}

export async function extractStoryGroup(
  group: StoryGroup,
  date: string,
  pageId: string,
): Promise<Article> {
  const fetchOne = async (id: string): Promise<Article> => {
    const url = `https://digital.elmercurio.com/${date}/content/articles/${id}.json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${id}`);
    return extractFromDigitalJsonResponse(await r.json() as MercurioJsonArticle, date, id);
  };

  const [anchorRes, ...recuadroResults] = await Promise.allSettled([
    fetchOne(group.anchor.id),
    ...group.recuadros.map(r => fetchOne(r.id)),
  ]);

  if (anchorRes.status === 'rejected') {
    throw new Error(`No se pudo obtener el ancla del reportaje: ${anchorRes.reason}`);
  }
  const anchor = anchorRes.value;

  let combinedBody = anchor.body;

  for (let i = 0; i < group.recuadros.length; i++) {
    const recuadroMeta = group.recuadros[i];
    const res = recuadroResults[i];
    if (res.status === 'fulfilled') {
      const r = res.value;
      const titleHtml = r.title ? `<h3>${escapeHtmlMinimal(r.title)}</h3>` : '';
      combinedBody += `\n<hr>\n${titleHtml}${r.body}`;
    } else {
      console.error(JSON.stringify({
        event: 'story_group_recuadro_failed',
        anchorId: group.anchor.id,
        recuadroId: recuadroMeta.id,
        error: String(res.reason),
        timestamp: new Date().toISOString(),
      }));
      const titleClean = sanitizeAndStripMercurio(recuadroMeta.title);
      combinedBody += `\n<hr>\n<p><i>(Recuadro «${escapeHtmlMinimal(titleClean)}» no disponible)</i></p>`;
    }
  }

  // Cover policy: shared with single-article extractByArticleId via
  // applyMercurioCoverPolicy. First per-article image becomes the
  // explicit cover, rest stay in `images`, printed-page image appended
  // as footer for context. No anchor images → printed page is the cover.
  const pageCoverUrl = buildMercurioPageCoverUrl(date, pageId);
  const policy = applyMercurioCoverPolicy(combinedBody, anchor.images, pageCoverUrl);
  combinedBody = policy.body;
  const coverImage = policy.coverImage;
  const outImages = policy.images;

  const sizeBytes = Buffer.byteLength(combinedBody, 'utf8');
  if (sizeBytes > 50_000) {
    console.error(JSON.stringify({
      event: 'telegraph_payload_size_warning',
      sizeBytes,
      anchorId: group.anchor.id,
      recuadroCount: group.recuadros.length,
      timestamp: new Date().toISOString(),
    }));
    let truncated = false;
    while (Buffer.byteLength(combinedBody, 'utf8') > 45_000) {
      const lastHr = combinedBody.lastIndexOf('<hr>');
      if (lastHr === -1) break;
      combinedBody = combinedBody.slice(0, lastHr).trimEnd();
      truncated = true;
    }
    if (truncated) {
      combinedBody += '\n<hr>\n<p><i>(Continúa en el original →)</i></p>';
    }
  }

  return {
    title: anchor.title,
    kicker: anchor.kicker,
    subtitle: anchor.subtitle,
    author: anchor.author,
    body: combinedBody,
    images: outImages,
    coverImage,
    url: `https://digital.elmercurio.com/${date}/content/articles/${group.anchor.id}`,
    source: 'elmercurio',
  };
}


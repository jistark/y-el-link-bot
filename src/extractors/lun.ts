import type { Article } from '../types.js';
import { decodeEntities, escapeHtmlMinimal } from '../utils/shared.js';

interface LunParams {
  fecha: string;
  newsId: string;
  paginaId: string;
  supplementId: string;
  bodyId: string;
}

export interface LunPageArticleInfo {
  newsId: string;
  title: string;
}

export interface LunPageData {
  articles: LunPageArticleInfo[];
  fecha: string;
  paginaId: string;
}

const LUN_TIMEOUT_MS = 15_000;

export function parseLunUrl(url: string): LunParams {
  const params: Record<string, string> = {};
  const matches = url.matchAll(/[?&](\w+)=([^&]+)/gi);
  for (const match of matches) {
    params[match[1].toLowerCase()] = match[2];
  }

  return {
    fecha: params.dt || '',
    newsId: params.newsid || '',
    paginaId: params.paginaid || '1',
    supplementId: params.supplementid || '0',
    bodyId: params.bodyid || '0',
  };
}

const SPANISH_MONTH_ABBR = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

export function buildLunPageCoverUrl(fechaIso: string, paginaId: string): string | null {
  if (!fechaIso || !paginaId) return null;
  const m = fechaIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, year, month, day] = m;
  const monthIdx = parseInt(month, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  const abbr = SPANISH_MONTH_ABBR[monthIdx];
  return `https://images.lun.com/luncontents/NewsPaperPages/${year}/${abbr}/${day}/p_${fechaIso}_pag${paginaId}.webp`;
}

function buildHomemobUrl(params: LunParams): string {
  return `https://www.lun.com/lunmobileiphone/Homemob.aspx?dt=${params.fecha}&bodyid=${params.bodyId}&SupplementId=${params.supplementId}&PaginaId=${params.paginaId}&NewsId=${params.newsId}`;
}

// Use the shared decoder — it covers the same entities, plus hex (&#x...;)
// which the local version was missing.
const decodeHtmlEntities = decodeEntities;

interface ExtractedContent {
  titulo: string | null;
  subtitulo: string | null;
  bajada: string | null;
  texto: string | null;
  seccion: string | null;
  videoUrl: string | null;
  autor: string | null;
  imagenes: string[];
  newsId: string | null;
  fecha: string | null;
}

function extractLunContent(html: string): ExtractedContent {
  const result: ExtractedContent = {
    titulo: null,
    subtitulo: null,
    bajada: null,
    texto: null,
    seccion: null,
    videoUrl: null,
    autor: null,
    imagenes: [],
    newsId: null,
    fecha: null,
  };

  // NewsID from div with class noticia
  let m = html.match(/<div id='(\d+)' class="noticia"/);
  if (m) result.newsId = m[1];

  // Título from div id="titulo"
  m = html.match(/<div id="titulo">([^<]+)<\/div>/);
  if (m) result.titulo = decodeHtmlEntities(m[1].trim());

  // Sección from div id="seccion"
  m = html.match(/<div id="seccion">([^<]+)<\/div>/);
  if (m) result.seccion = decodeHtmlEntities(m[1].trim());

  // Autor from div id="autor"
  m = html.match(/<div id="autor">([^<]+)<\/div>/);
  if (m) result.autor = decodeHtmlEntities(m[1].trim());

  // Video URL from div id="video"
  m = html.match(/<div id="video">([^<]+)<\/div>/);
  if (m) {
    const filename = m[1].trim();
    if (filename) {
      result.videoUrl = `https://images.lun.com/luncontents/Videos/${filename}`;
    }
  }

  // Fecha from div id="fecha_publicacion_av"
  m = html.match(/<div id="fecha_publicacion_av">([^<]+)<\/div>/);
  if (m) result.fecha = m[1].trim();

  // Subtítulo (volada) from lblSubTitulo span
  m = html.match(/lblSubTitulo"[^>]*>([^<]+)<\/span>/);
  if (m) result.subtitulo = decodeHtmlEntities(m[1].trim());

  // Bajada from lblSubTitulo3 span
  m = html.match(/lblSubTitulo3"[^>]*>([^<]+)<\/span>/);
  if (m) result.bajada = decodeHtmlEntities(m[1].trim());

  // Texto principal from _pText span
  m = html.match(/_pText">(.+?)<\/span>/s);
  if (m) {
    let textoHtml = m[1];

    // Convertir subtítulos internos <sub> a formato legible
    textoHtml = textoHtml.replace(/<sub[^>]*>([^<]+)<\/sub>/g, '\n\n## $1\n');

    // Limpiar el HTML
    textoHtml = textoHtml.replace(/<big[^>]*>([^<]*)<\/big>/g, '$1'); // Letra capital
    textoHtml = textoHtml.replace(/<br\s*\/?>/gi, '\n'); // Saltos de línea
    textoHtml = textoHtml.replace(/<[^>]+>/g, ''); // Remover tags restantes

    // Decode HTML entities
    textoHtml = decodeHtmlEntities(textoHtml);

    // Normalizar espacios
    textoHtml = textoHtml.replace(/\n{3,}/g, '\n\n');

    result.texto = textoHtml.trim();
  }

  // Imágenes from src attributes - using single quotes in Homemob
  const imagenes = html.matchAll(/src='(https:\/\/images\.lun\.com\/LunServerContents\/Noticias[^']+)'/g);
  const imageSet = new Set<string>();
  for (const imgMatch of imagenes) {
    // Encode spaces in URL (e.g., "Noticias Imagenes" -> "Noticias%20Imagenes")
    const encodedUrl = imgMatch[1].replace(/ /g, '%20');
    imageSet.add(encodedUrl);
  }
  result.imagenes = Array.from(imageSet);

  return result;
}

export async function fetchLunPageArticles(url: string): Promise<LunPageData | null> {
  const params = parseLunUrl(url);
  if (!params.fecha || !params.paginaId) return null;

  const response = await fetch(url, { signal: AbortSignal.timeout(LUN_TIMEOUT_MS) });
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  const html = new TextDecoder('iso-8859-1').decode(buffer);

  // All NewsIDRepeater values in order, dedupe preserving first-seen order
  const newsIdMatches = Array.from(html.matchAll(/var NewsIDRepeater\s*=\s*'(\d+)'/g), m => m[1]);
  const seen = new Set<string>();
  const uniqueNewsIds: string[] = [];
  for (const id of newsIdMatches) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueNewsIds.push(id);
    }
  }
  if (uniqueNewsIds.length === 0) return null;

  // All titles in order. Each article has its own <div id="titulo">.
  const titles = Array.from(html.matchAll(/<div id="titulo">([^<]+)<\/div>/g), m => decodeHtmlEntities(m[1].trim()));

  const articles: LunPageArticleInfo[] = uniqueNewsIds.map((newsId, i) => ({
    newsId,
    title: titles[i] || `Noticia ${i + 1}`,
  }));

  return { articles, fecha: params.fecha, paginaId: params.paginaId };
}

async function extractLunCore(
  params: LunParams,
  originalUrl: string,
  options: { embedPageCover?: boolean } = {},
): Promise<Article> {
  // embedPageCover defaults to true for single-article extraction.
  // Group extraction passes false to avoid appending one footer per article
  // (all articles on the same page share the same printed-page image).
  const embedPageCover = options.embedPageCover ?? true;
  // Construir URL de Homemob.aspx y obtener contenido
  const homemobUrl = buildHomemobUrl(params);
  const response = await fetch(homemobUrl, { signal: AbortSignal.timeout(LUN_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Error al obtener contenido: ${response.status}`);
  }
  // LUN servers return ISO-8859-1 encoded content
  const buffer = await response.arrayBuffer();
  const decoder = new TextDecoder('iso-8859-1');
  const html = decoder.decode(buffer);

  const content = extractLunContent(html);

  if (!content.titulo || !content.texto) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Construir body con subtitulo y bajada si existen
  let body = '';
  if (content.videoUrl) {
    body += `<figure><video src="${content.videoUrl}"></video></figure>\n`;
  }
  if (content.subtitulo) {
    body += `<p><strong>${content.subtitulo}</strong></p>\n`;
  }
  if (content.bajada) {
    body += `<p><em>${content.bajada}</em></p>\n`;
  }

  // Convertir texto plano con ## subtítulos a HTML
  const paragraphs = content.texto.split('\n\n');
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('## ')) {
      body += `<h4>${trimmed.slice(3)}</h4>\n`;
    } else {
      body += `<p>${trimmed.replace(/\n/g, '<br>')}</p>\n`;
    }
  }

  const images: Article['images'] = content.imagenes.map((imgUrl) => ({
    url: imgUrl,
  }));

  // Cover image policy:
  // - If the article has its own per-article photos (the inline images
  //   from /LunServerContents/Noticias...), the FIRST one becomes the
  //   explicit cover image. Remaining images stay in `images` and
  //   render as figures before the body. The printed-page image is
  //   appended at the end of the body as context.
  // - If the article has no per-article photos, fall back to the
  //   printed-page image as the cover.
  //
  // Why explicit coverImage instead of relying on og:image extraction:
  // (1) on multi-article pages, each article's lead photo travels with
  //     it — combineLunPageArticles can inline non-first articles' lead
  //     photos at the start of their body section; (2) makes the policy
  //     readable rather than implicit.
  const pageCoverUrl = buildLunPageCoverUrl(params.fecha, params.paginaId);
  let coverImage: Article['coverImage'];
  let outImages: Article['images'];

  if (images.length > 0) {
    coverImage = { url: images[0].url, caption: images[0].caption };
    // The remaining images render as figures between author and body.
    outImages = images.length > 1 ? images.slice(1) : undefined;
    if (pageCoverUrl && embedPageCover) {
      body += `<figure><img src="${pageCoverUrl}"><figcaption>Edición impresa</figcaption></figure>\n`;
    }
  } else {
    coverImage = pageCoverUrl ? { url: pageCoverUrl } : undefined;
    outImages = undefined;
  }

  return {
    title: content.titulo,
    subtitle: content.bajada || undefined,
    author: content.autor || undefined,
    date: content.fecha || params.fecha || undefined,
    body,
    images: outImages,
    coverImage,
    url: originalUrl,
    source: 'lun',
  };
}

export async function extractLunByNewsId(
  newsId: string,
  fecha: string,
  paginaId: string,
  originalUrl: string,
  options: { embedPageCover?: boolean } = {},
): Promise<Article> {
  return extractLunCore(
    { fecha, newsId, paginaId, supplementId: '0', bodyId: '0' },
    originalUrl,
    options,
  );
}

export async function extractLunPageGroup(
  pageArticles: LunPageArticleInfo[],
  fecha: string,
  paginaId: string,
  originalUrl: string,
): Promise<Article> {
  // Suppress per-article printed-page footer; we add a single one at the end
  // so the cover image isn't repeated N times in the combined body.
  const results = await Promise.allSettled(
    pageArticles.map(a =>
      extractLunByNewsId(a.newsId, fecha, paginaId, originalUrl, { embedPageCover: false }),
    ),
  );
  const fulfilled = results
    .map((r, i) => ({ r, info: pageArticles[i] }))
    .filter(x => x.r.status === 'fulfilled') as Array<{
      r: PromiseFulfilledResult<Article>;
      info: LunPageArticleInfo;
    }>;
  if (fulfilled.length === 0) throw new Error('Ningún artículo de la página pudo extraerse');

  // Log failures
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      console.error(JSON.stringify({
        event: 'lun_page_group_article_failed',
        newsId: pageArticles[i].newsId,
        error: String((results[i] as PromiseRejectedResult).reason),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  return combineLunPageArticles(
    fulfilled.map(f => f.r.value),
    buildLunPageCoverUrl(fecha, paginaId),
    originalUrl,
  );
}

/**
 * Combine N LUN articles (extracted with embedPageCover: false) into a
 * single Article. Pure function — exposed for unit tests.
 *
 * Invariants:
 *  - Throws if `articles` is empty.
 *  - The first article's metadata (title, subtitle, author, date, coverImage)
 *    becomes the combined article's metadata.
 *  - Subsequent article bodies are joined with <hr> + <h3>{escaped title}.
 *  - The printed-page footer is appended exactly ONCE at the end (regression
 *    for commit 91f656c, where each per-article extraction appended its own
 *    footer and N copies leaked into the combined body).
 */
export function combineLunPageArticles(
  articles: Article[],
  pageCoverUrl: string | null,
  originalUrl: string,
): Article {
  if (articles.length === 0) {
    throw new Error('combineLunPageArticles: no articles to combine');
  }

  const first = articles[0];
  let combinedBody = first.body;
  let combinedImages = first.images ? [...first.images] : [];

  // first.coverImage is the page-level cover (above the fold). For
  // articles 2..N, their per-article coverImage was meant to be THEIR
  // lead photo; in a combined page we can't render it as a page cover,
  // so we inline it at the start of that article's body section as a
  // figure. This preserves the per-article visual context that the LUN
  // mobile app shows next to each note.
  for (let i = 1; i < articles.length; i++) {
    const r = articles[i];
    const titleHtml = `<h3>${escapeHtmlMinimal(r.title)}</h3>`;
    const isPerArticleCover = !!r.coverImage?.url
      && r.coverImage.url !== pageCoverUrl; // not the printed-page fallback
    const inlineCover = isPerArticleCover
      ? `<figure><img src="${r.coverImage!.url}"></figure>\n`
      : '';
    combinedBody += `\n<hr>\n${titleHtml}\n${inlineCover}${r.body}`;
    if (r.images) combinedImages = combinedImages.concat(r.images);
  }

  // Determine whether ANY article has its own per-article images. This
  // governs whether the printed-page footer goes into the body, and
  // whether we keep first.coverImage as the page-level cover or suppress
  // it (to avoid double-cover when first.coverImage is itself the
  // printed page — which happens when the first article has no images
  // but later articles do).
  const firstHasOwnCover = !!first.coverImage?.url
    && first.coverImage.url !== pageCoverUrl;
  const anyHasPerArticleImages = combinedImages.length > 0
    || firstHasOwnCover
    || articles.slice(1).some(a => a.coverImage?.url && a.coverImage.url !== pageCoverUrl);

  if (pageCoverUrl && anyHasPerArticleImages) {
    combinedBody += `\n<figure><img src="${pageCoverUrl}"><figcaption>Edición impresa</figcaption></figure>`;
  }

  // Cover policy for the combined page:
  // - first.coverImage is per-article → keep as page cover.
  // - first.coverImage is pageCoverUrl AND others have per-article
  //   images → suppress to avoid the printed page rendering BOTH as
  //   the cover AND as a footer in the body.
  // - first.coverImage is pageCoverUrl AND no one has per-article
  //   images → keep as page cover (no double-cover risk).
  const inheritedCover = firstHasOwnCover
    ? first.coverImage
    : (anyHasPerArticleImages ? undefined : first.coverImage);

  return {
    title: first.title,
    subtitle: first.subtitle,
    author: first.author,
    date: first.date,
    body: combinedBody,
    images: combinedImages.length > 0 ? combinedImages : undefined,
    coverImage: inheritedCover,
    url: originalUrl,
    source: 'lun',
  };
}

export async function extract(url: string): Promise<Article> {
  const params = parseLunUrl(url);

  // Si es URL desktop (no tiene NewsID), primero obtener el NewsID
  if (!params.newsId) {
    const desktopResponse = await fetch(url, { signal: AbortSignal.timeout(LUN_TIMEOUT_MS) });
    if (!desktopResponse.ok) {
      throw new Error(`Error al obtener página desktop: ${desktopResponse.status}`);
    }
    // LUN servers return ISO-8859-1 encoded content
    const desktopBuffer = await desktopResponse.arrayBuffer();
    const desktopDecoder = new TextDecoder('iso-8859-1');
    const desktopHtml = desktopDecoder.decode(desktopBuffer);

    // Buscar NewsID en JavaScript de la página
    // Primero intentar NewsIDRepeater (contiene el ID real de la noticia principal)
    // Si no, intentar NewsID directo
    // Multi-article callers should use fetchLunPageArticles instead.
    const newsIdRepeaterMatch = desktopHtml.match(/var NewsIDRepeater\s*=\s*'(\d+)'/);
    const newsIdMatch = desktopHtml.match(/var NewsID\s*=\s*'(\d+)'/);

    const foundNewsId = newsIdRepeaterMatch?.[1] || (newsIdMatch?.[1] !== '0' ? newsIdMatch?.[1] : null);

    if (!foundNewsId) {
      throw new Error('No se pudo obtener NewsID de la página desktop. Esta página no tiene un artículo específico asociado.');
    }
    params.newsId = foundNewsId;
  }

  return extractLunCore(params, url);
}

import type { Article, TelegraphNode, TelegraphPage } from '../types.js';
import { decodeEntities } from '../utils/shared.js';

const API_URL = 'https://api.telegra.ph';
const UPLOAD_URL = 'https://telegra.ph/upload';

// In-memory cache of original URL → telegra.ph URL to avoid re-uploading
// when an image is referenced by multiple articles in a session.
//
// TTL'd because Telegraph periodically purges orphaned uploads — without
// expiry we'd cache a stale telegra.ph URL forever and serve broken images
// for the entire process lifetime.
const UPLOAD_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const UPLOAD_CACHE_MAX = 500;
const uploadCache = new Map<string, { url: string; expires: number }>();

function uploadCacheGet(key: string): string | undefined {
  const entry = uploadCache.get(key);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    uploadCache.delete(key);
    return undefined;
  }
  return entry.url;
}

function uploadCacheSet(key: string, url: string): void {
  // Bound size: when full, drop the oldest entry (Map preserves insertion order).
  if (uploadCache.size >= UPLOAD_CACHE_MAX) {
    const firstKey = uploadCache.keys().next().value;
    if (firstKey !== undefined) uploadCache.delete(firstKey);
  }
  uploadCache.set(key, { url, expires: Date.now() + UPLOAD_CACHE_TTL_MS });
}

/**
 * Downloads an image from an external URL and uploads it to Telegraph's CDN,
 * returning the new telegra.ph URL. Falls back to the original URL on any failure.
 * Telegraph's /upload endpoint has a 5MB file size limit.
 */
async function mirrorToTelegraph(externalUrl: string): Promise<string> {
  if (!externalUrl || !externalUrl.startsWith('http')) return externalUrl;
  if (externalUrl.startsWith('https://telegra.ph/file/')) return externalUrl;

  const cached = uploadCacheGet(externalUrl);
  if (cached) return cached;

  try {
    const fetchResp = await fetch(externalUrl, { signal: AbortSignal.timeout(8_000) });
    if (!fetchResp.ok) return externalUrl;

    const blob = await fetchResp.blob();
    if (blob.size === 0 || blob.size > 5 * 1024 * 1024) return externalUrl;

    const formData = new FormData();
    formData.append('file', blob);

    const uploadResp = await fetch(UPLOAD_URL, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(8_000),
    });
    if (!uploadResp.ok) return externalUrl;

    const data = await uploadResp.json() as Array<{ src?: string }>;
    if (!Array.isArray(data) || !data[0]?.src) return externalUrl;

    const newUrl = `https://telegra.ph${data[0].src}`;
    uploadCacheSet(externalUrl, newUrl);
    return newUrl;
  } catch (err) {
    console.error(JSON.stringify({
      event: 'telegraph_upload_failed',
      url: externalUrl,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
    return externalUrl;
  }
}

async function mirrorArticleImages(article: Article): Promise<Article> {
  const tasks: Array<Promise<void>> = [];
  const updated: Article = {
    ...article,
    coverImage: article.coverImage ? { ...article.coverImage } : undefined,
    images: article.images ? article.images.map(i => ({ ...i })) : undefined,
  };

  if (updated.coverImage?.url) {
    tasks.push(
      mirrorToTelegraph(updated.coverImage.url).then(u => {
        updated.coverImage!.url = u;
      })
    );
  }
  if (updated.images) {
    for (const img of updated.images) {
      tasks.push(
        mirrorToTelegraph(img.url).then(u => { img.url = u; })
      );
    }
  }

  // Mirror any <img> URLs embedded inside the body HTML (e.g., from recuadros
  // composed by extractStoryGroup). We replace them in-place via regex.
  if (updated.body) {
    // Accept both " and ' for src attribute. Some scrapers (DF, La Tercera
     // via Googlebot UA) emit single-quoted src and would otherwise be skipped.
    const urlsInBody = Array.from(
      updated.body.matchAll(/<img\s+[^>]*src=["'](https?:\/\/[^"']+)["']/gi),
      m => m[1]
    );
    const uniqueBodyUrls = [...new Set(urlsInBody)];
    if (uniqueBodyUrls.length > 0) {
      const mirrored: Record<string, string> = {};
      await Promise.all(
        uniqueBodyUrls.map(async u => {
          mirrored[u] = await mirrorToTelegraph(u);
        })
      );
      let newBody = updated.body;
      for (const [orig, mir] of Object.entries(mirrored)) {
        if (orig !== mir) {
          // Escape special regex chars in the original URL
          const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          newBody = newBody.replace(new RegExp(escaped, 'g'), mir);
        }
      }
      updated.body = newBody;
    }
  }

  await Promise.all(tasks);
  return updated;
}

// Diccionario de palabras cortas (max 5 chars) en español e inglés
const WORDS = [
  // Español
  'casa', 'sol', 'luna', 'mar', 'rio', 'luz', 'paz', 'amor', 'vida', 'oro',
  'flor', 'pan', 'sal', 'agua', 'aire', 'roca', 'nube', 'pez', 'ave', 'arbol',
  'dia', 'mes', 'hora', 'rey', 'voz', 'isla', 'cima', 'ola', 'red', 'eco',
  'gato', 'perro', 'lobo', 'oso', 'leon', 'tigre', 'puma', 'zorro', 'buho',
  'mesa', 'silla', 'cama', 'piso', 'techo', 'muro', 'sala', 'patio', 'plaza',
  'norte', 'sur', 'este', 'oeste', 'calle', 'metro', 'bus', 'tren', 'avion',
  // English
  'sun', 'moon', 'star', 'sky', 'sea', 'lake', 'tree', 'leaf', 'root', 'seed',
  'bird', 'fish', 'wolf', 'bear', 'deer', 'hawk', 'crow', 'duck', 'frog',
  'rock', 'sand', 'wind', 'rain', 'snow', 'ice', 'fire', 'gold', 'iron',
  'book', 'page', 'word', 'line', 'note', 'song', 'bell', 'drum', 'horn',
  'door', 'wall', 'roof', 'road', 'path', 'hill', 'cave', 'pond', 'well',
  'blue', 'red', 'warm', 'dark', 'soft', 'bold', 'calm', 'fast', 'slow',
  'one', 'two', 'ten', 'half', 'full', 'new', 'old', 'big', 'tiny', 'long',
];

// Códigos por fuente
const SOURCE_CODES: Record<Article['source'], string> = {
  elmercurio: 'em',
  emol: 'eml',
  lasegunda: 'ls',
  latercera: 'lt',
  df: 'df',
  theverge: 'vrg',
  lun: 'lun',
  nyt: 'nyt',
  wapo: 'wpo',
  cnnchile: 'cnn',
  biobio: 'rbb',
  elpais: 'ep',
  ft: 'ft',
  theatlantic: 'atl',
  wired: 'wrd',
  '404media': '404m',
  bloomberg: 'bbg',
  adnradio: 'adn',
  elfiltrador: 'elf',
  theclinic: 'tcl',
  exante: 'exa',
  interferencia: 'inf',
  t13: 't13',
  '13cl': '13c',
  tvn: 'tvn',
  '24horas': '24h',
  mega: 'mga',
  meganoticias: 'mgn',
  chilevision: 'chv',
  ojoalatele: 'ojt',
  adprensa: 'adp',
  lahora: 'lhr',
  generic: 'gen',
};

function generateSlug(source: Article['source']): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const code = SOURCE_CODES[source];
  const num = Math.floor(Math.random() * 1000); // 0-999
  return `${word}-${code}-${num}`;
}

function buildFullTitle(article: Article): string {
  const title = decodeEntities(article.title);
  if (article.kicker) {
    return `${decodeEntities(article.kicker)} ${title}`;
  }
  return title;
}

interface CreatePageResponse {
  ok: boolean;
  result?: TelegraphPage;
  error?: string;
}


// Parsea children recursivamente: si tiene HTML, parsea; si no, decodifica texto
function parseChildren(innerHtml: string): TelegraphNode[] {
  return innerHtml.includes('<') ? parseInline(innerHtml) : [decodeEntities(innerHtml)];
}

// Normalize <strong>/<em> to <b>/<i> so the inline regex doesn't need
// backreferences. Without this, mixed pairs like `<b>...</strong>` or
// `<strong>...</b>` (common in scraped HTML) silently get stripped to
// plain text instead of being rendered as bold.
function normalizeBoldItalicTags(html: string): string {
  return html
    .replace(/<strong\b([^>]*)>/gi, '<b$1>')
    .replace(/<\/strong>/gi, '</b>')
    .replace(/<em\b([^>]*)>/gi, '<i$1>')
    .replace(/<\/em>/gi, '</i>');
}

// Parsea contenido inline, preservando negritas, itálicas, links y marks
function parseInline(html: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  let text = normalizeBoldItalicTags(html);

  // Procesar (con [^>]* para aceptar atributos como style, class):
  // - negritas <b>...</b> y <strong>...</strong>
  // - itálicas <i>...</i> y <em>...</em>
  // - subrayado <u>...</u> → pass-through (Telegraph no soporta <u>)
  // - destacados <mark>...</mark> → itálica
  // - links <a href="...">...</a>
  // After normalization above, <strong>/<em> are already rewritten to
  // <b>/<i>, so we no longer need backreferences to match symmetric pairs.
  const regex = /<b[^>]*>(.+?)<\/b>|<i[^>]*>(.+?)<\/i>|<u[^>]*>(.+?)<\/u>|<mark[^>]*>(.+?)<\/mark>|<a\s+href="([^"]+)"[^>]*>(.+?)<\/a>/gi;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Texto antes del match
    if (match.index > lastIndex) {
      const before = decodeEntities(text.slice(lastIndex, match.index));
      if (before) nodes.push(before);
    }

    // Capture groups (post-normalization, no backreferences):
    //   1: <b>...</b> content   2: <i>...</i> content
    //   3: <u>...</u> content   4: <mark>...</mark> content
    //   5: <a href="">          6: <a>...</a> content
    if (match[1] !== undefined) {
      nodes.push({ tag: 'b', children: parseChildren(match[1]) });
    } else if (match[2] !== undefined) {
      nodes.push({ tag: 'i', children: parseChildren(match[2]) });
    } else if (match[3] !== undefined) {
      // <u> → pass-through (Telegraph no soporta underline)
      nodes.push(...parseChildren(match[3]));
    } else if (match[4] !== undefined) {
      // <mark> → itálica
      nodes.push({ tag: 'i', children: parseChildren(match[4]) });
    } else if (match[5] !== undefined) {
      nodes.push({ tag: 'a', attrs: { href: match[5] }, children: parseChildren(match[6]) });
    }

    lastIndex = match.index + match[0].length;
  }

  // Texto después del último match
  if (lastIndex < text.length) {
    const after = decodeEntities(text.slice(lastIndex).replace(/<[^>]+>/g, ''));
    if (after) nodes.push(after);
  }

  // Si no hay nodos, devolver texto limpio
  if (nodes.length === 0) {
    const clean = decodeEntities(text.replace(/<[^>]+>/g, ''));
    if (clean) return [clean];
    return [];
  }

  return nodes;
}

// Crea nodo para embed de video/social
function createEmbedNode(url: string, provider?: string): TelegraphNode | null {
  // YouTube → iframe
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const videoId = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]+)/)?.[1];
    if (videoId) {
      return {
        tag: 'figure',
        children: [{
          tag: 'iframe',
          attrs: { src: `https://www.youtube.com/embed/${videoId}` },
        }],
      };
    }
  }

  // Vimeo → iframe
  if (url.includes('vimeo.com')) {
    const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1];
    if (videoId) {
      return {
        tag: 'figure',
        children: [{
          tag: 'iframe',
          attrs: { src: `https://player.vimeo.com/video/${videoId}` },
        }],
      };
    }
  }

  // Twitter/X, Instagram, TikTok → link
  if (url.includes('twitter.com') || url.includes('x.com')) {
    return { tag: 'p', children: [{ tag: 'a', attrs: { href: url }, children: ['Ver post en X/Twitter'] }] };
  }
  if (url.includes('instagram.com')) {
    return { tag: 'p', children: [{ tag: 'a', attrs: { href: url }, children: ['Ver en Instagram'] }] };
  }
  if (url.includes('tiktok.com')) {
    return { tag: 'p', children: [{ tag: 'a', attrs: { href: url }, children: ['Ver en TikTok'] }] };
  }

  // Otro embed → link genérico
  if (url.startsWith('http')) {
    return { tag: 'p', children: [{ tag: 'a', attrs: { href: url }, children: [`Ver ${provider || 'contenido'}`] }] };
  }

  return null;
}

// Tags HTML permitidos - todos los demás se eliminan preservando su texto.
// Limitado al subset que Telegraph soporta como nodos (más algunos block
// contenedores que normalizamos antes: div/span/section/article/p/h*).
//
// Eliminados respecto a la versión anterior: video/audio/source (Telegraph
// no los soporta), y table/tr/td/th/thead/tbody/ol (no son nodos válidos —
// si se dejaban pasar reaparecían como tags literales en el output).
const ALLOWED_TAGS = new Set([
  'p', 'b', 'strong', 'i', 'em', 'a', 'mark', 'u', 's',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'img', 'figure', 'figcaption', 'iframe',
  'br', 'hr', 'div', 'span', 'section', 'article', 'aside',
  'blockquote', 'ul', 'li',
]);

function stripUnknownTags(html: string): string {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g, (match, tagName) => {
    return ALLOWED_TAGS.has(tagName.toLowerCase()) ? match : '';
  });
}

function htmlToNodes(html: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  const asideContents: string[] = [];

  // Paso 0: Limpiar tags HTML
  // Normalizar <a> tags: quitar atributos extra (type, id, class, etc.) dejando
  // solo href. Decode entities in the href so URLs with `&amp;` in query
  // strings render as proper `&` instead of leaking the entity into the link.
  html = html.replace(/<a\s+[^>]*?href="([^"]*)"[^>]*>/gi, (_, href) => `<a href="${decodeEntities(href)}">`);
  html = html.replace(/<a\s+[^>]*?href='([^']*)'[^>]*>/gi, (_, href) => `<a href="${decodeEntities(href)}">`);
  // Eliminar tags desconocidos (ej: <capitals>, <subhead>)
  html = stripUnknownTags(html);

  // Paso 1: Normalizar saltos - <div>, </div>, <br> → \n
  let normalized = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<div[^>]*>/gi, '');

  // Paso 2: Extraer headers <h3> antes de dividir
  normalized = normalized.replace(/<h([1-6])[^>]*>(.+?)<\/h\1>/gi, '\n<H3>$2</H3>\n');

  // Paso 2b: Extraer blockquotes
  normalized = normalized.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n<BQ>$1</BQ>\n');

  // Paso 2c: Extraer asides (story group recuadros). The inner content
  // is processed recursively as block-level HTML.
  normalized = normalized.replace(/<aside[^>]*>([\s\S]*?)<\/aside>/gi, (_, inner) => {
    const placeholder = `__ASIDE_${asideContents.length}__`;
    asideContents.push(inner);
    return `\n<ASIDE>${placeholder}</ASIDE>\n`;
  });

  // Paso 3: Extraer imágenes (acepta src con comillas dobles o simples).
  normalized = normalized.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, '\n<IMG>$1</IMG>\n');

  // Paso 3b: Extraer iframes (YouTube, Vimeo)
  normalized = normalized.replace(/<iframe\s+[^>]*src="([^"]+)"[^>]*><\/iframe>/gi, '\n<IFRAME>$1</IFRAME>\n');
  normalized = normalized.replace(/<iframe\s+[^>]*src="([^"]+)"[^>]*>/gi, '\n<IFRAME>$1</IFRAME>\n');

  // Paso 3c: Extraer <hr>
  normalized = normalized.replace(/<hr\s*\/?>/gi, '\n<HR>\n');

  // Paso 4: Extraer figures
  normalized = normalized.replace(
    /<figure[^>]*>.*?<img\s+[^>]*src="([^"]+)"[^>]*>.*?(?:<figcaption>([^<]*)<\/figcaption>)?.*?<\/figure>/gis,
    '\n<FIG>$1|||$2</FIG>\n'
  );

  // Paso 5: Limpiar otros tags contenedores
  normalized = normalized.replace(/<\/?(p|span|section|article)[^>]*>/gi, '\n');

  // Paso 6: Dividir por saltos de línea
  const blocks = normalized.split(/\n+/).map(b => b.trim()).filter(Boolean);

  for (const block of blocks) {
    // Header
    const headerMatch = block.match(/^<H3>(.+)<\/H3>$/i);
    if (headerMatch) {
      const text = decodeEntities(headerMatch[1].replace(/<[^>]+>/g, '').trim());
      if (text) {
        nodes.push({ tag: 'h3', children: [text] });
      }
      continue;
    }

    // Blockquote
    const bqMatch = block.match(/^<BQ>([\s\S]+)<\/BQ>$/i);
    if (bqMatch) {
      const inner = bqMatch[1].trim();
      // The inner can contain inline HTML (b, i, leadin-converted-to-b, etc.)
      const children = parseInline(inner);
      if (children.length > 0) {
        nodes.push({ tag: 'blockquote', children });
      }
      continue;
    }

    // Imagen suelta
    const imgMatch = block.match(/^<IMG>(.+)<\/IMG>$/i);
    if (imgMatch) {
      nodes.push({
        tag: 'figure',
        children: [{ tag: 'img', attrs: { src: imgMatch[1] } }],
      });
      continue;
    }

    // Iframe (YouTube, Vimeo)
    const iframeMatch = block.match(/^<IFRAME>(.+)<\/IFRAME>$/i);
    if (iframeMatch) {
      nodes.push({
        tag: 'figure',
        children: [{ tag: 'iframe', attrs: { src: iframeMatch[1] } }],
      });
      continue;
    }

    // Horizontal rule
    if (block.match(/^<HR>$/i)) {
      nodes.push({ tag: 'hr' });
      continue;
    }

    // Figure con caption
    const figMatch = block.match(/^<FIG>(.+)\|\|\|(.*)<\/FIG>$/i);
    if (figMatch) {
      const figChildren: TelegraphNode[] = [
        { tag: 'img', attrs: { src: figMatch[1] } },
      ];
      if (figMatch[2]) {
        figChildren.push({ tag: 'figcaption', children: [decodeEntities(figMatch[2])] });
      }
      nodes.push({ tag: 'figure', children: figChildren });
      continue;
    }

    // Aside (story group recuadro)
    const asideMatch = block.match(/^<ASIDE>__ASIDE_(\d+)__<\/ASIDE>$/i);
    if (asideMatch) {
      const inner = asideContents[parseInt(asideMatch[1], 10)];
      if (inner) {
        const innerNodes = htmlToNodes(inner);
        if (innerNodes.length > 0) {
          nodes.push({ tag: 'aside', children: innerNodes });
        }
      }
      continue;
    }

    // Texto normal - parsear inline (negritas, links)
    const inlineNodes = parseInline(block);
    if (inlineNodes.length > 0) {
      nodes.push({ tag: 'p', children: inlineNodes });
    }
  }

  return nodes;
}

export function articleToNodes(article: Article): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];

  // Cover image (first <img> in content drives Telegraph's OG image)
  if (article.coverImage?.url) {
    const coverChildren: TelegraphNode[] = [
      { tag: 'img', attrs: { src: article.coverImage.url } },
    ];
    if (article.coverImage.caption) {
      coverChildren.push({ tag: 'figcaption', children: [decodeEntities(article.coverImage.caption)] });
    }
    nodes.push({ tag: 'figure', children: coverChildren });
  }

  // Subtítulo (bajada) como blockquote — primer nodo de texto, drives og:description
  if (article.subtitle) {
    nodes.push({ tag: 'blockquote', children: [decodeEntities(article.subtitle)] });
  }

  // Byline (author from the byline field)
  if (article.author) {
    nodes.push({
      tag: 'p',
      children: [{ tag: 'i', children: [`Por ${decodeEntities(article.author)}`] }],
    });
  }

  // Imágenes principales al inicio
  if (article.images?.length) {
    for (const img of article.images) {
      const figureChildren: TelegraphNode[] = [
        { tag: 'img', attrs: { src: img.url } },
      ];
      if (img.caption) {
        figureChildren.push({ tag: 'figcaption', children: [img.caption] });
      }
      nodes.push({ tag: 'figure', children: figureChildren });
    }
  }

  // Contenido del artículo
  nodes.push(...htmlToNodes(article.body));

  return nodes;
}

export interface CreatePageResult {
  url: string;
  path: string;
}

// Telegraph rejects content payloads larger than ~64KB of serialized JSON.
// We trim to a slightly smaller budget and append a sentinel "(continúa…)"
// node so the user knows truncation happened.
const TELEGRAPH_MAX_CONTENT_BYTES = 60_000;

export function truncateNodesToBudget(nodes: TelegraphNode[]): TelegraphNode[] {
  if (JSON.stringify(nodes).length <= TELEGRAPH_MAX_CONTENT_BYTES) return nodes;
  // Drop trailing nodes one at a time until we fit, then append a sentinel.
  let trimmed = nodes.slice();
  while (trimmed.length > 0 && JSON.stringify(trimmed).length > TELEGRAPH_MAX_CONTENT_BYTES - 200) {
    trimmed.pop();
  }
  trimmed.push({ tag: 'p', children: [{ tag: 'i', children: ['(Contenido truncado por límite de Telegraph)'] }] });
  console.warn(JSON.stringify({
    event: 'telegraph_content_truncated',
    originalNodes: nodes.length,
    keptNodes: trimmed.length,
    timestamp: new Date().toISOString(),
  }));
  return trimmed;
}

export async function createPage(article: Article): Promise<CreatePageResult> {
  const token = process.env.TELEGRAPH_ACCESS_TOKEN;
  if (!token) {
    throw new Error('TELEGRAPH_ACCESS_TOKEN no configurado');
  }

  // Mirror external images to Telegraph CDN (fail-soft: keeps original URLs on failure)
  const mirrored = await mirrorArticleImages(article);

  const content = truncateNodesToBudget(articleToNodes(mirrored));
  const slug = generateSlug(mirrored.source);

  // Paso 1: Crear página con slug como título (para obtener path corto)
  const createResponse = await fetch(`${API_URL}/createPage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token,
      title: slug,
      author_name: getSourceName(mirrored.source),
      author_url: mirrored.url,
      content,
      return_content: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const createData: CreatePageResponse = await createResponse.json();

  if (!createData.ok || !createData.result) {
    throw new Error(`Error creando página Telegraph: ${createData.error}`);
  }

  const path = createData.result.path;

  // Paso 2: Editar página para poner el título real
  const editResponse = await fetch(`${API_URL}/editPage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token,
      path,
      title: buildFullTitle(mirrored),
      author_name: getSourceName(mirrored.source),
      author_url: mirrored.url,
      content,
      return_content: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const editData: CreatePageResponse = await editResponse.json();
  if (!editData.ok) {
    console.error(JSON.stringify({
      event: 'telegraph_edit_error',
      path,
      error: editData.error,
      timestamp: new Date().toISOString(),
    }));
  }

  return {
    url: createData.result.url,
    path,
  };
}

export async function deletePage(path: string): Promise<boolean> {
  const token = process.env.TELEGRAPH_ACCESS_TOKEN;
  if (!token) {
    return false;
  }

  // Telegraph no tiene API de borrado, pero podemos "vaciar" la página
  // editándola con contenido mínimo
  try {
    const response = await fetch(`${API_URL}/editPage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        path,
        title: 'Contenido eliminado',
        content: [{ tag: 'p', children: ['Este artículo ha sido eliminado.'] }],
        return_content: false,
      }),
    });

    const data = await response.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

function getSourceName(source: Article['source']): string {
  const names: Record<Article['source'], string> = {
    elmercurio: 'El Mercurio',
    emol: 'Emol',
    lasegunda: 'La Segunda',
    latercera: 'La Tercera',
    df: 'Diario Financiero',
    theverge: 'The Verge',
    lun: 'Las Últimas Noticias',
    nyt: 'The New York Times',
    wapo: 'The Washington Post',
    cnnchile: 'CNN Chile',
    biobio: 'BioBioChile',
    elpais: 'El País',
    ft: 'Financial Times',
    theatlantic: 'The Atlantic',
    wired: 'Wired',
    '404media': '404 Media',
    bloomberg: 'Bloomberg',
    adnradio: 'Radio ADN',
    elfiltrador: 'El Filtrador',
    theclinic: 'The Clinic',
    exante: 'Ex-Ante',
    interferencia: 'Interferencia',
    t13: 'T13',
    '13cl': '13.cl',
    tvn: 'TVN',
    '24horas': '24 Horas',
    mega: 'Mega',
    meganoticias: 'Meganoticias',
    chilevision: 'Chilevisión',
    ojoalatele: 'Ojo a la Tele',
    adprensa: 'AdPrensa',
    lahora: 'La Hora',
    generic: 'Artículo',
  };
  return names[source];
}

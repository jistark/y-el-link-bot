import type { Article, TelegraphNode, TelegraphPage } from '../types.js';

const API_URL = 'https://api.telegra.ph';

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
  'blue', 'red', 'gold', 'dark', 'soft', 'bold', 'calm', 'fast', 'slow',
  'one', 'two', 'ten', 'half', 'full', 'new', 'old', 'big', 'tiny', 'long',
];

// Códigos por fuente
const SOURCE_CODES: Record<Article['source'], string> = {
  elmercurio: 'em',
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
};

function generateSlug(source: Article['source']): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const code = SOURCE_CODES[source];
  const num = Math.floor(Math.random() * 1000); // 0-999
  return `${word}-${code}-${num}`;
}

interface CreatePageResponse {
  ok: boolean;
  result?: TelegraphPage;
  error?: string;
}

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&laquo;': '«',
  '&raquo;': '»',
};

function decodeEntities(text: string): string {
  let decoded = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    decoded = decoded.replaceAll(entity, char);
  }
  // Decodificar entidades numéricas &#123;
  decoded = decoded.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 10))
  );
  return decoded;
}

// Parsea contenido inline, preservando negritas, itálicas, links y marks
function parseInline(html: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  let text = html;

  // Procesar:
  // - negritas <b>...</b> y <strong>...</strong>
  // - itálicas <i>...</i> y <em>...</em>
  // - destacados <mark>...</mark> → itálica
  // - links <a href="...">...</a>
  const regex = /<(b|strong)>(.+?)<\/\1>|<(i|em)>(.+?)<\/\3>|<mark[^>]*>(.+?)<\/mark>|<a\s+href="([^"]+)"[^>]*>(.+?)<\/a>/gi;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Texto antes del match
    if (match.index > lastIndex) {
      const before = decodeEntities(text.slice(lastIndex, match.index));
      if (before) nodes.push(before);
    }

    if (match[1]) {
      // Es negrita <b> o <strong>
      nodes.push({
        tag: 'b',
        children: [decodeEntities(match[2])],
      });
    } else if (match[3]) {
      // Es itálica <i> o <em>
      nodes.push({
        tag: 'i',
        children: [decodeEntities(match[4])],
      });
    } else if (match[5]) {
      // Es mark (destacado) → convertir a itálica
      nodes.push({
        tag: 'i',
        children: [decodeEntities(match[5])],
      });
    } else if (match[6]) {
      // Es link
      nodes.push({
        tag: 'a',
        attrs: { href: match[6] },
        children: [decodeEntities(match[7])],
      });
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

// Tags HTML permitidos - todos los demás se eliminan preservando su texto
const ALLOWED_TAGS = new Set([
  'p', 'b', 'strong', 'i', 'em', 'a', 'mark', 'u', 's',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'img', 'figure', 'figcaption', 'iframe',
  'br', 'div', 'span', 'section', 'article',
  'blockquote', 'ul', 'ol', 'li',
  'table', 'tr', 'td', 'th', 'thead', 'tbody',
  'video', 'source', 'audio',
]);

function stripUnknownTags(html: string): string {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g, (match, tagName) => {
    return ALLOWED_TAGS.has(tagName.toLowerCase()) ? match : '';
  });
}

function htmlToNodes(html: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];

  // Paso 0: Eliminar tags HTML desconocidos (ej: <capitals>, <subhead>)
  html = stripUnknownTags(html);

  // Paso 1: Normalizar saltos - <div>, </div>, <br> → \n
  let normalized = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<div[^>]*>/gi, '');

  // Paso 2: Extraer headers <h3> antes de dividir
  normalized = normalized.replace(/<h([1-6])[^>]*>(.+?)<\/h\1>/gi, '\n<H3>$2</H3>\n');

  // Paso 3: Extraer imágenes
  normalized = normalized.replace(/<img\s+[^>]*src="([^"]+)"[^>]*>/gi, '\n<IMG>$1</IMG>\n');

  // Paso 3b: Extraer iframes (YouTube, Vimeo)
  normalized = normalized.replace(/<iframe\s+[^>]*src="([^"]+)"[^>]*><\/iframe>/gi, '\n<IFRAME>$1</IFRAME>\n');
  normalized = normalized.replace(/<iframe\s+[^>]*src="([^"]+)"[^>]*>/gi, '\n<IFRAME>$1</IFRAME>\n');

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

  // Subtítulo como blockquote
  if (article.subtitle) {
    nodes.push({ tag: 'blockquote', children: [article.subtitle] });
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

export async function createPage(article: Article): Promise<CreatePageResult> {
  const token = process.env.TELEGRAPH_ACCESS_TOKEN;
  if (!token) {
    throw new Error('TELEGRAPH_ACCESS_TOKEN no configurado');
  }

  const content = articleToNodes(article);
  const slug = generateSlug(article.source);

  // Paso 1: Crear página con slug como título (para obtener path corto)
  const createResponse = await fetch(`${API_URL}/createPage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token,
      title: slug,
      author_name: getSourceName(article.source),
      author_url: article.url,
      content,
      return_content: false,
    }),
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
      title: article.title,
      author_name: getSourceName(article.source),
      author_url: article.url,
      content,
      return_content: false,
    }),
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
  };
  return names[source];
}

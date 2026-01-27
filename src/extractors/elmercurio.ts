import type { Article } from '../types.js';

// Respuesta de la API JSON de digital.elmercurio.com
interface MercurioJsonArticle {
  title?: string;
  head?: string;
  head_deck?: string;
  byline?: string;
  body?: string;
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

// Detecta el tipo de URL y extrae los parámetros necesarios
function parseUrl(url: string): {
  type: 'digital' | 'beta' | 'blogs' | 'subsitio';
  date?: string;
  articleId?: string;
  slug?: string;
  index?: string;
} | null {
  // digital.elmercurio.com/2026/01/27/A/0H4K1D2V (5 partes)
  // digital.elmercurio.com/2026/01/26/A/NG4K1CL9/UC4K1CT6 (6 partes)
  const digitalMatch = url.match(
    /digital\.elmercurio\.com\/(\d{4})\/(\d{2})\/(\d{2})\/\w+\/(\w+)(?:\/(\w+))?/
  );
  if (digitalMatch) {
    const [, year, month, day, part1, part2] = digitalMatch;
    return {
      type: 'digital',
      date: `${year}/${month}/${day}`,
      articleId: part2 || part1, // Si hay 6 partes, usar la última; si hay 5, usar part1
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

  // {ACCION ...} → eliminar
  processed = processed.replace(/\{ACCION[^}]*\}/gi, '');

  // Otras macros desconocidas → eliminar
  processed = processed.replace(/\{[A-Z]+[^}]*\}/g, '');

  return processed;
}

// Limpia tags XML propios de El Mercurio
function cleanMercurioTags(text: string): string {
  return text
    .replace(/<\/?head_deck>/gi, '')
    .replace(/<\/?byline>/gi, '')
    .replace(/<\/?byline_credit>/gi, ' - ')
    .replace(/<\/?body>/gi, '')
    .replace(/<\/?P>/gi, '')
    .trim();
}

// Extrae desde la API JSON de digital.elmercurio.com
async function extractFromDigitalJson(date: string, articleId: string): Promise<Article> {
  const jsonUrl = `https://digital.elmercurio.com/${date}/content/articles/${articleId}.json`;

  const response = await fetch(jsonUrl);
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const data: MercurioJsonArticle = await response.json();

  let title = data.title || data.head;
  if (!title) {
    throw new Error('Artículo sin título');
  }
  // Limpiar tags de highlight
  title = title.replace(/<\/?highlight>/gi, '').trim();

  let body = data.body || '';
  body = body
    .replace(/<\/?body>/gi, '')
    .replace(/<P>/gi, '<p>')
    .replace(/<\/P>/gi, '</p>')
    .replace(/<subhead>/gi, '<h3>')
    .replace(/<\/subhead>/gi, '</h3>')
    .replace(/<italic>/gi, '<i>')
    .replace(/<\/italic>/gi, '</i>')
    .replace(/<bold>/gi, '<b>')
    .replace(/<\/bold>/gi, '</b>')
    .replace(/<byline>.*?<\/byline>/gis, '');

  return {
    title,
    subtitle: data.head_deck ? cleanMercurioTags(data.head_deck) : undefined,
    author: data.byline ? cleanMercurioTags(data.byline) : undefined,
    body,
    url: `https://digital.elmercurio.com/${date}/content/articles/${articleId}`,
    source: 'elmercurio',
  };
}

// Extrae desde newsapi.ecn.cl
async function extractFromNewsApi(index: string, articleId: string, originalUrl: string): Promise<Article> {
  const apiUrl = `https://newsapi.ecn.cl/NewsApi/${index}/noticia/${articleId}`;

  const response = await fetch(apiUrl);
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

  let response = await fetch(url);
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
    response = await fetch(`${ELASTICSEARCH_URL}?source=${fallbackEncoded}&source_content_type=application/json`);
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

export async function extract(url: string): Promise<Article> {
  const parsed = parseUrl(url);
  if (!parsed) {
    throw new Error('URL de El Mercurio no válida');
  }

  switch (parsed.type) {
    case 'digital':
      return extractFromDigitalJson(parsed.date!, parsed.articleId!);

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

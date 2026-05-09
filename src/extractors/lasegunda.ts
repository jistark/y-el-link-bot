import type { Article } from '../types.js';

const API_URL = 'https://newsapi.ecn.cl/NewsApi/lasegunda/noticia';

interface LaSegundaResponse {
  _source: {
    titulo: string;
    texto: string;
    autor?: string;
    fechaPublicacion?: string;
    tablas?: {
      tablaMedios?: { Url: string; Bajada?: string }[];
    };
  };
}

export function extractArticleId(url: string): string | null {
  const match = url.match(/\/(\d{6,})\//);
  return match ? match[1] : null;
}

export function processMacros(text: string): string {
  let processed = text;

  // {IMAGEN url} → <img>
  processed = processed.replace(
    /\{IMAGEN\s+([^}]+)\}/gi,
    '<img src="$1">'
  );

  // {IMAGENCREDITO url; caption} → <figure>
  processed = processed.replace(
    /\{IMAGENCREDITO\s+([^;]+);\s*([^}]*)\}/gi,
    '<figure><img src="$1"><figcaption>$2</figcaption></figure>'
  );

  // {VIDEO url} → ignorar (Telegraph no soporta video embebido)
  // Use [\s\S]*? so newlines inside macros don't make us miss the closing brace.
  processed = processed.replace(/\{VIDEO[\s\S]*?\}/gi, '');

  // {CITA...}, {DESTACAR...} → eliminar (multilínea OK)
  processed = processed.replace(/\{CITA[\s\S]*?\}/gi, '');
  processed = processed.replace(/\{DESTACAR[\s\S]*?\}/gi, '');

  // Limpiar otras macros desconocidas
  processed = processed.replace(/\{[A-Z]+[\s\S]*?\}/g, '');

  return processed;
}

export async function extract(url: string): Promise<Article> {
  const articleId = extractArticleId(url);
  if (!articleId) {
    throw new Error('No se pudo extraer el ID del artículo de la URL');
  }

  const response = await fetch(`${API_URL}/${articleId}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const data: LaSegundaResponse = await response.json();
  // The API can return error-shaped JSON (e.g. {error: 404}) without a
  // `_source` field. Without this guard, the next field access crashes.
  if (!data?._source) {
    throw new Error('Respuesta inesperada de la API de La Segunda');
  }
  const source = data._source;
  if (!source.titulo) {
    throw new Error('Artículo sin título');
  }

  // External API: source.texto is typed string but can arrive null/undefined
  // (article without body) or as a non-string. Coerce to avoid crashing
  // .replace() inside processMacros.
  const body = typeof source.texto === 'string' ? processMacros(source.texto) : '';

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
    author: source.autor,
    date: source.fechaPublicacion,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'lasegunda',
  };
}

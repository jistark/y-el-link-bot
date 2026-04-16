import type { Article } from '../types.js';
import { decodeEntities } from '../utils/shared.js';

const EMOL_ELASTIC = 'https://cache-elastic-pandora.ecn.cl/emol/noticia/_search';

function extractId(url: string): string | null {
  const m = url.match(/emol\.com\/[^/]+\/[^/]+\/\d{4}\/\d{2}\/\d{2}\/(\d+)\//);
  return m?.[1] || null;
}

interface EmolHit {
  titulo: string;
  bajada?: { texto: string }[];
  autor?: string;
  texto: string;
  fechaPublicacion?: string;
  tablas?: {
    tablaMedios?: { Tipo: string; Url: string; Credito?: string }[];
  };
}

export async function extract(url: string): Promise<Article> {
  const id = extractId(url);
  if (!id) throw new Error('No se pudo extraer ID de la URL de Emol');

  const res = await fetch(`${EMOL_ELASTIC}?q=${id}&size=1`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ElasticSearch Emol: HTTP ${res.status}`);

  const data = await res.json() as { hits: { hits: { _source: EmolHit }[] } };
  const hit = data?.hits?.hits?.[0]?._source;
  if (!hit?.texto) throw new Error('Artículo no encontrado en ElasticSearch');

  const images = (hit.tablas?.tablaMedios || [])
    .filter(m => m.Tipo === 'Foto' && m.Url)
    .map(m => ({ url: m.Url, caption: m.Credito || undefined }));

  return {
    title: decodeEntities(hit.titulo || 'Sin título'),
    subtitle: hit.bajada?.[0]?.texto ? decodeEntities(hit.bajada[0].texto) : undefined,
    author: hit.autor || undefined,
    date: hit.fechaPublicacion,
    body: hit.texto,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'emol',
  };
}

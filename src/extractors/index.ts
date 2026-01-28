import type { Article } from '../types.js';
import * as cnnchile from './cnnchile.js';
import * as df from './df.js';
import * as elmercurio from './elmercurio.js';
import * as lasegunda from './lasegunda.js';
import * as latercera from './latercera.js';
import * as lun from './lun.js';
import * as nyt from './nyt.js';
import * as theverge from './theverge.js';
import * as wapo from './wapo.js';

const URL_PATTERNS = {
  elmercurio: /(?:beta|digital|www)?\.?elmercurio\.com/,
  lasegunda: /lasegunda\.com/,
  latercera: /latercera\.com/,
  df: /df\.cl/,
  theverge: /theverge\.com/,
  lun: /lun\.com/,
  nyt: /nytimes\.com/,
  wapo: /washingtonpost\.com/,
  cnnchile: /cnnchile\.com/,
} as const;

export type Source = keyof typeof URL_PATTERNS;

export function detectSource(url: string): Source | null {
  for (const [source, pattern] of Object.entries(URL_PATTERNS)) {
    if (pattern.test(url)) {
      return source as Source;
    }
  }
  return null;
}

export async function extractArticle(url: string): Promise<Article> {
  const source = detectSource(url);

  switch (source) {
    case 'lasegunda':
      return lasegunda.extract(url);

    case 'latercera':
      return latercera.extract(url);

    case 'elmercurio':
      return elmercurio.extract(url);

    case 'df':
      return df.extract(url);

    case 'theverge':
      return theverge.extract(url);

    case 'lun':
      return lun.extract(url);

    case 'nyt':
      return nyt.extract(url);

    case 'wapo':
      return wapo.extract(url);

    case 'cnnchile':
      return cnnchile.extract(url);

    default:
      throw new Error('URL no corresponde a un diario soportado');
  }
}

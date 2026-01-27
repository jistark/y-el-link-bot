import type { Article } from '../types.js';
import * as df from './df.js';
import * as elmercurio from './elmercurio.js';
import * as lasegunda from './lasegunda.js';
import * as latercera from './latercera.js';
import * as theverge from './theverge.js';

const URL_PATTERNS = {
  elmercurio: /(?:beta|digital|www)?\.?elmercurio\.com/,
  lasegunda: /lasegunda\.com/,
  latercera: /latercera\.com/,
  df: /df\.cl/,
  theverge: /theverge\.com/,
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

    default:
      throw new Error('URL no corresponde a un diario soportado');
  }
}

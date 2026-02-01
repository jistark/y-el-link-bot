import type { Article } from '../types.js';
import * as fourzerofourmedia from './404media.js';
import * as beehiiv from './beehiiv.js';
import * as biobio from './biobio.js';
// bloomberg requires browser-level bypass
import * as cnnchile from './cnnchile.js';
import * as df from './df.js';
import * as elmercurio from './elmercurio.js';
import * as elpais from './elpais.js';
import * as ft from './ft.js';
import * as lasegunda from './lasegunda.js';
import * as latercera from './latercera.js';
import * as lun from './lun.js';
import * as nyt from './nyt.js';
// reuters requires browser-level bypass
import * as substack from './substack.js';
import * as theatlantic from './theatlantic.js';
import * as theverge from './theverge.js';
import * as wapo from './wapo.js';
import * as wired from './wired.js';

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
  biobio: /biobiochile\.cl|pagina7\.cl/,
  elpais: /elpais\.com/,
  ft: /ft\.com/,
  theatlantic: /theatlantic\.com/,
  wired: /wired\.com/,
  '404media': /404media\.co/,
  substack: /\.substack\.com|jasmi\.news|sources\.news|elcontenido\.substack\.com/,
  beehiiv: /\.beehiiv\.com|aliciakennedy\.news|status\.news|theresanaiforthat\.com/,
  // bloomberg and reuters require browser-level bypass (cookies/JS blocking)
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

    case 'biobio':
      return biobio.extract(url);

    case 'elpais':
      return elpais.extract(url);

    case 'ft':
      return ft.extract(url);

    case 'theatlantic':
      return theatlantic.extract(url);

    case 'wired':
      return wired.extract(url);

    case '404media':
      return fourzerofourmedia.extract(url);

    case 'substack':
      return substack.extract(url);

    case 'beehiiv':
      return beehiiv.extract(url);

    default:
      throw new Error('URL no corresponde a un diario soportado');
  }
}

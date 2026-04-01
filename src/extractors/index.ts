import type { Article } from '../types.js';
import * as fourzerofourmedia from './404media.js';
import * as adnradio from './adnradio.js';
// beehiiv and substack deprecated - extraction unreliable
import * as biobio from './biobio.js';
import * as bloomberg from './bloomberg.js';
import * as chilevision from './chilevision.js';
import * as cnnchile from './cnnchile.js';
import * as df from './df.js';
import * as elfiltrador from './elfiltrador.js';
import * as elmercurio from './elmercurio.js';
import * as elpais from './elpais.js';
import * as exante from './exante.js';
import * as ft from './ft.js';
import * as interferencia from './interferencia.js';
import * as lahora from './lahora.js';
import * as lasegunda from './lasegunda.js';
import * as latercera from './latercera.js';
import * as lun from './lun.js';
import * as mega from './mega.js';
import * as nyt from './nyt.js';
import * as ojoalatele from './ojoalatele.js';
// reuters requires browser-level bypass
import * as t13 from './t13.js';
import * as theatlantic from './theatlantic.js';
import * as theclinic from './theclinic.js';
import * as theverge from './theverge.js';
import * as tvn from './tvn.js';
import * as wapo from './wapo.js';
import * as wired from './wired.js';

const URL_PATTERNS = {
  elmercurio: /(?:beta|digital|www)?\.?elmercurio\.com/,
  lasegunda: /lasegunda\.com/,
  latercera: /latercera\.com|lacuarta\.com/,
  df: /df\.cl/,
  theverge: /theverge\.com/,
  lun: /lun\.com/,
  nyt: /nytimes\.com/,
  wapo: /washingtonpost\.com/,
  cnnchile: /cnnchile\.com/,
  biobio: /biobiochile\.cl|pagina7\.cl/,
  elpais: /elpais\.com/,
  ft: /ft\.com/,
  bloomberg: /bloomberg\.com/,
  theatlantic: /theatlantic\.com/,
  wired: /wired\.com/,
  '404media': /404media\.co/,
  adnradio: /adnradio\.cl/,
  elfiltrador: /elfiltrador\.com/,
  theclinic: /theclinic\.cl/,
  exante: /ex-ante\.cl/,
  interferencia: /interferencia\.cl/,
  t13: /^(?:www\.)?(?:t13|13)\.cl$/,
  tvn: /^(?:www\.)?(?:tvn|24horas)\.cl$/,
  mega: /^(?:www\.)?(?:meganoticias|mega)\.cl$/,
  chilevision: /chilevision\.cl/,
  ojoalatele: /ojoalatele\.com/,
  lahora: /lahora\.cl/,
  // substack and beehiiv deprecated - extraction unreliable
  // reuters requires browser-level bypass
} as const;

export type Source = keyof typeof URL_PATTERNS;

export function detectSource(url: string): Source | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const [source, pattern] of Object.entries(URL_PATTERNS)) {
    if (pattern.test(hostname)) {
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

    case 'bloomberg':
      return bloomberg.extract(url);

    case 'theatlantic':
      return theatlantic.extract(url);

    case 'wired':
      return wired.extract(url);

    case '404media':
      return fourzerofourmedia.extract(url);

    case 'adnradio':
      return adnradio.extract(url);

    case 'elfiltrador':
      return elfiltrador.extract(url);

    case 'theclinic':
      return theclinic.extract(url);

    case 'exante':
      return exante.extract(url);

    case 'interferencia':
      return interferencia.extract(url);

    case 't13':
      return t13.extract(url);

    case 'tvn':
      return tvn.extract(url);

    case 'mega':
      return mega.extract(url);

    case 'chilevision':
      return chilevision.extract(url);

    case 'ojoalatele':
      return ojoalatele.extract(url);

    case 'lahora':
      return lahora.extract(url);

    default:
      throw new Error('URL no corresponde a un diario soportado');
  }
}

/**
 * Unified Vox Media extractor — entry point for all 12+ Vox properties
 * (Chorus CMS: theverge, vox, eater, polygon, sbnation, thedodo, thrillist,
 * popsugar; Clay CMS: nymag including Intelligencer/Strategist sections,
 * vulture, thecut, grubstreet, curbed).
 *
 * Dispatch logic lives in voxmedia/dispatch.ts; per-CMS extraction in
 * voxmedia/chorus.ts and voxmedia/clay.ts. This file just orchestrates:
 * fetch → dispatch → parse → wrap in `Article`.
 */

import type { Article } from '../types.js';
import { parseChorusArticle } from './voxmedia/chorus.js';
import { parseClayArticle } from './voxmedia/clay.js';
import { detectVoxStrategy } from './voxmedia/dispatch.js';

export { detectVoxStrategy, isVoxMediaHost } from './voxmedia/dispatch.js';

/**
 * Exposed for tests so they can run against on-disk HTML fixtures without
 * needing network or fetch-bypass.
 */
export function parseArticle(url: string, html: string): Partial<Article> | null {
  const routing = detectVoxStrategy(url);
  if (!routing) return null;
  return routing.strategy === 'chorus'
    ? parseChorusArticle(html)
    : parseClayArticle(html);
}

export async function extract(url: string): Promise<Article> {
  const routing = detectVoxStrategy(url);
  if (!routing) {
    throw new Error(`Vox Media extractor invoked for non-Vox URL: ${url}`);
  }

  // Chorus and Clay both serve without Cloudflare-grade bot protection;
  // a plain fetch with browser headers is enough. We mirror the User-Agent
  // the rest of the codebase uses for parity with what theverge.ts did
  // before this consolidation.
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo Vox Media (${routing.brand}): ${response.status}`);
  }
  const html = await response.text();

  const data = routing.strategy === 'chorus'
    ? parseChorusArticle(html)
    : parseClayArticle(html);

  if (!data?.title || !data?.body) {
    throw new Error(`No se pudo extraer contenido de ${routing.brand}`);
  }

  return {
    title: data.title,
    subtitle: data.subtitle,
    author: data.author,
    date: data.date,
    body: data.body,
    images: data.images,
    url,
    source: routing.source,
  };
}

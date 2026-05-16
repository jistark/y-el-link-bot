/**
 * Vox Media properties share two distinct CMS stacks:
 *
 *   - **Chorus** (Vox Media's flagship CMS): theverge, vox, eater, polygon,
 *     sbnation, thedodo, thrillist, popsugar. JSON-LD ships `articleBody` as
 *     a clean plain-text block — preferred extraction strategy.
 *
 *   - **Clay** (New York Magazine's CMS, kept independent after the 2019
 *     merger): nymag, vulture, thecut, intelligencer (a section of nymag),
 *     strategist (also a section of nymag). JSON-LD `articleBody` is empty;
 *     prose lives in a `.article-content` DOM container alongside paywall
 *     UI chrome that must be filtered out.
 *
 * `detectVoxStrategy` returns the routing decision for a URL, including the
 * brand label so downstream code can attribute the Telegraph page to the
 * specific publication (Intelligencer, The Strategist, etc.) rather than just
 * the dominant parent (New York Magazine).
 *
 * Intelligencer and The Strategist are detected via path on `nymag.com` —
 * the user has indicated that the dedicated domains (intelligencer.com,
 * thestrategist.com) may or may not exist in practice; we'll add them if
 * production URLs surface.
 */

import type { Article } from '../../types.js';

export type VoxStrategy = 'chorus' | 'clay';

export interface VoxRouting {
  strategy: VoxStrategy;
  brand: string;
  /**
   * The Article.source value to attribute to. Drives the Telegraph slug
   * code (SOURCE_CODES) and author-name attribution (getSourceName) in
   * formatters/telegraph.ts — keep the union in src/types.ts in sync.
   */
  source: Article['source'];
}

interface SiteMapping { brand: string; source: Article['source']; }

const CHORUS_HOSTS: Record<string, SiteMapping> = {
  'theverge.com': { brand: 'The Verge', source: 'theverge' },
  'vox.com': { brand: 'Vox', source: 'vox' },
  'eater.com': { brand: 'Eater', source: 'eater' },
  'polygon.com': { brand: 'Polygon', source: 'polygon' },
  'sbnation.com': { brand: 'SB Nation', source: 'sbnation' },
  'thedodo.com': { brand: 'The Dodo', source: 'thedodo' },
  'thrillist.com': { brand: 'Thrillist', source: 'thrillist' },
  'popsugar.com': { brand: 'PopSugar', source: 'popsugar' },
};

const CLAY_HOSTS: Record<string, SiteMapping> = {
  'vulture.com': { brand: 'Vulture', source: 'vulture' },
  'thecut.com': { brand: 'The Cut', source: 'thecut' },
  'grubstreet.com': { brand: 'Grub Street', source: 'grubstreet' },
  'curbed.com': { brand: 'Curbed', source: 'curbed' },
  // nymag.com handled specially below — path determines sub-brand.
};

const NYMAG_PATH_BRANDS: Array<{ prefix: string; brand: string; source: Article['source'] }> = [
  { prefix: '/intelligencer', brand: 'Intelligencer', source: 'intelligencer' },
  { prefix: '/strategist', brand: 'The Strategist', source: 'thestrategist' },
];

/**
 * Strips a leading "www." so hostname matching is uniform across canonical
 * and non-canonical forms. Returns lowercased.
 */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Returns null when the URL is not a Vox Media property. Caller should fall
 * through to the next extractor or to generic.
 */
export function detectVoxStrategy(url: string): VoxRouting | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }

  const host = normalizeHost(parsed.hostname);
  const path = parsed.pathname;

  if (host in CHORUS_HOSTS) {
    return { strategy: 'chorus', ...CHORUS_HOSTS[host] };
  }

  if (host in CLAY_HOSTS) {
    return { strategy: 'clay', ...CLAY_HOSTS[host] };
  }

  if (host === 'nymag.com') {
    for (const { prefix, brand, source } of NYMAG_PATH_BRANDS) {
      if (path.startsWith(prefix + '/') || path === prefix) {
        return { strategy: 'clay', brand, source };
      }
    }
    return { strategy: 'clay', brand: 'New York Magazine', source: 'nymag' };
  }

  return null;
}

/**
 * Hostname-only check for use in index.ts URL_PATTERNS. The URL_PATTERNS map
 * tests against `hostname` directly, so we can't inspect paths there. That's
 * fine for routing — every Vox Media URL has a Vox-owned hostname; only the
 * brand sub-attribution depends on path.
 */
export function isVoxMediaHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host in CHORUS_HOSTS || host in CLAY_HOSTS || host === 'nymag.com';
}

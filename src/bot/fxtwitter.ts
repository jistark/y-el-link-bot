/**
 * Helpers for resolving FxTwitter / FixupX / VxTwitter "tweet wrapper" URLs
 * back to the article URL that the source tweet was actually pointing to.
 *
 * Used by the Link Expander handler in bot.ts: when a tweet-expander bot
 * posts a fxtwitter.com link, we fetch the page and extract the first
 * embeddable article URL inside it.
 */

import { fetchBypass } from '../extractors/fetch-bypass.js';
import { extractUrls } from './url-filter.js';

// Hosts inside FxTwitter responses that don't lead to article URLs.
export const FXTWITTER_NOISE_HOSTS = new Set([
  'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com',
  'twitter.com', 'x.com', 'mobile.twitter.com',
  'twimg.com', 'pbs.twimg.com', 'video.twimg.com',
  't.co', // FxTwitter usually expands these in the response
]);

export function isFxTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /^(?:[\w-]+\.)?(?:fxtwitter|fixupx|vxtwitter|fixvx)\.com$/.test(host);
  } catch { return false; }
}

/**
 * Fetch an FxTwitter (or sibling) URL and pull out the embedded article
 * URLs that the source tweet was pointing to. Filters Twitter/CDN noise.
 *
 * Returns [] on fetch failure (logged), never throws.
 */
export async function extractUrlsFromFxTwitter(fxUrl: string): Promise<string[]> {
  let html: string;
  try {
    html = await fetchBypass(fxUrl);
  } catch (err) {
    console.error(JSON.stringify({
      event: 'fxtwitter_fetch_error',
      url: fxUrl,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of extractUrls(html)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
      if (FXTWITTER_NOISE_HOSTS.has(host)) continue;
      let noise = false;
      for (const n of FXTWITTER_NOISE_HOSTS) {
        if (host.endsWith('.' + n)) { noise = true; break; }
      }
      if (noise) continue;
      out.push(raw);
    } catch { /* skip malformed */ }
  }
  return out;
}

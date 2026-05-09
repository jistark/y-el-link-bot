/**
 * URL filtering for the article-extraction pipeline.
 *
 * Decides whether a URL pulled from a chat message is eligible for
 * extraction. The bot deliberately processes only a curated allowlist
 * (custom extractors + bypass-paywalls recipes + EXTRA_ALLOWED) and
 * silently drops everything else — this keeps the bot from acting on
 * tracking links, social posts, or arbitrary user input.
 *
 * Also blocks SSRF surface: private/reserved/loopback IPs and IPv6
 * variants are rejected before any network call.
 */

import { detectSource } from '../extractors/index.js';
import { hasRecipe } from '../extractors/recipes.js';

// Domains that should never be extracted (social media, video, non-article)
export const SKIP_DOMAINS = new Set([
  'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'instagram.com',
  'facebook.com', 'fb.com', 'tiktok.com', 'reddit.com', 'linkedin.com',
  'pinterest.com', 'tumblr.com', 'twitch.tv', 'discord.com', 'discord.gg',
  'spotify.com', 'apple.com', 'music.apple.com', 'soundcloud.com',
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com',
  'docs.google.com', 'drive.google.com', 'maps.google.com',
  'amazon.com', 'mercadolibre.cl', 'ebay.com', 'aliexpress.com',
  'wikipedia.org', 'wikimedia.org',
  't.me', 'telegram.org', 'wa.me', 'whatsapp.com',
  'wetransfer.com', 'we.tl', 'mega.nz', 'dropbox.com',
  // Link expander bots (fxtwitter, fixupx, vxtwitter, etc.)
  'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com',
  'ddinstagram.com', 'rxddit.com', 'vxreddit.com',
]);

// Bots that expand X/Twitter links into card previews. We selectively
// process their messages: pull fxtwitter/fixupx URLs out of the body,
// fetch them, and look for embedded article URLs to extract. Match by
// username (lowercase, no @).
export const LINK_EXPANDER_BOTS = new Set([
  'twitterlinkexpanderbot',
]);

// Domains without a bypass-paywalls recipe that we've still seen succeed
// via the generic extractor. Reviewed via `would_reject` logs — add here
// only after confirming the generic extractor produces useful output.
export const EXTRA_ALLOWED = new Set([
  'blog.google',
  'concierto.cl',
  'emol.com',
]);

export function isPrivateOrReservedHost(hostname: string): boolean {
  // Strip optional surrounding brackets (some parsers keep them on IPv6)
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Loopback (IPv4 + IPv6)
  if (h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0' || h === '::1') return true;
  // Private ranges (RFC 1918) + link-local / cloud metadata (IPv4)
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h)) return true;
  // IPv6-mapped IPv4 (::ffff:169.254.169.254 cloud metadata bypass)
  if (/^::ffff:(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.0\.0\.0)/.test(h)) return true;
  // IPv6 ULA (fd00::/8) and link-local (fe80::/10)
  if (/^(fd[0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(h)) return true;
  return false;
}

// Decides whether a URL belongs to the curated allowlist:
// custom extractor, bypass-paywalls recipe, or EXTRA_ALLOWED.
// Called from isExtractableUrl; also useful in tests.
export function isOnAllowlist(url: string): { allowed: boolean; reason: string } {
  if (detectSource(url)) return { allowed: true, reason: 'custom_extractor' };
  if (hasRecipe(url)) return { allowed: true, reason: 'bypass_recipe' };
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (EXTRA_ALLOWED.has(host)) return { allowed: true, reason: 'extra_allowed' };
    for (const d of EXTRA_ALLOWED) {
      if (host.endsWith('.' + d)) return { allowed: true, reason: 'extra_allowed' };
    }
  } catch { /* fall through */ }
  return { allowed: false, reason: 'not_in_allowlist' };
}

export function isExtractableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // Block private/reserved IPs (SSRF protection)
    if (isPrivateOrReservedHost(u.hostname)) return false;
    // Block known non-article domains
    if (SKIP_DOMAINS.has(host)) return false;
    for (const skip of SKIP_DOMAINS) {
      if (host.endsWith('.' + skip)) return false;
    }
    // Must have a path beyond "/" (skip homepages)
    if (u.pathname === '/' || u.pathname === '') return false;

    const { allowed } = isOnAllowlist(url);
    if (!allowed) return false;
    return true;
  } catch {
    return false;
  }
}

/** Pull http(s) URLs out of a free-form message body. */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"\]]+/gi;
  return (text.match(urlRegex) || []).map(url => url.replace(/[.,;:!?)]+$/, ''));
}

/**
 * Strip Google AMP wrappers / cdn.ampproject.org redirects to get the
 * canonical URL. After de-amping, we re-check the host against the SSRF
 * blocklist — an attacker could otherwise smuggle a private IP through
 * the AMP wrapper.
 */
export function deAmpUrl(url: string): string {
  // cdn.ampproject.org: https://www-example-com.cdn.ampproject.org/c/s/www.example.com/path
  const ampMatch = url.match(/cdn\.ampproject\.org\/[^/]*\/s\/(.+)/);
  if (ampMatch) {
    const deamped = `https://${ampMatch[1]}`;
    try { if (isPrivateOrReservedHost(new URL(deamped).hostname)) return url; } catch { return url; }
    return deamped;
  }
  // Google AMP cache: https://www.google.com/amp/s/www.example.com/path
  const googleAmpMatch = url.match(/google\.com\/amp\/s\/(.+)/);
  if (googleAmpMatch) {
    const deamped = `https://${googleAmpMatch[1]}`;
    try { if (isPrivateOrReservedHost(new URL(deamped).hostname)) return url; } catch { return url; }
    return deamped;
  }
  return url;
}

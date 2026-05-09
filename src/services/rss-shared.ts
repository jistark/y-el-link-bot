import { InlineKeyboard } from 'grammy';
import { createHash } from 'node:crypto';

// Regen button shown on RSS-poller messages (senal/adprensa/fotoportadas).
// Callback data is `regen_rss:{source}:{guidHash}` where guidHash is the
// first 16 hex chars of SHA-256(guid) — 64-bit collision space, effectively
// zero collision risk across a feed's recent items.
//
// Why hash and not raw guid: many feeds use URL-style GUIDs that share long
// common prefixes (e.g. `https://site.com/?p=N`), so naïve prefix truncation
// collapses every entry from the same site to a single key.
export function hashGuid(guid: string): string {
  return createHash('sha256').update(guid).digest('hex').slice(0, 16);
}

export function createRssRegenKeyboard(source: string, guid: string): InlineKeyboard {
  return new InlineKeyboard().text('\u{1F504}', `regen_rss:${source}:${hashGuid(guid)}`);
}

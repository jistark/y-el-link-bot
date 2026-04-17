import { InlineKeyboard } from 'grammy';

// Regen button shown on RSS-poller messages (senal/adprensa/fotoportadas).
// Callback data is `regen_rss:{source}:{guidHash}` — guid is truncated to
// 20 chars so the full callback_data stays under Telegram's 64-byte limit.
export function createRssRegenKeyboard(source: string, guid: string): InlineKeyboard {
  const guidHash = guid.slice(0, 20);
  return new InlineKeyboard().text('\u{1F504}', `regen_rss:${source}:${guidHash}`);
}

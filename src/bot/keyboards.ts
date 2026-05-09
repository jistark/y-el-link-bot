/**
 * Inline-keyboard builders shared by the message handler and the callback
 * dispatcher.
 *
 * Keyed off the shared state in `src/bot/state.ts` (cache + pathToUrl).
 */

import { InlineKeyboard } from 'grammy';
import { cache, pathToUrl } from './state.js';

/**
 * Recover the original URL for a given Telegraph slug. Falls back to
 * fetching the Telegraph page metadata (author_url) so the regen flow
 * survives a process restart that wiped the in-memory pathToUrl.
 */
export async function getUrlForPath(path: string): Promise<string | null> {
  if (pathToUrl.has(path)) return pathToUrl.get(path)!;
  for (const [url, entry] of cache) {
    if (entry.result.path === path) return url;
  }
  // Fallback: leer author_url desde Telegraph (sobrevive redeploys)
  try {
    const res = await fetch(`https://api.telegra.ph/getPage/${path}?return_content=false`);
    const data = await res.json();
    if (data.ok && data.result?.author_url) {
      pathToUrl.set(path, data.result.author_url);
      return data.result.author_url;
    }
  } catch { /* ok */ }
  return null;
}

/**
 * Build the four-button action row attached to every published article:
 * 🗑️ delete, 🔄 regen, 📦 archive.ph, 🐦 twitter search.
 *
 * If the callback_data would exceed Telegram's 64-byte limit (long
 * Telegraph slug + long userId), we degrade gracefully:
 *  - del: drops the timestamp so withinGrace becomes false (admin-only).
 *  - regen: replaces userId with the 'x' sentinel (admin-only).
 * See parseRegenCallback in src/utils/callbacks.ts for the parser side.
 */
export function createActionKeyboard(
  telegraphPath: string,
  userId: number,
  originalUrl: string,
): InlineKeyboard {
  // Guardar mapping path → URL para poder regenerar
  pathToUrl.set(telegraphPath, originalUrl);

  const archiveUrl = `https://archive.ph/?q=${encodeURIComponent(originalUrl)}`;
  const twitterUrl = `https://twitter.com/search?q=${encodeURIComponent(originalUrl)}`;

  const ts = Math.floor(Date.now() / 1000).toString(36);
  const deleteData = `del:${telegraphPath}:${userId}:${ts}`;
  const regenData = `regen:${telegraphPath}:${userId}`;

  const delCallback = deleteData.length <= 64
    ? deleteData
    : `del:${telegraphPath}:${userId}:0`;
  const regenCallback = regenData.length <= 64
    ? regenData
    : `regen:${telegraphPath}:x`;

  return new InlineKeyboard()
    .text('🗑️', delCallback)
    .text('🔄', regenCallback)
    .url('📦', archiveUrl)
    .url('🐦', twitterUrl);
}

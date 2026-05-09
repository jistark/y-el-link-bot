import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { escapeHtmlMinimal } from '../utils/shared.js';

/**
 * Render a Telegram-flavored mention for the message sender. Prefers the
 * @username form when available, otherwise falls back to a tg://user link
 * with the user's first_name (HTML-escaped — first_name is user-supplied
 * and can contain `<`, `>`, `&`).
 */
export function getUserMention(ctx: Context): string {
  const user = ctx.from;
  if (!user) return '';

  if (user.username) {
    return `@${user.username}`;
  }
  return `<a href="tg://user?id=${user.id}">${escapeHtmlMinimal(user.first_name)}</a>`;
}

/** Strip http(s) URLs out of a message text, return what remains. */
export function getTextWithoutUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"\]]+/gi, '').trim();
}

/** Single-button keyboard used during the UNDO_GRACE_PERIOD window. */
export function createUndoKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('⏪ Cancelar', 'undo');
}

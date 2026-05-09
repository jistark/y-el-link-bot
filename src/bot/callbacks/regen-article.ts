/**
 * `regen:` callback — re-extract a Telegraph article from the original URL.
 *
 * Owner or admin can regen. When the callback was truncated past 64 bytes
 * the userId is replaced with the 'x' sentinel by createActionKeyboard,
 * and gating degrades to admin-only (see canRegen in utils/callbacks.ts).
 */

import type { Context } from 'grammy';
import { extractArticle } from '../../extractors/index.js';
import { createPage } from '../../formatters/telegraph.js';
import { canRegen as canRegenAccess, parseRegenCallback } from '../../utils/callbacks.js';
import { escapeHtmlMinimal as escapeHtml, scheduleDelete, withTimeout } from '../../utils/shared.js';
import { createActionKeyboard, getUrlForPath } from '../keyboards.js';
import { cache, pathToUrl, TTL } from '../state.js';
import type { CallbackHandler } from './types.js';

async function isUserAdmin(ctx: Context, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

export const regenArticleHandler: CallbackHandler = {
  name: 'regen',
  matches: (data) => data.startsWith('regen:'),
  async handle(ctx: Context) {
    const data = ctx.callbackQuery!.data!;
    const { telegraphPath, ownerId } = parseRegenCallback(data);
    const userId = ctx.from?.id;

    const isAdmin = userId ? await isUserAdmin(ctx, userId) : false;
    if (!canRegenAccess({ ownerId, userId, isAdmin })) {
      await ctx.answerCallbackQuery({ text: 'Solo el autor o admins pueden regenerar', show_alert: true });
      return;
    }

    const originalUrl = await getUrlForPath(telegraphPath);
    if (!originalUrl) {
      await ctx.answerCallbackQuery({ text: 'No se puede regenerar. Postea la URL de nuevo.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🔄 Regenerando...' });

    try {
      const chatId = ctx.callbackQuery!.message?.chat.id;
      const messageId = ctx.callbackQuery!.message?.message_id;
      if (chatId && messageId) {
        await ctx.api.editMessageText(chatId, messageId, '⏳ Regenerando artículo...');
      }

      const article = await withTimeout(extractArticle(originalUrl), 30_000);
      const result = await createPage(article);

      cache.delete(originalUrl);
      pathToUrl.delete(telegraphPath);
      cache.set(originalUrl, { result, expires: Date.now() + TTL });

      // Si ownerId es null (callback truncado), el regenerador hereda el
      // ownership del mensaje regenerado.
      const newKeyboard = createActionKeyboard(result.path, ownerId ?? userId!, originalUrl);
      const mention = ctx.from?.username ? `@${ctx.from.username}` :
        `<a href="tg://user?id=${ctx.from?.id}">${escapeHtml(ctx.from?.first_name || '')}</a>`;
      const messageText = `${mention} compartió:\n${result.url}`;

      if (chatId && messageId) {
        await ctx.api.editMessageText(chatId, messageId, messageText, {
          parse_mode: 'HTML',
          reply_markup: newKeyboard,
          link_preview_options: { is_disabled: false },
        });
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'regen_error',
        url: originalUrl,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      const chatId = ctx.callbackQuery!.message?.chat.id;
      const messageId = ctx.callbackQuery!.message?.message_id;
      if (chatId && messageId) {
        try {
          await ctx.api.editMessageText(chatId, messageId, '❌ No se pudo regenerar el artículo.');
          scheduleDelete(ctx.api, chatId, messageId);
        } catch {}
      }
    }
  },
};

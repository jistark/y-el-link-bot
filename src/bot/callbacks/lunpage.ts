/**
 * `lunpage:` callback — selection of which article on a multi-article LUN
 * papel-digital page should be published.
 *
 * Format: `lunpage:{kind}:{idx}` where kind is 'g' (whole page combined)
 * or 'a' (single article).
 */

import type { Context } from 'grammy';
import {
  extractLunByNewsId, extractLunPageGroup,
} from '../../extractors/lun.js';
import { scheduleDelete, withTimeout } from '../../utils/shared.js';
import { pendingLunPages } from '../state.js';
import type { Article } from '../../types.js';
import type { CallbackHandler } from './types.js';
import { checkSelectionOwner, publishSelection } from './publish-selection.js';

export const lunpageHandler: CallbackHandler = {
  name: 'lunpage',
  matches: (data) => data.startsWith('lunpage:'),
  async handle(ctx: Context) {
    const data = ctx.callbackQuery!.data!;
    const messageId = ctx.callbackQuery!.message?.message_id;
    if (!messageId) {
      await ctx.answerCallbackQuery({ text: 'Error interno' });
      return;
    }
    const sel = pendingLunPages.get(messageId);
    if (!sel) {
      await ctx.answerCallbackQuery({ text: 'Selección expirada. Pega la URL de nuevo.', show_alert: true });
      return;
    }

    if (!(await checkSelectionOwner(ctx, sel))) {
      await ctx.answerCallbackQuery({ text: 'Solo quien pegó la URL puede elegir' });
      return;
    }

    const m = data.match(/^lunpage:([ga]):(\d+)$/);
    if (!m) {
      await ctx.answerCallbackQuery({ text: 'Selección no válida' });
      return;
    }
    const kind = m[1];
    const idx = parseInt(m[2], 10);

    let extracted: Article;
    let cacheKey: string;

    try {
      if (kind === 'g') {
        pendingLunPages.delete(messageId);
        await ctx.answerCallbackQuery({ text: '⏳ Procesando página...' });
        await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando página...');
        extracted = await withTimeout(
          extractLunPageGroup(sel.articles, sel.fecha, sel.paginaId, sel.originalUrl),
          30_000,
        );
        cacheKey = `${sel.originalUrl}#lunpage:all`;
      } else {
        const article = sel.articles[idx];
        if (!article) {
          await ctx.answerCallbackQuery({ text: 'Artículo no válido' });
          return;
        }
        pendingLunPages.delete(messageId);
        await ctx.answerCallbackQuery({ text: '⏳ Procesando...' });
        await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando artículo...');
        extracted = await withTimeout(
          extractLunByNewsId(article.newsId, sel.fecha, sel.paginaId, sel.originalUrl),
          30_000,
        );
        cacheKey = `${sel.originalUrl}#lunpage:${article.newsId}`;
      }

      await publishSelection(ctx, sel, extracted, cacheKey);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'lun_page_extraction_error',
        url: sel.originalUrl, kind, idx,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      try {
        await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '❌ No pude extraer la página.');
        scheduleDelete(ctx.api, sel.chatId, sel.botMessageId);
      } catch {}
    }
  },
};

/**
 * `empage:` callback — selection of which article on a multi-article
 * El Mercurio papel-digital page should be published.
 *
 * Format: `empage:{kind}:{idx}` where kind is 'g' (story group) or
 * 'a' (standalone article).
 */

import type { Context } from 'grammy';
import {
  extractByArticleId, extractStoryGroup,
} from '../../extractors/elmercurio.js';
import { scheduleDelete, withTimeout } from '../../utils/shared.js';
import { pendingPages } from '../state.js';
import type { Article } from '../../types.js';
import type { CallbackHandler } from './types.js';
import { checkSelectionOwner, publishSelection } from './publish-selection.js';

export const empageHandler: CallbackHandler = {
  name: 'empage',
  matches: (data) => data.startsWith('empage:'),
  async handle(ctx: Context) {
    const data = ctx.callbackQuery!.data!;
    const messageId = ctx.callbackQuery!.message?.message_id;
    if (!messageId) {
      await ctx.answerCallbackQuery({ text: 'Error interno' });
      return;
    }

    const sel = pendingPages.get(messageId);
    if (!sel) {
      await ctx.answerCallbackQuery({ text: 'Selección expirada. Pega la URL de nuevo.', show_alert: true });
      return;
    }

    if (!(await checkSelectionOwner(ctx, sel))) {
      await ctx.answerCallbackQuery({ text: 'Solo quien pegó la URL puede elegir' });
      return;
    }

    const m = data.match(/^empage:([ga]):(\d+)$/);
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
        const group = sel.groups[idx];
        if (!group) {
          await ctx.answerCallbackQuery({ text: 'Grupo no válido' });
          return;
        }
        pendingPages.delete(messageId);
        await ctx.answerCallbackQuery({ text: '⏳ Procesando reportaje...' });
        await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando reportaje...');
        extracted = await withTimeout(
          extractStoryGroup(group, sel.date, sel.pageId),
          30_000,
        );
        cacheKey = `${sel.originalUrl}#group:${group.anchor.id}`;
      } else {
        const article = sel.standalone[idx];
        if (!article) {
          await ctx.answerCallbackQuery({ text: 'Artículo no válido' });
          return;
        }
        pendingPages.delete(messageId);
        await ctx.answerCallbackQuery({ text: '⏳ Procesando...' });
        await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando artículo...');
        extracted = await withTimeout(
          // pageId enables printed-page footer + explicit cover policy.
          extractByArticleId(article.id, sel.date, sel.pageId),
          30_000,
        );
        cacheKey = `${sel.originalUrl}#${article.id}`;
      }

      await publishSelection(ctx, sel, extracted, cacheKey);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'page_extraction_error',
        url: sel.originalUrl,
        kind, idx,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      try {
        await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '❌ No pude reconstruir el artículo.');
        scheduleDelete(ctx.api, sel.chatId, sel.botMessageId);
      } catch {}
    }
  },
};

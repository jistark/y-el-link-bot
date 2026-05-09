/**
 * Wires the callback handler registry to grammy: iterates handlers in
 * order and dispatches to the first one whose `matches(data)` returns
 * true. If nothing matches, answers the callback silently to dismiss
 * Telegram's "loading" spinner.
 */

import type { Bot } from 'grammy';
import { callbackHandlers } from './index.js';

export function registerCallbackDispatcher(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    for (const h of callbackHandlers) {
      if (h.matches(data)) {
        await h.handle(ctx);
        return;
      }
    }
    await ctx.answerCallbackQuery();
  });
}

/**
 * Bot-wide middleware and error-handler setup.
 *
 * Two responsibilities:
 *  1. `setupThreadPreservation` — wraps `ctx.reply` so every response is
 *     posted into the same forum topic the user wrote from. Without this,
 *     replies fall back to the General topic and disappear from the
 *     thread the user was in.
 *  2. `setupErrorHandler` — catches uncaught errors from the dispatcher
 *     and logs them as structured events. Errors that escape grammy's
 *     middleware chain land here.
 */

import type { Bot } from 'grammy';

/**
 * Inject `message_thread_id` into every `ctx.reply` automatically when
 * the incoming message is in a forum topic. Other-options (parse_mode,
 * reply_markup, etc.) win — we just default the thread.
 */
export function setupThreadPreservation(bot: Bot): void {
  bot.use((ctx, next) => {
    const threadId = ctx.msg?.message_thread_id;
    if (threadId) {
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = (text: string, other?: any) =>
        originalReply(text, { message_thread_id: threadId, ...other });
    }
    return next();
  });
}

/**
 * Top-level error handler. Logs grammy-uncaught errors as structured JSON
 * with the originating update id (when present) for triage.
 */
export function setupErrorHandler(bot: Bot): void {
  bot.catch((err) => {
    console.error(JSON.stringify({
      event: 'bot_error',
      error: err.message,
      ctx: err.ctx?.update?.update_id,
      timestamp: new Date().toISOString(),
    }));
  });
}

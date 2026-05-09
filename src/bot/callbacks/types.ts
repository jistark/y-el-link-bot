/**
 * Callback router contract.
 *
 * The bot's callback_query:data dispatcher iterates the registered handlers
 * in order. The first one whose `matches(data)` returns true owns the
 * callback — its `handle(ctx)` is awaited and the dispatcher returns.
 *
 * Order matters: more-specific prefixes must come before broader ones
 * (e.g. `regen_rss:` before `regen:` if they both started with `regen`,
 * which they don't here, but the discipline is the same).
 */

import type { Context } from 'grammy';

export interface CallbackHandler {
  /** Short identifier used in logs and tests. */
  name: string;
  /** Cheap predicate run for every incoming callback. */
  matches(data: string): boolean;
  /** Full handler. Awaited by the dispatcher; must answerCallbackQuery itself. */
  handle(ctx: Context): Promise<void>;
}

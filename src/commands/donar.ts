/**
 * /donar (alias /donate) — small inline-keyboard reply with the Stripe
 * donation link. Self-contained: no external state, no API calls.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';

const STRIPE_URL = 'https://donate.stripe.com/eVq8wQ4XtbW5clbep0cfK01';

export function registerDonarCommand(bot: Bot): void {
  bot.command(['donar', 'donate'], async (ctx) => {
    const keyboard = new InlineKeyboard().url('🌭 Donar', STRIPE_URL);
    await ctx.reply(
      '🌭 Gracias por apoyar a la DVJ. Apóyanos con un tocomple.',
      { reply_markup: keyboard },
    );
  });
}

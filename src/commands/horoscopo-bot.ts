/**
 * Telegram-side handler for /tiayoli (alias /horoscopo).
 *
 * The data layer (sign matching, scraping, formatting) lives in
 * src/commands/horoscopo.ts; this module wires it up to grammy and
 * handles the no-arg help text + error fallback.
 */

import type { Bot } from 'grammy';
import { getHoroscopo, getSignosList } from './horoscopo.js';

export function registerHoroscopoCommand(bot: Bot): void {
  bot.command(['tiayoli', 'horoscopo'], async (ctx) => {
    // Pasar el input raw — getHoroscopo aplica escapeHtmlMinimal internamente
    // donde corresponde (no aquí, donde signo se usa como clave de búsqueda).
    const signo = ctx.match?.trim() || '';
    if (!signo) {
      await ctx.reply(
        `🔮 <b>Horóscopo de Yolanda Sultana</b>\n\nUsa: /tiayoli &lt;signo&gt;\n\n${getSignosList()}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const userName = ctx.from?.first_name || ctx.from?.username || '';
      const result = await getHoroscopo(signo, userName);
      await ctx.reply(result, {
        parse_mode: 'HTML',
        reply_parameters: {
          message_id: ctx.message!.message_id,
          allow_sending_without_reply: true,
        },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'horoscopo_error',
        signo,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      await ctx.reply('❌ No pude obtener el horóscopo. El sitio puede estar caído.');
    }
  });
}

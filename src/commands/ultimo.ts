/**
 * /ultimo (alias /last) — fetch the latest item from one of the RSS
 * pollers (Señal, Pauta, Fotoportadas) and post it inline.
 *
 * Restricted to the configured POLLER_CHAT_ID so it can't be invoked
 * from arbitrary chats — the pollers are authored for a single private
 * channel.
 *
 *   /ultimo            → all three sources
 *   /ultimo senal      → Señal only
 *   /ultimo pauta      → ADPrensa only
 *   /ultimo fotoportadas → Fotoportadas only
 */

import type { Bot } from 'grammy';
import { fetchLatestPauta } from '../services/adprensa-poller.js';
import { fetchLatestFotoportadas } from '../services/fotoportadas-poller.js';
import { fetchLatestSenal } from '../services/rss-poller.js';
import { scheduleDelete } from '../utils/shared.js';

export function registerUltimoCommand(bot: Bot): void {
  // Resolve the gate at registration time. Tests can stub via env var.
  const pollerChatId = parseInt(process.env.POLLER_CHAT_ID || '', 10);

  bot.command(['ultimo', 'last'], async (ctx) => {
    if (!pollerChatId || ctx.chat.id !== pollerChatId) return;

    const arg = ctx.match?.trim().toLowerCase() || '';
    const wantSenal = !arg || arg === 'senal' || arg === 'señal';
    const wantPauta = !arg || arg === 'pauta';
    const wantFotoportadas = !arg || arg === 'fotoportadas' || arg === 'portadas';

    try {
      const threadId = ctx.message?.message_thread_id;
      let sent = false;
      if (wantSenal) {
        sent = await fetchLatestSenal(ctx.api, ctx.chat.id, threadId) || sent;
      }
      if (wantPauta) {
        sent = await fetchLatestPauta(ctx.api, ctx.chat.id, threadId) || sent;
      }
      if (wantFotoportadas) {
        sent = await fetchLatestFotoportadas(ctx.api, ctx.chat.id, threadId) || sent;
      }
      if (!sent) {
        const notFound = await ctx.reply('No encontré publicaciones recientes.');
        scheduleDelete(ctx.api, notFound.chat.id, notFound.message_id);
      }
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'ultimo_error',
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
      const errMsg = await ctx.reply('Error al obtener la última publicación.');
      scheduleDelete(ctx.api, errMsg.chat.id, errMsg.message_id);
    }
  });
}

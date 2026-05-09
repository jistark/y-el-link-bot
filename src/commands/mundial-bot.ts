/**
 * Telegram-side handlers for the /mundial feature.
 *
 *  - `/mundial [arg]` — countdown / today / mañana / semana / equipos / team
 *    lookup, plus a small set of easter eggs (Chile, URSS, Norcorea, etc.).
 *  - `/setup_mundial` — admin-only, records the chat+topic where the
 *    2-hours-before-kickoff notification should land.
 *  - `startMundialNotifier(bot)` — kicks off the periodic scheduler.
 *
 * The data layer (matches, parsing, formatting) lives in src/commands/mundial.ts;
 * this module only wires it up to grammy.
 */

import type { Bot } from 'grammy';
import { InputFile } from 'grammy';
import {
  formatMatchesForDate, formatMatchesForTeam, formatMatchesForWeek, formatNotification,
  getAllTeams, getChileDate, getCountdown, getMatchesAtTime, getMatchesForDate,
  getMatchesForTeam, getMatchesForWeek,
} from './mundial.js';
import { getMundialConfig, saveMundialConfig } from '../bot/mundial-config.js';
import { safeSendMessage } from '../bot/safe-send.js';
import { mundialNotified } from '../bot/state.js';
import { escapeHtmlMinimal as escapeHtml } from '../utils/shared.js';

export function registerMundialCommand(bot: Bot): void {
  bot.command(['mundial', 'wc'], async (ctx) => {
    // Sanitize input: strip HTML tags, invisible Unicode, cap length.
    const rawArg = ctx.match?.trim() || '';
    const arg = rawArg
      .replace(/<[^>]*>/g, '')                    // strip HTML tags
      .replace(/[^\p{L}\p{N}\s'-]/gu, '')         // letters, numbers, spaces, dashes, apostrophes only
      .trim()
      .toLowerCase()
      .slice(0, 50);

    // Original input had content but sanitized version is empty → garbage.
    const hadInput = rawArg.length > 0;
    const replyOpts = { reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } };
    const htmlReplyOpts = { parse_mode: 'HTML' as const, ...replyOpts };

    // Sin argumento o "hoy": countdown o partidos de hoy.
    if ((!arg && !hadInput) || arg === 'hoy') {
      const countdown = getCountdown();
      if (countdown) {
        await ctx.reply(countdown, htmlReplyOpts);
        return;
      }
      const today = getChileDate();
      const matches = getMatchesForDate(today);
      await ctx.reply(formatMatchesForDate(matches, today, 'Hoy'), htmlReplyOpts);
      return;
    }

    if (arg === 'mañana' || arg === 'manana') {
      const tomorrow = getChileDate(1);
      const matches = getMatchesForDate(tomorrow);
      await ctx.reply(formatMatchesForDate(matches, tomorrow, 'Mañana'), htmlReplyOpts);
      return;
    }

    if (arg === 'semana') {
      const today = getChileDate();
      const matches = getMatchesForWeek(today);
      await ctx.reply(formatMatchesForWeek(matches), htmlReplyOpts);
      return;
    }

    if (arg === 'equipos') {
      const teams = getAllTeams();
      const teamList = teams.map(t => `• ${t}`).join('\n');
      await ctx.reply(
        `⚽ <b>Mundial 2026 — Equipos participantes</b>\n\n${teamList}`,
        htmlReplyOpts,
      );
      return;
    }

    // Easter eggs (deliberately match accent-stripped lowercase forms).
    const argNorm = arg.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

    if (argNorm === 'chile' || argNorm === 'la roja') {
      await ctx.reply('https://www.zzinstagram.com/p/BZs-WG7h8JL/', replyOpts);
      return;
    }

    if (argNorm === 'urss' || argNorm === 'ussr' || argNorm === 'union sovietica' || argNorm === 'soviet union') {
      await ctx.reply('https://www.youtube.com/watch?v=TFS316SzGFQ', replyOpts);
      return;
    }

    if (argNorm === 'norcorea' || argNorm === 'corea del norte' || argNorm === 'north korea') {
      await replyWithRemoteImage(ctx, 'https://i.imgur.com/B7yiPD1.jpeg', 'norcorea.jpg', replyOpts);
      return;
    }

    if (argNorm === 'artes' || argNorm === 'profesor artes' || argNorm === 'profesor de artes') {
      await replyWithRemoteImage(ctx, 'https://i.imgur.com/klS1PxD.jpeg', 'artes.jpg', replyOpts);
      return;
    }

    // El pelao de brazzers / Johnny Sins
    if (/\b(pelao|pelado)\b/.test(argNorm) || /\bbrazzers\b/.test(argNorm) || /\bjohnny\s*sins?\b/.test(argNorm)) {
      await replyWithRemoteImage(ctx, 'https://i.imgur.com/Ys17mHl.jpeg', 'pelao.jpg', replyOpts);
      return;
    }

    // Groserías
    if (/^(pene|pito|pichula|tula)$/.test(argNorm)) {
      await ctx.reply('\u{1F90F}', replyOpts);
      return;
    }

    // Buscar por equipo
    const result = getMatchesForTeam(arg);
    if (result) {
      await ctx.reply(formatMatchesForTeam(result.team, result.matches), htmlReplyOpts);
      return;
    }

    // Equipo no encontrado
    const displayArg = arg || rawArg.slice(0, 50);
    await ctx.reply(
      `⚽❌ <b>${escapeHtml(displayArg)}</b> NO va al mundial 2026\n\n` +
      'Usa /mundial equipos para ver quiénes sí van',
      htmlReplyOpts,
    );
  });

  bot.command('setup_mundial', async (ctx) => {
    if (!ctx.chat || !ctx.from) return;

    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (!['creator', 'administrator'].includes(member.status)) {
        await ctx.reply('Solo admins pueden configurar las notificaciones del Mundial.');
        return;
      }
    } catch { return; }

    const topicId = ctx.msg?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Ejecuta este comando dentro del topic donde quieres recibir las notificaciones.');
      return;
    }

    await saveMundialConfig(ctx.chat.id, topicId);
    await ctx.reply('✅ Notificaciones del Mundial configuradas para este topic.\nSe avisará 2 horas antes de cada partido.');
  });
}

// Imgur fetch + replyWithPhoto. Failure path posts a 🫠 placeholder so
// the user gets feedback even when imgur is being rate-limited.
async function replyWithRemoteImage(
  ctx: any, // grammy Context — kept loose to avoid coupling here
  url: string,
  filename: string,
  replyOpts: any,
): Promise<void> {
  try {
    const buf = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then(r => r.arrayBuffer());
    await ctx.replyWithPhoto(new InputFile(new Uint8Array(buf), filename), replyOpts);
  } catch {
    await ctx.reply('🫠', replyOpts);
  }
}

/**
 * Periodic scheduler: every minute, check whether any match starts in
 * exactly 2 hours (Chile time, minute precision). Emits a single
 * notification per (date, time) key — `mundialNotified` lives in state.ts.
 */
export function startMundialNotifier(bot: Bot): void {
  // .unref() makes the timer non-blocking for process exit (production
  // is fine because the bot is the main loop; tests need this to exit).
  const handle = setInterval(async () => {
    const cfg = getMundialConfig();
    if (!cfg) return;

    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const futureDate = twoHoursFromNow.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
    const futureTime = twoHoursFromNow.toLocaleTimeString('en-GB', {
      timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit',
    });

    const matches = getMatchesAtTime(futureDate, futureTime);
    if (matches.length === 0) return;

    const key = `${futureDate}-${futureTime}`;
    if (mundialNotified.has(key)) return;
    mundialNotified.add(key);

    try {
      await safeSendMessage(bot.api, cfg.chatId, formatNotification(matches), {
        message_thread_id: cfg.topicId,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'mundial_notification_error',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }, 60_000);
  handle.unref();
}

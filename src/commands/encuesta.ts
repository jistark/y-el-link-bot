/**
 * /encuesta — La Segunda's "Sondeo Relámpago" via the StrawPoll embed.
 *
 * Two-step fetch: scrape the poll ID off lasegunda.com's homepage, then
 * hit the public StrawPoll v3 API for vote counts.
 */

import type { Bot } from 'grammy';
import { escapeHtmlMinimal } from '../utils/shared.js';

export interface EncuestaResult {
  title: string;
  options: { value: string; votes: number }[];
  totalVotes: number;
  pollId: string;
}

export async function fetchEncuestaLaSegunda(): Promise<EncuestaResult> {
  // 1. Scrape poll ID from lasegunda.com homepage
  const page = await fetch('https://www.lasegunda.com/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!page.ok) throw new Error(`lasegunda.com respondió ${page.status}`);
  const html = await page.text();
  const idMatch = html.match(/strawpoll\.com\/embed\/(\w+)/);
  if (!idMatch) throw new Error('No se encontró encuesta en lasegunda.com');
  const pollId = idMatch[1];

  // 2. Fetch poll data from StrawPoll API v3 (public, no auth needed)
  const api = await fetch(`https://api.strawpoll.com/v3/polls/${pollId}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!api.ok) throw new Error(`StrawPoll API respondió ${api.status}`);
  const data = await api.json() as {
    title?: string;
    poll_options?: { value?: string; vote_count?: number }[];
  };

  if (!data.title || !data.poll_options?.length) {
    throw new Error('StrawPoll devolvió datos incompletos');
  }

  const options = data.poll_options.map(o => ({
    value: (o.value || '').replace(/\.$/, ''),
    votes: o.vote_count || 0,
  }));
  const totalVotes = options.reduce((s, o) => s + o.votes, 0);

  return { title: data.title, options, totalVotes, pollId };
}

export function registerEncuestaCommand(bot: Bot): void {
  bot.command(['encuesta', 'encuestalasegunda'], async (ctx) => {
    console.log('Comando encuesta recibido');
    try {
      const { title, options, totalVotes, pollId } = await fetchEncuestaLaSegunda();

      const lines = options.map(o => {
        const pct = totalVotes > 0 ? ((o.votes / totalVotes) * 100).toFixed(1).replace('.', ',') : '0';
        const bar = totalVotes > 0 ? '█'.repeat(Math.round((o.votes / totalVotes) * 10)) : '';
        return `${bar} <b>${o.value}</b>: ${o.votes.toLocaleString('es-CL')} (${pct}%)`;
      });

      const message = [
        '⚡ <b>SONDEO RELÁMPAGO</b>',
        '',
        escapeHtmlMinimal(title),
        '',
        ...lines,
        '',
        `📊 ${totalVotes.toLocaleString('es-CL')} votos`,
        `<a href="https://strawpoll.com/${pollId}">Votar</a> · Fuente: <a href="https://www.lasegunda.com/#EncuestaLaSegunda">lasegunda.com</a>`,
      ].join('\n');

      await ctx.reply(message, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'encuesta_error',
        chatId: ctx.chat.id,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      await ctx.reply('❌ No pude obtener la encuesta de La Segunda.');
    }
  });
}

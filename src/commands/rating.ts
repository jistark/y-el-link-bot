/**
 * /rating_youtube (alias /ryt) and /rating_zapping (alias /rz) commands.
 *
 * Fetch live rating data and post a sorted summary to the chat. Both fail
 * soft — on any error the user gets a generic ❌ message and the failure
 * is logged.
 */

import type { Bot } from 'grammy';
import { escapeHtmlMinimal } from '../utils/shared.js';
import { getChileTime } from './chile-time.js';

// --- Zapping ratings ---------------------------------------------------------

export const ZAPPING_CHANNELS = [
  { id: 'tvno', name: 'TVN', emoji: '🔴' },
  { id: 'mega', name: 'Mega', emoji: '🟣' },
  { id: '13', name: 'Canal 13', emoji: '🟠' },
  { id: 'chv', name: 'CHV', emoji: '⚪' },
  { id: 'lared', name: 'La Red', emoji: '🟢' },
  { id: 'tvm', name: 'TV+', emoji: '🔵' },
];

export async function fetchZappingRatings(): Promise<{ channel: typeof ZAPPING_CHANNELS[0]; rating: string }[]> {
  return Promise.all(
    ZAPPING_CHANNELS.map(async (channel) => {
      try {
        const response = await fetch(`https://metrics.zappingtv.com/public/rating/${channel.id}`);
        const html = await response.text();
        // La API devuelve HTML tipo: <div id="channel_rating"> 10.8</div>
        const match = html.match(/>[\s]*([\d.]+)/);
        const rating = match ? match[1] : html.replace(/<[^>]*>/g, '').trim();
        return { channel, rating };
      } catch {
        return { channel, rating: '—' };
      }
    })
  );
}

// --- Podscope (YouTube live streams ranking) --------------------------------

export interface PodscopeRanking {
  rank: number;
  channelName: string;
  videoTitle: string;
  viewers: number;
  peakViewers: number;
  videoId: string;
}

export interface PodscopeResponse {
  rankings: PodscopeRanking[];
  updatedAt: string;
  totalCount: number;
  totalViewers: number;
}

export async function fetchYouTubeRankings(): Promise<PodscopeResponse> {
  const response = await fetch('https://api.podscope.co/api/live/rankings');
  if (!response.ok) throw new Error(`Podscope API error: ${response.status}`);
  return response.json() as Promise<PodscopeResponse>;
}

export function formatViewers(n: number): string {
  return n.toLocaleString('es-CL');
}

// --- Command registration ---------------------------------------------------

export function registerRatingCommands(bot: Bot): void {
  // /rating_youtube — alias /ryt
  bot.command(['rating_youtube', 'ryt'], async (ctx) => {
    console.log('Comando rating_youtube recibido');

    try {
      const data = await fetchYouTubeRankings();
      const time = getChileTime();

      const lines = data.rankings.map(({ rank, channelName, videoTitle, viewers, peakViewers }) => {
        const medal = rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `${rank}.`;
        // Truncar título del video si es muy largo
        const title = videoTitle.length > 50 ? videoTitle.slice(0, 47) + '...' : videoTitle;
        // Escape HTML — channel/video names can contain &, <, > which would
        // break Telegram's HTML parse mode and reject the whole message.
        return `${medal} <b>${escapeHtmlMinimal(channelName)}</b>: ${formatViewers(viewers)} 👀\n    <i>${escapeHtmlMinimal(title)}</i>` +
          (peakViewers > viewers ? `\n    (peak: ${formatViewers(peakViewers)})` : '');
      });

      const message = `📺 <b>Rating YouTube Chile</b> (${time} hrs)\n\n` +
        `${lines.join('\n\n')}\n\n` +
        `📡 ${data.totalCount} streams | 👥 ${formatViewers(data.totalViewers)} viewers\n` +
        `<i>Fuente: podscope.co</i>`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Error fetching YouTube rankings:', error);
      await ctx.reply('❌ No pude obtener el ranking de YouTube. Intenta de nuevo más tarde.');
    }
  });

  // /rating_zapping — alias /rz
  bot.command(['rating_zapping', 'rz'], async (ctx) => {
    console.log(JSON.stringify({ event: 'rz_received', timestamp: new Date().toISOString() }));

    try {
      const ratings = await fetchZappingRatings();
      const time = getChileTime();

      const sorted = ratings.sort((a, b) => {
        const rA = parseFloat(a.rating) || 0;
        const rB = parseFloat(b.rating) || 0;
        return rB - rA;
      });

      const lines = sorted.map(({ channel, rating }) =>
        `${channel.emoji} ${channel.name}: <b>${escapeHtmlMinimal(rating)}</b>`
      );

      const message = `📺 <b>Rating Zapping</b> (${time} hrs)\n\n${lines.join('\n')}\n\n<i>Fuente: zapping.com</i>`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'rz_error',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      try {
        await ctx.reply('❌ No pude obtener el rating. Intenta de nuevo.');
      } catch { /* swallow — best-effort */ }
    }
  });
}

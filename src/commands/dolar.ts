/**
 * /dolar (alias /usd) — current USD/CLP exchange rate from dolar.cl.
 *
 * Three-tier strategy:
 *  1. Fast path: Bun native fetch of dolar.cl (works locally, often blocked
 *     from datacenter IPs by Vercel's bot-protection challenge).
 *  2. Fallback: mindicador.cl observed-dollar API → reply immediately.
 *  3. Background: try dolar.cl via the Python curl_cffi proxy. If it
 *     succeeds, edit the original message with the richer data.
 *
 * Without an argument: shows all sources.
 * With an argument: filters by name, id, or alias (eg /dolar bancoestado).
 */

import type { Bot } from 'grammy';
import { escapeHtmlMinimal } from '../utils/shared.js';
import { fetchBypass } from '../extractors/fetch-bypass.js';
import { getChileTime } from './chile-time.js';

export const DOLLAR_SOURCES = [
  { id: 'btg', name: 'BTG Pactual', aliases: ['btg pactual'] },
  { id: 'fintual', name: 'Fintual', aliases: [] },
  { id: 'bci', name: 'BCI', aliases: [] },
  { id: 'falabella', name: 'Banco Falabella', aliases: ['cmr', 'falabella'] },
  { id: 'bancochile', name: 'Banco de Chile', aliases: ['bancochile', 'banco chile', 'bch'] },
  { id: 'itau', name: 'Itaú', aliases: ['itau'] },
  { id: 'estado', name: 'BancoEstado', aliases: ['banco estado', 'bancoestado', 'bech'] },
  { id: 'santander', name: 'Santander', aliases: [] },
] as const;

interface MindicadorResponse {
  serie: { fecha: string; valor: number }[];
}

export async function fetchDollarFallback(): Promise<number> {
  const response = await fetch('https://mindicador.cl/api/dolar', {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`mindicador.cl respondió ${response.status}`);
  const data = (await response.json()) as MindicadorResponse;
  if (!data.serie?.length) throw new Error('Sin datos en mindicador.cl');
  return data.serie[0].valor;
}

interface DollarQuote {
  buy: number;
  sell: number | null;
  time: string;
  fee: number | null;
}

interface LiveQuote {
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  percentChange: number;
  datetime: string;
}

export type DollarData = {
  live: LiveQuote | null;
  quotes: { source: typeof DOLLAR_SOURCES[number]; quote: DollarQuote | null }[];
};

export function parseDollarHtml(html: string): DollarData {
  if (!html.includes('"buy"')) throw new Error('dolar.cl devolvió challenge page');

  // Extraer live quote del dehydrated state
  let live: LiveQuote | null = null;
  const liveMatch = html.match(/"change":([-\d.]+),"close":([\d.]+),"datetime":"([^"]+)","high":([\d.]+),"low":([\d.]+),"open":([\d.]+),"percentChange":([-\d.]+)/);
  if (liveMatch) {
    live = {
      change: parseFloat(liveMatch[1]),
      close: parseFloat(liveMatch[2]),
      datetime: liveMatch[3],
      high: parseFloat(liveMatch[4]),
      low: parseFloat(liveMatch[5]),
      open: parseFloat(liveMatch[6]),
      percentChange: parseFloat(liveMatch[7]),
    };
  }

  // Extraer quotes del dehydrated state (React Query)
  // dolar.cl puede tener dos formatos de hydration:
  //   lastQuote|{\"source\":\"fintual\"}  (escaped)
  //   lastQuote","source":"fintual"}      (JSON)
  const sourceOrder: string[] = [];
  const sourcePattern = /lastQuote["|,]\S*?source[\\"]+"?:?\s*[\\"]+"?(\w+)/g;
  let sm: RegExpExecArray | null;
  while ((sm = sourcePattern.exec(html)) !== null) {
    if (!sourceOrder.includes(sm[1])) sourceOrder.push(sm[1]);
  }

  const dataBlocks: { buy: number; sell: number; time: number }[] = [];
  const dataPattern = /"buy":(\d+\.?\d*),"sell":(\d+\.?\d*),"time":(\d+)/g;
  let dm: RegExpExecArray | null;
  while ((dm = dataPattern.exec(html)) !== null) {
    dataBlocks.push({ buy: parseFloat(dm[1]), sell: parseFloat(dm[2]), time: parseInt(dm[3]) });
  }

  console.log(`dolar.cl: ${sourceOrder.length} sources, ${dataBlocks.length} data blocks, live: ${!!live}`);

  if (sourceOrder.length === 0 || dataBlocks.length === 0) {
    throw new Error('dolar.cl no devolvió datos de precios');
  }

  const sourceDataMap = new Map<string, { buy: number; sell: number; time: number }>();
  for (let i = 0; i < Math.min(sourceOrder.length, dataBlocks.length); i++) {
    sourceDataMap.set(sourceOrder[i], dataBlocks[i]);
  }

  const quotes = DOLLAR_SOURCES.map(source => {
    const data = sourceDataMap.get(source.id);
    if (data) {
      return {
        source,
        quote: {
          buy: data.buy,
          sell: data.sell,
          time: new Date(data.time).toISOString(),
          fee: null,
        } as DollarQuote,
      };
    }
    return { source, quote: null };
  });

  return { live, quotes };
}

// Fast path: Bun native fetch (8s timeout, usually fails from datacenter IPs)
export async function fetchDollarPrices(): Promise<DollarData> {
  const response = await fetch('https://dolar.cl/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseDollarHtml(await response.text());
}

// Slow path: IPRoyal proxy with JS rendering (background only)
export async function fetchDollarPricesViaProxy(): Promise<DollarData> {
  const html = await fetchBypass('https://dolar.cl/');
  return parseDollarHtml(html);
}

export function formatCLP(value: number): string {
  return '$' + value.toLocaleString('es-CL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  });
}

export function formatDollarRich(
  { live, quotes }: DollarData,
  filter: string | undefined,
  time: string,
): string | null {
  let header = '💵 <b>DÓLAR AHORA</b>';
  if (live) {
    const arrow = live.change >= 0 ? '📈' : '📉';
    const sign = live.change >= 0 ? '+' : '';
    const pct = (live.percentChange * 100).toFixed(2).replace('.', ',');
    header += `: ${formatCLP(live.close)}`;
    header += `\n${arrow} ${sign}${pct}% · Rango: ${formatCLP(live.low)} – ${formatCLP(live.high)}`;
  }

  let validQuotes = quotes.filter(({ quote }) => !!quote);

  if (filter) {
    const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const filterNorm = normalize(filter);
    validQuotes = validQuotes.filter(({ source }) =>
      normalize(source.id).includes(filterNorm) ||
      normalize(source.name).includes(filterNorm) ||
      source.aliases.some(a => normalize(a).includes(filterNorm) || filterNorm.includes(normalize(a)))
    );
    if (validQuotes.length === 0) return null;
  }

  validQuotes.sort((a, b) => (a.quote!.buy) - (b.quote!.buy));

  const lines = validQuotes.map(({ source, quote }) => {
    const buy = formatCLP(quote!.buy);
    const sell = quote!.sell != null ? formatCLP(quote!.sell) : '—';
    return `${source.name}: ${buy} · ${sell}`;
  });

  return [
    header, '',
    `🏦 Compra · Venta (${time} hrs)`,
    ...lines, '',
    'Fuente: <a href="https://dolar.cl">dolar.cl</a>',
  ].join('\n');
}

export function registerDolarCommand(bot: Bot): void {
  bot.command(['dolar', 'usd'], async (ctx) => {
    console.log('Comando dolar recibido');
    const filter = ctx.match?.trim().toLowerCase();
    const time = getChileTime();

    // Fast path: Bun native fetch (funciona local, falla desde datacenter)
    try {
      const data = await fetchDollarPrices();
      const msg = formatDollarRich(data, filter, time);
      if (!msg) {
        const available = DOLLAR_SOURCES.map(s => s.name).join(', ');
        await ctx.reply(
          `❌ No encontré "<b>${escapeHtmlMinimal(filter || '')}</b>"\n\n🏦 Fuentes disponibles: ${available}`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
      return;
    } catch (err) {
      console.error(JSON.stringify({
        event: 'dollar_error', chatId: ctx.chat.id,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    }

    // Fallback: responder con mindicador.cl inmediatamente
    let sentMessage: Awaited<ReturnType<typeof ctx.reply>> | null = null;
    try {
      const valor = await fetchDollarFallback();
      sentMessage = await ctx.reply([
        `💵 <b>DÓLAR OBSERVADO</b>: ${formatCLP(valor)}`,
        '',
        `<i>Valor oficial Banco Central (${time} hrs)</i>`,
        '<i>Detalle por banco no disponible</i>',
        '',
        'Fuente: <a href="https://mindicador.cl">mindicador.cl</a>',
      ].join('\n'), { parse_mode: 'HTML' });
    } catch (fallbackError) {
      console.error(JSON.stringify({
        event: 'dollar_fallback_error', chatId: ctx.chat.id,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        timestamp: new Date().toISOString(),
      }));
      await ctx.reply('❌ No pude obtener el precio del dólar.');
      return;
    }

    // Background: intentar dolar.cl vía proxy (JS rendering).
    // Si funciona, reemplaza el mensaje de mindicador con datos completos.
    const chatId = sentMessage.chat.id;
    const messageId = sentMessage.message_id;
    fetchDollarPricesViaProxy().then(async (data) => {
      const msg = formatDollarRich(data, filter, getChileTime());
      if (msg) {
        await ctx.api.editMessageText(chatId, messageId, msg, { parse_mode: 'HTML' });
      }
    }).catch((err) => {
      console.error(JSON.stringify({
        event: 'dollar_proxy_bg_failed', chatId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    });
  });
}

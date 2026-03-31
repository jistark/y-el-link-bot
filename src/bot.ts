import { Bot, InlineKeyboard, Context } from 'grammy';
import { extractArticle, detectSource } from './extractors/index.js';
import { createPage, deletePage, type CreatePageResult } from './formatters/telegraph.js';
import { getHoroscopo, getSignosList } from './commands/horoscopo.js';
import { fetchBypass } from './extractors/fetch-bypass.js';

// Tiempo de gracia para undo antes de procesar (en ms)
const UNDO_GRACE_PERIOD = 5000;
// Tiempo total que el autor puede borrar después de publicar (en ms)
const DELETE_GRACE_PERIOD = 15000;

// Cache de artículos procesados
const cache = new Map<string, { result: CreatePageResult; expires: number }>();
const TTL = 24 * 60 * 60 * 1000; // 24 horas

// Pendientes de procesar (para undo)
interface PendingRequest {
  originalUrl: string;
  originalMessageId: number;
  originalText: string;
  userId: number;
  username?: string;
  firstName: string;
  chatId: number;
  botMessageId: number;
  timeoutId: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

const pending = new Map<string, PendingRequest>();

// Limpieza periódica del cache (cada hora)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expires < now) cache.delete(key);
  }
}, 60 * 60 * 1000);

// Rate limiter por usuario (máx 5 artículos por minuto)
const RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 1000; // 1 minuto
const userRequests = new Map<number, number[]>();

function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const timestamps = userRequests.get(userId) || [];
  const recent = timestamps.filter(t => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) return true;
  recent.push(now);
  userRequests.set(userId, recent);
  return false;
}

// Limpiar rate limiter cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of userRequests) {
    const recent = timestamps.filter(t => now - t < RATE_WINDOW);
    if (recent.length === 0) userRequests.delete(userId);
    else userRequests.set(userId, recent);
  }
}, 5 * 60 * 1000);

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"\]]+/gi;
  return (text.match(urlRegex) || []).map(url => url.replace(/[.,;:!?)]+$/, ''));
}

// Extraer URL canónica de URLs AMP
function deAmpUrl(url: string): string {
  // cdn.ampproject.org: https://www-example-com.cdn.ampproject.org/c/s/www.example.com/path
  const ampMatch = url.match(/cdn\.ampproject\.org\/[^/]*\/s\/(.+)/);
  if (ampMatch) return `https://${ampMatch[1]}`;
  // Google AMP cache: https://www.google.com/amp/s/www.example.com/path
  const googleAmpMatch = url.match(/google\.com\/amp\/s\/(.+)/);
  if (googleAmpMatch) return `https://${googleAmpMatch[1]}`;
  return url;
}

function getUserMention(ctx: Context): string {
  const user = ctx.from;
  if (!user) return '';

  if (user.username) {
    return `@${user.username}`;
  }
  return `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name)}</a>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getTextWithoutUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"\]]+/gi, '').trim();
}

function createUndoKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⏪ Cancelar', 'undo');
}

function createActionKeyboard(telegraphPath: string, userId: number, originalUrl: string): InlineKeyboard {
  const archiveUrl = `https://archive.ph/?q=${encodeURIComponent(originalUrl)}`;
  const twitterUrl = `https://twitter.com/search?q=${encodeURIComponent(originalUrl)}`;

  // Embeber path, userId y timestamp en callback data (sobrevive reinicios del bot)
  // Formato: "del:path:userId:timestamp" - timestamp en base36 para ahorrar bytes
  const ts = Math.floor(Date.now() / 1000).toString(36);
  const deleteData = `del:${telegraphPath}:${userId}:${ts}`;

  // Telegram limita callback_data a 64 bytes - fallback sin timestamp si excede
  const callbackData = deleteData.length <= 64
    ? deleteData
    : `del:${telegraphPath}:${userId}:0`;

  return new InlineKeyboard()
    .text('🗑️ Borrar', callbackData)
    .url('📦 Archive', archiveUrl)
    .url('🐦 Twitter', twitterUrl);
}

// Canales de TV para rating Zapping
const ZAPPING_CHANNELS = [
  { id: 'tvno', name: 'TVN', emoji: '🔴' },
  { id: 'mega', name: 'Mega', emoji: '🟣' },
  { id: '13', name: 'Canal 13', emoji: '🟠' },
  { id: 'chv', name: 'CHV', emoji: '⚪' },
  { id: 'lared', name: 'La Red', emoji: '🟢' },
  { id: 'tvm', name: 'TV+', emoji: '🔵' },
];

async function fetchZappingRatings(): Promise<{ channel: typeof ZAPPING_CHANNELS[0]; rating: string }[]> {
  const results = await Promise.all(
    ZAPPING_CHANNELS.map(async (channel) => {
      try {
        const response = await fetch(`https://metrics.zappingtv.com/public/rating/${channel.id}`);
        const html = await response.text();
        // La API devuelve HTML tipo: <div id="channel_rating"> 10.8</div>
        // Extraemos solo el número
        const match = html.match(/>[\s]*([\d.]+)/);
        const rating = match ? match[1] : html.replace(/<[^>]*>/g, '').trim();
        return { channel, rating };
      } catch {
        return { channel, rating: '—' };
      }
    })
  );
  return results;
}

function getChileTime(): string {
  const now = new Date();
  const chileTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const hours = chileTime.getHours().toString().padStart(2, '0');
  const minutes = chileTime.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Fuentes de precio del dólar (match con sources en dolar.cl)
const DOLLAR_SOURCES = [
  { id: 'btg', name: 'BTG Pactual', aliases: ['btg pactual'] },
  { id: 'fintual', name: 'Fintual', aliases: [] },
  { id: 'bci', name: 'BCI', aliases: [] },
  { id: 'falabella', name: 'Banco Falabella', aliases: ['cmr', 'falabella'] },
  { id: 'bancochile', name: 'Banco de Chile', aliases: ['bancochile', 'banco chile', 'bch'] },
  { id: 'itau', name: 'Itaú', aliases: ['itau'] },
  { id: 'estado', name: 'BancoEstado', aliases: ['banco estado', 'bech'] },
  { id: 'santander', name: 'Santander', aliases: [] },
] as const;

// Fallback: API mindicador.cl (dólar observado oficial del Banco Central)
interface MindicadorResponse {
  serie: { fecha: string; valor: number }[];
}

async function fetchDollarFallback(): Promise<number> {
  const response = await fetch('https://mindicador.cl/api/dolar', {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`mindicador.cl respondió ${response.status}`);
  const data = (await response.json()) as MindicadorResponse;
  if (!data.serie?.length) throw new Error('Sin datos en mindicador.cl');
  return data.serie[0].valor;
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 horas

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

async function fetchDollarPrices(): Promise<{
  live: LiveQuote | null;
  quotes: { source: typeof DOLLAR_SOURCES[number]; quote: DollarQuote | null }[];
}> {
  // Fetch HTML de dolar.cl - los precios están embebidos como React Query dehydrated state
  let html: string;
  try {
    const response = await fetch('https://dolar.cl/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch {
    // Fallback: curl_cffi bypasses Vercel bot detection
    html = await fetchBypass('https://dolar.cl/');
  }

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
  // Los sources y data blocks aparecen en el mismo orden en el HTML
  const sourceOrder: string[] = [];
  const sourcePattern = /lastQuote\|?\{\\"source\\":\\"(\w+)\\"\}/g;
  let sm: RegExpExecArray | null;
  while ((sm = sourcePattern.exec(html)) !== null) {
    sourceOrder.push(sm[1]);
  }

  const dataBlocks: { buy: number; sell: number; time: number }[] = [];
  const dataPattern = /"buy":(\d+\.?\d*),"sell":(\d+\.?\d*),"time":(\d+)/g;
  let dm: RegExpExecArray | null;
  while ((dm = dataPattern.exec(html)) !== null) {
    dataBlocks.push({ buy: parseFloat(dm[1]), sell: parseFloat(dm[2]), time: parseInt(dm[3]) });
  }

  // Mapear sources a data por posición
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

function formatCLP(value: number): string {
  return '$' + value.toLocaleString('es-CL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  });
}

// Podscope API: ranking de streams chilenos en YouTube
interface PodscopeRanking {
  rank: number;
  channelName: string;
  videoTitle: string;
  viewers: number;
  peakViewers: number;
  videoId: string;
}

interface PodscopeResponse {
  rankings: PodscopeRanking[];
  updatedAt: string;
  totalCount: number;
  totalViewers: number;
}

async function fetchYouTubeRankings(): Promise<PodscopeResponse> {
  const response = await fetch('https://api.podscope.co/api/live/rankings');
  if (!response.ok) throw new Error(`Podscope API error: ${response.status}`);
  return response.json() as Promise<PodscopeResponse>;
}

function formatViewers(n: number): string {
  return n.toLocaleString('es-CL');
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  // Comando /rating_youtube (también responde a /ryt como alias corto)
  bot.command(['rating_youtube', 'ryt'], async (ctx) => {
    console.log('Comando rating_youtube recibido');

    try {
      const data = await fetchYouTubeRankings();
      const time = getChileTime();

      const lines = data.rankings.map(({ rank, channelName, videoTitle, viewers, peakViewers }) => {
        const medal = rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `${rank}.`;
        // Truncar título del video si es muy largo
        const title = videoTitle.length > 50 ? videoTitle.slice(0, 47) + '...' : videoTitle;
        return `${medal} <b>${channelName}</b>: ${formatViewers(viewers)} 👀\n    <i>${title}</i>` +
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

  // Comando /rating_zapping (también responde a /rz como alias corto)
  bot.command(['rating_zapping', 'rz'], async (ctx) => {
    console.log('Comando rating_zapping recibido');

    const ratings = await fetchZappingRatings();
    const time = getChileTime();

    // Ordenar por rating (mayor a menor)
    const sorted = ratings.sort((a, b) => {
      const rA = parseFloat(a.rating) || 0;
      const rB = parseFloat(b.rating) || 0;
      return rB - rA;
    });

    const lines = sorted.map(({ channel, rating }) =>
      `${channel.emoji} ${channel.name}: <b>${rating}</b>`
    );

    const message = `📺 <b>Rating Zapping</b> (${time} hrs)\n\n${lines.join('\n')}\n\n<i>Fuente: zapping.com</i>`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  });

  // Comando /dolar (también responde a /usd)
  // Sin argumento: muestra todas las fuentes
  // Con argumento: filtra por nombre de fuente (ej: /dolar bancoestado)
  bot.command(['dolar', 'usd'], async (ctx) => {
    console.log('Comando dolar recibido');

    try {
      const { live, quotes } = await fetchDollarPrices();
      const time = getChileTime();
      const filter = ctx.match?.trim().toLowerCase();

      // Línea principal: DÓLAR AHORA
      let header = '💵 <b>DÓLAR AHORA</b>';
      if (live) {
        const arrow = live.change >= 0 ? '📈' : '📉';
        const sign = live.change >= 0 ? '+' : '';
        const pct = (live.percentChange * 100).toFixed(2).replace('.', ',');
        header += `: ${formatCLP(live.close)}`;
        header += `\n${arrow} ${sign}${pct}% · Rango: ${formatCLP(live.low)} – ${formatCLP(live.high)}`;
      }

      // Filtrar por fuente si se especificó
      let validQuotes = quotes.filter(({ quote }) => !!quote);

      if (filter) {
        const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const filterNorm = normalize(filter);
        const filtered = validQuotes.filter(({ source }) =>
          normalize(source.id).includes(filterNorm) ||
          normalize(source.name).includes(filterNorm) ||
          source.aliases.some(a => normalize(a).includes(filterNorm) || filterNorm.includes(normalize(a)))
        );

        if (filtered.length === 0) {
          const available = DOLLAR_SOURCES.map(s => s.name).join(', ');
          await ctx.reply(
            `❌ No encontré "<b>${filter}</b>"\n\n🏦 Fuentes disponibles: ${available}`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        validQuotes = filtered;
      }

      validQuotes.sort((a, b) => (a.quote!.buy) - (b.quote!.buy));

      const lines = validQuotes.map(({ source, quote }) => {
        const buy = formatCLP(quote!.buy);
        const sell = quote!.sell != null ? formatCLP(quote!.sell) : '—';
        return `${source.name}: ${buy} · ${sell}`;
      });

      const message = [
        header,
        '',
        `🏦 Compra · Venta (${time} hrs)`,
        ...lines,
        '',
        'Fuente: <a href="https://dolar.cl">dolar.cl</a>',
      ].join('\n');

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (primaryError) {
      console.error(JSON.stringify({
        event: 'dollar_error',
        chatId: ctx.chat.id,
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        timestamp: new Date().toISOString(),
      }));

      // Fallback: dólar observado desde mindicador.cl
      try {
        const valor = await fetchDollarFallback();
        const time = getChileTime();
        const message = [
          `💵 <b>DÓLAR OBSERVADO</b>: ${formatCLP(valor)}`,
          '',
          `<i>Valor oficial Banco Central (${time} hrs)</i>`,
          '<i>Detalle por banco no disponible</i>',
          '',
          'Fuente: <a href="https://mindicador.cl">mindicador.cl</a>',
        ].join('\n');
        await ctx.reply(message, { parse_mode: 'HTML' });
      } catch (fallbackError) {
        console.error(JSON.stringify({
          event: 'dollar_fallback_error',
          chatId: ctx.chat.id,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          timestamp: new Date().toISOString(),
        }));
        await ctx.reply('❌ No pude obtener el precio del dólar.');
      }
    }
  });

  // Comando /donar (también responde a /donate)
  bot.command(['donar', 'donate'], async (ctx) => {
    const keyboard = new InlineKeyboard()
      .url('🌭 Donar', 'https://donate.stripe.com/eVq8wQ4XtbW5clbep0cfK01');

    await ctx.reply(
      '🌭 Gracias por apoyar a la DVJ. Apóyanos con un tocomple.',
      { reply_markup: keyboard }
    );
  });

  // Comando /tiayoli - Horóscopo de Yolanda Sultana
  bot.command(['tiayoli', 'horoscopo'], async (ctx) => {
    const signo = ctx.match?.trim();
    if (!signo) {
      await ctx.reply(
        `🔮 <b>Horóscopo de Yolanda Sultana</b>\n\nUsa: /tiayoli &lt;signo&gt;\n\n${getSignosList()}`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    try {
      const result = await getHoroscopo(signo);
      await ctx.reply(result, { parse_mode: 'HTML' });
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

  // Handler para mensajes con URLs
  bot.on('message:text', async (ctx) => {
    const rawUrls = extractUrls(ctx.message.text);

    for (const rawUrl of rawUrls) {
      const url = deAmpUrl(rawUrl);
      const source = detectSource(url);
      if (!source) continue;

      // Rate limiting por usuario (skip si no hay userId)
      if (ctx.from?.id && isRateLimited(ctx.from.id)) continue;

      const pendingId = `${ctx.chat.id}:${ctx.message.message_id}:${url}`;

      // Revisar cache
      const cached = cache.get(url);
      if (cached && cached.expires > Date.now()) {
        await processAndReply(ctx, url, cached.result);
        continue;
      }

      // Enviar mensaje de "procesando" con botón de undo (reply al mensaje original)
      const botMessage = await ctx.reply('⏳ Procesando artículo...', {
        reply_markup: createUndoKeyboard(),
        reply_parameters: { message_id: ctx.message.message_id },
      });

      // Configurar timeout para procesar después del período de gracia
      const timeoutId = setTimeout(async () => {
        const req = pending.get(pendingId);
        if (!req || req.cancelled) {
          pending.delete(pendingId);
          return;
        }

        try {
          // Extraer y crear página
          const article = await extractArticle(url);
          const result = await createPage(article);

          // Guardar en cache
          cache.set(url, { result, expires: Date.now() + TTL });

          // Procesar el mensaje
          await processAndReply(ctx, url, result, req);

        } catch (error) {
          console.error(JSON.stringify({
            event: 'extraction_error',
            url,
            source: detectSource(url),
            chatId: ctx.chat.id,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }));
          try {
            await ctx.api.editMessageText(
              ctx.chat.id,
              botMessage.message_id,
              '❌ No pude acceder al artículo.'
            );
          } catch {
            // Mensaje ya borrado o inaccesible
          }
        }

        pending.delete(pendingId);
      }, UNDO_GRACE_PERIOD);

      // Guardar en pendientes
      pending.set(pendingId, {
        originalUrl: url,
        originalMessageId: ctx.message.message_id,
        originalText: ctx.message.text,
        userId: ctx.from?.id || 0,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name || 'Usuario',
        chatId: ctx.chat.id,
        botMessageId: botMessage.message_id,
        timeoutId,
        cancelled: false,
      });
    }
  });

  // Handler para callbacks (botones)
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Undo (autor o admin pueden cancelar)
    if (data === 'undo') {
      for (const [id, req] of pending.entries()) {
        if (req.botMessageId === ctx.callbackQuery.message?.message_id) {
          const isOwner = req.userId === ctx.from?.id;
          let isAdmin = false;

          if (!isOwner && ctx.chat && ctx.from?.id) {
            try {
              const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
              isAdmin = ['creator', 'administrator'].includes(member.status);
            } catch {}
          }

          if (!isOwner && !isAdmin) {
            await ctx.answerCallbackQuery({ text: 'Solo el autor o admins pueden cancelar' });
            return;
          }

          req.cancelled = true;
          clearTimeout(req.timeoutId);
          pending.delete(id);

          try {
            await ctx.deleteMessage();
          } catch {
            await ctx.editMessageText('↩️ Cancelado');
          }

          await ctx.answerCallbackQuery({ text: 'Cancelado' });
          return;
        }
      }
      await ctx.answerCallbackQuery({ text: 'Ya no se puede cancelar' });
      return;
    }

    // Delete - formato: "del:telegraphPath:ownerId:timestamp(base36)"
    if (data.startsWith('del:')) {
      const parts = data.slice(4).split(':');
      // Último = timestamp, penúltimo = userId, resto = path
      const createdAtB36 = parts.pop()!;
      const ownerIdStr = parts.pop()!;
      const telegraphPath = parts.join(':');
      const ownerId = parseInt(ownerIdStr, 10);
      const createdAt = parseInt(createdAtB36, 36) * 1000;
      const userId = ctx.from?.id;

      // Admins y mods pueden borrar siempre
      let isAdmin = false;
      if (ctx.chat && userId) {
        try {
          const member = await ctx.api.getChatMember(ctx.chat.id, userId);
          isAdmin = ['creator', 'administrator'].includes(member.status);
        } catch {}
      }

      const isOwner = userId === ownerId;
      const withinGrace = Date.now() - createdAt < DELETE_GRACE_PERIOD;

      if (!isAdmin && !isOwner) {
        await ctx.answerCallbackQuery({
          text: 'Solo el autor o admins pueden borrar',
          show_alert: true,
        });
        return;
      }

      if (isOwner && !isAdmin && !withinGrace) {
        await ctx.answerCallbackQuery({
          text: 'El tiempo para borrar ha expirado',
          show_alert: true,
        });
        return;
      }

      // "Borrar" la página Telegraph (vaciarla)
      await deletePage(telegraphPath);

      try {
        await ctx.deleteMessage();
      } catch {
        await ctx.editMessageText('🗑️ Eliminado');
      }

      await ctx.answerCallbackQuery({ text: 'Eliminado' });
      return;
    }

    // Retrocompatibilidad: botones viejos con formato "delete:path:userId"
    if (data.startsWith('delete:')) {
      const parts = data.slice(7).split(':');
      const ownerId = parseInt(parts.pop()!, 10);
      const telegraphPath = parts.join(':');
      const userId = ctx.from?.id;

      let canDelete = userId === ownerId;
      if (!canDelete && ctx.chat && userId) {
        try {
          const member = await ctx.api.getChatMember(ctx.chat.id, userId);
          canDelete = ['creator', 'administrator'].includes(member.status);
        } catch {}
      }

      if (!canDelete) {
        await ctx.answerCallbackQuery({ text: 'Solo el autor o admins pueden borrar', show_alert: true });
        return;
      }

      await deletePage(telegraphPath);
      try { await ctx.deleteMessage(); } catch { await ctx.editMessageText('🗑️ Eliminado'); }
      await ctx.answerCallbackQuery({ text: 'Eliminado' });
      return;
    }

    await ctx.answerCallbackQuery();
  });

  return bot;
}

async function processAndReply(
  ctx: Context,
  originalUrl: string,
  result: CreatePageResult,
  req?: PendingRequest
): Promise<void> {
  const userId = req?.userId || ctx.from?.id || 0;
  const keyboard = createActionKeyboard(result.path, userId, originalUrl);

  // Construir mensaje
  let messageText = result.url;

  if (req) {
    const mention = req.username ? `@${req.username}` :
      `<a href="tg://user?id=${req.userId}">${escapeHtml(req.firstName)}</a>`;

    const extraText = getTextWithoutUrls(req.originalText);

    if (extraText) {
      messageText = `${mention}: ${escapeHtml(extraText)}\n\n${result.url}`;
    } else {
      messageText = `${mention} compartió:\n${result.url}`;
    }

    // Intentar borrar el mensaje original
    try {
      await ctx.api.deleteMessage(req.chatId, req.originalMessageId);
    } catch {
      // No tenemos permisos para borrar - no pasa nada
    }

    // Editar el mensaje del bot
    try {
      await ctx.api.editMessageText(req.chatId, req.botMessageId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
    } catch {
      // Si falla editar, enviar nuevo mensaje
      await ctx.api.sendMessage(req.chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }
  } else {
    // Sin pending request (cache hit)
    await ctx.reply(messageText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
    });
  }
}

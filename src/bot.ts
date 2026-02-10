import { Bot, InlineKeyboard, Context } from 'grammy';
import { extractArticle, detectSource } from './extractors/index.js';
import { createPage, deletePage, type CreatePageResult } from './formatters/telegraph.js';

// Tiempo de gracia para undo (en ms)
const UNDO_GRACE_PERIOD = 5000;

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

// Páginas creadas (para poder borrarlas)
interface CreatedPage {
  path: string;
  url: string;
  originalUrl: string;
  botMessageId: number;
  chatId: number;
  userId: number; // Usuario que publicó el artículo
}

const createdPages = new Map<string, CreatedPage>();

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"\]]+/gi;
  return text.match(urlRegex) || [];
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

function createActionKeyboard(pageId: string, originalUrl: string): InlineKeyboard {
  const archiveUrl = `https://archive.ph/?q=${encodeURIComponent(originalUrl)}`;
  const twitterUrl = `https://twitter.com/search?q=${encodeURIComponent(originalUrl)}`;

  return new InlineKeyboard()
    .text('🗑️ Borrar', `delete:${pageId}`)
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

// Fuentes de precio del dólar
const DOLLAR_SOURCES = [
  { id: 'fintual', name: 'Fintual' },
  { id: 'bci', name: 'BCI' },
  { id: 'mach', name: 'MACH' },
  { id: 'falabella', name: 'Falabella' },
  { id: 'bancochile', name: 'Banco de Chile' },
  { id: 'estado', name: 'BancoEstado' },
  { id: 'itau', name: 'Itaú' },
  { id: 'santander', name: 'Santander' },
  { id: 'global66', name: 'Global66' },
] as const;

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
  // Construir batch tRPC request: index 0 = liveQuote, 1+ = lastQuote por fuente
  const input: Record<string, { json: Record<string, unknown> }> = {
    '0': { json: { range: '1d' } },
  };
  DOLLAR_SOURCES.forEach((s, i) => {
    input[String(i + 1)] = { json: { source: s.id } };
  });

  const procedures = [
    'dolar.liveQuote',
    ...DOLLAR_SOURCES.map(() => 'dolar.lastQuote'),
  ].join(',');

  const url = `https://dolar.cl/api/trpc/${procedures}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`dolar.cl respondió ${response.status}`);
  }

  const data = await response.json() as { result?: { data?: { json?: unknown } } }[];

  const live = (data[0]?.result?.data?.json as LiveQuote) || null;

  const quotes = DOLLAR_SOURCES.map((source, i) => {
    const quote = (data[i + 1]?.result?.data?.json as DollarQuote) || null;
    return { source, quote };
  });

  return { live, quotes };
}

function formatCLP(value: number): string {
  return '$' + value.toLocaleString('es-CL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  });
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

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
  bot.command(['dolar', 'usd'], async (ctx) => {
    console.log('Comando dolar recibido');

    try {
      const { live, quotes } = await fetchDollarPrices();
      const time = getChileTime();
      const now = Date.now();

      // Línea principal con precio actual
      let header = '💵 <b>Precio del Dólar</b>';
      if (live) {
        const arrow = live.change >= 0 ? '📈' : '📉';
        const sign = live.change >= 0 ? '+' : '';
        const pct = (live.percentChange * 100).toFixed(2).replace('.', ',');
        header += ` (${formatCLP(live.close)})`;
        header += `\n${arrow} ${sign}${pct}% · Rango: ${formatCLP(live.low)} – ${formatCLP(live.high)}`;
      }

      // Líneas por fuente, ordenadas por menor precio de compra
      const validQuotes = quotes
        .filter(({ source, quote }) => {
          if (!quote) return false;
          // Excluir Santander si está stale
          if (source.id === 'santander') {
            const quoteAge = now - new Date(quote.time).getTime();
            return quoteAge < STALE_THRESHOLD_MS;
          }
          return true;
        })
        .sort((a, b) => (a.quote!.buy) - (b.quote!.buy));

      const lines = validQuotes.map(({ source, quote }) => {
        const buy = formatCLP(quote!.buy);
        const sell = quote!.sell != null ? formatCLP(quote!.sell) : '—';
        return `<b>${source.name}</b>: ${buy} · ${sell}`;
      });

      const message = [
        header,
        '',
        `🏦 <b>Compra · Venta</b> (${time} hrs)`,
        ...lines,
        '',
        '<i>Fuente: dolar.cl</i>',
      ].join('\n');

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Error obteniendo precio del dólar:', error);
      await ctx.reply('❌ No pude obtener el precio del dólar.');
    }
  });

  // Handler para mensajes con URLs
  bot.on('message:text', async (ctx) => {
    const urls = extractUrls(ctx.message.text);

    for (const url of urls) {
      const source = detectSource(url);
      if (!source) continue;

      const pendingId = `${ctx.chat.id}:${ctx.message.message_id}:${url}`;

      // Revisar cache
      const cached = cache.get(url);
      if (cached && cached.expires > Date.now()) {
        await processAndReply(ctx, url, cached.result);
        continue;
      }

      // Enviar mensaje de "procesando" con botón de undo
      const botMessage = await ctx.reply('⏳ Procesando artículo...', {
        reply_markup: createUndoKeyboard(),
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
          console.error(`Error procesando ${url}:`, error);
          await ctx.api.editMessageText(
            ctx.chat.id,
            botMessage.message_id,
            '❌ No pude acceder al artículo.'
          );
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

    // Undo
    if (data === 'undo') {
      // Buscar el pending request asociado
      for (const [id, req] of pending.entries()) {
        if (req.botMessageId === ctx.callbackQuery.message?.message_id) {
          req.cancelled = true;
          clearTimeout(req.timeoutId);
          pending.delete(id);

          // Borrar el mensaje del bot
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

    // Delete
    if (data.startsWith('delete:')) {
      const pageId = data.slice(7);
      const page = createdPages.get(pageId);

      if (page) {
        const userId = ctx.from?.id;

        // Verificar que quien borra es quien publicó o es admin/mod
        let canDelete = userId === page.userId;

        if (!canDelete && ctx.chat && userId) {
          try {
            const member = await ctx.api.getChatMember(ctx.chat.id, userId);
            canDelete = ['creator', 'administrator'].includes(member.status);
          } catch {
            // Si falla obtener el estado, solo permitir al autor
          }
        }

        if (!canDelete) {
          await ctx.answerCallbackQuery({
            text: 'Solo el autor o admins pueden borrar',
            show_alert: true
          });
          return;
        }

        // "Borrar" la página Telegraph (vaciarla)
        await deletePage(page.path);

        // Borrar el mensaje del bot
        try {
          await ctx.deleteMessage();
        } catch {
          await ctx.editMessageText('🗑️ Eliminado');
        }

        createdPages.delete(pageId);
        await ctx.answerCallbackQuery({ text: 'Eliminado' });
      } else {
        await ctx.answerCallbackQuery({ text: 'No se encontró la página' });
      }
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
  const pageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Guardar referencia a la página creada
  createdPages.set(pageId, {
    path: result.path,
    url: result.url,
    originalUrl,
    botMessageId: req?.botMessageId || 0,
    chatId: ctx.chat?.id || 0,
    userId: req?.userId || ctx.from?.id || 0,
  });

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
    } catch (error) {
      // No tenemos permisos para borrar - no pasa nada
      console.log('No se pudo borrar mensaje original (permisos)');
    }

    // Editar el mensaje del bot
    try {
      await ctx.api.editMessageText(req.chatId, req.botMessageId, messageText, {
        parse_mode: 'HTML',
        reply_markup: createActionKeyboard(pageId, originalUrl),
        link_preview_options: { is_disabled: false },
      });
    } catch {
      // Si falla editar, enviar nuevo mensaje
      await ctx.api.sendMessage(req.chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: createActionKeyboard(pageId, originalUrl),
      });
    }
  } else {
    // Sin pending request (cache hit)
    await ctx.reply(messageText, {
      parse_mode: 'HTML',
      reply_markup: createActionKeyboard(pageId, originalUrl),
    });
  }
}

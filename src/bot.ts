import { Bot, InlineKeyboard, InputMediaBuilder, Context, InputFile } from 'grammy';
import { extractArticle, detectSource } from './extractors/index.js';
import { hasRecipe } from './extractors/recipes.js';
import { scheduleDelete } from './utils/shared.js';

// Domains that should never be extracted (social media, video, non-article)
const SKIP_DOMAINS = new Set([
  'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'instagram.com',
  'facebook.com', 'fb.com', 'tiktok.com', 'reddit.com', 'linkedin.com',
  'pinterest.com', 'tumblr.com', 'twitch.tv', 'discord.com', 'discord.gg',
  'spotify.com', 'apple.com', 'music.apple.com', 'soundcloud.com',
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com',
  'docs.google.com', 'drive.google.com', 'maps.google.com',
  'amazon.com', 'mercadolibre.cl', 'ebay.com', 'aliexpress.com',
  'wikipedia.org', 'wikimedia.org',
  't.me', 'telegram.org', 'wa.me', 'whatsapp.com',
  'wetransfer.com', 'we.tl', 'mega.nz', 'dropbox.com',
  // Link expander bots (fxtwitter, fixupx, vxtwitter, etc.)
  'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com',
  'ddinstagram.com', 'rxddit.com', 'vxreddit.com',
]);

// Bots that expand X/Twitter links into card previews. We selectively
// process their messages: pull fxtwitter/fixupx URLs out of the body,
// fetch them, and look for embedded article URLs to extract. Match by
// username (lowercase, no @).
const LINK_EXPANDER_BOTS = new Set([
  'twitterlinkexpanderbot',
]);

// Domains without a bypass-paywalls recipe that we've still seen succeed
// via the generic extractor. Reviewed via `would_reject` logs — add here
// only after confirming the generic extractor produces useful output.
const EXTRA_ALLOWED = new Set([
  'blog.google',
  'concierto.cl',
  'emol.com',
]);

// URLs outside the allowlist (custom extractor, bypass-paywalls recipe,
// or EXTRA_ALLOWED) are silently dropped. Only curated sources get extracted.

function isPrivateOrReservedHost(hostname: string): boolean {
  // Strip optional surrounding brackets (some parsers keep them on IPv6)
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Loopback (IPv4 + IPv6)
  if (h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0' || h === '::1') return true;
  // Private ranges (RFC 1918) + link-local / cloud metadata (IPv4)
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h)) return true;
  // IPv6-mapped IPv4 (::ffff:169.254.169.254 cloud metadata bypass)
  if (/^::ffff:(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.0\.0\.0)/.test(h)) return true;
  // IPv6 ULA (fd00::/8) and link-local (fe80::/10)
  if (/^(fd[0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(h)) return true;
  return false;
}

// Decides whether a URL belongs to the curated allowlist:
// custom extractor, bypass-paywalls recipe, or EXTRA_ALLOWED.
// Called from isExtractableUrl; also useful in tests.
function isOnAllowlist(url: string): { allowed: boolean; reason: string } {
  if (detectSource(url)) return { allowed: true, reason: 'custom_extractor' };
  if (hasRecipe(url)) return { allowed: true, reason: 'bypass_recipe' };
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (EXTRA_ALLOWED.has(host)) return { allowed: true, reason: 'extra_allowed' };
    for (const d of EXTRA_ALLOWED) {
      if (host.endsWith('.' + d)) return { allowed: true, reason: 'extra_allowed' };
    }
  } catch { /* fall through */ }
  return { allowed: false, reason: 'not_in_allowlist' };
}

function isExtractableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // Block private/reserved IPs (SSRF protection)
    if (isPrivateOrReservedHost(u.hostname)) return false;
    // Block known non-article domains
    if (SKIP_DOMAINS.has(host)) return false;
    for (const skip of SKIP_DOMAINS) {
      if (host.endsWith('.' + skip)) return false;
    }
    // Must have a path beyond "/" (skip homepages)
    if (u.pathname === '/' || u.pathname === '') return false;

    const { allowed } = isOnAllowlist(url);
    if (!allowed) return false;
    return true;
  } catch {
    return false;
  }
}
import {
  isPageUrl,
  fetchPageArticles,
  extractByArticleId,
  extractStoryGroup,
  groupPageArticles,
  sanitizeAndStripMercurio,
  type PageArticleInfo,
  type StoryGroup,
} from './extractors/elmercurio.js';
import { createPage, deletePage, type CreatePageResult } from './formatters/telegraph.js';
import { getHoroscopo, getSignosList } from './commands/horoscopo.js';
import {
  getChileDate, getChileTimeNow, getMatchesForDate, getMatchesForWeek,
  getMatchesForTeam, getMatchesAtTime, getCountdown, getAllTeams,
  formatMatchesForDate, formatMatchesForWeek, formatMatchesForTeam, formatNotification,
} from './commands/mundial.js';
import { fetchBypass } from './extractors/fetch-bypass.js';
import {
  startRssPoller, fetchLatestSenal, fetchSenalFeed,
  parseSenalItems, extractMediaLinks, getPhotos, formatCaption,
} from './services/rss-poller.js';
import {
  startAdprensaPoller, fetchLatestPauta, fetchAdprensaFeed,
  parseAdprensaItems, preprocessPautaContent, isContactList,
} from './services/adprensa-poller.js';
import {
  startFotoportadasPoller, fetchLatestFotoportadas, fetchFotoportadasFeed,
  parseFotoportadasItems, extractFotoportadaImages, downloadPhotos,
} from './services/fotoportadas-poller.js';
import { createRssRegenKeyboard } from './services/rss-shared.js';
import { addRegistryEntry, findByGuidPrefix, updateRegistryEntry } from './services/registry.js';
import { readFile, writeFile } from 'fs/promises';

// Safe wrapper: reintenta sin message_thread_id si Telegram rechaza el thread
async function safeSendMessage(
  api: Bot['api'],
  chatId: number,
  text: string,
  options?: Record<string, any>
) {
  try {
    return await api.sendMessage(chatId, text, options);
  } catch (err: any) {
    if (err?.description?.includes('message thread not found') && options?.message_thread_id) {
      const { message_thread_id, ...rest } = options;
      console.log(JSON.stringify({
        event: 'thread_fallback', action: 'sendMessage',
        threadId: message_thread_id, chatId,
        timestamp: new Date().toISOString(),
      }));
      return await api.sendMessage(chatId, text, rest);
    }
    throw err;
  }
}

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
  replyToMessageId?: number; // Si el mensaje original era un reply, preservar la relación
  threadId?: number; // Topic/foro de Telegram
  replyTargetThreadId?: number; // Thread del mensaje al que se respondió (para detectar mismatch)
  replyTargetIsBot?: boolean; // El target del reply es un bot (ej. Link Expander) — fuerza drop de reply_to
}

const pending = new Map<string, PendingRequest>();

// Pendientes de selección de artículo en página (El Mercurio papel digital)
interface PendingPageSelection {
  groups: StoryGroup[];
  standalone: PageArticleInfo[];
  date: string;
  pageId: string;
  originalUrl: string;
  userId: number;
  username?: string;
  firstName: string;
  chatId: number;
  botMessageId: number;
  originalMessageId: number;
  originalText: string;
  replyToMessageId?: number;
  threadId?: number;
  replyTargetThreadId?: number;
  replyTargetIsBot?: boolean;
}

const pendingPages = new Map<number, PendingPageSelection & { createdAt: number }>();

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// Mapa de Telegraph path → URL original (para regenerar artículos)
const pathToUrl = new Map<string, string>();

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
  // Limpiar selecciones de página expiradas (10 min TTL)
  for (const [key, sel] of pendingPages) {
    if (now - sel.createdAt > 10 * 60 * 1000) pendingPages.delete(key);
  }
  // Limpiar pathToUrl: eliminar entries cuyo path no esté en cache
  if (pathToUrl.size > 500) {
    const activePaths = new Set<string>();
    for (const entry of cache.values()) activePaths.add(entry.result.path);
    for (const path of pathToUrl.keys()) {
      if (!activePaths.has(path)) pathToUrl.delete(path);
    }
  }
  // Limpiar mundialNotified: eliminar entries con fecha pasada
  const todayStr = new Date(now).toISOString().slice(0, 10);
  for (const key of mundialNotified) {
    const dateStr = key.slice(0, 10); // key format: YYYY-MM-DD-HH:mm
    if (dateStr < todayStr) mundialNotified.delete(key);
  }
}, 5 * 60 * 1000);

// --- Mundial 2026: config de notificaciones ---
import { join } from 'path';
import { mkdirSync } from 'fs';

const MUNDIAL_CONFIG_DIR = join(process.cwd(), 'data');
const MUNDIAL_CONFIG_PATH = join(MUNDIAL_CONFIG_DIR, 'mundial-config.json');
let mundialConfig: { chatId: number; topicId: number } | null = null;

async function loadMundialConfig() {
  try {
    const data = await readFile(MUNDIAL_CONFIG_PATH, 'utf-8');
    mundialConfig = JSON.parse(data);
  } catch { mundialConfig = null; }
}
loadMundialConfig();

async function saveMundialConfig(chatId: number, topicId: number) {
  mundialConfig = { chatId, topicId };
  try { mkdirSync(MUNDIAL_CONFIG_DIR, { recursive: true }); } catch { /* ok */ }
  await writeFile(MUNDIAL_CONFIG_PATH, JSON.stringify(mundialConfig), 'utf-8');
}

// Partidos ya notificados (evita duplicados en memoria)
const mundialNotified = new Set<string>();

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"\]]+/gi;
  return (text.match(urlRegex) || []).map(url => url.replace(/[.,;:!?)]+$/, ''));
}

// Extraer URL canónica de URLs AMP
function deAmpUrl(url: string): string {
  // cdn.ampproject.org: https://www-example-com.cdn.ampproject.org/c/s/www.example.com/path
  const ampMatch = url.match(/cdn\.ampproject\.org\/[^/]*\/s\/(.+)/);
  if (ampMatch) {
    const deamped = `https://${ampMatch[1]}`;
    try { if (isPrivateOrReservedHost(new URL(deamped).hostname)) return url; } catch { return url; }
    return deamped;
  }
  // Google AMP cache: https://www.google.com/amp/s/www.example.com/path
  const googleAmpMatch = url.match(/google\.com\/amp\/s\/(.+)/);
  if (googleAmpMatch) {
    const deamped = `https://${googleAmpMatch[1]}`;
    try { if (isPrivateOrReservedHost(new URL(deamped).hostname)) return url; } catch { return url; }
    return deamped;
  }
  return url;
}

// --- Link Expander helpers ---------------------------------------------------

// Hosts inside FxTwitter responses that don't lead to article URLs.
const FXTWITTER_NOISE_HOSTS = new Set([
  'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com',
  'twitter.com', 'x.com', 'mobile.twitter.com',
  'twimg.com', 'pbs.twimg.com', 'video.twimg.com',
  't.co', // FxTwitter usually expands these in the response
]);

function isFxTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /^(?:[\w-]+\.)?(?:fxtwitter|fixupx|vxtwitter|fixvx)\.com$/.test(host);
  } catch { return false; }
}

// Fetch an FxTwitter (or sibling) URL and pull out the embedded article
// URLs that the source tweet was pointing to. Filters Twitter/CDN noise.
async function extractUrlsFromFxTwitter(fxUrl: string): Promise<string[]> {
  let html: string;
  try {
    html = await fetchBypass(fxUrl);
  } catch (err) {
    console.error(JSON.stringify({
      event: 'fxtwitter_fetch_error',
      url: fxUrl,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of extractUrls(html)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
      if (FXTWITTER_NOISE_HOSTS.has(host)) continue;
      let noise = false;
      for (const n of FXTWITTER_NOISE_HOSTS) {
        if (host.endsWith('.' + n)) { noise = true; break; }
      }
      if (noise) continue;
      out.push(raw);
    } catch { /* skip malformed */ }
  }
  return out;
}

// Handle messages from Link Expander-style bots: scan for fxtwitter URLs,
// resolve their embedded article URLs, and post a Telegraph reply per
// match. Does NOT delete the bot's original message.
async function handleLinkExpanderMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || !ctx.chat) return;

  const fxUrls = extractUrls(text).filter(isFxTwitterUrl);
  if (fxUrls.length === 0) return;

  for (const fxUrl of fxUrls) {
    const embedded = await extractUrlsFromFxTwitter(fxUrl);

    let articleUrl: string | null = null;
    for (const candidate of embedded) {
      const cleaned = deAmpUrl(candidate);
      if (detectSource(cleaned) || isExtractableUrl(cleaned)) {
        articleUrl = cleaned;
        break;
      }
    }
    if (!articleUrl) continue;

    let result: CreatePageResult;
    const cached = cache.get(articleUrl);
    if (cached && cached.expires > Date.now()) {
      result = cached.result;
    } else {
      try {
        const article = await extractArticle(articleUrl);
        article.url = articleUrl;
        result = await createPage(article);
        cache.set(articleUrl, { result, expires: Date.now() + TTL });
        pathToUrl.set(result.path, articleUrl);
      } catch (err) {
        console.error(JSON.stringify({
          event: 'link_expander_extract_error',
          fxUrl, articleUrl,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }));
        continue;
      }
    }

    console.log(JSON.stringify({
      event: 'link_expander_processed',
      botUsername: ctx.message?.from?.username,
      fxUrl, articleUrl,
      telegraphUrl: result.url,
      threadId: ctx.message?.message_thread_id,
      chatId: ctx.chat.id,
      timestamp: new Date().toISOString(),
    }));

    // Skip reply_to_message_id — target is a bot, which triggers Telegram's
    // topic-misplacement bug. Rely on message_thread_id to keep the reply
    // in the same topic. The visual reply chain is sacrificed; the
    // contextual proximity (same topic, posted right after) is enough.
    const threadOpts = ctx.message?.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};

    try {
      await safeSendMessage(ctx.api, ctx.chat.id, `📰 ${result.url}`, {
        ...threadOpts,
        link_preview_options: { is_disabled: false },
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'link_expander_send_error',
        articleUrl, telegraphUrl: result.url,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }
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

async function getUrlForPath(path: string): Promise<string | null> {
  if (pathToUrl.has(path)) return pathToUrl.get(path)!;
  for (const [url, entry] of cache) {
    if (entry.result.path === path) return url;
  }
  // Fallback: leer author_url desde Telegraph (sobrevive redeploys)
  try {
    const res = await fetch(`https://api.telegra.ph/getPage/${path}?return_content=false`);
    const data = await res.json();
    if (data.ok && data.result?.author_url) {
      pathToUrl.set(path, data.result.author_url);
      return data.result.author_url;
    }
  } catch { /* ok */ }
  return null;
}

function createActionKeyboard(telegraphPath: string, userId: number, originalUrl: string): InlineKeyboard {
  // Guardar mapping path → URL para poder regenerar
  pathToUrl.set(telegraphPath, originalUrl);

  const archiveUrl = `https://archive.ph/?q=${encodeURIComponent(originalUrl)}`;
  const twitterUrl = `https://twitter.com/search?q=${encodeURIComponent(originalUrl)}`;

  const ts = Math.floor(Date.now() / 1000).toString(36);
  const deleteData = `del:${telegraphPath}:${userId}:${ts}`;
  const regenData = `regen:${telegraphPath}:${userId}`;

  // Telegram limita callback_data a 64 bytes
  const delCallback = deleteData.length <= 64
    ? deleteData
    : `del:${telegraphPath}:${userId}:0`;
  const regenCallback = regenData.length <= 64
    ? regenData
    : `regen:${telegraphPath}:0`;

  return new InlineKeyboard()
    .text('🗑️', delCallback)
    .text('🔄', regenCallback)
    .url('📦', archiveUrl)
    .url('🐦', twitterUrl);
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

// Encuesta La Segunda — Sondeo Relámpago via StrawPoll embed
interface EncuestaResult {
  title: string;
  options: { value: string; votes: number }[];
  totalVotes: number;
  pollId: string;
}

async function fetchEncuestaLaSegunda(): Promise<EncuestaResult> {
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

function getChileTime(): string {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'America/Santiago',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Fuentes de precio del dólar (match con sources en dolar.cl)
const DOLLAR_SOURCES = [
  { id: 'btg', name: 'BTG Pactual', aliases: ['btg pactual'] },
  { id: 'fintual', name: 'Fintual', aliases: [] },
  { id: 'bci', name: 'BCI', aliases: [] },
  { id: 'falabella', name: 'Banco Falabella', aliases: ['cmr', 'falabella'] },
  { id: 'bancochile', name: 'Banco de Chile', aliases: ['bancochile', 'banco chile', 'bch'] },
  { id: 'itau', name: 'Itaú', aliases: ['itau'] },
  { id: 'estado', name: 'BancoEstado', aliases: ['banco estado', 'bancoestado', 'bech'] },
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

type DollarData = {
  live: LiveQuote | null;
  quotes: { source: typeof DOLLAR_SOURCES[number]; quote: DollarQuote | null }[];
};

function parseDollarHtml(html: string): DollarData {
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
async function fetchDollarPrices(): Promise<DollarData> {
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
async function fetchDollarPricesViaProxy(): Promise<DollarData> {
  const html = await fetchBypass('https://dolar.cl/');
  return parseDollarHtml(html);
}

function formatDollarRich(
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
    const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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

  // Preservar topic/thread en grupos con foros: inyectar message_thread_id
  // en todas las respuestas automáticamente
  bot.use((ctx, next) => {
    const threadId = ctx.msg?.message_thread_id;
    if (threadId) {
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = (text: string, other?: any) =>
        originalReply(text, { message_thread_id: threadId, ...other });
    }
    return next();
  });

  bot.catch((err) => {
    console.error(JSON.stringify({
      event: 'bot_error',
      error: err.message,
      ctx: err.ctx?.update?.update_id,
      timestamp: new Date().toISOString(),
    }));
  });

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

  // Comando /encuesta — Sondeo Relámpago de La Segunda
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
        escapeHtml(title),
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

  // Comando /dolar (también responde a /usd)
  // Sin argumento: muestra todas las fuentes
  // Con argumento: filtra por nombre de fuente (ej: /dolar bancoestado)
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
          `❌ No encontré "<b>${escapeHtml(filter || '')}</b>"\n\n🏦 Fuentes disponibles: ${available}`,
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
    const signo = escapeHtml(ctx.match?.trim() || '');
    if (!signo) {
      await ctx.reply(
        `🔮 <b>Horóscopo de Yolanda Sultana</b>\n\nUsa: /tiayoli &lt;signo&gt;\n\n${getSignosList()}`,
        { parse_mode: 'HTML' }
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

  // Comando /mundial - Partidos del Mundial FIFA 2026
  bot.command(['mundial', 'wc'], async (ctx) => {
    // Sanitizar input: strip HTML tags, invisible Unicode, y limitar largo
    const rawArg = ctx.match?.trim() || '';
    const arg = rawArg
      .replace(/<[^>]*>/g, '')                    // Strip HTML tags
      .replace(/[^\p{L}\p{N}\s'-]/gu, '')         // Solo letras, números, espacios, guiones, apóstrofes
      .trim()
      .toLowerCase()
      .slice(0, 50);                              // Limitar largo

    // Si el input original tenía contenido pero el sanitizado está vacío → basura
    const hadInput = rawArg.length > 0;

    // Sin argumento o "hoy": countdown o partidos de hoy
    if ((!arg && !hadInput) || arg === 'hoy') {
      const countdown = getCountdown();
      if (countdown) {
        await ctx.reply(countdown, { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } });
        return;
      }
      const today = getChileDate();
      const matches = getMatchesForDate(today);
      await ctx.reply(formatMatchesForDate(matches, today, 'Hoy'), { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } });
      return;
    }

    if (arg === 'mañana' || arg === 'manana') {
      const tomorrow = getChileDate(1);
      const matches = getMatchesForDate(tomorrow);
      await ctx.reply(formatMatchesForDate(matches, tomorrow, 'Mañana'), { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } });
      return;
    }

    if (arg === 'semana') {
      const today = getChileDate();
      const matches = getMatchesForWeek(today);
      await ctx.reply(formatMatchesForWeek(matches), { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } });
      return;
    }

    if (arg === 'equipos') {
      const teams = getAllTeams();
      const teamList = teams.map(t => `• ${t}`).join('\n');
      await ctx.reply(
        `\u26BD <b>Mundial 2026 — Equipos participantes</b>\n\n${teamList}`,
        { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } }
      );
      return;
    }

    // Easter eggs
    const argNorm = arg.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const replyOpts = { reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } };

    // Chile no clasificó
    if (argNorm === 'chile' || argNorm === 'la roja') {
      await ctx.reply('https://www.zzinstagram.com/p/BZs-WG7h8JL/', replyOpts);
      return;
    }

    // URSS
    if (argNorm === 'urss' || argNorm === 'ussr' || argNorm === 'union sovietica' || argNorm === 'soviet union') {
      await ctx.reply('https://www.youtube.com/watch?v=TFS316SzGFQ', replyOpts);
      return;
    }

    // Corea del Norte
    if (argNorm === 'norcorea' || argNorm === 'corea del norte' || argNorm === 'north korea') {
      try {
        const buf = await fetch('https://i.imgur.com/B7yiPD1.jpeg', { signal: AbortSignal.timeout(10_000) }).then(r => r.arrayBuffer());
        await ctx.replyWithPhoto(new InputFile(new Uint8Array(buf), 'norcorea.jpg'), replyOpts);
      } catch { await ctx.reply('🫠', replyOpts); }
      return;
    }

    // Profesor de artes
    if (argNorm === 'artes' || argNorm === 'profesor artes' || argNorm === 'profesor de artes') {
      try {
        const buf = await fetch('https://i.imgur.com/klS1PxD.jpeg', { signal: AbortSignal.timeout(10_000) }).then(r => r.arrayBuffer());
        await ctx.replyWithPhoto(new InputFile(new Uint8Array(buf), 'artes.jpg'), replyOpts);
      } catch { await ctx.reply('🫠', replyOpts); }
      return;
    }

    // El pelao de brazzers / Johnny Sins
    if (/\b(pelao|pelado)\b/.test(argNorm) || /\bbrazzers\b/.test(argNorm) || /\bjohnny\s*sins?\b/.test(argNorm)) {
      try {
        const buf = await fetch('https://i.imgur.com/Ys17mHl.jpeg', { signal: AbortSignal.timeout(10_000) }).then(r => r.arrayBuffer());
        await ctx.replyWithPhoto(new InputFile(new Uint8Array(buf), 'pelao.jpg'), replyOpts);
      } catch { await ctx.reply('🫠', replyOpts); }
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
      await ctx.reply(formatMatchesForTeam(result.team, result.matches), { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } });
      return;
    }

    // Equipo no encontrado
    const displayArg = arg || rawArg.slice(0, 50);
    await ctx.reply(
      `\u26BD\u274C <b>${escapeHtml(displayArg)}</b> NO va al mundial 2026\n\n` +
      'Usa /mundial equipos para ver quiénes sí van',
      { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } }
    );
  });

  // Comando /setup_mundial - Configura el topic para notificaciones
  bot.command('setup_mundial', async (ctx) => {
    if (!ctx.chat || !ctx.from) return;

    // Verificar que sea admin
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
    await ctx.reply('\u2705 Notificaciones del Mundial configuradas para este topic.\nSe avisará 2 horas antes de cada partido.');
  });

  // Scheduler: notificaciones 2h antes de partidos del Mundial
  setInterval(async () => {
    if (!mundialConfig) return;

    // Calcular fecha y hora Chile de aquí a 2 horas
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const futureDate = twoHoursFromNow.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
    const futureTime = twoHoursFromNow.toLocaleTimeString('en-GB', {
      timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit',
    });

    const matches = getMatchesAtTime(futureDate, futureTime);
    if (matches.length === 0) return;

    // Clave única para evitar duplicados
    const key = `${futureDate}-${futureTime}`;
    if (mundialNotified.has(key)) return;
    mundialNotified.add(key);

    try {
      await safeSendMessage(bot.api, mundialConfig.chatId, formatNotification(matches), {
        message_thread_id: mundialConfig.topicId,
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

  // Handler para mensajes con URLs
  bot.on('message:text', async (ctx) => {
    // Bots: only process Link Expander-style X/Twitter expanders.
    if (ctx.message.from?.is_bot) {
      const username = ctx.message.from.username?.toLowerCase();
      if (username && LINK_EXPANDER_BOTS.has(username)) {
        await handleLinkExpanderMessage(ctx);
      }
      return;
    }

    const rawUrls = extractUrls(ctx.message.text);

    for (const rawUrl of rawUrls) {
      const url = deAmpUrl(rawUrl);
      const source = detectSource(url);
      // Sites with a custom extractor or recipe go through immediately.
      // All other URLs try the generic extractor (JSON-LD / __NEXT_DATA__ / HTML).
      // The quality gate in generic.ts filters non-article pages.
      if (!source && !isExtractableUrl(url)) continue;

      // Rate limiting — skip extraction if no userId (can't rate-limit anonymous sources)
      const userId = ctx.from?.id;
      if (!userId || isRateLimited(userId)) continue;

      // El Mercurio: URLs de página necesitan selección de artículo
      if (source === 'elmercurio' && isPageUrl(url)) {
        try {
          const pageData = await fetchPageArticles(url);
          if (!pageData || pageData.articles.length === 0) {
            const sent = await ctx.reply('❌ No encontré artículos en esa página.', {
              reply_to_message_id: ctx.message.message_id,
            });
            scheduleDelete(ctx.api, sent.chat.id, sent.message_id);
            continue;
          }

          const grouping = groupPageArticles(pageData.articles);

          console.log(JSON.stringify({
            event: 'page_groups_detected',
            url,
            groupCount: grouping.groups.length,
            standaloneCount: grouping.standalone.length,
            totalArticles: pageData.articles.length,
            timestamp: new Date().toISOString(),
          }));

          // AUTO: 1 group + 0 standalones → render group without prompting
          if (grouping.groups.length === 1 && grouping.standalone.length === 0) {
            const group = grouping.groups[0];
            const article = await extractStoryGroup(group, pageData.date, pageData.pageId);
            article.url = url;
            const result = await createPage(article);
            const cacheKey = `${url}#group:${group.anchor.id}`;
            cache.set(cacheKey, { result, expires: Date.now() + TTL });
            pathToUrl.set(result.path, url);
            addRegistryEntry({
              type: 'extractor', originalUrl: url, source: article.source,
              telegraphPath: result.path, title: article.title, chatId: ctx.chat?.id,
            }).catch(() => {});
            await processAndReply(ctx, url, result);
            continue;
          }

          // AUTO: 0 groups + 1 standalone → render directly (preserves prior behavior)
          if (grouping.groups.length === 0 && grouping.standalone.length === 1) {
            const lone = grouping.standalone[0];
            const article = await extractByArticleId(lone.id, pageData.date);
            article.url = url;
            const result = await createPage(article);
            cache.set(`${url}#${lone.id}`, { result, expires: Date.now() + TTL });
            pathToUrl.set(result.path, url);
            addRegistryEntry({
              type: 'extractor', originalUrl: url, source: article.source,
              telegraphPath: result.path, title: article.title, chatId: ctx.chat?.id,
            }).catch(() => {});
            await processAndReply(ctx, url, result);
            continue;
          }

          // Otherwise: show selector with groups + standalones
          let text = `📰 <b>${escapeHtml(pageData.sectionName)}</b> — Pág. ${pageData.page}\n\n`;
          text += 'Elige el artículo:\n\n';
          const keyboard = new InlineKeyboard();

          // Groups first
          for (let gi = 0; gi < grouping.groups.length; gi++) {
            const g = grouping.groups[gi];
            const cleanTitle = sanitizeAndStripMercurio(g.anchor.title);
            const partsCount = 1 + g.recuadros.length;
            text += `📋 Reportaje completo: ${escapeHtml(cleanTitle)} (${partsCount} partes)\n`;
            keyboard.text(`📋 ${gi + 1}`, `empage:g:${gi}`).row();
          }

          // Standalones with numbered buttons
          const maxStandalone = Math.min(grouping.standalone.length, NUMBER_EMOJIS.length);
          for (let i = 0; i < maxStandalone; i++) {
            const a = grouping.standalone[i];
            const cleanTitle = sanitizeAndStripMercurio(a.title);
            text += `${NUMBER_EMOJIS[i]} ${escapeHtml(cleanTitle)}\n`;
            keyboard.text(NUMBER_EMOJIS[i], `empage:a:${i}`);
            if ((i + 1) % 5 === 0) keyboard.row();
          }

          const botMessage = await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            reply_to_message_id: ctx.message.message_id,
          });

          pendingPages.set(botMessage.message_id, {
            groups: grouping.groups,
            standalone: grouping.standalone.slice(0, maxStandalone),
            date: pageData.date,
            pageId: pageData.pageId,
            originalUrl: url,
            userId: ctx.from?.id || 0,
            username: ctx.from?.username,
            firstName: ctx.from?.first_name || 'Usuario',
            chatId: ctx.chat.id,
            botMessageId: botMessage.message_id,
            originalMessageId: ctx.message.message_id,
            originalText: ctx.message.text,
            replyToMessageId: ctx.message.reply_to_message?.message_id,
            threadId: ctx.message.message_thread_id,
            replyTargetThreadId: ctx.message.reply_to_message?.message_thread_id,
            replyTargetIsBot: ctx.message.reply_to_message?.from?.is_bot ?? false,
            createdAt: Date.now(),
          });
        } catch (error) {
          console.error(JSON.stringify({
            event: 'page_selection_error', url,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }));
          const sent = await ctx.reply('❌ No pude acceder a esa página.', {
            reply_to_message_id: ctx.message.message_id,
          });
          scheduleDelete(ctx.api, sent.chat.id, sent.message_id);
        }
        continue;
      }

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
        reply_parameters: {
          message_id: ctx.message.message_id,
          allow_sending_without_reply: true,
        },
      });

      // Configurar timeout para procesar después del período de gracia
      const timeoutId = setTimeout(async () => {
        const req = pending.get(pendingId);
        if (!req || req.cancelled) {
          pending.delete(pendingId);
          return;
        }

        try {
          // Extraer y crear página (30s timeout global para evitar cuelgues)
          const article = await Promise.race([
            extractArticle(url),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Timeout: extracción tomó más de 30s')), 30_000)
            ),
          ]);
          const result = await createPage(article);

          // Guardar en cache
          cache.set(url, { result, expires: Date.now() + TTL });

          // Persist to registry (survives redeploys)
          addRegistryEntry({
            type: 'extractor',
            originalUrl: url,
            source: article.source,
            telegraphPath: result.path,
            title: article.title,
            chatId: ctx.chat?.id,
          }).catch(() => {});

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
            scheduleDelete(ctx.api, ctx.chat.id, botMessage.message_id);
          } catch {
            // Mensaje ya borrado o inaccesible
          }
        } finally {
          pending.delete(pendingId);
        }
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
        replyToMessageId: ctx.message.reply_to_message?.message_id,
        threadId: ctx.message.message_thread_id,
        replyTargetThreadId: ctx.message.reply_to_message?.message_thread_id,
        replyTargetIsBot: ctx.message.reply_to_message?.from?.is_bot ?? false,
      });

      console.log(JSON.stringify({
        event: 'pending_created', url,
        threadId: ctx.message.message_thread_id,
        replyToMessageId: ctx.message.reply_to_message?.message_id,
        chatId: ctx.chat.id,
        timestamp: new Date().toISOString(),
      }));
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
      // Validate path format — Telegraph paths are alphanumeric + hyphens
      if (!/^[\w-]+$/.test(telegraphPath)) {
        await ctx.answerCallbackQuery({ text: 'Path inválido', show_alert: true });
        return;
      }
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

      // "Borrar" la página Telegraph (vaciarla) e invalidar cache
      await deletePage(telegraphPath);
      pathToUrl.delete(telegraphPath);
      for (const [cachedUrl, entry] of cache) {
        if (entry.result.path === telegraphPath) { cache.delete(cachedUrl); break; }
      }

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
      pathToUrl.delete(telegraphPath);
      for (const [cachedUrl, entry] of cache) {
        if (entry.result.path === telegraphPath) { cache.delete(cachedUrl); break; }
      }
      try { await ctx.deleteMessage(); } catch { await ctx.editMessageText('🗑️ Eliminado'); }
      await ctx.answerCallbackQuery({ text: 'Eliminado' });
      return;
    }

    // Regenerar artículo Telegraph
    if (data.startsWith('regen:')) {
      const parts = data.slice(6).split(':');
      const ownerId = parseInt(parts.pop()!, 10);
      const telegraphPath = parts.join(':');
      const userId = ctx.from?.id;

      // Solo owner o admin
      let canRegen = userId === ownerId;
      if (!canRegen && ctx.chat && userId) {
        try {
          const member = await ctx.api.getChatMember(ctx.chat.id, userId);
          canRegen = ['creator', 'administrator'].includes(member.status);
        } catch {}
      }
      if (!canRegen) {
        await ctx.answerCallbackQuery({ text: 'Solo el autor o admins pueden regenerar', show_alert: true });
        return;
      }

      // Recuperar URL original
      const originalUrl = await getUrlForPath(telegraphPath);
      if (!originalUrl) {
        await ctx.answerCallbackQuery({ text: 'No se puede regenerar. Postea la URL de nuevo.', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '🔄 Regenerando...' });

      try {
        // Editar mensaje a "procesando"
        const chatId = ctx.callbackQuery.message?.chat.id;
        const messageId = ctx.callbackQuery.message?.message_id;
        if (chatId && messageId) {
          await ctx.api.editMessageText(chatId, messageId, '⏳ Regenerando artículo...');
        }

        // Re-extraer y crear nueva página
        const article = await Promise.race([
          extractArticle(originalUrl),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 30_000)
          ),
        ]);
        const result = await createPage(article);

        // Invalidar cache vieja, guardar nueva
        cache.delete(originalUrl);
        pathToUrl.delete(telegraphPath);
        cache.set(originalUrl, { result, expires: Date.now() + TTL });

        // Reconstruir mensaje y keyboard
        const newKeyboard = createActionKeyboard(result.path, ownerId, originalUrl);
        const mention = ctx.from?.username ? `@${ctx.from.username}` :
          `<a href="tg://user?id=${ctx.from?.id}">${escapeHtml(ctx.from?.first_name || '')}</a>`;
        const messageText = `${mention} compartió:\n${result.url}`;

        if (chatId && messageId) {
          await ctx.api.editMessageText(chatId, messageId, messageText, {
            parse_mode: 'HTML',
            reply_markup: newKeyboard,
            link_preview_options: { is_disabled: false },
          });
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'regen_error',
          url: originalUrl,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }));
        const chatId = ctx.callbackQuery.message?.chat.id;
        const messageId = ctx.callbackQuery.message?.message_id;
        if (chatId && messageId) {
          try {
            await ctx.api.editMessageText(chatId, messageId, '❌ No se pudo regenerar el artículo.');
            scheduleDelete(ctx.api, chatId, messageId);
          } catch {}
        }
      }
      return;
    }

    // Regenerar item RSS (ADPrensa o Señal)
    if (data.startsWith('regen_rss:')) {
      const parts = data.slice(10).split(':');
      const source = parts[0]; // 'adprensa' or 'senal'
      const guidHash = parts[1];
      const userId = ctx.from?.id;

      // Only admins can regen RSS items
      let canRegen = false;
      if (ctx.chat && userId) {
        try {
          const member = await ctx.api.getChatMember(ctx.chat.id, userId);
          canRegen = ['creator', 'administrator'].includes(member.status);
        } catch {}
      }
      if (!canRegen) {
        await ctx.answerCallbackQuery({ text: 'Solo admins pueden regenerar', show_alert: true });
        return;
      }

      // Look up in registry by guid prefix
      const entry = await findByGuidPrefix(guidHash);
      if (!entry || !entry.guid) {
        await ctx.answerCallbackQuery({ text: 'Item no encontrado en el registro', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '\u{1F504} Regenerando...' });

      const chatId = ctx.callbackQuery.message?.chat.id;
      const messageId = ctx.callbackQuery.message?.message_id;

      try {
        if (source === 'adprensa') {
          // ADPrensa: re-fetch feed, find item, re-create Telegraph, edit message
          const xml = await fetchAdprensaFeed();
          const allItems = parseAdprensaItems(xml);
          const item = allItems.find(i => i.guid === entry.guid);

          if (!item) {
            if (chatId && messageId) {
              try { await ctx.api.editMessageText(chatId, messageId, '\u{274C} Item ya no est\u00e1 en el feed. Intenta m\u00e1s tarde.'); } catch {}
            }
            return;
          }

          const contactList = isContactList(item.contentEncoded);
          const body = contactList ? item.contentEncoded : preprocessPautaContent(item.contentEncoded);

          const article = {
            title: item.title,
            body,
            url: item.link,
            source: 'adprensa' as const,
            date: item.pubDate,
          };

          const result = await createPage(article);

          // Update registry with new telegraph path
          updateRegistryEntry(entry.guid, { telegraphPath: result.path }).catch(() => {});

          // Edit existing message with new Telegraph URL + regen keyboard
          const regenKeyboard = createRssRegenKeyboard('adprensa', entry.guid);
          if (chatId && messageId) {
            await ctx.api.editMessageText(chatId, messageId, result.url, {
              reply_markup: regenKeyboard,
              link_preview_options: { is_disabled: false },
            });
          }

          console.log(JSON.stringify({
            event: 'regen_rss_success',
            source: 'adprensa',
            guid: entry.guid,
            newPath: result.path,
            timestamp: new Date().toISOString(),
          }));

        } else if (source === 'senal') {
          // Señal: re-fetch feed, find item, re-download media, send NEW message
          const xml = await fetchSenalFeed();
          const allItems = parseSenalItems(xml);
          const item = allItems.find(i => i.guid === entry.guid);

          if (!item) {
            if (chatId && messageId) {
              try { await ctx.api.editMessageText(chatId, messageId, '\u{274C} Item ya no est\u00e1 en el feed. Intenta m\u00e1s tarde.'); } catch {}
            }
            return;
          }

          const media = extractMediaLinks(item.contentEncoded);
          const caption = formatCaption(item, media);
          const photos = await getPhotos(media);
          const regenKeyboard = createRssRegenKeyboard('senal', entry.guid);

          if (chatId) {
            // Try to delete the old message (may fail for media groups)
            if (messageId) {
              try { await ctx.api.deleteMessage(chatId, messageId); } catch {}
            }

            let newMessageId: number | undefined;

            if (photos.length >= 2) {
              const mediaGroup = photos.map((p, i) =>
                InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
              );
              const sent = await ctx.api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true });
              newMessageId = sent[0]?.message_id;
              // Follow-up regen button (no reply_to — channels show full preview as dupe)
              await ctx.api.sendMessage(chatId, '\u{1F504}', {
                disable_notification: true,
                reply_markup: regenKeyboard,
              });
            } else if (photos.length === 1) {
              const sent = await ctx.api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
                caption, parse_mode: 'HTML', disable_notification: true, reply_markup: regenKeyboard,
              });
              newMessageId = sent.message_id;
            } else {
              const sent = await ctx.api.sendMessage(chatId, caption, {
                parse_mode: 'HTML', disable_notification: true, reply_markup: regenKeyboard,
                link_preview_options: { is_disabled: true },
              });
              newMessageId = sent.message_id;
            }

            // Update registry with new message ID
            if (newMessageId) {
              updateRegistryEntry(entry.guid, { messageId: newMessageId }).catch(() => {});
            }
          }

          console.log(JSON.stringify({
            event: 'regen_rss_success',
            source: 'senal',
            guid: entry.guid,
            timestamp: new Date().toISOString(),
          }));
        } else if (source === 'fotoportadas') {
          // Fotoportadas: re-fetch feed, find item, re-download photos, replace message
          const xml = await fetchFotoportadasFeed();
          const allItems = parseFotoportadasItems(xml);
          const item = allItems.find(i => i.guid === entry.guid);

          if (!item) {
            if (chatId && messageId) {
              try { await ctx.api.editMessageText(chatId, messageId, '\u{274C} Item ya no est\u00e1 en el feed. Intenta m\u00e1s tarde.'); } catch {}
            }
            return;
          }

          const urls = extractFotoportadaImages(item.contentEncoded);
          const photos = await downloadPhotos(urls);
          const caption = `\u{1F4F0} <b>${escapeHtml(item.title)}</b>`;
          const regenKeyboard = createRssRegenKeyboard('fotoportadas', entry.guid);

          if (chatId) {
            if (messageId) {
              try { await ctx.api.deleteMessage(chatId, messageId); } catch {}
            }

            let newMessageId: number | undefined;

            if (photos.length >= 2) {
              const mediaGroup = photos.map((p, i) =>
                InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
              );
              const sent = await ctx.api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true });
              newMessageId = sent[0]?.message_id;
              // Follow-up regen button — media groups can't carry inline keyboards.
              await ctx.api.sendMessage(chatId, '\u{1F504}', {
                disable_notification: true,
                reply_markup: regenKeyboard,
              });
            } else if (photos.length === 1) {
              const sent = await ctx.api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
                caption, parse_mode: 'HTML', disable_notification: true, reply_markup: regenKeyboard,
              });
              newMessageId = sent.message_id;
            }

            if (newMessageId) {
              updateRegistryEntry(entry.guid, { messageId: newMessageId }).catch(() => {});
            }
          }

          console.log(JSON.stringify({
            event: 'regen_rss_success',
            source: 'fotoportadas',
            guid: entry.guid,
            timestamp: new Date().toISOString(),
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'regen_rss_error',
          source,
          guid: entry.guid,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }));
        if (chatId && messageId) {
          try {
            await ctx.api.editMessageText(chatId, messageId, '\u{274C} No se pudo regenerar.');
          } catch {}
        }
      }
      return;
    }

    // Selección de artículo en página de El Mercurio
    if (data.startsWith('empage:')) {
      const messageId = ctx.callbackQuery.message?.message_id;
      if (!messageId) {
        await ctx.answerCallbackQuery({ text: 'Error interno' });
        return;
      }

      const sel = pendingPages.get(messageId);
      if (!sel) {
        await ctx.answerCallbackQuery({ text: 'Selección expirada. Pega la URL de nuevo.', show_alert: true });
        return;
      }

      const isOwner = ctx.from?.id === sel.userId;
      let isAdmin = false;
      if (!isOwner && ctx.chat && ctx.from?.id) {
        try {
          const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
          isAdmin = ['creator', 'administrator'].includes(member.status);
        } catch {}
      }
      if (!isOwner && !isAdmin) {
        await ctx.answerCallbackQuery({ text: 'Solo quien pegó la URL puede elegir' });
        return;
      }

      const m = data.match(/^empage:([ga]):(\d+)$/);
      if (!m) {
        await ctx.answerCallbackQuery({ text: 'Selección no válida' });
        return;
      }
      const kind = m[1];
      const idx = parseInt(m[2], 10);

      let extracted: import('./types.js').Article;
      let cacheKey: string;

      try {
        if (kind === 'g') {
          const group = sel.groups[idx];
          if (!group) {
            await ctx.answerCallbackQuery({ text: 'Grupo no válido' });
            return;
          }
          pendingPages.delete(messageId);
          await ctx.answerCallbackQuery({ text: '⏳ Procesando reportaje...' });
          await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando reportaje...');
          extracted = await Promise.race([
            extractStoryGroup(group, sel.date, sel.pageId),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30_000)),
          ]);
          cacheKey = `${sel.originalUrl}#group:${group.anchor.id}`;
        } else {
          const article = sel.standalone[idx];
          if (!article) {
            await ctx.answerCallbackQuery({ text: 'Artículo no válido' });
            return;
          }
          pendingPages.delete(messageId);
          await ctx.answerCallbackQuery({ text: '⏳ Procesando...' });
          await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando artículo...');
          extracted = await Promise.race([
            extractByArticleId(article.id, sel.date),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30_000)),
          ]);
          cacheKey = `${sel.originalUrl}#${article.id}`;
        }

        extracted.url = sel.originalUrl;
        const result = await createPage(extracted);
        cache.set(cacheKey, { result, expires: Date.now() + TTL });
        pathToUrl.set(result.path, sel.originalUrl);

        const keyboard = createActionKeyboard(result.path, sel.userId, sel.originalUrl);
        const mention = sel.username ? `@${sel.username}` :
          `<a href="tg://user?id=${sel.userId}">${escapeHtml(sel.firstName)}</a>`;
        const extraText = getTextWithoutUrls(sel.originalText);
        const messageText = extraText
          ? `${mention}: ${escapeHtml(extraText)}\n\n${result.url}`
          : `${mention} compartió:\n${result.url}`;

        if (sel.replyToMessageId) {
          try { await ctx.api.deleteMessage(sel.chatId, sel.botMessageId); } catch {}
          try { await ctx.api.deleteMessage(sel.chatId, sel.originalMessageId); } catch {}

          const sameId = sel.replyToMessageId === sel.threadId;
          const threadMismatch = sel.threadId != null &&
            sel.replyTargetThreadId !== sel.threadId;
          const targetIsBot = sel.replyTargetIsBot === true;
          const dropReplyTo = sameId || threadMismatch || targetIsBot;
          const threadOpts = sel.threadId ? { message_thread_id: sel.threadId } : {};
          const replyOpts = dropReplyTo
            ? {} : { reply_to_message_id: sel.replyToMessageId };

          if (threadMismatch || targetIsBot) {
            console.log(JSON.stringify({
              event: 'thread_mismatch', action: 'drop_reply_to',
              reason: targetIsBot ? 'target_is_bot' : 'thread_mismatch',
              currentThread: sel.threadId,
              replyTargetThread: sel.replyTargetThreadId,
              replyTargetIsBot: sel.replyTargetIsBot,
              replyToMessageId: sel.replyToMessageId,
              chatId: sel.chatId,
              timestamp: new Date().toISOString(),
            }));
          }

          await safeSendMessage(ctx.api, sel.chatId, messageText, {
            ...threadOpts,
            ...replyOpts,
            parse_mode: 'HTML',
            reply_markup: keyboard,
            link_preview_options: { is_disabled: false },
          });
        } else {
          try { await ctx.api.deleteMessage(sel.chatId, sel.originalMessageId); } catch {}
          try {
            await ctx.api.editMessageText(sel.chatId, sel.botMessageId, messageText, {
              parse_mode: 'HTML',
              reply_markup: keyboard,
              link_preview_options: { is_disabled: false },
            });
          } catch {
            await safeSendMessage(ctx.api, sel.chatId, messageText, {
              message_thread_id: sel.threadId,
              parse_mode: 'HTML',
              reply_markup: keyboard,
              link_preview_options: { is_disabled: false },
            });
          }
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'page_extraction_error',
          url: sel.originalUrl,
          kind, idx,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }));
        try {
          await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '❌ No pude reconstruir el artículo.');
          scheduleDelete(ctx.api, sel.chatId, sel.botMessageId);
        } catch {}
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // /ultimo — fetch latest Señal or Pauta post (poller channel only)
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

  // RSS pollers for private channel
  startRssPoller(bot.api).catch(err =>
    console.error(JSON.stringify({ event: 'rss_poller_fatal', error: err?.message || String(err), timestamp: new Date().toISOString() })));
  startAdprensaPoller(bot.api).catch(err =>
    console.error(JSON.stringify({ event: 'adprensa_poller_fatal', error: err?.message || String(err), timestamp: new Date().toISOString() })));
  startFotoportadasPoller(bot.api).catch(err =>
    console.error(JSON.stringify({ event: 'fotoportadas_poller_fatal', error: err?.message || String(err), timestamp: new Date().toISOString() })));

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

    if (req.replyToMessageId) {
      // El usuario respondió a otro mensaje con un link — borrar "⏳ Procesando" y
      // el mensaje del usuario, luego publicar como reply al mensaje padre original
      try { await ctx.api.deleteMessage(req.chatId, req.botMessageId); } catch { /* ok */ }
      try { await ctx.api.deleteMessage(req.chatId, req.originalMessageId); } catch { /* ok */ }

      // Determinar si podemos incluir reply_to_message_id sin que Telegram
      // mueva el mensaje a un topic distinto:
      // 1. sameId: el reply target es el header del topic → no incluir reply_to
      // 2. threadMismatch: el reply target está en otro thread → drop reply_to
      // 3. targetIsBot: replying to a bot's message (Link Expander, etc.)
      //    Telegram silently moves replies to bot messages to General/main
      //    topic regardless of message_thread_id. Drop reply_to to keep
      //    correct topic placement; sacrifices the visual reply chain.
      const sameId = req.replyToMessageId === req.threadId;
      const threadMismatch = req.threadId != null &&
        req.replyTargetThreadId !== req.threadId;
      const targetIsBot = req.replyTargetIsBot === true;
      const dropReplyTo = sameId || threadMismatch || targetIsBot;
      const threadOpts = req.threadId ? { message_thread_id: req.threadId } : {};
      const replyOpts = dropReplyTo
        ? {} : { reply_to_message_id: req.replyToMessageId };

      if (threadMismatch || targetIsBot) {
        console.log(JSON.stringify({
          event: 'thread_mismatch', action: 'drop_reply_to',
          reason: targetIsBot ? 'target_is_bot' : 'thread_mismatch',
          currentThread: req.threadId,
          replyTargetThread: req.replyTargetThreadId,
          replyTargetIsBot: req.replyTargetIsBot,
          replyToMessageId: req.replyToMessageId,
          chatId: req.chatId,
          timestamp: new Date().toISOString(),
        }));
      }

      await safeSendMessage(ctx.api, req.chatId, messageText, {
        ...threadOpts,
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
    } else {
      // Mensaje directo con link — borrar original, editar "⏳ Procesando" con resultado
      try { await ctx.api.deleteMessage(req.chatId, req.originalMessageId); } catch { /* ok */ }
      try {
        await ctx.api.editMessageText(req.chatId, req.botMessageId, messageText, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: false },
        });
      } catch {
        await safeSendMessage(ctx.api, req.chatId, messageText, {
          message_thread_id: req.threadId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: false },
        });
      }
    }
  } else {
    // Sin pending request (cache hit) — apply the same thread guards as pending path
    const replyToId = ctx.message?.reply_to_message?.message_id;
    const threadId = ctx.msg?.message_thread_id;
    const chatId = ctx.chat!.id;

    if (replyToId) {
      // Nested reply with cached URL — delete user msg, reply to original target
      const mention = ctx.from?.username
        ? `@${ctx.from.username}`
        : `<a href="tg://user?id=${ctx.from?.id}">${escapeHtml(ctx.from?.first_name || 'Usuario')}</a>`;
      const extraText = getTextWithoutUrls(ctx.message?.text || '');
      messageText = extraText
        ? `${mention}: ${escapeHtml(extraText)}\n\n${result.url}`
        : `${mention} compartió:\n${result.url}`;

      try { await ctx.api.deleteMessage(chatId, ctx.msg!.message_id); } catch { /* ok */ }

      const sameId = replyToId === threadId;
      const replyTargetThreadId = ctx.message?.reply_to_message?.message_thread_id;
      const replyTargetIsBot = ctx.message?.reply_to_message?.from?.is_bot === true;
      const threadMismatch = threadId != null &&
        replyTargetThreadId !== threadId;
      const dropReplyTo = sameId || threadMismatch || replyTargetIsBot;
      const threadOpts = threadId ? { message_thread_id: threadId } : {};
      const replyOpts = dropReplyTo
        ? {} : { reply_to_message_id: replyToId };

      if (threadMismatch || replyTargetIsBot) {
        console.log(JSON.stringify({
          event: 'thread_mismatch', action: 'drop_reply_to',
          reason: replyTargetIsBot ? 'target_is_bot' : 'thread_mismatch',
          currentThread: threadId,
          replyTargetThread: replyTargetThreadId,
          replyTargetIsBot,
          replyToMessageId: replyToId,
          chatId,
          timestamp: new Date().toISOString(),
        }));
      }

      await safeSendMessage(ctx.api, chatId, messageText, {
        ...threadOpts,
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
    } else {
      // Direct message (not a reply) — middleware handles thread injection via ctx.reply()
      await ctx.reply(messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        reply_to_message_id: ctx.msg?.message_id,
      });
    }
  }
}

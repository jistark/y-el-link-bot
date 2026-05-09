/**
 * Shared in-memory state for the bot's URL-extraction pipeline.
 *
 * Why a single module: the message handler, the callback dispatcher, and
 * several command modules all read/write the same cache + pending maps.
 * Keeping them here makes the data model explicit and lets each consumer
 * import only what it needs instead of pulling everything from bot.ts.
 *
 * Also owns the periodic cleanup interval that bounds memory on Render's
 * 512 MB instance.
 */

import type { CreatePageResult } from '../formatters/telegraph.js';
import type { PageArticleInfo, StoryGroup } from '../extractors/elmercurio.js';
import type { LunPageArticleInfo } from '../extractors/lun.js';

// --- Constants --------------------------------------------------------------

/** Grace window during which the user can press "⏪ Cancelar" (ms). */
export const UNDO_GRACE_PERIOD = 5000;

/** Window after publication during which the author (non-admin) can /borrar. */
export const DELETE_GRACE_PERIOD = 15000;

/** TTL for the article-result cache (24 h). */
export const TTL = 24 * 60 * 60 * 1000;

/** Number of articles a single user may extract per minute. */
export const RATE_LIMIT = 5;
export const RATE_WINDOW = 60 * 1000;

// Number emojis used for "elegir artículo en página" UI.
export const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// --- Types ------------------------------------------------------------------

export interface PendingRequest {
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
  /** Si el mensaje original era un reply, preservar la relación. */
  replyToMessageId?: number;
  /** Topic/foro de Telegram. */
  threadId?: number;
  /** Thread del mensaje al que se respondió (para detectar mismatch). */
  replyTargetThreadId?: number;
  /** El target del reply es un bot (ej. Link Expander) — fuerza drop de reply_to. */
  replyTargetIsBot?: boolean;
}

export interface PendingPageSelection {
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

export interface PendingLunSelection {
  articles: LunPageArticleInfo[];
  fecha: string;
  paginaId: string;
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

// --- State maps -------------------------------------------------------------

/** original URL → cached Telegraph result. Pruned by TTL each hour. */
export const cache = new Map<string, { result: CreatePageResult; expires: number }>();

/** Pending requests inside the UNDO grace period. Keyed by tracking id. */
export const pending = new Map<string, PendingRequest>();

/** Multi-article El Mercurio page selections awaiting user choice. */
export const pendingPages = new Map<number, PendingPageSelection & { createdAt: number }>();

/** Multi-article LUN page selections awaiting user choice. */
export const pendingLunPages = new Map<number, PendingLunSelection & { createdAt: number }>();

/** Telegraph path → original URL, used to regenerate articles after restart. */
export const pathToUrl = new Map<string, string>();

/** Match-notification dedupe set for /mundial. Keys are TZ-Chile YYYY-MM-DD-HH:mm. */
export const mundialNotified = new Set<string>();

/** Per-user rate limiter timestamps. */
const userRequests = new Map<number, number[]>();

// --- Behavior ---------------------------------------------------------------

export function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const timestamps = userRequests.get(userId) || [];
  const recent = timestamps.filter(t => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) return true;
  recent.push(now);
  userRequests.set(userId, recent);
  return false;
}

// --- Cleanup intervals ------------------------------------------------------

// Article cache: drop expired entries every hour. Cheap and bounded — the
// cache only grows when users post new URLs, so this rarely scans more
// than a few hundred entries.
//
// .unref() so the test runner / shutdown can exit even though the timer
// is technically still scheduled. In production the bot is the main loop,
// so unref'ing is a no-op there.
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expires < now) cache.delete(key);
  }
}, 60 * 60 * 1000).unref();

// Auxiliary state cleanup every 5 minutes. Bounds memory on Render's
// 512 MB instance — without these sweeps, pendingPages/Lun and
// userRequests would grow with every page-selection or rate-limit hit.
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of userRequests) {
    const recent = timestamps.filter(t => now - t < RATE_WINDOW);
    if (recent.length === 0) userRequests.delete(userId);
    else userRequests.set(userId, recent);
  }
  // Selecciones de página expiradas (10 min TTL)
  for (const [key, sel] of pendingPages) {
    if (now - sel.createdAt > 10 * 60 * 1000) pendingPages.delete(key);
  }
  for (const [key, sel] of pendingLunPages) {
    if (now - sel.createdAt > 10 * 60 * 1000) pendingLunPages.delete(key);
  }
  // pathToUrl: drop entries whose path is no longer cached.
  if (pathToUrl.size > 500) {
    const activePaths = new Set<string>();
    for (const entry of cache.values()) activePaths.add(entry.result.path);
    for (const path of pathToUrl.keys()) {
      if (!activePaths.has(path)) pathToUrl.delete(path);
    }
  }
  // mundialNotified: drop entries with past dates. Keys use TZ Chile,
  // so the cleanup must use the same zone — otherwise entries around
  // midnight get evicted 1 day too early or 1 day too late.
  const todayStr = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
  for (const key of mundialNotified) {
    const dateStr = key.slice(0, 10); // key format: YYYY-MM-DD-HH:mm
    if (dateStr < todayStr) mundialNotified.delete(key);
  }
}, 5 * 60 * 1000).unref();

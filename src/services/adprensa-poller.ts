import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Api } from 'grammy';
import type { Article } from '../types.js';
import { createPage } from '../formatters/telegraph.js';

const RSS_FEED_URL = 'https://adprensa.cl/feed/';
const BASE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const JITTER = 3 * 60 * 1000;         // ±3 minutes
const MAX_POSTED = 500;
const ITEM_DELAY = 3_000;

const POSTED_PATH = join(process.cwd(), 'data', 'adprensa-posted.json');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

interface RssItem {
  guid: string;
  title: string;
  link: string;
  contentEncoded: string;
  pubDate: string;
  categories: string[];
}

// --- Persistence ---

async function loadPostedGuids(): Promise<Set<string>> {
  try {
    const data = await readFile(POSTED_PATH, 'utf-8');
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

async function savePostedGuids(guids: Set<string>): Promise<void> {
  try { mkdirSync(join(process.cwd(), 'data'), { recursive: true }); } catch { /* ok */ }
  const arr = [...guids].slice(-MAX_POSTED);
  await writeFile(POSTED_PATH, JSON.stringify(arr), 'utf-8');
}

// --- Fetching ---

async function fetchRssFeed(): Promise<string> {
  const res = await fetch(RSS_FEED_URL, {
    headers: { 'User-Agent': randomUA() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`AdPrensa RSS fetch failed: ${res.status}`);
  return res.text();
}

// --- Parsing ---

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8230;/g, '...')
    .replace(/&#160;/g, ' ');
}

function parseItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const contentMatch = block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);

    // Extract all categories
    const categories: string[] = [];
    const catRegex = /<category><!\[CDATA\[([\s\S]*?)\]\]><\/category>/g;
    let catMatch;
    while ((catMatch = catRegex.exec(block)) !== null) {
      categories.push(catMatch[1].trim());
    }

    if (titleMatch && guidMatch && contentMatch) {
      items.push({
        guid: guidMatch[1].trim(),
        title: decodeEntities(titleMatch[1].trim()),
        link: linkMatch?.[1]?.trim() || '',
        contentEncoded: contentMatch[1],
        pubDate: pubDateMatch?.[1]?.trim() || '',
        categories,
      });
    }
  }

  return items;
}

// --- Telegram helpers ---

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getRetryAfter(err: any): number | null {
  const match = err?.message?.match(/retry after (\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

async function sendWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const retryAfter = getRetryAfter(err);
    if (retryAfter) {
      console.log(JSON.stringify({
        event: 'adprensa_rate_limited',
        retryAfter,
        label,
        timestamp: new Date().toISOString(),
      }));
      await sleep((retryAfter + 1) * 1000);
      return await fn();
    }
    throw err;
  }
}

// --- Core ---

async function pollOnce(api: Api, chatId: number, posted: Set<string>): Promise<void> {
  const xml = await fetchRssFeed();
  const allItems = parseItems(xml);

  // Filter: only "Pauta" category
  const pautaItems = allItems.filter(item => item.categories.includes('Pauta'));

  // Process oldest-first
  const newItems = pautaItems.filter(item => !posted.has(item.guid)).reverse();

  if (newItems.length === 0) return;

  console.log(JSON.stringify({
    event: 'adprensa_new_items',
    count: newItems.length,
    timestamp: new Date().toISOString(),
  }));

  for (const item of newItems) {
    try {
      // Build Article for Telegraph
      const article: Article = {
        title: item.title,
        body: item.contentEncoded,
        url: item.link,
        source: 'adprensa',
        date: item.pubDate,
      };

      // Create Telegraph page
      const result = await createPage(article);

      // Post Telegraph link to channel
      await sendWithRetry(
        () => api.sendMessage(chatId, result.url, { disable_notification: true }),
        'sendMessage',
      );

      posted.add(item.guid);
      await savePostedGuids(posted);

      await sleep(ITEM_DELAY);
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'adprensa_send_error',
        guid: item.guid,
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
      await sleep(ITEM_DELAY);
    }
  }
}

// --- Scheduler ---

function scheduleNext(api: Api, chatId: number, posted: Set<string>) {
  const jitter = (Math.random() * 2 - 1) * JITTER;
  const delay = BASE_INTERVAL + jitter;
  const minutes = (delay / 60_000).toFixed(1);

  console.log(JSON.stringify({
    event: 'adprensa_next_poll',
    delayMinutes: minutes,
    timestamp: new Date().toISOString(),
  }));

  setTimeout(async () => {
    try {
      await pollOnce(api, chatId, posted);
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'adprensa_poll_error',
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
    }
    scheduleNext(api, chatId, posted);
  }, delay);
}

export async function startAdprensaPoller(api: Api): Promise<void> {
  const chatId = parseInt(process.env.BANCOMEDIA_CHAT_ID || '', 10);
  if (!chatId || isNaN(chatId)) {
    console.log(JSON.stringify({
      event: 'adprensa_poller_disabled',
      reason: 'BANCOMEDIA_CHAT_ID not set',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  const posted = await loadPostedGuids();

  console.log(JSON.stringify({
    event: 'adprensa_poller_started',
    chatId,
    knownGuids: posted.size,
    timestamp: new Date().toISOString(),
  }));

  // On cold start, seed non-Pauta items to avoid reposting; let Pauta items through
  if (posted.size === 0) {
    try {
      const xml = await fetchRssFeed();
      const items = parseItems(xml);
      for (const item of items) {
        if (!item.categories.includes('Pauta')) posted.add(item.guid);
      }
      await savePostedGuids(posted);
      console.log(JSON.stringify({
        event: 'adprensa_seeded',
        count: items.length,
        timestamp: new Date().toISOString(),
      }));
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'adprensa_seed_error',
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  // First poll (on cold start, this posts the Pauta items not seeded)
  {
    try {
      await pollOnce(api, chatId, posted);
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'adprensa_initial_poll_error',
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  scheduleNext(api, chatId, posted);
}

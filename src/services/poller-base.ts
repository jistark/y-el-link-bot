import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Api } from 'grammy';
import { randomUA, sleep } from '../utils/shared.js';

// --- Types ---

export interface BaseRssItem {
  guid: string;
  title: string;
  link: string;
  contentEncoded: string;
}

export interface PollerConfig<T extends BaseRssItem = BaseRssItem> {
  name: string;                    // 'rss' | 'adprensa' — for event names and log prefixes
  feedUrl: string;                 // RSS feed URL
  postedPath: string;              // e.g. 'data/rss-posted.json'
  baseInterval?: number;           // default 15 min
  jitter?: number;                 // default 3 min
  maxPosted?: number;              // default 500
  itemDelay?: number;              // default 3s

  // Hooks — source-specific logic
  parseItems: (xml: string) => T[];
  filterNew: (items: T[], posted: Set<string>) => T[];
  processItem: (api: Api, chatId: number, item: T, posted: Set<string>, save: () => Promise<void>) => Promise<void>;
}

export interface PollerInstance {
  start: (api: Api) => Promise<void>;
  getPostedGuids: () => Promise<Set<string>>;
  fetchRssFeed: () => Promise<string>;
  savePostedGuids: (guids: Set<string>) => Promise<void>;
}

// --- Factory ---

export function createPoller<T extends BaseRssItem>(config: PollerConfig<T>): PollerInstance {
  const {
    name,
    feedUrl,
    postedPath,
    baseInterval = 15 * 60 * 1000,
    jitter = 3 * 60 * 1000,
    maxPosted = 500,
    itemDelay = 3_000,
    parseItems,
    filterNew,
    processItem,
  } = config;

  const fullPostedPath = join(process.cwd(), postedPath);

  // Shared in-memory set — used by both the poller and /ultimo command.
  // Memoize with Promise (not value) to prevent race condition: if /ultimo
  // fires while startPoller is still loading, both would see null and
  // create two independent Sets.
  let postedGuidsPromise: Promise<Set<string>> | null = null;

  function getPostedGuids(): Promise<Set<string>> {
    if (!postedGuidsPromise) postedGuidsPromise = loadPostedGuids();
    return postedGuidsPromise;
  }

  // --- Persistence ---

  async function loadPostedGuids(): Promise<Set<string>> {
    try {
      const data = await readFile(fullPostedPath, 'utf-8');
      return new Set(JSON.parse(data));
    } catch {
      return new Set();
    }
  }

  async function savePostedGuids(guids: Set<string>): Promise<void> {
    try { mkdirSync(join(process.cwd(), 'data'), { recursive: true }); } catch { /* ok */ }
    const arr = [...guids].slice(-maxPosted);
    await writeFile(fullPostedPath, JSON.stringify(arr), 'utf-8');
  }

  // --- RSS Fetching ---

  async function fetchRssFeed(): Promise<string> {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': randomUA() },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${name} RSS fetch failed: ${res.status}`);
    return res.text();
  }

  // --- Core ---

  async function pollOnce(api: Api, chatId: number, posted: Set<string>): Promise<void> {
    const xml = await fetchRssFeed();
    const allItems = parseItems(xml);
    const newItems = filterNew(allItems, posted);

    if (newItems.length === 0) return;

    console.log(JSON.stringify({
      event: `${name}_new_items`,
      count: newItems.length,
      timestamp: new Date().toISOString(),
    }));

    for (const item of newItems) {
      try {
        await processItem(api, chatId, item, posted, () => savePostedGuids(posted));
        await sleep(itemDelay);
      } catch (err: any) {
        console.error(JSON.stringify({
          event: `${name}_send_error`,
          guid: item.guid,
          error: err?.message || String(err),
          timestamp: new Date().toISOString(),
        }));
        // On persistent failure, still pace before next item
        await sleep(itemDelay);
      }
    }
  }

  // --- Scheduler ---

  function scheduleNext(api: Api, chatId: number, posted: Set<string>) {
    const j = (Math.random() * 2 - 1) * jitter;
    const delay = baseInterval + j;
    const minutes = (delay / 60_000).toFixed(1);

    console.log(JSON.stringify({
      event: `${name}_next_poll`,
      delayMinutes: minutes,
      timestamp: new Date().toISOString(),
    }));

    setTimeout(async () => {
      try {
        await pollOnce(api, chatId, posted);
      } catch (err: any) {
        console.error(JSON.stringify({
          event: `${name}_poll_error`,
          error: err?.message || String(err),
          timestamp: new Date().toISOString(),
        }));
      }
      scheduleNext(api, chatId, posted);
    }, delay);
  }

  // --- Startup ---

  async function start(api: Api): Promise<void> {
    const chatId = parseInt(process.env.POLLER_CHAT_ID || '', 10);
    if (!chatId || isNaN(chatId)) {
      console.log(JSON.stringify({
        event: `${name}_poller_disabled`,
        reason: 'POLLER_CHAT_ID not set',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    const posted = await getPostedGuids();

    console.log(JSON.stringify({
      event: `${name}_poller_started`,
      chatId,
      knownGuids: posted.size,
      timestamp: new Date().toISOString(),
    }));

    // On cold start (no persisted GUIDs), seed with current feed to avoid reposting
    if (posted.size === 0) {
      try {
        const xml = await fetchRssFeed();
        const items = parseItems(xml);
        for (const item of items) posted.add(item.guid);
        await savePostedGuids(posted);
        console.log(JSON.stringify({
          event: `${name}_seeded`,
          count: items.length,
          timestamp: new Date().toISOString(),
        }));
      } catch (err: any) {
        console.error(JSON.stringify({
          event: `${name}_seed_error`,
          error: err?.message || String(err),
          timestamp: new Date().toISOString(),
        }));
      }
    } else {
      // Normal first poll
      try {
        await pollOnce(api, chatId, posted);
      } catch (err: any) {
        console.error(JSON.stringify({
          event: `${name}_initial_poll_error`,
          error: err?.message || String(err),
          timestamp: new Date().toISOString(),
        }));
      }
    }

    scheduleNext(api, chatId, posted);
  }

  return { start, getPostedGuids, fetchRssFeed, savePostedGuids };
}

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Api } from 'grammy';
import type { Article } from '../types.js';
import { createPage, deletePage } from '../formatters/telegraph.js';
import { randomUA, decodeEntities, sleep, sendWithRetry } from '../utils/shared.js';

const RSS_FEED_URL = 'https://adprensa.cl/feed/';
const BASE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const JITTER = 3 * 60 * 1000;         // ±3 minutes
const MAX_POSTED = 500;
const ITEM_DELAY = 3_000;

const POSTED_PATH = join(process.cwd(), 'data', 'adprensa-posted.json');

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


// --- Content preprocessing ---

// Detect if content is a contact list (table with emails/phones)
function isContactList(html: string): boolean {
  return /<table[\s>]/i.test(html) && /(?:e-?mail|fono|celular)/i.test(html);
}

// Transform pauta/agenda content: sections → headings, dash-items → lists
function preprocessPautaContent(html: string): string {
  let result = html;

  // Pattern 1: ==== lines wrapping a section title (strong or plain)
  // <p>====================<br />\nPRESIDENCIAL<br />\n====================</p>
  // Also handles <strong> variants
  result = result.replace(
    /<p>\s*(?:<strong>)?[=]{3,}(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?([\s\S]*?)(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?[=]{3,}(?:<\/strong>)?\s*<\/p>/gi,
    (_match, title) => `<h3>${title.trim()}</h3>`
  );

  // Pattern 2: ——— lines wrapping a subsection title
  // <p>———————<br />\nATENCIÓN CON<br />\n———————</p>
  result = result.replace(
    /<p>\s*(?:<strong>)?[—–\-]{3,}(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?([\s\S]*?)(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?[—–\-]{3,}(?:<\/strong>)?\s*<\/p>/gi,
    (_match, title) => `<h4>${title.trim()}</h4>`
  );

  // Pattern 3: Standalone separator lines (just dashes) → remove
  result = result.replace(/<p>\s*(?:<strong>)?[—–\-=]{3,}(?:<\/strong>)?\s*<\/p>/gi, '');

  // Pattern 4: Paragraphs starting with - → list items, group consecutive ones
  // First, convert individual -items to <li>
  result = result.replace(
    /<p>\s*[-–]\s*([\s\S]*?)\s*<\/p>/gi,
    '<li>$1</li>'
  );

  // Wrap consecutive <li> blocks in <ul>
  result = result.replace(
    /((?:<li>[\s\S]*?<\/li>\s*)+)/gi,
    '<ul>$1</ul>'
  );

  return result;
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
      const contactList = isContactList(item.contentEncoded);
      const body = contactList ? item.contentEncoded : preprocessPautaContent(item.contentEncoded);

      // Build Article for Telegraph
      const article: Article = {
        title: item.title,
        body,
        url: item.link,
        source: 'adprensa',
        date: item.pubDate,
      };

      // Create Telegraph page
      const result = await createPage(article);

      // Contact lists expire after 72h (contain emails/phones)
      if (contactList) {
        const LISTADO_TTL = 72 * 60 * 60 * 1000;
        setTimeout(() => {
          deletePage(result.path).catch(() => {});
          console.log(JSON.stringify({
            event: 'adprensa_listado_expired',
            path: result.path,
            timestamp: new Date().toISOString(),
          }));
        }, LISTADO_TTL);
      }

      // Post Telegraph link to channel
      await sendWithRetry(
        () => api.sendMessage(chatId, result.url, { disable_notification: true }),
        'sendMessage', 'adprensa',
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

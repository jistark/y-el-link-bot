import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Api, Bot } from 'grammy';

const RSS_FEED_URL = 'https://senal.mediabanco.com/feed/';
const BASE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const JITTER = 3 * 60 * 1000;         // ±3 minutes
const MAX_POSTED = 500;

const POSTED_PATH = join(process.cwd(), 'data', 'rss-posted.json');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

interface RssItem {
  guid: string;
  title: string;
  contentEncoded: string;
}

interface MediaLinks {
  vimeoUrl: string | null;
  videoHdLink: string | null;
  fotosLink: string | null;
  clave: string | null;
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
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const res = await fetch(RSS_FEED_URL, {
    headers: { 'User-Agent': ua },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
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
    const contentMatch = block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);

    if (titleMatch && guidMatch && contentMatch) {
      items.push({
        guid: guidMatch[1].trim(),
        title: decodeEntities(titleMatch[1].trim()),
        contentEncoded: contentMatch[1],
      });
    }
  }

  return items;
}

function extractMediaLinks(html: string): MediaLinks {
  // Vimeo embed URL
  const vimeoMatch = html.match(/player\.vimeo\.com\/video\/(\d+)/);
  const vimeoUrl = vimeoMatch ? `https://player.vimeo.com/video/${vimeoMatch[1]}` : null;

  // WeTransfer links - they follow "Link de descarga Video HD:" and "Link de descarga Fotos:"
  const videoHdMatch = html.match(/Link de descarga Video HD:\s*<a\s+href="([^"]+)"/);
  const fotosMatch = html.match(/Link de descarga Fotos:\s*<a\s+href="([^"]+)"/);

  // Clave de Descarga - inside a span or plain text
  const claveMatch = html.match(/Clave de Descarga:\s*([A-Za-z0-9]+)/);

  return {
    vimeoUrl,
    videoHdLink: videoHdMatch?.[1] || null,
    fotosLink: fotosMatch?.[1] || null,
    clave: claveMatch?.[1] || null,
  };
}

// --- Formatting ---

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMessage(item: RssItem, media: MediaLinks): string {
  const lines: string[] = [];

  lines.push(`\u{1F4F9} <b>${escapeHtml(item.title)}</b>`);

  if (media.vimeoUrl) {
    lines.push('');
    lines.push(`\u{1F3AC} ${media.vimeoUrl}`);
  }

  if (media.videoHdLink || media.fotosLink) {
    lines.push('');
    if (media.videoHdLink) lines.push(`\u{1F4E5} Video HD: ${media.videoHdLink}`);
    if (media.fotosLink) lines.push(`\u{1F4E5} Fotos: ${media.fotosLink}`);
  }

  if (media.clave) {
    lines.push(`\u{1F511} Clave: ${media.clave}`);
  }

  return lines.join('\n');
}

// --- Core ---

async function pollOnce(api: Api, chatId: number, posted: Set<string>): Promise<void> {
  const xml = await fetchRssFeed();
  const items = parseItems(xml);

  // Process oldest-first so channel shows them in chronological order
  const newItems = items.filter(item => !posted.has(item.guid)).reverse();

  if (newItems.length === 0) return;

  console.log(JSON.stringify({
    event: 'rss_new_items',
    count: newItems.length,
    timestamp: new Date().toISOString(),
  }));

  for (const item of newItems) {
    const media = extractMediaLinks(item.contentEncoded);

    // Skip items with no useful links
    if (!media.vimeoUrl && !media.videoHdLink && !media.fotosLink) continue;

    const message = formatMessage(item, media);

    try {
      await api.sendMessage(chatId, message, { parse_mode: 'HTML', disable_notification: true });
      posted.add(item.guid);
      await savePostedGuids(posted);
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'rss_send_error',
        guid: item.guid,
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }
}

// --- Scheduler ---

function scheduleNext(api: Api, chatId: number, posted: Set<string>) {
  const jitter = (Math.random() * 2 - 1) * JITTER;
  const delay = BASE_INTERVAL + jitter;
  const minutes = (delay / 60_000).toFixed(1);

  console.log(JSON.stringify({
    event: 'rss_next_poll',
    delayMinutes: minutes,
    timestamp: new Date().toISOString(),
  }));

  setTimeout(async () => {
    try {
      await pollOnce(api, chatId, posted);
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'rss_poll_error',
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
    }
    scheduleNext(api, chatId, posted);
  }, delay);
}

export async function startRssPoller(api: Api): Promise<void> {
  const chatId = parseInt(process.env.BANCOMEDIA_CHAT_ID || '', 10);
  if (!chatId || isNaN(chatId)) {
    console.log(JSON.stringify({
      event: 'rss_poller_disabled',
      reason: 'BANCOMEDIA_CHAT_ID not set',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  const posted = await loadPostedGuids();

  console.log(JSON.stringify({
    event: 'rss_poller_started',
    chatId,
    knownGuids: posted.size,
    timestamp: new Date().toISOString(),
  }));

  // First poll immediately
  try {
    await pollOnce(api, chatId, posted);
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'rss_initial_poll_error',
      error: err?.message || String(err),
      timestamp: new Date().toISOString(),
    }));
  }

  scheduleNext(api, chatId, posted);
}

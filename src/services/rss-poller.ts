import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { InputFile } from 'grammy';
import type { Api } from 'grammy';
import { randomUA, decodeEntities, sleep, sendWithRetry } from '../utils/shared.js';

const RSS_FEED_URL = 'https://senal.mediabanco.com/feed/';
const BASE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const JITTER = 3 * 60 * 1000;         // ±3 minutes
const MAX_POSTED = 500;

const POSTED_PATH = join(process.cwd(), 'data', 'rss-posted.json');

interface RssItem {
  guid: string;
  title: string;
  contentEncoded: string;
}

interface MediaLinks {
  vimeoId: string | null;
  fotosLink: string | null;
  clave: string | null;
}

interface WtFile {
  id: string;
  name: string;
  size: number;
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

// --- RSS Fetching ---

async function fetchRssFeed(): Promise<string> {
  const res = await fetch(RSS_FEED_URL, {
    headers: { 'User-Agent': randomUA() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  return res.text();
}

// --- WeTransfer ---

async function resolveWetransferUrl(shortUrl: string): Promise<{ transferId: string; securityHash: string } | null> {
  try {
    const res = await fetch(shortUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': randomUA() },
      signal: AbortSignal.timeout(15_000),
    });
    const location = res.headers.get('location');
    if (!location) return null;

    // URL format: .../downloads/{transferId}/{securityHash}?...
    const match = location.match(/\/downloads\/([a-f0-9]+)\/([a-f0-9]+)/);
    if (!match) return null;

    return { transferId: match[1], securityHash: match[2] };
  } catch {
    return null;
  }
}

async function getWetransferFiles(transferId: string, securityHash: string, password: string): Promise<WtFile[]> {
  const res = await fetch(`https://wetransfer.com/api/v4/transfers/${transferId}/prepare-download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': randomUA() },
    body: JSON.stringify({ security_hash: securityHash, password, intent: 'entire_transfer' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const data = await res.json() as any;
  if (data.state !== 'downloadable') return [];
  return (data.items || []).map((item: any) => ({
    id: item.id,
    name: item.name,
    size: item.size || 0,
  }));
}

async function getWetransferFileUrl(transferId: string, securityHash: string, password: string, fileId: string): Promise<string | null> {
  const res = await fetch(`https://wetransfer.com/api/v4/transfers/${transferId}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': randomUA() },
    body: JSON.stringify({ security_hash: securityHash, password, intent: 'single_file', file_ids: [fileId] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  return data.direct_link || null;
}


// --- RSS Parsing ---


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
  const vimeoMatch = html.match(/player\.vimeo\.com\/video\/(\d+)/);

  const fotosMatch = html.match(/Link de descarga Fotos:\s*<a\s+href="([^"]+)"/);
  const claveMatch = html.match(/Clave de Descarga:\s*([A-Za-z0-9]+)/);

  return {
    vimeoId: vimeoMatch?.[1] || null,
    fotosLink: fotosMatch?.[1] || null,
    clave: claveMatch?.[1] || null,
  };
}

// Fetch Vimeo thumbnail via oEmbed
async function getVimeoThumbnail(vimeoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${vimeoId}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.thumbnail_url || null;
  } catch {
    return null;
  }
}

// Get a single photo: try Vimeo oEmbed thumbnail first, then first WeTransfer photo
async function getSinglePhoto(media: MediaLinks): Promise<{ buf: Uint8Array; name: string } | null> {
  // Try Vimeo thumbnail
  if (media.vimeoId) {
    const thumbUrl = await getVimeoThumbnail(media.vimeoId);
    if (thumbUrl) {
      try {
        const res = await fetch(thumbUrl, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          return { buf, name: 'thumbnail.jpg' };
        }
      } catch { /* fallthrough to WeTransfer */ }
    }
  }

  // Fallback: first WeTransfer photo
  if (media.fotosLink && media.clave) {
    const resolved = await resolveWetransferUrl(media.fotosLink);
    if (resolved) {
      const files = await getWetransferFiles(resolved.transferId, resolved.securityHash, media.clave);
      const imageFile = files.find(f => /\.(jpe?g|png)$/i.test(f.name));
      if (imageFile) {
        const url = await getWetransferFileUrl(resolved.transferId, resolved.securityHash, media.clave, imageFile.id);
        if (url) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (res.ok) {
              const buf = new Uint8Array(await res.arrayBuffer());
              return { buf, name: imageFile.name };
            }
          } catch { /* no photo available */ }
        }
      }
    }
  }

  return null;
}

// --- Formatting ---

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatCaption(item: RssItem, media: MediaLinks): string {
  const lines: string[] = [];
  lines.push(`\u{1F4F9} <b>${escapeHtml(item.title)}</b>`);

  if (media.clave) {
    lines.push(`\u{1F511} Clave: ${media.clave}`);
  }

  return lines.join('\n');
}

// --- Telegram helpers ---

const ITEM_DELAY = 3_000; // 3s between items to avoid rate limits

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

    // Skip items with no media (mark as posted to avoid re-evaluation)
    if (!media.vimeoId && !media.fotosLink) {
      posted.add(item.guid);
      continue;
    }

    const caption = formatCaption(item, media);

    try {
      // Try to get a single photo (Vimeo thumbnail or first WeTransfer photo)
      const photo = await getSinglePhoto(media);

      if (photo) {
        // Send as photo message with caption
        await sendWithRetry(
          () => api.sendPhoto(chatId, new InputFile(photo.buf, photo.name), {
            caption,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
          'sendPhoto', 'rss',
        );
      } else {
        // Fallback: text-only message
        await sendWithRetry(
          () => api.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_notification: true }),
          'sendMessage', 'rss',
        );
      }

      posted.add(item.guid);
      await savePostedGuids(posted);

      // Pace between items to avoid Telegram rate limits
      await sleep(ITEM_DELAY);
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'rss_send_error',
        guid: item.guid,
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
      // On persistent failure, still pace before next item
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

  // On cold start (no persisted GUIDs), seed with current feed to avoid reposting
  if (posted.size === 0) {
    try {
      const xml = await fetchRssFeed();
      const items = parseItems(xml);
      for (const item of items) posted.add(item.guid);
      await savePostedGuids(posted);
      console.log(JSON.stringify({
        event: 'rss_seeded',
        count: items.length,
        timestamp: new Date().toISOString(),
      }));
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'rss_seed_error',
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
        event: 'rss_initial_poll_error',
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  scheduleNext(api, chatId, posted);
}

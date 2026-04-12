import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { InputFile, InputMediaBuilder } from 'grammy';
import type { Api } from 'grammy';
import { randomUA, decodeEntities, sleep, sendWithRetry } from '../utils/shared.js';
import { addRegistryEntry } from './registry.js';

const RSS_FEED_URL = 'https://senal.mediabanco.com/feed/';
const BASE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const JITTER = 3 * 60 * 1000;         // ±3 minutes
const MAX_POSTED = 500;

const POSTED_PATH = join(process.cwd(), 'data', 'rss-posted.json');

// Shared in-memory set — used by both the poller and /ultimo command.
// Memoize with Promise (not value) to prevent race condition: if /ultimo
// fires while startRssPoller is still loading, both would see null and
// create two independent Sets.
let postedGuidsPromise: Promise<Set<string>> | null = null;

function getPostedGuids(): Promise<Set<string>> {
  if (!postedGuidsPromise) postedGuidsPromise = loadPostedGuids();
  return postedGuidsPromise;
}

interface RssItem {
  guid: string;
  title: string;
  link: string;
  contentEncoded: string;
}

interface MediaLinks {
  vimeoId: string | null;
  fotosLink: string | null;
  videoLink: string | null;
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
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const contentMatch = block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);

    if (titleMatch && guidMatch && contentMatch) {
      items.push({
        guid: guidMatch[1].trim(),
        title: decodeEntities(titleMatch[1].trim()),
        link: linkMatch?.[1]?.trim() || '',
        contentEncoded: contentMatch[1],
      });
    }
  }

  return items;
}

function extractMediaLinks(html: string): MediaLinks {
  const vimeoMatch = html.match(/player\.vimeo\.com\/video\/(\d+)/);

  // Allow any HTML tags (e.g. </span>) between label text and <a> tag —
  // Gmail-to-WordPress pipeline wraps labels in <span> elements.
  const fotosMatch = html.match(/Link de descarga Fotos:[\s\S]*?<a\s[^>]*href="([^"]+)"/);
  const videoMatch = html.match(/Link de descarga Video(?:\s*HD)?:[\s\S]*?<a\s[^>]*href="([^"]+)"/);
  const claveMatch = html.match(/Clave de Descarga:\s*([A-Za-z0-9]+)/);

  return {
    vimeoId: vimeoMatch?.[1] || null,
    fotosLink: fotosMatch?.[1] || null,
    videoLink: videoMatch?.[1] || null,
    clave: claveMatch?.[1] || null,
  };
}

// Vimeo thumbnail via direct CDN URL pattern — works for domain-restricted
// videos where oEmbed returns no thumbnail (domain_status_code 403).
async function getVimeoThumbnail(vimeoId: string): Promise<string | null> {
  const url = `https://i.vimeocdn.com/video/${vimeoId}_1280x720.jpg`;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

const MAX_PHOTOS = 10; // Telegram sendMediaGroup limit
const MAX_PHOTO_SIZE = 9 * 1024 * 1024; // 9 MB safety margin (Telegram limit is 10 MB)

// Get photos: Vimeo thumbnail as first, then WeTransfer photos
async function getPhotos(media: MediaLinks): Promise<{ buf: Uint8Array; name: string }[]> {
  const photos: { buf: Uint8Array; name: string }[] = [];

  // Try Vimeo thumbnail as lead photo
  if (media.vimeoId) {
    const thumbUrl = await getVimeoThumbnail(media.vimeoId);
    if (thumbUrl) {
      try {
        const res = await fetch(thumbUrl, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length <= MAX_PHOTO_SIZE) {
            photos.push({ buf, name: 'thumbnail.jpg' });
          }
        }
      } catch { /* skip */ }
    }
  }

  // Add WeTransfer photos
  if (media.fotosLink && media.clave && photos.length < MAX_PHOTOS) {
    const resolved = await resolveWetransferUrl(media.fotosLink);
    if (resolved) {
      const files = await getWetransferFiles(resolved.transferId, resolved.securityHash, media.clave);
      const imageFiles = files.filter(f => /\.(jpe?g|png)$/i.test(f.name))
        .filter(f => f.size <= MAX_PHOTO_SIZE)
        .slice(0, MAX_PHOTOS - photos.length);

      for (const file of imageFiles) {
        const url = await getWetransferFileUrl(resolved.transferId, resolved.securityHash, media.clave, file.id);
        if (url) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (res.ok) {
              const buf = new Uint8Array(await res.arrayBuffer());
              if (buf.length <= MAX_PHOTO_SIZE) {
                photos.push({ buf, name: file.name });
              }
            }
          } catch { /* skip this photo */ }
        }
      }
    }
  }

  return photos;
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

  if (item.link) {
    lines.push(`\u{1F3AC} <a href="${escapeHtml(item.link)}">Video</a>`);
  }

  if (media.videoLink) {
    lines.push(`\u{2B07}\u{FE0F} <a href="${escapeHtml(media.videoLink)}">Video HD</a>`);
  }

  if (media.fotosLink) {
    lines.push(`\u{1F4F7} <a href="${escapeHtml(media.fotosLink)}">Fotos</a>`);
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

    // Log extraction results so format changes are caught early
    if (media.vimeoId && (!media.fotosLink || !media.videoLink || !media.clave)) {
      console.log(JSON.stringify({
        event: 'rss_media_partial',
        guid: item.guid,
        title: item.title,
        has: { vimeo: !!media.vimeoId, fotos: !!media.fotosLink, video: !!media.videoLink, clave: !!media.clave },
        timestamp: new Date().toISOString(),
      }));
    }

    // Skip items with no media (mark as posted to avoid re-evaluation)
    if (!media.vimeoId && !media.fotosLink) {
      posted.add(item.guid);
      continue;
    }

    const caption = formatCaption(item, media);

    try {
      const photos = await getPhotos(media);

      if (photos.length >= 2) {
        // Send as media group (album) — caption on first photo
        const mediaGroup = photos.map((p, i) =>
          InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? {
            caption,
            parse_mode: 'HTML',
          } : {}),
        );
        await sendWithRetry(
          () => api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true }),
          'sendMediaGroup', 'rss',
        );
      } else if (photos.length === 1) {
        // Single photo
        await sendWithRetry(
          () => api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
            caption,
            parse_mode: 'HTML',
            disable_notification: true,
          }),
          'sendPhoto', 'rss',
        );
      } else {
        // No photos — text-only
        await sendWithRetry(
          () => api.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_notification: true }),
          'sendMessage', 'rss',
        );
      }

      posted.add(item.guid);
      await savePostedGuids(posted);

      // Persist to registry (survives redeploys)
      addRegistryEntry({
        type: 'rss-senal',
        originalUrl: item.link,
        guid: item.guid,
        source: 'senal',
        title: item.title,
        chatId,
      }).catch(() => {}); // non-blocking

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

// Fetch and send the latest Señal item (for manual /ultimo command)
export async function fetchLatestSenal(api: Api, chatId: number, threadId?: number): Promise<boolean> {
  const xml = await fetchRssFeed();
  const items = parseItems(xml);

  // Find first item with media
  const item = items.find(i => {
    const m = extractMediaLinks(i.contentEncoded);
    return m.vimeoId || m.fotosLink;
  });

  if (!item) return false;

  const media = extractMediaLinks(item.contentEncoded);
  const caption = formatCaption(item, media);
  const photos = await getPhotos(media);
  const threadOpts = threadId ? { message_thread_id: threadId } : {};

  if (photos.length >= 2) {
    const mediaGroup = photos.map((p, i) =>
      InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? {
        caption,
        parse_mode: 'HTML' as const,
      } : {}),
    );
    await api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true, ...threadOpts });
  } else if (photos.length === 1) {
    await api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
      caption, parse_mode: 'HTML', disable_notification: true, ...threadOpts,
    });
  } else {
    await api.sendMessage(chatId, caption, {
      parse_mode: 'HTML', disable_notification: true,
      link_preview_options: { is_disabled: true }, ...threadOpts,
    });
  }

  // Mark as posted in shared set so the poller doesn't duplicate it
  const posted = await getPostedGuids();
  posted.add(item.guid);
  await savePostedGuids(posted);

  return true;
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

  const posted = await getPostedGuids();

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

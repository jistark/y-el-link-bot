import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { InputFile } from 'grammy';
import type { Api } from 'grammy';
import type { InputMediaPhoto } from 'grammy/types';

const RSS_FEED_URL = 'https://senal.mediabanco.com/feed/';
const BASE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const JITTER = 3 * 60 * 1000;         // ±3 minutes
const MAX_POSTED = 500;
const MAX_PHOTOS = 10; // Telegram sendMediaGroup limit

const POSTED_PATH = join(process.cwd(), 'data', 'rss-posted.json');

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
  contentEncoded: string;
}

interface MediaLinks {
  vimeoUrl: string | null;
  videoHdLink: string | null;
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

async function downloadWetransferPhotos(
  fotosUrl: string,
  password: string,
): Promise<{ buf: Uint8Array; name: string }[]> {
  const resolved = await resolveWetransferUrl(fotosUrl);
  if (!resolved) return [];

  const files = await getWetransferFiles(resolved.transferId, resolved.securityHash, password);
  // Only JPG/PNG images
  const imageFiles = files.filter(f => /\.(jpe?g|png)$/i.test(f.name)).slice(0, MAX_PHOTOS);
  if (imageFiles.length === 0) return [];

  const photos: { buf: Uint8Array; name: string }[] = [];
  for (const file of imageFiles) {
    try {
      const url = await getWetransferFileUrl(resolved.transferId, resolved.securityHash, password, file.id);
      if (!url) continue;
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      photos.push({ buf, name: file.name });
    } catch {
      // Skip failed downloads, continue with remaining
    }
  }

  return photos;
}

// --- RSS Parsing ---

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
  const vimeoMatch = html.match(/player\.vimeo\.com\/video\/(\d+)/);
  const vimeoUrl = vimeoMatch ? `https://vimeo.com/${vimeoMatch[1]}` : null;

  const videoHdMatch = html.match(/Link de descarga Video HD:\s*<a\s+href="([^"]+)"/);
  const fotosMatch = html.match(/Link de descarga Fotos:\s*<a\s+href="([^"]+)"/);

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
      // Send text message first
      await api.sendMessage(chatId, message, { parse_mode: 'HTML', disable_notification: true });

      // Download and send photos from WeTransfer
      if (media.fotosLink && media.clave) {
        try {
          const photos = await downloadWetransferPhotos(media.fotosLink, media.clave);
          if (photos.length > 0) {
            const mediaGroup: InputMediaPhoto[] = photos.map((photo, i) => ({
              type: 'photo' as const,
              media: new InputFile(photo.buf, photo.name),
              ...(i === 0 ? { caption: escapeHtml(item.title), parse_mode: 'HTML' as const } : {}),
            }));
            await api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true });
          }
        } catch (err: any) {
          console.error(JSON.stringify({
            event: 'rss_photos_error',
            guid: item.guid,
            error: err?.message || String(err),
            timestamp: new Date().toISOString(),
          }));
          // Text message was sent, photos failed — not fatal
        }
      }

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

import { InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import type { Api } from 'grammy';
import { randomUA, decodeEntities, sendWithRetry } from '../utils/shared.js';
import { addRegistryEntry } from './registry.js';
import { createPoller } from './poller-base.js';
import type { BaseRssItem } from './poller-base.js';

// --- Types ---

export interface SenalRssItem extends BaseRssItem {
  // BaseRssItem already covers guid, title, link, contentEncoded
}

// Alias used internally — the renamed type was exported for external use
type RssItem = SenalRssItem;

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

// --- Regen keyboard ---

function createRssRegenKeyboard(source: string, guid: string): InlineKeyboard {
  const guidHash = guid.slice(0, 20);
  return new InlineKeyboard().text('\u{1F504}', `regen_rss:${source}:${guidHash}`);
}

// --- RSS Parsing ---

export function parseSenalItems(xml: string): SenalRssItem[] {
  const items: SenalRssItem[] = [];
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

// --- Media extraction ---

export function extractMediaLinks(html: string): MediaLinks {
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

// Vimeo thumbnail from player config — fetches the player page with Referer
// to get the real thumbnail_url (domain-restricted videos return a generic
// placeholder via the CDN pattern).
async function getVimeoThumbnail(vimeoId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://player.vimeo.com/video/${vimeoId}`, {
      headers: {
        'Referer': 'https://senal.mediabanco.com/',
        'Origin': 'https://senal.mediabanco.com',
        'User-Agent': randomUA(),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Extract config JSON that starts with {"cdn_url"
    const start = html.indexOf('{"cdn_url"');
    if (start === -1) return null;

    // Find matching closing brace
    let depth = 0;
    let end = start;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') depth--;
      if (depth === 0) { end = i + 1; break; }
    }

    const config = JSON.parse(html.slice(start, end));
    const thumbUrl = config?.video?.thumbnail_url;
    if (!thumbUrl) return null;

    // Append size params for 720p quality
    return `${thumbUrl}?mw=1280&mh=720&q=70`;
  } catch {
    return null;
  }
}

const MAX_PHOTOS = 10; // Telegram sendMediaGroup limit
const MAX_PHOTO_SIZE = 9 * 1024 * 1024; // 9 MB safety margin (Telegram limit is 10 MB)

// Get photos: Vimeo thumbnail as first, then WeTransfer photos
export async function getPhotos(media: MediaLinks): Promise<{ buf: Uint8Array; name: string }[]> {
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

export function formatCaption(item: SenalRssItem, media: MediaLinks): string {
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

// --- Poller instance ---

const poller = createPoller<SenalRssItem>({
  name: 'rss',
  feedUrl: 'https://senal.mediabanco.com/feed/',
  postedPath: 'data/rss-posted.json',
  parseItems: parseSenalItems,
  filterNew(items, posted) {
    // Process oldest-first so channel shows them in chronological order
    return items.filter(item => !posted.has(item.guid)).reverse();
  },
  async processItem(api, chatId, item, posted, save) {
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
      return;
    }

    const caption = formatCaption(item, media);
    const photos = await getPhotos(media);
    const keyboard = createRssRegenKeyboard('senal', item.guid);
    let messageId: number | undefined;

    if (photos.length >= 2) {
      // Send as media group (album) — caption on first photo
      const mediaGroup = photos.map((p, i) =>
        InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? {
          caption,
          parse_mode: 'HTML',
        } : {}),
      );
      const sent = await sendWithRetry(
        () => api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true }),
        'sendMediaGroup', 'rss',
      );
      // Media groups return array of messages — use first one's ID
      messageId = sent[0]?.message_id;
      // Media groups can't have inline keyboards, so send a follow-up with the regen button
      await sendWithRetry(
        () => api.sendMessage(chatId, '\u{1F504}', {
          disable_notification: true,
          reply_markup: keyboard,
          reply_to_message_id: messageId,
        }),
        'sendMessage', 'rss',
      );
    } else if (photos.length === 1) {
      // Single photo with regen keyboard
      const sent = await sendWithRetry(
        () => api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
          caption,
          parse_mode: 'HTML',
          disable_notification: true,
          reply_markup: keyboard,
        }),
        'sendPhoto', 'rss',
      );
      messageId = sent.message_id;
    } else {
      // No photos — text-only with regen keyboard
      const sent = await sendWithRetry(
        () => api.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          disable_notification: true,
          reply_markup: keyboard,
        }),
        'sendMessage', 'rss',
      );
      messageId = sent.message_id;
    }

    posted.add(item.guid);
    await save();

    // Persist to registry (survives redeploys)
    addRegistryEntry({
      type: 'rss-senal',
      originalUrl: item.link,
      guid: item.guid,
      source: 'senal',
      title: item.title,
      chatId,
      messageId,
    }).catch(() => {}); // non-blocking
  },
});

// --- Public API (unchanged signatures) ---

// Fetch and send the latest Senal item (for manual /ultimo command)
export async function fetchLatestSenal(api: Api, chatId: number, threadId?: number): Promise<boolean> {
  const xml = await poller.fetchRssFeed();
  const items = parseSenalItems(xml);

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
  const keyboard = createRssRegenKeyboard('senal', item.guid);
  let messageId: number | undefined;

  if (photos.length >= 2) {
    const mediaGroup = photos.map((p, i) =>
      InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? {
        caption,
        parse_mode: 'HTML' as const,
      } : {}),
    );
    const sent = await api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true, ...threadOpts });
    messageId = sent[0]?.message_id;
    // Media groups can't have inline keyboards, send a follow-up regen button
    await api.sendMessage(chatId, '\u{1F504}', {
      disable_notification: true,
      reply_markup: keyboard,
      reply_to_message_id: messageId,
      ...threadOpts,
    });
  } else if (photos.length === 1) {
    const sent = await api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
      caption, parse_mode: 'HTML', disable_notification: true, reply_markup: keyboard, ...threadOpts,
    });
    messageId = sent.message_id;
  } else {
    const sent = await api.sendMessage(chatId, caption, {
      parse_mode: 'HTML', disable_notification: true, reply_markup: keyboard,
      link_preview_options: { is_disabled: true }, ...threadOpts,
    });
    messageId = sent.message_id;
  }

  // Mark as posted in shared set so the poller doesn't duplicate it
  const posted = await poller.getPostedGuids();
  posted.add(item.guid);
  await poller.savePostedGuids(posted);

  // Persist to registry
  addRegistryEntry({
    type: 'rss-senal',
    originalUrl: item.link,
    guid: item.guid,
    source: 'senal',
    title: item.title,
    chatId,
    messageId,
  }).catch(() => {});

  return true;
}

export async function fetchSenalFeed(): Promise<string> {
  return poller.fetchRssFeed();
}

export async function startRssPoller(api: Api): Promise<void> {
  return poller.start(api);
}

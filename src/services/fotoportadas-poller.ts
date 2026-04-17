import { InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import type { Api } from 'grammy';
import { decodeEntities, sendWithRetry } from '../utils/shared.js';
import { addRegistryEntry } from './registry.js';
import { createPoller } from './poller-base.js';
import type { BaseRssItem } from './poller-base.js';

// --- Types ---

export interface FotoportadasRssItem extends BaseRssItem {
  pubDate: string;
}

// --- Parsing ---

export function parseFotoportadasItems(xml: string): FotoportadasRssItem[] {
  const items: FotoportadasRssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const contentMatch = block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);

    if (titleMatch && guidMatch && contentMatch) {
      items.push({
        guid: guidMatch[1].trim(),
        title: decodeEntities(titleMatch[1].trim()),
        link: linkMatch?.[1]?.trim() || '',
        contentEncoded: contentMatch[1],
        pubDate: pubDateMatch?.[1]?.trim() || '',
      });
    }
  }

  return items;
}

// --- Image extraction ---

const MAX_PHOTO_SIZE = 9 * 1024 * 1024; // 9 MB safety margin

export function extractFotoportadaImages(html: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const imgRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imgRegex.exec(html)) !== null) {
    const url = match[1];
    // Keep only mcusercontent.com images (actual newspaper front pages)
    // Skip sawa-dev storage images (logo), deduplicate (email HTML repeats 3x)
    if (url.includes('mcusercontent.com') && !url.includes('sawa-dev') && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

// Download images as buffers for Telegram media group
export async function downloadPhotos(urls: string[]): Promise<{ buf: Uint8Array; name: string }[]> {
  const photos: { buf: Uint8Array; name: string }[] = [];
  for (const url of urls.slice(0, 10)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_PHOTO_SIZE) continue;
      const ext = url.endsWith('.jpg') ? 'jpg' : 'png';
      photos.push({ buf, name: `portada_${photos.length}.${ext}` });
    } catch { /* skip */ }
  }
  return photos;
}

// --- Regen keyboard ---

export function createRssRegenKeyboard(source: string, guid: string): InlineKeyboard {
  const guidHash = guid.slice(0, 20);
  return new InlineKeyboard().text('\u{1F504}', `regen_rss:${source}:${guidHash}`);
}

// --- Poller instance ---

const poller = createPoller<FotoportadasRssItem>({
  name: 'fotoportadas',
  feedUrl: 'https://us14.campaign-archive.com/feed?u=41850a74f5ef0d136bc85f974&id=ee58f858f7',
  postedPath: 'data/fotoportadas-posted.json',
  baseInterval: 30 * 60 * 1000,
  jitter: 5 * 60 * 1000,
  parseItems: parseFotoportadasItems,
  filterNew(items, posted) {
    // Only items whose title starts with "Fotoportadas", oldest-first
    return items.filter(item => item.title.startsWith('Fotoportadas') && !posted.has(item.guid)).reverse();
  },
  async processItem(api, chatId, item, posted, save) {
    const urls = extractFotoportadaImages(item.contentEncoded);

    if (urls.length === 0) {
      console.log(JSON.stringify({
        event: 'fotoportadas_no_images',
        guid: item.guid,
        title: item.title,
        timestamp: new Date().toISOString(),
      }));
      posted.add(item.guid);
      await save();
      return;
    }

    const photos = await downloadPhotos(urls);
    if (photos.length === 0) {
      posted.add(item.guid);
      await save();
      return;
    }

    // Send as photo album (carousel) — caption on first photo
    const caption = `\u{1F4F0} <b>${item.title}</b>`;
    let messageId: number | undefined;

    if (photos.length >= 2) {
      const mediaGroup = photos.map((p, i) =>
        InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? {
          caption,
          parse_mode: 'HTML' as const,
        } : {}),
      );
      const sent = await sendWithRetry(
        () => api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true }),
        'sendMediaGroup', 'fotoportadas',
      );
      messageId = sent[0]?.message_id;
    } else {
      const sent = await sendWithRetry(
        () => api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
          caption,
          parse_mode: 'HTML',
          disable_notification: true,
          reply_markup: createRssRegenKeyboard('fotoportadas', item.guid),
        }),
        'sendPhoto', 'fotoportadas',
      );
      messageId = sent.message_id;
    }

    posted.add(item.guid);
    await save();

    addRegistryEntry({
      type: 'rss-fotoportadas',
      originalUrl: item.link,
      guid: item.guid,
      source: 'fotoportadas',
      title: item.title,
      chatId,
      messageId,
    }).catch(() => {});
  },
});

// Re-export for external callers that need raw feed access
export async function fetchFotoportadasFeed(): Promise<string> {
  return poller.fetchRssFeed();
}

// --- Public API ---

// Fetch and send the latest Fotoportadas item (for manual /ultimo command)
export async function fetchLatestFotoportadas(api: Api, chatId: number, threadId?: number): Promise<boolean> {
  const xml = await poller.fetchRssFeed();
  const allItems = parseFotoportadasItems(xml);
  const item = allItems.find(i => i.title.startsWith('Fotoportadas'));

  if (!item) return false;

  const urls = extractFotoportadaImages(item.contentEncoded);
  if (urls.length === 0) return false;

  const photos = await downloadPhotos(urls);
  if (photos.length === 0) return false;

  const caption = `\u{1F4F0} <b>${item.title}</b>`;
  const threadOpts = threadId ? { message_thread_id: threadId } : {};
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
  } else {
    const sent = await api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
      caption, parse_mode: 'HTML', disable_notification: true, ...threadOpts,
    });
    messageId = sent.message_id;
  }

  const posted = await poller.getPostedGuids();
  posted.add(item.guid);
  await poller.savePostedGuids(posted);

  addRegistryEntry({
    type: 'rss-adprensa',
    originalUrl: item.link,
    guid: item.guid,
    source: 'fotoportadas',
    title: item.title,
    chatId,
    messageId,
  }).catch(() => {});

  return true;
}

export async function startFotoportadasPoller(api: Api): Promise<void> {
  return poller.start(api);
}

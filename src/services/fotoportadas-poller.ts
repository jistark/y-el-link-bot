import { InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import type { Article } from '../types.js';
import { createPage } from '../formatters/telegraph.js';
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

function extractFotoportadaImages(html: string): { url: string }[] {
  const images: { url: string }[] = [];
  const imgRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imgRegex.exec(html)) !== null) {
    const url = match[1];
    // Keep only mcusercontent.com images (actual newspaper front pages)
    // Skip sawa-dev storage images (logo)
    if (url.includes('mcusercontent.com') && !url.includes('sawa-dev')) {
      images.push({ url });
    }
  }

  return images;
}

// Build Telegraph body HTML from images
function buildFotoportadasBody(images: { url: string }[]): string {
  return images.map(img =>
    `<figure><img src="${img.url}"></figure>`
  ).join('\n');
}

// --- Regen keyboard ---

function createRssRegenKeyboard(source: string, guid: string): InlineKeyboard {
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
    const images = extractFotoportadaImages(item.contentEncoded);

    if (images.length === 0) {
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

    const body = buildFotoportadasBody(images);

    // Build Article for Telegraph
    const article: Article = {
      title: item.title,
      body,
      url: item.link,
      source: 'adprensa',
      date: item.pubDate,
      images: images.map(img => ({ url: img.url })),
    };

    // Create Telegraph page
    const result = await createPage(article);

    // Post Telegraph link to channel with regen button
    const keyboard = createRssRegenKeyboard('adprensa', item.guid);
    const sent = await sendWithRetry(
      () => api.sendMessage(chatId, result.url, {
        disable_notification: true,
        reply_markup: keyboard,
      }),
      'sendMessage', 'fotoportadas',
    );

    posted.add(item.guid);
    await save();

    // Persist to registry (survives redeploys)
    addRegistryEntry({
      type: 'rss-adprensa',
      originalUrl: item.link,
      guid: item.guid,
      source: 'adprensa',
      telegraphPath: result.path,
      title: item.title,
      chatId,
      messageId: sent.message_id,
    }).catch(() => {}); // non-blocking
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

  const images = extractFotoportadaImages(item.contentEncoded);
  if (images.length === 0) return false;

  const body = buildFotoportadasBody(images);

  const article: Article = {
    title: item.title,
    body,
    url: item.link,
    source: 'adprensa',
    date: item.pubDate,
    images: images.map(img => ({ url: img.url })),
  };

  const result = await createPage(article);

  const keyboard = createRssRegenKeyboard('adprensa', item.guid);
  const sent = await api.sendMessage(chatId, result.url, {
    disable_notification: true,
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard,
    ...(threadId ? { message_thread_id: threadId } : {}),
  });

  // Mark as posted in shared set so the poller doesn't duplicate it
  const posted = await poller.getPostedGuids();
  posted.add(item.guid);
  await poller.savePostedGuids(posted);

  // Persist to registry
  addRegistryEntry({
    type: 'rss-adprensa',
    originalUrl: item.link,
    guid: item.guid,
    source: 'adprensa',
    telegraphPath: result.path,
    title: item.title,
    chatId,
    messageId: sent.message_id,
  }).catch(() => {});

  return true;
}

export async function startFotoportadasPoller(api: Api): Promise<void> {
  return poller.start(api);
}

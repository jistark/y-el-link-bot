import { InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import type { Article } from '../types.js';
import { createPage, deletePage } from '../formatters/telegraph.js';
import { decodeEntities, sendWithRetry } from '../utils/shared.js';
import { addRegistryEntry } from './registry.js';
import { createPoller } from './poller-base.js';
import type { BaseRssItem } from './poller-base.js';

// --- Types ---

export interface AdprensaRssItem extends BaseRssItem {
  pubDate: string;
  categories: string[];
}

// --- Parsing ---

export function parseAdprensaItems(xml: string): AdprensaRssItem[] {
  const items: AdprensaRssItem[] = [];
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

// --- Regen keyboard ---

function createRssRegenKeyboard(source: string, guid: string): InlineKeyboard {
  // Use first 20 chars of guid to stay under 64-byte Telegram callback_data limit
  const guidHash = guid.slice(0, 20);
  return new InlineKeyboard().text('\u{1F504}', `regen_rss:${source}:${guidHash}`);
}

// --- Content preprocessing ---

// Detect if content is a contact list (table with emails/phones)
export function isContactList(html: string): boolean {
  return /<table[\s>]/i.test(html) && /(?:e-?mail|fono|celular)/i.test(html);
}

// Transform pauta/agenda content: sections -> headings, dash-items -> lists
export function preprocessPautaContent(html: string): string {
  let result = html;

  // Pattern 1: ==== lines wrapping a section title (strong or plain)
  // <p>====================<br />\nPRESIDENCIAL<br />\n====================</p>
  // Also handles <strong> variants
  result = result.replace(
    /<p>\s*(?:<strong>)?[=]{3,}(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?([\s\S]*?)(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?[=]{3,}(?:<\/strong>)?\s*<\/p>/gi,
    (_match, title) => `<h3>${title.trim()}</h3>`
  );

  // Pattern 2: ——— lines wrapping a subsection title
  // <p>———————<br />\nATENCION CON<br />\n———————</p>
  result = result.replace(
    /<p>\s*(?:<strong>)?[—–\-]{3,}(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?([\s\S]*?)(?:<\/strong>)?\s*<br\s*\/?>\s*(?:<strong>)?[—–\-]{3,}(?:<\/strong>)?\s*<\/p>/gi,
    (_match, title) => `<h4>${title.trim()}</h4>`
  );

  // Pattern 3: Standalone separator lines (just dashes) -> remove
  result = result.replace(/<p>\s*(?:<strong>)?[—–\-=]{3,}(?:<\/strong>)?\s*<\/p>/gi, '');

  // Pattern 4: Paragraphs starting with - -> list items, group consecutive ones
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

// --- Poller instance ---

const poller = createPoller<AdprensaRssItem>({
  name: 'adprensa',
  feedUrl: 'https://adprensa.cl/feed/',
  postedPath: 'data/adprensa-posted.json',
  parseItems: parseAdprensaItems,
  filterNew(items, posted) {
    // Accept all categories (Pauta, Economía, Gobierno, Crónica, Política,
    // Congreso, etc.) in oldest-first order so the channel shows them in
    // chronological order.
    return items.filter(item => !posted.has(item.guid)).reverse();
  },
  async processItem(api, chatId, item, posted, save) {
    const isPauta = item.categories.includes('Pauta');
    const contactList = isContactList(item.contentEncoded);
    // Only Pauta items need the ====/——— → heading transforms; press
    // releases and other stories come as normal HTML and should pass through.
    const body = contactList
      ? item.contentEncoded
      : isPauta
        ? preprocessPautaContent(item.contentEncoded)
        : item.contentEncoded;

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

    // Post Telegraph link to channel with regen button
    const keyboard = createRssRegenKeyboard('adprensa', item.guid);
    const sent = await sendWithRetry(
      () => api.sendMessage(chatId, result.url, {
        disable_notification: true,
        reply_markup: keyboard,
      }),
      'sendMessage', 'adprensa',
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
export async function fetchAdprensaFeed(): Promise<string> {
  return poller.fetchRssFeed();
}

// --- Public API (unchanged signatures) ---

// Fetch and send the latest Pauta item (for manual /ultimo command)
export async function fetchLatestPauta(api: Api, chatId: number, threadId?: number): Promise<boolean> {
  const xml = await poller.fetchRssFeed();
  const allItems = parseAdprensaItems(xml);
  const item = allItems.find(i => i.categories.includes('Pauta'));

  if (!item) return false;

  const contactList = isContactList(item.contentEncoded);
  const body = contactList ? item.contentEncoded : preprocessPautaContent(item.contentEncoded);

  const article: Article = {
    title: item.title,
    body,
    url: item.link,
    source: 'adprensa',
    date: item.pubDate,
  };

  const result = await createPage(article);

  if (contactList) {
    const LISTADO_TTL = 72 * 60 * 60 * 1000;
    setTimeout(() => {
      deletePage(result.path).catch(() => {});
    }, LISTADO_TTL);
  }

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

export async function startAdprensaPoller(api: Api): Promise<void> {
  return poller.start(api);
}

/**
 * Handler for messages from Twitter Link Expander-style bots.
 *
 * When such a bot relays a tweet that wraps an article URL via
 * fxtwitter/fixupx, we:
 *  1. Pull every fxtwitter URL out of the message body.
 *  2. Fetch each one via curl_cffi (bypasses Twitter's bot detection).
 *  3. Find the first article URL embedded inside.
 *  4. Extract + post a Telegraph link (deduped via the shared cache).
 *
 * We do NOT delete the bot's original message — that would be hostile
 * to other group members. We just append a Telegraph reply nearby.
 */

import type { Context } from 'grammy';
import { detectSource, extractArticle } from '../extractors/index.js';
import { createPage, type CreatePageResult } from '../formatters/telegraph.js';
import { extractUrlsFromFxTwitter, isFxTwitterUrl } from './fxtwitter.js';
import { safeSendMessage } from './safe-send.js';
import { cache, pathToUrl, TTL } from './state.js';
import { deAmpUrl, extractUrls, isExtractableUrl } from './url-filter.js';

export async function handleLinkExpanderMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || !ctx.chat) return;

  const fxUrls = extractUrls(text).filter(isFxTwitterUrl);
  if (fxUrls.length === 0) return;

  for (const fxUrl of fxUrls) {
    const embedded = await extractUrlsFromFxTwitter(fxUrl);

    let articleUrl: string | null = null;
    for (const candidate of embedded) {
      const cleaned = deAmpUrl(candidate);
      if (detectSource(cleaned) || isExtractableUrl(cleaned)) {
        articleUrl = cleaned;
        break;
      }
    }
    if (!articleUrl) continue;

    let result: CreatePageResult;
    const cached = cache.get(articleUrl);
    if (cached && cached.expires > Date.now()) {
      result = cached.result;
    } else {
      try {
        const article = await extractArticle(articleUrl);
        article.url = articleUrl;
        result = await createPage(article);
        cache.set(articleUrl, { result, expires: Date.now() + TTL });
        pathToUrl.set(result.path, articleUrl);
      } catch (err) {
        console.error(JSON.stringify({
          event: 'link_expander_extract_error',
          fxUrl, articleUrl,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }));
        continue;
      }
    }

    console.log(JSON.stringify({
      event: 'link_expander_processed',
      botUsername: ctx.message?.from?.username,
      fxUrl, articleUrl,
      telegraphUrl: result.url,
      threadId: ctx.message?.message_thread_id,
      chatId: ctx.chat.id,
      timestamp: new Date().toISOString(),
    }));

    // Skip reply_to_message_id — target is a bot, which triggers Telegram's
    // topic-misplacement bug. Rely on message_thread_id to keep the reply
    // in the same topic. The visual reply chain is sacrificed; the
    // contextual proximity (same topic, posted right after) is enough.
    const threadOpts = ctx.message?.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};

    try {
      await safeSendMessage(ctx.api, ctx.chat.id, `📰 ${result.url}`, {
        ...threadOpts,
        link_preview_options: { is_disabled: false },
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'link_expander_send_error',
        articleUrl, telegraphUrl: result.url,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }
}

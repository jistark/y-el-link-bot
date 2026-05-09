/**
 * Main URL-extraction handler: parses every text message for paywalled
 * article URLs and dispatches them through the extractor pipeline.
 *
 * Flow per detected URL:
 *  1. Resolve canonical URL (de-AMP) and gate against allowlist + SSRF.
 *  2. Per-user rate limit.
 *  3. Special multi-article paths (El Mercurio papel digital, LUN papel)
 *     show a selector; the user's choice is handled by the empage:/lunpage:
 *     callback handlers.
 *  4. Otherwise: register the URL as pending with a 5s undo button. After
 *     the grace period, extract → createPage → processAndReply.
 *
 * Bot messages are mostly ignored, except for the curated Link Expander
 * bots whose tweets sometimes wrap article URLs we can resolve.
 */

import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { detectSource, extractArticle } from '../../extractors/index.js';
import {
  extractByArticleId, extractStoryGroup, fetchPageArticles, groupPageArticles,
  isPageUrl, sanitizeAndStripMercurio,
} from '../../extractors/elmercurio.js';
import { fetchLunPageArticles } from '../../extractors/lun.js';
import { createPage } from '../../formatters/telegraph.js';
import { addRegistryEntry } from '../../services/registry.js';
import { escapeHtmlMinimal as escapeHtml, scheduleDelete, withTimeout } from '../../utils/shared.js';
import { handleLinkExpanderMessage } from '../link-expander-handler.js';
import {
  LINK_EXPANDER_BOTS, deAmpUrl, extractUrls, isExtractableUrl,
} from '../url-filter.js';
import {
  cache, isRateLimited, NUMBER_EMOJIS, pathToUrl, pending, pendingLunPages, pendingPages,
  TTL, UNDO_GRACE_PERIOD,
} from '../state.js';
import { createUndoKeyboard } from '../user-helpers.js';
import { processAndReply } from './process-and-reply.js';

export function registerMessageHandler(bot: Bot): void {
  bot.on('message:text', async (ctx) => {
    // Bots: only process Link Expander-style X/Twitter expanders.
    if (ctx.message.from?.is_bot) {
      const username = ctx.message.from.username?.toLowerCase();
      if (username && LINK_EXPANDER_BOTS.has(username)) {
        await handleLinkExpanderMessage(ctx);
      }
      return;
    }

    const rawUrls = extractUrls(ctx.message.text);

    for (const rawUrl of rawUrls) {
      const url = deAmpUrl(rawUrl);
      const source = detectSource(url);
      // Sites with a custom extractor or recipe go through immediately.
      // All other URLs try the generic extractor (JSON-LD / __NEXT_DATA__ / HTML).
      // The quality gate in generic.ts filters non-article pages.
      if (!source && !isExtractableUrl(url)) continue;

      // Rate limiting — skip extraction if no userId (can't rate-limit anonymous sources)
      const userId = ctx.from?.id;
      if (!userId || isRateLimited(userId)) continue;

      // El Mercurio: URLs de página necesitan selección de artículo
      if (source === 'elmercurio' && isPageUrl(url)) {
        await handleMercurioPage(ctx, url);
        continue;
      }

      // LUN: páginas con múltiples artículos (selector inline)
      if (source === 'lun') {
        const handled = await handleLunPageMaybe(ctx, url);
        if (handled) continue;
        // single-article LUN → fall through to normal pipeline
      }

      await scheduleArticleExtraction(ctx, url);
    }
  });
}

// --- El Mercurio page selection -------------------------------------------

async function handleMercurioPage(ctx: Context, url: string): Promise<void> {
  try {
    const pageData = await fetchPageArticles(url);
    if (!pageData || pageData.articles.length === 0) {
      const sent = await ctx.reply('❌ No encontré artículos en esa página.', {
        reply_to_message_id: ctx.message!.message_id,
      });
      scheduleDelete(ctx.api, sent.chat.id, sent.message_id);
      return;
    }

    const grouping = groupPageArticles(pageData.articles);

    console.log(JSON.stringify({
      event: 'page_groups_detected',
      url,
      groupCount: grouping.groups.length,
      standaloneCount: grouping.standalone.length,
      totalArticles: pageData.articles.length,
      timestamp: new Date().toISOString(),
    }));

    // AUTO: 1 group + 0 standalones → render group without prompting
    if (grouping.groups.length === 1 && grouping.standalone.length === 0) {
      const group = grouping.groups[0];
      const processingMsg = await ctx.reply('⏳ Reconstruyendo reportaje...', {
        reply_to_message_id: ctx.message!.message_id,
      });
      try {
        const article = await extractStoryGroup(group, pageData.date, pageData.pageId);
        article.url = url;
        const result = await createPage(article);
        const cacheKey = `${url}#group:${group.anchor.id}`;
        cache.set(cacheKey, { result, expires: Date.now() + TTL });
        pathToUrl.set(result.path, url);
        addRegistryEntry({
          type: 'extractor', originalUrl: url, source: article.source,
          telegraphPath: result.path, title: article.title, chatId: ctx.chat?.id,
        }).catch(() => {});
        try { await ctx.api.deleteMessage(processingMsg.chat.id, processingMsg.message_id); } catch {}
        await processAndReply(ctx, url, result);
      } catch (err) {
        try {
          await ctx.api.editMessageText(processingMsg.chat.id, processingMsg.message_id,
            '❌ No pude reconstruir el reportaje.');
          scheduleDelete(ctx.api, processingMsg.chat.id, processingMsg.message_id);
        } catch {}
        throw err; // re-throw so the outer try/catch logs it
      }
      return;
    }

    // AUTO: 0 groups + 1 standalone → render directly (preserves prior behavior)
    if (grouping.groups.length === 0 && grouping.standalone.length === 1) {
      const lone = grouping.standalone[0];
      // Pass pageId so the printed-page footer + explicit cover policy
      // applies (consistent with extractStoryGroup for multi-article).
      const article = await extractByArticleId(lone.id, pageData.date, pageData.pageId);
      article.url = url;
      const result = await createPage(article);
      cache.set(`${url}#${lone.id}`, { result, expires: Date.now() + TTL });
      pathToUrl.set(result.path, url);
      addRegistryEntry({
        type: 'extractor', originalUrl: url, source: article.source,
        telegraphPath: result.path, title: article.title, chatId: ctx.chat?.id,
      }).catch(() => {});
      await processAndReply(ctx, url, result);
      return;
    }

    // Otherwise: show selector with groups + standalones
    let text = `📰 <b>${escapeHtml(pageData.sectionName)}</b> — Pág. ${pageData.page}\n\n`;
    text += 'Elige el artículo:\n\n';
    const keyboard = new InlineKeyboard();

    for (let gi = 0; gi < grouping.groups.length; gi++) {
      const g = grouping.groups[gi];
      const cleanTitle = sanitizeAndStripMercurio(g.anchor.title);
      const partsCount = 1 + g.recuadros.length;
      text += `📋 Reportaje completo: ${escapeHtml(cleanTitle)} (${partsCount} partes)\n`;
      keyboard.text(`📋 ${gi + 1}`, `empage:g:${gi}`).row();
    }

    const maxStandalone = Math.min(grouping.standalone.length, NUMBER_EMOJIS.length);
    for (let i = 0; i < maxStandalone; i++) {
      const a = grouping.standalone[i];
      const cleanTitle = sanitizeAndStripMercurio(a.title);
      text += `${NUMBER_EMOJIS[i]} ${escapeHtml(cleanTitle)}\n`;
      keyboard.text(NUMBER_EMOJIS[i], `empage:a:${i}`);
      if ((i + 1) % 5 === 0) keyboard.row();
    }

    const botMessage = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      reply_to_message_id: ctx.message!.message_id,
    });

    pendingPages.set(botMessage.message_id, {
      groups: grouping.groups,
      standalone: grouping.standalone.slice(0, maxStandalone),
      date: pageData.date,
      pageId: pageData.pageId,
      originalUrl: url,
      userId: ctx.from?.id || 0,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name || 'Usuario',
      chatId: ctx.chat!.id,
      botMessageId: botMessage.message_id,
      originalMessageId: ctx.message!.message_id,
      originalText: ctx.message!.text ?? '',
      replyToMessageId: ctx.message!.reply_to_message?.message_id,
      threadId: ctx.message!.message_thread_id,
      replyTargetThreadId: ctx.message!.reply_to_message?.message_thread_id,
      replyTargetIsBot: ctx.message!.reply_to_message?.from?.is_bot ?? false,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'page_selection_error', url,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    const sent = await ctx.reply('❌ No pude acceder a esa página.', {
      reply_to_message_id: ctx.message!.message_id,
    });
    scheduleDelete(ctx.api, sent.chat.id, sent.message_id);
  }
}

// --- LUN page selection ---------------------------------------------------

async function handleLunPageMaybe(ctx: Context, url: string): Promise<boolean> {
  try {
    const lunPage = await fetchLunPageArticles(url);
    if (!lunPage || lunPage.articles.length < 2) return false;

    let text = `📰 <b>LUN</b> — Pág. ${lunPage.paginaId}\n\n`;
    text += 'Elige el artículo:\n\n';
    const keyboard = new InlineKeyboard();

    const partsCount = lunPage.articles.length;
    text += `📋 Página completa (${partsCount} notas)\n`;
    keyboard.text('📋 Toda', 'lunpage:g:0').row();

    const maxArticles = Math.min(lunPage.articles.length, NUMBER_EMOJIS.length);
    for (let i = 0; i < maxArticles; i++) {
      const a = lunPage.articles[i];
      text += `${NUMBER_EMOJIS[i]} ${escapeHtml(a.title)}\n`;
      keyboard.text(NUMBER_EMOJIS[i], `lunpage:a:${i}`);
      if ((i + 1) % 5 === 0) keyboard.row();
    }

    const botMessage = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      reply_to_message_id: ctx.message!.message_id,
    });

    pendingLunPages.set(botMessage.message_id, {
      articles: lunPage.articles.slice(0, maxArticles),
      fecha: lunPage.fecha,
      paginaId: lunPage.paginaId,
      originalUrl: url,
      userId: ctx.from?.id || 0,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name || 'Usuario',
      chatId: ctx.chat!.id,
      botMessageId: botMessage.message_id,
      originalMessageId: ctx.message!.message_id,
      originalText: ctx.message!.text ?? '',
      replyToMessageId: ctx.message!.reply_to_message?.message_id,
      threadId: ctx.message!.message_thread_id,
      replyTargetThreadId: ctx.message!.reply_to_message?.message_thread_id,
      replyTargetIsBot: ctx.message!.reply_to_message?.from?.is_bot ?? false,
      createdAt: Date.now(),
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'lun_page_selection_error', url,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    return false; // fall through to normal pipeline
  }
}

// --- Normal single-article pipeline ---------------------------------------

async function scheduleArticleExtraction(ctx: Context, url: string): Promise<void> {
  const pendingId = `${ctx.chat!.id}:${ctx.message!.message_id}:${url}`;

  // Cache check
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) {
    await processAndReply(ctx, url, cached.result);
    return;
  }

  // Send "procesando" with undo button (reply to original message).
  const botMessage = await ctx.reply('⏳ Procesando artículo...', {
    reply_markup: createUndoKeyboard(),
    reply_parameters: {
      message_id: ctx.message!.message_id,
      allow_sending_without_reply: true,
    },
  });

  // Schedule extraction after the UNDO grace window.
  const timeoutId = setTimeout(async () => {
    const req = pending.get(pendingId);
    if (!req || req.cancelled) {
      pending.delete(pendingId);
      return;
    }

    try {
      const article = await withTimeout(
        extractArticle(url),
        30_000,
        'Timeout: extracción tomó más de 30s',
      );
      const result = await createPage(article);

      cache.set(url, { result, expires: Date.now() + TTL });

      addRegistryEntry({
        type: 'extractor',
        originalUrl: url,
        source: article.source,
        telegraphPath: result.path,
        title: article.title,
        chatId: ctx.chat?.id,
      }).catch(() => {});

      await processAndReply(ctx, url, result, req);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'extraction_error',
        url,
        source: detectSource(url),
        chatId: ctx.chat!.id,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          botMessage.message_id,
          '❌ No pude acceder al artículo.',
        );
        scheduleDelete(ctx.api, ctx.chat!.id, botMessage.message_id);
      } catch {
        // Mensaje ya borrado o inaccesible
      }
    } finally {
      pending.delete(pendingId);
    }
  }, UNDO_GRACE_PERIOD);

  pending.set(pendingId, {
    originalUrl: url,
    originalMessageId: ctx.message!.message_id,
    originalText: ctx.message!.text ?? '',
    userId: ctx.from?.id || 0,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name || 'Usuario',
    chatId: ctx.chat!.id,
    botMessageId: botMessage.message_id,
    timeoutId,
    cancelled: false,
    replyToMessageId: ctx.message!.reply_to_message?.message_id,
    threadId: ctx.message!.message_thread_id,
    replyTargetThreadId: ctx.message!.reply_to_message?.message_thread_id,
    replyTargetIsBot: ctx.message!.reply_to_message?.from?.is_bot ?? false,
  });

  console.log(JSON.stringify({
    event: 'pending_created', url,
    threadId: ctx.message!.message_thread_id,
    replyToMessageId: ctx.message!.reply_to_message?.message_id,
    chatId: ctx.chat!.id,
    timestamp: new Date().toISOString(),
  }));
}

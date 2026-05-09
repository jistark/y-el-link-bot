/**
 * Shared helper used by both `empage:` (Mercurio) and `lunpage:` (LUN)
 * callback handlers after the user has chosen which article on a multi-
 * article page to publish.
 *
 * Takes the extracted Article, creates a Telegraph page, then orchestrates
 * the editMessage / deleteMessage / sendMessage dance to surface the result
 * in the right thread, preserving the reply-to relationship when sensible.
 */

import type { Context } from 'grammy';
import type { Article } from '../../types.js';
import { createPage } from '../../formatters/telegraph.js';
import { addRegistryEntry } from '../../services/registry.js';
import { escapeHtmlMinimal as escapeHtml } from '../../utils/shared.js';
import { createActionKeyboard } from '../keyboards.js';
import { safeSendMessage } from '../safe-send.js';
import { cache, pathToUrl, TTL } from '../state.js';
import { getTextWithoutUrls } from '../user-helpers.js';

/** Common shape of the pending-page selection we need from state. */
export interface SelectionContext {
  userId: number;
  username?: string;
  firstName: string;
  chatId: number;
  botMessageId: number;
  originalMessageId: number;
  originalUrl: string;
  originalText: string;
  replyToMessageId?: number;
  threadId?: number;
  replyTargetThreadId?: number;
  replyTargetIsBot?: boolean;
}

/**
 * Publish the extracted article into the chat in place of the selection
 * prompt. Records the path↔URL mapping so regen works later.
 */
export async function publishSelection(
  ctx: Context,
  sel: SelectionContext,
  extracted: Article,
  cacheKey: string,
): Promise<void> {
  extracted.url = sel.originalUrl;
  const result = await createPage(extracted);
  cache.set(cacheKey, { result, expires: Date.now() + TTL });
  pathToUrl.set(result.path, sel.originalUrl);

  // Persist to registry (survives redeploys). Mirrors the auto-publish
  // path in message-text.ts — without this, articles published via the
  // Mercurio/LUN multi-article selector are invisible to /ultimo and
  // to the regen-by-path fallback that queries the registry on restart.
  addRegistryEntry({
    type: 'extractor',
    originalUrl: sel.originalUrl,
    source: extracted.source,
    telegraphPath: result.path,
    title: extracted.title,
    chatId: sel.chatId,
  }).catch(() => {});

  const keyboard = createActionKeyboard(result.path, sel.userId, sel.originalUrl);
  const mention = sel.username ? `@${sel.username}` :
    `<a href="tg://user?id=${sel.userId}">${escapeHtml(sel.firstName)}</a>`;
  const extraText = getTextWithoutUrls(sel.originalText);
  const messageText = extraText
    ? `${mention}: ${escapeHtml(extraText)}\n\n${result.url}`
    : `${mention} compartió:\n${result.url}`;

  if (sel.replyToMessageId) {
    try { await ctx.api.deleteMessage(sel.chatId, sel.botMessageId); } catch {}
    try { await ctx.api.deleteMessage(sel.chatId, sel.originalMessageId); } catch {}

    const sameId = sel.replyToMessageId === sel.threadId;
    const threadMismatch = sel.threadId != null &&
      sel.replyTargetThreadId !== sel.threadId;
    const targetIsBot = sel.replyTargetIsBot === true;
    const dropReplyTo = sameId || threadMismatch || targetIsBot;
    const threadOpts = sel.threadId ? { message_thread_id: sel.threadId } : {};
    const replyOpts = dropReplyTo ? {} : { reply_to_message_id: sel.replyToMessageId };

    if (threadMismatch || targetIsBot) {
      console.log(JSON.stringify({
        event: 'thread_mismatch', action: 'drop_reply_to',
        reason: targetIsBot ? 'target_is_bot' : 'thread_mismatch',
        currentThread: sel.threadId,
        replyTargetThread: sel.replyTargetThreadId,
        replyTargetIsBot: sel.replyTargetIsBot,
        replyToMessageId: sel.replyToMessageId,
        chatId: sel.chatId,
        timestamp: new Date().toISOString(),
      }));
    }

    await safeSendMessage(ctx.api, sel.chatId, messageText, {
      ...threadOpts,
      ...replyOpts,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: false },
    });
  } else {
    try { await ctx.api.deleteMessage(sel.chatId, sel.originalMessageId); } catch {}
    try {
      await ctx.api.editMessageText(sel.chatId, sel.botMessageId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
    } catch {
      await safeSendMessage(ctx.api, sel.chatId, messageText, {
        message_thread_id: sel.threadId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
    }
  }
}

/** Common owner/admin gating for selection callbacks. */
export async function checkSelectionOwner(
  ctx: Context,
  sel: { userId: number },
): Promise<boolean> {
  const isOwner = ctx.from?.id === sel.userId;
  if (isOwner) return true;
  if (!ctx.chat || !ctx.from?.id) return false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

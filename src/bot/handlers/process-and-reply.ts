/**
 * Final step of the message-text pipeline: take the Telegraph result,
 * compose the channel reply, and orchestrate the editMessage / deleteMessage
 * / sendMessage dance.
 *
 * Two execution modes:
 *  - With a `req` (PendingRequest from the UNDO grace path): we own the
 *    "⏳ Procesando" placeholder and replace/delete it.
 *  - Without `req` (cache hit on a re-posted URL): we send a fresh reply
 *    or, if the user was replying to another message, replicate the
 *    reply-target relationship subject to the same thread guards.
 *
 * Shared concerns: HTML escape on user-controlled fields, drop reply_to
 * when the target is a bot or in a different topic (Telegram silently
 * moves replies to bots into the General topic — we'd lose the topic
 * placement).
 */

import type { Context } from 'grammy';
import type { CreatePageResult } from '../../formatters/telegraph.js';
import { escapeHtmlMinimal as escapeHtml } from '../../utils/shared.js';
import { createActionKeyboard } from '../keyboards.js';
import { safeSendMessage } from '../safe-send.js';
import { getTextWithoutUrls } from '../user-helpers.js';
import type { PendingRequest } from '../state.js';

export async function processAndReply(
  ctx: Context,
  originalUrl: string,
  result: CreatePageResult,
  req?: PendingRequest,
): Promise<void> {
  const userId = req?.userId || ctx.from?.id || 0;
  const keyboard = createActionKeyboard(result.path, userId, originalUrl);

  let messageText = result.url;

  if (req) {
    const mention = req.username ? `@${req.username}` :
      `<a href="tg://user?id=${req.userId}">${escapeHtml(req.firstName)}</a>`;

    const extraText = getTextWithoutUrls(req.originalText);

    messageText = extraText
      ? `${mention}: ${escapeHtml(extraText)}\n\n${result.url}`
      : `${mention} compartió:\n${result.url}`;

    if (req.replyToMessageId) {
      // El usuario respondió a otro mensaje con un link — borrar "⏳ Procesando" y
      // el mensaje del usuario, luego publicar como reply al mensaje padre original
      try { await ctx.api.deleteMessage(req.chatId, req.botMessageId); } catch { /* ok */ }
      try { await ctx.api.deleteMessage(req.chatId, req.originalMessageId); } catch { /* ok */ }

      // Determinar si podemos incluir reply_to_message_id sin que Telegram
      // mueva el mensaje a un topic distinto:
      // 1. sameId: el reply target es el header del topic → no incluir reply_to
      // 2. threadMismatch: el reply target está en otro thread → drop reply_to
      // 3. targetIsBot: replying to a bot's message (Link Expander, etc.)
      //    Telegram silently moves replies to bot messages to General/main
      //    topic regardless of message_thread_id. Drop reply_to to keep
      //    correct topic placement; sacrifices the visual reply chain.
      const sameId = req.replyToMessageId === req.threadId;
      const threadMismatch = req.threadId != null &&
        req.replyTargetThreadId !== req.threadId;
      const targetIsBot = req.replyTargetIsBot === true;
      const dropReplyTo = sameId || threadMismatch || targetIsBot;
      const threadOpts = req.threadId ? { message_thread_id: req.threadId } : {};
      const replyOpts = dropReplyTo
        ? {} : { reply_to_message_id: req.replyToMessageId };

      if (threadMismatch || targetIsBot) {
        console.log(JSON.stringify({
          event: 'thread_mismatch', action: 'drop_reply_to',
          reason: targetIsBot ? 'target_is_bot' : 'thread_mismatch',
          currentThread: req.threadId,
          replyTargetThread: req.replyTargetThreadId,
          replyTargetIsBot: req.replyTargetIsBot,
          replyToMessageId: req.replyToMessageId,
          chatId: req.chatId,
          timestamp: new Date().toISOString(),
        }));
      }

      await safeSendMessage(ctx.api, req.chatId, messageText, {
        ...threadOpts,
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
    } else {
      // Mensaje directo con link — borrar original, editar "⏳ Procesando" con resultado
      try { await ctx.api.deleteMessage(req.chatId, req.originalMessageId); } catch { /* ok */ }
      try {
        await ctx.api.editMessageText(req.chatId, req.botMessageId, messageText, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: false },
        });
      } catch {
        await safeSendMessage(ctx.api, req.chatId, messageText, {
          message_thread_id: req.threadId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: false },
        });
      }
    }
  } else {
    // Sin pending request (cache hit) — apply the same thread guards as pending path
    const replyToId = ctx.message?.reply_to_message?.message_id;
    const threadId = ctx.msg?.message_thread_id;
    const chatId = ctx.chat!.id;

    if (replyToId) {
      // Nested reply with cached URL — delete user msg, reply to original target
      const mention = ctx.from?.username
        ? `@${ctx.from.username}`
        : `<a href="tg://user?id=${ctx.from?.id}">${escapeHtml(ctx.from?.first_name || 'Usuario')}</a>`;
      const extraText = getTextWithoutUrls(ctx.message?.text || '');
      messageText = extraText
        ? `${mention}: ${escapeHtml(extraText)}\n\n${result.url}`
        : `${mention} compartió:\n${result.url}`;

      try { await ctx.api.deleteMessage(chatId, ctx.msg!.message_id); } catch { /* ok */ }

      const sameId = replyToId === threadId;
      const replyTargetThreadId = ctx.message?.reply_to_message?.message_thread_id;
      const replyTargetIsBot = ctx.message?.reply_to_message?.from?.is_bot === true;
      const threadMismatch = threadId != null &&
        replyTargetThreadId !== threadId;
      const dropReplyTo = sameId || threadMismatch || replyTargetIsBot;
      const threadOpts = threadId ? { message_thread_id: threadId } : {};
      const replyOpts = dropReplyTo
        ? {} : { reply_to_message_id: replyToId };

      if (threadMismatch || replyTargetIsBot) {
        console.log(JSON.stringify({
          event: 'thread_mismatch', action: 'drop_reply_to',
          reason: replyTargetIsBot ? 'target_is_bot' : 'thread_mismatch',
          currentThread: threadId,
          replyTargetThread: replyTargetThreadId,
          replyTargetIsBot,
          replyToMessageId: replyToId,
          chatId,
          timestamp: new Date().toISOString(),
        }));
      }

      await safeSendMessage(ctx.api, chatId, messageText, {
        ...threadOpts,
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
    } else {
      // Direct message (not a reply) — middleware handles thread injection via ctx.reply()
      await ctx.reply(messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        reply_to_message_id: ctx.msg?.message_id,
        // Force the Telegraph URL preview on. Without this, Telegram
        // applies its default heuristic which often hides the preview
        // for telegra.ph URLs — every other send path in this file
        // explicitly enables the preview, so this branch was the odd
        // one out (pre-refactor inconsistency).
        link_preview_options: { is_disabled: false },
      });
    }
  }
}

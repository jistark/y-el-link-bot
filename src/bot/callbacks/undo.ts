/**
 * `undo` callback — fires when the user presses the ⏪ Cancelar button
 * during the UNDO_GRACE_PERIOD window after a URL is detected.
 *
 * Cancels the pending request before it completes. Owner OR admin can
 * cancel.
 */

import type { Context } from 'grammy';
import { pending } from '../state.js';
import type { CallbackHandler } from './types.js';

export const undoHandler: CallbackHandler = {
  name: 'undo',
  matches: (data) => data === 'undo',
  async handle(ctx: Context) {
    for (const [id, req] of pending.entries()) {
      if (req.botMessageId === ctx.callbackQuery?.message?.message_id) {
        const isOwner = req.userId === ctx.from?.id;
        let isAdmin = false;

        if (!isOwner && ctx.chat && ctx.from?.id) {
          try {
            const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
            isAdmin = ['creator', 'administrator'].includes(member.status);
          } catch {}
        }

        if (!isOwner && !isAdmin) {
          await ctx.answerCallbackQuery({ text: 'Solo el autor o admins pueden cancelar' });
          return;
        }

        req.cancelled = true;
        clearTimeout(req.timeoutId);
        pending.delete(id);

        try {
          await ctx.deleteMessage();
        } catch {
          await ctx.editMessageText('↩️ Cancelado');
        }

        await ctx.answerCallbackQuery({ text: 'Cancelado' });
        return;
      }
    }
    await ctx.answerCallbackQuery({ text: 'Ya no se puede cancelar' });
  },
};

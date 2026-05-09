/**
 * Two delete callback handlers:
 *  - `del:` — current format, includes a base36 timestamp so we can enforce
 *    the DELETE_GRACE_PERIOD for non-admin owners.
 *  - `delete:` — legacy format (kept for messages emitted before the
 *    timestamp was added). No grace check; admin or owner only.
 */

import type { Context } from 'grammy';
import { deletePage } from '../../formatters/telegraph.js';
import { cache, pathToUrl, DELETE_GRACE_PERIOD } from '../state.js';
import type { CallbackHandler } from './types.js';

async function purgeTelegraphPath(telegraphPath: string): Promise<void> {
  await deletePage(telegraphPath);
  pathToUrl.delete(telegraphPath);
  for (const [cachedUrl, entry] of cache) {
    if (entry.result.path === telegraphPath) { cache.delete(cachedUrl); break; }
  }
}

async function isUserAdmin(ctx: Context, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

async function tryDeleteOrEdit(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    await ctx.editMessageText('🗑️ Eliminado');
  }
}

// `del:{telegraphPath}:{ownerId}:{createdAt-base36}`
export const delHandler: CallbackHandler = {
  name: 'del',
  matches: (data) => data.startsWith('del:'),
  async handle(ctx) {
    const data = ctx.callbackQuery!.data!;
    const parts = data.slice(4).split(':');
    const createdAtB36 = parts.pop()!;
    const ownerIdStr = parts.pop()!;
    const telegraphPath = parts.join(':');
    // Validate path — Telegraph paths are alphanumeric + hyphens.
    if (!/^[\w-]+$/.test(telegraphPath)) {
      await ctx.answerCallbackQuery({ text: 'Path inválido', show_alert: true });
      return;
    }
    const ownerId = parseInt(ownerIdStr, 10);
    const createdAt = parseInt(createdAtB36, 36) * 1000;
    const userId = ctx.from?.id;

    const isAdmin = userId ? await isUserAdmin(ctx, userId) : false;
    const isOwner = userId === ownerId;
    const withinGrace = Date.now() - createdAt < DELETE_GRACE_PERIOD;

    if (!isAdmin && !isOwner) {
      await ctx.answerCallbackQuery({
        text: 'Solo el autor o admins pueden borrar',
        show_alert: true,
      });
      return;
    }

    if (isOwner && !isAdmin && !withinGrace) {
      await ctx.answerCallbackQuery({
        text: 'El tiempo para borrar ha expirado',
        show_alert: true,
      });
      return;
    }

    await purgeTelegraphPath(telegraphPath);
    await tryDeleteOrEdit(ctx);
    await ctx.answerCallbackQuery({ text: 'Eliminado' });
  },
};

// Legacy `delete:{telegraphPath}:{ownerId}` — kept for old buttons.
export const legacyDeleteHandler: CallbackHandler = {
  name: 'delete-legacy',
  matches: (data) => data.startsWith('delete:'),
  async handle(ctx) {
    const data = ctx.callbackQuery!.data!;
    const parts = data.slice(7).split(':');
    const ownerId = parseInt(parts.pop()!, 10);
    const telegraphPath = parts.join(':');
    const userId = ctx.from?.id;

    let canDelete = userId === ownerId;
    if (!canDelete && userId) canDelete = await isUserAdmin(ctx, userId);

    if (!canDelete) {
      await ctx.answerCallbackQuery({ text: 'Solo el autor o admins pueden borrar', show_alert: true });
      return;
    }

    await purgeTelegraphPath(telegraphPath);
    await tryDeleteOrEdit(ctx);
    await ctx.answerCallbackQuery({ text: 'Eliminado' });
  },
};

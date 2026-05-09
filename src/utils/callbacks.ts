/**
 * Pure helpers for parsing and gating Telegram inline-keyboard callback_data.
 *
 * Callback data is bounded to 64 bytes by Telegram, which forces some
 * compression tricks for long Telegraph paths or large user IDs. The pieces
 * below are extracted from the bot.ts callback handlers so they can be
 * unit-tested without grammy context mocks.
 */

export interface RegenCallback {
  telegraphPath: string;
  // null = owner unknown (callback was truncated and the user-id segment
  // was replaced with the sentinel 'x'). In this case the handler should
  // fall back to admin-only access.
  ownerId: number | null;
}

/**
 * Parse `regen:{path}:{ownerId|x}` callback_data. The Telegraph path may
 * itself contain colons (it almost never does — they're slugs — but we
 * defensively split-then-rejoin so an unexpected colon doesn't lose data).
 */
export function parseRegenCallback(data: string): RegenCallback {
  if (!data.startsWith('regen:')) {
    throw new Error(`Not a regen callback: ${data}`);
  }
  const parts = data.slice('regen:'.length).split(':');
  if (parts.length < 2) {
    throw new Error(`Malformed regen callback: ${data}`);
  }
  const ownerIdRaw = parts.pop()!;
  const telegraphPath = parts.join(':');
  const ownerId = ownerIdRaw === 'x' ? null : parseInt(ownerIdRaw, 10);
  return {
    telegraphPath,
    ownerId: Number.isFinite(ownerId) ? (ownerId as number) : null,
  };
}

/**
 * Decide whether a user can regenerate an article.
 *  - If we know the owner: owner OR admin can regen.
 *  - If we don't (callback was truncated): admin-only.
 */
export function canRegen(args: {
  ownerId: number | null;
  userId: number | undefined;
  isAdmin: boolean;
}): boolean {
  const { ownerId, userId, isAdmin } = args;
  if (isAdmin) return true;
  if (ownerId === null) return false; // sentinel: only admins
  if (userId === undefined) return false;
  return userId === ownerId;
}

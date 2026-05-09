/**
 * Ordered registry of callback handlers. The dispatcher in bot.ts iterates
 * this array; the first handler whose `matches(data)` returns true owns
 * the callback.
 *
 * Order rationale:
 *  - `undo` (literal equality) first because it's the cheapest match.
 *  - `del:` BEFORE `delete:` so the modern format wins for any data that
 *    could conceivably match both (in practice they don't overlap, but
 *    keeping more-specific prefixes first is a defensive habit).
 *  - `regen_rss:` BEFORE `regen:` for the same reason — `regen_rss:`
 *    starts with `regen` (without a colon), but our prefix checks include
 *    the colon, so the order is purely about discoverability.
 */

import type { CallbackHandler } from './types.js';
import { undoHandler } from './undo.js';
import { delHandler, legacyDeleteHandler } from './delete.js';
import { regenArticleHandler } from './regen-article.js';
import { regenRssHandler } from './regen-rss.js';
import { empageHandler } from './empage.js';
import { lunpageHandler } from './lunpage.js';

export const callbackHandlers: CallbackHandler[] = [
  undoHandler,
  delHandler,
  legacyDeleteHandler,
  regenRssHandler,    // before regenArticleHandler
  regenArticleHandler,
  empageHandler,
  lunpageHandler,
];

export type { CallbackHandler } from './types.js';

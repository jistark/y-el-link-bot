/**
 * `regen_rss:{source}:{guidHash}` — admin-only re-publication of an RSS
 * poller item (Señal, ADPrensa, or Fotoportadas).
 *
 * Strategy per source:
 *  - adprensa: re-fetch feed → re-build Telegraph page → editMessageText
 *  - senal/fotoportadas: re-fetch feed → re-download media → delete old +
 *    send new message (album messages cannot be edited in place)
 */

import type { Context } from 'grammy';
import { InputFile, InputMediaBuilder } from 'grammy';
import { createPage } from '../../formatters/telegraph.js';
import {
  fetchAdprensaFeed, isContactList, parseAdprensaItems, preprocessPautaContent,
} from '../../services/adprensa-poller.js';
import {
  downloadPhotos, extractFotoportadaImages, fetchFotoportadasFeed, parseFotoportadasItems,
} from '../../services/fotoportadas-poller.js';
import { findByGuidHash, findByGuidPrefix, updateRegistryEntry } from '../../services/registry.js';
import {
  extractMediaLinks, fetchSenalFeed, formatCaption, getPhotos, parseSenalItems,
} from '../../services/rss-poller.js';
import { createRssRegenKeyboard } from '../../services/rss-shared.js';
import { escapeHtmlMinimal as escapeHtml } from '../../utils/shared.js';
import type { CallbackHandler } from './types.js';

export const regenRssHandler: CallbackHandler = {
  name: 'regen_rss',
  matches: (data) => data.startsWith('regen_rss:'),
  async handle(ctx: Context) {
    const data = ctx.callbackQuery!.data!;
    const parts = data.slice('regen_rss:'.length).split(':');
    const source = parts[0]; // 'adprensa' | 'senal' | 'fotoportadas'
    const guidHash = parts[1];
    const userId = ctx.from?.id;

    let canRegen = false;
    if (ctx.chat && userId) {
      try {
        const member = await ctx.api.getChatMember(ctx.chat.id, userId);
        canRegen = ['creator', 'administrator'].includes(member.status);
      } catch {}
    }
    if (!canRegen) {
      await ctx.answerCallbackQuery({ text: 'Solo admins pueden regenerar', show_alert: true });
      return;
    }

    // SHA-256 hash lookup, with a fallback to the legacy prefix lookup so
    // callbacks emitted before the hash migration still work.
    let entry = await findByGuidHash(guidHash, source);
    if (!entry) entry = await findByGuidPrefix(guidHash);
    if (!entry || !entry.guid) {
      await ctx.answerCallbackQuery({ text: 'Item no encontrado en el registro', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: '\u{1F504} Regenerando...' });

    const chatId = ctx.callbackQuery!.message?.chat.id;
    const messageId = ctx.callbackQuery!.message?.message_id;

    try {
      if (source === 'adprensa') {
        const xml = await fetchAdprensaFeed();
        const allItems = parseAdprensaItems(xml);
        const item = allItems.find(i => i.guid === entry!.guid);

        if (!item) {
          if (chatId && messageId) {
            try { await ctx.api.editMessageText(chatId, messageId, '\u{274C} Item ya no está en el feed. Intenta más tarde.'); } catch {}
          }
          return;
        }

        const contactList = isContactList(item.contentEncoded);
        const body = contactList ? item.contentEncoded : preprocessPautaContent(item.contentEncoded);

        const article = {
          title: item.title,
          body,
          url: item.link,
          source: 'adprensa' as const,
          date: item.pubDate,
        };

        const result = await createPage(article);
        updateRegistryEntry(entry.guid, { telegraphPath: result.path }).catch(() => {});

        const regenKeyboard = createRssRegenKeyboard('adprensa', entry.guid);
        if (chatId && messageId) {
          await ctx.api.editMessageText(chatId, messageId, result.url, {
            reply_markup: regenKeyboard,
            link_preview_options: { is_disabled: false },
          });
        }

        console.log(JSON.stringify({
          event: 'regen_rss_success', source: 'adprensa', guid: entry.guid,
          newPath: result.path, timestamp: new Date().toISOString(),
        }));
      } else if (source === 'senal') {
        const xml = await fetchSenalFeed();
        const allItems = parseSenalItems(xml);
        const item = allItems.find(i => i.guid === entry!.guid);

        if (!item) {
          if (chatId && messageId) {
            try { await ctx.api.editMessageText(chatId, messageId, '\u{274C} Item ya no está en el feed. Intenta más tarde.'); } catch {}
          }
          return;
        }

        const media = extractMediaLinks(item.contentEncoded);
        const caption = formatCaption(item, media);
        const photos = await getPhotos(media);
        const regenKeyboard = createRssRegenKeyboard('senal', entry.guid);

        if (chatId) {
          if (messageId) {
            try { await ctx.api.deleteMessage(chatId, messageId); } catch {}
          }

          let newMessageId: number | undefined;

          if (photos.length >= 2) {
            const mediaGroup = photos.map((p, i) =>
              InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
            );
            const sent = await ctx.api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true });
            newMessageId = sent[0]?.message_id;
            await ctx.api.sendMessage(chatId, '\u{1F504}', {
              disable_notification: true,
              reply_markup: regenKeyboard,
            });
          } else if (photos.length === 1) {
            const sent = await ctx.api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
              caption, parse_mode: 'HTML', disable_notification: true, reply_markup: regenKeyboard,
            });
            newMessageId = sent.message_id;
          } else {
            const sent = await ctx.api.sendMessage(chatId, caption, {
              parse_mode: 'HTML', disable_notification: true, reply_markup: regenKeyboard,
              link_preview_options: { is_disabled: true },
            });
            newMessageId = sent.message_id;
          }

          if (newMessageId) {
            updateRegistryEntry(entry.guid, { messageId: newMessageId }).catch(() => {});
          }
        }

        console.log(JSON.stringify({
          event: 'regen_rss_success', source: 'senal', guid: entry.guid,
          timestamp: new Date().toISOString(),
        }));
      } else if (source === 'fotoportadas') {
        const xml = await fetchFotoportadasFeed();
        const allItems = parseFotoportadasItems(xml);
        const item = allItems.find(i => i.guid === entry!.guid);

        if (!item) {
          if (chatId && messageId) {
            try { await ctx.api.editMessageText(chatId, messageId, '\u{274C} Item ya no está en el feed. Intenta más tarde.'); } catch {}
          }
          return;
        }

        const urls = extractFotoportadaImages(item.contentEncoded);
        const photos = await downloadPhotos(urls);
        const caption = `\u{1F4F0} <b>${escapeHtml(item.title)}</b>`;
        const regenKeyboard = createRssRegenKeyboard('fotoportadas', entry.guid);

        if (chatId) {
          if (messageId) {
            try { await ctx.api.deleteMessage(chatId, messageId); } catch {}
          }

          let newMessageId: number | undefined;

          if (photos.length >= 2) {
            const mediaGroup = photos.map((p, i) =>
              InputMediaBuilder.photo(new InputFile(p.buf, p.name), i === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
            );
            const sent = await ctx.api.sendMediaGroup(chatId, mediaGroup, { disable_notification: true });
            newMessageId = sent[0]?.message_id;
            await ctx.api.sendMessage(chatId, '\u{1F504}', {
              disable_notification: true,
              reply_markup: regenKeyboard,
            });
          } else if (photos.length === 1) {
            const sent = await ctx.api.sendPhoto(chatId, new InputFile(photos[0].buf, photos[0].name), {
              caption, parse_mode: 'HTML', disable_notification: true, reply_markup: regenKeyboard,
            });
            newMessageId = sent.message_id;
          }

          if (newMessageId) {
            updateRegistryEntry(entry.guid, { messageId: newMessageId }).catch(() => {});
          }
        }

        console.log(JSON.stringify({
          event: 'regen_rss_success', source: 'fotoportadas', guid: entry.guid,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'regen_rss_error',
        source, guid: entry.guid,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }));
      if (chatId && messageId) {
        try { await ctx.api.editMessageText(chatId, messageId, '\u{274C} No se pudo regenerar.'); } catch {}
      }
    }
  },
};

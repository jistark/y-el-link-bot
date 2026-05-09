import { describe, expect, it } from 'bun:test';
import { postAlbumWithRegenButton, type MinimalAlbumApi } from '../src/services/rss-poller.js';

// Builds a minimal fake api that records call order and lets each method
// be configured to either succeed or throw.
function makeApi(opts: {
  sendMediaGroupResult?: Array<{ message_id?: number }>;
  sendMediaGroupError?: Error;
  sendMessageError?: Error;
}): { api: MinimalAlbumApi; calls: string[] } {
  const calls: string[] = [];
  const api: MinimalAlbumApi = {
    sendMediaGroup: async () => {
      calls.push('sendMediaGroup');
      if (opts.sendMediaGroupError) throw opts.sendMediaGroupError;
      return opts.sendMediaGroupResult ?? [{ message_id: 999 }];
    },
    sendMessage: async () => {
      calls.push('sendMessage');
      if (opts.sendMessageError) throw opts.sendMessageError;
      return { message_id: 1000 };
    },
  };
  return { api, calls };
}

describe('postAlbumWithRegenButton', () => {
  const baseArgs = {
    chatId: 1,
    mediaGroup: [{ type: 'photo', media: 'foo' }],
    keyboard: { inline_keyboard: [] },
    threadOpts: {},
    guid: 'guid-1',
  };

  it('marks as posted AFTER sendMediaGroup but BEFORE sendMessage (regression #4)', async () => {
    const { api, calls } = makeApi({});
    const order: string[] = [];

    await postAlbumWithRegenButton({
      ...baseArgs,
      api,
      markPosted: async () => { order.push('markPosted'); calls.push('markPosted'); },
    });

    // The exact contract: sendMediaGroup → markPosted → sendMessage
    expect(calls).toEqual(['sendMediaGroup', 'markPosted', 'sendMessage']);
  });

  it('returns the album first message_id', async () => {
    const { api } = makeApi({ sendMediaGroupResult: [{ message_id: 42 }, { message_id: 43 }] });
    const id = await postAlbumWithRegenButton({
      ...baseArgs, api, markPosted: async () => {},
    });
    expect(id).toBe(42);
  });

  it('does NOT mark posted when sendMediaGroup itself fails', async () => {
    const { api } = makeApi({ sendMediaGroupError: new Error('5xx') });
    let posted = false;
    await expect(
      postAlbumWithRegenButton({
        ...baseArgs, api,
        markPosted: async () => { posted = true; },
      })
    ).rejects.toThrow('5xx');
    expect(posted).toBe(false);
  });

  it('STILL marks posted even when the follow-up sendMessage fails', async () => {
    // The bug we fixed: a transient sendMessage failure was unmarking the
    // item, leading to duplicate albums on the next cycle. Now the album
    // is "committed" the moment sendMediaGroup succeeds.
    const { api } = makeApi({ sendMessageError: new Error('rate limit') });
    let posted = false;
    const id = await postAlbumWithRegenButton({
      ...baseArgs, api,
      markPosted: async () => { posted = true; },
    });
    expect(posted).toBe(true);
    // Function returns successfully despite the follow-up failure.
    expect(id).toBe(999);
  });

  it('swallows follow-up errors (does not throw to caller)', async () => {
    // Same as above — we want the async to resolve, not propagate the
    // sendMessage error. Otherwise the caller would have to also know
    // not to revert the mark-as-posted.
    const { api } = makeApi({ sendMessageError: new Error('boom') });
    await expect(
      postAlbumWithRegenButton({
        ...baseArgs, api, markPosted: async () => {},
      })
    ).resolves.toBeDefined();
  });

  it('returns undefined messageId when sendMediaGroup returns empty array', async () => {
    const { api } = makeApi({ sendMediaGroupResult: [] });
    const id = await postAlbumWithRegenButton({
      ...baseArgs, api, markPosted: async () => {},
    });
    expect(id).toBeUndefined();
  });
});

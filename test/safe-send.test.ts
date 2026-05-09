import { describe, expect, it } from 'bun:test';
import { safeSendMessage } from '../src/bot/safe-send.js';

// Minimal fake of grammy's Bot['api']. We only need sendMessage.
function fakeApi(opts: {
  firstError?: { description: string };
  alwaysError?: Error;
}): { api: any; calls: Array<{ chatId: number; text: string; options?: any }> } {
  const calls: Array<{ chatId: number; text: string; options?: any }> = [];
  let attempts = 0;
  const api = {
    sendMessage: async (chatId: number, text: string, options?: any) => {
      calls.push({ chatId, text, options });
      attempts++;
      if (opts.alwaysError) throw opts.alwaysError;
      if (opts.firstError && attempts === 1) {
        const err: any = new Error(opts.firstError.description);
        err.description = opts.firstError.description;
        throw err;
      }
      return { message_id: 42 };
    },
  };
  return { api, calls };
}

describe('safeSendMessage', () => {
  it('sends successfully on the first attempt', async () => {
    const { api, calls } = fakeApi({});
    const res = await safeSendMessage(api, 100, 'hola', { parse_mode: 'HTML' });
    expect(res).toEqual({ message_id: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ parse_mode: 'HTML' });
  });

  it('retries WITHOUT message_thread_id when Telegram says "message thread not found"', async () => {
    // Telegram occasionally returns this for valid topics during topic
    // creation/migration races. Falling back keeps the message visible.
    const { api, calls } = fakeApi({ firstError: { description: 'Bad Request: message thread not found' } });
    const res = await safeSendMessage(api, 100, 'hola', {
      parse_mode: 'HTML',
      message_thread_id: 5,
    });
    expect(res).toEqual({ message_id: 42 });
    expect(calls).toHaveLength(2);
    // First attempt included thread_id; retry stripped it.
    expect(calls[0].options).toMatchObject({ message_thread_id: 5 });
    expect(calls[1].options).not.toHaveProperty('message_thread_id');
    expect(calls[1].options.parse_mode).toBe('HTML');
  });

  it('does NOT retry when there was no message_thread_id to drop', async () => {
    // Same error description but the original call had no thread_id, so
    // the retry would be identical and pointless. Should propagate.
    const { api } = fakeApi({ alwaysError: Object.assign(new Error('boom'), { description: 'Bad Request: message thread not found' }) });
    await expect(safeSendMessage(api, 100, 'hola')).rejects.toThrow();
  });

  it('does NOT retry on unrelated errors', async () => {
    const { api, calls } = fakeApi({ alwaysError: Object.assign(new Error('rate limit'), { description: 'Too Many Requests' }) });
    await expect(
      safeSendMessage(api, 100, 'hola', { message_thread_id: 5 })
    ).rejects.toThrow();
    expect(calls).toHaveLength(1); // no retry attempted
  });
});

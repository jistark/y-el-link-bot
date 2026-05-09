import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

// /ultimo is gated by POLLER_CHAT_ID. We verify the gate works without
// touching the actual poller fetch functions — when chatId doesn't match,
// the handler returns silently and never calls fetchLatestX.

let originalEnv: string | undefined;

beforeAll(() => {
  originalEnv = process.env.POLLER_CHAT_ID;
  process.env.POLLER_CHAT_ID = '12345';
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.POLLER_CHAT_ID;
  else process.env.POLLER_CHAT_ID = originalEnv;
});

describe('registerUltimoCommand — gating', () => {
  // Re-import after env mutation so the module captures POLLER_CHAT_ID
  // at registration time. Each test imports fresh inside an isolated
  // fake bot so we don't carry state across cases.

  async function setup() {
    // The pollerChatId is parsed inside registerUltimoCommand(), not at module
    // load time, so a fresh `import` is unnecessary — each call to
    // registerUltimoCommand picks up the current env.
    const mod = await import('../src/commands/ultimo.js');
    const handlers: Record<string, any> = {};
    const fakeBot: any = {
      command(names: string | string[], fn: any) {
        const arr = Array.isArray(names) ? names : [names];
        for (const n of arr) handlers[n] = fn;
      },
    };
    mod.registerUltimoCommand(fakeBot);
    return handlers;
  }

  it('registers /ultimo and /last aliases', async () => {
    const handlers = await setup();
    expect(handlers).toHaveProperty('ultimo');
    expect(handlers).toHaveProperty('last');
  });

  it('returns silently when chatId does not match POLLER_CHAT_ID', async () => {
    const handlers = await setup();
    let replied = false;
    const ctx: any = {
      chat: { id: 99999 }, // not POLLER_CHAT_ID
      match: '',
      message: {},
      api: {},
      reply: async () => { replied = true; return {}; },
    };
    await handlers.ultimo(ctx);
    expect(replied).toBe(false);
  });

  it('returns silently when POLLER_CHAT_ID is unset (parseInt → NaN)', async () => {
    delete process.env.POLLER_CHAT_ID;
    const handlers = await setup();
    let replied = false;
    const ctx: any = {
      chat: { id: 12345 }, // matches the previous value but env is unset now
      match: '',
      message: {},
      api: {},
      reply: async () => { replied = true; return {}; },
    };
    await handlers.ultimo(ctx);
    expect(replied).toBe(false);
    // restore for subsequent tests in this file
    process.env.POLLER_CHAT_ID = '12345';
  });
});

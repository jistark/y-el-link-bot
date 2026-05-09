import { describe, expect, it } from 'bun:test';
import { Bot } from 'grammy';
import { setupErrorHandler, setupThreadPreservation } from '../src/bot/setup.js';

describe('setupThreadPreservation', () => {
  it('registers cleanly on a real Bot instance', () => {
    const bot = new Bot('test:fake');
    expect(() => setupThreadPreservation(bot)).not.toThrow();
  });

  it('wraps ctx.reply to inject message_thread_id when present', async () => {
    // Simulate the middleware in isolation by capturing the wrapper it
    // installs. The real middleware machinery in grammy is exercised
    // implicitly when the bot processes updates.
    let installedMiddleware: any;
    const fakeBot: any = {
      use(fn: any) { installedMiddleware = fn; },
    };
    setupThreadPreservation(fakeBot);
    expect(typeof installedMiddleware).toBe('function');

    let capturedOpts: any;
    const ctx: any = {
      msg: { message_thread_id: 42 },
      reply: async (_t: string, opts: any) => { capturedOpts = opts; return {}; },
    };
    let nextCalled = false;
    await installedMiddleware(ctx, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);

    // Now call the wrapped reply and check the injected thread.
    await ctx.reply('hola');
    expect(capturedOpts).toEqual({ message_thread_id: 42 });

    // User-supplied options should win.
    await ctx.reply('hola', { parse_mode: 'HTML' });
    expect(capturedOpts.parse_mode).toBe('HTML');
    expect(capturedOpts.message_thread_id).toBe(42);
  });

  it('does NOT wrap ctx.reply when there is no thread', async () => {
    let installedMiddleware: any;
    const fakeBot: any = { use(fn: any) { installedMiddleware = fn; } };
    setupThreadPreservation(fakeBot);

    const originalReply = async (_t: string, _opts: any) => ({ ok: true });
    const ctx: any = { msg: undefined, reply: originalReply };
    await installedMiddleware(ctx, () => {});
    // Identity check: reply was NOT replaced.
    expect(ctx.reply).toBe(originalReply);
  });

  it('user-provided thread_id wins over the injected default', async () => {
    let installedMiddleware: any;
    const fakeBot: any = { use(fn: any) { installedMiddleware = fn; } };
    setupThreadPreservation(fakeBot);

    let capturedOpts: any;
    const ctx: any = {
      msg: { message_thread_id: 42 },
      reply: async (_t: string, opts: any) => { capturedOpts = opts; return {}; },
    };
    await installedMiddleware(ctx, () => {});
    await ctx.reply('hola', { message_thread_id: 99 });
    expect(capturedOpts.message_thread_id).toBe(99);
  });
});

describe('setupErrorHandler', () => {
  it('registers cleanly on a real Bot instance', () => {
    const bot = new Bot('test:fake');
    expect(() => setupErrorHandler(bot)).not.toThrow();
  });

  it('logs structured JSON with event=bot_error and the update id', () => {
    let installedHandler: any;
    const fakeBot: any = { catch(fn: any) { installedHandler = fn; } };
    setupErrorHandler(fakeBot);
    expect(typeof installedHandler).toBe('function');

    const logs: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => { logs.push(msg); };

    try {
      installedHandler({
        message: 'boom',
        ctx: { update: { update_id: 12345 } },
      });
    } finally {
      console.error = origError;
    }

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.event).toBe('bot_error');
    expect(parsed.error).toBe('boom');
    expect(parsed.ctx).toBe(12345);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

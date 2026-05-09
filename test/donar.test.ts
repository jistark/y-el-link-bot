import { describe, expect, it } from 'bun:test';
import { Bot } from 'grammy';
import { registerDonarCommand } from '../src/commands/donar.js';

// donar is one of the simplest commands — a static reply with one URL
// button. We verify it registers without crashing and assert the
// button shape via a fake ctx.

interface FakeCtx {
  reply: (text: string, opts?: any) => Promise<unknown>;
  match?: string;
}

describe('registerDonarCommand', () => {
  it('registers cleanly on a real Bot instance', () => {
    // Bot constructor accepts any non-empty string token; we never call .start().
    const bot = new Bot('test:fake');
    expect(() => registerDonarCommand(bot)).not.toThrow();
  });

  it('reply text references "DVJ" and inline keyboard has the Stripe URL', async () => {
    // Find the registered handler by spying on bot.command. We re-implement
    // a tiny bot that captures registrations.
    const handlers: Record<string, any> = {};
    const fakeBot: any = {
      command(names: string | string[], fn: any) {
        const arr = Array.isArray(names) ? names : [names];
        for (const n of arr) handlers[n] = fn;
      },
    };
    registerDonarCommand(fakeBot);
    expect(handlers).toHaveProperty('donar');
    expect(handlers).toHaveProperty('donate');

    let capturedText: string | undefined;
    let capturedOpts: any;
    const ctx: FakeCtx = {
      async reply(text, opts) { capturedText = text; capturedOpts = opts; return {}; },
    };
    await handlers.donar(ctx);

    expect(capturedText).toMatch(/DVJ/);
    const keyboard = capturedOpts.reply_markup;
    expect(keyboard.inline_keyboard).toHaveLength(1);
    const btn = keyboard.inline_keyboard[0][0];
    expect(btn.url).toMatch(/^https:\/\/donate\.stripe\.com\//);
    expect(btn.text).toContain('Donar');
  });
});

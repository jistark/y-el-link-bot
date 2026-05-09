import { describe, expect, it } from 'bun:test';
import { registerHoroscopoCommand } from '../src/commands/horoscopo-bot.js';

// We test the registration shape and the no-arg branch (which doesn't
// require network). The full happy path goes through getHoroscopo which
// scrapes primedigital.cl — that's covered by integration testing.

describe('registerHoroscopoCommand', () => {
  it('registers /tiayoli and /horoscopo aliases', () => {
    const handlers: Record<string, any> = {};
    const fakeBot: any = {
      command(names: string | string[], fn: any) {
        const arr = Array.isArray(names) ? names : [names];
        for (const n of arr) handlers[n] = fn;
      },
    };
    registerHoroscopoCommand(fakeBot);
    expect(handlers).toHaveProperty('tiayoli');
    expect(handlers).toHaveProperty('horoscopo');
  });

  it('shows help text with sign list when called without an argument', async () => {
    const handlers: Record<string, any> = {};
    const fakeBot: any = {
      command(_: any, fn: any) { handlers.tiayoli = fn; },
    };
    registerHoroscopoCommand(fakeBot);

    let captured: string | undefined;
    let optsCaptured: any;
    const ctx: any = {
      match: '',
      reply: async (text: string, opts: any) => { captured = text; optsCaptured = opts; return {}; },
    };
    await handlers.tiayoli(ctx);
    expect(captured).toContain('Yolanda Sultana');
    expect(captured).toContain('/tiayoli');
    expect(optsCaptured.parse_mode).toBe('HTML');
  });

  it('shows help text when match is whitespace only', async () => {
    const handlers: Record<string, any> = {};
    const fakeBot: any = {
      command(_: any, fn: any) { handlers.tiayoli = fn; },
    };
    registerHoroscopoCommand(fakeBot);

    let captured: string | undefined;
    const ctx: any = {
      match: '   ',
      reply: async (text: string) => { captured = text; return {}; },
    };
    await handlers.tiayoli(ctx);
    expect(captured).toContain('Yolanda Sultana');
  });
});

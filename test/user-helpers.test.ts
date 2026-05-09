import { describe, expect, it } from 'bun:test';
import { getUserMention, getTextWithoutUrls, createUndoKeyboard } from '../src/bot/user-helpers.js';
import type { Context } from 'grammy';

// Helper to fake a grammy Context — only the fields we read are populated.
function fakeCtx(from: { id?: number; username?: string; first_name?: string } | undefined): Context {
  return { from } as unknown as Context;
}

describe('getUserMention', () => {
  it('returns @username when present', () => {
    expect(getUserMention(fakeCtx({ id: 1, username: 'alice', first_name: 'Alice' })))
      .toBe('@alice');
  });

  it('falls back to tg://user link with first_name when no username', () => {
    expect(getUserMention(fakeCtx({ id: 42, first_name: 'Bob' })))
      .toBe('<a href="tg://user?id=42">Bob</a>');
  });

  it('escapes HTML metacharacters in first_name (regression: Telegram allows < > & in names)', () => {
    expect(getUserMention(fakeCtx({ id: 7, first_name: '<script>x' })))
      .toBe('<a href="tg://user?id=7">&lt;script&gt;x</a>');
    expect(getUserMention(fakeCtx({ id: 8, first_name: 'A & B' })))
      .toBe('<a href="tg://user?id=8">A &amp; B</a>');
  });

  it('returns empty string when ctx.from is missing', () => {
    expect(getUserMention(fakeCtx(undefined))).toBe('');
  });
});

describe('getTextWithoutUrls', () => {
  it('strips a single URL and trims', () => {
    expect(getTextWithoutUrls('mira https://example.com/foo')).toBe('mira');
  });

  it('strips multiple URLs', () => {
    expect(getTextWithoutUrls('a https://x.com b https://y.com c')).toBe('a  b  c');
  });

  it('returns plain text unchanged', () => {
    expect(getTextWithoutUrls('hola mundo')).toBe('hola mundo');
  });

  it('returns empty for URL-only input', () => {
    expect(getTextWithoutUrls('https://example.com/foo')).toBe('');
  });
});

describe('createUndoKeyboard', () => {
  it('returns a keyboard with a single Cancelar button bound to "undo"', () => {
    const kb = createUndoKeyboard();
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toHaveLength(1);
    const btn = kb.inline_keyboard[0][0];
    expect(btn.text).toContain('Cancelar');
    expect((btn as any).callback_data).toBe('undo');
  });
});

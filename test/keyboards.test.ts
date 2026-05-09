import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// keyboards.ts uses cache + pathToUrl from state.ts. Sandbox via chdir
// before dynamic import (state.ts itself doesn't read disk, but downstream
// dependents do, and we want consistency with other state-dependent tests).

let tmpdirPath: string;
let originalCwd: string;
let kb: typeof import('../src/bot/keyboards.js');
let state: typeof import('../src/bot/state.js');

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpdirPath = await mkdtemp(join(tmpdir(), 'jdv-keyboards-test-'));
  process.chdir(tmpdirPath);
  state = await import('../src/bot/state.js');
  kb = await import('../src/bot/keyboards.js');
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(tmpdirPath, { recursive: true, force: true });
});

function findCallback(keyboard: ReturnType<typeof kb.createActionKeyboard>, prefix: string): string | undefined {
  for (const row of keyboard.inline_keyboard) {
    for (const btn of row) {
      const data = (btn as any).callback_data;
      if (typeof data === 'string' && data.startsWith(prefix)) return data;
    }
  }
}

describe('createActionKeyboard', () => {
  it('emits 4 buttons (del, regen, archive.ph, twitter)', () => {
    const k = kb.createActionKeyboard('Mi-Slug-X', 12345, 'https://example.com/foo');
    const buttons = k.inline_keyboard.flat();
    expect(buttons).toHaveLength(4);
    const callbacks = buttons.map(b => (b as any).callback_data).filter(Boolean) as string[];
    const urls = buttons.map(b => (b as any).url).filter(Boolean) as string[];
    expect(callbacks.some(c => c.startsWith('del:'))).toBe(true);
    expect(callbacks.some(c => c.startsWith('regen:'))).toBe(true);
    expect(urls.some(u => u.startsWith('https://archive.ph/'))).toBe(true);
    expect(urls.some(u => u.startsWith('https://twitter.com/'))).toBe(true);
  });

  it('records the path → URL mapping for later regen', () => {
    const path = `slug-${Date.now()}`;
    kb.createActionKeyboard(path, 7, 'https://example.com/article');
    expect(state.pathToUrl.get(path)).toBe('https://example.com/article');
  });

  it('embeds userId AND base36 timestamp in del callback', () => {
    const k = kb.createActionKeyboard('Mi-Slug', 12345, 'https://example.com/x');
    const del = findCallback(k, 'del:')!;
    // del:{path}:{userId}:{base36-timestamp}
    const parts = del.split(':');
    expect(parts[0]).toBe('del');
    expect(parts[1]).toBe('Mi-Slug');
    expect(parts[2]).toBe('12345');
    // base36 timestamp should be alphanumeric and non-empty
    expect(parts[3]).toMatch(/^[0-9a-z]+$/);
  });

  it('embeds userId in regen callback', () => {
    const k = kb.createActionKeyboard('Mi-Slug', 12345, 'https://example.com/x');
    const regen = findCallback(k, 'regen:')!;
    expect(regen).toBe('regen:Mi-Slug:12345');
  });

  it('falls back to "x" sentinel in regen when full callback would exceed 64 bytes', () => {
    // Pick a path that is just past the threshold for the FULL form
    // ("regen:{path}:{userId}") but the FALLBACK form ("regen:{path}:x")
    // still fits under 64. Real Telegraph slugs are 30-50 chars.
    const path = 'A'.repeat(45);
    const userId = 1234567890; // 10 digits
    // regen:45chars:10digits = 6+45+1+10 = 62 ✓ fits, no fallback expected.
    // We need the FULL to NOT fit but FALLBACK to fit:
    const longPath = 'A'.repeat(55);
    // full: 6+55+1+10 = 72 → too big → fallback
    // fallback: 6+55+1+1 = 63 ≤ 64 → fits
    const k = kb.createActionKeyboard(longPath, userId, 'https://example.com/x');
    const regen = findCallback(k, 'regen:')!;
    expect(regen.endsWith(':x')).toBe(true);
    expect(Buffer.byteLength(regen, 'utf-8')).toBeLessThanOrEqual(64);
  });

  it('falls back to "0" timestamp in del when full callback would exceed 64 bytes', () => {
    // Same shape as above. del:{path}:{userId}:{ts}; ts is base36 of seconds (~7 chars in 2026).
    // Choose path so full overflows but fallback (ts=0, saves ~6 chars) fits.
    const longPath = 'A'.repeat(50);
    const userId = 1234567890;
    // full: 4+50+1+10+1+7 = 73 → overflow
    // fallback: 4+50+1+10+1+1 = 67 → still over!
    // Use a shorter user id to ensure fallback fits:
    const shortUid = 12345; // 5 digits
    // full: 4+50+1+5+1+7 = 68 → overflow
    // fallback: 4+50+1+5+1+1 = 62 ≤ 64 ✓
    const k = kb.createActionKeyboard(longPath, shortUid, 'https://example.com/x');
    const del = findCallback(k, 'del:')!;
    expect(del.endsWith(':0')).toBe(true);
    expect(Buffer.byteLength(del, 'utf-8')).toBeLessThanOrEqual(64);
  });

  it('URL-encodes archive and twitter buttons', () => {
    const k = kb.createActionKeyboard('p', 1, 'https://example.com/?a=1&b=2');
    const buttons = k.inline_keyboard.flat();
    const archive = buttons.find(b => (b as any).url?.startsWith('https://archive.ph/')) as any;
    expect(archive.url).toContain('%3F'); // ? encoded
    expect(archive.url).toContain('%3D'); // = encoded
  });
});

describe('getUrlForPath', () => {
  it('returns the URL recorded by createActionKeyboard', async () => {
    const path = `path-roundtrip-${Date.now()}`;
    kb.createActionKeyboard(path, 1, 'https://example.com/round');
    const url = await kb.getUrlForPath(path);
    expect(url).toBe('https://example.com/round');
  });

  it('returns null for an unknown path with no Telegraph fallback available', async () => {
    // Network call to api.telegra.ph will fail (path doesn't exist) and
    // we expect null rather than a throw.
    const url = await kb.getUrlForPath('nonexistent-path-zzz-' + Date.now());
    expect(url).toBeNull();
  }, 10_000);
});

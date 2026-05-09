import { describe, expect, it } from 'bun:test';
import { hashGuid, createRssRegenKeyboard } from '../src/services/rss-shared.js';

describe('hashGuid', () => {
  it('produces a 16-char hex string', () => {
    const h = hashGuid('https://example.com/?p=123');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic across calls', () => {
    const a = hashGuid('https://example.com/?p=123');
    const b = hashGuid('https://example.com/?p=123');
    expect(a).toBe(b);
  });

  it('produces distinct hashes for WordPress-style GUIDs that share a long prefix', () => {
    // Regression: the old 20-char prefix truncation collapsed every
    // ?p=N entry from the same site into a single key. SHA-256 makes
    // them effectively unique.
    const guids = [
      'https://www.adn.cl/?p=12345',
      'https://www.adn.cl/?p=12346',
      'https://www.adn.cl/?p=12347',
      'https://www.adn.cl/?p=12348',
    ];
    const hashes = new Set(guids.map(hashGuid));
    expect(hashes.size).toBe(guids.length);
  });

  it('does not collide for a moderate batch of realistic feed URLs', () => {
    const sources = [
      'https://adprensa.cl/?p=1', 'https://adprensa.cl/?p=2', 'https://adprensa.cl/?p=3',
      'https://senal.com/?p=1', 'https://senal.com/?p=2',
      'https://example.org/2026/04/26/foo', 'https://example.org/2026/04/27/bar',
      'tag:example.com,2026:item-1', 'tag:example.com,2026:item-2',
    ];
    const hashes = new Set(sources.map(hashGuid));
    expect(hashes.size).toBe(sources.length);
  });
});

describe('createRssRegenKeyboard', () => {
  it('builds callback_data with regen_rss prefix and SHA-256 hash', () => {
    const kb = createRssRegenKeyboard('senal', 'https://example.com/?p=42');
    // Inspect the inline_keyboard structure
    const data = kb.inline_keyboard[0]?.[0];
    expect(data?.callback_data).toMatch(/^regen_rss:senal:[0-9a-f]{16}$/);
  });

  it('keeps callback_data well under Telegram 64-byte limit', () => {
    const longGuid = 'https://this-is-a-very-long-domain-name.example.com/posts/' + 'x'.repeat(500);
    const kb = createRssRegenKeyboard('fotoportadas', longGuid);
    const data = kb.inline_keyboard[0]?.[0]?.callback_data ?? '';
    // 'regen_rss:fotoportadas:' (23) + 16 hex = 39 bytes
    expect(Buffer.byteLength(data, 'utf-8')).toBeLessThan(64);
  });
});

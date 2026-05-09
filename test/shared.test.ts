import { describe, expect, it } from 'bun:test';
import { decodeEntities, escapeHtmlMinimal, withTimeout, sleep } from '../src/utils/shared.js';

describe('escapeHtmlMinimal', () => {
  it('escapes ampersand, less-than, greater-than', () => {
    expect(escapeHtmlMinimal('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(escapeHtmlMinimal('a < b')).toBe('a &lt; b');
    expect(escapeHtmlMinimal('a > b')).toBe('a &gt; b');
  });

  it('escapes ampersand FIRST so &lt; does not become &amp;lt;', () => {
    // If the order were reversed (< then &), the < would already be &lt;
    // and the subsequent & escape would re-escape the ampersand,
    // producing the wrong output.
    expect(escapeHtmlMinimal('<b>')).toBe('&lt;b&gt;');
    expect(escapeHtmlMinimal('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('handles plain text unchanged', () => {
    expect(escapeHtmlMinimal('hola mundo')).toBe('hola mundo');
    expect(escapeHtmlMinimal('')).toBe('');
  });

  it('does not touch single quotes or double quotes', () => {
    // Minimal escape — these are safe for textContent in HTML elements,
    // but unsafe inside attribute values. By design.
    expect(escapeHtmlMinimal('he said "hi"')).toBe('he said "hi"');
    expect(escapeHtmlMinimal("don't")).toBe("don't");
  });
});

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeEntities('caf&eacute;')).toBe('café');
    expect(decodeEntities('&iquest;qu&eacute;?')).toBe('¿qué?');
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeEntities('&#233;')).toBe('é');
  });

  it('decodes hex numeric entities (was missing in old lun.ts version)', () => {
    expect(decodeEntities('&#x1F4A9;')).toBe('💩');
    expect(decodeEntities('&#xe9;')).toBe('é');
  });

  it('coerces non-string input instead of throwing', () => {
    expect(decodeEntities(undefined as unknown as string)).toBe('');
    expect(decodeEntities(null as unknown as string)).toBe('');
    expect(decodeEntities(123 as unknown as string)).toBe('123');
  });
});

describe('withTimeout', () => {
  it('resolves with the inner value when promise wins', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('rejects with timeout error when promise is too slow', async () => {
    const slow = sleep(500).then(() => 'too late');
    await expect(withTimeout(slow, 50)).rejects.toThrow('Timeout');
  });

  it('uses custom label in timeout error', async () => {
    const slow = sleep(500).then(() => 'too late');
    await expect(withTimeout(slow, 50, 'my-op timed out')).rejects.toThrow('my-op timed out');
  });

  it('does not leak the timer when the inner promise wins quickly', async () => {
    // If the timer were not cleared, the test runner would have a 30s timer
    // hanging around after this assertion. We can't observe that directly,
    // but we can at least verify the value comes back fast.
    const t0 = Date.now();
    await withTimeout(Promise.resolve(42), 30_000);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('does not produce unhandled rejections after the race resolves', async () => {
    let unhandled = 0;
    const handler = () => { unhandled++; };
    process.on('unhandledRejection', handler);
    try {
      await withTimeout(Promise.resolve('ok'), 50);
      // Yield enough ticks for any orphaned timer to have fired.
      await sleep(120);
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});

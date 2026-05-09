import { describe, expect, it } from 'bun:test';
import { formatViewers, ZAPPING_CHANNELS } from '../src/commands/rating.js';

describe('formatViewers', () => {
  it('uses Chilean thousand separator (period)', () => {
    expect(formatViewers(1234)).toBe('1.234');
    expect(formatViewers(1234567)).toBe('1.234.567');
  });

  it('handles zero and small numbers', () => {
    expect(formatViewers(0)).toBe('0');
    expect(formatViewers(99)).toBe('99');
    expect(formatViewers(999)).toBe('999');
  });
});

describe('ZAPPING_CHANNELS', () => {
  it('contains the 6 expected Chilean channels in display order', () => {
    expect(ZAPPING_CHANNELS).toHaveLength(6);
    const ids = ZAPPING_CHANNELS.map(c => c.id);
    expect(ids).toEqual(['tvno', 'mega', '13', 'chv', 'lared', 'tvm']);
  });

  it('every channel has emoji + name + id', () => {
    for (const ch of ZAPPING_CHANNELS) {
      expect(typeof ch.id).toBe('string');
      expect(typeof ch.name).toBe('string');
      expect(ch.emoji.length).toBeGreaterThan(0);
    }
  });

  it('uses unique ids', () => {
    const ids = new Set(ZAPPING_CHANNELS.map(c => c.id));
    expect(ids.size).toBe(ZAPPING_CHANNELS.length);
  });
});

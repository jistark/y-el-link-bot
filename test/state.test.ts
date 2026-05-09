import { describe, expect, it } from 'bun:test';
import { isRateLimited, RATE_LIMIT, RATE_WINDOW } from '../src/bot/state.js';

// isRateLimited is stateful — uses a module-private Map. Each test uses a
// distinct userId to avoid bleed-over.

describe('isRateLimited', () => {
  it('allows up to RATE_LIMIT requests in a row, then blocks', () => {
    const userId = 1_000_001;
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect(isRateLimited(userId)).toBe(false);
    }
    // The (RATE_LIMIT + 1)th request must be blocked.
    expect(isRateLimited(userId)).toBe(true);
  });

  it('keeps blocking on subsequent calls within the window', () => {
    const userId = 1_000_002;
    for (let i = 0; i < RATE_LIMIT; i++) isRateLimited(userId);
    expect(isRateLimited(userId)).toBe(true);
    expect(isRateLimited(userId)).toBe(true);
    expect(isRateLimited(userId)).toBe(true);
  });

  it('tracks separate users independently', () => {
    const a = 1_000_003;
    const b = 1_000_004;
    for (let i = 0; i < RATE_LIMIT; i++) isRateLimited(a);
    expect(isRateLimited(a)).toBe(true);
    // b is untouched — still allowed.
    expect(isRateLimited(b)).toBe(false);
  });

  it('exposes sane RATE_LIMIT and RATE_WINDOW constants', () => {
    expect(RATE_LIMIT).toBeGreaterThan(0);
    expect(RATE_LIMIT).toBeLessThan(1000); // sanity: not "unlimited"
    expect(RATE_WINDOW).toBeGreaterThanOrEqual(1000); // at least 1 second
  });
});

import { describe, expect, it } from 'bun:test';
import { canRegen, parseRegenCallback } from '../src/utils/callbacks.js';

describe('parseRegenCallback', () => {
  it('parses standard regen:{path}:{userId} format', () => {
    const out = parseRegenCallback('regen:Mi-Slug-X-12-31:123456789');
    expect(out.telegraphPath).toBe('Mi-Slug-X-12-31');
    expect(out.ownerId).toBe(123456789);
  });

  it('returns ownerId=null for the "x" sentinel (truncated callback)', () => {
    // Regression: the old fallback was `:0`, which made every owner check
    // fail because no user has Telegram ID 0. The sentinel "x" disables
    // the owner check explicitly so the handler degrades to admin-only.
    const out = parseRegenCallback('regen:Some-Long-Slug:x');
    expect(out.telegraphPath).toBe('Some-Long-Slug');
    expect(out.ownerId).toBeNull();
  });

  it('returns ownerId=null for non-numeric ids that are not the sentinel', () => {
    // Defensive: anything that doesn't parse as an integer should be
    // treated as "owner unknown" rather than NaN comparing falsely.
    const out = parseRegenCallback('regen:slug:garbage');
    expect(out.ownerId).toBeNull();
  });

  it('throws for non-regen prefixes', () => {
    expect(() => parseRegenCallback('del:slug:1:0')).toThrow(/Not a regen/);
  });

  it('throws for malformed input (no separator)', () => {
    expect(() => parseRegenCallback('regen:onlyone')).toThrow(/Malformed/);
  });
});

describe('canRegen', () => {
  it('admin can always regen', () => {
    expect(canRegen({ ownerId: 1, userId: 999, isAdmin: true })).toBe(true);
    expect(canRegen({ ownerId: null, userId: 999, isAdmin: true })).toBe(true);
    expect(canRegen({ ownerId: 1, userId: undefined, isAdmin: true })).toBe(true);
  });

  it('non-admin owner can regen', () => {
    expect(canRegen({ ownerId: 42, userId: 42, isAdmin: false })).toBe(true);
  });

  it('non-admin non-owner cannot regen', () => {
    expect(canRegen({ ownerId: 42, userId: 7, isAdmin: false })).toBe(false);
  });

  it('with sentinel (ownerId=null), only admins can regen', () => {
    // Regression: before the sentinel fix, ownerId was 0 and userId === 0
    // never matched, so non-admin owners couldn't regen their own articles
    // when the callback was truncated. With the sentinel, the design is
    // explicit: "owner unknown → admin-only".
    expect(canRegen({ ownerId: null, userId: 42, isAdmin: false })).toBe(false);
    expect(canRegen({ ownerId: null, userId: 42, isAdmin: true })).toBe(true);
  });

  it('userId undefined and not admin → false', () => {
    expect(canRegen({ ownerId: 42, userId: undefined, isAdmin: false })).toBe(false);
  });
});

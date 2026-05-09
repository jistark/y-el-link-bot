import { describe, expect, it } from 'bun:test';
import { callbackHandlers } from '../src/bot/callbacks/index.js';
import { undoHandler } from '../src/bot/callbacks/undo.js';
import { delHandler, legacyDeleteHandler } from '../src/bot/callbacks/delete.js';
import { regenArticleHandler } from '../src/bot/callbacks/regen-article.js';
import { regenRssHandler } from '../src/bot/callbacks/regen-rss.js';
import { empageHandler } from '../src/bot/callbacks/empage.js';
import { lunpageHandler } from '../src/bot/callbacks/lunpage.js';

// Tests verify the matches() predicates only — handle() is the integration
// surface and lives behind grammy Context, which is exercised by manual
// QA. Ordering and routing invariants ARE testable here in isolation.

describe('matches() — undo', () => {
  it('matches the literal string only', () => {
    expect(undoHandler.matches('undo')).toBe(true);
    expect(undoHandler.matches('undo:')).toBe(false);
    expect(undoHandler.matches('undone')).toBe(false);
    expect(undoHandler.matches('')).toBe(false);
  });
});

describe('matches() — del:', () => {
  it('matches del:* but not delete:* or unrelated', () => {
    expect(delHandler.matches('del:slug:1:0')).toBe(true);
    expect(delHandler.matches('del:')).toBe(true);
    // delete: starts with "del" but not with "del:"
    expect(delHandler.matches('delete:slug:1')).toBe(false);
    expect(delHandler.matches('regen:slug:1')).toBe(false);
    expect(delHandler.matches('undo')).toBe(false);
  });
});

describe('matches() — delete: (legacy)', () => {
  it('matches delete:* but not del:*', () => {
    expect(legacyDeleteHandler.matches('delete:slug:1')).toBe(true);
    expect(legacyDeleteHandler.matches('delete:')).toBe(true);
    expect(legacyDeleteHandler.matches('del:slug:1:0')).toBe(false);
  });
});

describe('matches() — regen:', () => {
  it('matches regen:* but NOT regen_rss:*', () => {
    expect(regenArticleHandler.matches('regen:slug:123')).toBe(true);
    expect(regenArticleHandler.matches('regen:slug:x')).toBe(true);
    // regen_rss starts with "regen" but not with "regen:"
    expect(regenArticleHandler.matches('regen_rss:senal:abc')).toBe(false);
  });
});

describe('matches() — regen_rss:', () => {
  it('matches regen_rss:* only', () => {
    expect(regenRssHandler.matches('regen_rss:adprensa:abc')).toBe(true);
    expect(regenRssHandler.matches('regen_rss:senal:def')).toBe(true);
    expect(regenRssHandler.matches('regen:slug:1')).toBe(false);
  });
});

describe('matches() — empage:', () => {
  it('matches empage:* only', () => {
    expect(empageHandler.matches('empage:g:0')).toBe(true);
    expect(empageHandler.matches('empage:a:5')).toBe(true);
    expect(empageHandler.matches('lunpage:g:0')).toBe(false);
  });
});

describe('matches() — lunpage:', () => {
  it('matches lunpage:* only', () => {
    expect(lunpageHandler.matches('lunpage:g:0')).toBe(true);
    expect(lunpageHandler.matches('empage:g:0')).toBe(false);
  });
});

describe('callbackHandlers registry', () => {
  it('lists every handler exactly once', () => {
    const names = callbackHandlers.map(h => h.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
    expect(unique).toContain('undo');
    expect(unique).toContain('del');
    expect(unique).toContain('delete-legacy');
    expect(unique).toContain('regen');
    expect(unique).toContain('regen_rss');
    expect(unique).toContain('empage');
    expect(unique).toContain('lunpage');
  });

  it('places regen_rss BEFORE regen so the more-specific prefix wins', () => {
    const names = callbackHandlers.map(h => h.name);
    expect(names.indexOf('regen_rss')).toBeLessThan(names.indexOf('regen'));
  });

  it('routes a real callback string to exactly one handler', () => {
    const samples: Array<{ data: string; expected: string }> = [
      { data: 'undo', expected: 'undo' },
      { data: 'del:Mi-Slug:42:abc', expected: 'del' },
      { data: 'delete:Mi-Slug:42', expected: 'delete-legacy' },
      { data: 'regen:Mi-Slug:42', expected: 'regen' },
      { data: 'regen:Mi-Slug:x', expected: 'regen' },
      { data: 'regen_rss:senal:abc123', expected: 'regen_rss' },
      { data: 'empage:g:0', expected: 'empage' },
      { data: 'empage:a:5', expected: 'empage' },
      { data: 'lunpage:g:0', expected: 'lunpage' },
    ];
    for (const { data, expected } of samples) {
      const matched = callbackHandlers.filter(h => h.matches(data));
      expect(matched.length).toBeGreaterThanOrEqual(1);
      // First-match-wins is the dispatcher contract — assert the FIRST
      // handler whose predicate matches is the expected one.
      expect(matched[0].name).toBe(expected);
    }
  });

  it('returns no matches for an unknown callback shape', () => {
    expect(callbackHandlers.filter(h => h.matches('unknown_prefix:foo'))).toHaveLength(0);
    expect(callbackHandlers.filter(h => h.matches(''))).toHaveLength(0);
  });
});

import { describe, expect, it } from 'bun:test';
import { getRecipe, hasRecipe } from '../src/extractors/recipes.js';

describe('getRecipe', () => {
  it('returns headers for a known domain', () => {
    // The bypass-rules.json includes nytimes.com. We don't assert the
    // specific header values — those depend on the upstream rules file —
    // only that we get a non-null result with at least a User-Agent.
    const r = getRecipe('https://www.nytimes.com/2026/01/01/foo.html');
    expect(r).not.toBeNull();
    expect(r?.headers['User-Agent']).toBeDefined();
  });

  it('returns null for a domain with no recipe', () => {
    expect(getRecipe('https://random-no-recipe-domain-xyz123.com/x')).toBeNull();
  });

  it('falls through multiple subdomain levels to find a parent rule', () => {
    // Regression for the parent-domain peeling bug: the old findRule only
    // peeled one level, so news.regional.ft.com would not match ft.com.
    const r = getRecipe('https://news.regional.ft.com/articles/x');
    expect(r).not.toBeNull();
  });

  it('hasRecipe agrees with getRecipe', () => {
    expect(hasRecipe('https://www.nytimes.com/x')).toBe(true);
    expect(hasRecipe('https://random-no-recipe-domain-xyz123.com/x')).toBe(false);
  });

  it('does not include a Cookie header when stripCookies is set (no empty value)', () => {
    // Regression: previously `allHeaders['Cookie'] = ''` was sent as an
    // empty header, which is a browser-anomaly fingerprint that triggers
    // anti-bot scoring on Cloudflare/Vercel. Now the header is deleted.
    // We check via getRecipe that no Cookie key is present in the returned
    // headers — even for sites where stripCookies would apply (we can't
    // easily tell which without inspecting the rules file, so just assert
    // the invariant for a known site).
    const r = getRecipe('https://www.nytimes.com/x');
    if (r) {
      expect(r.headers).not.toHaveProperty('Cookie');
    }
  });
});

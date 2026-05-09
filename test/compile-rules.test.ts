import { describe, expect, it } from 'bun:test';
import { parseSitesJs, transformObjectLiteral } from '../scripts/compile-rules.js';

function wrap(body: string): string {
  return `var defaultSites = {\n${body}\n};\n`;
}

describe('transformObjectLiteral', () => {
  it('preserves URLs inside string values (regression: wsj/marketwatch corruption)', () => {
    const src = wrap(`
"WSJ": {
  domain: "wsj.com",
  allow_cookies: 1,
  referer_custom: "https://www.drudgereport.com/"
}`);
    const sites = parseSitesJs(src);
    expect(sites['WSJ'].referer_custom).toBe('https://www.drudgereport.com/');
  });

  it('replaces regex literals in values with null', () => {
    const src = wrap(`
"X": {
  domain: "x.com",
  block_regex: /\\.x\\.com\\/(meter|paywall)\\.js/gim,
  allow_cookies: 1
}`);
    const sites = parseSitesJs(src);
    expect(sites['X'].domain).toBe('x.com');
    expect((sites['X'] as Record<string, unknown>).block_regex).toBeNull();
    expect((sites['X'] as Record<string, unknown>).allow_cookies).toBe(1);
  });

  it('preserves slashes in string paths that look like regex contents', () => {
    const src = wrap(`
"P": {
  domain: "p.com",
  referer_custom: "https://example.com/path/to/resource",
  headers_custom: { "x-foo": "/api/v1/route" }
}`);
    const sites = parseSitesJs(src);
    expect(sites['P'].referer_custom).toBe('https://example.com/path/to/resource');
    expect(sites['P'].headers_custom?.['x-foo']).toBe('/api/v1/route');
  });

  it('quotes unquoted identifier keys', () => {
    const src = wrap(`
"K": {
  domain: "k.com",
  allow_cookies: 1
}`);
    const sites = parseSitesJs(src);
    expect(sites['K'].domain).toBe('k.com');
    expect(sites['K'].allow_cookies).toBe(1);
  });

  it('drops trailing commas before } and ]', () => {
    const src = wrap(`
"T": {
  domain: "t.com",
  group: ["a.com", "b.com",],
  allow_cookies: 1,
}`);
    const sites = parseSitesJs(src);
    expect(sites['T'].group).toEqual(['a.com', 'b.com']);
    expect(sites['T'].allow_cookies).toBe(1);
  });

  it('handles single-quoted strings without losing content', () => {
    const src = wrap(`
"S": {
  domain: 'single.com',
  referer_custom: 'https://www.drudgereport.com/'
}`);
    const sites = parseSitesJs(src);
    // Single-quoted strings need to round-trip as JS, but our parser quotes
    // identifiers and uses Function-eval fallback for non-JSON forms.
    expect(sites['S'].domain).toBe('single.com');
    expect(sites['S'].referer_custom).toBe('https://www.drudgereport.com/');
  });

  it('returns transform end pointing at the matching outer brace', () => {
    const src = `var defaultSites = { a: { b: 1 } };\nrest of file`;
    const start = src.indexOf('{', src.indexOf('defaultSites'));
    const { end } = transformObjectLiteral(src, start);
    expect(src.slice(end - 1, end)).toBe('}');
  });

  it('skips line and block comments inside the object literal', () => {
    const src = wrap(`
// a comment
"C": {
  /* block */
  domain: "c.com", // trailing
  allow_cookies: 1
}`);
    const sites = parseSitesJs(src);
    expect(sites['C'].domain).toBe('c.com');
  });
});

describe('extractRule (smoke through parseSitesJs)', () => {
  it('preserves headers_custom record', () => {
    const src = wrap(`
"H": {
  domain: "haaretz.com",
  useragent_custom: "Mozilla/5.0 mobile",
  headers_custom: { ismobileapp: "true", platform: "app" }
}`);
    const sites = parseSitesJs(src);
    expect(sites['H'].useragent_custom).toBe('Mozilla/5.0 mobile');
    expect(sites['H'].headers_custom).toEqual({ ismobileapp: 'true', platform: 'app' });
  });
});

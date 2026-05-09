import { describe, expect, it } from 'bun:test';
import {
  deAmpUrl, extractUrls, isExtractableUrl, isOnAllowlist, isPrivateOrReservedHost,
  SKIP_DOMAINS, EXTRA_ALLOWED, LINK_EXPANDER_BOTS,
} from '../src/bot/url-filter.js';

describe('isPrivateOrReservedHost', () => {
  it('flags loopback', () => {
    expect(isPrivateOrReservedHost('localhost')).toBe(true);
    expect(isPrivateOrReservedHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('127.55.99.123')).toBe(true);
    expect(isPrivateOrReservedHost('::1')).toBe(true);
    expect(isPrivateOrReservedHost('0.0.0.0')).toBe(true);
  });

  it('flags RFC1918 private ranges', () => {
    expect(isPrivateOrReservedHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('10.255.255.254')).toBe(true);
    expect(isPrivateOrReservedHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('172.31.255.254')).toBe(true);
    expect(isPrivateOrReservedHost('192.168.1.1')).toBe(true);
  });

  it('flags AWS/GCP cloud-metadata IP', () => {
    // 169.254.169.254 is the canonical SSRF target on AWS/GCP/Azure.
    expect(isPrivateOrReservedHost('169.254.169.254')).toBe(true);
  });

  it('flags IPv6-mapped IPv4 metadata IP (::ffff:169.254.169.254)', () => {
    expect(isPrivateOrReservedHost('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('::ffff:10.0.0.1')).toBe(true);
  });

  it('flags IPv6 ULA (fd00::/8) and link-local (fe80::/10)', () => {
    expect(isPrivateOrReservedHost('fd00::1')).toBe(true);
    expect(isPrivateOrReservedHost('fdab:cd::1')).toBe(true);
    expect(isPrivateOrReservedHost('fe80::1')).toBe(true);
  });

  it('strips IPv6 brackets before testing', () => {
    expect(isPrivateOrReservedHost('[::1]')).toBe(true);
    expect(isPrivateOrReservedHost('[fd00::1]')).toBe(true);
  });

  it('does NOT flag legitimate public addresses', () => {
    expect(isPrivateOrReservedHost('lasegunda.com')).toBe(false);
    expect(isPrivateOrReservedHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedHost('172.15.0.1')).toBe(false); // outside 16-31
    expect(isPrivateOrReservedHost('172.32.0.1')).toBe(false);
  });

  it('does NOT flag 11.x or 9.x (close to but not in private ranges)', () => {
    expect(isPrivateOrReservedHost('11.0.0.1')).toBe(false);
    expect(isPrivateOrReservedHost('9.0.0.1')).toBe(false);
  });
});

describe('isOnAllowlist', () => {
  it('reports custom_extractor for known sites with extractors', () => {
    const r = isOnAllowlist('https://www.lasegunda.com/sociedad/123456/foo');
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('custom_extractor');
  });

  it('reports bypass_recipe for sites in bypass-rules.json', () => {
    const r = isOnAllowlist('https://www.nytimes.com/2026/01/01/us/x.html');
    expect(r.allowed).toBe(true);
    expect(['custom_extractor', 'bypass_recipe']).toContain(r.reason);
  });

  it('reports extra_allowed for EXTRA_ALLOWED domains', () => {
    const r = isOnAllowlist('https://blog.google/products/ai/some-post');
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('extra_allowed');
  });

  it('returns not_in_allowlist for random domains', () => {
    const r = isOnAllowlist('https://random-no-recipe-domain-xyz123.com/article');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_in_allowlist');
  });

  it('handles malformed URLs without throwing', () => {
    const r = isOnAllowlist('not-a-url');
    expect(r.allowed).toBe(false);
  });
});

describe('isExtractableUrl', () => {
  it('returns true for an allowlisted public URL with a path', () => {
    expect(isExtractableUrl('https://www.lasegunda.com/sociedad/123456/foo')).toBe(true);
  });

  it('returns false for SKIP_DOMAINS (social media, video, etc.)', () => {
    expect(isExtractableUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isExtractableUrl('https://twitter.com/some/post/123')).toBe(false);
    expect(isExtractableUrl('https://t.me/somechannel/4567')).toBe(false);
  });

  it('returns false for sub.skip.com via endsWith match', () => {
    expect(isExtractableUrl('https://music.spotify.com/album/abc')).toBe(false);
    expect(isExtractableUrl('https://m.facebook.com/post/123')).toBe(false);
  });

  it('rejects private/reserved hosts (SSRF)', () => {
    expect(isExtractableUrl('http://localhost:8080/foo')).toBe(false);
    expect(isExtractableUrl('http://10.0.0.1/admin')).toBe(false);
    expect(isExtractableUrl('http://169.254.169.254/metadata')).toBe(false);
  });

  it('rejects homepages (no path beyond /)', () => {
    expect(isExtractableUrl('https://www.lasegunda.com/')).toBe(false);
    expect(isExtractableUrl('https://www.lasegunda.com')).toBe(false);
  });

  it('rejects URLs not on the allowlist even if they have valid paths', () => {
    expect(isExtractableUrl('https://random-no-recipe-domain-xyz123.com/some/article')).toBe(false);
  });

  it('handles malformed URLs without throwing', () => {
    expect(isExtractableUrl('not-a-url')).toBe(false);
    expect(isExtractableUrl('')).toBe(false);
    expect(isExtractableUrl('http://')).toBe(false);
  });
});

describe('extractUrls', () => {
  it('pulls a single URL from prose', () => {
    expect(extractUrls('mira esto: https://example.com/foo'))
      .toEqual(['https://example.com/foo']);
  });

  it('pulls multiple URLs', () => {
    const out = extractUrls('a https://example.com/x b http://example.org/y c');
    expect(out).toEqual(['https://example.com/x', 'http://example.org/y']);
  });

  it('strips trailing punctuation (period, comma, parens, etc.)', () => {
    expect(extractUrls('ver https://example.com/foo.')).toEqual(['https://example.com/foo']);
    expect(extractUrls('cf https://example.com/foo, gracias')).toEqual(['https://example.com/foo']);
    expect(extractUrls('(https://example.com/foo)')).toEqual(['https://example.com/foo']);
    expect(extractUrls('mira https://example.com/foo!')).toEqual(['https://example.com/foo']);
  });

  it('returns [] when no URLs are present', () => {
    expect(extractUrls('hola mundo sin urls')).toEqual([]);
    expect(extractUrls('')).toEqual([]);
  });

  it('does not match ftp:// or other schemes', () => {
    expect(extractUrls('ftp://example.com/x')).toEqual([]);
  });

  it('handles ?query and #anchor without truncating', () => {
    expect(extractUrls('see https://example.com/path?a=1&b=2#section'))
      .toEqual(['https://example.com/path?a=1&b=2#section']);
  });
});

describe('deAmpUrl', () => {
  it('unwraps cdn.ampproject.org URLs to canonical', () => {
    expect(
      deAmpUrl('https://www-example-com.cdn.ampproject.org/c/s/www.example.com/path')
    ).toBe('https://www.example.com/path');
  });

  it('unwraps google.com/amp/s/ URLs', () => {
    expect(deAmpUrl('https://www.google.com/amp/s/www.example.com/path'))
      .toBe('https://www.example.com/path');
  });

  it('passes through non-AMP URLs unchanged', () => {
    expect(deAmpUrl('https://www.lasegunda.com/foo')).toBe('https://www.lasegunda.com/foo');
  });

  it('does NOT unwrap an AMP URL whose target is a private/reserved host (SSRF)', () => {
    // Without this guard, an attacker could smuggle a private IP through
    // the AMP wrapper.
    const malicious = 'https://www.google.com/amp/s/169.254.169.254/metadata';
    expect(deAmpUrl(malicious)).toBe(malicious); // unchanged → caller still rejects
  });

  it('does NOT unwrap a cdn.ampproject AMP URL targeting localhost', () => {
    const malicious = 'https://x.cdn.ampproject.org/c/s/localhost/secret';
    expect(deAmpUrl(malicious)).toBe(malicious);
  });
});

describe('domain set sanity', () => {
  it('SKIP_DOMAINS contains expected social/video sites', () => {
    expect(SKIP_DOMAINS.has('youtube.com')).toBe(true);
    expect(SKIP_DOMAINS.has('x.com')).toBe(true);
    expect(SKIP_DOMAINS.has('t.me')).toBe(true);
  });

  it('LINK_EXPANDER_BOTS is non-empty', () => {
    expect(LINK_EXPANDER_BOTS.size).toBeGreaterThan(0);
  });

  it('EXTRA_ALLOWED is a subset of allowlisted domains', () => {
    for (const domain of EXTRA_ALLOWED) {
      const r = isOnAllowlist(`https://${domain}/some-path`);
      expect(r.allowed).toBe(true);
    }
  });
});

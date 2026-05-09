import { describe, expect, it } from 'bun:test';
import { isFxTwitterUrl, FXTWITTER_NOISE_HOSTS } from '../src/bot/fxtwitter.js';

// extractUrlsFromFxTwitter requires network/python — skip integration here.

describe('isFxTwitterUrl', () => {
  it('matches fxtwitter, fixupx, vxtwitter, fixvx', () => {
    expect(isFxTwitterUrl('https://fxtwitter.com/user/status/123')).toBe(true);
    expect(isFxTwitterUrl('https://fixupx.com/user/status/456')).toBe(true);
    expect(isFxTwitterUrl('https://vxtwitter.com/user/status/789')).toBe(true);
    expect(isFxTwitterUrl('https://fixvx.com/user/status/000')).toBe(true);
  });

  it('matches subdomains (api.fxtwitter.com etc)', () => {
    expect(isFxTwitterUrl('https://api.fxtwitter.com/foo')).toBe(true);
    expect(isFxTwitterUrl('https://www.fxtwitter.com/x/status/1')).toBe(true);
  });

  it('rejects vanilla twitter / x.com', () => {
    expect(isFxTwitterUrl('https://twitter.com/user/status/123')).toBe(false);
    expect(isFxTwitterUrl('https://x.com/user/status/123')).toBe(false);
  });

  it('rejects unrelated domains', () => {
    expect(isFxTwitterUrl('https://example.com/foo')).toBe(false);
    expect(isFxTwitterUrl('https://lookalike-fxtwitter.com/x')).toBe(false);
    expect(isFxTwitterUrl('https://fxtwitter.evil.com/x')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isFxTwitterUrl('not-a-url')).toBe(false);
    expect(isFxTwitterUrl('')).toBe(false);
  });
});

describe('FXTWITTER_NOISE_HOSTS', () => {
  it('contains the canonical Twitter wrappers and CDN hosts', () => {
    expect(FXTWITTER_NOISE_HOSTS.has('fxtwitter.com')).toBe(true);
    expect(FXTWITTER_NOISE_HOSTS.has('twitter.com')).toBe(true);
    expect(FXTWITTER_NOISE_HOSTS.has('x.com')).toBe(true);
    expect(FXTWITTER_NOISE_HOSTS.has('t.co')).toBe(true);
    expect(FXTWITTER_NOISE_HOSTS.has('twimg.com')).toBe(true);
  });
});

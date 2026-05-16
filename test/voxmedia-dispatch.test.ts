import { describe, expect, it } from 'bun:test';
import { detectVoxStrategy, isVoxMediaHost } from '../src/extractors/voxmedia/dispatch.js';

describe('detectVoxStrategy — Chorus stack', () => {
  it.each([
    ['https://www.theverge.com/2025/9/1/article', 'The Verge', 'theverge'],
    ['https://www.vox.com/policy/foo', 'Vox', 'vox'],
    ['https://www.eater.com/maps/best-pizza-nyc', 'Eater', 'eater'],
    ['https://www.polygon.com/reviews/x', 'Polygon', 'polygon'],
    ['https://www.sbnation.com/nba', 'SB Nation', 'sbnation'],
    ['https://www.thedodo.com/dodo-stories/animal', 'The Dodo', 'thedodo'],
    ['https://www.thrillist.com/eat/x', 'Thrillist', 'thrillist'],
    ['https://www.popsugar.com/fashion/x', 'PopSugar', 'popsugar'],
  ])('%s → chorus / %s', (url, brand, source) => {
    const r = detectVoxStrategy(url);
    expect(r).toEqual({ strategy: 'chorus', brand, source });
  });

  it('handles non-www subdomain forms', () => {
    expect(detectVoxStrategy('https://theverge.com/article')).toEqual({
      strategy: 'chorus', brand: 'The Verge', source: 'theverge'
    });
  });
});

describe('detectVoxStrategy — Clay stack', () => {
  it('vulture.com → clay / Vulture', () => {
    expect(detectVoxStrategy('https://www.vulture.com/article/foo.html'))
      .toEqual({ strategy: 'clay', brand: 'Vulture', source: 'vulture' });
  });

  it('thecut.com → clay / The Cut', () => {
    expect(detectVoxStrategy('https://www.thecut.com/article/foo.html'))
      .toEqual({ strategy: 'clay', brand: 'The Cut', source: 'thecut' });
  });

  it('grubstreet.com → clay / Grub Street', () => {
    expect(detectVoxStrategy('https://www.grubstreet.com/article/foo.html'))
      .toEqual({ strategy: 'clay', brand: 'Grub Street', source: 'grubstreet' });
  });

  it('curbed.com → clay / Curbed', () => {
    expect(detectVoxStrategy('https://www.curbed.com/article/foo.html'))
      .toEqual({ strategy: 'clay', brand: 'Curbed', source: 'curbed' });
  });

  it('nymag.com without section path → clay / New York Magazine', () => {
    expect(detectVoxStrategy('https://nymag.com/article/foo.html'))
      .toEqual({ strategy: 'clay', brand: 'New York Magazine', source: 'nymag' });
  });

  it('nymag.com/intelligencer/* → clay / Intelligencer', () => {
    expect(detectVoxStrategy('https://nymag.com/intelligencer/article/foo.html'))
      .toEqual({ strategy: 'clay', brand: 'Intelligencer', source: 'intelligencer' });
  });

  it('nymag.com/strategist/* → clay / The Strategist', () => {
    expect(detectVoxStrategy('https://nymag.com/strategist/article/foo.html'))
      .toEqual({ strategy: 'clay', brand: 'The Strategist', source: 'thestrategist' });
  });

  it('does NOT match nymag.com/intelligencerish (false prefix)', () => {
    // The prefix matcher requires the section name to be followed by `/`
    // or end-of-path, so `/intelligencerish/...` is treated as a generic
    // nymag.com section, not Intelligencer.
    expect(detectVoxStrategy('https://nymag.com/intelligencerish/foo'))
      .toEqual({ strategy: 'clay', brand: 'New York Magazine', source: 'nymag' });
  });
});

describe('detectVoxStrategy — non-Vox URLs', () => {
  it.each([
    'https://www.bloomberg.com/news/articles/foo',
    'https://www.elmercurio.com/foo',
    'https://example.com/article',
  ])('%s → null', (url) => {
    expect(detectVoxStrategy(url)).toBeNull();
  });

  it('invalid URL → null', () => {
    expect(detectVoxStrategy('not a url')).toBeNull();
  });
});

describe('isVoxMediaHost', () => {
  it('matches Vox hosts', () => {
    expect(isVoxMediaHost('theverge.com')).toBe(true);
    expect(isVoxMediaHost('www.nymag.com')).toBe(true);
    expect(isVoxMediaHost('VULTURE.COM')).toBe(true); // case insensitive
  });

  it('rejects non-Vox', () => {
    expect(isVoxMediaHost('bloomberg.com')).toBe(false);
    expect(isVoxMediaHost('example.com')).toBe(false);
  });
});

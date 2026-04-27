import { describe, expect, it } from 'bun:test';
import { buildLunPageCoverUrl } from '../src/extractors/lun.js';

describe('buildLunPageCoverUrl', () => {
  it('builds URL with abbreviated month for April 2026', () => {
    expect(buildLunPageCoverUrl('2026-04-26', '13')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/abr/26/p_2026-04-26_pag13.webp'
    );
  });

  it('uses correct abbreviation for January', () => {
    expect(buildLunPageCoverUrl('2026-01-15', '7')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/ene/15/p_2026-01-15_pag7.webp'
    );
  });

  it('uses correct abbreviation for September', () => {
    expect(buildLunPageCoverUrl('2026-09-03', '1')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/sep/03/p_2026-09-03_pag1.webp'
    );
  });

  it('returns null for invalid date', () => {
    expect(buildLunPageCoverUrl('not-a-date', '1')).toBeNull();
    expect(buildLunPageCoverUrl('', '1')).toBeNull();
    expect(buildLunPageCoverUrl('2026-04-26', '')).toBeNull();
  });

  it('handles single-digit days (no padding required for output)', () => {
    expect(buildLunPageCoverUrl('2026-04-05', '1')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/abr/05/p_2026-04-05_pag1.webp'
    );
  });
});

describe('LUN video extraction', () => {
  it('matches video filename from div id="video"', () => {
    const html = '<div id="video">13_teleferico_pio_nono_lun.mp4</div>';
    const m = html.match(/<div id="video">([^<]+)<\/div>/);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe('13_teleferico_pio_nono_lun.mp4');
    const fullUrl = `https://images.lun.com/luncontents/Videos/${m![1].trim()}`;
    expect(fullUrl).toBe('https://images.lun.com/luncontents/Videos/13_teleferico_pio_nono_lun.mp4');
  });

  it('does not match when video div is absent', () => {
    const html = '<div id="autor">Foo Bar</div>';
    const m = html.match(/<div id="video">([^<]+)<\/div>/);
    expect(m).toBeNull();
  });
});

describe('LUN multi-article detection', () => {
  it('matches multiple NewsIDRepeater values in document order', () => {
    const html = `
      <script>var NewsID = '0'; var NewsIDRepeater = '561601';</script>
      <div id="titulo">Título 1</div>
      <script>var NewsID = '0'; var NewsIDRepeater = '561602';</script>
      <div id="titulo">Título 2</div>
    `;
    const newsIds = Array.from(html.matchAll(/var NewsIDRepeater\s*=\s*'(\d+)'/g), m => m[1]);
    expect(newsIds).toEqual(['561601', '561602']);
    const titles = Array.from(html.matchAll(/<div id="titulo">([^<]+)<\/div>/g), m => m[1]);
    expect(titles).toEqual(['Título 1', 'Título 2']);
  });

  it('dedupes repeated NewsIDRepeater values (single-article page)', () => {
    const html = `var NewsIDRepeater = '561601'; var NewsIDRepeater = '561601';`;
    const matches = Array.from(html.matchAll(/var NewsIDRepeater\s*=\s*'(\d+)'/g), m => m[1]);
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const id of matches) {
      if (!seen.has(id)) { seen.add(id); unique.push(id); }
    }
    expect(unique).toEqual(['561601']);
  });
});

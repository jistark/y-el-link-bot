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

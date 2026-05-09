import { describe, expect, it } from 'bun:test';
import { parseLunUrl } from '../src/extractors/lun.js';

describe('parseLunUrl', () => {
  it('parses a mobile NewsDetail URL with all params', () => {
    const url = 'https://www.lun.com/lunmobileiphone/homeslide.aspx?dt=2026-04-26&NewsID=561601&PaginaId=13';
    const out = parseLunUrl(url);
    expect(out.fecha).toBe('2026-04-26');
    expect(out.newsId).toBe('561601');
    expect(out.paginaId).toBe('13');
  });

  it('parses a desktop NewsDetail URL (no NewsID, just date+page)', () => {
    const url = 'https://www.lun.com/Pages/NewsDetail.aspx?dt=2026-04-26&PaginaId=13';
    const out = parseLunUrl(url);
    expect(out.fecha).toBe('2026-04-26');
    expect(out.paginaId).toBe('13');
    // newsId may be absent or empty depending on impl — just that we don't crash
  });

  it('handles URLs with extra trailing params', () => {
    const url = 'https://www.lun.com/lunmobileiphone/homeslide.aspx?dt=2026-04-26&NewsID=99&PaginaId=1&utm=foo';
    const out = parseLunUrl(url);
    expect(out.fecha).toBe('2026-04-26');
    expect(out.newsId).toBe('99');
  });
});

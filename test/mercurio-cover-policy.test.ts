import { describe, expect, it } from 'bun:test';
import {
  applyMercurioCoverPolicy, buildMercurioPageCoverUrl,
} from '../src/extractors/elmercurio.js';

describe('buildMercurioPageCoverUrl', () => {
  it('builds the canonical printed-page image URL when pageId is given', () => {
    expect(buildMercurioPageCoverUrl('2026/05/09', 'A1'))
      .toBe('https://digital.elmercurio.com/2026/05/09/content/pages/img/mid/A1.jpg');
  });

  it('returns null when pageId is missing (single-article URL context)', () => {
    expect(buildMercurioPageCoverUrl('2026/05/09', undefined)).toBeNull();
    expect(buildMercurioPageCoverUrl('2026/05/09', '')).toBeNull();
  });
});

describe('applyMercurioCoverPolicy', () => {
  const PAGE_COVER = 'https://digital.elmercurio.com/2026/05/09/content/pages/img/mid/A1.jpg';
  const BASE_BODY = '<p>cuerpo del artículo</p>';

  it('first per-article image becomes cover, rest stay in images', () => {
    const images = [
      { url: 'https://x.com/lead.jpg', caption: 'Lead' },
      { url: 'https://x.com/second.jpg' },
      { url: 'https://x.com/third.jpg' },
    ];
    const out = applyMercurioCoverPolicy(BASE_BODY, images, PAGE_COVER);

    expect(out.coverImage).toEqual({ url: 'https://x.com/lead.jpg', caption: 'Lead' });
    expect(out.images).toHaveLength(2);
    expect(out.images?.[0].url).toBe('https://x.com/second.jpg');
  });

  it('appends printed-page footer to body when there are per-article images', () => {
    const images = [{ url: 'https://x.com/lead.jpg' }];
    const out = applyMercurioCoverPolicy(BASE_BODY, images, PAGE_COVER);

    expect(out.body).toContain(BASE_BODY);
    expect(out.body).toContain('<figure><img src="' + PAGE_COVER + '">');
    expect(out.body).toContain('<figcaption>Edición impresa</figcaption>');
  });

  it('printed-page image becomes the cover when there are no per-article images', () => {
    const out = applyMercurioCoverPolicy(BASE_BODY, undefined, PAGE_COVER);
    expect(out.coverImage).toEqual({ url: PAGE_COVER });
    expect(out.images).toBeUndefined();
    // No footer in this case — the printed page is the cover, not a footer.
    expect(out.body).toBe(BASE_BODY);
  });

  it('handles empty images array same as undefined', () => {
    const out = applyMercurioCoverPolicy(BASE_BODY, [], PAGE_COVER);
    expect(out.coverImage).toEqual({ url: PAGE_COVER });
    expect(out.body).toBe(BASE_BODY);
  });

  it('without pageCoverUrl: per-article images still split, but no footer', () => {
    const images = [
      { url: 'https://x.com/a.jpg' },
      { url: 'https://x.com/b.jpg' },
    ];
    const out = applyMercurioCoverPolicy(BASE_BODY, images, null);
    expect(out.coverImage?.url).toBe('https://x.com/a.jpg');
    expect(out.images?.[0].url).toBe('https://x.com/b.jpg');
    expect(out.body).toBe(BASE_BODY); // no footer appended
  });

  it('without pageCoverUrl AND no images: cover undefined, body unchanged', () => {
    const out = applyMercurioCoverPolicy(BASE_BODY, undefined, null);
    expect(out.coverImage).toBeUndefined();
    expect(out.images).toBeUndefined();
    expect(out.body).toBe(BASE_BODY);
  });

  it('does not mutate the input images array', () => {
    const images = [
      { url: 'https://x.com/a.jpg' },
      { url: 'https://x.com/b.jpg' },
    ];
    applyMercurioCoverPolicy(BASE_BODY, images, PAGE_COVER);
    expect(images).toHaveLength(2);
  });
});

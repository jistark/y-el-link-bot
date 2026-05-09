import { describe, expect, it } from 'bun:test';
import { combineLunPageArticles } from '../src/extractors/lun.js';
import type { Article } from '../src/types.js';

function art(overrides: Partial<Article>): Article {
  return {
    title: 'T',
    body: '<p>body</p>',
    url: 'https://lun.com/...',
    source: 'lun',
    ...overrides,
  };
}

const PAGE_COVER = 'https://images.lun.com/luncontents/NewsPaperPages/2026/abr/26/p_2026-04-26_pag13.webp';

describe('combineLunPageArticles', () => {
  it('throws on empty input', () => {
    expect(() => combineLunPageArticles([], PAGE_COVER, 'https://lun.com/x')).toThrow();
  });

  it('returns a single article through unchanged (no <hr>, no extra titles)', () => {
    const a = art({
      title: 'Solo',
      body: '<p>texto único</p>',
      images: [{ url: 'https://images.lun.com/foo.jpg' }],
    });
    const out = combineLunPageArticles([a], PAGE_COVER, 'https://lun.com/x');
    expect(out.title).toBe('Solo');
    // Cover footer must appear exactly once because there are body images
    const footers = (out.body.match(/Edición impresa/g) || []).length;
    expect(footers).toBe(1);
    // No <hr> separator since there's only one article
    expect(out.body).not.toContain('<hr>');
  });

  it('combines N articles with <hr> + escaped <h3> per follow-up article', () => {
    const articles = [
      art({ title: 'Primero', body: '<p>uno</p>' }),
      art({ title: 'Segundo & Co', body: '<p>dos</p>' }),
      art({ title: 'Tercero', body: '<p>tres</p>' }),
    ];
    const out = combineLunPageArticles(articles, null, 'https://lun.com/x');
    expect(out.title).toBe('Primero');
    expect(out.body).toContain('<p>uno</p>');
    expect(out.body).toContain('<hr>');
    // Title of follow-ups must be HTML-escaped
    expect(out.body).toContain('<h3>Segundo &amp; Co</h3>');
    expect(out.body).toContain('<h3>Tercero</h3>');
    // Number of <hr> separators = articles - 1
    expect((out.body.match(/<hr>/g) || []).length).toBe(2);
  });

  it('appends printed-page footer EXACTLY ONCE for multi-article (regression #2)', () => {
    // Regression: extractLunCore was appending the footer per-article;
    // combineLunPageArticles should append it at the end exactly once.
    const articles = [
      art({ title: 'A', body: '<p>a</p>', images: [{ url: 'a.jpg' }] }),
      art({ title: 'B', body: '<p>b</p>', images: [{ url: 'b.jpg' }] }),
      art({ title: 'C', body: '<p>c</p>', images: [{ url: 'c.jpg' }] }),
    ];
    const out = combineLunPageArticles(articles, PAGE_COVER, 'https://lun.com/x');
    const footers = (out.body.match(/Edición impresa/g) || []).length;
    expect(footers).toBe(1);
  });

  it('does NOT append printed-page footer when no article has body images', () => {
    const articles = [
      art({ title: 'A', body: '<p>a</p>' }),
      art({ title: 'B', body: '<p>b</p>' }),
    ];
    const out = combineLunPageArticles(articles, PAGE_COVER, 'https://lun.com/x');
    expect(out.body).not.toContain('Edición impresa');
  });

  it('does NOT append printed-page footer when pageCoverUrl is null', () => {
    const articles = [
      art({ title: 'A', body: '<p>a</p>', images: [{ url: 'a.jpg' }] }),
    ];
    const out = combineLunPageArticles(articles, null, 'https://lun.com/x');
    expect(out.body).not.toContain('Edición impresa');
  });

  it('avoids double-cover when first article has no images but later ones do', () => {
    // Regression for the "double cover" edge case: extractLunCore sets
    // coverImage = pageCoverUrl on articles with no body images. If the
    // first article in the group is one of those AND a later article
    // has body images, the combined article would otherwise carry both
    // coverImage (above the fold) AND the printed-page footer (in body).
    const articles = [
      art({ title: 'A no images', body: '<p>a</p>', coverImage: { url: PAGE_COVER } }),
      art({ title: 'B with images', body: '<p>b</p>', images: [{ url: 'b.jpg' }] }),
    ];
    const out = combineLunPageArticles(articles, PAGE_COVER, 'https://lun.com/x');

    // Footer appears in body (because at least one article has images)
    const footers = (out.body.match(/Edición impresa/g) || []).length;
    expect(footers).toBe(1);
    // BUT coverImage is suppressed — no double cover.
    expect(out.coverImage).toBeUndefined();
  });

  it('preserves first.coverImage when NO article has body images', () => {
    const articles = [
      art({ title: 'A', body: '<p>a</p>', coverImage: { url: PAGE_COVER } }),
      art({ title: 'B', body: '<p>b</p>' }),
    ];
    const out = combineLunPageArticles(articles, PAGE_COVER, 'https://lun.com/x');
    expect(out.coverImage?.url).toBe(PAGE_COVER);
    // No footer in body — cover handles it.
    expect(out.body).not.toContain('Edición impresa');
  });

  it('inlines per-article coverImage as <figure> at the start of each non-first article body', () => {
    // The LUN mobile experience shows a per-article photo next to each
    // note. In a combined Telegraph page, only article 0's cover image
    // can occupy the page-level cover slot. Articles 1..N's per-article
    // covers must therefore appear inline in their body section.
    const articles = [
      art({
        title: 'A',
        body: '<p>texto A</p>',
        coverImage: { url: 'https://images.lun.com/a.jpg' },
      }),
      art({
        title: 'B',
        body: '<p>texto B</p>',
        coverImage: { url: 'https://images.lun.com/b.jpg' },
      }),
      art({
        title: 'C',
        body: '<p>texto C</p>',
        coverImage: { url: 'https://images.lun.com/c.jpg' },
      }),
    ];
    const out = combineLunPageArticles(articles, PAGE_COVER, 'https://lun.com/x');

    // Article 0 owns the page-level cover.
    expect(out.coverImage?.url).toBe('https://images.lun.com/a.jpg');

    // Articles 1 and 2 have their per-article covers inlined in the body
    // as <figure> tags right after their <h3> titles.
    expect(out.body).toContain('<figure><img src="https://images.lun.com/b.jpg"></figure>');
    expect(out.body).toContain('<figure><img src="https://images.lun.com/c.jpg"></figure>');
    // Article 0's cover does NOT appear in the body — it's the page-level cover.
    expect(out.body).not.toContain('<figure><img src="https://images.lun.com/a.jpg">');
  });

  it('does NOT inline coverImage that equals pageCoverUrl (printed-page fallback)', () => {
    // Article 2 has no per-article images, so extractLunCore set its
    // coverImage = pageCoverUrl. In the combined output we must NOT
    // inline the printed page in the middle of the body — only the
    // single end-of-body footer is allowed.
    const articles = [
      art({
        title: 'A',
        body: '<p>a</p>',
        coverImage: { url: 'https://images.lun.com/a.jpg' },
        images: [{ url: 'https://images.lun.com/a2.jpg' }],
      }),
      art({
        title: 'B no images, fallback page-cover',
        body: '<p>b</p>',
        coverImage: { url: PAGE_COVER },
      }),
    ];
    const out = combineLunPageArticles(articles, PAGE_COVER, 'https://lun.com/x');

    // Footer appears exactly once.
    const footers = (out.body.match(/Edición impresa/g) || []).length;
    expect(footers).toBe(1);
    // The page cover URL appears only in the footer, not inlined in
    // the middle of the body. Count occurrences in body.
    const pageCoverInBody = (out.body.match(new RegExp(PAGE_COVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    expect(pageCoverInBody).toBe(1);
  });

  it('concatenates images across all articles', () => {
    const articles = [
      art({ title: 'A', body: '<p>a</p>', images: [{ url: 'a1.jpg' }, { url: 'a2.jpg' }] }),
      art({ title: 'B', body: '<p>b</p>', images: [{ url: 'b1.jpg' }] }),
    ];
    const out = combineLunPageArticles(articles, null, 'https://lun.com/x');
    expect(out.images).toHaveLength(3);
    expect(out.images?.map(i => i.url)).toEqual(['a1.jpg', 'a2.jpg', 'b1.jpg']);
  });

  it('inherits coverImage and metadata from the first article', () => {
    const articles = [
      art({ title: 'A', author: 'autor-a', subtitle: 'sub-a', date: '2026-04-26',
            coverImage: { url: 'cover-a.jpg' } }),
      art({ title: 'B', author: 'autor-b', subtitle: 'sub-b', coverImage: { url: 'cover-b.jpg' } }),
    ];
    const out = combineLunPageArticles(articles, null, 'https://lun.com/x');
    expect(out.title).toBe('A');
    expect(out.author).toBe('autor-a');
    expect(out.subtitle).toBe('sub-a');
    expect(out.date).toBe('2026-04-26');
    expect(out.coverImage?.url).toBe('cover-a.jpg');
  });

  it('does not mutate input image arrays (defensive copy)', () => {
    const firstImages = [{ url: 'a.jpg' }];
    const articles = [
      art({ title: 'A', body: '<p>a</p>', images: firstImages }),
      art({ title: 'B', body: '<p>b</p>', images: [{ url: 'b.jpg' }] }),
    ];
    combineLunPageArticles(articles, null, 'https://lun.com/x');
    // First article's images array must remain length 1 (not concatenated in place)
    expect(firstImages).toHaveLength(1);
  });
});

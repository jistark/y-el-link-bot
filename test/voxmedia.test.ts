import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseArticle } from '../src/extractors/voxmedia.js';
import {
  articleBodyToHtml,
  authorsFromJsonLd,
  dedupeImages,
  imageBaseKey,
  isInlineSchemaJson,
  isUIChrome,
} from '../src/extractors/voxmedia/shared.js';

function loadFixture(name: string): string {
  return readFileSync(resolve(import.meta.dir, 'fixtures', name), 'utf8');
}

// ---------- Chorus: vox.com ----------

const CHORUS_VOX = loadFixture('voxmedia_chorus_vox.html');

describe('voxmedia.parseArticle — Chorus (vox.com)', () => {
  const article = parseArticle('https://www.vox.com/future-perfect/article', CHORUS_VOX);

  it('extracts via JSON-LD articleBody', () => {
    expect(article).not.toBeNull();
    expect(article!.title).toContain('Elon Musk');
  });

  it('handles single-newline paragraph separator (Vox style)', () => {
    // Vox's JSON-LD articleBody uses `\n` (single newline) between
    // paragraphs, unlike The Verge which historically used `\n\n`. The
    // articleBodyToHtml waterfall handles both — regression: previous
    // theverge.ts would have emitted a single giant paragraph here.
    const pCount = (article!.body!.match(/<p>/g) || []).length;
    expect(pCount).toBeGreaterThan(15);
  });

  it('preserves subtitle and author', () => {
    expect(article!.subtitle).toBeTruthy();
    expect(article!.author).toBe('Sara Herschander');
  });

  it('emits an ISO date', () => {
    expect(article!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------- Clay: vulture.com ----------

const CLAY_VULTURE = loadFixture('voxmedia_clay_vulture.html');

describe('voxmedia.parseArticle — Clay (vulture.com)', () => {
  const article = parseArticle(
    'https://www.vulture.com/article/the-comeback-explained-finale.html',
    CLAY_VULTURE,
  );

  it('extracts an article', () => {
    expect(article).not.toBeNull();
    expect(article!.title).toContain('Terminator');
  });

  it('uses meta tags for metadata (Clay JSON-LD lacks articleBody)', () => {
    expect(article!.author).toBe('Jackson McHenry');
    expect(article!.subtitle).toBeTruthy();
    expect(article!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('body has many prose paragraphs (clay-paragraph class)', () => {
    const pCount = (article!.body!.match(/<p>/g) || []).length;
    expect(pCount).toBeGreaterThan(20);
  });

  it('emits inline <figure> for article-image / img-data', () => {
    expect(article!.body).toContain('<figure>');
    expect(article!.body).toContain('<img src=');
  });

  it('extracts lede image with credit caption', () => {
    expect(article!.images?.[0].caption).toContain('Photo:');
  });

  it('drops UI chrome (no "Save this article", "Sign up here", etc.)', () => {
    const body = article!.body!;
    expect(body).not.toMatch(/save this article/i);
    expect(body).not.toMatch(/^[\s<>p\/]*save\s*</im);
  });

  it('drops inline schema-JSON pollution', () => {
    expect(article!.body).not.toContain('"@id"');
    expect(article!.body).not.toContain('"@context"');
  });
});

// ---------- Clay: thecut.com ----------

const CLAY_THECUT = loadFixture('voxmedia_clay_thecut.html');

describe('voxmedia.parseArticle — Clay (thecut.com)', () => {
  const article = parseArticle(
    'https://www.thecut.com/article/robyn-sexistential-album-interview.html',
    CLAY_THECUT,
  );

  it('extracts an article', () => {
    expect(article!.title).toContain('Robyn');
    expect(article!.author).toBe('Cat Zhang');
  });

  it('extracts inline images (article-image and img-data) without losing them', () => {
    // The Robyn feature has multiple inline photographs — exercise both
    // image classes Clay templates emit.
    const figCount = (article!.body!.match(/<figure>/g) || []).length;
    expect(figCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------- Clay: nymag.com/intelligencer (sub-path routing) ----------

const CLAY_INTEL = loadFixture('voxmedia_clay_intelligencer.html');

describe('voxmedia.parseArticle — Clay (nymag.com/intelligencer)', () => {
  const url = 'https://nymag.com/intelligencer/article/new-york-congressional-race.html';
  const article = parseArticle(url, CLAY_INTEL);

  it('routes by path: nymag.com/intelligencer → Intelligencer brand', () => {
    expect(article).not.toBeNull();
    expect(article!.title).toContain('Manhattan');
  });

  it('handles long-form features (60+ paragraphs)', () => {
    const pCount = (article!.body!.match(/<p>/g) || []).length;
    expect(pCount).toBeGreaterThan(50);
  });
});

// ---------- Photo-gallery (out of scope, must fail soft) ----------

describe('voxmedia.parseArticle — photo galleries return null', () => {
  it('photo-gallery articles (image-gallery class) fall through to null', () => {
    // Synthetic photo-gallery: has clay container but only 2 clay-paragraphs
    // (under quality gate). Real example: thecut.com/article/frieze-…
    const html = `
      <html><head>
        <meta property="og:title" content="Photo essay"/>
        <meta property="og:description" content="Pictures."/>
      </head><body>
        <h1>Photo essay</h1>
        <div class="article-content">
          <p class="clay-paragraph">Intro line.</p>
          <p class="clay-paragraph">Outro line.</p>
        </div>
      </body></html>`;
    expect(parseArticle('https://www.thecut.com/article/photoessay.html', html)).toBeNull();
  });

  it('non-Vox URLs return null instead of throwing', () => {
    expect(parseArticle('https://www.bloomberg.com/news/foo', '<html></html>')).toBeNull();
  });
});

// ---------- shared helpers ----------

describe('voxmedia/shared — articleBodyToHtml', () => {
  it('preserves existing <p> markup', () => {
    expect(articleBodyToHtml('<p>one</p>\n<p>two</p>')).toBe('<p>one</p>\n<p>two</p>');
  });

  it('splits on double newlines (The Verge style)', () => {
    expect(articleBodyToHtml('A.\n\nB.')).toBe('<p>A.</p>\n<p>B.</p>');
  });

  it('falls back to single newlines (Vox style)', () => {
    expect(articleBodyToHtml('A.\nB.\nC.')).toBe('<p>A.</p>\n<p>B.</p>\n<p>C.</p>');
  });

  it('groups sentences when no newlines at all', () => {
    const long = 'First sentence here. '.repeat(20).trim();
    const result = articleBodyToHtml(long);
    const paragraphs = (result.match(/<p>/g) || []).length;
    expect(paragraphs).toBeGreaterThan(1);
  });
});

describe('voxmedia/shared — isUIChrome', () => {
  it('matches save/comment/etc.', () => {
    expect(isUIChrome('save')).toBe(true);
    expect(isUIChrome('Save')).toBe(true);
    expect(isUIChrome('Comment')).toBe(true);
    expect(isUIChrome('Save this article to read it later.')).toBe(true);
    expect(isUIChrome("This article was featured in New York’s One Great Story newsletter.")).toBe(true);
    expect(isUIChrome('Sign up here')).toBe(true);
  });

  it('does not match real short prose', () => {
    expect(isUIChrome('Yes.')).toBe(false);
    expect(isUIChrome('Reader, I married him.')).toBe(false);
    expect(isUIChrome('She paused.')).toBe(false);
  });
});

describe('voxmedia/shared — isInlineSchemaJson', () => {
  it('matches multi-line schema dumps', () => {
    expect(isInlineSchemaJson('{\n  "@id": "#articleSchema",\n  …')).toBe(true);
    expect(isInlineSchemaJson('{ "@context": "http://schema.org" }')).toBe(true);
  });

  it('does not match prose that happens to start with {', () => {
    expect(isInlineSchemaJson('{She was born in 1989.}')).toBe(false);
    expect(isInlineSchemaJson('Hello.')).toBe(false);
  });
});

describe('voxmedia/shared — image dedupe', () => {
  it('imageBaseKey collapses responsive variants', () => {
    const a = imageBaseKey('https://pyxis.nymag.com/v1/imgs/foo-NYM-clipping.1x.rsocial.w1200.jpg');
    const b = imageBaseKey('https://pyxis.nymag.com/v1/imgs/foo-NYM-clipping.rvertical.w570.jpg');
    expect(a).toBe(b);
  });

  it('dedupeImages keeps first occurrence', () => {
    const result = dedupeImages([
      { url: 'https://x.com/img/foo.1x.w1200.jpg' },
      { url: 'https://x.com/img/foo.rvertical.w570.jpg' },
      { url: 'https://x.com/img/bar.w800.jpg' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].url).toContain('w1200');
  });
});

describe('voxmedia/shared — authorsFromJsonLd', () => {
  it('joins arrays of author objects', () => {
    expect(authorsFromJsonLd([{ name: 'Alice' }, { name: 'Bob' }])).toBe('Alice, Bob');
  });

  it('handles single author object', () => {
    expect(authorsFromJsonLd({ name: 'Solo' })).toBe('Solo');
  });

  it('handles strings', () => {
    expect(authorsFromJsonLd('Plain string')).toBe('Plain string');
    expect(authorsFromJsonLd(['Alice', 'Bob'])).toBe('Alice, Bob');
  });

  it('returns undefined for empty / missing', () => {
    expect(authorsFromJsonLd(undefined)).toBeUndefined();
    expect(authorsFromJsonLd([])).toBeUndefined();
    expect(authorsFromJsonLd([{ name: '' }])).toBeUndefined();
  });
});

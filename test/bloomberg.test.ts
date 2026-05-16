import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseArticle } from '../src/extractors/bloomberg.js';

function loadFixture(name: string): string {
  return readFileSync(resolve(import.meta.dir, 'fixtures', name), 'utf8');
}

// Real-world fixtures trimmed to ~30-40% of original size (head + meta +
// JSON-LD + __NEXT_DATA__ + <main> body) while preserving structural
// elements that the extractor depends on.
const FEATURES_LAYOUT = loadFixture('bloomberg_features_jassy.html');
const MODERN_LAYOUT = loadFixture('bloomberg_news_article_india.html');

describe('bloomberg parseArticle — /features/ layout (Jassy)', () => {
  const article = parseArticle(FEATURES_LAYOUT);

  it('extracts an article (does not fall back to null/garbage)', () => {
    expect(article).not.toBeNull();
    expect(article!.title).toBeTruthy();
    expect(article!.body).toBeTruthy();
  });

  it('uses <h1> for title rather than JSON-LD SEO headline', () => {
    // <h1>: "Andy Jassy Is Rewriting Amazon's Playbook for the AI Age"
    // JSON-LD headline: "How Andy Jassy Is Steering Amazon Through the AI Boom Without Bezos"
    expect(article!.title).toContain('Rewriting');
    expect(article!.title).not.toContain('Steering');
  });

  it('extracts clean subtitle (regression: previous bot used og:description that could be JS-corrupted)', () => {
    expect(article!.subtitle).toContain('Jassy was once Jeff Bezos');
    expect(article!.subtitle).not.toContain('function(');
    expect(article!.subtitle).not.toContain('var ');
  });

  it('joins multiple authors from JSON-LD', () => {
    expect(article!.author).toBe('Brad Stone, Matt Day');
  });

  it('extracts ISO date from JSON-LD', () => {
    expect(article!.date).toMatch(/^2026-05-14T/);
  });

  it('body has prose only — no CSS, JS, schema-JSON leakage', () => {
    const body = article!.body!;
    expect(body).not.toContain('--ds-');
    expect(body).not.toContain(':root');
    expect(body).not.toContain('@context');
    expect(body).not.toContain('@type');
    expect(body).not.toContain('function(');
    expect(body).not.toContain('NREUM');
  });

  it('body has many paragraphs (Jassy feature is long-form)', () => {
    const pCount = (article!.body!.match(/<p>/g) || []).length;
    expect(pCount).toBeGreaterThan(30);
  });

  it('body starts with the lede ("Thirteen miles north of Jackson…")', () => {
    expect(article!.body).toMatch(/Thirteen miles north of Jackson, Mississippi/);
  });

  it('strips Bloomberg terminal links (empty href data-bbg=…) to plain text', () => {
    // The page links "Amazon.com Inc." to a bbg:// terminal URL. We strip the
    // wrapper anchor since Telegraph readers can't follow it.
    expect(article!.body).toContain('Amazon.com Inc.');
    expect(article!.body).not.toContain('data-bbg');
  });

  it('extracts cover image from JSON-LD plus inline figures', () => {
    expect(article!.images?.length).toBeGreaterThan(1);
    const firstUrl = article!.images?.[0].url;
    expect(firstUrl).toContain('assets.bwbx.io');
  });
});

describe('bloomberg parseArticle — modern /news/ layout (India)', () => {
  const article = parseArticle(MODERN_LAYOUT);

  it('extracts an article from __NEXT_DATA__', () => {
    expect(article).not.toBeNull();
    expect(article!.title).toBe('The Sober High Taking Over India’s Nightlife');
  });

  it('decodes &nbsp; in subtitle (regression: stripTags() was leaving entities)', () => {
    expect(article!.subtitle).toContain('faith-fueled buzz');
    expect(article!.subtitle).not.toContain('&nbsp;');
  });

  it('extracts subtitle from summary when abstract is an empty array', () => {
    // story.abstract === [] is truthy; previous code returned `[]` and the
    // Telegraph blockquote ended up rendering literal "[]".
    expect(article!.subtitle).not.toBe('[]');
    expect(article!.subtitle).not.toMatch(/^\[/);
    expect(typeof article!.subtitle).toBe('string');
  });

  it('joins multiple authors with comma', () => {
    expect(article!.author).toBe('Eshani Mathur, Akriti Sharma');
  });

  it('skips ad/inline-newsletter/inline-recirc blocks', () => {
    expect(article!.body).not.toContain('inline-newsletter');
    expect(article!.body).not.toContain('adType');
    expect(article!.body).not.toMatch(/<ad\b/);
  });

  it('emits <figure> for media blocks (inline images)', () => {
    expect(article!.body).toContain('<figure>');
    expect(article!.body).toContain('<img src=');
  });

  it('emits paragraphs with prose content', () => {
    const pCount = (article!.body!.match(/<p>/g) || []).length;
    expect(pCount).toBeGreaterThan(10);
    expect(article!.body).toMatch(/Floodlights sweep across the 16th century fort/);
  });

  it('includes ledeImageUrl as cover image', () => {
    expect(article!.images?.length).toBeGreaterThanOrEqual(1);
    expect(article!.images?.[0].url).toContain('assets.bwbx.io');
  });
});

describe('bloomberg parseArticle — degenerate inputs', () => {
  it('returns null when no __NEXT_DATA__ and no parseable feature DOM', () => {
    expect(parseArticle('<html><body><p>nothing useful</p></body></html>')).toBeNull();
  });

  it('returns null when __NEXT_DATA__ JSON is malformed', () => {
    expect(
      parseArticle('<html><script id="__NEXT_DATA__">not json</script></html>')
    ).toBeNull();
  });

  it('returns null when feature DOM has fewer than 3 paragraphs (quality gate)', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">{"headline":"t","description":"d"}</script>
      </head><body>
        <h1>Title</h1>
        <main>
          <p class="ds--paragraph">One short paragraph only.</p>
        </main>
      </body></html>`;
    expect(parseArticle(html)).toBeNull();
  });
});

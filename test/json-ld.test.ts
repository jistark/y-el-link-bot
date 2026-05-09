import { describe, expect, it } from 'bun:test';
import { findArticleNode, isJsonLdArticle, extractAuthor, extractImage } from '../src/extractors/helpers/json-ld.js';

describe('isJsonLdArticle', () => {
  it('matches NewsArticle as string', () => {
    expect(isJsonLdArticle({ '@type': 'NewsArticle' })).toBe(true);
  });

  it('matches Article and BlogPosting', () => {
    expect(isJsonLdArticle({ '@type': 'Article' })).toBe(true);
    expect(isJsonLdArticle({ '@type': 'BlogPosting' })).toBe(true);
    expect(isJsonLdArticle({ '@type': 'ReportageNewsArticle' })).toBe(true);
  });

  it('matches @type as array (real-world schema.org pattern)', () => {
    expect(isJsonLdArticle({ '@type': ['NewsArticle', 'Article'] })).toBe(true);
    expect(isJsonLdArticle({ '@type': ['Article', 'WebPage'] })).toBe(true);
  });

  it('rejects non-article types', () => {
    expect(isJsonLdArticle({ '@type': 'WebPage' })).toBe(false);
    expect(isJsonLdArticle({ '@type': 'Organization' })).toBe(false);
    expect(isJsonLdArticle({ '@type': ['WebPage', 'Thing'] })).toBe(false);
  });

  it('rejects nullish or non-object inputs', () => {
    expect(isJsonLdArticle(null)).toBe(false);
    expect(isJsonLdArticle(undefined)).toBe(false);
    expect(isJsonLdArticle('NewsArticle')).toBe(false);
    expect(isJsonLdArticle(42)).toBe(false);
  });

  it('rejects an object with no @type', () => {
    expect(isJsonLdArticle({ headline: 'x' })).toBe(false);
  });
});

describe('findArticleNode', () => {
  it('returns the input when it is itself an article', () => {
    const node = { '@type': 'NewsArticle', headline: 'foo' };
    expect(findArticleNode(node)).toBe(node);
  });

  it('finds the first article in a top-level array', () => {
    const arr = [
      { '@type': 'WebPage' },
      { '@type': 'Article', headline: 'x' },
      { '@type': 'NewsArticle', headline: 'y' },
    ];
    expect(findArticleNode(arr)).toBe(arr[1]);
  });

  it('finds an article inside @graph', () => {
    const root = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'BreadcrumbList' },
        { '@type': 'NewsArticle', headline: 'inside graph' },
        { '@type': 'Person' },
      ],
    };
    const found = findArticleNode(root);
    expect(found?.headline).toBe('inside graph');
  });

  it('finds an article in @graph when @type is an array', () => {
    const root = {
      '@graph': [
        { '@type': ['Person', 'Author'] },
        { '@type': ['NewsArticle', 'Article'], headline: 'array type' },
      ],
    };
    const found = findArticleNode(root);
    expect(found?.headline).toBe('array type');
  });

  it('returns null when no article-shaped node exists', () => {
    expect(findArticleNode({ '@graph': [{ '@type': 'WebPage' }] })).toBeNull();
    expect(findArticleNode({ '@type': 'WebPage' })).toBeNull();
  });

  it('returns null for null/undefined/primitives', () => {
    expect(findArticleNode(null)).toBeNull();
    expect(findArticleNode(undefined)).toBeNull();
    expect(findArticleNode(42)).toBeNull();
    expect(findArticleNode('string')).toBeNull();
  });
});

describe('extractAuthor', () => {
  it('handles string author', () => {
    expect(extractAuthor('Jane Doe')).toBe('Jane Doe');
  });

  it('handles object author', () => {
    expect(extractAuthor({ name: 'Jane' })).toBe('Jane');
  });

  it('joins multiple authors with comma', () => {
    expect(extractAuthor([{ name: 'A' }, { name: 'B' }])).toBe('A, B');
  });

  it('returns undefined for empty inputs', () => {
    expect(extractAuthor(undefined)).toBeUndefined();
    expect(extractAuthor([])).toBeUndefined();
  });
});

describe('extractImage', () => {
  it('handles string URL', () => {
    expect(extractImage('https://example.com/x.jpg')).toBe('https://example.com/x.jpg');
  });

  it('handles object with url', () => {
    expect(extractImage({ url: 'https://example.com/x.jpg' })).toBe('https://example.com/x.jpg');
  });

  it('takes first element from array', () => {
    expect(extractImage([{ url: 'first.jpg' }, { url: 'second.jpg' }])).toBe('first.jpg');
    expect(extractImage(['plain.jpg', 'second.jpg'])).toBe('plain.jpg');
  });

  it('returns undefined for nullish', () => {
    expect(extractImage(undefined)).toBeUndefined();
  });
});

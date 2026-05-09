import { describe, expect, it } from 'bun:test';
import { articleToNodes, truncateNodesToBudget } from '../src/formatters/telegraph.js';
import type { Article, TelegraphNode } from '../src/types.js';

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    title: 'T',
    body: '<p>body</p>',
    url: 'https://example.com/x',
    source: 'theverge' as Article['source'],
    ...overrides,
  };
}

// Recursively walk a TelegraphNode tree and yield every text leaf.
function* textLeaves(node: TelegraphNode | string): Generator<string> {
  if (typeof node === 'string') { yield node; return; }
  for (const c of node.children ?? []) yield* textLeaves(c as any);
}

function flatText(nodes: TelegraphNode[]): string {
  let out = '';
  for (const n of nodes) for (const t of textLeaves(n)) out += t;
  return out;
}

function findFirstByTag(nodes: TelegraphNode[], tag: string): TelegraphNode | undefined {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.tag === tag) return n;
    const inner = findFirstByTag((n.children ?? []) as TelegraphNode[], tag);
    if (inner) return inner;
  }
}

describe('articleToNodes — basics', () => {
  it('emits a cover figure when coverImage is set', () => {
    const out = articleToNodes(makeArticle({
      coverImage: { url: 'https://example.com/cover.jpg', caption: 'Pie' },
    }));
    const fig = findFirstByTag(out, 'figure');
    expect(fig).toBeDefined();
    const img = findFirstByTag([fig as TelegraphNode], 'img');
    expect((img as any)?.attrs?.src).toBe('https://example.com/cover.jpg');
  });

  it('renders subtitle as blockquote', () => {
    const out = articleToNodes(makeArticle({ subtitle: 'Una bajada' }));
    const bq = findFirstByTag(out, 'blockquote');
    expect(bq).toBeDefined();
    expect(flatText([bq as TelegraphNode])).toContain('Una bajada');
  });

  it('prepends author with "Por ..." italic', () => {
    const out = articleToNodes(makeArticle({ author: 'Jane Doe' }));
    expect(flatText(out)).toContain('Por Jane Doe');
  });
});

describe('articleToNodes — inline tag handling (regression)', () => {
  it('handles mismatched <b>...</strong> as bold, not stripped text', () => {
    // Regression: old regex used backreferences (\1/\3), so mismatched
    // open/close tag types fell through to the tail-stripper and the
    // text was emitted plain. After the normalize-pass fix, both should
    // produce a <b> node containing the text.
    const out = articleToNodes(makeArticle({ body: '<p><b>hola</strong> mundo</p>' }));
    const b = findFirstByTag(out, 'b');
    expect(b).toBeDefined();
    expect(flatText([b as TelegraphNode])).toBe('hola');
    expect(flatText(out)).toContain('mundo');
  });

  it('treats <strong>...</strong> identically to <b>', () => {
    const out = articleToNodes(makeArticle({ body: '<p><strong>negrita</strong></p>' }));
    expect(findFirstByTag(out, 'b')).toBeDefined();
  });

  it('treats <em>...</em> as <i>', () => {
    const out = articleToNodes(makeArticle({ body: '<p><em>cursi</em></p>' }));
    expect(findFirstByTag(out, 'i')).toBeDefined();
  });

  it('treats mismatched <em>...</i> as italic', () => {
    const out = articleToNodes(makeArticle({ body: '<p><em>x</i></p>' }));
    expect(findFirstByTag(out, 'i')).toBeDefined();
  });
});

describe('articleToNodes — image handling', () => {
  it('extracts <img> with single-quoted src in body', () => {
    // Regression #22: scrapers (DF, La Tercera vía Googlebot UA) emit
    // src='...' which the previous double-quote-only regex skipped.
    const out = articleToNodes(makeArticle({
      body: `<p>antes</p><figure><img src='https://example.com/y.jpg'></figure><p>después</p>`,
    }));
    const img = findFirstByTag(out, 'img');
    expect((img as any)?.attrs?.src).toBe('https://example.com/y.jpg');
  });

  it('extracts <img> with double-quoted src in body', () => {
    const out = articleToNodes(makeArticle({
      body: `<figure><img src="https://example.com/y.jpg"></figure>`,
    }));
    const img = findFirstByTag(out, 'img');
    expect((img as any)?.attrs?.src).toBe('https://example.com/y.jpg');
  });
});

describe('articleToNodes — disallowed tags are stripped', () => {
  it('strips <video> tags (Telegraph does not support them)', () => {
    const out = articleToNodes(makeArticle({
      body: '<p>antes</p><video src="x.mp4"></video><p>después</p>',
    }));
    // Walk tree — there should be no node with tag 'video'
    function hasTag(nodes: TelegraphNode[], tag: string): boolean {
      for (const n of nodes) {
        if (typeof n === 'string') continue;
        if (n.tag === tag) return true;
        if (hasTag((n.children ?? []) as TelegraphNode[], tag)) return true;
      }
      return false;
    }
    expect(hasTag(out, 'video')).toBe(false);
  });

  it('strips <table> family tags', () => {
    const out = articleToNodes(makeArticle({
      body: '<p>x</p><table><tr><td>cell</td></tr></table><p>y</p>',
    }));
    function hasTag(nodes: TelegraphNode[], tag: string): boolean {
      for (const n of nodes) {
        if (typeof n === 'string') continue;
        if (n.tag === tag) return true;
        if (hasTag((n.children ?? []) as TelegraphNode[], tag)) return true;
      }
      return false;
    }
    expect(hasTag(out, 'table')).toBe(false);
    expect(hasTag(out, 'tr')).toBe(false);
    expect(hasTag(out, 'td')).toBe(false);
  });
});

describe('truncateNodesToBudget', () => {
  it('returns input unchanged when payload fits the budget', () => {
    const small: TelegraphNode[] = [
      { tag: 'p', children: ['short body'] },
      { tag: 'p', children: ['another'] },
    ];
    expect(truncateNodesToBudget(small)).toEqual(small);
  });

  it('drops trailing nodes and appends a sentinel when oversized', () => {
    // Build 200 paragraphs of ~500 chars each — well over 60KB.
    const big: TelegraphNode[] = Array.from({ length: 200 }, (_, i) =>
      ({ tag: 'p', children: ['x'.repeat(500) + ` (#${i})`] })
    );
    const out = truncateNodesToBudget(big);
    expect(out.length).toBeLessThan(big.length);
    // Total payload is now under the 60KB budget.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(60_000);
    // Last node should be the truncation sentinel (italic notice in a <p>).
    const last = out[out.length - 1] as any;
    expect(last.tag).toBe('p');
    const text = flatText([last]);
    expect(text).toContain('truncado');
  });

  it('preserves earliest nodes when truncating (FIFO eviction from the tail)', () => {
    const big: TelegraphNode[] = Array.from({ length: 200 }, (_, i) =>
      ({ tag: 'p', children: ['x'.repeat(500) + ` (#${i})`] })
    );
    const out = truncateNodesToBudget(big);
    // First node should still be #0
    expect(flatText([out[0]])).toContain('(#0)');
  });
});

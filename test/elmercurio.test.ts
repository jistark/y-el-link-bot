import { describe, expect, it } from 'bun:test';
import { sanitizeMercurioMarkup, parseArticleName, groupPageArticles } from '../src/extractors/elmercurio.js';
import { articleToNodes } from '../src/formatters/telegraph.js';
import buchiAnchor from './fixtures/elmercurio_buchi_anchor.json';
import b12Fixture from './fixtures/elmercurio_b12_2026-04-25.json';
import b1Fixture from './fixtures/elmercurio_b1_2026-04-25.json';

describe('sanitizeMercurioMarkup', () => {
  it('converts <P> to <p>', () => {
    expect(sanitizeMercurioMarkup('<P>Hola</P>')).toBe('<p>Hola</p>');
  });

  it('converts <subhead> to <h3>', () => {
    expect(sanitizeMercurioMarkup('<subhead>Tema</subhead>')).toBe('<h3>Tema</h3>');
  });

  it('converts <bold> to <b> and <italic> to <i>', () => {
    expect(sanitizeMercurioMarkup('<bold>x</bold> <italic>y</italic>')).toBe('<b>x</b> <i>y</i>');
  });

  it('converts <bold_intro> to <p><b>', () => {
    expect(sanitizeMercurioMarkup('<bold_intro>—¿Pregunta?</bold_intro>'))
      .toBe('<p><b>—¿Pregunta?</b></p>');
  });

  it('converts <leadin> to <b>', () => {
    expect(sanitizeMercurioMarkup('<leadin>Inicio</leadin> resto'))
      .toBe('<b>Inicio</b> resto');
  });

  it('removes <dropcap/>', () => {
    expect(sanitizeMercurioMarkup('<dropcap/>Antonio')).toBe('Antonio');
  });

  it('removes <highlight> tags but keeps content', () => {
    expect(sanitizeMercurioMarkup('<highlight>Confío más</highlight> en')).toBe('Confío más en');
  });

  it('removes unknown tags but preserves content', () => {
    expect(sanitizeMercurioMarkup('<foo>texto</foo>')).toBe('texto');
  });

  it('handles nested known tags', () => {
    expect(sanitizeMercurioMarkup('<bold>Hola <italic>mundo</italic></bold>'))
      .toBe('<b>Hola <i>mundo</i></b>');
  });

  it('handles empty input', () => {
    expect(sanitizeMercurioMarkup('')).toBe('');
  });

  it('strips outer <body> wrapper', () => {
    expect(sanitizeMercurioMarkup('<body><P>x</P></body>')).toBe('<p>x</p>');
  });

  it('handles attributes on substitution tags', () => {
    expect(sanitizeMercurioMarkup('<bold class="x">Hello</bold>')).toBe('<b>Hello</b>');
    expect(sanitizeMercurioMarkup('<subhead style="y">Tema</subhead>')).toBe('<h3>Tema</h3>');
  });

  it('handles attributes on wrapper tags', () => {
    expect(sanitizeMercurioMarkup('<head_label class="z"><P>Antonio:</P></head_label>')).toBe('<p>Antonio:</p>');
  });

  it('handles attributes on self-closing dropcap', () => {
    expect(sanitizeMercurioMarkup('<dropcap class="foo"/>Antonio')).toBe('Antonio');
  });
});

describe('extractFromDigitalJson (via fixture parsing)', () => {
  it('extracts kicker, quotes, and image from Büchi article JSON', () => {
    expect(buchiAnchor.head_label).toContain('Büchi');
    expect(buchiAnchor.quotes).toHaveLength(2);
    expect(buchiAnchor.images.length).toBeGreaterThanOrEqual(1);
    const mainPhoto = buchiAnchor.images.find((i: any) => i.caption?.includes('CEO de Entel'));
    expect(mainPhoto).toBeDefined();
    expect(mainPhoto!.noExport).toBe(false);
    expect(mainPhoto!.name).toMatch(/NO_WEB_/);
  });
});

describe('parseArticleName', () => {
  it('parses anchor with T1 prefix', () => {
    expect(parseArticleName('T1_EyN_B12_2504_Büchi.ART')).toEqual({
      topicKey: 'T1',
      isRecuadro: false,
      recuadroIndex: null,
      normalizedKey: 'T1_EyN_B12_2504_Büchi',
      isValid: true,
    });
  });

  it('parses recuadro with T1 prefix and _R1 suffix', () => {
    expect(parseArticleName('T1_2_EyN_B12_2504_Büchi_R1.ART')).toEqual({
      topicKey: 'T1',
      isRecuadro: true,
      recuadroIndex: 1,
      normalizedKey: 'T1_EyN_B12_2504_Büchi',
      isValid: true,
    });
  });

  it('parses recuadro R3 with T1 prefix', () => {
    const r = parseArticleName('T1_4_EyN_B12_2504_Büchi_R3.ART');
    expect(r.isRecuadro).toBe(true);
    expect(r.recuadroIndex).toBe(3);
    expect(r.normalizedKey).toBe('T1_EyN_B12_2504_Büchi');
  });

  it('parses article without T-prefix', () => {
    const r = parseArticleName('EYN_B1_LLAMADO_A_2504.ART');
    expect(r.topicKey).toBeNull();
    expect(r.isRecuadro).toBe(false);
    expect(r.isValid).toBe(true);
  });

  it('rejects banner section files (.AR1)', () => {
    expect(parseArticleName('Chile.Nacional.Economía_y_Ne.AR1').isValid).toBe(false);
  });

  it('handles names with accented characters (ü)', () => {
    const r = parseArticleName('T1_2_X_Büchi_R1.ART');
    expect(r.normalizedKey).toBe('T1_X_Büchi');
  });

  it('handles names with periods in the middle', () => {
    expect(parseArticleName('Chile.Foo.Bar.AR1').isValid).toBe(false);
  });
});

describe('groupPageArticles', () => {
  it('detects Büchi story group on B12 page (1 anchor + 4 recuadros)', () => {
    const articles = b12Fixture.articles.map((a: any) => ({
      id: a.id, title: a.title, name: a.name, width: a.width, height: a.height,
      noExport: a.noExport,
    }));
    const result = groupPageArticles(articles);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].anchor.title).toContain('Confío');
    expect(result.groups[0].recuadros).toHaveLength(4);
    const indices = result.groups[0].recuadros.map(r => parseArticleName(r.name).recuadroIndex);
    expect(indices).toEqual([1, 2, 3, 4]);
    expect(result.standalone).toHaveLength(0);
  });

  it('returns no groups on B1 page (banners + NO_WEB filtered, no recuadros)', () => {
    const articles = b1Fixture.articles.map((a: any) => ({
      id: a.id, title: a.title, name: a.name, width: a.width, height: a.height,
      noExport: a.noExport,
    }));
    const result = groupPageArticles(articles);
    expect(result.groups).toHaveLength(0);
    expect(result.standalone).toHaveLength(3);
    expect(result.standalone.find(a => a.name.endsWith('.AR1'))).toBeUndefined();
    expect(result.standalone.find(a => a.name.startsWith('NO_WEB_'))).toBeUndefined();
  });

  it('treats orphan recuadros (no anchor) as standalone', () => {
    const articles = [
      { id: 'a', title: 'orphan', name: 'T9_2_X_Foo_R1.ART', width: 1, height: 1, noExport: false },
    ];
    const result = groupPageArticles(articles);
    expect(result.groups).toHaveLength(0);
    expect(result.standalone).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    expect(groupPageArticles([])).toEqual({ groups: [], standalone: [] });
  });
});

describe('articleToNodes — blockquote and aside rendering', () => {
  it('renders <blockquote> in body as a blockquote node', () => {
    const article = {
      title: 't',
      body: '<blockquote>Quote text</blockquote><p>After</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    const bq = nodes.find((n: any) => typeof n === 'object' && n.tag === 'blockquote');
    expect(bq).toBeDefined();
  });

  it('renders <aside> in body as an aside node', () => {
    const article = {
      title: 't',
      body: '<aside><h3>Recuadro</h3><p>Body</p></aside><p>Main</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    const aside = nodes.find((n: any) => typeof n === 'object' && n.tag === 'aside');
    expect(aside).toBeDefined();
    // Aside should contain h3 and p children
    const children = (aside as any).children;
    expect(children.find((c: any) => c.tag === 'h3')).toBeDefined();
    expect(children.find((c: any) => c.tag === 'p')).toBeDefined();
  });
});

describe('articleToNodes — hr rendering', () => {
  it('emits hr node when body contains <hr>', () => {
    const article = {
      title: 't',
      body: '<p>before</p><hr><p>after</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    const hr = nodes.find((n: any) => typeof n === 'object' && n.tag === 'hr');
    expect(hr).toBeDefined();
  });

  it('emits multiple hr separators in story group output', () => {
    const article = {
      title: 't',
      body: '<p>anchor body</p>\n<hr>\n<h3>R1</h3><p>r1 body</p>\n<hr>\n<h3>R2</h3><p>r2 body</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    const hrs = nodes.filter((n: any) => typeof n === 'object' && n.tag === 'hr');
    expect(hrs).toHaveLength(2);
  });
});

describe('articleToNodes — byline rendering', () => {
  it('renders author as italic "Por X" paragraph', () => {
    const article = {
      title: 't',
      author: 'Eduardo Olivares y César Sottovia',
      body: '<p>x</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    const byline = nodes.find((n: any) =>
      typeof n === 'object'
      && n.tag === 'p'
      && Array.isArray(n.children)
      && n.children.some((c: any) => c?.tag === 'i' && c.children?.[0]?.startsWith('Por '))
    );
    expect(byline).toBeDefined();
  });

  it('does not emit byline node when author is undefined', () => {
    const article = {
      title: 't',
      body: '<p>x</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    const hasBylineP = nodes.some((n: any) =>
      typeof n === 'object'
      && n.tag === 'p'
      && Array.isArray(n.children)
      && n.children.some((c: any) => c?.tag === 'i' && c.children?.[0]?.startsWith('Por '))
    );
    expect(hasBylineP).toBe(false);
  });
});

describe('image filter (tiny image rejection)', () => {
  it('Büchi anchor fixture image filter excludes the small 44×24 glyph', () => {
    // Use the fixture data directly to assert filter logic.
    const fixture = require('./fixtures/elmercurio_buchi_anchor.json');
    const filtered = fixture.images.filter((img: any) =>
      img.noExport === false
      && img.infographic === false
      && img.path
      && (img.width ?? 0) >= 100
      && (img.height ?? 0) >= 100
    );
    // Should keep only the 193×322 Büchi photo, not the 44×24 glyph
    expect(filtered).toHaveLength(1);
    expect(filtered[0].width).toBeGreaterThanOrEqual(100);
  });
});

describe('articleToNodes — kicker fused into title', () => {
  it('does NOT render kicker as a body node (it goes into the page title instead)', () => {
    const article = {
      title: '"Confío más en el mercado"',
      kicker: 'ANTONIO BÜCHI, CEO DE ENTEL:',
      body: '<p>x</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    // Kicker text should NOT appear in any node
    const json = JSON.stringify(nodes);
    expect(json).not.toContain('BÜCHI');
    expect(json).not.toContain('CEO DE ENTEL');
  });

  it('places subtitle as first text node (drives og:description)', () => {
    const article = {
      title: 't',
      kicker: 'k',
      subtitle: 'La bajada del artículo',
      body: '<p>body</p>',
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    // First non-figure node should be the subtitle blockquote
    const firstTextNode = nodes.find((n: any) =>
      typeof n === 'object' && n.tag !== 'figure'
    );
    expect(firstTextNode).toBeDefined();
    expect((firstTextNode as any).tag).toBe('blockquote');
    expect((firstTextNode as any).children[0]).toContain('bajada');
  });
});

describe('articleToNodes — story group cover priority', () => {
  it('when article has body images, no coverImage means first <figure> is body image', () => {
    const article = {
      title: 't',
      body: '<p>body</p>',
      images: [{ url: 'https://example.com/photo.jpg', caption: 'foto' }],
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    // First figure node must be the body image, not a cover
    const firstFigure = nodes.find((n: any) => typeof n === 'object' && n.tag === 'figure');
    expect(firstFigure).toBeDefined();
    const img = (firstFigure as any).children?.find((c: any) => c.tag === 'img');
    expect(img?.attrs?.src).toBe('https://example.com/photo.jpg');
  });

  it('when article has no body images and a coverImage, the cover is the first figure', () => {
    const article = {
      title: 't',
      body: '<p>body</p>',
      coverImage: { url: 'https://example.com/page.jpg' },
      url: 'x',
      source: 'elmercurio' as const,
    };
    const nodes = articleToNodes(article);
    const firstFigure = nodes.find((n: any) => typeof n === 'object' && n.tag === 'figure');
    const img = (firstFigure as any).children?.find((c: any) => c.tag === 'img');
    expect(img?.attrs?.src).toBe('https://example.com/page.jpg');
  });
});

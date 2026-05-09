import { describe, expect, it } from 'bun:test';
import { parseAdprensaItems, isContactList, preprocessPautaContent } from '../src/services/adprensa-poller.js';

function buildXml(itemCount: number): string {
  const items = Array.from({ length: itemCount }, (_, i) => `
    <item>
      <title><![CDATA[Item ${i}]]></title>
      <guid>https://adprensa.cl/?p=${i}</guid>
      <link>https://adprensa.cl/p/${i}</link>
      <pubDate>Mon, 26 Apr 2026 10:00:00 +0000</pubDate>
      <category><![CDATA[Pauta]]></category>
      <content:encoded><![CDATA[<p>body ${i}</p>]]></content:encoded>
    </item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

describe('parseAdprensaItems', () => {
  it('parses a small feed end-to-end', () => {
    const items = parseAdprensaItems(buildXml(3));
    expect(items).toHaveLength(3);
    expect(items[0].guid).toBe('https://adprensa.cl/?p=0');
    expect(items[0].title).toBe('Item 0');
    expect(items[0].link).toBe('https://adprensa.cl/p/0');
    expect(items[0].categories).toEqual(['Pauta']);
  });

  it('caps parsing at MAX_ITEMS_PARSED to bound memory on adversarial feeds', () => {
    // Feed has 200 items; cap is 50. Without the cap, an adversarial feed
    // could exhaust Render's 512MB instance during parsing alone.
    const items = parseAdprensaItems(buildXml(200));
    expect(items).toHaveLength(50);
  });

  it('skips items missing required fields silently', () => {
    const xml = `<rss><channel>
      <item><title>has no guid</title><content:encoded><![CDATA[x]]></content:encoded></item>
      <item><title>full</title><guid>g1</guid><content:encoded><![CDATA[<p>body</p>]]></content:encoded></item>
    </channel></rss>`;
    const items = parseAdprensaItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].guid).toBe('g1');
  });
});

describe('isContactList', () => {
  it('detects a <table> containing "e-mail" or "fono"', () => {
    const html = '<table><tr><td>Nombre</td><td>e-mail</td><td>Fono</td></tr></table>';
    expect(isContactList(html)).toBe(true);
  });

  it('detects "celular" inside a table', () => {
    const html = '<table><tr><th>Persona</th><th>Celular</th></tr></table>';
    expect(isContactList(html)).toBe(true);
  });

  it('does not flag plain prose with no <table>', () => {
    const html = '<p>Esta es una nota normal con email@x.com mencionado.</p>';
    expect(isContactList(html)).toBe(false);
  });

  it('does not flag a generic <table> without contact-shaped headers', () => {
    const html = '<table><tr><td>foo</td><td>bar</td></tr></table>';
    expect(isContactList(html)).toBe(false);
  });
});

describe('preprocessPautaContent', () => {
  it('converts ===WRAPPED=== section headings to <h3>', () => {
    const html = '<p>===<br />\nTITULO<br />\n===</p>';
    const out = preprocessPautaContent(html);
    expect(out).toContain('<h3>TITULO</h3>');
  });

  it('converts ——— wrapped subsection headings to <h4>', () => {
    const html = '<p>———————<br />\nATENCION<br />\n———————</p>';
    const out = preprocessPautaContent(html);
    expect(out).toContain('<h4>ATENCION</h4>');
  });

  it('removes standalone separator lines', () => {
    const html = '<p>===========</p><p>real content</p>';
    const out = preprocessPautaContent(html);
    expect(out).not.toContain('===');
    expect(out).toContain('real content');
  });

  it('wraps consecutive dash-prefixed paragraphs in <ul>', () => {
    const html = '<p>- item 1</p><p>- item 2</p><p>- item 3</p>';
    const out = preprocessPautaContent(html);
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>item 1</li>');
    expect(out).toContain('<li>item 2</li>');
    expect(out).toContain('<li>item 3</li>');
    expect(out).toContain('</ul>');
  });
});

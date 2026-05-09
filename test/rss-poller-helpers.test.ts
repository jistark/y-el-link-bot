import { describe, expect, it } from 'bun:test';
import { parseSenalItems, extractMediaLinks, formatCaption } from '../src/services/rss-poller.js';
import type { SenalRssItem } from '../src/services/rss-poller.js';

function buildXml(itemCount: number, contentTemplate?: (i: number) => string): string {
  const items = Array.from({ length: itemCount }, (_, i) => `
    <item>
      <title><![CDATA[Item ${i}]]></title>
      <guid>https://senal.com/?p=${i}</guid>
      <link>https://senal.com/p/${i}</link>
      <content:encoded><![CDATA[${contentTemplate ? contentTemplate(i) : `<p>body ${i}</p>`}]]></content:encoded>
    </item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

describe('parseSenalItems', () => {
  it('parses a small feed end-to-end', () => {
    const items = parseSenalItems(buildXml(3));
    expect(items).toHaveLength(3);
    expect(items[0].guid).toBe('https://senal.com/?p=0');
    expect(items[0].title).toBe('Item 0');
    expect(items[0].link).toBe('https://senal.com/p/0');
  });

  it('caps parsing at MAX_ITEMS_PARSED to bound memory on adversarial feeds', () => {
    // Same MAX_ITEMS_PARSED = 50 contract as adprensa/fotoportadas.
    const items = parseSenalItems(buildXml(200));
    expect(items).toHaveLength(50);
  });

  it('skips items missing required fields silently', () => {
    const xml = `<rss><channel>
      <item><title>has no guid</title><content:encoded><![CDATA[x]]></content:encoded></item>
      <item><title>full</title><guid>g1</guid><content:encoded><![CDATA[<p>body</p>]]></content:encoded></item>
    </channel></rss>`;
    const items = parseSenalItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0].guid).toBe('g1');
  });
});

describe('extractMediaLinks', () => {
  it('extracts vimeo ID from player URL', () => {
    const html = '<iframe src="https://player.vimeo.com/video/987654321?autoplay=0"></iframe>';
    const m = extractMediaLinks(html);
    expect(m.vimeoId).toBe('987654321');
  });

  it('extracts fotos download link via WeTransfer / similar', () => {
    const html = `
      <p>Link de descarga Fotos: <a href="https://wetransfer.com/downloads/abc123">Descargar</a></p>
    `;
    expect(extractMediaLinks(html).fotosLink).toBe('https://wetransfer.com/downloads/abc123');
  });

  it('extracts video link with </span> between label and <a> (regression)', () => {
    // The regex tolerates HTML between the colon and the anchor tag —
    // matches the gmail-to-WordPress pipeline that ends labels with </span>.
    const html = `
      <p><span>Link de descarga Video HD:</span> <a href="https://wetransfer.com/downloads/video">v</a></p>
    `;
    expect(extractMediaLinks(html).videoLink).toBe('https://wetransfer.com/downloads/video');
  });

  it('extracts download key (alphanumeric)', () => {
    const html = '<p>Clave de Descarga: ABC123def</p>';
    expect(extractMediaLinks(html).clave).toBe('ABC123def');
  });

  it('returns nulls for fields not present', () => {
    const m = extractMediaLinks('<p>nada relevante</p>');
    expect(m.vimeoId).toBeNull();
    expect(m.fotosLink).toBeNull();
    expect(m.videoLink).toBeNull();
    expect(m.clave).toBeNull();
  });
});

function buildItem(overrides: Partial<SenalRssItem> = {}): SenalRssItem {
  return {
    title: 'Título',
    guid: 'g1',
    link: 'https://senal.com/abc',
    contentEncoded: '',
    ...overrides,
  } as SenalRssItem;
}

describe('formatCaption', () => {
  it('renders a minimal caption with title only', () => {
    const out = formatCaption(buildItem({ link: '' }), {
      vimeoId: null, fotosLink: null, videoLink: null, clave: null,
    });
    // Title is bolded and the camera emoji prefix is present
    expect(out).toContain('<b>Título</b>');
    expect(out).toContain('📹');
  });

  it('escapes HTML in the title (regression — & / < / > break parse_mode HTML)', () => {
    const out = formatCaption(buildItem({ title: 'A & B <evil>' }), {
      vimeoId: null, fotosLink: null, videoLink: null, clave: null,
    });
    expect(out).toContain('A &amp; B &lt;evil&gt;');
    expect(out).not.toContain('<evil>');
  });

  it('includes the Clave line when present', () => {
    const out = formatCaption(buildItem(), {
      vimeoId: null, fotosLink: null, videoLink: null, clave: 'XYZ',
    });
    expect(out).toContain('Clave: XYZ');
  });

  it('renders a Video link when item.link is present', () => {
    const out = formatCaption(buildItem({ link: 'https://senal.com/abc' }), {
      vimeoId: null, fotosLink: null, videoLink: null, clave: null,
    });
    expect(out).toContain('<a href="https://senal.com/abc">Video</a>');
  });

  it('renders Video HD and Fotos links when present in media', () => {
    const out = formatCaption(buildItem({ link: '' }), {
      vimeoId: null,
      videoLink: 'https://wetransfer.com/downloads/video',
      fotosLink: 'https://wetransfer.com/downloads/fotos',
      clave: null,
    });
    expect(out).toContain('Video HD');
    expect(out).toContain('Fotos');
  });

  it('escapes HTML in URLs (defensive — & in query strings)', () => {
    const out = formatCaption(buildItem({ link: 'https://x.com/?a=1&b=2' }), {
      vimeoId: null, fotosLink: null, videoLink: null, clave: null,
    });
    // & must be escaped to &amp; in href values
    expect(out).toMatch(/href="https:\/\/x\.com\/\?a=1&amp;b=2"/);
  });
});

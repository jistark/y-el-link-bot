import { describe, expect, it } from 'bun:test';
import { parseFotoportadasItems, extractFotoportadaImages } from '../src/services/fotoportadas-poller.js';

function buildXml(itemCount: number, contentTemplate?: (i: number) => string): string {
  const items = Array.from({ length: itemCount }, (_, i) => `
    <item>
      <title><![CDATA[Foto ${i}]]></title>
      <guid>https://foto.cl/?p=${i}</guid>
      <link>https://foto.cl/p/${i}</link>
      <pubDate>Mon, 26 Apr 2026 10:00:00 +0000</pubDate>
      <content:encoded><![CDATA[${contentTemplate ? contentTemplate(i) : `<img src="https://foto.cl/img${i}.jpg">`}]]></content:encoded>
    </item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

describe('parseFotoportadasItems', () => {
  it('parses a small feed', () => {
    const items = parseFotoportadasItems(buildXml(3));
    expect(items).toHaveLength(3);
    expect(items[0].guid).toBe('https://foto.cl/?p=0');
    expect(items[0].title).toBe('Foto 0');
    expect(items[0].pubDate).toBe('Mon, 26 Apr 2026 10:00:00 +0000');
  });

  it('caps at MAX_ITEMS_PARSED', () => {
    const items = parseFotoportadasItems(buildXml(200));
    expect(items).toHaveLength(50);
  });

  it('skips items missing required fields', () => {
    const xml = `<rss><channel>
      <item><title>no guid</title><content:encoded><![CDATA[x]]></content:encoded></item>
      <item><title>ok</title><guid>g1</guid><content:encoded><![CDATA[<p>x</p>]]></content:encoded></item>
    </channel></rss>`;
    expect(parseFotoportadasItems(xml)).toHaveLength(1);
  });
});

describe('extractFotoportadaImages', () => {
  it('extracts mcusercontent.com images and skips logo/sawa-dev', () => {
    // Real Mailchimp emails repeat each image ~3x; we expect dedupe.
    const html = `
      <img src="https://gallery.mcusercontent.com/abc/portada1.jpg">
      <img src="https://other-cdn.com/logo.png">
      <img src="https://gallery.mcusercontent.com/abc/portada2.jpg">
      <img src="https://gallery.mcusercontent.com/abc/portada1.jpg">
      <img src="https://gallery.mcusercontent.com/abc/sawa-dev/logo.png">
    `;
    const out = extractFotoportadaImages(html);
    // Logo (other-cdn) skipped; sawa-dev skipped; portada1 deduped.
    expect(out).toEqual([
      'https://gallery.mcusercontent.com/abc/portada1.jpg',
      'https://gallery.mcusercontent.com/abc/portada2.jpg',
    ]);
  });

  it('drops non-mcusercontent images entirely', () => {
    // The function deliberately filters to Mailchimp content. Other CDNs
    // (logos, banners) are dropped — they are never the front-page covers.
    const html = '<img src="https://foto.cl/a.jpg"><img src="https://foto.cl/b.jpg">';
    expect(extractFotoportadaImages(html)).toEqual([]);
  });

  it('returns [] when no images present', () => {
    expect(extractFotoportadaImages('<p>texto</p>')).toEqual([]);
    expect(extractFotoportadaImages('')).toEqual([]);
  });
});

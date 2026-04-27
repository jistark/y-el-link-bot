import { describe, expect, it } from 'bun:test';
import { sanitizeMercurioMarkup } from '../src/extractors/elmercurio.js';
import buchiAnchor from './fixtures/elmercurio_buchi_anchor.json';

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

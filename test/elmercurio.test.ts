import { describe, expect, it } from 'bun:test';
import { sanitizeMercurioMarkup, parseArticleName } from '../src/extractors/elmercurio.js';
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

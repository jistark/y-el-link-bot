import { describe, expect, it } from 'bun:test';
import { processMacros, extractArticleId } from '../src/extractors/lasegunda.js';

describe('extractArticleId', () => {
  it('extracts numeric ID from path', () => {
    expect(extractArticleId('https://lasegunda.com/seccion/123456/titulo')).toBe('123456');
  });

  it('returns null when no numeric segment present', () => {
    expect(extractArticleId('https://lasegunda.com/seccion/articulo-x')).toBeNull();
  });
});

describe('processMacros', () => {
  it('converts {IMAGEN url} to <img>', () => {
    expect(processMacros('Antes {IMAGEN https://x.com/foo.jpg} después'))
      .toBe('Antes <img src="https://x.com/foo.jpg"> después');
  });

  it('converts {IMAGENCREDITO url; caption} to <figure>', () => {
    const out = processMacros('{IMAGENCREDITO https://x.com/y.jpg;Foto: Juan}');
    expect(out).toBe('<figure><img src="https://x.com/y.jpg"><figcaption>Foto: Juan</figcaption></figure>');
  });

  it('strips {VIDEO ...} entirely', () => {
    expect(processMacros('Texto {VIDEO https://x.com/v.mp4} más texto'))
      .toBe('Texto  más texto');
  });

  it('strips single-line {CITA ...} and {DESTACAR ...}', () => {
    expect(processMacros('Antes {CITA texto} después')).toBe('Antes  después');
    expect(processMacros('Antes {DESTACAR algo} después')).toBe('Antes  después');
  });

  it('strips multiline {CITA ...} (regression — old [^}]* did not match newlines)', () => {
    const input = 'Antes {CITA\n  línea uno\n  línea dos\n} después';
    const out = processMacros(input);
    expect(out).toBe('Antes  después');
  });

  it('strips multiline {DESTACAR ...}', () => {
    expect(processMacros('A {DESTACAR\n bb\n cc\n} D')).toBe('A  D');
  });

  it('strips unknown all-caps macros that span newlines', () => {
    expect(processMacros('A {NOTA\n  contenido\n} B')).toBe('A  B');
  });

  it('handles plain text without macros unchanged', () => {
    expect(processMacros('Sin macros aquí.')).toBe('Sin macros aquí.');
  });
});

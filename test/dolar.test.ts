import { describe, expect, it } from 'bun:test';
import {
  formatCLP, formatDollarRich, parseDollarHtml, DOLLAR_SOURCES, type DollarData,
} from '../src/commands/dolar.js';

describe('formatCLP', () => {
  it('adds the $ prefix and Chilean grouping (no decimals for integers)', () => {
    expect(formatCLP(987)).toBe('$987');
    expect(formatCLP(1234)).toBe('$1.234');
    expect(formatCLP(1234567)).toBe('$1.234.567');
  });

  it('keeps decimals when value has fractional component', () => {
    // The function uses minimumFractionDigits: 0 + maximumFractionDigits: 2
    // so non-integer values render up to 2 decimals.
    expect(formatCLP(987.5)).toMatch(/^\$987,5/);
  });

  it('handles zero', () => {
    expect(formatCLP(0)).toBe('$0');
  });
});

describe('parseDollarHtml', () => {
  it('throws on a Vercel/dolar.cl challenge page (no "buy" field)', () => {
    expect(() => parseDollarHtml('<html>Just a Moment...</html>')).toThrow(/challenge/);
  });

  it('throws on a page with the buy field but no source/data blocks', () => {
    // Has the "buy" sentinel but no actual quote data — should fall through
    // to the "no data" error rather than silently returning empty quotes.
    const html = '"buy":}'; // present but unparseable
    expect(() => parseDollarHtml(html)).toThrow(/no devolvió datos/);
  });

  it('parses a minimal happy-path payload', () => {
    // Build a minimal mock of dolar.cl's hydration shape with two sources.
    const html = `
      lastQuote","source":"fintual"}
      "buy":900.50,"sell":920.75,"time":1735000000000
      lastQuote","source":"bci"}
      "buy":910.00,"sell":925.00,"time":1735000000001
    `;
    const data = parseDollarHtml(html);
    expect(data.quotes.length).toBe(DOLLAR_SOURCES.length);

    // Find the source IDs that got populated
    const populated = data.quotes.filter(q => q.quote !== null).map(q => q.source.id);
    expect(populated).toContain('fintual');
    expect(populated).toContain('bci');

    const fintual = data.quotes.find(q => q.source.id === 'fintual')!;
    expect(fintual.quote?.buy).toBe(900.5);
    expect(fintual.quote?.sell).toBe(920.75);
  });

  it('extracts the live quote when present', () => {
    const html = `
      "change":-2.5,"close":910.25,"datetime":"2026-01-01T15:00:00","high":915,"low":905,"open":912,"percentChange":-0.27
      lastQuote","source":"fintual"}
      "buy":910.00,"sell":925.00,"time":1735000000000
    `;
    const data = parseDollarHtml(html);
    expect(data.live).not.toBeNull();
    expect(data.live?.close).toBe(910.25);
    expect(data.live?.change).toBe(-2.5);
    expect(data.live?.percentChange).toBe(-0.27);
  });
});

function makeQuote(buy: number, sell: number | null = buy + 5): { buy: number; sell: number | null; time: string; fee: null } {
  return { buy, sell, time: '2026-01-01T00:00:00Z', fee: null };
}

describe('formatDollarRich', () => {
  const fakeData: DollarData = {
    live: {
      open: 900, high: 920, low: 895, close: 915,
      change: 5, percentChange: 0.0055, datetime: '2026-01-01T00:00:00',
    },
    quotes: [
      { source: DOLLAR_SOURCES[0], quote: makeQuote(905) }, // BTG
      { source: DOLLAR_SOURCES[1], quote: makeQuote(900) }, // Fintual
      { source: DOLLAR_SOURCES[2], quote: null },           // BCI: missing
      { source: DOLLAR_SOURCES[3], quote: makeQuote(910) }, // Falabella
      { source: DOLLAR_SOURCES[4], quote: null },
      { source: DOLLAR_SOURCES[5], quote: null },
      { source: DOLLAR_SOURCES[6], quote: makeQuote(908) }, // BancoEstado
      { source: DOLLAR_SOURCES[7], quote: null },
    ],
  };

  it('renders header with live quote and arrow', () => {
    const out = formatDollarRich(fakeData, undefined, '15:30');
    expect(out).toContain('DÓLAR AHORA');
    expect(out).toContain('$915');
    expect(out).toContain('📈'); // change is positive
  });

  it('uses 📉 when change is negative', () => {
    const negData: DollarData = {
      ...fakeData,
      live: { ...fakeData.live!, change: -3, percentChange: -0.003 },
    };
    expect(formatDollarRich(negData, undefined, '15:30')).toContain('📉');
  });

  it('omits null quotes from the body', () => {
    const out = formatDollarRich(fakeData, undefined, '15:30')!;
    expect(out).toContain('Fintual');
    expect(out).toContain('BancoEstado');
    expect(out).not.toContain('BCI');
    expect(out).not.toContain('Itaú');
  });

  it('sorts quotes by buy price ascending', () => {
    const out = formatDollarRich(fakeData, undefined, '15:30')!;
    const fintualIdx = out.indexOf('Fintual');
    const btgIdx = out.indexOf('BTG');
    const bancoEstadoIdx = out.indexOf('BancoEstado');
    const falabellaIdx = out.indexOf('Banco Falabella');
    // Buy prices: Fintual 900, BTG 905, BancoEstado 908, Falabella 910
    expect(fintualIdx).toBeLessThan(btgIdx);
    expect(btgIdx).toBeLessThan(bancoEstadoIdx);
    expect(bancoEstadoIdx).toBeLessThan(falabellaIdx);
  });

  it('returns null when filter matches no sources', () => {
    expect(formatDollarRich(fakeData, 'no-such-bank', '15:30')).toBeNull();
  });

  it('filters by name (case + accent insensitive)', () => {
    // "itau" is an alias for "Itaú" — but Itaú has no quote in fakeData,
    // so we expect null. Use BancoEstado instead.
    const out = formatDollarRich(fakeData, 'bancoestado', '15:30');
    expect(out).toContain('BancoEstado');
    // Other banks should not appear
    expect(out).not.toContain('Fintual');
  });

  it('filters via alias', () => {
    // "bech" is an alias for BancoEstado.
    const out = formatDollarRich(fakeData, 'bech', '15:30');
    expect(out).toContain('BancoEstado');
  });

  it('renders without live quote when null', () => {
    const noLive: DollarData = { live: null, quotes: fakeData.quotes };
    const out = formatDollarRich(noLive, undefined, '15:30')!;
    expect(out).toContain('DÓLAR AHORA');
    expect(out).not.toContain('📈');
    expect(out).not.toContain('📉');
  });
});

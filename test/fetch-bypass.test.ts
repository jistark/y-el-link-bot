import { describe, expect, it } from 'bun:test';
import { fetchBypass } from '../src/extractors/fetch-bypass.js';

// fetchBypass throws synchronously (well, in the Promise) for invalid
// schemes BEFORE spawning the Python subprocess, so these tests don't
// require the Python venv or actually shell out.

describe('fetchBypass — URL scheme guard', () => {
  it('rejects file:// URLs', async () => {
    await expect(fetchBypass('file:///etc/passwd')).rejects.toThrow(/Esquema no permitido/);
  });

  it('rejects ftp:// URLs', async () => {
    await expect(fetchBypass('ftp://example.com/x')).rejects.toThrow(/Esquema no permitido/);
  });

  it('rejects gopher:// URLs', async () => {
    await expect(fetchBypass('gopher://example.com/')).rejects.toThrow(/Esquema no permitido/);
  });

  it('rejects javascript: pseudo-URLs', async () => {
    await expect(fetchBypass('javascript:alert(1)')).rejects.toThrow(/Esquema no permitido/);
  });

  it('rejects malformed URLs with a clear error', async () => {
    await expect(fetchBypass('not-a-url')).rejects.toThrow(/URL inválida/);
    await expect(fetchBypass('')).rejects.toThrow(/URL inválida/);
  });

  // We don't test the http/https success path here — it would actually
  // spawn the Python script and hit a real URL. That belongs in an
  // integration test with TELEGRAPH-style harness, not a unit test.
});

describe('fetchBypass — overload shape', () => {
  // Type-level guarantees: all overload forms compile and reject invalid
  // schemes consistently. Runtime behavior beyond the guard requires the
  // Python subprocess and lives in integration tests.
  it('accepts opts object form', async () => {
    await expect(fetchBypass('file:///etc/passwd', {
      referer: 'https://google.com',
      headers: { 'User-Agent': 'test' },
      mode: 'chrome',
    })).rejects.toThrow(/Esquema no permitido/);
  });

  it('accepts empty opts object', async () => {
    await expect(fetchBypass('javascript:1', {})).rejects.toThrow(/Esquema no permitido/);
  });

  it('still accepts legacy (referer, mode) form', async () => {
    await expect(fetchBypass('ftp://x', 'https://google.com', 'googlebot')).rejects.toThrow(/Esquema no permitido/);
  });
});

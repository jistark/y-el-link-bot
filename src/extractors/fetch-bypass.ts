/**
 * Fetch URLs via Python curl_cffi when direct fetch fails (Cloudflare/Vercel bot detection).
 * Uses project .venv if available, falls back to system python3.
 */
import { spawn } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

const PROJECT_ROOT = resolve(import.meta.dir, '../..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'scripts/fetch_bypass.py');
const VENV_PYTHON = resolve(PROJECT_ROOT, '.venv/bin/python3');
const PYTHON_CMD = process.env.PYTHON_CMD || (existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
// Must exceed Python's worst-case path: proxy (30s) + direct retry (40s) +
// webcache (20s) = 90s. Render mode (60s proxy) also fits with margin.
const TIMEOUT_MS = 90_000;

export type FetchMode = 'chrome' | 'googlebot' | 'inspectiontool';

export interface FetchBypassOptions {
  referer?: string;
  /**
   * Recipe headers (User-Agent, X-Forwarded-For, headers_custom, etc.)
   * forwarded to the Python script via the `EXTRA_HEADERS` env var so they
   * survive escalation through IPRoyal Web Unblocker.
   */
  headers?: Record<string, string>;
  mode?: FetchMode;
}

export function fetchBypass(url: string, opts?: FetchBypassOptions): Promise<string>;
// Legacy 3-arg form preserved for callers not yet migrated.
export function fetchBypass(url: string, referer?: string, mode?: FetchMode): Promise<string>;
export function fetchBypass(
  url: string,
  optsOrReferer?: FetchBypassOptions | string,
  legacyMode?: FetchMode,
): Promise<string> {
  const opts: FetchBypassOptions =
    typeof optsOrReferer === 'string' || optsOrReferer === undefined
      ? { referer: optsOrReferer as string | undefined, mode: legacyMode }
      : optsOrReferer;

  const referer = opts.referer ?? '';
  const mode: FetchMode = opts.mode ?? 'chrome';
  const headers = opts.headers;

  // Reject non-http(s) schemes before spawning Python. URLs originate from
  // user-pasted Telegram messages; without this guard a `file://` or
  // `gopher://` URL would be handed to curl_cffi which honors them.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error(`URL inválida: ${url}`));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error(`Esquema no permitido: ${parsed.protocol}`));
  }

  return new Promise((resolvePromise, reject) => {
    const args = [SCRIPT_PATH, url, referer, mode];

    // Pass headers via env var — never argv — to keep them out of `ps` output
    // and to avoid quoting headaches with values containing spaces or quotes.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (headers && Object.keys(headers).length > 0) {
      env.EXTRA_HEADERS = JSON.stringify(headers);
    }

    const proc = spawn(PYTHON_CMD, args, {
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (data: Buffer) => chunks.push(data));
    proc.stderr.on('data', (data: Buffer) => errChunks.push(data));

    proc.on('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(chunks).toString('utf-8'));
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
        reject(new Error(`fetch_bypass failed: ${stderr || `exit code ${code}`}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`fetch_bypass spawn error: ${err.message}`));
    });
  });
}

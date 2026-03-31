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
const TIMEOUT_MS = 25_000;

export async function fetchBypass(url: string, referer?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT_PATH, url];
    if (referer) args.push(referer);

    const proc = spawn(PYTHON_CMD, args, {
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (data: Buffer) => chunks.push(data));
    proc.stderr.on('data', (data: Buffer) => errChunks.push(data));

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf-8'));
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

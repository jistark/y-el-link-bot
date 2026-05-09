/**
 * Persistent TTL queue for Telegraph paths that should be deleted at a
 * specific future time (e.g. ADPrensa contact lists with PII that expire 72h
 * after publication).
 *
 * Why not setTimeout: a 72h timer would never fire on Render's Starter plan,
 * which restarts the process on each redeploy (typically multiple times per
 * day). The closure also keeps the page path alive in the event-loop heap
 * indefinitely. This file-backed queue survives restarts.
 *
 * The barrido (sweepExpirations) is called from the ADPrensa poller's
 * pre-tick hook so it runs once per cycle (~15min cadence in prod), which
 * is granular enough — items are scheduled for hours/days in the future.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { deletePage } from '../formatters/telegraph.js';

// Resolved lazily so tests can chdir into a sandboxed tmpdir before the
// first read/write. If we baked the path in at module-init, the value
// would freeze to whatever process.cwd() was when test discovery loaded
// the module — which is rarely the test's tmpdir.
function dataDir() { return join(process.cwd(), 'data'); }
function dataPath() { return join(dataDir(), 'expirations.json'); }

interface Expiration {
  /** Telegraph page path (slug, not full URL) */
  path: string;
  /** Unix ms epoch when the page should be deleted */
  expireAt: number;
  /** Free-form tag for logging */
  reason?: string;
}

let cache: Expiration[] | null = null;

async function load(): Promise<Expiration[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(dataPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function save(): Promise<void> {
  if (!cache) return;
  try {
    try { mkdirSync(dataDir(), { recursive: true }); } catch { /* ok */ }
    await writeFile(dataPath(), JSON.stringify(cache), 'utf-8');
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'expirations_save_error',
      error: err?.message || String(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

export async function scheduleExpiry(path: string, ttlMs: number, reason?: string): Promise<void> {
  const list = await load();
  list.push({ path, expireAt: Date.now() + ttlMs, reason });
  await save();
}

/**
 * Delete any Telegraph pages whose expireAt has passed, then remove them
 * from the queue. Idempotent — safe to call repeatedly.
 */
export async function sweepExpirations(): Promise<void> {
  const list = await load();
  const now = Date.now();
  const due: Expiration[] = [];
  const remaining: Expiration[] = [];
  for (const e of list) {
    if (e.expireAt <= now) due.push(e);
    else remaining.push(e);
  }
  if (due.length === 0) return;

  for (const e of due) {
    try {
      await deletePage(e.path);
      console.log(JSON.stringify({
        event: 'expiration_swept',
        path: e.path,
        reason: e.reason,
        timestamp: new Date().toISOString(),
      }));
    } catch (err: any) {
      console.error(JSON.stringify({
        event: 'expiration_sweep_error',
        path: e.path,
        error: err?.message || String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }
  cache = remaining;
  await save();
}

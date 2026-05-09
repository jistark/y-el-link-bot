/**
 * Persistent registry of processed items, stored on disk.
 *
 * With Render's persistent disk mounted at /app/data, the registry
 * file survives redeploys. Simple file I/O replaces the previous
 * Telegraph API approach — faster and no HTTP round-trips.
 *
 * Capacity: last MAX_ENTRIES items (~100), FIFO rotation.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mkdirSync } from 'fs';

// Lazy: resolved on each call so tests can chdir into a sandboxed tmpdir
// before the first read/write. Baking the path in at init freezes it to
// whatever cwd happened to be when test discovery loaded the module.
function registryPath(): string {
  return join(process.cwd(), 'data', 'registry.json');
}
const MAX_ENTRIES = 100;

export interface RegistryEntry {
  /** Discriminator for the processing pipeline */
  type: 'extractor' | 'rss-senal' | 'rss-adprensa' | 'rss-fotoportadas';
  /** Fetchable URL (article URL for extractors, RSS <link> for pollers) */
  originalUrl: string;
  /** RSS GUID — only for poller entries */
  guid?: string;
  /** Source identifier (wapo, latercera, senal, adprensa, etc.) */
  source: string;
  /** Telegraph page path — only for items that created a page */
  telegraphPath?: string;
  /** Article/item title */
  title: string;
  /** Chat where the message was sent */
  chatId?: number;
  /** Telegram message ID (for editing/regenerating) */
  messageId?: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

let entriesCache: RegistryEntry[] | null = null;
let savePromise: Promise<void> | null = null;

// --- Load / Save ---

async function loadEntries(): Promise<RegistryEntry[]> {
  if (entriesCache) return entriesCache;

  try {
    const raw = await readFile(registryPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    // Guard against shape mismatch (e.g. partial write left valid JSON
    // that is not an array). Without this, every subsequent push/splice
    // would throw TypeError.
    entriesCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    // File doesn't exist yet or is corrupted — start fresh
    entriesCache = [];
  }

  return entriesCache!;
}

async function saveEntries(): Promise<void> {
  if (!entriesCache) return;

  try {
    try { mkdirSync(join(process.cwd(), 'data'), { recursive: true }); } catch { /* ok */ }
    const json = JSON.stringify(entriesCache.slice(-MAX_ENTRIES));
    await writeFile(registryPath(), json, 'utf-8');
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'registry_save_error',
      error: err?.message || String(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

// Debounce saves: batch rapid writes into a single disk write
function scheduleSave(): void {
  if (savePromise) return;
  savePromise = new Promise<void>((resolve) => {
    setTimeout(async () => {
      await saveEntries();
      // Resolve before clearing the slot so awaiters see the completed save.
      // If we cleared first, a second scheduleSave() arriving in the resolve
      // microtask window would create a fresh debounce timer and observe
      // stale state.
      resolve();
      savePromise = null;
    }, 2_000); // 2s debounce
  });
}

// --- Public API ---

export async function addRegistryEntry(entry: Omit<RegistryEntry, 'timestamp'>): Promise<void> {
  const entries = await loadEntries();

  entries.push({ ...entry, timestamp: new Date().toISOString() });

  // FIFO cap
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  scheduleSave();
}

export async function findByTelegraphPath(path: string): Promise<RegistryEntry | undefined> {
  const entries = await loadEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].telegraphPath === path) return entries[i];
  }
}

export async function findByGuid(guid: string): Promise<RegistryEntry | undefined> {
  const entries = await loadEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].guid === guid) return entries[i];
  }
}

export async function findByGuidPrefix(prefix: string): Promise<RegistryEntry | undefined> {
  const entries = await loadEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].guid?.startsWith(prefix)) return entries[i];
  }
}

/**
 * Look up an entry by the 16-char SHA-256 hash of its GUID. Optionally filter
 * by source to limit the search space (e.g. only re-hash adprensa entries).
 * Used by the RSS regen callback handler — see hashGuid in rss-shared.ts.
 */
export async function findByGuidHash(
  hash: string,
  source?: string,
): Promise<RegistryEntry | undefined> {
  const { hashGuid } = await import('./rss-shared.js');
  const entries = await loadEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.guid) continue;
    if (source && e.source !== source) continue;
    if (hashGuid(e.guid) === hash) return e;
  }
}

export async function updateRegistryEntry(
  guid: string,
  updates: Partial<Pick<RegistryEntry, 'messageId' | 'telegraphPath'>>,
): Promise<void> {
  const entries = await loadEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].guid === guid) {
      Object.assign(entries[i], updates);
      scheduleSave();
      return;
    }
  }
}

export async function findByMessageId(chatId: number, messageId: number): Promise<RegistryEntry | undefined> {
  const entries = await loadEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].chatId === chatId && entries[i].messageId === messageId) return entries[i];
  }
}

export async function getRecentEntries(type?: RegistryEntry['type'], limit = 10): Promise<RegistryEntry[]> {
  const entries = await loadEntries();
  const filtered = type ? entries.filter(e => e.type === type) : entries;
  return filtered.slice(-limit);
}

/** Force an immediate save (call before shutdown if needed) */
export async function flushRegistry(): Promise<void> {
  await saveEntries();
}

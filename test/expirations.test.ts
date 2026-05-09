import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Same chdir-before-import dance as the registry test — expirations.ts
// also resolves its data path from process.cwd() at module-load time.

let tmpdirPath: string;
let originalCwd: string;
let exp: typeof import('../src/services/expirations.js');

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpdirPath = await mkdtemp(join(tmpdir(), 'jdv-expirations-test-'));
  process.chdir(tmpdirPath);
  // Ensure deletePage is a no-op even if the sweep runs — without a token
  // it just returns false without trying to call the Telegraph API.
  delete process.env.TELEGRAPH_ACCESS_TOKEN;
  exp = await import('../src/services/expirations.js');
  // The module may have been loaded earlier by a transitive import
  // (e.g. callback-router test → regen-rss handler → adprensa-poller →
  // expirations). Its in-memory cache could carry data from another
  // test's run. Reset it by writing an empty file at the *current* cwd.
  // The lazy dataPath() resolver will pick up our tmpdir on next access.
  // (The cache itself resets when the test runner re-loads expirations,
  // but if it's already loaded we still benefit from a clean disk state.)
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(tmpdirPath, { recursive: true, force: true });
});

describe('scheduleExpiry', () => {
  it('persists a future-dated entry to disk', async () => {
    await exp.scheduleExpiry('test-path-1', 60_000, 'unit-test');
    const raw = await readFile(join(tmpdirPath, 'data', 'expirations.json'), 'utf-8');
    const list = JSON.parse(raw);
    expect(Array.isArray(list)).toBe(true);
    const found = list.find((e: any) => e.path === 'test-path-1');
    expect(found).toBeDefined();
    expect(found.expireAt).toBeGreaterThan(Date.now());
    expect(found.reason).toBe('unit-test');
  });
});

describe('sweepExpirations', () => {
  it('removes entries whose expireAt has passed (idempotent)', async () => {
    // Schedule an entry that is already past-due.
    await exp.scheduleExpiry('past-due-path', -1_000, 'should-sweep');

    // Snapshot pre-sweep state.
    const beforeRaw = await readFile(join(tmpdirPath, 'data', 'expirations.json'), 'utf-8');
    const before = JSON.parse(beforeRaw);
    expect(before.find((e: any) => e.path === 'past-due-path')).toBeDefined();

    // Sweep: deletePage returns false (no token), so the path is dropped
    // from the queue without actually contacting Telegraph.
    await exp.sweepExpirations();

    const afterRaw = await readFile(join(tmpdirPath, 'data', 'expirations.json'), 'utf-8');
    const after = JSON.parse(afterRaw);
    expect(after.find((e: any) => e.path === 'past-due-path')).toBeUndefined();

    // Re-running should be a no-op
    await exp.sweepExpirations();
    const afterRaw2 = await readFile(join(tmpdirPath, 'data', 'expirations.json'), 'utf-8');
    expect(JSON.parse(afterRaw2).length).toBe(JSON.parse(afterRaw).length);
  });

  it('keeps not-yet-due entries', async () => {
    await exp.scheduleExpiry('future-path', 60 * 60 * 1000, 'should-keep');
    await exp.sweepExpirations();
    const raw = await readFile(join(tmpdirPath, 'data', 'expirations.json'), 'utf-8');
    const list = JSON.parse(raw);
    expect(list.find((e: any) => e.path === 'future-path')).toBeDefined();
  });
});

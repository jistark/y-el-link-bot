import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpdirPath: string;
let originalCwd: string;
let mc: typeof import('../src/bot/mundial-config.js');

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpdirPath = await mkdtemp(join(tmpdir(), 'jdv-mundial-test-'));
  process.chdir(tmpdirPath);
  mc = await import('../src/bot/mundial-config.js');
  // The module fires loadMundialConfig() at init as a fire-and-forget Promise.
  // Wait for any in-flight load to complete so it can't race with our writes.
  await mc.loadMundialConfig();
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(tmpdirPath, { recursive: true, force: true });
});

describe('saveMundialConfig + getMundialConfig', () => {
  it('persists chatId+topicId to disk and returns them in-memory', async () => {
    await mc.saveMundialConfig(-100, 5);
    expect(mc.getMundialConfig()).toEqual({ chatId: -100, topicId: 5 });

    const raw = await readFile(join(tmpdirPath, 'data', 'mundial-config.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ chatId: -100, topicId: 5 });
  });

  it('overwrites previous config on subsequent saves', async () => {
    await mc.saveMundialConfig(1, 1);
    await mc.saveMundialConfig(2, 22);
    expect(mc.getMundialConfig()).toEqual({ chatId: 2, topicId: 22 });
  });
});

describe('loadMundialConfig — corruption resistance', () => {
  it('returns null when the file does not exist', async () => {
    const dataDir = join(tmpdirPath, 'data');
    await mkdir(dataDir, { recursive: true });
    await rm(join(dataDir, 'mundial-config.json'), { force: true });
    await mc.loadMundialConfig();
    expect(mc.getMundialConfig()).toBeNull();
  });

  it('returns null when the file is invalid JSON', async () => {
    await mkdir(join(tmpdirPath, 'data'), { recursive: true });
    await writeFile(join(tmpdirPath, 'data', 'mundial-config.json'), '{not json', 'utf-8');
    await mc.loadMundialConfig();
    expect(mc.getMundialConfig()).toBeNull();
  });

  it('returns null when the file has the wrong shape (defensive)', async () => {
    await mkdir(join(tmpdirPath, 'data'), { recursive: true });
    await writeFile(
      join(tmpdirPath, 'data', 'mundial-config.json'),
      JSON.stringify({ wrongField: 1 }),
      'utf-8',
    );
    await mc.loadMundialConfig();
    expect(mc.getMundialConfig()).toBeNull();
  });

  it('returns null when fields have wrong types (e.g. chatId as string)', async () => {
    await mkdir(join(tmpdirPath, 'data'), { recursive: true });
    await writeFile(
      join(tmpdirPath, 'data', 'mundial-config.json'),
      JSON.stringify({ chatId: '-100', topicId: 5 }),
      'utf-8',
    );
    await mc.loadMundialConfig();
    expect(mc.getMundialConfig()).toBeNull();
  });

  it('roundtrips a saved config through save → load cycle', async () => {
    await mc.saveMundialConfig(-12345, 99);
    await mc.loadMundialConfig();
    expect(mc.getMundialConfig()).toEqual({ chatId: -12345, topicId: 99 });
  });
});

/**
 * Persistent config for the /mundial notifications feature: which chat +
 * topic the periodic notifier should post into.
 *
 * Stored in data/mundial-config.json so the choice survives Render
 * restarts. Loaded once at module init; written via saveMundialConfig.
 */

import { readFile, writeFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { join } from 'path';

export interface MundialConfig {
  chatId: number;
  topicId: number;
}

// Lazy resolution — see expirations.ts / registry.ts for the rationale.
function dir() { return join(process.cwd(), 'data'); }
function configPath() { return join(dir(), 'mundial-config.json'); }

let current: MundialConfig | null = null;

export function getMundialConfig(): MundialConfig | null {
  return current;
}

export async function loadMundialConfig(): Promise<void> {
  try {
    const data = await readFile(configPath(), 'utf-8');
    const parsed = JSON.parse(data);
    // Defensive: only accept the shape we expect — corrupt files
    // shouldn't poison the in-memory config.
    if (
      parsed && typeof parsed.chatId === 'number' && typeof parsed.topicId === 'number'
    ) {
      current = { chatId: parsed.chatId, topicId: parsed.topicId };
    } else {
      current = null;
    }
  } catch {
    current = null;
  }
}

export async function saveMundialConfig(chatId: number, topicId: number): Promise<void> {
  current = { chatId, topicId };
  try { mkdirSync(dir(), { recursive: true }); } catch { /* ok */ }
  await writeFile(configPath(), JSON.stringify(current), 'utf-8');
}

// Trigger an initial load. Promise is fire-and-forget — callers that
// need the value before this resolves should await loadMundialConfig()
// themselves, but in practice the bot has time before the first poll.
loadMundialConfig();

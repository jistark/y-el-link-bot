/**
 * Persistent registry of processed items, stored as a Telegraph page.
 *
 * Survives Render redeploys (filesystem is ephemeral) by using Telegraph
 * itself as a key-value store: a hidden page titled "__registry__" holds
 * JSON in a <pre> node, editable via the same access_token used for articles.
 *
 * Capacity: last MAX_ENTRIES items (~100), FIFO rotation.
 */

const TELEGRAPH_API = 'https://api.telegra.ph';
const REGISTRY_TITLE = '__registry__';
const MAX_ENTRIES = 100;

export interface RegistryEntry {
  /** Discriminator for the processing pipeline */
  type: 'extractor' | 'rss-senal' | 'rss-adprensa';
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
let pagePath: string | null = null;
let savePromise: Promise<void> | null = null;

function getToken(): string {
  const token = process.env.TELEGRAPH_ACCESS_TOKEN;
  if (!token) throw new Error('TELEGRAPH_ACCESS_TOKEN not set');
  return token;
}

// --- Telegraph page discovery/creation ---

async function findRegistryPage(): Promise<string | null> {
  try {
    const res = await fetch(`${TELEGRAPH_API}/getPageList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: getToken(), limit: 200 }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as any;
    if (!data.ok) return null;

    const page = data.result?.pages?.find((p: any) => p.title === REGISTRY_TITLE);
    return page?.path || null;
  } catch {
    return null;
  }
}

async function createRegistryPage(): Promise<string> {
  const res = await fetch(`${TELEGRAPH_API}/createPage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: getToken(),
      title: REGISTRY_TITLE,
      author_name: 'bot-internal',
      content: [{ tag: 'pre', children: ['[]'] }],
      return_content: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Failed to create registry page: ${data.error}`);

  console.log(JSON.stringify({
    event: 'registry_created',
    path: data.result.path,
    timestamp: new Date().toISOString(),
  }));

  return data.result.path;
}

// --- Load / Save ---

async function loadEntries(): Promise<RegistryEntry[]> {
  if (entriesCache) return entriesCache;

  try {
    // Find or create the registry page
    pagePath = await findRegistryPage();
    if (!pagePath) pagePath = await createRegistryPage();

    const res = await fetch(
      `${TELEGRAPH_API}/getPage/${pagePath}?return_content=true`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const data = await res.json() as any;
    if (!data.ok) { entriesCache = []; return entriesCache; }

    // JSON is stored inside a <pre> node
    const preNode = data.result?.content?.find((n: any) => n.tag === 'pre');
    const raw = typeof preNode?.children?.[0] === 'string' ? preNode.children[0] : '[]';
    entriesCache = JSON.parse(raw);
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'registry_load_error',
      error: err?.message || String(err),
      timestamp: new Date().toISOString(),
    }));
    entriesCache = [];
  }

  return entriesCache!;
}

async function saveEntries(): Promise<void> {
  if (!entriesCache || !pagePath) return;

  try {
    const json = JSON.stringify(entriesCache.slice(-MAX_ENTRIES));
    await fetch(`${TELEGRAPH_API}/editPage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: getToken(),
        path: pagePath,
        title: REGISTRY_TITLE,
        author_name: 'bot-internal',
        content: [{ tag: 'pre', children: [json] }],
        return_content: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'registry_save_error',
      error: err?.message || String(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

// Debounce saves: batch rapid writes into a single Telegraph API call
function scheduleSave(): void {
  if (savePromise) return; // already scheduled
  savePromise = new Promise<void>((resolve) => {
    setTimeout(async () => {
      await saveEntries();
      savePromise = null;
      resolve();
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
  // Search from end (most recent first)
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

import type { Api } from 'grammy';

// --- User agents ---

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

export function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// --- HTML entities ---

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&laquo;': '«',
  '&raquo;': '»',
};

export function decodeEntities(text: string): string {
  let decoded = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    decoded = decoded.replaceAll(entity, char);
  }
  // Numeric entities: &#123; &#8211; etc.
  decoded = decoded.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 10))
  );
  return decoded;
}

// --- Async helpers ---

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function getRetryAfter(err: any): number | null {
  const match = err?.message?.match(/retry after (\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export async function sendWithRetry<T>(fn: () => Promise<T>, label: string, eventPrefix = 'poller'): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const retryAfter = getRetryAfter(err);
    if (retryAfter) {
      console.log(JSON.stringify({
        event: `${eventPrefix}_rate_limited`,
        retryAfter,
        label,
        timestamp: new Date().toISOString(),
      }));
      await sleep((retryAfter + 1) * 1000);
      return await fn();
    }
    throw err;
  }
}

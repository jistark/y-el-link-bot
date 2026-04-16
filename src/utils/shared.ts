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
  // Básicas
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  // Puntuación
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&laquo;': '«',
  '&raquo;': '»',
  '&ldquo;': '\u201C',
  '&rdquo;': '\u201D',
  '&lsquo;': '\u2018',
  '&rsquo;': '\u2019',
  '&bull;': '•',
  '&middot;': '·',
  '&iexcl;': '¡',
  '&iquest;': '¿',
  '&deg;': '°',
  '&ordm;': 'º',
  '&ordf;': 'ª',
  '&trade;': '™',
  '&copy;': '©',
  '&reg;': '®',
  // Monedas
  '&euro;': '€',
  '&pound;': '£',
  '&yen;': '¥',
  '&cent;': '¢',
  // Vocales acentuadas (minúsculas y mayúsculas)
  '&aacute;': 'á', '&Aacute;': 'Á',
  '&eacute;': 'é', '&Eacute;': 'É',
  '&iacute;': 'í', '&Iacute;': 'Í',
  '&oacute;': 'ó', '&Oacute;': 'Ó',
  '&uacute;': 'ú', '&Uacute;': 'Ú',
  '&ntilde;': 'ñ', '&Ntilde;': 'Ñ',
  '&uuml;': 'ü', '&Uuml;': 'Ü',
  // Otros acentos comunes
  '&agrave;': 'à', '&Agrave;': 'À',
  '&egrave;': 'è', '&Egrave;': 'È',
  '&igrave;': 'ì', '&Igrave;': 'Ì',
  '&ograve;': 'ò', '&Ograve;': 'Ò',
  '&ugrave;': 'ù', '&Ugrave;': 'Ù',
  '&acirc;': 'â', '&Acirc;': 'Â',
  '&ecirc;': 'ê', '&Ecirc;': 'Ê',
  '&icirc;': 'î', '&Icirc;': 'Î',
  '&ocirc;': 'ô', '&Ocirc;': 'Ô',
  '&ucirc;': 'û', '&Ucirc;': 'Û',
  '&ccedil;': 'ç', '&Ccedil;': 'Ç',
};

export function decodeEntities(text: string): string {
  let decoded = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    decoded = decoded.replaceAll(entity, char);
  }
  // Numeric entities: &#123; &#x1F4A9; etc.
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  );
  decoded = decoded.replace(/&#(\d+);/g, (_, code) =>
    String.fromCodePoint(parseInt(code, 10))
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

// Delete a Telegram message after a delay, ignoring failures. Intended for
// transient notices (extraction errors, etc.) where the message has no
// long-term value once the user has seen it.
// deleteMessage fires at most once per id, so network errors are swallowed.
export function scheduleDelete(
  api: { deleteMessage: (chatId: number, messageId: number) => Promise<unknown> },
  chatId: number,
  messageId: number,
  afterMs = 10_000,
): void {
  setTimeout(() => {
    api.deleteMessage(chatId, messageId).catch(() => { /* swallow — nothing to do */ });
  }, afterMs);
}

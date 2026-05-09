import { readFileSync } from 'fs';
import { join } from 'path';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT_UA = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const FACEBOOKBOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

// Fallback UA for cookie-strip-only recipes. The bypass-paywalls Chrome
// extension sends the user's real browser UA; we have to synthesize one.
// WSJ's Drudge-referer trick, for example, only honors Chrome-UA + Drudge-referer
// pairs — a missing UA makes Cloudflare drop the request as bot traffic.
const DEFAULT_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface BypassRule {
  useragent?: string;
  useragent_custom?: string;
  referer?: string;
  referer_custom?: string;
  headers_custom?: Record<string, string>;
  allow_cookies?: boolean;
  random_ip?: string;
  /**
   * Hostnames the rule should NOT apply to (upstream `excluded_domains`).
   * E.g., a Dow Jones group rule excludes `journaldemontreal.com` even though
   * it shares ownership. Honored in findRule.
   */
  excluded_domains?: string[];
}

export interface RecipeHeaders {
  headers: Record<string, string>;
  stripCookies: boolean;
}

// Load rules once at module load time
// bypass-rules.json is a static compile-time asset, NOT runtime data.
// It lives at /app/bypass-rules.json in Docker (outside the persistent
// disk mount at /app/data). Locally, fall back to data/ in the repo.
const rulesPath = join(process.cwd(), 'bypass-rules.json');
const fallbackPath = join(process.cwd(), 'data', 'bypass-rules.json');
const allRules: Record<string, BypassRule> = (() => {
  try {
    let raw: string;
    try {
      raw = readFileSync(rulesPath, 'utf-8');
    } catch {
      raw = readFileSync(fallbackPath, 'utf-8');
    }
    const parsed = JSON.parse(raw);
    delete parsed._meta;
    return parsed;
  } catch {
    console.error('Failed to load bypass-rules.json');
    return {};
  }
})();

function ruleApplies(rule: BypassRule | undefined, hostname: string): rule is BypassRule {
  if (!rule) return false;
  if (rule.excluded_domains && rule.excluded_domains.includes(hostname)) return false;
  return true;
}

function findRule(hostname: string): BypassRule | null {
  // Exact match
  if (ruleApplies(allRules[hostname], hostname)) return allRules[hostname];
  // Strip www.
  const noWww = hostname.replace(/^www\./, '');
  if (ruleApplies(allRules[noWww], hostname)) return allRules[noWww];
  // Try every parent domain by peeling subdomains one level at a time.
  // (e.g. news.regional.ft.com -> regional.ft.com -> ft.com).
  // Stop at length 2 to avoid matching naked TLDs like "co.uk".
  const parts = noWww.split('.');
  while (parts.length > 2) {
    parts.shift();
    const candidate = parts.join('.');
    if (ruleApplies(allRules[candidate], hostname)) return allRules[candidate];
  }
  return null;
}

function buildHeaders(rule: BypassRule): RecipeHeaders {
  const headers: Record<string, string> = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // User-Agent
  if (rule.useragent === 'googlebot') {
    headers['User-Agent'] = GOOGLEBOT_UA;
    headers['Referer'] = 'https://www.google.com/';
    headers['X-Forwarded-For'] = '66.249.66.1';
  } else if (rule.useragent === 'bingbot') {
    headers['User-Agent'] = BINGBOT_UA;
  } else if (rule.useragent === 'facebookbot') {
    headers['User-Agent'] = FACEBOOKBOT_UA;
  } else if (rule.useragent_custom) {
    headers['User-Agent'] = rule.useragent_custom;
  } else {
    // Cookie-strip-only recipe: send a real Chrome UA so referer-trick
    // recipes (wsj.com → Drudge Report) and Cloudflare edge checks accept us.
    headers['User-Agent'] = DEFAULT_CHROME_UA;
  }

  // Referer (if not already set by googlebot)
  if (!headers['Referer']) {
    if (rule.referer === 'google') headers['Referer'] = 'https://www.google.com/';
    else if (rule.referer === 'facebook') headers['Referer'] = 'https://www.facebook.com/';
    else if (rule.referer === 'twitter') headers['Referer'] = 'https://t.co/';
    else if (rule.referer_custom) headers['Referer'] = rule.referer_custom;
  }

  // Custom headers
  if (rule.headers_custom) {
    for (const [k, v] of Object.entries(rule.headers_custom)) {
      headers[k] = v;
    }
  }

  // Random IP
  if (rule.random_ip && !headers['X-Forwarded-For']) {
    headers['X-Forwarded-For'] = `${Math.floor(Math.random() * 223 + 1)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  }

  // Strip cookies
  const stripCookies = rule.allow_cookies !== true;

  return { headers, stripCookies };
}

export function getRecipe(url: string): RecipeHeaders | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const rule = findRule(hostname);
  if (!rule) return null;
  return buildHeaders(rule);
}

export function hasRecipe(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return findRule(hostname) !== null;
  } catch {
    return false;
  }
}

import { readFileSync } from 'fs';
import { join } from 'path';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT_UA = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const FACEBOOKBOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

interface BypassRule {
  useragent?: string;
  useragent_custom?: string;
  referer?: string;
  referer_custom?: string;
  headers_custom?: Record<string, string>;
  allow_cookies?: boolean;
  random_ip?: string;
}

export interface RecipeHeaders {
  headers: Record<string, string>;
  stripCookies: boolean;
}

// Load rules once at module load time
const rulesPath = join(import.meta.dir, '../../data/bypass-rules.json');
const allRules: Record<string, BypassRule> = (() => {
  try {
    const raw = readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(raw);
    delete parsed._meta;
    return parsed;
  } catch {
    console.error('Failed to load bypass-rules.json');
    return {};
  }
})();

function findRule(hostname: string): BypassRule | null {
  // Exact match
  if (allRules[hostname]) return allRules[hostname];
  // Strip www.
  const noWww = hostname.replace(/^www\./, '');
  if (allRules[noWww]) return allRules[noWww];
  // Try parent domain (e.g., sub.example.com -> example.com)
  const parts = noWww.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(1).join('.');
    if (allRules[parent]) return allRules[parent];
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

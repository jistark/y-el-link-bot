/**
 * Compile bypass-paywalls-chrome-clean sites.js into a flat JSON lookup.
 *
 * Usage:  bun run scripts/compile-rules.ts /path/to/sites.js
 * Output: data/bypass-rules.json
 *
 * Extracts ONLY server-relevant fields per domain:
 *   useragent, useragent_custom, referer, referer_custom,
 *   headers_custom, allow_cookies, random_ip
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const RELEVANT_KEYS = new Set([
  'useragent',
  'useragent_custom',
  'referer',
  'referer_custom',
  'headers_custom',
  'allow_cookies',
  'random_ip',
]);

interface RawSite {
  domain: string;
  group?: string[];
  useragent?: string;
  useragent_custom?: string;
  referer?: string;
  referer_custom?: string;
  headers_custom?: Record<string, string>;
  allow_cookies?: number | boolean;
  random_ip?: string;
  exception?: RawSite[];
  [key: string]: unknown;
}

interface BypassRule {
  useragent?: string;
  useragent_custom?: string;
  referer?: string;
  referer_custom?: string;
  headers_custom?: Record<string, string>;
  allow_cookies?: boolean;
  random_ip?: string;
}

function extractRule(site: RawSite): BypassRule {
  const rule: BypassRule = {};

  if (site.useragent && typeof site.useragent === 'string') {
    rule.useragent = site.useragent;
  }
  if (site.useragent_custom && typeof site.useragent_custom === 'string') {
    rule.useragent_custom = site.useragent_custom;
  }
  if (site.referer && typeof site.referer === 'string') {
    rule.referer = site.referer;
  }
  if (site.referer_custom && typeof site.referer_custom === 'string') {
    rule.referer_custom = site.referer_custom;
  }
  if (site.headers_custom && typeof site.headers_custom === 'object') {
    rule.headers_custom = site.headers_custom;
  }
  if (site.allow_cookies) {
    rule.allow_cookies = true;
  }
  if (site.random_ip && typeof site.random_ip === 'string') {
    rule.random_ip = site.random_ip;
  }

  return rule;
}

function isPlaceholderDomain(domain: unknown): boolean {
  if (typeof domain !== 'string') return true;
  return domain.startsWith('#') || domain.startsWith('###');
}

function parseSitesJs(source: string): Record<string, RawSite> {
  // Strip the closing code after the object literal (everything after the final `};`)
  // We need to extract just the object between `var defaultSites = {` and the matching `};`
  const startMatch = source.match(/var\s+defaultSites\s*=\s*\{/);
  if (!startMatch || startMatch.index === undefined) {
    throw new Error('Could not find "var defaultSites = {" in source');
  }

  const objStart = startMatch.index + startMatch[0].length - 1; // include the `{`

  // Find the matching closing brace by counting braces
  let depth = 0;
  let objEnd = -1;
  for (let i = objStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        objEnd = i + 1;
        break;
      }
    }
    // Skip strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++; // skip escaped char
        i++;
      }
    }
    // Skip regex literals - look for /.../ but not division or comments
    if (ch === '/' && i > 0) {
      const prev = source.slice(Math.max(0, i - 10), i).trimEnd();
      const lastChar = prev[prev.length - 1];
      // Regex follows: comma, colon, open bracket/paren, operator, keyword end, or line start
      if (lastChar && /[,:(\[=!&|?;{]/.test(lastChar)) {
        // This is a regex literal
        i++;
        while (i < source.length && source[i] !== '/') {
          if (source[i] === '\\') i++; // skip escaped char
          i++;
        }
        // Skip flags
        while (i + 1 < source.length && /[gimsuy]/.test(source[i + 1])) {
          i++;
        }
      }
    }
  }

  if (objEnd === -1) {
    throw new Error('Could not find matching closing brace for defaultSites');
  }

  let objStr = source.slice(objStart, objEnd);

  // Convert to valid JSON-like form that we can eval safely:
  // 1. Remove regex values (replace with null)
  objStr = objStr.replace(/:\s*\/(?:[^/\\]|\\.)*\/[gimsuy]*/g, ': null');

  // 2. Remove trailing commas before } or ]
  objStr = objStr.replace(/,(\s*[}\]])/g, '$1');

  // 3. Wrap unquoted keys in quotes (JS allows unquoted identifiers as keys)
  // Match keys that are NOT already quoted
  objStr = objStr.replace(/(?<=[\{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '"$1"$2');

  // Attempt JSON.parse, fall back to eval with sandboxing
  try {
    return JSON.parse(objStr);
  } catch {
    // JSON parse failed — use Function constructor as a safer eval
    // This handles JS syntax like single-quoted strings, computed expressions, etc.
    // We need a different approach: evaluate the original JS
  }

  // Fallback: evaluate the original JS object with regex values neutralized
  // Re-extract and neutralize more carefully for eval
  let evalStr = source.slice(objStart, objEnd);
  // Replace regex literals with null for eval
  evalStr = evalStr.replace(
    /:\s*\/(?:[^/\\]|\\.)*\/[gimsuy]*/g,
    ': null'
  );

  try {
    const fn = new Function(`return (${evalStr});`);
    return fn() as Record<string, RawSite>;
  } catch (e) {
    throw new Error(`Failed to parse sites object: ${e}`);
  }
}

// --- Main ---

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: bun run scripts/compile-rules.ts /path/to/sites.js');
  process.exit(1);
}

const source = readFileSync(resolve(inputPath), 'utf-8');
const sites = parseSitesJs(source);

const rules: Record<string, BypassRule> = {};
let domainCount = 0;

for (const [_name, site] of Object.entries(sites)) {
  if (!site || typeof site !== 'object') continue;
  if (!site.domain || typeof site.domain !== 'string') continue;

  const baseRule = extractRule(site);

  // Build exception lookup (domain -> overridden rule)
  const exceptions = new Map<string, BypassRule>();
  if (Array.isArray(site.exception)) {
    for (const exc of site.exception) {
      if (exc.domain && !isPlaceholderDomain(exc.domain)) {
        exceptions.set(exc.domain, extractRule(exc));
      }
    }
  }

  // Collect all domains for this entry
  const domains: string[] = [];

  if (!isPlaceholderDomain(site.domain)) {
    domains.push(site.domain);
  }

  if (Array.isArray(site.group)) {
    for (const d of site.group) {
      if (d && !isPlaceholderDomain(d)) {
        domains.push(d);
      }
    }
  }

  // Write a rule per domain
  for (const domain of domains) {
    // Exception overrides the base rule for specific domains
    const rule = exceptions.has(domain)
      ? { ...baseRule, ...exceptions.get(domain)! }
      : baseRule;

    // Only include if the rule has at least one relevant field
    const hasRelevant = Object.keys(rule).length > 0;
    if (hasRelevant) {
      rules[domain] = rule;
    } else {
      // Even domains with no special headers are useful —
      // they indicate "this site is in the bypass list" (allow_cookies: false means strip cookies)
      rules[domain] = {};
    }
    domainCount++;
  }
}

// Add metadata
const output: Record<string, unknown> = {
  _meta: {
    compiled: new Date().toISOString(),
    count: domainCount,
    source: 'bypass-paywalls-chrome-clean sites.js',
  },
  ...rules,
};

const outputPath = resolve(import.meta.dir, '../data/bypass-rules.json');
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

console.log(`Compiled ${domainCount} domain entries to ${outputPath}`);

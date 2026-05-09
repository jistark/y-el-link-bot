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
import { createHash } from 'crypto';

const RELEVANT_KEYS = new Set([
  'useragent',
  'useragent_custom',
  'referer',
  'referer_custom',
  'headers_custom',
  'allow_cookies',
  'random_ip',
  'restrictions',
  'excluded_domains',
  // JSON-LD selector hints from upstream — unused by extractors today, but
  // surfaced so future extractors can opt into upstream's per-site selectors.
  'ld_json',
  'ld_json_next',
  'ld_json_source',
  'ld_json_url',
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
  // `restrictions` is a regex literal upstream — neutralized to `null` by
  // transformObjectLiteral. We never see the original pattern; field exists
  // for type completeness only.
  restrictions?: unknown;
  excluded_domains?: string[];
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
  excluded_domains?: string[];
  // JSON-LD selector hints, lifted as-is from upstream (format: "paywall|article").
  // No extractor consumes these yet; lift is for future-proofing.
  ld_json?: string;
  ld_json_next?: string;
  ld_json_source?: string;
  ld_json_url?: string;
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
  if (Array.isArray(site.excluded_domains)) {
    const list = site.excluded_domains.filter((d): d is string => typeof d === 'string' && d.length > 0);
    if (list.length > 0) rule.excluded_domains = list;
  }
  for (const k of ['ld_json', 'ld_json_next', 'ld_json_source', 'ld_json_url'] as const) {
    const v = site[k];
    if (typeof v === 'string' && v.length > 0) {
      (rule as Record<string, unknown>)[k] = v;
    }
  }

  return rule;
}

function isPlaceholderDomain(domain: unknown): boolean {
  if (typeof domain !== 'string') return true;
  return domain.startsWith('#') || domain.startsWith('###');
}

/**
 * Walk the source from objStart, emitting a JSON-friendly version of the
 * object literal. Single string-aware pass that:
 *   - copies strings verbatim (so `://` inside a URL is preserved),
 *   - replaces regex literals after `:` with `null`,
 *   - drops trailing commas before `}` or `]`,
 *   - quotes unquoted identifier keys.
 *
 * Stops when the matching outer `}` is reached. Returns the transformed
 * substring and its end index in the original source.
 */
function transformObjectLiteral(source: string, objStart: number): { text: string; end: number } {
  let out = '';
  let depth = 0;
  let i = objStart;

  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  while (i < source.length) {
    const c = source[i];

    if (c === '{') {
      depth++;
      out += c;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      out += c;
      i++;
      if (depth === 0) return { text: out, end: i };
      continue;
    }

    // String literals: copy through verbatim, including the closing quote.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        const cc = source[i];
        if (cc === '\\' && i + 1 < source.length) {
          out += cc + source[i + 1];
          i += 2;
          continue;
        }
        out += cc;
        i++;
        if (cc === quote) break;
      }
      continue;
    }

    // Line comment
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += source[i];
        i++;
      }
      continue;
    }

    // Block comment
    if (c === '/' && source[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i];
        i++;
      }
      if (i < source.length) { out += '*/'; i += 2; }
      continue;
    }

    // Regex literal after `:` — replace with `null`. Anchored at `:` so
    // arbitrary slashes inside strings (already handled above) never reach here.
    if (c === ':') {
      let j = i + 1;
      while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
      if (source[j] === '/') {
        let k = j + 1;
        while (k < source.length && source[k] !== '/' && source[k] !== '\n') {
          if (source[k] === '\\' && k + 1 < source.length) k += 2;
          else k++;
        }
        if (source[k] === '/') {
          let f = k + 1;
          while (f < source.length && /[gimsuy]/.test(source[f])) f++;
          out += ': null';
          i = f;
          continue;
        }
      }
    }

    // Trailing comma before `}` or `]` — drop the comma.
    if (c === ',') {
      let j = i + 1;
      while (j < source.length && isWs(source[j])) j++;
      if (source[j] === '}' || source[j] === ']') {
        i++;
        continue;
      }
    }

    // Unquoted identifier key: wrap in double quotes.
    // Trigger only when the previous non-whitespace emitted char is `{` or `,`.
    if (/[a-zA-Z_$]/.test(c)) {
      let lastIdx = out.length - 1;
      while (lastIdx >= 0 && isWs(out[lastIdx])) lastIdx--;
      const last = lastIdx >= 0 ? out[lastIdx] : '';
      if (last === '{' || last === ',') {
        let k = i;
        while (k < source.length && /[a-zA-Z0-9_$]/.test(source[k])) k++;
        let m = k;
        while (m < source.length && isWs(source[m])) m++;
        if (source[m] === ':') {
          out += '"' + source.slice(i, k) + '"';
          i = k;
          continue;
        }
      }
    }

    out += c;
    i++;
  }

  throw new Error('transformObjectLiteral: unterminated object literal');
}

function parseSitesJs(source: string): Record<string, RawSite> {
  const startMatch = source.match(/var\s+defaultSites\s*=\s*\{/);
  if (!startMatch || startMatch.index === undefined) {
    throw new Error('Could not find "var defaultSites = {" in source');
  }
  const objStart = startMatch.index + startMatch[0].length - 1; // include the `{`

  const { text: objStr } = transformObjectLiteral(source, objStart);

  try {
    return JSON.parse(objStr);
  } catch {
    // String-aware transform should produce valid JSON; fall back to JS eval
    // only as a defensive measure for unforeseen quirks.
    try {
      const fn = new Function(`return (${objStr});`);
      return fn() as Record<string, RawSite>;
    } catch (e) {
      throw new Error(`Failed to parse sites object: ${e}`);
    }
  }
}

export { parseSitesJs, extractRule, transformObjectLiteral };
export type { RawSite, BypassRule };

function compile(source: string): { rules: Record<string, BypassRule>; count: number } {
  const sites = parseSitesJs(source);
  const rules: Record<string, BypassRule> = {};
  let domainCount = 0;

  for (const [, site] of Object.entries(sites)) {
    if (!site || typeof site !== 'object') continue;
    if (!site.domain || typeof site.domain !== 'string') continue;

    const baseRule = extractRule(site);
    const exceptions = new Map<string, BypassRule>();
    if (Array.isArray(site.exception)) {
      for (const exc of site.exception) {
        if (exc.domain && !isPlaceholderDomain(exc.domain)) {
          exceptions.set(exc.domain, extractRule(exc));
        }
      }
    }

    const domains: string[] = [];
    if (!isPlaceholderDomain(site.domain)) domains.push(site.domain);
    if (Array.isArray(site.group)) {
      for (const d of site.group) {
        if (d && !isPlaceholderDomain(d)) domains.push(d);
      }
    }

    for (const domain of domains) {
      const rule = exceptions.has(domain)
        ? { ...baseRule, ...exceptions.get(domain)! }
        : baseRule;
      rules[domain] = Object.keys(rule).length > 0 ? rule : {};
      domainCount++;
    }
  }

  return { rules, count: domainCount };
}

function readManifestVersion(sitesJsPath: string): string | undefined {
  try {
    const manifestPath = resolve(sitesJsPath, '..', 'manifest.json');
    const text = readFileSync(manifestPath, 'utf-8');
    const m = text.match(/"version"\s*:\s*"([^"]+)"/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

// Run the CLI when executed directly (skip when imported as a module by tests).
const isMain = (() => {
  try {
    return import.meta.path === resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: bun run scripts/compile-rules.ts /path/to/sites.js');
    process.exit(1);
  }

  const absInputPath = resolve(inputPath);
  const source = readFileSync(absInputPath, 'utf-8');
  const { rules, count } = compile(source);

  const upstreamSha256 = createHash('sha256').update(source).digest('hex');
  const upstreamVersion = readManifestVersion(absInputPath);

  const output: Record<string, unknown> = {
    _meta: {
      compiled: new Date().toISOString(),
      count,
      source: 'bypass-paywalls-chrome-clean sites.js',
      upstream_version: upstreamVersion,
      upstream_sha256: upstreamSha256,
    },
    ...rules,
  };

  const outputPath = resolve(import.meta.dir, '../data/bypass-rules.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

  console.log(`Compiled ${count} domain entries to ${outputPath}`);
  if (upstreamVersion) console.log(`  upstream version: ${upstreamVersion}`);
  console.log(`  upstream sha256: ${upstreamSha256}`);
}

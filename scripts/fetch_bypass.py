#!/usr/bin/env python3
"""
Fetch URLs bypassing Cloudflare/Vercel bot detection via TLS impersonation.
Called from TypeScript extractors when direct fetch fails.

Usage: python3 fetch_bypass.py <url> [referer] [mode]
  mode: "chrome" (default) — Chrome TLS impersonation; routes through
        IPRoyal Web Unblocker for known-blocked domains when PROXY_URL is set.
        "googlebot" — Googlebot UA + X-Forwarded-For (for Arc XP paywalls)
        "inspectiontool" — Google-InspectionTool UA (for NYT)
Output: HTML to stdout, errors to stderr, exit code 0 on success.
"""
import os
import re
import sys
import time
import json
from urllib.parse import urlparse
from curl_cffi import requests

# Web Unblocker MITM-terminates SSL; the cert it presents won't validate.
# Suppress the warning (verify=False is set only on requests routed through it).
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    pass

# IPRoyal Web Unblocker URL — http://USER:PASS@unblocker.iproyal.com:12323
# The password may include baked-in params like _country-us (from IPRoyal dashboard).
# build_proxy_url() strips them before appending per-request params.
PROXY_URL = os.environ.get('PROXY_URL')

# Regex matching known IPRoyal parameter suffixes in the password segment.
# Used to strip baked-in params before rebuilding per-request.
_IPROYAL_PARAM_RE = re.compile(r'_(?:render-\d+|country-[a-z]{2}|city-[\w-]+|state-[\w-]+)')

# Domains that can't be fetched from datacenter IPs (Cloudflare/Vercel bot
# protection). Override with PROXY_DOMAINS env var (comma-separated).
DEFAULT_PROXY_DOMAINS = [
    'ft.com', 'bloomberg.com', 'nytimes.com', 'theatlantic.com',
    'wired.com', 'dolar.cl', 'reuters.com',
    # Added 2026-05-09 based on prod failure logs (May 1-9):
    'elpais.com',           # 403 from datacenter on Googlebot UA
    'haaretz.com',          # paywall expects mobile-app headers from non-DC IPs
    # NOTE: washingtonpost.com / wsj.com / marketwatch.com originally added
    # here but verified to work via direct (datacenter + recipe headers).
    # Routing them through residential proxy actually hurts: the residential
    # exit IP triggers tighter scrutiny than Googlebot UA from datacenter.
]
PROXY_DOMAINS = (
    [d.strip() for d in os.environ['PROXY_DOMAINS'].split(',') if d.strip()]
    if os.environ.get('PROXY_DOMAINS') else DEFAULT_PROXY_DOMAINS
)

# Domains needing JS rendering (Chromium spin-up — slower, more billable units).
# dolar.cl requires it: Vercel Security Checkpoint is a JS challenge that
# can't be bypassed with header-only proxying.
DEFAULT_JS_DOMAINS = ['dolar.cl', 'reuters.com']
JS_DOMAINS = (
    [d.strip() for d in os.environ['PROXY_JS_DOMAINS'].split(',') if d.strip()]
    if os.environ.get('PROXY_JS_DOMAINS') else DEFAULT_JS_DOMAINS
)

# Per-domain country routing. dolar.cl is a Chilean finance site that may
# geo-filter or rate-limit foreign IPs harder than local ones.
DOMAIN_COUNTRY: dict[str, str] = {
    'dolar.cl': 'cl',
}

# Full browser-like headers to pass datacenter IP reputation checks
BROWSER_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
}

# Minimal headers for proxy + JS rendering. When Chromium renders the page,
# it generates its own Sec-*, Referer, Accept, and User-Agent headers;
# IPRoyal strips ours anyway (documented behavior). Only pass what survives.
PROXY_RENDER_HEADERS = {
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Upgrade-Insecure-Requests': '1',
}


def needs_proxy(url):
    domain = (urlparse(url).hostname or '').lower()
    return any(domain == d or domain.endswith('.' + d) for d in PROXY_DOMAINS)


def needs_js(url):
    if not JS_DOMAINS:
        return False
    domain = (urlparse(url).hostname or '').lower()
    return any(domain == d or domain.endswith('.' + d) for d in JS_DOMAINS)


def get_country(url):
    """Return the country code for a domain, or None."""
    domain = (urlparse(url).hostname or '').lower()
    for d, cc in DOMAIN_COUNTRY.items():
        if domain == d or domain.endswith('.' + d):
            return cc
    return None


def build_proxy_url(render=False, country=None):
    """Build proxy URL with optional render and country suffixes.

    Strips any IPRoyal params already baked into the PROXY_URL password
    (e.g. _country-us from the dashboard) before appending per-request ones.

    PASS_country-us + country='cl' → PASS_country-cl  (no duplicates)
    """
    if not PROXY_URL:
        return None
    try:
        scheme, rest = PROXY_URL.split('://', 1)
        auth, host = rest.rsplit('@', 1)
        user, pwd = auth.split(':', 1)
        base_pwd = _IPROYAL_PARAM_RE.sub('', pwd)
        suffix = ''
        if render:
            suffix += '_render-1'
        if country:
            suffix += f'_country-{country}'
        return f"{scheme}://{user}:{base_pwd}{suffix}@{host}"
    except ValueError:
        return PROXY_URL


def log_proxy(domain, bytes_used, status, render=False, country=None):
    """Structured log line for cost auditing via Render logs."""
    entry = {
        'event': 'proxy_use',
        'domain': domain,
        'bytes': bytes_used,
        'status': status,
        'render': render,
    }
    if country:
        entry['country'] = country
    print(json.dumps(entry), file=sys.stderr)


def fetch_direct(url, headers, use_proxy=False, render=False, country=None):
    """Fetch URL with TLS impersonation; route through Web Unblocker if requested."""
    proxies = None
    timeout = 20
    verify = True
    if use_proxy and PROXY_URL:
        purl = build_proxy_url(render=render, country=country)
        proxies = {"http": purl, "https": purl}
        timeout = 60 if render else 30  # residential adds latency; rendering more
        verify = False                  # Web Unblocker terminates TLS via MITM
    try:
        r = requests.get(
            url,
            impersonate='chrome',
            headers=headers,
            proxies=proxies,
            timeout=timeout,
            allow_redirects=True,
            verify=verify,
        )
    except Exception as e:
        if proxies:
            print(f"proxy_error: {e}", file=sys.stderr)
        return None, None
    if proxies:
        log_proxy(urlparse(url).hostname or '', len(r.content), r.status_code, render, country)
    if r.status_code >= 400:
        return None, r.status_code
    return r.content, r.status_code


def fetch_webcache(url, headers):
    """Fallback: fetch via Google Webcache."""
    cache_url = f'https://webcache.googleusercontent.com/search?q=cache:{url}'
    h = dict(headers)
    h.pop('Referer', None)
    h['Sec-Fetch-Site'] = 'none'
    r = requests.get(cache_url, impersonate='chrome', headers=h, timeout=20, allow_redirects=True)
    if r.status_code >= 400:
        return None, r.status_code
    # Webcache wraps content but preserves JSON-LD, __NEXT_DATA__, etc.
    return r.content, r.status_code


GOOGLEBOT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.google.com/',
    'X-Forwarded-For': '66.249.66.1',
}

INSPECTIONTOOL_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.google.com/',
    'X-Forwarded-For': '66.249.66.1',
}


def _load_extra_headers():
    """Recipe headers passed from TS via env. JSON object; empty if absent."""
    raw = os.environ.get('EXTRA_HEADERS')
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch_bypass.py <url> [referer] [mode]", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    referer = sys.argv[2] if len(sys.argv) > 2 else None
    mode = sys.argv[3] if len(sys.argv) > 3 else 'chrome'
    extra_headers = _load_extra_headers()

    if mode == 'googlebot' or mode == 'inspectiontool':
        headers = dict(GOOGLEBOT_HEADERS if mode == 'googlebot' else INSPECTIONTOOL_HEADERS)
        if referer:
            headers['Referer'] = referer
        # Recipe headers (e.g., headers_custom from haaretz) override mode defaults.
        headers.update(extra_headers)
        # Bot UAs can also be IP-blocked at datacenter; route through proxy if
        # the domain is in PROXY_DOMAINS (e.g., elpais.com returns 403 to
        # Googlebot from datacenter IPs but accepts via residential proxy).
        use_proxy = bool(PROXY_URL) and needs_proxy(url)
        country = get_country(url) if use_proxy else None
        if use_proxy:
            content, status = fetch_direct(url, headers, use_proxy=True, country=country)
            if content is not None:
                sys.stdout.buffer.write(content)
                return
            # Proxy failed (timeout, 403, etc.) — fall through to direct.
        content, status = fetch_direct(url, headers, use_proxy=False)
        if content is not None:
            sys.stdout.buffer.write(content)
            return
        print(f"HTTP {status}", file=sys.stderr)
        sys.exit(1)

    # Default: chrome mode
    use_proxy = bool(PROXY_URL) and needs_proxy(url)
    render = needs_js(url)
    country = get_country(url) if use_proxy else None

    # When proxy renders in Chromium, it generates its own browser headers;
    # ours get stripped. Use minimal set to avoid noise.
    if use_proxy and render:
        headers = dict(PROXY_RENDER_HEADERS)
    else:
        headers = dict(BROWSER_HEADERS)
        if referer:
            headers['Referer'] = referer
            headers['Sec-Fetch-Site'] = 'cross-site'

    # Recipe headers always take precedence — they're the site-specific
    # bypass strategy from upstream rules (mobile UA, custom auth, etc.).
    headers.update(extra_headers)

    if use_proxy:
        # Web Unblocker first — direct fetch from Render IP would fail anyway.
        content, status = fetch_direct(url, headers, use_proxy=True, render=render, country=country)
        if content is not None:
            sys.stdout.buffer.write(content)
            return
        if status == 407:
            print("proxy_auth_failed: check PROXY_URL credentials", file=sys.stderr)
        # Fall through: try direct as last-ditch then webcache.

    # Direct strategy (also runs as fallback after proxy attempt)
    for attempt in range(2):
        content, status = fetch_direct(url, headers, use_proxy=False)
        if content is not None:
            sys.stdout.buffer.write(content)
            return
        if attempt == 0 and status in (403, 429):
            time.sleep(2)

    # Last resort: Google Webcache
    content, status = fetch_webcache(url, headers)
    if content is not None:
        sys.stdout.buffer.write(content)
        return

    print(f"HTTP {status}", file=sys.stderr)
    sys.exit(1)


if __name__ == '__main__':
    main()

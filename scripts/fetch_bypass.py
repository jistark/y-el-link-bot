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

# IPRoyal Web Unblocker URL — http://USER:PASS_country-us@unblocker.iproyal.com:12323
PROXY_URL = os.environ.get('PROXY_URL')

# Domains that can't be fetched from datacenter IPs (Cloudflare/Vercel bot
# protection). Override with PROXY_DOMAINS env var (comma-separated).
DEFAULT_PROXY_DOMAINS = [
    'ft.com', 'bloomberg.com', 'nytimes.com', 'theatlantic.com',
    'washingtonpost.com', 'wired.com',
]
PROXY_DOMAINS = (
    [d.strip() for d in os.environ['PROXY_DOMAINS'].split(',') if d.strip()]
    if os.environ.get('PROXY_DOMAINS') else DEFAULT_PROXY_DOMAINS
)

# Domains needing JS rendering (Chromium spin-up — slower, more billable units).
# Empty by default; opt-in via PROXY_JS_DOMAINS env var.
JS_DOMAINS = [
    d.strip() for d in os.environ.get('PROXY_JS_DOMAINS', '').split(',')
    if d.strip()
]

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


def needs_proxy(url):
    domain = (urlparse(url).hostname or '').lower()
    return any(domain == d or domain.endswith('.' + d) for d in PROXY_DOMAINS)


def needs_js(url):
    if not JS_DOMAINS:
        return False
    domain = (urlparse(url).hostname or '').lower()
    return any(domain == d or domain.endswith('.' + d) for d in JS_DOMAINS)


def proxy_url_with_render():
    """Append _render-1 to the password segment of PROXY_URL for JS rendering.

    http://USER:PASS@host:port  →  http://USER:PASS_render-1@host:port
    """
    if not PROXY_URL:
        return None
    try:
        scheme, rest = PROXY_URL.split('://', 1)
        auth, host = rest.rsplit('@', 1)
        user, pwd = auth.split(':', 1)
        return f"{scheme}://{user}:{pwd}_render-1@{host}"
    except ValueError:
        return PROXY_URL  # malformed — let the request fail naturally


def log_proxy(domain, bytes_used, status, render=False):
    """Structured log line for cost auditing via Render logs."""
    print(json.dumps({
        'event': 'proxy_use',
        'domain': domain,
        'bytes': bytes_used,
        'status': status,
        'render': render,
    }), file=sys.stderr)


def fetch_direct(url, headers, use_proxy=False, render=False):
    """Fetch URL with TLS impersonation; route through Web Unblocker if requested."""
    proxies = None
    timeout = 20
    verify = True
    if use_proxy and PROXY_URL:
        purl = proxy_url_with_render() if render else PROXY_URL
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
        log_proxy(urlparse(url).hostname or '', len(r.content), r.status_code, render)
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


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch_bypass.py <url> [referer] [mode]", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    referer = sys.argv[2] if len(sys.argv) > 2 else None
    mode = sys.argv[3] if len(sys.argv) > 3 else 'chrome'

    if mode == 'googlebot':
        headers = dict(GOOGLEBOT_HEADERS)
        if referer:
            headers['Referer'] = referer
        content, status = fetch_direct(url, headers)
        if content is not None:
            sys.stdout.buffer.write(content)
            return
        print(f"HTTP {status}", file=sys.stderr)
        sys.exit(1)

    if mode == 'inspectiontool':
        headers = dict(INSPECTIONTOOL_HEADERS)
        if referer:
            headers['Referer'] = referer
        content, status = fetch_direct(url, headers)
        if content is not None:
            sys.stdout.buffer.write(content)
            return
        print(f"HTTP {status}", file=sys.stderr)
        sys.exit(1)

    # Default: chrome mode
    headers = dict(BROWSER_HEADERS)
    if referer:
        headers['Referer'] = referer
        headers['Sec-Fetch-Site'] = 'cross-site'

    use_proxy = bool(PROXY_URL) and needs_proxy(url)
    render = needs_js(url)

    if use_proxy:
        # Web Unblocker first — direct fetch from Render IP would fail anyway.
        content, status = fetch_direct(url, headers, use_proxy=True, render=render)
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

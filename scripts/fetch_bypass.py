#!/usr/bin/env python3
"""
Fetch URLs bypassing Cloudflare/Vercel bot detection via TLS impersonation.
Called from TypeScript extractors when direct fetch fails.

Usage: python3 fetch_bypass.py <url> [referer] [mode]
  mode: "chrome" (default) — Chrome TLS impersonation
        "googlebot" — Googlebot UA + X-Forwarded-For (for Arc XP paywalls)
        "inspectiontool" — Google-InspectionTool UA (for NYT)
Output: HTML to stdout, errors to stderr, exit code 0 on success.
"""
import sys
import time
from curl_cffi import requests

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

def fetch_direct(url, headers):
    """Try fetching URL directly with TLS impersonation."""
    r = requests.get(url, impersonate='chrome', headers=headers, timeout=20, allow_redirects=True)
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

    # Strategy 1: Direct fetch with TLS impersonation (try twice with backoff)
    for attempt in range(2):
        content, status = fetch_direct(url, headers)
        if content is not None:
            sys.stdout.buffer.write(content)
            return
        if attempt == 0 and status in (403, 429):
            time.sleep(2)

    # Strategy 2: Google Webcache fallback
    content, status = fetch_webcache(url, headers)
    if content is not None:
        sys.stdout.buffer.write(content)
        return

    print(f"HTTP {status}", file=sys.stderr)
    sys.exit(1)

if __name__ == '__main__':
    main()

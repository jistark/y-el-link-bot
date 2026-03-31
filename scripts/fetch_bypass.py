#!/usr/bin/env python3
"""
Fetch URLs bypassing Cloudflare/Vercel bot detection via TLS impersonation.
Called from TypeScript extractors when direct fetch fails.

Usage: python3 fetch_bypass.py <url> [referer]
Output: HTML to stdout, errors to stderr, exit code 0 on success.
"""
import sys
from curl_cffi import requests

def main():
    if len(sys.argv) < 2:
        print("Usage: fetch_bypass.py <url> [referer]", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    referer = sys.argv[2] if len(sys.argv) > 2 else None

    headers = {}
    if referer:
        headers['Referer'] = referer

    r = requests.get(
        url,
        impersonate='chrome',
        headers=headers,
        timeout=20,
        allow_redirects=True,
    )

    if r.status_code >= 400:
        print(f"HTTP {r.status_code}", file=sys.stderr)
        sys.exit(1)

    sys.stdout.buffer.write(r.content)

if __name__ == '__main__':
    main()

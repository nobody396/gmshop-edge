#!/usr/bin/env python3
"""Daily App Store price scraper for /guides/appstore-prices.

Cloudflare Workers get HTTP 429 from apps.apple.com, so this runs on a normal
server (agent-shop host, root cron) and posts raw listings to
POST /api/ops/appstore-prices. All parsing of prices, tier mapping and the
"keep yesterday's value when a page fails" rule live in the Worker
(src/features/appstore-prices/snapshot.ts); this script only reads pages.

Usage:
  scrape.py --dry-run                 # print the payload, post nothing
  scrape.py --token-file /path/token  # post (token = APPSTORE_PRICES_TOKEN)

Production install (agent-shop host, ssh laoshirenvip-agent-root):
  /opt/appstore-prices/scrape.py, token in /opt/appstore-prices/token (root, 0600;
  same value as Fusebox GMSHOP_APPSTORE_PRICES_TOKEN and the Worker secret
  APPSTORE_PRICES_TOKEN), /etc/cron.d/appstore-prices runs it daily at
  00:20 UTC = 08:20 Beijing, log /var/log/appstore-prices.log.

Standard library only. Never prints the token.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Safari/605.1.15"
)
APPS = {
    "chatgpt": ("chatgpt", 6448311069),
    "claude": ("claude-by-anthropic", 6473753684),
    "gemini": ("google-gemini", 6477489729),
}
REGIONS = ["us", "jp", "ph", "tr"]
OTR_PAGES = {
    "chatgpt": "https://opentherank.com/ai-pricing/chatgpt/",
    "claude": "https://opentherank.com/ai-pricing/claude/",
    "gemini": "https://opentherank.com/ai-pricing/gemini/",
}
RATES_URL = "https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD,JPY,PHP,TRY"
DEFAULT_ENDPOINT = "https://laoshirenvip.com/api/ops/appstore-prices"


def get(url: str, attempts: int = 3) -> str:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
            )
            with urllib.request.urlopen(request, timeout=40) as response:
                return response.read().decode("utf-8", "ignore")
        except Exception as error:  # noqa: BLE001 - retried, then reported
            last = error
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def apple_items(page: str) -> list[dict[str, str]] | None:
    """In-App Purchases (name, price) pairs; None when the section is missing."""
    start = page.find("In-App Purchases</dt>")
    if start >= 0:
        end = page.find("</details>", start)
        block = page[start : end if end > 0 else start + 20000]
        pairs = re.findall(
            r'class="text-pair[^"]*"[^>]*>\s*<span[^>]*>(.*?)</span>\s*<span[^>]*>(.*?)</span>',
            block,
            re.S,
        )
        if pairs:
            return [{"name": text(n), "price": text(p)} for n, p in pairs]
    # Fallback: the embedded page JSON.
    marker = re.search(r'"In-App Purchases","summary":"Yes","items":\[', page)
    if marker:
        block = page[marker.end() : marker.end() + 20000]
        pairs = re.findall(
            r'"leadingText":"((?:[^"\\]|\\.)*)","trailingText":"((?:[^"\\]|\\.)*)"', block
        )
        if pairs:
            return [
                {"name": json.loads(f'"{n}"'), "price": json.loads(f'"{p}"')}
                for n, p in pairs
            ]
    return None  # Layout changed or blocked: the Worker keeps old values.


def scrape_apple() -> list[dict]:
    out = []
    for app, (slug, app_id) in APPS.items():
        for region in REGIONS:
            url = f"https://apps.apple.com/{region}/app/{slug}/id{app_id}?l=en-US"
            try:
                items = apple_items(get(url))
                ok = items is not None
            except RuntimeError as error:
                print(f"apple {app}/{region} failed: {error}", file=sys.stderr)
                items, ok = None, False
            out.append({"app": app, "region": region, "ok": ok, "items": items or []})
            time.sleep(1.5)
    return out


def otr_regions(page: str) -> dict[str, dict[str, str]]:
    """App Store table: region → plan id → local price text."""
    plans_attr = re.search(r'data-vs-plans="([^"]*)"', page)
    if not plans_attr:
        return {}
    plans = [p["id"] for p in json.loads(html.unescape(plans_attr.group(1)))]
    result: dict[str, dict[str, str]] = {}
    for match in re.finditer(r'<tr ([^>]*data-cc="([A-Z]{2})"[^>]*)>(.*?)</tr>', page, re.S):
        attrs, cc, row = match.groups()
        region = cc.lower()
        if region not in REGIONS or region in result:
            continue
        prices = re.search(r'data-vs-prices="([^"]*)"', attrs)
        # Google Play rows ("play:…") come after the App Store table.
        if not prices or prices.group(1).startswith("play:"):
            continue
        cells = [
            c
            for c in re.findall(r'<td class="ctl-td"[^>]*>(.*?)</td>', row, re.S)
            if "ctl-delta" not in c
        ]
        values: dict[str, str] = {}
        for plan, cell in zip(plans, cells):
            local = re.search(r'class="ctl-local[^"]*"[^>]*>([^<]*)<', cell)
            if local and re.search(r"\d", local.group(1)):
                values[plan] = text(local.group(1))
        result[region] = values
    return result


def scrape_otr() -> list[dict]:
    out = []
    for app, url in OTR_PAGES.items():
        try:
            regions = otr_regions(get(url))
            out.append({"app": app, "ok": bool(regions), "regions": regions})
        except RuntimeError as error:
            print(f"opentherank {app} failed: {error}", file=sys.stderr)
            out.append({"app": app, "ok": False, "regions": {}})
    return out


def scrape_rates() -> dict | None:
    try:
        data = json.loads(get(RATES_URL))
        return {"base": data["base"], "date": data["date"], "rates": data["rates"]}
    except Exception as error:  # noqa: BLE001
        print(f"rates failed: {error}", file=sys.stderr)
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--token-file")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    args = parser.parse_args()

    payload = {
        "fetchedAt": int(time.time() * 1000),
        "rates": scrape_rates(),
        "apple": scrape_apple(),
        "opentherank": scrape_otr(),
    }
    apple_ok = sum(1 for page in payload["apple"] if page["ok"])
    otr_ok = sum(1 for page in payload["opentherank"] if page["ok"])
    print(
        f"apple pages ok {apple_ok}/{len(payload['apple'])}, "
        f"opentherank ok {otr_ok}/{len(payload['opentherank'])}, "
        f"rates {payload['rates']['date'] if payload['rates'] else 'FAILED'}",
        file=sys.stderr,
    )
    if args.dry_run:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=1)
        print()
        return 0
    if not args.token_file:
        print("--token-file is required to post", file=sys.stderr)
        return 2
    with open(args.token_file, encoding="utf-8") as handle:
        token = handle.read().strip()
    request = urllib.request.Request(
        args.endpoint,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "appstore-prices-scraper/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            print(response.status, response.read().decode()[:300])
            return 0
    except urllib.error.HTTPError as error:
        print(error.code, error.read().decode()[:300], file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

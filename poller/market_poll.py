#!/usr/bin/env python3
"""Poll market data from Yahoo Finance and write a stats JSON feed for the Display web app.

No API key needed. Every symbol fetch is wrapped so one failing symbol
never kills the feed; the feed is only written if a majority of symbols parse.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# (feed key, yahoo symbol, label, divisor)
SYMBOLS = [
    ("spx", "^GSPC", "S&P 500", 1),
    ("ndx", "^NDX", "Nasdaq 100", 1),
    ("dji", "^DJI", "Dow", 1),
    ("es", "ES=F", "S&P Futures", 1),
    ("vix", "^VIX", "VIX", 1),
    ("t10y", "^TNX", "10-Yr Yield", 1),  # quoted directly in percent (4.94 = 4.94%)
]


def eprint(*a):
    print(*a, file=sys.stderr)


def fetch_chart(sym):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(sym, safe="") + "?interval=1d&range=1mo")
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def parse(sym, divisor):
    data = fetch_chart(sym)
    chart = data.get("chart") or {}
    results = chart.get("result") or []
    if not results:
        raise ValueError(f"no result: {chart.get('error')}")
    r0 = results[0]
    meta = r0.get("meta") or {}
    price = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose", meta.get("previousClose"))
    quote = ((r0.get("indicators") or {}).get("quote") or [{}])[0]
    closes = [c / divisor for c in (quote.get("close") or [])
              if isinstance(c, (int, float))]
    if price is None or prev is None:
        raise ValueError("missing price/previous close")
    price, prev = price / divisor, prev / divisor
    as_of = meta.get("regularMarketTime") or 0
    return {
        "price": round(price, 2),
        "change": round(price - prev, 2),
        "change_pct": round((price - prev) / prev * 100, 2),
        "as_of": (datetime.fromtimestamp(as_of, timezone.utc).isoformat()
                  if as_of else None),
        "history": [round(c, 2) for c in closes[-30:]],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="path to write latest.json")
    args = ap.parse_args()

    feed = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "symbols": {},
    }
    ok = 0
    for key, sym, label, divisor in SYMBOLS:
        try:
            d = parse(sym, divisor)
            d["label"] = label
            feed["symbols"][key] = d
            ok += 1
            eprint(f"ok: {label} {d['price']} ({d['change_pct']:+.2f}%)")
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the feed
            eprint(f"warn: {sym} failed: {exc}")
            feed["symbols"][key] = {"label": label, "price": None}
        time.sleep(1)  # be gentle with the quote API

    if ok < 4:
        raise SystemExit(f"only {ok}/6 symbols parsed; refusing to write feed")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(feed, fh)
    os.replace(tmp, args.out)
    eprint(f"wrote {args.out}")


if __name__ == "__main__":
    main()

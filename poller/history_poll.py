#!/usr/bin/env python3
"""Fetch 30-day daily history per watchlist ticker from Yahoo Finance.

Runs on a slow schedule (daily) — history only gains one point per day.
Writes docs/feed/history/<TICKER>.json, which the app loads on demand
when a ticker is opened. Never fails the run over a few bad tickers.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from market_poll import (  # noqa: E402  (same dir)
    UA, YAHOO_OVERRIDES, eprint, fetch_chart, load_watchlist,
)

HISTORY_DIR_ARG = "--history-dir"


def history_for(ticker):
    sym = YAHOO_OVERRIDES.get(ticker, ticker)
    data = fetch_chart(sym)
    results = (data.get("chart") or {}).get("result") or []
    if not results:
        raise ValueError("no result")
    quote = ((results[0].get("indicators") or {}).get("quote") or [{}])[0]
    closes = [c for c in (quote.get("close") or [])
              if isinstance(c, (int, float))]
    if len(closes) < 5:
        raise ValueError("too few closes")
    return [round(c, 2) for c in closes[-30:]]


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument(HISTORY_DIR_ARG, required=True,
                    help="dir to write <TICKER>.json files")
    args = ap.parse_args()
    outdir = args.history_dir
    os.makedirs(outdir, exist_ok=True)

    tickers = load_watchlist()
    ok, failed = 0, []
    for t in tickers:
        try:
            h = history_for(t)
            tmp = os.path.join(outdir, t + ".json.tmp")
            with open(tmp, "w") as fh:
                json.dump({"s": t, "h": h,
                           "generated_at": datetime.now(timezone.utc).isoformat()}, fh)
            os.replace(tmp, os.path.join(outdir, t + ".json"))
            ok += 1
        except Exception as exc:  # noqa: BLE001 - one bad ticker must not stop the run
            failed.append(t)
            eprint(f"warn: {t} history failed: {exc}")
        time.sleep(1)  # be gentle with the quote API
    eprint(f"history: {ok}/{len(tickers)} written to {outdir}")
    if failed:
        eprint("failed: " + ", ".join(failed))


if __name__ == "__main__":
    main()

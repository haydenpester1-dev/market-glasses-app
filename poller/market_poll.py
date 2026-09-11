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

# (feed key, yahoo symbol, label, kind, divisor) — also lives in
# docs/symbols.json, which is the file to edit when adding tickers.
SYMBOLS_JSON = os.path.join(os.path.dirname(__file__), "..", "docs", "symbols.json")

# Watchlist tickers (one per line, vendored from the Slack monitor list).
WATCHLIST_TXT = os.path.join(os.path.dirname(__file__), "..", "watchlist.txt")

# tickers whose Yahoo symbol differs from the watchlist spelling.
YAHOO_OVERRIDES = {
    "BRK.A": "BRK-A",
    "BRK.B": "BRK-B",
    "FWON.K": "FWONK",
    "NOVO B": "NOVO-B.CO",
    "RR.": "RR.L",
    "RHM": "RHM.DE",
    "ADYEN": "ADYEN.AS",
}


def load_watchlist():
    with open(WATCHLIST_TXT) as fh:
        return [l.strip() for l in fh if l.strip()]


def fetch_cnbc(symbols):
    q = ("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
         "?symbols=" + urllib.parse.quote("|".join(symbols), safe="")
         + "&symbolTypeCodes=STOCK&requestMethod=quick&noform=1&partnerId=2"
           "&fund=1&exthrs=1&output=json")
    req = urllib.request.Request(
        q, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        d = json.load(resp)
    return (d.get("FormattedQuoteResult") or {}).get("FormattedQuote") or []


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").replace("%", "").strip().lstrip("+")
    try:
        return float(s)
    except ValueError:
        return None


def yahoo_quote(ticker):
    """Fallback single-ticker quote via Yahoo v8 (used for CNBC misses)."""
    sym = YAHOO_OVERRIDES.get(ticker, ticker)
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(sym, safe="") + "?interval=1d&range=5d")
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    r0 = (data.get("chart") or {}).get("result", [{}])[0]
    meta = r0.get("meta") or {}
    price = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose", meta.get("previousClose"))
    if price is None or prev is None:
        raise ValueError("missing price")
    return {
        "s": ticker,
        "n": meta.get("longName") or meta.get("shortName") or ticker,
        "p": round(price, 2),
        "c": round(price - prev, 2),
        "cp": round((price - prev) / prev * 100, 2),
    }


def poll_watchlist():
    tickers = load_watchlist()
    quotes = {}
    for row in fetch_cnbc(tickers):
        p, cp = num(row.get("last")), num(row.get("change_pct"))
        if p is None or cp is None:
            continue
        quotes[row["symbol"]] = {
            "s": row["symbol"],
            "n": row.get("shortName") or row.get("name") or row["symbol"],
            "p": p,
            "c": num(row.get("change")) or 0.0,
            "cp": cp,
        }
    missing = [t for t in tickers if t not in quotes]
    for t in missing:
        try:
            quotes[t] = yahoo_quote(t)
            eprint(f"watchlist fallback ok: {t}")
        except Exception as exc:  # noqa: BLE001
            eprint(f"watchlist warn: {t} failed: {exc}")
        time.sleep(1)
    ordered = [quotes[t] for t in tickers if t in quotes]
    eprint(f"watchlist: {len(ordered)}/{len(tickers)} quotes")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "quotes": ordered,
    }


def load_symbols():
    with open(SYMBOLS_JSON) as fh:
        return json.load(fh)


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
    ap.add_argument("--watchlist-out", required=True,
                    help="path to write watchlist.json")
    args = ap.parse_args()

    feed = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "symbols": {},
    }
    symbols = load_symbols()
    ok = 0
    for entry in symbols:
        key, sym = entry["key"], entry["symbol"]
        label, kind = entry.get("label", key.upper()), entry.get("kind", "index")
        divisor = entry.get("divisor", 1)
        try:
            d = parse(sym, divisor)
            d["label"] = label
            d["kind"] = kind
            feed["symbols"][key] = d
            ok += 1
            eprint(f"ok: {label} {d['price']} ({d['change_pct']:+.2f}%)")
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the feed
            eprint(f"warn: {sym} failed: {exc}")
            feed["symbols"][key] = {"label": label, "kind": kind, "price": None}
        time.sleep(1)  # be gentle with the quote API

    if ok < max(1, len(symbols) // 2):
        raise SystemExit(f"only {ok}/{len(symbols)} symbols parsed; refusing to write feed")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(feed, fh)
    os.replace(tmp, args.out)
    eprint(f"wrote {args.out}")

    wl = poll_watchlist()
    if len(wl["quotes"]) < max(1, int(0.8 * len(load_watchlist()))):
        raise SystemExit("watchlist coverage too low; refusing to write feed")
    os.makedirs(os.path.dirname(args.watchlist_out), exist_ok=True)
    tmp = args.watchlist_out + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(wl, fh)
    os.replace(tmp, args.watchlist_out)
    eprint(f"wrote {args.watchlist_out}")


if __name__ == "__main__":
    main()

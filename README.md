# Market Overview — Meta Ray-Ban Display web app

Glanceable market dashboard for Meta Ray-Ban Display glasses (600×600):
S&P 500, Nasdaq 100, Dow, S&P futures, VIX, and the 10-year Treasury yield,
each with day change and a 30-day sparkline.

Live: https://haydenpester1-dev.github.io/market-glasses-app/

## How it works

- `poller/market_poll.py` fetches quotes + 30-day history from Yahoo Finance
  (no API key) and writes `docs/feed/latest.json`.
- `.github/workflows/poll.yml` runs the poller every 15 minutes and deploys
  `docs/` to GitHub Pages.
- `docs/app.js` renders the feed; no mock fallback — a failed feed shows an
  explicit error state. Local preview: serve `docs/` and open
  `index.html?mock=1`.

## Adding tickers

Edit `docs/symbols.json` — one entry per ticker:

```json
{"key": "nvda", "symbol": "NVDA", "label": "Nvidia", "kind": "index", "divisor": 1}
```

- `symbol` is the Yahoo Finance symbol (`AAPL`, `NVDA`, `TSLA`, `BTC-USD`, …).
- `kind` is `index` (comma + 2 decimals) or `yield` (percent).
- Tiles are built from the feed, so a new entry appears on the next deploy.
  Around 8 tiles fit comfortably in the 600×600 grid.

## Watchlist

The app has a second view listing every ticker in `glasses_watchlist.txt`
(a curated list — edit it to change what appears on the glasses) with live
price and day change, sorted by biggest mover. Opening a ticker shows its
price, change, and 30-day chart.

- Quotes come from CNBC's quote API in a single batch request, refreshed with
  the 15-minute poll. A few tickers whose symbols differ between sources fall
  back to Yahoo (`YAHOO_OVERRIDES` in `poller/market_poll.py`).
- 30-day charts are pre-fetched per ticker by `poller/history_poll.py` into
  `docs/feed/history/<TICKER>.json`, refreshed daily at 6:00 AM ET
  (`.github/workflows/poll-history.yml`).

Glasses navigation: the footer **Watchlist** button (or D-pad) opens the list;
↑/↓ moves one row, Enter opens the ticker, Esc goes back.

Meta AI app → Settings → App Info → tap the app version 5 times (Developer
Mode), then App Settings → App Connections → Web Apps → Add a Web App with
the live URL above.

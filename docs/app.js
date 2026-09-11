/* Market overview web app for Meta Ray-Ban Display (600x600, D-pad navigation).
 * Feed is written every 15 min by the GitHub Action (poller/market_poll.py);
 * per-ticker 30-day history is refreshed daily (poller/history_poll.py).
 * No mock fallback: if a feed fails the app shows an explicit error state.
 * Local preview: open index.html with ?mock=1 to render the docs/mock*.json files. */
(function () {
  'use strict';

  var FEED_URL = './feed/latest.json';
  var WL_URL = './feed/watchlist.json';
  var HIST_URL = './feed/history/';
  var MOCK_URL = './mock.json';
  var MOCK_WL_URL = './mock-watchlist.json';
  var MOCK_HIST_URL = './mock-history/';
  var REFRESH_MS = 5 * 60 * 1000;
  var UP = '#4ade80', DOWN = '#f87171', FLAT = '#6b7280';

  // Tiles are built from the feed itself, so adding a ticker to
  // docs/symbols.json automatically adds a tile on the next deploy.
  var SYMBOLS = [];
  var builtKeys = '';
  var WL = [];          // watchlist quotes, sorted by |change%|
  var WL_AT = null;     // watchlist generated_at
  var currentView = 'home';
  var detailSym = null;

  function $(id) { return document.getElementById(id); }

  function fmtNum(x, digits) {
    return Number(x).toLocaleString('en-US',
      { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtPrice(s) {
    if (s.price === null || s.price === undefined || isNaN(s.price)) return '–';
    if (s.kind === 'yield') return Number(s.price).toFixed(2) + '%';
    return fmtNum(s.price, 2);
  }

  function changeHTML(s) {
    if (s.change === null || s.change === undefined || isNaN(s.change)) return '';
    var cls = s.change > 0 ? 'up' : (s.change < 0 ? 'down' : 'flat');
    var sign = s.change > 0 ? '+' : (s.change < 0 ? '−' : '');
    var mag = Math.abs(s.change);
    var pct = (s.change_pct === null || s.change_pct === undefined || isNaN(s.change_pct)) ? '' :
      ' (' + sign + Math.abs(s.change_pct).toFixed(2) + '%)';
    var val = s.kind === 'yield' ? mag.toFixed(2) + ' pp' : fmtNum(mag, 2);
    return '<span class="change ' + cls + '">' + sign + val + pct + '</span>';
  }

  function ago(iso) {
    if (!iso) return 'no data yet';
    var mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 min ago';
    if (mins < 60) return mins + ' min ago';
    var h = Math.round(mins / 60);
    return h === 1 ? '1 hr ago' : h + ' hrs ago';
  }

  /* ---------- inline SVG sparkline (no libraries) ---------- */

  function sparklineSVG(values, w, h, color) {
    var v = (values || []).filter(function (x) { return x !== null && x !== undefined && !isNaN(x); });
    if (v.length < 2) return '';
    var min = Math.min.apply(null, v), max = Math.max.apply(null, v);
    var span = (max - min) || 1, pad = 4;
    var pts = v.map(function (val, i) {
      var x = pad + (w - 2 * pad) * i / (v.length - 1);
      var y = pad + (h - 2 * pad) * (1 - (val - min) / span);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var line = pts.join(' ');
    var last = pts[pts.length - 1].split(',');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polygon points="' + pad + ',' + h + ' ' + line + ' ' + (w - pad) + ',' + h +
      '" fill="' + color + '" opacity="0.16"/>' +
      '<polyline points="' + line + '" fill="none" stroke="' + color +
      '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="' + color + '"/>' +
      '</svg>';
  }

  /* ---------- home view ---------- */

  function trendColor(s) {
    if (s.change === null || s.change === undefined || isNaN(s.change)) return FLAT;
    return s.change > 0 ? UP : (s.change < 0 ? DOWN : FLAT);
  }

  function buildTiles() {
    $('grid').innerHTML = SYMBOLS.map(function (s) {
      return '<section class="tile" data-focusable tabindex="0" id="tile-' + s.key + '">' +
        '<div class="label">' + s.label + '</div>' +
        '<div class="row"><div class="value" id="v-' + s.key + '">–</div>' +
        '<div id="c-' + s.key + '"></div></div>' +
        '<div class="chart" id="ch-' + s.key + '"></div>' +
        '</section>';
    }).join('');
  }

  function renderHome(d) {
    var syms = d.symbols || {};
    var keys = Object.keys(syms);
    if (!keys.length) { renderError(); return; }
    var keyStr = keys.join(',');
    if (keyStr !== builtKeys) {
      builtKeys = keyStr;
      SYMBOLS = keys.map(function (k) {
        var sd = syms[k] || {};
        return { key: k, label: sd.label || k.toUpperCase(), kind: sd.kind || 'index' };
      });
      buildTiles();
      $('grid').style.gridTemplateRows = 'repeat(' + Math.ceil(keys.length / 2) + ', 1fr)';
      updateFocusables();
    }
    SYMBOLS.forEach(function (s) {
      var sd = syms[s.key] || {};
      sd.kind = s.kind;
      $('v-' + s.key).textContent = fmtPrice(sd);
      $('c-' + s.key).innerHTML = changeHTML(sd);
      $('ch-' + s.key).innerHTML = sparklineSVG(sd.history, 224, 40, trendColor(sd));
    });
    $('synced').textContent = 'synced ' + ago(d.generated_at);
    document.body.classList.remove('error');
  }

  /* ---------- watchlist view ---------- */

  function renderList() {
    var list = $('wl-list');
    list.innerHTML = WL.map(function (q) {
      var cls = q.cp > 0 ? 'up' : (q.cp < 0 ? 'down' : 'flat');
      var sign = q.cp > 0 ? '+' : (q.cp < 0 ? '−' : '');
      return '<button class="wl-row" data-focusable data-symbol="' + q.s + '">' +
        '<span class="wl-sym">' + q.s + '</span>' +
        '<span class="wl-price">' + fmtNum(q.p, 2) + '</span>' +
        '<span class="change ' + cls + '">' + sign + Math.abs(q.cp).toFixed(2) + '%</span>' +
        '</button>';
    }).join('');
    $('synced-wl').textContent = WL.length
      ? WL.length + ' tickers · synced ' + ago(WL_AT)
      : 'could not load watchlist';
    Array.prototype.forEach.call(list.querySelectorAll('.wl-row'), function (row) {
      row.addEventListener('click', function () { showDetail(row.getAttribute('data-symbol')); });
    });
    updateFocusables();
  }

  /* ---------- detail view ---------- */

  function quoteOf(sym) {
    for (var i = 0; i < WL.length; i++) if (WL[i].s === sym) return WL[i];
    return null;
  }

  function showDetail(sym) {
    detailSym = sym;
    var q = quoteOf(sym);
    $('d-sym').textContent = sym;
    $('d-name').textContent = q ? q.n : '';
    $('d-price').textContent = q ? fmtNum(q.p, 2) : '–';
    var dc = $('d-change');
    if (q) {
      var cls = q.cp > 0 ? 'up' : (q.cp < 0 ? 'down' : 'flat');
      var sign = q.cp > 0 ? '+' : (q.cp < 0 ? '−' : '');
      dc.className = 'd-change ' + cls;
      dc.textContent = sign + fmtNum(Math.abs(q.c), 2) + ' (' + sign + Math.abs(q.cp).toFixed(2) + '%)';
      $('d-asof').textContent = 'synced ' + ago(WL_AT);
    } else {
      dc.className = 'd-change flat';
      dc.textContent = '';
    }
    $('d-chart').innerHTML = '<div class="d-range">loading chart…</div>';
    showView('detail');
    var base = useMock() ? MOCK_HIST_URL : HIST_URL;
    fetch(base + encodeURIComponent(sym) + '.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('history ' + r.status); return r.json(); })
      .then(function (h) {
        if (detailSym !== sym) return;  // user moved on
        var color = q ? trendColor({ change: q.c }) : FLAT;
        var svg = sparklineSVG(h.h, 548, 220, color);
        $('d-chart').innerHTML = svg || '<div class="d-range">chart unavailable</div>';
      })
      .catch(function () {
        if (detailSym === sym) $('d-chart').innerHTML = '<div class="d-range">chart unavailable</div>';
      });
  }

  /* ---------- views ---------- */

  function showView(name) {
    currentView = name;
    ['home', 'list', 'detail'].forEach(function (v) {
      $('view-' + v).classList.toggle('active', v === name);
    });
    updateFocusables();
    if (focusables.length) moveFocus(0);
    if (name === 'list') {
      var active = document.activeElement;
      if (active && active.classList && active.classList.contains('wl-row')) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /* ---------- data ---------- */

  function renderError() {
    $('synced').textContent = 'could not load market data';
    document.body.classList.add('error');
  }

  function useMock() {
    return /[?&]mock=1/.test(window.location.search);
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  function refresh() {
    var feedUrl = useMock() ? MOCK_URL : FEED_URL;
    var wlUrl = useMock() ? MOCK_WL_URL : WL_URL;
    getJSON(feedUrl).then(renderHome).catch(renderError);
    getJSON(wlUrl).then(function (d) {
      WL_AT = d.generated_at || null;
      WL = (d.quotes || []).slice().sort(function (a, b) {
        return Math.abs(b.cp) - Math.abs(a.cp);
      });
      if (currentView === 'list') renderList();
      if (currentView === 'detail' && detailSym) {
        var q = quoteOf(detailSym);
        if (q) {
          $('d-price').textContent = fmtNum(q.p, 2);
          $('d-asof').textContent = 'synced ' + ago(WL_AT);
        }
      }
    }).catch(function () {
      WL = [];
      if (currentView === 'list') renderList();
    });
  }

  /* ---------- D-pad / Neural Band navigation ---------- */

  var focusables = [];
  var focusIndex = 0;

  function visibleFocusables() {
    var view = $('view-' + currentView);
    return Array.prototype.slice.call(
      view.querySelectorAll('[data-focusable]:not([disabled])')
    );
  }

  function updateFocusables() {
    focusables = visibleFocusables();
  }

  function moveFocus(idx) {
    focusables.forEach(function (el) { el.classList.remove('focused'); });
    focusIndex = Math.max(0, Math.min(idx, focusables.length - 1));
    var el = focusables[focusIndex];
    if (el) {
      el.classList.add('focused');
      el.focus();
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
  }

  document.addEventListener('focusin', function (e) {
    var idx = focusables.indexOf(e.target);
    if (idx !== -1) {
      focusables.forEach(function (el) { el.classList.remove('focused'); });
      focusIndex = idx;
      e.target.classList.add('focused');
    }
  });

  document.addEventListener('keydown', function (e) {
    var step = currentView === 'list' ? 1 : 2;  // list is 1 column, home grid is 2
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); moveFocus(focusIndex - step); break;
      case 'ArrowDown': e.preventDefault(); moveFocus(focusIndex + step); break;
      case 'ArrowLeft': e.preventDefault(); if (step === 2) moveFocus(focusIndex - 1); break;
      case 'ArrowRight': e.preventDefault(); if (step === 2) moveFocus(focusIndex + 1); break;
      case 'Enter':
        e.preventDefault();
        if (document.activeElement && document.activeElement.matches('[data-focusable]')) {
          document.activeElement.click();
        }
        break;
      case 'Backspace':
      case 'Escape':
        e.preventDefault();
        if (currentView === 'detail') showView('list');
        else if (currentView === 'list') showView('home');
        else history.back();
        break;
      default: return;
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    updateFocusables();
    if (focusables.length) moveFocus(0);
    var observer = new MutationObserver(updateFocusables);
    observer.observe(document.body, { childList: true, subtree: true });
  });

  $('to-list').addEventListener('click', function () { renderList(); showView('list'); });
  $('to-home').addEventListener('click', function () { showView('home'); });
  $('to-back').addEventListener('click', function () { showView('list'); });
  $('refresh').addEventListener('click', refresh);
  $('refresh2').addEventListener('click', refresh);

  refresh();
  setInterval(refresh, REFRESH_MS);
})();

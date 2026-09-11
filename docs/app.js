/* Market overview web app for Meta Ray-Ban Display (600x600, D-pad navigation).
 * Feed is written every 15 min by the GitHub Action (poller/market_poll.py).
 * No mock fallback: if the feed fails the app shows an explicit error state.
 * Local preview: open index.html with ?mock=1 to render docs/mock.json. */
(function () {
  'use strict';

  var FEED_URL = './feed/latest.json';
  var MOCK_URL = './mock.json';
  var REFRESH_MS = 5 * 60 * 1000;
  var UP = '#4ade80', DOWN = '#f87171', FLAT = '#6b7280';

  // Tiles are built from the feed itself, so adding a ticker to
  // docs/symbols.json automatically adds a tile on the next deploy.
  var SYMBOLS = [];
  var builtKeys = '';

  function $(id) { return document.getElementById(id); }

  function fmtPrice(s) {
    if (s.price === null || s.price === undefined || isNaN(s.price)) return '–';
    if (s.kind === 'yield') return Number(s.price).toFixed(2) + '%';
    return Number(s.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function changeHTML(s) {
    if (s.change === null || s.change === undefined || isNaN(s.change)) return '';
    var cls = s.change > 0 ? 'up' : (s.change < 0 ? 'down' : 'flat');
    var sign = s.change > 0 ? '+' : (s.change < 0 ? '−' : '');
    var mag = Math.abs(s.change);
    var pct = (s.change_pct === null || s.change_pct === undefined || isNaN(s.change_pct)) ? '' :
      ' (' + sign + Math.abs(s.change_pct).toFixed(2) + '%)';
    var val = s.kind === 'yield'
      ? mag.toFixed(2) + ' pp'
      : mag.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<polygon points="' + pad + ',' + h + ' ' + line + ' ' + (w - pad) + ',' + h +
      '" fill="' + color + '" opacity="0.16"/>' +
      '<polyline points="' + line + '" fill="none" stroke="' + color +
      '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="' + color + '"/>' +
      '</svg>';
  }

  /* ---------- render ---------- */

  function trendColor(s) {
    if (s.change === null || s.change === undefined || isNaN(s.change)) return FLAT;
    return s.change > 0 ? UP : (s.change < 0 ? DOWN : FLAT);
  }

  function buildTiles() {
    var grid = $('grid');
    grid.innerHTML = SYMBOLS.map(function (s) {
      return '<section class="tile" data-focusable tabindex="0" id="tile-' + s.key + '">' +
        '<div class="label">' + s.label + '</div>' +
        '<div class="row"><div class="value" id="v-' + s.key + '">–</div>' +
        '<div id="c-' + s.key + '"></div></div>' +
        '<div class="chart" id="ch-' + s.key + '"></div>' +
        '</section>';
    }).join('');
  }

  function render(d) {
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

  function renderError() {
    $('synced').textContent = 'could not load market data';
    document.body.classList.add('error');
  }

  function useMock() {
    return /[?&]mock=1/.test(window.location.search);
  }

  function refresh() {
    var url = useMock() ? MOCK_URL : FEED_URL;
    fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('feed ' + r.status); return r.json(); })
      .then(render)
      .catch(renderError);
  }

  /* ---------- D-pad / Neural Band navigation ---------- */

  var focusables = [];
  var focusIndex = 0;

  function updateFocusables() {
    focusables = Array.prototype.slice.call(
      document.querySelectorAll('[data-focusable]:not([disabled])')
    );
  }

  function moveFocus(idx) {
    focusables.forEach(function (el) { el.classList.remove('focused'); });
    focusIndex = Math.max(0, Math.min(idx, focusables.length - 1));
    if (focusables[focusIndex]) {
      focusables[focusIndex].classList.add('focused');
      focusables[focusIndex].focus();
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
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); moveFocus(focusIndex - 2); break;
      case 'ArrowDown': e.preventDefault(); moveFocus(focusIndex + 2); break;
      case 'ArrowLeft': e.preventDefault(); moveFocus(focusIndex - 1); break;
      case 'ArrowRight': e.preventDefault(); moveFocus(focusIndex + 1); break;
      case 'Enter':
        e.preventDefault();
        if (document.activeElement && document.activeElement.matches('[data-focusable]')) {
          document.activeElement.click();
        }
        break;
      case 'Backspace':
      case 'Escape':
        e.preventDefault();
        history.back();
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

  $('refresh').addEventListener('click', refresh);

  refresh();
  setInterval(refresh, REFRESH_MS);
})();

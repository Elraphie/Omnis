/**
 * The desk console served at `/`. A static shell: every number comes from GET /dashboard, which needs an
 * admin key unless PUBLIC_STATUS=1. Data is written with textContent only; Textile and venue messages are untrusted.
 */
export function statusPage(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Omnis desk</title>
<style>
  :root {
    color-scheme: light;
    --page: #f9f9f7; --surface: #fcfcfb; --raised: #ffffff;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
    --series: #2a78d6; --series-wash: rgba(42,120,214,0.10); --threshold: #898781;
    --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
    --good-ink: #006300; --bad-ink: #b42323;
    --focus: #2a78d6;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --page: #0d0d0d; --surface: #1a1a19; --raised: #222220;
      --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
      --series: #3987e5; --series-wash: rgba(57,135,229,0.12);
      --good-ink: #0ca30c; --bad-ink: #e66767; --focus: #3987e5;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --raised: #222220;
    --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --series: #3987e5; --series-wash: rgba(57,135,229,0.12);
    --good-ink: #0ca30c; --bad-ink: #e66767; --focus: #3987e5;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--page); color: var(--ink); }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { width: min(1240px, 100%); margin: 0 auto; padding: 0 16px; }
  a { color: inherit; text-underline-offset: 2px; }
  a:hover { color: var(--series); }
  button, input { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12.5px; }
  .num { font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); }
  .ink2 { color: var(--ink-2); }
  .up { color: var(--good-ink); }
  .down { color: var(--bad-ink); }

  header.top { border-bottom: 1px solid var(--ring); background: var(--surface); }
  @media (min-width: 720px) { header.top { position: sticky; top: 0; z-index: 5; } }
  .topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding-top: 12px; padding-bottom: 12px; }
  .brand { display: flex; align-items: baseline; gap: 8px; margin-right: auto; }
  .brand b { font-size: 18px; letter-spacing: -0.01em; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--ring); background: var(--raised); font-size: 12px; color: var(--ink-2); white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px var(--surface); }
  .clock { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); }
  .clock span b { color: var(--ink); font-weight: 600; }

  main { padding: 18px 0 64px; display: grid; gap: 18px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .seg { display: inline-flex; border: 1px solid var(--ring); border-radius: 8px; overflow: hidden; background: var(--raised); }
  .seg button { border: 0; background: transparent; padding: 6px 12px; cursor: pointer; color: var(--ink-2); }
  .seg button[aria-pressed="true"] { background: var(--ink); color: var(--page); font-weight: 600; }
  .note { font-size: 12px; color: var(--muted); }

  .tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 1180px) { .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 620px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 14px; min-width: 0; }
  .tile .label { font-size: 12px; color: var(--ink-2); }
  .tile .value { font-size: 24px; font-weight: 600; margin: 4px 0 2px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .tile .sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }

  .card { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 14px; min-width: 0; }
  .card h2 { font-size: 14px; font-weight: 600; margin: 0; }
  .card .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px 12px; margin-bottom: 10px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px; }
  @media (max-width: 960px) { .two, .three { grid-template-columns: 1fr; } }

  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--axis); white-space: nowrap; }
  td { padding: 7px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  .status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .legs { display: grid; gap: 2px; font-size: 12px; color: var(--ink-2); }
  .clip { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }

  dl.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 13px; }
  dl.kv dt { color: var(--ink-2); }
  dl.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

  .chart { position: relative; }
  .chart svg { display: block; width: 100%; height: 220px; }
  .chart .tip { position: absolute; pointer-events: none; background: var(--raised); border: 1px solid var(--ring); border-radius: 6px; padding: 5px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); white-space: nowrap; display: none; }
  .chart .empty { height: 220px; display: grid; place-items: center; color: var(--muted); font-size: 13px; }
  details.table-view summary { cursor: pointer; font-size: 12px; color: var(--ink-2); margin-top: 6px; }
  details.table-view .scroll { max-height: 220px; overflow: auto; margin-top: 6px; }

  .copy { border: 1px solid var(--ring); background: var(--raised); border-radius: 6px; padding: 1px 7px; font-size: 11px; cursor: pointer; color: var(--ink-2); }
  .lock { max-width: 460px; }
  .lock form, .convert form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .lock input, .convert input { flex: 1 1 140px; min-width: 0; padding: 7px 9px; border: 1px solid var(--axis); border-radius: 6px; background: var(--raised); }
  .btn { padding: 7px 14px; border-radius: 6px; border: 1px solid var(--ink); background: var(--ink); color: var(--page); cursor: pointer; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--raised); border: 1px solid var(--ring); border-radius: 6px; padding: 10px; font: 12px/1.45 ui-monospace, Consolas, monospace; max-height: 320px; overflow: auto; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header class="top">
  <div class="wrap topbar">
    <div class="brand"><b>Omnis</b><span class="muted">Celo FX desk</span></div>
    <div class="chips" id="chips"><span class="chip">Loading</span></div>
    <div class="clock" id="clock"></div>
  </div>
</header>

<main class="wrap">
  <section class="card lock" id="lock" hidden>
    <h2>Desk data is locked</h2>
    <p class="ink2" id="lock-reason">Enter an admin key from ADMIN_KEYS. For a local desk, PUBLIC_STATUS=1 opens this page without one.</p>
    <form id="lock-form">
      <input name="key" type="password" autocomplete="off" placeholder="Admin key" aria-label="Admin key" />
      <button class="btn" type="submit">Open desk</button>
    </form>
  </section>

  <div id="desk" hidden>
    <div class="row" style="margin-bottom:12px">
      <div class="seg" role="group" aria-label="Time window" id="range"></div>
      <span class="note" id="window-note"></span>
    </div>

    <section class="tiles" id="tiles" aria-label="Headline figures"></section>

    <div class="two" style="margin-top:18px">
      <section class="card">
        <div class="head"><h2>Best net edge per scan</h2><span class="note">bps after gas and the cushion · line at the trade threshold</span></div>
        <div class="chart" id="chart-edge"></div>
      </section>
      <section class="card">
        <div class="head"><h2>Paper realized P&amp;L</h2><span class="note">USD, cumulative</span></div>
        <div class="chart" id="chart-pnl"></div>
      </section>
    </div>

    <section class="card" style="margin-top:18px">
      <div class="head"><h2>Corridor scanner</h2><span class="note" id="scanner-note"></span></div>
      <div class="scroll" id="scanner"></div>
    </section>

    <section class="card" style="margin-top:18px">
      <div class="head"><h2>Shadow execution</h2><span class="note" id="shadow-note"></span></div>
      <div class="scroll" id="shadow-log"></div>
    </section>

    <div class="two" style="margin-top:18px">
      <section class="card">
        <div class="head"><h2>Routes over the window</h2><span class="note">every priced round trip</span></div>
        <div class="scroll" id="routes"></div>
      </section>
      <section class="card">
        <div class="head"><h2>On-chain vs fiat reference</h2><span class="note" id="ref-note"></span></div>
        <div class="scroll" id="reference"></div>
      </section>
    </div>

    <div class="three" style="margin-top:18px">
      <section class="card"><div class="head"><h2>Risk parameters</h2></div><dl class="kv" id="risk"></dl></section>
      <section class="card"><div class="head"><h2>System</h2></div><dl class="kv" id="system"></dl></section>
      <section class="card"><div class="head"><h2>Shadow wallet</h2><span class="note">signs quote requests only</span></div><div id="wallet"></div></section>
    </div>

    <div class="two" style="margin-top:18px">
      <section class="card">
        <div class="head"><h2>Paper trades</h2><span class="note">simulated fills</span></div>
        <div class="scroll" id="trades"></div>
      </section>
      <section class="card">
        <div class="head"><h2>Venues and contracts</h2><span class="note">Celo mainnet · 42220</span></div>
        <div class="scroll" id="contracts"></div>
      </section>
    </div>

    <details class="card convert" style="margin-top:18px">
      <summary><b>Convert quote</b> <span class="note">needs a Convert API key</span></summary>
      <form id="convert">
        <input name="from" value="USDT" aria-label="From token" />
        <input name="to" value="wBRL" aria-label="To token" />
        <input name="amount" value="100" aria-label="Amount" />
        <input name="key" type="password" autocomplete="off" placeholder="API key" aria-label="Convert API key" />
        <button class="btn" type="submit">Quote</button>
      </form>
      <pre id="quote" hidden></pre>
    </details>
  </div>
</main>

<script>
(function () {
  var WINDOWS = [[6, '6h'], [24, '24h'], [72, '3d'], [168, '7d']];
  var STATUS = {
    good: { color: 'var(--good)', mark: '✓' },
    warning: { color: 'var(--warning)', mark: '◆' },
    serious: { color: 'var(--serious)', mark: '▲' },
    critical: { color: 'var(--critical)', mark: '✕' },
    neutral: { color: 'var(--axis)', mark: '–' }
  };
  var state = { hours: 24, key: '', data: null, loadedAt: 0 };
  try { state.key = sessionStorage.getItem('omnis.admin') || ''; } catch (e) {}
  try { var savedHours = Number(localStorage.getItem('omnis.hours')); if (savedHours) state.hours = savedHours; } catch (e) {}

  function el(id) { return document.getElementById(id); }
  function h(tag, props, children) {
    var node = document.createElement(tag);
    props = props || {};
    for (var k in props) {
      if (props[k] === null || props[k] === undefined) continue;
      if (k === 'text') node.textContent = String(props[k]);
      else if (k === 'class') node.className = props[k];
      else if (k === 'style') node.setAttribute('style', props[k]);
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }
  function fill(node, children) { while (node.firstChild) node.removeChild(node.firstChild); (children || []).forEach(function (c) { if (c) node.appendChild(c); }); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function usd(n, dp) { if (!isNum(n)) return '—'; dp = dp === undefined ? 2 : dp; return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  function sUsd(n, dp) { if (!isNum(n)) return '—'; return (n > 0 ? '+' : '') + usd(n, dp); }
  function bps(n, dp) { if (!isNum(n)) return '—'; dp = dp === undefined ? 1 : dp; return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(dp); }
  function pct(n) { return isNum(n) ? (n * 100).toFixed(1) + '%' : '—'; }
  function dur(sec) {
    if (!isNum(sec) || sec < 0) return '—';
    var d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    if (d) return d + 'd ' + hh + 'h ' + m + 'm';
    if (hh) return hh + 'h ' + m + 'm';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  }
  function ago(ts) { if (!ts) return '—'; return dur((Date.now() - Date.parse(ts)) / 1000) + ' ago'; }
  function clock(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function stamp(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + clock(ts); }
  function short(addr) { return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '—'; }
  function signClass(n) { return isNum(n) ? (n > 0 ? 'up' : n < 0 ? 'down' : '') : ''; }
  function venue(v) { return ({ 'uniswap-v3': 'Uniswap', 'textile-rfq': 'Textile', 'mento-broker': 'Mento Broker', 'mento-v3': 'Mento v3' })[v] || v; }
  function routeName(r) { return r ? r.replace('uniswap-v3', 'Uniswap').replace('textile-rfq', 'Textile').replace('mento-broker', 'Mento Broker').replace('mento-v3', 'Mento v3').replace('->', ' → ').replace(' -> ', ' → ') : '—'; }
  function status(kind, label) {
    var s = STATUS[kind] || STATUS.neutral;
    return h('span', { class: 'status' }, [h('span', { class: 'dot', style: 'background:' + s.color, 'aria-hidden': 'true' }), h('span', { 'aria-hidden': 'true', class: 'muted', text: s.mark }), h('span', { text: label })]);
  }
  function chip(kind, label, title) { var c = status(kind, label); c.className = 'chip'; if (title) c.title = title; return c; }
  function table(head, rows, opts) {
    opts = opts || {};
    if (!rows.length) return h('p', { class: 'note', text: opts.empty || 'Nothing in this window yet.' });
    return h('table', {}, [
      h('thead', {}, [h('tr', {}, head.map(function (c) { return h('th', { class: c.r ? 'r' : null, text: c.t || c }); }))]),
      h('tbody', {}, rows.map(function (row) {
        return h('tr', {}, row.map(function (cell, i) {
          var right = head[i] && head[i].r;
          if (cell && cell.nodeType) return h('td', { class: right ? 'r' : null }, [cell]);
          if (cell && typeof cell === 'object') return h('td', { class: (right ? 'r ' : '') + (cell.cls || ''), title: cell.title }, [cell.node || document.createTextNode(cell.t)]);
          return h('td', { class: right ? 'r' : null, text: cell === null || cell === undefined ? '—' : cell });
        }));
      }))
    ]);
  }
  function copyButton(value) {
    return h('button', { class: 'copy', type: 'button', 'aria-label': 'Copy ' + value, onclick: function (e) {
      var b = e.currentTarget;
      try { navigator.clipboard.writeText(value).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1200); }); } catch (err) {}
    } }, ['Copy']);
  }
  function scan(addr) { return h('a', { href: 'https://celoscan.io/address/' + addr, target: '_blank', rel: 'noopener noreferrer', class: 'mono', text: short(addr) }); }

  // ---------- Charts: one series, one axis, crosshair + tooltip, table view ----------
  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    var span = max - min, step = Math.pow(10, Math.floor(Math.log10(span / count))), err = span / count / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var ticks = [], t = Math.floor(min / step) * step;
    for (; t <= max + step * 0.5; t += step) ticks.push(Math.round(t / step) * step);
    return ticks;
  }
  function lineChart(host, points, opts) {
    var values = points.filter(function (p) { return isNum(p.v); });
    if (!values.length) { fill(host, [h('div', { class: 'empty', text: opts.empty })]); return; }
    var W = Math.max(280, host.clientWidth || 600), H = 220, L = 52, R = 12, T = 12, B = 26;
    var t0 = Date.parse(opts.since), t1 = Date.parse(opts.until);
    var ys = values.map(function (p) { return p.v; });
    if (opts.zero) ys.push(0);
    if (isNum(opts.threshold)) ys.push(opts.threshold);
    var ticks = niceTicks(Math.min.apply(null, ys), Math.max.apply(null, ys), 4);
    var y0 = ticks[0], y1 = ticks[ticks.length - 1];
    function X(ts) { return L + (Date.parse(ts) - t0) / Math.max(1, t1 - t0) * (W - L - R); }
    function Y(v) { return T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B); }
    var ns = 'http://www.w3.org/2000/svg';
    function s(tag, attrs) { var n = document.createElementNS(ns, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label, tabindex: '0', preserveAspectRatio: 'none' });
    ticks.forEach(function (t) {
      var y = Y(t);
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: t === 0 && opts.zero ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
      var lab = s('text', { x: L - 8, y: y + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 });
      lab.textContent = opts.fmtTick(t); svg.appendChild(lab);
    });
    for (var i = 0; i <= 4; i++) {
      var tt = t0 + (t1 - t0) * i / 4, x = L + (W - L - R) * i / 4;
      var xl = s('text', { x: x, y: H - 8, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', fill: 'var(--muted)', 'font-size': 11 });
      var dd = new Date(tt);
      xl.textContent = opts.hours > 24 ? dd.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + dd.toLocaleTimeString([], { hour: '2-digit' }) : dd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      svg.appendChild(xl);
    }
    if (isNum(opts.threshold)) {
      var ty = Y(opts.threshold);
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: ty, y2: ty, stroke: 'var(--threshold)', 'stroke-width': 1 }));
      var tl = s('text', { x: W - R, y: ty - 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 11 });
      tl.textContent = opts.thresholdLabel; svg.appendChild(tl);
    }
    // Break the line where a scan priced nothing, rather than drawing through the gap.
    var segs = [], cur = [];
    points.forEach(function (p) { if (isNum(p.v)) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } });
    if (cur.length) segs.push(cur);
    var base = Y(Math.max(y0, Math.min(y1, 0)));
    segs.forEach(function (seg) {
      var d = seg.map(function (p, j) { return (j ? 'L' : 'M') + X(p.ts).toFixed(1) + ' ' + Y(p.v).toFixed(1); }).join(' ');
      if (seg.length > 1) svg.appendChild(s('path', { d: d + ' L' + X(seg[seg.length - 1].ts).toFixed(1) + ' ' + base + ' L' + X(seg[0].ts).toFixed(1) + ' ' + base + ' Z', fill: 'var(--series-wash)', stroke: 'none' }));
      svg.appendChild(s('path', { d: d, fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    });
    var last = values[values.length - 1];
    svg.appendChild(s('circle', { cx: X(last.ts), cy: Y(last.v), r: 4, fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2 }));
    var cross = s('line', { y1: T, y2: H - B, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
    var hot = s('circle', { r: 4, fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(cross); svg.appendChild(hot);
    var tip = h('div', { class: 'tip', role: 'status' });
    var idx = values.length - 1;
    function show(k) {
      idx = Math.max(0, Math.min(values.length - 1, k));
      var p = values[idx], px = X(p.ts), py = Y(p.v);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      hot.setAttribute('cx', px); hot.setAttribute('cy', py); hot.setAttribute('visibility', 'visible');
      tip.textContent = stamp(p.ts) + ' · ' + opts.fmtValue(p.v);
      tip.style.display = 'block';
      var rect = svg.getBoundingClientRect(), sx = rect.width / W, sy = rect.height / H;
      var left = px * sx + 10; if (left + tip.offsetWidth > rect.width) left = px * sx - tip.offsetWidth - 10;
      tip.style.left = Math.max(0, left) + 'px'; tip.style.top = Math.max(0, py * sy - 34) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    svg.addEventListener('pointermove', function (e) {
      var rect = svg.getBoundingClientRect(), x = (e.clientX - rect.left) / rect.width * W;
      var best = 0, gap = Infinity;
      values.forEach(function (p, k) { var g = Math.abs(X(p.ts) - x); if (g < gap) { gap = g; best = k; } });
      show(best);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', function () { show(idx); });
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { show(idx - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { show(idx + 1); e.preventDefault(); }
    });
    var rows = values.slice(-200).reverse().map(function (p) { return [stamp(p.ts), opts.fmtValue(p.v)]; });
    var tv = h('details', { class: 'table-view' }, [h('summary', { text: 'Show as table (' + values.length + ' points' + (values.length > 200 ? ', latest 200' : '') + ')' }), h('div', { class: 'scroll' }, [table(['Time', { t: opts.valueHead, r: true }], rows)])]);
    fill(host, [svg, tip, tv]);
  }

  // ---------- Sections ----------
  function renderHeader(d) {
    var chips = [];
    chips.push(chip(d.mode === 'live' ? 'critical' : d.mode === 'paper' ? 'good' : 'neutral', d.mode === 'dry-run' ? 'Dry-run' : d.mode === 'paper' ? 'Paper' : 'Live', 'Desk mode'));
    var src = d.lastCycle && d.lastCycle.quoteSource;
    chips.push(chip(src === 'live' ? 'good' : src ? 'warning' : 'neutral', src === 'live' ? 'Live quotes' : src ? 'Fixture quotes' : 'No scan yet'));
    chips.push(d.killSwitch ? chip('critical', 'Halted: ' + d.killReason) : chip('good', 'Risk on'));
    if (d.config.shadow) chips.push(chip('good', 'Shadow ' + (d.wallet ? 'firm quotes' : 'previews')));
    fill(el('chips'), chips);
  }
  function renderClock() {
    var d = state.data; if (!d) return;
    var last = d.lastCycle && d.lastCycle.ts;
    var next = d.nextScanAt ? Math.max(0, (Date.parse(d.nextScanAt) - Date.now()) / 1000) : null;
    var up = d.uptimeSec + (Date.now() - state.loadedAt) / 1000;
    fill(el('clock'), [
      h('span', {}, ['Last scan ', h('b', { text: last ? ago(last) : '—' })]),
      h('span', {}, ['Next ', h('b', { text: next === null ? '—' : next < 1 ? 'now' : dur(next) })]),
      h('span', {}, ['Up ', h('b', { text: dur(up) })])
    ]);
  }
  function renderRange(d) {
    fill(el('range'), WINDOWS.map(function (w) {
      return h('button', { type: 'button', 'aria-pressed': String(w[0] === state.hours), onclick: function () {
        state.hours = w[0]; try { localStorage.setItem('omnis.hours', String(w[0])); } catch (e) {} load();
      } }, [w[1]]);
    }));
    el('window-note').textContent = d.summary.scans + ' live scans since ' + stamp(d.window.since) + ' · refreshes every 15s';
  }
  function tile(label, value, sub, cls) {
    return h('div', { class: 'tile' }, [h('div', { class: 'label', text: label }), h('div', { class: 'value ' + (cls || ''), text: value }), h('div', { class: 'sub', text: sub })]);
  }
  function renderTiles(d) {
    var p = d.paper, best = d.lastCycle && d.lastCycle.best, sm = d.summary, sh = d.shadow;
    var textile = d.health.filter(function (row) { return row.venue === 'textile-rfq'; })[0];
    var wouldFill = sh.outcomes.would_fill || 0;
    fill(el('tiles'), [
      tile('Paper equity', p ? usd(p.equityUsd) : '—', p ? 'realized ' + sUsd(p.realizedUsd) + ' · since ' + usd(p.startingEquityUsd) + ' start' : d.lastCycle ? 'Paper mode is off' : 'waiting for the first scan'),
      tile('Best edge, last scan', best ? bps(best.netEdgeBps) + ' bps' : '—', best ? routeName(best.corridor + ' ' + best.route) + ' · ' + usd(best.sizeUsd, 0) + ' · ' + sUsd(best.netEdgeUsd, 4) : 'No round trip priced', best ? signClass(best.netEdgeBps) : ''),
      tile('Scans with a positive edge', sm.scans ? pct(sm.scansWithPositive / sm.scans) : '—', sm.scansWithPositive + ' of ' + sm.scans + ' · ' + sm.scansOver10Bps + ' at 10 bps or more'),
      tile('Upper bound', usd(sm.capturableUsd), 'best positive edge per scan, filled at its quote'),
      tile('Shadow walks', sh.runs ? wouldFill + ' of ' + sh.runs + ' would fill' : 'No runs yet', sh.runs ? 'median edge lost ' + bps(sh.medianDecayBps) + ' bps · ' + sUsd(sh.wouldFillNetUsd) : (d.config.shadow ? 'walks routes at ' + d.config.shadowMinNetBps + ' bps or better' : 'SHADOW=1 turns it on')),
      tile('Textile errors', textile ? pct(textile.scansWithErrors / Math.max(1, sm.scans)) : '0%', textile ? 'of scans · ' + textile.topMessage : 'every Textile request answered in this window')
    ]);
  }
  function renderCharts(d) {
    var minBps = d.config.minEdgeBps;
    lineChart(el('chart-edge'), d.series.edge.map(function (p) { return { ts: p.ts, v: p.bps }; }), {
      since: d.window.since, until: d.now, hours: d.window.hours, zero: true, threshold: minBps, thresholdLabel: 'trade at ' + minBps + ' bps',
      label: 'Best net edge per scan in basis points', valueHead: 'Best net bps',
      fmtTick: function (v) { return bps(v, 0); }, fmtValue: function (v) { return bps(v) + ' bps'; }, empty: 'No live scans in this window.'
    });
    lineChart(el('chart-pnl'), d.series.pnl.map(function (p) { return { ts: p.ts, v: p.realizedUsd }; }), {
      since: d.window.since, until: d.now, hours: d.window.hours, zero: true,
      label: 'Cumulative paper realized profit and loss in US dollars', valueHead: 'Realized',
      fmtTick: function (v) { return sUsd(v, Math.abs(v) < 10 ? 2 : 0); }, fmtValue: function (v) { return sUsd(v, 4); }, empty: 'No paper fills in this window. P&L appears once paper mode trades.'
    });
  }
  function signal(opp, cfg) {
    if (opp.netEdgeUsd >= cfg.minEdgeUsd && opp.netEdgeBps >= cfg.minEdgeBps) return status('good', 'Trade');
    if (opp.netEdgeUsd > 0) return status('warning', 'Watch');
    return status('neutral', 'No edge');
  }
  function renderScanner(d) {
    var c = d.lastCycle;
    el('scanner-note').textContent = c ? 'scanned ' + ago(c.ts) + ' · ' + c.quoteCount + ' prices in ' + (c.elapsedMs / 1000).toFixed(1) + 's · ' + c.decision.action + ': ' + c.decision.reason : 'waiting for the first scan';
    fill(el('scanner'), [table(
      ['Pair', 'Route', { t: 'Size', r: true }, { t: 'Out', r: true }, { t: 'Gas', r: true }, { t: 'Net $', r: true }, { t: 'Net bps', r: true }, 'Signal'],
      c ? c.opportunities.map(function (o) {
        return ['USDT/' + o.corridor, routeName(o.route), usd(o.sizeUsd), usd(o.outUsd, 4), usd(o.gasUsd, 4), { t: sUsd(o.netEdgeUsd, 4), cls: signClass(o.netEdgeUsd) }, { t: bps(o.netEdgeBps), cls: signClass(o.netEdgeBps) }, signal(o, d.config)];
      }) : [],
      { empty: 'No round trips priced in the last scan.' }
    )]);
  }
  function outcomeStatus(o) {
    if (o === 'would_fill') return status('good', 'Would fill');
    if (o === 'edge_gone') return status('warning', 'Edge gone');
    return status('critical', 'Leg failed');
  }
  function renderShadow(d) {
    var sh = d.shadow;
    el('shadow-note').textContent = sh.runs
      ? sh.runs + ' runs in window · median re-priced ' + bps(sh.medianNetBps) + ' bps · median walk ' + Math.round(sh.medianElapsedMs || 0) + ' ms'
      : 'walks the best route as live mode would, never signs';
    fill(el('shadow-log'), [table(
      ['Time', 'Route', { t: 'Size', r: true }, { t: 'Scan bps', r: true }, { t: 'Re-priced', r: true }, 'Outcome', 'Legs'],
      d.shadowLog.map(function (r) {
        var legs = h('div', { class: 'legs' }, r.legs.map(function (leg) {
          var text = venue(leg.venue) + ' ' + leg.tokenIn + '→' + leg.tokenOut + ' · ' + leg.status.replace('_', ' ') + (isNum(leg.driftBps) ? ' · drift ' + bps(leg.driftBps) : '') + (leg.built ? ' · calldata ok' : '');
          return h('span', {}, [text, leg.detail ? h('span', { class: 'muted clip', title: leg.detail, text: ' · ' + leg.detail }) : null]);
        }));
        return [stamp(r.ts), routeName(r.corridor + ' ' + venue(r.buyVenue) + ' -> ' + venue(r.sellVenue)), usd(r.sizeUsd, 0), bps(r.scanNetBps), { t: isNum(r.netBps) ? bps(r.netBps) : '—', cls: signClass(r.netBps) }, outcomeStatus(r.outcome), legs];
      }),
      { empty: d.config.shadow ? 'No shadow runs yet. They start when a route reaches ' + d.config.shadowMinNetBps + ' bps after the cushion.' : 'Shadow execution is off. Start the desk with SHADOW=1.' }
    )]);
  }
  function renderRoutes(d) {
    fill(el('routes'), [table(
      ['Route', { t: 'Size', r: true }, { t: 'Seen', r: true }, { t: '> 0', r: true }, { t: '≥ 10 bp', r: true }, { t: 'Median', r: true }, { t: 'Max', r: true }, { t: 'Longest open', r: true }],
      d.routes.map(function (r) {
        // Route keys read "wARS uniswap-v3->textile-rfq $100".
        var parts = r.route.split(' $'), size = Number(parts[1]);
        return [{ node: h('span', { style: 'white-space:nowrap', text: routeName(parts[0]) }) }, usd(size, 0), r.observations, pct(r.positiveShare), pct(r.over10Share), { t: bps(r.medianBps), cls: signClass(r.medianBps) }, { t: bps(r.maxBps), cls: signClass(r.maxBps) }, r.longestRunScans + ' scans'];
      })
    )]);
  }
  function renderReference(d) {
    var asOf = d.reference.reduce(function (a, r) { return r.latestRefAsOf > a ? r.latestRefAsOf : a; }, '');
    el('ref-note').textContent = asOf ? 'daily rate as of ' + stamp(asOf) + ' · positive beats the reference' : (d.config.fxReference ? '' : 'FX_REFERENCE_URL is off');
    fill(el('reference'), [table(
      ['Corridor', 'Venue', 'Side', { t: 'Median', r: true }, { t: 'p10', r: true }, { t: 'p90', r: true }, { t: '≥ 50 bp', r: true }],
      d.reference.map(function (r) {
        return [r.corridor, venue(r.venue), r.side, { t: bps(r.medianBps), cls: signClass(r.medianBps) }, bps(r.p10Bps), bps(r.p90Bps), pct(r.over50Share)];
      })
    )]);
  }
  function kv(host, pairs) {
    fill(host, pairs.reduce(function (acc, p) { acc.push(h('dt', { text: p[0] })); acc.push(p[1] && p[1].nodeType ? h('dd', {}, [p[1]]) : h('dd', { text: p[1] })); return acc; }, []));
  }
  function renderRisk(d) {
    var c = d.config;
    kv(el('risk'), [
      ['Max trade', usd(c.maxTradeUsd)], ['Size ladder', c.ladder.map(function (f) { return Math.round(f * 100) + '%'; }).join(' · ')],
      ['Min edge', usd(c.minEdgeUsd) + ' and ' + c.minEdgeBps + ' bps'], ['Cushion per non-firm leg', c.adverseBps + ' bps'],
      ['Slippage cap', c.slippageBps + ' bps'], ['Daily loss stop', usd(c.maxDailyLossUsd)], ['Inventory cap', usd(c.maxInventoryUsd)],
      ['Scan interval', c.intervalSec + 's'], ['Shadow', c.shadow ? 'on · ≥ ' + c.shadowMinNetBps + ' bps · ' + c.shadowMaxPerHour + '/h' : 'off']
    ]);
  }
  function renderSystem(d) {
    var c = d.lastCycle;
    kv(el('system'), [
      ['Started', stamp(d.startedAt)], ['Version', d.version], ['Last scan', c ? clock(c.ts) : '—'], ['Scan took', c ? (c.elapsedMs / 1000).toFixed(1) + 's' : '—'],
      ['Prices last scan', c ? String(c.quoteCount) : '—'],
      ['Venue errors last scan', c ? (c.venueErrors.length ? c.venueErrors.length + ' (' + c.venueErrors[0].venue + ')' : 'none') : '—'],
      ['Decision', c ? c.decision.action + ' · ' + c.decision.reason : '—'],
      ['Reference', d.config.fxReference || 'off'], ['RPC', d.config.rpcUrl.replace(/^https?:\/\//, '')]
    ]);
  }
  function renderWallet(d) {
    var w = d.wallet;
    if (!w) { fill(el('wallet'), [h('p', { class: 'note', text: 'No shadow wallet. The Textile leg uses previews. Set SHADOW_TAKER_KEY in .env for firm quotes.' })]); return; }
    var balances = Object.keys(w.balances).map(function (k) { return [k, Number(w.balances[k]).toLocaleString(undefined, { maximumFractionDigits: k === 'wARS' || k === 'cNGN' ? 0 : 4 })]; });
    var funded = Object.keys(w.balances).some(function (k) { return k !== 'CELO' && Number(w.balances[k]) > 0; });
    fill(el('wallet'), [
      h('div', { class: 'row', style: 'margin-bottom:8px' }, [scan(w.address), copyButton(w.address)]),
      h('div', { style: 'margin-bottom:8px' }, [funded ? status('good', 'Funded') : status('warning', 'Unfunded: firm quotes refused')]),
      (function () { var dl = h('dl', { class: 'kv' }); kv(dl, balances.concat([['Checked', clock(w.checkedAt)]])); return dl; })()
    ]);
  }
  function renderTrades(d) {
    fill(el('trades'), [table(
      ['Time', 'Strategy', 'Pair', 'Venues', { t: 'Size', r: true }, { t: 'P&L', r: true }],
      d.trades.map(function (t) { return [stamp(t.ts), t.strategy, t.pair, routeName(t.venuePath), usd(t.sizeUsd), { t: sUsd(t.pnlUsd, 4), cls: signClass(t.pnlUsd) }]; }),
      { empty: 'No paper fills yet.' }
    )]);
  }
  function renderContracts(d) {
    fill(el('contracts'), [table(['Contract', 'Address', ''], d.contracts.map(function (c) { return [c.label, scan(c.address), copyButton(c.address)]; }))]);
  }

  function render(d) {
    renderHeader(d); renderRange(d); renderTiles(d); renderCharts(d); renderScanner(d); renderShadow(d);
    renderRoutes(d); renderReference(d); renderRisk(d); renderSystem(d); renderWallet(d); renderTrades(d); renderContracts(d); renderClock();
  }

  function lock(message) {
    el('desk').hidden = true; el('lock').hidden = false;
    if (message) el('lock-reason').textContent = message;
    fill(el('chips'), [chip('warning', 'Locked')]); fill(el('clock'), []);
  }
  var loading = false;
  function load() {
    if (loading) return; loading = true;
    var headers = state.key ? { authorization: 'Bearer ' + state.key } : {};
    fetch('/dashboard?hours=' + state.hours, { headers: headers }).then(function (res) {
      if (res.status === 401) return res.json().then(function (body) { lock(body && body.error ? 'The desk said: ' + body.error + '.' : null); });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (body) {
        state.data = body; state.loadedAt = Date.now();
        el('lock').hidden = true; el('desk').hidden = false;
        render(body);
      });
    }).catch(function (err) {
      fill(el('chips'), [chip('critical', 'Desk unreachable', String(err && err.message || err))]);
    }).then(function () { loading = false; });
  }

  el('lock-form').addEventListener('submit', function (e) {
    e.preventDefault();
    state.key = String(new FormData(e.target).get('key') || '');
    try { sessionStorage.setItem('omnis.admin', state.key); } catch (err) {}
    load();
  });
  el('convert').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(e.target), out = el('quote');
    var params = new URLSearchParams({ from: f.get('from'), to: f.get('to'), amount: f.get('amount') });
    out.hidden = false; out.textContent = 'Quoting…';
    fetch('/convert/quote?' + params.toString(), { headers: { authorization: 'Bearer ' + f.get('key') } })
      .then(function (r) { return r.json(); })
      .then(function (body) { out.textContent = JSON.stringify(body, null, 2); })
      .catch(function (err) { out.textContent = String(err); });
  });
  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (state.data) renderCharts(state.data); }, 150); });
  load();
  setInterval(load, 15000);
  setInterval(renderClock, 1000);
})();
</script>
</body>
</html>`
}

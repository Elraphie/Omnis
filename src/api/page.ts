export function statusPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Omnis desk</title>
<style>
  :root { color-scheme: light; --ink:#1c1915; --paper:#f3efe4; --rule:#d9d0bc; --up:#1f6b4a; --down:#8c2f2f; --muted:#6d6458; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.45 "Iowan Old Style", Palatino, "Palatino Linotype", serif; }
  header, main { width:min(1100px, calc(100% - 32px)); margin:0 auto; }
  header { padding:28px 0 12px; border-bottom:1px solid var(--ink); display:flex; justify-content:space-between; gap:16px; align-items:end; }
  h1 { font-weight:500; font-size:40px; letter-spacing:-0.03em; margin:0; }
  h1 span { color:var(--muted); font-size:18px; margin-left:8px; }
  .badges { display:flex; gap:8px; flex-wrap:wrap; font-family:ui-monospace, "IBM Plex Mono", monospace; font-size:12px; }
  .badge { border:1px solid var(--ink); padding:4px 8px; }
  main { padding:22px 0 64px; display:grid; gap:22px; }
  .grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; }
  .card { border-top:1px solid var(--ink); padding-top:8px; }
  .card b { display:block; font-family:ui-monospace, monospace; font-size:22px; font-weight:500; }
  .card span, p.note { color:var(--muted); font-size:13px; }
  table { width:100%; border-collapse:collapse; font-family:ui-monospace, monospace; font-size:13px; }
  th { text-align:left; font-weight:500; color:var(--muted); border-bottom:1px solid var(--ink); padding:6px 8px; }
  td { padding:7px 8px; border-bottom:1px solid var(--rule); vertical-align:top; }
  .up { color:var(--up); } .down { color:var(--down); }
  form { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; align-items:end; }
  label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
  input, select, button { font:14px ui-monospace, monospace; padding:8px; border:1px solid var(--ink); background:transparent; color:inherit; }
  button { cursor:pointer; background:var(--ink); color:var(--paper); }
  pre { white-space:pre-wrap; word-break:break-word; background:#fffdf8; border:1px solid var(--rule); padding:12px; font:12px/1.45 ui-monospace, monospace; }
  @media (max-width:800px) { .grid, form { grid-template-columns:1fr 1fr; } h1 { font-size:32px; } }
  @media (max-width:520px) { .grid, form { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>Omnis <span>Celo FX desk</span></h1>
    <p class="note">Dry-run by default. Convert builds unsigned transactions for the wallet you name. Omnis does not hold user funds.</p>
  </div>
  <div class="badges" id="badges">loading</div>
</header>
<main>
  <section class="grid" id="stats"></section>
  <section>
    <h2>Scanned routes</h2>
    <div id="routes">Waiting for the first scan.</div>
  </section>
  <section>
    <h2>Quotes we would make</h2>
    <div id="mm">No inventory quotes yet.</div>
  </section>
  <section>
    <h2>Naira basis</h2>
    <div id="basis">Not in this scan.</div>
  </section>
  <section>
    <h2>Convert</h2>
    <form id="convert">
      <label>From<input name="from" value="USDT" required /></label>
      <label>To<input name="to" value="wBRL" required /></label>
      <label>Amount<input name="amount" value="100" required /></label>
      <label>API key<input name="key" placeholder="from API_KEYS" required /></label>
      <button type="submit">Quote best route</button>
    </form>
    <pre id="quote">Submit a pair. The fee, if configured, is an exact transfer to the treasury that you sign yourself.</pre>
  </section>
</main>
<script>
const money = (n) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : (n < 0 ? '-' : '') + Math.abs(n).toFixed(4);
const el = (id) => document.getElementById(id);
function table(headers, rows) {
  if (!rows.length) return '<p class="note">Nothing in this scan.</p>';
  return '<table><thead><tr>' + headers.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
async function refresh() {
  const res = await fetch('/status');
  if (!res.ok) { el('routes').textContent = 'Status unavailable (' + res.status + ').'; return; }
  const body = await res.json();
  const cycle = body.lastCycle;
  el('badges').innerHTML = [
    body.mode, body.killSwitch ? 'kill switch' : 'risk on',
    cycle ? cycle.quoteSource : 'no scan', body.signer
  ].map((item) => '<span class="badge">' + item + '</span>').join('');
  const best = cycle && cycle.best;
  const cards = [
    ['Best net edge', best ? money(best.netEdgeUsd) : '—', best ? best.netEdgeBps.toFixed(1) + ' bps' : 'awaiting scan'],
    ['Decision', cycle ? cycle.decision.action : '—', cycle ? cycle.decision.reason : ''],
    ['Equity', money(body.paper && body.paper.equityUsd), 'realized ' + money(body.paper && body.paper.realizedUsd)],
    ['Convert fee', body.config.convertFeeBps + ' bps', body.config.treasury || 'no treasury'],
  ];
  el('stats').innerHTML = cards.map((card) => '<div class="card"><span>' + card[0] + '</span><b class="' + (String(card[1]).startsWith('-') ? 'down' : 'up') + '">' + card[1] + '</b><span>' + card[2] + '</span></div>').join('');
  el('routes').innerHTML = cycle ? table(['Pair', 'Route', 'Size', 'Net USD', 'Net bps'], cycle.opportunities.map((opp) => [
    opp.corridor, opp.route, money(opp.sizeUsd), '<span class="' + (opp.netEdgeUsd >= 0 ? 'up' : 'down') + '">' + money(opp.netEdgeUsd) + '</span>', opp.netEdgeBps.toFixed(1)
  ])) : 'Waiting for the first scan.';
  el('mm').innerHTML = cycle ? table(['Pair', 'Bid', 'Mid', 'Ask', 'Skew bps', 'Inventory'], cycle.mmQuotes.map((q) => [
    q.corridor, q.bidUsd.toFixed(6), q.midUsd.toFixed(6), q.askUsd.toFixed(6), String(q.skewBps), money(q.inventoryUsd)
  ])) : '';
  const basis = cycle && cycle.basis && cycle.basis[0];
  el('basis').innerHTML = basis ? '<p>' + basis.left + ' vs ' + basis.right + '. Gap <b>' + (basis.gapBps === null ? 'n/a' : basis.gapBps.toFixed(1) + ' bps') + '</b>. ' + basis.note + '</p>' : 'Not in this scan.';
}
document.getElementById('convert').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const params = new URLSearchParams({ from: data.get('from'), to: data.get('to'), amount: data.get('amount') });
  el('quote').textContent = 'Quoting…';
  const res = await fetch('/convert/quote?' + params.toString(), { headers: { authorization: 'Bearer ' + data.get('key') } });
  const body = await res.json();
  el('quote').textContent = JSON.stringify(body, null, 2);
});
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`
}

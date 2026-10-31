import 'dotenv/config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { parseArgs } from 'node:util'
import {
  gapStats, medianIntervalSec, routeStats, scanSummary, shadowStats, venueHealth, type GapRow, type OppRow, type ShadowRow,
} from '../analysis/edges.js'

const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    hours: { type: 'string' },
    top: { type: 'string', default: '15' },
    'include-fixture': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
})

const dbPath = args.db ?? join(process.env.DATA_DIR ?? './data', 'omnis.db')
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Run the desk first, or pass --db <path>.`)
  process.exit(1)
}
const hours = args.hours === undefined ? null : Number(args.hours)
if (hours !== null && !(hours > 0)) {
  console.error('--hours must be a positive number')
  process.exit(1)
}
const top = Math.max(1, Number(args.top) || 15)
const since = hours === null ? '' : new Date(Date.now() - hours * 3_600_000).toISOString()
const sources = args['include-fixture'] ? ['live', 'fixture'] : ['live']
const db = new DatabaseSync(dbPath, { readOnly: true })

function rows(sql: string): Record<string, SQLOutputValue>[] {
  return db.prepare(sql).all(since, ...sources) as Record<string, SQLOutputValue>[]
}
const sourceFilter = `quote_source IN (${sources.map(() => '?').join(', ')})`
const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

const scanRows = rows(`SELECT ts, payload FROM scans WHERE ts >= ? AND ${sourceFilter} ORDER BY ts`)
const scanTimes = scanRows.map((row) => String(row.ts))
const scanErrors = scanRows.map((row) => {
  try {
    const errors = (JSON.parse(String(row.payload)) as { errors?: { venue: string; message: string }[] }).errors
    return Array.isArray(errors) ? errors : []
  } catch {
    return []
  }
})
const opps: OppRow[] = hasTable('opportunities')
  ? rows(`SELECT ts, corridor, buy_venue, sell_venue, size_usd, net_usd, net_bps FROM opportunities WHERE ts >= ? AND ${sourceFilter}`).map((row) => ({
      ts: String(row.ts),
      corridor: String(row.corridor),
      buyVenue: String(row.buy_venue),
      sellVenue: String(row.sell_venue),
      sizeUsd: Number(row.size_usd),
      netUsd: Number(row.net_usd),
      netBps: Number(row.net_bps),
    }))
  : []
const gaps: GapRow[] = hasTable('reference_gaps')
  ? rows(`SELECT ts, corridor, venue, side, gap_bps, ref_as_of FROM reference_gaps WHERE ts >= ? AND ${sourceFilter}`).map((row) => ({
      ts: String(row.ts),
      corridor: String(row.corridor),
      venue: String(row.venue),
      side: String(row.side),
      gapBps: Number(row.gap_bps),
      refAsOf: String(row.ref_as_of),
    }))
  : []
const num = (value: SQLOutputValue | undefined) => (value === null || value === undefined ? null : Number(value))
const str = (value: SQLOutputValue | undefined) => (value === null || value === undefined ? null : String(value))
// Shadow runs only ever use live quotes, so they take the time filter alone.
const shadowRows: ShadowRow[] = hasTable('shadow_trades')
  ? (db.prepare(`SELECT corridor, buy_venue, sell_venue, size_usd, scan_net_bps, outcome, net_usd, net_bps, buy_status, sell_status,
      buy_drift_bps, sell_drift_bps, textile_status, textile_detail, elapsed_ms FROM shadow_trades WHERE ts >= ?`).all(since) as Record<string, SQLOutputValue>[])
      .map((row) => ({
        corridor: String(row.corridor),
        buyVenue: String(row.buy_venue),
        sellVenue: String(row.sell_venue),
        sizeUsd: Number(row.size_usd),
        scanNetBps: Number(row.scan_net_bps),
        outcome: String(row.outcome),
        netUsd: num(row.net_usd),
        netBps: num(row.net_bps),
        buyStatus: String(row.buy_status),
        sellStatus: str(row.sell_status),
        buyDriftBps: num(row.buy_drift_bps),
        sellDriftBps: num(row.sell_drift_bps),
        textileStatus: str(row.textile_status),
        textileDetail: str(row.textile_detail),
        elapsedMs: Number(row.elapsed_ms),
      }))
  : []
const refSource = hasTable('reference_gaps')
  ? (db.prepare('SELECT ref_source FROM reference_gaps ORDER BY id DESC LIMIT 1').get() as { ref_source?: SQLOutputValue } | undefined)?.ref_source
  : undefined
db.close()

const interval = medianIntervalSec(scanTimes)
const summary = scanSummary(opps, scanTimes)
const routes = routeStats(opps, scanTimes)
const reference = gapStats(gaps)
const health = venueHealth(scanErrors)
const shadow = shadowStats(shadowRows)

if (args.json) {
  console.log(JSON.stringify({ db: dbPath, since: since || null, sources, intervalSec: interval, summary, routes, reference, health, shadow, refSource: refSource ?? null }, null, 2))
  process.exit(0)
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const bp = (value: number | null) => (value === null ? '—' : value.toFixed(1))
const usd = (value: number | null) => (value === null ? '—' : value.toFixed(4))
const minutes = (scans: number) => (interval === null ? `${scans} scans` : `${scans} (~${Math.round((scans * interval) / 60)} min)`)

function table(headers: string[], body: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...body.map((row) => row[i]!.length)))
  const line = (cells: string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ')
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...body.map(line)].join('\n')
}

console.log(`\nOmnis edge report · ${dbPath}`)
if (scanTimes.length === 0) {
  console.log(`No ${sources.join('/')} scans${since ? ` since ${since}` : ''}. Let the desk run, then try again.`)
  process.exit(0)
}
console.log(`Window: ${scanTimes[0]} → ${scanTimes[scanTimes.length - 1]} · ${summary.scans} scans` +
  `${interval === null ? '' : ` about every ${Math.round(interval)}s`} · quotes: ${sources.join(', ')}`)

console.log('\nVenue health')
if (health.length === 0) {
  console.log('  No venue errors recorded.')
} else {
  for (const row of health) {
    console.log(`  ${row.venue}: errors in ${row.scansWithErrors} of ${summary.scans} scans (${pct(row.scansWithErrors / summary.scans)}), ${row.errors} total. Most common: ${row.topMessage}`)
  }
}

console.log('\nPool-vs-pool round trips (net of gas and the adverse cushion)')
console.log(`  Scans with any positive edge:   ${summary.scansWithPositive} of ${summary.scans} (${pct(summary.scansWithPositive / summary.scans)})`)
console.log(`  Scans with an edge ≥ 10 bps:    ${summary.scansOver10Bps} of ${summary.scans} (${pct(summary.scansOver10Bps / summary.scans)})`)
console.log(`  Upper bound, best edge per scan filled at its quote: $${summary.capturableUsd.toFixed(2)}`)
if (summary.best) {
  console.log(`  Best scan: ${summary.best.route} net $${usd(summary.best.netUsd)} (${bp(summary.best.netBps)} bps) at ${summary.best.ts}`)
}

console.log(`\nRoutes, top ${Math.min(top, routes.length)} of ${routes.length} by best net bps`)
console.log(table(
  ['Route', 'Seen', '>0', '≥5bp', '≥10bp', '≥25bp', 'Median', 'p90', 'Max', 'Best $', 'Episodes', 'Longest run'],
  routes.slice(0, top).map((row) => [
    row.route, String(row.observations), pct(row.positiveShare), pct(row.over5Share), pct(row.over10Share), pct(row.over25Share),
    bp(row.medianBps), bp(row.p90Bps), bp(row.maxBps), usd(row.bestNetUsd), String(row.episodes), minutes(row.longestRunScans),
  ]),
))

console.log('\nShadow execution: the best route walked as live mode would, re-priced at that moment, never signed')
if (shadow.runs === 0) {
  console.log('  No shadow runs. Start the desk with SHADOW=1.')
} else {
  const outcomeText = Object.entries(shadow.outcomes).map(([outcome, count]) => `${outcome} ${count} (${pct(count / shadow.runs)})`).join(', ')
  console.log(`  Runs: ${shadow.runs} · ${outcomeText}`)
  console.log(`  Would-fill net, summed: $${shadow.wouldFillNetUsd.toFixed(2)} · median re-priced net ${bp(shadow.medianNetBps)} bps`)
  console.log(`  Edge lost between scan and execution, median: ${bp(shadow.medianDecayBps)} bps · median walk time ${shadow.medianElapsedMs === null ? '—' : Math.round(shadow.medianElapsedMs)} ms`)
  console.log(table(
    ['Route', 'Runs', 'Would fill', 'Median net', 'Best $'],
    shadow.routes.slice(0, top).map((row) => [row.route, String(row.runs), pct(row.wouldFillShare), bp(row.medianNetBps), usd(row.bestNetUsd)]),
  ))
  console.log(table(
    ['Leg venue', 'Side', 'Runs', 'Median drift', 'p10 drift'],
    shadow.drift.map((row) => [row.venue, row.side, String(row.runs), bp(row.medianBps), bp(row.p10Bps)]),
  ))
  if (shadow.textile.length) {
    console.log('  Textile leg: ' + shadow.textile.map((row) => `${row.status} ${row.runs}${row.topDetail ? ` (${row.topDetail})` : ''}`).join(' · '))
  }
  console.log('  Drift is the leg\'s rate now against the rate the scan saw; negative moved against us.')
}

console.log(`\nOn-chain price vs fiat reference${refSource ? ` (${String(refSource)})` : ''}, smallest clip, before gas`)
if (reference.length === 0) {
  console.log('  No reference rows. Check FX_REFERENCE_URL and the desk logs.')
} else {
  console.log(table(
    ['Corridor', 'Venue', 'Side', 'Seen', 'Median', 'p10', 'p90', 'Max', '≥25bp', '≥50bp', 'Ref as of'],
    reference.map((row) => [
      row.corridor, row.venue, row.side, String(row.observations), bp(row.medianBps), bp(row.p10Bps), bp(row.p90Bps), bp(row.maxBps),
      pct(row.over25Share), pct(row.over50Share), row.latestRefAsOf.slice(0, 16),
    ]),
  ))
  console.log('  Positive = the on-chain side beats the reference rate. The reference is a once-a-day rate, so this shows')
  console.log('  lasting premiums and discounts, not intraday lag. ARS and NGN references are official rates.')
}
console.log('')

import type { SQLOutputValue, StatementSync } from 'node:sqlite'
import type { GapRow, OppRow, ShadowRow } from './edges.js'

/** The part of node:sqlite's DatabaseSync these loaders use, so a read-only handle and the desk's Store both fit. */
export interface Queryable {
  prepare(sql: string): StatementSync
}

type Row = Record<string, SQLOutputValue>

const num = (value: SQLOutputValue | undefined) => (value === null || value === undefined ? null : Number(value))
const str = (value: SQLOutputValue | undefined) => (value === null || value === undefined ? null : String(value))

function hasTable(db: Queryable, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

export interface AnalysisRows {
  scanTimes: string[]
  scanErrors: { venue: string; message: string }[][]
  /** Best net edge per scan, after the cushion. Null when a scan priced no round trip. */
  scanEdges: { ts: string; bps: number | null }[]
  opps: OppRow[]
  gaps: GapRow[]
  /** Shadow runs only ever use live quotes, so they take the time filter alone. */
  shadow: ShadowRow[]
}

/** Every row the edge analysis needs since `since` (ISO; '' for all), for the given quote sources. */
export function loadAnalysisRows(db: Queryable, since: string, sources: string[]): AnalysisRows {
  const filter = `quote_source IN (${sources.map(() => '?').join(', ')})`
  const all = (sql: string) => db.prepare(sql).all(since, ...sources) as Row[]
  const scans = all(`SELECT ts, best_edge_bps, payload FROM scans WHERE ts >= ? AND ${filter} ORDER BY ts`)
  return {
    scanTimes: scans.map((row) => String(row.ts)),
    scanErrors: scans.map((row) => {
      try {
        const errors = (JSON.parse(String(row.payload)) as { errors?: { venue: string; message: string }[] }).errors
        return Array.isArray(errors) ? errors : []
      } catch {
        return []
      }
    }),
    scanEdges: scans.map((row) => ({ ts: String(row.ts), bps: num(row.best_edge_bps) })),
    opps: hasTable(db, 'opportunities')
      ? all(`SELECT ts, corridor, buy_venue, sell_venue, size_usd, net_usd, net_bps FROM opportunities WHERE ts >= ? AND ${filter}`).map((row) => ({
          ts: String(row.ts),
          corridor: String(row.corridor),
          buyVenue: String(row.buy_venue),
          sellVenue: String(row.sell_venue),
          sizeUsd: Number(row.size_usd),
          netUsd: Number(row.net_usd),
          netBps: Number(row.net_bps),
        }))
      : [],
    gaps: hasTable(db, 'reference_gaps')
      ? all(`SELECT ts, corridor, venue, side, gap_bps, ref_as_of FROM reference_gaps WHERE ts >= ? AND ${filter}`).map((row) => ({
          ts: String(row.ts),
          corridor: String(row.corridor),
          venue: String(row.venue),
          side: String(row.side),
          gapBps: Number(row.gap_bps),
          refAsOf: String(row.ref_as_of),
        }))
      : [],
    shadow: hasTable(db, 'shadow_trades')
      ? (db.prepare(`SELECT corridor, buy_venue, sell_venue, size_usd, scan_net_bps, outcome, net_usd, net_bps, buy_status, sell_status,
          buy_drift_bps, sell_drift_bps, textile_status, textile_detail, elapsed_ms FROM shadow_trades WHERE ts >= ?`).all(since) as Row[])
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
      : [],
  }
}

export interface ShadowLogRow {
  ts: string
  corridor: string
  buyVenue: string
  sellVenue: string
  sizeUsd: number
  scanNetBps: number
  outcome: string
  netUsd: number | null
  netBps: number | null
  legs: { venue: string; tokenIn: string; tokenOut: string; status: string; driftBps: number | null; latencyMs: number; built: boolean; detail: string }[]
}

/** The most recent shadow runs with their legs, newest first. */
export function loadShadowLog(db: Queryable, limit: number): ShadowLogRow[] {
  if (!hasTable(db, 'shadow_trades')) return []
  return (db.prepare('SELECT ts, payload FROM shadow_trades ORDER BY id DESC LIMIT ?').all(limit) as Row[]).flatMap((row) => {
    try {
      const payload = JSON.parse(String(row.payload)) as Omit<ShadowLogRow, 'ts'>
      return [{
        ts: String(row.ts),
        corridor: payload.corridor,
        buyVenue: payload.buyVenue,
        sellVenue: payload.sellVenue,
        sizeUsd: payload.sizeUsd,
        scanNetBps: payload.scanNetBps,
        outcome: payload.outcome,
        netUsd: payload.netUsd,
        netBps: payload.netBps,
        legs: (payload.legs ?? []).map((leg) => ({
          venue: leg.venue, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, status: leg.status,
          driftBps: leg.driftBps, latencyMs: leg.latencyMs, built: leg.built, detail: leg.detail,
        })),
      }]
    } catch {
      return []
    }
  })
}

/** Paper equity and realized P&L snapshots since `since`, oldest first. */
export function loadPnl(db: Queryable, since: string): { ts: string; equityUsd: number; realizedUsd: number }[] {
  return (db.prepare('SELECT ts, equity_usd_micros, realized_usd_micros FROM pnl_snapshots WHERE ts >= ? ORDER BY ts').all(since) as Row[])
    .map((row) => ({ ts: String(row.ts), equityUsd: Number(row.equity_usd_micros) / 1e6, realizedUsd: Number(row.realized_usd_micros) / 1e6 }))
}

/** At most `max` points, keeping the largest value in each time bucket so a short spike survives the thinning. */
export function thinToMax<T extends { ts: string }>(points: T[], max: number, value: (point: T) => number | null): T[] {
  if (points.length <= max) return points
  const size = Math.ceil(points.length / max)
  const out: T[] = []
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size)
    out.push(bucket.reduce((best, point) => ((value(point) ?? -Infinity) > (value(best) ?? -Infinity) ? point : best)))
  }
  return out
}

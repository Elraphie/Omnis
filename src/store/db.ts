import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { Queryable } from '../analysis/load.js'
import { jsonSafe } from '../util.js'

function asBigint(value: SQLOutputValue | undefined): bigint {
  if (value === null || value === undefined) return 0n
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value !== '') return BigInt(value)
  return 0n
}

function asString(value: SQLOutputValue | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

export interface TradeRow {
  id: number
  ts: string
  mode: string
  strategy: string
  pair: string
  venuePath: string
  sizeUsd: number
  pnlUsd: number
  payload: string
}

export interface UsageRow {
  keyId: string
  endpoint: string
  count: number
}

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        mode TEXT NOT NULL,
        quote_source TEXT NOT NULL,
        best_edge_usd REAL,
        best_edge_bps REAL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        strategy TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        mode TEXT NOT NULL,
        strategy TEXT NOT NULL,
        pair TEXT NOT NULL,
        venue_path TEXT NOT NULL,
        size_usd REAL NOT NULL,
        pnl_usd_micros INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pnl_snapshots (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        equity_usd_micros INTEGER NOT NULL,
        realized_usd_micros INTEGER NOT NULL,
        unrealized_usd_micros INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        key_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        pair TEXT,
        amount TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS balances (
        symbol TEXT PRIMARY KEY,
        amount TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        quote_source TEXT NOT NULL,
        corridor TEXT NOT NULL,
        buy_venue TEXT NOT NULL,
        sell_venue TEXT NOT NULL,
        size_usd REAL NOT NULL,
        gross_usd REAL NOT NULL,
        gas_usd REAL NOT NULL,
        buffer_usd REAL NOT NULL,
        net_usd REAL NOT NULL,
        net_bps REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS opportunities_ts ON opportunities (ts);
      CREATE TABLE IF NOT EXISTS reference_gaps (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        quote_source TEXT NOT NULL,
        corridor TEXT NOT NULL,
        venue TEXT NOT NULL,
        side TEXT NOT NULL,
        size_usd REAL NOT NULL,
        onchain_per_usd REAL NOT NULL,
        ref_per_usd REAL NOT NULL,
        gap_bps REAL NOT NULL,
        ref_source TEXT NOT NULL,
        ref_as_of TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reference_gaps_ts ON reference_gaps (ts);
      CREATE TABLE IF NOT EXISTS shadow_trades (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        corridor TEXT NOT NULL,
        buy_venue TEXT NOT NULL,
        sell_venue TEXT NOT NULL,
        size_usd REAL NOT NULL,
        scan_net_usd REAL NOT NULL,
        scan_net_bps REAL NOT NULL,
        outcome TEXT NOT NULL,
        net_usd REAL,
        net_bps REAL,
        buy_status TEXT NOT NULL,
        sell_status TEXT,
        buy_drift_bps REAL,
        sell_drift_bps REAL,
        textile_status TEXT,
        textile_detail TEXT,
        all_built INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `)
  }

  private batch(run: () => void): void {
    this.db.exec('BEGIN')
    try {
      run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  /** Read access for the analysis loaders in src/analysis/load.ts. */
  get reader(): Queryable {
    return this.db
  }

  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v?: SQLOutputValue } | undefined
    return row?.v === undefined || row.v === null ? null : String(row.v)
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value)
  }

  seedPaper(usdtAtomic: bigint): void {
    const existing = this.db.prepare('SELECT COUNT(*) AS n FROM balances').get() as { n?: SQLOutputValue }
    if (asBigint(existing?.n) > 0n) return
    this.setBalance('USDT', usdtAtomic)
    this.setKv('starting_equity_micros', usdtAtomic.toString())
    this.setKv('realized_usd_micros', '0')
  }

  balance(symbol: string): bigint {
    const row = this.db.prepare('SELECT amount FROM balances WHERE symbol = ?').get(symbol) as { amount?: SQLOutputValue } | undefined
    return asBigint(row?.amount)
  }

  setBalance(symbol: string, amount: bigint): void {
    if (amount < 0n) throw new Error(`refusing negative ${symbol} balance`)
    this.db.prepare('INSERT INTO balances (symbol, amount) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET amount = excluded.amount').run(symbol, amount.toString())
  }

  balances(): Record<string, bigint> {
    const rows = this.db.prepare('SELECT symbol, amount FROM balances').all() as { symbol: SQLOutputValue; amount: SQLOutputValue }[]
    const out: Record<string, bigint> = {}
    for (const row of rows) out[asString(row.symbol)] = asBigint(row.amount)
    return out
  }

  realized(): bigint {
    return asBigint(this.getKv('realized_usd_micros') ?? '0')
  }

  addRealized(delta: bigint): void {
    this.setKv('realized_usd_micros', (this.realized() + delta).toString())
  }

  startingEquity(): bigint {
    return asBigint(this.getKv('starting_equity_micros') ?? '0')
  }

  manualKill(): boolean {
    return this.getKv('manual_kill') === '1'
  }

  setManualKill(on: boolean): void {
    this.setKv('manual_kill', on ? '1' : '0')
  }

  lossStopDay(): string | null {
    return this.getKv('loss_stop_day')
  }

  setLossStopDay(day: string | null): void {
    if (!day) this.db.prepare('DELETE FROM kv WHERE k = ?').run('loss_stop_day')
    else this.setKv('loss_stop_day', day)
  }

  dailyRealized(day: string): bigint {
    const rows = this.db.prepare(`SELECT pnl_usd_micros FROM trades WHERE substr(ts, 1, 10) = ?`).all(day) as { pnl_usd_micros: SQLOutputValue }[]
    return rows.reduce((sum, row) => sum + asBigint(row.pnl_usd_micros), 0n)
  }

  insertScan(row: { ts: string; mode: string; quoteSource: string; bestEdgeUsd: number | null; bestEdgeBps: number | null; payload: unknown }): void {
    this.db.prepare('INSERT INTO scans (ts, mode, quote_source, best_edge_usd, best_edge_bps, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
      row.ts, row.mode, row.quoteSource, row.bestEdgeUsd, row.bestEdgeBps, jsonSafe(row.payload),
    )
  }

  /** Every scanned round trip, not just the best, so edge frequency per route can be measured later. */
  insertOpportunities(ts: string, quoteSource: string, rows: {
    corridor: string; buyVenue: string; sellVenue: string; sizeUsd: number
    grossUsd: number; gasUsd: number; bufferUsd: number; netUsd: number; netBps: number
  }[]): void {
    if (rows.length === 0) return
    const insert = this.db.prepare('INSERT INTO opportunities (ts, quote_source, corridor, buy_venue, sell_venue, size_usd, gross_usd, gas_usd, buffer_usd, net_usd, net_bps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.batch(() => {
      for (const row of rows) {
        insert.run(ts, quoteSource, row.corridor, row.buyVenue, row.sellVenue, row.sizeUsd, row.grossUsd, row.gasUsd, row.bufferUsd, row.netUsd, row.netBps)
      }
    })
  }

  insertReferenceGaps(ts: string, quoteSource: string, ref: { source: string; asOf: string }, rows: {
    corridor: string; venue: string; side: string; sizeUsd: number; onchainPerUsd: number; refPerUsd: number; gapBps: number
  }[]): void {
    if (rows.length === 0) return
    const insert = this.db.prepare('INSERT INTO reference_gaps (ts, quote_source, corridor, venue, side, size_usd, onchain_per_usd, ref_per_usd, gap_bps, ref_source, ref_as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.batch(() => {
      for (const row of rows) {
        insert.run(ts, quoteSource, row.corridor, row.venue, row.side, row.sizeUsd, row.onchainPerUsd, row.refPerUsd, row.gapBps, ref.source, ref.asOf)
      }
    })
  }

  insertShadow(ts: string, row: {
    corridor: string; buyVenue: string; sellVenue: string; sizeUsd: number; scanNetUsd: number; scanNetBps: number
    outcome: string; netUsd: number | null; netBps: number | null; elapsedMs: number
    legs: { venue: string; status: string; driftBps: number | null; built: boolean; detail: string }[]
  }): void {
    const [buy, sell] = row.legs
    const textile = row.legs.find((leg) => leg.venue === 'textile-rfq')
    // A Textile preview has no calldata to build; only the on-chain legs and a firm Textile leg count.
    const allBuilt = row.legs.length === 2 && row.legs.every((leg) => leg.built || leg.status === 'preview_only')
    this.db.prepare(`INSERT INTO shadow_trades (ts, corridor, buy_venue, sell_venue, size_usd, scan_net_usd, scan_net_bps, outcome, net_usd, net_bps,
      buy_status, sell_status, buy_drift_bps, sell_drift_bps, textile_status, textile_detail, all_built, elapsed_ms, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ts, row.corridor, row.buyVenue, row.sellVenue, row.sizeUsd, row.scanNetUsd, row.scanNetBps, row.outcome, row.netUsd, row.netBps,
      buy?.status ?? 'error', sell?.status ?? null, buy?.driftBps ?? null, sell?.driftBps ?? null,
      textile?.status ?? null, textile?.detail || null, allBuilt ? 1 : 0, row.elapsedMs, jsonSafe(row),
    )
  }

  insertDecision(row: { ts: string; strategy: string; action: string; reason: string; payload: unknown }): void {
    this.db.prepare('INSERT INTO decisions (ts, strategy, action, reason, payload) VALUES (?, ?, ?, ?, ?)').run(
      row.ts, row.strategy, row.action, row.reason, jsonSafe(row.payload),
    )
  }

  insertTrade(row: { ts: string; mode: string; strategy: string; pair: string; venuePath: string; sizeUsd: number; pnlUsdMicros: bigint; payload: unknown }): void {
    this.db.prepare('INSERT INTO trades (ts, mode, strategy, pair, venue_path, size_usd, pnl_usd_micros, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.ts, row.mode, row.strategy, row.pair, row.venuePath, row.sizeUsd, row.pnlUsdMicros, jsonSafe(row.payload),
    )
  }

  insertPnl(row: { ts: string; equityUsdMicros: bigint; realizedUsdMicros: bigint; unrealizedUsdMicros: bigint }): void {
    this.db.prepare('INSERT INTO pnl_snapshots (ts, equity_usd_micros, realized_usd_micros, unrealized_usd_micros) VALUES (?, ?, ?, ?)').run(
      row.ts, row.equityUsdMicros, row.realizedUsdMicros, row.unrealizedUsdMicros,
    )
  }

  recordUsage(row: { ts: string; keyId: string; endpoint: string; pair?: string; amount?: string }): void {
    this.db.prepare('INSERT INTO usage (ts, key_id, endpoint, pair, amount) VALUES (?, ?, ?, ?, ?)').run(
      row.ts, row.keyId, row.endpoint, row.pair ?? null, row.amount ?? null,
    )
  }

  recentTrades(limit: number): TradeRow[] {
    const rows = this.db.prepare('SELECT id, ts, mode, strategy, pair, venue_path, size_usd, pnl_usd_micros, payload FROM trades ORDER BY id DESC LIMIT ?').all(limit) as Record<string, SQLOutputValue>[]
    return rows.map((row) => ({
      id: Number(row.id),
      ts: asString(row.ts),
      mode: asString(row.mode),
      strategy: asString(row.strategy),
      pair: asString(row.pair),
      venuePath: asString(row.venue_path),
      sizeUsd: Number(row.size_usd),
      pnlUsd: Number(asBigint(row.pnl_usd_micros)) / 1e6,
      payload: asString(row.payload),
    }))
  }

  usageSummary(): UsageRow[] {
    const rows = this.db.prepare('SELECT key_id, endpoint, COUNT(*) AS n FROM usage GROUP BY key_id, endpoint ORDER BY n DESC').all() as Record<string, SQLOutputValue>[]
    return rows.map((row) => ({ keyId: asString(row.key_id), endpoint: asString(row.endpoint), count: Number(row.n) }))
  }

  counts(): { scans: number; trades: number; decisions: number } {
    const one = (sql: string) => Number(asBigint((this.db.prepare(sql).get() as { n?: SQLOutputValue }).n))
    return {
      scans: one('SELECT COUNT(*) AS n FROM scans'),
      trades: one('SELECT COUNT(*) AS n FROM trades'),
      decisions: one('SELECT COUNT(*) AS n FROM decisions'),
    }
  }
}

import { gapStats, routeStats, scanSummary, shadowStats, venueHealth } from '../analysis/edges.js'
import { loadAnalysisRows, loadPnl, loadShadowLog, thinToMax } from '../analysis/load.js'
import { publicConfig, type AppConfig } from '../config/load.js'
import { CONTRACTS, TOKENS } from '../config/tokens.js'
import type { CycleReport } from '../execution/engine.js'
import { killReason } from '../risk/guards.js'
import type { Store } from '../store/db.js'
import { utcDay } from '../util.js'

export const DASHBOARD_HOURS = [6, 24, 72, 168] as const

export interface WalletView {
  address: string
  balances: Record<string, string>
  checkedAt: string
}

/** Everything the desk page shows, for one time window. Pure reads; nothing here moves state. */
export function buildDashboard(args: {
  cfg: AppConfig
  store: Store
  report: CycleReport | null
  hours: number
  startedAt: number
  now?: number
  wallet: WalletView | null
}) {
  const now = args.now ?? Date.now()
  const since = new Date(now - args.hours * 3_600_000).toISOString()
  const db = args.store.reader
  const rows = loadAnalysisRows(db, since, ['live'])
  const killed = killReason(args.cfg.killSwitch || args.store.manualKill(), args.store.lossStopDay(), utcDay(new Date(now)))
  const report = args.report
  const nextScanAt = report ? new Date(Date.parse(report.ts) + args.cfg.intervalSec * 1000).toISOString() : null
  const paper = report?.paper ?? null
  return {
    service: 'omnis',
    version: '2.0.0',
    now: new Date(now).toISOString(),
    startedAt: new Date(args.startedAt).toISOString(),
    uptimeSec: Math.round((now - args.startedAt) / 1000),
    mode: args.cfg.mode,
    killSwitch: Boolean(killed),
    killReason: killed,
    config: {
      ...publicConfig(args.cfg),
      minTradeUsd: Number(args.cfg.minTradeUsdMicros) / 1e6,
      ladder: args.cfg.ladderBps.map((bps) => bps / 10_000),
      shadowMinNetBps: Number(args.cfg.shadowMinNetBps),
    },
    wallet: args.wallet,
    lastCycle: report && {
      ts: report.ts,
      quoteSource: report.quoteSource,
      elapsedMs: report.elapsedMs,
      quoteCount: report.quoteCount,
      decision: report.decision,
      best: report.best,
      opportunities: report.opportunities,
      venueErrors: report.venueErrors,
      shadow: report.shadow,
      basis: report.basis,
    },
    nextScanAt,
    paper: paper && { ...paper, startingEquityUsd: Number(args.store.startingEquity()) / 1e6 },
    window: { hours: args.hours, since },
    summary: scanSummary(rows.opps, rows.scanTimes),
    health: venueHealth(rows.scanErrors),
    routes: routeStats(rows.opps, rows.scanTimes).slice(0, 12),
    reference: gapStats(rows.gaps),
    shadow: shadowStats(rows.shadow),
    series: {
      edge: thinToMax(rows.scanEdges, 360, (point) => point.bps),
      pnl: thinToMax(loadPnl(db, since), 360, (point) => point.realizedUsd),
    },
    shadowLog: loadShadowLog(db, 25),
    trades: args.store.recentTrades(15),
    contracts: [
      { label: 'Textile FX LimitOrderReactor', address: CONTRACTS.textileReactor },
      { label: 'Uniswap v3 SwapRouter02', address: CONTRACTS.uniRouter },
      { label: 'Uniswap v3 QuoterV2', address: CONTRACTS.uniQuoter },
      { label: 'Mento Broker', address: CONTRACTS.mentoBroker },
      { label: 'Mento v3 Router', address: CONTRACTS.mentoRouter },
      ...(['USDT', 'wBRL', 'wARS', 'cNGN', 'NGNm'] as const).map((symbol) => ({ label: symbol, address: TOKENS[symbol].address })),
    ],
  }
}

export type Dashboard = ReturnType<typeof buildDashboard>

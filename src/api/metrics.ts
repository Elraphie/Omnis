export interface MetricSnapshot {
  up: number
  mode: string
  killSwitch: number
  scans: number
  trades: number
  decisions: number
  bestEdgeBps: number | null
  equityUsd: number | null
  realizedUsd: number | null
  convertQuotes: number
  convertBuilds: number
  quoteSource: string
}

export function renderMetrics(snapshot: MetricSnapshot): string {
  const lines = [
    '# HELP omnis_up Process is serving.',
    '# TYPE omnis_up gauge',
    'omnis_up 1',
    '# HELP omnis_kill_switch Manual or daily-loss kill switch.',
    '# TYPE omnis_kill_switch gauge',
    `omnis_kill_switch ${snapshot.killSwitch}`,
    '# HELP omnis_scans_total Scan cycles recorded.',
    '# TYPE omnis_scans_total counter',
    `omnis_scans_total ${snapshot.scans}`,
    '# HELP omnis_trades_total Paper or live fills recorded.',
    '# TYPE omnis_trades_total counter',
    `omnis_trades_total ${snapshot.trades}`,
    '# HELP omnis_decisions_total Strategy decisions recorded.',
    '# TYPE omnis_decisions_total counter',
    `omnis_decisions_total ${snapshot.decisions}`,
    '# HELP omnis_convert_quotes_total Convert quotes metered.',
    '# TYPE omnis_convert_quotes_total counter',
    `omnis_convert_quotes_total ${snapshot.convertQuotes}`,
    '# HELP omnis_convert_builds_total Convert transaction bundles metered.',
    '# TYPE omnis_convert_builds_total counter',
    `omnis_convert_builds_total ${snapshot.convertBuilds}`,
  ]
  if (snapshot.bestEdgeBps !== null) {
    lines.push('# HELP omnis_last_best_edge_bps Net edge of the best scanned route.', '# TYPE omnis_last_best_edge_bps gauge', `omnis_last_best_edge_bps ${snapshot.bestEdgeBps}`)
  }
  if (snapshot.equityUsd !== null) {
    lines.push('# HELP omnis_equity_usd Mark-to-market equity.', '# TYPE omnis_equity_usd gauge', `omnis_equity_usd ${snapshot.equityUsd}`)
  }
  if (snapshot.realizedUsd !== null) {
    lines.push('# HELP omnis_realized_pnl_usd Realized paper or live P&L.', '# TYPE omnis_realized_pnl_usd gauge', `omnis_realized_pnl_usd ${snapshot.realizedUsd}`)
  }
  lines.push(`# mode ${snapshot.mode}`, `# quote_source ${snapshot.quoteSource}`)
  return `${lines.join('\n')}\n`
}

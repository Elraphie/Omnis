import 'dotenv/config'
import { join } from 'node:path'
import { createSigner, createReader } from '../chain/client.js'
import { loadConfig } from '../config/load.js'
import { createLogger } from '../log/logger.js'
import { formatUsd } from '../pricing/math.js'
import { referenceFeedFor, runDeskCycle, shadowRunnerFor } from '../runtime.js'
import { Store } from '../store/db.js'

const log = createLogger('omnis')
const loaded = loadConfig()
if (loaded.privateKeyPresent && loaded.cfg.mode !== 'live') {
  log.warn('AGENT_PRIVATE_KEY is present and will not be used. Read-only and paper paths do not sign.')
}
const store = new Store(join(loaded.cfg.dataDir, 'omnis.db'))
const client = createReader(loaded.cfg.rpcUrl)
const signer = createSigner(loaded.cfg, loaded.secrets, client)
if (loaded.cfg.mode === 'live' && !signer.canSign) {
  throw new Error('MODE=live requires a signer that can sign')
}

const report = await runDeskCycle({
  cfg: loaded.cfg,
  store,
  client: loaded.cfg.quoteSource === 'fixture' ? null : client,
  signer,
  shadow: shadowRunnerFor(loaded.cfg, loaded.secrets),
  reference: referenceFeedFor(loaded.cfg, (message) => log.warn('reference rates unavailable', { message })),
})
store.close()
const best = report.best
log.info('cycle complete', {
  mode: report.mode,
  quoteSource: report.quoteSource,
  decision: report.decision.action,
  reason: report.decision.reason,
  bestEdgeUsd: best ? best.netEdgeUsd : null,
  bestEdgeBps: best ? best.netEdgeBps : null,
  quotes: report.quoteCount,
  trade: report.trade,
  equityUsd: report.paper.equityUsd,
  realizedUsd: report.paper.realizedUsd,
})
console.log(`\nOmnis ${report.mode} · quotes ${report.quoteSource} · ${report.quoteCount} prices · ${report.elapsedMs}ms`)
console.log(`Decision: ${report.decision.action} — ${report.decision.reason}`)
if (best) {
  console.log(`Best: ${best.corridor} ${best.route} size ${formatUsd(BigInt(Math.round(best.sizeUsd * 1e6)))} net ${best.netEdgeUsd.toFixed(4)} USD (${best.netEdgeBps.toFixed(2)} bps)`)
} else {
  console.log('Best: no route')
}
if (report.basis[0]) {
  const basis = report.basis[0]
  console.log(`Naira basis: ${basis.left} vs ${basis.right} gap ${basis.gapBps ?? 'n/a'} bps (tradable ${basis.tradable})`)
}
if (report.shadow) {
  const shadow = report.shadow
  const net = shadow.netUsd === null ? 'n/a' : `${shadow.netUsd.toFixed(4)} USD (${shadow.netBps} bps)`
  console.log(`Shadow: ${shadow.outcome} ${shadow.corridor} ${shadow.buyVenue} -> ${shadow.sellVenue} $${shadow.sizeUsd} net ${net}; the scan said ${shadow.scanNetBps} bps`)
  for (const leg of shadow.legs) {
    const drift = leg.driftBps === null ? 'n/a' : `${leg.driftBps.toFixed(1)} bps`
    console.log(`  ${leg.venue} ${leg.tokenIn}->${leg.tokenOut}: ${leg.status}, drift ${drift}, ${leg.latencyMs}ms${leg.built ? ', calldata built' : ''}${leg.detail ? ` · ${leg.detail}` : ''}`)
  }
}
if (report.trade) console.log(`Paper fill: ${report.trade.strategy} ${report.trade.pair} pnl ${report.trade.pnlUsd.toFixed(4)}`)
if (report.venueErrors.length) console.log(`Venue errors: ${report.venueErrors.length} (see logs)`)
console.log(`Equity ${report.paper.equityUsd.toFixed(4)} · realized ${report.paper.realizedUsd.toFixed(4)}`)

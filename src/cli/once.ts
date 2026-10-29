import 'dotenv/config'
import { join } from 'node:path'
import { createSigner, createReader } from '../chain/client.js'
import { loadConfig } from '../config/load.js'
import { createLogger } from '../log/logger.js'
import { formatUsd } from '../pricing/math.js'
import { referenceFeedFor, runDeskCycle } from '../runtime.js'
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
if (report.trade) console.log(`Paper fill: ${report.trade.strategy} ${report.trade.pair} pnl ${report.trade.pnlUsd.toFixed(4)}`)
if (report.venueErrors.length) console.log(`Venue errors: ${report.venueErrors.length} (see logs)`)
console.log(`Equity ${report.paper.equityUsd.toFixed(4)} · realized ${report.paper.realizedUsd.toFixed(4)}`)

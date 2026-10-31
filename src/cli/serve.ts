import 'dotenv/config'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { startServer } from '../api/server.js'
import { RateLimiter } from '../api/rate-limit.js'
import { createReader, createSigner } from '../chain/client.js'
import { loadConfig } from '../config/load.js'
import type { CycleReport } from '../execution/engine.js'
import { createLogger } from '../log/logger.js'
import { createConvertApi, referenceFeedFor, runDeskCycle, shadowRunnerFor } from '../runtime.js'
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
  throw new Error('MODE=live requires a signer that can sign. Attach a KMS adapter or provide AGENT_PRIVATE_KEY with CONFIRM_LIVE=I_UNDERSTAND.')
}
const convert = createConvertApi({ cfg: loaded.cfg, client: loaded.cfg.quoteSource === 'fixture' ? null : client })
const reference = referenceFeedFor(loaded.cfg, (message) => log.warn('reference rates unavailable', { message }))
const shadow = shadowRunnerFor(loaded.cfg, loaded.secrets)
if (shadow) {
  log.info('shadow execution on', {
    maxPerHour: loaded.cfg.shadowMaxPerHour,
    textileLeg: loaded.secrets.shadowTakerKey ? 'firm quote' : 'preview only',
    shadowWallet: loaded.secrets.shadowTakerKey ? privateKeyToAccount(loaded.secrets.shadowTakerKey).address : null,
  })
}
let report: CycleReport | null = null
let running = false

async function cycle() {
  if (running) return
  running = true
  try {
    report = await runDeskCycle({
      cfg: loaded.cfg,
      store,
      client: loaded.cfg.quoteSource === 'fixture' ? null : client,
      signer,
      reference,
      shadow,
    })
    log.info('scan', {
      quoteSource: report.quoteSource,
      decision: report.decision.action,
      reason: report.decision.reason,
      bestEdgeBps: report.best?.netEdgeBps ?? null,
      quotes: report.quoteCount,
      referenceGaps: report.referenceGaps.length,
      shadow: report.shadow
        ? `${report.shadow.outcome} ${report.shadow.corridor} ${report.shadow.buyVenue}->${report.shadow.sellVenue} net ${report.shadow.netBps ?? 'n/a'} bps`
        : null,
      errors: report.venueErrors.length,
    })
  } catch (error) {
    log.error('scan failed', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    running = false
  }
}

const server = startServer({
  cfg: loaded.cfg,
  store,
  limiter: new RateLimiter(loaded.cfg.rateLimitPerMin),
  getReport: () => report,
  quoteConvert: (from, to, amount) => convert.quote(from, to, amount),
  buildConvert: (body) => convert.build(body),
})

server.listen(loaded.cfg.port, loaded.cfg.host, () => {
  log.info('listening', { host: loaded.cfg.host, port: loaded.cfg.port, mode: loaded.cfg.mode, signer: signer.kind })
})

if (loaded.cfg.startupDelaySec > 0) {
  log.info('startup delay', { seconds: loaded.cfg.startupDelaySec })
  await new Promise((resolve) => setTimeout(resolve, loaded.cfg.startupDelaySec * 1000))
}
await cycle()
const timer = setInterval(() => { void cycle() }, loaded.cfg.intervalSec * 1000)

function shutdown() {
  clearInterval(timer)
  server.close()
  store.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

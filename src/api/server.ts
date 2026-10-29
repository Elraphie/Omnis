import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { authenticateApiKey, publicConfig, type AppConfig } from '../config/load.js'
import { parseConvertAmount, type ConvertQuote } from '../convert/service.js'
import type { CycleReport } from '../execution/engine.js'
import type { Store } from '../store/db.js'
import { utcDay } from '../util.js'
import { corsHeaders } from './cors.js'
import { renderMetrics } from './metrics.js'
import { statusPage } from './page.js'
import { RateLimiter } from './rate-limit.js'
import { killReason } from '../risk/guards.js'

export interface ServerDeps {
  cfg: AppConfig
  store: Store
  limiter: RateLimiter
  getReport: () => CycleReport | null
  quoteConvert: (from: string, to: string, amount: string) => Promise<ConvertQuote>
  buildConvert: (body: unknown) => Promise<unknown>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 20_000) {
        reject(new Error('Body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Desk internals: P&L, balances, limits, treasury, key usage. Operators only unless PUBLIC_STATUS=1. */
const OPS_PATHS = new Set(['/status', '/trades', '/pnl', '/metrics'])

function presentedKey(req: IncomingMessage): string | undefined {
  return (typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined)
    ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined)
}

/** Null when the caller holds an admin key, otherwise the reason it was refused. */
function adminDenied(header: string | undefined, cfg: AppConfig): string | null {
  if (cfg.adminKeys.length === 0) return 'admin endpoints are disabled until ADMIN_KEYS is set'
  return authenticateApiKey(header, cfg.adminKeys).ok ? null : 'missing or invalid admin key'
}

function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string>, contentType = 'application/json; charset=utf-8'): void {
  res.writeHead(code, { 'content-type': contentType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

export function createHandler(deps: ServerDeps) {
  const started = Date.now()
  return async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    const cors = corsHeaders(origin, deps.cfg.corsOrigins, host)
    if (!cors) {
      send(res, 403, { error: 'origin is not allowed' }, {})
      return
    }
    if (req.method === 'OPTIONS') {
      send(res, 204, '', cors, 'text/plain')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const header = presentedKey(req)
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        send(res, 200, statusPage(), cors, 'text/html; charset=utf-8')
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        const report = deps.getReport()
        send(res, 200, {
          ok: true,
          service: 'omnis',
          mode: deps.cfg.mode,
          uptimeSec: Math.round((Date.now() - started) / 1000),
          lastScanAt: report?.ts ?? null,
          quoteSource: report?.quoteSource ?? null,
        }, cors)
        return
      }
      if (OPS_PATHS.has(url.pathname) && !deps.cfg.publicStatus) {
        const denied = adminDenied(header, deps.cfg)
        if (denied) {
          send(res, 401, { error: denied }, cors)
          return
        }
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const report = deps.getReport()
        const today = utcDay()
        const killed = killReason(deps.cfg.killSwitch || deps.store.manualKill(), deps.store.lossStopDay(), today)
        send(res, 200, {
          service: 'omnis',
          version: '2.0.0',
          mode: deps.cfg.mode,
          signer: deps.cfg.signerKind,
          killSwitch: Boolean(killed),
          killReason: killed,
          config: publicConfig(deps.cfg),
          lastCycle: report,
          paper: report?.paper ?? null,
          usage: deps.store.usageSummary(),
          recentTrades: deps.store.recentTrades(20),
          counts: deps.store.counts(),
        }, cors)
        return
      }
      if (req.method === 'GET' && url.pathname === '/trades') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 500)
        send(res, 200, deps.store.recentTrades(Number.isFinite(limit) ? limit : 50), cors)
        return
      }
      if (req.method === 'GET' && url.pathname === '/pnl') {
        send(res, 200, {
          realizedUsd: Number(deps.store.realized()) / 1e6,
          startingEquityUsd: Number(deps.store.startingEquity()) / 1e6,
          balances: Object.fromEntries(Object.entries(deps.store.balances()).map(([symbol, amount]) => [symbol, amount.toString()])),
          dailyRealizedUsd: Number(deps.store.dailyRealized(utcDay())) / 1e6,
        }, cors)
        return
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        const report = deps.getReport()
        const usage = deps.store.usageSummary()
        const killed = killReason(deps.cfg.killSwitch || deps.store.manualKill(), deps.store.lossStopDay(), utcDay())
        const counts = deps.store.counts()
        send(res, 200, renderMetrics({
          up: 1,
          mode: deps.cfg.mode,
          killSwitch: killed ? 1 : 0,
          scans: counts.scans,
          trades: counts.trades,
          decisions: counts.decisions,
          bestEdgeBps: report?.best?.netEdgeBps ?? null,
          equityUsd: report?.paper.equityUsd ?? null,
          realizedUsd: report?.paper.realizedUsd ?? null,
          convertQuotes: usage.filter((row) => row.endpoint === 'quote').reduce((sum, row) => sum + row.count, 0),
          convertBuilds: usage.filter((row) => row.endpoint === 'build').reduce((sum, row) => sum + row.count, 0),
          quoteSource: report?.quoteSource ?? 'none',
        }), cors, 'text/plain; version=0.0.4; charset=utf-8')
        return
      }

      // Admin keys are separate from Convert keys and are not rate limited, so a busy
      // dashboard can never lock an operator out of the kill switch.
      if (url.pathname.startsWith('/admin')) {
        const denied = adminDenied(header, deps.cfg)
        if (denied) {
          send(res, 401, { error: denied }, cors)
          return
        }
        if (req.method === 'POST' && url.pathname === '/admin/kill') {
          const body = JSON.parse((await readBody(req)) || '{}') as { enabled?: boolean }
          deps.store.setManualKill(body.enabled !== false)
          send(res, 200, { killSwitch: deps.store.manualKill() }, cors)
          return
        }
      }

      if (url.pathname.startsWith('/convert')) {
        if (deps.cfg.apiKeys.length === 0) {
          send(res, 401, { error: 'Convert is disabled until API_KEYS is set' }, cors)
          return
        }
        const auth = authenticateApiKey(header, deps.cfg.apiKeys)
        if (!auth.ok) {
          send(res, 401, { error: 'missing or invalid API key' }, cors)
          return
        }
        const limit = deps.limiter.take(auth.keyId)
        if (!limit.ok) {
          send(res, 429, { error: 'rate limit exceeded' }, { ...cors, 'retry-after': String(limit.retryAfterSec) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/convert/quote') {
          const from = url.searchParams.get('from') ?? ''
          const to = url.searchParams.get('to') ?? ''
          const amount = url.searchParams.get('amount') ?? ''
          parseConvertAmount(from, amount, deps.cfg.maxConvertUsdMicros)
          const quote = await deps.quoteConvert(from, to, amount)
          deps.store.recordUsage({ ts: new Date().toISOString(), keyId: auth.keyId, endpoint: 'quote', pair: `${from}/${to}`, amount })
          send(res, 200, quote, cors)
          return
        }
        if (req.method === 'POST' && url.pathname === '/convert/build') {
          const body = JSON.parse((await readBody(req)) || '{}') as { from?: string; to?: string; amount?: string }
          const built = await deps.buildConvert(body)
          deps.store.recordUsage({
            ts: new Date().toISOString(),
            keyId: auth.keyId,
            endpoint: 'build',
            pair: `${body.from ?? ''}/${body.to ?? ''}`,
            amount: body.amount,
          })
          send(res, 200, built, cors)
          return
        }
      }
      send(res, 404, { error: 'not found' }, cors)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(res, 400, { error: message }, cors)
    }
  }
}

export function startServer(deps: ServerDeps) {
  const handler = createHandler(deps)
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  return server
}

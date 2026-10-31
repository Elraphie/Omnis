import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { thinToMax } from '../src/analysis/load.js'
import { buildDashboard } from '../src/api/dashboard.js'
import { statusPage } from '../src/api/page.js'
import { RateLimiter } from '../src/api/rate-limit.js'
import { createHandler } from '../src/api/server.js'
import { loadConfig } from '../src/config/load.js'
import { runCycle, type CycleReport } from '../src/execution/engine.js'
import { usdToMicros } from '../src/pricing/math.js'
import { Store } from '../src/store/db.js'
import { fixtureAdapters } from '../src/venues/fixture.js'

async function seeded(quoteSource: 'live' | 'fixture') {
  const cfg = loadConfig({ MODE: 'paper', MAX_TRADE_USD: '100', MIN_TRADE_USD: '10', SIZE_LADDER: '1,0.5', ADMIN_KEYS: 'omnis_admin_key_1' }).cfg
  const store = new Store(':memory:')
  const report = await runCycle({
    cfg, store, adapters: fixtureAdapters('profitable'), gasPriceWei: 5_000_000_000n, celoUsdMicros: usdToMicros(0.3), quoteSource,
    reference: { source: 'test', asOf: new Date().toISOString(), perUsd: { USD: 1, BRL: 5.4, NGN: 1368, ARS: 1200 } },
  })
  return { cfg, store, report }
}

describe('dashboard data', () => {
  it('summarises the window from live scans only', async () => {
    const { cfg, store, report } = await seeded('live')
    const dash = buildDashboard({ cfg, store, report, hours: 24, startedAt: Date.now() - 60_000, wallet: null })
    expect(dash.mode).toBe('paper')
    expect(dash.summary.scans).toBe(1)
    expect(dash.summary.scansWithPositive).toBe(1)
    expect(dash.series.edge).toHaveLength(1)
    expect(dash.series.pnl.length).toBeGreaterThan(0)
    expect(dash.routes.length).toBeGreaterThan(0)
    expect(dash.reference.length).toBeGreaterThan(0)
    expect(dash.trades).toHaveLength(1)
    expect(dash.lastCycle?.opportunities.length).toBeGreaterThan(0)
    expect(dash.nextScanAt).toBe(new Date(Date.parse(report.ts) + cfg.intervalSec * 1000).toISOString())
    expect(dash.contracts.some((c) => c.label === 'wARS')).toBe(true)
    expect(() => JSON.stringify(dash)).not.toThrow()

    const fixture = await seeded('fixture')
    const fixtureDash = buildDashboard({ cfg: fixture.cfg, store: fixture.store, report: fixture.report, hours: 24, startedAt: Date.now(), wallet: null })
    expect(fixtureDash.summary.scans).toBe(0)
    expect(fixtureDash.series.edge).toEqual([])
    store.close()
    fixture.store.close()
  })

  it('thins long series without losing a spike', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ ts: new Date(i * 1000).toISOString(), v: i === 503 ? 99 : 0 }))
    const thin = thinToMax(points, 100, (p) => p.v)
    expect(thin).toHaveLength(100)
    expect(thin.some((p) => p.v === 99)).toBe(true)
    expect(thinToMax(points.slice(0, 5), 100, (p) => p.v)).toHaveLength(5)
  })
})

describe('dashboard endpoint and page', () => {
  it('is admin-gated, caches, and falls back to 24 hours', async () => {
    const { cfg, store, report } = await seeded('live')
    let walletCalls = 0
    const handler = createHandler({
      cfg, store, limiter: new RateLimiter(10), getReport: () => report as CycleReport,
      quoteConvert: async () => { throw new Error('unused') }, buildConvert: async () => ({}),
      wallet: async () => { walletCalls += 1; return { address: '0x8De805f7b95c12396EB851E39e18dDCb73eA7C93', balances: { USDT: '0' }, checkedAt: new Date().toISOString() } },
    })
    const server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const admin = { authorization: 'Bearer omnis_admin_key_1' }
    try {
      expect((await fetch(`${base}/dashboard`)).status).toBe(401)
      const first = await fetch(`${base}/dashboard?hours=999`, { headers: admin })
      expect(first.status).toBe(200)
      const body = await first.json() as { window: { hours: number }; wallet: { address: string } }
      expect(body.window.hours).toBe(24)
      expect(body.wallet.address).toMatch(/^0x8De8/)
      await fetch(`${base}/dashboard?hours=24`, { headers: admin })
      expect(walletCalls).toBe(1)
      const week = await fetch(`${base}/dashboard?hours=168`, { headers: admin })
      expect(((await week.json()) as { window: { hours: number } }).window.hours).toBe(168)
      const page = await (await fetch(`${base}/`)).text()
      expect(page).toContain('Corridor scanner')
      expect(page).toContain('/dashboard?hours=')
    } finally {
      store.close()
      await new Promise((resolve) => server.close(() => resolve(null)))
    }
  })

  it('ships a page whose script parses and never writes data as HTML', () => {
    const html = statusPage()
    const script = html.split('<script>')[1]!.split('</script>')[0]!
    expect(() => new Function(script)).not.toThrow()
    expect(script).not.toContain('innerHTML')
  })
})

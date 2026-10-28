import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createHandler } from '../src/api/server.js'
import { RateLimiter } from '../src/api/rate-limit.js'
import { loadConfig } from '../src/config/load.js'
import { Store } from '../src/store/db.js'
import { originAllowed } from '../src/api/cors.js'
import { renderMetrics } from '../src/api/metrics.js'

function listen(handler: ReturnType<typeof createHandler>) {
  const server = createServer((req, res) => { void handler(req, res) })
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

describe('config validation', () => {
  it('defaults to dry-run with no key and no fee', () => {
    const loaded = loadConfig({})
    expect(loaded.cfg.mode).toBe('dry-run')
    expect(loaded.cfg.signerKind).toBe('readonly')
    expect(loaded.secrets.agentPrivateKey).toBeUndefined()
    expect(loaded.cfg.convertFeeBps).toBe(0n)
    expect(loaded.cfg).not.toHaveProperty('agentPrivateKey')
  })

  it('rejects wildcard cors, a fee without a treasury, live without confirmation, and a hot key in kms mode', () => {
    expect(() => loadConfig({ CORS_ORIGINS: '*' })).toThrow(/wildcard/)
    expect(() => loadConfig({ CONVERT_FEE_BPS: '8' })).toThrow(/TREASURY_ADDRESS/)
    expect(() => loadConfig({ MODE: 'live', AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` })).toThrow(/CONFIRM_LIVE/)
    expect(() => loadConfig({ SIGNER_KIND: 'kms', AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` })).toThrow(/KMS/)
    expect(() => loadConfig({ API_KEYS: 'short' })).toThrow(/API_KEYS/)
    expect(() => loadConfig({ ATTRIBUTION_TAG: 'Has-Dash' })).toThrow(/ATTRIBUTION_TAG/)
  })
})

describe('http api', () => {
  it('requires a key, rate limits, and keeps cors tight', async () => {
    expect(originAllowed(undefined, [], '127.0.0.1:1')).toBe(true)
    expect(originAllowed('https://evil.example', ['http://127.0.0.1:43123'], '127.0.0.1:43123')).toBe(false)
    expect(originAllowed('*', [], undefined)).toBe(false)

    const loaded = loadConfig({
      API_KEYS: 'omnis_test_key_1',
      CORS_ORIGINS: 'http://allowed.example',
      CONVERT_FEE_BPS: '8',
      TREASURY_ADDRESS: '0x000000000000000000000000000000000000dEaD',
    })
    const store = new Store(':memory:')
    const handler = createHandler({
      cfg: loaded.cfg,
      store,
      limiter: new RateLimiter(2),
      getReport: () => null,
      quoteConvert: async (from, to, amount) => ({
        from, to, amountIn: amount, feeBps: 8, feeToken: from, feeAmount: '0.08', swapAmount: '99.92',
        treasury: loaded.cfg.treasury, feeAtomic: false, routes: [], best: { venue: 'uniswap-v3', amountOut: '1', minAmountOut: '0.995' },
        advantageBps: null,
      }),
      buildConvert: async () => ({ ok: true }),
    })
    const server = await listen(handler)
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/health`)
      expect(health.status).toBe(200)
      const blocked = await fetch(`http://127.0.0.1:${server.port}/health`, { headers: { origin: 'https://evil.example' } })
      expect(blocked.status).toBe(403)
      const allowed = await fetch(`http://127.0.0.1:${server.port}/status`, { headers: { origin: 'http://allowed.example' } })
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('access-control-allow-origin')).toBe('http://allowed.example')
      const open = await fetch(`http://127.0.0.1:${server.port}/convert/quote?from=USDT&to=wBRL&amount=100`)
      expect(open.status).toBe(401)
      const headers = { authorization: 'Bearer omnis_test_key_1' }
      const first = await fetch(`http://127.0.0.1:${server.port}/convert/quote?from=USDT&to=wBRL&amount=100`, { headers })
      const second = await fetch(`http://127.0.0.1:${server.port}/convert/quote?from=USDT&to=wBRL&amount=100`, { headers })
      const third = await fetch(`http://127.0.0.1:${server.port}/convert/quote?from=USDT&to=wBRL&amount=100`, { headers })
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(third.status).toBe(429)
      const body = await first.json() as { feeAmount: string; swapAmount: string }
      expect(body.feeAmount).toBe('0.08')
      expect(body.swapAmount).toBe('99.92')
      expect(store.usageSummary()).toEqual(expect.arrayContaining([expect.objectContaining({ endpoint: 'quote', count: 2 })]))
      const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`)
      expect(await metrics.text()).toContain('omnis_up 1')
      const page = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(await page.text()).toContain('Omnis')
    } finally {
      store.close()
      await server.close()
    }
  })

  it('renders a kill-switch gauge', () => {
    const text = renderMetrics({
      up: 1, mode: 'dry-run', killSwitch: 1, scans: 2, trades: 0, decisions: 2,
      bestEdgeBps: -1.5, equityUsd: 1000, realizedUsd: 0, convertQuotes: 0, convertBuilds: 0, quoteSource: 'fixture',
    })
    expect(text).toContain('omnis_kill_switch 1')
    expect(text).toContain('omnis_last_best_edge_bps -1.5')
  })
})

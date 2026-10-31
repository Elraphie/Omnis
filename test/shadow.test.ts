import { verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { shadowStats, type ShadowRow } from '../src/analysis/edges.js'
import { loadConfig } from '../src/config/load.js'
import { CONTRACTS, token, type VenueId } from '../src/config/tokens.js'
import { runCycle } from '../src/execution/engine.js'
import { shadowArb, shadowBudget, shadowCandidate, type ShadowDeps, type ShadowResult } from '../src/execution/shadow.js'
import { usdToMicros } from '../src/pricing/math.js'
import type { ArbOpportunity } from '../src/strategies/arbitrage.js'
import { Store } from '../src/store/db.js'
import { fixtureAdapters } from '../src/venues/fixture.js'
import { probeTextileFirm, takerProofText } from '../src/venues/textile.js'
import type { QuoteRequest, VenueAdapter, VenueQuote } from '../src/venues/types.js'

const KEY = `0x${'42'.repeat(32)}` as const
const NONCE = `0x${'ab'.repeat(32)}`
const GAS: Record<VenueId, bigint> = { 'uniswap-v3': 180_000n, 'textile-rfq': 280_000n, 'mento-broker': 220_000n, 'mento-v3': 220_000n }

/** 1 USDT buys 1,500 wARS on Uniswap; Textile buys wARS back at 1.002 USDT per 1,500. */
function adapter(id: VenueId, price: (request: QuoteRequest) => bigint | null): VenueAdapter {
  return {
    id,
    chainId: 42220,
    supports: () => true,
    async quote(request): Promise<VenueQuote | null> {
      const amountOut = price(request)
      if (amountOut === null) return null
      return {
        venue: id, chainId: 42220, tokenIn: request.tokenIn, tokenOut: request.tokenOut, amountIn: request.amountIn, amountOut,
        firm: false, gasUnits: GAS[id], quotedAt: Date.now(), meta: id === 'uniswap-v3' ? { feeTier: 500 } : {},
      }
    },
  }
}
const uniswap = adapter('uniswap-v3', (request) => request.amountIn * 1500n * 10n ** 12n)
const textile = adapter('textile-rfq', (request) => (request.amountIn * 1002n) / 1_500_000_000_000_000_000n)

const opp: ArbOpportunity = {
  corridor: 'wARS', buyVenue: 'uniswap-v3', sellVenue: 'textile-rfq',
  sizeUsdMicros: 100_000_000n, amountIn: 100_000_000n, midAmount: 150_000n * 10n ** 18n, amountOut: 100_200_000n,
  buyFirm: false, sellFirm: false,
  grossUsdMicros: 200_000n, gasUsdMicros: 690n, adverseUsdMicros: 40_000n, netUsdMicros: 159_310n, netBps: 15n,
}

function deps(extra: Partial<ShadowDeps> = {}): ShadowDeps {
  return {
    adapters: [uniswap, textile], slippageBps: 30n, gasPriceWei: 5_000_000_000n, celoUsdMicros: usdToMicros(0.3),
    timeoutMs: 1000, textileApi: 'https://textile.test', takerSigner: null, randomNonce: () => NONCE, ...extra,
  }
}

function textileApi(handler: (path: string, body: unknown) => { status: number; body: unknown }) {
  const calls: { path: string; headers: Record<string, string>; body: unknown }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path, headers: (init?.headers ?? {}) as Record<string, string>, body })
    const reply = handler(path, body)
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const quotedBody = (buyAmount: string) => ({
  data: {
    rfqId: 'rfq_1', claimToken: 'claim_1', status: 'quoted',
    quote: { buyAmount, feeAmount: '0', expiresAt: '2026-10-31T00:01:00Z', reactor: CONTRACTS.textileReactor, spender: CONTRACTS.textileReactor },
    transactions: { approval: { to: token('wARS').address, data: '0x01' }, swap: { to: CONTRACTS.textileReactor, data: '0xabcdef' } },
  },
})

describe('textile firm probe', () => {
  it('signs the exact proof text and always releases the quote', async () => {
    const signer = privateKeyToAccount(KEY)
    const api = textileApi((path) => (path.endsWith('/cancel') ? { status: 200, body: { data: { status: 'cancelled' } } } : { status: 200, body: quotedBody('99800000') }))
    const result = await probeTextileFirm({
      apiBase: 'https://textile.test/', signer, sellToken: token('wARS').address, buyToken: token('USDT').address, sellAmount: 5n,
      expectedReactor: CONTRACTS.textileReactor, timeoutMs: 1000, randomNonce: () => NONCE, fetchImpl: api.fetchImpl,
    })
    expect(result.status).toBe('quoted')
    const request = api.calls[0]!
    expect(request.path).toBe('/v2/rfq/request')
    const proof = (request.body as { takerProof: { nonce: string; issuedAt: number; signature: `0x${string}`; scheme: string } }).takerProof
    expect(proof.scheme).toBe('eip191')
    const text = takerProofText(signer.address, 42220, proof.nonce, proof.issuedAt)
    expect(text).toContain(`Wallet: ${signer.address.toLowerCase()}`)
    expect(text.split('\n')[4]).toBe('quote for it. This does not approve any transfer, trade or allowance.')
    expect(await verifyMessage({ address: signer.address, message: text, signature: proof.signature })).toBe(true)
    expect(api.calls[1]).toMatchObject({ path: '/v2/rfq/rfq_1/cancel', headers: { 'x-rfq-claim': 'claim_1' } })
  })

  it('reports a refusal such as insufficient funds without throwing', async () => {
    const api = textileApi(() => ({ status: 400, body: { error: { message: 'no', details: { reason: 'insufficient_funds' } } } }))
    const result = await probeTextileFirm({
      apiBase: 'https://textile.test', signer: privateKeyToAccount(KEY), sellToken: '0x1', buyToken: '0x2', sellAmount: 5n,
      expectedReactor: CONTRACTS.textileReactor, timeoutMs: 1000, randomNonce: () => NONCE, fetchImpl: api.fetchImpl,
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'insufficient_funds' })
    expect(api.calls).toHaveLength(1)
  })
})

describe('shadow execution', () => {
  it('re-prices both legs, sizes leg two from leg one\'s minimum, and builds the on-chain leg', async () => {
    const result = await shadowArb(opp, deps(), (venue) => GAS[venue])
    expect(result.outcome).toBe('would_fill')
    const [buy, sell] = result.legs
    expect(buy).toMatchObject({ venue: 'uniswap-v3', status: 'priced', built: true, amountOut: 150_000n * 10n ** 18n })
    expect(buy!.driftBps).toBeCloseTo(0, 9)
    // 30 bps under 150,000 wARS.
    expect(sell).toMatchObject({ venue: 'textile-rfq', status: 'preview_only', built: false, amountIn: 149_550n * 10n ** 18n, amountOut: 99_899_400n })
    expect(sell!.driftBps).toBeCloseTo(0, 6)
    // The unsold 450 wARS is marked at leg two's rate, so proceeds are 100.2 USDT; gas is 690 micro-USD.
    expect(result.netUsd).toBeCloseTo(0.19931, 9)
    expect(result.netBps).toBe(19)
    // Nothing moved, so the scan's net before the cushion matches what re-pricing found.
    expect(result.scanNetUsd).toBeCloseTo(0.19931, 9)
    expect(result.scanNetBps).toBe(result.netBps)
  })

  it('binds a firm Textile quote when a shadow wallet is configured', async () => {
    const api = textileApi((path) => (path.endsWith('/cancel') ? { status: 200, body: {} } : { status: 200, body: quotedBody('99800000') }))
    const result = await shadowArb(opp, deps({ takerSigner: privateKeyToAccount(KEY), fetchImpl: api.fetchImpl }), (venue) => GAS[venue])
    const sell = result.legs[1]!
    expect(sell).toMatchObject({ status: 'firm', built: true, amountOut: 99_800_000n, detail: '' })
    expect(sell.driftBps!).toBeLessThan(-9)
    expect(api.calls.map((call) => call.path)).toEqual(['/v2/rfq/request', '/v2/rfq/rfq_1/cancel'])
  })

  it('records a failed leg instead of guessing', async () => {
    const api = textileApi(() => ({ status: 400, body: { error: { details: { reason: 'insufficient_funds' } } } }))
    const result = await shadowArb(opp, deps({ takerSigner: privateKeyToAccount(KEY), fetchImpl: api.fetchImpl }), (venue) => GAS[venue])
    expect(result.outcome).toBe('leg_failed')
    expect(result.netUsd).toBeNull()
    expect(result.legs[1]).toMatchObject({ status: 'refused', detail: 'insufficient_funds' })

    const empty = await shadowArb(opp, deps({ adapters: [adapter('uniswap-v3', () => null), textile] }), (venue) => GAS[venue])
    expect(empty.outcome).toBe('leg_failed')
    expect(empty.legs).toHaveLength(1)
  })

  it('calls it edge_gone when re-pricing erases the gap', async () => {
    const worse = adapter('textile-rfq', (request) => (request.amountIn * 995n) / 1_500_000_000_000_000_000n)
    const result = await shadowArb(opp, deps({ adapters: [uniswap, worse] }), (venue) => GAS[venue])
    expect(result.outcome).toBe('edge_gone')
    expect(result.netUsd!).toBeLessThan(0)
  })

  it('budgets runs per rolling hour and picks the best candidate by dollars', () => {
    const allow = shadowBudget(2)
    expect([allow(0), allow(1), allow(2)]).toEqual([true, true, false])
    expect(allow(3_600_000)).toBe(true)
    const small = { ...opp, netUsdMicros: 10n, netBps: 1n }
    const negative = { ...opp, netUsdMicros: -5n, netBps: -1n }
    expect(shadowCandidate([small, opp, negative], 0n)).toBe(opp)
    expect(shadowCandidate([negative], 0n)).toBeNull()
    expect(shadowCandidate([negative], -2n)).toBe(negative)
  })
})

describe('shadow wiring', () => {
  const fake: ShadowResult = {
    corridor: 'wBRL', buyVenue: 'uniswap-v3', sellVenue: 'textile-rfq', sizeUsd: 100, scanNetUsd: 1, scanNetBps: 100,
    outcome: 'would_fill', netUsd: 0.5, netBps: 50, elapsedMs: 12,
    legs: [
      { venue: 'uniswap-v3', tokenIn: 'USDT', tokenOut: 'wBRL', amountIn: 1n, amountOut: 2n, status: 'priced', driftBps: -1, latencyMs: 3, built: true, detail: '' },
      { venue: 'textile-rfq', tokenIn: 'wBRL', tokenOut: 'USDT', amountIn: 2n, amountOut: 3n, status: 'preview_only', driftBps: -2, latencyMs: 4, built: false, detail: 'preview' },
    ],
  }
  const cfg = () => loadConfig({ MODE: 'dry-run', MAX_TRADE_USD: '100', MIN_TRADE_USD: '10', SIZE_LADDER: '1', SHADOW: '1' }).cfg

  it('shadows live-quote cycles, stores the run, and keeps the report JSON-safe', async () => {
    const store = new Store(':memory:')
    const seen: ArbOpportunity[] = []
    const report = await runCycle({
      cfg: cfg(), store, adapters: fixtureAdapters('profitable'), gasPriceWei: 5_000_000_000n, celoUsdMicros: usdToMicros(0.3),
      quoteSource: 'live', shadow: async (candidate) => { seen.push(candidate); return fake },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.corridor).toBe('wBRL')
    expect(report.shadow?.legs[0]?.amountOut).toBe('2')
    expect(() => JSON.stringify(report)).not.toThrow()
    const db = (store as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> } } }).db
    expect(db.prepare('SELECT outcome, buy_status, sell_status, textile_status, all_built FROM shadow_trades').get())
      .toEqual({ outcome: 'would_fill', buy_status: 'priced', sell_status: 'preview_only', textile_status: 'preview_only', all_built: 1 })
    store.close()
  })

  it('never shadows fixture quotes', async () => {
    const store = new Store(':memory:')
    let calls = 0
    const report = await runCycle({
      cfg: cfg(), store, adapters: fixtureAdapters('profitable'), gasPriceWei: 5_000_000_000n, celoUsdMicros: usdToMicros(0.3),
      quoteSource: 'fixture', shadow: async () => { calls += 1; return fake },
    })
    expect(calls).toBe(0)
    expect(report.shadow).toBeNull()
    store.close()
  })

  it('validates the shadow settings', () => {
    expect(() => loadConfig({ SHADOW: '1', MODE: 'live', CONFIRM_LIVE: 'I_UNDERSTAND', AGENT_PRIVATE_KEY: KEY })).toThrow(/dry-run and paper/)
    expect(() => loadConfig({ SHADOW: '1', SHADOW_TAKER_KEY: KEY, AGENT_PRIVATE_KEY: KEY })).toThrow(/not be the trading key/)
    expect(() => loadConfig({ SHADOW_TAKER_KEY: '0x12' })).toThrow(/32-byte/)
    expect(loadConfig({ SHADOW: '1', SHADOW_TAKER_KEY: KEY }).secrets.shadowTakerKey).toBe(KEY)
    expect(loadConfig({ SHADOW: '0', SHADOW_TAKER_KEY: KEY }).secrets.shadowTakerKey).toBeUndefined()
  })
})

describe('shadow stats', () => {
  const row = (outcome: string, netBps: number | null, scanNetBps: number, sellDriftBps: number | null, textileStatus: string | null): ShadowRow => ({
    corridor: 'wARS', buyVenue: 'uniswap-v3', sellVenue: 'textile-rfq', sizeUsd: 100, scanNetBps, outcome,
    netUsd: netBps === null ? null : netBps / 100, netBps, buyStatus: 'priced', sellStatus: textileStatus,
    buyDriftBps: 0, sellDriftBps, textileStatus, textileDetail: textileStatus === 'refused' ? 'insufficient_funds' : null, elapsedMs: 100,
  })

  it('summarises outcomes, decay, drift, and Textile status', () => {
    const stats = shadowStats([
      row('would_fill', 6, 9, -3, 'preview_only'),
      row('edge_gone', -2, 4, -6, 'preview_only'),
      row('leg_failed', null, 5, null, 'refused'),
    ])
    expect(stats.runs).toBe(3)
    expect(stats.outcomes).toEqual({ would_fill: 1, edge_gone: 1, leg_failed: 1 })
    expect(stats.wouldFillNetUsd).toBeCloseTo(0.06, 9)
    expect(stats.medianDecayBps).toBe(4.5)
    expect(stats.drift.find((entry) => entry.side === 'sell')).toMatchObject({ venue: 'textile-rfq', runs: 2, medianBps: -4.5 })
    expect(stats.textile).toEqual([
      { status: 'preview_only', runs: 2, topDetail: '' },
      { status: 'refused', runs: 1, topDetail: 'insufficient_funds' },
    ])
    expect(stats.routes[0]).toMatchObject({ runs: 3, wouldFillShare: 1 / 3, medianNetBps: 2 })
  })
})

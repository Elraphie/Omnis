import { describe, expect, it } from 'vitest'
import { gapStats, medianIntervalSec, quantile, routeStats, scanSummary, venueHealth, type OppRow } from '../src/analysis/edges.js'
import { loadConfig } from '../src/config/load.js'
import { runCycle } from '../src/execution/engine.js'
import { usdToMicros } from '../src/pricing/math.js'
import { createReferenceFeed, parseErApi, referenceGaps, type ReferenceRates } from '../src/reference/fx.js'
import type { PricedQuote } from '../src/strategies/arbitrage.js'
import { Store } from '../src/store/db.js'
import { fixtureAdapters } from '../src/venues/fixture.js'

const erBody = {
  result: 'success',
  base_code: 'USD',
  time_last_update_unix: 1_793_232_000,
  rates: { USD: 1, BRL: 5.35, NGN: 1346.2, EUR: 0.897, BAD: 'x' },
}

describe('reference rates', () => {
  it('parses ExchangeRate-API and drops junk', () => {
    const ref = parseErApi(erBody, 'open.er-api.com')
    expect(ref.perUsd.BRL).toBe(5.35)
    expect(ref.perUsd.BAD).toBeUndefined()
    expect(ref.asOf).toBe(new Date(1_793_232_000 * 1000).toISOString())
    expect(() => parseErApi({ result: 'error' }, 'x')).toThrow(/USD success/)
  })

  it('caches for the TTL and keeps the last good rates when a refresh fails', async () => {
    let calls = 0
    let fail = false
    const errors: string[] = []
    const feed = createReferenceFeed({
      url: 'https://open.er-api.com/v6/latest/USD',
      ttlMs: 1000,
      timeoutMs: 1000,
      onError: (message) => errors.push(message),
      fetchImpl: (async () => {
        calls += 1
        if (fail) throw new Error('offline')
        return new Response(JSON.stringify(erBody), { status: 200 })
      }) as typeof fetch,
    })
    expect((await feed.get(0))?.perUsd.BRL).toBe(5.35)
    await feed.get(500)
    expect(calls).toBe(1)
    fail = true
    expect((await feed.get(2000))?.perUsd.BRL).toBe(5.35)
    expect(calls).toBe(2)
    expect(errors).toEqual(['offline'])
  })

  it('returns null, not a throw, when there never were rates', async () => {
    const feed = createReferenceFeed({
      url: 'https://open.er-api.com/v6/latest/USD', ttlMs: 1000, timeoutMs: 1000,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    })
    expect(await feed.get()).toBeNull()
  })
})

describe('reference gaps', () => {
  const ref: ReferenceRates = { source: 'test', asOf: '2026-10-29T00:00:00.000Z', perUsd: { USD: 1, BRL: 5.0 } }
  const quote = (venue: PricedQuote['venue'], tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint): PricedQuote => ({
    venue, tokenIn, tokenOut, tokenInAddress: tokenIn, tokenOutAddress: tokenOut, amountIn, amountOut, firm: false, gasUnits: 0n,
  })

  it('signs gaps so positive means the chain beats the reference', () => {
    // 10 USDT buys 50.5 wBRL (5.05 per USD, 1% better than 5.00). Selling it back returns 10.05 USDT.
    const buy = quote('uniswap-v3', 'USDT', 'wBRL', 10_000_000n, 50_500_000_000_000_000_000n)
    const sell = quote('uniswap-v3', 'wBRL', 'USDT', 50_500_000_000_000_000_000n, 10_050_000n)
    const other = quote('uniswap-v3', 'USDT', 'wBRL', 20_000_000n, 100_000_000_000_000_000_000n)
    const gaps = referenceGaps({ corridors: [{ id: 'wBRL', base: 'wBRL' }], quotes: [buy, sell, other], reference: ref, sizeUsdMicros: 10_000_000n })
    expect(gaps).toHaveLength(2)
    const buyGap = gaps.find((gap) => gap.side === 'buy')!
    const sellGap = gaps.find((gap) => gap.side === 'sell')!
    expect(buyGap.onchainPerUsd).toBeCloseTo(5.05, 9)
    expect(buyGap.gapBps).toBeCloseTo(100, 6)
    // 50.5 wBRL for 10.05 USD is 5.0249 per USD; the reference wants 5.00, so selling on-chain loses about 50 bps.
    expect(sellGap.gapBps).toBeCloseTo((5.0 / (50.5 / 10.05) - 1) * 10_000, 6)
    expect(sellGap.gapBps).toBeLessThan(0)
  })

  it('skips corridors with no reference currency', () => {
    const buy = quote('uniswap-v3', 'USDT', 'wARS', 10_000_000n, 1n)
    expect(referenceGaps({ corridors: [{ id: 'wARS', base: 'wARS' }], quotes: [buy], reference: ref, sizeUsdMicros: 10_000_000n })).toEqual([])
  })
})

describe('edge analysis', () => {
  const times = ['2026-10-29T00:00:00.000Z', '2026-10-29T00:01:00.000Z', '2026-10-29T00:02:00.000Z', '2026-10-29T00:03:00.000Z']
  const row = (ts: string, netUsd: number, netBps: number, sellVenue = 'textile-rfq'): OppRow => ({
    ts, corridor: 'wBRL', buyVenue: 'uniswap-v3', sellVenue, sizeUsd: 100, netUsd, netBps,
  })
  const opps = [
    row(times[0]!, 0.2, 20), row(times[1]!, 0.15, 15), row(times[2]!, -0.1, -10), row(times[3]!, 0.05, 5),
    row(times[0]!, -0.3, -30, 'mento-v3'), row(times[3]!, 0.3, 30, 'mento-v3'),
  ]

  it('computes quantiles and scan spacing', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([], 0.5)).toBeNull()
    expect(medianIntervalSec(times)).toBe(60)
  })

  it('takes one best fill per scan for the upper bound', () => {
    const summary = scanSummary(opps, times)
    expect(summary.scans).toBe(4)
    expect(summary.scansWithPositive).toBe(3)
    expect(summary.scansOver10Bps).toBe(3)
    expect(summary.capturableUsd).toBeCloseTo(0.2 + 0.15 + 0.3, 9)
    expect(summary.best?.route).toBe('wBRL uniswap-v3->mento-v3 $100')
  })

  it('counts episodes and the longest positive run per route', () => {
    const textile = routeStats(opps, times).find((stats) => stats.route.endsWith('textile-rfq $100'))!
    expect(textile.observations).toBe(4)
    expect(textile.positiveShare).toBe(0.75)
    expect(textile.over10Share).toBe(0.5)
    expect(textile.episodes).toBe(2)
    expect(textile.longestRunScans).toBe(2)
    expect(textile.maxBps).toBe(20)
    expect(routeStats(opps, times)[0]!.route).toContain('mento-v3')
  })

  it('counts each venue once per failing scan', () => {
    const health = venueHealth([
      [{ venue: 'textile-rfq', message: 'timed out' }, { venue: 'textile-rfq', message: 'timed out' }],
      [],
      [{ venue: 'textile-rfq', message: 'HTTP 502' }, { venue: 'mento-broker', message: 'rpc down' }],
    ])
    expect(health[0]).toEqual({ venue: 'textile-rfq', scansWithErrors: 2, errors: 3, topMessage: 'timed out' })
    expect(health[1]).toMatchObject({ venue: 'mento-broker', scansWithErrors: 1, errors: 1 })
  })

  it('groups reference gaps by corridor, venue, and side', () => {
    const stats = gapStats([
      { ts: times[0]!, corridor: 'wBRL', venue: 'uniswap-v3', side: 'buy', gapBps: 10, refAsOf: 'a' },
      { ts: times[1]!, corridor: 'wBRL', venue: 'uniswap-v3', side: 'buy', gapBps: 60, refAsOf: 'b' },
      { ts: times[0]!, corridor: 'wBRL', venue: 'uniswap-v3', side: 'sell', gapBps: -5, refAsOf: 'a' },
    ])
    expect(stats).toHaveLength(2)
    expect(stats[0]).toMatchObject({ side: 'buy', observations: 2, medianBps: 35, maxBps: 60, over25Share: 0.5, over50Share: 0.5, latestRefAsOf: 'b' })
  })
})

describe('scan recording', () => {
  it('stores every opportunity and the reference gaps for each cycle', async () => {
    const store = new Store(':memory:')
    const report = await runCycle({
      cfg: loadConfig({ MODE: 'dry-run', QUOTE_SOURCE: 'fixture', MAX_TRADE_USD: '100', MIN_TRADE_USD: '10', SIZE_LADDER: '1,0.5' }).cfg,
      store,
      adapters: fixtureAdapters('collapsed'),
      gasPriceWei: 5_000_000_000n,
      celoUsdMicros: usdToMicros(0.3),
      quoteSource: 'fixture',
      reference: { source: 'test', asOf: '2026-10-29T00:00:00.000Z', perUsd: { USD: 1, BRL: 5.4, NGN: 1368, ARS: 1200 } },
    })
    const db = (store as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db
    const opps = Number(db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n)
    const gaps = Number(db.prepare('SELECT COUNT(*) AS n FROM reference_gaps').get().n)
    // The report keeps the top 12; the table keeps every round trip.
    expect(opps).toBeGreaterThanOrEqual(report.opportunities.length)
    expect(opps).toBeGreaterThan(0)
    expect(gaps).toBe(report.referenceGaps.length)
    expect(report.referenceGaps.some((gap) => gap.corridor === 'wBRL' && gap.sizeUsd === 50)).toBe(true)
    expect(report.referenceAsOf).toBe('2026-10-29T00:00:00.000Z')
    store.close()
  })
})

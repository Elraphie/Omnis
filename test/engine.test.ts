import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/load.js'
import { runCycle } from '../src/execution/engine.js'
import { usdToMicros } from '../src/pricing/math.js'
import { Store } from '../src/store/db.js'
import { fixtureAdapters } from '../src/venues/fixture.js'

function paperConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    MODE: 'paper',
    QUOTE_SOURCE: 'fixture',
    MAX_TRADE_USD: '100',
    MIN_TRADE_USD: '10',
    SIZE_LADDER: '1',
    MIN_EDGE_USD: '0.05',
    MIN_EDGE_BPS: '3',
    ADVERSE_BPS: '2',
    PAPER_USDT: '1000',
    MAX_INVENTORY_USD: '500',
    MAX_DAILY_LOSS_USD: '25',
    CELO_USD: '0.3',
    GAS_PRICE_WEI_FALLBACK: '5000000000',
    ...extra,
  }).cfg
}

async function cycle(scenario: 'profitable' | 'collapsed', extra: Record<string, string> = {}, seed?: (store: Store) => void) {
  const store = new Store(':memory:')
  const calls: string[] = []
  if (seed) seed(store)
  const report = await runCycle({
    cfg: paperConfig(extra),
    store,
    adapters: fixtureAdapters(scenario),
    gasPriceWei: 5_000_000_000n,
    celoUsdMicros: usdToMicros(0.3),
    quoteSource: 'fixture',
    now: new Date('2026-10-28T12:00:00.000Z'),
    broadcaster: async () => { calls.push('send') },
  })
  return { report, store, calls }
}

describe('paper and dry-run desk', () => {
  it('simulates a fill when the cross-venue edge clears costs', async () => {
    const { report, store, calls } = await cycle('profitable')
    expect(calls).toEqual([])
    expect(report.quoteSource).toBe('fixture')
    expect(report.decision.action).toBe('arbitrage')
    expect(report.trade?.strategy).toBe('arbitrage')
    expect(report.trade?.pair).toBe('wBRL/USDT')
    expect(report.trade!.pnlUsd).toBeGreaterThan(1)
    expect(report.paper.equityUsd).toBeGreaterThan(1001)
    expect(report.paper.realizedUsd).toBeCloseTo(report.trade!.pnlUsd, 4)
    expect(store.recentTrades(5)).toHaveLength(1)
    expect(report.basis[0]?.tradable).toBe(false)
    expect(report.basis[0]?.gapBps).toBeGreaterThan(100)
    expect(report.mmQuotes.some((quote) => quote.corridor === 'wBRL' && quote.bidUsd < quote.askUsd)).toBe(true)
    expect(report.opportunities.every((opp) => !opp.route.startsWith(opp.route.split(' -> ')[1] ?? 'x'))).toBe(true)
  })

  it('holds when every scanned gap is inside the cost floor', async () => {
    const { report, store } = await cycle('collapsed')
    expect(report.decision.action).toBe('hold')
    expect(report.decision.reason).toBe('no positive edge')
    expect(report.trade).toBeNull()
    expect(store.counts().trades).toBe(0)
    expect(report.best && report.best.netEdgeUsd < 0).toBe(true)
  })

  it('does not send or mutate balances in dry-run', async () => {
    const store = new Store(':memory:')
    const calls: string[] = []
    const report = await runCycle({
      cfg: loadConfig({ MODE: 'dry-run', MAX_TRADE_USD: '100', MIN_TRADE_USD: '10', SIZE_LADDER: '1', ADVERSE_BPS: '2' }).cfg,
      store,
      adapters: fixtureAdapters('profitable'),
      gasPriceWei: 5_000_000_000n,
      celoUsdMicros: usdToMicros(0.3),
      quoteSource: 'fixture',
      broadcaster: async () => { calls.push('send') },
    })
    expect(report.decision.action).toBe('arbitrage')
    expect(report.trade).toBeNull()
    expect(calls).toEqual([])
    expect(store.balances()).toEqual({})
  })

  it('obeys the kill switch, inventory cap, and daily loss stop', async () => {
    const killed = await cycle('profitable', { KILL_SWITCH: '1' })
    expect(killed.report.decision.reason).toBe('kill switch')
    expect(killed.report.trade).toBeNull()

    const capped = await cycle('profitable', { MAX_INVENTORY_USD: '50' })
    expect(capped.report.decision.reason).toBe('inventory limit')

    const stopped = await cycle('profitable', {}, (store) => {
      store.seedPaper(usdToMicros(1000))
      store.insertTrade({
        ts: '2026-10-28T00:00:00.000Z', mode: 'paper', strategy: 'arbitrage', pair: 'wBRL/USDT',
        venuePath: 'x', sizeUsd: 100, pnlUsdMicros: usdToMicros(-30), payload: {},
      })
    })
    expect(stopped.report.decision.reason).toBe('daily loss stop')
    expect(stopped.store.lossStopDay()).toBe('2026-10-28')
  })

  it('sells drifted inventory when there is no arb', async () => {
    const { report, store } = await cycle('collapsed', {
      REBALANCE_THRESHOLD_BPS: '100',
      REBALANCE_MAX_COST_BPS: '50',
      MM_MAX_SKEW_BPS: '0',
    }, (store) => {
      store.seedPaper(usdToMicros(1000))
      store.setBalance('wBRL', 1_080n * 10n ** 18n)
    })
    expect(report.decision.action).toBe('rebalance')
    expect(report.trade?.strategy).toBe('rebalance')
    expect(store.balance('wBRL')).toBeLessThan(1_080n * 10n ** 18n)
  })
})

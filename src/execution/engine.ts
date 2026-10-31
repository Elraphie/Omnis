import type { AppConfig } from '../config/load.js'
import { activeCorridors, TOKENS, token, venuesForPair, type VenueId } from '../config/tokens.js'
import { gasCostUsdMicros, ladderSizes, microsToNumber } from '../pricing/math.js'
import { referenceGaps, type ReferenceGap, type ReferenceRates } from '../reference/fx.js'
import { shadowCandidate, shadowView, type ShadowResult, type ShadowView } from './shadow.js'
import { killReason, reviewOpenRisk, reviewReduceRisk, shouldTripLossStop } from '../risk/guards.js'
import { findArbs, type ArbOpportunity, type PricedQuote } from '../strategies/arbitrage.js'
import { bestBid, buildMmQuotes, fxRebalance, inventoryMarks, nairaBasis, priceOf, type BasisRow, type MmQuote } from '../strategies/book.js'
import { bestArb, chooseStrategy, type StrategyChoice } from '../strategies/select.js'
import type { Store } from '../store/db.js'
import { mapLimit, utcDay, withTimeout } from '../util.js'
import { adaptersFor } from '../venues/registry.js'
import type { VenueAdapter, VenueQuote } from '../venues/types.js'

export interface CycleReport {
  ts: string
  mode: AppConfig['mode']
  quoteSource: 'live' | 'fixture'
  elapsedMs: number
  opportunities: {
    corridor: string
    route: string
    sizeUsd: number
    outUsd: number
    grossEdgeUsd: number
    gasUsd: number
    bufferUsd: number
    netEdgeUsd: number
    netEdgeBps: number
  }[]
  best: CycleReport['opportunities'][number] | null
  decision: StrategyChoice
  mmQuotes: MmQuote[]
  basis: BasisRow[]
  /** On-chain prices against the fiat reference at the smallest clip. Empty without a reference. */
  referenceGaps: ReferenceGap[]
  referenceAsOf: string | null
  venueErrors: { venue: string; message: string }[]
  quoteCount: number
  paper: {
    equityUsd: number
    realizedUsd: number
    unrealizedUsd: number
    balances: Record<string, string>
  }
  trade: { strategy: string; pair: string; pnlUsd: number } | null
  /** What live execution would have met on this cycle's best route. Null when shadow mode is off or skipped. */
  shadow: ShadowView | null
}

export interface CycleDeps {
  cfg: AppConfig
  store: Store
  adapters: VenueAdapter[]
  gasPriceWei: bigint
  celoUsdMicros: bigint
  quoteSource: 'live' | 'fixture'
  now?: Date
  /** Fiat rates per USD to measure on-chain prices against. Measurement only; no decision reads it. */
  reference?: ReferenceRates | null
  /**
   * Shadow execution for dry-run and paper on live quotes. Returns null when its hourly budget is spent.
   * It never signs; live mode never calls it.
   */
  shadow?: (opp: ArbOpportunity) => Promise<ShadowResult | null>
  /** Called only when mode is live and a broadcastable route exists. */
  broadcaster?: (opp: ArbOpportunity) => Promise<void>
}

function toPriced(quote: VenueQuote): PricedQuote {
  return {
    venue: quote.venue,
    tokenIn: quote.tokenIn.symbol,
    tokenOut: quote.tokenOut.symbol,
    tokenInAddress: quote.tokenIn.address,
    tokenOutAddress: quote.tokenOut.address,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    firm: quote.firm,
    gasUnits: quote.gasUnits,
  }
}

function viewOpp(opp: ArbOpportunity): CycleReport['opportunities'][number] {
  return {
    corridor: opp.corridor,
    route: `${opp.buyVenue} -> ${opp.sellVenue}`,
    sizeUsd: microsToNumber(opp.sizeUsdMicros),
    outUsd: microsToNumber(opp.amountOut),
    grossEdgeUsd: microsToNumber(opp.grossUsdMicros),
    gasUsd: microsToNumber(opp.gasUsdMicros),
    bufferUsd: microsToNumber(opp.adverseUsdMicros),
    netEdgeUsd: microsToNumber(opp.netUsdMicros),
    netEdgeBps: Number(opp.netBps),
  }
}

async function quoteAll(
  adapters: VenueAdapter[],
  tokenInSym: string,
  tokenOutSym: string,
  amountIn: bigint,
  timeoutMs: number,
  errors: { venue: string; message: string }[],
): Promise<PricedQuote[]> {
  const tokenIn = token(tokenInSym)
  const tokenOut = token(tokenOutSym)
  const selected = adaptersFor(adapters, tokenIn, tokenOut)
  const allowed = new Set<VenueId>(venuesForPair(tokenOutSym === 'USDT' ? tokenInSym : tokenOutSym, 'USDT'))
  const results = await Promise.all(selected.filter((adapter) => allowed.has(adapter.id)).map(async (adapter) => {
    try {
      const quote = await withTimeout(
        adapter.quote({ chainId: 42220, tokenIn, tokenOut, amountIn }),
        timeoutMs,
        adapter.id,
      )
      return quote ? toPriced(quote) : null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ venue: adapter.id, message })
      return null
    }
  }))
  return results.filter((quote): quote is PricedQuote => quote !== null)
}

export async function runCycle(deps: CycleDeps): Promise<CycleReport> {
  const started = Date.now()
  const now = deps.now ?? new Date()
  const today = utcDay(now)
  const ts = now.toISOString()
  const { cfg, store } = deps
  if (cfg.mode === 'paper') store.seedPaper(cfg.paperUsdtMicros)
  const errors: { venue: string; message: string }[] = []
  const corridors = activeCorridors(cfg.includeExtended)
  const sizes = ladderSizes(cfg.maxTradeUsdMicros, cfg.ladderBps, cfg.minTradeUsdMicros)
  const quotes: PricedQuote[] = []

  await mapLimit(corridors, 3, async (corridor) => {
    for (const size of sizes) {
      const buys = await quoteAll(deps.adapters, 'USDT', corridor.base, size, cfg.quoteTimeoutMs, errors)
      quotes.push(...buys)
      await Promise.all(buys.map(async (buy) => {
        const sells = await quoteAll(deps.adapters, corridor.base, 'USDT', buy.amountOut, cfg.quoteTimeoutMs, errors)
        quotes.push(...sells)
      }))
    }
  })

  const opps = findArbs({
    corridors,
    quotes,
    gasPriceWei: deps.gasPriceWei,
    celoUsdMicros: deps.celoUsdMicros,
    adverseBps: cfg.adverseBps,
  })
  const chosen = bestArb(opps, cfg.minEdgeUsdMicros, cfg.minEdgeBps)
  store.insertOpportunities(ts, deps.quoteSource, opps.map((opp) => ({
    corridor: opp.corridor,
    buyVenue: opp.buyVenue,
    sellVenue: opp.sellVenue,
    sizeUsd: microsToNumber(opp.sizeUsdMicros),
    grossUsd: microsToNumber(opp.grossUsdMicros),
    gasUsd: microsToNumber(opp.gasUsdMicros),
    bufferUsd: microsToNumber(opp.adverseUsdMicros),
    netUsd: microsToNumber(opp.netUsdMicros),
    netBps: Number(opp.netBps),
  })))
  const smallest = sizes.reduce<bigint | null>((min, size) => (min === null || size < min ? size : min), null)
  const gaps = deps.reference && smallest !== null
    ? referenceGaps({ corridors, quotes, reference: deps.reference, sizeUsdMicros: smallest })
    : []
  if (deps.reference) store.insertReferenceGaps(ts, deps.quoteSource, deps.reference, gaps)
  const balances = store.balances()
  const marks = inventoryMarks(balances, quotes)
  const inventoryUsd = (symbol: string) => marks.usd[symbol] ?? 0n
  const nonCashInventory = Object.entries(marks.usd).reduce((sum, [symbol, usd]) => sum + (symbol === 'USDT' ? 0n : usd), 0n)
  const mmQuotes = buildMmQuotes({
    corridors,
    quotes,
    inventoryUsd,
    spreadBps: cfg.mmSpreadBps,
    skewFactorBps: cfg.mmSkewFactorBps,
    maxSkewBps: cfg.mmMaxSkewBps,
    basisUsdMicros: cfg.maxTradeUsdMicros,
  })
  const basis = [nairaBasis(quotes)]
  const manualKill = cfg.killSwitch || store.manualKill()
  const daily = store.dailyRealized(today)
  if (shouldTripLossStop(daily, cfg.maxDailyLossUsdMicros)) store.setLossStopDay(today)
  const lossStopDay = store.lossStopDay()

  const arbBlock = chosen
    ? reviewOpenRisk({
        manualKill,
        lossStopDay,
        today,
        dailyRealizedUsdMicros: daily,
        maxDailyLossUsdMicros: cfg.maxDailyLossUsdMicros,
        currentInventoryUsdMicros: nonCashInventory,
        proposedAddUsdMicros: chosen.sizeUsdMicros,
        maxInventoryUsdMicros: cfg.maxInventoryUsdMicros,
        netEdgeUsdMicros: chosen.netUsdMicros,
        minEdgeUsdMicros: cfg.minEdgeUsdMicros,
        netEdgeBps: chosen.netBps,
        minEdgeBps: cfg.minEdgeBps,
      })
    : null

  let marketMake = false
  let marketMakeCorridor: MmQuote | null = null
  for (const quote of mmQuotes) {
    const bid = bestBid(quotes, quote.corridor)
    if (!bid) continue
    const market = priceOf(bid, 'bid')
    if (market >= BigInt(quote.askUsdMicros) && (balances[quote.corridor] ?? 0n) > 0n) {
      marketMake = true
      marketMakeCorridor = quote
      break
    }
  }
  const mmBlock = marketMake
    ? reviewOpenRisk({
        manualKill,
        lossStopDay,
        today,
        dailyRealizedUsdMicros: daily,
        maxDailyLossUsdMicros: cfg.maxDailyLossUsdMicros,
        currentInventoryUsdMicros: nonCashInventory,
        proposedAddUsdMicros: 0n,
        maxInventoryUsdMicros: cfg.maxInventoryUsdMicros,
        netEdgeUsdMicros: cfg.minEdgeUsdMicros,
        minEdgeUsdMicros: cfg.minEdgeUsdMicros,
        netEdgeBps: cfg.minEdgeBps,
        minEdgeBps: cfg.minEdgeBps,
      })
    : null

  const rebalance = fxRebalance({
    marks: marks.usd,
    thresholdBps: cfg.rebalanceThresholdBps,
    maxCostBps: cfg.rebalanceMaxCostBps,
    quotes,
    targetUsdtBps: cfg.targetUsdtBps,
  })
  const rebalanceBlock = rebalance ? reviewReduceRisk(manualKill) : null
  let decision = chooseStrategy({
    arb: chosen,
    arbBlock: arbBlock && !arbBlock.ok ? arbBlock.reason : chosen ? null : 'no positive edge',
    marketMake,
    marketMakeBlock: mmBlock && !mmBlock.ok ? mmBlock.reason : null,
    rebalance,
    rebalanceBlock: rebalanceBlock && !rebalanceBlock.ok ? rebalanceBlock.reason : null,
  })
  if (cfg.mode === 'live' && deps.quoteSource === 'fixture' && decision.action !== 'hold') {
    decision = { strategy: decision.strategy, action: 'hold', reason: 'fixture quotes are not tradable' }
  }
  if (decision.action === 'arbitrage' && chosen && (balances.USDT ?? 0n) < chosen.sizeUsdMicros && cfg.mode !== 'dry-run') {
    decision = { strategy: 'arbitrage', action: 'hold', reason: 'insufficient paper USDT' }
  }

  let trade: CycleReport['trade'] = null
  if (decision.action === 'arbitrage' && chosen && cfg.mode === 'paper') {
    // Book the same net edge the decision used, cushion included, so paper P&L is not flattered.
    const pnl = chosen.netUsdMicros
    store.setBalance('USDT', (balances.USDT ?? 0n) + pnl)
    store.addRealized(pnl)
    store.insertTrade({
      ts, mode: cfg.mode, strategy: 'arbitrage', pair: `${chosen.corridor}/USDT`,
      venuePath: `${chosen.buyVenue}->${chosen.sellVenue}`, sizeUsd: microsToNumber(chosen.sizeUsdMicros),
      pnlUsdMicros: pnl, payload: viewOpp(chosen),
    })
    trade = { strategy: 'arbitrage', pair: `${chosen.corridor}/USDT`, pnlUsd: microsToNumber(pnl) }
  } else if (decision.action === 'arbitrage' && chosen && cfg.mode === 'live') {
    try {
      if (!deps.broadcaster) throw new Error('live mode has no broadcaster')
      await deps.broadcaster(chosen)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      decision = { strategy: 'arbitrage', action: 'hold', reason: message }
    }
  } else if (decision.action === 'rebalance' && rebalance && cfg.mode === 'paper') {
    const symbol = rebalance.symbol
    const held = store.balance(symbol)
    const bid = bestBid(quotes, symbol)
    if (bid && held > 0n) {
      const tokenInfo = TOKENS[symbol as keyof typeof TOKENS]
      const price = priceOf(bid, 'bid')
      const wantAtomic = (rebalance.usdMicros * 10n ** BigInt(tokenInfo.decimals)) / (price > 0n ? price : 1n)
      const sell = wantAtomic > held ? held : wantAtomic
      const proceeds = (sell * bid.amountOut) / bid.amountIn
      const gas = gasCostUsdMicros(cfg.gasUnits['uniswap-v3'], deps.gasPriceWei, deps.celoUsdMicros)
      const pnl = -gas
      store.setBalance(symbol, held - sell)
      store.setBalance('USDT', store.balance('USDT') + (proceeds > gas ? proceeds - gas : 0n))
      store.addRealized(pnl)
      store.insertTrade({
        ts, mode: cfg.mode, strategy: 'rebalance', pair: `${symbol}/USDT`, venuePath: bid.venue,
        sizeUsd: microsToNumber(proceeds), pnlUsdMicros: pnl, payload: { symbol, sell: sell.toString() },
      })
      trade = { strategy: 'rebalance', pair: `${symbol}/USDT`, pnlUsd: microsToNumber(pnl) }
    }
  } else if (decision.action === 'market-make' && marketMakeCorridor && cfg.mode === 'paper') {
    const symbol = marketMakeCorridor.corridor
    const held = store.balance(symbol)
    const bid = bestBid(quotes, symbol)
    if (bid && held > 0n) {
      const tokenInfo = TOKENS[symbol as keyof typeof TOKENS]
      const price = priceOf(bid, 'bid')
      const clip = (cfg.maxTradeUsdMicros * 10n ** BigInt(tokenInfo.decimals)) / (price > 0n ? price : 1n)
      const sell = clip > held ? held : clip
      const proceeds = (sell * bid.amountOut) / bid.amountIn
      store.setBalance(symbol, held - sell)
      store.setBalance('USDT', store.balance('USDT') + proceeds)
      store.insertTrade({
        ts, mode: cfg.mode, strategy: 'market-make', pair: `${symbol}/USDT`, venuePath: bid.venue,
        sizeUsd: microsToNumber(proceeds), pnlUsdMicros: 0n,
        payload: { symbol, sell: sell.toString(), skewBps: marketMakeCorridor.skewBps },
      })
      trade = { strategy: 'market-make', pair: `${symbol}/USDT`, pnlUsd: 0 }
    }
  }

  let shadow: ShadowView | null = null
  if (deps.shadow && cfg.mode !== 'live' && deps.quoteSource === 'live') {
    const candidate = shadowCandidate(opps, cfg.shadowMinNetBps)
    const result = candidate ? await deps.shadow(candidate) : null
    if (result) {
      shadow = shadowView(result)
      store.insertShadow(ts, shadow)
    }
  }

  const after = inventoryMarks(store.balances(), quotes)
  const equity = after.totalUsd
  const realized = store.realized()
  const starting = store.startingEquity()
  const unrealized = equity - starting - realized
  if (cfg.mode === 'paper') {
    store.insertPnl({ ts, equityUsdMicros: equity, realizedUsdMicros: realized, unrealizedUsdMicros: unrealized })
  }
  const ranked = [...opps].sort((a, b) => (a.netUsdMicros > b.netUsdMicros ? -1 : 1)).slice(0, 12).map(viewOpp)
  const best = chosen ? viewOpp(chosen) : ranked[0] ?? null
  store.insertScan({
    ts, mode: cfg.mode, quoteSource: deps.quoteSource,
    bestEdgeUsd: best ? best.netEdgeUsd : null,
    bestEdgeBps: best ? best.netEdgeBps : null,
    payload: { opportunities: ranked, errors },
  })
  store.insertDecision({ ts, strategy: decision.strategy, action: decision.action, reason: decision.reason, payload: decision })
  if (killReason(manualKill, store.lossStopDay(), today) === null && shouldTripLossStop(store.dailyRealized(today), cfg.maxDailyLossUsdMicros)) {
    store.setLossStopDay(today)
  }

  const balanceView: Record<string, string> = {}
  for (const [symbol, amount] of Object.entries(store.balances())) balanceView[symbol] = amount.toString()
  return {
    ts,
    mode: cfg.mode,
    quoteSource: deps.quoteSource,
    elapsedMs: Date.now() - started,
    opportunities: ranked,
    best,
    decision,
    mmQuotes,
    basis,
    referenceGaps: gaps,
    referenceAsOf: deps.reference?.asOf ?? null,
    venueErrors: errors,
    quoteCount: quotes.length,
    paper: {
      equityUsd: microsToNumber(equity),
      realizedUsd: microsToNumber(realized),
      unrealizedUsd: microsToNumber(unrealized),
      balances: balanceView,
    },
    trade,
    shadow,
  }
}

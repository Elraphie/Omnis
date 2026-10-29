import { TOKENS, type Token } from '../config/tokens.js'
import { BPS, fxPerUsdMicros, gapBps, inventorySkewQuote, rebalanceOrders, usdMicrosPerToken, type RebalanceOrder } from '../pricing/math.js'
import type { PricedQuote } from './arbitrage.js'

export interface MmQuote {
  corridor: string
  midUsd: number
  bidUsd: number
  askUsd: number
  spreadBps: number
  skewBps: number
  inventoryUsd: number
  bidUsdMicros: string
  askUsdMicros: string
}

export interface BasisRow {
  label: string
  left: string
  right: string
  leftFxPerUsd: number | null
  rightFxPerUsd: number | null
  gapBps: number | null
  tradable: boolean
  note: string
}

function decimalsOf(symbol: string): number {
  return TOKENS[symbol as keyof typeof TOKENS]?.decimals ?? 18
}

export function bestBid(quotes: PricedQuote[], base: string): PricedQuote | null {
  const sells = quotes.filter((quote) => quote.tokenIn === base && quote.tokenOut === 'USDT')
  return sells.reduce<PricedQuote | null>((best, quote) => {
    if (!best) return quote
    return quote.amountOut * best.amountIn > best.amountOut * quote.amountIn ? quote : best
  }, null)
}

export function bestAsk(quotes: PricedQuote[], base: string): PricedQuote | null {
  const buys = quotes.filter((quote) => quote.tokenIn === 'USDT' && quote.tokenOut === base)
  return buys.reduce<PricedQuote | null>((best, quote) => {
    if (!best) return quote
    const quotePrice = quote.amountIn * best.amountOut
    const bestPrice = best.amountIn * quote.amountOut
    return quotePrice < bestPrice ? quote : best
  }, null)
}

export function priceOf(quote: PricedQuote, side: 'bid' | 'ask'): bigint {
  const base = side === 'bid' ? quote.tokenIn : quote.tokenOut
  const atomic = side === 'bid' ? quote.amountIn : quote.amountOut
  const usd = side === 'bid' ? quote.amountOut : quote.amountIn
  return usdMicrosPerToken(atomic, usd, decimalsOf(base))
}

export function buildMmQuotes(args: {
  corridors: { id: string; base: string }[]
  quotes: PricedQuote[]
  inventoryUsd: (symbol: string) => bigint
  spreadBps: bigint
  skewFactorBps: bigint
  maxSkewBps: bigint
  basisUsdMicros: bigint
}): MmQuote[] {
  const out: MmQuote[] = []
  for (const corridor of args.corridors) {
    const bid = bestBid(args.quotes, corridor.base)
    const ask = bestAsk(args.quotes, corridor.base)
    if (!bid && !ask) continue
    const bidPx = bid ? priceOf(bid, 'bid') : 0n
    const askPx = ask ? priceOf(ask, 'ask') : 0n
    const mid = bidPx > 0n && askPx > 0n ? (bidPx + askPx) / 2n : bidPx > 0n ? bidPx : askPx
    if (mid <= 0n) continue
    const inventory = args.inventoryUsd(corridor.base)
    const skewed = inventorySkewQuote({
      midUsdMicrosPerToken: mid,
      spreadBps: args.spreadBps,
      inventoryUsdMicros: inventory,
      targetUsdMicros: 0n,
      skewFactorBps: args.skewFactorBps,
      maxSkewBps: args.maxSkewBps,
      basisUsdMicros: args.basisUsdMicros,
    })
    out.push({
      corridor: corridor.id,
      midUsd: Number(mid) / 1e6,
      bidUsd: Number(skewed.bidUsdMicrosPerToken) / 1e6,
      askUsd: Number(skewed.askUsdMicrosPerToken) / 1e6,
      spreadBps: Number(args.spreadBps),
      skewBps: Number(skewed.skewBps),
      inventoryUsd: Number(inventory) / 1e6,
      bidUsdMicros: skewed.bidUsdMicrosPerToken.toString(),
      askUsdMicros: skewed.askUsdMicrosPerToken.toString(),
    })
  }
  return out
}

export function nairaBasis(quotes: PricedQuote[]): BasisRow {
  const cngn = bestAsk(quotes, 'cNGN')
  const ngnm = bestAsk(quotes, 'NGNm')
  const left = cngn ? fxPerUsdMicros(cngn.amountIn, cngn.amountOut, decimalsOf('cNGN')) : 0n
  const right = ngnm ? fxPerUsdMicros(ngnm.amountIn, ngnm.amountOut, decimalsOf('NGNm')) : 0n
  const gap = gapBps(left, right)
  return {
    label: 'cNGN vs NGNm',
    left: cngn ? `cNGN ${cngn.venue}` : 'cNGN unquoted',
    right: ngnm ? `NGNm ${ngnm.venue}` : 'NGNm unquoted',
    leftFxPerUsd: left > 0n ? Number(left) / 1e6 : null,
    rightFxPerUsd: right > 0n ? Number(right) / 1e6 : null,
    gapBps: gap === null ? null : Number(gap),
    tradable: false,
    note: 'cNGN and Mento NGNm are different assets. The gap is reported, never traded, until a licensed bridge or pool exists.',
  }
}

export function inventoryMarks(balances: Record<string, bigint>, quotes: PricedQuote[]): { usd: Record<string, bigint>; totalUsd: bigint } {
  const usd: Record<string, bigint> = {}
  let total = 0n
  for (const [symbol, amount] of Object.entries(balances)) {
    if (amount <= 0n) continue
    if (symbol === 'USDT') {
      usd[symbol] = amount
      total += amount
      continue
    }
    const bid = bestBid(quotes, symbol)
    if (!bid || bid.amountIn === 0n) {
      usd[symbol] = 0n
      continue
    }
    const marked = (amount * bid.amountOut) / bid.amountIn
    usd[symbol] = marked
    total += marked
  }
  return { usd, totalUsd: total }
}

export function fxRebalance(args: {
  marks: Record<string, bigint>
  thresholdBps: bigint
  maxCostBps: bigint
  quotes: PricedQuote[]
  targetUsdtBps: bigint
}): RebalanceOrder | null {
  const weights = Object.entries(args.marks).map(([symbol, usdMicros]) => ({
    symbol,
    usdMicros,
    targetBps: symbol === 'USDT' ? args.targetUsdtBps : 0n,
  }))
  const sample = weights.find((row) => row.symbol !== 'USDT')
  let cost = args.maxCostBps + 1n
  if (sample) {
    const bid = bestBid(args.quotes, sample.symbol)
    const ask = bestAsk(args.quotes, sample.symbol)
    if (bid && ask) {
      const bidPx = priceOf(bid, 'bid')
      const askPx = priceOf(ask, 'ask')
      const mid = (bidPx + askPx) / 2n
      if (mid > 0n) cost = askPx >= bidPx ? ((askPx - bidPx) * BPS) / mid : 0n
    }
  }
  const orders = rebalanceOrders({
    weights,
    thresholdBps: args.thresholdBps,
    maxCostBps: args.maxCostBps,
    costBps: cost < 0n ? 0n : cost,
  }).filter((order) => order.symbol !== 'USDT' && order.side === 'sell')
  return orders[0] ?? null
}

export function tokenOf(symbol: string): Token {
  const found = TOKENS[symbol as keyof typeof TOKENS]
  if (!found) throw new Error(`Unknown token ${symbol}`)
  return found
}

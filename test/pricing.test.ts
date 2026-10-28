import { describe, expect, it } from 'vitest'
import {
  edgeAfterCosts,
  fxPerUsdMicros,
  gapBps,
  inventorySkewQuote,
  minOut,
  rebalanceOrders,
  selectBestArb,
  selectBestRoute,
  splitInputFee,
  usdToMicros,
  gasCostUsdMicros,
} from '../src/pricing/math.js'

describe('pricing math', () => {
  it('splits an input fee in exact base units', () => {
    const amount = usdToMicros(100)
    const { fee, swapAmount } = splitInputFee(amount, 8n)
    expect(fee).toBe(80_000n)
    expect(swapAmount).toBe(99_920_000n)
    expect(fee + swapAmount).toBe(amount)
  })

  it('rejects a fee that consumes the trade', () => {
    expect(() => splitInputFee(100n, 10_000n)).toThrow(/fee consumes/)
  })

  it('prices gas into usd micros', () => {
    const cost = gasCostUsdMicros(200_000n, 5_000_000_000n, usdToMicros(0.3))
    expect(cost).toBe(300n)
  })

  it('treats a 2bp gross gap as a loss once the adverse cushion is included', () => {
    const edge = edgeAfterCosts({
      amountInUsdMicros: usdToMicros(100),
      amountOutUsdMicros: usdToMicros(100.02),
      gasUsdMicros: 300n,
      adverseBps: 2n,
    })
    expect(edge.grossUsdMicros).toBe(20_000n)
    expect(edge.netUsdMicros < 0n).toBe(true)
  })

  it('keeps a wide gap after gas and a two-leg cushion', () => {
    const edge = edgeAfterCosts({
      amountInUsdMicros: usdToMicros(100),
      amountOutUsdMicros: usdToMicros(100.4),
      gasUsdMicros: 300n,
      adverseBps: 4n,
    })
    expect(edge.netUsdMicros > usdToMicros(0.3)).toBe(true)
    expect(edge.netBps > 30n).toBe(true)
  })

  it('sets a slippage floor without using it as the expected cost', () => {
    expect(minOut(1_000_000n, 50n)).toBe(995_000n)
  })

  it('measures the cNGN / NGNm basis in bps and keeps the scale', () => {
    const cngn = fxPerUsdMicros(1_000_000n, 1_368_000_000n, 6)
    const ngnm = fxPerUsdMicros(1_000_000n, 1_335n * 10n ** 18n, 18)
    expect(Number(cngn) / 1e6).toBeCloseTo(1368, 3)
    expect(Number(ngnm) / 1e6).toBeCloseTo(1335, 3)
    const gap = gapBps(cngn, ngnm)
    expect(gap).not.toBeNull()
    expect(Number(gap)).toBeGreaterThan(200)
  })

  it('skews a long inventory down on both sides', () => {
    const flat = inventorySkewQuote({
      midUsdMicrosPerToken: 5_400_000n,
      spreadBps: 10n,
      inventoryUsdMicros: 0n,
      targetUsdMicros: 0n,
      skewFactorBps: 5_000n,
      maxSkewBps: 40n,
      basisUsdMicros: usdToMicros(100),
    })
    const long = inventorySkewQuote({
      midUsdMicrosPerToken: 5_400_000n,
      spreadBps: 10n,
      inventoryUsdMicros: usdToMicros(100),
      targetUsdMicros: 0n,
      skewFactorBps: 5_000n,
      maxSkewBps: 40n,
      basisUsdMicros: usdToMicros(100),
    })
    expect(flat.skewBps).toBe(0n)
    expect(flat.bidUsdMicrosPerToken < flat.askUsdMicrosPerToken).toBe(true)
    expect(long.skewBps).toBe(40n)
    expect(long.bidUsdMicrosPerToken < flat.bidUsdMicrosPerToken).toBe(true)
    expect(long.askUsdMicrosPerToken < flat.askUsdMicrosPerToken).toBe(true)
    expect(long.askUsdMicrosPerToken > long.bidUsdMicrosPerToken).toBe(true)
  })

  it('sells the overweight asset when drift exceeds the threshold and the spread is cheap', () => {
    const orders = rebalanceOrders({
      weights: [
        { symbol: 'USDT', usdMicros: usdToMicros(800), targetBps: 10_000n },
        { symbol: 'wBRL', usdMicros: usdToMicros(200), targetBps: 0n },
      ],
      thresholdBps: 500n,
      maxCostBps: 15n,
      costBps: 8n,
    })
    expect(orders.map((order) => order.symbol)).toContain('wBRL')
    expect(orders.find((order) => order.symbol === 'wBRL')?.side).toBe('sell')
  })

  it('does not rebalance through an expensive spread', () => {
    const orders = rebalanceOrders({
      weights: [
        { symbol: 'USDT', usdMicros: usdToMicros(800), targetBps: 10_000n },
        { symbol: 'wBRL', usdMicros: usdToMicros(200), targetBps: 0n },
      ],
      thresholdBps: 500n,
      maxCostBps: 15n,
      costBps: 40n,
    })
    expect(orders).toEqual([])
  })
})

describe('route selection', () => {
  it('picks more output, then a firm quote, then lower gas', () => {
    const best = selectBestRoute([
      { venue: 'uniswap-v3', amountOut: 100n, firm: false, gasUsdMicros: 10n },
      { venue: 'textile-rfq', amountOut: 100n, firm: true, gasUsdMicros: 50n },
      { venue: 'mento-v3', amountOut: 90n, firm: true, gasUsdMicros: 1n },
      { venue: 'dead', amountOut: 0n, firm: true, gasUsdMicros: 0n },
    ])
    expect(best?.venue).toBe('textile-rfq')
  })

  it('prefers the clip with more dollars, even when the smaller clip has more bps', () => {
    const best = selectBestArb([
      { id: 'big', sizeUsdMicros: 100_000_000n, netEdgeUsdMicros: 50_000n, netEdgeBps: 5n, venueBuy: 'uniswap-v3', venueSell: 'textile-rfq' },
      { id: 'small', sizeUsdMicros: 25_000_000n, netEdgeUsdMicros: 200_000n, netEdgeBps: 80n, venueBuy: 'uniswap-v3', venueSell: 'textile-rfq' },
      { id: 'same', sizeUsdMicros: 25_000_000n, netEdgeUsdMicros: 900_000n, netEdgeBps: 200n, venueBuy: 'uniswap-v3', venueSell: 'uniswap-v3' },
      { id: 'thin', sizeUsdMicros: 100_000_000n, netEdgeUsdMicros: 1_000n, netEdgeBps: 2n, venueBuy: 'mento-broker', venueSell: 'uniswap-v3' },
    ], 50_000n, 3n)
    expect(best?.id).toBe('small')
  })
})

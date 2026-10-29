import { TOKENS, type Token, type VenueId } from '../config/tokens.js'
import type { QuoteRequest, VenueAdapter, VenueQuote } from './types.js'

const E8 = 100_000_000n

export interface FixtureRate {
  venue: VenueId
  base: keyof typeof TOKENS
  /** Whole base tokens per 1 USDT, scaled by 1e8. */
  tokensPerUsdtE8: bigint
  firm?: boolean
}

export function tokensForUsdt(usdtAmount: bigint, tokensPerUsdtE8: bigint, decimals: number): bigint {
  return (usdtAmount * tokensPerUsdtE8 * 10n ** BigInt(decimals)) / (1_000_000n * E8)
}

export function usdtForTokens(tokenAmount: bigint, tokensPerUsdtE8: bigint, decimals: number): bigint {
  const denom = tokensPerUsdtE8 * 10n ** BigInt(decimals)
  if (denom === 0n) return 0n
  return (tokenAmount * 1_000_000n * E8) / denom
}

const GAS: Record<VenueId, bigint> = {
  'uniswap-v3': 180_000n,
  'textile-rfq': 280_000n,
  'mento-broker': 220_000n,
  'mento-v3': 220_000n,
}

/** Profitable wBRL gap. cNGN and NGNm differ on purpose and are not the same asset. */
export function profitableRates(): FixtureRate[] {
  return [
    { venue: 'uniswap-v3', base: 'wBRL', tokensPerUsdtE8: 540_000_000n },
    { venue: 'textile-rfq', base: 'wBRL', tokensPerUsdtE8: 530_000_000n },
    { venue: 'uniswap-v3', base: 'wARS', tokensPerUsdtE8: 1_200_0000_0000n },
    { venue: 'textile-rfq', base: 'wARS', tokensPerUsdtE8: 1_201_0000_0000n },
    { venue: 'uniswap-v3', base: 'cNGN', tokensPerUsdtE8: 136_800_000_000n },
    { venue: 'textile-rfq', base: 'cNGN', tokensPerUsdtE8: 137_000_000_000n },
    { venue: 'mento-broker', base: 'NGNm', tokensPerUsdtE8: 133_500_000_000n },
    { venue: 'uniswap-v3', base: 'cUSD', tokensPerUsdtE8: 100_000_000n },
    { venue: 'mento-v3', base: 'cUSD', tokensPerUsdtE8: 100_050_000n },
  ]
}

/** The late-October picture: gross gaps inside a couple of basis points, net of costs negative. */
export function collapsedRates(): FixtureRate[] {
  return [
    { venue: 'uniswap-v3', base: 'wBRL', tokensPerUsdtE8: 540_000_000n },
    { venue: 'textile-rfq', base: 'wBRL', tokensPerUsdtE8: 540_080_000n },
    { venue: 'uniswap-v3', base: 'wARS', tokensPerUsdtE8: 1_200_0000_0000n },
    { venue: 'textile-rfq', base: 'wARS', tokensPerUsdtE8: 1_200_2000_0000n },
    { venue: 'uniswap-v3', base: 'cNGN', tokensPerUsdtE8: 136_800_000_000n },
    { venue: 'textile-rfq', base: 'cNGN', tokensPerUsdtE8: 136_820_000_000n },
    { venue: 'mento-broker', base: 'NGNm', tokensPerUsdtE8: 133_500_000_000n },
    { venue: 'uniswap-v3', base: 'cUSD', tokensPerUsdtE8: 100_000_000n },
    { venue: 'mento-broker', base: 'cUSD', tokensPerUsdtE8: 100_010_000n },
  ]
}

class RateVenue implements VenueAdapter {
  readonly chainId = 42220
  constructor(readonly id: VenueId, private rates: FixtureRate[]) {}

  supports(tokenIn: Token, tokenOut: Token): boolean {
    const base = tokenIn.symbol === 'USDT' ? tokenOut.symbol : tokenIn.symbol
    const quote = tokenIn.symbol === 'USDT' ? tokenIn.symbol : tokenOut.symbol
    return quote === 'USDT' && this.rates.some((rate) => rate.venue === this.id && rate.base === base)
  }

  async quote(request: QuoteRequest): Promise<VenueQuote | null> {
    const sellingUsdt = request.tokenIn.symbol === 'USDT'
    const baseSymbol = sellingUsdt ? request.tokenOut.symbol : request.tokenIn.symbol
    const other = sellingUsdt ? request.tokenIn.symbol : request.tokenOut.symbol
    if (other !== 'USDT') return null
    const rate = this.rates.find((item) => item.venue === this.id && item.base === baseSymbol)
    if (!rate) return null
    const base = TOKENS[rate.base]
    const amountOut = sellingUsdt
      ? tokensForUsdt(request.amountIn, rate.tokensPerUsdtE8, base.decimals)
      : usdtForTokens(request.amountIn, rate.tokensPerUsdtE8, base.decimals)
    if (amountOut <= 0n) return null
    return {
      venue: this.id,
      chainId: 42220,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      amountOut,
      firm: rate.firm ?? false,
      gasUnits: GAS[this.id],
      quotedAt: Date.now(),
      meta: { source: 'fixture', tokensPerUsdtE8: rate.tokensPerUsdtE8.toString() },
    }
  }
}

export function fixtureAdapters(scenario: 'profitable' | 'collapsed'): VenueAdapter[] {
  const rates = scenario === 'profitable' ? profitableRates() : collapsedRates()
  const ids = [...new Set(rates.map((rate) => rate.venue))]
  return ids.map((id) => new RateVenue(id, rates))
}

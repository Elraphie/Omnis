import type { PricedQuote } from '../strategies/arbitrage.js'
import { TOKENS } from '../config/tokens.js'

/** The fiat currency each token is meant to track. Reference rates are units of that currency per 1 USD. */
export const TRACKS: Record<string, string> = {
  USDC: 'USD',
  cUSD: 'USD',
  cEUR: 'EUR',
  cREAL: 'BRL',
  wBRL: 'BRL',
  wARS: 'ARS',
  wCOP: 'COP',
  wMXN: 'MXN',
  cNGN: 'NGN',
  NGNm: 'NGN',
  IDRX: 'IDR',
}

export interface ReferenceRates {
  source: string
  /** When the source last updated its rates, not when we fetched them. */
  asOf: string
  perUsd: Record<string, number>
}

export interface ReferenceFeed {
  /** Never throws. Returns the last good rates when a refresh fails, or null if there never were any. */
  get(now?: number): Promise<ReferenceRates | null>
}

/** ExchangeRate-API's open endpoint (`/v6/latest/USD`). Daily rates, no key. */
export function parseErApi(body: unknown, source: string): ReferenceRates {
  const root = body as { result?: string; base_code?: string; time_last_update_unix?: number; rates?: Record<string, unknown> }
  if (root.result !== 'success' || root.base_code !== 'USD' || !root.rates) throw new Error('reference rates were not a USD success response')
  const perUsd: Record<string, number> = { USD: 1 }
  for (const [code, value] of Object.entries(root.rates)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) perUsd[code] = value
  }
  const asOf = typeof root.time_last_update_unix === 'number' ? new Date(root.time_last_update_unix * 1000).toISOString() : new Date(0).toISOString()
  return { source, asOf, perUsd }
}

export function createReferenceFeed(opts: {
  url: string
  ttlMs: number
  timeoutMs: number
  fetchImpl?: typeof fetch
  onError?: (message: string) => void
}): ReferenceFeed {
  const fetcher = opts.fetchImpl ?? fetch
  let last: ReferenceRates | null = null
  let fetchedAt = 0
  return {
    async get(now = Date.now()) {
      if (last && now - fetchedAt < opts.ttlMs) return last
      try {
        const response = await fetcher(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs), headers: { 'user-agent': 'omnis/2.0' } })
        if (!response.ok) throw new Error(`reference HTTP ${response.status}`)
        last = parseErApi(await response.json(), new URL(opts.url).host)
        fetchedAt = now
      } catch (error) {
        opts.onError?.(error instanceof Error ? error.message : String(error))
      }
      return last
    },
  }
}

export interface ReferenceGap {
  corridor: string
  venue: string
  /** buy: USDT into the token on-chain. sell: the token back to USDT on-chain. */
  side: 'buy' | 'sell'
  sizeUsd: number
  onchainPerUsd: number
  refPerUsd: number
  /** Positive when the on-chain side beats the reference rate, before gas. */
  gapBps: number
}

function whole(atomic: bigint, decimals: number): number {
  return Number(atomic) / 10 ** decimals
}

/**
 * Compares each venue's executable price at one clip size with the fiat reference.
 * A positive buy gap means USDT buys more of the currency on-chain than the reference rate gives.
 * A positive sell gap means the currency sells on-chain for more USD than the reference rate gives.
 */
export function referenceGaps(args: {
  corridors: { id: string; base: string }[]
  quotes: PricedQuote[]
  reference: ReferenceRates
  sizeUsdMicros: bigint
}): ReferenceGap[] {
  const out: ReferenceGap[] = []
  for (const corridor of args.corridors) {
    const currency = TRACKS[corridor.base]
    const refPerUsd = currency ? args.reference.perUsd[currency] : undefined
    const decimals = TOKENS[corridor.base as keyof typeof TOKENS]?.decimals
    if (!refPerUsd || decimals === undefined) continue
    const buys = args.quotes.filter((quote) =>
      quote.tokenIn === 'USDT' && quote.tokenOut === corridor.base && quote.amountIn === args.sizeUsdMicros && quote.amountOut > 0n)
    for (const buy of buys) {
      const sizeUsd = whole(buy.amountIn, 6)
      const boughtPerUsd = whole(buy.amountOut, decimals) / sizeUsd
      out.push({ corridor: corridor.id, venue: buy.venue, side: 'buy', sizeUsd, onchainPerUsd: boughtPerUsd, refPerUsd, gapBps: (boughtPerUsd / refPerUsd - 1) * 10_000 })
      const sell = args.quotes.find((quote) =>
        quote.venue === buy.venue && quote.tokenIn === corridor.base && quote.tokenOut === 'USDT' && quote.amountIn === buy.amountOut && quote.amountOut > 0n)
      if (!sell) continue
      const soldPerUsd = whole(sell.amountIn, decimals) / whole(sell.amountOut, 6)
      out.push({ corridor: corridor.id, venue: sell.venue, side: 'sell', sizeUsd, onchainPerUsd: soldPerUsd, refPerUsd, gapBps: (refPerUsd / soldPerUsd - 1) * 10_000 })
    }
  }
  return out
}

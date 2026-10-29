import type { VenueId } from '../config/tokens.js'
import { edgeAfterCosts, gasCostUsdMicros, type Edge } from '../pricing/math.js'

export interface PricedQuote {
  venue: VenueId
  tokenIn: string
  tokenOut: string
  tokenInAddress: string
  tokenOutAddress: string
  amountIn: bigint
  amountOut: bigint
  firm: boolean
  gasUnits: bigint
}

export interface ArbOpportunity extends Edge {
  corridor: string
  buyVenue: VenueId
  sellVenue: VenueId
  sizeUsdMicros: bigint
  amountIn: bigint
  midAmount: bigint
  amountOut: bigint
  buyFirm: boolean
  sellFirm: boolean
}

export function findArbs(args: {
  corridors: { id: string; base: string; quote: string }[]
  quotes: PricedQuote[]
  gasPriceWei: bigint
  celoUsdMicros: bigint
  adverseBps: bigint
}): ArbOpportunity[] {
  const opps: ArbOpportunity[] = []
  for (const corridor of args.corridors) {
    const buys = args.quotes.filter(
      (quote) => quote.tokenIn === corridor.quote && quote.tokenOut === corridor.base,
    )
    for (const buy of buys) {
      const sells = args.quotes.filter(
        (quote) =>
          quote.venue !== buy.venue &&
          quote.tokenIn === corridor.base &&
          quote.tokenOut === corridor.quote &&
          quote.tokenInAddress.toLowerCase() === buy.tokenOutAddress.toLowerCase() &&
          quote.tokenOutAddress.toLowerCase() === buy.tokenInAddress.toLowerCase() &&
          quote.amountIn === buy.amountOut,
      )
      for (const sell of sells) {
        const nonFirmLegs = (buy.firm ? 0n : 1n) + (sell.firm ? 0n : 1n)
        const gasUsdMicros = gasCostUsdMicros(buy.gasUnits + sell.gasUnits, args.gasPriceWei, args.celoUsdMicros)
        const edge = edgeAfterCosts({
          amountInUsdMicros: buy.amountIn,
          amountOutUsdMicros: sell.amountOut,
          gasUsdMicros,
          adverseBps: args.adverseBps * nonFirmLegs,
        })
        opps.push({
          ...edge,
          corridor: corridor.id,
          buyVenue: buy.venue,
          sellVenue: sell.venue,
          sizeUsdMicros: buy.amountIn,
          amountIn: buy.amountIn,
          midAmount: buy.amountOut,
          amountOut: sell.amountOut,
          buyFirm: buy.firm,
          sellFirm: sell.firm,
        })
      }
    }
  }
  return opps
}

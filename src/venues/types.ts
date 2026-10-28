import type { Token, VenueId } from '../config/tokens.js'

export interface QuoteRequest {
  chainId: number
  tokenIn: Token
  tokenOut: Token
  amountIn: bigint
}

export interface VenueQuote {
  venue: VenueId
  chainId: number
  tokenIn: Token
  tokenOut: Token
  amountIn: bigint
  amountOut: bigint
  firm: boolean
  gasUnits: bigint
  quotedAt: number
  meta: Record<string, string | number | boolean>
}

/**
 * One venue on one chain. Adapters return null when they have no market;
 * they throw only when the transport itself fails.
 */
export interface VenueAdapter {
  readonly id: VenueId
  readonly chainId: number
  supports(tokenIn: Token, tokenOut: Token): boolean
  quote(request: QuoteRequest): Promise<VenueQuote | null>
}

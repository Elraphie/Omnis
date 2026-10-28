import { CONTRACTS, type Token, type VenueId } from '../config/tokens.js'
import type { QuoteRequest, VenueAdapter, VenueQuote } from './types.js'

const TEXTILE = new Set(['wBRL', 'wARS', 'wCOP', 'wMXN', 'cNGN', 'IDRX', 'USDC', 'USDT'])

interface PreviewBody {
  status?: string
  buyAmount?: string
  feeAmount?: string
  reason?: string
  data?: PreviewBody
}

export function createTextileAdapter(apiBase: string, gasUnits: bigint, timeoutMs: number): VenueAdapter {
  const id: VenueId = 'textile-rfq'
  return {
    id,
    chainId: 42220,
    supports(tokenIn: Token, tokenOut: Token) {
      return TEXTILE.has(tokenIn.symbol) && TEXTILE.has(tokenOut.symbol) && tokenIn.symbol !== tokenOut.symbol
    },
    async quote(request: QuoteRequest): Promise<VenueQuote | null> {
      if (request.chainId !== 42220 || request.amountIn <= 0n) return null
      const response = await fetch(`${apiBase.replace(/\/$/, '')}/v2/rfq/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'omnis/2.0' },
        body: JSON.stringify({
          chainId: 42220,
          sellToken: request.tokenIn.address,
          buyToken: request.tokenOut.address,
          sellAmount: request.amountIn.toString(),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`Textile preview HTTP ${response.status}`)
      const body = (await response.json()) as PreviewBody
      const data = body.data ?? body
      if (data.status !== 'preview' || !data.buyAmount) return null
      const amountOut = BigInt(data.buyAmount)
      if (amountOut <= 0n) return null
      return {
        venue: id,
        chainId: 42220,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        amountOut,
        firm: false,
        gasUnits,
        quotedAt: Date.now(),
        meta: { feeAmount: data.feeAmount ?? '0', reactor: CONTRACTS.textileReactor },
      }
    },
  }
}

export interface TextileFirmQuote {
  rfqId: string
  buyAmount: bigint
  feeAmount: bigint
  expiresAt: string
  to: `0x${string}`
  data: `0x${string}`
}

/** Firm quotes are checked against Textile's published Celo reactor before any calldata is returned. */
export function parseTextileFirm(body: unknown, expectedReactor: string): TextileFirmQuote {
  const root = body as { data?: Record<string, unknown>; error?: { message?: string } }
  const data = (root.data ?? root) as Record<string, unknown>
  if (data.status === 'no_quote') throw new Error(`Textile has no firm quote (${String(data.reason ?? 'no_quote')})`)
  const quote = data.quote as Record<string, unknown> | undefined
  const transactions = data.transactions as { swap?: { to?: string; data?: string } } | undefined
  if (!quote || !transactions?.swap?.to || !transactions.swap.data) throw new Error('Textile firm quote was incomplete')
  const reactor = String(quote.reactor ?? '').toLowerCase()
  const to = String(transactions.swap.to).toLowerCase()
  if (reactor !== expectedReactor.toLowerCase() || to !== expectedReactor.toLowerCase()) {
    throw new Error('Unexpected Textile reactor, refusing to build')
  }
  return {
    rfqId: String(data.rfqId ?? ''),
    buyAmount: BigInt(String(quote.buyAmount)),
    feeAmount: BigInt(String(quote.feeAmount ?? '0')),
    expiresAt: String(quote.expiresAt ?? ''),
    to: transactions.swap.to as `0x${string}`,
    data: transactions.swap.data as `0x${string}`,
  }
}

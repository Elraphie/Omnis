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

/**
 * The exact text Textile verifies for an `eip191` proof of control (see /v2/openapi.json, takerProof.scheme).
 * Signing it approves no transfer, trade, or allowance.
 */
export function takerProofText(taker: string, chainId: number, nonce: string, issuedAt: number): string {
  return [
    'Textile Taker Control',
    'Version: 1',
    '',
    'Sign to prove you control this wallet so Textile can request a firm',
    'quote for it. This does not approve any transfer, trade or allowance.',
    '',
    `Wallet: ${taker.toLowerCase()}`,
    `Chain: ${chainId}`,
    `Nonce: ${nonce.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
  ].join('\n')
}

/** Signs Textile's proof-of-control message only. It never sees a transaction. */
export interface TakerProofSigner {
  address: `0x${string}`
  signMessage(args: { message: string }): Promise<`0x${string}`>
}

export type TextileFirmOutcome =
  | { status: 'quoted'; firm: TextileFirmQuote; spender: string; latencyMs: number }
  | { status: 'no_quote' | 'refused' | 'error'; reason: string; latencyMs: number }

/**
 * Requests a firm, taker-bound quote and always releases it again with /cancel. Measurement only:
 * the quote is never accepted or settled. Textile checks that the taker holds the sell amount.
 */
export async function probeTextileFirm(args: {
  apiBase: string
  signer: TakerProofSigner
  sellToken: string
  buyToken: string
  sellAmount: bigint
  expectedReactor: string
  timeoutMs: number
  randomNonce: () => string
  fetchImpl?: typeof fetch
}): Promise<TextileFirmOutcome> {
  const fetcher = args.fetchImpl ?? fetch
  const base = args.apiBase.replace(/\/$/, '')
  const started = Date.now()
  const nonce = args.randomNonce()
  const issuedAt = Date.now()
  try {
    const signature = await args.signer.signMessage({ message: takerProofText(args.signer.address, 42220, nonce, issuedAt) })
    const response = await fetcher(`${base}/v2/rfq/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'omnis/2.0' },
      body: JSON.stringify({
        chainId: 42220,
        sellToken: args.sellToken,
        buyToken: args.buyToken,
        sellAmount: args.sellAmount.toString(),
        taker: args.signer.address,
        takerProof: { nonce, issuedAt, signature, scheme: 'eip191' },
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    })
    const body = await response.json() as {
      data?: { rfqId?: string; claimToken?: string; status?: string; reason?: string; quote?: { spender?: string } }
      error?: { message?: string; details?: { reason?: string } }
    }
    const latencyMs = Date.now() - started
    const data = body.data
    if (data?.rfqId && data.claimToken) {
      // Release it whatever happens next, so makers are not left holding inventory for a quote we will not fill.
      await fetcher(`${base}/v2/rfq/${encodeURIComponent(data.rfqId)}/cancel`, {
        method: 'POST',
        headers: { 'x-rfq-claim': data.claimToken, 'user-agent': 'omnis/2.0' },
        signal: AbortSignal.timeout(args.timeoutMs),
      }).catch(() => undefined)
    }
    if (!response.ok) {
      return { status: 'refused', reason: body.error?.details?.reason ?? body.error?.message ?? `HTTP ${response.status}`, latencyMs }
    }
    if (data?.status !== 'quoted') return { status: 'no_quote', reason: data?.reason ?? 'no_quote', latencyMs }
    return { status: 'quoted', firm: parseTextileFirm(body, args.expectedReactor), spender: String(data.quote?.spender ?? ''), latencyMs }
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started }
  }
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

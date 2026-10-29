import { formatUnits, isAddress, parseUnits, type Address, type Hex } from 'viem'
import { buildExactApprovals, type UnsignedCall } from '../chain/approvals.js'
import { attributionSuffix, tagCalldata } from '../chain/attribution.js'
import type { AppConfig } from '../config/load.js'
import { token, type Token } from '../config/tokens.js'
import { minOut, selectBestRoute, splitInputFee, type RouteCandidate } from '../pricing/math.js'
import { buildMentoBrokerSwap, buildMentoV3Swap, buildTransfer, buildUniswapSwap, spenderFor } from '../execution/build.js'
import { parseTextileFirm } from '../venues/textile.js'
import type { VenueQuote } from '../venues/types.js'
import { CONTRACTS } from '../config/tokens.js'

export interface ConvertRoute {
  venue: string
  amountOut: string
  firm: boolean
  gasUsd: number
  meta: Record<string, string | number | boolean>
}

export interface ConvertQuote {
  from: string
  to: string
  amountIn: string
  feeBps: number
  feeToken: string
  feeAmount: string
  swapAmount: string
  treasury: string | null
  feeAtomic: boolean
  routes: ConvertRoute[]
  best: { venue: string; amountOut: string; minAmountOut: string } | null
  advantageBps: number | null
}

export interface ConvertBuild extends ConvertQuote {
  wallet: Address
  steps: { kind: 'transfer' | 'approve' | 'swap'; description: string; to: Address; data: Hex; value: '0' }[]
}

function fmt(tokenInfo: Token, amount: bigint): string {
  return formatUnits(amount, tokenInfo.decimals)
}

export function parseConvertAmount(symbol: string, amount: string, maxUsdtMicros: bigint): { token: Token; amount: bigint } {
  const info = token(symbol)
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('amount must be a positive number')
  const parsed = parseUnits(amount, info.decimals)
  if (parsed <= 0n) throw new Error('amount must be positive')
  if (info.symbol === 'USDT' && parsed > maxUsdtMicros) {
    throw new Error(`Max ${formatUnits(maxUsdtMicros, 6)} USDT per conversion`)
  }
  return { token: info, amount: parsed }
}

export function assembleQuote(args: {
  from: Token
  to: Token
  amountIn: bigint
  feeBps: bigint
  treasury: Address | null
  quotes: VenueQuote[]
  slippageBps: bigint
}): ConvertQuote {
  const { fee, swapAmount } = args.feeBps > 0n ? splitInputFee(args.amountIn, args.feeBps) : { fee: 0n, swapAmount: args.amountIn }
  const candidates: RouteCandidate[] = args.quotes
    .filter((quote) => quote.amountIn === swapAmount && quote.amountOut > 0n)
    .map((quote) => ({ venue: quote.venue, amountOut: quote.amountOut, firm: quote.firm, gasUsdMicros: quote.gasUnits }))
  const best = selectBestRoute(candidates)
  const sorted = [...candidates].sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1))
  const second = sorted.find((route) => route.venue !== best?.venue)
  const advantageBps = best && second && second.amountOut > 0n
    ? Number(((best.amountOut - second.amountOut) * 10_000n) / second.amountOut)
    : null
  const byVenue = new Map(args.quotes.map((quote) => [quote.venue, quote]))
  return {
    from: args.from.symbol,
    to: args.to.symbol,
    amountIn: fmt(args.from, args.amountIn),
    feeBps: Number(args.feeBps),
    feeToken: args.from.symbol,
    feeAmount: fmt(args.from, fee),
    swapAmount: fmt(args.from, swapAmount),
    treasury: args.treasury,
    feeAtomic: false,
    routes: sorted.map((route) => {
      const quote = byVenue.get(route.venue as VenueQuote['venue'])
      return {
        venue: route.venue,
        amountOut: fmt(args.to, route.amountOut),
        firm: route.firm,
        gasUsd: 0,
        meta: quote?.meta ?? {},
      }
    }),
    best: best ? {
      venue: best.venue,
      amountOut: fmt(args.to, best.amountOut),
      minAmountOut: fmt(args.to, minOut(best.amountOut, args.slippageBps)),
    } : null,
    advantageBps,
  }
}

function step(call: UnsignedCall, kind: 'transfer' | 'approve' | 'swap') {
  return { kind, description: call.description, to: call.to, data: call.data, value: '0' as const }
}

export function buildSteps(args: {
  from: Token
  to: Token
  wallet: Address
  fee: bigint
  swapAmount: bigint
  treasury: Address | null
  allowance: bigint
  quote: VenueQuote
  slippageBps: bigint
  suffix: Hex | null
  textile?: { to: Address; data: Hex; buyAmount: bigint }
  deadline?: bigint
}): UnsignedCall[] {
  const calls: UnsignedCall[] = []
  if (args.fee > 0n) {
    if (!args.treasury) throw new Error('treasury is required when a fee is charged')
    calls.push(buildTransfer(args.from, args.treasury, args.fee, args.suffix))
  }
  const spender = spenderFor(args.quote.venue)
  calls.push(...buildExactApprovals({
    token: args.from.address,
    spender,
    ownerAllowance: args.allowance,
    required: args.swapAmount,
    symbol: args.from.symbol,
  }).map((call) => ({ ...call, data: call.data })))
  // Approvals are tagged by the caller below so a reset and the exact approve share the suffix.
  const floor = minOut(args.textile?.buyAmount ?? args.quote.amountOut, args.slippageBps)
  if (args.quote.venue === 'uniswap-v3') {
    const feeTier = Number(args.quote.meta.feeTier ?? 0)
    if (!feeTier) throw new Error('Uniswap quote is missing a fee tier')
    calls.push(buildUniswapSwap({
      tokenIn: args.from, tokenOut: args.to, feeTier, recipient: args.wallet,
      amountIn: args.swapAmount, minAmountOut: floor, suffix: args.suffix,
    }))
  } else if (args.quote.venue === 'mento-broker') {
    const exchangeId = String(args.quote.meta.exchangeId ?? '')
    if (!exchangeId.startsWith('0x')) throw new Error('Mento quote is missing an exchange id')
    calls.push(buildMentoBrokerSwap({
      tokenIn: args.from, tokenOut: args.to, exchangeId: exchangeId as Hex,
      amountIn: args.swapAmount, minAmountOut: floor, suffix: args.suffix,
    }))
  } else if (args.quote.venue === 'mento-v3') {
    calls.push(buildMentoV3Swap({
      tokenIn: args.from, tokenOut: args.to, amountIn: args.swapAmount, minAmountOut: floor,
      recipient: args.wallet, deadline: args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 600), suffix: args.suffix,
    }))
  } else if (args.quote.venue === 'textile-rfq') {
    if (!args.textile) throw new Error('Textile route needs a firm quote')
    if (args.textile.to.toLowerCase() !== CONTRACTS.textileReactor.toLowerCase()) {
      throw new Error('Unexpected Textile reactor, refusing to build')
    }
    calls.push({
      to: args.textile.to,
      value: 0n,
      description: `Swap ${args.from.symbol} for ${args.to.symbol} on Textile FX`,
      data: tagCalldata(args.textile.data, args.suffix),
    })
  } else {
    throw new Error(`cannot build venue ${args.quote.venue}`)
  }
  return calls.map((call) => ({ ...call, data: tagCalldata(call.data, args.suffix) }))
}

export function stepsForWallet(calls: UnsignedCall[]): ConvertBuild['steps'] {
  return calls.map((call) => step(call, call.description.startsWith('Transfer') ? 'transfer' : call.description.startsWith('Swap') ? 'swap' : 'approve'))
}

export function suffixFor(cfg: AppConfig): Hex | null {
  return attributionSuffix(cfg.attributionTag)
}

export function requireWallet(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('wallet must be a valid address')
  return value
}

export { parseTextileFirm }

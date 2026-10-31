import type { Hex } from 'viem'
import { CONTRACTS, CORRIDORS, token, type Token, type VenueId } from '../config/tokens.js'
import { gasCostUsdMicros, microsToNumber, minOut } from '../pricing/math.js'
import type { ArbOpportunity } from '../strategies/arbitrage.js'
import { probeTextileFirm, type TakerProofSigner } from '../venues/textile.js'
import type { VenueAdapter, VenueQuote } from '../venues/types.js'
import { withTimeout } from '../util.js'
import { buildMentoBrokerSwap, buildMentoV3Swap, buildUniswapSwap } from './build.js'

/**
 * Shadow execution: walk an opportunity's two legs the way live mode would, at the moment it is chosen,
 * and record what would have happened. It re-prices every leg, binds a firm Textile quote when it can,
 * and builds each leg's calldata. It never signs or sends a transaction.
 */

export type LegStatus = 'priced' | 'firm' | 'preview_only' | 'no_quote' | 'refused' | 'error'

export interface ShadowLeg {
  venue: VenueId
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  status: LegStatus
  /** Rate now against the rate the scan saw, normalised for size. Negative means it moved against us. */
  driftBps: number | null
  latencyMs: number
  built: boolean
  detail: string
}

export type ShadowOutcome = 'would_fill' | 'edge_gone' | 'leg_failed'

export interface ShadowResult {
  corridor: string
  buyVenue: VenueId
  sellVenue: VenueId
  sizeUsd: number
  /** What the scan saw after gas, before the adverse cushion. */
  scanNetUsd: number
  scanNetBps: number
  outcome: ShadowOutcome
  /** Re-priced round trip after gas. Leftover from sizing leg two at leg one's minimum is marked at leg two's rate. */
  netUsd: number | null
  netBps: number | null
  legs: ShadowLeg[]
  elapsedMs: number
}

export interface ShadowDeps {
  adapters: VenueAdapter[]
  slippageBps: bigint
  gasPriceWei: bigint
  celoUsdMicros: bigint
  timeoutMs: number
  textileApi: string
  /** Present only with SHADOW_TAKER_KEY. Without it the Textile leg is a fresh preview, not a firm quote. */
  takerSigner: TakerProofSigner | null
  randomNonce: () => string
  fetchImpl?: typeof fetch
}

function rateDriftBps(scanIn: bigint, scanOut: bigint, nowIn: bigint, nowOut: bigint): number | null {
  if (scanIn <= 0n || scanOut <= 0n || nowIn <= 0n || nowOut <= 0n) return null
  return ((Number(nowOut) * Number(scanIn)) / (Number(scanOut) * Number(nowIn)) - 1) * 10_000
}

function buildFor(quote: VenueQuote, slippageBps: bigint, recipient: `0x${string}`): { built: boolean; detail: string } {
  const floor = minOut(quote.amountOut, slippageBps)
  const suffix: Hex | null = null
  try {
    if (quote.venue === 'uniswap-v3') {
      const feeTier = Number(quote.meta.feeTier ?? 0)
      if (!feeTier) return { built: false, detail: 'no fee tier on the quote' }
      buildUniswapSwap({ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, feeTier, recipient, amountIn: quote.amountIn, minAmountOut: floor, suffix })
    } else if (quote.venue === 'mento-broker') {
      const exchangeId = String(quote.meta.exchangeId ?? '')
      if (!exchangeId.startsWith('0x')) return { built: false, detail: 'no exchange id on the quote' }
      buildMentoBrokerSwap({ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, exchangeId: exchangeId as Hex, amountIn: quote.amountIn, minAmountOut: floor, suffix })
    } else if (quote.venue === 'mento-v3') {
      buildMentoV3Swap({ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountIn: quote.amountIn, minAmountOut: floor, recipient, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), suffix })
    } else {
      return { built: false, detail: `no on-chain builder for ${quote.venue}` }
    }
    return { built: true, detail: '' }
  } catch (error) {
    return { built: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function priceLeg(args: {
  deps: ShadowDeps
  venue: VenueId
  tokenIn: Token
  tokenOut: Token
  amountIn: bigint
  scanIn: bigint
  scanOut: bigint
}): Promise<ShadowLeg> {
  const { deps, venue, tokenIn, tokenOut, amountIn } = args
  const started = Date.now()
  const base = { venue, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountIn }
  const adapter = deps.adapters.find((item) => item.id === venue)
  if (!adapter) {
    return { ...base, amountOut: 0n, status: 'error', driftBps: null, latencyMs: 0, built: false, detail: 'venue adapter missing' }
  }
  if (venue === 'textile-rfq' && deps.takerSigner) {
    const firm = await probeTextileFirm({
      apiBase: deps.textileApi, signer: deps.takerSigner, sellToken: tokenIn.address, buyToken: tokenOut.address, sellAmount: amountIn,
      expectedReactor: CONTRACTS.textileReactor, timeoutMs: Math.max(deps.timeoutMs, 75_000), randomNonce: deps.randomNonce, fetchImpl: deps.fetchImpl,
    })
    if (firm.status !== 'quoted') {
      return { ...base, amountOut: 0n, status: firm.status, driftBps: null, latencyMs: firm.latencyMs, built: false, detail: firm.reason }
    }
    const spenderNote = firm.spender && firm.spender.toLowerCase() !== CONTRACTS.textileReactor.toLowerCase() ? `approval spender ${firm.spender} is not the reactor` : ''
    return {
      ...base, amountOut: firm.firm.buyAmount, status: 'firm', latencyMs: firm.latencyMs,
      driftBps: rateDriftBps(args.scanIn, args.scanOut, amountIn, firm.firm.buyAmount),
      built: firm.firm.data.length > 2, detail: spenderNote,
    }
  }
  try {
    const quote = await withTimeout(adapter.quote({ chainId: 42220, tokenIn, tokenOut, amountIn }), deps.timeoutMs, venue)
    const latencyMs = Date.now() - started
    if (!quote || quote.amountOut <= 0n) {
      return { ...base, amountOut: 0n, status: 'no_quote', driftBps: null, latencyMs, built: false, detail: '' }
    }
    const driftBps = rateDriftBps(args.scanIn, args.scanOut, amountIn, quote.amountOut)
    if (venue === 'textile-rfq') {
      return { ...base, amountOut: quote.amountOut, status: 'preview_only', driftBps, latencyMs, built: false, detail: 'set SHADOW_TAKER_KEY for a firm quote' }
    }
    const build = buildFor(quote, deps.slippageBps, deps.takerSigner?.address ?? '0x000000000000000000000000000000000000dEaD')
    return { ...base, amountOut: quote.amountOut, status: 'priced', driftBps, latencyMs, ...build }
  } catch (error) {
    return { ...base, amountOut: 0n, status: 'error', driftBps: null, latencyMs: Date.now() - started, built: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function legPriced(leg: ShadowLeg): boolean {
  return leg.amountOut > 0n && (leg.status === 'priced' || leg.status === 'firm' || leg.status === 'preview_only')
}

export async function shadowArb(opp: ArbOpportunity, deps: ShadowDeps, gasUnitsFor: (venue: VenueId) => bigint): Promise<ShadowResult> {
  const started = Date.now()
  const corridor = CORRIDORS.find((item) => item.id === opp.corridor)
  if (!corridor) throw new Error(`unknown corridor ${opp.corridor}`)
  const usdt = token('USDT')
  const asset = token(corridor.base)
  // The shadow net carries no adverse cushion, it is what re-pricing found, so the scan figure it is compared with
  // drops the cushion too. Otherwise the cushion would read as edge lost between seeing and acting.
  const scanNet = opp.netUsdMicros + opp.adverseUsdMicros
  const head = {
    corridor: opp.corridor, buyVenue: opp.buyVenue, sellVenue: opp.sellVenue,
    sizeUsd: microsToNumber(opp.sizeUsdMicros), scanNetUsd: microsToNumber(scanNet), scanNetBps: Number((scanNet * 10_000n) / opp.amountIn),
  }

  const buyLeg = await priceLeg({ deps, venue: opp.buyVenue, tokenIn: usdt, tokenOut: asset, amountIn: opp.amountIn, scanIn: opp.amountIn, scanOut: opp.midAmount })
  if (!legPriced(buyLeg)) {
    return { ...head, outcome: 'leg_failed', netUsd: null, netBps: null, legs: [buyLeg], elapsedMs: Date.now() - started }
  }
  // Leg two sells what leg one is guaranteed to deliver, so a short fill on leg one cannot leave leg two unfunded.
  const guaranteed = buyLeg.status === 'firm' ? buyLeg.amountOut : minOut(buyLeg.amountOut, deps.slippageBps)
  const sellLeg = await priceLeg({ deps, venue: opp.sellVenue, tokenIn: asset, tokenOut: usdt, amountIn: guaranteed, scanIn: opp.midAmount, scanOut: opp.amountOut })
  const legs = [buyLeg, sellLeg]
  if (!legPriced(sellLeg)) {
    return { ...head, outcome: 'leg_failed', netUsd: null, netBps: null, legs, elapsedMs: Date.now() - started }
  }
  const proceeds = (sellLeg.amountOut * buyLeg.amountOut) / guaranteed
  const gas = gasCostUsdMicros(gasUnitsFor(opp.buyVenue) + gasUnitsFor(opp.sellVenue), deps.gasPriceWei, deps.celoUsdMicros)
  const net = proceeds - opp.amountIn - gas
  return {
    ...head,
    outcome: net > 0n ? 'would_fill' : 'edge_gone',
    netUsd: microsToNumber(net),
    netBps: Number((net * 10_000n) / opp.amountIn),
    legs,
    elapsedMs: Date.now() - started,
  }
}

/** JSON-safe copy for the cycle report and the store; atomic amounts become strings. */
export function shadowView(result: ShadowResult) {
  return {
    ...result,
    legs: result.legs.map((leg) => ({ ...leg, amountIn: leg.amountIn.toString(), amountOut: leg.amountOut.toString() })),
  }
}
export type ShadowView = ReturnType<typeof shadowView>

/** Picks what shadow mode walks: the scan's best round trip by dollars, if it clears `minNetBps`. */
export function shadowCandidate(opps: ArbOpportunity[], minNetBps: bigint): ArbOpportunity | null {
  return opps
    .filter((opp) => opp.buyVenue !== opp.sellVenue && opp.netBps >= minNetBps)
    .reduce<ArbOpportunity | null>((best, opp) => (!best || opp.netUsdMicros > best.netUsdMicros ? opp : best), null)
}

/** At most `perHour` shadow runs in any rolling hour, so Textile is not flooded with quotes we will not fill. */
export function shadowBudget(perHour: number): (now?: number) => boolean {
  const runs: number[] = []
  return (now = Date.now()) => {
    while (runs.length && now - runs[0]! >= 3_600_000) runs.shift()
    if (runs.length >= perHour) return false
    runs.push(now)
    return true
  }
}

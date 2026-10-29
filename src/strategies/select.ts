import type { ArbOpportunity } from './arbitrage.js'
import { selectBestArb, type ArbCandidate } from '../pricing/math.js'
import type { RebalanceOrder } from '../pricing/math.js'

export interface StrategyChoice {
  strategy: 'arbitrage' | 'market-make' | 'rebalance' | 'scan'
  action: 'arbitrage' | 'market-make' | 'rebalance' | 'hold'
  reason: string
}

export function chooseStrategy(args: {
  arb: ArbOpportunity | null
  arbBlock: string | null
  marketMake: boolean
  marketMakeBlock: string | null
  rebalance: RebalanceOrder | null
  rebalanceBlock: string | null
}): StrategyChoice {
  if (args.arb && !args.arbBlock) {
    return { strategy: 'arbitrage', action: 'arbitrage', reason: 'net edge clears costs and risk limits' }
  }
  if (args.marketMake && !args.marketMakeBlock) {
    return { strategy: 'market-make', action: 'market-make', reason: 'a venue crossed the skewed quote' }
  }
  if (args.rebalance && !args.rebalanceBlock) {
    return { strategy: 'rebalance', action: 'rebalance', reason: 'inventory drift exceeded the threshold' }
  }
  if (args.arb && args.arbBlock) return { strategy: 'arbitrage', action: 'hold', reason: args.arbBlock }
  if (args.rebalance && args.rebalanceBlock) return { strategy: 'rebalance', action: 'hold', reason: args.rebalanceBlock }
  return { strategy: 'scan', action: 'hold', reason: 'no positive edge' }
}

export function bestArb(opps: ArbOpportunity[], minEdgeUsd: bigint, minEdgeBps: bigint): ArbOpportunity | null {
  const picked = selectBestArb(
    opps.map((opp) => ({
      id: `${opp.corridor}:${opp.buyVenue}:${opp.sellVenue}:${opp.sizeUsdMicros}`,
      sizeUsdMicros: opp.sizeUsdMicros,
      netEdgeUsdMicros: opp.netUsdMicros,
      netEdgeBps: opp.netBps,
      venueBuy: opp.buyVenue,
      venueSell: opp.sellVenue,
    }) satisfies ArbCandidate),
    minEdgeUsd,
    minEdgeBps,
  )
  if (!picked) return null
  return opps.find((opp) => `${opp.corridor}:${opp.buyVenue}:${opp.sellVenue}:${opp.sizeUsdMicros}` === picked.id) ?? null
}

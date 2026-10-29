export const BPS = 10_000n
export const USD = 1_000_000n

export function usdToMicros(usd: number): bigint {
  if (!Number.isFinite(usd)) throw new Error('usd must be finite')
  const negative = usd < 0
  const [whole, frac = ''] = Math.abs(usd).toFixed(6).split('.')
  const micros = BigInt(`${whole}${frac}`)
  return negative ? -micros : micros
}

export function microsToNumber(micros: bigint): number {
  return Number(micros) / 1e6
}

export function formatUsd(micros: bigint, dp = 4): string {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  const whole = abs / USD
  const frac = (abs % USD).toString().padStart(6, '0').slice(0, dp)
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`
}

export function applyBps(value: bigint, bps: bigint): bigint {
  return (value * bps) / BPS
}

/** Input-side protocol fee. The swap is quoted on what remains. */
export function splitInputFee(amountIn: bigint, feeBps: bigint): { fee: bigint; swapAmount: bigint } {
  if (feeBps < 0n || feeBps > BPS) throw new Error('fee bps out of range')
  if (amountIn <= 0n) throw new Error('amount must be positive')
  const fee = (amountIn * feeBps) / BPS
  const swapAmount = amountIn - fee
  if (swapAmount <= 0n) throw new Error('fee consumes the entire amount')
  return { fee, swapAmount }
}

export function minOut(amountOut: bigint, slippageBps: bigint): bigint {
  if (amountOut < 0n) throw new Error('amount out must be non-negative')
  if (slippageBps < 0n || slippageBps >= BPS) throw new Error('slippage bps out of range')
  return (amountOut * (BPS - slippageBps)) / BPS
}

/** CELO gas priced into USD micros. gasPriceWei is wei per gas unit. */
export function gasCostUsdMicros(gasUnits: bigint, gasPriceWei: bigint, celoUsdMicros: bigint): bigint {
  if (gasUnits < 0n || gasPriceWei < 0n || celoUsdMicros < 0n) throw new Error('gas inputs must be non-negative')
  return (gasUnits * gasPriceWei * celoUsdMicros) / 10n ** 18n
}

export interface EdgeInput {
  amountInUsdMicros: bigint
  amountOutUsdMicros: bigint
  gasUsdMicros: bigint
  /** Decision hurdle in bps of notional. This is not a second copy of the pool fee. */
  adverseBps: bigint
}

export interface Edge {
  grossUsdMicros: bigint
  gasUsdMicros: bigint
  adverseUsdMicros: bigint
  netUsdMicros: bigint
  netBps: bigint
}

/**
 * Net edge of a round trip that starts and ends in USDT.
 * Quoted outputs are already net of venue fees. Slippage caps stay on the
 * transaction as a limit; `adverseBps` is only the expected cushion for a
 * quote that is not firm.
 */
export function edgeAfterCosts(input: EdgeInput): Edge {
  if (input.amountInUsdMicros <= 0n) throw new Error('amount in must be positive')
  if (input.adverseBps < 0n) throw new Error('adverse bps must be non-negative')
  const grossUsdMicros = input.amountOutUsdMicros - input.amountInUsdMicros
  const adverseUsdMicros = (input.amountInUsdMicros * input.adverseBps) / BPS
  const netUsdMicros = grossUsdMicros - input.gasUsdMicros - adverseUsdMicros
  return {
    grossUsdMicros,
    gasUsdMicros: input.gasUsdMicros,
    adverseUsdMicros,
    netUsdMicros,
    netBps: (netUsdMicros * BPS) / input.amountInUsdMicros,
  }
}

/** Whole-token FX units per 1 USD, scaled by 1e6. */
export function fxPerUsdMicros(amountInUsdt: bigint, amountOutAtomic: bigint, decimals: number): bigint {
  if (amountInUsdt <= 0n || amountOutAtomic <= 0n) return 0n
  return (amountOutAtomic * USD * USD) / (amountInUsdt * 10n ** BigInt(decimals))
}

export function gapBps(left: bigint, right: bigint): bigint | null {
  if (left <= 0n || right <= 0n) return null
  const diff = left > right ? left - right : right - left
  const mid = (left + right) / 2n
  if (mid === 0n) return null
  return (diff * BPS) / mid
}

export function assertSameAsset(
  left: { symbol: string; address: string },
  right: { symbol: string; address: string },
): void {
  if (left.symbol !== right.symbol || left.address.toLowerCase() !== right.address.toLowerCase()) {
    throw new Error(`refusing cross-asset route ${left.symbol} -> ${right.symbol}`)
  }
}

export interface SkewInput {
  midUsdMicrosPerToken: bigint
  spreadBps: bigint
  inventoryUsdMicros: bigint
  targetUsdMicros: bigint
  skewFactorBps: bigint
  maxSkewBps: bigint
  basisUsdMicros: bigint
}

export interface SkewQuote {
  bidUsdMicrosPerToken: bigint
  askUsdMicrosPerToken: bigint
  skewBps: bigint
}

/**
 * Long inventory (above target) shifts both sides down: we pay less to buy
 * more, and we offer inventory cheaper. Short inventory does the opposite.
 */
export function inventorySkewQuote(input: SkewInput): SkewQuote {
  if (input.midUsdMicrosPerToken <= 0n) throw new Error('mid must be positive')
  if (input.spreadBps <= 0n || input.spreadBps >= BPS) throw new Error('spread bps out of range')
  const basis = input.basisUsdMicros > 0n ? input.basisUsdMicros : 1n
  const deviationBps = ((input.inventoryUsdMicros - input.targetUsdMicros) * BPS) / basis
  let skewBps = (deviationBps * input.skewFactorBps) / BPS
  if (skewBps > input.maxSkewBps) skewBps = input.maxSkewBps
  if (skewBps < -input.maxSkewBps) skewBps = -input.maxSkewBps
  const half = input.spreadBps / 2n
  const bidPenalty = half + skewBps
  const askPremium = half - skewBps
  let bid = (input.midUsdMicrosPerToken * (BPS - bidPenalty)) / BPS
  let ask = (input.midUsdMicrosPerToken * (BPS + askPremium)) / BPS
  if (bid < 1n) bid = 1n
  if (ask <= bid) ask = bid + 1n
  return { bidUsdMicrosPerToken: bid, askUsdMicrosPerToken: ask, skewBps }
}

export interface Weight {
  symbol: string
  usdMicros: bigint
  targetBps: bigint
}

export interface RebalanceOrder {
  symbol: string
  side: 'buy' | 'sell'
  usdMicros: bigint
  driftBps: bigint
}

export function rebalanceOrders(input: {
  weights: Weight[]
  thresholdBps: bigint
  maxCostBps: bigint
  costBps: bigint
}): RebalanceOrder[] {
  if (input.costBps > input.maxCostBps) return []
  const total = input.weights.reduce((sum, row) => sum + (row.usdMicros > 0n ? row.usdMicros : 0n), 0n)
  if (total <= 0n) return []
  const orders: RebalanceOrder[] = []
  for (const row of input.weights) {
    const current = row.usdMicros > 0n ? (row.usdMicros * BPS) / total : 0n
    const drift = current - row.targetBps
    const abs = drift < 0n ? -drift : drift
    if (abs <= input.thresholdBps) continue
    const usdMicros = (abs * total) / BPS
    if (usdMicros <= 0n) continue
    orders.push({ symbol: row.symbol, side: drift > 0n ? 'sell' : 'buy', usdMicros, driftBps: drift })
  }
  orders.sort((a, b) => (a.usdMicros === b.usdMicros ? 0 : a.usdMicros > b.usdMicros ? -1 : 1))
  return orders
}

export interface RouteCandidate {
  venue: string
  amountOut: bigint
  firm: boolean
  gasUsdMicros: bigint
}

/** Best user outcome: more output, then a firm quote, then less gas. */
export function selectBestRoute(routes: RouteCandidate[]): RouteCandidate | null {
  const live = routes.filter((route) => route.amountOut > 0n)
  live.sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1
    if (a.firm !== b.firm) return a.firm ? -1 : 1
    if (a.gasUsdMicros !== b.gasUsdMicros) return a.gasUsdMicros < b.gasUsdMicros ? -1 : 1
    return 0
  })
  return live[0] ?? null
}

export interface ArbCandidate {
  id: string
  sizeUsdMicros: bigint
  netEdgeUsdMicros: bigint
  netEdgeBps: bigint
  venueBuy: string
  venueSell: string
}

/** Dollar edge wins. A smaller clip can beat a larger one after price impact. */
export function selectBestArb(opps: ArbCandidate[], minEdgeUsd: bigint, minEdgeBps: bigint): ArbCandidate | null {
  const viable = opps.filter(
    (opp) =>
      opp.venueBuy !== opp.venueSell &&
      opp.netEdgeUsdMicros >= minEdgeUsd &&
      opp.netEdgeBps >= minEdgeBps,
  )
  viable.sort((a, b) => (a.netEdgeUsdMicros === b.netEdgeUsdMicros ? 0 : a.netEdgeUsdMicros > b.netEdgeUsdMicros ? -1 : 1))
  return viable[0] ?? null
}

export function ladderSizes(maxUsdMicros: bigint, ladderBps: number[], minUsdMicros: bigint): bigint[] {
  const seen = new Set<string>()
  const sizes: bigint[] = []
  for (const bps of ladderBps) {
    const size = (maxUsdMicros * BigInt(bps)) / BPS
    if (size < minUsdMicros) continue
    const key = size.toString()
    if (seen.has(key)) continue
    seen.add(key)
    sizes.push(size)
  }
  return sizes
}

/** USDT micros paid or received per 1 whole token. */
export function usdMicrosPerToken(atomic: bigint, usdMicros: bigint, decimals: number): bigint {
  if (atomic <= 0n) return 0n
  return (usdMicros * 10n ** BigInt(decimals)) / atomic
}

export function killReason(manual: boolean, lossStopDay: string | null, today: string): string | null {
  if (manual) return 'kill switch'
  if (lossStopDay && lossStopDay === today) return 'daily loss stop'
  return null
}

export interface OpenRiskInput {
  manualKill: boolean
  lossStopDay: string | null
  today: string
  dailyRealizedUsdMicros: bigint
  maxDailyLossUsdMicros: bigint
  currentInventoryUsdMicros: bigint
  proposedAddUsdMicros: bigint
  maxInventoryUsdMicros: bigint
  netEdgeUsdMicros: bigint
  minEdgeUsdMicros: bigint
  netEdgeBps: bigint
  minEdgeBps: bigint
}

export type RiskDecision = { ok: true } | { ok: false; reason: string }

/** New risk: a round trip that can leave the local asset behind if leg two fails. */
export function reviewOpenRisk(input: OpenRiskInput): RiskDecision {
  const killed = killReason(input.manualKill, input.lossStopDay, input.today)
  if (killed) return { ok: false, reason: killed }
  if (input.dailyRealizedUsdMicros <= -input.maxDailyLossUsdMicros) {
    return { ok: false, reason: 'daily loss stop' }
  }
  const add = input.proposedAddUsdMicros > 0n ? input.proposedAddUsdMicros : 0n
  if (input.currentInventoryUsdMicros + add > input.maxInventoryUsdMicros) {
    return { ok: false, reason: 'inventory limit' }
  }
  if (input.netEdgeUsdMicros < input.minEdgeUsdMicros) return { ok: false, reason: 'edge below minimum usd' }
  if (input.netEdgeBps < input.minEdgeBps) return { ok: false, reason: 'edge below minimum bps' }
  return { ok: true }
}

/** Flattening inventory is allowed through the daily loss stop, not through a manual kill. */
export function reviewReduceRisk(manualKill: boolean): RiskDecision {
  if (manualKill) return { ok: false, reason: 'kill switch' }
  return { ok: true }
}

export function assertLiveAllowed(opts: {
  mode: string
  confirmLive: string | undefined
  canSign: boolean
  manualKill: boolean
}): void {
  if (opts.mode !== 'live') throw new Error('live execution blocked: mode is not live')
  if (opts.confirmLive !== 'I_UNDERSTAND') {
    throw new Error('live execution blocked: set CONFIRM_LIVE=I_UNDERSTAND')
  }
  if (!opts.canSign) throw new Error('live execution blocked: signer cannot sign')
  if (opts.manualKill) throw new Error('live execution blocked: kill switch')
}

export function shouldTripLossStop(dailyRealizedUsdMicros: bigint, maxDailyLossUsdMicros: bigint): boolean {
  return dailyRealizedUsdMicros <= -maxDailyLossUsdMicros
}

import type { Hex } from 'viem'
import type { UnsignedCall } from '../chain/approvals.js'
import type { TradingSigner } from '../chain/signer.js'
import { assertLiveAllowed } from '../risk/guards.js'

/**
 * The only broadcast path. Dry-run and paper never call it.
 * A Textile leg is refused here: a preview is not a fill, and sending leg one
 * alone would warehouse FX inventory.
 */
export async function executeLive(opts: {
  mode: string
  confirmLive: string | undefined
  manualKill: boolean
  signer: TradingSigner
  venues: string[]
  calls: UnsignedCall[]
}): Promise<Hex[]> {
  assertLiveAllowed({
    mode: opts.mode,
    confirmLive: opts.confirmLive,
    canSign: opts.signer.canSign,
    manualKill: opts.manualKill,
  })
  if (opts.venues.some((venue) => venue === 'textile-rfq')) {
    throw new Error('live Textile leg refused: bind a firm RFQ in the same cycle before sending, or stay in paper mode')
  }
  if (opts.calls.length === 0) throw new Error('live execution refused: no calls')
  const hashes: Hex[] = []
  for (const call of opts.calls) hashes.push(await opts.signer.signAndSend(call))
  return hashes
}

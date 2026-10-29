import { decodeFunctionData, erc20Abi } from 'viem'
import { describe, expect, it } from 'vitest'
import { buildExactApprovals, MAX_UINT256 } from '../src/chain/approvals.js'
import { tagCalldata } from '../src/chain/attribution.js'
import { TOKENS } from '../src/config/tokens.js'
import { buildSteps } from '../src/convert/service.js'
import { attributionSuffix } from '../src/chain/attribution.js'
import { executeLive } from '../src/execution/live.js'
import { readOnlySigner, type TradingSigner } from '../src/chain/signer.js'
import { assertLiveAllowed, killReason, reviewOpenRisk, reviewReduceRisk, shouldTripLossStop } from '../src/risk/guards.js'
import { findArbs } from '../src/strategies/arbitrage.js'
import { usdToMicros } from '../src/pricing/math.js'

const spender = '0x5615CDAb10dc425a742d643d949a7F474C01abc4'

describe('approvals', () => {
  it('approves the exact amount and resets a stale non-zero allowance', () => {
    const steps = buildExactApprovals({
      token: TOKENS.USDT.address,
      spender,
      ownerAllowance: 5n,
      required: 1_000_000n,
      symbol: 'USDT',
    })
    expect(steps).toHaveLength(2)
    const amounts = steps.map((step) => {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: step.data })
      expect(decoded.functionName).toBe('approve')
      return decoded.args[1]
    })
    expect(amounts).toEqual([0n, 1_000_000n])
    expect(amounts).not.toContain(MAX_UINT256)
  })

  it('skips an approval that is already sufficient and refuses unlimited', () => {
    expect(buildExactApprovals({
      token: TOKENS.USDT.address, spender, ownerAllowance: 10n, required: 10n, symbol: 'USDT',
    })).toEqual([])
    expect(() => buildExactApprovals({
      token: TOKENS.USDT.address, spender, ownerAllowance: 0n, required: MAX_UINT256, symbol: 'USDT',
    })).toThrow(/unlimited/)
  })

  it('tags convert approvals with the attribution suffix exactly once', () => {
    const suffix = attributionSuffix('omnis_fx')
    const quote = {
      venue: 'uniswap-v3' as const,
      chainId: 42220,
      tokenIn: TOKENS.USDT,
      tokenOut: TOKENS.wBRL,
      amountIn: 99_920_000n,
      amountOut: 500n * 10n ** 18n,
      firm: false,
      gasUnits: 180_000n,
      quotedAt: 0,
      meta: { feeTier: 100 },
    }
    const calls = buildSteps({
      from: TOKENS.USDT,
      to: TOKENS.wBRL,
      wallet: TOKENS.USDT.address,
      fee: 80_000n,
      swapAmount: 99_920_000n,
      treasury: '0x000000000000000000000000000000000000dEaD',
      allowance: 1n,
      quote,
      slippageBps: 50n,
      suffix,
    })
    const approve = calls.find((call) => call.description.startsWith('Approve'))
    expect(approve).toBeTruthy()
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve!.data.slice(0, 138) as `0x${string}` })
    expect(decoded.args[1]).toBe(99_920_000n)
    expect(approve!.data.toLowerCase().endsWith(suffix!.slice(2).toLowerCase())).toBe(true)
    expect(tagCalldata(approve!.data, suffix)).toBe(approve!.data)
    expect(calls.some((call) => call.data.includes(MAX_UINT256.toString(16)))).toBe(false)
  })
})

describe('risk guards', () => {
  const base = {
    manualKill: false,
    lossStopDay: null,
    today: '2026-10-28',
    dailyRealizedUsdMicros: 0n,
    maxDailyLossUsdMicros: usdToMicros(25),
    currentInventoryUsdMicros: 0n,
    proposedAddUsdMicros: usdToMicros(100),
    maxInventoryUsdMicros: usdToMicros(500),
    netEdgeUsdMicros: usdToMicros(1),
    minEdgeUsdMicros: usdToMicros(0.05),
    netEdgeBps: 20n,
    minEdgeBps: 3n,
  }

  it('blocks a kill switch, a daily loss, and an inventory breach', () => {
    expect(reviewOpenRisk({ ...base, manualKill: true }).ok).toBe(false)
    expect(reviewOpenRisk({ ...base, dailyRealizedUsdMicros: usdToMicros(-25) })).toMatchObject({ ok: false, reason: 'daily loss stop' })
    expect(reviewOpenRisk({ ...base, currentInventoryUsdMicros: usdToMicros(450) })).toMatchObject({ ok: false, reason: 'inventory limit' })
    expect(reviewOpenRisk(base).ok).toBe(true)
  })

  it('lets a flatten through the loss stop and not through a manual kill', () => {
    expect(reviewReduceRisk(false).ok).toBe(true)
    expect(reviewReduceRisk(true)).toMatchObject({ reason: 'kill switch' })
  })

  it('clears a loss stop on the next utc day', () => {
    expect(killReason(false, '2026-10-28', '2026-10-28')).toBe('daily loss stop')
    expect(killReason(false, '2026-10-28', '2026-10-29')).toBeNull()
    expect(shouldTripLossStop(usdToMicros(-25), usdToMicros(25))).toBe(true)
    expect(shouldTripLossStop(usdToMicros(-24.99), usdToMicros(25))).toBe(false)
  })

  it('refuses live execution unless every gate is open', async () => {
    expect(() => assertLiveAllowed({ mode: 'paper', confirmLive: 'I_UNDERSTAND', canSign: true, manualKill: false })).toThrow(/not live/)
    expect(() => assertLiveAllowed({ mode: 'live', confirmLive: 'yes', canSign: true, manualKill: false })).toThrow(/CONFIRM_LIVE/)
    expect(() => assertLiveAllowed({ mode: 'live', confirmLive: 'I_UNDERSTAND', canSign: false, manualKill: false })).toThrow(/cannot sign/)
    const signer: TradingSigner = {
      kind: 'local',
      address: TOKENS.USDT.address,
      canSign: true,
      signAndSend: async () => { throw new Error('should not send') },
    }
    await expect(executeLive({
      mode: 'dry-run', confirmLive: 'I_UNDERSTAND', manualKill: false, signer, venues: ['uniswap-v3'], calls: [],
    })).rejects.toThrow(/not live/)
    await expect(executeLive({
      mode: 'live', confirmLive: 'I_UNDERSTAND', manualKill: false, signer,
      venues: ['uniswap-v3', 'textile-rfq'],
      calls: [{ to: TOKENS.USDT.address, data: '0x1234', value: 0n, description: 'nope' }],
    })).rejects.toThrow(/Textile/)
    expect(readOnlySigner().canSign).toBe(false)
  })
})

describe('cross-asset guard', () => {
  it('does not pair cNGN with NGNm even if a quote is mislabeled', () => {
    const opps = findArbs({
      corridors: [{ id: 'cNGN', base: 'cNGN', quote: 'USDT' }],
      gasPriceWei: 1n,
      celoUsdMicros: usdToMicros(0.3),
      adverseBps: 2n,
      quotes: [
        {
          venue: 'uniswap-v3', tokenIn: 'USDT', tokenOut: 'cNGN',
          tokenInAddress: TOKENS.USDT.address, tokenOutAddress: TOKENS.cNGN.address,
          amountIn: 1_000_000n, amountOut: 50n, firm: false, gasUnits: 1n,
        },
        {
          venue: 'mento-broker', tokenIn: 'cNGN', tokenOut: 'USDT',
          tokenInAddress: TOKENS.NGNm.address, tokenOutAddress: TOKENS.USDT.address,
          amountIn: 50n, amountOut: 2_000_000n, firm: false, gasUnits: 1n,
        },
      ],
    })
    expect(opps).toEqual([])
  })
})

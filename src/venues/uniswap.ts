import { parseAbi } from 'viem'
import type { ChainClient } from '../chain/client.js'
import { CONTRACTS, type Token, type VenueId } from '../config/tokens.js'
import type { QuoteRequest, VenueAdapter, VenueQuote } from './types.js'

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
])
const routerAbi = parseAbi(['function factory() view returns (address)'])
const FEE_TIERS = [100, 500, 3000, 10_000]

export function createUniswapAdapter(client: ChainClient, gasUnits: bigint): VenueAdapter {
  let factoryOk: boolean | null = null
  const id: VenueId = 'uniswap-v3'
  return {
    id,
    chainId: 42220,
    supports(tokenIn: Token, tokenOut: Token) {
      return tokenIn.address.toLowerCase() !== tokenOut.address.toLowerCase()
    },
    async quote(request: QuoteRequest): Promise<VenueQuote | null> {
      if (request.chainId !== 42220 || request.amountIn <= 0n) return null
      if (factoryOk === null) {
        const factory = await client.readContract({ address: CONTRACTS.uniRouter, abi: routerAbi, functionName: 'factory' }) as string
        factoryOk = String(factory).toLowerCase() === CONTRACTS.uniFactory.toLowerCase()
        if (!factoryOk) throw new Error('Uniswap router factory mismatch, refusing to quote')
      }
      let best: { out: bigint; fee: number } | null = null
      await Promise.all(FEE_TIERS.map(async (fee) => {
        try {
          const result = await client.simulateContract({
            address: CONTRACTS.uniQuoter,
            abi: quoterAbi,
            functionName: 'quoteExactInputSingle',
            args: [{
              tokenIn: request.tokenIn.address,
              tokenOut: request.tokenOut.address,
              amountIn: request.amountIn,
              fee,
              sqrtPriceLimitX96: 0n,
            }],
          })
          const out = (result.result as readonly [bigint])[0]
          if (out > 0n && (!best || out > best.out)) best = { out, fee }
        } catch {
          // Empty fee tier.
        }
      }))
      if (!best) return null
      const chosen: { out: bigint; fee: number } = best
      return {
        venue: id,
        chainId: 42220,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        amountOut: chosen.out,
        firm: false,
        gasUnits,
        quotedAt: Date.now(),
        meta: { feeTier: chosen.fee },
      }
    },
  }
}

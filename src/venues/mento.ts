import { encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import type { ChainClient } from '../chain/client.js'
import { CONTRACTS, type Token, type VenueId } from '../config/tokens.js'
import type { QuoteRequest, VenueAdapter, VenueQuote } from './types.js'

const MENTO = new Set(['cUSD', 'cEUR', 'cREAL', 'NGNm', 'USDT', 'USDC', 'CELO'])
const brokerAbi = parseAbi([
  'function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut)',
])
const idsAbi = parseAbi(['function getExchangeIds() view returns (bytes32[])'])
const exchangesAbi = parseAbi(['function exchanges(bytes32 exchangeId) view returns (address asset0, address asset1)'])
const routerAbi = parseAbi([
  'struct Route { address from; address to; address factory; }',
  'function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)',
])

interface Pool {
  exchangeId: Hex
  asset0: Address
  asset1: Address
}

function pairKey(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join(':')
}

function wordAddress(data: Hex, index: number): Address {
  const start = 2 + index * 64
  return getAddress(`0x${data.slice(start + 24, start + 64)}`)
}

export function createMentoBrokerAdapter(client: ChainClient, gasUnits: bigint): VenueAdapter {
  let pools: Map<string, Pool> | null = null
  let failed = false
  const id: VenueId = 'mento-broker'

  async function loadPools(): Promise<Map<string, Pool>> {
    if (pools) return pools
    if (failed) return new Map()
    try {
      const ids = (await client.readContract({
        address: CONTRACTS.mentoBiPool,
        abi: idsAbi,
        functionName: 'getExchangeIds',
      })) as Hex[]
      const map = new Map<string, Pool>()
      for (const exchangeId of ids.slice(0, 48)) {
        const data = encodeFunctionData({ abi: exchangesAbi, functionName: 'exchanges', args: [exchangeId] })
        const raw = await client.call({ to: CONTRACTS.mentoBiPool, data })
        if (!raw.data || raw.data.length < 2 + 128) continue
        const asset0 = wordAddress(raw.data, 0)
        const asset1 = wordAddress(raw.data, 1)
        map.set(pairKey(asset0, asset1), { exchangeId, asset0, asset1 })
      }
      pools = map
      return map
    } catch (error) {
      failed = true
      throw error
    }
  }

  return {
    id,
    chainId: 42220,
    supports(tokenIn: Token, tokenOut: Token) {
      return MENTO.has(tokenIn.symbol) && MENTO.has(tokenOut.symbol)
    },
    async quote(request: QuoteRequest): Promise<VenueQuote | null> {
      if (request.chainId !== 42220 || request.amountIn <= 0n) return null
      const map = await loadPools()
      const pool = map.get(pairKey(request.tokenIn.address, request.tokenOut.address))
      if (!pool) return null
      try {
        const amountOut = (await client.readContract({
          address: CONTRACTS.mentoBroker,
          abi: brokerAbi,
          functionName: 'getAmountOut',
          args: [CONTRACTS.mentoBiPool, pool.exchangeId, request.tokenIn.address, request.tokenOut.address, request.amountIn],
        })) as bigint
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
          meta: { exchangeId: pool.exchangeId },
        }
      } catch {
        return null
      }
    },
  }
}

export function createMentoV3Adapter(client: ChainClient, gasUnits: bigint): VenueAdapter {
  const id: VenueId = 'mento-v3'
  return {
    id,
    chainId: 42220,
    supports(tokenIn: Token, tokenOut: Token) {
      return MENTO.has(tokenIn.symbol) && MENTO.has(tokenOut.symbol)
    },
    async quote(request: QuoteRequest): Promise<VenueQuote | null> {
      if (request.chainId !== 42220 || request.amountIn <= 0n) return null
      try {
        const amounts = (await client.readContract({
          address: CONTRACTS.mentoRouter,
          abi: routerAbi,
          functionName: 'getAmountsOut',
          args: [request.amountIn, [{ from: request.tokenIn.address, to: request.tokenOut.address, factory: zeroAddress }]],
        })) as readonly bigint[]
        const amountOut = amounts[amounts.length - 1] ?? 0n
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
          meta: { factory: 'default' },
        }
      } catch {
        return null
      }
    },
  }
}

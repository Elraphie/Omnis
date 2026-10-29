import type { ChainClient } from '../chain/client.js'
import type { AppConfig } from '../config/load.js'
import { venuesForPair, type Token, type VenueId } from '../config/tokens.js'
import { fixtureAdapters } from './fixture.js'
import { createMentoBrokerAdapter, createMentoV3Adapter } from './mento.js'
import { createTextileAdapter } from './textile.js'
import type { VenueAdapter } from './types.js'
import { createUniswapAdapter } from './uniswap.js'

export function createLiveAdapters(client: ChainClient, cfg: AppConfig): VenueAdapter[] {
  return [
    createUniswapAdapter(client, cfg.gasUnits['uniswap-v3']),
    createTextileAdapter(cfg.textileApi, cfg.gasUnits['textile-rfq'], cfg.quoteTimeoutMs),
    createMentoBrokerAdapter(client, cfg.gasUnits['mento-broker']),
    createMentoV3Adapter(client, cfg.gasUnits['mento-v3']),
  ]
}

export function adaptersFor(all: VenueAdapter[], tokenIn: Token, tokenOut: Token): VenueAdapter[] {
  const allowed = new Set<VenueId>(venuesForPair(
    tokenIn.symbol === 'USDT' ? tokenOut.symbol : tokenIn.symbol,
    tokenIn.symbol === 'USDT' ? 'USDT' : tokenOut.symbol === 'USDT' ? 'USDT' : tokenOut.symbol,
  ))
  return all.filter((adapter) => allowed.has(adapter.id) && adapter.supports(tokenIn, tokenOut))
}

export function fallbackAdapters(): VenueAdapter[] {
  return fixtureAdapters('profitable')
}

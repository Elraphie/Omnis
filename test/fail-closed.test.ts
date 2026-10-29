import { describe, expect, it } from 'vitest'
import type { ChainClient } from '../src/chain/client.js'
import { readOnlySigner } from '../src/chain/signer.js'
import { loadConfig } from '../src/config/load.js'
import { token } from '../src/config/tokens.js'
import { buildSteps } from '../src/convert/service.js'
import { createConvertApi, runDeskCycle } from '../src/runtime.js'
import { Store } from '../src/store/db.js'
import { fixtureAdapters } from '../src/venues/fixture.js'

/** An RPC that is down: every read fails, so no venue can quote. */
const deadRpc: ChainClient = {
  readContract: async () => { throw new Error('rpc down') },
  simulateContract: async () => { throw new Error('rpc down') },
  call: async () => { throw new Error('rpc down') },
  getGasPrice: async () => { throw new Error('rpc down') },
  waitForTransactionReceipt: async () => { throw new Error('rpc down') },
}

// Textile is pointed at a closed local port so the test never leaves the machine.
const offline = { TEXTILE_API: 'http://127.0.0.1:9', QUOTE_TIMEOUT_MS: '2000', SIZE_LADDER: '1', MIN_TRADE_USD: '10' }

describe('desk fallback', () => {
  it('falls back to the labeled fixture book only in dry-run', async () => {
    const store = new Store(':memory:')
    const report = await runDeskCycle({ cfg: loadConfig({ ...offline, MODE: 'dry-run' }).cfg, store, client: deadRpc, signer: readOnlySigner() })
    expect(report.quoteSource).toBe('fixture')
    store.close()
  })

  it('holds on an empty book in paper mode instead of booking fixture P&L', async () => {
    const store = new Store(':memory:')
    const report = await runDeskCycle({ cfg: loadConfig({ ...offline, MODE: 'paper' }).cfg, store, client: deadRpc, signer: readOnlySigner() })
    expect(report.quoteSource).toBe('live')
    expect(report.quoteCount).toBe(0)
    expect(report.decision.action).toBe('hold')
    expect(report.trade).toBeNull()
    expect(store.counts().trades).toBe(0)
    expect(store.realized()).toBe(0n)
    store.close()
  })
})

describe('convert fails closed', () => {
  it('returns no route, not fixture prices, when live venues are down', async () => {
    const api = createConvertApi({ cfg: loadConfig({ ...offline, QUOTE_SOURCE: 'auto' }).cfg, client: deadRpc })
    const quote = await api.quote('USDT', 'wBRL', '100')
    expect(quote.quoteSource).toBe('live')
    expect(quote.best).toBeNull()
    expect(quote.routes).toEqual([])
    await expect(api.build({ from: 'USDT', to: 'wBRL', amount: '100', wallet: `0x${'22'.repeat(20)}` })).rejects.toThrow(/no route/)
  })

  it('labels fixture quotes and refuses to build them', async () => {
    const api = createConvertApi({ cfg: loadConfig({ QUOTE_SOURCE: 'fixture' }).cfg, client: null })
    const quote = await api.quote('USDT', 'wBRL', '100')
    expect(quote.quoteSource).toBe('fixture')
    expect(quote.best).not.toBeNull()
    await expect(api.build({ from: 'USDT', to: 'wBRL', amount: '100', wallet: `0x${'22'.repeat(20)}` })).rejects.toThrow(/live quotes/)
  })

  it('will not turn a fixture quote into calldata even if one reaches the builder', async () => {
    const [venue] = fixtureAdapters('profitable')
    const fixture = await venue!.quote({ chainId: 42220, tokenIn: token('USDT'), tokenOut: token('wBRL'), amountIn: 100_000_000n })
    expect(fixture).not.toBeNull()
    expect(() => buildSteps({
      from: token('USDT'),
      to: token('wBRL'),
      wallet: `0x${'22'.repeat(20)}`,
      fee: 0n,
      swapAmount: 100_000_000n,
      treasury: null,
      allowance: 0n,
      quote: { ...fixture!, meta: { ...fixture!.meta, feeTier: 500 } },
      slippageBps: 50n,
      suffix: null,
    })).toThrow(/fixture/)
  })
})

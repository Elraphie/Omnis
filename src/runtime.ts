import { randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ChainClient } from './chain/client.js'
import { erc20Abi } from 'viem'
import type { AppConfig, Secrets } from './config/load.js'
import { CONTRACTS, token } from './config/tokens.js'
import {
  assembleQuote,
  buildSteps,
  parseConvertAmount,
  requireWallet,
  stepsForWallet,
  suffixFor,
  type ConvertBuild,
  type ConvertQuote,
} from './convert/service.js'
import { runCycle, type CycleDeps, type CycleReport } from './execution/engine.js'
import { executeLive } from './execution/live.js'
import { shadowArb, shadowBudget, type ShadowResult } from './execution/shadow.js'
import type { ArbOpportunity } from './strategies/arbitrage.js'
import { createReferenceFeed, type ReferenceFeed } from './reference/fx.js'
import type { TradingSigner } from './chain/signer.js'
import type { Store } from './store/db.js'
import { fallbackAdapters, createLiveAdapters } from './venues/registry.js'
import { parseTextileFirm } from './venues/textile.js'
import type { VenueAdapter, VenueQuote } from './venues/types.js'
import { withTimeout } from './util.js'
import { adaptersFor } from './venues/registry.js'

async function gasPrice(client: ChainClient | null, fallback: bigint): Promise<bigint> {
  if (!client) return fallback
  try {
    return await withTimeout(client.getGasPrice(), 4_000, 'gas price')
  } catch {
    return fallback
  }
}

/** Shadow execution bound to one cycle's live adapters and gas price. Null when its hourly budget is spent. */
export type ShadowRunner = (opp: ArbOpportunity, ctx: { adapters: VenueAdapter[]; gasPriceWei: bigint }) => Promise<ShadowResult | null>

/** Null unless SHADOW=1. With SHADOW_TAKER_KEY the Textile leg is a firm quote; without it, a fresh preview. */
export function shadowRunnerFor(cfg: AppConfig, secrets: Secrets): ShadowRunner | null {
  if (!cfg.shadow || cfg.mode === 'live') return null
  const taker = secrets.shadowTakerKey ? privateKeyToAccount(secrets.shadowTakerKey) : null
  const allow = shadowBudget(cfg.shadowMaxPerHour)
  return async (opp, ctx) => {
    if (!allow()) return null
    return shadowArb(opp, {
      adapters: ctx.adapters,
      slippageBps: cfg.slippageBps,
      gasPriceWei: ctx.gasPriceWei,
      celoUsdMicros: cfg.celoUsdMicros,
      timeoutMs: cfg.quoteTimeoutMs,
      textileApi: cfg.textileApi,
      takerSigner: taker,
      randomNonce: () => `0x${randomBytes(32).toString('hex')}`,
    }, (venue) => cfg.gasUnits[venue])
  }
}

export async function runDeskCycle(args: {
  cfg: AppConfig
  store: Store
  client: ChainClient | null
  signer: TradingSigner
  now?: Date
  reference?: ReferenceFeed | null
  shadow?: ShadowRunner | null
}): Promise<CycleReport> {
  const gas = await gasPrice(args.client, args.cfg.gasPriceWeiFallback)
  const base: Omit<CycleDeps, 'adapters' | 'quoteSource'> = {
    cfg: args.cfg,
    store: args.store,
    gasPriceWei: gas,
    celoUsdMicros: args.cfg.celoUsdMicros,
    now: args.now,
    reference: args.reference ? await args.reference.get() : null,
    broadcaster: async (opp) => {
      await executeLive({
        mode: args.cfg.mode,
        confirmLive: args.cfg.confirmLive,
        manualKill: args.cfg.killSwitch || args.store.manualKill(),
        signer: args.signer,
        venues: [opp.buyVenue, opp.sellVenue],
        calls: [],
      })
    },
  }
  if (args.cfg.quoteSource === 'fixture' || !args.client) {
    return runCycle({ ...base, adapters: fallbackAdapters(), quoteSource: 'fixture' })
  }
  const adapters = createLiveAdapters(args.client, args.cfg)
  const shadow = args.shadow
  const live = await runCycle({
    ...base,
    adapters,
    quoteSource: 'live',
    shadow: shadow ? (opp) => shadow(opp, { adapters, gasPriceWei: gas }) : undefined,
  })
  // The fixture fallback is a demo aid. In paper or live mode it would book or chase made-up prices,
  // so those modes hold on an empty book instead.
  if (args.cfg.quoteSource === 'auto' && live.quoteCount === 0 && args.cfg.mode === 'dry-run') {
    return runCycle({ ...base, adapters: fallbackAdapters(), quoteSource: 'fixture' })
  }
  return live
}

/** Null when FX_REFERENCE_URL is empty. Refresh failures are logged through `onError` and never stop a scan. */
export function referenceFeedFor(cfg: AppConfig, onError?: (message: string) => void): ReferenceFeed | null {
  if (!cfg.fxReferenceUrl) return null
  return createReferenceFeed({ url: cfg.fxReferenceUrl, ttlMs: cfg.fxReferenceTtlSec * 1000, timeoutMs: cfg.quoteTimeoutMs, onError })
}

async function quotesFor(
  adapters: VenueAdapter[],
  fromSymbol: string,
  toSymbol: string,
  amount: bigint,
  timeoutMs: number,
): Promise<VenueQuote[]> {
  const from = token(fromSymbol)
  const to = token(toSymbol)
  const selected = adaptersFor(adapters, from, to)
  const results = await Promise.all(selected.map(async (adapter) => {
    try {
      return await withTimeout(adapter.quote({ chainId: 42220, tokenIn: from, tokenOut: to, amountIn: amount }), timeoutMs, adapter.id)
    } catch {
      return null
    }
  }))
  return results.filter((quote): quote is VenueQuote => quote !== null)
}

export function createConvertApi(args: { cfg: AppConfig; client: ChainClient | null }) {
  // Convert never falls back from live to fixture prices. With no live route it says so.
  const quoteSource: ConvertQuote['quoteSource'] = (args.cfg.quoteSource === 'fixture' || !args.client) ? 'fixture' : 'live'
  const adapters = (): VenueAdapter[] => (quoteSource === 'fixture' || !args.client)
    ? fallbackAdapters()
    : createLiveAdapters(args.client, args.cfg)

  async function priced(from: string, to: string, amount: string): Promise<{ quote: ConvertQuote; quotes: VenueQuote[]; fee: bigint; swapAmount: bigint }> {
    const parsed = parseConvertAmount(from, amount, args.cfg.maxConvertUsdMicros)
    const other = token(to)
    if (parsed.token.symbol === other.symbol) throw new Error('from and to must differ')
    const { fee, swapAmount } = args.cfg.convertFeeBps > 0n
      ? (await import('./pricing/math.js')).splitInputFee(parsed.amount, args.cfg.convertFeeBps)
      : { fee: 0n, swapAmount: parsed.amount }
    const quotes = await quotesFor(adapters(), parsed.token.symbol, other.symbol, swapAmount, args.cfg.quoteTimeoutMs)
    return {
      fee,
      swapAmount,
      quotes,
      quote: assembleQuote({
        from: parsed.token,
        to: other,
        amountIn: parsed.amount,
        feeBps: args.cfg.convertFeeBps,
        treasury: args.cfg.treasury,
        quotes,
        slippageBps: args.cfg.convertSlippageBps,
        quoteSource,
      }),
    }
  }

  return {
    async quote(from: string, to: string, amount: string): Promise<ConvertQuote> {
      return (await priced(from, to, amount)).quote
    },
    async build(body: unknown): Promise<ConvertBuild> {
      const input = body as { from?: string; to?: string; amount?: string; wallet?: string; venue?: string }
      if (!input.from || !input.to || !input.amount) throw new Error('from, to, and amount are required')
      const wallet = requireWallet(input.wallet)
      if (quoteSource !== 'live') throw new Error('build needs live quotes. Fixture prices are for demos and are never signed.')
      const pricedQuote = await priced(input.from, input.to, input.amount)
      const chosen = input.venue
        ? pricedQuote.quotes.find((quote) => quote.venue === input.venue)
        : pricedQuote.quotes.find((quote) => quote.venue === pricedQuote.quote.best?.venue)
      if (!chosen) throw new Error('no route for that pair and size')
      if (!args.client) throw new Error('build needs a chain reader for allowance and balance checks')
      const balance = await args.client.readContract({
        address: chosen.tokenIn.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet],
      }) as bigint
      const parsed = parseConvertAmount(input.from, input.amount, args.cfg.maxConvertUsdMicros)
      if (balance < parsed.amount) throw new Error(`insufficient ${chosen.tokenIn.symbol}`)
      const spender = (await import('./execution/build.js')).spenderFor(chosen.venue)
      const allowance = await args.client.readContract({
        address: chosen.tokenIn.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [wallet, spender],
      }) as bigint
      let textile: { to: Address; data: Hex; buyAmount: bigint } | undefined
      if (chosen.venue === 'textile-rfq') {
        const response = await fetch(`${args.cfg.textileApi.replace(/\/$/, '')}/v2/rfq/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'omnis/2.0' },
          body: JSON.stringify({
            chainId: 42220,
            sellToken: chosen.tokenIn.address,
            buyToken: chosen.tokenOut.address,
            sellAmount: pricedQuote.swapAmount.toString(),
            taker: wallet,
          }),
          signal: AbortSignal.timeout(args.cfg.quoteTimeoutMs),
        })
        const payload = await response.json() as { error?: { message?: string; details?: { reason?: string } } }
        if (response.status === 401 && String(payload.error?.details?.reason ?? '').includes('proof_of_control')) {
          throw new Error('Textile asked the taker wallet to sign a proof of control. Send that signature as a follow-up; Omnis will not sign for a user.')
        }
        if (!response.ok) throw new Error(payload.error?.message ?? `Textile HTTP ${response.status}`)
        const firm = parseTextileFirm(payload, CONTRACTS.textileReactor)
        textile = { to: firm.to, data: firm.data, buyAmount: firm.buyAmount }
      }
      const calls = buildSteps({
        from: chosen.tokenIn,
        to: chosen.tokenOut,
        wallet,
        fee: pricedQuote.fee,
        swapAmount: pricedQuote.swapAmount,
        treasury: args.cfg.treasury,
        allowance,
        quote: chosen,
        slippageBps: args.cfg.convertSlippageBps,
        suffix: suffixFor(args.cfg),
        textile,
      })
      return { ...pricedQuote.quote, wallet, steps: stepsForWallet(calls) }
    },
  }
}

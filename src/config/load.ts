import { createHash, timingSafeEqual } from 'node:crypto'
import { isAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'
import { VENUE_IDS, type VenueId } from './tokens.js'
import { usdToMicros } from '../pricing/math.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
const TAG = /^[a-z0-9_]{1,32}$/
const API_KEY = /^[A-Za-z0-9_-]{12,128}$/

const envSchema = z.object({
  MODE: z.enum(['dry-run', 'paper', 'live']).default('dry-run'),
  CONFIRM_LIVE: z.string().optional(),
  CELO_RPC: z.string().url().default('https://forno.celo.org'),
  PORT: z.coerce.number().int().positive().max(65535).default(43123),
  DATA_DIR: z.string().min(1).default('./data'),
  MIN_EDGE_USD: z.coerce.number().nonnegative().default(0.05),
  MIN_EDGE_BPS: z.coerce.number().nonnegative().max(10_000).default(3),
  MAX_TRADE_USD: z.coerce.number().positive().default(100),
  MIN_TRADE_USD: z.coerce.number().positive().default(2),
  INTERVAL_SEC: z.coerce.number().positive().default(60),
  SIZE_LADDER: z.string().default('1,0.5,0.25'),
  MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(25),
  MAX_INVENTORY_USD: z.coerce.number().positive().default(500),
  KILL_SWITCH: z.enum(['0', '1']).default('0'),
  SLIPPAGE_BPS: z.coerce.number().int().min(0).max(500).default(30),
  ADVERSE_BPS: z.coerce.number().int().min(0).max(200).default(2),
  CONVERT_FEE_BPS: z.coerce.number().int().min(0).max(100).default(0),
  CONVERT_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(500).default(50),
  MAX_CONVERT_USD: z.coerce.number().positive().default(500),
  TREASURY_ADDRESS: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  API_KEYS: z.string().default(''),
  ADMIN_KEYS: z.string().default(''),
  PUBLIC_STATUS: z.enum(['0', '1']).default('0'),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().max(10_000).default(60),
  PAPER_USDT: z.coerce.number().positive().default(1000),
  QUOTE_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(8000),
  QUOTE_SOURCE: z.enum(['auto', 'live', 'fixture']).default('auto'),
  INCLUDE_EXTENDED: z.enum(['0', '1']).default('0'),
  CELO_USD: z.coerce.number().positive().default(0.3),
  GAS_PRICE_WEI_FALLBACK: z.string().default('5000000000'),
  ATTRIBUTION_TAG: z.string().default(''),
  SIGNER_KIND: z.enum(['auto', 'local', 'readonly', 'kms']).default('auto'),
  AGENT_PRIVATE_KEY: z.string().optional(),
  TEXTILE_API: z.string().url().default('https://api.textilecredit.com'),
  MM_SPREAD_BPS: z.coerce.number().int().min(1).max(500).default(10),
  MM_SKEW_FACTOR_BPS: z.coerce.number().int().min(0).max(10_000).default(5000),
  MM_MAX_SKEW_BPS: z.coerce.number().int().min(0).max(500).default(40),
  REBALANCE_THRESHOLD_BPS: z.coerce.number().int().min(0).max(10_000).default(500),
  REBALANCE_MAX_COST_BPS: z.coerce.number().int().min(0).max(500).default(15),
  TARGET_USDT_BPS: z.coerce.number().int().min(0).max(10_000).default(10_000),
  GAS_UNITS_UNISWAP: z.coerce.number().int().positive().default(180_000),
  GAS_UNITS_TEXTILE: z.coerce.number().int().positive().default(280_000),
  GAS_UNITS_MENTO: z.coerce.number().int().positive().default(220_000),
  GAS_UNITS_MENTO_V3: z.coerce.number().int().positive().default(220_000),
  STARTUP_DELAY_SEC: z.coerce.number().nonnegative().default(0),
})

export interface ApiKeyRecord {
  id: string
  hash: Buffer
}

export interface AppConfig {
  mode: 'dry-run' | 'paper' | 'live'
  confirmLive?: string
  chainId: 42220
  rpcUrl: string
  port: number
  dataDir: string
  minEdgeUsdMicros: bigint
  minEdgeBps: bigint
  maxTradeUsdMicros: bigint
  minTradeUsdMicros: bigint
  intervalSec: number
  ladderBps: number[]
  maxDailyLossUsdMicros: bigint
  maxInventoryUsdMicros: bigint
  killSwitch: boolean
  slippageBps: bigint
  adverseBps: bigint
  convertFeeBps: bigint
  convertSlippageBps: bigint
  maxConvertUsdMicros: bigint
  treasury: Address | null
  corsOrigins: string[]
  apiKeys: ApiKeyRecord[]
  /** Operator keys for /admin and the desk's status, P&L, and metrics. Never shared with Convert customers. */
  adminKeys: ApiKeyRecord[]
  /** Local development only: serve status, trades, P&L, and metrics without a key. */
  publicStatus: boolean
  rateLimitPerMin: number
  paperUsdtMicros: bigint
  quoteTimeoutMs: number
  quoteSource: 'auto' | 'live' | 'fixture'
  includeExtended: boolean
  celoUsdMicros: bigint
  gasPriceWeiFallback: bigint
  attributionTag: string
  signerKind: 'local' | 'readonly' | 'kms'
  textileApi: string
  mmSpreadBps: bigint
  mmSkewFactorBps: bigint
  mmMaxSkewBps: bigint
  rebalanceThresholdBps: bigint
  rebalanceMaxCostBps: bigint
  targetUsdtBps: bigint
  gasUnits: Record<VenueId, bigint>
  startupDelaySec: number
}

export interface Secrets {
  agentPrivateKey?: Hex
}

export interface LoadedConfig {
  cfg: AppConfig
  secrets: Secrets
  privateKeyPresent: boolean
}

function blankEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}

export function hashApiKey(raw: string): ApiKeyRecord {
  const hash = createHash('sha256').update(raw).digest()
  return { id: hash.subarray(0, 6).toString('hex'), hash }
}

export function authenticateApiKey(header: string | undefined, keys: ApiKeyRecord[]): { ok: true; keyId: string } | { ok: false } {
  if (!header || keys.length === 0) return { ok: false }
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim()
  if (!raw) return { ok: false }
  const hash = createHash('sha256').update(raw).digest()
  for (const key of keys) {
    if (key.hash.length === hash.length && timingSafeEqual(key.hash, hash)) return { ok: true, keyId: key.id }
  }
  return { ok: false }
}

function parseLadder(raw: string): number[] {
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('SIZE_LADDER must list at least one fraction')
  const ladder: number[] = []
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`SIZE_LADDER entry ${part} must be a fraction in (0, 1]`)
    }
    ladder.push(Math.round(value * 10_000))
  }
  return ladder
}

function parseOrigins(raw: string): string[] {
  if (!raw.trim()) return []
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean)
}

function parseKeys(raw: string, name: string): ApiKeyRecord[] {
  if (!raw.trim()) return []
  return raw.split(',').map((key) => key.trim()).filter(Boolean).map((key) => {
    if (!API_KEY.test(key)) throw new Error(`${name} entries must be 12-128 chars of letters, numbers, _ or -`)
    return hashApiKey(key)
  })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const parsed = envSchema.safeParse(blankEnv(env))
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`).join('; ')
    throw new Error(`Invalid configuration: ${detail}`)
  }
  const raw = parsed.data
  const treasuryRaw = raw.TREASURY_ADDRESS?.trim() || ''
  if (raw.CONVERT_FEE_BPS > 0) {
    if (!treasuryRaw || !isAddress(treasuryRaw) || !ADDRESS.test(treasuryRaw)) {
      throw new Error('TREASURY_ADDRESS must be a valid address when CONVERT_FEE_BPS > 0')
    }
    if (/^0x0{40}$/i.test(treasuryRaw)) throw new Error('TREASURY_ADDRESS cannot be the zero address')
  } else if (treasuryRaw && !isAddress(treasuryRaw)) {
    throw new Error('TREASURY_ADDRESS is not a valid address')
  }
  const corsOrigins = parseOrigins(raw.CORS_ORIGINS)
  if (corsOrigins.some((origin) => origin === '*' || origin.includes('*'))) {
    throw new Error('CORS_ORIGINS cannot contain a wildcard')
  }
  if (raw.ATTRIBUTION_TAG && !TAG.test(raw.ATTRIBUTION_TAG)) {
    throw new Error('ATTRIBUTION_TAG must match /^[a-z0-9_]{1,32}$/')
  }
  let gasPriceWeiFallback: bigint
  try {
    gasPriceWeiFallback = BigInt(raw.GAS_PRICE_WEI_FALLBACK)
  } catch {
    throw new Error('GAS_PRICE_WEI_FALLBACK must be an integer wei value')
  }
  if (gasPriceWeiFallback < 0n) throw new Error('GAS_PRICE_WEI_FALLBACK must be non-negative')
  const ladderBps = parseLadder(raw.SIZE_LADDER)
  const apiKeys = parseKeys(raw.API_KEYS, 'API_KEYS')
  const adminKeys = parseKeys(raw.ADMIN_KEYS, 'ADMIN_KEYS')
  if (adminKeys.some((admin) => apiKeys.some((key) => key.hash.equals(admin.hash)))) {
    throw new Error('ADMIN_KEYS cannot reuse a key from API_KEYS. A Convert customer must not reach the kill switch.')
  }
  const privateKey = raw.AGENT_PRIVATE_KEY?.trim()
  if (privateKey && !PRIVATE_KEY.test(privateKey)) throw new Error('AGENT_PRIVATE_KEY must be a 32-byte hex key')

  let signerKind: AppConfig['signerKind']
  if (raw.SIGNER_KIND === 'kms') signerKind = 'kms'
  else if (raw.SIGNER_KIND === 'local') signerKind = 'local'
  else if (raw.SIGNER_KIND === 'readonly') signerKind = 'readonly'
  else signerKind = raw.MODE === 'live' ? 'local' : 'readonly'

  if (signerKind === 'kms' && privateKey) {
    throw new Error('Refusing AGENT_PRIVATE_KEY when SIGNER_KIND=kms. Use a KMS adapter instead of a hot key.')
  }
  if (raw.MODE === 'live') {
    if (raw.CONFIRM_LIVE !== 'I_UNDERSTAND') {
      throw new Error('MODE=live requires CONFIRM_LIVE=I_UNDERSTAND')
    }
    if (signerKind === 'readonly') throw new Error('MODE=live cannot use a read-only signer')
    if (signerKind === 'local' && !privateKey) throw new Error('MODE=live with SIGNER_KIND=local requires AGENT_PRIVATE_KEY')
  }
  if (signerKind === 'local' && raw.MODE !== 'live') {
    signerKind = 'readonly'
  }
  if (raw.MIN_TRADE_USD > raw.MAX_TRADE_USD) throw new Error('MIN_TRADE_USD cannot exceed MAX_TRADE_USD')

  const gasUnits = {
    'uniswap-v3': BigInt(raw.GAS_UNITS_UNISWAP),
    'textile-rfq': BigInt(raw.GAS_UNITS_TEXTILE),
    'mento-broker': BigInt(raw.GAS_UNITS_MENTO),
    'mento-v3': BigInt(raw.GAS_UNITS_MENTO_V3),
  } satisfies Record<VenueId, bigint>
  for (const id of VENUE_IDS) {
    if (gasUnits[id] <= 0n) throw new Error(`gas units for ${id} must be positive`)
  }

  const cfg: AppConfig = {
    mode: raw.MODE,
    confirmLive: raw.CONFIRM_LIVE,
    chainId: 42220,
    rpcUrl: raw.CELO_RPC,
    port: raw.PORT,
    dataDir: raw.DATA_DIR,
    minEdgeUsdMicros: usdToMicros(raw.MIN_EDGE_USD),
    minEdgeBps: BigInt(Math.round(raw.MIN_EDGE_BPS)),
    maxTradeUsdMicros: usdToMicros(raw.MAX_TRADE_USD),
    minTradeUsdMicros: usdToMicros(raw.MIN_TRADE_USD),
    intervalSec: raw.INTERVAL_SEC,
    ladderBps,
    maxDailyLossUsdMicros: usdToMicros(raw.MAX_DAILY_LOSS_USD),
    maxInventoryUsdMicros: usdToMicros(raw.MAX_INVENTORY_USD),
    killSwitch: raw.KILL_SWITCH === '1',
    slippageBps: BigInt(raw.SLIPPAGE_BPS),
    adverseBps: BigInt(raw.ADVERSE_BPS),
    convertFeeBps: BigInt(raw.CONVERT_FEE_BPS),
    convertSlippageBps: BigInt(raw.CONVERT_SLIPPAGE_BPS),
    maxConvertUsdMicros: usdToMicros(raw.MAX_CONVERT_USD),
    treasury: treasuryRaw ? (treasuryRaw as Address) : null,
    corsOrigins,
    apiKeys,
    adminKeys,
    publicStatus: raw.PUBLIC_STATUS === '1',
    rateLimitPerMin: raw.RATE_LIMIT_PER_MIN,
    paperUsdtMicros: usdToMicros(raw.PAPER_USDT),
    quoteTimeoutMs: raw.QUOTE_TIMEOUT_MS,
    quoteSource: raw.QUOTE_SOURCE,
    includeExtended: raw.INCLUDE_EXTENDED === '1',
    celoUsdMicros: usdToMicros(raw.CELO_USD),
    gasPriceWeiFallback,
    attributionTag: raw.ATTRIBUTION_TAG,
    signerKind,
    textileApi: raw.TEXTILE_API,
    mmSpreadBps: BigInt(raw.MM_SPREAD_BPS),
    mmSkewFactorBps: BigInt(raw.MM_SKEW_FACTOR_BPS),
    mmMaxSkewBps: BigInt(raw.MM_MAX_SKEW_BPS),
    rebalanceThresholdBps: BigInt(raw.REBALANCE_THRESHOLD_BPS),
    rebalanceMaxCostBps: BigInt(raw.REBALANCE_MAX_COST_BPS),
    targetUsdtBps: BigInt(raw.TARGET_USDT_BPS),
    gasUnits,
    startupDelaySec: raw.STARTUP_DELAY_SEC,
  }
  return {
    cfg,
    secrets: cfg.mode === 'live' && privateKey ? { agentPrivateKey: privateKey as Hex } : {},
    privateKeyPresent: Boolean(privateKey),
  }
}

export function publicConfig(cfg: AppConfig) {
  return {
    mode: cfg.mode,
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl,
    minEdgeUsd: Number(cfg.minEdgeUsdMicros) / 1e6,
    minEdgeBps: Number(cfg.minEdgeBps),
    maxTradeUsd: Number(cfg.maxTradeUsdMicros) / 1e6,
    intervalSec: cfg.intervalSec,
    maxDailyLossUsd: Number(cfg.maxDailyLossUsdMicros) / 1e6,
    maxInventoryUsd: Number(cfg.maxInventoryUsdMicros) / 1e6,
    slippageBps: Number(cfg.slippageBps),
    adverseBps: Number(cfg.adverseBps),
    convertFeeBps: Number(cfg.convertFeeBps),
    treasury: cfg.treasury,
    quoteSource: cfg.quoteSource,
    signer: cfg.signerKind,
    attributionTag: cfg.attributionTag || null,
    includeExtended: cfg.includeExtended,
    corsOrigins: cfg.corsOrigins,
    apiKeyCount: cfg.apiKeys.length,
    adminKeyCount: cfg.adminKeys.length,
    publicStatus: cfg.publicStatus,
    rateLimitPerMin: cfg.rateLimitPerMin,
  }
}

import { getAddress, type Address } from 'viem'

const addr = (value: string): Address => getAddress(value)

export const CELO_CHAIN_ID = 42220

export const CONTRACTS = {
  textileReactor: addr('0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3'),
  uniFactory: addr('0xAfE208a311B21f13EF87E33A90049fC17A7acDEc'),
  uniQuoter: addr('0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'),
  uniRouter: addr('0x5615CDAb10dc425a742d643d949a7F474C01abc4'),
  mentoBroker: addr('0x777A8255cA72412f0d706dc03C9D1987306B4CaD'),
  mentoBiPool: addr('0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901'),
  mentoRouter: addr('0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6'),
} as const

export interface Token {
  symbol: string
  address: Address
  decimals: number
  /** USDT is the numeraire. Everything else is marked from quotes. */
  kind: 'cash' | 'asset' | 'gas'
}

export const TOKENS = {
  USDT: { symbol: 'USDT', address: addr('0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'), decimals: 6, kind: 'cash' },
  USDC: { symbol: 'USDC', address: addr('0xcebA9300f2b948710d2653dD7B07f33A8B32118C'), decimals: 6, kind: 'asset' },
  cUSD: { symbol: 'cUSD', address: addr('0x765DE816845861e75A25fCA122bb6898B8B1282a'), decimals: 18, kind: 'asset' },
  cEUR: { symbol: 'cEUR', address: addr('0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73'), decimals: 18, kind: 'asset' },
  cREAL: { symbol: 'cREAL', address: addr('0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787'), decimals: 18, kind: 'asset' },
  wBRL: { symbol: 'wBRL', address: addr('0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0'), decimals: 18, kind: 'asset' },
  wARS: { symbol: 'wARS', address: addr('0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D'), decimals: 18, kind: 'asset' },
  wCOP: { symbol: 'wCOP', address: addr('0x8a1D45e102e886510e891d2Ec656a708991e2D76'), decimals: 18, kind: 'asset' },
  wMXN: { symbol: 'wMXN', address: addr('0x337E7456B420bD3481e7FA61fA9850343d610d34'), decimals: 18, kind: 'asset' },
  cNGN: { symbol: 'cNGN', address: addr('0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f'), decimals: 6, kind: 'asset' },
  /** Mento naira. A different asset from cNGN; never crossed with it. */
  NGNm: { symbol: 'NGNm', address: addr('0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71'), decimals: 18, kind: 'asset' },
  IDRX: { symbol: 'IDRX', address: addr('0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22'), decimals: 2, kind: 'asset' },
  CELO: { symbol: 'CELO', address: addr('0x471EcE3750Da237f93B8E339c536989b8978a438'), decimals: 18, kind: 'gas' },
} as const satisfies Record<string, Token>

export type TokenSymbol = keyof typeof TOKENS

export function token(symbol: string): Token {
  const found = (Object.values(TOKENS) as Token[]).find((item) => item.symbol.toLowerCase() === symbol.toLowerCase())
  if (!found) throw new Error(`Unknown token ${symbol}`)
  return found
}

export function tokenByAddress(address: Address): Token | undefined {
  const needle = address.toLowerCase()
  return (Object.values(TOKENS) as Token[]).find((item) => item.address.toLowerCase() === needle)
}

export interface Corridor {
  id: string
  base: TokenSymbol
  quote: 'USDT'
  extended: boolean
}

/** Same-asset corridors versus USDT. cNGN and NGNm stay separate. */
export const CORRIDORS: Corridor[] = [
  { id: 'wBRL', base: 'wBRL', quote: 'USDT', extended: false },
  { id: 'wARS', base: 'wARS', quote: 'USDT', extended: false },
  { id: 'cNGN', base: 'cNGN', quote: 'USDT', extended: false },
  { id: 'NGNm', base: 'NGNm', quote: 'USDT', extended: false },
  { id: 'USDC', base: 'USDC', quote: 'USDT', extended: false },
  { id: 'cUSD', base: 'cUSD', quote: 'USDT', extended: false },
  { id: 'cEUR', base: 'cEUR', quote: 'USDT', extended: false },
  { id: 'cREAL', base: 'cREAL', quote: 'USDT', extended: false },
  { id: 'wCOP', base: 'wCOP', quote: 'USDT', extended: true },
  { id: 'wMXN', base: 'wMXN', quote: 'USDT', extended: true },
  { id: 'IDRX', base: 'IDRX', quote: 'USDT', extended: true },
]

export const VENUE_IDS = ['uniswap-v3', 'textile-rfq', 'mento-broker', 'mento-v3'] as const
export type VenueId = (typeof VENUE_IDS)[number]

const TEXTILE = new Set(['wBRL', 'wARS', 'wCOP', 'wMXN', 'cNGN', 'IDRX', 'USDC', 'USDT'])
const MENTO = new Set(['cUSD', 'cEUR', 'cREAL', 'NGNm', 'USDT', 'USDC', 'CELO'])

export function venuesForPair(base: string, quote: string): VenueId[] {
  const venues: VenueId[] = ['uniswap-v3']
  if (TEXTILE.has(base) && (quote === 'USDT' || quote === 'USDC')) venues.push('textile-rfq')
  if (MENTO.has(base) && MENTO.has(quote)) venues.push('mento-broker', 'mento-v3')
  return venues
}

export function activeCorridors(includeExtended: boolean): Corridor[] {
  return CORRIDORS.filter((corridor) => includeExtended || !corridor.extended)
}

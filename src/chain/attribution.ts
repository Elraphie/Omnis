import { concat, type Hex } from 'viem'
import { toDataSuffix } from '@celo/attribution-tags'

export function attributionSuffix(tag: string): Hex | null {
  if (!tag) return null
  return toDataSuffix(tag) as Hex
}

/** Append an ERC-8021 suffix once. Already-tagged calldata is left alone. */
export function tagCalldata(data: Hex, suffix: Hex | null): Hex {
  if (!suffix || suffix === '0x') return data
  const body = data.toLowerCase()
  const extra = suffix.toLowerCase().slice(2)
  if (extra.length > 0 && body.endsWith(extra)) return data
  return concat([data === '0x' ? '0x' : data, suffix])
}

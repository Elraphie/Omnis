import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'

export const MAX_UINT256 = (1n << 256n) - 1n

export interface UnsignedCall {
  to: Address
  data: Hex
  value: 0n
  description: string
}

/**
 * Exact-amount approvals. USDT-style tokens revert on a non-zero to non-zero
 * change, so a stale allowance is reset to zero first. Unlimited approvals
 * are refused.
 */
export function buildExactApprovals(args: {
  token: Address
  spender: Address
  ownerAllowance: bigint
  required: bigint
  symbol: string
}): UnsignedCall[] {
  if (args.required < 0n) throw new Error('approval amount must be non-negative')
  if (args.required === MAX_UINT256) throw new Error('refusing unlimited approval')
  if (args.ownerAllowance >= args.required) return []
  const approve = (amount: bigint): UnsignedCall => ({
    to: args.token,
    value: 0n,
    description: amount === 0n ? `Reset ${args.symbol} allowance` : `Approve exactly ${amount.toString()} ${args.symbol} base units`,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [args.spender, amount] }),
  })
  const steps: UnsignedCall[] = []
  if (args.ownerAllowance > 0n) steps.push(approve(0n))
  if (args.required > 0n) steps.push(approve(args.required))
  return steps
}

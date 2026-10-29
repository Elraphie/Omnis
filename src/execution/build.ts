import { encodeFunctionData, erc20Abi, parseAbi, zeroAddress, type Address } from 'viem'
import { CONTRACTS, type Token } from '../config/tokens.js'
import { type UnsignedCall } from '../chain/approvals.js'
import { tagCalldata } from '../chain/attribution.js'
import type { Hex } from 'viem'

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
])
const brokerAbi = parseAbi([
  'function swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)',
])
const mentoRouterAbi = parseAbi([
  'struct Route { address from; address to; address factory; }',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
])

function tagged(call: UnsignedCall, suffix: Hex | null): UnsignedCall {
  return { ...call, data: tagCalldata(call.data, suffix) }
}

export function buildTransfer(token: Token, to: Address, amount: bigint, suffix: Hex | null): UnsignedCall {
  if (amount <= 0n) throw new Error('transfer amount must be positive')
  return tagged({
    to: token.address,
    value: 0n,
    description: `Transfer ${amount.toString()} ${token.symbol} base units to treasury`,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  }, suffix)
}

export function buildUniswapSwap(args: {
  tokenIn: Token
  tokenOut: Token
  feeTier: number
  recipient: Address
  amountIn: bigint
  minAmountOut: bigint
  suffix: Hex | null
}): UnsignedCall {
  return tagged({
    to: CONTRACTS.uniRouter,
    value: 0n,
    description: `Swap ${args.tokenIn.symbol} for ${args.tokenOut.symbol} on Uniswap v3 (${args.feeTier})`,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: args.tokenIn.address,
        tokenOut: args.tokenOut.address,
        fee: args.feeTier,
        recipient: args.recipient,
        amountIn: args.amountIn,
        amountOutMinimum: args.minAmountOut,
        sqrtPriceLimitX96: 0n,
      }],
    }),
  }, args.suffix)
}

export function buildMentoBrokerSwap(args: {
  tokenIn: Token
  tokenOut: Token
  exchangeId: Hex
  amountIn: bigint
  minAmountOut: bigint
  suffix: Hex | null
}): UnsignedCall {
  return tagged({
    to: CONTRACTS.mentoBroker,
    value: 0n,
    description: `Swap ${args.tokenIn.symbol} for ${args.tokenOut.symbol} on Mento Broker`,
    data: encodeFunctionData({
      abi: brokerAbi,
      functionName: 'swapIn',
      args: [CONTRACTS.mentoBiPool, args.exchangeId, args.tokenIn.address, args.tokenOut.address, args.amountIn, args.minAmountOut],
    }),
  }, args.suffix)
}

export function buildMentoV3Swap(args: {
  tokenIn: Token
  tokenOut: Token
  amountIn: bigint
  minAmountOut: bigint
  recipient: Address
  deadline: bigint
  suffix: Hex | null
}): UnsignedCall {
  return tagged({
    to: CONTRACTS.mentoRouter,
    value: 0n,
    description: `Swap ${args.tokenIn.symbol} for ${args.tokenOut.symbol} on Mento v3`,
    data: encodeFunctionData({
      abi: mentoRouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [
        args.amountIn,
        args.minAmountOut,
        [{ from: args.tokenIn.address, to: args.tokenOut.address, factory: zeroAddress }],
        args.recipient,
        args.deadline,
      ],
    }),
  }, args.suffix)
}

export function spenderFor(venue: string): Address {
  if (venue === 'uniswap-v3') return CONTRACTS.uniRouter
  if (venue === 'textile-rfq') return CONTRACTS.textileReactor
  if (venue === 'mento-broker') return CONTRACTS.mentoBroker
  if (venue === 'mento-v3') return CONTRACTS.mentoRouter
  throw new Error(`no spender for venue ${venue}`)
}

import { createPublicClient, http, type Hex } from 'viem'
import { celo } from 'viem/chains'
import type { AppConfig } from '../config/load.js'
import type { Secrets } from '../config/load.js'
import { attributionSuffix } from './attribution.js'
import { kmsSigner, localSigner, readOnlySigner, type KmsAdapter, type TradingSigner } from './signer.js'

/** Structural client so venue adapters do not depend on viem's full generic client. */
export interface ChainClient {
  readContract(args: Record<string, unknown>): Promise<unknown>
  simulateContract(args: Record<string, unknown>): Promise<{ result: unknown }>
  call(args: { to: `0x${string}`; data?: Hex }): Promise<{ data?: Hex }>
  getGasPrice(): Promise<bigint>
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }>
}

export function createReader(rpcUrl: string): ChainClient {
  const client = createPublicClient({
    chain: celo,
    transport: http(rpcUrl, { timeout: 8_000, retryCount: 1, retryDelay: 250 }),
  })
  return {
    readContract: (args) => client.readContract(args as never),
    simulateContract: async (args) => {
      const simulated = await client.simulateContract(args as never)
      return { result: simulated.result }
    },
    call: (args) => client.call(args),
    getGasPrice: () => client.getGasPrice(),
    waitForTransactionReceipt: async (args) => {
      const receipt = await client.waitForTransactionReceipt(args)
      return { status: receipt.status }
    },
  }
}

export function createSigner(cfg: AppConfig, secrets: Secrets, client: ChainClient, kms: KmsAdapter | null = null): TradingSigner {
  const suffix = attributionSuffix(cfg.attributionTag)
  if (cfg.mode !== 'live') return readOnlySigner()
  if (cfg.signerKind === 'kms') return kmsSigner(kms, suffix)
  if (cfg.signerKind === 'local' && secrets.agentPrivateKey) {
    return localSigner({ privateKey: secrets.agentPrivateKey, rpcUrl: cfg.rpcUrl, suffix, publicClient: client })
  }
  return readOnlySigner()
}

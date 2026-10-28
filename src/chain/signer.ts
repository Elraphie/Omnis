import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { tagCalldata } from './attribution.js'

export interface UnsignedTx {
  to: Address
  data: Hex
  value?: bigint
}

export interface TradingSigner {
  readonly kind: 'local' | 'readonly' | 'kms'
  readonly address: Address | null
  readonly canSign: boolean
  signAndSend(tx: UnsignedTx): Promise<Hex>
}

/** Plug in AWS KMS, GCP KMS, Turnkey, or another remote signer. No raw key lives here. */
export interface KmsAdapter {
  address: Address
  signAndSend(tx: UnsignedTx): Promise<Hex>
}

export function readOnlySigner(address: Address | null = null): TradingSigner {
  return {
    kind: 'readonly',
    address,
    canSign: false,
    async signAndSend() {
      throw new Error('read-only signer cannot send transactions')
    },
  }
}

export function localSigner(opts: {
  privateKey: Hex
  rpcUrl: string
  suffix: Hex | null
  publicClient: { waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }> }
}): TradingSigner {
  const account = privateKeyToAccount(opts.privateKey)
  const wallet = createWalletClient({ account, chain: celo, transport: http(opts.rpcUrl) })
  return {
    kind: 'local',
    address: account.address,
    canSign: true,
    async signAndSend(tx) {
      const hash = await wallet.sendTransaction({
        account,
        chain: celo,
        to: tx.to,
        data: tagCalldata(tx.data, opts.suffix),
        value: tx.value ?? 0n,
      })
      const receipt = await opts.publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`)
      return hash
    },
  }
}

export function kmsSigner(adapter: KmsAdapter | null, suffix: Hex | null): TradingSigner {
  if (!adapter) {
    return {
      kind: 'kms',
      address: null,
      canSign: false,
      async signAndSend() {
        throw new Error(
          'KMS adapter is not attached. Inject a KmsAdapter (AWS KMS, GCP KMS, Turnkey). This path does not accept a raw private key.',
        )
      },
    }
  }
  return {
    kind: 'kms',
    address: adapter.address,
    canSign: true,
    signAndSend(tx) {
      return adapter.signAndSend({ ...tx, data: tagCalldata(tx.data, suffix) })
    },
  }
}

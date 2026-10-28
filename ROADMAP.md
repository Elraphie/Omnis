# Roadmap

Omnis v2 is a dry-run desk and a non-custodial Convert API. The pure arbitrage that Kiyoshi harvested in late October 2026 has compressed: about $228 of profit on roughly $63k of volume from 25–28 October, with the margin down around 2 bps and later scans negative after costs. The items below are how the desk gets broader than that one gap. None of them are implemented as live money movement in this repository.

## Licensed naira on- and off-ramp

cNGN on Celo and a naira bank account are not the same rail. Busha and Yellow Card already move naira for retail and businesses, but a non-institutional wallet cannot treat their settlement as an on-chain leg. The useful integration is a licensed partner flow: quote cNGN or USDT on Celo, hand the user to the partner for the fiat leg, and reconcile the two with a reference the partner returns. Omnis should not custody the naira and should not pretend an API key is a license.

## The cNGN gap

On 25 October 2026 three naira prices sat on Celo at once: Mento NGNm near 1,335 NGN per USD with the oracle offline, cNGN on Uniswap v3 near 1,368, and Textile's cNGN bid near 1,382 with an empty offer. That is a few percent, and it is not an arbitrage. NGNm (`0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71`) and cNGN (`0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`) are different tokens. There is no NGNm/cNGN pool an ordinary wallet can use, and the issuer bridge wants a registered business. The desk reports the basis and refuses to cross the assets. The route opens only if a pool, a working Mento median, or a licensed bridge appears. Wire that as another `VenueAdapter`, not as a special case in the arbitrage math.

## Remittance corridors

USDT against wBRL, wARS, wCOP, wMXN, and IDRX is the same shape as the Celo book, on Textile's other chains (Base, Ethereum, BSC, Polygon) and on the local stable that actually settles there. A corridor is a pair of adapters plus a shared numeraire. Inventory has to live on each chain, and a rebalance across chains is a bridge with its own failure mode, not a second swap. Price the bridge as a cost the way gas is priced today, and keep the daily loss stop global.

## SME treasury

A small importer does not want a round trip. They want a limit: sell wBRL when the rate beats their invoice, or roll USDT into cUSD and cEUR inside inventory bands. That is the market-making and rebalance layer pointed at a stated target instead of a flat USDT book, with a human approval on anything larger than the band. Convert is the API for that approval. The desk should quote; the company's wallet should sign.

## MiniPay

MiniPay users often have no CELO for gas. Celo fee-currency lets a swap pay gas in USDT or cUSD, which is what Kiyoshi Convert called out and what this build does not yet set on the unsigned transaction. The Convert response should grow a `feeCurrency` field and a gas estimate denominated in that token, and the status page should be usable at phone width (it already reflows; the wallet handoff does not exist yet). Still non-custodial: Omnis returns the transaction, MiniPay signs it.

## Other chains and venues

The adapter interface is `supports` plus `quote`, returning null when there is no market. Textile's address book already lists reactors on BSC, Base, Ethereum, and Polygon. Mento v3's router is deployed beyond Celo. Adding a chain means a client, a token list, and a numeraire, not a new strategy. Do not arb two tokens that merely share a currency name.

## Before any live capital

- Bind a firm Textile RFQ in the same cycle as the hedge, or do not send the first leg. The live path refuses a Textile preview for this reason.
- Replace the placeholder treasury. The Convert fee is a transfer the user signs; it is not atomic, and a discarded transfer step means the swap still works and the fee is unpaid. A small router contract can pull the fee and the swap together later.
- External review. This code has tests for the math and the guards. It has not been audited.
- Keep `CONFIRM_LIVE=I_UNDERSTAND` and a KMS signer. A hot key in the environment is the failure mode v2 was built to avoid.

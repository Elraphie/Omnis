# Omnis

Omnis is a Celo FX desk. It quotes the same currency on Uniswap v3, Textile FX, and Mento, decides whether the gap still pays after gas and a cushion for quotes that are not firm, and can hand a user an unsigned conversion at the best route it found. It does not hold user funds. It boots in **dry-run** and will not sign anything unless you deliberately turn live mode on.

See [NOTICE.md](NOTICE.md) for the attribution and the license gap upstream.

## What it does

Three strategies share one quote book:

1. **Cross-venue arbitrage.** Buy on one venue, sell on another, same token. Pool fees and the Textile fee are already inside the quoted output. Omnis then subtracts gas (priced in CELO) and `ADVERSE_BPS` per leg that is not a firm quote. The slippage cap is a limit on the transaction, not a second subtraction from the expected edge. The clip with the most dollars wins, which is not always the largest size.
2. **Market making.** A mid from the best bid and offer, a configured spread, and an inventory skew. Long inventory moves both the bid and the ask down. In paper mode, if a venue would lift that offer, the fill is simulated.
3. **Rebalance.** FX inventory above the target (a flat USDT book, unless you change it) is sold when the spread is cheaper than `REBALANCE_MAX_COST_BPS`. A manual kill switch blocks this. The daily loss stop does not, because flattening reduces risk.

A risk manager sits in front of all three: per-asset inventory headroom (a failed second leg can leave you holding the local currency), a daily loss stop, and a kill switch. cNGN and Mento NGNm are quoted for a basis line and are never crossed. They are different tokens.

## Architecture

```mermaid
flowchart LR
  subgraph venues [Venue adapters]
    Uni[Uniswap v3]
    Tex[Textile RFQ]
    Broker[Mento Broker]
    V3[Mento v3 router]
  end
  Scan[Quote loop] --> venues
  venues --> Book[Same-asset quote book]
  Book --> Arb[Arbitrage]
  Book --> MM[Market making]
  Book --> Reb[Rebalance]
  Arb --> Risk[Risk manager]
  MM --> Risk
  Reb --> Risk
  Risk --> Dry[Dry-run log]
  Risk --> Paper[Paper fills and P and L]
  Risk --> Live[Live gate]
  Convert[Convert API] --> Book
  Convert --> Treasury[Fee transfer to treasury]
  Paper --> DB[(SQLite)]
  Dry --> DB
  Convert --> DB
  HTTP[/health /status /metrics] --> DB
```

| Path | Role |
|---|---|
| `src/venues` | Uniswap v3, Textile preview, Mento Broker, Mento v3. `supports` + `quote`. Null means no market. |
| `src/pricing` | Fees, gas, edge, skew, route choice. Integer micro-USD. |
| `src/strategies` | Arbitrage pairing, market-make quotes, rebalance. |
| `src/risk` | Inventory, daily loss, kill switch, live gate. |
| `src/execution` | Paper fills, exact-amount call builders, the live broadcast gate. |
| `src/convert` | Best-route quote and unsigned bundle. |
| `src/api` | HTTP, API keys, rate limit, CORS. |
| `src/store` | SQLite via `node:sqlite`. |
| `src/chain` | Read-only client, exact approvals, signer interface. |

Adding a chain or a venue is a new adapter and a token entry. Strategies should not grow a special case for it.

## Run

Node 22.13 or newer.

```bash
npm install
npm test
npm run once          # one cycle. Live quotes if the RPC answers, otherwise a labeled fixture book.
npm run dev           # desk plus HTTP on port 43123
npm run build && npm start
```

`npm run once` and `npm run dev` default to dry-run. Set `MODE=paper` to simulate fills and write P&L. In dry-run, if `QUOTE_SOURCE=auto` and every venue fails, the cycle falls back to a fixture book and says so. Paper and live never fall back: they hold on an empty book, so paper P&L is only ever booked from live quotes (or from `QUOTE_SOURCE=fixture`, which you chose on purpose). Fixture numbers are not live prices. To see the desk page locally, set `PUBLIC_STATUS=1` or enter a key from `ADMIN_KEYS`.

Copy `.env.example` to `.env` when you want a fee, an API key, or a different RPC. A private key is not required. If one is present and the mode is not live, it is ignored and a warning is logged.

### HTTP

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | no | Desk page |
| GET | `/health` | no | Liveness |
| GET | `/status` | admin key | Last scan, decision, config, recent paper trades |
| GET | `/trades` | admin key | Recent fills |
| GET | `/pnl` | admin key | Realized P&L and balances |
| GET | `/metrics` | admin key | Prometheus text |
| GET | `/convert/quote?from=USDT&to=wBRL&amount=100` | API key | Best route after the fee |
| POST | `/convert/build` | API key | Unsigned steps for `wallet` |
| POST | `/admin/kill` | admin key | `{ "enabled": true }` manual kill switch |

Send the key as `Authorization: Bearer <key>` or `x-api-key`. Keys are stored only as SHA-256; logs keep a short id. Empty `API_KEYS` disables Convert. Admin keys (`ADMIN_KEYS`) are separate from Convert keys, cannot reuse one, and are not rate limited, so a Convert customer can never reach the kill switch or the desk's P&L. `PUBLIC_STATUS=1` opens the status endpoints without a key for local development; do not set it in production.

Every Convert response carries `quoteSource`. Convert never falls back from live prices to the fixture book: with no live route, `best` is null. `/convert/build` refuses fixture prices outright. CORS echoes an allowed origin and never `*`. Requests with no `Origin` (server-side calls) are accepted. Same-host browser calls are accepted. Anything else needs `CORS_ORIGINS`. The default limit is 60 Convert or admin requests per key per minute.

The fee is `CONVERT_FEE_BPS` of the input, sent to `TREASURY_ADDRESS` as an ERC-20 transfer the user signs, then an exact approval and the swap for the remainder. It is not atomic: a wallet can drop the transfer and still swap. Say so to users. Set the fee to 0 until the treasury address is yours. The dead address in a demo config burns fees.

Approvals are the exact swap amount. A non-zero USDT allowance is reset to zero first. `maxUint256` is refused.

### Measuring the edge

Every scan stores each round trip it priced (table `opportunities`) and, when `FX_REFERENCE_URL` is set, each venue's price against a fiat reference at the smallest clip (table `reference_gaps`). Let the desk run on live quotes, then summarise:

```bash
npm run report
npm run report -- --hours 24 --top 20
npm run report -- --json
```

The report shows venue health, how often any round trip clears gas and the cushion, an upper bound on what one fill per scan would have made, per-route frequency and size of edges with how long they stayed open, and the on-chain premium or discount against the reference per corridor, venue, and side. Fixture scans are excluded unless you pass `--include-fixture`. The default reference is a once-a-day rate, so it measures lasting premiums, not intraday lag.

### Shadow execution

`SHADOW=1` (dry-run or paper only, live quotes only) takes each scan's best round trip that clears `SHADOW_MIN_NET_BPS` and walks it the way live mode would, at most `SHADOW_MAX_PER_HOUR` times an hour. It re-prices leg one, sizes leg two from leg one's guaranteed minimum, re-prices leg two, builds each on-chain leg's calldata, and records the outcome (`would_fill`, `edge_gone`, `leg_failed`), the re-priced net, each leg's drift from the scan, and timing in `shadow_trades`. It never signs or sends a transaction. `npm run report` summarises it.

The Textile leg is a fresh preview unless `SHADOW_TAKER_KEY` is set. With it, Omnis signs Textile's proof-of-control message (an off-chain text that, in Textile's words, does not approve any transfer, trade or allowance), requests a firm quote, records it, and releases it straight away with `/cancel`. Textile only firm-quotes a taker that holds the sell amount, so that wallet needs a small balance of what it sells. Shadow mode never moves those funds, but the key is a hot key: use a dedicated wallet holding only what the measurement needs, never the trading key (startup refuses that), and keep the key in `.env`, never in the repository.

`npm run measure` runs the desk for measurement and restarts it if it stops: paper mode, live quotes, shadow on, sizes up to $1,000, the desk page on 127.0.0.1, data and `desk.log` in `./data-measure`. Values in your environment or `.env` override those defaults. On Windows PowerShell, use `npm.cmd` if script execution is disabled.

### Paper and dry-run

Dry-run records the decision and does not move a balance. Paper starts from `PAPER_USDT` (default 1000), applies a round trip at the quoted output minus gas, and stores equity in SQLite under `DATA_DIR`. Both modes use read-only RPC calls. Tests use an in-memory database and a fixture book, so `npm test` does not need a network or a key.

### Live mode

Live mode requires all of:

- `MODE=live`
- `CONFIRM_LIVE=I_UNDERSTAND`
- a signer that can sign: `AGENT_PRIVATE_KEY` with `SIGNER_KIND=local`, or `SIGNER_KIND=kms`

`SIGNER_KIND=kms` rejects a private key in the environment. The KMS path is an interface (`KmsAdapter`: an address and `signAndSend`). Wire AWS KMS, GCP KMS, Turnkey, or similar in `createSigner`. There is no cloud signer in this repo.

Even then, the desk will not broadcast a Textile preview. A preview is not a fill, and sending the other leg alone warehouses currency risk. `executeLive` is the only broadcast function, and it returns before any signature if the mode, the confirmation, the signer, the kill switch, or the bundle is wrong. Treat live mode as unfinished for real capital until a firm Textile quote is bound in the same cycle as the hedge and someone has reviewed the call builders.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `dry-run` | `dry-run`, `paper`, or `live` |
| `CELO_RPC` | `https://forno.celo.org` | Celo RPC |
| `PORT` | `43123` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address. `127.0.0.1` for a local-only desk |
| `FX_REFERENCE_URL` | `https://open.er-api.com/v6/latest/USD` | Fiat reference for measurement. `off` disables |
| `FX_REFERENCE_TTL_SEC` | `3600` | How long reference rates are cached |
| `SHADOW` | `0` | `1` walks the best route each scan as live mode would, without signing. Dry-run and paper only |
| `SHADOW_MIN_NET_BPS` | `0` | Only shadow a route whose scanned net (after the cushion) is at least this |
| `SHADOW_MAX_PER_HOUR` | `20` | Cap on shadow runs in any rolling hour |
| `SHADOW_TAKER_KEY` | | Optional dedicated wallet that signs Textile proof-of-control for firm quotes. Never the trading key |
| `DATA_DIR` | `./data` | SQLite directory |
| `MIN_EDGE_USD` | `0.05` | Minimum net dollars |
| `MIN_EDGE_BPS` | `3` | Minimum net basis points |
| `ADVERSE_BPS` | `2` | Cushion per non-firm leg |
| `SLIPPAGE_BPS` | `30` | On-chain minimum-out for the desk |
| `MAX_TRADE_USD` | `100` | Clip size |
| `SIZE_LADDER` | `1,0.5,0.25` | Fractions of the clip |
| `MAX_DAILY_LOSS_USD` | `25` | Stop opening risk for the UTC day |
| `MAX_INVENTORY_USD` | `500` | Cap on local-currency inventory, including a failed leg |
| `KILL_SWITCH` | `0` | `1` blocks new risk and flattens |
| `PAPER_USDT` | `1000` | Paper starting balance |
| `QUOTE_SOURCE` | `auto` | `auto`, `live`, or `fixture` |
| `CONVERT_FEE_BPS` | `0` | Input fee, max 100 |
| `TREASURY_ADDRESS` | | Required when the fee is non-zero |
| `API_KEYS` | | Comma-separated Convert keys |
| `ADMIN_KEYS` | | Comma-separated operator keys for `/admin` and status endpoints |
| `PUBLIC_STATUS` | `0` | `1` serves status, trades, P&L, and metrics without a key (local only) |
| `CORS_ORIGINS` | | Comma-separated origins, no wildcards |
| `RATE_LIMIT_PER_MIN` | `60` | Per API key |
| `ATTRIBUTION_TAG` | | Optional ERC-8021 code, `[a-z0-9_]{1,32}` |
| `INCLUDE_EXTENDED` | `0` | Also quote wCOP, wMXN, IDRX |
| `CELO_USD` | `0.3` | Fallback CELO price for gas |
| `TEXTILE_API` | `https://api.textilecredit.com` | Textile v2 |

The full list with gas units and skew knobs is in `.env.example`. Invalid combinations fail at startup. That includes a wildcard CORS origin, a fee without a treasury, live mode without the confirmation phrase, and a hot key combined with `SIGNER_KIND=kms`.

## Contracts

Celo mainnet (chain 42220). These match Textile's published address book and the Mento deployment docs.

| Contract | Address |
|---|---|
| Textile LimitOrderReactor | `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3` |
| Uniswap v3 SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` |
| Uniswap v3 QuoterV2 | `0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8` |
| Uniswap v3 factory | `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc` |
| Mento Broker | `0x777A8255cA72412f0d706dc03C9D1987306B4CaD` |
| Mento BiPoolManager | `0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901` |
| Mento v3 Router | `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6` |
| USDT | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` |
| USDC | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` |
| wBRL | `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` |
| wARS | `0x0DC4F92879B7670e5f4e4E6e3c801D229129D90D` |
| cNGN | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` |
| NGNm (Mento) | `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71` |

Uniswap quotes are checked against the router factory before use. Textile firm quotes are checked against the reactor above. Anything else is dropped.

## Docker

```bash
docker build -t omnis .
docker run --rm -p 43123:43123 -e MODE=dry-run -v omnis-data:/data omnis
```

The image stays in dry-run. Mount `/data` if you want the SQLite file to outlive the container.

## Tests

`npm test` covers pricing (fee split, gas, the 2 bp case, skew), route choice (dollars over bps, firm quotes over indicative), exact approvals, the cross-asset guard, the kill switch, inventory and daily loss, paper fills, dry-run immutability, API keys, rate limiting, and CORS. No test sends a transaction.

## Further work

[ROADMAP.md](ROADMAP.md) covers a licensed naira ramp (Busha, Yellow Card), the cNGN/NGNm gap, remittance corridors, SME treasury, MiniPay fee currency, and other chains.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Kiyoshi is copyright Mel Okoye.

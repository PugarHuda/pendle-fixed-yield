# Pendle Fixed Yield: PayBox plugin

Lets a PayBox-connected agent lock in a **fixed rate** on idle stablecoins, ETH, BTC, HYPE or tokenized assets by
buying [Pendle](https://pendle.finance) Principal Tokens. It then handles the rest of the lifecycle: due diligence,
quoting, depositing, tracking the positions, exiting them, and rolling them into the next maturity when they expire.
The plugin never signs anything. Each wallet action is an unsigned proposal that PayBox simulates and the user approves.

- **Live page:** https://pendle-fixed-yield.vercel.app shows current fixed rates, a live maturity ladder and a
  calculator. Its source is in `site/`.
- **Repository:** https://github.com/PugarHuda/pendle-fixed-yield
- **PayBox:** https://paybox.sh (docs: https://docs.paybox.sh, developer portal: https://developer.paybox.sh)
- Built for the MoonPay PayBox Hackathon (Chapter 1).

> "Put 25 USDC somewhere it earns a fixed rate until February."
>
> The agent finds the best Pendle market, explains its risks, and quotes the fixed rate
> (for example 8.7% fixed, so $25 becomes about $25.8). It then proposes an exact-amount approval,
> then the deposit, and the PT lands in the wallet. At maturity it rolls the PT into the next maturity
> in one transaction.
>
> "Spread 10,000 USDC so some of it comes back every month."
>
> The agent builds a 4-rung ladder from November to February at a blended fixed APY of about 13%.

**Why a PT is a fixed rate.** A Principal Token trades at a discount and redeems for one unit of its accounting
asset at maturity. Buying it today locks the discount as a fixed APY, provided the PT is held to maturity. Selling
early happens at the market price.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `find_fixed_yields` | read | Every active Pendle market on 8 PayBox chains in one call. Shows fixed vs variable APY, premium, liquidity, TVL, protocol, `value_of_1000_at_maturity` and risk flags. Filters: `chain`, `asset` (usd/eth/btc/hype), `min_liquidity_usd`, `min_days`/`max_days`, `exclude_flagged`. Sorts by `fixed_apy`, `fixed_premium` or `liquidity`. |
| `explain_fixed_yield_market` | read | Due diligence for one market: Pendle's own asset description, risk notes and quirks, the 30-day fixed and variable APY trend, the live PT price in its underlying, order-book depth (how much PT can be bought, from limit orders plus AMM, before the fixed rate falls to each 0.1% level), points programs, risk flags, and the accepted and redeem tokens with their symbols. Works for matured markets too. |
| `quote_fixed_yield` | read | PT received, effective fixed APY, USD value now and at maturity, projected gain, price impact, fee, whether the aggregator is used, and approval and balance checks for the wallet. |
| `plan_fixed_yield_ladder` | read | Splits one amount evenly across 2â€“4 markets in different maturity months on one chain, like a bond ladder, so the money comes back in stages. Takes the best fixed rate in each upcoming month (skipping markets flagged low liquidity, new or volatile) and quotes every rung through the verified router route. Reports PT out, APY, maturity value and price impact per rung, plus the blended APY. If the chain can't ladder, it names chains that can. |
| `propose_fixed_yield_deposit` | proposal | If the router needs an approval, returns an exact-amount approval (step 1 of 2). Otherwise returns the verified Pendle router deposit. Checks the balance first and refuses trades whose price impact is too high. |
| `get_fixed_yield_positions` | read | PT holdings across all chains, valued in USD. Balances are read on-chain, and older or matured markets are found through Pendle's position index. Suggests a roll-over target. Chains whose RPC fails are listed in `chains_unavailable`, not silently skipped. |
| `propose_fixed_yield_exit` | proposal | Redeems after maturity (`redeemPyToToken`) or sells early at the market price (`swapExactPtForToken`) into a token of the user's choice. Requests a PT approval first if needed. |
| `propose_fixed_yield_rollover` | proposal | One transaction from an old PT into a later PT of the same asset, using Pendle Router `callAndReflect` through Pendle's Reflector. Works for matured PTs (redeemed) and active ones (sold at market). If no target is given, it picks the highest fixed rate on the same SY that matures at least 14 days out and has at least $50k of liquidity. |

Each tool has a strict input and output schema and MCP annotations (`readOnlyHint` and the others). Amounts are
decimal strings converted to atomic units without floating point, and `"max"` means the full PT balance.

### Risk flags

| Flag | Meaning |
|---|---|
| `low_liquidity` | Pool liquidity under $250k, so exits may move the price |
| `short_maturity` | Under 14 days left |
| `new_market` | Pendle marks the market as new |
| `volatile_underlying` | The underlying is not a stable asset (for example a tokenized stock or ETH) |
| `fixed_far_above_variable` | The fixed rate is more than 5 points above, and more than twice, the variable rate. The cause is often an incentive or a risk premium, so check it |
| `points_go_to_yt_not_pt` | The market has a points program, which accrues to YT holders, not PT |

## Safety

- **Never signs.** It returns `io.paybox/transactionProposal` EVM calls, and PayBox simulates them, asks the user, and signs.
- **Pendle's hosted API is treated as untrusted.** The plugin decodes the calldata itself and proposes a route only
  if it targets the official Pendle Router V4 (`0x888888888889758F76e7103c6CbF23ABbF58F946`) and matches the plan exactly:
  - deposit: `swapExactTokenForPt(receiver = user, market = requested)`
  - exit: `swapExactPtForToken` or `redeemPyToToken`, with the user as receiver and the exact PT amount
  - roll-over: `callAndReflect`, whose reflector is Pendle's deployed Reflector for that chain (taken from
    `pendle-core-v2-public/deployments`). Its first self-call must consume exactly the user's old PT
    (`redeemPyToSy` or `swapExactPtForSy`), its second must be empty, and the reflected call must be
    `swapExactSyForPt` buying the requested new PT for the user.
  - the native value must equal the deposit amount (or be 0)
- **Approvals are for the exact amount, never unlimited.** Mainnet USDT is reset to 0 first.
- **Risky trades are refused.** A trade is refused when its price impact exceeds `max_price_impact_bps` (default 1%),
  or when Pendle reports no impact at all. Balances are checked before anything is proposed.
- **No API keys, secrets or state between calls.**

`scripts/check-routes.ts` proves that six honest routes pass (buy, native buy, sell, redeem, matured roll-over,
active roll-over) and that six tampered or mismatched routes are refused.

## How it runs inside PayBox

- **One sandbox per call, 10-second budget.** All upstream calls share one 9-second budget (`timeLeft()` in
  `src/pendle.ts`) instead of fixed per-request timeouts. The hosted sandbox is about 2â€“3Ã— slower than local, so this
  keeps slow chains working.
- **Pendle compute units.** Pendle limits each IP to 200 CU per minute, and every PayBox user shares the sandbox's
  egress. The plugin uses the market list (`/v2/markets/all`, 2 CU, all chains in one request) and the v3 convert API.
  It turns on Pendle's aggregator only when the market cannot take the input token, or return the output token,
  natively (about 5 CU instead of 7). A 429 response returns a clear "try again in N s" message.
- **Pendle endpoints used:**
  - `/v2/markets/all`
  - `/v3/sdk/{chainId}/convert`
  - `/v1/dashboard/positions/database/{user}`
  - `/v1/prices/assets`
  - `/v3/{chainId}/markets/{market}/historical-data`
  - `/v1/sdk/{chainId}/markets/{market}/swapping-prices`
  - `/v2/limit-orders/book/{chainId}` (consolidated limit-order and AMM depth)
- **On-chain reads.** Balances, allowances, decimals and symbols are read in one Multicall3 request per chain (viem).

## Chains

Each chain was verified with a "Validate transaction" simulation in the PayBox developer portal. X Layer (196) is
not included because PayBox rejects proposals on it.

| Chain | ID | RPC host | Pendle Reflector |
|---|---|---|---|
| Ethereum | 1 | `ethereum-rpc.publicnode.com` | `0x30544e00â€¦55DD` |
| Base | 8453 | `base-rpc.publicnode.com` | `0x30544e00â€¦55DD` |
| Arbitrum | 42161 | `arbitrum-one-rpc.publicnode.com` | `0x30544e00â€¦55DD` |
| HyperEVM | 999 | `rpc.hyperliquid.xyz` | `0x30544e00â€¦55DD` |
| Robinhood Chain | 4663 | `robinhood-rpc.publicnode.com` | `0x73d5DBF8â€¦4fA8` |
| BNB Chain | 56 | `bsc-rpc.publicnode.com` | `0x30544e00â€¦55DD` |
| Monad | 143 | `rpc.monad.xyz` | `0x73d5DBF8â€¦4fA8` |
| Plasma | 9745 | `rpc.plasma.to` | `0x30544e00â€¦55DD` |

## Portal configuration

**Network hosts** (Test & configure â†’ Network access):

```
api-v2.pendle.finance
ethereum-rpc.publicnode.com
base-rpc.publicnode.com
arbitrum-one-rpc.publicnode.com
rpc.hyperliquid.xyz
robinhood-rpc.publicnode.com
bsc-rpc.publicnode.com
rpc.monad.xyz
rpc.plasma.to
```

**Variables & Secrets:** none. Upload `dist/plugin.mjs` only.

## Build and test

Use Node.js 24.21.0 and pnpm 11.11.0 on Linux or macOS (WSL2 on Windows).

```bash
pnpm install --frozen-lockfile
pnpm test                                    # typecheck, deterministic build x2, MCP conformance
node scripts/qa.mjs [filter]                 # 48 live cases: happy paths, invalid input, error paths
pnpm exec tsx scripts/check-routes.ts        # 12 live router-verification checks incl. tamper refusal
pnpm exec tsx scripts/chain-probes.ts        # one approval probe per chain, for portal "Validate transaction"
pnpm exec tsx scripts/find-sim-wallets.ts base [token]   # real wallets with router allowances, for smoke tests
node scripts/smoke.mjs <tool> '<json>'       # call any tool once
```

The portal's "Validate transaction" always simulates from your own PayBox wallet. A deposit's second step, an exit
or a roll-over therefore validates there only once that wallet actually holds the allowance or the PT.

**Latest results:**
- `pnpm test` passes: 8 tools and a deterministic bundle.
- QA passes 48/48 and route checks pass 12/12.
- A real deposit from the developer's PayBox wallet (0.002 native ETH into PT-sUSDai on Arbitrum, no approval needed)
  passes the portal's "Validate transaction" simulation, as does an exact-amount USDC approval on Base.
- Hosted runs in the PayBox sandbox succeed:

  | Tool | Hosted time |
  |---|---|
  | find | 3.7 s |
  | explain | 4.3 s |
  | quote | 5.3 s |
  | ladder (4 rungs) | 5.9 s |
  | positions | 7.1 s |
  | exit | 6.1 s |

## Layout

```
src/plugin.ts     MCP server and the eight tools
src/pendle.ts     Pendle API client, markets, prices, on-chain reads, route decoding and verification
src/paybox.ts     PayBox proposal helpers from the starter kit (unchanged)
scripts/          conformance (starter), QA, route checks, chain probes, smoke tools
site/             the static landing page deployed to Vercel (Three.js hero, live Pendle data)
```

## Limitations

- Limit orders are not supported, because they need typed-data signatures and PayBox proposals are EVM, Solana or x402
  transactions only. PT looping is not supported, because it is leveraged and outside a fixed-yield product.
- Hosted latency is 6â€“8 s for the heaviest calls (cross-chain positions, slow chains), against a 10 s limit. When
  Pendle or an RPC is slow, the call returns a clear error rather than a partial proposal.
- The fixed rate is fixed only if the PT is held to maturity. This is not financial advice.

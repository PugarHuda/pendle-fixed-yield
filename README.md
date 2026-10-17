# Pendle Fixed Yield — PayBox plugin

Lets a PayBox-connected agent lock in a **fixed rate** on idle stablecoins, ETH, BTC, HYPE or tokenized
assets by buying [Pendle](https://pendle.finance) Principal Tokens — then do the due diligence, track the
positions, exit them, and roll them into the next maturity when they expire. Everything is signed only
after the user's PayBox approval.

Live page with current Pendle fixed rates: https://pendle-fixed-yield.vercel.app (source in `site/`).

> "Put 25 USDC somewhere it earns a fixed rate until February."
> → finds the best Pendle market → explains its risks → quotes 8.7% fixed (≈ $25 → $25.8) →
> exact-amount approval → deposit → PT in the wallet → at maturity, one-transaction roll-over.

A PT bought today redeems for one unit of its accounting asset at maturity, so the APY is fixed if held to maturity.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `find_fixed_yields` | read | Every active Pendle market on 8 PayBox chains in one call: fixed vs variable APY, premium, liquidity, TVL, protocol, risk flags; sort by rate, premium or liquidity |
| `explain_fixed_yield_market` | read | Due diligence: Pendle's own asset description, risk notes and quirks, 30-day fixed/variable APY trend, live PT discount, points programs, accepted and redeem tokens with symbols |
| `quote_fixed_yield` | read | PT received, effective fixed APY, USD value now and at maturity, projected gain, price impact, fee, approval and balance check |
| `propose_fixed_yield_deposit` | proposal | Exact-amount approval (step 1/2) or the verified Pendle router deposit |
| `get_fixed_yield_positions` | read | PT holdings across all chains with USD value; balances read on-chain, older markets discovered via Pendle's index; suggests a roll-over target |
| `propose_fixed_yield_exit` | proposal | Redeem after maturity, or sell early at market price |
| `propose_fixed_yield_rollover` | proposal | One transaction from an old PT into a later PT of the same asset (Pendle `callAndReflect`), auto-picking the best target |

Chains: Ethereum, Base, Arbitrum, HyperEVM, Robinhood Chain, BNB Chain, Monad, Plasma (each verified with a PayBox portal simulation; X Layer is rejected by PayBox).

## Safety

- Never signs; returns `io.paybox/transactionProposal` EVM calls. PayBox simulates, asks for approval, signs.
- Pendle's hosted API is treated as untrusted. The plugin decodes the calldata itself and only proposes
  a route that targets the official Pendle Router V4 (`0x8888…F946`) and matches the plan exactly:
  - deposit: `swapExactTokenForPt(receiver = user, market = requested)`
  - exit: `swapExactPtForToken` / `redeemPyToToken` with the user as receiver and the exact PT amount
  - roll-over: `callAndReflect` whose reflector is Pendle's deployed Reflector for that chain (from
    `pendle-core-v2-public/deployments`), whose first call consumes exactly the user's old PT, and whose
    reflected call buys the requested new PT for the user
  - native value must equal the deposit amount (or 0)
- `scripts/check-routes.ts` proves honest routes pass and six tampered/mismatched routes are refused.
- Approvals are for the exact amount, never unlimited (mainnet USDT is reset to 0 first).
- Refuses trades whose price impact exceeds `max_price_impact_bps` (default 1%), or when Pendle
  reports none; checks balances before proposing; flags low liquidity, short maturity, new markets,
  volatile underlyings, suspicious fixed-vs-variable spreads and points that accrue to YT, not PT.
- Pendle aggregators are used only when a market can't take or return the token natively, which keeps
  each call cheap against Pendle's per-IP compute-unit limit; 429s return a clear retry message.
- No API keys or secrets. No state between calls.

## Portal configuration

**Network hosts** (Test & configure → Network access):

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

**Variables & Secrets:** none.

## Build and test

Node.js 24.21.0 and pnpm 11.11.0 on Linux/macOS (WSL2 on Windows).

```bash
pnpm install --frozen-lockfile
pnpm test                                   # typecheck, deterministic build x2, conformance
node scripts/qa.mjs                         # 42 live cases: happy paths, invalid input, error paths
pnpm exec tsx scripts/check-routes.ts       # live router verification incl. roll-over and tampering
node scripts/smoke.mjs <tool> '<json>'      # call any tool once
```

Upload `dist/plugin.mjs` only.

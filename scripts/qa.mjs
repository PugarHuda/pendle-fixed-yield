// Live QA matrix: happy paths, invalid inputs and error paths for every tool. Exits 1 on any failure.
// Usage: node scripts/qa.mjs   (after pnpm build)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const HOLDER = "0xfb95f07cf0a09d55cb3b75983c86c8a8ff5a9708"; // live PT holder on Ethereum + Arbitrum
const PAYBOX_WALLET = "0x632f5c094d1356cd96e3d8d74712a292caa04bf8"; // the developer's PayBox EVM wallet (2.9 USDC on Base)
const EMPTY = "0x1111111111111111111111111111111111111111";
const SUSDAI = "0xf86119a39f8654f38acbbd5488bd83f3f51983c8";
const USDAI = "0x46f545683d8494ef4c54b7ea40ca762c620846ef";
const YUTY = "0x858539e155d870ecbbd27f5fb9d9521aa39251f1";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SUSDAI_SY_INPUT = "0x0b2b2b2076d95dda7817e785989fe353fe955ef9";
const MATURED_UNIETH = "0x7b8aec3d1986b4becbf1c651ff6a953cc0117b05"; // Arbitrum, matured 2026-06-25
const MATURED_APYUSD = "0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952"; // Ethereum, matured 2026-08-27
const quote = (o) => ({ chain: "arbitrum", market: SUSDAI, wallet_address: EMPTY, token_in: ARB_USDC, amount: "25", ...o });
const sc = (r) => r.structuredContent;

// [label, tool, args, expectError, textPattern, extraCheck?]
const cases = [
  ["find: defaults scan every chain", "find_fixed_yields", {}, false, /fixed vs .* variable/, (r) => sc(r).markets_scanned > 50],
  ["find: rows carry variable APY, premium, risk flags", "find_fixed_yields", { limit: 5 }, false, /variable/,
    (r) => sc(r).results.every((x) => typeof x.variable_apy_pct === "number" && Array.isArray(x.risk_flags) && x.protocol)],
  ["find: btc on base only", "find_fixed_yields", { chain: "base", asset: "btc", min_liquidity_usd: 0 }, false, /BTC/i,
    (r) => sc(r).results.length > 0 && sc(r).results.every((x) => x.asset === "btc" && x.chain === "base")],
  ["find: Robinhood Chain tokenized assets", "find_fixed_yields", { chain: "robinhood", min_liquidity_usd: 0, min_days: 0 }, false, /robinhood/,
    (r) => sc(r).results.length > 0 && sc(r).results.every((x) => x.chain === "robinhood")],
  ["find: sorted by APY desc", "find_fixed_yields", { limit: 10 }, false, /fixed/,
    (r) => sc(r).results.every((x, i, a) => i === 0 || a[i - 1].fixed_apy_pct >= x.fixed_apy_pct)],
  ["find: sort by premium", "find_fixed_yields", { sort: "fixed_premium", limit: 6 }, false, /fixed/,
    (r) => sc(r).results.every((x, i, a) => i === 0 || a[i - 1].fixed_premium_pct >= x.fixed_premium_pct)],
  ["find: exclude_flagged drops risky markets", "find_fixed_yields", { exclude_flagged: true, min_liquidity_usd: 0, limit: 25 }, false, /fixed/,
    (r) => sc(r).results.every((x) => !x.risk_flags.some((f) => ["low_liquidity", "new_market", "volatile_underlying"].includes(f)))],
  ["find: impossible filter → empty", "find_fixed_yields", { min_liquidity_usd: 1e10 }, false, /No Pendle fixed yields/],
  ["find: limit 0 rejected", "find_fixed_yields", { limit: 0 }, true, /validation/i],
  ["find: unknown asset rejected", "find_fixed_yields", { asset: "doge" }, true, /validation/i],
  ["find: extra field rejected", "find_fixed_yields", { foo: 1 }, true, /validation/i],
  ["explain: risk notes, 30d trend, accepted token symbols", "explain_fixed_yield_market", { chain: "arbitrum", market: SUSDAI }, false, /Pendle risk note/,
    (r) => sc(r).apy_30d?.days >= 20 && sc(r).accepts.every((t) => t.symbol && !t.symbol.includes("…")) && sc(r).pt_price_in_underlying > 0 && sc(r).risk.length > 20],
  ["explain: matured market is labelled inactive", "explain_fixed_yield_market", { chain: "arbitrum", market: MATURED_UNIETH }, false, /uniETH/,
    (r) => sc(r).active === false && sc(r).pt_price_in_underlying === null],
  ["explain: unknown market", "explain_fixed_yield_market", { chain: "arbitrum", market: EMPTY }, true, /No Pendle market/],
  ["quote: USDC happy path with USD values", "quote_fixed_yield", quote({}), false, /PT-sUSDai.*fixed until.*≈ \$/,
    (r) => sc(r).amount_in_usd > 24 && sc(r).value_at_maturity_usd > sc(r).amount_in_usd && sc(r).routed_via_aggregator === true],
  ["quote: market's own input token skips aggregator", "quote_fixed_yield", quote({ token_in: SUSDAI_SY_INPUT, amount: "10" }), false, /PT-sUSDai/,
    (r) => sc(r).routed_via_aggregator === false],
  ["quote: native ETH", "quote_fixed_yield", quote({ token_in: "native", amount: "0.01" }), false, /ETH → .*PT-sUSDai/],
  ["quote: unsupported chain", "quote_fixed_yield", quote({ chain: "polygon" }), true, /validation/i],
  ["quote: bad market format", "quote_fixed_yield", quote({ market: "0x123" }), true, /validation/i],
  ["quote: unknown market", "quote_fixed_yield", quote({ market: EMPTY }), true, /No Pendle market/],
  ["quote: matured market", "quote_fixed_yield", quote({ market: MATURED_UNIETH }), true, /matured on/],
  ["quote: amount not a number", "quote_fixed_yield", quote({ amount: "abc" }), true, /validation/i],
  ["quote: amount zero", "quote_fixed_yield", quote({ amount: "0" }), true, /greater than zero/],
  ["quote: too many decimals for USDC", "quote_fixed_yield", quote({ amount: "1.1234567" }), true, /decimal places/],
  ["quote: token is not an ERC-20", "quote_fixed_yield", quote({ token_in: EMPTY }), true, /Could not read token/],
  ["quote: unroutable token names accepted tokens", "quote_fixed_yield",
    { chain: "base", market: "0xf5e6cf47ee975600786248cae0a80ab99daf0350", wallet_address: EMPTY, token_in: BASE_USDC, amount: "10" }, true, /Accepted input tokens: apxUSD/],
  ["deposit: insufficient balance refused", "propose_fixed_yield_deposit", quote({ amount: "1000000" }), true, /holds .* less than/],
  ["deposit: approval comes first (exact 2.5 USDC)", "propose_fixed_yield_deposit",
    { chain: "base", market: YUTY, wallet_address: PAYBOX_WALLET, token_in: BASE_USDC, amount: "2.5" }, false, /Step 1 of 2/,
    (r) => sc(r)["io.paybox/transactionProposal"].transaction.data.endsWith("2625a0")],
  ["deposit: slippage above 3% rejected", "propose_fixed_yield_deposit", quote({ slippage_bps: 301 }), true, /validation/i],
  ["deposit: bad wallet rejected", "propose_fixed_yield_deposit", quote({ wallet_address: "alice.eth" }), true, /validation/i],
  ["positions: holder across chains with USD value", "get_fixed_yield_positions", { wallet_address: HOLDER }, false, /PT-sUSDai on arbitrum \(\$/,
    (r) => sc(r).positions.length >= 3 && new Set(sc(r).positions.map((p) => p.chain)).size >= 2 && sc(r).total_value_usd > 1000],
  ["positions: single chain filter", "get_fixed_yield_positions", { wallet_address: HOLDER, chain: "arbitrum" }, false, /PT-sUSDai/,
    (r) => sc(r).positions.every((p) => p.chain === "arbitrum")],
  ["positions: empty wallet", "get_fixed_yield_positions", { wallet_address: EMPTY }, false, /No Pendle PT positions/],
  ["exit: holder gets PT approval first", "propose_fixed_yield_exit", { chain: "arbitrum", market: SUSDAI, wallet_address: HOLDER, token_out: ARB_USDC }, false, /Step 1 of 2.*PT-sUSDai/],
  ["exit: no PT held", "propose_fixed_yield_exit", { chain: "arbitrum", market: SUSDAI, wallet_address: EMPTY, token_out: ARB_USDC }, true, /holds no PT/],
  ["exit: more than balance", "propose_fixed_yield_exit", { chain: "arbitrum", market: SUSDAI, wallet_address: HOLDER, amount: "99999999", token_out: ARB_USDC }, true, /holds only/],
  ["exit: token_out required", "propose_fixed_yield_exit", { chain: "arbitrum", market: SUSDAI, wallet_address: HOLDER }, true, /validation/i],
  ["rollover: auto-target for matured apyUSD, no PT held", "propose_fixed_yield_rollover", { chain: "ethereum", from_market: MATURED_APYUSD, wallet_address: EMPTY }, true, /holds no PT-apyUSD/],
  ["rollover: different underlying refused", "propose_fixed_yield_rollover", { chain: "arbitrum", from_market: SUSDAI, to_market: USDAI, wallet_address: HOLDER }, true, /different underlying/],
  ["rollover: destination not an active market", "propose_fixed_yield_rollover", { chain: "arbitrum", from_market: SUSDAI, to_market: EMPTY, wallet_address: HOLDER }, true, /not an active Pendle market/],
  ["rollover: same market refused", "propose_fixed_yield_rollover", { chain: "arbitrum", from_market: SUSDAI, to_market: SUSDAI, wallet_address: HOLDER }, true, /must differ/],
  ["explain: order-book depth is cumulative and walks the rate down", "explain_fixed_yield_market", { chain: "arbitrum", market: SUSDAI }, false, /Depth: \$/,
    (r) => { const d = sc(r).pt_buy_depth; return d.length >= 3 && d.every((x, i) => i === 0 || (x.pt_available >= d[i - 1].pt_available && x.fixed_apy_pct <= d[i - 1].fixed_apy_pct)); }],
  ["ladder: 4 Ethereum USDC rungs in distinct months, verified quotes", "plan_fixed_yield_ladder",
    { chain: "ethereum", wallet_address: EMPTY, token_in: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "10000", rungs: 4 }, false, /Blended fixed APY/,
    (r) => { const x = sc(r); const m = x.rungs.map((g) => g.maturity.slice(0, 7)); return x.rungs.length === 4 && new Set(m).size === 4
      && m.every((v, i) => i === 0 || m[i - 1] < v) && x.rungs.reduce((t, g) => t + Number(g.amount_in), 0) === 10000 && x.blended_fixed_apy_pct > 0 && !x.balance_sufficient; }],
  ["ladder: odd amount keeps every atomic unit", "plan_fixed_yield_ladder",
    { chain: "ethereum", wallet_address: EMPTY, token_in: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "1000.000001", rungs: 3 }, false, /Ladder of 3/,
    (r) => Math.round(sc(r).rungs.reduce((t, g) => t + Number(g.amount_in) * 1e6, 0)) === 1000000001],
  ["ladder: 0xEeee… gas-token sentinel is read as native ETH", "plan_fixed_yield_ladder",
    { chain: "ethereum", wallet_address: EMPTY, token_in: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amount: "3", rungs: 2, asset: "eth" }, false, /Ladder of 2 .*\n.*ETH →/,
    (r) => sc(r).token_in_symbol === "ETH"],
  ["ladder: chain without two months points elsewhere", "plan_fixed_yield_ladder",
    { chain: "plasma", wallet_address: EMPTY, token_in: "native", amount: "1" }, true, /Chains that can ladder usd now: .*ethereum/],
  ["ladder: unroutable token fails clearly with accepted tokens", "plan_fixed_yield_ladder",
    { chain: "monad", wallet_address: EMPTY, token_in: "native", amount: "100" }, true, /No rung could be quoted with MON: .*accepts/],
  ["ladder: rungs 5 rejected", "plan_fixed_yield_ladder", { chain: "ethereum", wallet_address: EMPTY, token_in: "native", amount: "1", rungs: 5 }, true, /validation/i],
  ["rollover: no later maturity available", "propose_fixed_yield_rollover", { chain: "arbitrum", from_market: SUSDAI, wallet_address: HOLDER }, true, /No active sUSDai market/],
];

function call(tool, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "ignore"] });
    const started = Date.now();
    const timer = setTimeout(() => { child.kill(); resolve({ timeout: true, ms: Date.now() - started }); }, 10_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== 1) return;
      clearTimeout(timer); child.kill();
      resolve({ ...(msg.result ?? { isError: true, content: [{ text: JSON.stringify(msg.error) }] }), ms: Date.now() - started });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "qa", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }) + "\n");
  });
}

let failed = 0;
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
for (const [label, tool, args, expectError, pattern, extra] of cases) {
  if (only && !only.test(label)) continue;
  const r = await call(tool, args);
  const text = (r.content ?? []).map((c) => c.text).join(" | ");
  let extraOk = true;
  try { extraOk = !extra || Boolean(extra(r)); } catch { extraOk = false; }
  const ok = !r.timeout && Boolean(r.isError) === expectError && pattern.test(text) && extraOk;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${String(r.ms).padStart(5)}ms  ${label}${ok ? "" : `\n      → isError=${r.isError} timeout=${!!r.timeout} extra=${extraOk} text=${text.slice(0, 300)}`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);

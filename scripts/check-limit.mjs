// Live check of the limit-order tools: builds a real preSignSingle and cancelSingle proposal for a wallet that already
// has Pendle limit orders and a Limit Router allowance, then simulates both with eth_call from that wallet.
// Usage: node scripts/check-limit.mjs   (after pnpm build; exits 1 if any expectation fails)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const RPC = "https://arbitrum-one-rpc.publicnode.com";
const MAKER = "0xa7b114832112e4286dd72b2c22959c739d102a1a"; // live Pendle limit-order maker on Arbitrum (sUSDai)
const SUSDAI_MARKET = "0xf86119a39f8654f38acbbd5488bd83f3f51983c8";
const SUSDAI = "0x0b2b2b2076d95dda7817e785989fe353fe955ef9";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });
const pending = new Map();
lines.on("line", (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m.result ?? m.error); });
let id = 0;
const call = (name, args) => new Promise((res) => {
  pending.set(++id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "check-limit", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
  } } }) + "\n");
});
const simulate = async (tx) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: MAKER, to: tx.to, data: tx.data, value: "0x0" }, "latest"] }) }).then((x) => x.json());
  return r.error ? `reverted: ${r.error.message}` : "ok";
};

let failed = 0;
const expect = (ok, label) => { console.log(ok ? "ok  " : "FAIL", label); if (!ok) failed++; };
const text = (r) => r?.content?.map((c) => c.text).join(" ") ?? JSON.stringify(r);
const proposal = (r) => r?.structuredContent?.["io.paybox/transactionProposal"]?.transaction;

const place = await call("propose_fixed_yield_limit_order", { chain: "arbitrum", market: SUSDAI_MARKET, wallet_address: MAKER, token_in: SUSDAI, amount: "0.05", target_fixed_apy_pct: 14, expires_in_days: 7 });
const tx = proposal(place);
expect(tx?.to === "0x000000000000c9B3E2C3Ec88B1B4c0cD853f4321" && tx.data.startsWith("0x"), `place: proposal to the Limit Router (${text(place).slice(0, 120)})`);
if (tx) expect((await simulate(tx)) === "ok", "place: preSignSingle simulates without revert from the maker");

const list = await call("get_fixed_yield_limit_orders", { wallet_address: MAKER, chain: "arbitrum" });
const orders = list?.structuredContent?.orders ?? [];
expect(orders.length > 0 && orders.every((o) => o.active && o.target_fixed_apy_pct > 0), `list: ${orders.length} active orders with target APYs`);

const open = orders.find((o) => o.side === "buy PT");
if (open) {
  const cancel = await call("propose_cancel_fixed_yield_limit_order", { chain: "arbitrum", wallet_address: MAKER, order_id: open.order_id });
  const ctx = proposal(cancel);
  expect(Boolean(ctx), `cancel: proposal for ${open.order_id.slice(0, 12)}… (${text(cancel).slice(0, 100)})`);
  if (ctx) expect((await simulate(ctx)) === "ok", "cancel: cancelSingle simulates without revert from the maker");
}

const refuse = async (label, name, args, pattern) => { const r = await call(name, args); expect(r?.isError && pattern.test(text(r)), `${label}: ${text(r).slice(0, 140)}`); };
await refuse("unsupported funding token lists accepted ones", "propose_fixed_yield_limit_order",
  { chain: "arbitrum", market: SUSDAI_MARKET, wallet_address: MAKER, token_in: USDC, amount: "1", target_fixed_apy_pct: 14 }, /Accepted: .*sUSDai/);
await refuse("target at or below today's rate points to a deposit", "propose_fixed_yield_limit_order",
  { chain: "arbitrum", market: SUSDAI_MARKET, wallet_address: MAKER, token_in: SUSDAI, amount: "1", target_fixed_apy_pct: 1 }, /propose_fixed_yield_deposit/);
await refuse("expiry past maturity refused", "propose_fixed_yield_limit_order",
  { chain: "arbitrum", market: SUSDAI_MARKET, wallet_address: MAKER, token_in: SUSDAI, amount: "1", target_fixed_apy_pct: 14, expires_in_days: 365 }, /before the market matures/);
await refuse("cancel of an unknown order refused", "propose_cancel_fixed_yield_limit_order",
  { chain: "arbitrum", wallet_address: MAKER, order_id: "0x" + "ab".repeat(32) }, /No limit order/);

child.kill();
process.exit(failed ? 1 : 0);

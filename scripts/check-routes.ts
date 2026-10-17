// Live check of the router-verification paths (buy, sell, redeem, roll-over) and of tamper rejection.
// Usage: pnpm exec tsx scripts/check-routes.ts   (exits 1 if any expectation fails)
import { getAddress } from "viem";
import { activeMarkets, convert, findMarket, resetBudget, UserError } from "../src/pendle.js";

const holder = getAddress("0xfb95f07cf0a09d55cb3b75983c86c8a8ff5a9708");
const usdc = getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
const active = await activeMarkets();
const susdai = active.find((m) => m.chain === "arbitrum" && m.name === "sUSDai")!;
const otherArb = active.find((m) => m.chain === "arbitrum" && m.name !== "sUSDai")!;
// Ethereum apyUSD: a matured market and an active successor on the same SY; siUSD: two active maturities.
const maturedApy = await findMarket("ethereum", "0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952");
const nextApy = active.find((m) => m.chain === "ethereum" && m.sy === maturedApy.sy)!;
const siUsd = active.filter((m) => m.chain === "ethereum" && m.name === "siUSD").sort((a, b) => a.expiry.localeCompare(b.expiry));
const maturedArb = await findMarket("arbitrum", "0x7b8aec3d1986b4becbf1c651ff6a953cc0117b05");

let failed = 0;
const expect = (ok: boolean, label: string) => { resetBudget(); console.log(ok ? "ok  " : "FAIL", label); if (!ok) failed++; };
const refused = async (label: string, run: () => Promise<unknown>, pattern: RegExp) => {
  try { await run(); expect(false, `${label} (was accepted)`); }
  catch (e) { expect(e instanceof UserError && pattern.test(e.message), `${label}: ${(e as Error).message}`); }
};
const base = { slippageBps: 50, nativeValue: false };
resetBudget();

const buy = await convert("arbitrum", { kind: "buy", market: susdai }, { ...base, receiver: holder, tokenIn: usdc, amountIn: 25_000_000n, tokenOut: susdai.pt });
expect(buy.method === "swapExactTokenForPt" && buy.usedAggregator, `buy USDC→PT decodes as ${buy.method}, aggregator=${buy.usedAggregator}`);
const native = await convert("arbitrum", { kind: "buy", market: susdai }, { ...base, receiver: holder, tokenIn: susdai.inputTokens[0]!, amountIn: 10n ** 19n, tokenOut: susdai.pt });
expect(!native.usedAggregator, `buy with the market's own input token skips the aggregator (${susdai.inputTokens[0]})`);
const sell = await convert("arbitrum", { kind: "exit", market: susdai }, { ...base, receiver: holder, tokenIn: susdai.pt, amountIn: 10n ** 19n, tokenOut: usdc });
expect(sell.method === "swapExactPtForToken", `sell before maturity decodes as ${sell.method}`);
const redeem = await convert("arbitrum", { kind: "exit", market: maturedArb }, { ...base, receiver: holder, tokenIn: maturedArb.pt, amountIn: 10n ** 18n, tokenOut: maturedArb.outputTokens[0]! });
expect(redeem.method === "redeemPyToToken", `redeem matured ${maturedArb.name} decodes as ${redeem.method}`);
const rollMatured = await convert("ethereum", { kind: "rollover", from: maturedApy, to: nextApy }, { ...base, receiver: holder, tokenIn: maturedApy.pt, amountIn: 10n ** 18n, tokenOut: nextApy.pt });
expect(rollMatured.method === "callAndReflect" && rollMatured.amountOut > 0n, `roll matured ${maturedApy.name} ${maturedApy.expiry.slice(0, 10)} → ${nextApy.expiry.slice(0, 10)}: ${rollMatured.amountOut}`);
if (siUsd.length >= 2) {
  const rollActive = await convert("ethereum", { kind: "rollover", from: siUsd[0]!, to: siUsd[1]! }, { ...base, receiver: holder, tokenIn: siUsd[0]!.pt, amountIn: 10n ** 18n, tokenOut: siUsd[1]!.pt });
  expect(rollActive.method === "callAndReflect", `roll active siUSD ${siUsd[0]!.expiry.slice(0, 10)} → ${siUsd[1]!.expiry.slice(0, 10)} (sold at market)`);
}

// Pendle builds these honestly, but the plugin's expectations differ, so each must be refused.
await refused("buy route for a different market", () => convert("arbitrum", { kind: "buy", market: otherArb }, { ...base, receiver: holder, tokenIn: usdc, amountIn: 25_000_000n, tokenOut: susdai.pt }), /different market/);
await refused("sell calldata where a buy was expected", () => convert("arbitrum", { kind: "buy", market: susdai }, { ...base, receiver: holder, tokenIn: susdai.pt, amountIn: 10n ** 19n, tokenOut: usdc }), /unexpected router function/);
await refused("mismatched native value", () => convert("arbitrum", { kind: "buy", market: susdai }, { ...base, receiver: holder, tokenIn: usdc, amountIn: 25_000_000n, tokenOut: susdai.pt, nativeValue: true }), /native value/);
await refused("roll-over into a market other than the one requested", () => convert("ethereum", { kind: "rollover", from: maturedApy, to: siUsd[1]! }, { ...base, receiver: holder, tokenIn: maturedApy.pt, amountIn: 10n ** 18n, tokenOut: nextApy.pt }), /different market/);
await refused("roll-over from a different source PT", () => convert("ethereum", { kind: "rollover", from: siUsd[0]!, to: nextApy }, { ...base, receiver: holder, tokenIn: maturedApy.pt, amountIn: 10n ** 18n, tokenOut: nextApy.pt }), /different market|unexpected router function/);
await refused("plain buy where a roll-over was expected", () => convert("arbitrum", { kind: "rollover", from: susdai, to: susdai }, { ...base, receiver: holder, tokenIn: susdai.inputTokens[0]!, amountIn: 10n ** 19n, tokenOut: susdai.pt }), /not a callAndReflect/);

process.exit(failed ? 1 : 0);

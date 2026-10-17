// Builds one approval-proposal argument set per chain, using a market's SY contract as a read-only "wallet" that
// holds the market's input token. Used to check, in the developer portal, which chains PayBox can simulate/sign.
// Usage: pnpm exec tsx scripts/chain-probes.ts
import { formatUnits } from "viem";
import { activeMarkets, CHAIN_KEYS, resetBudget, tokenState } from "../src/pendle.js";

const active = await activeMarkets();
const probes: Record<string, unknown> = {};
for (const chain of CHAIN_KEYS) {
  resetBudget();
  for (const m of active.filter((x) => x.chain === chain).sort((a, b) => b.liquidityUsd - a.liquidityUsd)) {
    const found = await (async () => {
      for (const t of m.inputTokens) {
        const s = await tokenState(chain, t, m.sy).catch(() => null);
        if (s && s.balance >= 10n ** BigInt(s.decimals)) return s;
      }
      return null;
    })();
    if (!found) continue;
    probes[chain] = { chain, market: m.address, wallet_address: m.sy, token_in: found.token, amount: "1", _note: `${m.name}: SY holds ${formatUnits(found.balance, found.decimals)} ${found.symbol}` };
    break;
  }
  if (!probes[chain]) probes[chain] = { chain, _note: "no probe found" };
}
console.log(JSON.stringify(probes, null, 1));

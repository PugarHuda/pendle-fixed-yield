// Finds real wallets that already have a live Pendle Router allowance, to smoke-test step-2 deposits, exits and
// roll-overs against real holdings (node scripts/smoke.mjs ...). The portal's "Validate transaction" always simulates
// from your own PayBox wallet, so those proposals only validate there for a wallet that holds the position.
// Usage: pnpm exec tsx scripts/find-sim-wallets.ts [chain] [extra input token...]   (e.g. USDC, routed via aggregator)
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address } from "viem";
import { activeMarkets, CHAINS, ROUTER, resetBudget, tokenState, type ChainKey } from "../src/pendle.js";

const chain = (process.argv[2] ?? "base") as ChainKey;
const rpc = createPublicClient({ transport: http(CHAINS[chain].rpc, { timeout: 20_000 }) });
const approval = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
const markets = (await activeMarkets()).filter((m) => m.chain === chain);

// Recent approvals of `tokens` to the router, newest first. publicnode serves logs only for recent blocks without a
// token, and only when the range ends at "latest".
async function approvers(tokens: Address[], blocks: bigint) {
  const head = await rpc.getBlockNumber();
  const logs = await rpc.getLogs({ address: tokens, event: approval, args: { spender: ROUTER }, fromBlock: head - blocks, toBlock: "latest" });
  const seen = new Map<Address, Address>();
  for (const l of logs.reverse()) if (l.args.value! > 0n) seen.set(getAddress(l.args.owner!), getAddress(l.address));
  return [...seen];
}

const out: Record<string, unknown> = {};
// Deposit: a wallet with balance and allowance for one of a market's input tokens.
const extra = process.argv.slice(3).map((t) => getAddress(t));
const inputs = extra.length ? extra : [...new Set(markets.flatMap((m) => m.inputTokens))];
for (const [owner, token] of await approvers(inputs, 5_000n)) {
  resetBudget();
  const s = await tokenState(chain, token, owner).catch(() => null);
  if (!s || s.balance === 0n || s.allowance === 0n) continue;
  const amount = (s.balance < s.allowance ? s.balance : s.allowance) / 2n;
  const m = markets.filter((x) => extra.includes(token) || x.inputTokens.includes(token)).sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]!;
  out.deposit = { chain, market: m.address, wallet_address: owner, token_in: token, amount_atomic: amount.toString(), _note: `${m.name} Â· ${s.symbol} balance ${s.balance} allowance ${s.allowance}` };
  break;
}
// Exit / roll-over: a wallet holding a PT that is already approved to the router.
for (const [owner, pt] of await approvers(markets.map((m) => m.pt), 5_000n)) {
  const [bal, allow] = await Promise.all([
    rpc.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    rpc.readContract({ address: pt, abi: erc20Abi, functionName: "allowance", args: [owner, ROUTER] }),
  ]);
  if (bal === 0n || allow < bal) continue;
  const m = markets.find((x) => x.pt === pt)!;
  out.exit = { chain, market: m.address, wallet_address: owner, _note: `${m.name} ${m.expiry.slice(0, 10)} Â· PT balance ${bal}` };
  break;
}
console.log(JSON.stringify(out, null, 1));

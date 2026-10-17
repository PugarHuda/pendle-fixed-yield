import { createPublicClient, decodeFunctionData, erc20Abi, getAddress, http, type Address } from "viem";

// Pendle chains that PayBox wallets can sign on (each verified with a portal simulation; X Layer is not supported by PayBox).
// RPC hosts must match the portal's network allowlist.
// Reflector addresses come from pendle-finance/pendle-core-v2-public deployments/<chainId>-core.json.
const REFLECTOR_A = "0x30544e00Cf296B34A9eE59E5540Ae2f9CCCD55DD" as const;
const REFLECTOR_B = "0x73d5DBF81A4f3bFa7b335e6a2d4638D6017a4fA8" as const;
export const CHAINS = {
  ethereum: { id: 1, rpc: "https://ethereum-rpc.publicnode.com", native: "ETH", reflector: REFLECTOR_A },
  base: { id: 8453, rpc: "https://base-rpc.publicnode.com", native: "ETH", reflector: REFLECTOR_A },
  arbitrum: { id: 42161, rpc: "https://arbitrum-one-rpc.publicnode.com", native: "ETH", reflector: REFLECTOR_A },
  hyperevm: { id: 999, rpc: "https://rpc.hyperliquid.xyz/evm", native: "HYPE", reflector: REFLECTOR_A },
  robinhood: { id: 4663, rpc: "https://robinhood-rpc.publicnode.com", native: "ETH", reflector: REFLECTOR_B },
  bsc: { id: 56, rpc: "https://bsc-rpc.publicnode.com", native: "BNB", reflector: REFLECTOR_A },
  monad: { id: 143, rpc: "https://rpc.monad.xyz", native: "MON", reflector: REFLECTOR_B },
  plasma: { id: 9745, rpc: "https://rpc.plasma.to", native: "XPL", reflector: REFLECTOR_A },
} as const;
export type ChainKey = keyof typeof CHAINS;
export const CHAIN_KEYS = Object.keys(CHAINS) as [ChainKey, ...ChainKey[]];
const CHAIN_BY_ID = new Map(CHAIN_KEYS.map((k) => [CHAINS[k].id as number, k]));

const API = "https://api-v2.pendle.finance/core";
// Pendle Router V4, same address on every supported chain. Anything else returned by the API is rejected.
export const ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946" as const;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
// Each sandbox run is a fresh process serving one call, with a 10s budget. Rather than a fixed per-request timeout,
// every upstream call gets whatever is left of a 9s budget (capped at 6s), so one slow Pendle convert still fits.
let started = Date.now();
const BUDGET_MS = 9_000;
export const timeLeft = () => Math.max(500, Math.min(6_000, started + BUDGET_MS - Date.now() - 300));
export const elapsed = () => Date.now() - started;
/** For local scripts that make many calls in one process; the hosted plugin never needs it. */
export const resetBudget = () => { started = Date.now(); };
const DAY_MS = 86_400_000;

export type Asset = "usd" | "eth" | "btc" | "hype" | "other";

export interface Market {
  chain: ChainKey;
  address: Address;
  name: string;
  protocol: string;
  expiry: string;
  pt: Address;
  yt: Address;
  sy: Address;
  accounting: Address;
  inputTokens: Address[];
  outputTokens: Address[];
  fixedApy: number;
  underlyingApy: number;
  liquidityUsd: number;
  tvlUsd: number;
  asset: Asset;
  categories: string[];
  points: string[];
  isNew: boolean;
  isVolatile: boolean;
  active: boolean;
  info: { description: string; risk: string; quirks: string };
}

export class UserError extends Error {}

async function request<T>(path: string, init?: { body: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init ? "POST" : "GET",
      signal: AbortSignal.timeout(timeLeft()),
      headers: { accept: "application/json", ...(init ? { "content-type": "application/json" } : {}) },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new UserError("Pendle API did not respond in time. Try again shortly.");
  }
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const wait = Number.isFinite(reset) ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 60;
    throw new UserError(`Pendle API rate limit reached; try again in about ${wait}s.`);
  }
  const body = await res.json().catch(() => null) as any;
  if (!res.ok) {
    const raw = Array.isArray(body?.message) ? body.message.join("; ") : body?.message;
    throw new UserError(`Pendle rejected the request: ${typeof raw === "string" ? raw.slice(0, 200) : `HTTP ${res.status}`}`);
  }
  return body as T;
}

const addr = (prefixed: string) => getAddress(prefixed.slice(prefixed.indexOf("-") + 1));

// ponytail: asset bucket from Pendle categories + market name; good enough for filtering, not a token registry.
function classify(name: string, categories: string[]): Asset {
  const n = name.toUpperCase();
  if (categories.includes("stables") || /USD|DAI|GHO|FRAX/.test(n)) return "usd";
  if (/BTC/.test(n)) return "btc";
  if (/HYPE/.test(n)) return "hype";
  if (categories.includes("eth") || /ETH/.test(n)) return "eth";
  return "other";
}

/** Pendle's market descriptions are HTML; agents and users get plain text. */
export function plainText(html: unknown, max = 700): string {
  if (typeof html !== "string") return "";
  const text = html
    .replace(/<li[^>]*>/gi, "• ").replace(/<\/(p|li|ul|div)>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toMarket(raw: any): Market | null {
  const chain = CHAIN_BY_ID.get(Number(raw.chainId));
  if (!chain) return null;
  const d = raw.details ?? {};
  const categories: string[] = Array.isArray(raw.categoryIds) ? raw.categoryIds.map(String) : [];
  const tokens = (list: unknown) => (Array.isArray(list) ? list.map((t) => addr(String(t))) : []);
  return {
    chain,
    address: getAddress(raw.address),
    name: String(raw.name),
    protocol: String(raw.protocol ?? ""),
    expiry: String(raw.expiry),
    pt: addr(raw.pt),
    yt: addr(raw.yt),
    sy: addr(raw.sy),
    accounting: addr(raw.accountingAsset ?? raw.underlyingAsset),
    inputTokens: tokens(raw.inputTokens),
    outputTokens: tokens(raw.outputTokens),
    fixedApy: Number(d.impliedApy ?? 0),
    underlyingApy: Number(d.underlyingApy ?? 0),
    liquidityUsd: Number(d.liquidity ?? 0),
    tvlUsd: Number(d.totalTvl ?? 0),
    asset: classify(String(raw.name), categories),
    categories,
    points: Array.isArray(raw.points) ? raw.points.map((p: any) => String(p.key)) : [],
    isNew: Boolean(raw.isNew),
    isVolatile: Boolean(raw.isVolatile),
    active: Date.parse(String(raw.expiry)) > Date.now(),
    info: {
      description: plainText(raw.marketInfo?.assetDescription),
      risk: plainText(raw.marketInfo?.riskInvolved),
      quirks: plainText(raw.marketInfo?.importantQuirks),
    },
  };
}

// One sandbox run serves one tool call, so a per-process memo is safe and avoids refetching.
let activeCache: Promise<Market[]> | undefined;

/** Every active, whitelisted Pendle market on the supported chains (one paginated endpoint). */
export function activeMarkets(): Promise<Market[]> {
  activeCache ??= (async () => {
    const out: Market[] = [];
    for (let skip = 0; skip < 1000; skip += 100) {
      const page = await request<{ total: number; results: any[] }>(`/v2/markets/all?isActive=true&limit=100&skip=${skip}`);
      for (const raw of page.results) { const m = toMarket(raw); if (m?.active) out.push(m); }
      if (skip + 100 >= page.total) break;
    }
    return out;
  })();
  return activeCache;
}

/** Fetch specific markets (active or matured) by id, 20 per request. */
export async function marketsById(ids: { chain: ChainKey; address: Address }[]): Promise<Market[]> {
  const unique = [...new Set(ids.map((i) => `${CHAINS[i.chain].id}-${i.address.toLowerCase()}`))];
  const pages = await Promise.all(Array.from({ length: Math.ceil(unique.length / 20) }, (_, i) =>
    request<{ results: any[] }>(`/v2/markets/all?ids=${unique.slice(i * 20, i * 20 + 20).join(",")}&limit=100`)));
  return pages.flatMap((p) => p.results).map(toMarket).filter((m): m is Market => m !== null);
}

export async function findMarket(chain: ChainKey, market: string): Promise<Market> {
  const target = getAddress(market);
  const found = (await marketsById([{ chain, address: target }])).find((m) => m.chain === chain && m.address === target);
  if (!found) throw new UserError(`No Pendle market ${target} on ${chain}. Use find_fixed_yields to get a market address.`);
  return found;
}

export function daysLeft(expiry: string) {
  return Math.max(0, (Date.parse(expiry) - Date.now()) / DAY_MS);
}

/** Growth of 1 unit at the fixed APY until maturity (Pendle implied APY compounds annually). */
export function maturityMultiplier(apy: number, days: number) {
  return (1 + apy) ** (days / 365);
}

/** Deterministic warnings an agent should surface before the user commits funds. */
export function riskFlags(m: Market): string[] {
  const days = daysLeft(m.expiry);
  const flags: string[] = [];
  if (m.liquidityUsd < 250_000) flags.push("low_liquidity");
  if (days < 14) flags.push("short_maturity");
  if (m.isNew) flags.push("new_market");
  if (m.isVolatile) flags.push("volatile_underlying");
  if (m.fixedApy - m.underlyingApy > 0.05 && m.fixedApy > 2 * m.underlyingApy) flags.push("fixed_far_above_variable");
  if (m.points.length) flags.push("points_go_to_yt_not_pt");
  return flags;
}

/** USD prices for Pendle-listed tokens (PT, SY and their underlying assets), keyed by checksum address. */
export async function prices(chain: ChainKey, tokens: Address[]): Promise<Map<Address, number>> {
  const ids = [...new Set(tokens)].slice(0, 20).map((t) => `${CHAINS[chain].id}-${t.toLowerCase()}`);
  if (!ids.length) return new Map();
  const { prices: raw } = await request<{ prices: Record<string, number> }>(`/v1/prices/assets?ids=${ids.join(",")}`);
  return new Map(Object.entries(raw ?? {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [addr(k), v]));
}

export interface HistoryPoint { timestamp: string; impliedApy: number; underlyingApy: number; tvl: number }

export async function history(m: Market, days: number): Promise<HistoryPoint[]> {
  const start = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { results } = await request<{ results: any[] }>(
    `/v3/${CHAINS[m.chain].id}/markets/${m.address}/historical-data?time_frame=day&timestamp_start=${start}&fields=impliedApy,underlyingApy,tvl`);
  return (results ?? []).map((r) => ({ timestamp: String(r.timestamp), impliedApy: Number(r.impliedApy), underlyingApy: Number(r.underlyingApy), tvl: Number(r.tvl) }))
    .filter((r) => Number.isFinite(r.impliedApy));
}

/** Real-time pool price: how much underlying 1 PT is worth now (the discount that becomes the fixed yield). */
export async function ptRate(m: Market): Promise<{ ptToUnderlying: number; underlying: Address } | null> {
  const r = await request<any>(`/v1/sdk/${CHAINS[m.chain].id}/markets/${m.address}/swapping-prices`);
  const rate = Number(r?.ptToUnderlyingTokenRate);
  return Number.isFinite(rate) && r?.underlyingToken ? { ptToUnderlying: rate, underlying: getAddress(r.underlyingToken) } : null;
}

/**
 * How much PT a buyer can take before the fixed rate falls to each level, from Pendle's consolidated book
 * (limit orders + AMM depth). A PT buy fills long-yield orders, which are listed from the current APY downward.
 * Sizes are cumulative PT in atomic units.
 */
export async function ptBuyDepth(m: Market, levels = 6): Promise<{ apy: number; pt: bigint }[]> {
  const book = await request<{ longYieldEntries?: { impliedApy: number; limitOrderSize: string; ammSize: string }[] }>(
    `/v2/limit-orders/book/${CHAINS[m.chain].id}?market=${m.address}&limit=${levels}&precisionDecimal=1&includeAmm=true`);
  let total = 0n;
  return (book.longYieldEntries ?? []).filter((e) => Number.isFinite(e.impliedApy)).map((e) => {
    total += BigInt(e.limitOrderSize || "0") + BigInt(e.ammSize || "0");
    return { apy: e.impliedApy, pt: total };
  });
}

export interface PendlePosition { chain: ChainKey; market: Address }

/** Markets Pendle has indexed for this wallet across all chains (cached by Pendle up to ~24h); used to discover
 *  matured or older markets, never as balance truth — balances are always re-read on-chain. */
export async function indexedMarkets(owner: Address): Promise<PendlePosition[]> {
  const { positions } = await request<{ positions: any[] }>(`/v1/dashboard/positions/database/${owner}?filterUsd=0.01`);
  return (positions ?? []).flatMap((c: any) => [...(c.openPositions ?? []), ...(c.closedPositions ?? [])].map((p: any) => {
    const [chainId, market] = String(p.marketId).split("-");
    const chain = CHAIN_BY_ID.get(Number(chainId));
    return chain && market && BigInt(p.pt?.balance ?? "0") > 0n ? { chain, market: getAddress(market) } : null;
  })).filter((p): p is PendlePosition => p !== null);
}

function client(chain: ChainKey) {
  return createPublicClient({ transport: http(CHAINS[chain].rpc, { timeout: timeLeft(), retryCount: 0 }) });
}

const getEthBalanceAbi = [{ type: "function", name: "getEthBalance", stateMutability: "view",
  inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] }] as const;

export interface TokenState { token: Address; native: boolean; symbol: string; decimals: number; balance: bigint; allowance: bigint }

/** Balance, decimals, symbol and router allowance of `token` for `owner`, in one multicall. */
export async function tokenState(chain: ChainKey, token: Address | "native", owner: Address): Promise<TokenState> {
  const c = client(chain);
  try {
    if (token === "native") {
      const balance = await c.readContract({ address: MULTICALL3, abi: getEthBalanceAbi, functionName: "getEthBalance", args: [owner] });
      return { token: NATIVE, native: true, symbol: CHAINS[chain].native, decimals: 18, balance, allowance: 2n ** 256n - 1n };
    }
    const [decimals, symbol, balance, allowance] = await c.multicall({
      multicallAddress: MULTICALL3, allowFailure: false,
      contracts: [
        { address: token, abi: erc20Abi, functionName: "decimals" },
        { address: token, abi: erc20Abi, functionName: "symbol" },
        { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
        { address: token, abi: erc20Abi, functionName: "allowance", args: [owner, ROUTER] },
      ],
    });
    return { token, native: false, symbol, decimals, balance, allowance };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Could not read token ${token} on ${chain}. Check that it is an ERC-20 on this chain.`);
  }
}

/** Symbols for many tokens in one multicall (unknown → shortened address). */
export async function symbols(chain: ChainKey, tokens: Address[]): Promise<Map<Address, string>> {
  if (!tokens.length) return new Map();
  const results = await client(chain).multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: "symbol" } as const)),
  }).catch(() => []);
  return new Map(tokens.map((t, i) => {
    const r = results[i];
    return [t, r?.status === "success" ? String(r.result) : `${t.slice(0, 6)}…${t.slice(-4)}`];
  }));
}

/** PT balances and decimals for many markets in one multicall. */
export async function ptBalances(chain: ChainKey, markets: Market[], owner: Address) {
  if (!markets.length) return [];
  const results = await client(chain).multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: markets.flatMap((m) => [
      { address: m.pt, abi: erc20Abi, functionName: "balanceOf", args: [owner] } as const,
      { address: m.pt, abi: erc20Abi, functionName: "decimals" } as const,
    ]),
  });
  return markets.map((market, i) => {
    const balance = results[2 * i];
    const decimals = results[2 * i + 1];
    return {
      market,
      balance: balance?.status === "success" ? balance.result as bigint : 0n,
      decimals: decimals?.status === "success" ? Number(decimals.result) : 18,
    };
  });
}

export interface Conversion {
  method: string;
  tx: { to: Address; data: `0x${string}`; value: string };
  amountOut: bigint;
  priceImpact: number | null;
  effectiveApy: number | null;
  feeUsd: number | null;
  usedAggregator: boolean;
}

// Router V4 selectors, read from the calldata itself (never the API's method label). Signatures verified on 4byte.directory.
// Every one takes (address receiver, address marketOrYt, uint256 amount, ...).
const SEL = {
  swapExactTokenForPt: "0xc81f847a",
  swapExactPtForToken: "0x594a88cc",
  redeemPyToToken: "0x47f1de22",
  callAndReflect: "0x9fa02c86",
  redeemPyToSy: "0x339748cb",
  swapExactPtForSy: "0x3346d3a3",
  swapExactSyForPt: "0x2a50917c",
} as const;
const callAndReflectAbi = [{ type: "function", name: "callAndReflect", stateMutability: "payable",
  inputs: [{ name: "reflector", type: "address" }, { name: "selfCall1", type: "bytes" }, { name: "selfCall2", type: "bytes" }, { name: "reflectCall", type: "bytes" }],
  outputs: [] }] as const;

const word = (data: string, i: number) => data.slice(10 + 64 * i, 74 + 64 * i);
const isAddressWord = (data: string, i: number, a: Address) => word(data, i) === a.slice(2).toLowerCase().padStart(64, "0");
const isAmountWord = (data: string, i: number, n: bigint) => word(data, i) === n.toString(16).padStart(64, "0");

/** Check one Router call: selector, receiver (arg 0), market/YT (arg 1) and exact input amount (arg 2). */
function checkCall(data: string, selector: string, receiver: Address, target: Address, amount: bigint | null, what: string) {
  if (data.slice(0, 10) !== selector || data.length < 10 + 64 * 3) throw new UserError(`Pendle route calls an unexpected router function for ${what}; refusing to propose it.`);
  if (!isAddressWord(data, 0, receiver)) throw new UserError(`Pendle route sends ${what} to an unexpected address; refusing to propose it.`);
  if (!isAddressWord(data, 1, target)) throw new UserError(`Pendle route targets a different market for ${what}; refusing to propose it.`);
  if (amount !== null && !isAmountWord(data, 2, amount)) throw new UserError(`Pendle route uses a different amount for ${what}; refusing to propose it.`);
}

export type Plan =
  | { kind: "buy"; market: Market }
  | { kind: "exit"; market: Market }
  | { kind: "rollover"; from: Market; to: Market };

/** Ask Pendle's hosted SDK (v3 convert) for router calldata, then verify it against `plan` before anyone can sign it. */
export async function convert(chain: ChainKey, plan: Plan, args: { receiver: Address; tokenIn: Address; amountIn: bigint; tokenOut: Address; slippageBps: number; nativeValue: boolean }): Promise<Conversion> {
  // Aggregators cost extra Pendle compute units; only route through one when the market can't take/give the token natively.
  const usedAggregator = plan.kind === "buy" ? !plan.market.inputTokens.includes(args.tokenIn)
    : plan.kind === "exit" ? !plan.market.outputTokens.includes(args.tokenOut) : false;
  const body = await request<any>(`/v3/sdk/${CHAINS[chain].id}/convert`, { body: {
    receiver: args.receiver,
    slippage: args.slippageBps / 10_000,
    inputs: [{ token: args.tokenIn, amount: args.amountIn.toString() }],
    outputs: [args.tokenOut],
    enableAggregator: usedAggregator,
    ...(usedAggregator ? { aggregators: ["kyberswap", "okx"] } : {}),
    additionalData: "effectiveApy",
  } });
  const route = body?.routes?.[0];
  if (!route?.tx) throw new UserError("Pendle returned no route for this trade. Try a different token or amount.");

  const to = getAddress(route.tx.to);
  const data = String(route.tx.data).toLowerCase() as `0x${string}`;
  const value = BigInt(route.tx.value ?? "0").toString();
  // Defense in depth: the API is untrusted input. Decode the calldata ourselves.
  if (to !== ROUTER) throw new UserError("Pendle route targets an unexpected contract; refusing to propose it.");
  if (!/^0x([0-9a-f]{2})+$/.test(data)) throw new UserError("Pendle returned malformed calldata.");
  if (value !== (args.nativeValue ? args.amountIn.toString() : "0")) throw new UserError("Pendle route sends an unexpected native value; refusing to propose it.");

  let method: string;
  if (plan.kind === "buy") {
    checkCall(data, SEL.swapExactTokenForPt, args.receiver, plan.market.address, null, "the deposit");
    method = "swapExactTokenForPt";
  } else if (plan.kind === "exit") {
    if (data.startsWith(SEL.redeemPyToToken) && !plan.market.active) {
      checkCall(data, SEL.redeemPyToToken, args.receiver, plan.market.yt, args.amountIn, "the redemption");
      method = "redeemPyToToken";
    } else {
      checkCall(data, SEL.swapExactPtForToken, args.receiver, plan.market.address, args.amountIn, "the sale");
      method = "swapExactPtForToken";
    }
  } else {
    // Roll-over: Router.callAndReflect(reflector, selfCall1, selfCall2, reflectCall). selfCall1 turns the old PT
    // into SY held by Pendle's Reflector; reflectCall has the Reflector buy the new PT for the user.
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: callAndReflectAbi, data });
    } catch {
      throw new UserError("Pendle roll-over route is not a callAndReflect call; refusing to propose it.");
    }
    const [reflector, selfCall1, selfCall2, reflectCall] = decoded.args;
    const expected = CHAINS[chain].reflector;
    if (getAddress(reflector) !== expected) throw new UserError("Pendle roll-over uses an unknown reflector contract; refusing to propose it.");
    const first = selfCall1.toLowerCase();
    if (first.startsWith(SEL.redeemPyToSy)) checkCall(first, SEL.redeemPyToSy, expected, plan.from.yt, args.amountIn, "the matured PT");
    else checkCall(first, SEL.swapExactPtForSy, expected, plan.from.address, args.amountIn, "the old PT");
    if (selfCall2 !== "0x") throw new UserError("Pendle roll-over has an unexpected extra step; refusing to propose it.");
    checkCall(reflectCall.toLowerCase(), SEL.swapExactSyForPt, args.receiver, plan.to.address, null, "the new PT");
    method = "callAndReflect";
  }

  const out = route.outputs?.find((o: any) => getAddress(o.token) === getAddress(args.tokenOut));
  if (!out) throw new UserError("Pendle route did not report the expected output token.");
  const priceImpact = Number(route.data?.priceImpact);
  return {
    method,
    tx: { to, data, value },
    amountOut: BigInt(out.amount),
    priceImpact: Number.isFinite(priceImpact) ? priceImpact : null,
    effectiveApy: typeof route.data?.effectiveApy === "number" ? route.data.effectiveApy : null,
    feeUsd: typeof route.data?.fee?.usd === "number" ? route.data.fee.usd : null,
    usedAggregator,
  };
}

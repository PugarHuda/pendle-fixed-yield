import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, type Address } from "viem";
import * as z from "zod/v4";
import { atomicAmount, evmOutputSchema, proposeEvm } from "./paybox.js";
import {
  activeMarkets, CHAIN_KEYS, CHAINS, convert, daysLeft, elapsed, findMarket, history, indexedMarkets, marketsById, maturityMultiplier,
  NATIVE, prices, ptBalances, ptRate, riskFlags, ROUTER, symbols, tokenState, UserError, type ChainKey, type Market,
} from "./pendle.js";

const PROTOCOL_VERSION = "2026-07-28";

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const chain = z.enum(CHAIN_KEYS).describe(`Network: ${CHAIN_KEYS.join(", ")}.`);
const chainFilter = z.enum(["all", ...CHAIN_KEYS]).default("all");
const wallet = evmAddress.describe("Public address of the PayBox wallet that will sign. Get it from list_credentials; never a private key.");
const token = z.union([z.literal("native"), evmAddress]);
const decimalAmount = z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,36})?$/);
const slippage = z.number().int().min(1).max(300).default(50).describe("Max slippage in basis points (50 = 0.5%).");
const maxImpact = z.number().int().min(1).max(1000).default(100).describe("Refuse if price impact exceeds this many basis points (100 = 1%).");
const marketAddress = evmAddress.describe("Pendle market address from find_fixed_yields.");

const pct = (x: number) => Math.round(x * 10_000) / 100;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const day = (iso: string) => iso.slice(0, 10);
const chainId = (c: ChainKey) => `eip155:${CHAINS[c].id}`;
const usd = (x: number | null) => (x === null ? null : round(x));

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function guarded<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UserError) return fail(error.message);
    console.error(error instanceof Error ? error.message : String(error));
    return fail("Unexpected error while talking to Pendle or the chain. Nothing was proposed; try again.");
  }
}

function withSummary(proposal: ReturnType<typeof proposeEvm>, summary: string) {
  return { ...proposal, content: [{ type: "text" as const, text: summary }, ...proposal.content] };
}

// Mainnet USDT reverts when changing a nonzero allowance; it must be reset to 0 first.
const RESET_FIRST = new Set(["ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7"]);

/** Approval proposal for exactly `amount` (never unlimited) to the Pendle router. */
function proposeApproval(c: ChainKey, tokenAddress: Address, amount: bigint, current: bigint, summary: string, retryTool: string) {
  const reset = current > 0n && RESET_FIRST.has(`${c}:${tokenAddress}`);
  const proposal = proposeEvm({
    chain: chainId(c), to: tokenAddress, value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, reset ? 0n : amount] }),
  });
  const text = reset
    ? `Step 1 of 3: this token needs its existing allowance reset to 0 first. After it confirms, call ${retryTool} again with the same arguments.`
    : `Step 1 of 2: ${summary} After it confirms, call ${retryTool} again with the same arguments.`;
  return withSummary(proposal, text);
}

function checkImpact(priceImpact: number | null, limitBps: number) {
  if (priceImpact === null) throw new UserError("Pendle did not report a price impact for this route, so it cannot be checked; try again or a different amount.");
  if (Math.abs(priceImpact) * 10_000 > limitBps) {
    throw new UserError(`Pendle reports ${round(priceImpact * 100, 3)}% price impact, above the ${limitBps / 100}% limit. `
      + "Very small trades pay fixed routing costs, so try a larger amount, a deeper market, or a higher max_price_impact_bps if the user accepts it.");
  }
}

function parseAmount(amount: string, decimals: number) {
  try {
    return BigInt(atomicAmount(amount, decimals));
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : "Invalid amount.");
  }
}

/** Best place to roll a PT into: an active market on the same SY that matures later, deepest-yielding first. */
function rolloverTarget(from: Market, active: Market[]): Market | undefined {
  return active
    .filter((m) => m.chain === from.chain && m.sy === from.sy && m.address !== from.address
      && Date.parse(m.expiry) > Date.parse(from.expiry) && daysLeft(m.expiry) >= 14 && m.liquidityUsd >= 50_000)
    .sort((a, b) => b.fixedApy - a.fixedApy)[0];
}

const riskFlagList = z.array(z.string()).describe("low_liquidity, short_maturity, new_market, volatile_underlying, fixed_far_above_variable, points_go_to_yt_not_pt");

function createServer() {
  const server = new McpServer(
    { name: "pendle-fixed-yield", version: "2.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  const yieldRow = z.object({
    chain, market: z.string(), name: z.string(), protocol: z.string(), asset: z.string(),
    fixed_apy_pct: z.number(), variable_apy_pct: z.number(), fixed_premium_pct: z.number(),
    maturity: z.string(), days_to_maturity: z.number(), liquidity_usd: z.number(), tvl_usd: z.number(),
    value_of_1000_at_maturity: z.number(), risk_flags: riskFlagList,
  }).strict();

  server.registerTool("find_fixed_yields", {
    title: "Find fixed yields on Pendle",
    description: "Lists Pendle fixed-rate opportunities (Principal Tokens) the user can lock in from a PayBox wallet. "
      + "A PT bought today redeems for one unit of its accounting asset at maturity, so the APY is fixed if held to maturity. "
      + "Each row compares the fixed rate with the asset's current variable APY and carries risk flags. "
      + "Next: explain_fixed_yield_market for details, then quote_fixed_yield.",
    inputSchema: z.object({
      chain: chainFilter,
      asset: z.enum(["any", "usd", "eth", "btc", "hype"]).default("any").describe("usd = stablecoin yields."),
      min_liquidity_usd: z.number().min(0).max(1e10).default(100_000),
      min_days: z.number().int().min(0).max(3650).default(7),
      max_days: z.number().int().min(1).max(3650).optional(),
      sort: z.enum(["fixed_apy", "fixed_premium", "liquidity"]).default("fixed_apy"),
      exclude_flagged: z.boolean().default(false).describe("Drop markets flagged low_liquidity, new_market or volatile_underlying."),
      limit: z.number().int().min(1).max(25).default(8),
    }).strict(),
    outputSchema: z.object({ results: z.array(yieldRow), markets_scanned: z.number() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => guarded(async () => {
    const markets = (await activeMarkets()).filter((m) => args.chain === "all" || m.chain === args.chain);
    const severe = new Set(["low_liquidity", "new_market", "volatile_underlying"]);
    const sortKey = { fixed_apy: (m: Market) => m.fixedApy, fixed_premium: (m: Market) => m.fixedApy - m.underlyingApy, liquidity: (m: Market) => m.liquidityUsd }[args.sort];
    const results = markets
      .map((m) => ({ m, days: daysLeft(m.expiry), flags: riskFlags(m) }))
      .filter(({ m, days, flags }) => (args.asset === "any" || m.asset === args.asset)
        && m.liquidityUsd >= args.min_liquidity_usd && m.fixedApy > 0
        && days >= args.min_days && (args.max_days === undefined || days <= args.max_days)
        && !(args.exclude_flagged && flags.some((f) => severe.has(f))))
      .sort((a, b) => sortKey(b.m) - sortKey(a.m))
      .slice(0, args.limit)
      .map(({ m, days, flags }) => ({
        chain: m.chain, market: m.address, name: m.name, protocol: m.protocol, asset: m.asset,
        fixed_apy_pct: pct(m.fixedApy), variable_apy_pct: pct(m.underlyingApy), fixed_premium_pct: pct(m.fixedApy - m.underlyingApy),
        maturity: day(m.expiry), days_to_maturity: Math.floor(days), liquidity_usd: Math.round(m.liquidityUsd), tvl_usd: Math.round(m.tvlUsd),
        value_of_1000_at_maturity: round(1000 * maturityMultiplier(m.fixedApy, days)), risk_flags: flags,
      }));
    const lines = results.map((r) => `${r.name} (${r.protocol}) on ${r.chain}: ${r.fixed_apy_pct}% fixed vs ${r.variable_apy_pct}% variable until ${r.maturity} `
      + `(${r.days_to_maturity}d, $${r.liquidity_usd.toLocaleString("en-US")} liquidity)${r.risk_flags.length ? ` [${r.risk_flags.join(", ")}]` : ""}`);
    return {
      content: [{ type: "text" as const, text: results.length ? lines.join("\n") : "No Pendle fixed yields match these filters." }],
      structuredContent: { results, markets_scanned: markets.length },
    };
  }));

  const tokenRef = z.object({ address: z.string(), symbol: z.string() }).strict();
  server.registerTool("explain_fixed_yield_market", {
    title: "Explain a Pendle fixed-yield market",
    description: "Due-diligence brief for one Pendle market before locking funds: what the asset is, Pendle's own risk notes and quirks, "
      + "30-day trend of the fixed and variable APY, the PT's current discount, liquidity, points programs, risk flags, and which tokens it accepts and redeems to.",
    inputSchema: z.object({ chain, market: marketAddress }).strict(),
    outputSchema: z.object({
      chain, market: z.string(), name: z.string(), protocol: z.string(), active: z.boolean(), maturity: z.string(), days_to_maturity: z.number(),
      fixed_apy_pct: z.number(), variable_apy_pct: z.number(), fixed_premium_pct: z.number(),
      apy_30d: z.object({ days: z.number(), fixed_min_pct: z.number(), fixed_max_pct: z.number(), fixed_change_pct: z.number(), variable_avg_pct: z.number() }).strict().nullable(),
      pt_price_in_underlying: z.number().nullable(), liquidity_usd: z.number(), tvl_usd: z.number(),
      points: z.array(z.string()), risk_flags: riskFlagList, accepts: z.array(tokenRef), redeems_to: z.array(tokenRef),
      description: z.string(), risk: z.string(), quirks: z.string(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => guarded(async () => {
    const m = await findMarket(args.chain, args.market);
    const tokens = [...new Set([...m.inputTokens, ...m.outputTokens])];
    const [hist, rate, names] = await Promise.all([
      history(m, 30).catch(() => []),
      m.active ? ptRate(m).catch(() => null) : Promise.resolve(null),
      symbols(m.chain, tokens),
    ]);
    const fixed = hist.map((h) => h.impliedApy);
    const apy30 = hist.length >= 2 ? {
      days: hist.length,
      fixed_min_pct: pct(Math.min(...fixed)), fixed_max_pct: pct(Math.max(...fixed)),
      fixed_change_pct: pct(fixed[fixed.length - 1]! - fixed[0]!),
      variable_avg_pct: pct(hist.reduce((s, h) => s + (Number.isFinite(h.underlyingApy) ? h.underlyingApy : 0), 0) / hist.length),
    } : null;
    const ref = (list: Address[]) => list.map((a) => ({ address: a, symbol: names.get(a) ?? a }));
    const out = {
      chain: m.chain, market: m.address, name: m.name, protocol: m.protocol, active: m.active, maturity: day(m.expiry), days_to_maturity: Math.floor(daysLeft(m.expiry)),
      fixed_apy_pct: pct(m.fixedApy), variable_apy_pct: pct(m.underlyingApy), fixed_premium_pct: pct(m.fixedApy - m.underlyingApy),
      apy_30d: apy30, pt_price_in_underlying: rate ? round(rate.ptToUnderlying, 6) : null,
      liquidity_usd: Math.round(m.liquidityUsd), tvl_usd: Math.round(m.tvlUsd), points: m.points, risk_flags: riskFlags(m),
      accepts: ref(m.inputTokens), redeems_to: ref(m.outputTokens),
      description: m.info.description, risk: m.info.risk, quirks: m.info.quirks,
    };
    const text = [
      `${m.name} by ${m.protocol} on ${m.chain}: ${out.fixed_apy_pct}% fixed (variable now ${out.variable_apy_pct}%), matures ${out.maturity}.`,
      apy30 ? `30d fixed APY range ${apy30.fixed_min_pct}–${apy30.fixed_max_pct}% (${apy30.fixed_change_pct >= 0 ? "+" : ""}${apy30.fixed_change_pct} pts), variable avg ${apy30.variable_avg_pct}%.` : "",
      rate ? `1 PT trades at ${out.pt_price_in_underlying} underlying today and redeems for 1 at maturity.` : "",
      `Accepts: ${out.accepts.map((t) => t.symbol).join(", ") || "n/a"}. Risk flags: ${out.risk_flags.join(", ") || "none"}.`,
      out.risk ? `Pendle risk note: ${out.risk}` : "",
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: out };
  }));

  /** Shared by quote and deposit: resolve market, token state and a verified Pendle route for buying PT. */
  async function planDeposit(a: { chain: ChainKey; market: string; wallet_address: string; token_in: string; amount: string; slippage_bps: number }) {
    const owner = getAddress(a.wallet_address);
    const tokenIn = a.token_in === "native" ? "native" as const : getAddress(a.token_in);
    const market = await findMarket(a.chain, a.market);
    if (!market.active) throw new UserError(`${market.name} matured on ${day(market.expiry)}; pick an active market.`);
    const days = daysLeft(market.expiry);
    if (days < 1) throw new UserError(`${market.name} matures in under a day; pick a later maturity.`);
    const [state, pt] = await Promise.all([tokenState(a.chain, tokenIn, owner), tokenState(a.chain, market.pt, owner)]);
    const amountIn = parseAmount(a.amount, state.decimals);
    if (amountIn === 0n) throw new UserError("Amount must be greater than zero.");
    const tokenInAddress = state.native ? NATIVE : state.token;
    const [route, priced] = await Promise.all([
      convert(a.chain, { kind: "buy", market }, {
        receiver: owner, tokenIn: tokenInAddress, amountIn, tokenOut: market.pt, slippageBps: a.slippage_bps, nativeValue: state.native,
      }).catch(async (error) => {
        if (!(error instanceof UserError) || !/cannot be swapped/i.test(error.message)) throw error;
        const names = await symbols(a.chain, market.inputTokens);
        throw new UserError(`Pendle cannot route ${state.symbol} into ${market.name} on ${a.chain}. `
          + `Accepted input tokens: ${market.inputTokens.map((t) => `${names.get(t)} (${t})`).join(", ") || "the market's underlying asset"}.`);
      }),
      prices(a.chain, [tokenInAddress, market.accounting, market.pt]).catch(() => new Map<Address, number>()),
    ]);
    const ptOut = Number(formatUnits(route.amountOut, pt.decimals));
    const inPrice = priced.get(tokenInAddress) ?? null;
    const maturityPrice = priced.get(market.accounting) ?? null;
    const amountUsd = inPrice === null ? null : Number(a.amount) * inPrice;
    const maturityUsd = maturityPrice === null ? null : ptOut * maturityPrice;
    return {
      owner, market, state, amountIn, days, route, ptOut: formatUnits(route.amountOut, pt.decimals),
      amountUsd, maturityUsd, gainUsd: amountUsd !== null && maturityUsd !== null ? maturityUsd - amountUsd : null,
    };
  }

  const depositInput = {
    chain, market: marketAddress, wallet_address: wallet,
    token_in: token.describe("Token to deposit: 'native' (ETH/HYPE/…) or an ERC-20 address on that chain."),
    amount: decimalAmount.describe("Human amount of token_in, e.g. '25' or '0.01'."),
  };

  server.registerTool("quote_fixed_yield", {
    title: "Quote a Pendle fixed-yield deposit",
    description: "Read-only quote for locking token_in into a Pendle market's fixed rate: PT received, effective fixed APY after price impact, "
      + "USD value now and at maturity (at today's underlying price), fees, and whether an approval or more balance is needed. Moves no funds.",
    inputSchema: z.object({ ...depositInput, slippage_bps: slippage }).strict(),
    outputSchema: z.object({
      chain, market: z.string(), name: z.string(), maturity: z.string(), days_to_maturity: z.number(),
      token_in: z.string(), token_in_symbol: z.string(), amount_in: z.string(), amount_in_usd: z.number().nullable(),
      pt_out: z.string(), fixed_apy_pct: z.number(), value_at_maturity_usd: z.number().nullable(), projected_gain_usd: z.number().nullable(),
      price_impact_pct: z.number().nullable(), fee_usd: z.number().nullable(), routed_via_aggregator: z.boolean(),
      needs_approval: z.boolean(), balance_sufficient: z.boolean(), risk_flags: riskFlagList,
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => guarded(async () => {
    const p = await planDeposit(args);
    const apy = p.route.effectiveApy ?? p.market.fixedApy;
    const out = {
      chain: args.chain, market: p.market.address, name: p.market.name, maturity: day(p.market.expiry),
      days_to_maturity: Math.floor(p.days), token_in: args.token_in, token_in_symbol: p.state.symbol, amount_in: args.amount, amount_in_usd: usd(p.amountUsd),
      pt_out: p.ptOut, fixed_apy_pct: pct(apy), value_at_maturity_usd: usd(p.maturityUsd), projected_gain_usd: usd(p.gainUsd),
      price_impact_pct: p.route.priceImpact === null ? null : round(p.route.priceImpact * 100, 3), fee_usd: p.route.feeUsd, routed_via_aggregator: p.route.usedAggregator,
      needs_approval: !p.state.native && p.state.allowance < p.amountIn, balance_sufficient: p.state.balance >= p.amountIn, risk_flags: riskFlags(p.market),
    };
    const notes = [
      out.projected_gain_usd !== null ? `≈ $${out.amount_in_usd} now → $${out.value_at_maturity_usd} at maturity (+$${out.projected_gain_usd}).` : null,
      out.balance_sufficient ? null : `Wallet holds only ${formatUnits(p.state.balance, p.state.decimals)} ${p.state.symbol}.`,
      out.needs_approval ? `An approval for ${args.amount} ${p.state.symbol} comes first.` : null,
      out.risk_flags.length ? `Risk flags: ${out.risk_flags.join(", ")}.` : null,
    ].filter(Boolean).join(" ");
    return {
      content: [{ type: "text" as const, text: `${args.amount} ${p.state.symbol} → ${p.ptOut} PT-${p.market.name}, `
        + `${out.fixed_apy_pct}% fixed until ${out.maturity}. Each PT redeems for one unit of the market's accounting asset at maturity. ${notes}`.trim() }],
      structuredContent: out,
    };
  }));

  server.registerTool("propose_fixed_yield_deposit", {
    title: "Propose locking a Pendle fixed yield",
    description: "Builds an unsigned PayBox transaction that buys a Pendle Principal Token, locking the fixed rate until maturity. "
      + "If the router needs an ERC-20 approval first, returns that exact-amount approval instead (step 1 of 2); after it confirms, call this tool again. "
      + "Verifies the Pendle route calls the official router to buy this market's PT for wallet_address. PayBox simulates, asks the user to approve, then signs.",
    inputSchema: z.object({ ...depositInput, slippage_bps: slippage, max_price_impact_bps: maxImpact }).strict(),
    outputSchema: evmOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => guarded(async () => {
    const p = await planDeposit(args);
    const sym = p.state.symbol;
    if (p.state.balance < p.amountIn) {
      throw new UserError(`Wallet holds ${formatUnits(p.state.balance, p.state.decimals)} ${sym}, less than ${args.amount}.`);
    }
    if (!p.state.native && p.state.allowance < p.amountIn) {
      return proposeApproval(args.chain, p.state.token, p.amountIn, p.state.allowance,
        `approve the Pendle router to spend exactly ${args.amount} ${sym}.`, "propose_fixed_yield_deposit");
    }
    checkImpact(p.route.priceImpact, args.max_price_impact_bps);
    const apy = pct(p.route.effectiveApy ?? p.market.fixedApy);
    return withSummary(
      proposeEvm({ chain: chainId(args.chain), to: p.route.tx.to, value: p.route.tx.value, data: p.route.tx.data }),
      `Lock ${args.amount} ${sym} into PT-${p.market.name} on ${args.chain}: ~${p.ptOut} PT at ${apy}% fixed, `
        + `redeemable on ${day(p.market.expiry)}${p.maturityUsd !== null ? ` (≈ $${round(p.maturityUsd)})` : ""}. Max slippage ${args.slippage_bps / 100}%.`,
    );
  }));

  const positionRow = z.object({
    chain, market: z.string(), name: z.string(), pt: z.string(), pt_balance: z.string(), value_usd: z.number().nullable(),
    maturity: z.string(), matured: z.boolean(), days_to_maturity: z.number(), current_fixed_apy_pct: z.number().nullable(),
    rollover_to: z.object({ market: z.string(), name: z.string(), fixed_apy_pct: z.number(), maturity: z.string() }).strict().nullable(),
  }).strict();

  server.registerTool("get_fixed_yield_positions", {
    title: "Show Pendle fixed-yield positions",
    description: "Lists the Pendle Principal Tokens a wallet holds with USD value and maturity, across every supported chain. "
      + "Balances are read on-chain; matured or maturing positions include a suggested roll-over market for propose_fixed_yield_rollover.",
    inputSchema: z.object({ wallet_address: wallet, chain: chainFilter }).strict(),
    outputSchema: z.object({ positions: z.array(positionRow), total_value_usd: z.number().nullable(), chains_unavailable: z.array(z.string()) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => guarded(async () => {
    const owner = getAddress(args.wallet_address);
    const wanted = (c: ChainKey) => args.chain === "all" || c === args.chain;
    const [active, indexed] = await Promise.all([activeMarkets(), indexedMarkets(owner).catch(() => [])]);
    const known = new Set(active.map((m) => `${m.chain}:${m.address}`));
    const missing = indexed.filter((p) => wanted(p.chain) && !known.has(`${p.chain}:${p.market}`));
    const older = missing.length ? await marketsById(missing.map((p) => ({ chain: p.chain, address: p.market }))).catch(() => []) : [];
    const candidates = [...active, ...older].filter((m) => wanted(m.chain));
    const chains = [...new Set(candidates.map((m) => m.chain))];
    const scans = await Promise.allSettled(chains.map((c) => ptBalances(c, candidates.filter((m) => m.chain === c), owner)));
    const unavailable = chains.filter((_, i) => scans[i]?.status === "rejected");
    const held = scans.flatMap((s) => (s.status === "fulfilled" ? s.value : [])).filter((h) => h.balance > 0n);
    // Prices are a nice-to-have; skip them rather than blow the sandbox's 10s budget.
    const priceMaps = elapsed() < 6_000
      ? await Promise.all([...new Set(held.map((h) => h.market.chain))].map(async (c) =>
        [c, await prices(c, held.filter((h) => h.market.chain === c).map((h) => h.market.pt)).catch(() => new Map<Address, number>())] as const))
      : [];
    const priceOf = new Map(priceMaps);
    const positions = held.map(({ market: m, balance, decimals }) => {
      const amount = Number(formatUnits(balance, decimals));
      const price = priceOf.get(m.chain)?.get(m.pt);
      const days = daysLeft(m.expiry);
      const target = !m.active || days < 14 ? rolloverTarget(m, active) : undefined;
      return {
        chain: m.chain, market: m.address, name: m.name, pt: m.pt, pt_balance: formatUnits(balance, decimals),
        value_usd: price === undefined ? null : round(amount * price), maturity: day(m.expiry), matured: !m.active, days_to_maturity: Math.floor(days),
        current_fixed_apy_pct: m.active ? pct(m.fixedApy) : null,
        rollover_to: target ? { market: target.address, name: target.name, fixed_apy_pct: pct(target.fixedApy), maturity: day(target.expiry) } : null,
      };
    });
    const valued = positions.filter((p) => p.value_usd !== null);
    const total = positions.length && valued.length === positions.length ? round(valued.reduce((s, p) => s + p.value_usd!, 0)) : null;
    const lines = positions.map((p) => `${p.pt_balance} PT-${p.name} on ${p.chain}${p.value_usd !== null ? ` ($${p.value_usd})` : ""} — `
      + `${p.matured ? `matured ${p.maturity}, redeemable now` : `matures ${p.maturity} (${p.days_to_maturity}d)`}`
      + `${p.rollover_to ? `; can roll into ${p.rollover_to.name} at ${p.rollover_to.fixed_apy_pct}% until ${p.rollover_to.maturity}` : ""}`);
    return {
      content: [{ type: "text" as const, text: positions.length ? lines.join("\n") : "No Pendle PT positions found for this wallet." }],
      structuredContent: { positions, total_value_usd: total, chains_unavailable: unavailable },
    };
  }));

  /** Shared by exit and roll-over: PT balance, requested amount and approval state for one market. */
  async function ptPosition(c: ChainKey, market: Market, owner: Address, amount: string) {
    const pt = await tokenState(c, market.pt, owner);
    const amountIn = amount === "max" ? pt.balance : parseAmount(amount, pt.decimals);
    if (amountIn === 0n) throw new UserError(`Wallet holds no PT-${market.name} on ${c}.`);
    if (amountIn > pt.balance) throw new UserError(`Wallet holds only ${formatUnits(pt.balance, pt.decimals)} PT-${market.name}.`);
    return { pt, amountIn, shown: formatUnits(amountIn, pt.decimals) };
  }
  const ptAmount = z.union([z.literal("max"), decimalAmount]).default("max").describe("PT amount, or 'max'.");

  server.registerTool("propose_fixed_yield_exit", {
    title: "Propose exiting a Pendle fixed yield",
    description: "Builds an unsigned PayBox transaction that turns a Pendle PT back into token_out: redeems it for its accounting asset after maturity, "
      + "or sells it at the market price before maturity (the fixed rate is only guaranteed if held to maturity). "
      + "Returns an exact-amount PT approval first if needed (step 1 of 2).",
    inputSchema: z.object({
      chain, market: marketAddress, wallet_address: wallet, amount: ptAmount,
      token_out: token.describe("Token to receive: 'native' or an ERC-20 address, e.g. USDC."),
      slippage_bps: slippage, max_price_impact_bps: maxImpact,
    }).strict(),
    outputSchema: evmOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => guarded(async () => {
    const owner = getAddress(args.wallet_address);
    const market = await findMarket(args.chain, args.market);
    const { pt, amountIn, shown } = await ptPosition(args.chain, market, owner, args.amount);
    if (pt.allowance < amountIn) {
      return proposeApproval(args.chain, market.pt, amountIn, pt.allowance,
        `approve the Pendle router to spend exactly ${shown} PT-${market.name}.`, "propose_fixed_yield_exit");
    }
    const tokenOut = args.token_out === "native" ? NATIVE : getAddress(args.token_out);
    const [route, outSymbol] = await Promise.all([
      convert(args.chain, { kind: "exit", market }, {
        receiver: owner, tokenIn: market.pt, amountIn, tokenOut, slippageBps: args.slippage_bps, nativeValue: false,
      }),
      args.token_out === "native" ? Promise.resolve(CHAINS[args.chain].native) : symbols(args.chain, [tokenOut]).then((s) => s.get(tokenOut)!),
    ]);
    if (market.active) checkImpact(route.priceImpact, args.max_price_impact_bps);
    return withSummary(
      proposeEvm({ chain: chainId(args.chain), to: route.tx.to, value: route.tx.value, data: route.tx.data }),
      !market.active
        ? `Redeem ${shown} matured PT-${market.name} into ${outSymbol} on ${args.chain}.`
        : `Sell ${shown} PT-${market.name} before maturity (${day(market.expiry)}) into ${outSymbol} at market price. Holding to maturity would keep the fixed rate.`,
    );
  }));

  server.registerTool("propose_fixed_yield_rollover", {
    title: "Propose rolling a Pendle PT into a new maturity",
    description: "Builds one unsigned PayBox transaction that moves a PT position into a later-maturing PT of the same asset, re-locking a fixed rate "
      + "without cashing out (Pendle Router callAndReflect via Pendle's Reflector). Works for matured PTs (redeemed) and active ones (sold at market). "
      + "If to_market is omitted, picks the highest fixed rate on the same asset maturing at least 14 days out. Returns an exact-amount PT approval first if needed.",
    inputSchema: z.object({
      chain, from_market: marketAddress, to_market: evmAddress.optional().describe("Destination market; omit to auto-select."),
      wallet_address: wallet, amount: ptAmount, slippage_bps: slippage, max_price_impact_bps: maxImpact,
    }).strict(),
    outputSchema: evmOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => guarded(async () => {
    const owner = getAddress(args.wallet_address);
    const [from, active] = await Promise.all([findMarket(args.chain, args.from_market), activeMarkets()]);
    const to = args.to_market
      ? active.find((m) => m.chain === args.chain && m.address === getAddress(args.to_market!))
      : rolloverTarget(from, active);
    if (!to) {
      throw new UserError(args.to_market
        ? `${getAddress(args.to_market)} is not an active Pendle market on ${args.chain}.`
        : `No active ${from.name} market on ${args.chain} maturing after ${day(from.expiry)} with enough liquidity to roll into.`);
    }
    if (to.address === from.address) throw new UserError("Destination market must differ from the source market.");
    if (to.sy !== from.sy) throw new UserError(`${to.name} uses a different underlying (SY) than ${from.name}; roll-over needs the same asset. Exit and deposit instead.`);
    if (daysLeft(to.expiry) < 1) throw new UserError(`${to.name} matures in under a day; pick a later maturity.`);
    const { pt, amountIn, shown } = await ptPosition(args.chain, from, owner, args.amount);
    if (pt.allowance < amountIn) {
      return proposeApproval(args.chain, from.pt, amountIn, pt.allowance,
        `approve the Pendle router to spend exactly ${shown} PT-${from.name}.`, "propose_fixed_yield_rollover");
    }
    const route = await convert(args.chain, { kind: "rollover", from, to }, {
      receiver: owner, tokenIn: from.pt, amountIn, tokenOut: to.pt, slippageBps: args.slippage_bps, nativeValue: false,
    });
    checkImpact(route.priceImpact, args.max_price_impact_bps);
    const newPt = formatUnits(route.amountOut, pt.decimals);
    return withSummary(
      proposeEvm({ chain: chainId(args.chain), to: route.tx.to, value: route.tx.value, data: route.tx.data }),
      `Roll ${shown} PT-${from.name} (${from.active ? `matures ${day(from.expiry)}, sold at market` : `matured ${day(from.expiry)}`}) into ~${newPt} PT-${to.name} `
        + `at ${pct(route.effectiveApy ?? to.fixedApy)}% fixed until ${day(to.expiry)}, in one transaction. Max slippage ${args.slippage_bps / 100}%.`,
    );
  }));

  return server;
}

serveStdio(createServer, { legacy: "reject" });

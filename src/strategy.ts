import type { AppState, DCAEntry, SellOrder, FilledSell } from './types';

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const USDC_DECIMALS = 1_000_000; // 1 USDC = 1_000_000 micro-USDC

// Jupiter mints (mainnet)
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Sell levels: % above average cost → % of position to sell
export const SELL_LEVELS = [
  { pct: 10, share: 0.25 },
  { pct: 20, share: 0.25 },
  { pct: 40, share: 0.25 },
  { pct: 60, share: 1.0 },  // "ce qu'il reste"
] as const;

/**
 * Calculates the daily DCA amount in USD based on 30-day price change.
 * Returns 0 if DCA should be paused.
 */
export function calcDCAAmountUSD(change30dPct: number, baseAmountUSD: number): number {
  if (change30dPct > 20) return 0;          // hausse > 20% → stop
  if (change30dPct <= -20) return 20;       // baisse ≥ 20% → 20$
  if (change30dPct <= -15) return 15;       // baisse ≥ 15% → 15$
  return baseAmountUSD;                      // -15% < Δ ≤ +20% → base (10$)
}

/**
 * Weighted-average DCA cost (USDC/SOL) derived from the actual buy history.
 * This is the single source of truth for sell thresholds: unlike the stored
 * averageBuyPriceUSD it can never be corrupted by manual actions, and selling
 * never changes per-unit cost, so it stays correct after fills too.
 */
export function averageCostFromHistory(history: DCAEntry[]): number {
  let solLamports = 0;
  let usdcMicro = 0;
  for (const h of history) {
    solLamports += h.solBoughtLamports;
    usdcMicro += h.amountUSD * USDC_DECIMALS;
  }
  if (solLamports <= 0) return 0;
  return (usdcMicro / USDC_DECIMALS) / (solLamports / LAMPORTS_PER_SOL);
}

/**
 * Average cost (USDC/SOL) of the SOL STILL HELD, using proper average-cost
 * accounting: buys blend the average; a sell removes units at the current
 * average (leaving per-unit cost unchanged) so later buys blend against the
 * remaining quantity. Correct after partial sells — unlike averaging all buys.
 * Falls back to a buys-only average when there are no recorded sells.
 */
export function computeAvgCost(
  history: DCAEntry[],
  sells: FilledSell[] = [],
): number {
  type Ev = { t: number; sol: number; usdc: number; buy: boolean };
  const evs: Ev[] = [];
  for (const b of history) {
    evs.push({
      t: Date.parse(b.date) || 0,
      sol: b.solBoughtLamports || 0,
      usdc: Math.round((b.amountUSD || 0) * USDC_DECIMALS),
      buy: true,
    });
  }
  for (const s of sells) {
    evs.push({ t: s.filledAt || 0, sol: s.solLamports || 0, usdc: 0, buy: false });
  }
  evs.sort((a, b) => a.t - b.t);

  let heldLamports = 0;
  let basisMicro = 0;
  for (const e of evs) {
    if (e.buy) {
      basisMicro += e.usdc;
      heldLamports += e.sol;
    } else {
      if (heldLamports <= 0) continue;
      const perLamport = basisMicro / heldLamports;
      const sold = Math.min(e.sol, heldLamports);
      basisMicro -= sold * perLamport;
      heldLamports -= sold;
    }
  }
  if (heldLamports <= 0) return 0;
  return (basisMicro / USDC_DECIMALS) / (heldLamports / LAMPORTS_PER_SOL);
}

/**
 * Recalculates the average buy price after a new purchase.
 */
export function updateAverageCost(
  state: AppState,
  solBoughtLamports: number,
  usdcSpentMicro: number,
): Pick<AppState, 'totalSOLBoughtLamports' | 'totalUSDCSpentMicro' | 'averageBuyPriceUSD'> {
  const totalSOL = state.totalSOLBoughtLamports + solBoughtLamports;
  const totalUSDC = state.totalUSDCSpentMicro + usdcSpentMicro;
  const totalSOLUnits = totalSOL / LAMPORTS_PER_SOL;
  const totalUSDCUnits = totalUSDC / USDC_DECIMALS;
  const averageBuyPriceUSD = totalSOLUnits > 0 ? totalUSDCUnits / totalSOLUnits : 0;
  return {
    totalSOLBoughtLamports: totalSOL,
    totalUSDCSpentMicro: totalUSDC,
    averageBuyPriceUSD,
  };
}

/**
 * Builds the 4 sell orders from current position and average cost.
 * Returns order specs (to be submitted to Jupiter Limit Order).
 */
export function buildSellOrderSpecs(
  totalPositionLamports: number,
  averageBuyPriceUSD: number,
): Array<{ solLamports: number; targetPriceUSD: number; targetPct: number }> {
  if (totalPositionLamports <= 0 || averageBuyPriceUSD <= 0) return [];

  let remaining = totalPositionLamports;
  const orders: Array<{ solLamports: number; targetPriceUSD: number; targetPct: number }> = [];

  for (let i = 0; i < SELL_LEVELS.length; i++) {
    const level = SELL_LEVELS[i];
    const isLast = i === SELL_LEVELS.length - 1;
    const solLamports = isLast
      ? remaining
      : Math.floor(totalPositionLamports * level.share);

    if (solLamports <= 0) continue;

    const targetPriceUSD = averageBuyPriceUSD * (1 + level.pct / 100);
    orders.push({ solLamports, targetPriceUSD, targetPct: level.pct });
    if (!isLast) remaining -= solLamports;
  }

  return orders;
}

/**
 * Adaptive sell-order builder that respects Jupiter's per-order minimum
 * (~5 USD). Splits the position across as many of the 4 target levels as the
 * size allows, each order ≥ minUsdPerOrder. Falls back to fewer, larger orders
 * for small positions; returns [] if the position is too small for even one.
 *
 * refPriceUSD = the price the targets are computed from (average cost, or the
 * current market price for a manual "protect position" action).
 */
export function buildAdaptiveSellOrderSpecs(
  totalPositionLamports: number,
  refPriceUSD: number,
  minUsdPerOrder = 5.5,
): Array<{ solLamports: number; targetPriceUSD: number; targetPct: number }> {
  if (totalPositionLamports <= 0 || refPriceUSD <= 0) return [];

  const levels = SELL_LEVELS.map(l => l.pct); // [10, 20, 40, 60]
  const solTotal = totalPositionLamports / LAMPORTS_PER_SOL;
  const lowestTargetPrice = refPriceUSD * (1 + levels[0] / 100);

  // Max number of equal chunks whose smallest-target value still clears the min.
  let n = 0;
  for (let candidate = levels.length; candidate >= 1; candidate--) {
    if ((solTotal / candidate) * lowestTargetPrice >= minUsdPerOrder) {
      n = candidate;
      break;
    }
  }
  if (n === 0) return []; // position too small for a single valid order

  const orders: Array<{ solLamports: number; targetPriceUSD: number; targetPct: number }> = [];
  let remaining = totalPositionLamports;
  const chunk = Math.floor(totalPositionLamports / n);
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const solLamports = isLast ? remaining : chunk;
    if (solLamports <= 0) continue;
    const pct = levels[i];
    orders.push({ solLamports, targetPriceUSD: refPriceUSD * (1 + pct / 100), targetPct: pct });
    if (!isLast) remaining -= solLamports;
  }
  return orders;
}

/**
 * Adds a completed DCA entry and records it in history.
 */
export function recordDCAEntry(
  state: AppState,
  entry: Omit<DCAEntry, never>,
): DCAEntry[] {
  return [...state.dcaHistory, entry].slice(-365); // keep 1 year max
}

/**
 * Replaces active sell orders with newly computed ones (after a buy).
 */
export function replaceSellOrders(
  existingOrders: SellOrder[],
  newOrders: Array<{ solLamports: number; targetPriceUSD: number; targetPct: number }>,
  submittedAccounts: string[],
): SellOrder[] {
  // Mark old active orders as cancelled
  const cancelled = existingOrders.map(o =>
    o.status === 'active' ? { ...o, status: 'cancelled' as const } : o,
  );

  const fresh: SellOrder[] = newOrders.map((spec, i) => ({
    accountPubkey: submittedAccounts[i] ?? '',
    solLamports: spec.solLamports,
    targetPriceUSD: spec.targetPriceUSD,
    targetPct: spec.targetPct,
    status: 'active' as const,
  }));

  return [...cancelled, ...fresh];
}

import type { AppState, DCAEntry, SellOrder } from './types';

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

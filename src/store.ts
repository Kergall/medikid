import type { AppState } from './types';
import { computeAvgCost } from './strategy';

const STORAGE_KEY = 'sol_dca_bot_v1';
const USDC_DECIMALS = 1_000_000;

// Rebuild the cost basis from the immutable buy history + recorded sells
// (single source of truth). Manual actions and past bugs corrupted the stored
// totals; buys/sells are the real record, so we always trust them.
function healCostBasisFromHistory(s: AppState): void {
  if (!Array.isArray(s.dcaHistory) || s.dcaHistory.length === 0) return;
  let solLamports = 0;
  let usdcMicro = 0;
  for (const h of s.dcaHistory) {
    solLamports += h.solBoughtLamports || 0;
    usdcMicro += Math.round((h.amountUSD || 0) * USDC_DECIMALS);
  }
  if (solLamports <= 0) return;
  s.totalSOLBoughtLamports = solLamports;
  s.totalUSDCSpentMicro = usdcMicro;
  // Average cost of the SOL still held (accounts for executed sells).
  s.averageBuyPriceUSD = computeAvgCost(s.dcaHistory, s.sells || []);
}

const DEFAULT_STATE: AppState = {
  totalSOLBoughtLamports: 0,
  totalUSDCSpentMicro: 0,
  averageBuyPriceUSD: 0,
  lastDCADate: null,
  dcaEnabled: true,
  dcaHistory: [],
  pendingDCA: null,
  sellOrders: [],
  lastOrdersPlacedAt: 0,
  sells: [],
  baseAmountUSD: 10,
  rpcEndpoint: '', // empty = use the proxy's built-in public RPC pool
  walletMode: 'none',
  autoExecute: false,
};

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const saved = JSON.parse(raw);
    // Migrate off dead/keyless-blocked public RPCs to the proxy pool ('')
    if (
      saved.rpcEndpoint === 'https://api.mainnet-beta.solana.com' ||
      saved.rpcEndpoint === 'https://rpc.ankr.com/solana'
    ) {
      saved.rpcEndpoint = '';
    }
    const merged = { ...DEFAULT_STATE, ...saved };
    healCostBasisFromHistory(merged);
    return merged;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState(): AppState {
  const fresh = { ...DEFAULT_STATE };
  saveState(fresh);
  return fresh;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isDCADoneToday(state: AppState): boolean {
  return state.lastDCADate === todayISO();
}

import type { AppState } from './types';

const STORAGE_KEY = 'sol_dca_bot_v1';

const DEFAULT_STATE: AppState = {
  totalSOLBoughtLamports: 0,
  totalUSDCSpentMicro: 0,
  averageBuyPriceUSD: 0,
  lastDCADate: null,
  dcaEnabled: true,
  dcaHistory: [],
  sellOrders: [],
  baseAmountUSD: 10,
  rpcEndpoint: 'https://api.mainnet-beta.solana.com',
  walletMode: 'none',
  autoExecute: false,
};

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
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

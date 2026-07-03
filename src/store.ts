import type { AppState } from './types';

const STORAGE_KEY = 'sol_dca_bot_v1';

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
  trailingEnabled: true,
  trailingStop: null,
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
    return { ...DEFAULT_STATE, ...saved };
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

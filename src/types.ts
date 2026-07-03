export interface DCAEntry {
  date: string;
  amountUSD: number;
  solPriceUSD: number;
  solBoughtLamports: number;
  txSignature: string;
}

export interface SellOrder {
  accountPubkey: string;
  solLamports: number;
  targetPriceUSD: number;
  targetPct: number;
  status: 'active' | 'filled' | 'cancelled';
}

export type WalletMode = 'none' | 'phantom' | 'local';

// A swap that was sent on-chain but whose confirmation failed or timed out.
// Kept until its real outcome is known, so a retry can never double-buy.
export interface PendingDCA {
  date: string;
  signature: string;
  amountUSD: number;
  solLamports: number;
  priceUSD: number;
  sentAt: number; // epoch ms
}

// App-side trailing stop replacing the +60% tranche. All thresholds are
// relative to refPriceUSD (the average DCA price at initialisation):
// arms once peak ≥ ref×1.40, then stop = peak − ref×0.20 (floor ref×1.20).
// Only runs while the app is open — Jupiter has no on-chain stop orders.
export interface TrailingStop {
  solLamports: number;
  refPriceUSD: number;
  peakPriceUSD: number;
  locked: boolean;    // armed once → daily DCA no longer re-initialises it
  createdAt: number;
}

export interface AppState {
  // Position
  totalSOLBoughtLamports: number;
  totalUSDCSpentMicro: number;
  averageBuyPriceUSD: number;

  // DCA
  lastDCADate: string | null;
  dcaEnabled: boolean;
  dcaHistory: DCAEntry[];
  pendingDCA: PendingDCA | null;

  // Sell orders
  sellOrders: SellOrder[];
  lastOrdersPlacedAt: number; // epoch ms — guards on-chain sync against API lag
  trailingEnabled: boolean;
  trailingStop: TrailingStop | null;

  // Settings
  baseAmountUSD: number;
  rpcEndpoint: string;

  // Wallet
  walletMode: WalletMode;
  autoExecute: boolean;  // true = sign without PIN on open
}

export interface SolanaProvider {
  isPhantom?: boolean;
  publicKey: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
  }
}

export interface DCAEntry {
  date: string;           // YYYY-MM-DD
  amountUSD: number;
  solPriceUSD: number;
  solBoughtLamports: number;
  txSignature: string;
}

export interface SellOrder {
  accountPubkey: string;
  solLamports: number;
  targetPriceUSD: number;
  targetPct: number;      // 10 | 20 | 40 | 60
  status: 'active' | 'filled' | 'cancelled';
}

export interface AppState {
  // Position
  totalSOLBoughtLamports: number;
  totalUSDCSpentMicro: number;   // USDC * 1e6
  averageBuyPriceUSD: number;

  // DCA
  lastDCADate: string | null;    // YYYY-MM-DD
  dcaEnabled: boolean;
  dcaHistory: DCAEntry[];

  // Sell orders
  sellOrders: SellOrder[];

  // Settings
  baseAmountUSD: number;         // default 10
  rpcEndpoint: string;
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

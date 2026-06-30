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

export interface AppState {
  // Position
  totalSOLBoughtLamports: number;
  totalUSDCSpentMicro: number;
  averageBuyPriceUSD: number;

  // DCA
  lastDCADate: string | null;
  dcaEnabled: boolean;
  dcaHistory: DCAEntry[];

  // Sell orders
  sellOrders: SellOrder[];

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

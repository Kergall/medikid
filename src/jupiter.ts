import { VersionedTransaction } from '@solana/web3.js';
import { SOL_MINT, USDC_MINT, USDC_DECIMALS, LAMPORTS_PER_SOL } from './strategy';

// Use same-origin proxy routes to avoid CORS issues on mobile networks
const QUOTE_API = '/api';

// ─── Swap (DCA buy: USDC → SOL) ───────────────────────────────────────────────

export interface SwapQuote {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
  outAmountLamports: number;
  priceUSD: number;
}

export async function getSwapQuote(
  amountUSD: number,
  slippageBps = 50,
): Promise<SwapQuote> {
  const inAmount = Math.floor(amountUSD * USDC_DECIMALS);
  const url = new URL(`${QUOTE_API}/quote`, location.href);
  url.searchParams.set('inputMint', USDC_MINT);
  url.searchParams.set('outputMint', SOL_MINT);
  url.searchParams.set('amount', String(inAmount));
  url.searchParams.set('slippageBps', String(slippageBps));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Quote API error: ${res.status}`);
  const raw = await res.json();

  const outAmountLamports = Number(raw.outAmount);
  const solAmount = outAmountLamports / LAMPORTS_PER_SOL;
  const priceUSD = amountUSD / solAmount;

  return { raw, outAmountLamports, priceUSD };
}

export async function buildSwapTransaction(
  quote: SwapQuote,
  walletPubkey: string,
  priorityFeeLamports = 5000,
): Promise<VersionedTransaction> {
  const res = await fetch(`/api/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: priorityFeeLamports,
    }),
  });
  if (!res.ok) throw new Error(`Swap API error: ${res.status}`);
  const { swapTransaction } = await res.json() as { swapTransaction: string };
  return VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, 'base64'),
  );
}

// ─── Limit Order (sell SOL → USDC) ────────────────────────────────────────────

export interface LimitOrderSpec {
  solLamports: number;
  targetPriceUSD: number;
}

export interface PlacedLimitOrder {
  orderAccount: string;
  txSignature: string;
}

export async function buildLimitOrderTransaction(
  spec: LimitOrderSpec,
  walletPubkey: string,
): Promise<{ tx: VersionedTransaction; orderAccount: string }> {
  const inAmount = String(spec.solLamports);
  const outAmountUSDC = Math.floor(
    (spec.solLamports / LAMPORTS_PER_SOL) * spec.targetPriceUSD * USDC_DECIMALS,
  );

  const res = await fetch(`/api/limit-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: walletPubkey,
      inAmount,
      outAmount: String(outAmountUSDC),
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      expiredAt: null,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Limit Order API error ${res.status}: ${text}`);
  }

  const data = await res.json() as { tx: string; orderAccount: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(data.tx, 'base64'));
  return { tx, orderAccount: data.orderAccount };
}

export async function buildCancelOrdersTransaction(
  orderAccounts: string[],
  walletPubkey: string,
): Promise<VersionedTransaction | null> {
  if (orderAccounts.length === 0) return null;

  const res = await fetch(`/api/cancel-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: walletPubkey, orders: orderAccounts }),
  });

  if (!res.ok) return null; // non-blocking: old orders may already be filled

  const data = await res.json() as { tx: string };
  return VersionedTransaction.deserialize(Buffer.from(data.tx, 'base64'));
}

export async function fetchOpenOrders(
  walletPubkey: string,
): Promise<Array<{ publicKey: string; account: { inputMint: string } }>> {
  const res = await fetch(`/api/open-orders?wallet=${walletPubkey}`);
  if (!res.ok) return [];
  return res.json();
}

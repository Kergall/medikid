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
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Quote API ${res.status} — ${detail.slice(0, 200)}`);
  }
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
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Swap API ${res.status} — ${detail.slice(0, 200)}`);
  }
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

// Jupiter Trigger API: sell `makingAmount` SOL for `takingAmount` USDC.
// The order fills on-chain once the market reaches the implied price.
export async function buildLimitOrderTransaction(
  spec: LimitOrderSpec,
  walletPubkey: string,
): Promise<{ tx: VersionedTransaction; orderAccount: string }> {
  const makingAmount = String(spec.solLamports); // SOL sold (lamports)
  const takingAmount = String(Math.floor(
    (spec.solLamports / LAMPORTS_PER_SOL) * spec.targetPriceUSD * USDC_DECIMALS,
  )); // USDC received (micro)

  const res = await fetch(`/api/limit-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      maker: walletPubkey,
      payer: walletPubkey,
      params: { makingAmount, takingAmount },
      computeUnitPrice: 'auto',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Trigger API ${res.status} — ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { transaction: string; order: string };
  const tx = VersionedTransaction.deserialize(
    Buffer.from(data.transaction, 'base64'),
  );
  return { tx, orderAccount: data.order };
}

// Cancels each active Trigger order (one tx per order).
export async function buildCancelOrdersTransaction(
  orderAccounts: string[],
  walletPubkey: string,
): Promise<VersionedTransaction[]> {
  const txs: VersionedTransaction[] = [];
  for (const order of orderAccounts) {
    if (!order) continue;
    try {
      const res = await fetch(`/api/cancel-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maker: walletPubkey,
          order,
          computeUnitPrice: 'auto',
        }),
      });
      if (!res.ok) continue; // non-blocking: order may already be filled/gone
      const data = await res.json() as { transaction: string };
      txs.push(VersionedTransaction.deserialize(
        Buffer.from(data.transaction, 'base64'),
      ));
    } catch { /* skip this order */ }
  }
  return txs;
}

export async function fetchOpenOrders(
  walletPubkey: string,
): Promise<Array<{ orderKey: string; inputMint: string }>> {
  const res = await fetch(`/api/open-orders?wallet=${walletPubkey}`);
  if (!res.ok) return [];
  const data = await res.json() as { orders?: Array<{ orderKey: string; inputMint: string }> };
  return data.orders ?? [];
}

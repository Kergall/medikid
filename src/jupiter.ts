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

// Market-sell quote (SOL → USDC), used by the app-side trailing stop.
// outAmountLamports carries the USDC micro amount received.
export async function getSellQuote(
  solLamports: number,
  slippageBps = 100,
): Promise<SwapQuote> {
  const url = new URL(`${QUOTE_API}/quote`, location.href);
  url.searchParams.set('inputMint', SOL_MINT);
  url.searchParams.set('outputMint', USDC_MINT);
  url.searchParams.set('amount', String(Math.floor(solLamports)));
  url.searchParams.set('slippageBps', String(slippageBps));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Quote API ${res.status} — ${detail.slice(0, 200)}`);
  }
  const raw = await res.json();
  const outUsdcMicro = Number(raw.outAmount);
  const priceUSD = (outUsdcMicro / USDC_DECIMALS) / (solLamports / LAMPORTS_PER_SOL);
  return { raw, outAmountLamports: outUsdcMicro, priceUSD };
}

export async function buildSwapTransaction(
  quote: SwapQuote,
  walletPubkey: string,
): Promise<VersionedTransaction> {
  const res = await fetch(`/api/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
      // Let Jupiter size compute units and pay a high-but-capped priority fee
      // so the tx lands reliably through public RPCs.
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: 'high',
          maxLamports: 1_000_000,
        },
      },
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

// A Jupiter Trigger transaction to be signed then submitted via /execute.
export interface TriggerTx {
  tx: VersionedTransaction;
  requestId: string;   // required by the /execute endpoint
  order?: string;      // order account (createOrder only)
}

// Jupiter Trigger API: sell `makingAmount` SOL for `takingAmount` USDC.
// The order fills on-chain once the market reaches the implied price.
//
// HARD SAFETY INVARIANT: a sell order is NEVER created unless its target
// price is safely ABOVE the current market price. A target at/below market
// would be filled instantly at a loss. The current market price is required —
// if it's unknown, we refuse to create the order.
//
// NOTE: the returned tx must be signed and submitted through executeTrigger()
// (Jupiter's /execute endpoint), NOT sent to a raw RPC.
export async function createSellOrder(
  spec: LimitOrderSpec,
  walletPubkey: string,
  currentMarketPriceUSD: number,
): Promise<TriggerTx> {
  if (!(currentMarketPriceUSD > 0)) {
    throw new Error('Prix du marché inconnu — ordre de vente refusé (sécurité).');
  }
  if (spec.targetPriceUSD <= currentMarketPriceUSD * 1.005) {
    throw new Error(
      `Cible ${spec.targetPriceUSD.toFixed(2)} ≤ marché ${currentMarketPriceUSD.toFixed(2)} ` +
      `— ordre refusé (anti-vente à perte).`,
    );
  }

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
    throw new Error(`Trigger createOrder ${res.status} — ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { transaction: string; requestId: string; order: string };
  if (!data.transaction || !data.requestId) {
    throw new Error(`Réponse createOrder inattendue : ${JSON.stringify(data).slice(0, 200)}`);
  }
  const tx = VersionedTransaction.deserialize(
    Buffer.from(data.transaction, 'base64'),
  );
  return { tx, requestId: data.requestId, order: data.order };
}

// Builds a cancel transaction (to be signed + executed) for each order.
export async function createCancelOrders(
  orderAccounts: string[],
  walletPubkey: string,
): Promise<TriggerTx[]> {
  const out: TriggerTx[] = [];
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
      const data = await res.json() as { transaction: string; requestId: string };
      if (!data.transaction || !data.requestId) continue;
      out.push({
        tx: VersionedTransaction.deserialize(Buffer.from(data.transaction, 'base64')),
        requestId: data.requestId,
      });
    } catch { /* skip this order */ }
  }
  return out;
}

export interface OpenOrder {
  orderKey: string;
  inputMint: string;
  makingLamports: number; // remaining SOL locked in the order (if input = SOL)
}

// Throws on API failure — an empty result must mean "no open orders",
// never "the request failed" (callers may treat missing orders as filled).
export async function fetchOpenOrders(walletPubkey: string): Promise<OpenOrder[]> {
  const res = await fetch(`/api/open-orders?wallet=${walletPubkey}`);
  if (!res.ok) throw new Error(`openOrders ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as { orders?: any[] };
  const orders = data.orders ?? [];
  return orders
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((o: any) => ({
      orderKey: o.orderKey ?? o.publicKey ?? o.order ?? '',
      inputMint: o.inputMint ?? o.account?.inputMint ?? '',
      makingLamports: Number(
        o.remainingMakingAmount ?? o.makingAmount ?? o.account?.makingAmount ?? 0,
      ),
    }))
    .filter((o: OpenOrder) => o.orderKey);
}

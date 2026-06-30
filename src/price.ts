export interface PriceData {
  currentUSD: number;
  price30dAgoUSD: number;
  change30dPct: number;     // e.g. -12.5 or +8.3
}

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export async function fetchPriceData(): Promise<PriceData> {
  // Fetch current price + 30-day history in parallel
  const [currentRes, historyRes] = await Promise.all([
    fetch(`${COINGECKO_BASE}/simple/price?ids=solana&vs_currencies=usd`),
    fetch(`${COINGECKO_BASE}/coins/solana/market_chart?vs_currency=usd&days=30&interval=daily`),
  ]);

  if (!currentRes.ok || !historyRes.ok) {
    throw new Error('Impossible de récupérer les prix (CoinGecko)');
  }

  const currentData = await currentRes.json() as { solana: { usd: number } };
  const historyData = await historyRes.json() as { prices: [number, number][] };

  const currentUSD = currentData.solana.usd;
  const prices = historyData.prices;

  // First data point is ~30 days ago
  const price30dAgoUSD = prices[0][1];
  const change30dPct = ((currentUSD - price30dAgoUSD) / price30dAgoUSD) * 100;

  return { currentUSD, price30dAgoUSD, change30dPct };
}

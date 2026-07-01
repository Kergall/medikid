export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Keyless public Solana RPC endpoints, tried in order until one answers.
const UPSTREAMS = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
  'https://solana.drpc.org',
];

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const body = await request.text();
  let lastDetail = '';

  for (const upstream of UPSTREAMS) {
    try {
      const res = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      const text = await res.text();
      // Only accept a clean JSON-RPC answer; otherwise try the next upstream.
      if (res.ok && text && !text.trimStart().startsWith('<')) {
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      lastDetail = `${upstream}: HTTP ${res.status}`;
    } catch (err) {
      lastDetail = `${upstream}: ${String(err && err.message ? err.message : err)}`;
    }
  }

  return new Response(
    JSON.stringify({ proxyError: `Tous les RPC ont échoué. ${lastDetail}` }),
    { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } },
  );
}

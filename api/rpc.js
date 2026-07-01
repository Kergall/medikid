export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Keyless public Solana RPC endpoints.
const UPSTREAMS = [
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
  'https://api.mainnet-beta.solana.com',
];

function jsonResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function callUpstream(upstream, body) {
  const res = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  const ok = res.ok && text && !text.trimStart().startsWith('<');
  return { ok, status: res.status, text, upstream };
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const body = await request.text();

  // Allow a user-supplied dedicated RPC (e.g. Helius) to take priority.
  const { searchParams } = new URL(request.url);
  const custom = searchParams.get('upstream');
  const upstreams = custom ? [custom, ...UPSTREAMS] : UPSTREAMS;

  let method = '';
  try { method = JSON.parse(body).method; } catch { /* ignore */ }

  // For sendTransaction, broadcast to ALL upstreams in parallel and return
  // the first accepted response — this maximises the odds the tx lands.
  if (method === 'sendTransaction') {
    const results = await Promise.allSettled(
      upstreams.map(u => callUpstream(u, body)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        return jsonResponse(r.value.text);
      }
    }
    // Nothing clean — surface the first fulfilled body if any.
    const firstBody = results.find(r => r.status === 'fulfilled');
    if (firstBody && firstBody.status === 'fulfilled') {
      return jsonResponse(firstBody.value.text, 200);
    }
    return jsonResponse(JSON.stringify({ proxyError: 'Tous les RPC ont refusé sendTransaction.' }), 502);
  }

  // Reads: try upstreams in order, return the first clean answer.
  let lastDetail = '';
  for (const upstream of upstreams) {
    try {
      const r = await callUpstream(upstream, body);
      if (r.ok) return jsonResponse(r.text);
      lastDetail = `${upstream}: HTTP ${r.status}`;
    } catch (err) {
      lastDetail = `${upstream}: ${String(err && err.message ? err.message : err)}`;
    }
  }
  return jsonResponse(JSON.stringify({ proxyError: `Tous les RPC ont échoué. ${lastDetail}` }), 502);
}

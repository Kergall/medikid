export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const { searchParams } = new URL(request.url);
  const jupUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
  searchParams.forEach((value, key) => jupUrl.searchParams.set(key, value));

  try {
    const res = await fetch(jupUrl.toString(), {
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ proxyError: String(err && err.message ? err.message : err) }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } },
    );
  }
}

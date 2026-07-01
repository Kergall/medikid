export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const { searchParams } = new URL(request.url);
  const jupUrl = new URL('https://quote-api.jup.ag/v6/quote');
  searchParams.forEach((value, key) => jupUrl.searchParams.set(key, value));

  const res = await fetch(jupUrl.toString());
  const body = await res.arrayBuffer();

  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

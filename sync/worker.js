// Stores one JSON document (watchlist, indicators, drawings) per sync key.
// The key is a long random string made by the page; whoever has it can read and write that document.
const ALLOWED = ['https://workerdec.github.io', 'http://127.0.0.1:8799'];
const MAX_BYTES = 2_000_000;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const m = new URL(req.url).pathname.match(/^\/v1\/([A-Za-z0-9_-]{20,64})$/);
    if (!m) return new Response('not found', { status: 404, headers: cors });
    const key = 'u:' + m[1];

    if (req.method === 'GET') {
      const v = await env.KV.get(key);
      return new Response(v || '{}', { headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (req.method === 'PUT') {
      const body = await req.text();
      if (body.length > MAX_BYTES) return new Response('too large', { status: 413, headers: cors });
      try {
        const j = JSON.parse(body);
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error();
      } catch {
        return new Response('bad json', { status: 400, headers: cors });
      }
      await env.KV.put(key, body);
      return new Response('ok', { headers: cors });
    }
    return new Response('method not allowed', { status: 405, headers: cors });
  },
};

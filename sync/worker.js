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

    // Market Radar snapshot: the VPS writes it every 15 min (needs RADAR_SECRET), anyone can read it.
    if (new URL(req.url).pathname === '/radar') {
      if (req.method === 'GET') {
        const v = await env.KV.get('radar');
        return new Response(v || '{}', { headers: { ...cors, 'Access-Control-Allow-Origin': '*', 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
      if (req.method === 'PUT') {
        if (!env.RADAR_SECRET || req.headers.get('authorization') !== 'Bearer ' + env.RADAR_SECRET) return new Response('forbidden', { status: 403, headers: cors });
        const body = await req.text();
        if (body.length > 5_000_000) return new Response('too large', { status: 413, headers: cors });
        try { JSON.parse(body); } catch { return new Response('bad json', { status: 400, headers: cors }); }
        await env.KV.put('radar', body);
        return new Response('ok', { headers: cors });
      }
      return new Response('method not allowed', { status: 405, headers: cors });
    }

    const m =new URL(req.url).pathname.match(/^\/v1\/([A-Za-z0-9_-]{20,64})$/);
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

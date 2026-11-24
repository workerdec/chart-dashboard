// Stores one JSON document (watchlist, indicators, drawings) per sync key.
// The key is a long random string made by the page; whoever has it can read and write that document.
const ALLOWED = ['https://workerdec.github.io', 'http://127.0.0.1:8799'];
const MAX_BYTES = 2_000_000;

// ---------- /bars?s=USDT.D|BTC.D|TOTAL|TOTAL3|NDX|SPX|DXY|BRENT|GOLD|SILVER|NVDA...&tf=5m..1M&before=ms ----------
// Returns {rows:[{timestamp,open,high,low,close,volume}] oldest first, more}. One page per call.
const UA = { 'user-agent': 'Mozilla/5.0 chart-dashboard', accept: 'application/json' };
const TFMS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1D': 864e5, '1W': 6048e5, '1M': 0 };
const YAHOO = { NDX: '^NDX', IXIC: '^IXIC', SPX: '^GSPC', GOLD: 'GC=F', SILVER: 'SI=F', DXY: 'DX-Y.NYB', BRENT: 'BZ=F', WTI: 'CL=F', NVDA: 'NVDA' };
// crypto totals/dominance, all from one CMC feed so they agree with each other: [total, btc dominance %, eth dominance %, usdt supply]
const CMC = {
  'USDT.D': (t, b, e, u) => u ? u / t * 100 : null,
  'BTC.D': (t, b) => b, 'ETH.D': (t, b, e) => e,
  TOTAL: (t) => t, TOTAL2: (t, b) => t * (1 - b / 100), TOTAL3: (t, b, e) => t * (1 - (b + e) / 100),
};
const getj = async (url) => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + url.split('?')[0]); return r.json(); };

function bucketOf(ts, tf) {
  if (tf === '1M') { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  if (tf === '1W') { const d = new Date(ts), day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 864e5; }
  return Math.floor(ts / TFMS[tf]) * TFMS[tf];
}
// points [[ms, value]] -> candles; each candle opens at the previous close so the line is continuous
function candles(pts, tf) {
  const out = []; let prev = null;
  for (const [t, v] of pts) {
    const b = bucketOf(t, tf), last = out[out.length - 1];
    if (last && last.timestamp === b) { last.high = Math.max(last.high, v); last.low = Math.min(last.low, v); last.close = v; }
    else { const o = prev ?? v; out.push({ timestamp: b, open: o, high: Math.max(o, v), low: Math.min(o, v), close: v, volume: 0 }); }
    prev = v;
  }
  return out;
}
// merge yahoo/finer candles into a coarser tf (4h from 1h)
function regroup(rows, tf) {
  const out = [];
  for (const r of rows) { const b = bucketOf(r.timestamp, tf), l = out[out.length - 1];
    if (l && l.timestamp === b) { l.high = Math.max(l.high, r.high); l.low = Math.min(l.low, r.low); l.close = r.close; l.volume += r.volume; }
    else out.push({ ...r, timestamp: b }); }
  return out;
}

// USDT market cap from CMC too (same source as the total, so the ratio matches CMC's own dominance).
// range=ALL is weekly back to 2015; range=1M adds denser recent points.
let supplyMem = null;
async function usdtSupply() {
  if (supplyMem && Date.now() - supplyMem.t < 30 * 6e4) return supplyMem.S;
  const pick = (j) => Object.entries(j.data?.points || {}).map(([t, p]) => [t * 1000, p.v?.[2]]);
  const [all, m1] = await Promise.all(['ALL', '1M'].map((r) => getj(`https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail/chart?id=825&range=${r}`).then(pick).catch(() => [])));
  const from = m1.length ? m1[0][0] : Infinity;
  const S = [...all.filter((x) => x[0] < from), ...m1].filter((x) => x[1] > 0).sort((a, b) => a[0] - b[0]);
  if (!S.length) throw new Error('no USDT supply');
  supplyMem = { t: Date.now(), S };
  return S;
}
function supplyAt(S, t) {   // linear between the daily points, flat after the last one
  if (t < S[0][0]) return null;
  let lo = 0, hi = S.length - 1;
  if (t >= S[hi][0]) return S[hi][1];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m][0] <= t) lo = m; else hi = m; }
  const [t0, v0] = S[lo], [t1, v1] = S[hi]; return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
}
async function cmc(interval, startMs, endMs) {
  const j = await getj(`https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes/historical?format=chart&interval=${interval}&timeStart=${Math.floor(startMs / 1000)}&timeEnd=${Math.floor(endMs / 1000)}`);
  return (j.data?.quotes || []).map((q) => [Date.parse(q.timestamp), q.quote[0].totalMarketCap, q.btcDominance, q.ethDominance]);
}
async function cmcSeries(sym, tf, before) {
  // [cmc interval, ms per point, pages of 2000 points]
  const plan = { '1m': ['5m', 3e5, 1], '5m': ['5m', 3e5, 1], '15m': ['5m', 3e5, 2], '1h': ['5m', 3e5, 2], '4h': ['1h', 36e5, 1], '1D': ['1d', 864e5, 1], '1W': ['1d', 864e5, 2], '1M': ['1d', 864e5, 2] }[tf];
  const [iv, step, pages] = plan, span = 2000 * step;
  const reqs = [];
  for (let p = 0; p < pages; p++) reqs.push(cmc(iv, before - (p + 1) * span, before - p * span - 1));
  // live page of a coarse chart: add the last 2 days of 5m points so today's candle exists and has a real high/low
  if (iv !== '5m' && before >= Date.now() - 6e4) reqs.push(cmc('5m', before - 2 * 864e5, before).catch(() => []));
  const needU = sym === 'USDT.D';
  const [S, ...parts] = await Promise.all([needU ? usdtSupply() : null, ...reqs]);
  const tot = parts.flat().sort((a, b) => a[0] - b[0]);
  const pts = [];
  const f = CMC[sym];
  for (const [t, total, btc, eth] of tot) {
    if (!total || btc == null) continue;
    const v = f(total, btc, eth, needU ? supplyAt(S, t) : 0);
    if (v != null && isFinite(v)) pts.push([t, v > 1e6 ? Math.round(v) : +v.toFixed(4)]);
  }
  const rows = candles(pts, tf === '1m' ? '5m' : tf);
  if (rows.length && before < Date.now() - 6e4) rows.pop();   // older page: drop a possibly partial last candle
  return { rows, more: pts.length > 0 && (!needU || tot[0][0] > S[0][0]) };
}

async function yahoo(sym, tf, before) {
  const plan = { '1m': ['1m', 7], '5m': ['5m', 14], '15m': ['15m', 40], '1h': ['60m', 200], '4h': ['60m', 700], '1D': ['1d', 4000], '1W': ['1wk', 20000], '1M': ['1mo', 20000] }[tf];
  const [iv, days] = plan, p2 = Math.floor(before / 1000), p1 = Math.max(0, p2 - days * 86400);
  const j = await getj(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&period1=${p1}&period2=${p2}&includePrePost=false`);
  const r = j.chart?.result?.[0]; if (!r || !r.timestamp) return { rows: [], more: false };
  const q = r.indicators.quote[0];
  let rows = r.timestamp.map((t, i) => ({ timestamp: t * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 }))
    .filter((x) => x.open != null && x.close != null && x.high != null && x.low != null && x.timestamp < before);
  if (tf === '4h') rows = regroup(rows, '4h');
  if (tf === '1D' || tf === '1W' || tf === '1M') rows = regroup(rows, tf);   // yahoo dates bars by session open; snap to midnight / Monday / 1st
  const limitDays = { '1m': 29, '5m': 59, '15m': 59, '1h': 729, '4h': 729 }[tf];
  const more = rows.length > 0 && (!limitDays || p1 * 1000 > Date.now() - limitDays * 864e5) && !(tf === '1W' || tf === '1M');
  return { rows, more };
}

async function bars(req, cors, ctx) {
  const u = new URL(req.url), s = u.searchParams.get('s') || '', tf = u.searchParams.get('tf') || '1D';
  const head = { ...cors, 'Access-Control-Allow-Origin': '*', 'content-type': 'application/json' };
  if (!(tf in TFMS) || !(CMC[s] || YAHOO[s])) return new Response('{"error":"bad symbol or tf"}', { status: 400, headers: head });
  const now = Date.now(), b = +u.searchParams.get('before') || 0, before = b && b < now ? b : now;
  const intraday = TFMS[tf] && TFMS[tf] < 864e5, ttl = b ? 3600 : intraday ? 45 : 300;
  // cache key: live calls rounded to the ttl so everyone shares one upstream fetch
  const keyUrl = `https://bars.cache/${s}/${tf}/${b ? before : Math.floor(now / (ttl * 1000))}`;
  const cache = caches.default, hit = await cache.match(keyUrl);
  const n = +u.searchParams.get('n') || 0;   // n = only the last n candles (live polling, watchlist prices)
  const send = (body) => { if (n) { const j = JSON.parse(body); j.rows = j.rows.slice(-n); body = JSON.stringify(j); } return new Response(body, { headers: { ...head, 'cache-control': `public, max-age=${Math.min(ttl, 60)}` } }); };
  if (hit) return send(await hit.text());
  try {
    const out = CMC[s] ? await cmcSeries(s, tf, before) : await yahoo(YAHOO[s], tf, before);
    const body = JSON.stringify(out);
    ctx.waitUntil(cache.put(keyUrl, new Response(body, { headers: { 'cache-control': `public, max-age=${ttl}` } })));
    return send(body);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: head });
  }
}

export default {
  async fetch(req, env, ctx) {
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

    // Candles for symbols the browser can't fetch itself (no CORS): USDT dominance, Nasdaq, gold, silver.
    if (new URL(req.url).pathname === '/bars' && req.method === 'GET') return bars(req, cors, ctx);

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

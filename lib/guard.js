// Abuse guard for the public scan endpoints (each one can cost money on the Claude API).
//  - CORS: only Live Above's own pages may call these from a browser. Pages with no Origin
//    (app webviews, sandboxed embeds that report "null") are allowed, because browsers send
//    Origin on cross-site calls and a script that omits it is limited by the per-IP caps below.
//  - Per-IP caps: a sliding hour and a sliding day. Memory is per serverless instance, so this is
//    best effort, not a hard wall. Pair it with a monthly spend limit in the Anthropic Console.
//
// Vercel environment (optional):
//   ALLOWED_ORIGINS  extra comma-separated origins, e.g. https://app.example.com
//   GUARD_HEAVY_HOUR / GUARD_HEAVY_DAY / GUARD_LIGHT_HOUR   override the caps

const BASE = ['https://live-above.mvt.so', 'https://abovexpectations.com', 'https://www.abovexpectations.com', 'https://live-above-scorecard.onrender.com'];
const EXTRA = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED = BASE.concat(EXTRA);

function originOk(origin) {
  if (!origin || origin === 'null') return true;
  if (ALLOWED.indexOf(origin) !== -1) return true;
  try {
    const h = new URL(origin).hostname;
    return /(^|\.)mvt\.so$/.test(h) || /(^|\.)abovexpectations\.com$/.test(h);
  } catch (e) { return false; }
}

const hits = new Map(); // ip -> { h: [timestamps], d: [timestamps] }
let lastSweep = 0;
function sweep(now) {
  if (now - lastSweep < 600000) return;
  lastSweep = now;
  for (const [ip, v] of hits) { if (!v.d.length || now - v.d[v.d.length - 1] > 86400000) hits.delete(ip); }
}
function num(v, d) { const n = parseInt(v, 10); return n > 0 ? n : d; }

// Returns true when the request was refused (the response is already sent). Use:  if (guard(req, res)) return;
function guard(req, res, opts) {
  const heavy = !(opts && opts.light);
  const origin = req.headers.origin;
  if (origin) {
    if (!originOk(origin)) { res.status(403).json({ error: 'Origin not allowed' }); return true; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', BASE[0]);
  }
  if (req.method === 'OPTIONS') return false; // the handler answers the preflight; it is not counted

  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  sweep(now);
  const v = hits.get(ip) || { h: [], d: [] };
  v.h = v.h.filter((t) => now - t < 3600000);
  v.d = v.d.filter((t) => now - t < 86400000);
  const hourMax = heavy ? num(process.env.GUARD_HEAVY_HOUR, 40) : num(process.env.GUARD_LIGHT_HOUR, 200);
  const dayMax = heavy ? num(process.env.GUARD_HEAVY_DAY, 200) : 2000;
  if (v.h.length >= hourMax || v.d.length >= dayMax) {
    hits.set(ip, v);
    res.setHeader('Retry-After', '600');
    res.status(429).json({ error: 'Too many scans from this connection. Wait a few minutes and try again.' });
    return true;
  }
  v.h.push(now); v.d.push(now);
  hits.set(ip, v);
  return false;
}

module.exports = { guard, originOk };

// Vercel serverless function: /api/estimate-spoken-meal
// Turns a spoken or typed description of food ("a handful of potato chips, one Reese's cup, four
// McDonald's french fries") into separate foods with an estimated portion and nutrition for each.
// The tracker shows every estimate with the assumption behind it so the member can fix it.
//
// v2: reliable and more accurate.
// - Two steps. Step 1 sizes the portion and gives calories and macros (small, fast, focused). Step 2 fills the
//   micronutrients with the shared estimator, which caches. The old single call asked for ~27 numbers per food
//   and could run past the time limit, which showed up as "Couldn't estimate that".
// - Model fallback chain, a retry on busy or overloaded responses, and a hard time budget per call.
// - Per-unit anchors for common countable foods and fast-food items, so "10 McDonald's fries" is sized as ten fries.
// - Calories are checked against protein, carbs and fat before they leave the server.
// - Errors say what failed, so the app can show a useful message instead of a guess.

const M = require('../lib/micro-estimate.js');

const MODELS = Array.from(new Set([process.env.VOICE_MODEL, process.env.PHOTO_MODEL, 'claude-sonnet-5-5', 'claude-sonnet-5'].filter(Boolean)));
const MAX_ITEMS = 12;
const MAX_ITEM_G = 1500;
const MAX_ITEM_KCAL = 2500;
const MACRO_KEYS = ['cal', 'p', 'c', 'f', 'fiber', 'sodium', 'addedSugar'];

const PROMPT = [
  'You are a registered-dietitian-grade nutrition estimator. A person SAID or typed what they ate. Split it into separate foods and estimate calories and macros for the exact portion they described.',
  '',
  'HOW TO SIZE PORTIONS:',
  '- Spoken numbers are exact. "10 fries" is ten fries, "two slices" is two slices. Work out ONE unit, then multiply: grams = unit grams x count.',
  '- Vague amounts: a handful of chips or crackers is about 28 g; a handful of nuts about 30 g; a bite about 10 g; a splash of milk about 30 ml; a drizzle of oil or dressing about 1 tbsp (14 g); a bowl of cereal about 1.5 cups; a glass is about 240 ml.',
  '- Branded and restaurant items: use the brand\'s published US nutrition when you know it, and divide by the piece count for single pieces. If you do not know it, say so with low confidence and size it from a comparable food.',
  '- Cooked and raw differ: rice, pasta, oats and meat are described cooked unless the person says dry or raw.',
  '- Add hidden extras only when clearly implied (fried, buttered, with dressing). Never invent foods they did not mention.',
  '- Missing quantity: assume ONE typical serving and say so in the basis.',
  '- Drinks count when they contain calories. Plain water, plain black coffee and plain tea are skipped.',
  '',
  'REFERENCE ANCHORS (typical, use them when the food matches):',
  '- McDonald\'s fries (about 2.9 kcal per g, 0.35 g sodium per 100 g... salted): small 71 g and 230 kcal, medium 111 g and 320 kcal, large 150 g and 480 kcal. One fry is about 2.5 to 3 g, so 10 fries is about 28 g and 80 kcal.',
  '- Chicken McNuggets: 4 pieces 170 kcal, 6 pieces 250 kcal, 10 pieces 410 kcal. One piece is about 16 g and 42 kcal.',
  '- Reese\'s peanut butter cup: one cup 21 g, 105 kcal. Oreo cookie: 11 g, 53 kcal. Potato chip: about 2 g, 10 kcal each (about 15 chips per 28 g).',
  '- Large egg 50 g, 72 kcal. Slice of white bread 28 g, 75 kcal. Slice of cheese 21 g, 80 kcal. Deli turkey slice 28 g, about 30 kcal.',
  '- Medium banana 118 g, 105 kcal. Medium apple 182 g, 95 kcal. Almond 1.2 g, 7 kcal. Grape 5 g. Medium strawberry 12 g. Baby carrot 10 g.',
  '- 1 tbsp olive oil 14 g, 119 kcal. 1 tbsp peanut butter 16 g, 94 kcal. 1 tsp sugar 4 g, 16 kcal. 1 cup cooked rice 158 g, 205 kcal. 1 cup whole milk 244 g, 149 kcal. 12 oz cola 140 kcal. Large cheese pizza slice about 107 g, 285 kcal.',
  '',
  'Respond with ONLY a JSON object, no fences, no other text:',
  '{"isFood":boolean,"mealName":string,"items":[{"name":string,"qty":string,"grams":number,"confidence":"high"|"medium"|"low","basis":string,"v":{' + MACRO_KEYS.map((k) => '"' + k + '":number').join(',') + '},"sizes":[{"label":string,"factor":number}]|null}],"note":string|null}',
  'Rules:',
  '- "name" is a short database-style name with the brand when one was said, for example "Reese\'s Peanut Butter Cup" or "McDonald\'s French Fries".',
  '- "qty" is what they said in plain words, for example "10 fries" or "1 handful".',
  '- "grams" is the weight of the portion (or ml for drinks) you used.',
  '- "basis" is one short phrase showing the math, for example "10 fries x 2.8 g = 28 g, 2.9 kcal/g" or "1 cup = 21 g, label value".',
  '- "v" holds the nutrition for the WHOLE portion, not per 100 g. Units: cal kcal; p, c, f, fiber, addedSugar g; sodium mg. Calories must agree with the macros (4 per g of protein and carbs, 9 per g of fat).',
  '- "sizes": ONLY when the person gave no count and no size for a food that comes in sizes (fries, drinks, burgers, coffees). List 2 to 4 sizes with "factor" relative to the portion you chose (your pick is 1). Otherwise null.',
  '- Be realistic, not zero by default: use 0 only when the food truly has none of that nutrient.',
  '- Maximum ' + MAX_ITEMS + ' items. If the text is not about food, set isFood to false and items to [].',
  '- "note" is one short sentence only if something big affects accuracy; otherwise null.',
].join('\n').replace(' (about 2.9 kcal per g, 0.35 g sodium per 100 g... salted)', ' (about 2.9 kcal per g, salted)');

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try { return JSON.parse(cleaned.slice(a, b + 1)); } catch (e) { /* fall through */ }
  }
  return null;
}

function num(v) { const n = Number(v); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One model call. Returns { json } on success, or { status, retry } so the caller can decide what to do next.
async function callOnce(apiKey, model, text, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1800, messages: [{ role: 'user', content: PROMPT + '\n\nWhat the person said:\n"""' + text + '"""' }] }),
    });
    if (!r.ok) {
      console.error('Voice estimate HTTP', model, r.status, (await r.text()).slice(0, 200));
      // 400/404: this model name is not usable here, move on. 429/5xx/529: busy, worth one retry.
      return { status: r.status, retry: r.status === 429 || r.status >= 500 };
    }
    const d = await r.json();
    const tb = (d.content || []).find((b) => b.type === 'text');
    const json = tb ? extractJson(tb.text) : null;
    return json ? { json } : { status: 'parse', retry: true };
  } catch (e) {
    console.error('Voice estimate call failed', model, e && e.name);
    return { status: e && e.name === 'AbortError' ? 'timeout' : 'network', retry: true };
  } finally { clearTimeout(timer); }
}

async function getEstimate(apiKey, text, startedAt) {
  let last = null;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - startedAt > 40000) return { fail: last || 'time' };
      const r = await callOnce(apiKey, model, text, 22000);
      if (r.json) return { json: r.json, model };
      last = r.status;
      if (!r.retry) break;
      await sleep(600);
    }
  }
  return { fail: last || 'unknown' };
}

// Pulls a made-up calorie figure back to what the macros say. Skipped for drinks with alcohol or sugar alcohols.
function fixEnergy(it) {
  const v = it.v, fromMacros = 4 * v.p + 4 * v.c + 9 * v.f;
  if (!(v.cal > 60) || !(fromMacros > 0)) return;
  if (/beer|wine|vodka|whiskey|whisky|rum|gin|tequila|cocktail|margarita|liquor|bourbon|alcohol|seltzer|sugar.?free|zero/i.test(it.name)) return;
  const gap = Math.abs(v.cal - fromMacros) / Math.max(v.cal, fromMacros);
  if (gap > 0.2) {
    it.basis = (it.basis ? it.basis + '. ' : '') + 'Calories adjusted to match macros.';
    v.cal = Math.round(0.35 * v.cal + 0.65 * fromMacros);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST requests allowed' });

  const body = req.body || {};
  // Phone keyboards type curly quotes and dictation adds filler; normalize before the model sees it.
  const text = typeof body.text === 'string'
    ? body.text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').replace(/\b(um+|uh+|er+)\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 600)
    : '';
  if (text.length < 2) return res.status(400).json({ error: 'Nothing to estimate', stage: 'input' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: missing API key', stage: 'config' });

  const t0 = Date.now();
  try {
    const got = await getEstimate(apiKey, text, t0);
    if (!got.json) {
      const busy = got.fail === 429 || got.fail === 529 || got.fail === 503 || got.fail === 'timeout';
      return res.status(busy ? 503 : 502).json({ error: busy ? 'The estimator is busy. Try again in a moment.' : 'Could not estimate that', stage: 'model', code: String(got.fail) });
    }
    const parsed = got.json;
    if (parsed.isFood === false) return res.status(200).json({ isFood: false, items: [] });

    const items = [];
    (Array.isArray(parsed.items) ? parsed.items : []).slice(0, MAX_ITEMS).forEach((it) => {
      if (!it || typeof it.name !== 'string' || !it.v) return;
      const grams = Math.min(MAX_ITEM_G, Math.round(Number(it.grams) || 0));
      const v = {};
      MACRO_KEYS.forEach((k) => { v[k] = num(it.v[k]); });
      if (!(v.cal > 0) || v.cal > MAX_ITEM_KCAL) return;
      const conf = ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium';
      const sizes = Array.isArray(it.sizes) ? it.sizes.map((s) => ({ label: String((s && s.label) || '').slice(0, 24), factor: Math.round(Number(s && s.factor) * 100) / 100 }))
        .filter((s) => s.label && s.factor > 0.1 && s.factor < 6).slice(0, 4) : [];
      const row = { name: it.name.trim().slice(0, 80), qty: String(it.qty || '').slice(0, 60), grams: grams > 0 ? grams : null, confidence: conf, basis: String(it.basis || '').slice(0, 140), v, sizes: sizes.length >= 2 ? sizes : null };
      fixEnergy(row);
      items.push(row);
    });
    if (!items.length) return res.status(200).json({ isFood: false, items: [] });

    // Step 2: micronutrients for the portion, from the shared estimator (cached, never blocks the answer).
    let micros = [];
    try {
      micros = await M.estimate(items.map((it) => ({
        name: it.name, context: it.qty, grams: it.grams || undefined,
        macros: { cal: it.v.cal, p: it.v.p, c: it.v.c, f: it.v.f, fiber: it.v.fiber, sodium: it.v.sodium },
        need: M.KEYS.slice(),
      })), { timeoutMs: 15000 });
    } catch (e) { console.error('Voice micros failed', e && e.message); }
    let missing = 0;
    items.forEach((it, i) => {
      const m = micros && micros[i] && micros[i].micros;
      if (!m) missing++;
      M.KEYS.forEach((k) => { it.v[k] = m && m[k] !== undefined ? m[k] : 0; });
      it.microsEstimated = !!m;
    });

    return res.status(200).json({
      isFood: true,
      mealName: typeof parsed.mealName === 'string' ? parsed.mealName.slice(0, 60) : '',
      items,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null,
      microsMissing: missing > 0,
      ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('Voice estimate error:', err);
    return res.status(502).json({ error: 'Estimate unavailable', stage: 'server' });
  }
};

// Vercel serverless function: /api/estimate-spoken-meal
// Turns a spoken or typed description of food ("a handful of potato chips, one Reese's cup, four
// McDonald's french fries") into separate foods with an estimated portion and nutrition for each.
// The tracker shows every estimate with the assumption behind it so the member can fix it.
//
// Accuracy pipeline (Oct 2026):
//   1. The model splits the meal into foods and sizes each portion in grams, with macros only
//      (a short answer, so it returns well inside the time limit).
//   2. Branded, restaurant and local-spot foods are checked against the same database the
//      Restaurant search uses (local spots + FatSecret). When a confident match is found, its
//      per-gram values replace the model's guess for that food.
//   3. Micronutrients are filled by the shared estimator, scaled to the exact portion.
// Response shape is unchanged, so the tracker needs no update to benefit.

const M = require('../lib/micro-estimate.js');
const restaurantSearch = require('./restaurant-search.js');

const MODEL = process.env.VOICE_MODEL || 'claude-sonnet-5-5';
const FALLBACK_MODEL = process.env.VOICE_MODEL_FALLBACK || 'claude-sonnet-5';
const MAX_ITEMS = 12;
const MAX_ITEM_G = 1500;
const MAX_ITEM_KCAL = 2500;
const LOOKUP_WAIT_MS = 3500;
const MACRO_KEYS = ['cal', 'p', 'c', 'f', 'fiber', 'sodium', 'addedSugar'];

const PROMPT = [
  'You are a registered-dietitian-grade nutrition estimator. A person SAID or typed what they ate (speech-to-text, so expect small transcription errors like "for" meaning "four"). Split it into separate foods and estimate the nutrition of the exact portion they described.',
  '',
  'HOW TO SIZE PORTIONS:',
  '- Spoken numbers count: "four fries" is four fries, "one cup" of a candy is one piece, "two slices" is two slices, "a couple" is 2, "a few" is 3.',
  '- Vague amounts use these anchors: a handful of chips or crackers is about 28 g; a handful of nuts about 30 g; a bite about 10 g; a splash of milk about 30 ml; a drizzle of oil or dressing about 1 tbsp; a bowl of cereal about 1.5 cups; a glass of a drink about 8 fl oz; a plate of pasta or rice about 1.5 to 2 cups cooked; a slice of deli meat about 28 g; a slice of bread about 30 g; a large egg about 50 g.',
  '- Meats, rice, pasta and vegetables are cooked weights unless the person says raw.',
  '- Branded and restaurant items: use the brand\'s published nutrition and published portion sizes when you know them (one Reese\'s peanut butter cup is about 21 g and 105 kcal; a McDonald\'s medium fries is about 111 g and 320 kcal, so one fry is about 4 to 5 g). "Small, medium, large" means that restaurant\'s size.',
  '- Add hidden extras only when the person clearly implies them (fried, buttered, with dressing, with cheese). Do not invent foods they did not mention.',
  '- If a quantity is missing, assume ONE typical serving and say so in the basis.',
  '- Drinks count when they contain calories. Plain water, black coffee and plain tea are skipped.',
  '- Check your own math: calories should be close to 4 x protein + 4 x carbs + 9 x fat (+ 7 x grams of alcohol for drinks).',
  '',
  'Respond with ONLY a JSON object, no fences, no other text:',
  '{"isFood":boolean,"mealName":string,"items":[{"name":string,"brand":string|null,"lookup":string|null,"qty":string,"grams":number,"confidence":"high"|"medium"|"low","basis":string,"v":{' + MACRO_KEYS.map((k) => '"' + k + '":number').join(',') + '}}],"note":string|null}',
  'Rules:',
  '- "name" is a short database-style name with the brand when one was said, for example "Reese\'s Peanut Butter Cup" or "McDonald\'s French Fries".',
  '- "brand" is the brand or restaurant name if one was said or is obvious (Big Mac means McDonald\'s), otherwise null.',
  '- "lookup" is a short search phrase for a nutrition database, brand first, for example "McDonald\'s french fries" or "Chipotle chicken burrito bowl"; null when brand is null.',
  '- "qty" is what they said in plain words, for example "4 fries" or "1 handful".',
  '- "grams" is the weight of the portion (or ml for drinks) you used.',
  '- "basis" is one short phrase on how you sized it, for example "1 cup = 21 g, label value" or "handful is about 1 oz".',
  '- "v" holds the nutrition for the WHOLE portion, not per 100 g. Units: cal kcal; p, c, f, fiber, addedSugar g; sodium mg.',
  '- Be realistic, not zero by default: use 0 only when the food truly has none of that nutrient.',
  '- Maximum ' + MAX_ITEMS + ' items. If the text is not about food, set isFood to false and items to [].',
  '- "note" is one short sentence only if something big affects accuracy; otherwise null.',
].join('\n');

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

function clean(v, k) {
  const n = Number(v && v[k]);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function norm(s) { return String(s || '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'from', 'in', 'on', 'my', 'some', 'piece', 'pieces', 'small', 'medium', 'large', 'regular', 'size']);
function words(s) { return norm(s).split(' ').filter((w) => w && !STOP.has(w)); }
function stem(w) { return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w; }

// Runs the Restaurant search handler in-process (local spots + FatSecret branded foods), fast mode.
function searchDb(query) {
  return new Promise((resolve) => {
    const fake = {
      code: 200,
      setHeader() {}, end() {},
      status(c) { this.code = c; return this; },
      json(j) { resolve(this.code === 200 && j && Array.isArray(j.results) ? j.results : []); },
    };
    restaurantSearch({ method: 'GET', query: { query, fast: '1' } }, fake).catch(() => resolve([]));
  });
}
function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r([]), ms); })]).then((v) => { clearTimeout(t); return v; });
}

// Picks a database row only when it clearly is the same food: the brand must match and most of the
// food words must appear. Anything less keeps the model's estimate.
function bestMatch(item, rows) {
  const brandW = words(item.brand).map(stem);
  const foodW = words(item.name).map(stem).filter((w) => brandW.indexOf(w) < 0);
  if (!foodW.length) return null;
  let best = null;
  rows.forEach((r) => {
    if (!r || !r.per100 || !(r.per100.cal >= 0)) return;
    const hay = words((r.brandName || '') + ' ' + (r.name || '')).map(stem);
    const brandOk = !brandW.length || brandW.some((w) => hay.indexOf(w) > -1);
    if (!brandOk) return;
    const hit = foodW.filter((w) => hay.indexOf(w) > -1).length;
    const score = hit / foodW.length;
    const extra = words(r.name).length - hit; // fewer unrelated words wins ties
    if (score >= 0.6 && (!best || score > best.score || (score === best.score && extra < best.extra))) best = { r, score, extra };
  });
  return best ? best.r : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST requests allowed' });

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  if (text.length < 2) return res.status(400).json({ error: 'Nothing to estimate' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: missing API key' });

  let activeModel = MODEL;
  function post(model) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: PROMPT + '\n\nWhat the person said:\n"""' + text + '"""' }],
      }),
    });
  }
  async function callModel() {
    let r = await post(activeModel);
    // An unknown or retired model name should not take voice logging down: fall back once and stay there.
    if (!r.ok && (r.status === 400 || r.status === 404) && activeModel !== FALLBACK_MODEL) {
      console.error('Voice model rejected, falling back:', activeModel, r.status, await r.text());
      activeModel = FALLBACK_MODEL;
      r = await post(activeModel);
    }
    // Overloaded or rate limited: one short pause, then one more try.
    if (!r.ok && (r.status === 429 || r.status === 529 || r.status >= 500)) {
      await new Promise((ok) => setTimeout(ok, 700));
      r = await post(activeModel);
    }
    if (!r.ok) { console.error('Voice estimate HTTP', r.status, await r.text()); return null; }
    const d = await r.json();
    const tb = (d.content || []).find((b) => b.type === 'text');
    return tb ? extractJson(tb.text) : null;
  }

  try {
    let parsed = await callModel();
    if (!parsed) parsed = await callModel();
    if (!parsed) return res.status(502).json({ error: 'Could not estimate that' });
    if (parsed.isFood === false) return res.status(200).json({ isFood: false, items: [] });

    const items = [];
    (Array.isArray(parsed.items) ? parsed.items : []).slice(0, MAX_ITEMS).forEach((it) => {
      if (!it || typeof it.name !== 'string' || !it.v) return;
      const grams = Math.min(MAX_ITEM_G, Math.round(Number(it.grams) || 0));
      const v = {};
      MACRO_KEYS.forEach((k) => { v[k] = clean(it.v, k); });
      if (!(v.cal > 0) || v.cal > MAX_ITEM_KCAL) return;
      const conf = ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium';
      items.push({
        name: it.name.trim().slice(0, 80),
        qty: String(it.qty || '').slice(0, 60),
        grams: grams > 0 ? grams : null,
        confidence: conf,
        basis: String(it.basis || '').slice(0, 120),
        source: 'estimate',
        v,
        _brand: typeof it.brand === 'string' ? it.brand.slice(0, 60) : '',
        _lookup: typeof it.lookup === 'string' ? it.lookup.slice(0, 80) : '',
      });
    });
    if (!items.length) return res.status(200).json({ isFood: false, items: [] });

    // Step 2: ground branded and restaurant foods in the database, in parallel, with a hard time cap.
    await Promise.all(items.map(async (it) => {
      if (!it._brand || !it._lookup || !it.grams) return;
      const rows = await withTimeout(searchDb(it._lookup), LOOKUP_WAIT_MS);
      const m = bestMatch({ name: it.name, brand: it._brand }, rows);
      if (!m) return;
      const f = it.grams / 100;
      const cal = Math.round(m.per100.cal * f * 10) / 10;
      // A wildly different calorie count means the match is a different product: keep the estimate.
      if (!(cal > 0) || cal > it.v.cal * 3 || cal < it.v.cal / 3) return;
      MACRO_KEYS.forEach((k) => { it.v[k] = Math.round((Number(m.per100[k]) || 0) * f * 100) / 100; });
      M.KEYS.forEach((k) => { const x = Number(m.per100[k]); if (x > 0) it.v[k] = Math.round(x * f * 100) / 100; });
      it.confidence = 'high';
      it.source = m.estimated ? 'local' : 'database';
      it.basis = (it.basis ? it.basis + '; ' : '') + 'values from ' + ((m.brandName ? m.brandName + ' ' : '') + m.name).slice(0, 60);
    }));

    // Step 3: micronutrients for the exact portion. A slow or failed fill never blocks the answer.
    const jobs = items.map((it) => ({
      name: it.name, context: it.qty, grams: it.grams || undefined,
      macros: it.v, have: it.v, need: M.missingKeys(it.v, true),
    }));
    let est = [];
    try { est = await M.estimate(jobs, { timeoutMs: 7000 }); } catch (e) { console.error('Voice micro fill failed', e && e.message); }
    items.forEach((it, i) => {
      const got = est[i] && est[i].micros ? est[i].micros : {};
      M.KEYS.forEach((k) => {
        if (it.v[k] > 0) return;
        const x = Number(got[k]);
        it.v[k] = isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : 0;
      });
      delete it._brand; delete it._lookup;
    });

    return res.status(200).json({
      isFood: true,
      mealName: typeof parsed.mealName === 'string' ? parsed.mealName.slice(0, 60) : '',
      items,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null,
    });
  } catch (err) {
    console.error('Voice estimate error:', err);
    return res.status(502).json({ error: 'Estimate unavailable' });
  }
};

// Model call + database checks + micronutrient fill can pass Vercel's 10 second default.
module.exports.config = { maxDuration: 30 };

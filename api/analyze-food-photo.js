// Vercel serverless function: /api/analyze-food-photo
// Receives one to three photos of a meal (plus an optional note from the member), asks Claude's
// vision API to identify each food and estimate grams, and returns a list the tracker matches
// against its own food database. Calories, macros and micronutrients are NOT guessed here: the
// front end computes them from its database so numbers stay consistent with everything else
// the user logs.
//
// Accuracy notes (v2):
// - Accepts `images` (up to 3 angles) or the original single `imageBase64`.
// - Accepts `hint`, a short note from the member ("grilled in olive oil, no dressing").
// - The model is told HOW to estimate: reference objects, plate sizes, depth, density, and
//   cooked vs raw weights, and to decompose mixed dishes and add hidden fats.
// - Each item returns a gram range, so the app can show how sure the estimate is.
// - Output is validated, de-duplicated and sanity-capped before it leaves the server.

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

const MODEL = process.env.PHOTO_MODEL || 'claude-sonnet-5';
const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Plausible ceiling for one item in a single meal, in grams. Anything above is clamped.
const MAX_ITEM_G = 1200;

const PROMPT = [
  'You are a registered-dietitian-grade food photo analyst. The photo(s) show ONE meal or snack. Identify every distinct food and estimate how many grams the person is about to EAT (cooked weight for cooked foods, edible portion only, no bones, peels or shells).',
  '',
  'HOW TO ESTIMATE PORTIONS (do this silently, then answer):',
  '1. Find a size reference: a standard dinner plate is about 26 cm (10.5 in), a salad or bread plate about 19 cm, a fork is about 19 cm long, a spoon about 17 cm, a standard bowl holds about 350 to 500 ml, a can is about 6.6 cm wide, a hand or thumb if visible. Use it to judge the real size of the food.',
  '2. Estimate area covered and HEIGHT of each food. Piled food is usually thicker than it looks. Judge volume, then convert with typical densities: cooked rice about 0.65 g/ml, cooked pasta about 0.55 g/ml, leafy salad about 0.1 g/ml, cooked ground meat about 0.9 g/ml, cooked vegetables about 0.5 g/ml, mashed potato about 1.0 g/ml, yogurt or sauces about 1.0 g/ml.',
  '3. Sanity check with common portions: a cooked chicken breast is 120 to 200 g, a palm-sized steak about 140 g, a fist of cooked rice about 150 g, a slice of bread 30 to 40 g, one egg about 50 g, a medium banana about 120 g edible, a tablespoon of oil 14 g.',
  '4. If several photos are given they show the same meal from different angles. Use them together and do not double count.',
  '',
  'NAMING RULES:',
  '- Use specific names a nutrition database would have, including the cooking method and the cut or fat level when you can tell, e.g. "chicken breast grilled", "ground beef 85% lean cooked", "white rice cooked", "broccoli steamed", "salmon baked", "fried egg", "olive oil".',
  '- Break mixed dishes into their main components (a burrito bowl becomes rice, beans, chicken, salsa, cheese, lettuce). For a dish that cannot be separated (a casserole, soup, stew, curry), list the main components with a note.',
  '- Add visible or very likely cooking fats, butter, dressings and sauces as their own items with realistic amounts (1 tsp oil is 5 g, 1 tbsp is 14 g, a drizzle of dressing 15 to 30 g). Fried or glossy foods almost always carry oil.',
  '- Include drinks only when they contain calories (juice, milk, soda, coffee with cream or sugar, smoothies). Skip plain water, plates, utensils, napkins and garnishes under 5 g.',
  '- If the member wrote a note, trust it over your guess for ingredients, cooking method and weights it states.',
  '',
  'Respond with ONLY a JSON object, no other text, no markdown fences:',
  '{',
  '  "isFood": boolean,',
  '  "mealName": string,',
  '  "foods": [',
  '    { "name": string, "grams": number, "gramsLow": number, "gramsHigh": number, "confidence": "high" | "medium" | "low", "basis": string }',
  '  ],',
  '  "note": string | null',
  '}',
  'Rules:',
  '- "grams" is your single best estimate. "gramsLow" and "gramsHigh" are a realistic range (tighter when you can see the food clearly, wider when it is hidden, stacked or the scale is unclear).',
  '- "basis" is a very short phrase for how you sized it, e.g. "covers a third of a 10 inch plate", "about 1 cup".',
  '- "confidence": high only when the food is clearly visible and identifiable, low when you are guessing the food or the portion.',
  '- Prefer a realistic estimate over zero. Never invent foods that are not visible or strongly implied.',
  '- If the photo is not food, set isFood to false and foods to an empty array.',
  '- "note" is one short sentence only if something affects accuracy (hidden food, mixed dish, unclear scale, dark photo); otherwise null.',
  '- Maximum 14 items, largest portions first.',
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

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : NaN;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your domain before real launch
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST requests allowed' });

  const body = req.body || {};
  const list = [];
  if (Array.isArray(body.images)) {
    body.images.slice(0, 3).forEach((im) => {
      if (im && typeof im.imageBase64 === 'string' && im.imageBase64.length > 100) {
        list.push({ data: im.imageBase64, type: SUPPORTED.includes(im.mediaType) ? im.mediaType : 'image/jpeg' });
      }
    });
  }
  if (!list.length && typeof body.imageBase64 === 'string' && body.imageBase64.length > 100) {
    list.push({ data: body.imageBase64, type: SUPPORTED.includes(body.mediaType) ? body.mediaType : 'image/jpeg' });
  }
  if (!list.length) return res.status(400).json({ error: 'No image provided' });

  const hint = typeof body.hint === 'string' ? body.hint.replace(/\s+/g, ' ').trim().slice(0, 300) : '';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: missing API key' });

  const content = [];
  list.forEach((im, i) => {
    if (list.length > 1) content.push({ type: 'text', text: 'Photo ' + (i + 1) + ' of ' + list.length + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } });
  });
  content.push({
    type: 'text',
    text: PROMPT + (hint ? '\n\nMember note (trust this): ' + hint : ''),
  });

  async function callModel() {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1400,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!response.ok) {
      console.error('Anthropic API error:', response.status, await response.text());
      return null;
    }
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    return textBlock ? extractJson(textBlock.text) : null;
  }

  try {
    // One automatic retry: a malformed or failed first response should not cost the member a re-shoot.
    let parsed = await callModel();
    if (!parsed) parsed = await callModel();
    if (!parsed) return res.status(502).json({ error: 'Could not read that photo' });

    const seen = new Map();
    (Array.isArray(parsed.foods) ? parsed.foods : []).forEach((f) => {
      if (!f || typeof f.name !== 'string') return;
      let g = num(f.grams);
      if (!(g > 0)) return;
      g = Math.min(MAX_ITEM_G, Math.round(g));
      let lo = num(f.gramsLow);
      let hi = num(f.gramsHigh);
      if (!(lo > 0 && lo <= g)) lo = Math.max(1, Math.round(g * 0.75));
      if (!(hi >= g)) hi = Math.round(g * 1.3);
      lo = Math.round(Math.min(lo, g));
      hi = Math.min(MAX_ITEM_G * 1.2, Math.round(Math.max(hi, g)));
      const name = String(f.name).trim().slice(0, 80);
      const key = name.toLowerCase();
      const item = {
        name,
        grams: g,
        gramsLow: lo,
        gramsHigh: hi,
        confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium',
        basis: typeof f.basis === 'string' ? f.basis.slice(0, 80) : '',
      };
      // Merge exact duplicate names instead of listing the same food twice.
      if (seen.has(key)) {
        const prev = seen.get(key);
        prev.grams = Math.min(MAX_ITEM_G, prev.grams + item.grams);
        prev.gramsLow += item.gramsLow;
        prev.gramsHigh += item.gramsHigh;
      } else {
        seen.set(key, item);
      }
    });
    const foods = Array.from(seen.values()).sort((a, b) => b.grams - a.grams).slice(0, 14);

    let note = typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null;
    const totalG = foods.reduce((s, f) => s + f.grams, 0);
    if (totalG > 2500) note = (note ? note + ' ' : '') + 'That is a very large total. Check the grams.';

    // Per-100 g calories, macros and all 20 micronutrients for every food, so a food the tracker's own list
    // does not have can still be logged with complete numbers (flagged as an estimate in the app).
    try {
      const M = require('../lib/micro-estimate.js');
      const est = await M.estimate(foods.map((f) => ({ name: f.name, context: 'as eaten, per 100 g', grams: 100, need: M.KEYS, needMacros: true })), { timeoutMs: 7000 });
      est.forEach((e, i) => {
        if (!e || !e.macros || !(e.macros.cal >= 0)) return;
        foods[i].est = Object.assign({ cal: 0, p: 0, c: 0, f: 0, fiber: 0, sodium: 0, addedSugar: 0 }, e.macros, e.micros);
      });
    } catch (e) { console.error('Photo estimate failed:', e && e.message); }

    return res.status(200).json({
      isFood: parsed.isFood !== false && foods.length > 0,
      mealName: typeof parsed.mealName === 'string' ? parsed.mealName.slice(0, 60) : '',
      foods,
      note,
      version: 2,
    });
  } catch (err) {
    console.error('analyze-food-photo error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

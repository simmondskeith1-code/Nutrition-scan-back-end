// Vercel serverless function: /api/analyze-food-photo
// Receives one to three photos of a meal (plus an optional note from the member), asks Claude's
// vision API to identify each food and estimate grams, and returns a list the tracker matches
// against its own food database. Calories, macros and micronutrients are NOT guessed here: the
// front end computes them from its database so numbers stay consistent with everything else
// the user logs.
//
// Accuracy notes (v5): a fresh photo is read twice in parallel and the two readings are averaged; foods only one
//   reading saw come back as low confidence; big disagreements widen the range. Re-reads with a prior stay single.
// (v4 notes)
// - v4: each solid item also returns a volume and density, and the server blends that weight with the
//   direct gram guess (two independent estimates), widening the range when they disagree.
// - v4: `prior` lets a re-read after the member answers questions or picks a plate size keep the same
//   portions unless the new information changes them, so numbers stop drifting between reads.
// - v4: the model reports photo quality; a blurry, dark or too-far photo returns `retake` so the app asks for a reshoot.
// - v4: if the configured model name is rejected, one retry uses the previous model.
// (v2 notes)
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

const MODEL = process.env.PHOTO_MODEL || 'claude-sonnet-5-5';
const FALLBACK_MODEL = process.env.PHOTO_MODEL_FALLBACK || 'claude-sonnet-5';
const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const RETAKE_TEXT = {
  blurry: 'This photo is blurry, so portions are rough. Hold steady and retake it.',
  dark: 'This photo is too dark to size the food. Move near a window or use the torch, then retake it.',
  too_far: 'The food is too small in the frame. Move closer so the plate fills most of the shot, then retake it.',
  glare: 'Glare is hiding the food. Tilt the phone away from the light and retake it.',
  angle: 'The angle hides the portions. Shoot from above, or at a 45 degree angle, and retake it.',
  covered: 'Part of the food is hidden. Move what is covering it or add a second angle.',
};

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
  '5. For every SOLID or semi-solid food, ALSO estimate its volume in ml from what you can see (area covered times height, using the size reference) and pick the density in g/ml from the list above. Do this independently of your gram guess. Skip volume for liquids, oils, sauces under 30 g and anything you cannot see.',
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
  '    { "name": string, "grams": number, "gramsLow": number, "gramsHigh": number, "confidence": "high" | "medium" | "low", "basis": string, "volumeMl": number | null, "densityGml": number | null }',
  '  ],',
  '  "quality": { "usable": boolean, "issue": "blurry" | "dark" | "too_far" | "glare" | "angle" | "covered" | null },',
  '  "note": string | null,',
  '  "questions": [ { "q": string, "options": [string, string] } ]',
  '}',
  'Rules:',
  '- "grams" is your single best estimate. "gramsLow" and "gramsHigh" are a realistic range (tighter when you can see the food clearly, wider when it is hidden, stacked or the scale is unclear).',
  '- "basis" is a very short phrase for how you sized it, e.g. "covers a third of a 10 inch plate", "about 1 cup".',
  '- "confidence": high only when the food is clearly visible and identifiable, low when you are guessing the food or the portion.',
  '- Prefer a realistic estimate over zero. Never invent foods that are not visible or strongly implied.',
  '- If the photo is not food, set isFood to false and foods to an empty array.',
  '- "note" is one short sentence only if something affects accuracy (hidden food, mixed dish, unclear scale, dark photo); otherwise null.',
  '- Maximum 14 items, largest portions first.',
  '- "quality.usable" is false only when the photo is too poor to size the food (heavy blur, very dark, food tiny in frame, glare hiding the food, food mostly hidden). Then still give your best guess, with low confidence and wide ranges, and set "issue". When usable, issue is null.',
  '- "questions": up to 3 short follow-up questions for the member, ONLY about things you cannot see that would move calories or macros by more than about 10 percent: cooking method or oil/butter used, sauces and dressings, cheese amount, sugar or milk in a drink, what is inside a wrap or casserole, or a portion hidden under other food. Each has 2 to 4 short concrete answer options (for example "Pan fried in oil", "Grilled, no oil"). Never ask what the photo or the member note already answers. Use an empty array if nothing material is unclear.',
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

// Two independent estimates of the same food: the direct gram guess and volume times density.
// Close agreement tightens the number; a wide gap means the model is unsure, so the range widens and
// confidence drops. Densities outside a plausible band are ignored.
function reconcile(g, lo, hi, vol, dens, confidence) {
  if (!(vol > 0 && vol <= 2500 && dens >= 0.08 && dens <= 1.6)) return { g, lo, hi, confidence };
  const vg = vol * dens;
  const ratio = Math.max(g, vg) / Math.min(g, vg);
  if (ratio <= 1.25) {
    const m = Math.round((g + vg) / 2);
    return { g: Math.min(MAX_ITEM_G, m), lo: Math.max(1, Math.round(Math.min(lo, m, vg * 0.9))), hi: Math.round(Math.max(hi, m)), confidence };
  }
  if (ratio <= 1.7) {
    const m = Math.round(Math.sqrt(g * vg));
    return { g: Math.min(MAX_ITEM_G, m), lo: Math.max(1, Math.round(Math.min(lo, g, vg) * 0.95)), hi: Math.round(Math.max(hi, g, vg) * 1.05), confidence: confidence === 'high' ? 'medium' : confidence };
  }
  const m = Math.round(Math.sqrt(g * vg));
  return { g: Math.min(MAX_ITEM_G, m), lo: Math.max(1, Math.round(Math.min(g, vg) * 0.9)), hi: Math.round(Math.max(g, vg) * 1.1), confidence: 'low' };
}

// Turn one raw model reading into a clean, de-duplicated food list (volume x density blended in).
function cleanFoods(parsed) {
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
    let confidence = ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium';
    const rec = reconcile(g, lo, hi, num(f.volumeMl), num(f.densityGml), confidence);
    g = rec.g; lo = rec.lo; hi = rec.hi; confidence = rec.confidence;
    const item = {
      name,
      grams: g,
      gramsLow: lo,
      gramsHigh: hi,
      confidence,
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

  return Array.from(seen.values());
}

const STOP = new Set(['and', 'with', 'the', 'of', 'a', 'cooked', 'raw', 'fresh', 'baked', 'grilled', 'fried', 'steamed', 'roasted', 'boiled', 'sauteed', 'lean', 'plain']);
function toks(name) {
  const t = String(name).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(es|s)$/, ''));
  return new Set(t);
}
function sameFood(a, b) {
  const ta = toks(a), tb = toks(b);
  if (!ta.size || !tb.size) return a.toLowerCase() === b.toLowerCase();
  let hit = 0;
  ta.forEach((w) => { if (tb.has(w)) hit++; });
  return hit / Math.min(ta.size, tb.size) >= 0.6;
}
const RANK = { low: 0, medium: 1, high: 2 };
const NAME = ['low', 'medium', 'high'];

// Two independent readings of the same photo: average what both saw, widen the range and lower
// confidence where they disagree, and keep a food seen by only one reading as low confidence.
function mergeRuns(A, B) {
  const poolB = B.slice();
  const out = [];
  A.slice().sort((x, y) => y.grams - x.grams).forEach((a) => {
    const j = poolB.findIndex((b) => sameFood(a.name, b.name));
    if (j === -1) {
      if (a.grams < 10) return;
      out.push({ ...a, confidence: a.confidence === 'high' ? 'medium' : 'low', gramsLow: Math.max(1, Math.round(a.grams * 0.4)) });
      return;
    }
    const b = poolB.splice(j, 1)[0];
    const g = Math.round((a.grams + b.grams) / 2);
    const ratio = Math.max(a.grams, b.grams) / Math.max(1, Math.min(a.grams, b.grams));
    let r = Math.min(RANK[a.confidence], RANK[b.confidence]);
    if (ratio > 1.5) r = 0; else if (ratio > 1.25) r = Math.min(r, 1);
    out.push({
      name: a.name,
      grams: Math.min(MAX_ITEM_G, g),
      gramsLow: Math.max(1, Math.min(a.gramsLow, b.gramsLow, Math.round(g * (ratio > 1.25 ? 0.85 : 1)))),
      gramsHigh: Math.min(MAX_ITEM_G * 1.2, Math.max(a.gramsHigh, b.gramsHigh, Math.round(g * (ratio > 1.25 ? 1.15 : 1)))),
      confidence: NAME[r],
      basis: a.basis || b.basis,
    });
  });
  poolB.forEach((b) => {
    if (b.grams < 10) return;
    out.push({ ...b, confidence: b.confidence === 'high' ? 'medium' : 'low', gramsLow: Math.max(1, Math.round(b.grams * 0.4)) });
  });
  return out;
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

  const estimateMode = body.mode === 'estimate';
  const hint = typeof body.hint === 'string' ? body.hint.replace(/\s+/g, ' ').trim().slice(0, 300) : '';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: missing API key' });

  // Previous read of this same photo set (the member answered questions, picked a plate size or added a note).
  const prior = (Array.isArray(body.prior) ? body.prior : []).slice(0, 14)
    .map((f) => ({ name: String(f && f.name || '').replace(/\s+/g, ' ').trim().slice(0, 80), grams: Math.round(num(f && f.grams)) }))
    .filter((f) => f.name && f.grams > 0 && f.grams <= MAX_ITEM_G);
  const priorText = prior.length
    ? '\n\nPrevious estimate of this SAME meal, which the member has already seen: ' + prior.map((f) => f.name + ' ' + f.grams + ' g').join('; ') +
      '. Keep each portion and name unless the member note or answers below, or a plate size they gave, clearly change it. Do not change a number just to be different. Update only what the new information affects, and add or remove foods only if the new information says so.'
    : '';

  const content = [];
  list.forEach((im, i) => {
    if (list.length > 1) content.push({ type: 'text', text: 'Photo ' + (i + 1) + ' of ' + list.length + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } });
  });
  content.push({
    type: 'text',
    text: PROMPT + priorText + (hint ? '\n\nMember note (trust this): ' + hint : ''),
  });

  let activeModel = MODEL;
  async function callModel() {
    let response = await postModel(activeModel);
    // A rejected or unknown model name should not take the feature down: fall back once, and stay there.
    if (!response.ok && (response.status === 400 || response.status === 404) && activeModel !== FALLBACK_MODEL) {
      console.error('Photo model rejected, falling back:', activeModel, response.status, await response.text());
      activeModel = FALLBACK_MODEL;
      response = await postModel(activeModel);
    }
    if (!response.ok) {
      console.error('Anthropic API error:', response.status, await response.text());
      return null;
    }
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    return textBlock ? extractJson(textBlock.text) : null;
  }

  function postModel(model) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1800,
        messages: [{ role: 'user', content }],
      }),
    });
  }

  // Phase 2 (only for foods the tracker's list could not match): nutrition for the portion in THIS photo,
  // as it appears (visible oil, sauce, breading, cooking method), not a generic 100 g figure.
  if (estimateMode) {
    const M = require('../lib/micro-estimate.js');
    const asked = (Array.isArray(body.foods) ? body.foods : []).slice(0, 14)
      .map((f) => ({ name: String(f && f.name || '').slice(0, 80), grams: Math.round(num(f && f.grams)), basis: String(f && f.basis || '').slice(0, 80) }))
      .filter((f) => f.name && f.grams > 0 && f.grams <= MAX_ITEM_G);
    if (!asked.length) return res.status(400).json({ error: 'No foods to estimate' });
    const keys = M.KEYS.concat(['cal', 'p', 'c', 'f', 'fiber', 'sodium', 'addedSugar']);
    const ecContent = content.slice(0, -1).concat([{ type: 'text', text: [
      'Using the photo(s), estimate the nutrition of each food below for the PORTION shown, at the weight given. Account for what is visible: oil sheen, sauce, breading, cheese, cooking method. Add the member note if present.',
      'Return ONLY JSON, no fences: {"items":[{"i":0,"v":{' + keys.map((k) => '"' + k + '":number').join(',') + '}}]}',
      'Units: cal kcal; p, c, f, fiber, addedSugar g; sodium mg; ' + M.KEYS.map((k) => k + ' ' + M.UNITS[k]).join('; ') + '. Values are for the whole portion, not per 100 g. Use realistic non-zero values where the food has them.',
      '',
      asked.map((f, i) => i + '. ' + f.name + ' | ' + f.grams + ' g' + (f.basis ? ' | ' + f.basis : '')).join('\n'),
      hint ? '\nMember note (trust this): ' + hint : '',
    ].join('\n') }]);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: activeModel, max_tokens: 400 + asked.length * 420, messages: [{ role: 'user', content: ecContent }] }),
      });
      if (!r.ok) { console.error('Photo estimate HTTP', r.status); return res.status(502).json({ error: 'Estimate unavailable' }); }
      const d = await r.json();
      const tb = (d.content || []).find((b) => b.type === 'text');
      const parsedE = tb ? extractJson(tb.text) : null;
      const estimates = [];
      ((parsedE && parsedE.items) || []).forEach((row) => {
        const f = asked[row.i];
        if (!f || !row.v || !(Number(row.v.cal) >= 0)) return;
        const v = {};
        keys.forEach((k) => { const n = Number(row.v[k]); v[k] = isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; });
        estimates.push({ name: f.name, grams: f.grams, v });
      });
      return res.status(200).json({ estimates, perPortion: true });
    } catch (err) {
      console.error('Photo estimate error:', err);
      return res.status(502).json({ error: 'Estimate unavailable' });
    }
  }

  try {
    // One automatic retry: a malformed or failed first response should not cost the member a re-shoot.
    // Accuracy: read the photo twice in parallel and average (skipped on a re-read that carries a prior estimate,
    // which already anchors the portions). If one read fails, the other stands alone.
    let parsed, second = null;
    if (prior.length) {
      parsed = await callModel();
    } else {
      const pair = await Promise.all([callModel(), callModel()]);
      parsed = pair[0] || pair[1];
      second = pair[0] && pair[1] ? pair[1] : null;
    }
    if (!parsed) parsed = await callModel();
    if (!parsed) return res.status(502).json({ error: 'Could not read that photo' });

    const foods = (second ? mergeRuns(cleanFoods(parsed), cleanFoods(second)) : cleanFoods(parsed)).sort((x, y) => y.grams - x.grams).slice(0, 14);

    let note = typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null;
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : []).slice(0, 3).map((q) => ({
      q: q && typeof q.q === 'string' ? q.q.trim().slice(0, 120) : '',
      options: Array.isArray(q && q.options) ? q.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 4).map((o) => o.trim().slice(0, 40)) : [],
    })).filter((q) => q.q && q.options.length >= 2);
    const totalG = foods.reduce((s, f) => s + f.grams, 0);
    if (totalG > 2500) note = (note ? note + ' ' : '') + 'That is a very large total. Check the grams.';

    const q = parsed.quality && typeof parsed.quality === 'object' ? parsed.quality : {};
    const issue = ['blurry', 'dark', 'too_far', 'glare', 'angle', 'covered'].includes(q.issue) ? q.issue : null;
    const retake = q.usable === false && issue ? RETAKE_TEXT[issue] : null;

    return res.status(200).json({
      isFood: parsed.isFood !== false && foods.length > 0,
      retake,
      retakeIssue: retake ? issue : null,
      mealName: typeof parsed.mealName === 'string' ? parsed.mealName.slice(0, 60) : '',
      foods,
      note,
      questions,
      version: 5,
      reads: second ? 2 : 1,
    });
  } catch (err) {
    console.error('analyze-food-photo error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

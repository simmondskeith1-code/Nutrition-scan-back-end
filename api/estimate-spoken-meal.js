// Vercel serverless function: /api/estimate-spoken-meal
// Turns a spoken or typed description of food ("a handful of potato chips, one Reese's cup, four
// McDonald's french fries") into separate foods with an estimated portion and nutrition for each.
// The tracker shows every estimate with the assumption behind it so the member can fix it.

const M = require('../lib/micro-estimate.js');

const MODEL = process.env.VOICE_MODEL || process.env.PHOTO_MODEL || 'claude-sonnet-5';
const MAX_ITEMS = 12;
const MAX_ITEM_G = 1500;
const MAX_ITEM_KCAL = 2500;
const MACRO_KEYS = ['cal', 'p', 'c', 'f', 'fiber', 'sodium', 'addedSugar'];

const PROMPT = [
  'You are a registered-dietitian-grade nutrition estimator. A person SAID or typed what they ate. Split it into separate foods and estimate the nutrition of the exact portion they described.',
  '',
  'HOW TO SIZE PORTIONS:',
  '- Spoken numbers count: "four fries" is four fries, "one cup" of a candy is one piece, "two slices" is two slices.',
  '- Vague amounts use these anchors: a handful of chips, nuts or snacks is about 28 g (1 oz) for chips and crackers and about 30 g for nuts; a bite is about 10 g; a splash of milk is about 30 ml; a drizzle of oil or dressing is about 1 tbsp; a bowl of cereal is about 1.5 cups; a glass of a drink is about 8 fl oz; a plate of pasta or rice is about 1.5 to 2 cups cooked; a small, medium or large size means that restaurant\'s published size when you know it.',
  '- Branded and restaurant items: use the brand\'s published nutrition when you know it (for example one Reese\'s peanut butter cup is about 21 g and 105 kcal; a McDonald\'s medium fries is about 111 g and 320 kcal, so a single fry is about 4 to 5 g). When you do not know the brand, estimate from the closest typical product and say so.',
  '- Add hidden extras only when the person clearly implies them (fried, buttered, with dressing). Do not invent foods they did not mention.',
  '- If a quantity is missing, assume ONE typical serving and say so in the basis.',
  '- Drinks count when they contain calories. Plain water is skipped.',
  '',
  'Respond with ONLY a JSON object, no fences, no other text:',
  '{"isFood":boolean,"mealName":string,"items":[{"name":string,"qty":string,"grams":number,"confidence":"high"|"medium"|"low","basis":string,"v":{' + MACRO_KEYS.concat(M.KEYS).map((k) => '"' + k + '":number').join(',') + '}}],"note":string|null}',
  'Rules:',
  '- "name" is a short database-style name with the brand when one was said, for example "Reese\'s Peanut Butter Cup" or "McDonald\'s French Fries".',
  '- "qty" is what they said in plain words, for example "4 fries" or "1 handful".',
  '- "grams" is the weight of the portion (or ml for drinks) you used.',
  '- "basis" is one short phrase on how you sized it, for example "1 cup = 21 g, label value" or "handful is about 1 oz".',
  '- "v" holds the nutrition for the WHOLE portion, not per 100 g. Units: cal kcal; p, c, f, fiber, addedSugar g; sodium mg; ' + M.KEYS.map((k) => k + ' ' + M.UNITS[k]).join('; ') + '.',
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

  async function callModel() {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4500,
        messages: [{ role: 'user', content: PROMPT + '\n\nWhat the person said:\n"""' + text + '"""' }],
      }),
    });
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

    const keys = MACRO_KEYS.concat(M.KEYS);
    const items = [];
    (Array.isArray(parsed.items) ? parsed.items : []).slice(0, MAX_ITEMS).forEach((it) => {
      if (!it || typeof it.name !== 'string' || !it.v) return;
      const grams = Math.min(MAX_ITEM_G, Math.round(Number(it.grams) || 0));
      const v = {};
      keys.forEach((k) => { v[k] = clean(it.v, k); });
      if (!(v.cal > 0) || v.cal > MAX_ITEM_KCAL) return;
      const conf = ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium';
      items.push({
        name: it.name.trim().slice(0, 80),
        qty: String(it.qty || '').slice(0, 60),
        grams: grams > 0 ? grams : null,
        confidence: conf,
        basis: String(it.basis || '').slice(0, 120),
        v,
      });
    });
    if (!items.length) return res.status(200).json({ isFood: false, items: [] });
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

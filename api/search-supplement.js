// POST { query: "fish oil" } -> { results: [{ name, brand, servingLabel, servingWeightG, vitA, iron, ... }] }
// Searches the NIH Dietary Supplement Label Database and USDA FoodData Central Branded Foods by name (needs the FDC_API_KEY env var, same one
// lookup-barcode.js uses). Values are scaled to the label's serving size, like the barcode lookup.
const N = {
  vitA: '320', iron: '303', calcium: '301', vitD: '328', potassium: '306', magnesium: '304',
  vitC: '401', vitE: '323', sodium: '307', b6: '415', b12: '418', zinc: '309', vitK: '430',
  folate: '435', choline: '421', biotin: '416',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your domain before real launch
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST requests allowed' });

  const q = String((req.body || {}).query || '').trim().slice(0, 80);
  if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 letters' });
  const apiKey = process.env.FDC_API_KEY;
  if (!apiKey) {
    const only = await require('../lib/dsld.js').searchByName(q, 6).catch(() => []);
    if (only.length) return res.status(200).json({ results: only.map((x) => Object.assign({}, x, { src: 'the NIH label database' })) });
    return res.status(500).json({ error: 'Search is not configured' });
  }

  try {
    // NIH label database first (the Supplement Facts panel as printed), USDA branded foods after it.
    const dsldP = require('../lib/dsld.js').searchByName(q, 6).catch(() => []);
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}`
      + `&query=${encodeURIComponent(q + ' supplement')}&dataType=Branded&pageSize=15`;
    const r = await fetch(url);
    if (!r.ok) {
      console.error('FDC search error:', await r.text());
      const only = await dsldP;
      if (only.length) return res.status(200).json({ results: only.map((x) => Object.assign({}, x, { src: 'the NIH label database' })) });
      return res.status(502).json({ error: 'Search failed' });
    }
    const data = await r.json();
    const results = (data.foods || []).map((f) => {
      const byNum = {};
      (f.foodNutrients || []).forEach((n) => { if (n.nutrientNumber) byNum[n.nutrientNumber] = n.value; });
      const w = f.servingSizeUnit && /^g/i.test(f.servingSizeUnit) && f.servingSize ? Math.round(f.servingSize) : 100;
      const out = {
        name: f.description || 'Product',
        brand: f.brandName || f.brandOwner || '',
        servingLabel: f.householdServingFullText || (f.servingSize ? `${f.servingSize} ${f.servingSizeUnit || ''}`.trim() : '100g'),
        servingWeightG: w,
      };
      Object.keys(N).forEach((k) => {
        const v = byNum[N[k]];
        out[k] = v === undefined || v === null ? null : Math.round(v * (w / 100) * 10) / 10;
      });
      return out;
    }).slice(0, 12);
    const dsldRes = await dsldP;
    const seen = new Set(dsldRes.map((r) => (r.brand + '|' + r.name).toLowerCase()));
    const merged = dsldRes.map((r) => Object.assign({}, r, { src: 'the NIH label database' }))
      .concat(results.filter((r) => !seen.has((r.brand + '|' + r.name).toLowerCase()))).slice(0, 14);
    return res.status(200).json({ results: merged });
  } catch (err) {
    console.error('search-supplement threw:', err);
    return res.status(500).json({ error: 'Search failed' });
  }
};

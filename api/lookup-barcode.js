// Vercel serverless function: /api/lookup-barcode
// Primary source: Edamam Food Database via RapidAPI (unchanged from before — same account,
// same key, same UPC parser). New: if Edamam has no match, this now falls back to Open Food
// Facts (free, no API key required) before giving up. Also tries a couple of barcode digit
// variants against each source, since a scanner can hand back either a 12-digit UPC-A or a
// 13-digit EAN-13 depending on how the physical barcode is printed, and an exact-match lookup
// against the wrong digit count silently misses a product that's actually in the database.
//
// Response shape is unchanged from the Edamam-only version — the client doesn't need to change
// at all. A new "source" field ("edamam" or "openfoodfacts") is added for your own debugging;
// the client can ignore it.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your domain before real launch
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests allowed' });
  }

  const { barcode } = req.body || {};
  if (!barcode) {
    return res.status(400).json({ error: 'No barcode provided' });
  }

  // Barcode variants to try, in order: as scanned, with one leading zero stripped (in case the
  // scanner read a 13-digit EAN-13 but the database has it indexed as 12-digit UPC-A), and with
  // one leading zero added (the reverse case). Duplicates are removed since a barcode with no
  // leading zero to strip, or already at typical max length, would otherwise produce the same
  // string twice.
  const raw = String(barcode).trim();
  const variants = Array.from(new Set([
    raw,
    raw.replace(/^0+/, '') || raw, // stripped (guard against emptying the string entirely)
    '0' + raw,
  ]));

  try {
    const edamamResult = await tryEdamam(variants);
    if (edamamResult) {
      return res.status(200).json(edamamResult);
    }

    const offResult = await tryOpenFoodFacts(variants);
    if (offResult) {
      return res.status(200).json(offResult);
    }

    return res.status(404).json({ error: 'No product found for that barcode' });
  } catch (err) {
    console.error('Barcode lookup handler error:', err);
    return res.status(500).json({ error: 'Server error looking up barcode' });
  }
};

// ---------------- Edamam (primary, unchanged logic, now tried across barcode variants) ----------------

async function tryEdamam(variants) {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (!rapidApiKey) {
    console.error('Edamam skipped: missing RAPIDAPI_KEY env var');
    return null;
  }
  const RAPIDAPI_HOST = 'edamam-food-and-grocery-database.p.rapidapi.com';

  for (const code of variants) {
    try {
      const url = `https://${RAPIDAPI_HOST}/api/food-database/v2/parser?upc=${encodeURIComponent(code)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': rapidApiKey,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Edamam/RapidAPI error for', code, ':', errText);
        continue; // try the next variant rather than failing the whole lookup
      }

      const data = await response.json();

      // "parsed" = an exact UPC match, which comes with a resolved measure/quantity already.
      // "hints" = a looser match list where we have to pick a serving measure ourselves.
      let food, servingWeightG, servingLabel;

      if (data.parsed && data.parsed[0]) {
        const p = data.parsed[0];
        food = p.food;
        servingWeightG = (p.measure && p.measure.weight) || 100;
        servingLabel = (p.measure && p.measure.label) || '100g';
      } else if (data.hints && data.hints[0]) {
        const h = data.hints[0];
        food = h.food;
        const measures = h.measures || [];
        const servingMeasure =
          measures.find((m) => /serving/i.test(m.label)) ||
          measures.find((m) => !/gram/i.test(m.label)) ||
          null;
        servingWeightG = servingMeasure ? servingMeasure.weight : 100;
        servingLabel = servingMeasure ? servingMeasure.label : '100g';
      }

      if (!food) continue; // this variant had no match, try the next one

      const nutrients = food.nutrients || {};
      const factor = servingWeightG / 100; // Edamam nutrients are baseline per-100g

      const scale = (val) => (val === undefined || val === null ? null : Math.round(val * factor * 10) / 10);

      return {
        source: 'edamam',
        name: food.label || 'Scanned Product',
        servingLabel: servingLabel,
        servingWeightG: Math.round(servingWeightG),
        cal: scale(nutrients.ENERC_KCAL),
        protein: scale(nutrients.PROCNT),
        carbs: scale(nutrients.CHOCDF),
        fat: scale(nutrients.FAT),
        fiber: scale(nutrients.FIBTG),
        iron: scale(nutrients.FE),
        calcium: scale(nutrients.CA),
        vitD: scale(nutrients.VITD),
        potassium: scale(nutrients.K),
        magnesium: scale(nutrients.MG),
        vitC: scale(nutrients.VITC),
        vitE: scale(nutrients.TOCPHA),
        sodium: scale(nutrients.NA),
        vitK: scale(nutrients.VITK1),
        // This tier of the Edamam database does not reliably return B6/B12/zinc on
        // branded products — left null; the person can add them manually if the
        // physical label shows them.
        b6: null,
        b12: null,
        zinc: null,
      };
    } catch (innerErr) {
      console.error('Edamam attempt threw for', code, ':', innerErr);
      // keep trying remaining variants
    }
  }

  return null; // no variant matched anything in Edamam
}

// ---------------- Open Food Facts (fallback, free, no API key) ----------------

async function tryOpenFoodFacts(variants) {
  for (const code of variants) {
    try {
      const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'FuelYourFitnessTracker/1.0 (barcode fallback lookup)' },
      });
      if (!response.ok) continue;

      const data = await response.json();
      if (data.status !== 1 || !data.product) continue; // OFF's own "not found" signal

      const product = data.product;
      const n = product.nutriments || {};

      // OFF gives per-100g values directly (already normalized), so no serving-weight scaling
      // is needed the way Edamam requires it — but we still surface the product's own labeled
      // serving size when it has one, so "Servings Eaten" in the calculator lines up with the
      // real package the person is holding rather than a flat 100g assumption.
      const servingWeightG = product.serving_quantity ? Math.round(parseFloat(product.serving_quantity)) : 100;
      const servingLabel = product.serving_size || '100g';

      const num = (v) => (v === undefined || v === null || v === '' ? null : Math.round(parseFloat(v) * 10) / 10);

      // OFF stores sodium in grams per 100g (not mg like everything else here) — this is a
      // known, easy-to-miss unit mismatch with OFF data, converted explicitly below.
      const sodiumMg = n.sodium_100g !== undefined && n.sodium_100g !== null
        ? Math.round(parseFloat(n.sodium_100g) * 1000 * 10) / 10
        : null;

      return {
        source: 'openfoodfacts',
        name: product.product_name || product.generic_name || 'Scanned Product',
        servingLabel: servingLabel,
        servingWeightG: servingWeightG,
        // Per-100g values from OFF, left at 100g basis since that's what the calculator's
        // "Servings Eaten" multiplier is built to scale from.
        cal: num(n['energy-kcal_100g']),
        protein: num(n.proteins_100g),
        carbs: num(n.carbohydrates_100g),
        fat: num(n.fat_100g),
        fiber: num(n.fiber_100g),
        iron: num(n.iron_100g),
        calcium: num(n.calcium_100g),
        vitD: num(n['vitamin-d_100g']),
        potassium: num(n.potassium_100g),
        magnesium: num(n.magnesium_100g),
        vitC: num(n['vitamin-c_100g']),
        vitE: num(n['vitamin-e_100g']),
        sodium: sodiumMg,
        vitK: num(n['vitamin-k_100g']),
        // OFF does carry these for some products (unlike this Edamam tier), but coverage is
        // inconsistent product-to-product — honest null when the field's genuinely absent
        // rather than guessing.
        b6: num(n['vitamin-b6_100g']),
        b12: num(n['vitamin-b12_100g']),
        zinc: num(n.zinc_100g),
      };
    } catch (innerErr) {
      console.error('Open Food Facts attempt threw for', code, ':', innerErr);
      // keep trying remaining variants
    }
  }

  return null; // no variant matched anything in Open Food Facts either
}

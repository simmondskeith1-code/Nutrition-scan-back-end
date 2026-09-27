// Vercel serverless function: /api/lookup-barcode
// Three-tier fallback chain: Edamam Food Database (primary, paid RapidAPI account, unchanged
// logic) → Open Food Facts (free, no key) → USDA FoodData Central Branded Foods (free, needs
// FDC_API_KEY env var). Each tier is tried in turn only if the one before it found nothing.
// Also tries a couple of barcode digit variants against each source, since a scanner can hand
// back either a 12-digit UPC-A or a 13-digit EAN-13 depending on how the physical barcode is
// printed, and an exact-match lookup against the wrong digit count silently misses a product
// that's actually in the database.
//
// Response shape is unchanged from the original Edamam-only version — the client doesn't need
// to change at all. A "source" field ("edamam", "openfoodfacts", or "fdc") is added for your
// own debugging; the client can ignore it.

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

    const fdcResult = await tryFDC(variants);
    if (fdcResult) {
      return res.status(200).json(fdcResult);
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

      // OFF's nutriments are per-100g, but the client displays these numbers as being FOR the
      // reported servingWeightG (e.g. "values shown are per 1 bag (28g)") — so they have to be
      // scaled to the label's actual serving here, the same way the Edamam branch above does.
      // Without this scaling, a 28g bag would show its per-100g calories mislabeled as its
      // per-28g calories, roughly 3.5x too high.
      const servingWeightG = product.serving_quantity ? Math.round(parseFloat(product.serving_quantity)) : 100;
      const servingLabel = product.serving_size || '100g';
      const factor = servingWeightG / 100;

      const num = (v) => (v === undefined || v === null || v === '' ? null : Math.round(parseFloat(v) * factor * 10) / 10);

      // OFF stores sodium in grams per 100g (not mg like everything else here) — converted to
      // mg first, then scaled to the serving like every other field.
      const sodiumMg = n.sodium_100g !== undefined && n.sodium_100g !== null
        ? Math.round(parseFloat(n.sodium_100g) * 1000 * factor * 10) / 10
        : null;

      return {
        source: 'openfoodfacts',
        name: product.product_name || product.generic_name || 'Scanned Product',
        servingLabel: servingLabel,
        servingWeightG: servingWeightG,
        // Scaled from OFF's per-100g basis to the product's actual labeled serving weight.
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

// ---------------- USDA FoodData Central Branded Foods (third fallback, free, needs a key) ----------------

// USDA nutrient numbers are stable, standardized IDs (not name strings, which vary in phrasing
// across records) — mapping by number is the reliable way to pull the right value regardless of
// how a given entry's foodNutrients array is ordered or worded.
var FDC_NUTRIENT_NUMBERS = {
  cal: '208',       // Energy (kcal)
  protein: '203',   // Protein
  fat: '204',       // Total lipid (fat)
  carbs: '205',     // Carbohydrate, by difference
  fiber: '291',     // Fiber, total dietary
  sodium: '307',    // Sodium, Na (mg)
  calcium: '301',   // Calcium, Ca (mg)
  iron: '303',      // Iron, Fe (mg)
  vitC: '401',      // Vitamin C, total ascorbic acid (mg)
  vitD: '328',      // Vitamin D (D2 + D3) (mcg)
  potassium: '306', // Potassium, K (mg)
  magnesium: '304', // Magnesium, Mg (mg)
  vitE: '323',      // Vitamin E (alpha-tocopherol) (mg)
  vitK: '430',      // Vitamin K (phylloquinone) (mcg)
  b6: '415',        // Vitamin B-6 (mg)
  b12: '418',       // Vitamin B-12 (mcg)
  zinc: '309',      // Zinc, Zn (mg)
};

async function tryFDC(variants) {
  const apiKey = process.env.FDC_API_KEY;
  if (!apiKey) {
    console.error('FDC skipped: missing FDC_API_KEY env var');
    return null;
  }

  for (const code of variants) {
    try {
      // FoodData Central has no dedicated "look up by UPC" endpoint — the standard approach is
      // searching with the barcode digits as the query text, scoped to dataType=Branded, then
      // confirming an exact match on the record's own gtinUpc field below. A non-exact search
      // hit is discarded rather than guessed at, so a wrong product never gets logged silently.
      const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}`
        + `&query=${encodeURIComponent(code)}&dataType=Branded&pageSize=25`;
      const response = await fetch(url);
      if (!response.ok) {
        const errText = await response.text();
        console.error('FDC error for', code, ':', errText);
        continue;
      }

      const data = await response.json();
      const foods = data.foods || [];
      const food = foods.find((f) => f.gtinUpc && f.gtinUpc.replace(/^0+/, '') === code.replace(/^0+/, ''));
      if (!food) continue; // no exact-UPC record in this batch of results, try next variant

      const nutrientsByNumber = {};
      (food.foodNutrients || []).forEach((fn) => {
        if (fn.nutrientNumber) nutrientsByNumber[fn.nutrientNumber] = fn.value;
      });

      // Branded Foods nutrient values are reported per 100g regardless of the product's actual
      // serving size — same normalized basis as Open Food Facts — but the client displays these
      // numbers as being FOR the reported servingWeightG, so they get scaled to the label's real
      // serving here too, same as the OFF branch above.
      const servingWeightG = food.servingSizeUnit === 'g' && food.servingSize
        ? Math.round(food.servingSize)
        : 100;
      const servingLabel = food.householdServingFullText
        || (food.servingSize && food.servingSizeUnit ? `${food.servingSize} ${food.servingSizeUnit}` : '100g');
      const factor = servingWeightG / 100;

      const num = (key) => {
        const v = nutrientsByNumber[FDC_NUTRIENT_NUMBERS[key]];
        return v === undefined || v === null ? null : Math.round(v * factor * 10) / 10;
      };

      return {
        source: 'fdc',
        name: food.description || food.brandName || 'Scanned Product',
        servingLabel: servingLabel,
        servingWeightG: servingWeightG,
        cal: num('cal'),
        protein: num('protein'),
        carbs: num('carbs'),
        fat: num('fat'),
        fiber: num('fiber'),
        iron: num('iron'),
        calcium: num('calcium'),
        vitD: num('vitD'),
        potassium: num('potassium'),
        magnesium: num('magnesium'),
        vitC: num('vitC'),
        vitE: num('vitE'),
        sodium: num('sodium'),
        vitK: num('vitK'),
        b6: num('b6'),
        b12: num('b12'),
        zinc: num('zinc'),
      };
    } catch (innerErr) {
      console.error('FDC attempt threw for', code, ':', innerErr);
      // keep trying remaining variants
    }
  }

  return null; // no variant matched an exact-UPC record in FDC either
}

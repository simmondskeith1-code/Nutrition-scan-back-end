// Vercel serverless function: /api/lookup-barcode
// Used by the Fuel Your Fitness tracker's barcode scan. Upgraded so it agrees with Above the Label.
//
// What changed from the old Edamam-first chain:
//  1. The barcode is cleaned first: digits only, UPC-E expanded, check digit verified, then looked up as
//     12, 13 and 14 digit forms so a UPC-A / EAN-13 mismatch cannot silently miss a product.
//  2. Tier 0 is the Above the Label database (members' own label photos). When a member-verified record
//     exists it wins, so both scanners show the same numbers.
//  3. FoodData Central, Edamam (exact UPC match only) and Open Food Facts are asked in parallel. When two
//     sources agree on calories the answer is marked "confirmed"; when they disagree it is marked "disputed"
//     and the other answers come back in "alt" so the app can ask the member instead of guessing.
//  4. Edamam's loose "hints" list (a similar product, not an exact UPC match) is now a last resort and is
//     marked "approximate". The old code accepted it as if it were the scanned product.
//
// Response keeps the old shape and adds: upc, brand, confidence (verified | confirmed | single | disputed |
// approximate), warnings, alt. Optional env var ATL_API_URL points at the Above the Label server.

const ATL_URL = process.env.ATL_API_URL || 'https://live-above-scorecard.onrender.com';

function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

// GS1 check digit for 8, 12, 13 and 14 digit codes.
function gs1Valid(code) {
  const c = digitsOf(code);
  if ([8, 12, 13, 14].indexOf(c.length) === -1) return false;
  let sum = 0;
  const n = c.length - 1;
  for (let i = 0; i < n; i++) sum += (+c[i]) * (((n - 1 - i) % 2 === 0) ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === +c[n];
}

// UPC-E (short code) to the full 12 digit UPC-A. Returns null if it is not a valid UPC-E.
function expandUpcE(code) {
  const c = digitsOf(code);
  const e = c.length === 8 ? c : c.length === 7 ? '0' + c : null;
  if (!e || (e[0] !== '0' && e[0] !== '1')) return null;
  const ns = e[0], d = e.slice(1, 7), chk = e[7], last = d[5];
  let body;
  if ('012'.indexOf(last) !== -1) body = d[0] + d[1] + last + '0000' + d[2] + d[3] + d[4];
  else if (last === '3') body = d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
  else if (last === '4') body = d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
  else body = d[0] + d[1] + d[2] + d[3] + d[4] + '0000' + last;
  const upcA = ns + body + chk;
  return gs1Valid(upcA) ? upcA : null;
}

// Returns { canon, variants } or null when the digits cannot be a real product code.
function cleanBarcode(raw) {
  let d = digitsOf(raw);
  if (d.length === 8 || d.length === 7) {
    const up = expandUpcE(d);
    if (up) d = up;
    else if (d.length === 8 && gs1Valid(d)) { /* a genuine EAN-8, keep it */ }
    else return null;
  }
  if (!gs1Valid(d)) return null;
  const s = d.replace(/^0+/, '');
  if (!s) return null;
  const variants = [];
  [12, 13, 14].forEach(function (n) { if (s.length <= n) variants.push(s.padStart(n, '0')); });
  if (variants.indexOf(s) === -1) variants.push(s);
  return { canon: s.padStart(s.length <= 12 ? 12 : 13, '0'), variants: Array.from(new Set(variants)) };
}

// fetch with a hard timeout so one slow source cannot stall the scan.
async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 5000);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(timer); }
}

// ---------------- Above the Label database (tier 0, members' own label photos) ----------------
async function tryAboveTheLabel(variants) {
  for (const code of variants.slice(0, 2)) {
    try {
      const r = await fetchT(ATL_URL + '/api/scan/nutrition?upc=' + encodeURIComponent(code), { headers: { Accept: 'application/json' } }, 4000);
      if (!r.ok) continue;
      const d = await r.json();
      if (!d || !d.found || !d.nutrition) continue;
      const n = d.nutrition;
      return {
        source: 'abovethelabel',
        verifiedByMember: !!d.memberVerified,
        name: d.name || 'Scanned Product',
        brand: d.brand || '',
        servingLabel: d.servingLabel || (d.servingG ? d.servingG + 'g' : '100g'),
        servingWeightG: d.servingG || 100,
        cal: n.cal == null ? null : n.cal, protein: n.p == null ? null : n.p, carbs: n.c == null ? null : n.c, fat: n.f == null ? null : n.f,
        fiber: n.fiber == null ? null : n.fiber, sodium: n.sodium == null ? null : n.sodium, addedSugar: n.addedSugar == null ? null : n.addedSugar,
        iron: null, calcium: null, vitD: null, potassium: null, magnesium: null, vitC: null, vitE: null, vitK: null, b6: null, b12: null, zinc: null,
      };
    } catch (e) { /* try the next variant */ }
  }
  return null;
}

// ---------------- Choosing between sources ----------------
const PRIORITY = { abovethelabel: 0, fdc: 1, edamam: 2, openfoodfacts: 3 };

function calPer100(r) {
  if (!r || r.cal == null) return null;
  const g = r.servingWeightG || 100;
  return g > 0 ? (r.cal * 100) / g : null;
}
function close(a, b) {
  if (a == null || b == null) return false;
  if (a < 20 && b < 20) return true;
  return Math.abs(a - b) <= 0.25 * Math.max(a, b);
}
// Atwater check: protein and carbs 4 kcal/g, fat 9 kcal/g. Flags numbers that cannot be one real label.
function warningsFor(r) {
  const w = [];
  if (r.cal == null) { w.push('no_calories'); return w; }
  const est = (r.protein || 0) * 4 + (r.carbs || 0) * 4 + (r.fat || 0) * 9;
  if (r.cal > 40 && Math.abs(est - r.cal) > 0.6 * Math.max(est, r.cal)) w.push('macros_do_not_match_calories');
  const per100 = calPer100(r);
  if (per100 != null && per100 > 900) w.push('calories_per_100g_too_high');
  return w;
}
function choose(cands) {
  const list = cands.filter(Boolean).sort(function (a, b) { return PRIORITY[a.source] - PRIORITY[b.source]; });
  if (!list.length) return null;
  const member = list.find(function (r) { return r.source === 'abovethelabel' && r.verifiedByMember; });
  if (member) return finish2(member, 'verified', list);
  const pool = list.filter(function (r) { return !(r.source === 'abovethelabel' && !r.verifiedByMember); });
  if (!pool.length) return null;
  if (pool.length === 1) return finish2(pool[0], 'single', pool);
  // Find the highest-priority source that at least one other source agrees with.
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      if (i !== j && close(calPer100(pool[i]), calPer100(pool[j]))) return finish2(pool[i], 'confirmed', pool);
    }
  }
  return finish2(pool[0], 'disputed', pool);
}
// Supplements: calories mean nothing here (most are zero), so sources are not compared on calories.
// The record that carries the most vitamin and mineral numbers wins; a tie goes to the higher priority source.
const SUPP_KEYS = ['vitA', 'iron', 'calcium', 'vitD', 'potassium', 'magnesium', 'vitC', 'vitE', 'sodium', 'b6', 'b12', 'zinc', 'vitK',
  'folate', 'copper', 'selenium', 'manganese', 'iodine', 'choline', 'biotin', 'dha'];
function microCount(r) { return SUPP_KEYS.filter(function (k) { return r[k] !== null && r[k] !== undefined; }).length; }

function nameTokens(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(function (w) { return w.length > 1; });
}
async function nameFallback(r) {
  const brand = String(r.brand || '').trim();
  const q = ((brand && r.name.toLowerCase().indexOf(brand.toLowerCase()) === 0 ? '' : brand + ' ') + r.name).replace(/\s+/g, ' ').trim();
  const labels = await require('../lib/dsld.js').searchByName(q, 5);
  const want = nameTokens(r.name), bw = nameTokens(brand);
  let best = null, bestScore = 0;
  (labels || []).forEach(function (l) {
    const have = nameTokens(l.name);
    const lb = nameTokens(l.brand || '');
    if (bw.length && !bw.some(function (w) { return lb.indexOf(w) >= 0 || have.indexOf(w) >= 0; })) return;
    const hit = want.filter(function (w) { return have.indexOf(w) >= 0; }).length;
    const score = want.length ? hit / want.length : 0;
    if (score >= 0.5 && score > bestScore) { best = l; bestScore = score; }
  });
  if (!best) return null;
  const out = Object.assign({}, best, { source: 'dsld', confidence: 'approximate', upc: r.upc || null, warnings: ['Matched by product name, not barcode. Check it against your bottle.'] });
  out.microCount = microCount(out);
  return out;
}
function chooseSupplement(cands) {
  const pool = cands.filter(Boolean).filter(function (r) { return !(r.source === 'abovethelabel' && !r.verifiedByMember); })
    .sort(function (a, b) {
      // NIH label data is the panel as printed, so it leads whenever it has numbers; otherwise most numbers wins.
      const da = a.source === 'dsld' && microCount(a) > 0 ? 0 : 1, db = b.source === 'dsld' && microCount(b) > 0 ? 0 : 1;
      return (da - db) || (microCount(b) - microCount(a)) || ((PRIORITY[a.source] || 0) - (PRIORITY[b.source] || 0));
    });
  if (!pool.length) return null;
  const out = Object.assign({}, pool[0]);
  delete out.verifiedByMember;
  out.confidence = out.source === 'abovethelabel' ? 'verified' : (out.source === 'dsld' ? 'label' : 'single');
  out.microCount = microCount(out);
  out.warnings = [];
  return out;
}
function finish2(pick, confidence, all) {
  const out = Object.assign({}, pick);
  delete out.verifiedByMember;
  out.confidence = confidence;
  out.warnings = warningsFor(pick);
  if (confidence === 'disputed') {
    out.alt = all.filter(function (r) { return r !== pick; }).map(function (r) {
      return { source: r.source, name: r.name, brand: r.brand || '', servingLabel: r.servingLabel, cal: r.cal };
    });
  }
  return out;
}

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

  const { barcode, noEstimate, kind } = req.body || {};
  // Nutrients the product record does not carry are estimated and flagged in estimatedKeys.
  // Supplement lookups pass noEstimate: a missing value there means the product has none.
  const finish = async (r) => {
    if (!noEstimate) {
      try { await require('../lib/micro-estimate.js').fillFlat(r, r.name, 'barcode product'); }
      catch (e) { console.error('Barcode estimate failed:', e && e.message); }
    }
    return res.status(200).json(r);
  };
  if (!barcode) {
    return res.status(400).json({ error: 'No barcode provided' });
  }

  const cleaned = cleanBarcode(barcode);
  if (!cleaned) {
    // A misread (check digit fails) would look up the wrong product, so it is refused instead.
    return res.status(422).json({ error: 'Barcode did not read correctly', code: 'bad_barcode' });
  }
  const variants = cleaned.variants;

  try {
    // Ask everything at once. Each tier swallows its own errors and returns null.
    const settled = await Promise.all([
      tryAboveTheLabel(variants).catch(function () { return null; }),
      tryFDC(variants).catch(function () { return null; }),
      tryEdamam(variants, false).catch(function () { return null; }),
      tryOpenFoodFacts(variants).catch(function () { return null; }),
      // Supplements only: the NIH label database holds the Supplement Facts panel itself.
      kind === 'supplement' ? require('../lib/dsld.js').lookupByUpc(variants).catch(function () { return null; }) : null,
    ]);
    let result = kind === 'supplement' ? chooseSupplement(settled) : choose(settled);
    if (!result) {
      // Last resort: Edamam's closest-match list. It may be a similar product, so it is labelled approximate.
      const loose = await tryEdamam(variants, true).catch(function () { return null; });
      if (loose) {
        result = Object.assign({}, loose, { confidence: 'approximate', warnings: warningsFor(loose) });
      }
    }
    if (kind === 'supplement' && result && result.name && microCount(result) === 0) {
      // The barcode named the product but carried no Supplement Facts. Look the product up by name in the NIH label database.
      try {
        const alt = await nameFallback(result);
        if (alt) result = alt;
      } catch (e) { console.error('DSLD name fallback failed:', e && e.message); }
    }
    if (!result) {
      return res.status(404).json({ error: 'No product found for that barcode' });
    }
    result.upc = cleaned.canon;
    return finish(result);
  } catch (err) {
    console.error('Barcode lookup handler error:', err);
    return res.status(500).json({ error: 'Server error looking up barcode' });
  }
};

// ---------------- Edamam (primary, unchanged logic, now tried across barcode variants) ----------------

async function tryEdamam(variants, allowHints) {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (!rapidApiKey) {
    console.error('Edamam skipped: missing RAPIDAPI_KEY env var');
    return null;
  }
  const RAPIDAPI_HOST = 'edamam-food-and-grocery-database.p.rapidapi.com';

  for (const code of variants.slice(0, 2)) {
    try {
      const url = `https://${RAPIDAPI_HOST}/api/food-database/v2/parser?upc=${encodeURIComponent(code)}`;
      const response = await fetchT(url, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': rapidApiKey,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
      }, 4000);

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
      } else if (allowHints && data.hints && data.hints[0]) {
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
        brand: food.brand || '',
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
        // branded products , left null; the person can add them manually if the
        // physical label shows them.
        b6: null,
        b12: null,
        zinc: null,
        // "Added Sugars" is its own line on US Nutrition Facts labels, distinct from total
        // sugar , Edamam exposes it under this separate nutrient key when the brand submitted
        // it, so it gets its own scale() call rather than being folded into SUGAR.
        addedSugar: scale(nutrients['SUGAR.added']),
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
  for (const code of variants.slice(0, 2)) {
    try {
      const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
      const response = await fetchT(url, {
        headers: { 'User-Agent': 'FuelYourFitnessTracker/1.0 (barcode fallback lookup)' },
      }, 4000);
      if (!response.ok) continue;

      const data = await response.json();
      if (data.status !== 1 || !data.product) continue; // OFF's own "not found" signal

      const product = data.product;
      const n = product.nutriments || {};

      // OFF's nutriments are per-100g, but the client displays these numbers as being FOR the
      // reported servingWeightG (e.g. "values shown are per 1 bag (28g)") , so they have to be
      // scaled to the label's actual serving here, the same way the Edamam branch above does.
      // Without this scaling, a 28g bag would show its per-100g calories mislabeled as its
      // per-28g calories, roughly 3.5x too high.
      const servingWeightG = product.serving_quantity ? Math.round(parseFloat(product.serving_quantity)) : 100;
      const servingLabel = product.serving_size || '100g';
      const factor = servingWeightG / 100;

      const num = (v) => (v === undefined || v === null || v === '' ? null : Math.round(parseFloat(v) * factor * 10) / 10);

      // OFF stores sodium in grams per 100g (not mg like everything else here) , converted to
      // mg first, then scaled to the serving like every other field.
      const sodiumMg = n.sodium_100g !== undefined && n.sodium_100g !== null
        ? Math.round(parseFloat(n.sodium_100g) * 1000 * factor * 10) / 10
        : null;

      return {
        source: 'openfoodfacts',
        name: product.product_name || product.generic_name || 'Scanned Product',
        brand: String(product.brands || '').split(',')[0].trim(),
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
        // inconsistent product-to-product , honest null when the field's genuinely absent
        // rather than guessing.
        b6: num(n['vitamin-b6_100g']),
        b12: num(n['vitamin-b12_100g']),
        zinc: num(n.zinc_100g),
        // Sparse but present on some products , OFF's separate "added sugars" field (distinct
        // from total sugars_100g), scaled to serving like everything else here.
        addedSugar: num(n['added-sugars_100g']),
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
// across records) , mapping by number is the reliable way to pull the right value regardless of
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
  addedSugar: '539', // Sugars, added (g) , distinct from total sugars (269)
};

async function tryFDC(variants) {
  const apiKey = process.env.FDC_API_KEY;
  if (!apiKey) {
    console.error('FDC skipped: missing FDC_API_KEY env var');
    return null;
  }

  for (const code of variants.slice(0, 2)) {
    try {
      // FoodData Central has no dedicated "look up by UPC" endpoint , the standard approach is
      // searching with the barcode digits as the query text, scoped to dataType=Branded, then
      // confirming an exact match on the record's own gtinUpc field below. A non-exact search
      // hit is discarded rather than guessed at, so a wrong product never gets logged silently.
      const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}`
        + `&query=${encodeURIComponent(code)}&dataType=Branded&pageSize=25`;
      const response = await fetchT(url, {}, 4000);
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
      // serving size , same normalized basis as Open Food Facts , but the client displays these
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
        brand: food.brandName || food.brandOwner || '',
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
        addedSugar: num('addedSugar'),
      };
    } catch (innerErr) {
      console.error('FDC attempt threw for', code, ':', innerErr);
      // keep trying remaining variants
    }
  }

  return null; // no variant matched an exact-UPC record in FDC either
}

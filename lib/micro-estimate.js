// Shared micronutrient estimator. Real values (from a label, a database or the member) are never
// overwritten: this only fills the gaps, so every food the tracker shows carries all 23 nutrients.
// Values are estimates (USDA-style knowledge of the food and its typical recipe) and are flagged.
//
// Set MICRO_MODEL to change the model. Failure is silent by design: a slow or failed estimate must
// never block a search, scan or photo result, the item just comes back without the extra numbers.

var KEYS = ['magnesium', 'b12', 'b6', 'b1', 'b2', 'b3', 'zinc', 'vitC', 'vitD', 'potassium', 'calcium', 'dha', 'choline',
  'vitE', 'folate', 'copper', 'manganese', 'selenium', 'iron', 'iodine', 'vitA', 'vitK', 'biotin'];
var UNITS = {
  magnesium: 'mg', b12: 'mcg', b6: 'mg', b1: 'mg', b2: 'mg', b3: 'mg', zinc: 'mg', vitC: 'mg', vitD: 'mcg', potassium: 'mg', calcium: 'mg',
  dha: 'mg', choline: 'mg', vitE: 'mg', folate: 'mcg', copper: 'mcg', manganese: 'mg', selenium: 'mcg',
  iron: 'mg', iodine: 'mcg', vitA: 'mcg RAE', vitK: 'mcg', biotin: 'mcg'
};
// Hard ceilings per 1000 kcal-ish portion are not knowable, so use generous absolute caps per portion.
var CAP = { magnesium: 1500, b12: 400, b6: 40, b1: 100, b2: 100, b3: 500, zinc: 80, vitC: 1500, vitD: 400, potassium: 8000, calcium: 3000,
  dha: 6000, choline: 1500, vitE: 150, folate: 3000, copper: 6000, manganese: 60, selenium: 1200, iron: 120,
  iodine: 4000, vitA: 30000, vitK: 5000, biotin: 3000 };
var MODEL = process.env.MICRO_MODEL || 'claude-haiku-5-5';
var CACHE = new Map();

function keyFor(it) {
  var m = it.macros || {};
  return [String(it.name || '').toLowerCase(), String(it.context || '').toLowerCase().slice(0, 80),
    Math.round(m.cal || 0), Math.round(m.p || 0), Math.round(m.c || 0), Math.round(m.f || 0), it.grams || ''].join('|');
}
function fmt(x) { return x == null || isNaN(Number(x)) ? '?' : Math.round(Number(x) * 10) / 10; }
function missingKeys(have, treatZeroAsMissing) {
  return KEYS.filter(function (k) {
    var v = have ? have[k] : undefined;
    if (v === undefined || v === null || v === '' || isNaN(Number(v))) return true;
    return treatZeroAsMissing && Number(v) === 0;
  });
}

// items: [{ name, context, macros:{cal,p,c,f,fiber,sodium}, grams?, have:{...known micros}, need:[keys], needMacros? }]
// "macros" and every returned number refer to the SAME portion (per 100 g, per serving, whatever the caller used).
// Returns an array aligned with items: { micros:{key:number}, macros?:{...} } or null.
async function estimate(items, opts) {
  opts = opts || {};
  var apiKey = process.env.ANTHROPIC_API_KEY;
  var out = new Array(items.length).fill(null);
  if (!apiKey || !items.length) return out;

  var todo = [];
  items.forEach(function (it, i) {
    if (!it.need || !it.need.length) return;
    var hit = CACHE.get(keyFor(it));
    if (hit && !it.needMacros) {
      var sub = {};
      it.need.forEach(function (k) { if (hit[k] !== undefined) sub[k] = hit[k]; });
      if (Object.keys(sub).length === it.need.length) { out[i] = { micros: sub }; return; }
    }
    todo.push(i);
  });
  if (!todo.length) return out;

  var lines = todo.map(function (i, n) {
    var it = items[i], m = it.macros || {};
    return n + '. ' + it.name + (it.context ? ' [' + it.context + ']' : '') +
      (it.needMacros ? '' : ' | portion macros: ' + fmt(m.cal) + ' kcal, protein ' + fmt(m.p) + ' g, carbs ' + fmt(m.c) + ' g, fat ' + fmt(m.f) + ' g, fiber ' + fmt(m.fiber) + ' g, sodium ' + fmt(m.sodium) + ' mg') +
      (it.grams ? ' | portion weight ' + it.grams + ' g' : '') +
      ' | need: ' + it.need.join(',') + (it.needMacros ? ',cal,p,c,f,fiber,sodium,addedSugar' : '');
  });
  var prompt = [
    'You are a registered dietitian filling a nutrition database. For each food below, estimate the requested nutrients using USDA FoodData Central values and the food\'s typical recipe or formulation (fortified products carry fortified amounts).',
    'Every number you return is for the SAME portion the macros describe (if no macros are given, per 100 g). Do not output per-100 g unless that is the portion.',
    'Units: ' + KEYS.map(function (k) { return k + ' ' + UNITS[k]; }).join('; ') + '; cal kcal; p, c, f, fiber, addedSugar in g; sodium mg.',
    'Be realistic, not zero by default: most foods have some magnesium, potassium, B6, thiamin (b1), riboflavin (b2), niacin (b3), selenium, manganese, folate. Use 0 only when the food truly has none (for example B12 in fruit).',
    'Respond with ONLY JSON, no fences: {"items":[{"i":0,"v":{"key":number,...}}]} with exactly the requested keys per item.',
    '', lines.join('\n')
  ].join('\n');

  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, opts.timeoutMs || 7000);
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: Math.min(8000, 200 + todo.length * 330), messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) { console.error('MICRO_ESTIMATE_HTTP', r.status); return out; }
    var data = await r.json();
    var tb = (data.content || []).find(function (b) { return b.type === 'text'; });
    if (!tb) return out;
    var parsed = JSON.parse(tb.text.replace(/```json|```/g, '').trim());
    (parsed.items || []).forEach(function (row) {
      var idx = todo[row.i];
      if (idx === undefined || !row.v) return;
      var it = items[idx], micros = {}, macros = {};
      it.need.forEach(function (k) {
        var v = Number(row.v[k]);
        if (isFinite(v) && v >= 0) micros[k] = Math.round(Math.min(v, CAP[k]) * 100) / 100;
      });
      if (it.needMacros) ['cal', 'p', 'c', 'f', 'fiber', 'sodium', 'addedSugar'].forEach(function (k) {
        var v = Number(row.v[k]);
        if (isFinite(v) && v >= 0) macros[k] = Math.round(v * 10) / 10;
      });
      out[idx] = { micros: micros, macros: it.needMacros ? macros : undefined };
      if (!it.needMacros) {
        if (CACHE.size > 800) CACHE.delete(CACHE.keys().next().value);
        var prev = CACHE.get(keyFor(it)) || {};
        CACHE.set(keyFor(it), Object.assign(prev, micros));
      }
    });
  } catch (e) {
    console.error('MICRO_ESTIMATE_FAILED', e && e.message);
  } finally { clearTimeout(timer); }
  return out;
}

// Fill gaps on result objects whose nutrient fields sit directly on them (label and barcode shape).
// obj: { cal, protein, carbs, fat, fiber, sodium, iron, ... } for one serving. Mutates and returns obj.
async function fillFlat(obj, name, context, opts) {
  var have = {};
  KEYS.forEach(function (k) { if (obj[k] !== undefined) have[k] = obj[k]; });
  var need = missingKeys(have, false);
  if (!need.length) { obj.estimatedKeys = []; return obj; }
  var res = (await estimate([{ name: name || 'packaged food', context: context, grams: obj.servingWeightG,
    macros: { cal: obj.cal, p: obj.protein, c: obj.carbs, f: obj.fat, fiber: obj.fiber, sodium: obj.sodium }, need: need }], opts))[0];
  obj.estimatedKeys = [];
  need.forEach(function (k) {
    if (res && res.micros[k] !== undefined) { obj[k] = res.micros[k]; obj.estimatedKeys.push(k); }
    else if (obj[k] === undefined) obj[k] = null;
  });
  return obj;
}

// Fill gaps on restaurant-style results: { name, brandName, servingGrams, per100:{cal,p,c,f,...,micros} }.
async function fillPer100(results, opts) {
  opts = opts || {};
  var treatZero = opts.treatZeroAsMissing !== false;
  var jobs = [], idxs = [];
  results.forEach(function (r, i) {
    var need = missingKeys(r.per100, treatZero || r.source === 'fatsecret');
    if (!need.length) return;
    jobs.push({ name: r.name, context: r.brandName || '', macros: { cal: r.per100.cal, p: r.per100.p, c: r.per100.c, f: r.per100.f, fiber: r.per100.fiber, sodium: r.per100.sodium }, grams: 100, need: need });
    idxs.push(i);
  });
  if (!jobs.length) return results;
  var est = await estimate(jobs, opts);
  est.forEach(function (e, j) {
    if (!e) return;
    var r = results[idxs[j]];
    r.microsEstimated = r.microsEstimated || [];
    jobs[j].need.forEach(function (k) {
      if (e.micros[k] === undefined) return;
      r.per100[k] = e.micros[k];
      r.microsEstimated.push(k);
    });
  });
  return results;
}

module.exports = { KEYS: KEYS, UNITS: UNITS, estimate: estimate, fillFlat: fillFlat, fillPer100: fillPer100, missingKeys: missingKeys };

// NIH Office of Dietary Supplements, Dietary Supplement Label Database (DSLD), public API v9, no key needed.
// Docs: https://api.ods.od.nih.gov/dsld/v9   Endpoints used (all GET):
//   /v9/search-filter?q=...&status=1        search label records ("q" searches across label fields)
//   /v9/label/{id}                          one full label: ingredientRows[], servingSizes[], fullName, brandName, upcSku
// DSLD publishes what the manufacturer printed on the Supplement Facts panel, so amounts are per label serving.
// Every call has a short timeout and swallows its own errors: DSLD being slow or down must never break a lookup.

const BASE = 'https://api.ods.od.nih.gov/dsld/v9';

async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 3500);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// ---- unit helpers: every amount becomes the unit the tracker stores ----
function unitKind(u) {
  const s = String(u || '').toLowerCase().trim();
  if (/^(mcg|µg|ug)/.test(s)) return 'mcg';
  if (/^mg/.test(s)) return 'mg';
  if (/^g(ram)?s?\b|^g$/.test(s)) return 'g';
  if (/^iu\b|^i\.u\./.test(s)) return 'iu';
  return null;
}
function toUnit(q, unit, want) { // want: 'mg' or 'mcg'
  const k = unitKind(unit);
  if (!k || !(q >= 0)) return null;
  const mcg = k === 'mcg' ? q : k === 'mg' ? q * 1000 : k === 'g' ? q * 1e6 : null;
  if (mcg === null) return null;
  return want === 'mg' ? mcg / 1000 : mcg;
}

// [key, name pattern, want unit, special]
const RULES = [
  ['vitA', /^vitamin a\b|^retinol|^retinyl/, 'mcg', 'vitA'],
  ['vitD', /^vitamin d\b|^vitamin d[23]\b|^cholecalciferol|^ergocalciferol/, 'mcg', 'vitD'],
  ['vitE', /^vitamin e\b|^tocopherol|^d-alpha|^dl-alpha/, 'mg', 'vitE'],
  ['vitC', /^vitamin c\b|^ascorbic acid/, 'mg'],
  ['vitK', /^vitamin k\b|^vitamin k[12]\b|^phylloquinone|^menaquinone/, 'mcg'],
  ['b6', /^vitamin b-?6\b|^pyridoxine|^pyridoxal/, 'mg'],
  ['b12', /^vitamin b-?12\b|^cobalamin|^cyanocobalamin|^methylcobalamin/, 'mcg'],
  ['folate', /^folate\b|^folic acid|^folacin|^5-mthf|^l-methylfolate/, 'mcg', 'folate'],
  ['biotin', /^biotin/, 'mcg'],
  ['choline', /^choline/, 'mg'],
  ['iron', /^iron\b/, 'mg'],
  ['calcium', /^calcium\b/, 'mg'],
  ['magnesium', /^magnesium\b/, 'mg'],
  ['zinc', /^zinc\b/, 'mg'],
  ['potassium', /^potassium\b/, 'mg'],
  ['sodium', /^sodium\b/, 'mg'],
  ['copper', /^copper\b/, 'mcg'],
  ['selenium', /^selenium\b/, 'mcg'],
  ['manganese', /^manganese\b/, 'mg'],
  ['iodine', /^iodine\b/, 'mcg'],
  ['dha', /^dha\b|^docosahexaenoic/, 'mg'],
];
const KEYS = RULES.map((r) => r[0]);

function servingOf(label) {
  const s = (Array.isArray(label.servingSizes) ? label.servingSizes : [])[0];
  if (!s) return { q: null, unit: null, text: null };
  const q = Number(s.minQuantity);
  const unit = String(s.unit || '').replace(/\(s\)/g, '').trim();
  return { q: isFinite(q) && q > 0 ? q : null, unit, text: isFinite(q) && q > 0 ? (q + ' ' + unit).trim() : null };
}
// A row can list the amount for several servings; use the one for the label's first serving, else the first listed.
function pickQuantity(row, serving) {
  const list = Array.isArray(row.quantity) ? row.quantity : [];
  if (!list.length) return null;
  const match = serving.q ? list.find((x) => Number(x.servingSizeQuantity) === serving.q) : null;
  return match || list[0];
}

function parseLabel(label) {
  if (!label || typeof label !== 'object') return null;
  const serving = servingOf(label);
  const out = {}; KEYS.forEach((k) => { out[k] = null; });
  const extras = [], notes = [];
  const rows = Array.isArray(label.ingredientRows) ? label.ingredientRows : [];
  rows.forEach((row) => {
    const name = String(row.ingredientGroup || row.name || '').trim();
    const rowName = String(row.name || '').trim();
    const q = pickQuantity(row, serving);
    const amount = q ? Number(q.quantity) : NaN;
    const unit = q ? q.unit : '';
    const lower = (name + '|' + rowName).toLowerCase();
    let handled = false;
    for (let i = 0; i < RULES.length; i++) {
      const [key, re, want, special] = RULES[i];
      if (!(re.test(name.toLowerCase()) || re.test(rowName.toLowerCase()))) continue;
      handled = true;
      if (!isFinite(amount) || amount < 0 || out[key] !== null) break; // first listed row for a nutrient wins, so nested forms never double count
      const k = unitKind(unit);
      let v = null;
      if (special === 'vitD' && k === 'iu') { v = amount / 40; notes.push('Vitamin D converted from IU to mcg.'); }
      else if (special === 'vitA' && k === 'iu') { v = amount * (/beta.?carotene/.test(lower) ? 0.15 : 0.3); notes.push('Vitamin A converted from IU to mcg RAE.'); }
      else if (special === 'vitE' && k === 'iu') { v = amount * (/\bdl-|synthetic/.test(lower) ? 0.45 : 0.67); notes.push('Vitamin E converted from IU to mg.'); }
      else if (special === 'folate' && k === 'mcg' && !/dfe/i.test(unit) && /folic acid/.test(lower)) { v = amount * 1.7; notes.push('Folic acid converted to mcg DFE.'); }
      else v = toUnit(amount, unit, want);
      if (v !== null && isFinite(v)) out[key] = Math.round(v * 100) / 100;
      break;
    }
    if (!handled && rowName && extras.length < 12 && !/^(other ingredients?|calories|total fat|total carbohydrates?|saturated fat|trans fat|cholesterol|dietary fiber)\b/i.test(rowName)) {
      extras.push({ name: rowName.slice(0, 60), amount: isFinite(amount) ? amount : null, unit: String(unit || '').slice(0, 12) });
    }
  });
  const count = KEYS.filter((k) => out[k] !== null).length;
  return Object.assign(out, {
    source: 'dsld',
    name: label.fullName ? String(label.fullName).slice(0, 100) : null,
    brand: label.brandName ? String(label.brandName).slice(0, 60) : null,
    servingLabel: serving.text,
    servingWeightG: null,
    extras, notes: Array.from(new Set(notes)).slice(0, 4),
    confidence: 'label',
    microCount: count,
    dsldId: label.id || null,
    upc: label.upcSku ? String(label.upcSku) : null,
    cal: null,
  });
}

// ---- UPC lookup. DSLD stores upcSku inconsistently (digits only, or spaced like "0 33674 79320 6"), so each form is tried. ----
const digits = (s) => String(s || '').replace(/\D/g, '');
function probeForms(variants) {
  const forms = [];
  (variants || []).forEach((v) => {
    const d = digits(v); if (!d) return;
    forms.push(d);
    if (d.length === 12) forms.push(d[0] + ' ' + d.slice(1, 6) + ' ' + d.slice(6, 11) + ' ' + d[11]);
    if (d.length === 13 && d[0] === '0') { const u = d.slice(1); forms.push(u[0] + ' ' + u.slice(1, 6) + ' ' + u.slice(6, 11) + ' ' + u[11]); }
  });
  return Array.from(new Set(forms)).slice(0, 5);
}
function hitsOf(d) {
  if (!d) return [];
  if (Array.isArray(d.hits)) return d.hits;
  if (d.hits && Array.isArray(d.hits.hits)) return d.hits.hits;
  return [];
}
function idOf(h) { return (h && (h._source && h._source.id)) || (h && h._id) || null; }
function sameUpc(a, b) { const x = digits(a).replace(/^0+/, ''), y = digits(b).replace(/^0+/, ''); return !!x && x === y; }

async function lookupByUpc(variants, opts) {
  const o = opts || {};
  const wanted = (variants || []).map(digits).filter(Boolean);
  const forms = probeForms(variants);
  for (let i = 0; i < forms.length; i++) {
    const d = await getJson(BASE + '/search-filter?status=1&size=5&q=' + encodeURIComponent('"' + forms[i] + '"'), o.ms);
    const hits = hitsOf(d);
    for (let j = 0; j < hits.length && j < 5; j++) {
      const id = idOf(hits[j]); if (!id) continue;
      const src = hits[j]._source || {};
      // Search covers every label field, so a hit only counts when its own UPC matches.
      if (src.upcSku && !wanted.some((w) => sameUpc(w, src.upcSku))) continue;
      const label = await getJson(BASE + '/label/' + encodeURIComponent(id), o.ms);
      if (!label) continue;
      if (!label.upcSku || !wanted.some((w) => sameUpc(w, label.upcSku))) continue;
      const parsed = parseLabel(label);
      if (parsed && (parsed.microCount > 0 || parsed.extras.length)) return parsed;
    }
  }
  return null;
}

async function searchByName(q, n, opts) {
  const o = opts || {};
  const d = await getJson(BASE + '/search-filter?status=1&size=' + Math.min(8, n || 6) + '&q=' + encodeURIComponent(q), o.ms);
  const ids = hitsOf(d).map(idOf).filter(Boolean).slice(0, n || 6);
  const labels = await Promise.all(ids.map((id) => getJson(BASE + '/label/' + encodeURIComponent(id), o.ms)));
    return labels.map(parseLabel).filter((r) => r && r.name && (r.microCount > 0 || (r.extras && r.extras.length)));
}

module.exports = { parseLabel, lookupByUpc, searchByName, probeForms, getJson, BASE };

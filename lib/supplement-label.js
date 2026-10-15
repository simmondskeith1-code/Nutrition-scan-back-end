// Reads a SUPPLEMENT FACTS panel (vitamin, mineral and supplement bottles) with Claude's vision API.
// Different from a Nutrition Facts label: servings are capsules or scoops, amounts come in IU, mcg DFE or mcg RAE,
// and many lines are not nutrients the tracker follows. Returns the same flat keys the tracker already uses,
// plus the serving it read, other active ingredients, and plain-language notes about any conversion or doubt.

const MODEL = process.env.SCAN_MODEL || 'claude-sonnet-5-5';
const FALLBACK_MODEL = process.env.SCAN_MODEL_FALLBACK || 'claude-sonnet-5';
const KEYS = ['vitA', 'iron', 'calcium', 'vitD', 'potassium', 'magnesium', 'vitC', 'vitE', 'sodium', 'b6', 'b12', 'zinc', 'vitK',
  'folate', 'copper', 'selenium', 'manganese', 'iodine', 'choline', 'biotin', 'dha'];
const UNITS = { vitA: 'mcg RAE', iron: 'mg', calcium: 'mg', vitD: 'mcg', potassium: 'mg', magnesium: 'mg', vitC: 'mg', vitE: 'mg', sodium: 'mg', b6: 'mg', b12: 'mcg',
  zinc: 'mg', vitK: 'mcg', folate: 'mcg DFE', copper: 'mcg', selenium: 'mcg', manganese: 'mg', iodine: 'mcg', choline: 'mg', biotin: 'mcg', dha: 'mg' };
// A single serving above these is almost always a unit slip (IU read as mcg, mg read as mcg). The value is kept, with a note.
const CHECK_ABOVE = { vitA: 10000, iron: 100, calcium: 3000, vitD: 2500, potassium: 3000, magnesium: 1500, vitC: 5000, vitE: 1000, sodium: 3000, b6: 500, b12: 20000,
  zinc: 150, vitK: 2000, folate: 5000, copper: 10000, selenium: 1000, manganese: 50, iodine: 1000, choline: 2000, biotin: 20000, dha: 3000 };

const PROMPT = [
  'This is a photo of a SUPPLEMENT FACTS (or Nutrition Facts) panel on a vitamin, mineral or supplement bottle. Read the amounts for ONE serving, exactly as the panel defines its serving (for example "2 capsules" or "1 scoop").',
  'If the panel has several columns (per capsule and per serving, or adult and child), use the column for the Serving Size printed at the top of the panel. If the label is curved, partly cut off, blurry, dark or glared, read what you can and say so in "issue".',
  'Respond with ONLY a JSON object, no other text, no markdown fences, in this shape:',
  '{ "readable": boolean, "issue": "blurry" | "dark" | "glare" | "cropped" | "curved" | null, "productName": string | null, "brand": string | null,',
  '  "servingLabel": string | null, "servingsPerContainer": number | null,',
  '  "nutrients": { ' + KEYS.map((k) => '"' + k + '": number | null').join(', ') + ' },',
  '  "extras": [ { "name": string, "amount": number | null, "unit": string } ],',
  '  "notes": [ string ] }',
  'Units for "nutrients" (convert to these): ' + KEYS.map((k) => k + ' in ' + UNITS[k]).join('; ') + '.',
  'Conversions when the panel uses other units, and say each one you apply in "notes": vitamin D IU to mcg: divide by 40. Vitamin A: use mcg RAE when printed; if only IU, retinol or retinyl acetate or palmitate IU times 0.3 gives mcg RAE, beta-carotene IU times 0.15 gives mcg RAE. Vitamin E: use mg when printed; if only IU, natural d-alpha-tocopherol IU times 0.67 gives mg, synthetic dl-alpha-tocopherol IU times 0.45 gives mg. Folate: use mcg DFE (not the folic acid figure in brackets). Biotin, copper and selenium: mg to mcg multiply by 1000. DHA: only the DHA line, in mg (not total omega-3). Sodium and potassium in mg.',
  'Rules: use null for any nutrient the panel does not print. Never use the % Daily Value as an amount. Do not guess. If a line is a "proprietary blend" with one total, do not split it, put the blend in "extras". Put every other active ingredient (herbs, amino acids, probiotics, CoQ10, creatine and so on) in "extras" with its amount and unit, at most 12.',
  '"notes": at most 4 short plain sentences about conversions, unclear numbers or anything the member should double check. Empty array if none.',
].join('\n');

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch (e) { /* fall through */ } }
  return null;
}

const RETAKE = {
  blurry: 'The label is blurry. Hold steady, about 6 to 8 inches away, and try again.',
  dark: 'The label is too dark. Move near a window or turn on a light and try again.',
  glare: 'Glare is covering the label. Tilt the bottle away from the light and try again.',
  cropped: 'Part of the label is cut off. Fit the whole Supplement Facts panel in the photo and try again.',
  curved: 'The label curves away at the edges. Turn the bottle so the panel faces the camera, and shoot straight on.',
};

async function readSupplementLabel(apiKey, base64, mediaType) {
  const body = (model) => JSON.stringify({
    model, max_tokens: 1500,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }, { type: 'text', text: PROMPT }] }],
  });
  const post = (model) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: body(model),
  });
  let model = MODEL;
  const call = async () => {
    let r = await post(model);
    if (!r.ok && (r.status === 400 || r.status === 404) && model !== FALLBACK_MODEL) { console.error('Supplement label model rejected:', model, r.status); model = FALLBACK_MODEL; r = await post(model); }
    if (!r.ok) { console.error('Supplement label API error:', r.status, (await r.text()).slice(0, 300)); return null; }
    const d = await r.json();
    const tb = (d.content || []).find((b) => b.type === 'text');
    return tb ? extractJson(tb.text) : null;
  };
  let parsed = await call();
  if (!parsed) parsed = await call(); // one retry: a malformed first answer should not cost the member a reshoot
  return parsed;
}

function shape(parsed) {
  const n = parsed && typeof parsed.nutrients === 'object' && parsed.nutrients ? parsed.nutrients : {};
  const out = {};
  const notes = (Array.isArray(parsed.notes) ? parsed.notes : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 4);
  let count = 0;
  KEYS.forEach((k) => {
    const v = Number(n[k]);
    if (n[k] === null || n[k] === undefined || !isFinite(v) || v < 0) { out[k] = null; return; }
    out[k] = Math.round(v * 100) / 100; count++;
    if (v > CHECK_ABOVE[k]) notes.push('Check ' + k + ': ' + out[k] + ' ' + UNITS[k] + ' per serving is very high. Make sure the unit is right.');
  });
  const extras = (Array.isArray(parsed.extras) ? parsed.extras : []).slice(0, 12).map((e) => ({
    name: String(e && e.name || '').trim().slice(0, 60),
    amount: isFinite(Number(e && e.amount)) && e && e.amount !== null ? Number(e.amount) : null,
    unit: String(e && e.unit || '').trim().slice(0, 12),
  })).filter((e) => e.name);
  const issue = Object.prototype.hasOwnProperty.call(RETAKE, parsed.issue) ? parsed.issue : null;
  const sp = Number(parsed.servingsPerContainer);
  return Object.assign(out, {
    name: typeof parsed.productName === 'string' && parsed.productName.trim() ? parsed.productName.trim().slice(0, 80) : null,
    brand: typeof parsed.brand === 'string' && parsed.brand.trim() ? parsed.brand.trim().slice(0, 60) : null,
    servingLabel: typeof parsed.servingLabel === 'string' && parsed.servingLabel.trim() ? parsed.servingLabel.trim().slice(0, 60) : null,
    servingsPerContainer: isFinite(sp) && sp > 0 && sp < 5000 ? sp : null,
    extras, notes: notes.slice(0, 6),
    nutrientCount: count,
    readable: parsed.readable !== false && (count > 0 || extras.length > 0),
    issue, retake: issue ? RETAKE[issue] : null,
    kind: 'supplement',
  });
}

module.exports = { readSupplementLabel, shape, KEYS, RETAKE };

// Vercel serverless function: /api/scan-ingredients
// Clean Scan sends up to 3 photos of a package (ingredient list, nutrition facts, front).
// Claude reads them and returns the product name, brand, the ingredient list word for word,
// seals (Organic, Non-GMO, Bioengineered) and the key nutrition facts per serving.
// Uses the same ANTHROPIC_API_KEY the label scanner already uses.

module.exports.config = { api: { bodyParser: { sizeLimit: '12mb' } } };

const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST requests allowed' });

  const images = ((req.body && req.body.images) || []).filter(i => i && i.imageBase64).slice(0, 3);
  if (!images.length) return res.status(400).json({ error: 'No image provided' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: missing API key' });

  const prompt = [
    'These are photos of one packaged food product (ingredient list, nutrition facts panel, and/or front of the package).',
    'Respond with ONLY a JSON object, no other text, no markdown fences, in this exact shape:',
    '{',
    '  "name": string or null,          // product name from the front, e.g. "Creamy Peanut Butter"',
    '  "brand": string or null,',
    '  "ingredients": string or null,   // the full ingredient list copied WORD FOR WORD, keeping parentheses, commas and "contains 2% or less of". Do not include the allergen "Contains:" line.',
    '  "organic": boolean,              // true only if a USDA Organic seal or "organic" product claim is visible',
    '  "nonGmo": boolean,               // true only if a Non-GMO Project Verified seal or "Non-GMO" claim is visible',
    '  "bioengineered": boolean,        // true only if "bioengineered" or "derived from bioengineering" or the BE symbol is visible',
    '  "servingLabel": string or null,  // e.g. "2 tbsp (32g)"',
    '  "servingG": number or null,      // serving size in grams',
    '  "cal": number or null, "p": number or null, "c": number or null, "f": number or null,',
    '  "satFat": number or null, "fiber": number or null, "sugar": number or null,',
    '  "addedSugar": number or null,    // the "Includes Xg Added Sugars" line, grams. Not total sugars.',
    '  "sodium": number or null         // milligrams',
    '}',
    'All nutrition values are PER SERVING exactly as printed. Grams for p (protein), c (carbs), f (fat), satFat, fiber, sugar, addedSugar.',
    'If something is not visible in the photos, use null (or false for the seals). Never guess.'
  ].join('\n');

  const content = images.map(i => ({
    type: 'image',
    source: { type: 'base64', media_type: SUPPORTED.includes(i.mediaType) ? i.mediaType : 'image/jpeg', data: i.imageBase64 }
  }));
  content.push({ type: 'text', text: prompt });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1500, messages: [{ role: 'user', content }] })
    });
    if (!response.ok) {
      console.error('Anthropic API error:', await response.text());
      return res.status(502).json({ error: 'Vision API request failed' });
    }
    const data = await response.json();
    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    let parsed;
    try {
      const raw = text.replace(/```json|```/g, '').replace(/,?\s*\/\/[^\n"]*$/gm, m => (m.trim().startsWith(',') ? ',' : '')).trim();
      parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    } catch (e) {
      console.error('Could not parse:', text);
      return res.status(502).json({ error: 'Could not read the label. Try a clearer photo.' });
    }
    const num = k => (typeof parsed[k] === 'number' && isFinite(parsed[k]) ? parsed[k] : null);
    const str = (k, n) => (typeof parsed[k] === 'string' && parsed[k].trim() ? parsed[k].trim().slice(0, n) : null);
    return res.status(200).json({
      name: str('name', 120), brand: str('brand', 80), ingredients: str('ingredients', 4000),
      organic: parsed.organic === true, nonGmo: parsed.nonGmo === true, bioengineered: parsed.bioengineered === true,
      servingLabel: str('servingLabel', 60), servingG: num('servingG'),
      serving: { cal: num('cal'), p: num('p'), c: num('c'), f: num('f'), satFat: num('satFat'), fiber: num('fiber'), sugar: num('sugar'), addedSugar: num('addedSugar'), sodium: num('sodium') }
    });
  } catch (err) {
    console.error('scan-ingredients error:', err);
    return res.status(500).json({ error: 'Server error reading the photos' });
  }
};

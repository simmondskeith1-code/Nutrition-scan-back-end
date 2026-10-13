// Vercel serverless function: /api/analyze-food-photo
// Receives a photo of a meal, asks Claude's vision API to identify each food and estimate grams,
// and returns a list the tracker matches against its own food database. Calories, macros and
// micronutrients are NOT guessed here: the front end computes them from its database so numbers
// stay consistent with everything else the user logs.

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb',
    },
  },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your domain before real launch
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST requests allowed' });

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const safeMediaType = SUPPORTED.includes(mediaType) ? mediaType : 'image/jpeg';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: missing API key' });

  const promptText = [
    'This is a photo of a meal or food. Identify each distinct food item visible and estimate its weight in grams as eaten (cooked weight for cooked foods).',
    'Respond with ONLY a JSON object in this exact shape, no other text, no markdown fences:',
    '{',
    '  "isFood": boolean,',
    '  "foods": [',
    '    { "name": string, "grams": number, "confidence": "high" | "medium" | "low" }',
    '  ],',
    '  "note": string | null',
    '}',
    'Rules:',
    '- Use plain generic food names a nutrition database would have (e.g. "grilled chicken breast", "white rice cooked", "broccoli steamed", "olive oil").',
    '- List cooking fats, sauces and dressings as separate items only if clearly visible.',
    '- Do not list plates, utensils or drinks that are plain water.',
    '- Estimate grams using plate size and typical portions. Prefer a realistic estimate over zero.',
    '- If the photo is not food, set isFood to false and foods to an empty array.',
    '- "note" is one short sentence only if something affects accuracy (hidden food, mixed dish, unclear portion); otherwise null.',
    '- Maximum 12 items.',
  ].join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 700,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: safeMediaType, data: imageBase64 } },
              { type: 'text', text: promptText },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error('Anthropic API error:', await response.text());
      return res.status(502).json({ error: 'Vision API request failed' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No text in vision API response' });

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse model output as JSON:', textBlock.text);
      return res.status(502).json({ error: 'Could not parse photo analysis' });
    }

    const foods = (Array.isArray(parsed.foods) ? parsed.foods : [])
      .filter((f) => f && typeof f.name === 'string' && isFinite(Number(f.grams)) && Number(f.grams) > 0)
      .slice(0, 12)
      .map((f) => ({
        name: String(f.name).slice(0, 80),
        grams: Math.min(2000, Math.round(Number(f.grams))),
        confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium',
      }));

    return res.status(200).json({
      isFood: parsed.isFood !== false && foods.length > 0,
      foods,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null,
    });
  } catch (err) {
    console.error('analyze-food-photo error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

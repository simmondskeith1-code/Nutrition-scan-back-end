// Vercel serverless function: /api/scan-label
// Receives a nutrition label photo, sends it to Claude's vision API, returns structured nutrition data.

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb', // room for a phone photo
    },
  },
};

module.exports = async function handler(req, res) {
  // Only allow requests from your actual site, not just anyone
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten this to your domain before real launch, see note below
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests allowed' });
  }

  const { imageBase64, mediaType } = req.body || {};

  if (!imageBase64) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing API key' });
  }

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
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/jpeg',
                  data: imageBase64,
                },
              },
              {
                type: 'text',
                text: 'This is a photo of a nutrition facts label. Read the values for calories, protein (g), total carbohydrate (g), and total fat (g) for one serving as printed on the label. Respond with ONLY a JSON object in this exact shape, no other text: {"cal": number, "protein": number, "carbs": number, "fat": number}. If a value truly cannot be read, use null for that field.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      return res.status(502).json({ error: 'Vision API request failed' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No text in vision API response' });
    }

    // Strip markdown fences if the model wrapped its JSON in them
    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse model output as JSON:', textBlock.text);
      return res.status(502).json({ error: 'Could not parse label data' });
    }

    return res.status(200).json({
      cal: parsed.cal ?? null,
      protein: parsed.protein ?? null,
      carbs: parsed.carbs ?? null,
      fat: parsed.fat ?? null,
    });
  } catch (err) {
    console.error('Scan-label handler error:', err);
    return res.status(500).json({ error: 'Server error processing image' });
  }
};

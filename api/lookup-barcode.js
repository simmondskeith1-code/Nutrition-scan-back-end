// Vercel serverless function: /api/lookup-barcode
// Receives a UPC/EAN barcode number, looks it up against Edamam's Food Database via RapidAPI,
// returns nutrition scaled to the product's actual labeled serving size (not a flat 100g),
// so it lines up with the calculator's "Servings Eaten" multiplier.

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

  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (!rapidApiKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing RapidAPI key' });
  }

  const RAPIDAPI_HOST = 'edamam-food-and-grocery-database.p.rapidapi.com';

  try {
    const url = `https://${RAPIDAPI_HOST}/api/food-database/v2/parser?upc=${encodeURIComponent(barcode)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': rapidApiKey,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Edamam/RapidAPI error:', errText);
      return res.status(502).json({ error: 'Barcode lookup failed' });
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
      // Prefer a measure literally called "Serving"; otherwise take the first non-gram measure;
      // otherwise fall back to 100g.
      const servingMeasure =
        measures.find((m) => /serving/i.test(m.label)) ||
        measures.find((m) => !/gram/i.test(m.label)) ||
        null;
      servingWeightG = servingMeasure ? servingMeasure.weight : 100;
      servingLabel = servingMeasure ? servingMeasure.label : '100g';
    }

    if (!food) {
      return res.status(404).json({ error: 'No product found for that barcode' });
    }

    const nutrients = food.nutrients || {};
    const factor = servingWeightG / 100; // nutrients from Edamam are baseline per-100g

    const scale = (val) => (val === undefined || val === null ? null : Math.round(val * factor * 10) / 10);

    return res.status(200).json({
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
    });
  } catch (err) {
    console.error('Barcode lookup handler error:', err);
    return res.status(500).json({ error: 'Server error looking up barcode' });
  }
};

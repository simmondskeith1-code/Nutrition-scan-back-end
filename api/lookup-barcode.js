// Vercel serverless function: /api/lookup-barcode
// Receives a UPC/EAN barcode number, looks it up against Edamam's Food Database via RapidAPI,
// returns calories/macros and whatever micronutrients Edamam has for that product.

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

    // Edamam returns matches in "hints" (or "parsed" for exact matches). Take the first usable one.
    const match = (data.parsed && data.parsed[0]) || (data.hints && data.hints[0]);
    if (!match || !match.food) {
      return res.status(404).json({ error: 'No product found for that barcode' });
    }

    const food = match.food;
    const nutrients = food.nutrients || {};

    // Edamam's base nutrients are per 100g. The frontend scales these the same way it
    // scales the USDA database foods.
    return res.status(200).json({
      name: food.label || 'Scanned Product',
      cal: nutrients.ENERC_KCAL ?? null,
      protein: nutrients.PROCNT ?? null,
      carbs: nutrients.CHOCDF ?? null,
      fat: nutrients.FAT ?? null,
      fiber: nutrients.FIBTG ?? null,
      iron: nutrients.FE ?? null,
      calcium: nutrients.CA ?? null,
      vitD: nutrients.VITD ?? null,
      potassium: nutrients.K ?? null,
      magnesium: nutrients.MG ?? null,
      vitC: nutrients.VITC ?? null,
      vitE: nutrients.TOCPHA ?? null,
      sodium: nutrients.NA ?? null,
      vitK: nutrients.VITK1 ?? null,
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

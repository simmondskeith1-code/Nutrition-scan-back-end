// api/restaurant-search.js
//
// Drop this into the same backend project that already serves /api/scan-label and
// /api/lookup-barcode (nutrition-scan-back-end.vercel.app), replacing the old Nutritionix
// version. If that project uses a different export style (ESM `export default`, or a
// framework wrapper), match this logic to that file's existing convention rather than
// copy-pasting this verbatim.
//
// WHY FATSECRET INSTEAD OF NUTRITIONIX: Nutritionix closed free self-serve signup — new
// accounts now require a sales conversation. FatSecret's Platform API still has a real free
// self-serve tier (register, get keys same-day, 5,000 calls/day, no cost, no sales call) and
// covers restaurant/branded items the same way Nutritionix did.
//
// SETUP REQUIRED before this does anything:
//   1. You already registered a free FatSecret Platform API account at
//      https://platform.fatsecret.com/register
//   2. In your FatSecret developer dashboard, create/open your application and copy its
//      Client ID and Client Secret (FatSecret's older docs sometimes call the same pair
//      "Consumer Key" / "Consumer Secret" — same credentials, same flow, just older naming).
//   3. In the Vercel project's settings -> Environment Variables, add:
//        FATSECRET_CLIENT_ID = <your client id>
//        FATSECRET_CLIENT_SECRET = <your client secret>
//      Never put these in the client-side HTML file — that's the entire reason this lookup
//      goes through a backend instead of calling FatSecret directly from the browser.
//   4. Redeploy. The client already points at:
//        https://nutrition-scan-back-end.vercel.app/api/restaurant-search?query=...
//      so once this file is live at that path, the app's Restaurant / Fast Food search starts
//      returning real results with no further client changes — same URL as before, same
//      response shape the client already expects.
//
// HOW IT WORKS: FatSecret's OAuth2 uses a client-credentials grant — this backend exchanges
// your Client ID/Secret for a bearer token (valid 24h, cached across warm invocations of this
// function so it isn't re-requested on every single search) and then calls the v5 food search
// endpoint, which — unlike Nutritionix — returns full nutrition data for each result in the
// SAME call. No second "look up this specific item" request needed.
//
// WHAT IT RETURNS: calories, protein, carbs, fat, fiber, and sodium, same as before, plus a
// genuine improvement over the old Nutritionix backend: FatSecret also returns iron, calcium,
// vitamin A, vitamin C, and vitamin D for branded items "where available." That's real bonus
// micronutrient coverage restaurant-menu data never had before — but "where available" is
// FatSecret's own wording, meaning it's still frequently 0 for a given item. That's honest
// missing data, not a bug in this file.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your app's real origin once this is confirmed working
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var query = (req.query && req.query.query ? String(req.query.query) : '').trim();
  if (!query) {
    res.status(400).json({ error: 'Missing query parameter' });
    return;
  }

  var clientId = process.env.FATSECRET_CLIENT_ID;
  var clientSecret = process.env.FATSECRET_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: 'FatSecret credentials not configured on the server' });
    return;
  }

  try {
    var token = await getAccessToken(clientId, clientSecret);

    // food_type=brand restricts results to branded/restaurant items only, matching what the
    // old Nutritionix branded_type=1 filter did.
    var searchUrl = 'https://platform.fatsecret.com/rest/foods/search/v5?search_expression='
      + encodeURIComponent(query) + '&food_type=brand&max_results=10&format=json';
    var searchResp = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (!searchResp.ok) {
      res.status(502).json({ error: 'FatSecret search request failed' });
      return;
    }
    var searchData = await searchResp.json();
    var foodsWrap = searchData.foods_search && searchData.foods_search.results;
    var foodsRaw = foodsWrap ? foodsWrap.food : null;
    if (!foodsRaw) {
      res.status(404).json({ error: 'No matching restaurant items found' });
      return;
    }
    // FatSecret (like a lot of XML-derived JSON APIs) returns a bare object instead of a
    // one-item array when there's only a single match — normalize both shapes.
    var foodsList = Array.isArray(foodsRaw) ? foodsRaw : [foodsRaw];

    var results = foodsList.map(function(food) {
      var servingsRaw = food.servings && food.servings.serving;
      if (!servingsRaw) return null;
      var servings = Array.isArray(servingsRaw) ? servingsRaw : [servingsRaw];

      // Prefer a serving already expressed in grams or ounces so normalizing to per-100g is
      // exact instead of guessed from a vague "1 serving" description with no weight attached.
      var serving = servings.filter(function(s) {
        return s.metric_serving_unit === 'g' || s.metric_serving_unit === 'oz';
      })[0] || servings[0];

      var grams = null;
      if (serving.metric_serving_unit === 'g') grams = parseFloat(serving.metric_serving_amount);
      else if (serving.metric_serving_unit === 'oz') grams = parseFloat(serving.metric_serving_amount) * 28.3495;
      if (!grams || grams <= 0) grams = 100; // no usable weight on this serving - best effort fallback
      var factor = 100 / grams;

      var num = function(v) { return (v !== undefined && v !== null && v !== '') ? parseFloat(v) : 0; };

      return {
        name: food.food_name,
        brandName: food.brand_name || '',
        servingName: serving.serving_description || (grams + ' g'),
        servingGrams: grams,
        per100: {
          cal: round1(num(serving.calories) * factor),
          p: round1(num(serving.protein) * factor),
          c: round1(num(serving.carbohydrate) * factor),
          f: round1(num(serving.fat) * factor),
          fiber: round1(num(serving.fiber) * factor),
          sodium: round1(num(serving.sodium) * factor),
          // Bonus over the old Nutritionix backend - see the file-header note above.
          iron: round1(num(serving.iron) * factor),
          calcium: round1(num(serving.calcium) * factor),
          vitA: round1(num(serving.vitamin_a) * factor),
          vitC: round1(num(serving.vitamin_c) * factor),
          vitD: round1(num(serving.vitamin_d) * factor)
        }
      };
    }).filter(Boolean);

    if (results.length === 0) {
      res.status(404).json({ error: 'No matching restaurant items found' });
      return;
    }

    res.status(200).json({ results: results });
  } catch (err) {
    res.status(502).json({ error: 'Restaurant lookup failed' });
  }
};

// Cached at module scope so a warm serverless instance reuses the same token across requests
// instead of hitting the OAuth endpoint on every single search - tokens are valid 24h.
var cachedToken = null;
var cachedTokenExpiry = 0;

async function getAccessToken(clientId, clientSecret) {
  var now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) return cachedToken;

  var basicAuth = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  var resp = await fetch('https://oauth.fatsecret.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + basicAuth
    },
    body: 'grant_type=client_credentials&scope=basic'
  });
  if (!resp.ok) throw new Error('FatSecret token request failed');
  var data = await resp.json();

  cachedToken = data.access_token;
  // Refresh 5 minutes before actual expiry so a request landing right at the boundary never
  // gets handed a token that dies mid-flight.
  cachedTokenExpiry = now + (data.expires_in - 300) * 1000;
  return cachedToken;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

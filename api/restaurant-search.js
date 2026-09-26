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
// WHY THIS IS A TWO-STEP LOOKUP (search, then a detail call per result), same shape as the
// old Nutritionix version: FatSecret's newer v5 search endpoint returns full nutrition data
// in one call, but that endpoint is gated to their paid "Premier" scope and silently fails on
// a free account (returns an internal error instead of a normal HTTP error, which is its own
// FatSecret quirk, not something this file can work around). The v1 search endpoint below
// works on the free tier, but only returns a text description, not structured fields — so a
// second call to the (free-tier-compatible) food detail endpoint pulls the real numbers for
// each match, the same two-step shape the Nutritionix version always used.
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

    // v1 search works on the free "Basic" scope (v5 does not - see file-header note). It has
    // no food_type filter param, so it returns generic and branded foods mixed together; we
    // filter to food_type === 'Brand' ourselves below to keep only restaurant/branded items.
    var searchUrl = 'https://platform.fatsecret.com/rest/foods/search/v1?search_expression='
      + encodeURIComponent(query) + '&max_results=50&format=json';
    var searchResp = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (!searchResp.ok) {
      res.status(502).json({ error: 'FatSecret search request failed' });
      return;
    }
    var searchData = await searchResp.json();
    if (searchData.error) {
      // FatSecret returns HTTP 200 with an {error:{...}} body for account/scope problems
      // (e.g. a Premier-only call on a free account) instead of a normal HTTP error status,
      // so this has to be checked explicitly rather than relying on searchResp.ok.
      res.status(502).json({ error: 'FatSecret error: ' + (searchData.error.message || searchData.error.code) });
      return;
    }
    var foodsWrap = searchData.foods;
    var foodsRaw = foodsWrap ? foodsWrap.food : null;
    if (!foodsRaw) {
      res.status(404).json({ error: 'No matching restaurant items found' });
      return;
    }
    // FatSecret (like a lot of XML-derived JSON APIs) returns a bare object instead of a
    // one-item array when there's only a single match — normalize both shapes.
    var foodsList = Array.isArray(foodsRaw) ? foodsRaw : [foodsRaw];

    var branded = foodsList.filter(function(f) { return f.food_type === 'Brand'; }).slice(0, 8);
    if (branded.length === 0) {
      res.status(404).json({ error: 'No matching restaurant items found' });
      return;
    }

    var results = await Promise.all(branded.map(async function(item) {
      try {
        var detailUrl = 'https://platform.fatsecret.com/rest/food/v5?food_id=' + item.food_id + '&format=json';
        var detailResp = await fetch(detailUrl, { headers: { Authorization: 'Bearer ' + token } });
        if (!detailResp.ok) return null;
        var detailData = await detailResp.json();
        if (detailData.error) return null;
        var food = detailData.food;
        if (!food) return null;

        var servingsRaw = food.servings && food.servings.serving;
        if (!servingsRaw) return null;
        var servings = Array.isArray(servingsRaw) ? servingsRaw : [servingsRaw];

        // Prefer the standardized "100 g" serving FatSecret gives brand items (serving_id "0")
        // when present — no conversion math needed, most exact option available. Otherwise
        // fall back to any serving already expressed in grams or ounces.
        var serving = servings.filter(function(s) { return s.serving_id === '0'; })[0]
          || servings.filter(function(s) { return s.metric_serving_unit === 'g' || s.metric_serving_unit === 'oz'; })[0]
          || servings[0];

        var grams = null;
        if (serving.metric_serving_unit === 'g') grams = parseFloat(serving.metric_serving_amount);
        else if (serving.metric_serving_unit === 'oz') grams = parseFloat(serving.metric_serving_amount) * 28.3495;
        if (!grams || grams <= 0) grams = 100; // no usable weight on this serving - best effort fallback
        var factor = 100 / grams;

        var num = function(v) { return (v !== undefined && v !== null && v !== '') ? parseFloat(v) : 0; };

        return {
          name: food.food_name,
          brandName: food.brand_name || item.brand_name || '',
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
      } catch (innerErr) {
        return null;
      }
    }));

    var cleanResults = results.filter(Boolean);
    if (cleanResults.length === 0) {
      res.status(404).json({ error: 'No matching restaurant items found' });
      return;
    }

    res.status(200).json({ results: cleanResults });
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

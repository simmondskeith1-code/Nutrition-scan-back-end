// api/restaurant-search.js
//
// Drop this into the same backend project that already serves /api/scan-label and
// /api/lookup-barcode (nutrition-scan-back-end.vercel.app), replacing whatever version is
// currently live at this path. If that project uses a different export style (ESM
// `export default`, or a framework wrapper), match this logic to that file's existing
// convention rather than copy-pasting this verbatim.
//
// PREMIER TIER, ONE-CALL SEARCH: this version assumes the FatSecret account has been granted
// Premier tier and uses foods.search.v3, which returns full structured nutrition for every
// serving directly in the search response. That replaces the old two-step design (a free-tier
// v1 search returning only a text description, then a separate food.get detail call per
// result) with a single call per search. Faster, and roughly 1/9th the API calls for a typical
// 8-result search. If this account ever drops back to a free/non-Premier tier, this file will
// start failing (FatSecret gates v3 behind the "premier" OAuth scope) — see the older two-step
// version in this project's git history if that happens.
//
// SETUP REQUIRED before this does anything:
//   1. FatSecret Platform API account with Premier tier granted at
//      https://platform.fatsecret.com
//   2. In your FatSecret developer dashboard, create/open your application and copy its
//      Client ID and Client Secret (FatSecret's older docs sometimes call the same pair
//      "Consumer Key" / "Consumer Secret" — same credentials, same flow, just older naming).
//   3. In the Vercel project's settings -> Environment Variables, add:
//        FATSECRET_CLIENT_ID = <your client id>
//        FATSECRET_CLIENT_SECRET = <your client secret>
//      Never put these in the client-side HTML file — that's the entire reason this lookup
//      goes through a backend instead of calling FatSecret directly from the browser.
//   4. In the FatSecret dashboard, under API Keys -> Manage -> IP Restriction, whitelist
//      0.0.0.0/0 (allow any IP) — Vercel serverless functions run from a rotating pool of AWS
//      addresses, not one fixed IP, so a single-IP or narrow-range whitelist will not work.
//      FatSecret's own docs say this can take up to 24 hours to take effect.
//   5. Redeploy. The client already points at:
//        https://nutrition-scan-back-end.vercel.app/api/restaurant-search?query=...
//      so once this file is live at that path, the app's Restaurant / Fast Food search starts
//      returning real results with no further client changes — same URL as before, same
//      response shape the client already expects.
//   6. FatSecret's attribution requirement is separate from any of the above and does not get
//      satisfied by this file alone — it has to be added to (a) the app UI wherever these
//      results are shown, (b) the site's public pages. See platform.fatsecret.com's
//      attribution policy for the exact snippet.
//
// WHAT IT RETURNS: calories, protein, carbs, fat, fiber, and sodium, plus (where FatSecret has
// the data for a given item, still frequently 0 — that's honest missing data, not a bug here)
// iron, calcium, vitamin A, vitamin C, vitamin D, and now added sugars. Added sugars specifically
// was never available from the old free-tier two-step version at all; v3 exposes it directly.

// LOCAL SPOTS: small local restaurants (Monmouth County, Atlantic City, Gilroy area) that publish no nutrition facts. Their items live
// in data/local-spots.json as estimates (USDA ingredient data + typical portions), and are returned
// first, ahead of FatSecret, in the same shape the tracker already reads. To add a restaurant, add
// its items to that file and redeploy. No tracker change needed.
var LOCAL = require('../data/local-spots.json');
function norm(s) { return String(s || '').toLowerCase().replace(/['\u2019]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
var ADDONS_BY_SPOT = {};
LOCAL.items.forEach(function(it) {
  if (it.name.indexOf('Add-on: ') !== 0) return;
  (ADDONS_BY_SPOT[it.spot] = ADDONS_BY_SPOT[it.spot] || []).push(it);
});
// Add-ons are offered as toppings on the matching dish, not as standalone search results.
var LOCAL_INDEX = LOCAL.items.filter(function(it) { return it.name.indexOf('Add-on: ') !== 0; }).map(function(it) {
  var spot = LOCAL.spots[it.spot] || {};
  return { it: it, spotText: ' ' + norm([it.spot].concat(spot.aliases || []).join(' ')) + ' ', text: ' ' + norm(it.name) + ' ' };
});
// "on 1 slice of a 12-inch pie" add-ons only fit that exact slice; "1 portion" add-ons fit any non-slice dish.
function addonsFor(it) {
  var list = ADDONS_BY_SPOT[it.spot] || [];
  var isSlice = /slice/.test(it.servingName);
  return list.filter(function(a) {
    if (a.servingName === '1 portion') return !isSlice;
    return a.servingName === 'on ' + it.servingName;
  }).map(function(a) {
    return Object.assign({ name: a.name.replace('Add-on: ', ''), cal: a.cal, p: a.p, c: a.c, f: a.f, fiber: a.fiber, sodium: a.sodium, addedSugar: a.addedSugar }, a.m || {});
  });
}
function localSearch(query) {
  var words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  var hits = LOCAL_INDEX.filter(function(x) {
    var all = x.spotText + x.text;
    return words.every(function(w) { return all.indexOf(w) > -1; });
  });
  // Items whose own name matches the query rank above items that only match the restaurant name.
  hits.sort(function(a, b) {
    var sa = words.filter(function(w) { return a.text.indexOf(w) > -1; }).length;
    var sb = words.filter(function(w) { return b.text.indexOf(w) > -1; }).length;
    return sb - sa;
  });
  return hits.slice(0, 40).map(function(x) {
    var it = x.it, f = 100 / it.servingGrams;
    // Micronutrients: estimated from each ingredient's USDA values (same food data the tracker uses).
    var micro = {};
    Object.keys(it.m || {}).forEach(function(k) { micro[k] = Math.round(it.m[k] * f * 100) / 100; });
    return {
      name: it.name,
      brandName: it.spot + ' (local, estimated)',
      servingName: it.servingName,
      servingGrams: it.servingGrams,
      estimated: true,
      addons: addonsFor(it),
      per100: Object.assign({ iron: 0, calcium: 0, vitA: 0, vitC: 0, vitD: 0 }, micro, {
        cal: round1(it.cal * f), p: round1(it.p * f), c: round1(it.c * f), f: round1(it.f * f),
        fiber: round1(it.fiber * f), sodium: round1(it.sodium * f), addedSugar: round1(it.addedSugar * f)
      })
    };
  });
}

async function handler(req, res) {
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

  var local = req.query.skipLocal ? [] : localSearch(query);
  if (local.length) {
    // Local matches first. FatSecret is still asked for chain results, but any failure there
    // just means the member sees the local items alone.
    var fsResults = [];
    try { fsResults = await fatsecretSearch(query); } catch (e) { console.error('FATSECRET_WITH_LOCAL_FAILED', e && e.message); }
    res.status(200).json({ results: local.concat(fsResults) });
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

    // v3 requires the "premier" OAuth scope (see getAccessToken below) and returns full
    // nutrition per serving in this one response — no food_type filter param exists, so
    // generic and branded foods still come back mixed together; filtered to food_type ===
    // 'Brand' ourselves below to keep only restaurant/branded items.
    var searchUrl = 'https://platform.fatsecret.com/rest/foods/search/v3?search_expression='
      + encodeURIComponent(query) + '&max_results=50&format=json';
    var searchResp = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (!searchResp.ok) {
      console.error('FATSECRET_SEARCH_HTTP_ERROR', searchResp.status);
      res.status(502).json({ error: 'Restaurant search is temporarily unavailable. Log it as a Packaged Meal below instead.' });
      return;
    }
    var searchData = await searchResp.json();
    if (searchData.error) {
      // FatSecret returns HTTP 200 with an {error:{...}} body for account/scope problems
      // instead of a normal HTTP error status, so this has to be checked explicitly rather
      // than relying on searchResp.ok. If Premier ever lapses on this account, this is the
      // error shape that will start showing up here. The raw FatSecret error (often internal
      // jargon like a scope/tier code) goes to the server log only, tagged so it's greppable in
      // Vercel's logs — a paying member sees a plain, actionable message instead of raw API text.
      console.error('FATSECRET_AUTH_OR_TIER_ISSUE', searchData.error.code, searchData.error.message);
      res.status(502).json({ error: 'Restaurant search is temporarily unavailable. Log it as a Packaged Meal below instead.' });
      return;
    }
    var foodsWrap = searchData.foods_search && searchData.foods_search.results;
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

    var num = function(v) { return (v !== undefined && v !== null && v !== '') ? parseFloat(v) : 0; };

    var results = branded.map(function(food) {
      var servingsRaw = food.servings && food.servings.serving;
      if (!servingsRaw) return null;
      var servings = Array.isArray(servingsRaw) ? servingsRaw : [servingsRaw];

      // Prefer the real menu serving (FatSecret's default, e.g. "1 sandwich") so the member logs what
      // they actually ate. The standardized 100 g serving (serving_id "0") is only a fallback.
      var hasWeight = function(s) { return (s.metric_serving_unit === 'g' || s.metric_serving_unit === 'oz') && parseFloat(s.metric_serving_amount) > 0; };
      var serving = servings.filter(function(s) { return s.is_default === '1' && hasWeight(s); })[0]
        || servings.filter(function(s) { return s.serving_id !== '0' && hasWeight(s); })[0]
        || servings.filter(function(s) { return s.serving_id === '0'; })[0]
        || servings[0];

      var grams = null;
      if (serving.metric_serving_unit === 'g') grams = parseFloat(serving.metric_serving_amount);
      else if (serving.metric_serving_unit === 'oz') grams = parseFloat(serving.metric_serving_amount) * 28.3495;
      if (!grams || grams <= 0) grams = 100; // no usable weight on this serving - best effort fallback
      var factor = 100 / grams;

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
          addedSugar: round1(num(serving.added_sugars) * factor),
          iron: round1(num(serving.iron) * factor),
          calcium: round1(num(serving.calcium) * factor),
          vitA: round1(num(serving.vitamin_a) * factor),
          vitC: round1(num(serving.vitamin_c) * factor),
          vitD: round1(num(serving.vitamin_d) * factor),
          potassium: round1(num(serving.potassium) * factor)
        }
      };
    });

    var cleanResults = results.filter(Boolean);
    if (cleanResults.length === 0) {
      res.status(404).json({ error: 'No matching restaurant items found' });
      return;
    }

    res.status(200).json({ results: cleanResults });
  } catch (err) {
    // getAccessToken throwing here almost always means the OAuth token request itself failed —
    // check this specific log line first if restaurant search ever goes down, since it's the
    // most likely sign Premier access lapsed (rather than a one-off network blip).
    console.error('FATSECRET_REQUEST_FAILED', err && err.message);
    res.status(502).json({ error: 'Restaurant search is temporarily unavailable. Log it as a Packaged Meal below instead.' });
  }
}
module.exports = handler;

// Runs the FatSecret path above without sending a response, so local results can be combined with it.
function fatsecretSearch(query) {
  return new Promise(function(resolve, reject) {
    var fake = {
      code: 200,
      setHeader: function() {}, end: function() {},
      status: function(c) { this.code = c; return this; },
      json: function(j) {
        if (this.code === 200) resolve((j && j.results) || []);
        else if (this.code === 404) resolve([]);
        else reject(new Error((j && j.error) || ('status ' + this.code)));
      }
    };
    handler({ method: 'GET', query: { query: query, skipLocal: '1' } }, fake).catch(reject);
  });
}

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
    // foods.search.v3 is gated to the "premier" scope - a plain "basic" token (as the old
    // free-tier version of this file requested) gets a valid token that then fails on this
    // specific endpoint with an account/scope error, not an auth error, so the scope has to
    // be requested correctly here, not caught by retrying the search call.
    body: 'grant_type=client_credentials&scope=premier'
  });
  if (!resp.ok) {
    var bodyText = await resp.text().catch(function() { return ''; });
    throw new Error('FatSecret token request failed (' + resp.status + '): ' + bodyText);
  }
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

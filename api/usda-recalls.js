// Vercel serverless function: /api/usda-recalls
// Fetches USDA FSIS meat, poultry and egg recalls from Vercel's servers (USDA blocks Render's),
// trims them, and returns them to the Render server's recall alerts. Cached for 6 hours.
const URL = 'https://www.fsis.usda.gov/fsis/api/recall/v/1?field_recall_classification_id=10&field_archive_recall=0&field_translation_language=en';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.fsis.usda.gov/recalls'
};
const KEEP = ['field_title', 'field_recall_number', 'field_recall_date', 'field_recall_reason', 'field_establishment',
  'field_states', 'field_product_items', 'field_active_notice', 'field_recall_classification', 'field_risk_level'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(URL, { headers: HEADERS, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: 'USDA returned HTTP ' + r.status, detail: text.slice(0, 200) });
    let data;
    try { data = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'USDA did not return JSON', detail: text.slice(0, 200) }); }
    if (!Array.isArray(data)) return res.status(502).json({ error: 'Unexpected USDA response' });
    const since = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
    const recalls = data.filter(x => (x.field_recall_date || '') >= since)
      .map(x => Object.fromEntries(KEEP.map(k => [k, x[k] == null ? '' : x[k]])));
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({ updatedAt: new Date().toISOString(), count: recalls.length, recalls });
  } catch (e) {
    return res.status(504).json({ error: 'Could not reach USDA: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  } finally { clearTimeout(t); }
};

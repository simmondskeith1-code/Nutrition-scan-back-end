// Open in a browser to confirm the NIH label database is reachable and being read correctly:
//   /api/dsld-check?upc=033674793206      shows each step of a barcode lookup
//   /api/dsld-check?q=vitamin%20d3        shows a name search
// Read only. Returns what the server saw, so a mismatch with the live API shows up here first.
const D = require('../lib/dsld.js');
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = req.query || {};
  const out = { api: D.BASE };
  try {
    if (q.upc) {
      const digits = String(q.upc).replace(/\D/g, '');
      out.forms = D.probeForms([digits]);
      out.probes = [];
      for (const f of out.forms) {
        const raw = await D.getJson(D.BASE + '/search-filter?status=1&size=3&q=' + encodeURIComponent('"' + f + '"'), 6000);
        const hits = raw ? (Array.isArray(raw.hits) ? raw.hits : (raw.hits && raw.hits.hits) || []) : [];
        out.probes.push({ form: f, reachable: !!raw, topLevelKeys: raw ? Object.keys(raw) : null, hitCount: hits.length, firstHitKeys: hits[0] ? Object.keys(hits[0]._source || hits[0]) : null, firstHitUpc: hits[0] && hits[0]._source ? hits[0]._source.upcSku : null });
      }
      out.result = await D.lookupByUpc([digits], { ms: 6000 });
    } else if (q.q) {
      out.results = await D.searchByName(String(q.q).slice(0, 80), 4, { ms: 6000 });
    } else {
      out.help = 'Add ?upc=033674793206 or ?q=vitamin d3';
    }
    res.status(200).json(out);
  } catch (e) { out.error = String(e && e.message || e); res.status(500).json(out); }
};

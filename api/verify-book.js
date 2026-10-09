// Vercel serverless function. Save as: api/verify-book.js
// Required env vars in Vercel:
//   GUMROAD_PRODUCT_ID  (from the book's Gumroad product page, License key section)
//   ADMIN_KEY           (any long secret you choose; unlocks the widget for you)
// Optional:
//   BOOK_COMP_KEYS      (comma-separated free-access codes for clients, guests, reviewers.
//                        Each code must be at least 12 characters. Remove a code to revoke it.)
//   ALLOWED_ORIGIN      (defaults to *)
//   MAX_USES            (devices per license key, defaults to 5)

const crypto = require("crypto");

// Compares two strings without leaking how many leading characters matched.
function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Reads BOOK_COMP_KEYS, trims each code and drops anything too short to be safe.
function compKeys() {
  return String(process.env.BOOK_COMP_KEYS || "")
    .split(",")
    .map(function (k) { return k.trim(); })
    .filter(function (k) { return k.length >= 12; });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const key = String((body && body.key) || "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "Paste your license key first." });

  const admin = process.env.ADMIN_KEY;
  if (admin && same(key, admin)) return res.status(200).json({ ok: true, admin: true });

  // Free-access codes you hand out yourself. They skip Gumroad entirely.
  const comps = compKeys();
  for (let i = 0; i < comps.length; i++) {
    if (same(key, comps[i])) return res.status(200).json({ ok: true, comp: true });
  }

  const productId = process.env.GUMROAD_PRODUCT_ID;
  if (!productId) return res.status(500).json({ ok: false, error: "Server not configured." });

  try {
    const r = await fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: productId,
        license_key: key,
        increment_uses_count: "true"
      })
    });
    const data = await r.json();

    if (!data || !data.success) {
      return res.status(200).json({ ok: false, error: "That key didn't work. Check it and try again." });
    }
    const p = data.purchase || {};
    if (p.refunded || p.chargebacked || p.disputed) {
      return res.status(200).json({ ok: false, error: "This purchase is no longer active." });
    }
    const maxUses = parseInt(process.env.MAX_USES || "5", 10);
    if (typeof data.uses === "number" && data.uses > maxUses) {
      return res.status(200).json({ ok: false, error: "This key has been used on too many devices." });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Couldn't reach Gumroad. Try again." });
  }
};

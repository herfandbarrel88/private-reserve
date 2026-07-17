// netlify/functions/admin-write.js
// Every admin save (products, orders, members, invites, home page, cigar setup)
// routes through here. The public app key can only read the database now — this
// is the only place writes happen, and only after the passcode is verified.

const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";
const { getIdentifier, checkRateLimit, recordFailure, recordSuccess } = require("./rate-limit");

const ALLOWED_KEYS = [
  "pr_products", "pr_members", "pr_invites", "pr_orders",
  "pr_home_links", "pr_cigar_brand_images", "pr_cigar_origins",
];

async function sbGet(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data?select=value&key=eq.${key}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const rows = await res.json();
  return rows[0] ? rows[0].value : null;
}
async function sbSet(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_data?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ key, value }]),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "Server not configured yet — missing service role key." }) };
  }
  try {
    const body = JSON.parse(event.body);
    const identifier = getIdentifier(event);

    const limit = await checkRateLimit("pr_rate_adminwrite", identifier);
    if (limit.blocked) return { statusCode: 200, body: JSON.stringify({ ok: false, error: limit.message }) };

    const storedPasscode = (await sbGet("pr_admin_pass")) || "humidor21";
    if (storedPasscode !== body.passcode) {
      await recordFailure("pr_rate_adminwrite", identifier);
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: "Not authorized." }) };
    }
    await recordSuccess("pr_rate_adminwrite", identifier);

    const updates = body.updates || {};
    const keys = Object.keys(updates).filter((k) => ALLOWED_KEYS.includes(k));
    await Promise.all(keys.map((k) => sbSet(k, updates[k])));

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

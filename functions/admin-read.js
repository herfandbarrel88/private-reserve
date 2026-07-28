// netlify/functions/admin-read.js
// Members, orders and invite codes are no longer readable with the public app
// key — that key is visible in the page source, so anything it can read is
// effectively public. Those three blocks now come through here instead, and
// only after the proprietor passcode has been verified.
const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";
const { getIdentifier, checkRateLimit, recordFailure, recordSuccess } = require("./rate-limit");
const { verifyPasscode } = require("./passcode");

// The only keys this function will ever hand back. Anything else is a coding
// mistake, not a request to honour.
const PRIVATE_KEYS = ["pr_members", "pr_invites", "pr_orders"];

async function sbGet(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data?select=value&key=eq.${key}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Read failed for ${key} (${res.status}): ${detail.slice(0, 200)}`);
  }
  const rows = await res.json();
  return rows[0] ? rows[0].value : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "Server not configured yet — missing service role key." }) };
  }
  try {
    const body = JSON.parse(event.body);
    const identifier = getIdentifier(event);
    // Same bucket admin-write uses. A brand-new bucket name isn't guaranteed to
    // exist yet, and a limiter that can't find its own row shouldn't be able to
    // lock the proprietor out of their own orders.
    const RATE_KEY = "pr_rate_adminwrite";
    try {
      const limit = await checkRateLimit(RATE_KEY, identifier);
      if (limit && limit.blocked) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: limit.message }) };
      }
    } catch (e) {
      console.error("rate limit check failed, allowing request:", e.message);
    }

    const storedPasscode = (await sbGet("pr_admin_pass")) || "humidor21";
    if (!verifyPasscode(body.passcode, storedPasscode)) {
      try { await recordFailure(RATE_KEY, identifier); } catch (e) {}
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: "Passcode not accepted by admin-read." }) };
    }
    try { await recordSuccess(RATE_KEY, identifier); } catch (e) {}

    const data = {};
    await Promise.all(PRIVATE_KEYS.map(async (k) => { data[k] = await sbGet(k); }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, data }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

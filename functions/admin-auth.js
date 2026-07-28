// netlify/functions/admin-auth.js
// Checks and updates the Proprietor passcode using Supabase's service_role key,
// which bypasses Row Level Security. This lets us lock the passcode row down so
// the public anon key (visible in the app's own source) can never read it directly.
// The passcode itself is stored hashed — see passcode.js.
const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";
const { getIdentifier, checkRateLimit, recordFailure, recordSuccess } = require("./rate-limit");
const { hashPasscode, verifyPasscode, isHashed } = require("./passcode");
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
    if (body.action === "check") {
      const identifier = getIdentifier(event);
      const limit = await checkRateLimit("pr_rate_admin", identifier);
      if (limit.blocked) return { statusCode: 200, body: JSON.stringify({ ok: false, error: limit.message }) };
      const stored = (await sbGet("pr_admin_pass")) || "humidor21";
      const ok = verifyPasscode(body.passcode, stored);
      if (ok) {
        await recordSuccess("pr_rate_admin", identifier);
        // First successful sign-in after this update converts the stored plain-text
        // passcode into a hash. Nothing changes for the user.
        if (!isHashed(stored)) {
          try { await sbSet("pr_admin_pass", hashPasscode(body.passcode)); }
          catch (e) { console.error("passcode upgrade failed", e); }
        }
      } else {
        await recordFailure("pr_rate_admin", identifier);
      }
      return { statusCode: 200, body: JSON.stringify({ ok }) };
    }
    if (body.action === "set") {
      const stored = (await sbGet("pr_admin_pass")) || "humidor21";
      if (!verifyPasscode(body.currentPasscode, stored)) {
        return { statusCode: 403, body: JSON.stringify({ ok: false, error: "Current passcode is incorrect." }) };
      }
      if (!body.newPasscode || body.newPasscode.length < 4) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Use at least 4 characters." }) };
      }
      await sbSet("pr_admin_pass", hashPasscode(body.newPasscode));
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Unknown action." }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

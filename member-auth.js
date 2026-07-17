// netlify/functions/member-auth.js
// Handles member sign-up (invite redemption) and sign-in server-side, so passwords
// are hashed here rather than ever being compared or stored in plain text.

const crypto = require("crypto");

const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";
const { getIdentifier, checkRateLimit, recordFailure, recordSuccess } = require("./rate-limit");
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qbHJjYW1kbGdoY3Z6a3dwYmZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1Nzg5MjIsImV4cCI6MjA5OTE1NDkyMn0.ul4nyNg2Lbwl3LKJ2qW6ogOw_xkgNYRwuAApOHO8CKI";

async function sbGet(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data?select=value&key=eq.${key}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  const rows = await res.json();
  return rows[0] ? rows[0].value : null;
}
async function sbSet(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_data?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ key, value }]),
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  try {
    const hashBuffer = Buffer.from(hash, "hex");
    const testHash = crypto.scryptSync(password, salt, 64);
    return hashBuffer.length === testHash.length && crypto.timingSafeEqual(hashBuffer, testHash);
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const body = JSON.parse(event.body);

    if (body.action === "redeem") {
      const code = (body.code || "").trim().toUpperCase();
      const name = (body.name || "").trim();
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      if (!code || !name || !email || password.length < 4) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Fill in your name, email, and a password (4+ characters)." }) };
      }
      const invites = (await sbGet("pr_invites")) || {};
      const invite = invites[code];
      if (!invite || invite.used) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "That invite code is invalid or already used." }) };
      }
      const members = (await sbGet("pr_members")) || {};
      if (members[email]) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "An account with that email already exists — sign in instead." }) };
      }
      invites[code] = { ...invite, used: true, usedAt: Date.now() };
      members[email] = {
        email, name, passwordHash: hashPassword(password),
        active: true, joinedAt: Date.now(), invitedBy: code,
      };
      await Promise.all([sbSet("pr_invites", invites), sbSet("pr_members", members)]);
      return { statusCode: 200, body: JSON.stringify({ ok: true, member: { email, name } }) };
    }

    if (body.action === "signin") {
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const identifier = getIdentifier(event, email);
      const limit = await checkRateLimit("pr_rate_member", identifier);
      if (limit.blocked) return { statusCode: 200, body: JSON.stringify({ ok: false, error: limit.message }) };
      const members = (await sbGet("pr_members")) || {};
      const m = members[email];
      if (!m || !m.active) {
        await recordFailure("pr_rate_member", identifier);
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "No active membership found for that email." }) };
      }
      let valid = false;
      if (m.passwordHash) {
        valid = verifyPassword(password, m.passwordHash);
      } else if (m.password) {
        // Legacy plain-text account from before this fix — verify once, then upgrade it.
        valid = m.password === password;
        if (valid) {
          members[email] = { ...m, passwordHash: hashPassword(password) };
          delete members[email].password;
          await sbSet("pr_members", members);
        }
      }
      if (!valid) {
        await recordFailure("pr_rate_member", identifier);
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Incorrect password." }) };
      }
      await recordSuccess("pr_rate_member", identifier);
      return { statusCode: 200, body: JSON.stringify({ ok: true, member: { email: m.email, name: m.name } }) };
    }

    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Unknown action." }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

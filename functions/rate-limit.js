// netlify/functions/rate-limit.js
// Shared brute-force protection. Tracks failed attempts per identifier (usually
// the caller's IP) in Supabase and blocks further tries once too many failures
// happen in a short window. This stops an automated script from rapidly guessing
// passcodes or passwords — a human mistyping a few times is never affected.

const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qbHJjYW1kbGdoY3Z6a3dwYmZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1Nzg5MjIsImV4cCI6MjA5OTE1NDkyMn0.ul4nyNg2Lbwl3LKJ2qW6ogOw_xkgNYRwuAApOHO8CKI";

const MAX_ATTEMPTS = 8;       // failures allowed
const WINDOW_MS = 15 * 60 * 1000;   // within this window
const LOCKOUT_MS = 15 * 60 * 1000;  // then locked out for this long

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

function getIdentifier(event, extra) {
  const ip = (event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  return extra ? `${ip}:${extra}` : ip;
}

// Call before checking a password/passcode. Returns { blocked: bool, message }.
async function checkRateLimit(bucketKey, identifier) {
  const all = (await sbGet(bucketKey)) || {};
  const entry = all[identifier];
  const now = Date.now();
  if (entry && entry.lockedUntil && entry.lockedUntil > now) {
    const minutesLeft = Math.ceil((entry.lockedUntil - now) / 60000);
    return { blocked: true, message: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.` };
  }
  return { blocked: false };
}

// Call after a failed attempt.
async function recordFailure(bucketKey, identifier) {
  const all = (await sbGet(bucketKey)) || {};
  const now = Date.now();
  let entry = all[identifier];
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  all[identifier] = entry;
  await sbSet(bucketKey, all);
}

// Call after a successful attempt, to clear the counter.
async function recordSuccess(bucketKey, identifier) {
  const all = (await sbGet(bucketKey)) || {};
  if (all[identifier]) {
    delete all[identifier];
    await sbSet(bucketKey, all);
  }
}

module.exports = { getIdentifier, checkRateLimit, recordFailure, recordSuccess };

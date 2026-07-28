// netlify/functions/passcode.js
// The proprietor passcode used to be stored and compared as plain text. It's now
// hashed the same way member passwords are — scrypt with a random per-passcode
// salt — so the stored value can be checked against but never read back, even by
// someone with full database access.
//
// Hashed values carry an explicit "scrypt:" prefix. Anything without it is a
// legacy plain-text passcode, which still verifies (so nobody gets locked out)
// and is upgraded to a hash the next time it's used successfully.

const crypto = require("crypto");

const PREFIX = "scrypt:";

function hashPasscode(passcode) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(passcode, salt, 64).toString("hex");
  return `${PREFIX}${salt}:${hash}`;
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

function verifyPasscode(input, stored) {
  if (!stored || typeof input !== "string") return false;
  // Legacy plain-text passcode — compare directly. The caller should upgrade it.
  if (!isHashed(stored)) return input === stored;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [, salt, hash] = parts;
  try {
    const hashBuffer = Buffer.from(hash, "hex");
    const testHash = crypto.scryptSync(input, salt, 64);
    // Constant-time compare, so a wrong passcode can't be narrowed down by timing.
    return hashBuffer.length === testHash.length && crypto.timingSafeEqual(hashBuffer, testHash);
  } catch {
    return false;
  }
}

module.exports = { hashPasscode, verifyPasscode, isHashed };

// Is this a signed-in hub affiliate? auth-api.js makes the session on login
// ("affiliate-sessions"); it is tied to the password at the time, so a changed
// or reset password logs every device out.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

export const DEFAULT_PASSWORD = "0000";

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The affiliate's current password hash (the default password until one is set).
export async function storedPasswordHash(aff) {
  const rec = await getStore({ name: "affiliate-auth", consistency: "strong" }).get(aff, { type: "json" }).catch(() => null);
  return rec && rec.passwordHash ? rec.passwordHash : await sha256Hex(DEFAULT_PASSWORD);
}

export async function isAffiliateSession(aff, token) {
  if (!aff || !token) return false;
  const s = await getStore({ name: "affiliate-sessions", consistency: "strong" }).get(token, { type: "json" }).catch(() => null);
  if (!s || s.aff !== aff) return false;
  return s.ph === (await storedPasswordHash(aff)).slice(0, 16);
}

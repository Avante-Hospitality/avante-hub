// Is this an Avante admin's login? Sessions are made by admin-api.js on
// login and kept in the "admin-sessions" store until they expire.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

export async function isAdminToken(token) {
  if (!token) return false;
  const session = await getStore({ name: "admin-sessions", consistency: "strong" }).get(String(token), { type: "json" }).catch(() => null);
  return !!(session && new Date(session.expiresAt).getTime() > Date.now());
}

// Stock Network's own property feed (/api/1.0/resort, read with Avante's agent
// login — the same feed netlify/functions/stocknetwork-sync.mjs reads every
// night), looked up by NightsBridge BBID (the feed's "resortCode") so a
// property that only gives its BBID can be added (Jean, 2026-10-14).
//
// The hub's nightly sync never kept the feed's site fields, and Stock Network
// doesn't document their names, so every field with "site" in its name is
// returned as it is (siteFields), and the Site Nr / Site ID are picked out of
// them: the Site ID is the GUID, the Site Nr the whole number.
// The feed is big, so a slim index (BBID -> property + site fields) is kept for
// 6 hours in the "sn-feed" store.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

const BASE = "https://api.stocknetwork.co.za";
const CACHE_MS = 6 * 3600e3;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
export const normBbid = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/^0+/, "");

export function siteFieldsOf(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    if (!/site/i.test(k)) continue;
    const v = row[k];
    if (v === null || v === undefined || typeof v === "object") continue;
    const s = String(v).trim();
    if (s) out[k] = s;
  }
  return out;
}
export function pickSite(fields) {
  const vals = Object.entries(fields || {});
  const guid = (vals.find(([k, v]) => /iExchangeSiteFileID/i.test(k) && GUID.test(v)) || vals.find(([, v]) => GUID.test(v)) || [])[1] || "";
  const nr = (vals.find(([k, v]) => /^\d{1,7}$/.test(v) && /(no|nr|num|number|code)$/i.test(k)) || vals.find(([, v]) => /^\d{1,7}$/.test(v)) || [])[1] || "";
  return { siteId: guid, siteNr: nr };
}
function slim(row) {
  const num = (v) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? null : Number(v));
  return { resortId: String(row.iExchangeResortFileID || row.resortId || "").trim(), name: String(row.name || row.resortName || row.ResortName || "").trim(),
    latitude: num(row.latitude), longitude: num(row.longitude), siteFields: siteFieldsOf(row) };
}

async function loadIndex(fetchImpl) {
  const store = getStore({ name: "sn-feed", consistency: "strong" });
  const cached = await store.get("bbid-index", { type: "json" }).catch(() => null);
  if (cached && cached.at && Date.now() - Date.parse(cached.at) < CACHE_MS) return cached;
  const username = env("STOCKNETWORK_USERNAME"), clientID = env("STOCKNETWORK_CLIENT_ID"), clientSecret = env("STOCKNETWORK_CLIENT_SECRET");
  if (!username || !clientID || !clientSecret) throw new Error("The Stock Network login for the property feed isn't set on this site.");
  const t = await fetchImpl(BASE + "/api/1.0/token", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ username, clientID, clientSecret }) });
  if (!t.ok) throw new Error("Stock Network didn't accept Avante's login (" + t.status + ").");
  const tok = await t.json();
  const r = await fetchImpl(BASE + "/api/1.0/resort", { headers: { Authorization: "Bearer " + (tok.accessToken || tok.access_token), Accept: "application/json" } });
  if (!r.ok) throw new Error("Stock Network's property feed answered " + r.status + ".");
  const data = await r.json();
  const rows = Array.isArray(data) ? data : data.resorts || data.data || [];
  const byBbid = {};
  for (const row of rows) { const code = normBbid(row && row.resortCode); if (code) (byBbid[code] = byBbid[code] || []).push(slim(row)); }
  const index = { at: new Date().toISOString(), count: rows.length, byBbid };
  await store.setJSON("bbid-index", index).catch(() => {});
  return index;
}

// -> { ok, matches: [{ resortId, name, latitude, longitude, siteFields, siteNr, siteId }] } or { ok:false, error }
export async function feedByBbid(bbid, fetchImpl = fetch) {
  try {
    const index = await loadIndex(fetchImpl);
    const list = index.byBbid[normBbid(bbid)] || [];
    return { ok: true, matches: list.map((m) => Object.assign({}, m, pickSite(m.siteFields))) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

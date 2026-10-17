// Complexes, resorts and estates (golf, country, wildlife…) a property sits
// in (Jean, 2026-10-17). They show in the location tree only where one
// exists, between the suburb (or town) and the property, so the hook builder
// can offer the estate's own photos (pool, clubhouse, gate) for every
// property in it.
//
// Where they come from:
//   1. the property's listing (the listing form asks "Is the property in a
//      complex, resort or estate?": estateType + complexName), and
//   2. Stock Network's property feed, when a field in it names a complex or
//      estate (the listing wins).
// Kept as one map in the "estates" store, rebuilt when older than 30 minutes
// or after a listing is saved (forgetEstates).
//   map: { at, byResort: { resortId: { n, t, town } } }
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

export const ESTATE_TYPES = ["Complex", "Resort", "Golf estate", "Country estate", "Wildlife estate", "Eco estate", "Other estate"];
const MAX_AGE_MS = 30 * 60e3;
const FEED_KEY = /complex|estate/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 120);
export const estateTypeOf = (v) => ESTATE_TYPES.find((t) => t.toLowerCase() === clean(v).toLowerCase()) || "";
// A name that is really an estate name (not a yes/no, a number or an ID).
const isName = (v) => { const s = clean(v); return s.length > 2 && !GUID.test(s) && !/^(y|n|yes|no|true|false|none|n\/a|-|\d+)$/i.test(s); };

function fromFeedRow(row) {
  for (const [k, v] of Object.entries(row || {})) if (FEED_KEY.test(k) && typeof v === "string" && isName(v)) return { n: clean(v), t: /golf/i.test(k + " " + v) ? "Golf estate" : /estate/i.test(k + " " + v) ? "Other estate" : "Complex" };
  return null;
}

async function rebuild() {
  const byResort = {};
  // 2. Stock Network's feed (full rows, refreshed every 6 hours by lib/sn-feed.js).
  const idx = await getStore({ name: "sn-feed", consistency: "strong" }).get("resort-index", { type: "json" }).catch(() => null);
  for (const [rid, row] of Object.entries((idx && idx.byResort) || {})) {
    const e = fromFeedRow(row); if (e) byResort[rid] = { ...e, town: clean(row.district || row.city || ""), from: "sn" };
  }
  // 1. Listings (they win).
  const ls = getStore({ name: "property-listings", consistency: "strong" });
  const { blobs } = await ls.list().catch(() => ({ blobs: [] }));
  const keys = (blobs || []).map((b) => b.key).filter((k) => /^P-\d+$/.test(k));
  for (let i = 0; i < keys.length; i += 25) {
    const part = await Promise.all(keys.slice(i, i + 25).map((k) => ls.get(k, { type: "json" }).catch(() => null)));
    for (const r of part) {
      if (!r || !r.resortId || r.inEstate === "N" || !isName(r.complexName)) continue;
      byResort[String(r.resortId).toLowerCase()] = { n: clean(r.complexName), t: estateTypeOf(r.estateType) || "Complex", town: clean(r.city || r.district || ""), from: "listing" };
    }
  }
  const map = { at: new Date().toISOString(), byResort };
  await getStore({ name: "estates", consistency: "strong" }).setJSON("map", map).catch(() => {});
  return map;
}

export async function estatesMap() {
  const map = await getStore({ name: "estates", consistency: "strong" }).get("map", { type: "json" }).catch(() => null);
  if (map && map.at && Date.now() - Date.parse(map.at) < MAX_AGE_MS) return map;
  return rebuild().catch(() => map || { byResort: {} });
}
// After a listing is saved: the next read rebuilds the map.
export async function forgetEstates() { await getStore({ name: "estates", consistency: "strong" }).delete("map").catch(() => {}); }

// The estates that already exist, for the listing form's suggestions: [{ n, t, town }].
export async function estateNames() {
  const seen = new Map();
  for (const e of Object.values((await estatesMap()).byResort || {})) { const k = e.n.toLowerCase() + "|" + (e.town || "").toLowerCase(); if (!seen.has(k)) seen.set(k, { n: e.n, t: e.t, town: e.town }); }
  return [...seen.values()].sort((a, b) => a.n.localeCompare(b.n));
}

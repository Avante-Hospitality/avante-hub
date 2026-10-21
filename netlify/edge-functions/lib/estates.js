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
// (after the response that noticed) or after a listing is saved (forgetEstates).
//   map: { at, byResort: { resortId: { n, t, town } } }
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { readAllEntries, LISTINGS_STORE } from "./blob-records.js";

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

async function rebuild(startedAtGeneration) {
  const byResort = {};
  // 2. Stock Network's feed (full rows, refreshed every 6 hours by lib/sn-feed.js).
  const idx = await getStore({ name: "sn-feed", consistency: "strong" }).get("resort-index", { type: "json" }).catch(() => null);
  for (const [rid, row] of Object.entries((idx && idx.byResort) || {})) {
    const e = fromFeedRow(row); if (e) byResort[rid] = { ...e, town: clean(row.district || row.city || ""), from: "sn" };
  }
  // 1. Listings (they win), in list order. Read in parallel; unchanged
  // listings come from this isolate's copy (lib/blob-records.js).
  const entries = await readAllEntries(getStore({ name: LISTINGS_STORE, consistency: "strong" }), { cacheName: LISTINGS_STORE }).catch(() => []);
  for (const { key, value: r } of entries) {
    if (!/^P-\d+$/.test(key)) continue;
    if (!r || !r.resortId || r.inEstate === "N" || !isName(r.complexName)) continue;
    byResort[String(r.resortId).toLowerCase()] = { n: clean(r.complexName), t: estateTypeOf(r.estateType) || "Complex", town: clean(r.city || r.district || ""), from: "listing" };
  }
  const map = { at: new Date().toISOString(), byResort };
  // A listing saved since this rebuild began makes it stale: don't store it.
  if (startedAtGeneration === generation) await getStore({ name: "estates", consistency: "strong" }).setJSON("map", map).catch(() => {});
  return map;
}

// One rebuild at a time per isolate. A listing saved while a rebuild is
// running makes that rebuild stale (it read the listings before the save),
// so forgetEstates bumps `generation` and the next rebuildOnce starts afresh.
let rebuilding = null, rebuildingGeneration = -1, generation = 0;
function rebuildOnce() {
  if (!rebuilding || rebuildingGeneration !== generation) {
    const job = rebuild(generation).finally(() => { if (rebuilding === job) rebuilding = null; });
    rebuilding = job; rebuildingGeneration = generation;
  }
  return rebuilding;
}

// The map. With `context` (a request's), a map older than 30 minutes is still
// answered straight away and rebuilt after the response, so a page asking for
// the resort list never waits for every listing to be read. Without one, or
// when there is no map yet, it is rebuilt first.
export async function estatesMap(context) {
  const map = await getStore({ name: "estates", consistency: "strong" }).get("map", { type: "json" }).catch(() => null);
  if (map && map.at && Date.now() - Date.parse(map.at) < MAX_AGE_MS) return map;
  if (map && context && typeof context.waitUntil === "function") {
    context.waitUntil(rebuildOnce().catch(() => null));
    return map;
  }
  return rebuildOnce().catch(() => map || { byResort: {} });
}
// After a listing is saved: the map is dropped, and (with the request's
// `context`) built again after the response, so the next resort-list read
// doesn't have to.
export async function forgetEstates(context) {
  generation++;
  await getStore({ name: "estates", consistency: "strong" }).delete("map").catch(() => {});
  if (context && typeof context.waitUntil === "function") context.waitUntil(rebuildOnce().catch(() => null));
}

// The estates that already exist, for the listing form's suggestions: [{ n, t, town }].
export async function estateNames(context) {
  const seen = new Map();
  for (const e of Object.values((await estatesMap(context)).byResort || {})) { const k = e.n.toLowerCase() + "|" + (e.town || "").toLowerCase(); if (!seen.has(k)) seen.set(k, { n: e.n, t: e.t, town: e.town }); }
  return [...seen.values()].sort((a, b) => a.n.localeCompare(b.n));
}

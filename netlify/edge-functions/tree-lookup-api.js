// Location tree lookups and live placements (2026-10-07).
//
// GET  /api/tree-lookup?kind=activities|properties|all
//      Public read of the live placements in the "tree-places" store (places
//      are already public on the map). Default kind=activities.
// POST (admin only)
//      { points:[ "lat,lng" ] }                  property lookups for the one-off
//                                                Google run; returns answers, saves nothing
//      { kind:"activity", points:[{id,k}] }      look up activities and save their place
//      { action:"seedProperties" }               copy tree-places.json (the approved
//                                                tree) into the live store, with each
//                                                property's current pin
//      { action:"placeBacklog" }                 place properties that are new or whose
//                                                pin moved, within a time budget
//
// Only this endpoint, the nightly SN sync and map-api.js's activity save write
// the "tree-places" store. No property, activity, zone or affiliate record is
// changed here.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { googleLookup, placeCoordinate, placeResortBacklog, keyOf, PLACES_STORE, ACTIVITY_KEY, PROPERTY_KEY } from "./lib/tree.js";

const MAX_POINTS = 25;
const CONCURRENCY = 5;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function verifyAdminToken(token) {
  if (!token) return false;
  const sessionStore = getStore({ name: "admin-sessions", consistency: "strong" });
  const session = await sessionStore.get(token, { type: "json" });
  if (!session) return false;
  return new Date(session.expiresAt).getTime() >= Date.now();
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let n = 0;
  async function w() { while (n < items.length) { const i = n++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: CONCURRENCY }, w));
  return out;
}

export default async (request) => {
  const places = getStore({ name: PLACES_STORE, consistency: "strong" });

  if (request.method === "GET") {
    const kind = new URL(request.url).searchParams.get("kind") || "activities";
    const body = { ok: true };
    if (kind === "activities" || kind === "all") body.activities = (await places.get(ACTIVITY_KEY, { type: "json" })) || {};
    if (kind === "properties" || kind === "all") body.properties = (await places.get(PROPERTY_KEY, { type: "json" })) || {};
    return json(body);
  }
  if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Body must be JSON." }, 400); }
  if (!(await verifyAdminToken(body.token))) return json({ error: "Your admin session has expired. Log in again." }, 401);

  if (body.action === "seedProperties") {
    // The approved tree, keyed by ResortID, plus each property's current pin so
    // later runs can tell when a pin has moved.
    const res = await fetch(new URL("/tree-places.json", request.url));
    if (!res.ok) return json({ error: "Could not read tree-places.json (" + res.status + ")." }, 500);
    const file = (await res.json()).places || {};
    const resorts = (((await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" })) || {}).resorts || []);
    const pin = {};
    for (const r of resorts) {
      const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
      if (r.resortId && !pin[r.resortId] && isFinite(lat) && isFinite(lng)) pin[r.resortId] = keyOf(lat, lng);
    }
    const map = (await places.get(PROPERTY_KEY, { type: "json" })) || {};
    let added = 0;
    const at = new Date().toISOString();
    for (const id of Object.keys(file)) {
      if (map[id] && map[id].src !== "file") continue; // never overwrite a newer live placement
      map[id] = { ...file[id], k: pin[id] || "", at, src: "file" };
      added++;
    }
    await places.setJSON(PROPERTY_KEY, map);
    return json({ ok: true, seeded: added, total: Object.keys(map).length, resortRows: resorts.length });
  }

  const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
  if (!apiKey) return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables." }, 400);

  if (body.action === "placeBacklog") {
    const resorts = (((await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" })) || {}).resorts || []);
    const r = await placeResortBacklog(places, resorts, apiKey, 9000);
    return json({ ok: true, ...r });
  }

  if (body.kind === "activity") {
    // points: [{ id, k: "lat,lng" }]
    const items = Array.isArray(body.points) ? body.points.slice(0, MAX_POINTS) : [];
    const out = await pool(items, async (it) => {
      it = it || {};
      const [lat, lng] = String(it.k || "").split(",").map(Number);
      if (!isFinite(lat) || !isFinite(lng)) return { id: String(it.id || ""), k: it.k, ok: false, reason: "bad_coordinate" };
      const r = await placeCoordinate(lat, lng, apiKey);
      return r.ok ? { id: String(it.id || ""), ok: true, place: r.place } : { id: String(it.id || ""), k: it.k, ok: false, reason: r.reason };
    });
    const map = (await places.get(ACTIVITY_KEY, { type: "json" })) || {};
    out.forEach((r) => { if (r.id && r.ok) map[r.id] = r.place; });
    await places.setJSON(ACTIVITY_KEY, map);
    return json({ ok: true, results: out.map((r) => ({ id: r.id, ok: r.ok, reason: r.reason, k: r.place ? r.place.k : r.k })), saved: Object.keys(map).length });
  }

  // Property lookups for the one-off run: answers only, nothing saved.
  const points = Array.isArray(body.points) ? body.points.slice(0, MAX_POINTS) : [];
  const results = await pool(points, async (k) => {
    const [lat, lng] = String(k).split(",").map(Number);
    return isFinite(lat) && isFinite(lng) ? { k, ...(await googleLookup(lat, lng, apiKey)) } : { k, ok: false, reason: "bad_coordinate" };
  });
  return json({ ok: true, results });
};

export const config = { path: "/api/tree-lookup" };

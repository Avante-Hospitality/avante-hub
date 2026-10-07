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
//      { action:"placeListing", listingId, lat, lng }  place an onboarded listing
//                                                (stored as "listing:<listingId>")
//
// Only this endpoint, the nightly SN sync and map-api.js's activity save write
// the "tree-places" store. No property, activity, zone or affiliate record is
// changed here.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { googleLookup, placeCoordinate, placeResortBacklog, keyOf, PLACES_STORE, ACTIVITY_KEY, PROPERTY_KEY, TREE_RULES } from "./lib/tree.js";

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

  if (body.action === "convertHooks") {
    // Hooks only keep a text locationLabel ("Garden Route, Knysna"). This
    // rewrites old zone/town names to location-tree names and drops the
    // leftover zone/townId/suburbId fields. dryRun (the default) only reports.
    const dryRun = body.dryRun !== false;
    const hookStore = getStore({ name: "promo-hooks", consistency: "strong" });
    const pm = (await places.get(PROPERTY_KEY, { type: "json" })) || {};
    const am = (await places.get(ACTIVITY_KEY, { type: "json" })) || {};
    // Every name in the tree, lower-cased -> its spelling in the tree.
    // "Brenton on Sea" and "Brenton-on-Sea" are the same name.
    const nk = (v) => String(v || "").trim().toLowerCase().replace(/[-‐–]+/g, " ").replace(/\s+/g, " ");
    const names = new Map();
    const add = (v) => { if (v && !/^\(/.test(v)) names.set(nk(v), String(v).trim()); };
    // The approved tree file as well as the live store, so this works before set-up too.
    let filePlaces = {};
    try { const fr = await fetch(new URL("/tree-places.json", request.url)); if (fr.ok) filePlaces = (await fr.json()).places || {}; } catch (e) { /* live store only */ }
    Object.values(filePlaces).concat(Object.values(pm), Object.values(am)).forEach((pl) => {
      if (!pl) return;
      add(pl.p); (pl.r || []).forEach(add); add(pl.t); add(pl.s); (pl.a || []).forEach((x) => add(x && x[0]));
    });
    const rules = TREE_RULES;
    // Old zones -> tree names (regions, or the province where a zone was a province).
    const OLD_ZONES = {
      "winelands": ["Cape Winelands"], "west coast & overberg": ["West Coast", "Overberg"],
      "eastern cape & garden route": ["Garden Route", "Eastern Cape"],
      "western cape (cape town & winelands)": ["Cape Town", "Cape Winelands"],
      "gauteng & north west": ["Gauteng", "North West"],
    };
    const resorts = (((await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" })) || {}).resorts || []);
    const propNames = new Set(resorts.map((r) => String(r.name || "").trim().toLowerCase()).filter(Boolean));
    function convertPart(part) {
      const raw = part.trim().replace(/ \(entire area\)$/i, "").replace(/^— /, "").replace(/^Nearby /i, "");
      if (!raw) return { out: [], ok: true };
      const low = raw.toLowerCase();
      if (/^\d+ (more )?propert(y|ies)$/i.test(raw)) return { out: [raw], ok: true };
      if (OLD_ZONES[low]) return { out: OLD_ZONES[low], ok: true };
      let name = (rules.spell && rules.spell[raw]) || raw;
      if (rules.parent && rules.parent[name] && !names.has(nk(name))) name = rules.parent[name];
      if (names.has(nk(name))) return { out: [names.get(nk(name))], ok: true };
      if (propNames.has(low)) return { out: [raw], ok: true, property: true };
      return { out: [raw], ok: false };
    }
    const { blobs } = await hookStore.list();
    const keys = blobs.map((b) => b.key).sort();
    const recs = await pool(keys, (k) => hookStore.get(k, { type: "json" }).catch(() => null));
    const changes = [], unmatched = [];
    let checked = 0;
    const writes = [];
    keys.forEach((key, i) => {
      const rec = recs[i];
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) return;
      checked++;
      const oldLabel = typeof rec.locationLabel === "string" ? rec.locationLabel : "";
      const hasOld = ["zone", "townId", "suburbId"].some((f) => f in rec);
      let newLabel = oldLabel;
      const bad = [];
      if (oldLabel.trim()) {
        const out = [];
        oldLabel.split(/\s*,\s*|\s+›\s+/).forEach((p) => {
          const r = convertPart(p);
          r.out.forEach((x) => { if (out.indexOf(x) === -1) out.push(x); });
          if (!r.ok) bad.push(p.trim());
        });
        newLabel = out.join(", ");
      }
      if (bad.length) unmatched.push({ key, hook: String(rec.caption || "").split("\n")[0].slice(0, 80), label: oldLabel, parts: bad });
      if (newLabel === oldLabel && !hasOld) return;
      changes.push({ key, hook: String(rec.caption || "").split("\n")[0].slice(0, 80), from: oldLabel, to: newLabel, dropsOldFields: hasOld });
      if (!dryRun) {
        const next = Object.assign({}, rec, { locationLabel: newLabel });
        delete next.zone; delete next.townId; delete next.suburbId;
        writes.push({ key, rec: next });
      }
    });
    if (writes.length) await pool(writes, (w) => hookStore.setJSON(w.key, w.rec));
    return json({ ok: true, dryRun, checked, changes, unmatched, written: writes.length });
  }

  const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
  if (!apiKey) return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables." }, 400);

  if (body.action === "placeBacklog") {
    const resorts = (((await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" })) || {}).resorts || []);
    const r = await placeResortBacklog(places, resorts, apiKey, 9000);
    return json({ ok: true, ...r });
  }

  if (body.action === "placeListing") {
    // An onboarded listing (no StockNetwork ResortID): look its pin up and keep
    // its place in the live store under "listing:<listingId>".
    const id = typeof body.listingId === "string" ? body.listingId.trim() : "";
    const lat = parseFloat(body.lat), lng = parseFloat(body.lng);
    if (!id || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return json({ error: "This listing has no usable latitude and longitude." }, 400);
    const r = await placeCoordinate(lat, lng, apiKey);
    if (!r.ok) return json({ error: "Google could not place this pin (" + r.reason + ")." }, 502);
    const map = (await places.get(PROPERTY_KEY, { type: "json" })) || {};
    map["listing:" + id] = r.place;
    await places.setJSON(PROPERTY_KEY, map);
    return json({ ok: true, place: r.place });
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

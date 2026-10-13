// Where a property sits in the hub's location tree, for booking links
// (see lib/booking-link.js). Same source the Hub's pages use: the approved
// tree-places.json file, with the hub's live placements (the "tree-places"
// store, new or moved properties) winning over it. Property names come from
// the resort list. Loaded once per edge isolate and kept for a few minutes.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { treeOpts, parseBookingLink, holidayBuilderUrl, hasTreePath } from "./booking-link.js";

// Same store/key as lib/tree.js (PLACES_STORE / PROPERTY_KEY); not imported
// from there so link-only functions don't bundle the whole tree engine.
const PLACES_STORE = "tree-places";
const PROPERTY_KEY = "properties";
const TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, places, names }
let loading = null;

async function load(origin) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (loading) return loading;
  loading = (async () => {
    let filePlaces = {};
    try {
      const r = await fetch(new URL("/tree-places.json", origin));
      if (r.ok) filePlaces = (await r.json()).places || {};
    } catch (e) { /* live store only */ }
    let live = {};
    try {
      live = (await getStore({ name: PLACES_STORE, consistency: "strong" }).get(PROPERTY_KEY, { type: "json" })) || {};
    } catch (e) { /* file only */ }
    const names = {};
    try {
      const rec = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" });
      for (const r of (rec && rec.resorts) || []) if (r && r.resortId && r.name && !names[r.resortId]) names[r.resortId] = r.name;
    } catch (e) { /* no names */ }
    cache = { at: Date.now(), places: Object.assign({}, filePlaces, live), names };
    return cache;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// Link opts for one property: its full tree path plus its name.
// nameHint is used when the resort list has no name for it.
export async function propertyTreeOpts(resortId, origin, nameHint) {
  if (!resortId) return {};
  const { places, names } = await load(origin);
  return treeOpts(places[resortId] || null, names[resortId] || nameHint || "");
}

// The tree path shared by several properties (an area or a selection): the
// levels they all agree on, top down, stopping at the first difference. One
// property gives its full path and name.
export async function commonTreeOpts(resortIds, origin) {
  const ids = (resortIds || []).filter(Boolean);
  if (!ids.length) return {};
  if (ids.length === 1) return propertyTreeOpts(ids[0], origin);
  const { places } = await load(origin);
  const paths = ids.map((id) => treeOpts(places[id] || null, "")).filter((o) => o.country);
  if (!paths.length) return {};
  const out = {};
  for (const f of ["country", "province", "region", "city", "suburb"]) {
    const v = paths[0][f];
    if (!v || paths.some((p) => p[f] !== v)) break;
    out[f] = v;
  }
  return out;
}

// Gives a holiday builder (or old Stock Network) booking link for one
// property its tree path, if it doesn't carry one yet. Other links, and
// links that already have a path, come back unchanged.
export async function withTreePath(rawUrl, origin) {
  const parsed = parseBookingLink(rawUrl);
  if (!parsed || parsed.kind !== "hb" || !parsed.opts.resortId || hasTreePath(parsed.opts)) return rawUrl;
  try {
    const tree = await propertyTreeOpts(parsed.opts.resortId, origin);
    if (!tree.country && !tree.property) return rawUrl;
    const opts = { ...parsed.opts, ...tree };
    delete opts.destination; // now the property's own name
    let url = holidayBuilderUrl(parsed.siteId, opts);
    if (parsed.opts.extra && parsed.opts.extra.length) {
      const u = new URL(url);
      for (const [k, v] of parsed.opts.extra) if (!u.searchParams.has(k)) u.searchParams.append(k, v);
      url = u.toString();
    }
    return url;
  } catch (e) {
    return rawUrl;
  }
}

// ---- Places in the tree with a map position (front store "things to do") ----
// Each town and suburb of the tree gets a centre: the middle (median) of the
// pins of the properties in it (resort list latitude/longitude), the same way
// the hook builder works out a town's centre. Kept with the tree cache.
let centres = null; // { at, list: [{ p, t, s, lat, lng, n }] }
const med = (xs) => { const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
async function loadCentres(origin) {
  const c = await load(origin);
  if (centres && centres.at === c.at) return centres;
  const pins = {};
  try {
    const rec = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" });
    for (const r of (rec && rec.resorts) || []) {
      const lat = parseFloat(r && r.latitude), lng = parseFloat(r && r.longitude);
      if (r && r.resortId && isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0)) pins[r.resortId] = [lat, lng];
    }
  } catch (e) { /* no pins */ }
  const groups = {};
  for (const [id, pl] of Object.entries(c.places)) {
    const pin = pins[id]; if (!pin || !pl || !pl.t) continue;
    const add = (s) => { const k = (pl.p || "") + "|" + pl.t + "|" + s; (groups[k] = groups[k] || { p: pl.p || "", t: pl.t, s, pts: [] }).pts.push(pin); };
    add("");
    if (pl.s && pl.s !== pl.t) add(pl.s);
  }
  const list = Object.values(groups).map((g) => ({ p: g.p, t: g.t, s: g.s, lat: med(g.pts.map((x) => x[0])), lng: med(g.pts.map((x) => x[1])), n: g.pts.length }));
  list.sort((a, b) => (a.p + a.t + a.s).localeCompare(b.p + b.t + b.s));
  centres = { at: c.at, list };
  return centres;
}
// All towns and suburbs that have a centre, for the builder's place picker.
export async function treeAreaList(origin) {
  return (await loadCentres(origin)).list.map((x) => ({ p: x.p, t: x.t, s: x.s }));
}
// The centre of one place ({ p, t, s }): the suburb, else its town.
export async function treePlaceCentre(origin, place) {
  if (!place || !place.t) return null;
  const { list } = await loadCentres(origin), lc = (x) => String(x || "").toLowerCase();
  const town = list.filter((x) => lc(x.t) === lc(place.t) && (!place.p || lc(x.p) === lc(place.p)));
  return (place.s && town.find((x) => lc(x.s) === lc(place.s))) || town.find((x) => !x.s) || null;
}
// A property's own tree place as { p, t, s } (or null).
export async function propertyTreePlace(resortId, origin) {
  if (!resortId) return null;
  const pl = (await load(origin)).places[resortId];
  return pl && pl.t ? { p: pl.p || "", t: pl.t, s: pl.s && pl.s !== pl.t ? pl.s : "" } : null;
}

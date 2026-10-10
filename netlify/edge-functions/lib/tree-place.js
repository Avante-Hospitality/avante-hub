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

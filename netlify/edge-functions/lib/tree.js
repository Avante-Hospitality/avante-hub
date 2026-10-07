// The location tree engine (2026-10-07): places a coordinate in
// Country > Province > Region > City > Suburb, the same way the approved
// tree and the Explore page do. Google answers the country, province, town,
// suburb and district; the Avante region comes from the region shapes; the
// town groups, spelling fixes and metro cities come from lib/tree-data.js.
//
// A place is { c, p, r: [regions, main first], t, s, a: [[metroCity, town]], d }.
// Pages add "<town> & surrounds" themselves when s is blank.
import TREE from "./tree-data.js";

const FETCH_TIMEOUT_MS = 8000;
const RULES = TREE.rules || {};
const OVERLAY = new Set(TREE.overlay || []);

// ---------- geometry ----------
function inRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function inPoly(x, y, p) {
  if (!inRing(x, y, p[0])) return false;
  for (let h = 1; h < p.length; h++) if (inRing(x, y, p[h])) return false;
  return true;
}
function segKm(px, py, ax, ay, bx, by) {
  const kx = 111.32 * Math.cos((py * Math.PI) / 180);
  const Ax = ax * kx, Bx = bx * kx, Px = px * kx, Ay = ay * 110.57, By = by * 110.57, Py = py * 110.57;
  const dx = Bx - Ax, dy = By - Ay, l = dx * dx + dy * dy;
  let t = l ? ((Px - Ax) * dx + (Py - Ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(Px - (Ax + t * dx), Py - (Ay + t * dy));
}
export function km(a1, o1, a2, o2) {
  const r = Math.PI / 180, dl = (a2 - a1) * r, dn = (o2 - o1) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dn / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

const IDX = [];
for (const n of Object.keys(TREE.shapes || {})) {
  for (const poly of TREE.shapes[n]) {
    const b = [1e9, 1e9, -1e9, -1e9];
    for (const p of poly[0]) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
    IDX.push({ n, poly, b });
  }
}

// Every region containing the point, overlapping regions (e.g. Highlands Meander)
// first; within 3 km of the simplified coastline counts as the nearest region.
export function regionsAt(lat, lng) {
  const hit = new Set();
  for (const s of IDX) {
    if (lng < s.b[0] || lng > s.b[2] || lat < s.b[1] || lat > s.b[3]) continue;
    if (inPoly(lng, lat, s.poly)) hit.add(s.n);
  }
  let r = [...hit];
  if (!r.length) {
    let best = null, bd = 3;
    for (const s of IDX) {
      const ring = s.poly[0];
      for (let i = 1; i < ring.length; i++) {
        const d = segKm(lng, lat, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
        if (d < bd) { bd = d; best = s.n; }
      }
    }
    if (best) r = [best];
  }
  return r.sort((a, b) => (OVERLAY.has(b) ? 1 : 0) - (OVERLAY.has(a) ? 1 : 0) || a.localeCompare(b));
}

export function provinceAt(lat, lng) {
  for (const n of Object.keys(TREE.provs || {})) {
    const c = TREE.provs[n];
    const polys = TREE.provt[n] === "Polygon" ? [c] : c;
    for (const p of polys) if (inPoly(lng, lat, p)) return n;
  }
  return "";
}

function nearestTown(lat, lng, maxKm, minN = 3) {
  let best = null, bd = maxKm;
  for (const [t, la, lo, n] of TREE.towns || []) {
    if (n < minN) continue;
    const d = km(lat, lng, la, lo);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
// Nearest town centre whose name doesn't match `skip` (e.g. agricultural holdings).
export function nearestTownName(lat, lng, maxKm, skip) {
  let best = null, bd = maxKm;
  for (const [t, la, lo, n] of TREE.towns || []) {
    if (n < 3 || (skip && skip.test(t))) continue;
    const d = km(lat, lng, la, lo);
    if (d < bd) { bd = d; best = t; }
  }
  return best ? { name: best, km: bd } : null;
}
// "South Africa › Western Cape › Garden Route › Plettenberg Bay › Keurboomstrand"
export function placeText(pl) {
  if (!pl) return "";
  return [pl.c, pl.p, (pl.r || []).join(" / "), pl.t, pl.s && pl.s !== pl.t ? pl.s : ""].filter(Boolean).join(" › ");
}
// What a StockNetwork row should say for a place: Country, State (province),
// Area (main Avante region), City, Suburb (the town when there is none),
// District (local municipality).
export function snFieldsFromPlace(pl) {
  const t = pl.t && !/^\(/.test(pl.t) ? pl.t : "";
  return {
    country: pl.c || "",
    state: pl.p && !/^\(/.test(pl.p) ? pl.p : "",
    area: (pl.r && pl.r[0] && !/^\(/.test(pl.r[0])) ? pl.r[0] : "",
    city: t,
    suburb: pl.s && pl.s !== t ? pl.s : t,
    district: String(pl.d || "").replace(/ (Local )?Municipality$/, ""),
  };
}

function isNotTown(t) {
  return !t || /municipality|munisipaliteit|district/i.test(t) || (RULES.notTown || []).includes(t);
}

// ---------- Google ----------
export async function googleLookup(lat, lng, apiKey) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json?latlng=" +
    encodeURIComponent(lat) + "," + encodeURIComponent(lng) + "&key=" + encodeURIComponent(apiKey);
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try { res = await fetch(url, { signal: controller.signal }); } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, reason: e && e.name === "AbortError" ? "timeout" : "network" };
  }
  if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, reason: "bad_response" }; }
  if (!data || data.status !== "OK" || !Array.isArray(data.results) || !data.results.length) {
    return { ok: false, reason: (data && data.status) || "unknown", message: (data && data.error_message) || "" };
  }
  // results[0] is the most specific; fill any missing level from the broader results.
  function find(...types) {
    for (const r of data.results) for (const type of types) {
      const c = (r.address_components || []).find((c) => Array.isArray(c.types) && c.types.includes(type));
      if (c && c.long_name) return c.long_name;
    }
    return "";
  }
  return {
    ok: true,
    country: find("country"),
    province: find("administrative_area_level_1"),
    municipality: find("administrative_area_level_3", "administrative_area_level_2"),
    district: find("administrative_area_level_2"),
    town: find("locality", "postal_town"),
    suburb: find("sublocality_level_1", "sublocality", "neighborhood"),
    address: data.results[0].formatted_address || "",
  };
}

// ---------- rules: Google's answer -> tree place ----------
export function placeFromGoogle(g, lat, lng) {
  const spell = RULES.spell || {}, parent = RULES.parent || {}, metro = RULES.metro || {}, afr = RULES.afr || {}, provEn = RULES.provEn || {};
  const c = g.country || "";
  let p = provEn[g.province] || g.province || "";
  if (c === "South Africa" && !p) p = provinceAt(lat, lng);
  let t = spell[g.town] || g.town || "";
  let s = spell[g.suburb] || g.suburb || "";
  let d = afr[g.district] || g.district || "";
  if (/distriksmunisipaliteit/i.test(d)) d = d.replace(/\s*distriksmunisipaliteit/i, "") + " District Municipality";
  if (c === "South Africa" && isNotTown(t)) t = nearestTown(lat, lng, 25) || nearestTown(lat, lng, 80, 2) || t || "(no town)";
  if (!t) t = "(no town)";
  if (parent[t]) { s = t; t = parent[t]; }
  if (s && (s.toLowerCase() === t.toLowerCase() || /[0-9&@]/.test(s) || /^(central|resort|bed ?& ?breakfast)$/i.test(s))) s = "";
  const m = metro[d];
  const a = m && m !== t && c === "South Africa" ? [[m, t]] : [];
  let r;
  if (c === "South Africa") { r = regionsAt(lat, lng); if (!r.length) r = ["(no region)"]; }
  else r = [p || "(unknown)"];
  return { c, p: p || "(pin needs checking)", r, t, s, a, d };
}

export function keyOf(lat, lng) {
  return Number(lat).toFixed(6) + "," + Number(lng).toFixed(6);
}
// Two pins within 500 m count as the same spot (SN and the hub round differently).
export function sameSpot(k1, k2) {
  if (!k1 || !k2) return false;
  const [a1, o1] = String(k1).split(",").map(Number), [a2, o2] = String(k2).split(",").map(Number);
  return km(a1, o1, a2, o2) < 0.5;
}

// Looks a coordinate up with Google and places it. null if Google can't answer.
export async function placeCoordinate(lat, lng, apiKey) {
  const g = await googleLookup(lat, lng, apiKey);
  if (!g.ok) return { ok: false, reason: g.reason, message: g.message || "" };
  return { ok: true, place: { ...placeFromGoogle(g, lat, lng), k: keyOf(lat, lng), at: new Date().toISOString() }, google: g };
}

// ---------- the live placements store ----------
export const PLACES_STORE = "tree-places";
export const ACTIVITY_KEY = "activities";
export const PROPERTY_KEY = "properties";

// Places the given resort rows that have no placement yet, or whose pin moved,
// within a time budget. Returns counts. Saves once at the end.
export async function placeResortBacklog(store, resorts, apiKey, budgetMs = 9000, onlyIdxs = null) {
  const map = (await store.get(PROPERTY_KEY, { type: "json" })) || {};
  // Not seeded from the approved tree yet: wait, rather than re-looking up
  // thousands of properties that already have an approved place.
  if (!Object.keys(map).length) return { skipped: "not seeded yet", todo: 0, placed: 0, failed: 0, total: 0 };
  const began = Date.now();
  const todo = [];
  const seen = new Set();
  (onlyIdxs ? onlyIdxs.map((i) => resorts[i]) : resorts).forEach((rec) => {
    if (!rec || !rec.resortId || seen.has(rec.resortId)) return;
    const lat = parseFloat(rec.latitude), lng = parseFloat(rec.longitude);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
    seen.add(rec.resortId);
    const have = map[rec.resortId];
    if (have && sameSpot(have.k, keyOf(lat, lng))) return;
    todo.push({ id: rec.resortId, lat, lng });
  });
  let placed = 0, failed = 0, skipped = 0, denied = "";
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const it = todo[i++];
      if (Date.now() - began > budgetMs || denied) { skipped++; continue; }
      const r = await placeCoordinate(it.lat, it.lng, apiKey);
      if (r.ok) { map[it.id] = r.place; placed++; }
      else { failed++; if (r.reason === "REQUEST_DENIED" || r.reason === "OVER_QUERY_LIMIT") denied = r.reason; }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (placed) await store.setJSON(PROPERTY_KEY, map);
  return { todo: todo.length, placed, failed, skipped, denied, total: Object.keys(map).length };
}

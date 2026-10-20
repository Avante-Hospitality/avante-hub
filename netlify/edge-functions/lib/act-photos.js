// Photos for "things to do" on front stores (Jean, 2026-10-14): filled in by
// themselves, library first, Google only when the library has nothing.
//   1. the activity's own photos on the Avante map (map-activities photoKeys)
//   2. the shared photo library (avante-hooks /api/library): photos tagged
//      with this activity ("act:<id>"), or a Google search for the same words
//      that anyone (hook builder or front store) has done before
//   3. Google: a new search; its photos go into the library (as Google's
//      reference, the way the hook builder keeps Google photos), so the next
//      front store or hook gets them from the library.
// What was found is remembered per activity ("act-photos" store), so a page
// view doesn't search again. Google photos are shown through /api/stay?gphoto=
// and library photos through /api/stay?libphoto= (the library itself is
// private to the hook builder).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { GREF, LIBID, gphotoUrl, libphotoUrl, itemUrl, libIndex, libPost, forgetIndex, townTagOf } from "./photo-library.js";
export { GREF, LIBID, gphotoUrl, libphotoUrl, townTagOf };

const PLACES = "https://places.googleapis.com/v1";
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";

async function timed(url, init, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({}, init || {}, { signal: c.signal })); } finally { clearTimeout(t); }
}
// Admin's main photos (set in the hook builder or library): { activityId (lower case): url }.
export async function mainActPhotos() {
  const idx = await libIndex(), out = {};
  for (const [k, m] of Object.entries(idx.mains || {})) {
    if (!/^act:/.test(k) || !m) continue;
    const it = idx.items.find((x) => x.id === m.id), u = it && itemUrl(it);
    if (u) out[k.slice(4)] = u;
  }
  return out;
}
// Admin changed an activity's photos on the map: that photo is now its main
// photo, so an older main photo chosen in the hook builder no longer applies.
export async function clearActMain(id) { forgetIndex(); return libPost({ op: "clearMain", key: "act:" + String(id).toLowerCase() }); }
// A photo admin gave an activity in Map & Activities goes into the shared
// photo library, tagged with the activity (and its town in the location tree),
// and becomes the activity's main photo (Jean, 2026-10-14).
//   upload: { full, thumb, w, h, hash } made in admin's browser;  google: { ref, credit }
export async function activityToLibrary(a, place, photo) {
  const tags = [{ key: "act:" + a.id, name: a.name || "Activity" }], town = townTagOf(place);
  if (town) tags.push(town);
  let d;
  if (photo.ref) {
    if (!GREF.test(photo.ref)) return { ok: false, error: "Bad Google reference" };
    d = await libPost({ op: "addRef", item: { name: a.name || "Activity", tags, src: "google:" + photo.ref, source: "google", ref: photo.ref, credit: String(photo.credit || "Photo via Google").slice(0, 160) } });
  } else {
    d = await libPost({ op: "add", item: { name: a.name || "Activity", tags, src: "hub-activity:" + photo.key, source: "hub", w: +photo.w || 0, h: +photo.h || 0,
      hash: /^[0-9a-f]{16}$/.test(photo.hash || "") ? photo.hash : "" }, full: String(photo.full || ""), thumb: String(photo.thumb || "") });
  }
  if (!d || !d.ok) return { ok: false, error: (d && d.error) || "The photo library didn't answer." };
  const m = await libPost({ op: "setMain", key: "act:" + String(a.id).toLowerCase(), id: d.id });
  forgetIndex();
  return { ok: true, id: d.id, main: !!(m && m.ok) };
}
export const actQuery = (a) => [a.name, a.area].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200);

// Library photos for one activity: tagged with it, then an earlier Google search for the same words.
export async function libraryPhotos(a) {
  const idx = await libIndex(), out = [], seen = new Set();
  const add = (it) => { const u = it && itemUrl(it); if (u && !seen.has(u)) { seen.add(u); out.push({ url: u, credit: it.credit || "", source: it.source || "" }); } };
  if (a.id) idx.items.filter((it) => (it.tags || []).some((t) => t.key === "act:" + a.id)).sort((x, y) => (x.source === "google") - (y.source === "google")).forEach(add);
  // An earlier search's photos — only those still in the library (the photo link only serves library photos).
  const g = idx.gq[actQuery(a)];
  if (g && Array.isArray(g.refs)) for (const ref of g.refs) add(idx.items.find((it) => it.src === "google:" + ref));
  return out;
}

// A Google search for the activity: its photo references (no photo files), put into the library.
export async function googlePhotos(a, opts) {
  const key = env("GOOGLE_PLACES_API_KEY"); if (!key) return { ok: false, error: "Google photos aren't set up on this site." };
  const q = (opts && opts.query) || actQuery(a); if (!q) return { ok: false, error: "Nothing to search for." };
  const body = { textQuery: q, maxResultCount: 1 };
  if (isFinite(a.latitude) && isFinite(a.longitude) && a.latitude) body.locationBias = { circle: { center: { latitude: +a.latitude, longitude: +a.longitude }, radius: 5000 } };
  let d;
  try {
    const r = await timed(PLACES + "/places:searchText", { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.displayName,places.photos" }, body: JSON.stringify(body) });
    d = await r.json(); if (!r.ok) return { ok: false, error: "Google answered: " + ((d && d.error && d.error.message) || r.status) };
  } catch (_) { return { ok: false, error: "Google didn't respond. Try again." }; }
  const pl = d && d.places && d.places[0];
  const photos = ((pl && pl.photos) || []).slice(0, (opts && opts.limit) || 6);
  if (!photos.length) return { ok: false, error: pl ? "Google has no photos for that. Try other words." : "Google found nothing for that. Try other words." };
  const place = (pl.displayName && pl.displayName.text) || "";
  const tags = a.id ? [{ key: "act:" + a.id, name: a.name || "Activity" }] : [];
  const out = [], saves = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i], au = Array.isArray(p.authorAttributions) && p.authorAttributions[0];
    const credit = au && au.displayName ? au.displayName + " via Google" : "Photo via Google";
    out.push({ url: gphotoUrl(p.name), credit, source: "google" });
    saves.push(libPost({ op: "addRef", item: { name: (place || a.name || "Activity") + " Google " + (i + 1), tags, src: "google:" + p.name, source: "google", ref: p.name, credit, w: p.widthPx || 0, h: p.heightPx || 0 } }));
  }
  // Into the library one after the other (the library keeps one list), then the search itself.
  for (const sv of saves) await sv;
  await libPost({ op: "gq", q, refs: photos.map((p) => p.name), place });
  forgetIndex();
  return { ok: true, place, photos: out };
}

// Admin picks an activity's default photo from the library (Jean, 2026-10-20).
export async function setActMain(id, libId) {
  if (!LIBID.test(String(libId || ""))) return { ok: false, error: "Bad photo" };
  const idx = await libIndex(); if (!idx.items.some((it) => it.id === libId)) return { ok: false, error: "That photo is no longer in the library." };
  const r = await libPost({ op: "setMain", key: "act:" + String(id).toLowerCase(), id: libId });
  forgetIndex();
  return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "The photo library didn't answer." };
}
// The photo each activity shows now: admin's main photo, else its map photo, else the one found by itself.
export async function defaultActPhotos(acts) {
  const [mains, memo] = await Promise.all([mainActPhotos().catch(() => ({})), liveRemembered().catch(() => ({}))]), out = {};
  for (const a of acts || []) {
    const keys = Array.isArray(a.photoKeys) ? a.photoKeys : a.photoKey ? [a.photoKey] : [];
    const main = mains[String(a.id || "").toLowerCase()], base = keys[0] ? "/api/property-file?key=" + encodeURIComponent(keys[0]) : "";
    out[a.id] = { url: main || base || memo[a.id] || "", from: main ? "main" : base ? "map" : memo[a.id] ? "auto" : "" };
  }
  return out;
}

// The remembered photo per activity id: { id: url }.
const memo = () => getStore({ name: "act-photos", consistency: "strong" });
export async function rememberedPhotos() { return (await memo().get("map", { type: "json" }).catch(() => null)) || {}; }
// A remembered Google photo that is no longer in the library can't be shown
// (/api/stay?gphoto= only serves the library's own) — Jean, 2026-10-20: most
// of The Dunes' things to do lost their photo this way. Those count as
// "not looked for yet", so they are found again (library first, then Google).
export async function liveRemembered() {
  const [map, idx] = await Promise.all([rememberedPhotos(), libIndex()]);
  if (!idx.items.length) return map; // library not reachable: keep what we have
  const refs = new Set(idx.items.filter((it) => it.source === "google" && it.ref).map((it) => it.ref)), out = {};
  for (const [id, u] of Object.entries(map)) {
    const m = /[?&]gphoto=([^&]+)/.exec(u || "");
    if (m && !refs.has(decodeURIComponent(m[1]))) continue; // gone from the library: look again
    out[id] = u;
  }
  return out;
}
// Finds (library first, then Google) and remembers a photo for each activity that has none yet.
export async function fillActPhotos(acts, max) {
  const todo = (acts || []).filter((a) => a && a.id).slice(0, max || 10);
  if (!todo.length) return {};
  const found = {};
  // One activity at a time: the library keeps one list, and saves made at the
  // same moment could overwrite each other (that lost photos before).
  for (const a of todo) {
    const lib = await libraryPhotos(a);
    if (lib.length) { found[a.id] = lib[0].url; continue; }
    const g = await googlePhotos(a, { limit: 3 });
    if (g.ok && g.photos.length) found[a.id] = g.photos[0].url;
    else if (g.error && /didn't respond|answered/.test(g.error)) continue; // Google hiccup: try again next time
    else found[a.id] = ""; // "" = looked, nothing found
  }
  const map = await rememberedPhotos();
  Object.assign(map, found);
  await memo().setJSON("map", map);
  return found;
}

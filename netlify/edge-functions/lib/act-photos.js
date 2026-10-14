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
import { HOOKS_URL, makeHooksTicket } from "./hooks-ticket.js";

const PLACES = "https://places.googleapis.com/v1";
export const gphotoUrl = (ref) => "/api/stay?gphoto=" + encodeURIComponent(ref);
export const libphotoUrl = (id) => "/api/stay?libphoto=" + encodeURIComponent(id);
export const GREF = /^places\/[\w-]+\/photos\/[\w-]+$/;
export const LIBID = /^L[0-9a-z]{6,20}$/;
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";

async function timed(url, init, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({}, init || {}, { signal: c.signal })); } finally { clearTimeout(t); }
}
async function bearer() { return "Bearer " + (await makeHooksTicket({ sub: "admin", name: "Avante front store", role: "admin" })); }

// The library's index, kept a few minutes per edge isolate.
let libCache = null;
async function libIndex() {
  if (libCache && Date.now() - libCache.at < 5 * 60 * 1000) return libCache.idx;
  try {
    const r = await timed(new URL("/api/library", HOOKS_URL).href, { headers: { authorization: await bearer() } }, 10000);
    const d = r.ok ? await r.json() : null;
    if (d && d.ok) { libCache = { at: Date.now(), idx: { items: d.items || [], gq: d.gq || {} } }; return libCache.idx; }
  } catch (_) { /* library not reachable: Google only */ }
  return { items: [], gq: {} };
}
async function libPost(body) {
  try {
    const r = await timed(new URL("/api/library", HOOKS_URL).href, { method: "POST", headers: { "content-type": "application/json", authorization: await bearer() }, body: JSON.stringify(body) }, 8000);
    return await r.json().catch(() => null);
  } catch (_) { return null; }
}
const itemUrl = (it) => (it.source === "google" && it.ref && GREF.test(it.ref) ? gphotoUrl(it.ref) : LIBID.test(it.id || "") ? libphotoUrl(it.id) : "");
export const actQuery = (a) => [a.name, a.area].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200);

// Library photos for one activity: tagged with it, then an earlier Google search for the same words.
export async function libraryPhotos(a) {
  const idx = await libIndex(), out = [], seen = new Set();
  const add = (it) => { const u = it && itemUrl(it); if (u && !seen.has(u)) { seen.add(u); out.push({ url: u, credit: it.credit || "", source: it.source || "" }); } };
  if (a.id) idx.items.filter((it) => (it.tags || []).some((t) => t.key === "act:" + a.id)).sort((x, y) => (x.source === "google") - (y.source === "google")).forEach(add);
  const g = idx.gq[actQuery(a)];
  if (g && Array.isArray(g.refs)) for (const ref of g.refs) add(idx.items.find((it) => it.src === "google:" + ref) || (GREF.test(ref) ? { source: "google", ref } : null));
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
  libCache = null;
  return { ok: true, place, photos: out };
}

// The remembered photo per activity id: { id: url }.
const memo = () => getStore({ name: "act-photos", consistency: "strong" });
export async function rememberedPhotos() { return (await memo().get("map", { type: "json" }).catch(() => null)) || {}; }
// Finds (library first, then Google) and remembers a photo for each activity that has none yet.
export async function fillActPhotos(acts, max) {
  const todo = (acts || []).filter((a) => a && a.id).slice(0, max || 10);
  if (!todo.length) return {};
  const found = {};
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (a) => {
      const lib = await libraryPhotos(a);
      if (lib.length) { found[a.id] = lib[0].url; return; }
      const g = await googlePhotos(a, { limit: 3 });
      if (g.ok && g.photos.length) found[a.id] = g.photos[0].url; else found[a.id] = ""; // "" = looked, nothing found
    }));
  }
  const map = await rememberedPhotos();
  Object.assign(map, found);
  await memo().setJSON("map", map);
  return found;
}

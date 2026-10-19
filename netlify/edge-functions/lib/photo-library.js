// The shared photo library (Jean, 2026-10-17): the hook builder's library
// (avante-hooks /api/library) is the one home for every photo in the hub.
// This file is the hub's only way in: read the index, add or tag photos, and
// work out which photos someone may see.
//
// Photos are filed by tags (what the photo is of), the same keys the hook
// builder's "What are the photos of?" uses:
//   act:<activityId>                 an activity
//   p:<ResortID>                     a property      u:<ResortID>|<unit>  a unit type
//   listing:<listingId>              a property onboarded in the hub, before it has a ResortID
//   c:<country>  pv:<country>|<province>  rg:<country>|<province>|<region>
//   t:<region or province>|<town>    a town          t:…|<town>|<suburb>  a suburb
// A property's photos belong to that property only: someone who isn't admin
// never sees a photo filed under another property.
import { HOOKS_URL, makeHooksTicket } from "./hooks-ticket.js";

export const GREF = /^places\/[\w-]+\/photos\/[\w-]+$/;
export const LIBID = /^L[0-9a-z]{6,20}$/;
export const gphotoUrl = (ref) => "/api/stay?gphoto=" + encodeURIComponent(ref);
export const libphotoUrl = (id, thumb) => "/api/stay?libphoto=" + encodeURIComponent(id) + (thumb ? "&th=1" : "");
// The address a photo is shown at (Google's are shown live, by reference).
export const itemUrl = (it) => (it.source === "google" && it.ref && GREF.test(it.ref) ? gphotoUrl(it.ref) : LIBID.test(it.id || "") ? libphotoUrl(it.id) : "");
const itemThumb = (it) => (it.source === "google" ? itemUrl(it) : LIBID.test(it.id || "") ? libphotoUrl(it.id, true) : "");

async function timed(url, init, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({}, init || {}, { signal: c.signal })); } finally { clearTimeout(t); }
}
async function bearer() { return "Bearer " + (await makeHooksTicket({ sub: "admin", name: "Avante hub", role: "admin" })); }
const LIB_API = () => new URL("/api/library", HOOKS_URL).href;

// A Google photo for a front store (Jean, 2026-10-19): only one Avante's library
// has (nobody can use Avante's Google key for any photo). Never kept: Google's
// terms. -> { data, type } or null.
export async function libGooglePhoto(ref, key) {
  if (!GREF.test(ref || "") || !key) return null;
  const idx = await libIndex();
  if (!(idx.items || []).some((x) => x.source === "google" && x.ref === ref)) return null; // not one of Avante's
  const r = await timed("https://places.googleapis.com/v1/" + ref + "/media?maxWidthPx=1200&key=" + encodeURIComponent(key), {}, 12000).catch(() => null);
  const type = (r && r.headers.get("content-type")) || "";
  return r && r.ok && type.startsWith("image/") ? { data: await r.arrayBuffer(), type } : null;
}

// The library's index, kept a few minutes per edge isolate.
let libCache = null;
export function forgetIndex() { libCache = null; }
export async function libIndex() {
  if (libCache && Date.now() - libCache.at < 5 * 60 * 1000) return libCache.idx;
  try {
    const r = await timed(LIB_API(), { headers: { authorization: await bearer() } }, 10000);
    const d = r.ok ? await r.json() : null;
    if (d && d.ok) { libCache = { at: Date.now(), idx: { items: d.items || [], gq: d.gq || {}, mains: d.mains || {} } }; return libCache.idx; }
  } catch (_) { /* library not reachable */ }
  return { items: [], gq: {}, mains: {} };
}
// A change to the library. Answers the library's JSON, or null when it can't be reached.
export async function libPost(body) {
  try {
    const r = await timed(LIB_API(), { method: "POST", headers: { "content-type": "application/json", authorization: await bearer() }, body: JSON.stringify(body) }, 8000);
    return await r.json().catch(() => null);
  } catch (_) { return null; }
}
// One photo's file (full size, or its thumbnail): { data, type } or null.
export async function libImage(id, thumb) {
  if (!LIBID.test(id || "")) return null;
  const r = await timed(LIB_API() + "?img=" + encodeURIComponent(id) + (thumb ? "&th=1" : ""), { headers: { authorization: await bearer() } }, 10000).catch(() => null);
  if (!r || !r.ok) return null;
  return { data: await r.arrayBuffer(), type: r.headers.get("content-type") || "image/jpeg" };
}

// ---------- filing ----------
export const normName = (s) => String(s || "").toLowerCase().replace(/[‘’'`]/g, "").replace(/[^a-z0-9&]+/g, " ").trim();

// The library tags for a place in the hub's location tree, smallest first:
// suburb, town, region, province, country. pl = { c, p, r, t, s } (r may be a list).
export function placeTags(pl) {
  if (!pl) return [];
  const c = String(pl.c || "").trim(), p = String(pl.p || "").trim(), t = String(pl.t || "").trim(), s = String(pl.s || "").trim();
  const r = String((Array.isArray(pl.r) ? pl.r[0] : pl.r) || "").trim();
  const out = [];
  const hasRegion = r && normName(r) !== normName(p);
  const area = hasRegion ? r : p; // the hook builder's town keys hang off the region, or the province when there is none
  if (t && area) {
    const town = "t:" + area + "|" + normName(t);
    if (s && normName(s) !== normName(t)) out.push({ key: town + "|" + normName(s), name: s, level: "suburb" });
    out.push({ key: town, name: t, level: "town" });
  }
  if (c && p && hasRegion) out.push({ key: "rg:" + c + "|" + p + "|" + r, name: r, level: "region" });
  if (c && p) out.push({ key: "pv:" + c + "|" + p, name: p, level: "province" });
  if (c) out.push({ key: "c:" + c, name: c, level: "country" });
  return out;
}
export function townTagOf(pl) {
  const t = placeTags(pl).find((x) => x.level === "town");
  return t ? { key: t.key, name: t.name } : null;
}

// The tags of one property: the property itself (and its unit types), or the
// hub listing while it has no ResortID yet.
export function propertyTags({ resortId, listingId, name }) {
  const out = [];
  if (resortId) out.push({ key: "p:" + String(resortId).toLowerCase(), name: name || "Property", level: "property" });
  if (listingId) out.push({ key: "listing:" + listingId, name: name || "Property", level: "property" });
  return out;
}
export const unitTag = (resortId, unitName, propertyName) =>
  resortId && unitName ? { key: "u:" + String(resortId).toLowerCase() + "|" + normName(unitName), name: (propertyName ? propertyName + " — " : "") + unitName, level: "unit" } : null;

const lc = (k) => String(k || "").toLowerCase();
const OWNED = /^(p|u|listing):/i;
const ownerOf = (key) => { const k = lc(key); return k.startsWith("u:") ? "p:" + k.slice(2).split("|")[0] : k; };

// Who may see what. scope = { admin: true } or { own: [property/listing keys] }.
// Not admin: only photos with no other property's tag on them.
export function visibleTo(scope, it) {
  if (scope && scope.admin) return true;
  const tags = it.tags || [];
  if (!tags.length) return false;
  const own = new Set(((scope && scope.own) || []).map(lc));
  return tags.every((t) => !OWNED.test(t.key || "") || own.has(ownerOf(t.key)));
}
// Does the photo sit under this filing key (a town includes its suburbs, a property its unit types)?
function filedUnder(it, key) {
  const k = lc(key), unitsOf = k.startsWith("p:") ? "u:" + k.slice(2) + "|" : null;
  return (it.tags || []).some((t) => { const x = lc(t.key); return x === k || x.startsWith(k + "|") || (unitsOf && x.startsWith(unitsOf)); });
}

// Photos for the chooser: filed under any of keys (or anything, when keys is
// empty), whose name or tags contain every word of q. Newest first, at most max.
export async function findPhotos(scope, { keys, q, max, filesOnly }) {
  const idx = await libIndex();
  const words = normName(q).split(" ").filter(Boolean);
  const want = (keys || []).filter(Boolean);
  const out = [];
  for (let i = idx.items.length - 1; i >= 0 && out.length < (max || 120); i--) {
    const it = idx.items[i];
    if (!visibleTo(scope, it)) continue;
    if (filesOnly && it.source === "google") continue; // Google photos are kept by reference only, never as files
    if (want.length && !want.some((k) => filedUnder(it, k))) continue;
    if (words.length) { const text = normName([it.name].concat((it.tags || []).map((t) => t.name)).join(" ")); if (!words.every((w) => text.includes(w))) continue; }
    const full = itemUrl(it); if (!full) continue;
    out.push({ id: it.id, name: it.name || "Photo", full, thumb: itemThumb(it) || full, credit: it.credit || "", source: it.source || "", tags: (it.tags || []).map((t) => t.name).filter(Boolean) });
  }
  return out;
}

// The "Show photos for" list of the chooser, closest first: the unit type,
// the property, then its place in the tree (suburb up to country).
const LEVEL_WORD = { unit: "This unit", property: "This property", suburb: "Suburb", town: "Town", region: "Region", province: "Province", country: "Country" };
export function filingFor({ resortId, listingId, name, unit, place }) {
  const out = [];
  const u = unitTag(resortId, unit, name); if (u) out.push({ key: u.key, name: LEVEL_WORD.unit + ": " + unit });
  // A property can be filed both by its ResortID and as a hub listing: one choice finds both.
  const own = propertyTags({ resortId, listingId, name });
  if (own.length) out.push({ key: own.map((t) => t.key).join("\n"), name: LEVEL_WORD.property + ": " + (name || "this property") });
  for (const t of placeTags(place)) out.push({ key: t.key, name: LEVEL_WORD[t.level] + ": " + t.name });
  return out;
}

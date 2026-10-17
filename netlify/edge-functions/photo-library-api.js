// /api/photo-library — the photo chooser's way into the shared photo library
// (Jean, 2026-10-17: one photo chooser everywhere in the hub, filed in the
// library). See lib/photo-library.js for how photos are filed and who sees what.
//
// POST { action: "find", keys: [filing keys], q, filesOnly, ...who }  -> { photos }
// POST { action: "filing", resortId, listingId, name, unit, place: { c, p, r, t, s } }
//      the "Show photos for" list                                -> { filing: [{ key, name }] }
// POST { action: "toListing", listingId, ids: [library ids], ...who }
//      copies library photos into the listing's own files       -> { files: [{ id, key, fileName, caption }] }
// who: { token } (admin), or { listingId, key } (the listing's private edit key).
// Anyone else sees only photos that belong to no property (places, activities).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { isAdminToken } from "./lib/admin-session.js";
import { findPhotos, filingFor, libIndex, libImage, visibleTo, propertyTags } from "./lib/photo-library.js";
import { saveListingFile } from "./lib/listing-files.js";

const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 200);
const json = (d, s) => new Response(JSON.stringify(d), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// { admin } or { own: [this listing's property keys], listing }
async function scopeOf(body) {
  if (await isAdminToken(clean(body.token, 200))) return { admin: true };
  const listingId = clean(body.listingId, 20), key = clean(body.key, 200);
  if (listingId && key) {
    const rec = await getStore({ name: "property-listings", consistency: "strong" }).get(listingId, { type: "json" }).catch(() => null);
    if (rec && rec.editToken && rec.editToken === key) return { own: propertyTags({ resortId: rec.resortId, listingId }).map((t) => t.key), listing: listingId };
  }
  return { own: [] };
}

async function toListing(scope, body) {
  const listingId = clean(body.listingId, 60);
  // A new listing's photos go under its draft name until it is submitted;
  // an existing listing only with its edit key or admin.
  if (!/^draft-[\d-]+$/.test(listingId) && !scope.admin && scope.listing !== listingId) return json({ ok: false, error: "This listing can't take photos from here." }, 403);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => clean(x, 30)).slice(0, 30);
  const idx = await libIndex(), store = getStore({ name: "property-listing-files", consistency: "strong" });
  const files = [];
  for (const id of ids) {
    const it = idx.items.find((x) => x.id === id);
    if (!it || !visibleTo(scope, it)) { files.push({ id, error: "Not available" }); continue; }
    if (it.source === "google") { files.push({ id, error: "Google photos can't be copied" }); continue; }
    const img = await libImage(id);
    if (!img) { files.push({ id, error: "The library didn't send the photo" }); continue; }
    const fileName = clean(it.name || "photo", 80) + ".jpg";
    const key = await saveListingFile(store, { listingId, kind: "image", label: "library", fileName, contentType: img.type, data: img.data });
    files.push({ id, key, fileName, caption: it.credit ? "Photo: " + it.credit : "" });
  }
  return json({ ok: true, files });
}

export default async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Bad request" }, 400);
  try {
    const scope = await scopeOf(body);
    if (body.action === "find") {
      // A choice in "Show photos for" may hold several keys, one per line.
      const keys = (Array.isArray(body.keys) ? body.keys : []).flatMap((k) => String(k || "").split("\n")).map((k) => clean(k, 300)).filter(Boolean).slice(0, 20);
      return json({ ok: true, photos: await findPhotos(scope, { keys, q: clean(body.q, 80), max: 120, filesOnly: !!body.filesOnly }) });
    }
    if (body.action === "filing") {
      const pl = body.place && typeof body.place === "object" ? body.place : {};
      const place = { c: clean(pl.c, 80), p: clean(pl.p, 80), r: clean(pl.r, 80), t: clean(pl.t, 80), s: clean(pl.s, 80) };
      return json({ ok: true, filing: filingFor({ resortId: clean(body.resortId, 60), listingId: clean(body.listingId, 20), name: clean(body.name, 120), unit: clean(body.unit, 120), place }) });
    }
    if (body.action === "toListing") return await toListing(scope, body);
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api/photo-library" };

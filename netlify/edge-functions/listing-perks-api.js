// /api/listing-perks?resortId=<ResortID> (Jean, 2026-10-22) — the amenities a
// property ticked in its hub listing (property form, step 6), for the hook
// builder's perks when the property's Stock Network page lists only a few.
//   GET → { ok, perks: ["Swimming pool", …] }   (no listing: perks = [])
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { allListings, LISTINGS_STORE } from "./lib/blob-records.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 30;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: {
  "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "GET", // the hook builder reads it
  "cache-control": "public, max-age=600" } });

export default async (request) => {
  const rid = String(new URL(request.url).searchParams.get("resortId") || "").trim().toLowerCase();
  if (!GUID.test(rid)) return json({ ok: false, error: "That isn't a valid ResortID." }, 400);
  let listings;
  try { listings = await allListings(getStore({ name: LISTINGS_STORE, consistency: "strong" })); }
  catch (e) { console.error("listing-perks: couldn't read listings", e); return json({ ok: false, error: "Couldn't read the listings. Try again." }, 502); }
  // The property's newest listing.
  const mine = listings.filter((l) => String(l.resortId || "").toLowerCase() === rid)
    .sort((a, b) => String(b.dateUpdated || b.dateSubmitted || "").localeCompare(String(a.dateUpdated || a.dateSubmitted || "")))[0];
  const perks = [];
  for (const a of (mine && mine.amenities) || []) {
    const t = String((a && a.item) || "").trim();
    if (a && a.available === "Y" && t && !perks.some((p) => p.toLowerCase() === t.toLowerCase())) perks.push(t);
    if (perks.length >= MAX) break;
  }
  return json({ ok: true, perks });
};

export const config = { path: "/api/listing-perks" };

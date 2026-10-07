// Location tree lookup (standalone, 2026-10-07).
//
// Reverse-geocodes a small batch of coordinates with Google and returns the
// raw levels the new location tree needs: country, province
// (administrative_area_level_1), municipality (administrative_area_level_2),
// town (locality / postal_town) and suburb (sublocality / neighborhood).
//
// It only READS from Google and returns the answer to the admin page
// (tree-lookup.html). It writes nothing to any store, so it cannot change
// any property, zone, affiliate or anything else in the hub. Admin-only.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

const MAX_POINTS = 25;
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 8000;

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

async function lookup(lat, lng, apiKey) {
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
  // results[0] is the most specific match; fill any level it lacks from the
  // broader results that follow (rural points often have no suburb there).
  function find(...types) {
    for (const r of data.results) {
      for (const type of types) {
        const c = (r.address_components || []).find((c) => Array.isArray(c.types) && c.types.includes(type));
        if (c && c.long_name) return c.long_name;
      }
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

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Body must be JSON." }, 400); }
  if (!(await verifyAdminToken(body.token))) return json({ error: "Your admin session has expired. Log in again." }, 401);
  const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
  if (!apiKey) return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables." }, 400);

  const points = Array.isArray(body.points) ? body.points.slice(0, MAX_POINTS) : [];
  const results = new Array(points.length);
  let next = 0;
  async function worker() {
    while (next < points.length) {
      const i = next++;
      const [lat, lng] = String(points[i]).split(",").map(Number);
      results[i] = isFinite(lat) && isFinite(lng)
        ? { k: points[i], ...(await lookup(lat, lng, apiKey)) }
        : { k: points[i], ok: false, reason: "bad_coordinate" };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return json({ ok: true, results });
};

export const config = { path: "/api/tree-lookup" };

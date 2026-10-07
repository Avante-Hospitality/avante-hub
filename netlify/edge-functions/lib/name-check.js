// Name and address lookups that don't place anything (2026-10-07: what was
// left of lib/geolocate.js once the old zone/town tree was removed).
//  * checkNameAgainstCoordinate: does Google's answer for a property's NAME
//    land near its pin? Used by the nightly sync and suggestCoordinates.
//  * cachedForwardGeocode: address/name -> coordinate, cached in map-geocache.
import { forwardGeocode as forwardGeocodeAddress } from "./geocode.js";

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Forward-geocode cache key, in its own "fwd:" namespace so it can never
// collide with a reverse-lookup's "g:lat,lng" key in the same blob store.
function forwardGeoCacheKey(text) {
  return "fwd:" + String(text || "").trim().toLowerCase().slice(0, 200);
}

export async function cachedForwardGeocode(geoCache, text, apiKey) {
  const key = forwardGeoCacheKey(text);
  if (geoCache) {
    try {
      const hit = await geoCache.get(key, { type: "json" });
      if (hit && typeof hit.ok === "boolean") return Object.assign({}, hit, { cached: true });
    } catch (e) { /* cache trouble must never block a lookup */ }
  }
  const geo = await forwardGeocodeAddress(text, apiKey);
  if (geoCache && geo && (geo.ok || geo.reason === "ZERO_RESULTS")) {
    try { await geoCache.setJSON(key, geo); } catch (e) { /* best effort */ }
  }
  return geo;
}

// resorts-api.js's nightly sync can run the same "does this coordinate
// match the property's own name" check map-api.js's suggestCoordinates
// action already did — Case B of full-hub-coordinate-geocoding-scope.
const FORWARD_TIMEOUT_MS = 8000;
const NAME_MATCH_TYPES = ["establishment", "lodging", "point_of_interest", "premise", "subpremise", "street_address", "tourist_attraction", "campground", "rv_park"];

export async function forwardGeocodeByName(query, apiKey) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(query) + "&key=" + encodeURIComponent(apiKey);
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, reason: (e && e.name === "AbortError") ? "timeout" : "network", message: String((e && e.message) || e) };
  }
  if (!res.ok) return { ok: false, reason: "bad_response", message: "HTTP " + res.status };
  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, reason: "bad_response", message: "Response wasn't valid JSON" }; }
  if (!data || data.status !== "OK" || !Array.isArray(data.results) || !data.results.length) {
    return { ok: false, reason: (data && data.status) || "unknown", message: (data && data.error_message) || "" };
  }
  const top = data.results[0];
  const loc = top.geometry && top.geometry.location;
  if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return { ok: false, reason: "bad_response", message: "No location in result" };
  const types = Array.isArray(top.types) ? top.types : [];
  const countryComp = (top.address_components || []).find((c) => Array.isArray(c.types) && c.types.includes("country"));
  return {
    ok: true,
    lat: loc.lat,
    lng: loc.lng,
    types,
    nameMatch: types.some((t) => NAME_MATCH_TYPES.includes(t)),
    locationType: (top.geometry && top.geometry.location_type) || "",
    partial: !!top.partial_match,
    formatted: top.formatted_address || "",
    country: countryComp ? countryComp.long_name : "",
  };
}

// Checks a property's own NAME against a coordinate — used by
// map-api.js's suggestCoordinates action (a person-initiated batch check
// against an uploaded StockNetwork CSV) and, since 2026-09-29,
// resorts-api.js's nightly sync (Case B: flag a StockNetwork coordinate
// that doesn't match the property's own name, right when that coordinate
// just changed). Confidence:
//   high   — Google matched the actual business (not just its town) AND
//            the point is within 15 km of the coordinate already on file.
//   review — Google matched a business but there's nothing (missing/0,0)
//            or something far away (>15 km) to cross-check it against.
//   none   — Google only found the town/area, or nothing at all.
export async function checkNameAgainstCoordinate(name, lat, lng, apiKey) {
  const query = typeof name === "string" ? name.trim().slice(0, 300) : "";
  if (!query) return { confidence: "none", note: "No name to look up" };
  const g = await forwardGeocodeByName(query, apiKey);
  if (!g.ok) {
    return {
      confidence: "none",
      failed: g.reason !== "ZERO_RESULTS",
      reason: g.reason,
      message: g.message,
      note: g.reason === "ZERO_RESULTS" ? "Google found nothing for this name" : "Google: " + g.reason,
    };
  }
  const hasOld = isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
  const distKm = hasOld ? haversineKm(lat, lng, g.lat, g.lng) : null;
  let confidence = "none", note = "";
  if (!g.nameMatch) {
    note = "Google only found the area (" + (g.types[0] || "unknown") + "), not the property";
  } else if (hasOld && distKm <= 15) {
    confidence = "high"; note = "Matched by name; " + distKm.toFixed(1) + " km from the current pin";
  } else if (hasOld) {
    confidence = "review"; note = "Matched by name but " + distKm.toFixed(0) + " km from the current pin — check it is the right place";
  } else {
    confidence = "review"; note = "Matched by name; no usable current coordinate to cross-check against";
  }
  return {
    confidence, note,
    lat: Math.round(g.lat * 1e6) / 1e6,
    lng: Math.round(g.lng * 1e6) / 1e6,
    distKm: distKm === null ? null : Math.round(distKm * 10) / 10,
    formatted: g.formatted, googleType: g.types[0] || "", locationType: g.locationType, partial: g.partial,
    // country (2026-10-02): forwardGeocodeByName already pulls this off the
    // result's address_components — surfaced here too so fixPropertyCountry
    // in map-api.js can use a NAME match as a fallback country source when
    // the coordinate itself reverse-geocodes to ZERO_RESULTS (common for a
    // remote bush/safari camp with no mapped road nearby). Purely additive:
    // existing callers (suggestCoordinates, resorts-api.js's sync) destructure
    // only the fields they already used.
    country: g.country || "",
  };
}

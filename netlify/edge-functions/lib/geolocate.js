// The shared "where does this coordinate belong" engine — reverse-geocodes
// a lat/lng into Country/Zone/Town/Suburb/Nearby and finds-or-creates the
// matching Town/Suburb record, exactly as map-api.js's geocodeLocations,
// recheckZones, fixPropertyCountry and autoGeocodeRecord have always done.
//
// Extracted out of map-api.js (2026-09-29) so resorts-api.js's nightly
// StockNetwork sync can call the SAME resolution logic directly — after
// landing a new/changed coordinate from StockNetwork, it re-places the
// property in the Hub's tree right away instead of leaving it untagged
// until someone remembers to press "Re-check all zones" in admin. Nothing
// about the behaviour changed in this move — every function here is the
// same code that lived in map-api.js, just callable from more than one
// routed function now. See the towns-layer-implementation and
// full-hub-coordinate-geocoding-scope project docs for the history.
//
// Deliberately depends only on lib/zones.js and lib/geocode.js (already
// shared) — never on map-api.js or resorts-api.js themselves, so this
// stays a leaf module either file can import without pulling the other in.

import { LEGACY_ZONES, provinceToZone, districtToZone, normalizeZone, isValidZone, locateZone } from "./zones.js";
import { reverseGeocode, forwardGeocode as forwardGeocodeAddress } from "./geocode.js";

function clean(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max || 500) : "";
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Kept fairly tight (rather than "whichever town is least far away, however
// far that is") so the fallback below only fires when a nearby town is
// genuinely a reasonable stand-in for "what Region is this in" — not a
// guess across hundreds of km of empty map.
export const NEAREST_TOWN_MAX_KM = 100;

export const SAME_TOWN_MAX_KM = 60;
export const SAME_ZONE_TOWN_MAX_KM = 150;

// A point this close to a zone edge still counts as land — the zone polygons
// are simplified (~400 m) so a beach property can sit just outside them.
const COAST_SLACK_KM = 4;

export const SA_NAME = "South Africa";

// Stored on every resort row the location pass has tagged, so the CSV export
// knows the row carries the full set of fields (country, nearby flag) rather
// than an older, less complete tag.
export const LOCATION_TAG_VERSION = 2;

function genTownId() {
  const n = Math.floor(Math.random() * 900000) + 100000;
  return "T-" + n;
}

export function genTownUniqueId(existingIds) {
  let id = genTownId();
  while (existingIds.has(id)) {
    id = genTownId();
  }
  return id;
}

function genSuburbId() {
  const n = Math.floor(Math.random() * 900000) + 100000;
  return "SB-" + n;
}

export function genSuburbUniqueId(existingIds) {
  let id = genSuburbId();
  while (existingIds.has(id)) {
    id = genSuburbId();
  }
  return id;
}

export function allSuburbIds(towns) {
  const ids = new Set();
  towns.forEach((t) => {
    (Array.isArray(t.suburbs) ? t.suburbs : []).forEach((s) => { if (s && s.id) ids.add(s.id); });
  });
  return ids;
}

export function okZone(z) {
  const n = normalizeZone(z);
  return isValidZone(n) ? clean(n, 120) : "";
}

export function townCountry(t) {
  return (t && t.country) || SA_NAME;
}

// A town's zone as it should be shown. A town still carrying the old combined
// "Eastern Cape & Garden Route" name (not yet corrected by Re-check all zones)
// is placed by its own coordinates instead of being guessed as Eastern Cape.
export function townZone(t) {
  const z = String((t && t.zone) || "");
  if (LEGACY_ZONES[z]) {
    const lat = parseFloat(t.latitude), lng = parseFloat(t.longitude);
    if (isFinite(lat) && isFinite(lng)) {
      const at = locateZone(lat, lng);
      if (at.zone && at.km <= COAST_SLACK_KM) return at.zone;
    }
  }
  return normalizeZone(z);
}

export function townDistanceKm(t, lat, lng) {
  const tLat = parseFloat(t.latitude);
  const tLng = parseFloat(t.longitude);
  if (!isFinite(tLat) || !isFinite(tLng)) return Infinity;
  return haversineKm(lat, lng, tLat, tLng);
}

// The closest existing town (by straight-line distance, among towns that
// have coordinates of their own — and, when a country is given, in that same
// country) to a coordinate Google couldn't put in a town — or null if nothing
// is within maxKm. Returns { town, km }.
export function nearestTown(allTowns, lat, lng, maxKm, country) {
  let best = null;
  let bestDist = Infinity;
  for (const t of allTowns) {
    if (country && townCountry(t) !== country) continue;
    const d = townDistanceKm(t, lat, lng);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best && bestDist <= maxKm ? { town: best, km: bestDist } : null;
}

// A district/municipality name that came back in the "town" slot when Google
// had no real locality for the point (a farm, a reserve): not a town.
function looksLikeDistrict(name) {
  return /\b(district|municipality|metropolitan|metro)\b/i.test(name || "");
}

// Finds (or creates) the Town / Suburb a geocoded coordinate resolves to.
// Matched by name (case-insensitive) AND place — a same-named town more than
// SAME_TOWN_MAX_KM away is a different town and gets its own record. Follows
// the same "never overwrite what's already set" rule as discoverLocations'
// apply step — a blank zone/coordinate is filled in but a value an admin (or
// an earlier run) already set never is — UNLESS `force` is true, in which case
// a different zone DOES get overwritten. `force` exists for recheckZones, a
// deliberate correction pass — never pass force:true from an automatic path.
// Mutates `allTowns` in place and returns the ids to tag onto whichever
// property/activity/resort row this coordinate came from.
export function ensureTownAndSuburb(allTowns, existingIds, townName, zoneName, suburbName, lat, lng, force, country) {
  const cleanTown = clean(townName, 120);
  if (!cleanTown) return null;
  const zone = okZone(zoneName);
  const ctry = country || SA_NAME;

  // Towns made before country was recorded have none set: they match on name
  // and distance alone, and are stamped with the country below.
  const sameName = allTowns.filter((t) => (t.name || "").toLowerCase() === cleanTown.toLowerCase() && (!t.country || t.country === ctry));
  let town = null;
  if (sameName.length) {
    let best = null;
    let bestKm = Infinity;
    sameName.forEach((t) => {
      const d = lat != null ? townDistanceKm(t, lat, lng) : Infinity;
      if (d < bestKm) { bestKm = d; best = t; }
    });
    if (best && bestKm <= SAME_TOWN_MAX_KM) town = best;
    // A same-named town in the SAME zone, a bit further away, is still the
    // same place (a big city such as Cape Town spans well over 60 km).
    else if (best && zone && bestKm <= SAME_ZONE_TOWN_MAX_KM && townZone(best) === zone) town = best;
    // No coordinates anywhere to compare (an old record typed in by hand):
    // fall back to the old name-only match rather than duplicating it.
    else if (!isFinite(bestKm)) town = sameName[0];
  }

  let createdTown = false;
  let zoneChangedFrom = null;
  if (!town) {
    town = {
      id: genTownUniqueId(existingIds),
      name: cleanTown,
      area: "",
      zone: zone,
      country: ctry,
      affId: "",
      description: "",
      latitude: lat != null ? String(lat) : "",
      longitude: lng != null ? String(lng) : "",
      visible: true,
      suburbs: [],
      createdAt: new Date().toISOString(),
    };
    town.updatedAt = town.createdAt;
    existingIds.add(town.id);
    allTowns.push(town);
    createdTown = true;
  } else {
    if (!town.country) town.country = ctry;
    if (!town.latitude && lat != null) town.latitude = String(lat);
    if (!town.longitude && lng != null) town.longitude = String(lng);
    const stored = String(town.zone || "");
    if (force) {
      // The zone this TOWN belongs in: from its own coordinates when it is a
      // South African place, otherwise the zone worked out for this lookup.
      let want = zone;
      const tLat = parseFloat(town.latitude);
      const tLng = parseFloat(town.longitude);
      if (ctry === SA_NAME && isFinite(tLat) && isFinite(tLng)) {
        const at = locateZone(tLat, tLng);
        if (at.zone && at.km <= COAST_SLACK_KM) want = at.zone;
      }
      if (want && want !== stored) {
        zoneChangedFrom = stored || "(none)";
        town.zone = want;
      }
    } else if ((!stored || LEGACY_ZONES[stored]) && zone) {
      town.zone = zone;
    }
  }
  if (!Array.isArray(town.suburbs)) town.suburbs = [];

  const cleanSuburb = clean(suburbName, 120);
  let suburbId = "";
  let createdSuburb = false;
  if (cleanSuburb && cleanSuburb.toLowerCase() !== cleanTown.toLowerCase()) {
    let suburb = town.suburbs.find((s) => (s.name || "").toLowerCase() === cleanSuburb.toLowerCase());
    if (!suburb) {
      suburb = {
        id: genSuburbUniqueId(allSuburbIds(allTowns)),
        name: cleanSuburb,
        affId: "",
        latitude: lat != null ? String(lat) : "",
        longitude: lng != null ? String(lng) : "",
        visible: true,
      };
      town.suburbs.push(suburb);
      createdSuburb = true;
    }
    suburbId = suburb.id;
  }

  const locationLabel = suburbId ? (cleanSuburb + ", " + cleanTown) : cleanTown;
  return {
    zone: okZone(town.zone) || zone, townId: town.id, suburbId, locationLabel, createdTown, createdSuburb,
    zoneChangedFrom, townName: cleanTown, country: ctry,
    suburbName: suburbId ? cleanSuburb : "",
  };
}

// Reverse-geocodes through a cache so a coordinate never costs a second
// Google lookup, however many times any tool asks about it (Re-check all
// zones, the corrected-file export, a later re-run). Keys are the same
// 4-decimal (~11 m) rounding the batching code already groups by. Only a
// real answer, or Google's definitive ZERO_RESULTS, is cached — never a
// timeout, network error or quota failure, which should be retried.
function geoCacheKey(lat, lng) {
  return "g:" + Number(lat).toFixed(4) + "," + Number(lng).toFixed(4);
}

export async function cachedReverseGeocode(geoCache, lat, lng, apiKey) {
  const key = geoCacheKey(lat, lng);
  if (geoCache) {
    try {
      const hit = await geoCache.get(key, { type: "json" });
      if (hit && typeof hit.ok === "boolean") return Object.assign({}, hit, { cached: true });
    } catch (e) { /* cache trouble must never block a lookup */ }
  }
  const geo = await reverseGeocode(lat, lng, apiKey);
  if (geoCache && geo && (geo.ok || geo.reason === "ZERO_RESULTS")) {
    try { await geoCache.setJSON(key, geo); } catch (e) { /* best effort */ }
  }
  return geo;
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

// The single per-coordinate resolution step — work out what Country / Zone /
// Town / Suburb a coordinate belongs to, then find-or-create the Town/Suburb.
// Shared by every caller that needs "where is this": geocodeLocations (the
// backlog sweep), recheckZones (the correction pass), the corrected-file
// export, autoGeocodeRecord (one new record, right when it is saved), and
// now resorts-api.js's nightly sync (a coordinate that just changed).
//
//  * Names (town, suburb, country) come from Google, via the cache above.
//  * The ZONE inside South Africa comes from the coordinate's own zone
//    polygon (lib/zones.js) — never from the town's name — so same-named
//    towns and towns missing from the keyword table still land right.
//  * Outside South Africa the zone is the province/region Google reports
//    ("Erongo Region", "Matabeleland North Province"), falling back to the
//    country name.
//  * A point with no real town (a farm, or coordinates in the sea) is placed
//    with the nearest existing town within NEAREST_TOWN_MAX_KM and marked
//    `nearby`, which the export writes as Suburb "Nearby <Town>".
//
// Returns { result, viaFallback, failureReason, failureMessage }. `result`
// is null when nothing could place this coordinate at all.
export async function resolveLocationForCoordinate(lat, lng, apiKey, allTowns, existingIds, force, geoCache) {
  const geo = await cachedReverseGeocode(geoCache, lat, lng, apiKey);
  const geoOk = !!(geo && geo.ok);
  const at = locateZone(lat, lng);
  const onLand = at.km <= COAST_SLACK_KM;

  const country = geoOk && geo.country ? geo.country : (onLand ? SA_NAME : "");
  const inSA = country === SA_NAME;
  // Google found a real town here → the point is on land, whatever the
  // simplified zone edge says (border and coast polygons are approximate).
  // Only a point Google couldn't put in any town AND that sits outside every
  // zone is treated as being in the sea / not on land.
  const foundTown = !!(geoOk && geo.town && !(geo.townType === "administrative_area_level_2" && looksLikeDistrict(geo.town)));
  const offshoreKm = !foundTown && (inSA || !country) && !onLand && isFinite(at.km) ? Math.max(1, Math.round(at.km)) : 0;

  let zone = "";
  if (inSA) {
    zone = onLand ? at.zone : (districtToZone(geoOk ? geo.town : "") || provinceToZone(geoOk ? geo.province : "") || "");
  } else if (country) {
    zone = clean((geoOk && geo.province) || country, 120);
  }

  const realTown = geoOk && geo.town && !(geo.townType === "administrative_area_level_2" && looksLikeDistrict(geo.town));
  // Google answered but with no real town, or found nothing at all here.
  const noUsableTown = geo && ((geoOk && !realTown) || (!geoOk && geo.reason === "ZERO_RESULTS"));

  let result = null;
  let viaFallback = false;

  if (realTown) {
    result = ensureTownAndSuburb(allTowns, existingIds, geo.town, zone, geo.suburb, lat, lng, force, country || SA_NAME);
    if (result) { result.nearby = false; result.nearbyKm = null; }
  } else if (noUsableTown || (geo && !geoOk && onLand && geo.reason === "ZERO_RESULTS")) {
    const near = nearestTown(allTowns, lat, lng, NEAREST_TOWN_MAX_KM, country || (onLand ? SA_NAME : ""));
    if (near) {
      const nearest = near.town;
      result = {
        zone: okZone(townZone(nearest)) || zone,
        townId: nearest.id,
        suburbId: "",
        suburbName: "",
        locationLabel: nearest.name,
        createdTown: false,
        createdSuburb: false,
        zoneChangedFrom: null,
        townName: nearest.name,
        country: townCountry(nearest),
        nearby: true,
        nearbyKm: Math.round(near.km * 10) / 10,
      };
      viaFallback = true;
    }
  }
  if (result) result.offshoreKm = offshoreKm;

  let failureReason = "";
  let failureMessage = "";
  if (!result) {
    if (geo && !geoOk) {
      failureReason = geo.reason || "unknown";
      failureMessage = geo.message || "";
    } else if (geoOk && !realTown) {
      // Reachable only when there's also no town within NEAREST_TOWN_MAX_KM
      // to fall back to — genuinely remote.
      failureReason = "no_town_in_result";
      failureMessage = "Google matched this coordinate but the result had no town-level detail, and no existing town was close enough to use instead.";
    }
  }

  return { result, viaFallback, failureReason, failureMessage, country, offshoreKm };
}

// Forward-geocodes a free-text place query ("Resort name, suburb, city,
// state, country") with Google's Geocoding API and reports how trustworthy
// the match is — whether Google matched the actual business/establishment
// or just fell back to the town it sits in, since a town-centre answer is
// no better than a rounded coordinate already on file. Extracted out of
// map-api.js (2026-09-29) alongside checkNameAgainstCoordinate below, so
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
  };
}

// Writes a resolved location onto a property / resort row / activity.
export function applyLocationTag(rec, result) {
  rec.zone = result.zone;
  rec.townId = result.townId;
  rec.suburbId = result.suburbId;
  rec.locationLabel = result.locationLabel;
  rec.country = result.country || "";
  rec.nearby = !!result.nearby;
  rec.offshoreKm = result.offshoreKm || 0;
  rec.locV = LOCATION_TAG_VERSION;
}

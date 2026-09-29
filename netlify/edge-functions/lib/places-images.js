// Fetches real, place-tagged photos from Google's Places API (New) — Text
// Search + Place Photo media endpoints — for the two things Event hooks
// need: a location/area photo (query = the event's location name) and a
// "theme" photo (query = the event's theme, e.g. "whale watching") — see
// admin-api.js's findPlaceImages action, which is the only caller.
//
// Jean explicitly chose Google Places API for both of these over
// Pexels/Unsplash (this project's own earlier recommendation — see
// event-hook-image-picker-spec.md) despite the caveat that Places' photo
// terms are stricter and that free-text theme search isn't really what
// Places Text Search is built for (it searches "places", so a query like
// "whale watching" tends to surface tour operators/businesses rather than
// generic themed scenery — the admin can always retype a more specific
// query; see admin.html's picker). That's a settled decision, not a bug
// to fix here.
//
// Originally built against the legacy Text Search + Place Photo endpoints
// (maps.googleapis.com/maps/api/place/...). Switched to Places API (New)
// (places.googleapis.com/v1/...) after Jean hit "You're calling a legacy
// API, which is not enabled for your project" in production — new Google
// Cloud projects generally don't have the legacy Places API enabled by
// default any more, only Places API (New), and Google's own error message
// points at this replacement. IMPORTANT for Jean: this needs "Places API
// (New)" specifically enabled for her key's project in Google Cloud
// Console (Enabled APIs & services) — a key that only has the old "Places
// API" enabled will need that flipped on too, it's a separate API from
// Google's side even though the product name is nearly identical.
//
// This module NEVER returns a Google Places photo URL to the caller —
// those embed the API key as a query param, which would otherwise leak
// into places a client (or, worse, stored blob metadata — see
// lib/hook-photos.js's sourceUrl field) can see. Instead it fetches the
// actual image bytes itself, server-side, and hands back data: URIs (see
// lib/data-uri.js) — the key never leaves this file.
import { bytesToDataUri } from "./data-uri.js";
import { mapWithConcurrency } from "./booking-stats.js";

// Same reasoning as lib/geocode.js's FETCH_TIMEOUT_MS: this can run inside
// a Netlify Edge Function with its own execution limit, and a hung Google
// response must not be allowed to stall past that.
const FETCH_TIMEOUT_MS = 8000;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Returns, on success:
//   { ok: true, place: { name, formattedAddress }, images: [{ dataUri, width, height, attribution }] }
// On failure:
//   { ok: false, reason, message }
// `reason` is Google's own error status string (e.g. "NOT_FOUND",
// "PERMISSION_DENIED", "RESOURCE_EXHAUSTED") when Google actually
// responded, "ZERO_RESULTS" for a search that came back empty (Places API
// (New) reports this as a plain empty result, not an error — normalized
// here to keep the same reason admin.html already knows how to show), or
// one of "no_api_key" / "empty_query" / "network" / "timeout" /
// "bad_response" / "no_photos" / "photo_fetch_failed" otherwise — same
// shape as lib/geocode.js's reverseGeocode, for the same reason: "every
// search fails" almost always means a Google Cloud setup problem (API not
// enabled, billing not enabled, or a key restriction blocking server-side
// calls), and that's undiagnosable from a silent empty result.
export async function searchPlacePhotos(query, apiKey, limit) {
  const q = typeof query === "string" ? query.trim() : "";
  const cap = Math.max(1, Math.min(9, Number(limit) || 6));
  if (!apiKey) return { ok: false, reason: "no_api_key", message: "" };
  if (!q) return { ok: false, reason: "empty_query", message: "" };

  let searchRes;
  try {
    searchRes = await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Places API (New) charges/returns nothing without an explicit
        // field mask — this is the minimum needed to match a place, show
        // it, and fetch its photos.
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.photos",
      },
      body: JSON.stringify({ textQuery: q }),
    });
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { ok: false, reason: timedOut ? "timeout" : "network", message: String((e && e.message) || e) };
  }

  let searchData;
  try {
    searchData = await searchRes.json();
  } catch (e) {
    return { ok: false, reason: "bad_response", message: "Response wasn't valid JSON" };
  }

  if (!searchRes.ok) {
    // Places API (New) reports failures as { error: { code, message,
    // status } } rather than embedding a status string in a 200 body —
    // `status` here (PERMISSION_DENIED, RESOURCE_EXHAUSTED, INVALID_ARGUMENT,
    // ...) is the closest equivalent to the legacy API's status field.
    const err = searchData && searchData.error;
    return { ok: false, reason: (err && err.status) || "bad_response", message: (err && err.message) || "HTTP " + searchRes.status };
  }

  if (!searchData || !Array.isArray(searchData.places) || !searchData.places.length) {
    return { ok: false, reason: "ZERO_RESULTS", message: "" };
  }

  // Only the top match's own photos — same "results[0] carries what we
  // need, no merging across candidates" approach geocode.js takes, and
  // keeps the picker showing photos of one real place rather than a
  // grab-bag of unrelated ones sharing the search text.
  const place = searchData.places[0];
  const placeName = (place.displayName && place.displayName.text) || "";
  const photos = Array.isArray(place.photos) ? place.photos.slice(0, cap) : [];
  if (!photos.length) {
    return {
      ok: false,
      reason: "no_photos",
      message: "Google found \"" + (placeName || q) + "\" but it has no photos on file.",
    };
  }

  const fetched = await mapWithConcurrency(
    photos,
    async (photo) => {
      // `photo.name` is a resource path like
      // "places/PLACE_ID/photos/PHOTO_ID" — the media endpoint below
      // redirects (default fetch() behavior follows this) to the actual
      // image bytes.
      if (!photo || !photo.name) return null;
      const photoUrl =
        "https://places.googleapis.com/v1/" + photo.name + "/media?maxWidthPx=900&key=" + encodeURIComponent(apiKey);
      try {
        const res = await fetchWithTimeout(photoUrl);
        if (!res.ok) return null;
        const contentType = res.headers.get("content-type") || "image/jpeg";
        if (!contentType.startsWith("image/")) return null;
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 1 || buf.byteLength > MAX_PHOTO_BYTES) return null;
        const attribution =
          Array.isArray(photo.authorAttributions) && photo.authorAttributions.length && photo.authorAttributions[0].displayName
            ? String(photo.authorAttributions[0].displayName)
            : "Photo via Google";
        return {
          dataUri: bytesToDataUri(buf, contentType),
          width: photo.widthPx || null,
          height: photo.heightPx || null,
          attribution: attribution,
        };
      } catch (e) {
        return null;
      }
    },
    3
  );

  const images = fetched.filter((x) => x);
  if (!images.length) {
    return {
      ok: false,
      reason: "photo_fetch_failed",
      message: "Google found matching photos but none could be downloaded — please try again.",
    };
  }

  return {
    ok: true,
    place: { name: placeName, formattedAddress: place.formattedAddress || "" },
    images: images,
  };
}

// Worldwide name search returning several candidate PLACES (not photos) —
// backs Case C of full-hub-coordinate-geocoding-scope (2026-09-29): a
// property with no coordinate on file at all gets searched by its own
// name, and an admin picks the right match from a short list rather than
// Claude/Google guessing which of several same-named results is correct.
// Deliberately no country/region restriction on the request — Jean's
// explicit decision (2026-09-29) was worldwide search, not South
// Africa-only, since the hub already carries properties outside SA.
//
// Returns, on success: { ok: true, candidates: [{ placeId, name,
// formattedAddress, lat, lng }] } (possibly empty — a real zero-result
// search, not a failure). On failure: { ok: false, reason, message } —
// same reason vocabulary as searchPlacePhotos above (including the
// ZERO_RESULTS normalization), since admin.html's existing error-message
// handling for that action already knows how to show these.
export async function searchPlaceCandidates(query, apiKey, limit) {
  const q = typeof query === "string" ? query.trim() : "";
  const cap = Math.max(1, Math.min(10, Number(limit) || 5));
  if (!apiKey) return { ok: false, reason: "no_api_key", message: "" };
  if (!q) return { ok: false, reason: "empty_query", message: "" };

  let searchRes;
  try {
    searchRes = await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Wider field mask than searchPlacePhotos above: this needs each
        // candidate's own id/location, not just the top match's photos.
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: cap }),
    });
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { ok: false, reason: timedOut ? "timeout" : "network", message: String((e && e.message) || e) };
  }

  let searchData;
  try {
    searchData = await searchRes.json();
  } catch (e) {
    return { ok: false, reason: "bad_response", message: "Response wasn't valid JSON" };
  }

  if (!searchRes.ok) {
    const err = searchData && searchData.error;
    return { ok: false, reason: (err && err.status) || "bad_response", message: (err && err.message) || "HTTP " + searchRes.status };
  }

  if (!searchData || !Array.isArray(searchData.places) || !searchData.places.length) {
    return { ok: true, candidates: [] };
  }

  const candidates = searchData.places
    .slice(0, cap)
    .map((p) => {
      const loc = p.location;
      if (!loc || !isFinite(loc.latitude) || !isFinite(loc.longitude)) return null;
      return {
        placeId: p.id || "",
        name: (p.displayName && p.displayName.text) || "",
        formattedAddress: p.formattedAddress || "",
        lat: loc.latitude,
        lng: loc.longitude,
      };
    })
    .filter((c) => c);

  return { ok: true, candidates };
}

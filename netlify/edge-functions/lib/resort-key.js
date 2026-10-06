// A stable identity for one row in the resort-list store (the ~5,900-row
// StockNetwork property master, imported wholesale by resorts-api.js).
//
// StockNetwork's own ResortID identifies the physical property; the same
// ResortID can appear under more than one SiteID (StockNetwork lists the
// same resort under multiple booking "sites"), so the pair is what actually
// identifies one listed row — matching resorts-api.js's own within-import
// de-duplication, which already keys on name+siteId+resortId.
//
// Used in two places that both need the SAME row to resolve to the SAME key
// across a fresh CSV re-import: resorts-api.js's mergeResorts (so an
// admin-assigned affId survives the next StockNetwork upload instead of
// being wiped by the wholesale-replace) and admin-api.js's setResortAffId
// (so the checkboxes the admin ticked in the location tree — which read
// this same key from each property's data-key attribute — match back to
// the right row when the assignment is saved).
//
// Returns "" for a row with no resortId at all (can't be matched reliably
// across imports — rare; resorts-api.js's parser falls back to the CSV's
// last two columns for resortId/siteId, so this should only happen on a
// malformed export). Callers must treat "" as "not matchable", never as a
// real shared key.
export function resortKey(r) {
  const resortId = (r && r.resortId) || "";
  if (!resortId) return "";
  const siteId = (r && r.siteId) || "";
  return resortId + "|" + siteId;
}

// Fields map-api.js's applyLocationTag writes onto a resort row once its
// coordinate has been resolved to a specific Town/Suburb via geocodeLocations
// (or the equivalent "Re-check all zones" pass) — see map-api.js for where
// these are set. None of these come from the CSV/StockNetwork API at all,
// so mergeResorts is the only thing standing between them and being wiped
// on every re-import.
const LOCATION_TAG_FIELDS = [
  "zone", "townId", "suburbId", "locationLabel", "country", "nearby", "offshoreKm", "locV",
];

// Same coordinate-match tolerance map-api.js itself already uses (see its
// dryRun/apply handlers for the geocodeLocations action) before trusting a
// stored location tag — kept identical here so a re-import doesn't apply a
// looser or stricter rule than the rest of the app does.
const COORD_MATCH_TOLERANCE = 0.00002;

function sameCoordinate(a, b) {
  const aLat = parseFloat(a && a.latitude);
  const aLng = parseFloat(a && a.longitude);
  const bLat = parseFloat(b && b.latitude);
  const bLng = parseFloat(b && b.longitude);
  if (!isFinite(aLat) || !isFinite(aLng) || !isFinite(bLat) || !isFinite(bLng)) return false;
  return Math.abs(aLat - bLat) < COORD_MATCH_TOLERANCE && Math.abs(aLng - bLng) < COORD_MATCH_TOLERANCE;
}

// Carries an existing row's admin-set/admin-computed fields forward onto the
// freshly-parsed row with the same resortKey, so a StockNetwork CSV
// re-import updates each property's own listing details (name, district,
// suburb, zoneHint, lat/lng — all authoritative from the new file) without
// silently wiping:
//   - which affiliate it was assigned to (affId), and
//   - which Town/Suburb the map has it geocoded to (LOCATION_TAG_FIELDS
//     above) — but ONLY when the property's coordinate hasn't actually
//     moved since that geocoding ran (see sameCoordinate). If StockNetwork's
//     own lat/lng for a row has shifted, the old town/suburb tie could now
//     be wrong, so it's dropped instead of carried forward — the next
//     geocodeLocations/"Re-check all zones" pass will re-resolve it fresh,
//     same as it would for a brand-new row.
// A property that no longer appears in the new file simply drops out (and
// its old affId/location tag with it) — same as any other row that's gone
// from the new list. A brand-new property not seen before just gets the
// default "" affId and no location tag, same as before this file existed.
export function mergeResorts(oldResorts, newResorts) {
  const oldByKey = new Map();
  for (const r of Array.isArray(oldResorts) ? oldResorts : []) {
    const key = resortKey(r);
    if (key && !oldByKey.has(key)) oldByKey.set(key, r);
  }
  return (Array.isArray(newResorts) ? newResorts : []).map((r) => {
    const key = resortKey(r);
    const old = key ? oldByKey.get(key) : null;
    const merged = { ...r, affId: old && typeof old.affId === "string" ? old.affId : "" };
    // SN cleanup wizard (2026-10-06): the hub's coordinate was set on
    // purpose ahead of StockNetwork's (old.snCoordPending). Until a file
    // arrives with that same coordinate, keep the hub's coordinate and its
    // Town/Suburb tag rather than reverting to the file's older one. Once
    // the file matches, the marker is simply not carried forward.
    if (old && old.snCoordPending && !sameCoordinate(old, r)) {
      merged.latitude = old.latitude;
      merged.longitude = old.longitude;
      merged.snCoordPending = { ...old.snCoordPending, snSaw: { lat: r.latitude, lng: r.longitude } };
    }
    if (old && sameCoordinate(old, merged)) {
      for (const field of LOCATION_TAG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(old, field)) merged[field] = old[field];
      }
    }
    return merged;
  });
}

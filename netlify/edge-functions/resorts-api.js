import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { mergeResorts } from "./lib/resort-key.js";
// Case A of the full-hub-coordinate-geocoding-scope build (2026-09-29):
// after this sync lands a new/changed coordinate from StockNetwork, place
// that property in the hub's own Zone/Town/Suburb/Nearby tree right away —
// using the exact same resolveLocationForCoordinate/applyLocationTag engine
// map-api.js's "Start geocoding" button already uses — instead of leaving
// it untagged until someone notices and presses that button by hand. See
// lib/geolocate.js's own header comment for why this lives in a shared lib
// rather than being duplicated here.
//
// Case B (same scope, same date): checkNameAgainstCoordinate — for the
// same set of just-changed coordinates, also check the property's own NAME
// against the new pin, so a StockNetwork coordinate that's plainly wrong
// (a resort tagged to the wrong town, a data-entry slip) gets flagged for
// Jean right when it happens rather than silently placed into the tree.
import { resolveLocationForCoordinate, applyLocationTag, checkNameAgainstCoordinate } from "./lib/geolocate.js";

// Minimal CSV field-splitter (handles quoted fields, embedded commas, and
// "" escaped quotes) — we only need the first column (the resort name), but
// we parse the whole line properly so a quoted name containing a comma still
// works correctly.
function parseCsvLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { result.push(cur); cur = ""; }
      else { cur += ch; }
    }
  }
  result.push(cur);
  return result;
}

// Parses the resort master CSV into { name, district, suburb, zoneHint,
// siteId, resortId, latitude, longitude, ...rawFields } per row. Every field
// is looked up by header name so the parser doesn't break if StockNetwork
// reorders columns; siteId/resortId fall back to the last two columns (their
// known position) if the headers aren't found by name. The "town" field
// accepts a few different header spellings, since different StockNetwork
// exports have called this column District, Town, or City — first one found
// wins. suburb/area and zone/province are all optional finer-grained
// columns: present on some exports, absent on others, and only used (by
// map-api.js's location-discovery feature) when they're there — a row
// missing any of them just gets "" for that field and every existing
// caller of this file keeps working exactly as before. Latitude/Longitude
// are likewise optional. Rows are kept even if they share a name with
// another row — different physical properties can share a name, and each
// needs its own SiteID/ResortID for the Resort Info Link to work. Only
// exact duplicate rows (same name + siteId + resortId) are collapsed.
//
// 2026-09-29: extended to also capture StockNetwork's full real export
// columns (confirmed against Jean's actual "Resort Information" download —
// 24 columns: Resort, District, Area, Country, Latitude, Longitude, Supplier
// Rating, Tourism Board Rating, Property Type, External Resort Code, WiFi,
// WiFi Cost, Parking, Pet Allowance, Allow Same Day Booking, Smoking
// Allowed, Checkin Time, Checkout Time, Suburb, City, City2, State, SiteID,
// ResortID) as their own raw fields, per Jean's explicit instruction: these
// land in the hub as new informational fields, not currently used elsewhere,
// but no longer silently discarded. `snCountry` is deliberately NOT named
// `country` — `country` already means something different on a resort row
// (the hub's own geocoding-computed country, see lib/resort-key.js's
// LOCATION_TAG_FIELDS) and must never be overwritten by this raw import
// value. `district`/`suburb` keep their existing names (already raw,
// already used for zoneHint/backfill purposes) — `area`/`city`/`city2`/
// `state` are new. None of these raw fields are used to derive the hub's
// own Zone/Town/Suburb tree — that stays purely coordinate-geocoded, per
// Jean's explicit "the hub is the master" instruction (2026-09-29).
function parseResortsFromCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const findCol = (names) => {
    for (const name of names) {
      const idx = header.findIndex((h) => h === name);
      if (idx > -1) return idx;
    }
    return -1;
  };

  let nameIdx = findCol(["resort"]);
  const districtIdx = findCol(["district", "town", "town/city", "city"]);
  const suburbIdx = findCol(["suburb", "area"]);
  const zoneHintIdx = findCol(["zone", "province", "state", "stateprovince", "state/province"]);
  let siteIdIdx = findCol(["siteid"]);
  let resortIdIdx = findCol(["resortid"]);
  const latIdx = findCol(["latitude"]);
  const lngIdx = findCol(["longitude"]);
  if (nameIdx === -1) nameIdx = 0;
  if (resortIdIdx === -1) resortIdIdx = header.length - 1;
  if (siteIdIdx === -1) siteIdIdx = header.length - 2;

  // New raw passthrough columns — StockNetwork's real export header names,
  // matched exactly (case-insensitive). Every one is optional: a CSV that
  // doesn't have a given column just gets "" for that field, same fallback
  // rule as every other optional column above.
  const snCountryIdx = findCol(["country"]);
  const areaIdx = findCol(["area"]);
  const cityIdx = findCol(["city"]);
  const city2Idx = findCol(["city2", "city 2"]);
  const stateIdx = findCol(["state"]);
  const supplierRatingIdx = findCol(["supplier rating"]);
  const tourismBoardRatingIdx = findCol(["tourism board rating"]);
  const propertyTypeIdx = findCol(["property type"]);
  const externalResortCodeIdx = findCol(["external resort code"]);
  const wifiIdx = findCol(["wifi"]);
  const wifiCostIdx = findCol(["wifi cost"]);
  const parkingIdx = findCol(["parking"]);
  const petAllowanceIdx = findCol(["pet allowance"]);
  const allowSameDayBookingIdx = findCol(["allow same day booking"]);
  const smokingAllowedIdx = findCol(["smoking allowed"]);
  const checkinTimeIdx = findCol(["checkin time"]);
  const checkoutTimeIdx = findCol(["checkout time"]);

  const seen = new Set();
  const resorts = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const name = (fields[nameIdx] || "").trim();
    if (!name) continue;

    const district = districtIdx > -1 ? (fields[districtIdx] || "").trim() : "";
    const suburb = suburbIdx > -1 ? (fields[suburbIdx] || "").trim() : "";
    const zoneHint = zoneHintIdx > -1 ? (fields[zoneHintIdx] || "").trim() : "";
    const siteId = siteIdIdx > -1 ? (fields[siteIdIdx] || "").trim() : "";
    const resortId = resortIdIdx > -1 ? (fields[resortIdIdx] || "").trim() : "";
    const latitude = latIdx > -1 ? (fields[latIdx] || "").trim() : "";
    const longitude = lngIdx > -1 ? (fields[lngIdx] || "").trim() : "";

    const get = (idx) => (idx > -1 ? (fields[idx] || "").trim() : "");
    const raw = {
      snCountry: get(snCountryIdx),
      area: get(areaIdx),
      city: get(cityIdx),
      city2: get(city2Idx),
      state: get(stateIdx),
      supplierRating: get(supplierRatingIdx),
      tourismBoardRating: get(tourismBoardRatingIdx),
      propertyType: get(propertyTypeIdx),
      externalResortCode: get(externalResortCodeIdx),
      wifi: get(wifiIdx),
      wifiCost: get(wifiCostIdx),
      parking: get(parkingIdx),
      petAllowance: get(petAllowanceIdx),
      allowSameDayBooking: get(allowSameDayBookingIdx),
      smokingAllowed: get(smokingAllowedIdx),
      checkinTime: get(checkinTimeIdx),
      checkoutTime: get(checkoutTimeIdx),
    };

    const key = name.toLowerCase() + "|" + siteId + "|" + resortId;
    if (seen.has(key)) continue;
    seen.add(key);
    resorts.push({ name, district, suburb, zoneHint, siteId, resortId, latitude, longitude, ...raw });
  }

  resorts.sort((a, b) => a.name.localeCompare(b.name) || a.district.localeCompare(b.district));
  return resorts;
}

// Fields map-api.js's geocoding pipeline writes onto a resort row once its
// coordinate is resolved to a Town/Suburb (see lib/resort-key.js's
// LOCATION_TAG_FIELDS, kept in sync with that list by hand — small and
// stable, not worth an extra cross-file import for one array), plus the
// Case B name-vs-coordinate flag fields set by the auto-place pass just
// below (coordSuspicious/coordSuspiciousNote/coordSuggested — 2026-09-29).
// Cleared here whenever this sync sees a property's coordinate actually
// move, so a stale tag OR a stale suspicion flag tied to the OLD point
// never lingers — the auto-place pass right after this loop re-derives
// both fresh for the new coordinate.
const API_SYNC_CLEAR_ON_MOVE = ["zone", "townId", "suburbId", "locationLabel", "country", "nearby", "offshoreKm", "locV", "coordSuspicious", "coordSuspiciousNote", "coordSuggested"];

// Maps one raw StockNetwork /api/1.0/resort row onto the same raw,
// informational field names parseResortsFromCsv() above captures from a CSV
// upload — so a property looks the same in the hub whichever source last
// refreshed it. `snCountry` (not `country`) deliberately avoids the hub's
// own geocoding-computed `country` field — see the big comment on
// parseResortsFromCsv above. `resortTypeID` is a StockNetwork-internal GUID,
// not the readable "Guest house"/"Lodge" text the CSV's Property Type column
// carries, so it's deliberately NOT mapped to `propertyType` here — only a
// CSV upload can set that field correctly.
// Same small helper map-api.js defines for itself — duplicated here rather
// than imported across the two routed functions (this file's own
// parseCsvLine below is duplicated from map-api.js's copy for the same
// reason: neither routed function should import the other), since it's
// generic and only a few lines.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function mapApiRowToRawFields(r) {
  const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
  return {
    snCountry: s(r.country),
    area: s(r.area),
    district: s(r.district),
    suburb: s(r.suburb),
    city: s(r.city),
    city2: s(r.city2),
    state: s(r.state),
    supplierRating: s(r.supplierRating),
    tourismBoardRating: s(r.tourismBoardRating),
    externalResortCode: s(r.resortCode),
  };
}

// Returns the first non-empty value found under any of `keys` on `obj`, or
// "" if none are present. Used below for a StockNetwork API row's name and
// SiteID equivalent fields, which — unlike every other field this file
// reads off the API — were never actually needed until now: a MATCHED row
// keeps the name/siteId the hub already has from its original CSV import,
// so mapApiRowToRawFields above never had to know what StockNetwork calls
// them. For an UNMATCHED row there is no existing hub record to fall back
// on, so this guesses from the field-naming conventions StockNetwork's API
// uses elsewhere (iExchangeResortFileID for resortId) — if none of these
// guesses hit, the full raw row is kept alongside (see below) so the actual
// field name can be read straight from it and this list tightened.
function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
const UNMATCHED_NAME_KEYS = ["name", "resortName", "ResortName", "Resort", "resort", "title", "Name", "ResortTitle"];
const UNMATCHED_SITEID_KEYS = ["siteId", "siteID", "SiteID", "SiteId", "iExchangeSiteFileID", "iSiteID"];
// Caps how many full unmatched-row objects get saved to blob storage in one
// sync — a backlog in the thousands (e.g. the very first run after this
// feature ships) would otherwise risk a single oversized blob write. The
// real total is still reported via totalUnmatched even when the saved list
// is capped.
const UNMATCHED_SAVE_CAP = 500;

async function handleApiSync(request, store, cors) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ ok: false, error: "No rows supplied." }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const record = await store.get("current", { type: "json" });
  const resorts = record && Array.isArray(record.resorts) ? record.resorts : [];

  // The same physical property can be listed under more than one SiteID
  // (see lib/resort-key.js's own comment on this) — one API row updates
  // every resort-list row sharing that ResortID.
  const byResortId = new Map();
  resorts.forEach((r, i) => {
    if (!r || !r.resortId) return;
    if (!byResortId.has(r.resortId)) byResortId.set(r.resortId, []);
    byResortId.get(r.resortId).push(i);
  });

  let matchedProperties = 0,
    matchedRows = 0,
    unmatchedApiRows = 0,
    coordinatesChanged = 0,
    // hub-is-master-for-location (2026-09-30): counters for the two new
    // outcomes below, alongside coordFlaggedSuspicious/coordFlagCleared
    // which Case B further down also increments/decrements.
    coordFlaggedSuspicious = 0,
    coordFlagCleared = 0,
    coordProtectedFromOverwrite = 0,
    // SN cleanup wizard (2026-10-06): rows carrying snCoordPending.
    coordAwaitingSn = 0,
    snCoordCaughtUp = 0;
  // Indices into `resorts` whose coordinate was newly ACCEPTED this sync —
  // collected so the auto-place pass below (Case A) only ever looks at rows
  // that genuinely need it, not the whole ~5,900-row list. A row where the
  // hub already had a coordinate never lands here, whether StockNetwork's
  // value matched or was flagged as a mismatch -- see the per-row loop.
  const changedIdxs = [];
  // StockNetwork resort rows this sync couldn't match to any existing hub
  // property (new-properties-flagging, 2026-10-03, Jean's request) — saved
  // below so admin.html can show "N StockNetwork properties aren't in your
  // hub yet" instead of these being silently dropped, which is what
  // happened before this. Never auto-added to the hub itself: per
  // hub-is-master-for-location, only a reviewed CSV upload creates a new
  // resort-list row.
  const unmatchedItems = [];

  for (const apiRow of rows) {
    const resortId = String(apiRow.iExchangeResortFileID || "").trim();
    if (!resortId) continue;
    const idxs = byResortId.get(resortId);
    if (!idxs || !idxs.length) {
      unmatchedApiRows++;
      if (unmatchedItems.length < UNMATCHED_SAVE_CAP) {
        unmatchedItems.push({
          resortId,
          name: pickFirst(apiRow, UNMATCHED_NAME_KEYS),
          siteId: pickFirst(apiRow, UNMATCHED_SITEID_KEYS),
          latitude: typeof apiRow.latitude === "number" ? apiRow.latitude : null,
          longitude: typeof apiRow.longitude === "number" ? apiRow.longitude : null,
          ...mapApiRowToRawFields(apiRow),
          raw: apiRow,
        });
      }
      continue;
    }
    matchedProperties++;
    const fresh = mapApiRowToRawFields(apiRow);
    const hasNewCoord =
      typeof apiRow.latitude === "number" &&
      typeof apiRow.longitude === "number" &&
      !(apiRow.latitude === 0 && apiRow.longitude === 0);

    idxs.forEach((i) => {
      const rec = resorts[i];
      matchedRows++;
      Object.assign(rec, fresh);
      if (hasNewCoord) {
        const oldLat = parseFloat(rec.latitude);
        const oldLng = parseFloat(rec.longitude);
        const hubHasCoord = isFinite(oldLat) && isFinite(oldLng) && !(oldLat === 0 && oldLng === 0);

        if (!hubHasCoord) {
          // hub-is-master-for-location (2026-09-30, extending
          // full-hub-coordinate-geocoding-scope): first real coordinate
          // this property has ever had in the hub -- nothing of the hub's
          // own to protect yet, so accept it and run it through the usual
          // Case A/B placement pass below exactly as before. From this
          // point on the hub owns this property's own
          // Coordinates/Country/Zone/Town/Suburb -- see the two branches
          // below for what happens on every sync after this one.
          rec.latitude = String(apiRow.latitude);
          rec.longitude = String(apiRow.longitude);
          coordinatesChanged++;
          API_SYNC_CLEAR_ON_MOVE.forEach((f) => {
            delete rec[f];
          });
          changedIdxs.push(i);
          return;
        }

        const matches =
          Math.abs(oldLat - apiRow.latitude) < 0.00002 &&
          Math.abs(oldLng - apiRow.longitude) < 0.00002;

        if (matches) {
          // StockNetwork has caught up to what the hub already has (within
          // ~2m, same tolerance the old "moved" check used) -- nothing to
          // change. Clear a stale mismatch flag left over from an earlier
          // night, if this property still has one.
          if (rec.snCoordPending) {
            // SN cleanup wizard (2026-10-06): StockNetwork now has the
            // coordinate the wizard set -- the two agree, so stop protecting.
            delete rec.snCoordPending;
            snCoordCaughtUp++;
          }
          if (rec.coordSuspicious) {
            delete rec.coordSuspicious;
            delete rec.coordSuspiciousNote;
            delete rec.coordSuggested;
            coordFlagCleared++;
          }
        } else if (rec.snCoordPending) {
          // SN cleanup wizard (2026-10-06): the hub's coordinate was set on
          // purpose ahead of StockNetwork's (the wizard's file hasn't been
          // loaded into StockNetwork yet, or hasn't reached the API). Keep
          // the hub's coordinate exactly like the branch below does, but
          // don't raise a review flag every night for an expected
          // difference -- just remember what StockNetwork still says, for
          // the wizard's Check step.
          rec.snCoordPending.snSaw = { lat: apiRow.latitude, lng: apiRow.longitude };
          coordAwaitingSn++;
        } else {
          // The hub already has a coordinate for this property and
          // StockNetwork just sent a DIFFERENT one. Per Jean's explicit
          // rule (2026-09-30): once a property has a hub coordinate, the
          // hub is master and StockNetwork never overwrites it
          // automatically -- this only ever gets flagged for a person to
          // review. Reuses the exact same coordSuspicious/coordSuggested/
          // coordSuspiciousNote fields (and the existing "Accept suggested
          // coordinate" button in stocknetworkReview) Case B below already
          // uses, so no new UI is needed -- accepting it calls the same
          // applyPropertyCoordinate action either way.
          //
          // rec.latitude/longitude are deliberately left untouched, and
          // API_SYNC_CLEAR_ON_MOVE deliberately does NOT run here, so
          // Country/Zone/Town/Suburb stay exactly as the hub has them too.
          // This row is also deliberately never added to changedIdxs, so
          // Case A/B below never re-places it off a coordinate the hub
          // hasn't accepted.
          rec.coordSuspicious = true;
          rec.coordSuggested = { lat: apiRow.latitude, lng: apiRow.longitude };
          rec.coordSuspiciousNote =
            "StockNetwork sent a different coordinate than the hub's current one for this property \u2014 the hub's coordinate was kept. Review and accept below if StockNetwork's is correct.";
          coordProtectedFromOverwrite++;
        }
      }
    });
  }

  // Case A (full-hub-coordinate-geocoding-scope, 2026-09-29): place every
  // property whose coordinate just changed straight into the hub's own
  // Zone/Town/Suburb/Nearby tree, instead of leaving it untagged until
  // someone presses "Re-check all zones" in admin. Deliberately the SAME
  // safe rule geocodeLocations already uses — only ever fills in a row with
  // no locationLabel yet (checked again here, not just assumed from
  // `moved`, in case something else tagged it in between) — never the
  // force:true behaviour recheckZones uses, so this can never silently
  // revert a Town an admin corrected by hand. A skipped/failed row here
  // just stays untagged, exactly like any other geocodeLocations backlog
  // item — Jean's existing "Properties with no zone" tooling still sees it.
  let autoPlaced = 0,
    autoPlaceFailed = 0,
    autoPlaceSkippedForTime = 0,
    autoPlaceNoApiKey = false;
  // coordFlaggedSuspicious/coordFlagCleared are now declared above, next to
  // coordProtectedFromOverwrite, since the per-row loop above can also
  // increment/decrement them (hub-is-master-for-location, 2026-09-30) --
  // Case B just below is a second place that touches the same two
  // counters, for a different reason (a brand-new placement whose name
  // doesn't match), not a first place.

  if (changedIdxs.length) {
    const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
    if (!apiKey) {
      autoPlaceNoApiKey = true;
    } else {
      const targets = changedIdxs.filter((i) => {
        const rec = resorts[i];
        if (!rec || rec.locationLabel) return false;
        const lat = parseFloat(rec.latitude);
        const lng = parseFloat(rec.longitude);
        return isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
      });

      if (targets.length) {
        const townsStore = getStore({ name: "map-towns", consistency: "strong" });
        const geoCacheStore = getStore({ name: "map-geocache", consistency: "strong" });
        const allTowns = (await townsStore.get("all", { type: "json" })) || [];
        const existingIds = new Set(allTowns.map((t) => t.id));

        // Same time-budget pattern map-api.js's own batch geocoding actions
        // use: stop STARTING new lookups once spent, so a large night's
        // worth of coordinate changes can never blow this function's own
        // execution limit on top of the ~5,900-row match already done
        // above. Anything skipped here stays untagged and is picked up by
        // the next night's sync (still no locationLabel) or a manual
        // "Re-check all zones" / "Load flagged properties" in the meantime.
        const LOOKUP_START_BUDGET_MS = 11000;
        const lookupsBeganAt = Date.now();

        await mapWithConcurrency(targets, 8, async (i) => {
          if (Date.now() - lookupsBeganAt > LOOKUP_START_BUDGET_MS) {
            autoPlaceSkippedForTime++;
            return;
          }
          const rec = resorts[i];
          const lat = parseFloat(rec.latitude);
          const lng = parseFloat(rec.longitude);
          // Case A and Case B run together, in parallel, for each
          // just-changed coordinate — one reverse-geocodes the point (where
          // is this?), the other forward-geocodes the property's own name
          // (does Google's answer for that name land near this point?).
          const [placeResult, nameCheck] = await Promise.all([
            resolveLocationForCoordinate(lat, lng, apiKey, allTowns, existingIds, false, geoCacheStore),
            checkNameAgainstCoordinate(rec.name, lat, lng, apiKey),
          ]);
          if (placeResult.result) {
            applyLocationTag(rec, placeResult.result);
            autoPlaced++;
          } else {
            autoPlaceFailed++;
          }
          // Case B (full-hub-coordinate-geocoding-scope, 2026-09-29): flag a
          // StockNetwork coordinate that doesn't look like it belongs to
          // this property's own name, right when that coordinate just
          // changed — so Jean doesn't have to re-check the whole resort
          // list by hand. Stored directly on the record so stocknetworkReview
          // can surface it with no live Google calls of its own.
          //   "high"   — Google's own name match lands near this point ->
          //              clear any earlier flag, nothing to review.
          //   "review" — Google matched the name but it's far from this
          //              point (or nothing to compare against) -> flag it,
          //              with the alternate coordinate Google suggests.
          //   "none"/failed — Google couldn't confidently match the name at
          //              all (an obscure listing, a network hiccup, a name
          //              too generic to search) -> inconclusive, leave
          //              untouched rather than false-flag or false-clear.
          if (nameCheck.confidence === "high") {
            if (rec.coordSuspicious) coordFlagCleared++;
            delete rec.coordSuspicious;
            delete rec.coordSuspiciousNote;
            delete rec.coordSuggested;
          } else if (nameCheck.confidence === "review") {
            rec.coordSuspicious = true;
            rec.coordSuspiciousNote = nameCheck.note || "";
            rec.coordSuggested =
              nameCheck.lat != null && nameCheck.lng != null
                ? { lat: nameCheck.lat, lng: nameCheck.lng, formatted: nameCheck.formatted || "" }
                : null;
            coordFlaggedSuspicious++;
          }
        });

        await townsStore.setJSON("all", allTowns);
      }
    }
  }

  await store.setJSON(
    "current",
    Object.assign({}, record, { resorts, apiSyncedAt: new Date().toISOString() })
  );

  // Save this run's unmatched-row list, minus anything Jean has explicitly
  // dismissed (dismissPendingNewStockNetworkProperty in map-api.js) — that
  // set is read back here and carried forward since this whole list is a
  // full replace every run (a daily full resort fetch means a property no
  // longer unmatched just means she imported it; one still unmatched would
  // otherwise resurface every single day forever without this).
  const pendingNewStore = getStore({ name: "resort-pending-new", consistency: "strong" });
  const existingPending = (await pendingNewStore.get("current", { type: "json" })) || {};
  const dismissedIds = Array.isArray(existingPending.dismissedIds) ? existingPending.dismissedIds : [];
  const dismissedSet = new Set(dismissedIds);
  const keptItems = unmatchedItems.filter((it) => !dismissedSet.has(it.resortId));
  await pendingNewStore.setJSON("current", {
    items: keptItems,
    dismissedIds,
    totalUnmatched: unmatchedApiRows,
    savedCount: keptItems.length,
    truncated: unmatchedApiRows > keptItems.length + dismissedSet.size,
    updatedAt: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({
      ok: true,
      totalApiRows: rows.length,
      matchedProperties,
      matchedRows,
      unmatchedApiRows,
      newPropertiesPending: keptItems.length,
      coordinatesChanged,
      autoPlaced,
      autoPlaceFailed,
      autoPlaceSkippedForTime,
      autoPlaceNoApiKey,
      coordFlaggedSuspicious,
      coordFlagCleared,
      coordProtectedFromOverwrite,
      coordAwaitingSn,
      snCoordCaughtUp,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
}

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const store = getStore({ name: "resort-list", consistency: "strong" });

  try {
    if (request.method === "GET") {
      const record = await store.get("current", { type: "json" });
      const resorts = record && Array.isArray(record.resorts) ? record.resorts : [];
      const updatedAt = (record && record.updatedAt) || null;
      return new Response(JSON.stringify({ resorts, updatedAt, count: resorts.length }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    if (request.method === "POST") {
      // 2026-09-29: the nightly StockNetwork API sync (stocknetwork-sync.mjs)
      // posts here too, but as JSON — { action: "syncStockNetworkApi", rows:
      // [...raw StockNetwork /api/1.0/resort rows] } — a fundamentally
      // different job from the CSV upload below: it only ever UPDATES raw,
      // informational fields on properties that already exist in the hub
      // (matched by StockNetwork's own ResortID), never creates a new
      // resort-list row and never touches the hub's own Zone/Town/Suburb
      // tree — per Jean's explicit "the hub is the master" instruction, only
      // a coordinate change clears the tag so the existing geocoding
      // pipeline re-resolves it fresh, exactly like a moved CSV coordinate
      // already does (see mergeResorts/sameCoordinate above). Distinguished
      // from the CSV path purely by Content-Type, so nothing about the CSV
      // upload flow below needs to change.
      const contentType = (request.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/json")) {
        return handleApiSync(request, store, cors);
      }

      const text = await request.text();
      if (!text || !text.trim()) {
        return new Response(JSON.stringify({ ok: false, error: "Uploaded file was empty." }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      const freshResorts = parseResortsFromCsv(text);
      if (!freshResorts.length) {
        return new Response(JSON.stringify({ ok: false, error: "Could not find any resort names in that file." }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      // Merge onto the previous list rather than replacing it outright, so
      // any property an admin assigned to an affiliate (see admin-api.js's
      // setResortAffId) keeps that assignment across this re-import — every
      // other field (name/district/suburb/zoneHint/lat/lng) still comes
      // fresh from this file, only affId carries forward. See
      // lib/resort-key.js for the matching rules.
      const previousRecord = await store.get("current", { type: "json" });
      const previousResorts = previousRecord && Array.isArray(previousRecord.resorts) ? previousRecord.resorts : [];
      const resorts = mergeResorts(previousResorts, freshResorts);

      const updatedAt = new Date().toISOString();
      await store.setJSON("current", { resorts, updatedAt });

      return new Response(JSON.stringify({ ok: true, count: resorts.length, updatedAt, resorts }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...cors },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...cors },
    });
  }
};

export const config = { path: "/api/resorts" };

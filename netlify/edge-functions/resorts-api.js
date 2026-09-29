import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { mergeResorts } from "./lib/resort-key.js";

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
// stable, not worth an extra cross-file import for one array). Cleared here
// whenever this sync sees a property's coordinate actually move, so a stale
// tag tied to the OLD point never lingers — the next geocoding pass (nightly
// "Re-check all zones", or the map's own auto-tagging) resolves it fresh.
const API_SYNC_CLEAR_ON_MOVE = ["zone", "townId", "suburbId", "locationLabel", "country", "nearby", "offshoreKm", "locV"];

// Maps one raw StockNetwork /api/1.0/resort row onto the same raw,
// informational field names parseResortsFromCsv() above captures from a CSV
// upload — so a property looks the same in the hub whichever source last
// refreshed it. `snCountry` (not `country`) deliberately avoids the hub's
// own geocoding-computed `country` field — see the big comment on
// parseResortsFromCsv above. `resortTypeID` is a StockNetwork-internal GUID,
// not the readable "Guest house"/"Lodge" text the CSV's Property Type column
// carries, so it's deliberately NOT mapped to `propertyType` here — only a
// CSV upload can set that field correctly.
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
    coordinatesChanged = 0;

  for (const apiRow of rows) {
    const resortId = String(apiRow.iExchangeResortFileID || "").trim();
    if (!resortId) continue;
    const idxs = byResortId.get(resortId);
    if (!idxs || !idxs.length) {
      unmatchedApiRows++;
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
        const moved =
          !isFinite(oldLat) ||
          !isFinite(oldLng) ||
          Math.abs(oldLat - apiRow.latitude) >= 0.00002 ||
          Math.abs(oldLng - apiRow.longitude) >= 0.00002;
        rec.latitude = String(apiRow.latitude);
        rec.longitude = String(apiRow.longitude);
        if (moved) {
          coordinatesChanged++;
          API_SYNC_CLEAR_ON_MOVE.forEach((f) => {
            delete rec[f];
          });
        }
      }
    });
  }

  await store.setJSON(
    "current",
    Object.assign({}, record, { resorts, apiSyncedAt: new Date().toISOString() })
  );

  return new Response(
    JSON.stringify({
      ok: true,
      totalApiRows: rows.length,
      matchedProperties,
      matchedRows,
      unmatchedApiRows,
      coordinatesChanged,
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

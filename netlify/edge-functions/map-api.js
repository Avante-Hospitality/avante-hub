import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { ZONES, LEGACY_ZONES, provinceToZone, districtToZone, normalizeZone, isValidZone, locateZone, zoneShapes } from "./lib/zones.js";
// Aliased on import: kept distinct from lib/geolocate.js's own
// forwardGeocodeByName (imported below) — this one geocodes a full postal
// address (used by exportLocations/CSV round-trips), that one geocodes a
// free-text place NAME for the "does this coordinate match this property's
// name" check. Same underlying Google Geocoding API, different job.
import { reverseGeocode, forwardGeocode as forwardGeocodeAddress } from "./lib/geocode.js";
// Same Google Places photo search admin-api.js's Event hook "Find area
// photo"/"Find theme photo" pickers use (see lib/places-images.js) — reused
// here for the Map & Activities form's own "Find photo" button, so Jean
// doesn't have to source/upload an activity photo by hand when Google
// already has one on file for that place.
import { searchPlacePhotos, searchPlaceCandidates } from "./lib/places-images.js";
import { dataUriToBytes } from "./lib/data-uri.js";
import { nearestByDistance } from "./lib/geo-distance.js";
// The reverse-geocode-and-place engine (2026-09-29): extracted out of this
// file so resorts-api.js's nightly StockNetwork sync can call the exact
// same resolution logic directly — see lib/geolocate.js's own header
// comment and full-hub-coordinate-geocoding-scope project doc for why.
import {
  SA_NAME, LOCATION_TAG_VERSION, NEAREST_TOWN_MAX_KM, SAME_TOWN_MAX_KM, SAME_ZONE_TOWN_MAX_KM,
  haversineKm, genTownUniqueId, genSuburbUniqueId, allSuburbIds,
  okZone, townCountry, townZone, townDistanceKm, nearestTown, ensureTownAndSuburb,
  cachedReverseGeocode, cachedForwardGeocode, resolveLocationForCoordinate, applyLocationTag,
  forwardGeocodeByName, checkNameAgainstCoordinate,
} from "./lib/geolocate.js";

// Backs the new "Map & Activities" admin tab and the new "Explore Map" hub
// tab. Two data sources feed one shared response:
//
// 1. Properties — read directly from the existing `property-listings` store
//    (property-onboarding-api.js). Any listing with status "Listed" and a
//    latitude/longitude already on file becomes a map pin — no new property
//    data entry required. This file only READS that store; it never writes
//    to it, so property-onboarding-api.js and its admin tab are untouched.
// 2. Activities — a new `map-activities` store, since excursions/experiences
//    don't exist anywhere else in the system yet. Admin-managed here.
//
// A third store, `map-visibility`, holds a simple hide/show flag per
// property listingId so an admin can pull a property off the map without
// touching its underlying listing record.
//
// GET is public (no token) and returns only what the Hub map should show:
// Listed + visible properties, and visible activities.
// POST actions are admin-only (same admin-sessions token check used by
// property-onboarding-api.js) and cover activity CRUD plus the property
// visibility toggle, and an "adminList" action that returns everything
// (including hidden) for the admin tab's own view.
//
// Zones (ZONES / provinceToZone) live in lib/zones.js, shared with
// admin-api.js's affiliate Zone field — see that file for details.

function clean(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max || 500) : "";
}

// Minimal CSV field-splitter (handles quoted fields, embedded commas, and
// "" escaped quotes) — same approach as resorts-api.js's parseCsvLine,
// duplicated locally rather than shared since it's a few lines and this
// file shouldn't import from another routed function.
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

// ---- Import checks (2026-10-04) ----
// What the tree already knows: every country and, per country, every zone
// (the 12 South African zones + any town's zone + the saved Countries/Zones
// list). Used to WARN about CSV rows whose country/zone is new or filed under
// a different country. Warnings never block an import — a new country/zone
// is legitimate — they just stop typos going in unnoticed.
function buildKnownLocations(towns, lists) {
  const SA = "South Africa";
  const countries = new Map(); // lowercase -> display
  const zones = new Map();     // lowercase country -> Map(lowercase zone -> display)
  const addCountry = (c) => { const k = String(c || "").trim().toLowerCase(); if (k && !countries.has(k)) countries.set(k, String(c).trim()); };
  const addZone = (c, z) => {
    const ck = String(c || "").trim().toLowerCase();
    const zk = String(z || "").trim().toLowerCase();
    if (!ck || !zk) return;
    addCountry(c);
    if (!zones.has(ck)) zones.set(ck, new Map());
    zones.get(ck).set(zk, String(z).trim());
  };
  addCountry(SA);
  ZONES.forEach((z) => addZone(SA, z));
  (towns || []).forEach((t) => { if (!t) return; const c = townCountry(t); addCountry(c); const z = townZone(t); if (z) addZone(c, z); });
  const l = lists || {};
  (Array.isArray(l.countries) ? l.countries : []).forEach(addCountry);
  (Array.isArray(l.zones) ? l.zones : []).forEach((z) => { if (z) addZone(z.country, z.name); });
  return { countries, zones };
}

function checkRowLocation(label, row, known) {
  const out = [];
  const SA = "South Africa";
  const typedCountry = String(row.country || "").trim();
  const zone = okZone(row.zone);
  let country = SA;
  if (typedCountry) {
    const hit = known.countries.get(typedCountry.toLowerCase());
    if (hit) country = hit;
    else { country = typedCountry; out.push(label + ": country \"" + typedCountry + "\" isn't in the location tree yet."); }
  }
  if (zone) {
    const inCountry = known.zones.get(country.toLowerCase());
    if (!inCountry || !inCountry.has(zone.toLowerCase())) {
      const elsewhere = [];
      known.zones.forEach((m, ck) => { if (ck !== country.toLowerCase() && m.has(zone.toLowerCase())) elsewhere.push(known.countries.get(ck) || ck); });
      if (elsewhere.length) {
        out.push(label + ": zone \"" + zone + "\" is filed under " + elsewhere.join(" / ") + " in the tree, not " + country + (typedCountry ? "." : " (the country column is blank, so South Africa is assumed)."));
      } else {
        out.push(label + ": zone \"" + zone + "\" isn't in the tree yet for " + country + ".");
      }
    }
  }
  return out;
}

function parseActivitiesCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const cols = {
    id: idx("id"),
    name: idx("name"),
    area: idx("area"),
    country: idx("country"),
    zone: idx("zone"),
    price: idx("price"),
    contactLink: idx("contactlink"),
    description: idx("description"),
    latitude: idx("latitude"),
    longitude: idx("longitude"),
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const get = (key) => (cols[key] > -1 ? (fields[cols[key]] || "").trim() : "");
    const name = get("name");
    if (!name) continue;
    rows.push({
      id: get("id"),
      name: name,
      area: get("area"),
      country: get("country"),
      zone: get("zone"),
      price: get("price"),
      contactLink: get("contactLink"),
      description: get("description"),
      latitude: get("latitude"),
      longitude: get("longitude"),
    });
  }
  return rows;
}

function genActivityId() {
  const n = Math.floor(Math.random() * 900000) + 100000;
  return "A-" + n;
}

function parseTownsCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const cols = {
    id: idx("id"),
    name: idx("name"),
    area: idx("area"),
    country: idx("country"),
    zone: idx("zone"),
    description: idx("description"),
    latitude: idx("latitude"),
    longitude: idx("longitude"),
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const get = (key) => (cols[key] > -1 ? (fields[cols[key]] || "").trim() : "");
    const name = get("name");
    if (!name) continue;
    rows.push({
      id: get("id"),
      name: name,
      area: get("area"),
      country: get("country"),
      zone: get("zone"),
      description: get("description"),
      latitude: get("latitude"),
      longitude: get("longitude"),
    });
  }
  return rows;
}

// Suburbs — the third, finest tier under a Town (Zone > Town > Suburb).
// Stored nested inside their parent town record (town.suburbs, an array of
// {id, name, affId, latitude, longitude, visible}) rather than as their own
// collection: a suburb never exists independently of a town, so this avoids
// a second one-blob-collection store and the join it would need on every
// read. Same affId convention as towns — empty means shared/unallocated.
// genSuburbUniqueId/allSuburbIds/genTownUniqueId now live in
// lib/geolocate.js (imported above), shared with resorts-api.js.

function sanitizeSuburb(body, existing) {
  const record = existing ? Object.assign({}, existing) : {};
  if (typeof body.name === "string") record.name = clean(body.name, 300);
  if (typeof body.affId === "string") record.affId = clean(body.affId, 60);
  if (typeof body.latitude === "string" || typeof body.latitude === "number") {
    const lat = parseFloat(body.latitude);
    record.latitude = isFinite(lat) ? String(lat) : "";
  }
  if (typeof body.longitude === "string" || typeof body.longitude === "number") {
    const lng = parseFloat(body.longitude);
    record.longitude = isFinite(lng) ? String(lng) : "";
  }
  if (typeof body.visible === "boolean") record.visible = body.visible;
  if (record.visible === undefined) record.visible = true;
  return record;
}

function toSuburbPin(record) {
  const lat = parseFloat(record.latitude);
  const lng = parseFloat(record.longitude);
  return {
    id: record.id,
    name: record.name || "",
    affId: record.affId || "",
    latitude: isFinite(lat) ? lat : null,
    longitude: isFinite(lng) ? lng : null,
    hidden: record.visible === false,
  };
}

// Netlify Edge Functions have a very small (documented: 50ms) CPU-time
// budget per request, and — critically — Netlify Blobs' list() only ever
// returns keys, never the stored value, so reading N activities always
// costs N separate get() calls no matter how those calls are scheduled.
// Storing every activity as its own blob meant that cost grew with the
// total activity count forever, and eventually blew the CPU budget even
// for actions that only touch one activity. Storing the whole collection
// as a single JSON blob under one fixed key turns every read into exactly
// one get() and every write into exactly one setJSON(), regardless of how
// many activities exist.
const ACTIVITIES_KEY = "all";

async function loadActivities(activitiesStore) {
  const data = await activitiesStore.get(ACTIVITIES_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function saveActivities(activitiesStore, list) {
  await activitiesStore.setJSON(ACTIVITIES_KEY, list);
}

function genUniqueActivityId(existingIds) {
  let id = genActivityId();
  while (existingIds.has(id)) {
    id = genActivityId();
  }
  return id;
}

// Towns — same one-blob-collection pattern as activities above (see the
// comment on ACTIVITIES_KEY for why). A town can optionally be allocated
// to one affiliate (affId) so it's available to that affiliate's area
// hooks specifically, not just tagged with a broad zone the way
// affiliates themselves are — see sanitizeTown / toTownPin. A town with
// no affId set is treated as shared/unallocated and visible to every
// affiliate's Explore Map and area-hook picker.
const TOWNS_KEY = "all";

async function loadTowns(townsStore) {
  const data = await townsStore.get(TOWNS_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function saveTowns(townsStore, list) {
  await townsStore.setJSON(TOWNS_KEY, list);
}

// Runs `fn` over `items` with at most `limit` calls in flight at once.
// Still used for the (small, not expected to grow into the hundreds)
// property-listings and map-visibility stores — see loadActivities above
// for why activities themselves no longer use this pattern.
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


// Forward-geocoding + name-vs-coordinate confidence checking (used by the
// suggestCoordinates action below, and by resorts-api.js's nightly sync)
// now lives in lib/geolocate.js as forwardGeocodeByName /
// checkNameAgainstCoordinate — extracted 2026-09-29 so both call sites
// share one implementation. See that file's header comment.

async function verifyAdminToken(token) {
  if (!token) return false;
  const sessionStore = getStore({ name: "admin-sessions", consistency: "strong" });
  const session = await sessionStore.get(token, { type: "json" });
  if (!session) return false;
  if (new Date(session.expiresAt).getTime() < Date.now()) return false;
  return true;
}

function coverImageUrl(images) {
  if (!Array.isArray(images) || !images.length) return "";
  const cover = images.find((i) => i && i.cover === "Y") || images[0];
  return cover && cover.key ? "/api/property-file?key=" + encodeURIComponent(cover.key) : "";
}

function toPropertyPin(record, hidden) {
  const lat = parseFloat(record.latitude);
  const lng = parseFloat(record.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return {
    kind: "property",
    listingId: record.listingId,
    source: "onboarded",
    name: record.propertyName || "",
    area: record.area || record.district || "",
    city: record.city || "",
    country: record.country || "",
    // Prefer a location explicitly tagged on the listing (set by an admin
    // via the Property Listings review picker, or auto-filled by the
    // geocodeLocations action below) over the live province guess, so a
    // property once tagged shows up correctly in the location tree filter
    // instead of only ever being findable by its loose province match.
    zone: recordZone(record) || provinceToZone(record.stateProvince),
    townId: record.townId || "",
    suburbId: record.suburbId || "",
    locationLabel: record.locationLabel || "",
    description: (record.description || "").slice(0, 400),
    latitude: lat,
    longitude: lng,
    infoLink: record.infoLink || "",
    bookingLink: record.bookingLink || "",
    photo: coverImageUrl(record.images),
    hidden: !!hidden,
  };
}

// StockNetwork's own resort list is a much bigger dataset (thousands of
// properties) than the hand-onboarded property-listings above — it's the
// full inventory, kept up to date by re-uploading a CSV from StockNetwork
// via the existing /api/resorts endpoint (see resorts-api.js). Most rows
// won't have Latitude/Longitude unless that CSV export includes them, so
// only ones that do become pins here — same "skip if no usable
// coordinates" rule as onboarded properties. listingId is synthetic
// (resort:<resortId>:<siteId>) so a resort pin can still be individually
// hidden via the same map-visibility store as everything else, even
// though there's no per-row edit UI for this dataset (updates happen by
// re-uploading the whole CSV, not one row at a time).
function resortPinId(record) {
  return "resort:" + (record.resortId || "") + ":" + (record.siteId || "");
}

function toResortPin(record, hidden) {
  const lat = parseFloat(record.latitude);
  const lng = parseFloat(record.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const infoLink = record.resortId
    ? "https://old.stocknetwork.co.za/ResortInfo.aspx?ResortID=" +
      encodeURIComponent(record.resortId) +
      (record.siteId ? "&SiteID=" + encodeURIComponent(record.siteId) : "")
    : "";
  return {
    kind: "property",
    listingId: resortPinId(record),
    source: "resort-list",
    // Exposed (2026-10-03) so admin.html's map popup can offer an inline
    // "Edit location" action for this one row without needing its raw
    // resortList array index (which shifts as the list is re-fetched) —
    // see resolveStocknetworkLocation's resortId lookup path below.
    resortId: record.resortId || "",
    siteId: record.siteId || "",
    name: record.name || "",
    area: record.suburb || record.district || "",
    city: "",
    country: record.country || "South Africa",
    // Same preference order as toPropertyPin above: a location the
    // geocodeLocations action already resolved for this exact resort row
    // wins over the CSV-column guess, since it's tied to the property's
    // real coordinates rather than a district-name keyword match. When it
    // falls back to the CSV columns, districtToZone(district) is checked
    // BEFORE provinceToZone(zoneHint) — a district/town name (e.g.
    // "Knysna") can hit the Garden Route entry in TOWN_ZONE_KEYWORDS,
    // while zoneHint is often just the real province ("Western Cape"),
    // which would otherwise win first and mis-zone every Garden Route
    // resort row exactly like the geocodeLocations bug fixed above.
    zone: recordZone(record) || districtToZone(record.district) || provinceToZone(record.zoneHint),
    townId: record.townId || "",
    suburbId: record.suburbId || "",
    locationLabel: record.locationLabel || "",
    description: "",
    latitude: lat,
    longitude: lng,
    infoLink: infoLink,
    bookingLink: "",
    photo: "",
    hidden: !!hidden,
  };
}

function sanitizeActivity(body, existing) {
  const record = existing ? Object.assign({}, existing) : {};
  const fields = ["name", "area", "description", "price", "contactLink"];
  fields.forEach((f) => {
    if (typeof body[f] === "string") {
      record[f] = clean(body[f], f === "description" ? 2000 : 300);
    }
  });
  if (typeof body.zone === "string") {
    record.zone = okZone(body.zone);
  }
  // country (2026-10-04): the top level of the Country > Zone > Town >
  // Suburb tree. Blank means "not set" (activities were never forced to
  // carry one); the town's own country wins whenever a town is tagged.
  if (typeof body.country === "string") {
    record.country = clean(body.country, 120);
  }
  // Which town/suburb (from the Zone > Town > Suburb tree) this activity
  // is tagged with — set via admin.html's location tree picker, which
  // replaced the old flat Zone-only dropdown. Not validated against the
  // live towns list here (this file's sanitize* helpers don't cross-
  // reference each other's collections) — same accepted staleness as
  // sanitizeTown's own affId field: a townId/suburbId that's since been
  // deleted just means this activity quietly stops matching anything.
  if (typeof body.townId === "string") record.townId = clean(body.townId, 60);
  if (typeof body.suburbId === "string") record.suburbId = clean(body.suburbId, 60);
  if (typeof body.locationLabel === "string") record.locationLabel = clean(body.locationLabel, 160);
  if (typeof body.latitude === "string" || typeof body.latitude === "number") {
    const lat = parseFloat(body.latitude);
    record.latitude = isFinite(lat) ? String(lat) : "";
  }
  if (typeof body.longitude === "string" || typeof body.longitude === "number") {
    const lng = parseFloat(body.longitude);
    record.longitude = isFinite(lng) ? String(lng) : "";
  }
  if (typeof body.visible === "boolean") record.visible = body.visible;
  if (record.visible === undefined) record.visible = true;
  return record;
}

function sanitizeTown(body, existing) {
  const record = existing ? Object.assign({}, existing) : {};
  const fields = ["name", "area", "description"];
  fields.forEach((f) => {
    if (typeof body[f] === "string") {
      record[f] = clean(body[f], f === "description" ? 2000 : 300);
    }
  });
  if (typeof body.zone === "string") {
    record.zone = okZone(body.zone);
  }
  // country (2026-10-04, Jean's request): a town with a blank country is
  // silently treated as South Africa everywhere (townCountry()), so a town
  // whose coordinate is really elsewhere — or just wrongly entered — could
  // never be corrected from the admin page. Now editable.
  if (typeof body.country === "string") {
    record.country = clean(body.country, 120);
  }
  // affId: which affiliate this town is allocated to. Empty string means
  // shared/unallocated — every affiliate's Explore Map and area-hook
  // picker can use it. Not validated against the affiliate-profiles store
  // here (this file doesn't otherwise read that store) — an affId that no
  // longer exists just means the town quietly stops matching anyone,
  // same failure mode as a stale zone value above.
  if (typeof body.affId === "string") {
    record.affId = clean(body.affId, 60);
  }
  if (typeof body.latitude === "string" || typeof body.latitude === "number") {
    const lat = parseFloat(body.latitude);
    record.latitude = isFinite(lat) ? String(lat) : "";
  }
  if (typeof body.longitude === "string" || typeof body.longitude === "number") {
    const lng = parseFloat(body.longitude);
    record.longitude = isFinite(lng) ? String(lng) : "";
  }
  if (typeof body.visible === "boolean") record.visible = body.visible;
  if (record.visible === undefined) record.visible = true;
  return record;
}

function toTownPin(record) {
  const lat = parseFloat(record.latitude);
  const lng = parseFloat(record.longitude);
  const keys = Array.isArray(record.photoKeys) ? record.photoKeys : record.photoKey ? [record.photoKey] : [];
  const photos = keys.map((k) => "/api/property-file?key=" + encodeURIComponent(k));
  const suburbs = (Array.isArray(record.suburbs) ? record.suburbs : []).map(toSuburbPin);
  return {
    kind: "town",
    id: record.id,
    name: record.name || "",
    area: record.area || "",
    zone: townZone(record),
    country: record.country || "South Africa",
    countrySet: !!record.country,
    affId: record.affId || "",
    description: (record.description || "").slice(0, 400),
    photo: photos[0] || "",
    photos: photos,
    latitude: isFinite(lat) ? lat : null,
    longitude: isFinite(lng) ? lng : null,
    hidden: record.visible === false,
    suburbs: suburbs,
  };
}

function toActivityPin(record) {
  const lat = parseFloat(record.latitude);
  const lng = parseFloat(record.longitude);
  const keys = Array.isArray(record.photoKeys) ? record.photoKeys : record.photoKey ? [record.photoKey] : [];
  const photos = keys.map((k) => "/api/property-file?key=" + encodeURIComponent(k));
  return {
    kind: "activity",
    id: record.id,
    name: record.name || "",
    area: record.area || "",
    country: record.country || "",
    zone: recordZone(record),
    townId: record.townId || "",
    suburbId: record.suburbId || "",
    locationLabel: record.locationLabel || "",
    description: (record.description || "").slice(0, 400),
    price: record.price || "",
    contactLink: record.contactLink || "",
    photo: photos[0] || "",
    photos: photos,
    latitude: isFinite(lat) ? lat : null,
    longitude: isFinite(lng) ? lng : null,
    hidden: record.visible === false,
  };
}

function parseCoordinatesCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const cols = {
    id: idx("id"),
    propertyName: idx("propertyname"),
    latitude: idx("latitude"),
    longitude: idx("longitude"),
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const get = (key) => (cols[key] > -1 ? (fields[cols[key]] || "").trim() : "");
    const id = get("id");
    const propertyName = get("propertyName");
    const latitude = get("latitude");
    const longitude = get("longitude");
    if (!id && !propertyName) continue;
    if (!latitude || !longitude) continue;
    rows.push({ id, propertyName, latitude, longitude });
  }
  return rows;
}

// Auto-discovers the Zone > Town > Suburb tree from data that already
// exists elsewhere in the system, so an admin doesn't have to type every
// town and suburb in by hand:
//  - Onboarded property-listings: city (or district) => town, area => suburb
//    (skipped when it's identical to the town name), stateProvince => zone.
//  - The full StockNetwork resort-list: district => town (no suburb-level
//    field exists on that dataset), district => zone via districtToZone.
//  - map-activities: area => town (activities don't carry a separate town
//    field, so their "area" is the finest location grouping they have),
//    zone as entered by the admin (falls back to a district-style zone
//    guess if it isn't one of the canonical ZONES).
// Coordinates for a discovered town/suburb are the average of every
// contributing record that has a usable latitude/longitude; a node with no
// such record is left with no coordinates, same as the existing
// "missing coordinates" pattern used for properties elsewhere in this file.
async function discoverLocationTree({ listingsStore, resortListStore, activitiesStore }) {
  const zones = new Map(); // zoneName -> Map(townNameLower -> townNode)

  function zoneBucket(zoneName) {
    const key = zoneName || "";
    if (!zones.has(key)) zones.set(key, new Map());
    return zones.get(key);
  }
  function townNode(bucket, name) {
    const key = name.toLowerCase();
    if (!bucket.has(key)) {
      bucket.set(key, { name, suburbs: new Map(), propertyCount: 0, activityCount: 0, latSum: 0, lngSum: 0, coordCount: 0 });
    }
    return bucket.get(key);
  }
  function suburbNode(town, name) {
    const key = name.toLowerCase();
    if (!town.suburbs.has(key)) {
      town.suburbs.set(key, { name, count: 0, latSum: 0, lngSum: 0, coordCount: 0 });
    }
    return town.suburbs.get(key);
  }
  function addCoord(node, lat, lng) {
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (isFinite(la) && isFinite(ln)) { node.latSum += la; node.lngSum += ln; node.coordCount++; }
  }

  const { blobs } = await listingsStore.list();
  const listings = await mapWithConcurrency(blobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
  listings.filter(Boolean).forEach((r) => {
    const townName = clean(r.city || r.district || "", 120);
    if (!townName) return;
    // districtToZone(townName) checked first, provinceToZone(stateProvince)
    // as fallback — same fix as geocodeLocations/toResortPin above, so a
    // Garden Route town typed into property-form.html's free-text
    // stateProvince field as "Western Cape" (accurate, but not this
    // business's zone grouping) doesn't shadow the town-name match.
    const zoneName = districtToZone(townName) || provinceToZone(r.stateProvince) || "";
    const town = townNode(zoneBucket(zoneName), townName);
    town.propertyCount++;
    addCoord(town, r.latitude, r.longitude);
    const suburbName = clean(r.area || "", 120);
    if (suburbName && suburbName.toLowerCase() !== townName.toLowerCase()) {
      const sub = suburbNode(town, suburbName);
      sub.count++;
      addCoord(sub, r.latitude, r.longitude);
    }
  });

  const resortRecord = await resortListStore.get("current", { type: "json" });
  const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
  resortList.forEach((r) => {
    const townName = clean(r.district || "", 120);
    if (!townName) return;
    // zoneHint and suburb are optional columns some StockNetwork exports
    // include (see resorts-api.js) — use them when present for a more
    // precise zone and a Suburb-level node; fall back to the district-only
    // behavior (zone guessed from district, no suburb) when they're not.
    // districtToZone(district) checked first, provinceToZone(zoneHint) as
    // fallback — same Garden-Route-vs-Western-Cape-province fix as
    // everywhere else in this file; see the geocodeLocations comment above
    // for the full explanation.
    const zoneName = districtToZone(r.district) || provinceToZone(r.zoneHint) || "";
    const town = townNode(zoneBucket(zoneName), townName);
    town.propertyCount++;
    addCoord(town, r.latitude, r.longitude);
    const suburbName = clean(r.suburb || "", 120);
    if (suburbName && suburbName.toLowerCase() !== townName.toLowerCase()) {
      const sub = suburbNode(town, suburbName);
      sub.count++;
      addCoord(sub, r.latitude, r.longitude);
    }
  });

  const activities = await loadActivities(activitiesStore);
  activities.filter(Boolean).forEach((r) => {
    const townName = clean(r.area || "", 120);
    if (!townName) return;
    const zoneName = okZone(r.zone) || districtToZone(r.area) || "";
    const town = townNode(zoneBucket(zoneName), townName);
    town.activityCount++;
    addCoord(town, r.latitude, r.longitude);
  });

  const result = [];
  zones.forEach((townsMap, zoneName) => {
    const towns = [];
    townsMap.forEach((t) => {
      const suburbs = [];
      t.suburbs.forEach((s) => {
        suburbs.push({
          name: s.name,
          count: s.count,
          latitude: s.coordCount ? s.latSum / s.coordCount : null,
          longitude: s.coordCount ? s.lngSum / s.coordCount : null,
        });
      });
      suburbs.sort((a, b) => a.name.localeCompare(b.name));
      towns.push({
        name: t.name,
        propertyCount: t.propertyCount,
        activityCount: t.activityCount,
        latitude: t.coordCount ? t.latSum / t.coordCount : null,
        longitude: t.coordCount ? t.lngSum / t.coordCount : null,
        suburbs,
      });
    });
    towns.sort((a, b) => a.name.localeCompare(b.name));
    result.push({ zone: zoneName, towns });
  });
  result.sort((a, b) => a.zone.localeCompare(b.zone));
  return result;
}

// Straight-line distance in km between two coordinates (haversine formula).
// haversineKm and NEAREST_TOWN_MAX_KM now live in lib/geolocate.js
// (imported above), shared with resorts-api.js.

// Two towns with the SAME NAME are only treated as one place when their
// coordinates are within this distance of each other. Beyond it they are
// different towns that happen to share a name (Middelburg in Mpumalanga vs
// the Eastern Cape, Elim in Limpopo vs the Western Cape) and get separate
// Town records, each with its own zone. Before this, towns were matched by
// name alone, so those pairs shared one record and every Re-check flipped its
// zone back and forth.
//
// A big city (Cape Town's metro is ~60 km across) comes back from Google as
// ONE town name for properties far apart, so for a same-named town that is in
// the SAME ZONE the match is looser: up to this distance it is still the same
// place. (Different zone = a different town, whatever the distance.)
//
// Both values now live in lib/geolocate.js (imported above), shared with
// resorts-api.js.

// "Cape Town", "cape town " and "Cape  Town" are one name.
function townNameKey(n) {
  return String(n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Finds towns that are the same place recorded more than once: same name, same
// country, same zone, and within SAME_ZONE_TOWN_MAX_KM of each other (or one
// has no coordinates). Same-named towns in DIFFERENT zones (Heidelberg in the
// Western Cape and in Gauteng) are left alone. Returns the groups plus the
// old-id -> surviving-id maps (towns, and suburbs that had to be joined to a
// same-named suburb of the survivor). Deterministic, so the preview and the
// apply step always agree.
function planTownMerges(allTowns) {
  const byKey = new Map();
  allTowns.forEach((t) => {
    if (!t || !t.id) return;
    const k = townNameKey(t.name) + "|" + townCountry(t).toLowerCase() + "|" + townZone(t);
    if (!townNameKey(t.name)) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  });

  const score = (t) => {
    const photos = Array.isArray(t.photoKeys) ? t.photoKeys.length : (t.photoKey ? 1 : 0);
    return (Array.isArray(t.suburbs) ? t.suburbs.length : 0) * 2 + photos * 3 +
      (t.description ? 2 : 0) + (t.affId ? 1 : 0) +
      (isFinite(parseFloat(t.latitude)) && isFinite(parseFloat(t.longitude)) ? 1 : 0);
  };

  const groups = [];
  const townMap = {};
  const subMap = {};
  byKey.forEach((list) => {
    if (list.length < 2) return;
    // Union-find over "close enough (or no coordinates to compare)".
    const parent = list.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const aLat = parseFloat(a.latitude), aLng = parseFloat(a.longitude);
        const d = (isFinite(aLat) && isFinite(aLng)) ? townDistanceKm(b, aLat, aLng) : Infinity;
        if (!isFinite(d) || d <= SAME_ZONE_TOWN_MAX_KM) parent[find(j)] = find(i);
      }
    }
    const clusters = new Map();
    list.forEach((t, i) => {
      const r = find(i);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r).push(t);
    });
    clusters.forEach((members) => {
      if (members.length < 2) return;
      members.sort((a, b) => (score(b) - score(a)) ||
        String(a.createdAt || "9").localeCompare(String(b.createdAt || "9")) || String(a.id).localeCompare(String(b.id)));
      const survivor = members[0];
      const survivorSubs = new Map();
      (Array.isArray(survivor.suburbs) ? survivor.suburbs : []).forEach((s) => {
        const k = townNameKey(s.name);
        if (k && !survivorSubs.has(k)) survivorSubs.set(k, s);
      });
      let suburbsJoined = 0, suburbsMoved = 0, affConflict = false;
      const outMembers = [];
      members.forEach((m, idx) => {
        outMembers.push({
          id: m.id, name: m.name || "", zone: townZone(m), latitude: m.latitude || "", longitude: m.longitude || "",
          suburbs: Array.isArray(m.suburbs) ? m.suburbs.length : 0, affId: m.affId || "", survivor: idx === 0,
        });
        if (idx === 0) return;
        townMap[m.id] = survivor.id;
        if ((m.affId || "") !== (survivor.affId || "") && m.affId) affConflict = true;
        (Array.isArray(m.suburbs) ? m.suburbs : []).forEach((s) => {
          const k = townNameKey(s.name);
          const same = k && survivorSubs.get(k);
          if (same) { subMap[s.id] = same.id; suburbsJoined++; }
          else { if (k) survivorSubs.set(k, s); suburbsMoved++; }
        });
      });
      groups.push({
        name: survivor.name || "", zone: townZone(survivor), country: townCountry(survivor),
        survivorId: survivor.id, members: outMembers, suburbsJoined, suburbsMoved, affConflict,
      });
    });
  });
  groups.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
  return { groups, townMap, subMap };
}

function isPlainMap(x) { return !!x && typeof x === "object" && !Array.isArray(x); }

// Re-points a record's townId/suburbId after towns were merged. Returns true
// when something changed.
function remapTownRefs(rec, townMap, subMap) {
  if (!rec || typeof rec !== "object") return false;
  let changed = false;
  if (typeof rec.townId === "string" && townMap[rec.townId]) { rec.townId = townMap[rec.townId]; changed = true; }
  if (typeof rec.suburbId === "string" && subMap[rec.suburbId]) { rec.suburbId = subMap[rec.suburbId]; changed = true; }
  return changed;
}

// ---- Location tree audit (read-only) -------------------------------------
// "Merge duplicate towns" above only ever catches an EXACT (case/whitespace-
// insensitive) name match within the SAME country+zone — that's deliberately
// narrow so it can safely auto-merge. It never catches two other real
// patterns Jean spotted by eye in the live tree (2026-09-28):
//   1. "Inhambane" vs "Inhambane Province" — the same real place recorded
//      twice under names that differ by a qualifier word, which planTownMerges
//      treats as two unrelated names.
//   2. "Brenton-on-Sea" existing as BOTH its own standalone Town AND (as
//      "Brenton") a Suburb entry nested under Knysna — a cross-level
//      duplicate planTownMerges was never designed to look for at all, since
//      it only ever compares towns against other towns.
// This section is a REPORT ONLY — nothing here writes anything. Per Jean's
// standing rule (see suggestPropertyCoordinates above), a fuzzy name/distance
// match can be wrong (two genuinely different places that happen to share a
// qualifier-stripped name), so every result here is for a human to look at
// and act on by hand — via the existing Edit/Delete/Merge tools — never
// auto-applied.
//
// namesLikelySamePlace: true when two place names are identical once
// normalized, OR when the shorter one is a whole-word prefix of the longer
// one ("brenton" is a prefix of "brenton on sea"; "inhambane" is a prefix of
// "inhambane province"). Deliberately does NOT do general fuzzy/edit-distance
// matching — that produces too many unrelated false positives (misspellings
// aside, this codebase has no evidence of any); a qualifier-word SUFFIX is
// the specific, real pattern being targeted here.
function namesLikelySamePlace(nameA, nameB) {
  const a = townNameKey(nameA);
  const b = townNameKey(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.indexOf(shorter + " ") === 0;
}

// Every pair of Towns that are plausibly the same real place recorded twice,
// but which planTownMerges' exact-match grouping would never bucket together
// (different qualifier wording, and/or a different zone/country recorded on
// one of the two — itself often a symptom of the same underlying mix-up).
// Filtered to pairs within SAME_ZONE_TOWN_MAX_KM of each other (or missing
// coordinates on either side, in which case distance can't rule it out, so
// it's still surfaced for a human to check). Excludes the exact-match case
// "Merge duplicate towns" already finds and can fix on its own.
function auditNearDuplicateTowns(allTowns) {
  const results = [];
  for (let i = 0; i < allTowns.length; i++) {
    const a = allTowns[i];
    if (!a || !a.id || !a.name) continue;
    for (let j = i + 1; j < allTowns.length; j++) {
      const b = allTowns[j];
      if (!b || !b.id || !b.name) continue;
      if (!namesLikelySamePlace(a.name, b.name)) continue;
      const exactMatch = townNameKey(a.name) === townNameKey(b.name) &&
        townCountry(a).toLowerCase() === townCountry(b).toLowerCase() && townZone(a) === townZone(b);
      if (exactMatch) continue; // already covered by "Merge duplicate towns"
      const aLat = parseFloat(a.latitude), aLng = parseFloat(a.longitude);
      const bLat = parseFloat(b.latitude), bLng = parseFloat(b.longitude);
      const hasCoords = isFinite(aLat) && isFinite(aLng) && isFinite(bLat) && isFinite(bLng);
      const km = hasCoords ? haversineKm(aLat, aLng, bLat, bLng) : null;
      if (hasCoords && km > SAME_ZONE_TOWN_MAX_KM) continue;
      results.push({
        a: { id: a.id, name: a.name || "", zone: townZone(a), country: townCountry(a), latitude: a.latitude || "", longitude: a.longitude || "", suburbs: Array.isArray(a.suburbs) ? a.suburbs.length : 0 },
        b: { id: b.id, name: b.name || "", zone: townZone(b), country: townCountry(b), latitude: b.latitude || "", longitude: b.longitude || "", suburbs: Array.isArray(b.suburbs) ? b.suburbs.length : 0 },
        distanceKm: km,
      });
    }
  }
  return results;
}

// Every Town whose name plausibly matches a Suburb nested under a DIFFERENT
// town — the Brenton-on-Sea/Knysna pattern. Filtered to within
// SAME_TOWN_MAX_KM (tighter than the town-vs-town check above, since a
// suburb is expected to sit close to its own parent town) or missing
// coordinates on either side.
function auditTownSuburbOverlaps(allTowns) {
  const results = [];
  allTowns.forEach((town) => {
    if (!town || !town.id || !town.name) return;
    allTowns.forEach((parent) => {
      if (!parent || !parent.id || parent.id === town.id) return;
      (Array.isArray(parent.suburbs) ? parent.suburbs : []).forEach((sub) => {
        if (!sub || !sub.id || !sub.name) return;
        if (!namesLikelySamePlace(town.name, sub.name)) return;
        const tLat = parseFloat(town.latitude), tLng = parseFloat(town.longitude);
        const sLat = parseFloat(sub.latitude), sLng = parseFloat(sub.longitude);
        const hasCoords = isFinite(tLat) && isFinite(tLng) && isFinite(sLat) && isFinite(sLng);
        const km = hasCoords ? haversineKm(tLat, tLng, sLat, sLng) : null;
        if (hasCoords && km > SAME_TOWN_MAX_KM) return;
        results.push({
          standaloneTown: { id: town.id, name: town.name || "", zone: townZone(town), country: townCountry(town), latitude: town.latitude || "", longitude: town.longitude || "" },
          suburb: { id: sub.id, name: sub.name || "", parentTownId: parent.id, parentTownName: parent.name || "", latitude: sub.latitude || "", longitude: sub.longitude || "" },
          distanceKm: km,
        });
      });
    });
  });
  return results;
}

// A property/resort/activity should sit one level below its Town/Suburb in
// the tree, not floating free of it. Two ways that breaks: (a) a stored
// townId/suburbId that points at a Town/Suburb which no longer exists (left
// behind by a hand delete, or a merge whose remap step didn't reach this
// record); (b) a record with a zone but no townId at all — tagged only at
// the Region level, never actually nested under a Town. Read-only, same as
// the rest of this audit.
function auditOrphanRefs(allTowns, listings, resortList, activities) {
  const townIds = new Set(allTowns.filter((t) => t && t.id).map((t) => t.id));
  const subIdsByTown = new Map(allTowns.filter((t) => t && t.id).map((t) => [t.id, new Set((Array.isArray(t.suburbs) ? t.suburbs : []).map((s) => s && s.id).filter(Boolean))]));
  const orphans = [];
  const zoneOnly = [];
  function check(source, r, label) {
    if (!r) return;
    const tid = typeof r.townId === "string" ? r.townId : "";
    const sid = typeof r.suburbId === "string" ? r.suburbId : "";
    if (tid && !townIds.has(tid)) {
      orphans.push({ source, name: label, issue: "townId " + tid + " no longer exists", townId: tid, suburbId: sid });
      return;
    }
    if (sid) {
      if (!tid) {
        orphans.push({ source, name: label, issue: "has a suburbId but no townId", townId: "", suburbId: sid });
      } else {
        const subs = subIdsByTown.get(tid);
        if (subs && !subs.has(sid)) orphans.push({ source, name: label, issue: "suburbId " + sid + " is not a suburb of town " + tid, townId: tid, suburbId: sid });
      }
    }
    if (r.zone && !tid) zoneOnly.push({ source, name: label, zone: r.zone });
  }
  (listings || []).forEach((r) => { if (r && r.status === "Listed") check("listing", r, r.propertyName || r.listingId || ""); });
  (resortList || []).forEach((r, i) => { if (r) check("resort", r, r.name || ("resort row " + i)); });
  (activities || []).forEach((r) => { if (r) check("activity", r, r.name || r.id || ""); });
  return { orphans, zoneOnly };
}

// COAST_SLACK_KM, SA_NAME, LOCATION_TAG_VERSION, okZone, townCountry,
// townZone, townDistanceKm, nearestTown, looksLikeDistrict and
// ensureTownAndSuburb now all live in lib/geolocate.js (imported above),
// shared with resorts-api.js.

// Same idea as townZone: place a property/resort/activity row still tagged
// with the old combined zone name by its own coordinates.
function recordZone(r) {
  return townZone(r);
}

// geoCacheKey, cachedReverseGeocode, forwardGeoCacheKey, cachedForwardGeocode,
// resolveLocationForCoordinate and applyLocationTag now all live in
// lib/geolocate.js (imported above), shared with resorts-api.js.

// Auto-geocodes ONE record in place, right when it's saved, using the exact
// same resolveLocationForCoordinate step as the batch actions above — just
// run synchronously for a single coordinate instead of in a batch, so a
// brand-new activity or property never needs a separate "Start geocoding"
// click to get a Region/Town at all. Called from addActivity/updateActivity
// below. A no-op whenever it isn't needed or can't safely run: no API key
// configured, no usable coordinate on the record, or — same "never
// overwrite what's already set" rule as everywhere else in this file — the
// record already has a locationLabel, whether that came from an earlier
// geocode run or an admin manually picking a location from the tree. Any
// Google/network failure here is swallowed rather than blocking the save —
// the record just stays untagged, exactly as if "Start geocoding" hadn't
// reached it yet, and the existing manual tools (Start geocoding, Re-check
// all zones) remain the fallback if this ever misses one.
async function autoGeocodeRecord(record, apiKey, townsStore, geoCache) {
  if (!apiKey || !record || record.locationLabel) return;
  const lat = parseFloat(record.latitude);
  const lng = parseFloat(record.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return;
  try {
    const allTowns = await loadTowns(townsStore);
    const existingIds = new Set(allTowns.map((t) => t.id));
    const { result } = await resolveLocationForCoordinate(lat, lng, apiKey, allTowns, existingIds, false, geoCache);
    if (result) {
      record.zone = result.zone;
      record.townId = result.townId;
      record.suburbId = result.suburbId;
      record.locationLabel = result.locationLabel;
      record.country = result.country;
      record.nearby = !!result.nearby;
      await saveTowns(townsStore, allTowns);
    }
  } catch (e) {
    // Best-effort — swallow and leave the record untagged rather than fail
    // the save the admin is actually waiting on.
  }
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

  const json = (data, status) =>
    new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "content-type": "application/json", ...cors },
    });

  const listingsStore = getStore({ name: "property-listings", consistency: "strong" });
  const activitiesStore = getStore({ name: "map-activities", consistency: "strong" });
  const townsStore = getStore({ name: "map-towns", consistency: "strong" });
  const visibilityStore = getStore({ name: "map-visibility", consistency: "strong" });
  const resortListStore = getStore({ name: "resort-list", consistency: "strong" });
  // Raw Google reverse-geocode answers, one blob per (4-decimal) coordinate,
  // so a coordinate is only ever paid for once — see cachedReverseGeocode.
  const geoCacheStore = getStore({ name: "map-geocache", consistency: "strong" });
  // Same store + key shape as property-file-api.js's own upload — a
  // Places-picked activity photo has to show up in exactly the same place
  // a manually-uploaded one does, since toActivityPin() reads both kinds
  // of photoKeys identically via /api/property-file?key=...
  const activityPhotoFilesStore = getStore({ name: "property-listing-files", consistency: "strong" });
  // StockNetwork resort rows the nightly sync couldn't match to an existing
  // hub property — written by resorts-api.js's handleApiSync, read by
  // listPendingNewStockNetworkProperties/dismissPendingNewStockNetworkProperty
  // below (new-properties-flagging, 2026-10-03).
  const pendingNewStore = getStore({ name: "resort-pending-new", consistency: "strong" });
// Countries and Zones that exist in the hub's location tree WITHOUT (yet)
// any town under them (2026-10-04, Jean's "Country > Zone > Town > Suburb"
// picker). Everything else is derived from the towns themselves (+ the 12
// fixed South African zones) so nothing needs migrating — this store only
// holds the extras a person adds via the picker's "Not in the list — add a
// new country/zone" step. Shape: { countries: [name], zones: [{country, name}] }.
const locationListStore = getStore({ name: "map-location-lists", consistency: "strong" });

  try {
    if (request.method === "GET") {
      // ?shapes=1 — the zone polygons + zone list the Master map shades with.
      // Static data (lib/zone-shapes.js), so it can be cached hard.
      if (new URL(request.url).searchParams.get("shapes")) {
        return new Response(JSON.stringify({ ok: true, zones: ZONES, shapes: zoneShapes() }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "public, max-age=3600", ...cors },
        });
      }
      const { blobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(blobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const { blobs: visBlobs } = await visibilityStore.list();
      const visFlags = await mapWithConcurrency(visBlobs, 25, (b) => visibilityStore.get(b.key, { type: "json" }));
      const hiddenIds = new Set(
        visBlobs.filter((b, i) => visFlags[i] && visFlags[i].hidden).map((b) => b.key)
      );

      const onboardedProperties = listings
        .filter((r) => r && r.status === "Listed")
        .filter((r) => !hiddenIds.has(r.listingId))
        .map((r) => toPropertyPin(r, false))
        .filter(Boolean);

      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const resortProperties = resortList
        .filter((r) => !hiddenIds.has(resortPinId(r)))
        .map((r) => toResortPin(r, false))
        .filter(Boolean);

      const properties = onboardedProperties.concat(resortProperties);

      const activities = (await loadActivities(activitiesStore))
        .filter((r) => r && r.visible !== false)
        .map(toActivityPin);

      // A town allocated to one affiliate (affId set) only appears for that
      // affiliate's own Explore Map / area-hook picker. ?aff=<id> on the
      // request scopes this; omitting it (or the admin's own unfiltered
      // view) returns every visible town, allocated or not. Properties and
      // activities are unaffected — they aren't affiliate-scoped.
      const requestedAff = new URL(request.url).searchParams.get("aff") || "";
      const townMatchesAff = (r) => !r.affId || !requestedAff || r.affId === requestedAff;
      const towns = (await loadTowns(townsStore))
        .filter((r) => r && r.visible !== false)
        // A town qualifies if its own allocation matches (or is
        // shared/unallocated), OR — when it has suburbs — at least one of
        // those suburbs qualifies on its own. This lets one town hold
        // suburbs allocated to different affiliates side by side.
        .filter((r) => {
          const suburbs = Array.isArray(r.suburbs) ? r.suburbs.filter((s) => s && s.visible !== false) : [];
          if (!suburbs.length) return townMatchesAff(r);
          return townMatchesAff(r) || suburbs.some(townMatchesAff);
        })
        .map((r) => {
          const pin = toTownPin(r);
          if (requestedAff) {
            pin.suburbs = pin.suburbs.filter((s) => !s.affId || s.affId === requestedAff);
          }
          return pin;
        });

      return json({ ok: true, properties, activities, towns });
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid JSON" }, 400);
    }

    const authed = await verifyAdminToken(body.token);
    if (!authed) return json({ error: "Not authenticated." }, 401);

    const action = body.action;

    if (action === "adminList") {
      const { blobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(blobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const { blobs: visBlobs } = await visibilityStore.list();
      const visRecords = await mapWithConcurrency(visBlobs, 25, (b) => visibilityStore.get(b.key, { type: "json" }));
      const hiddenIds = new Set(visBlobs.filter((b, i) => visRecords[i] && visRecords[i].hidden).map((b) => b.key));

      const listedListings = listings.filter((r) => r && r.status === "Listed");
      const onboardedProperties = listedListings.map((r) => toPropertyPin(r, hiddenIds.has(r.listingId))).filter(Boolean);

      // Listed properties with no usable coordinates never become a pin, so
      // they're surfaced here separately — the admin tab uses this to show
      // which ones still need a latitude/longitude, e.g. via the
      // importPropertyCoordinatesCsv action below.
      const missingCoordinates = listedListings
        .filter((r) => {
          const lat = parseFloat(r.latitude);
          const lng = parseFloat(r.longitude);
          return !isFinite(lat) || !isFinite(lng);
        })
        .map((r) => ({
          listingId: r.listingId,
          propertyName: r.propertyName || "",
          city: r.city || "",
          country: r.country || "",
        }));

      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const resortProperties = resortList
        .map((r) => toResortPin(r, hiddenIds.has(resortPinId(r))))
        .filter(Boolean);
      const resortStats = {
        total: resortList.length,
        withCoordinates: resortProperties.length,
        updatedAt: (resortRecord && resortRecord.updatedAt) || null,
      };

      const properties = onboardedProperties.concat(resortProperties);

      const activities = await loadActivities(activitiesStore);
      const towns = await loadTowns(townsStore);

      const locationLists = (await locationListStore.get("current", { type: "json" })) || {};
      return json({
        ok: true, properties, activities: activities.filter(Boolean), towns: towns.filter(Boolean), missingCoordinates, resortStats,
        // The one list of South African zones (lib/zones.js) — admin.html uses
        // this instead of its own hard-coded copy.
        zones: ZONES,
        locationLists: {
          countries: Array.isArray(locationLists.countries) ? locationLists.countries : [],
          zones: Array.isArray(locationLists.zones) ? locationLists.zones : [],
        },
      });
    }

    if (action === "addLocationValue") {
      // Adds a Country, or a Zone under a Country, to the tree's own list
      // (see locationListStore above). Duplicate-safe (case-insensitive) —
      // adding something that already exists is a quiet success.
      const kind = body.kind === "zone" ? "zone" : body.kind === "country" ? "country" : "";
      const name = clean(body.name, 120);
      const country = clean(body.country, 120);
      if (!kind) return json({ error: "kind must be country or zone." }, 400);
      if (!name) return json({ error: "Name is required." }, 400);
      if (kind === "zone" && !country) return json({ error: "A zone needs its country." }, 400);
      const cur = (await locationListStore.get("current", { type: "json" })) || {};
      const countries = Array.isArray(cur.countries) ? cur.countries.slice() : [];
      const zones = Array.isArray(cur.zones) ? cur.zones.slice() : [];
      const lc = (x) => String(x || "").toLowerCase();
      if (kind === "country") {
        if (!countries.some((c) => lc(c) === lc(name))) countries.push(name);
      } else {
        if (!zones.some((z) => lc(z.name) === lc(name) && lc(z.country) === lc(country))) zones.push({ country, name });
        if (!countries.some((c) => lc(c) === lc(country))) countries.push(country);
      }
      await locationListStore.setJSON("current", { countries, zones, updatedAt: new Date().toISOString() });
      return json({ ok: true, countries, zones });
    }

    if (action === "discoverLocations") {
      // Read-only by default (body.apply falsy): scans property-listings,
      // the resort-list, and map-activities and returns the full Zone >
      // Town > Suburb tree it finds, flagging which nodes are already Town
      // / Suburb records so the admin UI can show what's new. Pass
      // apply:true to actually create the not-yet-existing towns/suburbs —
      // this only ever ADDS; a town or suburb matched by name (existing
      // ones are never touched) keeps every field an admin already set
      // (affId, description, photos, manual coordinate corrections, etc).
      const tree = await discoverLocationTree({ listingsStore, resortListStore, activitiesStore });
      const existingTowns = await loadTowns(townsStore);
      const existingTownByName = new Map(existingTowns.map((t) => [(t.name || "").toLowerCase(), t]));

      let newTowns = 0, newSuburbs = 0;
      tree.forEach((zoneEntry) => {
        zoneEntry.towns.forEach((t) => {
          const existingTown = existingTownByName.get(t.name.toLowerCase());
          t.existing = !!existingTown;
          if (!existingTown) newTowns++;
          const existingSuburbNames = existingTown && Array.isArray(existingTown.suburbs)
            ? new Set(existingTown.suburbs.map((s) => (s.name || "").toLowerCase()))
            : new Set();
          t.suburbs.forEach((s) => {
            s.existing = existingSuburbNames.has(s.name.toLowerCase());
            if (!s.existing) newSuburbs++;
          });
        });
      });

      if (body.apply) {
        const all = existingTowns.slice();
        const existingIds = new Set(all.map((t) => t.id));
        tree.forEach((zoneEntry) => {
          zoneEntry.towns.forEach((t) => {
            let townRecord = all.find((r) => (r.name || "").toLowerCase() === t.name.toLowerCase());
            if (!townRecord) {
              townRecord = {
                id: genTownUniqueId(existingIds),
                name: t.name,
                area: "",
                zone: okZone(zoneEntry.zone),
                affId: "",
                description: "",
                latitude: t.latitude != null ? String(t.latitude) : "",
                longitude: t.longitude != null ? String(t.longitude) : "",
                visible: true,
                suburbs: [],
                createdAt: new Date().toISOString(),
              };
              townRecord.updatedAt = townRecord.createdAt;
              existingIds.add(townRecord.id);
              all.push(townRecord);
            } else {
              // Backfill only what's currently blank on an already-existing
              // town — an admin edit (or a value set on an earlier, less
              // detailed run of this same scan) always wins. This is what
              // lets re-running Discover after uploading a richer export
              // (e.g. one that now has a Zone/Province/State column) fill
              // in the zone/coordinates on towns that were created before
              // that column was available, without touching anything the
              // admin has since changed by hand.
              if ((!townRecord.zone || LEGACY_ZONES[townRecord.zone]) && okZone(zoneEntry.zone)) townRecord.zone = okZone(zoneEntry.zone);
              if (!townRecord.latitude && t.latitude != null) townRecord.latitude = String(t.latitude);
              if (!townRecord.longitude && t.longitude != null) townRecord.longitude = String(t.longitude);
            }
            if (!Array.isArray(townRecord.suburbs)) townRecord.suburbs = [];
            const existingSuburbNames = new Set(townRecord.suburbs.map((s) => (s.name || "").toLowerCase()));
            t.suburbs.forEach((s) => {
              if (existingSuburbNames.has(s.name.toLowerCase())) return;
              const suburbRecord = {
                id: genSuburbUniqueId(allSuburbIds(all)),
                name: s.name,
                affId: "",
                latitude: s.latitude != null ? String(s.latitude) : "",
                longitude: s.longitude != null ? String(s.longitude) : "",
                visible: true,
              };
              townRecord.suburbs.push(suburbRecord);
              existingSuburbNames.add(s.name.toLowerCase());
            });
          });
        });
        await saveTowns(townsStore, all);
        return json({ ok: true, applied: true, createdTowns: newTowns, createdSuburbs: newSuburbs, towns: all });
      }

      return json({ ok: true, applied: false, tree, newTowns, newSuburbs });
    }

    if (action === "geocodeLocations") {
      // Builds the location tree straight from coordinates instead of
      // relying on district/city text columns — reverse-geocodes every
      // property, resort-list row, and activity that has a lat/long but no
      // location tag yet (checked via locationLabel, so a manually-picked
      // "whole zone" tag — which leaves townId/suburbId blank on purpose —
      // is never mistaken for "untagged" and re-geocoded over the top of).
      //
      // dryRun:true costs nothing and no Google calls are made — it just
      // reports how many records and how many distinct coordinates (several
      // records at the same address only ever cost one lookup between
      // them) would be geocoded, so the admin can see the real number
      // before spending anything.
      //
      // Without dryRun, processes up to `limit` distinct coordinates (default
      // 40) per call and reports how many are left — the admin UI calls this
      // repeatedly until remainingCoordinates is 0, so one run never risks
      // timing out the function on a large batch.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) {
        return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);
      }

      const { blobs: listingBlobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(listingBlobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const activities = await loadActivities(activitiesStore);

      function usable(r) {
        const lat = parseFloat(r.latitude);
        const lng = parseFloat(r.longitude);
        return isFinite(lat) && isFinite(lng) && !r.locationLabel;
      }

      const targets = [];
      listings.forEach((r) => {
        if (r && r.status === "Listed" && usable(r)) {
          targets.push({ source: "listing", key: r.listingId, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
        }
      });
      resortList.forEach((r, i) => {
        if (usable(r)) targets.push({ source: "resort", key: i, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
      });
      activities.forEach((r) => {
        if (r && usable(r)) targets.push({ source: "activity", key: r.id, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
      });

      // Round to 4 decimal places (~11m) so records sharing — or nearly
      // sharing — a coordinate only ever cost one Google lookup between them.
      const groups = new Map();
      targets.forEach((t) => {
        const k = t.lat.toFixed(4) + "," + t.lng.toFixed(4);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      });

      if (body.dryRun) {
        return json({ ok: true, dryRun: true, totalRecords: targets.length, uniqueCoordinates: groups.size });
      }

      // Capped at 20 rather than the original 100: with concurrency 8 below,
      // a batch this size still comfortably finishes inside the Edge
      // Function's own time limit even under slow real-world Google
      // response times. The admin UI's client loop asks for 12 at a time by
      // default and just makes more round-trips instead of fewer, riskier
      // ones — this cap is a backstop against a larger value ever being
      // passed in, not the normal case.
      const limit = Math.max(1, Math.min(parseInt(body.limit, 10) || 12, 20));
      const groupKeys = Array.from(groups.keys()).slice(0, limit);
      const remainingCoordinates = Math.max(0, groups.size - groupKeys.length);

      const allTowns = await loadTowns(townsStore);
      const existingIds = new Set(allTowns.map((t) => t.id));

      let addedTowns = 0, addedSuburbs = 0, taggedRecords = 0, geocodeFailures = 0;
      // Records placed by proximity to an existing town rather than a real
      // Google match — see the ZERO_RESULTS branch below. Counted
      // separately from taggedRecords (which includes these too) so the
      // admin UI can be upfront about which is which.
      let fallbackTagged = 0;
      let resortListChanged = false;
      let activitiesChanged = false;
      const listingUpdates = [];
      // Google's own status/message from the first lookup that didn't come
      // back OK — surfaced to the admin UI so "every coordinate failed"
      // reads as an actual diagnosis (e.g. "REQUEST_DENIED: This API key is
      // not authorized...") instead of a dead end.
      let firstFailureReason = "";
      let firstFailureMessage = "";
      // A handful of the actual failing coordinates, so a run of
      // ZERO_RESULTS (a valid Google response that just found nothing
      // there — usually a placeholder/invalid coordinate, not a config
      // problem) can be diagnosed by looking at the numbers themselves
      // instead of digging through the database.
      const exampleFailures = [];

      await mapWithConcurrency(groupKeys, 8, async (key) => {
        const parts = key.split(",");
        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);
        const { result, viaFallback, failureReason, failureMessage } =
          await resolveLocationForCoordinate(lat, lng, apiKey, allTowns, existingIds, false, geoCacheStore);

        if (result) {
          if (result.createdTown) addedTowns++;
          if (result.createdSuburb) addedSuburbs++;
        } else {
          geocodeFailures++;
          if (!firstFailureReason && failureReason) {
            firstFailureReason = failureReason;
            firstFailureMessage = failureMessage;
          }
          if (exampleFailures.length < 5) {
            exampleFailures.push(lat.toFixed(4) + "," + lng.toFixed(4));
          }
          return;
        }

        (groups.get(key) || []).forEach((t) => {
          taggedRecords++;
          if (viaFallback) fallbackTagged++;
          if (t.source === "listing") {
            const rec = listings.find((r) => r.listingId === t.key);
            if (rec) {
              applyLocationTag(rec, result);
              listingUpdates.push(rec);
            }
          } else if (t.source === "resort") {
            const rec = resortList[t.key];
            if (rec) {
              applyLocationTag(rec, result);
              resortListChanged = true;
            }
          } else if (t.source === "activity") {
            const rec = activities.find((r) => r.id === t.key);
            if (rec) {
              applyLocationTag(rec, result);
              activitiesChanged = true;
            }
          }
        });
      });

      await saveTowns(townsStore, allTowns);
      if (listingUpdates.length) {
        await mapWithConcurrency(listingUpdates, 10, (rec) => listingsStore.setJSON(rec.listingId, rec));
      }
      if (resortListChanged) {
        await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      }
      if (activitiesChanged) {
        await saveActivities(activitiesStore, activities);
      }

      return json({
        ok: true,
        dryRun: false,
        processedCoordinates: groupKeys.length,
        remainingCoordinates,
        taggedRecords,
        fallbackTagged,
        addedTowns,
        addedSuburbs,
        geocodeFailures,
        googleFailureReason: firstFailureReason,
        googleFailureMessage: firstFailureMessage,
        exampleFailedCoordinates: exampleFailures,
      });
    }

    if (action === "recheckZones") {
      // A deliberate one-time correction pass, distinct from
      // geocodeLocations above: that action only ever fills in records
      // that have NO locationLabel yet, and never touches anything
      // already tagged — which is exactly why the Garden-Route-towns-in-
      // "Western Cape" bug (fixed above, in the districtToZone/
      // provinceToZone priority) couldn't self-correct on its own. This
      // action re-sends EVERY property/resort-list row/activity that has
      // usable coordinates through Google again — tagged or not — and
      // OVERWRITES zone/townId/suburbId/locationLabel wherever the
      // corrected logic disagrees with what's currently stored, including
      // an existing Town's own zone field (via ensureTownAndSuburb's
      // `force` flag). Built and run once at Jean's explicit request
      // (2026-09-18), after she chose "full Google re-geocode" over a
      // free name-only recheck, and "apply automatically" over a
      // report-first review — see the towns-layer-implementation project
      // doc for that decision. Costs real Google API calls (same billing
      // as geocodeLocations) for every coordinate, not just new ones.
      //
      // IMPORTANT CAVEAT (surfaced to the admin UI too): there's no
      // "admin manually corrected this" flag anywhere in this codebase —
      // a Town's zone an admin hand-picked via the Towns tab Edit form
      // looks identical, in storage, to one auto-derived by geocoding. So
      // this action can silently revert a deliberate manual correction if
      // Google/the keyword list disagrees with it. That's an accepted
      // tradeoff for a one-off cleanup run, not something to schedule or
      // run routinely.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) {
        return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);
      }
      const actionStartedAt = Date.now();

      const { blobs: listingBlobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(listingBlobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const activities = await loadActivities(activitiesStore);

      // Unlike geocodeLocations' usable(), this has NO locationLabel
      // check — every record with a real coordinate is a target, whether
      // it's untagged, precisely tagged, or fallback-tagged already.
      function usableAny(r) {
        const lat = parseFloat(r.latitude);
        const lng = parseFloat(r.longitude);
        return isFinite(lat) && isFinite(lng);
      }

      const targets = [];
      listings.forEach((r) => {
        if (r && r.status === "Listed" && usableAny(r)) {
          targets.push({ source: "listing", key: r.listingId, name: r.propertyName || r.listingId, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
        }
      });
      resortList.forEach((r, i) => {
        if (usableAny(r)) targets.push({ source: "resort", key: i, name: r.name || ("resort row " + i), lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
      });
      activities.forEach((r) => {
        if (r && usableAny(r)) targets.push({ source: "activity", key: r.id, name: r.name || r.id, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
      });

      const groups = new Map();
      targets.forEach((t) => {
        const k = t.lat.toFixed(4) + "," + t.lng.toFixed(4);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      });

      if (body.dryRun) {
        return json({ ok: true, dryRun: true, totalRecords: targets.length, uniqueCoordinates: groups.size });
      }

      // Unlike geocodeLocations (where a processed coordinate gets tagged and
      // so drops out of the next call's target list), a re-check leaves every
      // coordinate in the target list forever — so the only way to make
      // progress is an explicit cursor. Before this, every call re-checked
      // the SAME first `limit` coordinates and reported remainingCoordinates
      // as (total - limit), a constant, so the admin loop could never
      // finish and just re-spent Google lookups on the same dozen places.
      // Keys are sorted so the order is identical from one call to the next.
      const limit = Math.max(1, Math.min(parseInt(body.limit, 10) || 12, 20));
      const offset = Math.max(0, parseInt(body.offset, 10) || 0);
      const totalCoordinates = groups.size;
      const groupKeys = Array.from(groups.keys()).sort().slice(offset, offset + limit);

      // Time budget. A Netlify Edge Function is killed (with a non-JSON
      // error page) if it runs too long, and when Google is slow every
      // lookup can sit for its full 8-second timeout — 12 of those, 8 at a
      // time, is enough to blow the limit and make the SAME batch fail on
      // every retry. So stop STARTING new lookups once this budget is spent,
      // and report only what was really processed; the admin page's cursor
      // then picks up exactly where this call stopped. Lookups start in
      // list order, so the ones skipped are always the tail of the batch.
      const LOOKUP_START_BUDGET_MS = 11000;
      const lookupsBeganAt = Date.now();
      const loadMs = lookupsBeganAt - actionStartedAt;
      let skippedForTime = 0;

      const allTowns = await loadTowns(townsStore);
      const existingIds = new Set(allTowns.map((t) => t.id));

      let addedTowns = 0, addedSuburbs = 0, checkedRecords = 0, changedRecords = 0, geocodeFailures = 0, fallbackTagged = 0, townZonesCorrected = 0;
      let resortListChanged = false;
      let activitiesChanged = false;
      const listingUpdates = [];
      let firstFailureReason = "";
      let firstFailureMessage = "";
      const exampleFailures = [];
      // Up to 10 examples of an actual change (record name, its zone
      // before and after), so the admin UI can show Jean concretely what
      // this run corrected rather than just a bare count.
      const exampleChanges = [];
      const correctedTownNames = new Set();

      await mapWithConcurrency(groupKeys, 8, async (key) => {
        if (Date.now() - lookupsBeganAt > LOOKUP_START_BUDGET_MS) {
          skippedForTime++;
          return;
        }
        const parts = key.split(",");
        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);
        const { result, viaFallback, failureReason, failureMessage } =
          await resolveLocationForCoordinate(lat, lng, apiKey, allTowns, existingIds, true, geoCacheStore);

        if (result) {
          if (result.createdTown) addedTowns++;
          if (result.createdSuburb) addedSuburbs++;
          if (result.zoneChangedFrom !== null && !correctedTownNames.has(result.townName)) {
            correctedTownNames.add(result.townName);
            townZonesCorrected++;
            if (exampleChanges.length < 10) {
              exampleChanges.push({ what: "Town: " + result.townName, from: result.zoneChangedFrom, to: result.zone });
            }
          }
        } else {
          geocodeFailures++;
          if (!firstFailureReason && failureReason) {
            firstFailureReason = failureReason;
            firstFailureMessage = failureMessage;
          }
          if (exampleFailures.length < 5) exampleFailures.push(lat.toFixed(4) + "," + lng.toFixed(4));
          return;
        }

        (groups.get(key) || []).forEach((t) => {
          checkedRecords++;
          if (viaFallback) fallbackTagged++;
          let rec = null;
          if (t.source === "listing") rec = listings.find((r) => r.listingId === t.key);
          else if (t.source === "resort") rec = resortList[t.key];
          else if (t.source === "activity") rec = activities.find((r) => r.id === t.key);
          if (!rec) return;

          const beforeZone = normalizeZone(rec.zone);
          if (beforeZone !== result.zone) {
            changedRecords++;
            if (exampleChanges.length < 10) {
              exampleChanges.push({ what: t.name, from: beforeZone || "(none)", to: result.zone });
            }
          }
          // Only queue a write when a stored field really differs. Before,
          // every checked record was re-saved — including the entire
          // 5,900-row resort list — on every single batch, even when
          // nothing had changed (which, on a second pass, is nearly all of
          // them), making each call far slower than it needed to be.
          const differs = rec.zone !== result.zone || rec.townId !== result.townId ||
            rec.suburbId !== result.suburbId || rec.locationLabel !== result.locationLabel ||
            (rec.country || "") !== (result.country || "") || !!rec.nearby !== !!result.nearby ||
            rec.locV !== LOCATION_TAG_VERSION;
          applyLocationTag(rec, result);
          if (!differs) return;
          if (t.source === "listing") listingUpdates.push(rec);
          else if (t.source === "resort") resortListChanged = true;
          else if (t.source === "activity") activitiesChanged = true;
        });
      });

      const lookupMs = Date.now() - lookupsBeganAt;
      const processedCount = groupKeys.length - skippedForTime;
      const nextOffset = offset + processedCount;
      const remainingCoordinates = Math.max(0, totalCoordinates - nextOffset);

      await saveTowns(townsStore, allTowns);
      if (listingUpdates.length) {
        await mapWithConcurrency(listingUpdates, 10, (rec) => listingsStore.setJSON(rec.listingId, rec));
      }
      if (resortListChanged) {
        await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      }
      if (activitiesChanged) {
        await saveActivities(activitiesStore, activities);
      }

      return json({
        ok: true,
        dryRun: false,
        processedCoordinates: processedCount,
        skippedForTime,
        timings: { loadMs, lookupMs, totalMs: Date.now() - actionStartedAt },
        remainingCoordinates,
        totalCoordinates,
        nextOffset,
        checkedRecords,
        changedRecords,
        townZonesCorrected,
        fallbackTagged,
        addedTowns,
        addedSuburbs,
        geocodeFailures,
        googleFailureReason: firstFailureReason,
        googleFailureMessage: firstFailureMessage,
        exampleFailedCoordinates: exampleFailures,
        exampleChanges,
      });
    }

    if (action === "fixTownZones") {
      // A gap "Re-check all zones" can't close on its own: that action only
      // ever visits a coordinate that belongs to a CURRENT property, resort
      // row, or activity — it finds/creates a Town by matching the name
      // Google returns for that coordinate. A Town created by "Discover &
      // add new locations" (built from text district/city/province columns,
      // not coordinates) can end up with a blank zone if that text didn't
      // clearly match a zone, and if no property/resort/activity with real
      // coordinates currently points at that same town by name, nothing
      // ever revisits it — "Re-check all zones" can run a hundred times and
      // it stays blank. Confirmed against the live "No zone set" count on
      // Jean's Master map (2026-09-28): those towns DO have coordinates
      // (the legend only counts ones that do) but no zone.
      //
      // This action instead works from the TOWN records themselves: for
      // every town that has coordinates of its own but no zone yet, it
      // resolves a zone straight from those coordinates, using the exact
      // same resolveLocationForCoordinate() step (zone-shape lookup first,
      // Google reverse-geocode only as a fallback) every other geocoding
      // action in this file uses, with force:true so it's allowed to set
      // the town's own zone. When Google's town name for that point matches
      // this town's own name (the normal case — it's the same place), it
      // self-heals. When Google returns a different name for that exact
      // point (a data/spelling mismatch between this town's name and what's
      // really there), a different town record gets matched or created
      // instead, and this one is left unresolved — "Merge duplicate towns"
      // below is the tool for cleaning up anything that creates.
      //
      // Same "never overwrite what's already set" rule as everywhere else:
      // only a town with a genuinely BLANK zone is ever touched. Only South
      // African towns have a zone to derive (places outside SA are coloured
      // by country on the map instead, not by zone). See the
      // towns-layer-implementation project doc, 2026-09-28 entry, for the
      // full diagnosis this was built for.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) {
        return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);
      }
      const actionStartedAt = Date.now();

      const allTowns = await loadTowns(townsStore);
      const existingIds = new Set(allTowns.map((t) => t.id));

      function needsZoneFix(t) {
        if (t.zone) return false;
        const lat = parseFloat(t.latitude);
        const lng = parseFloat(t.longitude);
        if (!isFinite(lat) || !isFinite(lng)) return false;
        return townCountry(t) === SA_NAME;
      }
      const targets = allTowns.filter(needsZoneFix).sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
      const totalTowns = targets.length;

      if (body.dryRun) {
        return json({ ok: true, dryRun: true, totalTowns });
      }

      const limit = Math.max(1, Math.min(parseInt(body.limit, 10) || 15, 25));
      const offset = Math.max(0, parseInt(body.offset, 10) || 0);
      const page = targets.slice(offset, offset + limit);

      // Same time-budget pattern as recheckZones above — stop starting new
      // lookups once this is spent, so a slow batch reports what it really
      // finished instead of risking the whole function getting killed.
      const LOOKUP_START_BUDGET_MS = 11000;
      const lookupsBeganAt = Date.now();
      let skippedForTime = 0, fixed = 0, stillUnresolved = 0;
      const exampleFixes = [];
      const exampleUnresolved = [];
      const geoCacheStore = getStore({ name: "map-geocache", consistency: "strong" });

      await mapWithConcurrency(page, 8, async (t) => {
        if (Date.now() - lookupsBeganAt > LOOKUP_START_BUDGET_MS) {
          skippedForTime++;
          return;
        }
        const lat = parseFloat(t.latitude);
        const lng = parseFloat(t.longitude);
        await resolveLocationForCoordinate(lat, lng, apiKey, allTowns, existingIds, true, geoCacheStore);
        // resolveLocationForCoordinate mutates allTowns in place via
        // ensureTownAndSuburb — re-read this same town record to see
        // whether it matched itself and got its zone filled in.
        if (t.zone) {
          fixed++;
          if (exampleFixes.length < 10) exampleFixes.push({ town: t.name, to: t.zone });
        } else {
          stillUnresolved++;
          if (exampleUnresolved.length < 10) exampleUnresolved.push(t.name);
        }
      });

      await saveTowns(townsStore, allTowns);

      const processed = page.length - skippedForTime;
      const nextOffset = offset + processed;
      const remaining = Math.max(0, totalTowns - nextOffset);

      return json({
        ok: true,
        dryRun: false,
        totalTowns,
        processed,
        skippedForTime,
        timings: { totalMs: Date.now() - actionStartedAt },
        remaining,
        nextOffset,
        fixed,
        stillUnresolved,
        exampleFixes,
        exampleUnresolved,
      });
    }

    if (action === "fixPropertyCountry") {
      // Closes a gap "Re-check all zones" can't reach: resolveLocationForCoordinate()
      // only ever tags a property/resort row when it can either match a real
      // town name Google returns, or find an EXISTING town in this system
      // within NEAREST_TOWN_MAX_KM of the coordinate — and every town in
      // this system is South African. A resort with a real coordinate in
      // the Okavango Delta or NamibRand (hundreds of km from the nearest
      // South African town) fails both of those, so "Re-check all zones"
      // counts it as a geocode failure and leaves it completely untouched —
      // not even the country gets recorded, even though Google answers it
      // plainly. Confirmed against Jean's live "Properties with no zone"
      // table (2026-09-28): every one of these had a real Namibia/Botswana/
      // Zimbabwe coordinate already, just no zone or country.
      //
      // Deliberately narrower than resolveLocationForCoordinate: it never
      // tries to find or create a Town, it only reverse-geocodes the
      // record's own coordinate and writes country + a zone value (the
      // province Google returns, or the country itself if there's no
      // province) straight onto that ONE record — sidestepping the "no SA
      // town nearby" dead end entirely. Only ever touches a record that
      // currently has NO zone, and only when it has a real (non-placeholder)
      // coordinate to work from — a property sitting at 0,0 is a different
      // problem (see suggestPropertyCoordinates below, which handles that
      // case by suggestion instead of writing anything).
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) {
        return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);
      }
      const actionStartedAt = Date.now();

      const { blobs: listingBlobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(listingBlobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];

      function hasRealCoord(r) {
        const lat = parseFloat(r.latitude);
        const lng = parseFloat(r.longitude);
        if (!isFinite(lat) || !isFinite(lng)) return false;
        return !(lat === 0 && lng === 0); // 0,0 is the CSV/import placeholder, not a real point
      }

      const targets = [];
      listings.forEach((r) => {
        if (r && r.status === "Listed" && !r.zone && hasRealCoord(r)) {
          targets.push({ source: "listing", key: r.listingId, name: r.propertyName || r.listingId, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
        }
      });
      resortList.forEach((r, i) => {
        if (r && !r.zone && hasRealCoord(r)) {
          targets.push({ source: "resort", key: i, name: r.name || ("resort row " + i), lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) });
        }
      });
      targets.sort((a, b) => (a.source + "|" + a.key).localeCompare(b.source + "|" + b.key));

      const totalTargets = targets.length;
      if (body.dryRun) {
        return json({ ok: true, dryRun: true, totalTargets });
      }

      const limit = Math.max(1, Math.min(parseInt(body.limit, 10) || 15, 25));
      const offset = Math.max(0, parseInt(body.offset, 10) || 0);
      const page = targets.slice(offset, offset + limit);

      const LOOKUP_START_BUDGET_MS = 11000;
      const lookupsBeganAt = Date.now();
      let skippedForTime = 0, fixed = 0, fixedByName = 0, stillUnresolved = 0;
      const exampleFixes = [];
      const exampleUnresolved = [];
      let resortListChanged = false;
      const listingUpdates = [];

      await mapWithConcurrency(page, 8, async (t) => {
        if (Date.now() - lookupsBeganAt > LOOKUP_START_BUDGET_MS) {
          skippedForTime++;
          return;
        }
        const geo = await cachedReverseGeocode(geoCacheStore, t.lat, t.lng, apiKey);
        let rec = null;
        if (t.source === "listing") rec = listings.find((r) => r.listingId === t.key);
        else if (t.source === "resort") rec = resortList[t.key];
        if (!rec) return;

        if (geo && geo.ok && geo.country) {
          rec.country = geo.country;
          rec.zone = clean(geo.province || geo.country, 120);
          fixed++;
          if (exampleFixes.length < 10) exampleFixes.push({ name: t.name, country: rec.country, zone: rec.zone });
          if (t.source === "listing") listingUpdates.push(rec);
          else resortListChanged = true;
          return;
        }

        // Coordinate reverse-geocode drew a blank — common for a remote
        // bush/safari camp with no mapped road nearby (confirmed 2026-10-02:
        // every property still unresolved here is deep in the Okavango
        // Delta / NamibRand / Mana Pools area). A country bounding-box
        // fallback was considered and rejected: every one of these
        // coordinates sits inside the overlap of two neighbouring
        // countries' boxes (e.g. Namibia/Botswana near the Caprivi Strip),
        // so a box alone would be a coin-flip, not a fix — worse than
        // leaving it blank. Instead, fall back to looking the property up
        // by NAME (the same Google Places lookup "Improve property
        // coordinates" already uses), cross-checked against this record's
        // own real coordinate via checkNameAgainstCoordinate — only ever
        // trusted when Google's name match lands within 15km of the pin
        // we already have, so a same-named place elsewhere can't slip in.
        const nameCheck = await checkNameAgainstCoordinate(t.name, t.lat, t.lng, apiKey);
        if (nameCheck.confidence === "high" && nameCheck.country) {
          rec.country = nameCheck.country;
          rec.zone = clean(nameCheck.country, 120);
          fixed++;
          fixedByName++;
          if (exampleFixes.length < 10) exampleFixes.push({ name: t.name, country: rec.country, zone: rec.zone, byName: true });
          if (t.source === "listing") listingUpdates.push(rec);
          else resortListChanged = true;
        } else {
          stillUnresolved++;
          if (exampleUnresolved.length < 10) exampleUnresolved.push(t.name);
        }
      });

      if (listingUpdates.length) {
        await mapWithConcurrency(listingUpdates, 10, (rec) => listingsStore.setJSON(rec.listingId, rec));
      }
      if (resortListChanged) {
        await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      }

      const processed = page.length - skippedForTime;
      const nextOffset = offset + processed;
      const remaining = Math.max(0, totalTargets - nextOffset);

      return json({
        ok: true,
        dryRun: false,
        totalTargets,
        processed,
        skippedForTime,
        timings: { totalMs: Date.now() - actionStartedAt },
        remaining,
        nextOffset,
        fixed,
        fixedByName,
        stillUnresolved,
        exampleFixes,
        exampleUnresolved,
      });
    }

    if (action === "suggestPropertyCoordinates") {
      // For a property/resort row with no usable coordinate at all (still
      // sitting at the CSV's blank/0,0 default), there's nothing to
      // reverse-geocode — fixPropertyCountry above needs a real coordinate
      // to work from. This goes the other way: it takes the property's own
      // Area/District text (the same text in your StockNetwork export) and
      // looks THAT up with Google, returning a suggested country and
      // coordinate.
      //
      // This is a suggestion only — nothing it finds is ever written back
      // to any stored record. Per Jean's rule (2026-09-28): a suggested
      // coordinate always goes back to a person to check and enter into
      // StockNetwork directly, never straight into this system, because a
      // short place name can be ambiguous (more than one "Amed" or
      // "Claremont" exists in the world) and a silent wrong write into live
      // data is worse than a blank someone has to fill in by hand.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) {
        return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);
      }
      const actionStartedAt = Date.now();

      const { blobs: listingBlobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(listingBlobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];

      function isPlaceholderOrMissing(r) {
        const lat = parseFloat(r.latitude);
        const lng = parseFloat(r.longitude);
        if (!isFinite(lat) || !isFinite(lng)) return true;
        return lat === 0 && lng === 0;
      }

      const targets = [];
      listings.forEach((r) => {
        if (r && r.status === "Listed" && !r.zone && isPlaceholderOrMissing(r)) {
          const area = r.area || r.district || "";
          if (area) targets.push({ source: "listing", key: r.listingId, name: r.propertyName || r.listingId, area, searchText: area });
        }
      });
      resortList.forEach((r, i) => {
        if (r && !r.zone && isPlaceholderOrMissing(r)) {
          const area = r.suburb || r.district || "";
          if (area) targets.push({ source: "resort", key: i, name: r.name || ("resort row " + i), area, searchText: area });
        }
      });
      targets.sort((a, b) => (a.source + "|" + a.key).localeCompare(b.source + "|" + b.key));

      const totalTargets = targets.length;
      if (body.dryRun) {
        return json({ ok: true, dryRun: true, totalTargets });
      }

      const limit = Math.max(1, Math.min(parseInt(body.limit, 10) || 15, 25));
      const offset = Math.max(0, parseInt(body.offset, 10) || 0);
      const page = targets.slice(offset, offset + limit);

      const LOOKUP_START_BUDGET_MS = 11000;
      const lookupsBeganAt = Date.now();
      let skippedForTime = 0;
      const suggestions = [];
      let notFound = 0;

      await mapWithConcurrency(page, 8, async (t) => {
        if (Date.now() - lookupsBeganAt > LOOKUP_START_BUDGET_MS) {
          skippedForTime++;
          return;
        }
        const geo = await cachedForwardGeocode(geoCacheStore, t.searchText, apiKey);
        if (geo && geo.ok && geo.country && typeof geo.lat === "number" && typeof geo.lng === "number") {
          suggestions.push({
            source: t.source,
            name: t.name,
            area: t.area,
            suggestedCountry: geo.country,
            suggestedProvince: geo.province || "",
            suggestedLat: geo.lat,
            suggestedLng: geo.lng,
            approximate: geo.locationType !== "ROOFTOP" && geo.locationType !== "GEOMETRIC_CENTER",
          });
        } else {
          notFound++;
        }
      });

      const processed = page.length - skippedForTime;
      const nextOffset = offset + processed;
      const remaining = Math.max(0, totalTargets - nextOffset);

      return json({
        ok: true,
        dryRun: false,
        totalTargets,
        processed,
        skippedForTime,
        timings: { totalMs: Date.now() - actionStartedAt },
        remaining,
        nextOffset,
        notFound,
        suggestions,
      });
    }

    if (action === "stocknetworkReview") {
      // Backs the "StockNetwork location review" card. Compares each
      // resort-list property's raw StockNetwork fields — landed by the
      // nightly API sync (resorts-api.js's handleApiSync) or a StockNetwork
      // CSV upload — against the hub's own Zone > Town > Suburb tree, and
      // flags where they disagree or StockNetwork's side is blank. The hub
      // is the master (per Jean's explicit 2026-09-29 instruction): this
      // never writes anything, it only lists what to look at. A property
      // with no StockNetwork field landed yet (never synced/uploaded) has
      // nothing to compare and is skipped, not flagged.
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const allTowns = await loadTowns(townsStore);
      const townById = new Map(allTowns.map((t) => [t.id, t]));

      function norm(v) {
        return String(v || "").trim().toLowerCase();
      }
      // Deliberately loose — a whole-string containment match, not exact —
      // since "Garden Route" (hub zone) vs "Garden Route Area" (SN's own
      // text) or "Cape Town" vs "Cape Town Central" are the same place
      // written slightly differently on each side, and this tool's job is
      // to surface genuine disagreements for a person to judge, not to
      // silently auto-match variants. False positives just mean an extra
      // row to glance at and dismiss; a missed real mismatch is the worse
      // failure this tool exists to avoid.
      function likelyMatch(a, b) {
        const x = norm(a), y = norm(b);
        if (!x || !y) return false;
        return x === y || x.indexOf(y) > -1 || y.indexOf(x) > -1;
      }

      const flags = [];
      resortList.forEach((r, i) => {
        if (!r || !r.resortId) return;
        const hasSnData = r.snCountry || r.area || r.city || r.suburb;
        // A coordinate flagged by Case B (resorts-api.js's nightly sync,
        // full-hub-coordinate-geocoding-scope 2026-09-29) is always worth
        // showing even when there's no other StockNetwork text to compare —
        // it's not a text disagreement, it's "this pin may not actually be
        // this property".
        if (!hasSnData && !r.coordSuspicious) return;

        const town = r.townId ? townById.get(r.townId) : null;
        const suburb = town && r.suburbId && Array.isArray(town.suburbs) ? town.suburbs.find((s) => s.id === r.suburbId) : null;
        const hubCountry = r.country || "";
        const hubZone = (town ? townZone(town) : "") || r.zone || "";
        const hubTownName = town ? town.name : (r.locationLabel || "");
        const hubSuburbName = suburb ? suburb.name : "";

        const reasons = [];
        if (hasSnData) {
          if (!r.snCountry) reasons.push("country-blank");
          else if (!likelyMatch(r.snCountry, hubCountry)) reasons.push("country");
          if (!r.area) reasons.push("zone-blank");
          else if (!likelyMatch(r.area, hubZone)) reasons.push("zone");
          if (!r.city) reasons.push("town-blank");
          else if (!likelyMatch(r.city, hubTownName)) reasons.push("town");
          if (r.suburb && hubSuburbName && !likelyMatch(r.suburb, hubSuburbName)) reasons.push("suburb");
        }
        // Case B: the property's own name doesn't look like it matches the
        // coordinate StockNetwork just sent — see resorts-api.js's
        // handleApiSync / lib/geolocate.js's checkNameAgainstCoordinate.
        if (r.coordSuspicious) reasons.push("coordinate");

        if (!reasons.length) return;
        flags.push({
          index: i,
          resortId: r.resortId,
          siteId: r.siteId || "",
          name: r.name || "",
          snCountry: r.snCountry || "", hubCountry,
          snArea: r.area || "", hubZone,
          snCity: r.city || "", hubTown: hubTownName,
          snSuburb: r.suburb || "", hubSuburb: hubSuburbName,
          hubTownId: r.townId || "", hubSuburbId: r.suburbId || "",
          // Read-only display fields Jean asked for (2026-09-29) — StockNetwork's
          // own District/City2/State never feed the hub's tree (that's still
          // purely coordinate-geocoding driven), they're shown here purely so
          // she can see everything StockNetwork sent for this property while
          // reviewing a flag.
          snDistrict: r.district || "", snCity2: r.city2 || "", snState: r.state || "",
          latitude: r.latitude || "", longitude: r.longitude || "",
          coordSuspicious: !!r.coordSuspicious,
          coordSuspiciousNote: r.coordSuspiciousNote || "",
          coordSuggested: r.coordSuggested || null,
          reasons,
        });
      });

      flags.sort((a, b) => a.name.localeCompare(b.name));
      const limit = Math.max(1, Math.min(parseInt(body.limit, 10) || 100, 500));
      const offset = Math.max(0, parseInt(body.offset, 10) || 0);
      return json({
        ok: true,
        totalProperties: resortList.length,
        totalFlagged: flags.length,
        offset,
        limit,
        remaining: Math.max(0, flags.length - (offset + limit)),
        flags: flags.slice(offset, offset + limit),
      });
    }

    if (action === "resolveStocknetworkLocation") {
      // The only action that writes a hub correction prompted by the
      // StockNetwork review above — per the standing project rule, nothing
      // from StockNetwork is ever applied automatically. A person reviews a
      // flag and either accepts the suggested country, or picks the correct
      // Town/Suburb/Zone from the tree (same encoding readLocationSelect/
      // applyLocationSelect use in admin.html), and only this action, on
      // that explicit save, writes it onto the resort-list row.
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];

      // Two ways to point at the row to fix: the "StockNetwork location
      // review" card (sn-review rows) already knows its raw array index.
      // The map popup's new "Edit location" action (2026-10-03) doesn't —
      // a pin only carries the pin's own resortId — and a raw index would
      // be unsafe there anyway since it can shift between the map's last
      // fetch and this save. resortId (StockNetwork's own ResortID) is
      // stable across both, so it's looked up fresh here instead.
      let index = parseInt(body.index, 10);
      if (!isFinite(index) || index < 0) {
        const resortId = typeof body.resortId === "string" ? body.resortId.trim() : "";
        if (!resortId) return json({ error: "Missing index or resortId." }, 400);
        index = resortList.findIndex((r) => r && String(r.resortId || "") === resortId);
        if (index < 0) return json({ error: "Property not found — the list may have changed, refresh and try again." }, 404);
      }

      const rec = resortList[index];
      if (!rec) return json({ error: "Property not found — the list may have changed, refresh and try again." }, 404);

      let changed = false;
      if (typeof body.country === "string" && body.country.trim()) {
        rec.country = clean(body.country, 120);
        changed = true;
      }
      if (body.clearLocation) {
        rec.zone = ""; rec.townId = ""; rec.suburbId = ""; rec.locationLabel = ""; rec.nearby = false;
        changed = true;
      } else if (body.townId || body.suburbId || body.zone) {
        rec.zone = body.zone ? okZone(body.zone) : "";
        rec.townId = typeof body.townId === "string" ? body.townId : "";
        rec.suburbId = typeof body.suburbId === "string" ? body.suburbId : "";
        // Picking a Town/Suburb from the tree used to leave the zone blank
        // and the country untouched (the picker only encodes a zone for a
        // zone-level pick). Now the chosen town's own zone and country are
        // copied across — unless a country was typed explicitly above, or
        // a zone was sent explicitly, which win (Jean 2026-10-04).
        if (rec.townId) {
          const pickedTowns = await loadTowns(townsStore);
          const picked = pickedTowns.find((t) => t.id === rec.townId);
          if (picked) {
            if (!body.zone) rec.zone = okZone(townZone(picked)) || rec.zone;
            if (!(typeof body.country === "string" && body.country.trim())) rec.country = townCountry(picked);
          }
        }
        rec.locationLabel = typeof body.locationLabel === "string" ? clean(body.locationLabel, 200) : "";
        rec.nearby = false;
        rec.locV = LOCATION_TAG_VERSION;
        changed = true;
      }
      if (!changed) return json({ error: "Nothing to save." }, 400);

      await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      return json({ ok: true, country: rec.country || "", zone: rec.zone || "", townId: rec.townId || "", suburbId: rec.suburbId || "", locationLabel: rec.locationLabel || "" });
    }

    if (action === "listMissingCoordinateProperties") {
      // Case C (full-hub-coordinate-geocoding-scope, 2026-09-29): backs the
      // "Find & fix missing coordinates" card — properties with NO usable
      // coordinate at all, so Case A/B (which only ever run once
      // StockNetwork has already sent a real coordinate) never get a
      // chance to place or check them. Paginated the same way
      // stocknetworkReview/exportLocations page through the resort list,
      // since that list alone runs to ~5,900 rows. Read-only.
      const source = body.source === "listing" ? "listing" : "resort";
      const offset = Math.max(0, parseInt(body.offset, 10) || 0);
      const limit = Math.max(1, Math.min(parseInt(body.limit, 10) || 100, 500));
      const noCoord = (r) => {
        const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
        return !(isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0));
      };

      if (source === "listing") {
        const { blobs } = await listingsStore.list();
        const listings = await mapWithConcurrency(blobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
        const missing = listings.filter((r) => r && noCoord(r));
        missing.sort((a, b) => (a.propertyName || "").localeCompare(b.propertyName || ""));
        return json({
          ok: true, source, total: missing.length, offset, limit,
          remaining: Math.max(0, missing.length - (offset + limit)),
          items: missing.slice(offset, offset + limit).map((r) => ({
            listingId: r.listingId,
            name: r.propertyName || "",
            area: r.area || r.district || "",
            city: r.city || "",
            country: r.country || "",
          })),
        });
      }

      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const missing = [];
      resortList.forEach((r, i) => {
        // flaggedInactive (2026-10-01): once a property's been flagged as
        // possibly no longer existing, via "flagPropertyInactive" below,
        // it drops out of this list so it's not re-checked every run —
        // it instead shows in "listFlaggedInactiveProperties" for
        // forwarding to StockNetwork's team.
        if (r && noCoord(r) && !r.flaggedInactive) {
          missing.push({
            index: i,
            resortId: r.resortId || "",
            siteId: r.siteId || "",
            name: r.name || "",
            area: r.area || r.district || "",
            city: r.city || "",
            country: r.snCountry || "",
          });
        }
      });
      missing.sort((a, b) => a.name.localeCompare(b.name));
      return json({
        ok: true, source, total: missing.length, offset, limit,
        remaining: Math.max(0, missing.length - (offset + limit)),
        items: missing.slice(offset, offset + limit),
      });
    }

    if (action === "flagPropertyInactive") {
      // "Flag as possibly inactive" on Case C's "Find & fix missing
      // coordinates" card (2026-10-01, Jean's request) — StockNetwork
      // resort rows only, since a hub-only listing has no StockNetwork
      // team to action it (the admin page only ever sends source:"resort"
      // here). Doesn't touch the property's own coordinate or placement —
      // just marks it so "listMissingCoordinateProperties" above stops
      // showing it, and "listFlaggedInactiveProperties" below picks it up
      // instead, ready to forward to StockNetwork as its own export, kept
      // deliberately separate from "Corrected StockNetwork file" so that
      // file's exact column format for StockNetwork's own importer is
      // never touched. Pass flag:false to undo a flag set by mistake.
      const index = parseInt(body.index, 10);
      if (!isFinite(index) || index < 0) return json({ error: "Missing or invalid index." }, 400);
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const rec = resortList[index];
      if (!rec) return json({ error: "Property not found — the list may have changed, refresh and try again." }, 404);
      const flag = body.flag !== false;
      if (flag) {
        rec.flaggedInactive = true;
        rec.flaggedInactiveNote = clean(body.note, 300);
        rec.flaggedInactiveAt = new Date().toISOString();
      } else {
        delete rec.flaggedInactive;
        delete rec.flaggedInactiveNote;
        delete rec.flaggedInactiveAt;
      }
      await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      return json({ ok: true, flagged: flag });
    }

    if (action === "listFlaggedInactiveProperties") {
      // Backs the "Flagged as possibly inactive" list next to "Find & fix
      // missing coordinates" — StockNetwork resort rows only. Read-only.
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const flagged = [];
      resortList.forEach((r, i) => {
        if (r && r.flaggedInactive) {
          flagged.push({
            index: i,
            resortId: r.resortId || "",
            siteId: r.siteId || "",
            name: r.name || "",
            area: r.area || r.district || "",
            city: r.city || "",
            country: r.snCountry || "",
            note: r.flaggedInactiveNote || "",
            flaggedAt: r.flaggedInactiveAt || "",
          });
        }
      });
      flagged.sort((a, b) => a.name.localeCompare(b.name));
      return json({ ok: true, items: flagged });
    }

    if (action === "listPendingNewStockNetworkProperties") {
      // Backs the "New StockNetwork properties" card (new-properties-
      // flagging, 2026-10-03, Jean's request) — the list resorts-api.js's
      // handleApiSync saves of StockNetwork resort rows the nightly sync
      // couldn't match to anything already in the hub. Purely informational:
      // nothing here is in the hub's own resort list or on the map until
      // Jean reviews it and re-uploads via the existing "StockNetwork resort
      // list (upload CSV)" flow above — per hub-is-master-for-location, a
      // property is never auto-added.
      const pending = (await pendingNewStore.get("current", { type: "json" })) || {};
      const items = Array.isArray(pending.items) ? pending.items : [];
      return json({ ok: true, items, totalUnmatched: pending.totalUnmatched || 0, truncated: !!pending.truncated, updatedAt: pending.updatedAt || null });
    }

    if (action === "dismissPendingNewStockNetworkProperty") {
      // Drops one StockNetwork resortId out of the "New StockNetwork
      // properties" list for good (e.g. a property Avante doesn't carry) —
      // without this, since the list is a full replace every sync, an
      // unmatched row Jean never imports would otherwise resurface every
      // single day forever. Does not touch anything in the hub itself.
      const resortId = String(body.resortId || "").trim();
      if (!resortId) return json({ error: "Missing resortId." }, 400);
      const pending = (await pendingNewStore.get("current", { type: "json" })) || {};
      const items = Array.isArray(pending.items) ? pending.items : [];
      const dismissedIds = Array.isArray(pending.dismissedIds) ? pending.dismissedIds : [];
      if (!dismissedIds.includes(resortId)) dismissedIds.push(resortId);
      const keptItems = items.filter((it) => it.resortId !== resortId);
      await pendingNewStore.setJSON("current", Object.assign({}, pending, { items: keptItems, dismissedIds }));
      return json({ ok: true, remaining: keptItems.length });
    }

    if (action === "flagStockNetworkFieldFix") {
      // "Corrections to send to StockNetwork" (2026-10-02, Jean's request):
      // District, City2 and State are mirrored from StockNetwork's own API
      // every night (mapApiRowToRawFields in resorts-api.js) and NEVER
      // corrected by "Corrected StockNetwork file" below, unlike
      // Country/Area/City/Suburb, which that export already derives from
      // the hub's Zone/Town/Suburb tree for every property automatically.
      // So there's no way to push a fix for these three back into
      // StockNetwork except telling their team directly — Jean uses these
      // for availability search on her side (a town can have two valid
      // search names, e.g. Warmbaths/Bela-Bela; a province can span more
      // than one hub zone), so what's "correct" here needs a person's
      // judgement, never auto-derived from the hub's tree. This action
      // just records that judgement against the row, alongside (not
      // instead of) resolveStocknetworkLocation fixing the hub's own
      // placement — the admin page calls both when "Save" is clicked and
      // any of these three fields were filled in. Passing all empty clears
      // a flag set by mistake, same as flagPropertyInactive's flag:false.
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      // Same two ways to point at a row as resolveStocknetworkLocation:
      // sn-review rows pass their raw index, the map popup passes the
      // stable resortId (2026-10-04).
      let index = parseInt(body.index, 10);
      if (!isFinite(index) || index < 0) {
        const resortId = typeof body.resortId === "string" ? body.resortId.trim() : "";
        if (!resortId) return json({ error: "Missing index or resortId." }, 400);
        index = resortList.findIndex((r) => r && String(r.resortId || "") === resortId);
        if (index < 0) return json({ error: "Property not found — the list may have changed, refresh and try again." }, 404);
      }
      const rec = resortList[index];
      if (!rec) return json({ error: "Property not found — the list may have changed, refresh and try again." }, 404);

      const district = clean(body.district, 120);
      const city2 = clean(body.city2, 120);
      const state = clean(body.state, 120);
      const note = clean(body.note, 300);

      if (!district && !city2 && !state && !note) {
        delete rec.snFixDistrict;
        delete rec.snFixCity2;
        delete rec.snFixState;
        delete rec.snFixNote;
        delete rec.snFixFlaggedAt;
        delete rec.snFixSentAt;
        await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
        return json({ ok: true, cleared: true });
      }

      rec.snFixDistrict = district;
      rec.snFixCity2 = city2;
      rec.snFixState = state;
      rec.snFixNote = note;
      rec.snFixFlaggedAt = new Date().toISOString();
      delete rec.snFixSentAt; // editing an already-sent flag un-sends it, so it shows again until re-downloaded

      await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      return json({ ok: true });
    }

    if (action === "listStockNetworkFieldFixes") {
      // Backs "Corrections to send to StockNetwork" next to the
      // StockNetwork location review table above. Only ever shows
      // not-yet-sent flags (see markStockNetworkFieldFixesSent) — this
      // list is meant to be worked through in small daily batches, per
      // Jean's own workflow, not accumulated indefinitely. Read-only.
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const items = [];
      resortList.forEach((r, i) => {
        if (r && !r.snFixSentAt && (r.snFixDistrict || r.snFixCity2 || r.snFixState || r.snFixNote)) {
          items.push({
            index: i,
            resortId: r.resortId || "",
            siteId: r.siteId || "",
            name: r.name || "",
            currentDistrict: r.district || "",
            currentCity2: r.city2 || "",
            currentState: r.state || "",
            district: r.snFixDistrict || "",
            city2: r.snFixCity2 || "",
            state: r.snFixState || "",
            note: r.snFixNote || "",
            flaggedAt: r.snFixFlaggedAt || "",
          });
        }
      });
      items.sort((a, b) => a.name.localeCompare(b.name));
      return json({ ok: true, items });
    }

    if (action === "markStockNetworkFieldFixesSent") {
      // Called right after the CSV in "Corrections to send to StockNetwork"
      // downloads, with the indices that were in that download — marks
      // them so they drop out of listStockNetworkFieldFixes above (today's
      // batch is "sent"; tomorrow's view starts fresh with whatever's
      // flagged between now and then). Editing a row again later clears
      // this (see flagStockNetworkFieldFix) so a correction that still
      // hasn't landed can be re-flagged and re-sent.
      const indices = Array.isArray(body.indices) ? body.indices : [];
      if (!indices.length) return json({ error: "No indices supplied." }, 400);
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const now = new Date().toISOString();
      let marked = 0;
      indices.forEach((raw) => {
        const i = parseInt(raw, 10);
        const rec = resortList[i];
        if (rec && (rec.snFixDistrict || rec.snFixCity2 || rec.snFixState || rec.snFixNote)) {
          rec.snFixSentAt = now;
          marked++;
        }
      });
      await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      return json({ ok: true, marked });
    }

    if (action === "lookupCoordinateInfo") {
      // Read-only (2026-10-04): works out the country and (for South Africa)
      // zone for a pasted coordinate, so the town edit popup can fill its
      // Country/Zone fields for a person to review before saving. Writes
      // nothing and never creates a town.
      const lat = parseFloat(body.lat), lng = parseFloat(body.lng);
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return json({ error: "Missing or invalid lat/lng." }, 400);
      }
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      const geoCacheStore = getStore({ name: "map-geocache", consistency: "strong" });
      const geo = apiKey ? await cachedReverseGeocode(geoCacheStore, lat, lng, apiKey) : null;
      const at = locateZone(lat, lng);
      const onLand = at.km <= 4;
      const country = geo && geo.ok && geo.country ? geo.country : (onLand ? SA_NAME : "");
      let zone = "";
      if (country === SA_NAME) zone = onLand ? (at.zone || "") : (districtToZone(geo && geo.ok ? geo.town : "") || provinceToZone(geo && geo.ok ? geo.province : "") || "");
      return json({ ok: true, country, zone, townName: geo && geo.ok ? (geo.town || "") : "", usedGoogle: !!(geo && geo.ok) });
    }

    if (action === "searchPropertyPlaces") {
      // Case C step 2: given a name (+ whatever area/city/country text the
      // admin page appended to disambiguate), search worldwide via Google
      // Places and return candidates for a person to pick from — no
      // country/region restriction, per Jean's explicit 2026-09-29
      // decision. Read-only; writes nothing.
      const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY") || "";
      if (!apiKey) return json({ error: "GOOGLE_PLACES_API_KEY isn't set in this site's environment variables yet." }, 400);
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 300) : "";
      if (!query) return json({ error: "Missing query." }, 400);
      const r = await searchPlaceCandidates(query, apiKey, 8);
      if (!r.ok) return json({ error: r.message || ("Google: " + r.reason), reason: r.reason }, 502);
      return json({ ok: true, candidates: r.candidates });
    }

    if (action === "applyPropertyCoordinate") {
      // The shared write path for Case B's "Accept suggested coordinate"
      // (on a StockNetwork review flag) and Case C's "Use this" (picking a
      // worldwide name-search candidate for a property with no coordinate
      // at all) — sets the property's coordinate and immediately re-places
      // it in the hub's own Zone/Town/Suburb/Nearby tree via the same
      // resolveLocationForCoordinate/applyLocationTag engine the nightly
      // sync's Case A uses. force:true here (unlike Case A's cautious
      // force:false) because this only ever runs on an explicit human
      // click — "Accept"/"Use this" should always win over whatever, if
      // anything, was tagged before.
      const source = body.source === "listing" ? "listing" : "resort";
      const lat = parseFloat(body.lat), lng = parseFloat(body.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json({ error: "Missing or invalid lat/lng." }, 400);
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);

      const allTowns = await loadTowns(townsStore);
      const existingIds = new Set(allTowns.map((t) => t.id));
      const geoCacheStore = getStore({ name: "map-geocache", consistency: "strong" });
      const { result } = await resolveLocationForCoordinate(lat, lng, apiKey, allTowns, existingIds, true, geoCacheStore);

      if (source === "listing") {
        const listingId = typeof body.listingId === "string" ? body.listingId : "";
        if (!listingId) return json({ error: "Missing listingId." }, 400);
        const rec = await listingsStore.get(listingId, { type: "json" });
        if (!rec) return json({ error: "Property not found." }, 404);
        rec.latitude = String(lat);
        rec.longitude = String(lng);
        if (result) applyLocationTag(rec, result);
        await listingsStore.setJSON(listingId, rec);
        await saveTowns(townsStore, allTowns);
        return json({ ok: true, placed: !!result, locationLabel: rec.locationLabel || "" });
      }

      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      // index (review/Find&fix cards) or resortId (map popup, 2026-10-04).
      let index = parseInt(body.index, 10);
      if (!isFinite(index) || index < 0) {
        const resortId = typeof body.resortId === "string" ? body.resortId.trim() : "";
        if (!resortId) return json({ error: "Missing index or resortId." }, 400);
        index = resortList.findIndex((r) => r && String(r.resortId || "") === resortId);
        if (index < 0) return json({ error: "Property not found — the list may have changed, refresh and try again." }, 404);
      }
      const rec = resortList[index];
      if (!rec) return json({ error: "Property not found — the list may have changed, refresh and try again." }, 404);
      rec.latitude = String(lat);
      rec.longitude = String(lng);
      delete rec.coordSuspicious;
      delete rec.coordSuspiciousNote;
      delete rec.coordSuggested;
      if (result) applyLocationTag(rec, result);
      await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      await saveTowns(townsStore, allTowns);
      return json({ ok: true, placed: !!result, locationLabel: rec.locationLabel || "" });
    }

    if (action === "exportLocations") {
      // Backs the "Corrected StockNetwork file" tool. Given a batch of rows
      // from a StockNetwork resort export ({ i, name, resortId, siteId,
      // lat, lng, csvCountry }), returns what Country / Area / City /
      // Suburb each should be according to the HUB's own location tree, so
      // the file that goes back to StockNetwork matches the hub exactly.
      //
      //  * Area = the hub ZONE (e.g. "Garden Route", "Eastern Cape",
      //    "Erongo Region"), per Jean's rule (2026-09-29, corrected from an
      //    earlier "State = hub zone" assumption — State is StockNetwork's
      //    own separate province/region column and is never written here) —
      //    not the province.
      //  * City = the hub Town. Suburb = the hub Suburb; when the place has
      //    no suburb the town name is repeated; when it has no town of its
      //    own and was placed with the nearest town, "Nearby <Town>".
      //  * A row whose stored hub tag is current (locV 2, same coordinates)
      //    costs nothing. Anything else is resolved live through the same
      //    resolveLocationForCoordinate step Re-check all zones uses (cache
      //    first, so a coordinate is never paid for twice) — at most
      //    LIVE_PER_CALL per call, then `nextIndex` tells the caller where
      //    to resume. Read-only for the hub except for any brand-new towns
      //    a live lookup creates, and the resort row it tags.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      const startedAt = Date.now();
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, body.dryRun ? 8000 : 400) : [];
      const LIVE_PER_CALL = 12;
      const LIVE_BUDGET_MS = 11000;

      const allTowns = await loadTowns(townsStore);
      const existingIds = new Set(allTowns.map((t) => t.id));
      const townById = new Map(allTowns.map((t) => [t.id, t]));
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const rowKey = (name, siteId, resortId) => String(name || "").trim().toLowerCase() + "|" + String(siteId || "").trim() + "|" + String(resortId || "").trim();
      const byKey = new Map();
      resortList.forEach((r, i) => byKey.set(rowKey(r.name, r.siteId, r.resortId), i));

      const ALIASES = [["eswatini", "swaziland"], ["czechia", "czech republic"], ["türkiye", "turkey"],
        ["côte d’ivoire", "ivory coast"], ["myanmar (burma)", "myanmar"], ["north macedonia", "macedonia"]];
      const norm = (v) => String(v || "").trim().toLowerCase();
      // Keep StockNetwork's own spelling of a country when Google only names
      // it differently (Eswatini / Swaziland) so no new country values appear.
      function countryMatches(google, csv) {
        const g = norm(google), c = norm(csv);
        if (!g || !c || g === c) return true;
        return ALIASES.some(([a, b]) => (a === g && b === c) || (b === g && a === c));
      }
      function pickCountry(google, csv) {
        if (!google) return csv || "";
        return countryMatches(google, csv) && csv ? csv : google;
      }
      // The StockNetwork row says one country and the coordinates say another:
      // one of them is wrong and the hub can't tell which, so the row is left
      // exactly as it is and listed in the report for a person to decide.
      function flagCountryClash(item, lat, lng, csvCountry, resolvedCountry) {
        item.status = "check";
        item.note = "StockNetwork says \"" + csvCountry + "\" but the coordinates are in \"" + resolvedCountry + "\" — left unchanged. Check the country or the coordinates.";
        addFlipNote(item, lat, lng, csvCountry);
      }

      // foldAH (SN cleanup wizard only, 2026-10-06, Jean's choice): when the
      // hub town is an agricultural holding ("Renosterkop AH"), StockNetwork's
      // City gets the nearest non-AH hub town within 40 km instead and the AH
      // name moves to Suburb — City is what guests search on. The hub's own
      // tree is untouched, and without the flag this behaves as before.
      const AH_NAME = /\b(AH|A\.H\.|agricultural holdings?)$/i;
      const FOLD_AH_MAX_KM = 40;
      function fieldsFromTown(town, suburbName, nearby, country, lat, lng) {
        const cityName = town.name || "";
        const f = {
          country,
          area: townZone(town),
          city: cityName,
          suburb: suburbName || (nearby ? "Nearby " + cityName : cityName),
        };
        if (body.foldAH && AH_NAME.test(cityName.trim()) && isFinite(lat) && isFinite(lng)) {
          let best = null, bestKm = Infinity;
          for (const t of allTowns) {
            if (t === town || AH_NAME.test(String(t.name || "").trim()) || townCountry(t) !== townCountry(town)) continue;
            const d = townDistanceKm(t, lat, lng);
            if (d < bestKm) { bestKm = d; best = t; }
          }
          if (best && bestKm <= FOLD_AH_MAX_KM) {
            f.city = best.name || "";
            f.suburb = cityName;
            f.foldNote = cityName + " is an agricultural holding — City is the nearest town, " + f.city + " (" + Math.round(bestKm) + " km).";
          }
        }
        return f;
      }
      function addFoldNote(item) {
        if (!item.foldNote) return;
        item.note = item.note ? item.note + " " + item.foldNote : item.foldNote;
        delete item.foldNote;
      }

      function seaNote(km) {
        return km <= 100
          ? "These coordinates are in the sea, about " + km + " km off the coast."
          : "These coordinates aren't on any land Google recognises (in the sea, or well away from any town).";
      }

      // A likely fix for coordinates that landed nowhere: latitude/longitude
      // with a flipped sign or swapped. Only ever suggested in the report,
      // never applied.
      function suggestFlip(lat, lng) {
        const tries = [[-lat, lng], [lat, -lng], [-lat, -lng], [lng, lat], [-lng, lat], [lng, -lat], [-lng, -lat]];
        for (const [a, b] of tries) {
          const at = locateZone(a, b);
          if (at.km <= 2) return { lat: a, lng: b, zone: at.zone };
        }
        return null;
      }

      function addFlipNote(item, lat, lng, csvCountry) {
        const flip = suggestFlip(lat, lng);
        if (flip && /^south africa$/i.test(csvCountry || "South Africa")) {
          item.suggestion = { lat: flip.lat, lng: flip.lng, zone: flip.zone };
          item.note += " Looks like the latitude/longitude may be swapped or have a flipped sign — as " + flip.lat + ", " + flip.lng + " it would be in " + flip.zone + ".";
        }
      }

      // dryRun: no lookups, nothing written — just how many rows already have a
      // current tag in the hub and how many would need a fresh look-up.
      if (body.dryRun) {
        let fromHub = 0, needLookup = 0, unusable = 0;
        rows.forEach((r) => {
          const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
          if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { unusable++; return; }
          const ri = byKey.get(rowKey(r.name, r.siteId, r.resortId));
          const rec = ri === undefined ? null : resortList[ri];
          const same = rec && Math.abs(parseFloat(rec.latitude) - lat) < 0.00002 && Math.abs(parseFloat(rec.longitude) - lng) < 0.00002;
          if (same && rec.locV === LOCATION_TAG_VERSION && townById.get(rec.townId)) fromHub++; else needLookup++;
        });
        return json({ ok: true, dryRun: true, total: rows.length, fromHub, needLookup, unusable });
      }

      const out = [];
      let liveUsed = 0;
      let resortChanged = false;
      let townsChanged = false;
      let idx = 0;
      for (; idx < rows.length; idx++) {
        const r = rows[idx];
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lng);
        const item = { i: r.i, status: "", note: "" };
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          item.status = "skip";
          item.note = "No usable coordinates (blank, 0,0 or out of range) — location can't be worked out from the hub.";
          out.push(item);
          continue;
        }
        const csvCountry = r.csvCountry || "";
        const ri = byKey.get(rowKey(r.name, r.siteId, r.resortId));
        const rec = ri === undefined ? null : resortList[ri];
        const same = rec && Math.abs(parseFloat(rec.latitude) - lat) < 0.00002 && Math.abs(parseFloat(rec.longitude) - lng) < 0.00002;
        const stored = same && rec.locV === LOCATION_TAG_VERSION && townById.get(rec.townId);

        if (stored) {
          const town = stored;
          const sub = rec.suburbId && (Array.isArray(town.suburbs) ? town.suburbs.find((s) => s.id === rec.suburbId) : null);
          const resolvedCountry = rec.country || townCountry(town);
          if (!countryMatches(resolvedCountry, csvCountry)) {
            flagCountryClash(item, lat, lng, csvCountry, resolvedCountry);
            out.push(item);
            continue;
          }
          const country = pickCountry(resolvedCountry, csvCountry);
          Object.assign(item, fieldsFromTown(town, sub ? sub.name : "", !!rec.nearby, country, lat, lng));
          item.status = rec.nearby ? "nearby" : "ok";
          item.source = "hub";
          if (rec.nearby) item.note = "No town of its own here — placed with the nearest town.";
          if (rec.offshoreKm > 0) {
            item.status = "sea";
            item.note = seaNote(rec.offshoreKm) + (rec.nearby ? " Placed with the nearest town." : "");
            addFlipNote(item, lat, lng, csvCountry);
          }
          out.push(item);
          continue;
        }

        // Needs a live lookup. Stop here (and report where) if this call has
        // used its share, so the caller resumes at exactly this row.
        if (liveUsed >= LIVE_PER_CALL || Date.now() - startedAt > LIVE_BUDGET_MS) break;
        if (!apiKey) {
          item.status = "fail";
          item.note = "GOOGLE_GEOCODING_API_KEY isn't set, so this row can't be looked up.";
          out.push(item);
          continue;
        }
        liveUsed++;
        const { result, failureReason, failureMessage, offshoreKm } =
          await resolveLocationForCoordinate(Number(lat.toFixed(4)), Number(lng.toFixed(4)), apiKey, allTowns, existingIds, false, geoCacheStore);
        if (result) {
          townsChanged = true;
          const town = allTowns.find((t) => t.id === result.townId);
          allTowns.forEach((t) => { if (!townById.has(t.id)) townById.set(t.id, t); });
          if (!countryMatches(result.country, csvCountry)) {
            flagCountryClash(item, lat, lng, csvCountry, result.country);
            out.push(item);
            continue;
          }
          const country = pickCountry(result.country, csvCountry);
          Object.assign(item, fieldsFromTown(town, result.suburbName, !!result.nearby, country, lat, lng));
          item.source = "live";
          item.status = result.nearby ? "nearby" : "ok";
          if (result.nearby) item.note = "No town of its own here — placed with the nearest town (" + result.nearbyKm + " km away).";
          if (offshoreKm > 0) {
            item.status = "sea";
            item.note = seaNote(offshoreKm) + (result.nearby ? " Placed with the nearest town." : "");
          }
          // snCoordPending (SN cleanup wizard, 2026-10-06): the hub's own
          // coordinate for this property was deliberately set ahead of
          // StockNetwork's, so an older export's coordinate must never be
          // written back over it here — only re-tag when it's the same point.
          if (rec && (!rec.snCoordPending || same)) {
            applyLocationTag(rec, result);
            rec.latitude = String(lat);
            rec.longitude = String(lng);
            resortChanged = true;
          }
        } else {
          item.status = "fail";
          item.note = "Couldn't place this coordinate" + (failureReason ? " (" + failureReason + ")" : "") + (failureMessage ? ": " + failureMessage : ".");
          if (offshoreKm > 0) item.note = seaNote(offshoreKm) + " No town is within " + NEAREST_TOWN_MAX_KM + " km.";
        }
        if (item.status === "sea" || item.status === "fail") addFlipNote(item, lat, lng, csvCountry);
        out.push(item);
      }

      if (townsChanged) await saveTowns(townsStore, allTowns);
      if (resortChanged) {
        await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      }
      out.forEach(addFoldNote);
      return json({ ok: true, results: out, nextIndex: idx, liveLookups: liveUsed, totalMs: Date.now() - startedAt });
    }

    if (action === "snCleanupApply") {
      // SN cleanup wizard, step 3 ("Place in hub"). For each { id,
      // resortId, lat, lng, pending } sets that coordinate on EVERY
      // resort-list row sharing the ResortID (one physical property can be
      // listed under several SiteIDs) and places it in the hub's tree via
      // the same resolveLocationForCoordinate/applyLocationTag engine
      // applyPropertyCoordinate uses (force:true — an explicit admin
      // choice). Rows whose coordinate and tag are already current are
      // settled for free. pending:true means StockNetwork doesn't have this
      // coordinate yet: the row gets snCoordPending, which makes the
      // nightly sync, a resort-list CSV re-upload and exportLocations keep
      // the hub's coordinate (without raising a review flag) until
      // StockNetwork sends the same point — then the marker clears itself.
      // Items not finished inside this call's budget come back done:false;
      // the caller re-sends them.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const LIVE_PER_CALL = 24;
      const LIVE_BUDGET_MS = 10000;
      const startedAt = Date.now();

      const allTowns = await loadTowns(townsStore);
      const existingIds = new Set(allTowns.map((t) => t.id));
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const byResortId = new Map();
      resortList.forEach((r, i) => {
        const k = r && String(r.resortId || "").trim();
        if (!k) return;
        if (!byResortId.has(k)) byResortId.set(k, []);
        byResortId.get(k).push(i);
      });
      const near = (a, b) => Math.abs(parseFloat(a) - b) < 0.00002;
      const tagCurrent = (r, lat, lng) =>
        near(r.latitude, lat) && near(r.longitude, lng) && r.locV === LOCATION_TAG_VERSION && r.townId && allTowns.some((t) => t.id === r.townId);

      const out = new Array(items.length);
      const live = [];
      let changed = false;
      const setAt = new Date().toISOString();

      function writeRows(idxs, lat, lng, pending, result, moved) {
        idxs.forEach((ri) => {
          const r = resortList[ri];
          const rowMoved = !(near(r.latitude, lat) && near(r.longitude, lng));
          r.latitude = String(lat);
          r.longitude = String(lng);
          if (result) applyLocationTag(r, result);
          else if (moved && rowMoved) {
            // Placement failed for a NEW point: the old tag belongs to the old
            // point, so drop it and let "Properties with no zone" pick it up.
            ["zone", "townId", "suburbId", "locationLabel", "country", "nearby", "offshoreKm", "locV"].forEach((f) => delete r[f]);
          }
          delete r.coordSuspicious;
          delete r.coordSuspiciousNote;
          delete r.coordSuggested;
          if (pending) r.snCoordPending = { lat, lng, setAt };
          else delete r.snCoordPending;
        });
        changed = true;
      }
      function placedInfo(ri) {
        const r = resortList[ri];
        return { locationLabel: r.locationLabel || "", country: r.country || "", zone: r.zone || "" };
      }

      items.forEach((it, n) => {
        const id = it && it.id;
        const resortId = String((it && it.resortId) || "").trim();
        const lat = parseFloat(it && it.lat), lng = parseFloat(it && it.lng);
        const pending = !!(it && it.pending);
        const idxs = resortId ? byResortId.get(resortId) : null;
        if (!idxs || !idxs.length) { out[n] = { id, done: true, status: "notInHub" }; return; }
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          out[n] = { id, done: true, status: "error", error: "Invalid coordinate" };
          return;
        }
        if (idxs.every((ri) => tagCurrent(resortList[ri], lat, lng))) {
          writeRows(idxs, lat, lng, pending, null, false);
          out[n] = Object.assign({ id, done: true, status: "placed", lookup: false }, placedInfo(idxs[0]));
          return;
        }
        if (!apiKey) { out[n] = { id, done: true, status: "error", error: "GOOGLE_GEOCODING_API_KEY isn't set." }; return; }
        if (live.length >= LIVE_PER_CALL) { out[n] = { id, done: false }; return; }
        live.push({ n, id, idxs, lat, lng, pending });
      });

      await mapWithConcurrency(live, 6, async (w) => {
        if (Date.now() - startedAt > LIVE_BUDGET_MS) { out[w.n] = { id: w.id, done: false }; return; }
        const { result, failureReason } = await resolveLocationForCoordinate(w.lat, w.lng, apiKey, allTowns, existingIds, true, geoCacheStore);
        writeRows(w.idxs, w.lat, w.lng, w.pending, result || null, true);
        out[w.n] = result
          ? Object.assign({ id: w.id, done: true, status: "placed", lookup: true }, placedInfo(w.idxs[0]))
          : { id: w.id, done: true, status: "notPlaced", lookup: true, error: failureReason || "Couldn't place this coordinate" };
      });

      if (live.length) await saveTowns(townsStore, allTowns);
      if (changed) await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      return json({ ok: true, results: out, totalMs: Date.now() - startedAt });
    }

    if (action === "snCleanupSaveRun" || action === "snCleanupCheck") {
      // SN cleanup wizard, steps 5–6. SaveRun stores what the built file
      // tells StockNetwork (per row: coordinate + Country/Area/City/Suburb)
      // so Check can compare it, on any later day, with what StockNetwork's
      // nightly sync actually sends back. Check is read-only.
      const runStore = getStore({ name: "sn-cleanup-runs", consistency: "strong" });
      if (action === "snCleanupSaveRun") {
        const run = body.run || {};
        const expected = Array.isArray(run.expected) ? run.expected.slice(0, 12000) : [];
        if (!expected.length) return json({ error: "Nothing to save." }, 400);
        const saved = {
          createdAt: new Date().toISOString(),
          fileName: String(run.fileName || "").slice(0, 200),
          areaMode: run.areaMode === "sn" ? "sn" : "hub",
          test: !!run.test,
          expected,
        };
        await runStore.setJSON("latest", saved);
        return json({ ok: true, createdAt: saved.createdAt, total: expected.length });
      }

      const run = await runStore.get("latest", { type: "json" });
      if (!run) return json({ ok: true, run: null });
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const byKey = new Map(), byResortId = new Map();
      resortList.forEach((r) => {
        if (!r || !r.resortId) return;
        const rid = String(r.resortId).trim();
        byKey.set(rid + "|" + String(r.siteId || "").trim(), r);
        if (!byResortId.has(rid)) byResortId.set(rid, r);
      });
      const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();
      const near = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.00002;
      const mismatch = { coordinate: 0, country: 0, area: 0, city: 0, suburb: 0 };
      let matched = 0, notInHub = 0, leftForYou = 0, noSnData = 0;
      const rows = [];
      run.expected.forEach((e) => {
        const rid = String(e.resortId || "").trim();
        const r = byKey.get(rid + "|" + String(e.siteId || "").trim()) || byResortId.get(rid);
        if (!r) { notInHub++; return; }
        if (e.status && e.status !== "applied") leftForYou++;
        const diffs = [];
        const hasLat = e.lat !== "" && e.lat != null && isFinite(parseFloat(e.lat));
        if (hasLat) {
          if (r.snCoordPending) {
            const saw = r.snCoordPending.snSaw;
            diffs.push({ field: "coordinate", expected: e.lat + ", " + e.lng, sn: saw ? saw.lat + ", " + saw.lng : "(StockNetwork hasn't sent it yet)" });
          } else if (!(near(r.latitude, e.lat) && near(r.longitude, e.lng))) {
            diffs.push({ field: "coordinate", expected: e.lat + ", " + e.lng, sn: "hub now has " + (r.latitude || "") + ", " + (r.longitude || "") });
          } else if (r.coordSuspicious && r.coordSuggested && !(near(r.coordSuggested.lat, e.lat) && near(r.coordSuggested.lng, e.lng))) {
            diffs.push({ field: "coordinate", expected: e.lat + ", " + e.lng, sn: r.coordSuggested.lat + ", " + r.coordSuggested.lng });
          }
        }
        if (!(r.snCountry || r.area || r.city || r.suburb)) noSnData++;
        else {
          if (norm(r.snCountry) !== norm(e.country)) diffs.push({ field: "country", expected: e.country, sn: r.snCountry || "" });
          if (run.areaMode !== "sn" && norm(r.area) !== norm(e.area)) diffs.push({ field: "area", expected: e.area, sn: r.area || "" });
          if (norm(r.city) !== norm(e.city)) diffs.push({ field: "city", expected: e.city, sn: r.city || "" });
          if (norm(r.suburb) !== norm(e.suburb)) diffs.push({ field: "suburb", expected: e.suburb, sn: r.suburb || "" });
        }
        if (!diffs.length) { matched++; return; }
        diffs.forEach((d) => { mismatch[d.field]++; });
        if (rows.length < 500) rows.push({ name: e.name || r.name || "", resortId: rid, siteId: e.siteId || "", diffs });
      });
      const syncedAt = (resortRecord && resortRecord.apiSyncedAt) || null;
      return json({
        ok: true,
        run: { createdAt: run.createdAt, fileName: run.fileName, areaMode: run.areaMode, test: run.test, total: run.expected.length },
        apiSyncedAt: syncedAt,
        syncedSinceRun: !!(syncedAt && syncedAt > run.createdAt),
        matched, notInHub, leftForYou, noSnData, mismatch,
        stillDifferent: run.expected.length - matched - notInHub,
        rows,
      });
    }

    if (action === "suggestCoordinates") {
      // Read-only (writes NOTHING to any store): for each { id, query, lat,
      // lng } the admin page sends — rows it read from the admin's own
      // StockNetwork export file — look the place up by name via Google and
      // say how much to trust the answer. The admin page assembles the
      // review report / upload-ready file itself, so this never touches
      // the stored resort list or any tagged record.
      //
      // Confidence:
      //   high   — Google matched the actual business (not just its town) AND
      //            the point is within 15 km of the coordinate already on
      //            file, so it's clearly the same place, just more exact.
      //   review — Google matched a business but there's nothing (missing /
      //            0,0) or something far away (>15 km) to cross-check it
      //            against; a human should eyeball the pin before using it.
      //   none   — Google only found the town/area, or nothing at all —
      //            no better than what's on file, so nothing is suggested.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) {
        return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);
      }
      const items = Array.isArray(body.items) ? body.items.slice(0, 12) : [];
      // checkNameAgainstCoordinate (lib/geolocate.js, 2026-09-29): the same
      // name-vs-coordinate confidence check resorts-api.js's nightly sync
      // now runs itself (Case B) — extracted here so both call sites share
      // one implementation instead of drifting apart.
      const results = await mapWithConcurrency(items, 8, async (it) => {
        const id = it && it.id;
        const r = await checkNameAgainstCoordinate(it && it.query, parseFloat(it && it.lat), parseFloat(it && it.lng), apiKey);
        return Object.assign({ id }, r);
      });
      return json({ ok: true, results });
    }

    if (action === "importPropertyCoordinatesCsv") {
      // The only place this file ever writes to property-listings, and only
      // ever these two fields — everything else about a listing (status,
      // agreement, owner details, etc.) stays exactly as
      // property-onboarding-api.js / the Property Listings tab left it.
      const csvText = typeof body.csv === "string" ? body.csv : "";
      if (!csvText.trim()) return json({ error: "Uploaded file was empty." }, 400);
      const rows = parseCoordinatesCsv(csvText);
      if (!rows.length) {
        return json({ error: "Could not find any usable rows (need an id or propertyName column, plus latitude and longitude)." }, 400);
      }

      const { blobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(blobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const listed = listings.filter((r) => r && r.status === "Listed");
      const byId = new Map(listed.map((r) => [r.listingId, r]));

      let updated = 0;
      let skippedNoMatch = 0;
      let skippedAmbiguous = 0;
      for (const row of rows) {
        const lat = parseFloat(row.latitude);
        const lng = parseFloat(row.longitude);
        if (!isFinite(lat) || !isFinite(lng)) { skippedNoMatch++; continue; }

        let match = row.id ? byId.get(row.id) : null;
        if (!match && row.propertyName) {
          const nameMatches = listed.filter((r) => (r.propertyName || "").toLowerCase() === row.propertyName.toLowerCase());
          if (nameMatches.length === 1) match = nameMatches[0];
          else if (nameMatches.length > 1) { skippedAmbiguous++; continue; }
        }
        if (!match) { skippedNoMatch++; continue; }

        match.latitude = String(lat);
        match.longitude = String(lng);
        match.dateUpdated = new Date().toISOString();
        await listingsStore.setJSON(match.listingId, match);
        updated++;
      }

      return json({ ok: true, updated, skippedNoMatch, skippedAmbiguous });
    }

    if (action === "importActivitiesCsv") {
      const csvText = typeof body.csv === "string" ? body.csv : "";
      if (!csvText.trim()) return json({ error: "Uploaded file was empty." }, 400);
      const rows = parseActivitiesCsv(csvText);
      if (!rows.length) return json({ error: "Could not find any activity rows (need at least a 'name' column)." }, 400);

      // One read, no matter how many activities already exist.
      const existingRecords = await loadActivities(activitiesStore);
      const byId = new Map(existingRecords.map((r) => [r.id, r]));
      const byName = new Map(existingRecords.map((r) => [(r.name || "").toLowerCase(), r]));
      const existingIds = new Set(byId.keys());

      const known = buildKnownLocations(await loadTowns(townsStore), await locationListStore.get("current", { type: "json" }));
      const warnings = [];
      let warningCount = 0;

      let created = 0;
      let updated = 0;
      for (const row of rows) {
        const rowWarnings = checkRowLocation(row.name, row, known);
        warningCount += rowWarnings.length;
        if (warnings.length < 40) rowWarnings.forEach((w) => { if (warnings.length < 40) warnings.push(w); });
        const matchExisting = (row.id && byId.get(row.id)) || byName.get(row.name.toLowerCase());
        const record = sanitizeActivity(row, matchExisting || {});
        if (matchExisting) {
          record.id = matchExisting.id;
          record.updatedAt = new Date().toISOString();
          updated++;
        } else {
          record.id = genUniqueActivityId(existingIds);
          existingIds.add(record.id);
          record.createdAt = new Date().toISOString();
          record.updatedAt = record.createdAt;
          created++;
        }
        byId.set(record.id, record);
        byName.set((record.name || "").toLowerCase(), record);
      }

      // One write, whatever the batch size — byId still holds every
      // untouched existing record too, since nothing is ever deleted from it.
      await saveActivities(activitiesStore, Array.from(byId.values()));

      return json({ ok: true, created: created, updated: updated, warnings, warningCount });
    }

    if (action === "importTownsCsv") {
      const csvText = typeof body.csv === "string" ? body.csv : "";
      if (!csvText.trim()) return json({ error: "Uploaded file was empty." }, 400);
      const rows = parseTownsCsv(csvText);
      if (!rows.length) return json({ error: "Could not find any town rows (need at least a 'name' column)." }, 400);

      const existingRecords = await loadTowns(townsStore);
      const byId = new Map(existingRecords.map((r) => [r.id, r]));
      const byName = new Map(existingRecords.map((r) => [(r.name || "").toLowerCase(), r]));
      const existingIds = new Set(byId.keys());

      const known = buildKnownLocations(existingRecords, await locationListStore.get("current", { type: "json" }));
      const warnings = [];
      let warningCount = 0;

      let created = 0;
      let updated = 0;
      for (const row of rows) {
        const rowWarnings = checkRowLocation(row.name, row, known);
        warningCount += rowWarnings.length;
        if (warnings.length < 40) rowWarnings.forEach((w) => { if (warnings.length < 40) warnings.push(w); });
        const matchExisting = (row.id && byId.get(row.id)) || byName.get(row.name.toLowerCase());
        const record = sanitizeTown(row, matchExisting || {});
        if (matchExisting) {
          record.id = matchExisting.id;
          record.updatedAt = new Date().toISOString();
          updated++;
        } else {
          record.id = genTownUniqueId(existingIds);
          existingIds.add(record.id);
          record.createdAt = new Date().toISOString();
          record.updatedAt = record.createdAt;
          created++;
        }
        byId.set(record.id, record);
        byName.set((record.name || "").toLowerCase(), record);
      }

      await saveTowns(townsStore, Array.from(byId.values()));

      return json({ ok: true, created: created, updated: updated, warnings, warningCount });
    }

    // ---- Merge duplicate towns -------------------------------------------
    // Step 1 (planTownMerges): read-only preview of which towns are the same
    // place recorded more than once. Step 2 (remapTownRefs, once per kind of
    // record): re-point everything that uses a duplicate at the surviving
    // town. Step 3 (applyTownMerges): fold the duplicates into the survivor
    // and delete them. References are moved BEFORE the duplicates are deleted,
    // so a run that stops half way leaves nothing pointing at a missing town.
    if (action === "planTownMerges") {
      const all = await loadTowns(townsStore);
      const plan = planTownMerges(all);
      return json({ ok: true, totalTowns: all.length, groups: plan.groups, townMap: plan.townMap, subMap: plan.subMap });
    }

    if (action === "remapTownRefs") {
      const townMap = isPlainMap(body.townMap) ? body.townMap : {};
      const subMap = isPlainMap(body.subMap) ? body.subMap : {};
      const kind = body.kind;
      if (!Object.keys(townMap).length && !Object.keys(subMap).length) return json({ ok: true, changed: 0, done: true });
      if (kind === "activities") {
        const list = await loadActivities(activitiesStore);
        let changed = 0;
        list.forEach((r) => { if (remapTownRefs(r, townMap, subMap)) changed++; });
        if (changed) await saveActivities(activitiesStore, list);
        return json({ ok: true, kind, changed, done: true });
      }
      if (kind === "resorts") {
        const rec = await resortListStore.get("current", { type: "json" });
        const list = (rec && Array.isArray(rec.resorts)) ? rec.resorts : [];
        let changed = 0;
        list.forEach((r) => { if (remapTownRefs(r, townMap, subMap)) changed++; });
        if (changed) await resortListStore.setJSON("current", Object.assign({}, rec, { resorts: list }));
        return json({ ok: true, kind, changed, done: true });
      }
      if (kind === "listings") {
        const { blobs } = await listingsStore.list();
        const recs = await mapWithConcurrency(blobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
        const toSave = [];
        recs.forEach((r, i) => { if (remapTownRefs(r, townMap, subMap)) toSave.push({ key: blobs[i].key, rec: r }); });
        await mapWithConcurrency(toSave, 10, (x) => listingsStore.setJSON(x.key, x.rec));
        return json({ ok: true, kind, changed: toSave.length, done: true });
      }
      if (kind === "hooks") {
        // Hooks (the admin's default hooks and every affiliate's own hooks)
        // remember the town they were tagged with. There can be many, so this
        // works through them in slices; the caller repeats with `cursor`.
        const hookStore = getStore({ name: "promo-hooks", consistency: "strong" });
        const { blobs } = await hookStore.list();
        const keys = blobs.map((b) => b.key).sort();
        const start = Math.max(0, parseInt(body.cursor, 10) || 0);
        const startedAt = Date.now();
        let idx = start;
        let changed = 0;
        while (idx < keys.length && Date.now() - startedAt < 15000) {
          const slice = keys.slice(idx, idx + 40);
          const recs = await mapWithConcurrency(slice, 20, (k) => hookStore.get(k, { type: "json" }).catch(() => null));
          const toSave = [];
          recs.forEach((r, i) => { if (isPlainMap(r) && remapTownRefs(r, townMap, subMap)) toSave.push({ key: slice[i], rec: r }); });
          await mapWithConcurrency(toSave, 10, (x) => hookStore.setJSON(x.key, x.rec));
          changed += toSave.length;
          idx += slice.length;
        }
        return json({ ok: true, kind, changed, done: idx >= keys.length, cursor: idx, total: keys.length });
      }
      return json({ error: "Unknown kind." }, 400);
    }

    if (action === "applyTownMerges") {
      const townMap = isPlainMap(body.townMap) ? body.townMap : {};
      const subMap = isPlainMap(body.subMap) ? body.subMap : {};
      const all = await loadTowns(townsStore);
      const byId = new Map(all.map((t) => [t.id, t]));
      let merged = 0, movedSuburbs = 0, joinedSuburbs = 0;
      Object.keys(townMap).forEach((oldId) => {
        const dup = byId.get(oldId);
        const keep = byId.get(townMap[oldId]);
        if (!dup || !keep || dup === keep) return;
        if (!Array.isArray(keep.suburbs)) keep.suburbs = [];
        (Array.isArray(dup.suburbs) ? dup.suburbs : []).forEach((s) => {
          if (subMap[s.id]) { joinedSuburbs++; return; }   // same-named suburb already on the survivor
          keep.suburbs.push(s);
          movedSuburbs++;
        });
        const keepPhotos = Array.isArray(keep.photoKeys) ? keep.photoKeys.slice() : keep.photoKey ? [keep.photoKey] : [];
        const dupPhotos = Array.isArray(dup.photoKeys) ? dup.photoKeys : dup.photoKey ? [dup.photoKey] : [];
        dupPhotos.forEach((k) => { if (keepPhotos.length < 12 && keepPhotos.indexOf(k) === -1) keepPhotos.push(k); });
        if (keepPhotos.length) { keep.photoKeys = keepPhotos; delete keep.photoKey; }
        if (!keep.description && dup.description) keep.description = dup.description;
        if (!keep.area && dup.area) keep.area = dup.area;
        if (!isFinite(parseFloat(keep.latitude)) && isFinite(parseFloat(dup.latitude))) keep.latitude = dup.latitude;
        if (!isFinite(parseFloat(keep.longitude)) && isFinite(parseFloat(dup.longitude))) keep.longitude = dup.longitude;
        if (!keep.country && dup.country) keep.country = dup.country;
        if (keep.visible === false && dup.visible !== false) keep.visible = true;
        keep.updatedAt = new Date().toISOString();
        byId.delete(oldId);
        merged++;
      });
      const next = all.filter((t) => byId.get(t.id) === t);
      await saveTowns(townsStore, next);
      return json({ ok: true, merged, movedSuburbs, joinedSuburbs, townsNow: next.length });
    }

    // Read-only report covering the gaps "Merge duplicate towns" doesn't
    // reach — see the comment above auditNearDuplicateTowns for why. Single
    // request, no pagination: even a full ~1,000-town tree is a trivial
    // number of comparisons (well under the Edge Function's time budget).
    if (action === "auditLocationTree") {
      const allTowns = await loadTowns(townsStore);
      const { blobs: listingBlobs } = await listingsStore.list();
      const listings = await mapWithConcurrency(listingBlobs, 25, (b) => listingsStore.get(b.key, { type: "json" }));
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const activities = await loadActivities(activitiesStore);

      const nearDuplicateTowns = auditNearDuplicateTowns(allTowns);
      const townSuburbOverlaps = auditTownSuburbOverlaps(allTowns);
      const orphanReport = auditOrphanRefs(allTowns, listings, resortList, activities);

      return json({
        ok: true,
        totalTowns: allTowns.length,
        nearDuplicateTowns,
        townSuburbOverlaps,
        orphanRefs: orphanReport.orphans,
        zoneOnlyNoTown: orphanReport.zoneOnly,
      });
    }

    if (action === "addTown") {
      const all = await loadTowns(townsStore);
      const id = genTownUniqueId(new Set(all.map((r) => r.id)));
      const record = sanitizeTown(body, {});
      record.id = id;
      record.createdAt = new Date().toISOString();
      record.updatedAt = record.createdAt;
      if (!record.name) return json({ error: "Town name is required." }, 400);
      all.push(record);
      await saveTowns(townsStore, all);
      return json({ ok: true, town: record });
    }

    if (action === "updateTown") {
      const id = clean(body.id, 20);
      if (!id) return json({ error: "missing id" }, 400);
      const all = await loadTowns(townsStore);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const record = sanitizeTown(body, all[idx]);
      record.updatedAt = new Date().toISOString();
      all[idx] = record;
      await saveTowns(townsStore, all);
      return json({ ok: true, town: record });
    }

    if (action === "deleteTown") {
      const id = clean(body.id, 20);
      if (!id) return json({ error: "missing id" }, 400);
      const all = await loadTowns(townsStore);
      await saveTowns(townsStore, all.filter((r) => r.id !== id));
      return json({ ok: true });
    }

    if (action === "addTownPhoto") {
      const id = clean(body.id, 20);
      const photoKey = clean(body.photoKey, 300);
      if (!id || !photoKey) return json({ error: "missing id or photoKey" }, 400);
      const all = await loadTowns(townsStore);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const existing = all[idx];
      const keys = Array.isArray(existing.photoKeys) ? existing.photoKeys.slice() : existing.photoKey ? [existing.photoKey] : [];
      if (keys.length >= 12) return json({ error: "Maximum 12 photos per town." }, 400);
      keys.push(photoKey);
      existing.photoKeys = keys;
      delete existing.photoKey;
      existing.updatedAt = new Date().toISOString();
      all[idx] = existing;
      await saveTowns(townsStore, all);
      return json({ ok: true, town: existing });
    }

    if (action === "removeTownPhoto") {
      const id = clean(body.id, 20);
      const photoKey = clean(body.photoKey, 300);
      if (!id || !photoKey) return json({ error: "missing id or photoKey" }, 400);
      const all = await loadTowns(townsStore);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const existing = all[idx];
      const keys = Array.isArray(existing.photoKeys) ? existing.photoKeys.slice() : existing.photoKey ? [existing.photoKey] : [];
      existing.photoKeys = keys.filter((k) => k !== photoKey);
      delete existing.photoKey;
      existing.updatedAt = new Date().toISOString();
      all[idx] = existing;
      await saveTowns(townsStore, all);
      return json({ ok: true, town: existing });
    }

    if (action === "addSuburb") {
      const townId = clean(body.townId, 20);
      if (!townId) return json({ error: "missing townId" }, 400);
      const all = await loadTowns(townsStore);
      const idx = all.findIndex((r) => r.id === townId);
      if (idx === -1) return json({ error: "town not found" }, 404);
      const town = all[idx];
      if (!Array.isArray(town.suburbs)) town.suburbs = [];
      const record = sanitizeSuburb(body, {});
      if (!record.name) return json({ error: "Suburb name is required." }, 400);
      record.id = genSuburbUniqueId(allSuburbIds(all));
      town.suburbs.push(record);
      town.updatedAt = new Date().toISOString();
      all[idx] = town;
      await saveTowns(townsStore, all);
      return json({ ok: true, town });
    }

    if (action === "updateSuburb") {
      const townId = clean(body.townId, 20);
      const suburbId = clean(body.suburbId, 20);
      if (!townId || !suburbId) return json({ error: "missing townId or suburbId" }, 400);
      const all = await loadTowns(townsStore);
      const idx = all.findIndex((r) => r.id === townId);
      if (idx === -1) return json({ error: "town not found" }, 404);
      const town = all[idx];
      const suburbs = Array.isArray(town.suburbs) ? town.suburbs : [];
      const sIdx = suburbs.findIndex((s) => s.id === suburbId);
      if (sIdx === -1) return json({ error: "suburb not found" }, 404);
      suburbs[sIdx] = sanitizeSuburb(body, suburbs[sIdx]);
      town.suburbs = suburbs;
      town.updatedAt = new Date().toISOString();
      all[idx] = town;
      await saveTowns(townsStore, all);
      return json({ ok: true, town });
    }

    if (action === "deleteSuburb") {
      const townId = clean(body.townId, 20);
      const suburbId = clean(body.suburbId, 20);
      if (!townId || !suburbId) return json({ error: "missing townId or suburbId" }, 400);
      const all = await loadTowns(townsStore);
      const idx = all.findIndex((r) => r.id === townId);
      if (idx === -1) return json({ error: "town not found" }, 404);
      const town = all[idx];
      town.suburbs = (Array.isArray(town.suburbs) ? town.suburbs : []).filter((s) => s.id !== suburbId);
      town.updatedAt = new Date().toISOString();
      all[idx] = town;
      await saveTowns(townsStore, all);
      return json({ ok: true, town });
    }

    if (action === "nearbyActivities") {
      // Real geometry, not typing: given a property's own coordinates
      // (already on file from onboarding/geocoding), returns visible
      // activities sorted nearest-first with a real distanceKm/
      // distanceLabel attached (see lib/geo-distance.js) — feeds the
      // landing page builder's automatic "nearby activities" suggestions
      // (Jean can still adjust the picks; nothing here saves anything).
      const lat = body.latitude;
      const lng = body.longitude;
      if (!isFinite(parseFloat(lat)) || !isFinite(parseFloat(lng))) {
        return json({ ok: false, error: "missing or invalid latitude/longitude" }, 400);
      }
      const all = (await loadActivities(activitiesStore)).filter((r) => r && r.visible !== false);
      const limit = isFinite(Number(body.limit)) ? Math.max(1, Math.min(50, Number(body.limit))) : 10;
      const maxKm = isFinite(Number(body.maxKm)) ? Number(body.maxKm) : undefined;
      const nearby = nearestByDistance(lat, lng, all, { limit, maxKm });
      return json({ ok: true, activities: nearby });
    }

    if (action === "addActivity") {
      const all = await loadActivities(activitiesStore);
      const id = genUniqueActivityId(new Set(all.map((r) => r.id)));
      const record = sanitizeActivity(body, {});
      record.id = id;
      record.createdAt = new Date().toISOString();
      record.updatedAt = record.createdAt;
      if (!record.name) return json({ error: "Activity name is required." }, 400);
      // Auto-geocode right here, at the moment this activity is created —
      // see autoGeocodeRecord's own comment. A no-op if the admin already
      // picked a location from the tree, if there's no usable coordinate,
      // or if GOOGLE_GEOCODING_API_KEY isn't configured.
      await autoGeocodeRecord(record, Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "", townsStore, geoCacheStore);
      all.push(record);
      await saveActivities(activitiesStore, all);
      return json({ ok: true, activity: record });
    }

    if (action === "updateActivity") {
      const id = clean(body.id, 20);
      if (!id) return json({ error: "missing id" }, 400);
      const all = await loadActivities(activitiesStore);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const record = sanitizeActivity(body, all[idx]);
      record.updatedAt = new Date().toISOString();
      // Same auto-geocode as addActivity — covers an existing activity
      // that gets a coordinate added (or edited) without a location pick.
      await autoGeocodeRecord(record, Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "", townsStore, geoCacheStore);
      all[idx] = record;
      await saveActivities(activitiesStore, all);
      return json({ ok: true, activity: record });
    }

    if (action === "deleteActivity") {
      const id = clean(body.id, 20);
      if (!id) return json({ error: "missing id" }, 400);
      const all = await loadActivities(activitiesStore);
      await saveActivities(activitiesStore, all.filter((r) => r.id !== id));
      return json({ ok: true });
    }

    if (action === "addActivityPhoto") {
      const id = clean(body.id, 20);
      const photoKey = clean(body.photoKey, 300);
      if (!id || !photoKey) return json({ error: "missing id or photoKey" }, 400);
      const all = await loadActivities(activitiesStore);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const existing = all[idx];
      const keys = Array.isArray(existing.photoKeys) ? existing.photoKeys.slice() : existing.photoKey ? [existing.photoKey] : [];
      if (keys.length >= 12) return json({ error: "Maximum 12 photos per activity." }, 400);
      keys.push(photoKey);
      existing.photoKeys = keys;
      delete existing.photoKey;
      existing.updatedAt = new Date().toISOString();
      all[idx] = existing;
      await saveActivities(activitiesStore, all);
      return json({ ok: true, activity: existing });
    }

    if (action === "removeActivityPhoto") {
      const id = clean(body.id, 20);
      const photoKey = clean(body.photoKey, 300);
      if (!id || !photoKey) return json({ error: "missing id or photoKey" }, 400);
      const all = await loadActivities(activitiesStore);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const existing = all[idx];
      const keys = Array.isArray(existing.photoKeys) ? existing.photoKeys.slice() : existing.photoKey ? [existing.photoKey] : [];
      existing.photoKeys = keys.filter((k) => k !== photoKey);
      delete existing.photoKey;
      existing.updatedAt = new Date().toISOString();
      all[idx] = existing;
      await saveActivities(activitiesStore, all);
      return json({ ok: true, activity: existing });
    }

    if (action === "findPlaceImages") {
      // Identical to admin-api.js's action of the same name (see there for
      // the full reasoning) — kept as its own small copy rather than a
      // shared import of the action itself, same as every other file that
      // wraps lib/places-images.js, since each caller's around-code
      // (auth, cors, response shape) is already file-local.
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 200) : "";
      const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY") || "";
      const result = await searchPlacePhotos(query, apiKey, body.limit);
      return json(result, 200);
    }

    if (action === "saveActivityPlacePhoto") {
      // Saves one admin-picked Places photo (already fetched to a data:
      // URI by findPlaceImages above, sent straight back rather than
      // re-fetched — same "client already has the bytes" shape as
      // admin-api.js's savePlacePhoto) as one more photo on this activity,
      // through the exact same property-listing-files store + photoKeys
      // array that manual uploads use, so it appears identically in
      // toActivityPin()'s photos list and counts against the same 12-photo
      // cap as addActivityPhoto above.
      const id = clean(body.id, 20);
      if (!id) return json({ ok: false, error: "missing id" }, 400);
      const all = await loadActivities(activitiesStore);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json({ ok: false, error: "not found" }, 404);
      const existing = all[idx];
      const keys = Array.isArray(existing.photoKeys) ? existing.photoKeys.slice() : existing.photoKey ? [existing.photoKey] : [];
      if (keys.length >= 12) return json({ ok: false, error: "Maximum 12 photos per activity." }, 400);

      const parsed = dataUriToBytes(body.dataUri);
      if (!parsed) return json({ ok: false, error: "No image data received." }, 400);
      if (parsed.buf.byteLength > 5 * 1024 * 1024) return json({ ok: false, error: "Image too large (max 5MB)." }, 413);

      const photoKey = "activity-" + id + "/image/" + Date.now() + "-google-places";
      await activityPhotoFilesStore.set(photoKey, parsed.buf, {
        metadata: { contentType: parsed.contentType, fileName: "google-places", listingId: "activity-" + id, kind: "image", label: "activity", sourceUrl: "google_places" },
      });

      keys.push(photoKey);
      existing.photoKeys = keys;
      delete existing.photoKey;
      existing.updatedAt = new Date().toISOString();
      all[idx] = existing;
      await saveActivities(activitiesStore, all);
      return json({ ok: true, activity: existing });
    }

    if (action === "setPropertyVisibility") {
      const listingId = clean(body.listingId, 20);
      const hidden = body.hidden === true;
      if (!listingId) return json({ error: "missing listingId" }, 400);
      if (hidden) {
        await visibilityStore.setJSON(listingId, { hidden: true });
      } else {
        await visibilityStore.delete(listingId);
      }
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
};

export const config = { path: "/api/map" };

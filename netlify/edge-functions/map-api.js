import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { placeCoordinate, keyOf, sameSpot, provinceAt, nearestTownName, placeText, snFieldsFromPlace, PLACES_STORE, ACTIVITY_KEY, PROPERTY_KEY } from "./lib/tree.js";
// Same Google Places photo search admin-api.js's Event hook "Find area
// photo"/"Find theme photo" pickers use (see lib/places-images.js) — reused
// here for the Map & Activities form's own "Find photo" button, so Jean
// doesn't have to source/upload an activity photo by hand when Google
// already has one on file for that place.
import { searchPlacePhotos, searchPlaceCandidates } from "./lib/places-images.js";
import { dataUriToBytes } from "./lib/data-uri.js";
import { nearestByDistance } from "./lib/geo-distance.js";
import { cachedForwardGeocode, checkNameAgainstCoordinate } from "./lib/name-check.js";

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
// Where a place is (Country › Province › Region › City › Suburb) comes from
// the location tree (lib/tree.js, the "tree-places" store), not from here.

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



// New location tree (2026-10-07): place an activity in Country > Province >
// Region > City > Suburb when it is added or its pin moves, in the
// "tree-places" store the Explore page reads. Best-effort: never blocks a save.
async function placeActivityInTree(record) {
  try {
    const lat = parseFloat(record.latitude), lng = parseFloat(record.longitude);
    if (!record.id || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
    const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
    if (!apiKey) return;
    const store = getStore({ name: PLACES_STORE, consistency: "strong" });
    const map = (await store.get(ACTIVITY_KEY, { type: "json" })) || {};
    const have = map[record.id];
    if (have && have.p && sameSpot(have.k, keyOf(lat, lng))) return;
    const r = await placeCoordinate(lat, lng, apiKey);
    if (!r.ok) return;
    map[record.id] = r.place;
    await store.setJSON(ACTIVITY_KEY, map);
  } catch (e) { /* placement is retried by the lookup page's activity run */ }
}

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
    // see applyPropertyCoordinate's resortId lookup path below.
    resortId: record.resortId || "",
    siteId: record.siteId || "",
    name: record.name || "",
    area: record.suburb || record.district || "",
    city: "",
    country: record.country || "South Africa",
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
  if (typeof body.country === "string") {
    record.country = clean(body.country, 120);
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

  try {
    if (request.method === "GET") {
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

      return json({ ok: true, properties, activities });
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
      return json({
        ok: true, properties, activities: activities.filter(Boolean), missingCoordinates, resortStats,
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
        if (r && r.status === "Listed" && isPlaceholderOrMissing(r)) {
          const area = r.area || r.district || "";
          if (area) targets.push({ source: "listing", key: r.listingId, name: r.propertyName || r.listingId, area, searchText: area });
        }
      });
      resortList.forEach((r, i) => {
        if (r && isPlaceholderOrMissing(r)) {
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
      // resort-list property's StockNetwork fields (from the nightly sync or a
      // CSV upload) with its place in the location tree (2026-10-07):
      // Country, State = province, Area = main Avante region, City, Suburb.
      // Read-only. A property with no StockNetwork data yet is skipped.
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const placed = (await getStore({ name: PLACES_STORE, consistency: "strong" }).get(PROPERTY_KEY, { type: "json" })) || {};

      function norm(v) {
        return String(v || "").trim().toLowerCase();
      }
      // Loose on purpose ("Cape Town" vs "Cape Town Central"): this lists
      // disagreements for a person to judge.
      function likelyMatch(a, b) {
        const x = norm(a), y = norm(b);
        if (!x || !y) return false;
        return x === y || x.indexOf(y) > -1 || y.indexOf(x) > -1;
      }

      const flags = [];
      resortList.forEach((r, i) => {
        if (!r || !r.resortId) return;
        const hasSnData = r.snCountry || r.area || r.city || r.suburb || r.state;
        if (!hasSnData && !r.coordSuspicious) return;

        const pl = placed[r.resortId];
        const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
        const current = pl && isFinite(lat) && isFinite(lng) && sameSpot(pl.k, keyOf(lat, lng));
        const hub = current ? snFieldsFromPlace(pl) : { country: "", state: "", area: "", city: "", suburb: "", district: "" };

        const reasons = [];
        if (!current && isFinite(lat) && isFinite(lng)) reasons.push("not-placed");
        if (hasSnData && current) {
          if (!r.snCountry) reasons.push("country-blank");
          else if (!likelyMatch(r.snCountry, hub.country)) reasons.push("country");
          if (!r.state) reasons.push("state-blank");
          else if (hub.state && !likelyMatch(r.state, hub.state)) reasons.push("state");
          if (!r.area) reasons.push("region-blank");
          else if (hub.area && !likelyMatch(r.area, hub.area)) reasons.push("region");
          if (!r.city) reasons.push("town-blank");
          else if (!likelyMatch(r.city, hub.city)) reasons.push("town");
          if (r.suburb && hub.suburb && !likelyMatch(r.suburb, hub.suburb)) reasons.push("suburb");
        }
        if (r.coordSuspicious) reasons.push("coordinate");

        if (!reasons.length) return;
        flags.push({
          index: i,
          resortId: r.resortId,
          siteId: r.siteId || "",
          name: r.name || "",
          snCountry: r.snCountry || "", snState: r.state || "", snArea: r.area || "", snCity: r.city || "", snSuburb: r.suburb || "",
          snDistrict: r.district || "", snCity2: r.city2 || "",
          hubCountry: hub.country, hubState: hub.state, hubRegion: hub.area, hubTown: hub.city, hubSuburb: hub.suburb, hubDistrict: hub.district,
          hubPlace: current ? placeText(pl) : "",
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
      // the location columns that export derives from the location tree.
      // So there's no way to push a fix for these three back into
      // StockNetwork except telling their team directly — Jean uses these
      // for availability search on her side (a town can have two valid
      // search names, e.g. Warmbaths/Bela-Bela; a province can span more
      // than one region), so what's "correct" here needs a person's
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
      // The shared write path for "Accept suggested coordinate" (StockNetwork
      // review), "Use this" (Find & fix missing coordinates) and the Master
      // map's Fix coordinates: sets the property's coordinate and places it
      // in the location tree straight away (2026-10-07).
      const source = body.source === "listing" ? "listing" : "resort";
      const lat = parseFloat(body.lat), lng = parseFloat(body.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json({ error: "Missing or invalid lat/lng." }, 400);
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      if (!apiKey) return json({ error: "GOOGLE_GEOCODING_API_KEY isn't set in this site's environment variables yet." }, 400);
      const placesStore = getStore({ name: PLACES_STORE, consistency: "strong" });
      const OLD_TAGS = ["zone", "townId", "suburbId", "locationLabel", "nearby", "offshoreKm", "locV"];
      const placedRes = await placeCoordinate(lat, lng, apiKey);
      async function savePlace(key) {
        if (!placedRes.ok) return;
        const map = (await placesStore.get(PROPERTY_KEY, { type: "json" })) || {};
        map[key] = placedRes.place;
        await placesStore.setJSON(PROPERTY_KEY, map);
      }
      const reply = () => json({ ok: true, placed: !!placedRes.ok, locationLabel: placedRes.ok ? placeText(placedRes.place) : "" });

      if (source === "listing") {
        const listingId = typeof body.listingId === "string" ? body.listingId : "";
        if (!listingId) return json({ error: "Missing listingId." }, 400);
        const rec = await listingsStore.get(listingId, { type: "json" });
        if (!rec) return json({ error: "Property not found." }, 404);
        rec.latitude = String(lat);
        rec.longitude = String(lng);
        OLD_TAGS.forEach((f) => delete rec[f]);
        await listingsStore.setJSON(listingId, rec);
        await savePlace("listing:" + listingId);
        return reply();
      }

      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      // index (review/Find&fix cards) or resortId (map popup).
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
      OLD_TAGS.forEach((f) => delete rec[f]);
      await resortListStore.setJSON("current", Object.assign({}, resortRecord, { resorts: resortList }));
      if (rec.resortId) await savePlace(String(rec.resortId));
      return reply();
    }

    if (action === "exportLocations") {
      // Backs the "Corrected StockNetwork file" tool and the SN cleanup
      // wizard. Given rows from a StockNetwork resort export ({ i, name,
      // resortId, siteId, lat, lng, csvCountry }), returns what each row's
      // location columns should say according to the location tree
      // (2026-10-07): Country, State = province, Area = main Avante region,
      // City = town, Suburb = suburb (the town when there is none), District
      // = local municipality. City2 is never touched.
      //
      // A property already placed in the live tree at the same spot costs
      // nothing; anything else is looked up with Google (at most
      // LIVE_PER_CALL per call, then `nextIndex` says where to resume) and
      // saved in the live tree.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      const startedAt = Date.now();
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, body.dryRun ? 8000 : 400) : [];
      const LIVE_PER_CALL = 12;
      const LIVE_BUDGET_MS = 11000;

      const placesStore = getStore({ name: PLACES_STORE, consistency: "strong" });
      const placed = (await placesStore.get(PROPERTY_KEY, { type: "json" })) || {};
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
      // A likely fix for a pin that landed nowhere in South Africa: latitude/
      // longitude with a flipped sign or swapped. Only suggested, never applied.
      function addFlipNote(item, lat, lng, csvCountry) {
        if (!/^south africa$/i.test(csvCountry || "South Africa")) return;
        const tries = [[-lat, lng], [lat, -lng], [-lat, -lng], [lng, lat], [-lng, lat], [lng, -lat], [-lng, -lat]];
        for (const [a, b] of tries) {
          const prov = provinceAt(a, b);
          if (prov) {
            item.suggestion = { lat: a, lng: b, province: prov };
            item.note += " Looks like the latitude/longitude may be swapped or have a flipped sign — as " + a + ", " + b + " it would be in " + prov + ".";
            return;
          }
        }
      }
      // foldAH (SN cleanup wizard only): when the town is an agricultural
      // holding ("Renosterkop AH"), City gets the nearest real town within
      // 40 km and the AH name moves to Suburb — City is what guests search on.
      const AH_NAME = /\b(AH|A\.H\.|agricultural holdings?)$/i;
      function fill(item, pl, csvCountry, lat, lng) {
        const f = snFieldsFromPlace(pl);
        f.country = pickCountry(f.country, csvCountry);
        if (body.foldAH && AH_NAME.test(f.city.trim())) {
          const near = nearestTownName(lat, lng, 40, AH_NAME);
          if (near) {
            item.note = (item.note ? item.note + " " : "") + f.city + " is an agricultural holding — City is the nearest town, " + near.name + " (" + Math.round(near.km) + " km).";
            f.suburb = f.city;
            f.city = near.name;
          }
        }
        Object.assign(item, f);
        if (pl.c === "South Africa" && (!f.area || !f.state)) {
          item.status = "sea";
          item.note = (item.note ? item.note + " " : "") + "The pin is not inside any Avante region — it may be in the sea or just over a border. Check the coordinates.";
          addFlipNote(item, lat, lng, csvCountry);
        } else item.status = "ok";
      }
      const usable = (lat, lng) => isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      const placeFor = (r, lat, lng) => {
        const ri = byKey.get(rowKey(r.name, r.siteId, r.resortId));
        const rec = ri === undefined ? null : resortList[ri];
        const id = String(r.resortId || (rec && rec.resortId) || "").trim();
        const have = id ? placed[id] : null;
        return { id, have: have && sameSpot(have.k, keyOf(lat, lng)) ? have : null };
      };

      // dryRun: no lookups, nothing written — how many rows are already in
      // the tree and how many would need a fresh lookup.
      if (body.dryRun) {
        let fromHub = 0, needLookup = 0, unusable = 0;
        rows.forEach((r) => {
          const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
          if (!usable(lat, lng)) { unusable++; return; }
          if (placeFor(r, lat, lng).have) fromHub++; else needLookup++;
        });
        return json({ ok: true, dryRun: true, total: rows.length, fromHub, needLookup, unusable });
      }

      const out = [];
      let liveUsed = 0, placedChanged = false, idx = 0;
      for (; idx < rows.length; idx++) {
        const r = rows[idx];
        const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
        const item = { i: r.i, status: "", note: "" };
        if (!usable(lat, lng)) {
          item.status = "skip";
          item.note = "No usable coordinates (blank, 0,0 or out of range) — the location can't be worked out.";
          out.push(item);
          continue;
        }
        const csvCountry = r.csvCountry || "";
        const { id, have } = placeFor(r, lat, lng);
        let pl = have;
        if (!pl) {
          if (liveUsed >= LIVE_PER_CALL || Date.now() - startedAt > LIVE_BUDGET_MS) break;
          if (!apiKey) {
            item.status = "fail";
            item.note = "GOOGLE_GEOCODING_API_KEY isn't set, so this row can't be looked up.";
            out.push(item);
            continue;
          }
          liveUsed++;
          const res = await placeCoordinate(lat, lng, apiKey);
          if (!res.ok) {
            item.status = "fail";
            item.note = "Google couldn't place this coordinate (" + res.reason + ")" + (res.message ? ": " + res.message : ".");
            addFlipNote(item, lat, lng, csvCountry);
            out.push(item);
            continue;
          }
          pl = res.place;
          // Only the property's own current pin goes into the live tree.
          const ri = byKey.get(rowKey(r.name, r.siteId, r.resortId));
          const rec = ri === undefined ? null : resortList[ri];
          if (id && rec && sameSpot(keyOf(parseFloat(rec.latitude), parseFloat(rec.longitude)), keyOf(lat, lng))) {
            placed[id] = pl;
            placedChanged = true;
          }
          item.source = "live";
        } else item.source = "hub";
        if (!countryMatches(pl.c, csvCountry)) {
          item.status = "check";
          item.note = "StockNetwork says \"" + csvCountry + "\" but the coordinates are in \"" + pl.c + "\" — left unchanged. Check the country or the coordinates.";
          addFlipNote(item, lat, lng, csvCountry);
          out.push(item);
          continue;
        }
        fill(item, pl, csvCountry, lat, lng);
        out.push(item);
      }

      if (placedChanged) await placesStore.setJSON(PROPERTY_KEY, placed);
      return json({ ok: true, results: out, nextIndex: idx, liveLookups: liveUsed, totalMs: Date.now() - startedAt });
    }

    if (action === "snCleanupApply") {
      // SN cleanup wizard, step 3 ("Place in hub"). For each { id, resortId,
      // lat, lng, pending } sets that coordinate on EVERY resort-list row
      // sharing the ResortID (one property can be listed under several
      // SiteIDs) and places it in the location tree (2026-10-07). A
      // property already placed at that spot costs nothing. pending:true
      // means StockNetwork doesn't have this coordinate yet: the row gets
      // snCoordPending, which makes the nightly sync, a resort-list CSV
      // re-upload and exportLocations keep the hub's coordinate (without
      // raising a review flag) until StockNetwork sends the same point.
      // Items not finished inside this call's budget come back done:false;
      // the caller re-sends them.
      const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const LIVE_PER_CALL = 24;
      const LIVE_BUDGET_MS = 10000;
      const startedAt = Date.now();

      const placesStore = getStore({ name: PLACES_STORE, consistency: "strong" });
      const placed = (await placesStore.get(PROPERTY_KEY, { type: "json" })) || {};
      const resortRecord = await resortListStore.get("current", { type: "json" });
      const resortList = (resortRecord && Array.isArray(resortRecord.resorts)) ? resortRecord.resorts : [];
      const byResortId = new Map();
      resortList.forEach((r, i) => {
        const k = r && String(r.resortId || "").trim();
        if (!k) return;
        if (!byResortId.has(k)) byResortId.set(k, []);
        byResortId.get(k).push(i);
      });

      const out = new Array(items.length);
      const live = [];
      let changed = false, placedChanged = false;
      const setAt = new Date().toISOString();
      // The old zone/town tags on a resort row are no longer used (location
      // tree, 2026-10-07): dropped from every row this touches.
      const OLD_TAGS = ["zone", "townId", "suburbId", "locationLabel", "nearby", "offshoreKm", "locV"];

      function writeRows(idxs, lat, lng, pending) {
        idxs.forEach((ri) => {
          const r = resortList[ri];
          r.latitude = String(lat);
          r.longitude = String(lng);
          OLD_TAGS.forEach((f) => delete r[f]);
          delete r.coordSuspicious;
          delete r.coordSuspiciousNote;
          delete r.coordSuggested;
          if (pending) r.snCoordPending = { lat, lng, setAt };
          else delete r.snCoordPending;
        });
        changed = true;
      }
      const info = (pl) => ({ locationLabel: placeText(pl), country: pl.c || "", region: (pl.r && pl.r[0]) || "" });

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
        const have = placed[resortId];
        if (have && sameSpot(have.k, keyOf(lat, lng))) {
          writeRows(idxs, lat, lng, pending);
          out[n] = Object.assign({ id, done: true, status: "placed", lookup: false }, info(have));
          return;
        }
        if (!apiKey) { out[n] = { id, done: true, status: "error", error: "GOOGLE_GEOCODING_API_KEY isn't set." }; return; }
        if (live.length >= LIVE_PER_CALL) { out[n] = { id, done: false }; return; }
        live.push({ n, id, resortId, idxs, lat, lng, pending });
      });

      await mapWithConcurrency(live, 6, async (w) => {
        if (Date.now() - startedAt > LIVE_BUDGET_MS) { out[w.n] = { id: w.id, done: false }; return; }
        const res = await placeCoordinate(w.lat, w.lng, apiKey);
        writeRows(w.idxs, w.lat, w.lng, w.pending);
        if (res.ok) {
          placed[w.resortId] = res.place;
          placedChanged = true;
          out[w.n] = Object.assign({ id: w.id, done: true, status: "placed", lookup: true }, info(res.place));
        } else {
          out[w.n] = { id: w.id, done: true, status: "notPlaced", lookup: true, error: res.reason || "Couldn't place this coordinate" };
        }
      });

      if (placedChanged) await placesStore.setJSON(PROPERTY_KEY, placed);
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
      // checkNameAgainstCoordinate (lib/name-check.js): the same
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

      const warnings = [];
      const warningCount = 0;

      let created = 0;
      let updated = 0;
      for (const row of rows) {
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
      all.push(record);
      await saveActivities(activitiesStore, all);
      await placeActivityInTree(record);
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
      all[idx] = record;
      await saveActivities(activitiesStore, all);
      await placeActivityInTree(record);
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

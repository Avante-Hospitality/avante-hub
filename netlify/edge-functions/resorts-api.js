import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { placeResortBacklog, PLACES_STORE } from "./lib/tree.js";
// When StockNetwork sends a new coordinate, the property's own NAME is
// checked against the new pin (checkNameAgainstCoordinate), so a plainly
// wrong StockNetwork coordinate gets flagged for review right away. Its place
// in the location tree is set by placeTreeBacklog (lib/tree.js).
import { checkNameAgainstCoordinate } from "./lib/name-check.js";
import { estatesMap, estateNames, ESTATE_TYPES } from "./lib/estates.js";
import { pickSite, siteFieldsOf } from "./lib/sn-feed.js";
import { isAdminToken } from "./lib/admin-session.js";

// The old zone/town tags (before the location tree, 2026-10-07). Removed from
// every row on each sync.
const OLD_ZONE_TAGS = ["zone", "townId", "suburbId", "locationLabel", "nearby", "offshoreKm", "locV", "zoneHint"];
function stripOldZoneTags(resorts) {
  (resorts || []).forEach((r) => { if (r) OLD_ZONE_TAGS.forEach((f) => { delete r[f]; }); });
}
// Cleared when a property gets its first coordinate, so the tree placing and
// name check below start fresh for it.
const API_SYNC_CLEAR_ON_MOVE = ["country", "coordSuspicious", "coordSuspiciousNote", "coordSuggested"];

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

// One raw Stock Network /api/1.0/resort row's informational fields. `snCountry`
// (not `country`) keeps clear of the hub's own tree-computed country: the hub
// location tree is master for location (Jean, 2026-09-29).
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

// The first non-empty value under any of `keys` on `obj`, or "".
function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
const NAME_KEYS = ["name", "resortName", "ResortName", "Resort", "resort", "title", "Name", "ResortTitle"];
// The "Added from Stock Network" list in admin keeps this many, newest first.
const ADDED_KEEP = 500;
const realCoord = (r) => typeof r.latitude === "number" && typeof r.longitude === "number" && !(r.latitude === 0 && r.longitude === 0);

// A new resort-list row for a Stock Network property the hub doesn't have yet
// (Jean, 2026-10-17: the nightly sync adds new properties itself). Location in
// the hub comes from its pin and the hub location tree (the master); the rest
// is what Stock Network sends. Null when the row has no name.
function newResortRow(apiRow, resortId, at) {
  const name = pickFirst(apiRow, NAME_KEYS);
  if (!name) return null;
  const has = realCoord(apiRow);
  return Object.assign({ name, siteId: pickSite(siteFieldsOf(apiRow)).siteId, resortId,
    latitude: has ? String(apiRow.latitude) : "", longitude: has ? String(apiRow.longitude) : "" }, mapApiRowToRawFields(apiRow), { addedFromSnAt: at });
}

// rows: raw /api/1.0/resort rows (the nightly sync), or rows from Stock
// Network's resort file in the same shape (admin's "Add from Stock Network's
// file", Jean 2026-10-20). opts.addOnly: only add properties the hub doesn't
// have; never change one it has. opts.dryRun: say what would be added, save nothing.
async function handleApiSync(body, store, cors, opts = {}) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ ok: false, error: "No rows supplied." }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const record = await store.get("current", { type: "json" });
  const resorts = record && Array.isArray(record.resorts) ? record.resorts : [];

  // The same physical property can be listed under more than one SiteID:
  // one API row updates every resort-list row sharing that ResortID (matched
  // without regard to upper/lower case, so a property is never added twice).
  const idKey = (v) => String(v || "").trim().toLowerCase();
  const byResortId = new Map();
  resorts.forEach((r, i) => {
    if (!r || !r.resortId) return;
    const k = idKey(r.resortId);
    if (!byResortId.has(k)) byResortId.set(k, []);
    byResortId.get(k).push(i);
  });
  // ResortIDs admin removed from the hub ("Remove from hub"): never added again.
  const pendingNewStore = getStore({ name: "resort-pending-new", consistency: "strong" });
  const pendingNew = (await pendingNewStore.get("current", { type: "json" })) || {};
  const dismissedIds = Array.isArray(pendingNew.dismissedIds) ? pendingNew.dismissedIds : [];
  const dismissedSet = new Set(dismissedIds.map(idKey));
  const syncAt = new Date().toISOString();

  let matchedProperties = 0,
    matchedRows = 0,
    unmatchedApiRows = 0,
    addedProperties = 0,
    skippedNoName = 0,
    skippedRemoved = 0,
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
  // Properties added this sync (Jean, 2026-10-17): every Stock Network
  // property the hub doesn't have yet is added, unless admin removed it.
  const added = [];

  for (const apiRow of rows) {
    const resortId = String(apiRow.iExchangeResortFileID || "").trim();
    if (!resortId) continue;
    const idxs = byResortId.get(idKey(resortId));
    if (!idxs || !idxs.length) {
      unmatchedApiRows++;
      if (dismissedSet.has(idKey(resortId))) { skippedRemoved++; continue; }
      const rec = newResortRow(apiRow, resortId, syncAt);
      if (!rec) { skippedNoName++; continue; }
      if (opts.source) rec.addedFrom = opts.source;
      const i = resorts.push(rec) - 1;
      byResortId.set(idKey(resortId), [i]);
      if (rec.latitude) changedIdxs.push(i);
      addedProperties++;
      added.push({ resortId, name: rec.name, siteId: rec.siteId, snCountry: rec.snCountry, area: rec.area, city: rec.city,
        latitude: rec.latitude ? Number(rec.latitude) : null, longitude: rec.longitude ? Number(rec.longitude) : null, addedAt: syncAt, from: opts.source || undefined });
      continue;
    }
    matchedProperties++;
    if (opts.addOnly) continue;
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

  if (opts.dryRun) {
    return new Response(JSON.stringify({ ok: true, dryRun: true, totalRows: rows.length, alreadyInHub: matchedProperties, skippedRemoved, skippedNoName,
      toAdd: added.map((a) => ({ resortId: a.resortId, name: a.name, city: a.city, area: a.area })) }), { headers: { "content-type": "application/json", ...cors } });
  }

  // Name check for every property whose coordinate just changed (see the
  // import note at the top). Its place in the location tree is set by
  // placeTreeBacklog below.
  let nameChecked = 0,
    nameCheckSkippedForTime = 0,
    nameCheckNoApiKey = false;

  if (changedIdxs.length) {
    const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
    if (!apiKey) {
      nameCheckNoApiKey = true;
    } else {
      const targets = changedIdxs.filter((i) => {
        const rec = resorts[i];
        if (!rec) return false;
        const lat = parseFloat(rec.latitude);
        const lng = parseFloat(rec.longitude);
        return isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
      });

      if (targets.length) {

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
            nameCheckSkippedForTime++;
            return;
          }
          const rec = resorts[i];
          const lat = parseFloat(rec.latitude);
          const lng = parseFloat(rec.longitude);
          const nameCheck = await checkNameAgainstCoordinate(rec.name, lat, lng, apiKey);
          nameChecked++;
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

      }
    }
  }

  stripOldZoneTags(resorts);
  await store.setJSON(
    "current",
    Object.assign({}, record, { resorts, updatedAt: syncAt }, opts.source ? {} : { apiSyncedAt: syncAt })
  );

  // New location tree (2026-10-07): place any property that is new or whose pin
  // moved, plus a little backlog, in the "tree-places" store. Best-effort: a
  // failure here never fails the sync, and anything left over is picked up next
  // night or with "Place now" on the lookup page.
  const treePlace = await placeTreeBacklog(resorts);

  // Admin's "Added from Stock Network" list: this run's additions first, then
  // earlier ones (kept for a while so admin can look back).
  const earlier = (Array.isArray(pendingNew.items) ? pendingNew.items : []).filter((it) => it && it.addedAt);
  await pendingNewStore.setJSON("current", {
    items: added.concat(earlier).slice(0, ADDED_KEEP),
    dismissedIds,
    lastRun: opts.source ? pendingNew.lastRun : { at: syncAt, added: addedProperties, skippedNoName, skippedRemoved },
    updatedAt: syncAt,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      totalApiRows: rows.length,
      matchedProperties,
      matchedRows,
      unmatchedApiRows,
      addedProperties,
      skippedNoName,
      skippedRemoved,
      coordinatesChanged,
      nameChecked,
      nameCheckSkippedForTime,
      nameCheckNoApiKey,
      coordFlaggedSuspicious,
      coordFlagCleared,
      coordProtectedFromOverwrite,
      coordAwaitingSn,
      snCoordCaughtUp,
      treePlace,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
}

async function placeTreeBacklog(resorts) {
  try {
    const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
    if (!apiKey) return { skipped: "no api key" };
    return await placeResortBacklog(getStore({ name: PLACES_STORE, consistency: "strong" }), resorts, apiKey, 6000);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-sync-secret",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const store = getStore({ name: "resort-list", consistency: "strong" });
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  const deny = (msg) => new Response(JSON.stringify({ ok: false, error: msg }), { status: 403, headers: { "content-type": "application/json", ...cors } });
  try {
    if (request.method === "GET") {
      // The complexes, resorts and estates that exist, for the listing form (Jean, 2026-10-17).
      if (new URL(request.url).searchParams.get("estates")) {
        return new Response(JSON.stringify({ ok: true, types: ESTATE_TYPES, estates: await estateNames() }), { headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
      }
      const record = await store.get("current", { type: "json" });
      const list = record && Array.isArray(record.resorts) ? record.resorts : [];
      // Each property's complex, resort or estate, where it has one: estate { n: name, t: type }.
      const est = (await estatesMap().catch(() => null) || {}).byResort || {};
      const resorts = list.map((r) => { const e = r && r.resortId && est[String(r.resortId).toLowerCase()]; return e ? { ...r, estate: { n: e.n, t: e.t } } : r; });
      const updatedAt = (record && record.updatedAt) || null;
      return new Response(JSON.stringify({ resorts, updatedAt, count: resorts.length }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    if (request.method === "POST") {
      // The nightly Stock Network sync (stocknetwork-sync.mjs) writes the resort
      // list: { action: "syncStockNetworkApi", rows: [raw /api/1.0/resort rows] }
      // with the shared secret. It updates Stock Network's own fields, adds
      // properties the hub doesn't have yet, and never touches the hub's location
      // tree (the master). Admin's resort file (below) only adds.
      let body;
      try { body = await request.json(); } catch (e) { return deny("The resort list is updated every night from Stock Network."); }
      // Admin's "Add from Stock Network's file" (Jean, 2026-10-20): Stock Network's
      // list sometimes leaves a property out; its resort file has it. Adds only.
      if (body.action === "addFromFile") {
        if (!(await isAdminToken(body.token))) return new Response(JSON.stringify({ ok: false, error: "Log in to Admin again." }), { status: 401, headers: { "content-type": "application/json", ...cors } });
        return handleApiSync(body, store, cors, { addOnly: true, dryRun: body.dryRun === true, source: "file" });
      }
      const secret = env("PA_SYNC_SECRET");
      if (!secret || request.headers.get("x-sync-secret") !== secret) return deny("The resort list is updated every night from Stock Network.");
      return handleApiSync(body, store, cors);
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

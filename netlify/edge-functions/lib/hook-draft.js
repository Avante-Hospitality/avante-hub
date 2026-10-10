// Shared "build a hook draft from a property or area" logic — the exact
// same behavior admin-api.js's generateHookDraft action has always used
// for the Default Hooks Auto-build feature, pulled out here so hook-api.js
// can offer the identical self-managed equivalent for affiliates in
// hub.html without duplicating ~150 lines (and, more importantly, without
// the two copies silently drifting apart over time). admin-api.js's own
// generateHookDraft action now just calls this and shapes the JSON
// response the same way it always returned.
//
// Every field this returns is sourced from real StockNetwork data
// (fetchResortInfo's scrape) or Claude's caption drafted directly from
// that scraped content — nothing here invents property details, per the
// no-invented-flyer-content rule the rest of this app already follows.
import { fetchResortInfo, draftHookCaption } from "./hook-source.js";
import { generateHashtags } from "./hashtag-helper.js";
import { ADMIN_MASTER_SITE_GUID, holidayBuilderUrl } from "./booking-link.js";
import { commonTreeOpts } from "./tree-place.js";
import { resortKey } from "./resort-key.js";

// The most properties a single "selection" draft (explicit resortKeys —
// see below) will ever fetch info for in one go. A picked whole suburb/
// town/zone can easily match more StockNetwork rows than anyone actually
// wants in one flyer/caption; this is a sanity ceiling, not a design
// target — the tree UI itself is expected to nudge toward sane campaign
// sizes, this just stops a mis-click from firing 200 scrape requests.
const MAX_SELECTION_PROPERTIES = 24;

// Attaches a resort-list row's own real latitude/longitude (Jean's CSV
// import, geocoded the same way every property/activity coordinate in this
// app is — see map-api.js) onto a fetchResortInfo() scrape result, which
// carries no location data of its own (StockNetwork's ResortInfo page has
// no lat/long field, same story as it having no static rate field). Added
// 2026-09-23 for the landing-page feature's distance-matching to Map &
// Activities (lib/geo-distance.js) — real coordinates, never guessed, left
// off entirely when the resort-list row itself has none on file.
function withCoords(info, row) {
  if (!info || !row) return info;
  const lat = parseFloat(row.latitude);
  const lng = parseFloat(row.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return info;
  return { ...info, latitude: String(lat), longitude: String(lng) };
}

// resortStore: the "resort-list" Netlify Blobs store (read-only here).
// input: { resortId?, siteId?, query?, resortKeys?, label?, bookingSiteGuid? }
// — bookingSiteGuid is the placeholder StockNetwork site GUID to build the
// booking link against (ADMIN_MASTER_SITE_GUID for an admin default hook,
// so hook-api.js's existing personalizeStockNetworkUrl can re-attribute it
// per-viewer the same way it already does; an affiliate's own real
// StockNetwork site GUID for a self-managed hook, which needs no
// re-attribution since it's already that affiliate's own link).
//
// resortKeys (new): an explicit list of "resortId|siteId" strings — from
// the Auto-build "Browse properties by location" checkbox tree, where the
// admin/affiliate ticked one or more individual properties and/or whole
// suburbs/towns/areas (each a shortcut for "every property currently
// listed there"). This is the "campaign across several properties/an
// area" path Jean asked for — distinct from the older free-text `query`
// area mode below, which guesses at a district by substring match;
// resortKeys is an exact, already-resolved list, so no guessing happens
// here at all. `label` is the human-readable description of the
// selection the tree already computed client-side (e.g. "Hermanus (all),
// Voëlklip" or "3 properties") — used as-is for the draft's label/
// locationLabel, since the server has no town/suburb name data to
// reconstruct it from.
// Returns { ok: true, ...draft } or { ok: false, error, status }.
export async function buildHookDraft(resortStore, input) {
  const bodyResortId = typeof input.resortId === "string" ? input.resortId.trim() : "";
  const bodySiteId = typeof input.siteId === "string" ? input.siteId.trim() : "";
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const resortKeys = Array.isArray(input.resortKeys)
    ? input.resortKeys.filter((k) => typeof k === "string" && k.trim()).slice(0, MAX_SELECTION_PROPERTIES)
    : [];
  const selectionLabel = typeof input.label === "string" ? input.label.trim() : "";
  const bookingSiteGuid = input.bookingSiteGuid || ADMIN_MASTER_SITE_GUID;

  if (!bodyResortId && !query && !resortKeys.length) {
    return { ok: false, error: "Type or pick a property or area first.", status: 400 };
  }

  let mode = "property";
  let label = query;
  let locationLabel = "";
  let sources = [];
  // Which properties the draft is about, for the booking link's tree path.
  let sourceResortIds = [];

  if (resortKeys.length) {
    mode = "selection";
    const listRecord = await resortStore.get("current", { type: "json" });
    const allResorts = listRecord && Array.isArray(listRecord.resorts) ? listRecord.resorts : [];
    const wantedKeys = new Set(resortKeys);
    const matches = allResorts.filter((r) => wantedKeys.has(resortKey(r)));
    if (!matches.length) {
      return { ok: false, error: "None of the selected properties could be found — try re-picking from the tree.", status: 404 };
    }
    const fetched = await Promise.all(matches.map((r) => fetchResortInfo(r.resortId, r.siteId)));
    sources = fetched.map((info, i) => withCoords(info, matches[i])).filter(Boolean);
    if (!sources.length) {
      return { ok: false, error: "Couldn't load info for the selected properties right now. Try again shortly.", status: 502 };
    }
    sourceResortIds = matches.map((r) => r.resortId);
    locationLabel = selectionLabel || (sources.length === 1 ? sources[0].name || "" : sources.length + " properties");
    label = sources.length === 1 ? sources[0].name || locationLabel : locationLabel;
    if (sources.length === 1) mode = "property";
  } else if (bodyResortId) {
    const info = await fetchResortInfo(bodyResortId, bodySiteId);
    if (!info) {
      return { ok: false, error: "Couldn't load that property's info page. Try again, or pick a different one.", status: 502 };
    }
    // This path is an already-known resortId+siteId (no search needed), so
    // the resort-list row is only looked up for its own coordinates, same
    // withCoords helper as every other path.
    const listRecordForId = await resortStore.get("current", { type: "json" });
    const allResortsForId = listRecordForId && Array.isArray(listRecordForId.resorts) ? listRecordForId.resorts : [];
    const rowForId = allResortsForId.find((r) => r.resortId === bodyResortId && (!bodySiteId || r.siteId === bodySiteId));
    sources = [withCoords(info, rowForId)];
    sourceResortIds = [bodyResortId];
    label = info.name || label;
  } else {
    const listRecord = await resortStore.get("current", { type: "json" });
    const allResorts = listRecord && Array.isArray(listRecord.resorts) ? listRecord.resorts : [];
    const queryLower = query.toLowerCase();

    let propertyMatch = allResorts.find((r) => r.name && r.name.toLowerCase() === queryLower);
    // Only fall back to a loose "name contains this text" match if there
    // isn't an exact area match available — see admin-api.js's original
    // generateHookDraft for the "63 Milkwood Knysna" story this guards
    // against.
    if (!propertyMatch) {
      const hasExactDistrictMatch = allResorts.some((r) => r.district && r.district.toLowerCase() === queryLower);
      if (!hasExactDistrictMatch) {
        propertyMatch = allResorts.find((r) => r.name && r.name.toLowerCase().includes(queryLower));
      }
    }

    if (propertyMatch) {
      label = propertyMatch.name;
      const info = await fetchResortInfo(propertyMatch.resortId, propertyMatch.siteId);
      if (!info) {
        return { ok: false, error: "Couldn't load that property's info page. Try again, or pick a different one.", status: 502 };
      }
      sources = [withCoords(info, propertyMatch)];
      sourceResortIds = [propertyMatch.resortId];
    } else {
      mode = "area";
      let matches = allResorts.filter((r) => r.district && r.district.toLowerCase() === queryLower);
      if (!matches.length) {
        matches = allResorts.filter((r) => r.district && r.district.toLowerCase().includes(queryLower));
      }
      if (!matches.length) {
        return { ok: false, error: 'Couldn\'t find a property or area matching "' + query + '" in the resort list.', status: 404 };
      }

      // StockNetwork lists the same physical resort under multiple
      // SiteIDs — dedupe by ResortID so an area draft draws on distinct
      // properties, not the same one three times.
      const seenResortIds = new Set();
      const distinct = [];
      for (const r of matches) {
        if (!r.resortId || seenResortIds.has(r.resortId)) continue;
        seenResortIds.add(r.resortId);
        distinct.push(r);
        if (distinct.length >= 5) break;
      }

      const fetched = await Promise.all(distinct.map((r) => fetchResortInfo(r.resortId, r.siteId)));
      sources = fetched.map((info, i) => withCoords(info, distinct[i])).filter(Boolean);
      if (!sources.length) {
        return { ok: false, error: "Couldn't load property info for that area right now. Try again shortly.", status: 502 };
      }
      sourceResortIds = matches.map((r) => r.resortId);
    }
  }

  // Every mode ends up with a sensible locationLabel — the "selection"
  // path already set its own (from the tree's computed summary, or a
  // property/property-count fallback); property and area (free-text
  // query) modes never had a separate notion of "location" from "label"
  // to begin with, so the same string does double duty there, same as
  // before this field existed.
  if (!locationLabel) locationLabel = label;

  const caption = await draftHookCaption({ mode: mode, label: label, sources: sources });
  const hashtags = caption ? await generateHashtags(caption) : null;

  const photos = [];
  outer: for (const s of sources) {
    for (const url of s.images) {
      if (!photos.includes(url)) photos.push(url);
      if (photos.length >= 12) break outer;
    }
  }

  // Dates default to one month out for a one-night stay — a viewer picks
  // their own dates on the landing page before booking; this is only the
  // fallback if they don't.
  const today = new Date();
  const checkIn = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()));
  const checkOut = new Date(checkIn.getTime() + 86400000);
  const fmtDate = (d) => d.toISOString().slice(0, 10);
  // Holiday builder search screen for this site, with the location tree
  // path of what the draft is about (one property: its full path and name;
  // an area or selection: the levels all its properties share) and dates.
  // See lib/booking-link.js. Falls back to the label as a plain destination.
  let tree = {};
  try {
    const ids = [...new Set(sourceResortIds.filter(Boolean))];
    tree = await commonTreeOpts(ids, input.origin || "https://go.avantetravel.co.za");
    if (ids.length === 1) tree.resortId = ids[0];
  } catch (e) {
    tree = {};
  }
  const booking = holidayBuilderUrl(bookingSiteGuid, {
    ...tree,
    destination: tree.country ? "" : label,
    checkIn: fmtDate(checkIn),
    checkOut: fmtDate(checkOut),
  });

  const description = sources.map((s) => s.description).filter(Boolean).join(" ");
  const attractions = sources.map((s) => s.attractions).filter(Boolean).join(" ");
  const roomType = sources.length === 1 ? sources[0].roomType || "" : "";
  const sourceNames = sources.map((s) => s.name).filter(Boolean);
  // The first source with real coordinates on file — a single-property
  // draft always has at most one, an area/selection draft picks whichever
  // matched property happened to have coordinates first. Used for the
  // landing page feature's distance-matching to Map & Activities; left
  // blank (never guessed) when nothing in `sources` has coordinates.
  const withCoordsSource = sources.find((s) => s && s.latitude && s.longitude);
  const latitude = withCoordsSource ? withCoordsSource.latitude : "";
  const longitude = withCoordsSource ? withCoordsSource.longitude : "";

  return {
    ok: true,
    mode: mode,
    latitude: latitude,
    longitude: longitude,
    label: label,
    locationLabel: locationLabel,
    caption: caption || "",
    captionGenerated: !!caption,
    hashtags: hashtags,
    booking: booking,
    photos: photos,
    sourceCount: sources.length,
    sourceNames: sourceNames,
    description: description,
    attractions: attractions,
    roomType: roomType,
  };
}

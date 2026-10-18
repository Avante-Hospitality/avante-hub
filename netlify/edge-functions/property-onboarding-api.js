import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
// v10 for the Site Nr register only: v8 ignores { onlyIfNew }, which the
// register needs so two requests can't take the same number.
import { getStore as getStoreV10 } from "https://esm.sh/@netlify/blobs@10?bundle";
import { emailList, badEmails, emailText, recipients } from "./lib/emails.js";
import { sendEmail } from "./lib/send-email.js";
// SheetJS from its own CDN (the build SheetJS recommends for Deno).
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import { SITE_REGISTER_STORE, SITE_STATUSES, DEFAULT_SN_SETUP_EMAILS, newEntry, reserveNextSiteNr, reserveSiteNr, getSiteNr, saveSiteNr,
  listSiteNrs, nextFreeSiteNr, findOpenRequest, requestSheetBase64, sheetFileName, setupEmail, confirmationEmail, welcomeEmail, WAITING_FOR_LISTING } from "./lib/sn-site-register.js";
import { readListingScreenshots } from "./lib/listing-reader.js";
import { HOOKS_URL, makeHooksTicket } from "./lib/hooks-ticket.js";
import { isAdminToken } from "./lib/admin-session.js";
import { isAffiliateSession } from "./lib/affiliate-session.js";
import { createPropertyAffiliate } from "./lib/affiliates.js";
import { SNClient } from "./lib/sn-client.js";
import { readResortInfo, copySnPhotos } from "./lib/sn-resort-info.js";
import { findSetUps, feedByBbid, feedRowByResort, fillFromFeed, typeNames, learnTypeName, typeCodeOf } from "./lib/sn-feed.js";
import { forwardGeocode, reverseGeocode } from "./lib/geocode.js";
import { searchPlacePhotos, searchPlaceCandidates } from "./lib/places-images.js";
import { placeCoordinate, snFieldsFromPlace, placeText, PLACES_STORE, PROPERTY_KEY } from "./lib/tree.js";
import { estateTypeOf, forgetEstates } from "./lib/estates.js";

// Backs the "Property Affiliate" onboarding tab in hub.html and the
// "Property Listings" tab in admin.html. A property owner (or an existing
// travel affiliate acting as their mandated agent) submits a listing here;
// it's stored with status "Requested" for Avante to review. Admin can edit the
// listing details and change status to "Listed" (approved, live) or
// "Rejected" at any point. There is no separate listing agreement (Jean,
// 2026-10-17): accepting the Avante Hospitality Terms & Conditions when the
// listing is submitted covers every kind of property. Nothing here auto-publishes a listing
// anywhere else — it only records/tracks it.

function clean(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max || 500) : "";
}

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br(v) {
  return escapeHtml(v).replace(/\n/g, "<br>");
}

function genListingId() {
  const n = Math.floor(Math.random() * 900000) + 100000;
  return "P-" + n;
}

function genToken() {
  try {
    return (
      crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
    );
  } catch (e) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}

const STATUSES = ["Requested", "Listed", "Rejected"];

// Fields an admin is allowed to edit via the "updateListing" action. This is
// deliberately the core identifying/contact/descriptive information plus the
// commercial terms — not the large nested unitTypes/amenities/documents/images
// arrays, which stay as originally submitted for now.
const EDITABLE_FIELDS = [
  "propertyName", "propertyName2", "country", "suburb", "city", "city2",
  "stateProvince", "area", "district", "propertyType", "complexName", "inEstate", "estateType",
  "infoLink", "bookingLink", "telephone", "email", "latitude", "longitude",
  "selfSupplierRating", "tourismBoardGrading", "ratingLink",
  "ownerFullName", "ownerIdPassport", "ownerEmail", "ownerPhone",
  "checkInTime", "checkOutTime", "description", "houseRules", "moreInfo",
  "areaInfo", "depositPolicyText", "depositPct", "depositDays", "childPolicy",
  "streetAddress", "siteId", "region", "sourceChannel", "channelListingLink",
  "channelReviews", "hostName", "accessibility", "icalLink",
  // Contact person for bookings and queries, and who gets the hub's emails (Jean, 2026-10-14).
  "contactName", "contactPhone", "contactEmail", "notifyWho",
];

const EDITABLE_FIELD_MAX = {
  description: 4000, houseRules: 4000, moreInfo: 4000, areaInfo: 4000,
  depositPolicyText: 2000, childPolicy: 1000,
  // Email fields hold several addresses, separated by commas.
  email: 600, ownerEmail: 600, contactEmail: 600, contactPhone: 200, telephone: 200, ownerPhone: 200,
};
const EMAIL_FIELDS = { ownerEmail: "Owner email", email: "Property email", affiliateEmail: "Affiliate email", contactEmail: "Contact person email" };
// The first email field with an address that isn't valid, as a message; "" when all are fine.
function emailFieldError(rec) {
  for (const k of Object.keys(EMAIL_FIELDS)) {
    const bad = badEmails(rec[k]);
    if (bad.length) return EMAIL_FIELDS[k] + ": \"" + bad[0] + "\" doesn't look like an email address. Separate several addresses with a comma.";
  }
  return "";
}
const NOTIFY_WHO = ["owner", "contact", "both"];

function sanitizeUnitTypes(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 30).map((u) => ({
    name: clean(u && u.name, 200),
    maxOccupancy: clean(u && u.maxOccupancy, 10),
    maxAdults: clean(u && u.maxAdults, 10),
    childrenAllowed: clean(u && u.childrenAllowed, 5),
    numUnits: clean(u && u.numUnits, 10),
    rateScheme: clean(u && u.rateScheme, 30),
    rateBasis: clean(u && u.rateBasis, 30),
    seasonStart: clean(u && u.seasonStart, 20),
    seasonEnd: clean(u && u.seasonEnd, 20),
    ratePax1: clean(u && u.ratePax1, 20),
    ratePax2: clean(u && u.ratePax2, 20),
    ratePax3: clean(u && u.ratePax3, 20),
    ratePax4: clean(u && u.ratePax4, 20),
    ratePax5: clean(u && u.ratePax5, 20),
    childRate06: clean(u && u.childRate06, 20),
    childRate712: clean(u && u.childRate712, 20),
    description: clean(u && u.description, 2000),
  }));
}

function sanitizeAmenities(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 400).map((a) => ({
    category: clean(a && a.category, 100),
    item: clean(a && a.item, 150),
    available: (a && a.available) === "Y" ? "Y" : "N",
    notes: clean(a && a.notes, 300),
  }));
}

function sanitizeFileRefs(input, max) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, max || 60).map((f) => ({
    type: clean(f && f.type, 100),
    unitTypeName: clean(f && f.unitTypeName, 200),
    key: clean(f && f.key, 300),
    fileName: clean(f && f.fileName, 200),
    caption: clean(f && f.caption, 300),
    cover: (f && f.cover) === "Y" ? "Y" : "N",
  }));
}

// The hub location tree is the master for a property's place names
// (Jean, 2026-10-13): Country, Province, Region, City/Town, Suburb, and the
// Stock Network Area / District, all come from placing the pin in the tree —
// never from what an owner types or what a channel shows. Only admin can
// override them.
const LOCATION_FIELDS = ["country", "stateProvince", "region", "city", "suburb", "district", "area"];
function treeFields(place) {
  const sn = snFieldsFromPlace(place);
  return {
    country: sn.country, stateProvince: sn.state,
    region: (place.r || []).filter((x) => x && !/^\(/.test(x)).join(" / "),
    city: sn.city, suburb: sn.suburb, district: sn.district, area: sn.area,
  };
}
async function placeInTree(lat, lng) {
  const la = Number(lat), lo = Number(lng);
  if (!validCoord(la, lo)) return null;
  const r = await placeCoordinate(la, lo, Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "");
  return r && r.ok ? r.place : null;
}
// Puts the tree's place on the record (location fields too unless an admin
// chose their own) and keeps it in the hub's live placements store, the same
// way Admin's "Place in the location tree" lookup does for a listing.
async function applyTreePlace(record, place, keepTypedLocation) {
  if (!place) return;
  record.treePlace = place;
  record.treePlaceText = placeText(place);
  if (!keepTypedLocation) Object.assign(record, treeFields(place));
  // A property already on Stock Network is in the tree under its own Resort
  // ID; don't add it a second time as a listing.
  if (record.resortId) return;
  try {
    const store = getStore({ name: PLACES_STORE, consistency: "strong" });
    const map = (await store.get(PROPERTY_KEY, { type: "json" })) || {};
    map["listing:" + record.listingId] = place;
    await store.setJSON(PROPERTY_KEY, map);
  } catch (e) {
    // The listing itself is still saved; admin can re-place it from the listing.
  }
}

// Builds (doesn't save) a listing for a property that is already on Stock
// Network, from what the hub and Stock Network have (Jean, 2026-10-13): used by
// Admin (Site Nr + Site ID, or the list of connected properties) and by the
// public "List your property" page (NightsBridge BBID). Place names come only
// from the hub location tree.
//   pr:  { site, siteId, resortId, resortName, aff, units, settings, channel, typedSiteId, siteIdForListing }
//   row: the property's row in the hub's Stock Network list (resort-list)
async function buildListingFromSn(pr, row, opts = {}) {
  const st = pr.settings || {};
  const yn = (v) => /^(y|yes|true|1)$/i.test(String(v || "").trim()) ? "Y" : "N";
  // What Stock Network shows publicly: description, facilities, unit
  // types with sleeps, photos (Jean: get it by API, seamless — no retyping).
  const sn = pr.resortId ? await readResortInfo(pr.resortId) : { ok: false };
  const snUnits = sn.ok ? sn.units : [];
  const units = snUnits.length
    ? snUnits.map((u) => ({ name: u.name, numUnits: "1", maxOccupancy: u.maxGuests ? String(u.maxGuests) : "", description: u.description || u.roomType || "" }))
    : (pr.units || []).map((u) => ({ name: u.name, numUnits: "1", maxOccupancy: u.size ? String(u.size) : "",
        description: st.prices && st.prices[u.name] ? "Hub price: R" + st.prices[u.name] + " a night" : "" }));
  const now = new Date().toISOString();
  const listingId = genListingId();
  const record = Object.assign({ listingId, status: opts.status || "Listed", dateSubmitted: now, dateUpdated: now }, submittedFields({
    description: sn.ok ? sn.about : "", areaInfo: sn.ok ? sn.attractions : "",
    propertyName: pr.resortName || row.name || "", propertyType: row.propertyType || "",
    // Place names never come from Stock Network: the hub location tree is
    // the master (Jean, 2026-10-13). Only the coordinates are taken; the
    // tree places the property from them below.
    latitude: row.latitude || "", longitude: row.longitude || "",
    telephone: st.phone || "", email: st.email || "",
    checkInTime: row.checkinTime || "", checkOutTime: row.checkoutTime || "",
    selfSupplierRating: row.supplierRating || "", tourismBoardGrading: row.tourismBoardRating || "",
    allowSameDayBooking: yn(row.allowSameDayBooking) === "Y" ? "Y" : "N",
    siteNr: String(pr.site || ""), siteId: pr.typedSiteId || (pr.channel ? pr.siteIdForListing : (/^nr:/.test(pr.siteId) ? "" : pr.siteId)), affId: pr.aff || pr.typedSiteId || "", submittedBy: "Owner",
    unitTypes: units,
  }), {
    editToken: genToken(), agreementSigned: "Y", existingOnSN: "Y", paSiteId: pr.channel || /^nr:/.test(pr.siteId) ? "" : pr.siteId, resortId: pr.resortId || "",
    snFacilities: sn.ok ? sn.facilities.slice(0, 80) : [],
    // Channel properties (NightsBridge etc.): rates and availability come
    // from their channel manager through Stock Network — no calendar or
    // rates in the hub, and commission on hub bookings is 4.95% + VAT.
    channelProperty: pr.channel ? "Y" : "", ratesFromChannel: pr.channel ? "Y" : "", commissionPct: pr.channel ? "4.95" : "",
  });
  // Everything else Stock Network's feed has (type, phone, email, links, times…).
  const fromFeed = await fillListingFromFeed(record).catch(() => []);
  if (row && row.propertyType && record.snTypeCode) await learnTypeName(record.snTypeCode, row.propertyType).catch(() => {});
  // Place names from the hub location tree (the master), as for any listing.
  const placed = await getStore({ name: PLACES_STORE, consistency: "strong" }).get(PROPERTY_KEY, { type: "json" }).catch(() => null);
  const place = (placed && pr.resortId && (placed[pr.resortId] || placed[String(pr.resortId).toLowerCase()])) || await placeInTree(record.latitude, record.longitude);
  await applyTreePlace(record, place, false);
  if (!place) record.needsTreePlace = "Y";   // admin places it (Place in the location tree)
  // Its pin was placed in the hub tree (by Google); the property can't move it.
  if (place) { record.coordsVerified = "Y"; record.coordsVerifiedPlace = record.treePlaceText || ""; record.coordsVerifiedAt = new Date().toISOString(); }
  if (sn.ok && sn.photos.length) record.images = await copySnPhotos(sn.photos, listingId, getStore({ name: "property-listing-files", consistency: "strong" }));
  addHistory(record, opts.by || "admin", (opts.historyNote || "Listing created from the property already on Stock Network") + " (Site Nr " + (pr.site || "?") + ")" +
    (sn.ok ? "; details, " + units.length + " unit type(s), " + record.snFacilities.length + " facilities and " + record.images.length + " photo(s) read from Stock Network" : "; Stock Network's page couldn't be read") +
    (fromFeed.length ? "; from Stock Network's feed: " + fromFeed.join(", ") : ""));
  return Object.assign(record, opts.extra || {});
}

// Everything Stock Network's own feed has for the property goes into the
// listing's EMPTY fields (Jean, 2026-10-14: pull all we can, then fill in only
// what isn't there). The property type: the hub knows the words for the
// feed's type code once it has seen them — typed on a listing, or on a resort
// list spreadsheet (Property Type column) for any property with the same code.
async function typeNameFor(code) {
  if (!code) return "";
  const names = await typeNames();
  if (names[code]) return names[code];
  try {
    const list = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" });
    const idx = await getStore({ name: "sn-feed", consistency: "strong" }).get("resort-index", { type: "json" });
    const votes = {};
    for (const r of (list && list.resorts) || []) {
      if (!r || !r.propertyType || !r.resortId) continue;
      const fr = idx && idx.byResort && idx.byResort[String(r.resortId).toLowerCase()];
      if (fr && typeCodeOf(fr) === code) votes[r.propertyType] = (votes[r.propertyType] || 0) + 1;
    }
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    if (best) { await learnTypeName(code, best[0]); return best[0]; }
  } catch (e) { /* not learnt yet */ }
  return "";
}
async function fillListingFromFeed(record) {
  if (!record.resortId) return [];
  const row = await feedRowByResort(record.resortId).catch(() => null);
  if (!row) return [];
  const code = typeCodeOf(row), names = await typeNames();
  if (code && !names[code]) { const t = await typeNameFor(code); if (t) names[code] = t; }
  return fillFromFeed(record, row, names);
}

// Straight-line distance in km between two coordinates (haversine).
function kmBetween(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

// The onboarding form is public (owners and affiliates use it without an
// admin login), and the screenshot / Google helpers below cost money per
// call — so each visitor gets a daily allowance per helper. Admin sessions
// (token) are not limited.
const DAILY_LIMITS = { readScreenshots: 40, lookupLocation: 120, verifyCoordinates: 120, findPhotos: 40, listingRequest: 10 };
async function overDailyLimit(kind, request, context) {
  try {
    const ip = (context && context.ip) || request.headers.get("x-nf-client-connection-ip") || "unknown";
    const key = kind + ":" + new Date().toISOString().slice(0, 10) + ":" + ip;
    const store = getStore({ name: "onboarding-helper-usage", consistency: "strong" });
    const n = Number(await store.get(key)) || 0;
    if (n >= (DAILY_LIMITS[kind] || 50)) return true;
    await store.set(key, String(n + 1));
  } catch (e) {
    // Never block a real person because the counter itself failed.
  }
  return false;
}

function sanitizeRateSeasons(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 200).map((r) => ({
    unitTypeName: clean(r && r.unitTypeName, 200),
    from: clean(r && r.from, 10),
    to: clean(r && r.to, 10),
    nights: clean(String((r && r.nights) || ""), 6),
    minStay: clean(String((r && r.minStay) || ""), 4),
    rackRate: clean(String((r && r.rackRate) || ""), 12),
    snRate: clean(String((r && r.snRate) || ""), 12),
  }));
}

function sanitizeDateList(input) {
  if (!Array.isArray(input)) return [];
  return input.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 800);
}

// Every field the onboarding form sends, cleaned — shared by "submit"
// (a new listing) and "update" (the same form reopened to edit it).
function submittedFields(body) {
  return {
    propertyName: clean(body.propertyName, 200),
    propertyName2: clean(body.propertyName2, 200),
    country: clean(body.country, 100),
    suburb: clean(body.suburb, 100),
    city: clean(body.city, 100),
    city2: clean(body.city2, 100),
    stateProvince: clean(body.stateProvince, 100),
    area: clean(body.area, 100),
    district: clean(body.district, 100),
    propertyType: clean(body.propertyType, 100),
    // In a complex, resort or estate? (Jean, 2026-10-17) "Y"/"N", its kind and its name.
    inEstate: body.inEstate === "Y" ? "Y" : body.inEstate === "N" ? "N" : "",
    estateType: body.inEstate === "N" ? "" : estateTypeOf(body.estateType),
    complexName: body.inEstate === "N" ? "" : clean(body.complexName, 200),
    infoLink: clean(body.infoLink, 300),
    bookingLink: clean(body.bookingLink, 300),
    siteNr: clean(body.siteNr, 30),
    telephone: clean(body.telephone, 60),
    email: clean(body.email, 600),
    latitude: clean(body.latitude, 30),
    longitude: clean(body.longitude, 30),
    selfSupplierRating: clean(body.selfSupplierRating, 50),
    tourismBoardGrading: clean(body.tourismBoardGrading, 50),
    ratingLink: clean(body.ratingLink, 300),

    // Added 2026-10-13 with the step-by-step form: street address, the
    // Stock Network Site ID (= the affiliate number the form was opened
    // with), whether the coordinates were checked against Google, and
    // the channel the details were imported from.
    streetAddress: clean(body.streetAddress, 300),
    siteId: clean(body.siteId || body.affId, 100),
    region: clean(body.region, 100),
    coordsVerified: body.coordsVerified === "Y" ? "Y" : "N",
    coordsVerifiedPlace: clean(body.coordsVerifiedPlace, 300),
    coordsVerifiedAt: body.coordsVerified === "Y" ? new Date().toISOString() : "",
    sourceChannel: clean(body.sourceChannel, 60),
    channelListingLink: clean(body.channelListingLink, 500),
    channelReviews: clean(body.channelReviews, 500),
    hostName: clean(body.hostName, 200),
    accessibility: clean(body.accessibility, 1000),
    notIncluded: clean(body.notIncluded, 1000),
    screenshotsRead: clean(String(body.screenshotsRead || ""), 4),
    icalLink: clean(body.icalLink, 600),
    rateSeasons: sanitizeRateSeasons(body.rateSeasons),
    blockedNights: sanitizeDateList(body.blockedNights),
    commissionPct: clean(String(body.commissionPct || ""), 8),

    ownerFullName: clean(body.ownerFullName, 200),
    ownerIdPassport: clean(body.ownerIdPassport, 60),
    ownerEmail: clean(body.ownerEmail, 600),
    ownerPhone: clean(body.ownerPhone, 60),

    submittedBy: body.submittedBy === "Affiliate" ? "Affiliate" : "Owner",
    affId: clean(body.affId, 100),
    affiliateAgentName: clean(body.affiliateAgentName, 200),
    affiliateCompany: clean(body.affiliateCompany, 200),
    affiliateEmail: clean(body.affiliateEmail, 600),
    contactName: clean(body.contactName, 200),
    contactPhone: clean(body.contactPhone, 200),
    contactEmail: clean(body.contactEmail, 600),
    notifyWho: NOTIFY_WHO.includes(body.notifyWho) ? body.notifyWho : "both",
    affiliatePhone: clean(body.affiliatePhone, 60),

    checkInTime: clean(body.checkInTime, 20),
    checkOutTime: clean(body.checkOutTime, 20),
    description: clean(body.description, 4000),
    houseRules: clean(body.houseRules, 4000),
    moreInfo: clean(body.moreInfo, 4000),
    areaInfo: clean(body.areaInfo, 4000),

    depositPolicyText: clean(body.depositPolicyText, 2000),
    depositPct: clean(body.depositPct, 10),
    depositDays: clean(body.depositDays, 10),
    childPolicy: clean(body.childPolicy, 1000),
    paymentGatewayInUse: body.paymentGatewayInUse === "Y" ? "Y" : "N",
    allowSameDayBooking: body.allowSameDayBooking === "Y" ? "Y" : "N",

    unitTypes: sanitizeUnitTypes(body.unitTypes),
    amenities: sanitizeAmenities(body.amenities),
    documents: sanitizeFileRefs(body.documents, 20),
    images: sanitizeFileRefs(body.images, 60),

    agreementSigned: body.agreementSigned === true ? "Y" : "N",
    signatoryName: clean(body.signatoryName, 200),
    signatoryCapacity: clean(body.signatoryCapacity, 100),
    signatoryIdPassport: clean(body.signatoryIdPassport, 60),
    signatureDate: clean(body.signatureDate, 20),
    signaturePlace: clean(body.signaturePlace, 200),
  };
}

// Change history (2026-10-13): every save keeps a dated entry of what
// changed, who changed it, and the old values, so nothing is lost when a
// listing or its rates are edited. Kept on the record, newest last, capped.
const HISTORY_MAX = 200;
const NO_HISTORY_KEYS = ["dateUpdated", "history", "editToken", "agreementToken"];
function addHistory(record, by, action, before) {
  const entry = { at: new Date().toISOString(), by: by, action: action };
  if (before) {
    const changed = {};
    Object.keys(before).forEach((k) => {
      if (NO_HISTORY_KEYS.indexOf(k) > -1) return;
      if (JSON.stringify(before[k]) === JSON.stringify(record[k])) return;
      let old = before[k];
      if (typeof old === "string" && old.length > 1500) old = old.slice(0, 1500) + "…";
      changed[k] = old === undefined ? "" : old;
    });
    if (!Object.keys(changed).length) return false;
    entry.changed = changed;
  }
  record.history = (Array.isArray(record.history) ? record.history : []).concat([entry]).slice(-HISTORY_MAX);
  return true;
}

const verifyAdminToken = isAdminToken;

// Email failures never break the listing submit/status flow.
async function sendNotificationEmail(to, subject, html) {
  await sendEmail({ to, subject, html });
}

async function getNotificationEmail() {
  return (await getSettings()).notificationEmail || "";
}

async function getSettings() {
  return (await getStore({ name: "property-settings", consistency: "strong" }).get("config", { type: "json" }).catch(() => null)) || {};
}
// Merges into the saved settings, so saving one setting keeps the others.
async function saveSettings(patch) {
  const settingsStore = getStore({ name: "property-settings", consistency: "strong" });
  // Read without hiding errors: saving on top of a failed read would wipe the other settings.
  const current = (await settingsStore.get("config", { type: "json" })) || {};
  await settingsStore.setJSON("config", Object.assign(current, patch));
}

// ---------- Stock Network set-up (Site Nr register, Jean 2026-10-15) ----------
const siteRegister = () => getStoreV10({ name: SITE_REGISTER_STORE, consistency: "strong" });
async function getSnSetupEmails() {
  return (await getSettings()).snSetupEmails || DEFAULT_SN_SETUP_EMAILS;
}
// Emails the Request_pull_area sheet for one Site Nr and logs the send on the
// register entry (failed ones too). `to` overrides the saved addresses.
// The property's private "Edit my listing" link and the email that sends it.
function editLinkEmail(record, origin) {
  if (!record.editToken) record.editToken = genToken();
  const link = origin + "/property-form.html?edit=" + encodeURIComponent(record.listingId) + "&key=" + encodeURIComponent(record.editToken);
  return { link, subject: "Please complete your Avante listing — " + (record.propertyName || ""),
    html: "<p>Hello,</p><p>Avante Travel has a new, fuller listing form for <strong>" + escapeHtml(record.propertyName || "your property") + "</strong>. We filled in what we already have.</p>" +
      "<p>Please open it, check everything and fill in what is missing (for example photos, amenities, policies and rates), then tap <b>Save changes</b> on the last step:<br><a href=\"" + link + "\">Edit my listing</a></p>" +
      "<p>Keep this email: you can use the link again any time. Anyone with this link can edit the listing, so don't share it.</p><p>Avante Travel</p>" };
}
// Email the edit link and keep a log of it on the listing (the caller saves the record).
async function emailEditLink(record, to, origin, by) {
  const m = editLinkEmail(record, origin);
  const sent = await sendEmail({ to, subject: m.subject, html: m.html });
  const at = new Date().toISOString(), toText = Array.isArray(to) ? to.join(", ") : to;
  record.editLinkLog = (Array.isArray(record.editLinkLog) ? record.editLinkLog : []).concat([{ at, to: toText, ok: sent.ok, error: sent.ok ? undefined : sent.error }]).slice(-50);
  record.history = (Array.isArray(record.history) ? record.history : []).concat([{ at, by, action: (sent.ok ? "Edit link emailed to " : "Edit link email FAILED to ") + toText }]).slice(-HISTORY_MAX);
  return sent;
}
// A link to the listing's photos for Stock Network (a private page,
// property-photos.js, opened with a random key kept on the listing), or "".
function photosLinkFor(record, origin) {
  const count = (record.images || []).filter((im) => im && im.key).length;
  if (!count) return { url: "", count };
  if (!record.photosToken) record.photosToken = [...crypto.getRandomValues(new Uint8Array(18))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { url: origin + "/api/property-photos?l=" + encodeURIComponent(record.listingId) + "&k=" + record.photosToken, count };
}
// Files built in the browser (sn-export.js filesForEmail), checked: at most 6, base64, 15 MB in all.
function cleanFiles(list) {
  const files = (Array.isArray(list) ? list : []).slice(0, 6)
    .map((f) => ({ filename: clean(f && f.filename, 150).replace(/[\\/:*?"<>|\r\n]/g, "_"), content: typeof (f && f.content) === "string" ? f.content.replace(/\s+/g, "") : "" }))
    .filter((f) => f.filename && f.content && /^[A-Za-z0-9+/=]+$/.test(f.content));
  const bytes = files.reduce((n, f) => n + Math.floor(f.content.length * 3 / 4), 0);
  return { files, tooBig: bytes > 15 * 1024 * 1024 };
}
// Rates sent to Stock Network: kept, so later only new or changed ones are sent.
function markRatesSent(record, at) {
  record.snSentSeasons = (record.rateSeasons || []).map((r) => Object.assign({}, r));
  record.snSentAt = at;
}

// Ready to go live (Jean, 2026-10-17): a set-up property not on a channel
// manager waits for stock until Avante's availability read (sn-availability.mjs,
// the next 12 months) finds a free unit. Answers the entries that just became ready.
const GO_LIVE = { waiting: "Waiting for stock", ready: "Ready to go live" };
async function checkStock(reg, origin) {
  const todo = (await listSiteNrs(reg)).filter((e) => e.status === "Set up" && e.resortId && e.channelManager === "None yet" && e.goLive !== GO_LIVE.ready).slice(0, 60);
  if (!todo.length) return [];
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const av = await fetch(origin + "/api/sn-availability", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: todo.map((e) => e.resortId), checkIn: day(Date.now()), checkOut: day(Date.now() + 365 * 864e5) }) }).then((r) => r.json()).catch(() => null);
  const results = (av && av.results) || {}, ready = [], listings = getStore({ name: "property-listings", consistency: "strong" });
  for (const e of todo) {
    const r = results[String(e.resortId).toLowerCase()];
    if (!r || r.error) continue; // not answered: try again next hour
    const now = new Date().toISOString();
    Object.assign(e, { goLive: r.firstOpen ? GO_LIVE.ready : GO_LIVE.waiting, stockCheckedAt: now, updatedAt: now });
    if (r.firstOpen) {
      Object.assign(e, { stockFrom: r.firstOpen, readyAt: now });
      ready.push(e);
      const rec = e.listingId ? await listings.get(e.listingId, { type: "json" }).catch(() => null) : null;
      if (rec) {
        const before = { goLive: rec.goLive || "" };
        Object.assign(rec, { goLive: GO_LIVE.ready, stockFrom: r.firstOpen, dateUpdated: now });
        addHistory(rec, "admin", "Ready to go live: Avante has stock from " + r.firstOpen, before);
        await listings.setJSON(e.listingId, rec);
      }
    }
    await saveSiteNr(reg, e);
  }
  return ready;
}

// The Site Nr entry still waiting for this listing to be complete, or null.
async function waitingSiteOf(record) {
  const e = record && record.siteNr ? await getSiteNr(siteRegister(), record.siteNr).catch(() => null) : null;
  return e && e.status === WAITING_FOR_LISTING && e.listingId === record.listingId ? e : null;
}

// more: { files: [{ filename, content (base64) }], extraHtml } sent along with the sheet.
async function sendSnSetupSheet(entry, by, to, more) {
  more = more || {};
  const recipientsTo = emailText(to || (await getSnSetupEmails()), 20);
  const filename = sheetFileName(entry);
  const { subject, html } = setupEmail(entry, more.extraHtml);
  let sent;
  try {
    sent = await sendEmail({ to: recipientsTo, subject, html, attachments: [{ filename, content: requestSheetBase64(XLSX, [entry]) }].concat(more.files || []), replyTo: "admin@avantehospitality.co.za" });
  } catch (e) {
    sent = { ok: false, error: "Could not make the sheet: " + String((e && e.message) || e) };
  }
  const at = new Date().toISOString();
  const file = [filename].concat((more.files || []).map((f) => f.filename)).join(", ");
  entry.sendLog = (Array.isArray(entry.sendLog) ? entry.sendLog : []).concat([{ at, by, to: recipientsTo, file, ok: sent.ok, error: sent.ok ? undefined : sent.error }]).slice(-50);
  if (sent.ok && (entry.status === "Spare" || entry.status === WAITING_FOR_LISTING)) entry.status = "Sent";
  entry.updatedAt = at;
  await saveSiteNr(siteRegister(), entry);
  return entry;
}
// Area / District / Suburb for the sheet from the hub location tree, when
// Google finds the property by its name (best effort: empty when the top
// match isn't clearly the same property; admin can fill them in).
async function guessSnLocation(name) {
  try {
    const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY") || "";
    const p = await searchPlaceCandidates(name + ", South Africa", placesKey, 1);
    const c = p && p.ok && p.candidates && p.candidates[0];
    const words = (v) => String(v || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
    if (!c || !words(c.name) || !(words(c.name).includes(words(name)) || words(name).includes(words(c.name)))) return {};
    const place = await placeInTree(c.lat, c.lng);
    if (!place) return {};
    const f = treeFields(place);
    return { area: f.area, district: f.district, suburb: f.suburb, place, lat: c.lat, lng: c.lng };
  } catch (e) {
    return {};
  }
}

// Who gets the hub's emails about a listing (Jean, 2026-10-14): the owner side
// (the owner, or the affiliate who submitted it), the contact person, or both
// (record.notifyWho). Returned as "a@x, b@y"; every address gets the email.
function submitterEmailFor(record) {
  const ownerSide = record.submittedBy === "Affiliate" ? record.affiliateEmail : record.ownerEmail;
  return recipients(ownerSide, record.contactEmail, record.notifyWho || "both").join(", ");
}

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const action = body.action;
  const store = getStore({ name: "property-listings", consistency: "strong" });

  const json = (data, status) =>
    new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "content-type": "application/json", ...cors },
    });

  const requireAdmin = async () => {
    const authed = await verifyAdminToken(body.token);
    if (!authed) return json({ error: "Not authenticated." }, 401);
    return null;
  };

  try {
    if (action === "submit") {
      const listingId = genListingId();
      const now = new Date().toISOString();

      const record = {
        listingId: listingId,
        status: "Requested",
        dateSubmitted: now,
        dateUpdated: now,

        ...submittedFields(body),
        editToken: genToken(),
      };

      const emailErr0 = emailFieldError(record);
      if (emailErr0) return json({ error: emailErr0 }, 400);
      if (!record.propertyName || !record.ownerFullName || record.agreementSigned !== "Y") {
        return json(
          { error: "Property name, owner name, and agreement acceptance are required." },
          400
        );
      }
      const submitAsAdmin = await verifyAdminToken(body.token);
      await applyTreePlace(record, await placeInTree(record.latitude, record.longitude), submitAsAdmin);
      addHistory(record, submitAsAdmin ? "admin" : record.submittedBy, "Submitted");

      await store.setJSON(listingId, record);
      await forgetEstates();

      // The person who submitted gets a private link to come back and edit
      // the listing (add next season's rates, fix details) at any time.
      const editLink = new URL(request.url).origin + "/property-form.html?edit=" + encodeURIComponent(listingId) + "&key=" + encodeURIComponent(record.editToken);
      const submitterTo = submitterEmailFor(record);
      if (submitterTo) {
        context.waitUntil(
          sendNotificationEmail(
            submitterTo,
            "Your Avante listing " + record.propertyName + " — your edit link",
            "<p>Thank you for listing <strong>" + escapeHtml(record.propertyName) + "</strong> (" + escapeHtml(listingId) + ") with Avante Travel. We'll be in touch once it's reviewed.</p>" +
              "<p>Keep this link to update the listing later — for example to add next season's rates:<br><a href=\"" + editLink + "\">Edit my listing</a></p>" +
              "<p>Anyone with this link can edit the listing, so don't share it.</p>"
          )
        );
      }

      const notifyTo = await getNotificationEmail();
      if (notifyTo) {
        context.waitUntil(
          sendNotificationEmail(
            notifyTo,
            "New property listing submitted — " + record.propertyName,
            "<p>A new property listing was submitted for review.</p>" +
              "<p><strong>Listing ID:</strong> " + escapeHtml(listingId) + "<br>" +
              "<strong>Property:</strong> " + escapeHtml(record.propertyName) + "<br>" +
              "<strong>Submitted by:</strong> " + escapeHtml(record.submittedBy) + " — " + escapeHtml(record.ownerFullName) + "<br>" +
              "<strong>Status:</strong> Requested</p>" +
              "<p>Log in to Admin &gt; Property Listings to review and approve.</p>"
          )
        );
      }

      return json({ ok: true, listingId: listingId, editLink: editLink });
    }

    if (action === "getForEdit" || action === "update" || action === "sendForSetUp" || action === "markSentToSN" || action === "emailSNFiles" || action === "libraryAdd" || action === "addPhotos" || action === "removePhoto") {
      // Reopen a listing in the onboarding form: admin (token) or the
      // submitter with their private edit key.
      const listingId = clean(body.listingId, 20);
      if (!listingId) return json({ error: "missing listingId" }, 400);
      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "This listing wasn't found." }, 404);
      const isAdmin = await verifyAdminToken(body.token);
      const keyOk = !!record.editToken && clean(body.key, 200) === record.editToken;
      if (!isAdmin && !keyOk) return json({ error: "This edit link isn't valid. Ask Avante Travel for a new one." }, 401);
      if (["markSentToSN", "emailSNFiles", "libraryAdd", "addPhotos", "removePhoto"].includes(action) && !isAdmin) return json({ error: "Only Avante admin can do this." }, 401);

      if (action === "getForEdit") {
        const out = Object.assign({}, record);
        delete out.agreementToken;
        delete out.editToken;
        if (!isAdmin) { delete out.history; delete out.photosToken; }
        return json({ ok: true, listing: out, asAdmin: isAdmin, waitingForSetUp: !!(await waitingSiteOf(record)) });
      }

      if (action === "sendForSetUp") {
        // Jean (2026-10-17): a property not on a channel manager completed its
        // listing (Ready check all Done). The form sends the property and rates
        // files it built (sn-export.js); the hub emails them with Stock
        // Network's sheet and a link to the photos to the SN set-up addresses.
        // The hourly check then picks the property up once it's set up.
        const site = await waitingSiteOf(record);
        if (!site) return json({ ok: true, already: true });
        const { files, tooBig } = cleanFiles(body.files);
        if (!files.length) return json({ error: "The property and rates files are missing. Tap Save changes again." }, 400);
        if (tooBig) return json({ error: "The files are too big to email (over 15 MB)." }, 400);
        // The sheet gets the listing's latest details.
        Object.assign(site, { propertyName: record.propertyName || site.propertyName, area: record.area || site.area, district: record.district || site.district, suburb: record.suburb || site.suburb,
          description: String(record.description || site.description || "").slice(0, 1000) });
        const origin = new URL(request.url).origin, pl = photosLinkFor(record, origin);
        const extraHtml = "<p><b>The listing is complete.</b> Also attached: " + files.map((f) => escapeHtml(f.filename)).join(", ") + ".</p>" +
          (pl.url ? '<p><b>Photos (' + pl.count + '):</b> <a href="' + escapeHtml(pl.url) + '">View and download the photos</a> (one .zip with all of them is on that page)</p>' : "<p>No photos on the listing yet.</p>");
        await sendSnSetupSheet(site, isAdmin ? "Admin, listing complete" : "Listing completed by the property", undefined, { files, extraHtml });
        const last = site.sendLog[site.sendLog.length - 1], at = last.at;
        if (last.ok) markRatesSent(record, at);
        record.snEmailLog = (Array.isArray(record.snEmailLog) ? record.snEmailLog : []).concat([{ at, to: last.to, subject: "Set-up sheet and files (listing complete)", files: last.file.split(", ").concat(pl.url ? ["Link to " + pl.count + " photos"] : []),
          siteNr: String(site.siteNr), ok: last.ok, error: last.error, markedSent: last.ok }]).slice(-200);
        addHistory(record, isAdmin ? "admin" : "property", (last.ok ? "Listing complete: set-up sheet, files and photos link sent to Stock Network (Site Nr " : "Listing complete, but sending to Stock Network FAILED (Site Nr ") + site.siteNr + ")");
        record.dateUpdated = at;
        await store.setJSON(listingId, record);
        const notifyTo = await getNotificationEmail();
        if (notifyTo) context.waitUntil(sendNotificationEmail(notifyTo, (last.ok ? "Listing complete, sent to Stock Network: " : "Listing complete, NOT sent to Stock Network: ") + (record.propertyName || listingId),
          "<p><b>" + escapeHtml(record.propertyName || "") + "</b> (listing " + escapeHtml(listingId) + ", Site Nr " + escapeHtml(site.siteNr) + ") completed its listing.</p>" +
          (last.ok ? "<p>The sheet, " + files.map((f) => escapeHtml(f.filename)).join(", ") + (pl.url ? " and a photos link" : "") + " went to " + escapeHtml(last.to) + ". The hub picks the property up once Stock Network has set it up (hourly check).</p>"
            : "<p><b>Sending failed</b> (" + escapeHtml(last.error || "") + "). Send it from Admin &gt; Property Listings (Email the files) and Admin &gt; Site Nrs.</p>")));
        return last.ok ? json({ ok: true, siteNr: site.siteNr }) : json({ error: "Your listing is saved, but it couldn't be sent to Avante just now. Avante has been told and will send it." }, 502);
      }

      if (action === "markSentToSN") {
        const before = { snSentSeasons: record.snSentSeasons || [] };
        markRatesSent(record, new Date().toISOString());
        record.dateUpdated = record.snSentAt;
        addHistory(record, "admin", "Rates marked as sent to Stock Network", before);
        await store.setJSON(listingId, record);
        return json({ ok: true, snSentAt: record.snSentAt });
      }

      if (action === "emailSNFiles") {
        // Jean (2026-10-13): email the Stock Network files (built in the
        // admin's browser, see sn-export.js filesForEmail) to any address,
        // and keep a log on the listing of every send, failed ones too.
        const to = String(body.to || "").split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
        if (!to.length) return json({ error: "Type the email address to send to." }, 400);
        if (to.length > 5) return json({ error: "Send to 5 addresses at most." }, 400);
        const bad = to.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.length > 200);
        if (bad.length) return json({ error: "This email address doesn't look right: " + bad.join(", ") }, 400);
        const { files, tooBig } = cleanFiles(body.files);
        if (!files.length) return json({ error: "No files to send." }, 400);
        if (tooBig) return json({ error: "The files are too big to email (over 15 MB)." }, 400);
        const siteNr = clean(body.siteNr, 20) || record.siteNr || "";
        const note = clean(body.note, 2000);
        const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
        // A link to the photos (Jean, 2026-10-13), so Stock Network can upload them.
        const pl = body.photosLink ? photosLinkFor(record, new URL(request.url).origin) : { url: "", count: 0 };
        const photoCount = pl.count, photosUrl = pl.url;
        const subject = clean(body.subject, 200) || ((record.existingOnSN === "Y" ? "Updated property details for Stock Network: " : "New property for Stock Network: ") + (record.propertyName || "property") + (siteNr ? " (Site Nr " + siteNr + ")" : ""));
        const html = "<p>Hello,</p>" +
          (note ? "<p>" + esc(note).replace(/\n/g, "<br>") + "</p>" : "<p>Please find attached the Stock Network files for <b>" + esc(record.propertyName || "the property") + "</b>.</p>") +
          "<p><b>Property:</b> " + esc(record.propertyName || "") + "<br><b>Site Nr:</b> " + esc(siteNr || "(not allocated)") +
          (record.siteId ? "<br><b>Site ID:</b> " + esc(record.siteId) : "") + "</p>" +
          "<p><b>Attached:</b><br>" + files.map((f) => esc(f.filename)).join("<br>") + "</p>" +
          (photosUrl ? '<p><b>Photos (' + photoCount + '):</b> <a href="' + esc(photosUrl) + '">View and download the photos</a><br><span style="color:#5b6b76">(one .zip with all of them is on that page)</span></p>' : "") +
          "<p>Avante Travel</p>";
        const replyTo = clean(body.replyTo, 200);
        const sent = await sendEmail({ to, subject, html, attachments: files, replyTo });
        const ok = sent.ok, error = sent.error || "", emailId = sent.id || "";
        const entry = { at: new Date().toISOString(), to: to.join(", "), subject, files: files.map((f) => f.filename).concat(photosUrl ? ["Link to " + photoCount + " photos"] : []), siteNr, note, ok, error: error || undefined, emailId: emailId || undefined, markedSent: false };
        const before = { snSentSeasons: record.snSentSeasons || [] };
        if (ok && body.markSent) { markRatesSent(record, entry.at); entry.markedSent = true; }
        // The Site Nr the files were sent with is the allocated one: keep it.
        if (ok && siteNr && !record.siteNr) { before.siteNr = ""; record.siteNr = siteNr; }
        record.snEmailLog = (Array.isArray(record.snEmailLog) ? record.snEmailLog : []).concat([entry]).slice(-200);
        record.history = (Array.isArray(record.history) ? record.history : []).concat([{ at: entry.at, by: "admin",
          action: (ok ? "Stock Network files emailed to " : "Email of Stock Network files FAILED to ") + entry.to + " (" + entry.files.join(", ") + ")" + (entry.markedSent ? "; rates marked as sent" : ""),
          changed: (entry.markedSent || before.siteNr === "") ? before : undefined }]).slice(-HISTORY_MAX);
        record.dateUpdated = entry.at;
        await store.setJSON(listingId, record);
        return json({ ok, error: error || undefined, entry });
      }

      if (action === "addPhotos" || action === "removePhoto") {
        // Admin adds or deletes photos on a listing in Property Listings
        // (Jean, 2026-10-13). The photo link in the Stock Network email always
        // shows the listing's photos as they are now.
        const filesStore = getStore({ name: "property-listing-files", consistency: "strong" });
        const before = { images: (record.images || []).map((x) => Object.assign({}, x)) };
        let changed = 0;
        if (action === "addPhotos") {
          const add = sanitizeFileRefs(body.images, 30).filter((im) => im.key);
          for (const im of add) {
            if ((record.images || []).some((x) => x.key === im.key)) continue;
            const meta = await filesStore.getMetadata(im.key).catch(() => null);
            if (!meta) continue;   // only photos that really were uploaded
            record.images = (record.images || []).concat([Object.assign(im, { type: im.type || "Property" })]).slice(0, 80);
            changed++;
          }
          if (!changed) return json({ error: "No new photos were added." }, 400);
        } else {
          const key = clean(body.imageKey, 300);
          const n = (record.images || []).length;
          record.images = (record.images || []).filter((x) => x.key !== key);
          changed = n - record.images.length;
          if (!changed) return json({ error: "That photo isn't on this listing." }, 400);
          if (record.libraryPhotos) delete record.libraryPhotos[key];
          await filesStore.delete(key).catch(() => {});
        }
        record.dateUpdated = new Date().toISOString();
        addHistory(record, "admin", action === "addPhotos" ? "Added " + changed + " photo(s)" : "Deleted a photo", before);
        await store.setJSON(listingId, record);
        return json({ ok: true, images: record.images });
      }

      if (action === "libraryAdd") {
        // Jean (2026-10-13): the listing's photos go into the hook builder's
        // shared photo library (avante-hooks /api/library), the same library
        // the hook builder fills. Admin's browser makes the flyer-size copy,
        // thumbnail and picture hash exactly as the hook builder does; the
        // hub passes it on with a 5-minute admin pass signed with
        // HOOKS_SSO_SECRET. The library itself spots photos it already has.
        const imageKey = clean(body.imageKey, 300);
        const im = (record.images || []).find((x) => x && x.key === imageKey);
        if (!im) return json({ error: "That photo isn't on this listing." }, 400);
        const item = body.item && typeof body.item === "object" ? body.item : {};
        const tags = [{ key: "listing:" + listingId, name: record.propertyName || "Property" }];
        let ticket;
        try { ticket = await makeHooksTicket({ sub: "admin", name: "Avante admin", role: "admin" }); }
        catch (e) { return json({ error: e.message }, 500); }
        let r, d;
        try {
          r = await fetch(new URL("/api/library", HOOKS_URL).href, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ticket },
            body: JSON.stringify({ op: "add", item: { name: clean(item.name, 120) || (record.propertyName || "Property"), tags, src: "hub-listing:" + imageKey, source: "hub",
              w: +item.w || 0, h: +item.h || 0, hash: /^[0-9a-f]{16}$/.test(item.hash || "") ? item.hash : "" }, full: String(body.full || ""), thumb: String(body.thumb || "") }) });
          d = await r.json().catch(() => ({}));
        } catch (e) { return json({ error: "Could not reach the hook builder: " + String((e && e.message) || e) }, 502); }
        if (!r.ok || !d.ok) return json({ error: (d && d.error) || ("The hook builder library said " + r.status + ".") }, 502);
        const fresh = (await store.get(listingId, { type: "json" })) || record;
        fresh.libraryPhotos = Object.assign({}, fresh.libraryPhotos || {}, { [imageKey]: d.id });
        await store.setJSON(listingId, fresh);
        return json({ ok: true, id: d.id, existing: !!d.existing, inLibrary: Object.keys(fresh.libraryPhotos).length });
      }

      // update: the whole form comes back; keep what only Avante controls.
      const incoming = submittedFields(body);
      const before = JSON.parse(JSON.stringify(record));
      const KEEP = ["listingId", "status", "dateSubmitted", "submittedBy", "affId", "editToken", "history",
        "commissionRate", "listingDuration", "agreementTerms", "agreementStatus", "agreementToken", "agreementSentAt",
        "agreementRespondedAt", "snSentSeasons", "snSentAt", "snEmailLog", "photosToken", "libraryPhotos", "existingOnSN", "paSiteId", "resortId", "editLinkLog", "affiliateCreatedAt", "snSiteFields", "bbid", "channelProperty", "ratesFromChannel", "snFacilities", "agreementSigned", "signatoryName", "signatoryCapacity",
        "signatoryIdPassport", "signatureDate", "signaturePlace", "coordsVerifiedAt"];
      Object.keys(incoming).forEach((k) => { if (KEEP.indexOf(k) === -1) record[k] = incoming[k]; });
      // A channel property's commission (4.95% + VAT on hub bookings) is set by
      // Avante, not by the form's default.
      if (before.channelProperty === "Y") record.commissionPct = before.commissionPct || "4.95";
      if (!isAdmin) {
        record.siteNr = before.siteNr || "";   // the Site Nr is allocated by Avante
        // Location is locked once submitted: coordinates, address and the
        // place names stay as Avante has them (the hub location tree is the master).
        ["latitude", "longitude", "streetAddress", "coordsVerified", "coordsVerifiedPlace"].concat(LOCATION_FIELDS)
          .forEach((k) => { record[k] = before[k] === undefined ? "" : before[k]; });
      } else if (before.latitude !== record.latitude || before.longitude !== record.longitude || !before.treePlace) {
        await applyTreePlace(record, await placeInTree(record.latitude, record.longitude), true);
      }
      if (incoming.coordsVerified === "Y" && (before.latitude !== record.latitude || before.longitude !== record.longitude || before.coordsVerified !== "Y")) {
        record.coordsVerifiedAt = new Date().toISOString();
      }
      if (!record.propertyName || !record.ownerFullName) return json({ error: "Property name and owner name can't be empty." }, 400);
      const emailErr1 = emailFieldError(record);
      if (emailErr1) return json({ error: emailErr1 }, 400);
      record.dateUpdated = new Date().toISOString();
      const changed = addHistory(record, isAdmin ? "admin" : (record.submittedBy || "owner"), "Edited", before);
      if (!changed) return json({ ok: true, listing: { listingId: listingId }, unchanged: true });
      await store.setJSON(listingId, record);
      await forgetEstates();

      if (!isAdmin) {
        const notifyTo = await getNotificationEmail();
        if (notifyTo) {
          const what = Object.keys(record.history[record.history.length - 1].changed || {}).join(", ");
          context.waitUntil(sendNotificationEmail(notifyTo, "Listing updated by owner — " + record.propertyName,
            "<p>" + escapeHtml(record.ownerFullName || "The owner") + " updated <strong>" + escapeHtml(record.propertyName) + "</strong> (" + escapeHtml(listingId) + ").</p>" +
            "<p><strong>Changed:</strong> " + escapeHtml(what) + "</p><p>See Admin &gt; Property Listings &gt; View &gt; History.</p>"));
        }
      }
      return json({ ok: true, listing: { listingId: listingId } });
    }

    if (action === "readScreenshots") {
      const isAdmin = await verifyAdminToken(body.token);
      if (!isAdmin && (await overDailyLimit("readScreenshots", request, context))) {
        return json({ ok: false, reason: "limit", message: "Daily limit for reading screenshots reached. Fill in the rest by hand or try tomorrow." });
      }
      const imgs = Array.isArray(body.images) ? body.images.slice(0, 12) : [];
      let total = 0;
      const images = [];
      for (const i of imgs) {
        const m = typeof (i && i.dataUri) === "string" ? i.dataUri.match(/^data:([^;,]+);base64,(.+)$/) : null;
        if (!m) continue;
        total += m[2].length;
        if (total > 18 * 1024 * 1024) break;
        images.push({ mediaType: m[1], data: m[2] });
      }
      const pdfs = [];
      (Array.isArray(body.pdfs) ? body.pdfs.slice(0, 4) : []).forEach((d) => {
        const m = typeof (d && d.dataUri) === "string" ? d.dataUri.match(/^data:application\/pdf;base64,(.+)$/) : null;
        if (!m) return;
        total += m[1].length;
        if (total > 24 * 1024 * 1024) return;
        pdfs.push({ name: clean(d.name, 120), data: m[1] });
      });
      const texts = (Array.isArray(body.texts) ? body.texts.slice(0, 8) : [])
        .map((t) => ({ name: clean(t && t.name, 120), text: typeof (t && t.text) === "string" ? t.text.slice(0, 60000) : "" }))
        .filter((t) => t.text);
      const amenityOptions = Array.isArray(body.amenityOptions) ? body.amenityOptions.map((a) => clean(a, 150)).filter(Boolean) : [];
      const result = await readListingScreenshots(images, clean(body.channel, 60), amenityOptions, clean(body.today, 10), pdfs, texts);
      return json(result);
    }

    if (action === "lookupLocation") {
      // Address / property name -> Google coordinate + place names. Returns
      // up to 5 candidates so the person picks the right one (a resort
      // name can match more than one place).
      const isAdmin = await verifyAdminToken(body.token);
      if (!isAdmin && (await overDailyLimit("lookupLocation", request, context))) {
        return json({ ok: false, reason: "limit", message: "Daily limit for Google lookups reached." });
      }
      const address = clean(body.address, 300);
      const name = clean(body.name, 200);
      const geoKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      const placesKey = Deno.env.get("GOOGLE_PLACES_API_KEY") || "";
      const out = [];
      if (name) {
        const p = await searchPlaceCandidates([name, address].filter(Boolean).join(", "), placesKey, 4);
        if (p && p.ok) p.candidates.forEach((c) => out.push({ source: "Google Places", name: c.name, address: c.formattedAddress, lat: c.lat, lng: c.lng }));
      }
      if (address) {
        const g = await forwardGeocode(address, geoKey);
        if (g && g.ok && g.lat != null) out.push({ source: "Google address", name: "", address: g.formattedAddress, lat: g.lat, lng: g.lng, precision: g.locationType });
      }
      if (!out.length) return json({ ok: false, reason: "not_found", message: "Google couldn't find that place. Check the address, or type the coordinates." });
      // Fill place names for each candidate from the coordinate itself, so
      // the tree fields come from the pin, not from the channel's text.
      const top = out.slice(0, 5);
      await Promise.all(top.map(async (c) => {
        const r = await reverseGeocode(c.lat, c.lng, geoKey);
        if (r && r.ok) Object.assign(c, { country: r.country, province: r.province, town: r.town, townType: r.townType, suburb: r.suburb });
      }));
      return json({ ok: true, candidates: top });
    }

    if (action === "verifyCoordinates") {
      const isAdmin = await verifyAdminToken(body.token);
      if (!isAdmin && (await overDailyLimit("verifyCoordinates", request, context))) {
        return json({ ok: false, reason: "limit", message: "Daily limit for Google lookups reached." });
      }
      const lat = Number(body.latitude), lng = Number(body.longitude);
      if (!validCoord(lat, lng)) {
        return json({ ok: false, reason: "invalid", message: "Those aren't valid coordinates. Latitude is -90 to 90 and longitude -180 to 180 (South Africa is about -22 to -35 and 16 to 33)." });
      }
      const geoKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY") || "";
      const r = await reverseGeocode(lat, lng, geoKey);
      if (!r || !r.ok) return json({ ok: false, reason: (r && r.reason) || "failed", message: "Google couldn't check these coordinates just now." });
      const result = { ok: true, country: r.country, province: r.province, town: r.town, townType: r.townType, suburb: r.suburb, warnings: [] };
      const place = await placeInTree(lat, lng);
      if (place) result.tree = { text: placeText(place), fields: treeFields(place) };
      // Compare with what the form says, and with the address if given.
      const said = { country: clean(body.country, 100), province: clean(body.province, 100), town: clean(body.city, 100) };
      const low = (s) => String(s || "").toLowerCase();
      if (said.country && r.country && low(said.country) !== low(r.country)) result.warnings.push("The pin is in " + r.country + ", but the form says " + said.country + ".");
      if (said.province && r.province && low(said.province) !== low(r.province)) result.warnings.push("The pin is in " + r.province + ", but the form says " + said.province + ".");
      const address = clean(body.address, 300);
      if (address) {
        const g = await forwardGeocode(address, geoKey);
        if (g && g.ok && g.lat != null) {
          const km = kmBetween(lat, lng, g.lat, g.lng);
          result.addressDistanceKm = Math.round(km * 10) / 10;
          if (km > 2) result.warnings.push("The pin is " + result.addressDistanceKm + " km from where Google puts the address. Check which one is right.");
        }
      }
      return json(result);
    }

    if (action === "findPhotos") {
      const isAdmin = await verifyAdminToken(body.token);
      if (!isAdmin && (await overDailyLimit("findPhotos", request, context))) {
        return json({ ok: false, reason: "limit", message: "Daily limit for Google photo searches reached." });
      }
      const query = clean(body.query, 200);
      const result = await searchPlacePhotos(query, Deno.env.get("GOOGLE_PLACES_API_KEY") || "", 6);
      return json(result);
    }

    if (action === "get") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const listingId = clean(body.listingId, 20);
      if (!listingId) return json({ error: "missing listingId" }, 400);
      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);
      return json({ ok: true, listing: record });
    }

    if (action === "list") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const { blobs } = await store.list();
      const items = await Promise.all(
        blobs.map((b) => store.get(b.key, { type: "json" }))
      );
      const summaries = items
        .filter(Boolean)
        .map((r) => ({
          listingId: r.listingId,
          propertyName: r.propertyName,
          ownerFullName: r.ownerFullName,
          submittedBy: r.submittedBy,
          country: r.country,
          city: r.city,
          status: r.status || "Requested",
          siteNr: r.siteNr || "",
          siteId: r.siteId || "",
          coordsVerified: r.coordsVerified || "N",
          existingOnSN: r.existingOnSN || "",
          dateSubmitted: r.dateSubmitted,
          dateUpdated: r.dateUpdated,
        }))
        .sort((a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted));

      return json({ ok: true, listings: summaries });
    }

    if (action === "myListing") {
      // A property signed in to the hub opens its own listing in the onboarding
      // form (Jean, 2026-10-17): the listing whose Site ID is its affiliate
      // number, or whose Site Nr is the affiliate's Site Nr.
      const aff = clean(body.aff, 100);
      if (!aff || !(await isAffiliateSession(aff, clean(body.session, 100)))) return json({ error: "Please log in to the hub again." }, 401);
      const profile = await getStore({ name: "affiliates-directory", consistency: "strong" }).get(aff, { type: "json" }).catch(() => null);
      const siteNr = String((profile && profile.siteNr) || "").trim();
      const all = (await Promise.all((await store.list()).blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
      const mine = all.filter((r) => r.siteId === aff || r.affId === aff || r.paSiteId === aff || (siteNr && String(r.siteNr || "").trim() === siteNr))
        .sort((a, b) => String(b.dateUpdated || "").localeCompare(String(a.dateUpdated || "")));
      const r = mine[0];
      if (!r) return json({ ok: true, listing: null });
      if (!r.editToken) { r.editToken = genToken(); await store.setJSON(r.listingId, r); }
      return json({ ok: true, listing: { listingId: r.listingId, key: r.editToken, propertyName: r.propertyName || "" } });
    }

    if (action === "listingRequest") {
      // The public "List your property" page (avante-channel-manager-listing.html).
      // Jean (2026-10-15): every property is set up on Stock Network first.
      //  - A NightsBridge BBID already in the hub's Stock Network list: the
      //    property is on SN; nothing goes to SN.
      //  - Otherwise: the hub gives it the next free Site Nr from its register
      //    and emails SN's Request_pull_area sheet to the SN set-up addresses
      //    (Admin > Site Nrs); the property gets a confirmation.
      //  - Only if the property ticked "I also want to become an Avante
      //    Property Affiliate" is a listing made, status Requested; it gets
      //    no edit link until admin has checked it and sends one.
      // Jean (2026-10-17), a property not on a channel manager ("Not on a
      // platform"): a listing is always made and its completion link emailed
      // straight away. Its Site Nr waits ("Waiting for listing"); nothing goes
      // to Stock Network until the listing's Ready check is complete, then the
      // hub sends the sheet, property file, rates file and photos link
      // (action sendForSetUp).
      if (await overDailyLimit("listingRequest", request, context)) return json({ error: "Too many requests from this connection today. Please email info@avantehospitality.co.za." }, 429);
      const contact = { name: clean(body.contactPerson, 120), phone: clean(body.phone, 200), email: clean(body.email, 600) };
      const propertyName = clean(body.propertyName, 200);
      const cm = ["NightsBridge", "eRes/NebulaCRS", "None yet"].includes(body.channelManager) ? body.channelManager : "";
      const bbid = clean(body.bbid, 40), eresRef = clean(body.eresRef, 60);
      const hosted = cm === "None yet";
      const wantsAffiliate = body.propertyAffiliate === true || hosted;
      // Where the property is listed now (Jean, 2026-10-17): ticked on the page, "Other" with its name.
      const CHANNELS = ["None", "Booking.com", "Airbnb", "LekkeSlaap", "Other"];
      const channels = (Array.isArray(body.channels) ? body.channels : []).filter((c) => CHANNELS.includes(c));
      const channelsOther = clean(body.channelsOther, 200);
      const listedOn = channels.map((c) => (c === "Other" && channelsOther ? "Other: " + channelsOther : c)).join(", ");
      if (!propertyName || !contact.name || !contact.phone || !contact.email || !cm) return json({ error: "Fill in every field." }, 400);
      if (!channels.length) return json({ error: "Tick where your property is listed now, or tick None." }, 400);
      if (channels.includes("Other") && !channelsOther) return json({ error: "Type which other website or channel your property is on." }, 400);
      if (badEmails(contact.email).length || !emailList(contact.email).length) return json({ error: "\"" + (badEmails(contact.email)[0] || contact.email) + "\" doesn't look like an email address. Separate several addresses with a comma." }, 400);
      if (body.acceptTerms !== true) return json({ error: "Accept the Terms & Conditions first." }, 400);
      if (cm === "NightsBridge" && !bbid) return json({ error: "Type your NightsBridge BBID number." }, 400);
      const norm = (v) => String(v || "").trim().toLowerCase().replace(/^0+/, "");
      let row = null, already = null;
      if (cm === "NightsBridge") {
        const cur = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
        const hits = ((cur && cur.resorts) || []).filter((r) => r.externalResortCode && norm(r.externalResortCode) === norm(bbid));
        row = hits.length === 1 ? hits[0] : null;
        if (row) {
          const all = (await Promise.all((await store.list()).blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
          already = all.find((r) => r.resortId && String(r.resortId).toLowerCase() === String(row.resortId).toLowerCase()) || null;
        }
      }

      // Not on Stock Network yet: reserve the Site Nr and send the sheet.
      let site = null, loc = {}, repeat = false;
      if (!row) {
        // Submitted before and not set up yet? Same Site Nr, nothing sent again.
        site = await findOpenRequest(siteRegister(), { bbid, propertyName, email: emailText(contact.email) });
        if (site) {
          repeat = true;
          if (wantsAffiliate && !site.propertyAffiliate) { site.propertyAffiliate = true; await saveSiteNr(siteRegister(), site); }
        } else {
          loc = await guessSnLocation(propertyName);
          const entry = newEntry({ propertyName, bbid, channelManager: cm, eresRef, contactName: contact.name, phone: contact.phone, email: emailText(contact.email),
            area: loc.area, district: loc.district, suburb: loc.suburb, propertyAffiliate: wantsAffiliate, note: "Listed on now: " + listedOn });
          if (hosted) entry.status = WAITING_FOR_LISTING;
          entry.siteNr = await reserveNextSiteNr(siteRegister(), entry);
          if (hosted) site = entry;
          else {
            site = await sendSnSetupSheet(entry, "List your property page");
            const conf = confirmationEmail(site);
            // At most 5 addresses: the confirmation goes to whatever was typed on a public page.
            context.waitUntil(sendEmail({ to: emailList(contact.email, 5), subject: conf.subject, html: conf.html }));
          }
        }
      }

      const extra = { requestContact: contact, contactName: contact.name, contactPhone: contact.phone, contactEmail: emailText(contact.email), notifyWho: "both",
        channelManager: cm, bbid, eresRef, listedOn, requestedAt: new Date().toISOString() };
      let record = null;
      if (wantsAffiliate && row && !already) {
        record = await buildListingFromSn({ site: String(row.siteId || ""), resortId: row.resortId, resortName: row.name, aff: "", units: [], settings: { email: contact.email, phone: contact.phone }, channel: true, siteIdForListing: "" },
          row, { by: "property", status: "Requested", historyNote: "Listing request from the List your property page, BBID " + bbid + ", found on Stock Network", extra });
      } else if (wantsAffiliate && !already && !(site && site.listingId)) {
        const now = new Date().toISOString(), listingId = genListingId();
        record = Object.assign({ listingId, status: "Requested", dateSubmitted: now, dateUpdated: now }, submittedFields({ propertyName, email: contact.email, telephone: contact.phone, submittedBy: "Owner" }),
          { editToken: genToken(), agreementSigned: "Y", channelProperty: cm !== "None yet" ? "Y" : "", ratesFromChannel: cm !== "None yet" ? "Y" : "", commissionPct: cm !== "None yet" ? "4.95" : "",
            needsTreePlace: loc.place ? "" : "Y",
            siteNr: site ? String(site.siteNr) : "" }, extra);
        if (loc.place) { record.latitude = String(loc.lat); record.longitude = String(loc.lng); await applyTreePlace(record, loc.place, false); }
        addHistory(record, "property", "Listing request from the List your property page (" + cm + (bbid ? ", BBID " + bbid : eresRef ? ", eRes ref " + eresRef : "") +
          (site ? "; Site Nr " + site.siteNr + " reserved" + (site.status === "Sent" ? ", sheet sent to Stock Network" : site.status === WAITING_FOR_LISTING ? ", waiting for the listing to be complete" : ", sheet NOT sent") : "") + ")");
      }
      if (record) {
        await store.setJSON(record.listingId, record);
        if (site) { site.listingId = record.listingId; await saveSiteNr(siteRegister(), site); }
      }
      // Not on a platform: the completion link goes out straight away (also
      // again when the property asks a second time). At most 5 addresses: it
      // goes to whatever was typed on a public page.
      let linkSent = false;
      const linkRecord = hosted ? record || (site && site.listingId ? await store.get(site.listingId, { type: "json" }).catch(() => null) : null) : null;
      if (linkRecord) {
        linkSent = (await emailEditLink(linkRecord, emailList(contact.email, 5), new URL(request.url).origin, "property")).ok;
        await store.setJSON(linkRecord.listingId, linkRecord);
      }

      const notifyTo = await getNotificationEmail();
      if (notifyTo) {
        context.waitUntil(sendNotificationEmail(notifyTo, "Listing request: " + propertyName + (bbid ? " (BBID " + bbid + ")" : "") + (site ? " — Site Nr " + site.siteNr : ""),
          "<p>A property asked to list on the <b>List your property</b> page.</p>" +
          "<p><b>Property:</b> " + escapeHtml(propertyName) + "<br><b>Contact:</b> " + escapeHtml(contact.name) + " · " + escapeHtml(contact.phone) + " · " + escapeHtml(contact.email) +
          "<br><b>System:</b> " + escapeHtml(cm === "None yet" ? "Not on a platform" : cm) + (bbid ? " · BBID " + escapeHtml(bbid) : "") + (eresRef ? " · eRes ref " + escapeHtml(eresRef) : "") +
          "<br><b>Listed on now:</b> " + escapeHtml(listedOn) +
          "<br><b>Property affiliate:</b> " + (wantsAffiliate ? "yes" : "no") + "</p>" +
          (row ? "<p>Already on Stock Network: <b>" + escapeHtml(row.name) + "</b>. Nothing was sent to Stock Network.</p>"
            : repeat ? "<p>Asked before: same Site Nr <b>" + escapeHtml(site.siteNr) + "</b> (" + escapeHtml(site.status) + "). Nothing was sent to Stock Network again.</p>"
            : site.status === WAITING_FOR_LISTING ? "<p>Site Nr <b>" + escapeHtml(site.siteNr) + "</b> reserved (" + WAITING_FOR_LISTING + "). Not on a platform, so nothing goes to Stock Network yet: when the property's listing is complete, the hub sends the sheet, property file, rates file and photos link by itself.</p>"
            : "<p>Site Nr <b>" + escapeHtml(site.siteNr) + "</b> reserved. " + (site.status === "Sent" ? "The Stock Network sheet was emailed to " + escapeHtml(site.sendLog[site.sendLog.length - 1].to) + "."
              : "<b>The Stock Network sheet could NOT be sent</b> (" + escapeHtml(site.sendLog[site.sendLog.length - 1].error || "") + "). Send it again from Admin &gt; Site Nrs.") + "</p>") +
          (already ? "<p>It already has a listing (" + escapeHtml(already.listingId) + "); no new listing was made.</p>"
            : record && hosted ? "<p>Listing <b>" + escapeHtml(record.listingId) + "</b> was made, status Requested. " + (linkSent ? "The link to complete it was emailed to the property." : "<b>The link to complete it could NOT be emailed</b>: tap <b>Email the edit link</b> in Admin &gt; Property Listings.") + "</p>"
            : record ? "<p>Listing <b>" + escapeHtml(record.listingId) + "</b> was made, status Requested. Check it in Admin &gt; Property Listings, then tap <b>Email the edit link</b>.</p>"
            : "<p>No listing was made (the property did not ask to be a property affiliate).</p>")));
      }
      return json({ ok: true, found: !!row, name: row ? row.name : "", already: !!already, siteNr: site ? site.siteNr : null, repeat, listing: !!(record || (site && site.listingId)), linkSent });
    }

    // ---------- Site Nr register (Admin > Site Nrs, Jean 2026-10-15) ----------
    if (action === "checkWaitingSetUps") {
      // Every hour (netlify/functions/sn-setup-check.mjs), or admin's "Check now"
      // in Site Nrs (Jean, 2026-10-17): Site Nrs sent to Stock Network and not
      // set up yet are looked for in Stock Network's list (by Site Nr, else BBID).
      // Found: the Site Nr is marked Set up, the property's hub affiliate is
      // made (number = Site ID; not connected until the property wants to use
      // the hub), its listing is linked, the property gets its hub login and
      // admin gets a summary. Then every set-up property not on a channel
      // manager is "Waiting for stock" until Avante's availability read finds
      // stock for it (the next 12 months), then "Ready to go live".
      const secret = Deno.env.get("PA_SYNC_SECRET") || "";
      const bySchedule = !!secret && request.headers.get("x-pa-sync-secret") === secret;
      if (!bySchedule) { const denied = await requireAdmin(); if (denied) return denied; }
      const reg = siteRegister();
      const waiting = (await listSiteNrs(reg)).filter((e) => e.status === "Sent");
      let found = [];
      if (waiting.length) {
        try { found = await findSetUps(waiting.map((e) => ({ siteNr: e.siteNr, bbid: e.bbid }))); }
        catch (e) { return json({ error: "Could not read Stock Network's property list: " + String((e && e.message) || e) }, 502); }
      }
      const origin = new URL(request.url).origin, done = [];
      for (let i = 0; i < waiting.length; i++) {
        const e = waiting[i], f = found[i];
        if (!f) continue;
        const now = new Date().toISOString();
        Object.assign(e, { status: "Set up", setUpAt: now, resortId: f.resortId, snSiteId: f.siteId, snName: f.name, updatedAt: now });
        if (e.channelManager === "None yet") e.goLive = GO_LIVE.waiting;
        let affId = "", affNote = "";
        if (f.siteId) {
          const made = await createPropertyAffiliate({ affId: f.siteId, name: e.propertyName || f.name, email: e.email, phone: e.phone, siteNr: f.siteNr || e.siteNr,
            type: e.channelManager && e.channelManager !== "None yet" ? "channel" : "property", note: "Made when Avante Site Nr " + e.siteNr + " was set up" });
          affId = f.siteId; affNote = made.created ? "affiliate made" : "affiliate already there";
        } else affNote = "no Site ID from Stock Network yet, so no affiliate";
        if (e.listingId) {
          const rec = await store.get(e.listingId, { type: "json" }).catch(() => null);
          if (rec) {
            const before = { resortId: rec.resortId || "", siteId: rec.siteId || "", affId: rec.affId || "" };
            rec.resortId = rec.resortId || f.resortId; if (affId) { rec.siteId = rec.siteId || affId; rec.affId = rec.affId || affId; }
            rec.siteNr = rec.siteNr || String(e.siteNr); rec.existingOnSN = "Y"; rec.dateUpdated = now;
            addHistory(rec, "admin", "Set up on Stock Network (Site Nr " + e.siteNr + "), found by the hourly check", before);
            await store.setJSON(e.listingId, rec);
          }
        }
        if (affId && !e.welcomeSentAt && emailList(e.email).length) {
          const w = welcomeEmail(e, affId, origin + "/login.html?aff=" + encodeURIComponent(affId));
          const ok = await sendEmail({ to: emailList(e.email, 5), subject: w.subject, html: w.html }).catch(() => false);
          if (ok) e.welcomeSentAt = now;
        }
        await saveSiteNr(reg, e);
        done.push({ siteNr: e.siteNr, name: e.propertyName, resortId: f.resortId, affId, affNote, welcomed: !!e.welcomeSentAt, listingId: e.listingId || "" });
      }
      const notifyTo = done.length ? await getNotificationEmail() : "";
      if (notifyTo) {
        context.waitUntil(sendNotificationEmail(notifyTo, "Set up on Stock Network: " + done.map((d) => d.name).join(", ").slice(0, 150),
          "<p>The hourly check found these properties on Stock Network:</p><ul>" + done.map((d) => "<li><b>" + escapeHtml(d.name) + "</b> — Site Nr " + escapeHtml(d.siteNr) +
            ", ResortID " + escapeHtml(d.resortId) + (d.affId ? ", affiliate " + escapeHtml(d.affId) : "") + " (" + escapeHtml(d.affNote) + ")" +
            (d.listingId ? ", listing " + escapeHtml(d.listingId) + " linked" : "") + (d.welcomed ? ", hub login emailed" : ", hub login NOT emailed") + "</li>").join("") +
          "</ul><p>See Admin &gt; Site Nrs.</p>"));
      }
      const ready = await checkStock(reg, origin);
      if (ready.length) {
        const to = notifyTo || await getNotificationEmail();
        if (to) context.waitUntil(sendNotificationEmail(to, "Ready to go live: " + ready.map((e) => e.propertyName).join(", ").slice(0, 150),
          "<p>Avante now has stock for these properties, so they are <b>Ready to go live</b>:</p><ul>" + ready.map((e) => "<li><b>" + escapeHtml(e.propertyName) + "</b> — Site Nr " + escapeHtml(e.siteNr) +
            ", first stock " + escapeHtml(e.stockFrom) + (e.listingId ? ", listing " + escapeHtml(e.listingId) : "") + "</li>").join("") + "</ul><p>See Admin &gt; Site Nrs.</p>"));
      }
      return json({ ok: true, waiting: waiting.length, setUp: done, ready: ready.map((e) => ({ siteNr: e.siteNr, name: e.propertyName, stockFrom: e.stockFrom })) });
    }

    if (["siteNrList", "siteNrReserve", "siteNrUpdate", "siteNrSend", "snSetupSettings"].includes(action)) {
      const denied = await requireAdmin();
      if (denied) return denied;
      const reg = siteRegister();
      if (action === "siteNrList") {
        const entries = await listSiteNrs(reg);
        return json({ ok: true, entries, next: await nextFreeSiteNr(reg), emails: await getSnSetupEmails(), statuses: SITE_STATUSES });
      }
      if (action === "snSetupSettings") {
        const emails = clean(body.emails, 600);
        if (!emailList(emails).length || badEmails(emails).length) return json({ error: badEmails(emails).length ? "\"" + badEmails(emails)[0] + "\" doesn't look like an email address. Separate several with a comma." : "Type at least one email address." }, 400);
        await saveSettings({ snSetupEmails: emailText(emails, 20) });
        return json({ ok: true, emails: emailText(emails, 20) });
      }
      const fields = (b) => ({ propertyName: b.propertyName, bbid: b.bbid, channelManager: b.channelManager, contactName: b.contactName, phone: b.phone,
        email: b.email, description: b.description, area: b.area, district: b.district, suburb: b.suburb, note: b.note });
      if (action === "siteNrReserve") {
        // By hand: the next free number, or one admin types (e.g. given out outside the hub).
        const entry = newEntry(Object.assign(fields(body), { propertyName: clean(body.propertyName, 200) || "Spare" }));
        try {
          entry.siteNr = body.siteNr ? await reserveSiteNr(reg, body.siteNr, entry) : await reserveNextSiteNr(reg, entry);
        } catch (e) { return json({ error: e.message }, 400); }
        if (body.markSetUp === true) { entry.status = "Set up"; await saveSiteNr(reg, entry); }
        return json({ ok: true, entry: await getSiteNr(reg, entry.siteNr) });
      }
      const entry = await getSiteNr(reg, body.siteNr);
      if (!entry) return json({ error: "Site Nr " + clean(String(body.siteNr || ""), 12) + " isn't in the list." }, 404);
      if (action === "siteNrUpdate") {
        const f = fields(body);
        for (const k of Object.keys(f)) if (typeof f[k] === "string") entry[k] = k === "description" || k === "note" ? clean(f[k], 1000) : clean(f[k], k === "email" ? 600 : 200).replace(/[\r\n\t]+/g, " ");
        if (typeof body.email === "string" && badEmails(body.email).length) return json({ error: "\"" + badEmails(body.email)[0] + "\" doesn't look like an email address." }, 400);
        if (SITE_STATUSES.includes(body.status)) entry.status = body.status;
        entry.updatedAt = new Date().toISOString();
        await saveSiteNr(reg, entry);
        return json({ ok: true, entry });
      }
      if (action === "siteNrSend") {
        const sent = await sendSnSetupSheet(entry, "Admin", clean(body.to, 600));
        const last = sent.sendLog[sent.sendLog.length - 1];
        return last.ok ? json({ ok: true, entry: sent }) : json({ error: "Not sent: " + last.error, entry: sent }, 502);
      }
    }

    if (action === "existingProperties" || action === "createFromExisting") {
      // Jean (2026-10-13): properties that joined before the onboarding form
      // (connected in Property Affiliate, already on Stock Network — e.g.
      // The Dunes, Silver Ranch) get a listing too, filled in from what the
      // hub already knows, so they and admin can complete the fields that
      // weren't there then and send the updates to Stock Network.
      const denied = await requireAdmin();
      if (denied) return denied;
      const paStore = getStore({ name: "property-affiliate", consistency: "strong" });
      const props = [];
      for (const b of (await paStore.list({ prefix: "site:" })).blobs) {
        const pr = await paStore.get(b.key, { type: "json" }).catch(() => null);
        if (pr && pr.siteId) props.push(pr);
      }
      // Channel Property Affiliates (on NightsBridge etc.) are already on
      // Stock Network too, but aren't connected in Property Affiliate: they
      // come from the affiliates list (type "channel") and its Site Nr.
      const cur = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
      const resortRows = (cur && cur.resorts) || [];
      const dirStore = getStore({ name: "affiliates-directory", consistency: "strong" });
      for (const b of (await dirStore.list()).blobs) {
        const a = await dirStore.get(b.key, { type: "json" }).catch(() => null);
        if (!a || !Array.isArray(a.types) || a.types.indexOf("channel") === -1) continue;
        const aff = a.affId || b.key;
        if (props.some((pr) => pr.aff === aff)) continue;
        const rows = resortRows.filter((r) => a.siteNr && String(r.siteId || "").trim() === String(a.siteNr).trim());
        props.push({ siteId: "aff:" + aff, site: a.siteNr || "", resortId: rows.length === 1 ? rows[0].resortId : "", resortName: a.name || (rows[0] && rows[0].name) || "",
          aff, units: [], settings: { email: a.email || "", phone: a.phone || "" }, channel: true, siteIdForListing: aff });
      }
      const all = (await Promise.all((await store.list()).blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
      const listingFor = (pr) => all.find((r) => (r.paSiteId && r.paSiteId === pr.siteId) || (r.resortId && pr.resortId && r.resortId === pr.resortId) || (pr.channel && r.channelProperty === "Y" && r.affId === pr.aff));

      if (action === "existingProperties") {
        return json({ ok: true, properties: props.map((pr) => {
          const l = listingFor(pr);
          return { siteId: pr.siteId, siteNr: String(pr.site || ""), resortId: pr.resortId || "", name: pr.resortName || "", aff: pr.aff || "", units: (pr.units || []).length, channel: !!pr.channel, listingId: l ? l.listingId : "" };
        }).sort((a, b) => a.name.localeCompare(b.name)) });
      }

      let pr = props.find((x) => x.siteId === clean(body.siteId, 100));
      // Jean (2026-10-13): or just type the Site Nr and Site ID, and the hub
      // finds the rest (Stock Network's property list and public page).
      // Or the NightsBridge BBID (Jean, 2026-10-14): found in the hub's Stock
      // Network list (External Resort Code); the property is then a channel property.
      const bbid = clean(body.bbid, 40);
      let bySiteNr = clean(body.siteNr, 20), bbidRid = "", bbidHit = null, snSite = null;
      let typedSiteIdIn = clean(body.siteIdIn, 100);
      if (!pr && bbid) {
        const nb = (v) => String(v || "").trim().toLowerCase().replace(/^0+/, "");
        let hits = resortRows.filter((r) => r.externalResortCode && nb(r.externalResortCode) === nb(bbid));
        // Stock Network's own property feed (Jean, 2026-10-14): when the hub's
        // list doesn't have the BBID, its Site Nr or the Site ID, ask the feed.
        // Typed numbers always win.
        if (!hits.length || (!bySiteNr && !hits.some((h) => String(h.siteId || "").trim())) || !typedSiteIdIn) {
          const f = await feedByBbid(bbid);
          if (f.ok && f.matches.length) {
            const pick0 = clean(body.resortId, 64).toLowerCase();
            const m = f.matches.length === 1 ? f.matches[0] : (f.matches.find((x) => pick0 && x.resortId.toLowerCase() === pick0) || (hits.length === 1 ? f.matches.find((x) => x.resortId.toLowerCase() === String(hits[0].resortId).toLowerCase()) : null));
            if (m) {
              snSite = { siteNr: m.siteNr, siteId: m.siteId, fields: m.siteFields };
              if (!hits.length) hits = [{ name: m.name, resortId: m.resortId, siteId: m.siteNr, latitude: m.latitude == null ? "" : String(m.latitude), longitude: m.longitude == null ? "" : String(m.longitude), fromFeed: true }];
              if (!bySiteNr && m.siteNr && !String((hits[0] && hits[0].siteId) || "").trim()) bySiteNr = m.siteNr;
              if (!typedSiteIdIn && m.siteId) typedSiteIdIn = m.siteId;
            } else if (!hits.length) {
              return json({ ok: false, chooseResort: f.matches.map((x) => ({ resortId: x.resortId, name: x.name + (x.siteNr ? " (Site Nr " + x.siteNr + ")" : "") })) });
            }
          } else if (!hits.length) {
            return json({ error: "BBID " + bbid + " isn't in the hub's Stock Network list or in Stock Network's property feed" + (f.ok ? "" : " (" + f.error + ")") + ". Check the number, or use the Site Nr instead." }, 404);
          }
        }
        const pick = clean(body.resortId, 64).toLowerCase();
        const hit = hits.length > 1 ? hits.find((r) => pick && String(r.resortId).toLowerCase() === pick) : hits[0];
        if (!hit) return json({ ok: false, chooseResort: hits.map((r) => ({ resortId: r.resortId, name: r.name + " (Site Nr " + (r.siteId || "?") + ")" })) });
        // The Site Nr typed next to the BBID, else the one in the list (the list
        // can lack it: Jean, 2026-10-14, 37 On Anderson, Site Nr 4851).
        bySiteNr = bySiteNr || String(hit.siteId || "").trim(); bbidRid = hit.resortId; bbidHit = hit;
        if (!bySiteNr) return json({ error: "Found " + hit.name + " (BBID " + bbid + "), but neither the hub's list nor Stock Network's feed gave its Site Nr. Type its Site Nr too, then tap Get the property.", snSite }, 400);
      }
      if (!pr && bySiteNr) {
        const rows = bbidHit ? [bbidHit] : resortRows.filter((r) => String(r.siteId || "").trim() === bySiteNr);
        if (!rows.length) return json({ error: "No property with Site Nr " + bySiteNr + " is in the hub's Stock Network list yet. Check the number, or refresh the property list in SN Cleanup." }, 404);
        const wantRid = clean(body.resortId, 64) || bbidRid;
        if (rows.length > 1 && !wantRid) return json({ ok: false, chooseResort: rows.map((r) => ({ resortId: r.resortId, name: r.name })) });
        const row0 = rows.find((r) => !wantRid || String(r.resortId).toLowerCase() === wantRid.toLowerCase()) || rows[0];
        const typedSiteId = typedSiteIdIn;
        const known = props.find((x) => (x.resortId && String(x.resortId).toLowerCase() === String(row0.resortId).toLowerCase()) || (typedSiteId && (x.siteIdForListing === typedSiteId || x.aff === typedSiteId)));
        pr = known ? Object.assign({}, known, { site: known.site || bySiteNr, resortId: known.resortId || row0.resortId, resortName: known.resortName || row0.name }) : { siteId: "nr:" + bySiteNr + ":" + row0.resortId, site: bySiteNr, resortId: row0.resortId, resortName: row0.name, aff: "", units: [], settings: {} };
        if (typedSiteId) { pr = Object.assign({}, pr, { typedSiteId }); }
        if (bbid && !pr.channel && !pr.paSiteId && /^nr:/.test(pr.siteId)) pr = Object.assign({}, pr, { channel: true, siteIdForListing: typedSiteId || "" });
      }
      if (!pr) return json({ error: "That property wasn't found." }, 404);
      const have = listingFor(pr);
      if (have) return json({ error: "This property already has a listing (" + have.listingId + ").", listingId: have.listingId }, 409);
      const row = resortRows.find((r) => r.resortId && pr.resortId && String(r.resortId).toLowerCase() === String(pr.resortId).toLowerCase()) || {};
      const rowFor = row.resortId ? row : (bbidHit && bbidHit.fromFeed ? bbidHit : row);
      const record = await buildListingFromSn(pr, rowFor, bbid ? { by: "admin", historyNote: "Listing created from NightsBridge BBID " + bbid, extra: { bbid, channelManager: "NightsBridge", snSiteFields: snSite ? snSite.fields : undefined } } : { by: "admin" });
      const listingId = record.listingId;
      await store.setJSON(listingId, record);
      return json({ ok: true, listingId, snSite });
    }

    if (action === "channelLogin" || action === "channelActivate" || action === "channelWelcome") {
      // Admin > Property Listings > "Activate a channel property" (Jean,
      // 2026-10-18): one pop-up, step by step. channelLogin tests the
      // property's Avante login and gives its Site Nr and Site ID (Stock
      // Network's property list doesn't have them). channelActivate makes or
      // links its listing, makes its Channel Property Affiliate and connects
      // it in Property Affiliate with that login, so the property never has
      // to type it. channelWelcome emails the property its hub login.
      const denied = await requireAdmin();
      if (denied) return denied;
      const creds = { username: clean(body.username, 100), clientID: clean(body.clientID, 100), clientSecret: clean(body.clientSecret, 100) };
      const rid = clean(body.resortId, 64).toLowerCase();
      const listings = async () => (await Promise.all((await store.list()).blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
      const listingOf = async () => rid ? (await listings()).find((r) => String(r.resortId || "").toLowerCase() === rid) || null : null;
      const affDir = getStore({ name: "affiliates-directory", consistency: "strong" });

      if (action === "channelLogin") {
        if (!creds.username || !creds.clientID || !creds.clientSecret) return json({ error: "Paste all three: username, client ID and client secret." }, 400);
        let tok;
        try { tok = await new SNClient(creds).login(); } catch (e) { return json({ error: String((e && e.message) || "The login wasn't accepted.") }, 400); }
        const l = await listingOf(), a = tok.siteId ? await affDir.get(tok.siteId, { type: "json" }).catch(() => null) : null;
        return json({ ok: true, siteNr: String(tok.site || ""), siteId: String(tok.siteId || ""), listingId: l ? l.listingId : "", listingSiteId: l ? l.siteId || "" : "",
          affExists: !!a, affTypes: a ? a.types || [] : [], email: (l && (l.email || l.ownerEmail)) || (a && a.email) || "", phone: (l && l.telephone) || (a && a.phone) || "", contactName: (l && l.contactName) || "" });
      }

      if (action === "channelActivate") {
        const siteNr = clean(body.siteNr, 20), siteId = clean(body.siteId, 100), name = clean(body.name, 200), bbid = clean(body.bbid, 40);
        const email = clean(body.email, 600), phone = clean(body.phone, 200), contactName = clean(body.contactName, 120);
        if (!rid || !siteId || !siteNr || !name) return json({ error: "Go back to step 1 and 2: the property and its Avante login are needed." }, 400);
        if (!emailList(email).length || badEmails(email).length) return json({ error: "Type the property's email address (several: separate with commas)." }, 400);
        const done = [], now = new Date().toISOString();
        // 1. Its listing: the one it has, or a new one from the hub's lists.
        let record = await listingOf();
        if (!record) {
          const cur = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
          const row = ((cur && cur.resorts) || []).find((r) => String(r.resortId || "").toLowerCase() === rid) || {};
          record = await buildListingFromSn({ siteId: "nr:" + siteNr + ":" + rid, site: siteNr, resortId: rid, resortName: name, aff: "", units: [], settings: { email, phone },
            channel: true, siteIdForListing: siteId }, row, { by: "admin", historyNote: "Listing created by Activate a channel property" + (bbid ? " (NightsBridge BBID " + bbid + ")" : ""), extra: { bbid, channelManager: bbid ? "NightsBridge" : "" } });
          done.push("Listing " + record.listingId + " made");
        } else done.push("Listing " + record.listingId + " linked");
        const before = { siteNr: record.siteNr || "", siteId: record.siteId || "", email: record.email || "", telephone: record.telephone || "" };
        Object.assign(record, { siteNr, siteId, affId: siteId, channelProperty: "Y", ratesFromChannel: "Y", commissionPct: record.commissionPct || "4.95", existingOnSN: "Y",
          email, telephone: phone || record.telephone || "", contactName: contactName || record.contactName || "", contactEmail: record.contactEmail || email, dateUpdated: now });
        if (bbid && !record.bbid) record.bbid = bbid;
        // 2. Its Channel Property Affiliate (number = Site ID).
        const made = await createPropertyAffiliate({ affId: siteId, name, email, phone, siteNr, type: "channel", note: "Made by Activate a channel property" });
        if (made.created) { record.affiliateCreatedAt = now; done.push("Affiliate " + siteId + " made (Channel Property)"); }
        else done.push("Affiliate " + siteId + " already there" + ((made.aff.types || []).includes("channel") ? "" : " (not ticked Channel Property: check it in Affiliates)"));
        addHistory(record, "admin", "Activated as a channel property (Site Nr " + siteNr + ")", before);
        await store.setJSON(record.listingId, record);
        // 3. Connect it in Property Affiliate with its Avante login.
        let connected = false, connectError = "";
        try {
          const r = await fetch(new URL(request.url).origin + "/api/property", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "connect", username: creds.username, clientID: creds.clientID, clientSecret: creds.clientSecret, aff: siteId, resortId: rid }) });
          const d = await r.json().catch(() => ({}));
          connected = !!(d.ok && d.property); if (!connected) connectError = d.error || "not connected";
        } catch (e) { connectError = String((e && e.message) || e); }
        done.push(connected ? "Connected in Property Affiliate" : "NOT connected: " + connectError);
        return json({ ok: true, listingId: record.listingId, affId: siteId, connected, connectError, done });
      }

      // channelWelcome
      const affId = clean(body.affId, 100), to = clean(body.to, 600);
      const a = affId ? await affDir.get(affId, { type: "json" }).catch(() => null) : null;
      if (!a) return json({ error: "The affiliate wasn't found. Do step 4 first." }, 404);
      if (!emailList(to).length || badEmails(to).length) return json({ error: "Type the email address to send to." }, 400);
      const w = welcomeEmail({ propertyName: a.name, siteNr: a.siteNr, contactName: clean(body.contactName, 120), channelManager: "NightsBridge" }, affId, new URL(request.url).origin + "/login.html?aff=" + encodeURIComponent(affId), { connected: body.connected === true });
      const sent = await sendEmail({ to: emailList(to, 5), subject: w.subject, html: w.html });
      return sent.ok ? json({ ok: true }) : json({ error: "Not sent: " + (sent.error || "unknown reason") }, 502);
    }

    if (action === "createAffiliateFromListing") {
      // One tap from the listing (Jean, 2026-10-14): a new affiliate with the
      // listing's Site ID as its number, its Site Nr and name, typed Channel
      // Property Affiliate (or Property Affiliate) with hook builder access.
      // Never overwrites an affiliate that already exists.
      const denied = await requireAdmin();
      if (denied) return denied;
      const listingId = clean(body.listingId, 20);
      const record = listingId && await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);
      const affId = clean(record.siteId, 100);
      if (!affId) return json({ error: "Type the Site ID (affiliate number) on the listing and tap Save Changes first." }, 400);
      const made = await createPropertyAffiliate({ affId, name: record.propertyName, email: record.email || record.ownerEmail, phone: record.telephone,
        siteNr: record.siteNr, type: record.channelProperty === "Y" ? "channel" : "property", note: "Created from listing " + listingId });
      if (!made.created) return json({ error: "An affiliate with number " + affId + " already exists. Open it in Affiliates to check its type and Site Nr.", exists: true }, 409);
      const now = made.aff.createdAt, aff = made.aff;
      record.affId = affId; record.affiliateCreatedAt = now; record.dateUpdated = now;
      record.history = (Array.isArray(record.history) ? record.history : []).concat([{ at: now, by: "admin", action: "Affiliate " + affId + " created (" + aff.types[0] + ")" }]).slice(-HISTORY_MAX);
      await store.setJSON(listingId, record);
      return json({ ok: true, affId });
    }

    if (action === "setRatesFromChannel") {
      const denied = await requireAdmin();
      if (denied) return denied;
      const listingId = clean(body.listingId, 20);
      const record = listingId && await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);
      const before = { ratesFromChannel: record.ratesFromChannel || "" };
      record.ratesFromChannel = body.on ? "Y" : "";
      record.dateUpdated = new Date().toISOString();
      addHistory(record, "admin", body.on ? "Rates set to come from the channel manager" : "Rates set to be kept in the hub", before);
      await store.setJSON(listingId, record);
      return json({ ok: true });
    }

    if (action === "sendEditLink") {
      // Email the property its private "Edit my listing" link.
      const denied = await requireAdmin();
      if (denied) return denied;
      const listingId = clean(body.listingId, 20);
      const record = listingId && await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);
      const to = clean(body.to, 600);
      if (!emailList(to).length || badEmails(to).length) return json({ error: badEmails(to).length ? "\"" + badEmails(to)[0] + "\" doesn't look like an email address. Separate several with a comma." : "Type the email address." }, 400);
      const sent = await emailEditLink(record, to, new URL(request.url).origin, "admin");
      await store.setJSON(listingId, record);
      return sent.ok ? json({ ok: true }) : json({ error: "Not sent: " + sent.error }, 502);
    }

    if (action === "updateListing") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const listingId = clean(body.listingId, 20);
      if (!listingId) return json({ error: "missing listingId" }, 400);

      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);
      const beforeEdit = JSON.parse(JSON.stringify(record));

      EDITABLE_FIELDS.forEach((field) => {
        if (typeof body[field] === "string") {
          record[field] = clean(body[field], EDITABLE_FIELD_MAX[field] || 500);
        }
      });
      // The property's ResortID on Stock Network: admin types it when SN gives
      // it, so the property can connect before SN's feed lists it (Jean, 2026-10-17).
      if (typeof body.resortId === "string") {
        const rid = body.resortId.trim().toLowerCase();
        if (rid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rid)) return json({ error: "The ResortID should look like be3ac535-8795-4610-b2c8-4378191e4810." }, 400);
        record.resortId = rid;
      }
      if (typeof body.paymentGatewayInUse === "string") {
        record.paymentGatewayInUse = body.paymentGatewayInUse === "Y" ? "Y" : "N";
      }
      if (typeof body.allowSameDayBooking === "string") {
        record.allowSameDayBooking = body.allowSameDayBooking === "Y" ? "Y" : "N";
      }
      if (!NOTIFY_WHO.includes(record.notifyWho)) record.notifyWho = "both";
      const emailErr2 = emailFieldError(record);
      if (emailErr2) return json({ error: emailErr2 }, 400);

      record.dateUpdated = new Date().toISOString();
      addHistory(record, "admin", "Edited in admin", beforeEdit);
      // The type admin typed teaches the hub the words for this Stock Network type code.
      if (record.resortId && String(record.propertyType || "").trim() && record.propertyType !== beforeEdit.propertyType) {
        if (!record.snTypeCode) { const fr = await feedRowByResort(record.resortId).catch(() => null); const c = fr && typeCodeOf(fr); if (c) record.snTypeCode = c; }
        if (record.snTypeCode) await learnTypeName(record.snTypeCode, record.propertyType).catch(() => {});
      }
      record.estateType = record.inEstate === "N" ? "" : estateTypeOf(record.estateType);
      if (record.inEstate === "N") record.complexName = "";
      await store.setJSON(listingId, record);
      await forgetEstates();

      return json({ ok: true, listing: record });
    }

    if (action === "snRepull") {
      // "Pull again from Stock Network": fills only the EMPTY fields of a listing
      // of a property already on Stock Network — never overwrites what's typed.
      const denied = await requireAdmin();
      if (denied) return denied;
      const listingId = clean(body.listingId, 20);
      const record = listingId && await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);
      if (!record.resortId) return json({ error: "This listing isn't linked to a property on Stock Network (no Resort ID)." }, 400);
      const before = JSON.parse(JSON.stringify(record)), filled = [];
      const sn = await readResortInfo(record.resortId);
      if (sn.ok) {
        if (!String(record.description || "").trim() && sn.about) { record.description = sn.about; filled.push("description"); }
        if (!String(record.areaInfo || "").trim() && sn.attractions) { record.areaInfo = sn.attractions; filled.push("areaInfo"); }
        if (!(record.snFacilities || []).length && sn.facilities.length) { record.snFacilities = sn.facilities.slice(0, 80); filled.push("facilities"); }
        if (!(record.unitTypes || []).some((u) => u && u.name) && sn.units.length) {
          record.unitTypes = sn.units.map((u) => ({ name: u.name, numUnits: "1", maxOccupancy: u.maxGuests ? String(u.maxGuests) : "", description: u.description || u.roomType || "" })); filled.push("unit types");
        }
        if (!(record.images || []).length && sn.photos.length) { record.images = await copySnPhotos(sn.photos, listingId, getStore({ name: "property-listing-files", consistency: "strong" })); filled.push("photos"); }
      }
      filled.push(...await fillListingFromFeed(record).catch(() => []));
      // Everything the feed holds for this property, shown to admin so every field can be matched.
      const feed = await feedRowByResort(record.resortId).catch(() => null);
      record.dateUpdated = new Date().toISOString();
      addHistory(record, "admin", filled.length ? "Pulled again from Stock Network: " + filled.join(", ") : "Pulled again from Stock Network: nothing new", before);
      await store.setJSON(listingId, record);
      return json({ ok: true, filled, snRead: !!sn.ok, feed: feed || null, listing: record });
    }

    if (action === "updateStatus") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const listingId = clean(body.listingId, 20);
      const status = clean(body.status, 30);
      const siteNr = typeof body.siteNr === "string" ? clean(body.siteNr, 30) : undefined;

      if (!listingId || STATUSES.indexOf(status) === -1) {
        return json({ error: "Valid listingId and status are required." }, 400);
      }

      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);

      const prevStatus = record.status;
      const beforeStatus = { status: record.status, siteNr: record.siteNr };
      record.status = status;
      record.dateUpdated = new Date().toISOString();
      if (siteNr !== undefined) record.siteNr = siteNr;
      addHistory(record, "admin", "Status / Site Nr", beforeStatus);

      await store.setJSON(listingId, record);

      if (prevStatus !== status) {
        const to = submitterEmailFor(record);
        if (to) {
          context.waitUntil(
            sendNotificationEmail(
              to,
              "Your Avante property listing status has changed — " + status,
              "<p>Hi " + escapeHtml(record.ownerFullName || "") + ",</p>" +
                "<p>Your property listing <strong>" + escapeHtml(record.propertyName) + "</strong> (" +
                escapeHtml(listingId) + ") status is now: <strong>" + escapeHtml(status) + "</strong>.</p>" +
                (status === "Listed"
                  ? "<p>Your property is now live in Avante's Private Property STR Database.</p>"
                  : "") +
                "<p>Questions? Reply to this email or contact Avante Travel directly.</p>"
            )
          );
        }
      }

      return json({ ok: true, listing: record });
    }

        if (action === "deleteListing") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const listingId = clean(body.listingId, 20);
      if (!listingId) return json({ error: "missing listingId" }, 400);

      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);

      await store.delete(listingId);
      return json({ ok: true });
    }

if (action === "getSettings") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const settingsStore = getStore({ name: "property-settings", consistency: "strong" });
      const settings = await settingsStore.get("config", { type: "json" });
      return json({ ok: true, settings: settings || { notificationEmail: "" } });
    }

    if (action === "setSettings") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const notificationEmail = clean(body.notificationEmail, 600);
      if (badEmails(notificationEmail).length) return json({ ok: false, error: "\"" + badEmails(notificationEmail)[0] + "\" doesn't look like an email address. Separate several addresses with a comma." }, 400);
      await saveSettings({ notificationEmail: notificationEmail });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
};

export const config = { path: "/api/property-onboarding" };

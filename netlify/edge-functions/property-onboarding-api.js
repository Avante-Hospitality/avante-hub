import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
// v10 for the Site Nr register only: v8 ignores { onlyIfNew }, which the
// register needs so two requests can't take the same number.
import { getStore as getStoreV10 } from "https://esm.sh/@netlify/blobs@10?bundle";
import { emailList, badEmails, emailText, recipients } from "./lib/emails.js";
import { sendEmail } from "./lib/send-email.js";
// SheetJS from its own CDN (the build SheetJS recommends for Deno).
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import { SITE_REGISTER_STORE, SITE_STATUSES, DEFAULT_SN_SETUP_EMAILS, newEntry, reserveNextSiteNr, reserveSiteNr, getSiteNr, saveSiteNr,
  listSiteNrs, nextFreeSiteNr, findOpenRequest, requestSheetBase64, sheetFileName, setupEmail, confirmationEmail, welcomeEmail, READY_TO_SEND, CHANNEL_WELCOME_DEFAULT, PROPERTY_WELCOME_DEFAULT, fillWelcome, welcomeHtml } from "./lib/sn-site-register.js";
import { readListingScreenshots } from "./lib/listing-reader.js";
import { HOOKS_URL, makeHooksTicket } from "./lib/hooks-ticket.js";
import { propertyTags, unitTag, libPost } from "./lib/photo-library.js";
import { isAdminToken } from "./lib/admin-session.js";
import "../../listing-ready.js"; // globalThis.ListingReady: the Ready check, shared with the listing form
import { isAffiliateSession } from "./lib/affiliate-session.js";
import { createPropertyAffiliate } from "./lib/affiliates.js";
import { SNClient } from "./lib/sn-client.js";
import { readResortInfo, copySnPhotos } from "./lib/sn-resort-info.js";
import { findSetUps, feedRowByResort, fillFromFeed, typeNames, learnTypeName, typeCodeOf } from "./lib/sn-feed.js";
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
    // Fields that are new on the record count too (a field the listing didn't have yet).
    [...new Set(Object.keys(before).concat(Object.keys(record)))].forEach((k) => {
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
// Where a listing photo is filed in the shared photo library (Jean,
// 2026-10-19): the listing, its property (ResortID, once it has one) and,
// for a unit photo, its unit type. Then the hook builder finds it under the
// property and the unit type, not only under the listing.
function libraryTagsFor(record, im) {
  const name = record.propertyName || "Property";
  const tags = propertyTags({ resortId: record.resortId, listingId: record.listingId, name }).map((t) => ({ key: t.key, name: t.name }));
  const u = im && im.type === "Unit" && im.unitTypeName ? unitTag(record.resortId, im.unitTypeName, name) : null;
  if (u) tags.push({ key: u.key, name: u.name });
  return tags;
}
// File the listing's photos already in the library again (adds tags, never removes any).
async function retagListingPhotos(record) {
  const lib = record.libraryPhotos || {};
  const changes = Object.entries(lib).map(([key, id]) => ({ id, tags: libraryTagsFor(record, (record.images || []).find((im) => im && im.key === key)) }));
  if (!changes.length) return { tagged: 0 };
  const d = await libPost({ op: "tagMany", changes });
  return d && d.ok ? { tagged: d.tagged || 0 } : { error: (d && d.error) || "The photo library didn't answer." };
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
  const av = await fetch(origin + "/api/sn-availability", { method: "POST", headers: { "content-type": "application/json", "x-pa-sync-secret": Deno.env.get("PA_SYNC_SECRET") || "" },
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


async function sendSnSetupSheet(entry, by, to) {
  const recipientsTo = emailText(to || (await getSnSetupEmails()), 20);
  const filename = sheetFileName(entry);
  const { subject, html } = setupEmail(entry);
  let sent;
  try {
    sent = await sendEmail({ to: recipientsTo, subject, html, attachments: [{ filename, content: requestSheetBase64(XLSX, [entry]) }], replyTo: "admin@avantehospitality.co.za" });
  } catch (e) {
    sent = { ok: false, error: "Could not make the sheet: " + String((e && e.message) || e) };
  }
  const at = new Date().toISOString();
  entry.sendLog = (Array.isArray(entry.sendLog) ? entry.sendLog : []).concat([{ at, by, to: recipientsTo, file: filename, ok: sent.ok, error: sent.ok ? undefined : sent.error }]).slice(-50);
  if (sent.ok && (entry.status === "Spare" || entry.status === READY_TO_SEND)) entry.status = "Sent";
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

    if (action === "getForEdit" || action === "update" || action === "completeListing" || action === "libraryRetag" || action === "completeLater" || action === "letAvante" || action === "markSentToSN" || action === "emailSNFiles" || action === "libraryAdd" || action === "addPhotos" || action === "removePhoto") {
      // Reopen a listing in the onboarding form: admin (token) or the
      // submitter with their private edit key.
      const listingId = clean(body.listingId, 20);
      if (!listingId) return json({ error: "missing listingId" }, 400);
      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "This listing wasn't found." }, 404);
      const isAdmin = await verifyAdminToken(body.token);
      const keyOk = !!record.editToken && clean(body.key, 200) === record.editToken;
      if (!isAdmin && !keyOk) return json({ error: "This edit link isn't valid. Ask Avante Travel for a new one." }, 401);
      if (["markSentToSN", "emailSNFiles", "addPhotos", "removePhoto"].includes(action) && !isAdmin) return json({ error: "Only Avante admin can do this." }, 401);

      if (action === "getForEdit") {
        const out = Object.assign({}, record);
        delete out.agreementToken;
        delete out.editToken;
        if (!isAdmin) { delete out.history; delete out.photosToken; }
        return json({ ok: true, listing: out, asAdmin: isAdmin, waitingForSetUp: record.hostedSetup === "completing" });
      }

      if (action === "completeLater") {
        // "Complete later" (Jean, 2026-10-19): the property stops for now. Admin
        // hears where it got to; the reminders (1, 3, 5 and 10 days) follow.
        const now = new Date().toISOString(), step = Math.max(1, Math.min(8, parseInt(body.step, 10) || record.lastStep || 1));
        Object.assign(record, { laterAt: now, lastStep: step });
        addHistory(record, "property", "Will complete later (at step " + step + " of 8)");
        // The link again, so it's at the top of their inbox.
        const to = emailList(record.contactEmail || record.email, 5);
        if (to.length) await emailEditLink(record, to, new URL(request.url).origin, "property").catch(() => null);
        await store.setJSON(listingId, record);
        const notifyTo = await getNotificationEmail();
        if (notifyTo) context.waitUntil(sendNotificationEmail(notifyTo, "Will complete later: " + (record.propertyName || listingId),
          "<p><b>" + escapeHtml(record.propertyName || "") + "</b> (listing " + escapeHtml(listingId) + ") tapped <b>Complete later</b> at step " + step + " of 8.</p>" +
          "<p>Still to do: " + escapeHtml(clean(body.todo, 600) || "see the Ready check") + ".</p><p>The hub reminds them after 1, 3, 5 and 10 days.</p>"));
        return json({ ok: true });
      }

      if (action === "letAvante") {
        // "Let Avante set it up" (Jean, 2026-10-19): the property sends what it
        // has (photos, rate sheets, screenshots, files, links, a note) and
        // Avante completes the listing. Admin gets all of it by email.
        const urls = String(body.urls || "").split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/i.test(u)).slice(0, 20);
        const note = clean(body.note, 2000), files = (Array.isArray(body.files) ? body.files : []).slice(0, 40)
          .map((f) => ({ key: clean(f && f.key, 300), name: clean(f && f.name, 150) })).filter((f) => f.key);
        if (!urls.length && !note && !files.length) return json({ error: "Add a file, a link or a note first." }, 400);
        const now = new Date().toISOString(), origin = new URL(request.url).origin;
        record.helpRequest = { at: now, urls, note, files };
        addHistory(record, "property", "Asked Avante to set it up (" + files.length + " file(s), " + urls.length + " link(s))");
        await store.setJSON(listingId, record);
        const notifyTo = await getNotificationEmail();
        if (notifyTo) context.waitUntil(sendNotificationEmail(notifyTo, "Please set it up: " + (record.propertyName || listingId),
          "<p><b>" + escapeHtml(record.propertyName || "") + "</b> (listing " + escapeHtml(listingId) + ") asks Avante to set up its listing.</p>" +
          (note ? "<p><b>Note:</b><br>" + escapeHtml(note).replace(/\n/g, "<br>") + "</p>" : "") +
          (urls.length ? "<p><b>Links:</b><br>" + urls.map((u) => '<a href="' + escapeHtml(u) + '">' + escapeHtml(u) + "</a>").join("<br>") + "</p>" : "") +
          (files.length ? "<p><b>Files:</b><br>" + files.map((f) => '<a href="' + escapeHtml(origin + "/api/property-file?key=" + encodeURIComponent(f.key)) + '">' + escapeHtml(f.name || "file") + "</a>").join("<br>") + "</p>" : "") +
          "<p>Open the listing in Admin &gt; Property Listings and tap <b>Open full form to edit</b>. Its <b>Read screenshots &amp; documents</b> can fill in most of it from these.</p>"));
        return json({ ok: true });
      }

      if (action === "libraryRetag") {
        // After a save: the listing's library photos filed under its property and unit types too.
        return json(Object.assign({ ok: true }, await retagListingPhotos(record)));
      }

      if (action === "completeListing") {
        // Jean (2026-10-19): a property not on a channel manager finished its
        // listing (Ready check all Done) and tapped Save. Only now does it get
        // its Site Nr (the hub is the only one giving them out). The email to
        // Stock Network is on hold for now: admin sends the files from the
        // listing ("Send the files by email"), which marks the Site Nr Sent.
        if (record.hostedSetup !== "completing") return json({ ok: true, already: true, siteNr: record.siteNr || "" });
        // The same Ready check the form shows (Jean, 2026-10-19): a Site Nr only when it is all Done.
        const todo = globalThis.ListingReady.todo(Object.assign({}, record, { treePlaced: !!record.treePlace, editing: true }));
        if (todo.length) return json({ error: "Not ready yet. Still to do: " + todo.join(", ") + "." }, 400);
        // Two taps at once (Jean, 2026-10-19): only the first one gets a Site Nr.
        // The store refuses the second claim; that tap answers with the number given.
        const reg = siteRegister(), claimKey = "complete:" + listingId;
        const claimed = await reg.setJSON(claimKey, { at: new Date().toISOString() }, { onlyIfNew: true });
        const old = claimed && claimed.modified === false ? await reg.get(claimKey, { type: "json" }).catch(() => null) : null;
        const stuck = old && Date.now() - Date.parse(old.at) > 120e3; // an earlier try that never finished
        if (stuck) await reg.setJSON(claimKey, { at: new Date().toISOString() });
        if (claimed && claimed.modified === false && !stuck) {
          for (let i = 0; i < 10; i++) {
            const r = await store.get(listingId, { type: "json" }).catch(() => null);
            if (r && r.hostedSetup !== "completing") return json({ ok: true, already: true, siteNr: r.siteNr || "" });
            await new Promise((ok) => setTimeout(ok, 500));
          }
          return json({ error: "Your listing is being sent to Avante. Wait a minute and open your link again." }, 409);
        }
        const now = new Date().toISOString();
        const entry = newEntry({ propertyName: record.propertyName, channelManager: "None yet", contactName: record.contactName || record.ownerFullName, phone: record.telephone || record.contactPhone,
          email: record.contactEmail || record.email, description: record.description || record.propertyName, area: record.area, district: record.district, suburb: record.suburb,
          propertyAffiliate: true, listingId, note: record.listedOn ? "Listed on now: " + record.listedOn : "" });
        entry.status = READY_TO_SEND;
        try { entry.siteNr = await reserveNextSiteNr(reg, entry); }
        catch (e) { await reg.delete(claimKey).catch(() => {}); throw e; }
        // Read it again: a step saved while the number was being given is kept.
        const done = Object.assign((await store.get(listingId, { type: "json" }).catch(() => null)) || record,
          { siteNr: String(entry.siteNr), hostedSetup: "ready", completedAt: now, dateUpdated: now });
        addHistory(done, isAdmin ? "admin" : "property", "Listing complete: Avante Site Nr " + entry.siteNr + " given (ready for Stock Network)", { siteNr: "" });
        await store.setJSON(listingId, done);
        const notifyTo = await getNotificationEmail();
        if (notifyTo) context.waitUntil(sendNotificationEmail(notifyTo, "Listing complete, ready for Stock Network: " + (record.propertyName || listingId) + " (Site Nr " + entry.siteNr + ")",
          "<p><b>" + escapeHtml(record.propertyName || "") + "</b> (listing " + escapeHtml(listingId) + ") completed its listing and got Avante Site Nr <b>" + escapeHtml(entry.siteNr) + "</b>.</p>" +
          "<p>Send it to Stock Network: Admin &gt; Property Listings &gt; View the listing &gt; <b>Send the files by email</b>.</p>"));
        return json({ ok: true, siteNr: entry.siteNr });
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
        // A completed listing's Site Nr waiting to be sent is now Sent (the hourly check looks for it).
        if (ok && siteNr) {
          const reg = siteRegister(), e = await getSiteNr(reg, siteNr).catch(() => null);
          if (e && e.listingId === listingId && (e.status === READY_TO_SEND || e.status === "Spare")) {
            e.status = "Sent"; e.updatedAt = entry.at;
            e.sendLog = (Array.isArray(e.sendLog) ? e.sendLog : []).concat([{ at: entry.at, by: "Listing files emailed by admin", to: entry.to, file: entry.files.join(", "), ok: true }]).slice(-50);
            await saveSiteNr(reg, e);
          }
        }
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
        const tags = libraryTagsFor(record, im);
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
      // A property still completing its first listing (not on a platform, Jean
      // 2026-10-19) sets its own location; after that it's locked.
      const ownsLocation = isAdmin || before.hostedSetup === "completing";
      if (!isAdmin) record.siteNr = before.siteNr || "";   // the Site Nr is allocated by Avante
      if (!ownsLocation) {
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
      // A step-by-step save (draft: the form saves on every Next, Jean 2026-10-19)
      // may come before the owner's name is typed.
      const draft = body.draft === true;
      // Where the property got to, so its link opens there next time.
      if (Number.isInteger(body.lastStep) && body.lastStep > 0 && body.lastStep < 20) record.lastStep = body.lastStep;
      if (!record.propertyName || (!record.ownerFullName && !draft)) return json({ error: "Property name and owner name can't be empty." }, 400);
      const emailErr1 = emailFieldError(record);
      if (emailErr1) return json({ error: emailErr1 }, 400);
      record.dateUpdated = new Date().toISOString();
      const changed = addHistory(record, isAdmin ? "admin" : (record.submittedBy || "owner"), "Edited", before);
      if (!changed) return json({ ok: true, listing: { listingId: listingId }, unchanged: true });
      // Completed while this save was on its way (Jean, 2026-10-19)? Keep the
      // Site Nr it was given, so the next save doesn't ask for another one.
      const latest = await store.get(listingId, { type: "json" }).catch(() => null);
      if (latest && latest.hostedSetup !== before.hostedSetup) {
        Object.assign(record, { hostedSetup: latest.hostedSetup, completedAt: latest.completedAt, siteNr: isAdmin ? record.siteNr || latest.siteNr : latest.siteNr });
      }
      await store.setJSON(listingId, record);
      await forgetEstates();

      // Admin hears about an owner's changes, not about every step of a listing still being completed.
      if (!isAdmin && !(draft && before.hostedSetup === "completing")) {
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
      // straight away. It gets no Site Nr yet (Jean, 2026-10-19): the hub gives
      // it one only when its listing is complete (action completeListing).
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

      // Not on a platform: asked before and not finished? The same listing, its link again.
      let site = null, loc = {}, repeat = false, hostedPrev = null;
      if (hosted) {
        const same = (a, b) => String(a || "").toLowerCase().replace(/[^a-z0-9@.]+/g, "") === String(b || "").toLowerCase().replace(/[^a-z0-9@.]+/g, "");
        hostedPrev = (await Promise.all((await store.list()).blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null))))
          .find((r) => r && r.hostedSetup === "completing" && same(r.propertyName, propertyName) && same(r.contactEmail || r.email, emailText(contact.email))) || null;
        repeat = !!hostedPrev;
        if (!hostedPrev) loc = await guessSnLocation(propertyName);
      }
      // Not on Stock Network yet: reserve the Site Nr and send the sheet.
      if (!row && !hosted) {
        // Submitted before and not set up yet? Same Site Nr, nothing sent again.
        site = await findOpenRequest(siteRegister(), { bbid, propertyName, email: emailText(contact.email) });
        if (site) {
          repeat = true;
          if (wantsAffiliate && !site.propertyAffiliate) { site.propertyAffiliate = true; await saveSiteNr(siteRegister(), site); }
        } else {
          loc = await guessSnLocation(propertyName);
          const entry = newEntry({ propertyName, bbid, channelManager: cm, eresRef, contactName: contact.name, phone: contact.phone, email: emailText(contact.email),
            area: loc.area, district: loc.district, suburb: loc.suburb, propertyAffiliate: wantsAffiliate, note: "Listed on now: " + listedOn });
          entry.siteNr = await reserveNextSiteNr(siteRegister(), entry);
          site = await sendSnSetupSheet(entry, "List your property page");
          const conf = confirmationEmail(site);
          // At most 5 addresses: the confirmation goes to whatever was typed on a public page.
          context.waitUntil(sendEmail({ to: emailList(contact.email, 5), subject: conf.subject, html: conf.html }));
        }
      }

      const extra = { requestContact: contact, contactName: contact.name, contactPhone: contact.phone, contactEmail: emailText(contact.email), notifyWho: "both",
        channelManager: cm, bbid, eresRef, listedOn, requestedAt: new Date().toISOString() };
      let record = null;
      if (wantsAffiliate && row && !already) {
        record = await buildListingFromSn({ site: String(row.siteId || ""), resortId: row.resortId, resortName: row.name, aff: "", units: [], settings: { email: contact.email, phone: contact.phone }, channel: true, siteIdForListing: "" },
          row, { by: "property", status: "Requested", historyNote: "Listing request from the List your property page, BBID " + bbid + ", found on Stock Network", extra });
      } else if (wantsAffiliate && !already && !hostedPrev && !(site && site.listingId)) {
        const now = new Date().toISOString(), listingId = genListingId();
        record = Object.assign({ listingId, status: "Requested", dateSubmitted: now, dateUpdated: now }, submittedFields({ propertyName, email: contact.email, telephone: contact.phone, submittedBy: "Owner" }),
          { editToken: genToken(), agreementSigned: "Y", channelProperty: cm !== "None yet" ? "Y" : "", ratesFromChannel: cm !== "None yet" ? "Y" : "", commissionPct: cm !== "None yet" ? "4.95" : "",
            needsTreePlace: loc.place ? "" : "Y", hostedSetup: hosted ? "completing" : "",
            siteNr: site ? String(site.siteNr) : "" }, extra);
        if (loc.place) { record.latitude = String(loc.lat); record.longitude = String(loc.lng); await applyTreePlace(record, loc.place, false); }
        addHistory(record, "property", "Listing request from the List your property page (" + cm + (bbid ? ", BBID " + bbid : eresRef ? ", eRes ref " + eresRef : "") +
          (site ? "; Site Nr " + site.siteNr + " reserved" + (site.status === "Sent" ? ", sheet sent to Stock Network" : ", sheet NOT sent") : hosted ? "; Site Nr given when the listing is complete" : "") + ")");
      }
      if (record) {
        await store.setJSON(record.listingId, record);
        if (site) { site.listingId = record.listingId; await saveSiteNr(siteRegister(), site); }
      }
      // Not on a platform: the completion link goes out straight away (also
      // again when the property asks a second time). At most 5 addresses: it
      // goes to whatever was typed on a public page.
      let linkSent = false;
      const linkRecord = hosted ? record || hostedPrev : null;
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
            : hosted ? "<p>Not on a platform: no Site Nr yet. The hub gives it one when the property's listing is complete, and tells you.</p>" + (hostedPrev ? "<p>Asked before: listing " + escapeHtml(hostedPrev.listingId) + ", the link was sent again.</p>" : "")
            : repeat ? "<p>Asked before: same Site Nr <b>" + escapeHtml(site.siteNr) + "</b> (" + escapeHtml(site.status) + "). Nothing was sent to Stock Network again.</p>"
            : "<p>Site Nr <b>" + escapeHtml(site.siteNr) + "</b> reserved. " + (site.status === "Sent" ? "The Stock Network sheet was emailed to " + escapeHtml(site.sendLog[site.sendLog.length - 1].to) + "."
              : "<b>The Stock Network sheet could NOT be sent</b> (" + escapeHtml(site.sendLog[site.sendLog.length - 1].error || "") + "). Send it again from Admin &gt; Site Nrs.") + "</p>") +
          (already ? "<p>It already has a listing (" + escapeHtml(already.listingId) + "); no new listing was made.</p>"
            : record && hosted ? "<p>Listing <b>" + escapeHtml(record.listingId) + "</b> was made, status Requested. " + (linkSent ? "The link to complete it was emailed to the property." : "<b>The link to complete it could NOT be emailed</b>: tap <b>Email the edit link</b> in Admin &gt; Property Listings.") + "</p>"
            : record ? "<p>Listing <b>" + escapeHtml(record.listingId) + "</b> was made, status Requested. Check it in Admin &gt; Property Listings, then tap <b>Email the edit link</b>.</p>"
            : "<p>No listing was made (the property did not ask to be a property affiliate).</p>")));
      }
      // A new listing (not on a platform) opens straight away in the step-by-step
      // form (Jean, 2026-10-19). Asked before: only by the emailed link.
      const continueLink = hosted && record ? editLinkEmail(record, new URL(request.url).origin).link : undefined;
      return json({ ok: true, found: !!row, name: row ? row.name : "", already: !!already, siteNr: site ? site.siteNr : null, repeat, listing: !!(record || hostedPrev || (site && site.listingId)), linkSent, continueLink });
    }

    if (action === "remindListings") {
      // Every morning (netlify/functions/listing-reminders.mjs): a property not
      // on a platform that hasn't finished its listing gets a reminder 1, 3, 5
      // and 10 days after its last save (Jean, 2026-10-19), with its link and
      // "Let Avante set it up". Saving again starts the count again; asking
      // Avante to set it up stops it.
      const secret = Deno.env.get("PA_SYNC_SECRET") || "";
      if (!secret || request.headers.get("x-pa-sync-secret") !== secret) return json({ error: "forbidden" }, 403);
      const DAYS = [1, 3, 5, 10], nowMs = Date.now(), origin = new URL(request.url).origin, out = [];
      for (const b of (await store.list()).blobs) {
        const rec = await store.get(b.key, { type: "json" }).catch(() => null);
        if (!rec || rec.hostedSetup !== "completing" || rec.helpRequest) continue;
        const base = rec.dateUpdated || rec.dateSubmitted;
        if (!rec.reminders || rec.reminders.base !== base) rec.reminders = { base, sent: 0 };
        const i = rec.reminders.sent;
        if (i >= DAYS.length || nowMs - Date.parse(base) < DAYS[i] * 864e5) continue;
        const to = emailList(rec.contactEmail || rec.email, 5);
        if (!to.length) continue;
        const m = editLinkEmail(rec, origin);
        const sent = await sendEmail({ to, subject: "Your Avante listing is waiting: " + (rec.propertyName || ""),
          html: "<p>Hello,</p><p>Your listing for <b>" + escapeHtml(rec.propertyName || "your property") + "</b> isn't finished yet. It's saved, so you carry on where you stopped:<br><a href=\"" + m.link + "\">Complete my listing</a></p>" +
            "<p>Rather have Avante do it? Send us your photos, rate sheet, screenshots or links and we'll set it up for you:<br><a href=\"" + m.link + "#help\">Let Avante set it up</a></p>" +
            "<p>Questions? Reply to this email or write to info@avantehospitality.co.za.</p><p>Avante Hospitality</p>" });
        if (!sent.ok) { out.push({ listingId: rec.listingId, error: sent.error }); continue; }
        rec.reminders.sent = i + 1; rec.reminders.lastAt = new Date().toISOString();
        rec.history = (Array.isArray(rec.history) ? rec.history : []).concat([{ at: rec.reminders.lastAt, by: "hub", action: "Reminder " + (i + 1) + " of " + DAYS.length + " emailed" }]).slice(-HISTORY_MAX);
        await store.setJSON(rec.listingId, rec);
        out.push({ listingId: rec.listingId, reminder: i + 1 });
      }
      return json({ ok: true, reminded: out });
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
        // The listing's pin helps match a property found by name (one not on a channel manager).
        const recs = await Promise.all(waiting.map((e) => (e.listingId ? store.get(e.listingId, { type: "json" }).catch(() => null) : null)));
        try { found = await findSetUps(waiting.map((e, i) => ({ siteNr: e.siteNr, bbid: e.bbid, name: e.propertyName || (recs[i] && recs[i].propertyName),
          latitude: recs[i] && recs[i].latitude, longitude: recs[i] && recs[i].longitude }))); }
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
        } else {
          // Stock Network's list has no Site ID: admin pastes the property's Avante
          // login in Site Nrs > Activate, which gives it (Jean, 2026-10-19).
          e.needsLogin = true;
          affNote = "found by " + f.by + "; paste its Avante login in Admin > Site Nrs > Activate to make its hub account and email it";
        }
        if (e.listingId) {
          const rec = await store.get(e.listingId, { type: "json" }).catch(() => null);
          if (rec) {
            const before = { resortId: rec.resortId || "", siteId: rec.siteId || "", affId: rec.affId || "" };
            rec.resortId = rec.resortId || f.resortId; if (affId) { rec.siteId = rec.siteId || affId; rec.affId = rec.affId || affId; }
            rec.siteNr = rec.siteNr || String(e.siteNr); rec.existingOnSN = "Y"; rec.dateUpdated = now;
            addHistory(rec, "admin", "Set up on Stock Network (Site Nr " + e.siteNr + "), found by the hourly check", before);
            await store.setJSON(e.listingId, rec);
            context.waitUntil(retagListingPhotos(rec).catch(() => null));
          }
        }
        if (affId && !e.welcomeSentAt && emailList(e.email).length) {
          const w = welcomeEmail(e, affId, origin + "/login.html?aff=" + encodeURIComponent(affId));
          const sent = await sendEmail({ to: emailList(e.email, 5), subject: w.subject, html: w.html }).catch(() => ({ ok: false }));
          if (sent.ok) e.welcomeSentAt = now;
        }
        await saveSiteNr(reg, e);
        done.push({ siteNr: e.siteNr, name: e.propertyName, resortId: f.resortId, affId, affNote, welcomed: !!e.welcomeSentAt, needsLogin: !!e.needsLogin, listingId: e.listingId || "" });
      }
      const notifyTo = done.length ? await getNotificationEmail() : "";
      if (notifyTo) {
        context.waitUntil(sendNotificationEmail(notifyTo, "Set up on Stock Network: " + done.map((d) => d.name).join(", ").slice(0, 150),
          "<p>The hourly check found these properties on Stock Network:</p><ul>" + done.map((d) => "<li><b>" + escapeHtml(d.name) + "</b> — Site Nr " + escapeHtml(d.siteNr) +
            ", ResortID " + escapeHtml(d.resortId) + (d.affId ? ", affiliate " + escapeHtml(d.affId) : "") + " (" + escapeHtml(d.affNote) + ")" +
            (d.listingId ? ", listing " + escapeHtml(d.listingId) + " linked" : "") + (d.welcomed ? ", hub login emailed" : d.needsLogin ? "" : ", hub login NOT emailed") + "</li>").join("") +
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

      // A property from "Show properties". (Typing a BBID or Site Nr here was
      // replaced by Activate a channel property, Jean 2026-10-18.)
      const pr = props.find((x) => x.siteId === clean(body.siteId, 100));
      if (!pr) return json({ error: "That property wasn't found." }, 404);
      const have = listingFor(pr);
      if (have) return json({ error: "This property already has a listing (" + have.listingId + ").", listingId: have.listingId }, 409);
      const row = resortRows.find((r) => r.resortId && pr.resortId && String(r.resortId).toLowerCase() === String(pr.resortId).toLowerCase()) || {};
      const record = await buildListingFromSn(pr, row, { by: "admin" });
      const listingId = record.listingId;
      await store.setJSON(listingId, record);
      return json({ ok: true, listingId });
    }

    if (action === "channelLogin" || action === "channelActivate" || action === "channelWelcome" || action === "channelWelcomeText" || action === "channelWelcomeTemplate") {
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
      // Also a property not on a channel manager (Jean, 2026-10-19): its login's
      // Site Nr is the one Avante gave it, so its Site Nrs entry finds its listing
      // even before the hourly check has found it on Stock Network.
      const regEntryOf = async (nr) => (nr ? await getSiteNr(siteRegister(), nr).catch(() => null) : null);
      // Its listing: by ResortID, by the Site Nrs entry, else by the Site Nr on the listing
      // (a Site Nr given out before the hub's Site Nrs list, e.g. Little Gem's 6019, Jean 2026-10-19).
      const listingOf = async (entry, siteNr) => {
        const all = await listings(), nr = String(siteNr || (entry && entry.siteNr) || "").trim();
        return (rid && all.find((r) => String(r.resortId || "").toLowerCase() === rid)) ||
          (entry && entry.listingId && all.find((r) => r.listingId === entry.listingId)) ||
          (nr && all.find((r) => String(r.siteNr || "").trim() === nr)) || null;
      };
      // Not on a channel manager: so its Site Nrs entry says, or its listing was made that way,
      // or its listing names no channel manager (no BBID, not a channel property).
      const hostedOf = (entry, l) => {
        if (entry && entry.channelManager) return entry.channelManager === "None yet";
        return !!(l && (l.hostedSetup || (l.channelProperty !== "Y" && !l.bbid && !l.channelManager)));
      };
      const affDir = getStore({ name: "affiliates-directory", consistency: "strong" });

      if (action === "channelLogin") {
        if (!creds.username || !creds.clientID || !creds.clientSecret) return json({ error: "Paste all three: username, client ID and client secret." }, 400);
        let tok;
        try { tok = await new SNClient(creds).login(); } catch (e) { return json({ error: String((e && e.message) || "The login wasn't accepted.") }, 400); }
        const entry = await regEntryOf(tok.site);
        // The login must be the property's own (a pasted login of another property would link the wrong one).
        if (entry && entry.resortId && rid && String(entry.resortId).toLowerCase() !== rid)
          return json({ error: "This login is for Avante Site Nr " + entry.siteNr + " (" + (entry.propertyName || "another property") + "), not the property you picked." }, 400);
        const l = await listingOf(entry, tok.site), a = tok.siteId ? await affDir.get(tok.siteId, { type: "json" }).catch(() => null) : null;
        return json({ ok: true, siteNr: String(tok.site || ""), siteId: String(tok.siteId || ""), listingId: l ? l.listingId : "", listingSiteId: l ? l.siteId || "" : "", hosted: hostedOf(entry, l),
          affExists: !!a, affTypes: a ? a.types || [] : [], email: (l && (l.email || l.contactEmail || l.ownerEmail)) || (entry && entry.email) || (a && a.email) || "",
          phone: (l && l.telephone) || (entry && entry.phone) || (a && a.phone) || "", contactName: (l && l.contactName) || (entry && entry.contactName) || "" });
      }

      if (action === "channelActivate") {
        const siteNr = clean(body.siteNr, 20), siteId = clean(body.siteId, 100), name = clean(body.name, 200), bbid = clean(body.bbid, 40);
        const email = clean(body.email, 600), phone = clean(body.phone, 200), contactName = clean(body.contactName, 120);
        if (!rid || !siteId || !siteNr || !name) return json({ error: "Go back to step 1 and 2: the property and its Avante login are needed." }, 400);
        if (!emailList(email).length || badEmails(email).length) return json({ error: "Type the property's email address (several: separate with commas)." }, 400);
        const done = [], now = new Date().toISOString(), reg = siteRegister(), entry = await regEntryOf(siteNr);
        // 1. Its listing: the one it has, or a new one from the hub's lists.
        let record = await listingOf(entry, siteNr);
        const hosted = hostedOf(entry, record);
        if (!record) {
          const cur = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
          const row = ((cur && cur.resorts) || []).find((r) => String(r.resortId || "").toLowerCase() === rid) || {};
          record = await buildListingFromSn({ siteId: "nr:" + siteNr + ":" + rid, site: siteNr, resortId: rid, resortName: name, aff: "", units: [], settings: { email, phone },
            channel: true, siteIdForListing: siteId }, row, { by: "admin", historyNote: "Listing created by Activate a channel property" + (bbid ? " (NightsBridge BBID " + bbid + ")" : ""), extra: { bbid, channelManager: bbid ? "NightsBridge" : "" } });
          done.push("Listing " + record.listingId + " made");
        } else done.push("Listing " + record.listingId + " linked");
        const before = { siteNr: record.siteNr || "", siteId: record.siteId || "", email: record.email || "", telephone: record.telephone || "" };
        Object.assign(record, { siteNr, siteId, affId: siteId, resortId: record.resortId || rid, existingOnSN: "Y",
          email, telephone: phone || record.telephone || "", contactName: contactName || record.contactName || "", contactEmail: record.contactEmail || email, dateUpdated: now });
        // A channel property: 4.95% + VAT, rates from its channel manager. One not on
        // a channel manager keeps its own rates in the hub (a Property Affiliate).
        if (!hosted) Object.assign(record, { channelProperty: "Y", ratesFromChannel: "Y", commissionPct: record.commissionPct || "4.95" });
        if (bbid && !record.bbid) record.bbid = bbid;
        // 2. Its affiliate (number = Site ID): Channel Property Affiliate, or Property Affiliate.
        const type = hosted ? "property" : "channel", typeName = hosted ? "Property" : "Channel Property";
        const made = await createPropertyAffiliate({ affId: siteId, name, email, phone, siteNr, type, note: "Made by Activate (" + typeName + ")" });
        if (made.created) { record.affiliateCreatedAt = now; done.push("Affiliate " + siteId + " made (" + typeName + ")"); }
        else {
          // Already there with the other type (Jean, 2026-10-19): set it to this one, or a
          // channel property would connect as a full property (front store, calendar).
          const types = made.aff.types || [], other = hosted ? "channel" : "property";
          if (!types.includes(type) || types.includes(other)) {
            made.aff.types = types.filter((t) => t !== other).concat(types.includes(type) ? [] : [type]);
            made.aff.updatedAt = now;
            await affDir.setJSON(siteId, made.aff);
            done.push("Affiliate " + siteId + " already there: set to " + typeName);
          } else done.push("Affiliate " + siteId + " already there");
        }
        addHistory(record, "admin", "Activated as a " + (hosted ? "property" : "channel property") + " (Site Nr " + siteNr + ")", before);
        await store.setJSON(record.listingId, record);
        context.waitUntil(retagListingPhotos(record).catch(() => null));
        // 3. Connect it in Property Affiliate with its Avante login.
        let connected = false, connectError = "";
        try {
          const r = await fetch(new URL(request.url).origin + "/api/property", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "connect", username: creds.username, clientID: creds.clientID, clientSecret: creds.clientSecret, aff: siteId, resortId: rid }) });
          const d = await r.json().catch(() => ({}));
          connected = !!(d.ok && d.property); if (!connected) connectError = d.error || "not connected";
        } catch (e) { connectError = String((e && e.message) || e); }
        done.push(connected ? "Connected in Property Affiliate" : "NOT connected: " + connectError);
        // 4. Its Site Nrs entry: set up, with its Site ID (the hourly check can't get that).
        if (entry) {
          Object.assign(entry, { status: "Set up", setUpAt: entry.setUpAt || now, resortId: entry.resortId || rid, snSiteId: siteId, snName: entry.snName || name,
            listingId: entry.listingId || record.listingId, needsLogin: false, updatedAt: now });
          if (hosted && !entry.goLive) entry.goLive = GO_LIVE.waiting;
          await saveSiteNr(reg, entry);
          done.push("Site Nr " + siteNr + " marked Set up");
        }
        return json({ ok: true, listingId: record.listingId, affId: siteId, hosted, connected, connectError, done });
      }

      // The welcome email's wording, kept in the property settings (Jean, 2026-10-18).
      const template = async () => { const t = (await getSettings()).channelWelcome; return t && t.subject && t.body ? t : CHANNEL_WELCOME_DEFAULT; };
      if (action === "channelWelcomeTemplate") {
        if (body.op === "save") {
          const subject = clean(body.subject, 200), text = String(body.body || "").replace(/\r/g, "").slice(0, 6000).trim();
          if (!subject || !text) return json({ error: "Type the subject and the text." }, 400);
          if (text.indexOf("{loginLink}") === -1) return json({ error: "Keep {loginLink} in the text: it's the link the property logs in with." }, 400);
          await saveSettings({ channelWelcome: { subject, body: text } });
        } else if (body.op === "reset") await saveSettings({ channelWelcome: null });
        const t = await template();
        return json({ ok: true, subject: t.subject, body: t.body, isDefault: t === CHANNEL_WELCOME_DEFAULT });
      }
      const affId = clean(body.affId, 100);
      const a = affId ? await affDir.get(affId, { type: "json" }).catch(() => null) : null;
      if (!a) return json({ error: "The affiliate wasn't found. Do step 4 first." }, 404);
      const vars = { property: a.name, contact: clean(body.contactName, 120), siteNr: a.siteNr, affiliateNumber: affId, loginLink: new URL(request.url).origin + "/login.html?aff=" + encodeURIComponent(affId) };
      // A Property Affiliate (not on a channel manager) gets the property wording.
      const t = (a.types || []).includes("channel") ? await template() : PROPERTY_WELCOME_DEFAULT;
      // Step 5 shows the email filled in, so admin can change it for this property.
      if (action === "channelWelcomeText") return json({ ok: true, subject: fillWelcome(t.subject, vars), body: fillWelcome(t.body, vars) });
      // channelWelcome: the text as changed in step 5 (the login link is already in it), or the saved wording.
      const to = clean(body.to, 600);
      if (!emailList(to).length || badEmails(to).length) return json({ error: "Type the email address to send to." }, 400);
      const subject = clean(body.subject, 200) || fillWelcome(t.subject, vars);
      const text = typeof body.body === "string" && body.body.trim() ? body.body.slice(0, 8000) : t.body;
      const sent = await sendEmail({ to: emailList(to, 5), subject, html: welcomeHtml(text, vars) });
      if (!sent.ok) return json({ error: "Not sent: " + (sent.error || "unknown reason") }, 502);
      const entry = await regEntryOf(a.siteNr);
      if (entry && !entry.welcomeSentAt) { entry.welcomeSentAt = new Date().toISOString(); await saveSiteNr(siteRegister(), entry); }
      return json({ ok: true });
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
      // Its library photos filed under its property and unit types (ResortID or unit names may have changed).
      context.waitUntil(retagListingPhotos(record).catch(() => null));

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

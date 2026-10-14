import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { emailList, badEmails, emailText, recipients } from "./lib/emails.js";
import { readListingScreenshots } from "./lib/listing-reader.js";
import { HOOKS_URL, makeHooksTicket } from "./lib/hooks-ticket.js";
import { readResortInfo, copySnPhotos } from "./lib/sn-resort-info.js";
import { feedByBbid, feedRowByResort, fillFromFeed, typeNames, learnTypeName, typeCodeOf } from "./lib/sn-feed.js";
import { forwardGeocode, reverseGeocode } from "./lib/geocode.js";
import { searchPlacePhotos, searchPlaceCandidates } from "./lib/places-images.js";
import { placeCoordinate, snFieldsFromPlace, placeText, PLACES_STORE, PROPERTY_KEY } from "./lib/tree.js";

// Backs the "Property Affiliate" onboarding tab in hub.html, the
// "Property Listings" tab in admin.html, and the public property-agreement.html
// acceptance page. A property owner (or an existing travel affiliate acting
// as their mandated agent) submits a listing here; it's stored with status
// "Requested" for Avante to review. Admin can edit the listing details, set
// commission/duration/agreement terms, send that agreement to the submitter
// for acceptance, and once accepted, change status to "Listed" (approved,
// live) or "Rejected" at any point. Nothing here auto-publishes a listing
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
const AGREEMENT_STATUSES = ["Not Sent", "Sent", "Accepted", "Declined"];

// Fields an admin is allowed to edit via the "updateListing" action. This is
// deliberately the core identifying/contact/descriptive information plus the
// commercial terms — not the large nested unitTypes/amenities/documents/images
// arrays, which stay as originally submitted for now.
const EDITABLE_FIELDS = [
  "propertyName", "propertyName2", "country", "suburb", "city", "city2",
  "stateProvince", "area", "district", "propertyType", "complexName",
  "infoLink", "bookingLink", "telephone", "email", "latitude", "longitude",
  "selfSupplierRating", "tourismBoardGrading", "ratingLink",
  "ownerFullName", "ownerIdPassport", "ownerEmail", "ownerPhone",
  "checkInTime", "checkOutTime", "description", "houseRules", "moreInfo",
  "areaInfo", "depositPolicyText", "depositPct", "depositDays", "childPolicy",
  "commissionRate", "listingDuration", "agreementTerms",
  "streetAddress", "siteId", "region", "sourceChannel", "channelListingLink",
  "channelReviews", "hostName", "accessibility", "icalLink",
  // Contact person for bookings and queries, and who gets the hub's emails (Jean, 2026-10-14).
  "contactName", "contactPhone", "contactEmail", "notifyWho",
];

const EDITABLE_FIELD_MAX = {
  description: 4000, houseRules: 4000, moreInfo: 4000, areaInfo: 4000,
  agreementTerms: 6000, depositPolicyText: 2000, childPolicy: 1000,
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
    commissionRate: "", listingDuration: "", agreementTerms: "", agreementStatus: "Not Sent", agreementToken: "", agreementSentAt: "", agreementRespondedAt: "",
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
    complexName: clean(body.complexName, 200),
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

async function verifyAdminToken(token) {
  if (!token) return false;
  const sessionStore = getStore({ name: "admin-sessions", consistency: "strong" });
  const session = await sessionStore.get(token, { type: "json" });
  if (!session) return false;
  if (new Date(session.expiresAt).getTime() < Date.now()) return false;
  return true;
}

async function sendNotificationEmail(to, subject, html) {
  try {
    const apiKey = Netlify.env.get("RESEND_API_KEY");
    if (!apiKey || !emailList(to).length) return;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "Avante Travel <bookings@go.avantetravel.co.za>",
        to: emailList(to, 20),
        subject: subject,
        html: html,
      }),
    });
  } catch (e) {
    // Email failures should never break the listing submit/status flow.
  }
}

async function getNotificationEmail() {
  const settingsStore = getStore({ name: "property-settings", consistency: "strong" });
  const settings = await settingsStore.get("config", { type: "json" });
  return (settings && settings.notificationEmail) || "";
}

// Who gets the hub's emails about a listing (Jean, 2026-10-14): the owner side
// (the owner, or the affiliate who submitted it), the contact person, or both
// (record.notifyWho). Returned as "a@x, b@y"; every address gets the email.
function submitterEmailFor(record) {
  const ownerSide = record.submittedBy === "Affiliate" ? record.affiliateEmail : record.ownerEmail;
  return recipients(ownerSide, record.contactEmail, record.notifyWho || "both").join(", ");
}

function withAgreementDefaults(record) {
  if (!record) return record;
  if (!record.commissionRate) record.commissionRate = "";
  if (!record.listingDuration) record.listingDuration = "";
  if (!record.agreementTerms) record.agreementTerms = "";
  if (!record.agreementStatus || AGREEMENT_STATUSES.indexOf(record.agreementStatus) === -1) {
    record.agreementStatus = "Not Sent";
  }
  if (!record.agreementToken) record.agreementToken = "";
  if (!record.agreementSentAt) record.agreementSentAt = "";
  if (!record.agreementRespondedAt) record.agreementRespondedAt = "";
  return record;
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

        // Commission / listing agreement (set by admin later, before a
        // listing can go live) — distinct from the onboarding "agreementSigned"
        // checkbox above, which just confirms the submitter accepted the
        // general onboarding terms when filling in this form.
        commissionRate: "",
        listingDuration: "",
        agreementTerms: "",
        agreementStatus: "Not Sent",
        agreementToken: "",
        agreementSentAt: "",
        agreementRespondedAt: "",
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

    if (action === "getForEdit" || action === "update" || action === "markSentToSN" || action === "emailSNFiles" || action === "libraryAdd" || action === "addPhotos" || action === "removePhoto") {
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
      withAgreementDefaults(record);

      if (action === "getForEdit") {
        const out = Object.assign({}, record);
        delete out.agreementToken;
        delete out.editToken;
        if (!isAdmin) { delete out.history; delete out.photosToken; }
        return json({ ok: true, listing: out, asAdmin: isAdmin });
      }

      if (action === "markSentToSN") {
        const before = { snSentSeasons: record.snSentSeasons || [] };
        record.snSentSeasons = (record.rateSeasons || []).map((r) => Object.assign({}, r));
        record.snSentAt = new Date().toISOString();
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
        const files = (Array.isArray(body.files) ? body.files : []).slice(0, 6)
          .map((f) => ({ filename: clean(f && f.filename, 150).replace(/[\\/:*?"<>|\r\n]/g, "_"), content: typeof (f && f.content) === "string" ? f.content.replace(/\s+/g, "") : "" }))
          .filter((f) => f.filename && f.content && /^[A-Za-z0-9+/=]+$/.test(f.content));
        if (!files.length) return json({ error: "No files to send." }, 400);
        const bytes = files.reduce((n, f) => n + Math.floor(f.content.length * 3 / 4), 0);
        if (bytes > 15 * 1024 * 1024) return json({ error: "The files are too big to email (over 15 MB)." }, 400);
        const siteNr = clean(body.siteNr, 20) || record.siteNr || "";
        const note = clean(body.note, 2000);
        const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
        // A link to the photos (Jean, 2026-10-13), so Stock Network can upload
        // them: a private page on the hub (property-photos.js), opened with a
        // random key kept on the listing.
        const photoCount = (record.images || []).filter((im) => im && im.key).length;
        let photosUrl = "";
        if (body.photosLink && photoCount) {
          if (!record.photosToken) record.photosToken = [...crypto.getRandomValues(new Uint8Array(18))].map((x) => x.toString(16).padStart(2, "0")).join("");
          photosUrl = new URL(request.url).origin + "/api/property-photos?l=" + encodeURIComponent(listingId) + "&k=" + record.photosToken;
        }
        const subject = clean(body.subject, 200) || ((record.existingOnSN === "Y" ? "Updated property details for Stock Network: " : "New property for Stock Network: ") + (record.propertyName || "property") + (siteNr ? " (Site Nr " + siteNr + ")" : ""));
        const html = "<p>Hello,</p>" +
          (note ? "<p>" + esc(note).replace(/\n/g, "<br>") + "</p>" : "<p>Please find attached the Stock Network files for <b>" + esc(record.propertyName || "the property") + "</b>.</p>") +
          "<p><b>Property:</b> " + esc(record.propertyName || "") + "<br><b>Site Nr:</b> " + esc(siteNr || "(not allocated)") +
          (record.siteId ? "<br><b>Site ID:</b> " + esc(record.siteId) : "") + "</p>" +
          "<p><b>Attached:</b><br>" + files.map((f) => esc(f.filename)).join("<br>") + "</p>" +
          (photosUrl ? '<p><b>Photos (' + photoCount + '):</b> <a href="' + esc(photosUrl) + '">View and download the photos</a><br><span style="color:#5b6b76">(one .zip with all of them is on that page)</span></p>' : "") +
          "<p>Avante Travel</p>";
        const replyTo = clean(body.replyTo, 200);
        let ok = false, error = "", emailId = "";
        const apiKey = Netlify.env.get("RESEND_API_KEY");
        if (!apiKey) error = "Email isn't switched on (RESEND_API_KEY missing).";
        else {
          try {
            const msg = { from: "Avante Travel <bookings@go.avantetravel.co.za>", to, subject, html, attachments: files };
            if (emailList(replyTo).length) msg.reply_to = emailList(replyTo);
            const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: JSON.stringify(msg) });
            const d = await r.json().catch(() => ({}));
            ok = r.ok; emailId = (d && d.id) || "";
            if (!ok) error = (d && (d.message || d.error)) || ("The email service said " + r.status + ".");
          } catch (e) { error = "Could not reach the email service: " + String((e && e.message) || e); }
        }
        const entry = { at: new Date().toISOString(), to: to.join(", "), subject, files: files.map((f) => f.filename).concat(photosUrl ? ["Link to " + photoCount + " photos"] : []), siteNr, note, ok, error: error || undefined, emailId: emailId || undefined, markedSent: false };
        const before = { snSentSeasons: record.snSentSeasons || [] };
        if (ok && body.markSent) {
          record.snSentSeasons = (record.rateSeasons || []).map((r) => Object.assign({}, r));
          record.snSentAt = entry.at;
          entry.markedSent = true;
        }
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
      return json({ ok: true, listing: withAgreementDefaults(record) });
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
        .map(withAgreementDefaults)
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
          agreementStatus: r.agreementStatus,
          dateSubmitted: r.dateSubmitted,
          dateUpdated: r.dateUpdated,
        }))
        .sort((a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted));

      return json({ ok: true, listings: summaries });
    }

    if (action === "listingRequest") {
      // The public "List your property" page (avante-channel-manager-listing.html,
      // Jean 2026-10-13): a property on NightsBridge types its BBID; the hub
      // finds it in its Stock Network list (External Resort Code) and builds
      // the listing from Stock Network. It stays a request: the property gets
      // no edit link until admin has checked it and sends one from Admin.
      if (await overDailyLimit("listingRequest", request, context)) return json({ error: "Too many requests from this connection today. Please email info@avantehospitality.co.za." }, 429);
      const contact = { name: clean(body.contactPerson, 120), phone: clean(body.phone, 200), email: clean(body.email, 600) };
      const propertyName = clean(body.propertyName, 200);
      const cm = ["NightsBridge", "eRes/NebulaCRS", "None yet"].includes(body.channelManager) ? body.channelManager : "";
      const bbid = clean(body.bbid, 40), eresRef = clean(body.eresRef, 60);
      if (!propertyName || !contact.name || !contact.phone || !contact.email || !cm) return json({ error: "Fill in every field." }, 400);
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
      const extra = { requestContact: contact, contactName: contact.name, contactPhone: contact.phone, contactEmail: emailText(contact.email), notifyWho: "both",
        channelManager: cm, bbid, eresRef, requestedAt: new Date().toISOString() };
      let record = null;
      if (row && !already) {
        record = await buildListingFromSn({ site: String(row.siteId || ""), resortId: row.resortId, resortName: row.name, aff: "", units: [], settings: { email: contact.email, phone: contact.phone }, channel: true, siteIdForListing: "" },
          row, { by: "property", status: "Requested", historyNote: "Listing request from the List your property page, BBID " + bbid + ", found on Stock Network", extra });
      } else if (!already) {
        const now = new Date().toISOString(), listingId = genListingId();
        record = Object.assign({ listingId, status: "Requested", dateSubmitted: now, dateUpdated: now }, submittedFields({ propertyName, email: contact.email, telephone: contact.phone, submittedBy: "Owner" }),
          { editToken: genToken(), agreementSigned: "Y", channelProperty: cm !== "None yet" ? "Y" : "", ratesFromChannel: cm !== "None yet" ? "Y" : "", commissionPct: cm !== "None yet" ? "4.95" : "",
            needsTreePlace: "Y", commissionRate: "", listingDuration: "", agreementTerms: "", agreementStatus: "Not Sent", agreementToken: "", agreementSentAt: "", agreementRespondedAt: "" }, extra);
        addHistory(record, "property", "Listing request from the List your property page (" + cm + (bbid ? ", BBID " + bbid + " not found in the Stock Network list" : eresRef ? ", eRes ref " + eresRef : "") + ")");
      }
      if (record) await store.setJSON(record.listingId, record);
      const notifyTo = await getNotificationEmail();
      if (notifyTo) {
        context.waitUntil(sendNotificationEmail(notifyTo, "Listing request: " + propertyName + (bbid ? " (BBID " + bbid + ")" : ""),
          "<p>A property asked to list on the <b>List your property</b> page.</p>" +
          "<p><b>Property:</b> " + escapeHtml(propertyName) + "<br><b>Contact:</b> " + escapeHtml(contact.name) + " · " + escapeHtml(contact.phone) + " · " + escapeHtml(contact.email) +
          "<br><b>System:</b> " + escapeHtml(cm) + (bbid ? " · BBID " + escapeHtml(bbid) : "") + (eresRef ? " · eRes ref " + escapeHtml(eresRef) : "") + "</p>" +
          (already ? "<p>It already has a listing (" + escapeHtml(already.listingId) + "); nothing new was made.</p>"
            : row ? "<p>Found on Stock Network: <b>" + escapeHtml(row.name) + "</b>, Site Nr " + escapeHtml(row.siteId || "?") + ". Listing <b>" + escapeHtml(record.listingId) + "</b> was made from Stock Network.</p>"
            : "<p>" + (cm === "NightsBridge" ? "That BBID wasn't found in the hub's Stock Network list. " : "") + "Listing <b>" + escapeHtml(record.listingId) + "</b> was made with these details only.</p>") +
          "<p>Check it in Admin &gt; Property Listings, then tap <b>Email the edit link</b> so the property can complete it.</p>"));
      }
      return json({ ok: true, found: !!row, name: row ? row.name : "", already: !!already });
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
      const dir = getStore({ name: "affiliates-directory", consistency: "strong" });
      if (await dir.get(affId, { type: "json" })) return json({ error: "An affiliate with number " + affId + " already exists. Open it in Affiliates to check its type and Site Nr.", exists: true }, 409);
      const now = new Date().toISOString();
      const aff = { affId, name: record.propertyName || "", email: record.email || record.ownerEmail || "", siteNr: record.siteNr || "",
        types: [record.channelProperty === "Y" ? "channel" : "property"], phone: record.telephone || "",
        revenueShare: Object.fromEntries(["accommodation", "flights", "activities", "car", "package"].map((k) => [k, { type: "percent", value: 0 }])),
        bank: { bankName: "", accountHolder: "", accountNumber: "", branchCode: "", accountType: "" }, notes: "Created from listing " + listingId,
        status: "active", totalRevenue: 0, totalOwed: 0, totalPaid: 0, channelRevenue: {}, hooksAccess: true, createdAt: now, updatedAt: now };
      await dir.setJSON(affId, aff);
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
      if (!record.editToken) record.editToken = genToken();
      const editLink = new URL(request.url).origin + "/property-form.html?edit=" + encodeURIComponent(listingId) + "&key=" + encodeURIComponent(record.editToken);
      const apiKey = Netlify.env.get("RESEND_API_KEY");
      if (!apiKey) return json({ error: "Email isn't switched on (RESEND_API_KEY missing)." }, 500);
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
        body: JSON.stringify({ from: "Avante Travel <bookings@go.avantetravel.co.za>", to: emailList(to, 20), subject: "Please complete your Avante listing — " + (record.propertyName || ""),
          html: "<p>Hello,</p><p>Avante Travel has a new, fuller listing form for <strong>" + escapeHtml(record.propertyName || "your property") + "</strong>. We filled in what we already have.</p>" +
            "<p>Please open it, check everything and fill in what is missing (for example photos, amenities, policies and rates), then tap <b>Save changes</b> on the last step:<br><a href=\"" + editLink + "\">Edit my listing</a></p>" +
            "<p>Keep this email: you can use the link again any time. Anyone with this link can edit the listing, so don't share it.</p><p>Avante Travel</p>" }) });
      const d = await r.json().catch(() => ({}));
      const at = new Date().toISOString();
      record.editLinkLog = (Array.isArray(record.editLinkLog) ? record.editLinkLog : []).concat([{ at, to, ok: r.ok, error: r.ok ? undefined : (d.message || ("status " + r.status)) }]).slice(-50);
      record.history = (Array.isArray(record.history) ? record.history : []).concat([{ at, by: "admin", action: (r.ok ? "Edit link emailed to " : "Edit link email FAILED to ") + to }]).slice(-HISTORY_MAX);
      await store.setJSON(listingId, record);
      return r.ok ? json({ ok: true }) : json({ error: "Not sent: " + (d.message || ("the email service said " + r.status)) }, 502);
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
      await store.setJSON(listingId, record);

      return json({ ok: true, listing: withAgreementDefaults(record) });
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
      return json({ ok: true, filled, snRead: !!sn.ok, feed: feed || null, listing: withAgreementDefaults(record) });
    }

    if (action === "sendAgreement") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const listingId = clean(body.listingId, 20);
      if (!listingId) return json({ error: "missing listingId" }, 400);

      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);
      withAgreementDefaults(record);

      if (!record.agreementTerms) {
        return json({ error: "Add the agreement terms before sending." }, 400);
      }

      const to = submitterEmailFor(record);
      if (!to) {
        return json({ error: "No email address on file for the submitter." }, 400);
      }

      record.agreementToken = genToken();
      record.agreementStatus = "Sent";
      record.agreementSentAt = new Date().toISOString();
      record.agreementRespondedAt = "";
      record.dateUpdated = record.agreementSentAt;
      await store.setJSON(listingId, record);

      const origin = new URL(request.url).origin;
      const link =
        origin + "/property-agreement.html?id=" + encodeURIComponent(listingId) +
        "&token=" + encodeURIComponent(record.agreementToken);

      context.waitUntil(
        sendNotificationEmail(
          to,
          "Listing agreement for " + record.propertyName + " — action needed",
          "<p>Hi " + escapeHtml(record.ownerFullName || "") + ",</p>" +
            "<p>Please review and accept the listing agreement for <strong>" +
            escapeHtml(record.propertyName) + "</strong> so we can proceed with getting it live " +
            "on Avante Travel's Private Property STR Database.</p>" +
            "<p><a href=\"" + link + "\">Review and accept the agreement</a></p>" +
            "<p>If the link above doesn't work, copy and paste this into your browser:<br>" +
            escapeHtml(link) + "</p>"
        )
      );

      return json({ ok: true, listing: record });
    }

    if (action === "getAgreement") {
      const listingId = clean(body.listingId, 20);
      const token = clean(body.token, 200);
      if (!listingId || !token) return json({ error: "missing listingId or token" }, 400);

      const record = await store.get(listingId, { type: "json" });
      if (!record || !record.agreementToken || record.agreementToken !== token) {
        return json({ error: "This agreement link is invalid or has expired." }, 404);
      }
      withAgreementDefaults(record);

      return json({
        ok: true,
        agreement: {
          listingId: record.listingId,
          propertyName: record.propertyName,
          ownerFullName: record.ownerFullName,
          commissionRate: record.commissionRate,
          listingDuration: record.listingDuration,
          agreementTerms: record.agreementTerms,
          agreementStatus: record.agreementStatus,
          agreementRespondedAt: record.agreementRespondedAt,
        },
      });
    }

    if (action === "acceptAgreement") {
      const listingId = clean(body.listingId, 20);
      const token = clean(body.token, 200);
      const decision = body.decision === "Declined" ? "Declined" : "Accepted";
      if (!listingId || !token) return json({ error: "missing listingId or token" }, 400);

      const record = await store.get(listingId, { type: "json" });
      if (!record || !record.agreementToken || record.agreementToken !== token) {
        return json({ error: "This agreement link is invalid or has expired." }, 404);
      }
      withAgreementDefaults(record);

      if (record.agreementStatus !== "Sent") {
        return json(
          { error: "This agreement has already been responded to (" + record.agreementStatus + ")." },
          400
        );
      }

      record.agreementStatus = decision;
      record.agreementRespondedAt = new Date().toISOString();
      record.dateUpdated = record.agreementRespondedAt;
      await store.setJSON(listingId, record);

      const notifyTo = await getNotificationEmail();
      if (notifyTo) {
        context.waitUntil(
          sendNotificationEmail(
            notifyTo,
            "Agreement " + decision.toLowerCase() + " — " + record.propertyName,
            "<p>" + escapeHtml(record.ownerFullName || "The submitter") + " has <strong>" +
              decision.toLowerCase() + "</strong> the listing agreement for <strong>" +
              escapeHtml(record.propertyName) + "</strong> (" + escapeHtml(listingId) + ").</p>" +
              (decision === "Accepted"
                ? "<p>You can now mark this listing as Listed in Admin &gt; Property Listings.</p>"
                : "<p>Log in to Admin &gt; Property Listings to follow up.</p>")
          )
        );
      }

      return json({ ok: true, agreementStatus: record.agreementStatus });
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
      withAgreementDefaults(record);

      if (status === "Listed" && record.agreementStatus !== "Accepted") {
        return json(
          { error: "The listing agreement must be sent and accepted before this listing can be marked as Listed." },
          400
        );
      }

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
      const settingsStore = getStore({ name: "property-settings", consistency: "strong" });
      await settingsStore.setJSON("config", { notificationEmail: notificationEmail });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
};

export const config = { path: "/api/property-onboarding" };

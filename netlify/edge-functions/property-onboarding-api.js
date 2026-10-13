import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { readListingScreenshots } from "./lib/listing-reader.js";
import { forwardGeocode, reverseGeocode } from "./lib/geocode.js";
import { searchPlacePhotos, searchPlaceCandidates } from "./lib/places-images.js";

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
];

const EDITABLE_FIELD_MAX = {
  description: 4000, houseRules: 4000, moreInfo: 4000, areaInfo: 4000,
  agreementTerms: 6000, depositPolicyText: 2000, childPolicy: 1000,
};

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
const DAILY_LIMITS = { readScreenshots: 40, lookupLocation: 120, verifyCoordinates: 120, findPhotos: 40 };
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
    if (!apiKey || !to) return;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "Avante Travel <bookings@go.avantetravel.co.za>",
        to: [to],
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

function submitterEmailFor(record) {
  return record.submittedBy === "Affiliate" ? record.affiliateEmail : record.ownerEmail;
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
        email: clean(body.email, 200),
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
        ownerEmail: clean(body.ownerEmail, 200),
        ownerPhone: clean(body.ownerPhone, 60),

        submittedBy: body.submittedBy === "Affiliate" ? "Affiliate" : "Owner",
        affId: clean(body.affId, 100),
        affiliateAgentName: clean(body.affiliateAgentName, 200),
        affiliateCompany: clean(body.affiliateCompany, 200),
        affiliateEmail: clean(body.affiliateEmail, 200),
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

      if (!record.propertyName || !record.ownerFullName || record.agreementSigned !== "Y") {
        return json(
          { error: "Property name, owner name, and agreement acceptance are required." },
          400
        );
      }

      await store.setJSON(listingId, record);

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

      return json({ ok: true, listingId: listingId });
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
      const amenityOptions = Array.isArray(body.amenityOptions) ? body.amenityOptions.map((a) => clean(a, 150)).filter(Boolean) : [];
      const result = await readListingScreenshots(images, clean(body.channel, 60), amenityOptions, clean(body.today, 10));
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
      const result = await searchPlacePhotos(query, Deno.env.get("GOOGLE_PLACES_API_KEY") || "", 9);
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
          agreementStatus: r.agreementStatus,
          dateSubmitted: r.dateSubmitted,
          dateUpdated: r.dateUpdated,
        }))
        .sort((a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted));

      return json({ ok: true, listings: summaries });
    }

    if (action === "updateListing") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const listingId = clean(body.listingId, 20);
      if (!listingId) return json({ error: "missing listingId" }, 400);

      const record = await store.get(listingId, { type: "json" });
      if (!record) return json({ error: "not found" }, 404);

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

      record.dateUpdated = new Date().toISOString();
      await store.setJSON(listingId, record);

      return json({ ok: true, listing: withAgreementDefaults(record) });
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
      record.status = status;
      record.dateUpdated = new Date().toISOString();
      if (siteNr !== undefined) record.siteNr = siteNr;

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

      const notificationEmail = clean(body.notificationEmail, 200);
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

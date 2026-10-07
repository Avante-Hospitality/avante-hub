// Stock Network API client for the Property Affiliate channel sync.
//
// Verified against the live API in Oct 2026 (The Dunes, site 5980, and
// Property Testing, site 3):
//  - POST /api/1/token           login with a property's own site credentials
//  - POST /api/1/search          availability; needs resortID and a region
//                                object, Offset starts at 1. Returns
//                                stockAvailability[].roomTypes[].availabilities[]
//                                (one entry per open stretch per unit).
//  - POST /api/1/request         create a reservation. A cellphone is REQUIRED:
//                                without it SN answers 500 but still removes the
//                                stock (bug reported to SN). Success = 201 with
//                                reservationId + reservationRefNo.
//  - GET  /api/1/request/{id}    read a reservation back
//  - POST /api/1/request/cancel/{id}   cancel; returns true, stock comes back
//  - PUT  /api/1/request/canceldetail/{detailId}  cancel one unit
// Plain ESM + fetch only, so it runs in edge functions (Deno) and in tests.

const BASE = "https://api.stocknetwork.co.za";
const ZERO = "00000000-0000-0000-0000-000000000000";

export class SNError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

export function isoDay(d) {
  // Accepts "2026-12-04T00:00:00" or a Date; returns "2026-12-04".
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d || "").slice(0, 10);
}

export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function nightsBetween(start, end) {
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000);
}

export class SNClient {
  constructor(creds, fetchImpl) {
    this.creds = creds;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.tok = null;
    this.onLogin = null; // optional: (tok) => save it so the next request can reuse the login
    this.logins = 0;
  }

  async login() {
    const res = await this.fetch(BASE + "/api/1/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientID: this.creds.clientID, clientSecret: this.creds.clientSecret, username: this.creds.username }),
    });
    if (!res.ok) throw new SNError(res.status === 403 || res.status === 401 ? "Stock Network did not accept these credentials." : "Stock Network login failed (" + res.status + ").", res.status, await res.text().catch(() => ""));
    const d = await res.json();
    const exp = Number(d.expiresDT) || Date.parse(d.expiresDT) || 0;
    this.tok = { accessToken: d.accessToken, siteId: d.siteId, site: d.site, expires: exp };
    this.logins++;
    if (this.onLogin) { try { await this.onLogin(this.tok); } catch (_) {} }
    return this.tok;
  }

  async token() {
    if (!this.tok || (this.tok.expires && this.tok.expires < Date.now() + 60000)) await this.login();
    return this.tok;
  }

  async call(path, { method = "POST", body } = {}, retried = false) {
    const t = await this.token();
    const res = await this.fetch(BASE + path, {
      method,
      headers: { Authorization: "Bearer " + t.accessToken, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // A reused login that SN no longer accepts: log in once more and repeat the call.
    if ((res.status === 401 || res.status === 403) && !retried) { this.tok = null; return this.call(path, { method, body }, true); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { status: res.status, ok: res.ok, data };
  }

  async search(resortId, checkIn, checkOut) {
    const t = await this.token();
    const body = {
      checkInDate: checkIn, checkOutDate: checkOut, resortID: resortId,
      geocoordinates: { latitude: 0, longitude: 0, withInKmRadius: 0 },
      pricing: { minPrice: 0, maxPrice: 100000000 }, region: { name: "" },
      ignoreLocationData: true, groupStockToMatchDates: false, extendDatesIfNoMatchFound: false,
    };
    const r = await this.call("/api/1/search?Offset=1&Limit=50&CallerDetails.SiteID=" + encodeURIComponent(t.siteId), { body });
    if (!r.ok) throw new SNError("Availability search failed (" + r.status + ").", r.status, r.data);
    return r.data || {};
  }

  // Every open stretch per unit between from and to (to = last check-out).
  async openStretches(resortId, from, to) {
    const d = await this.search(resortId, from, to);
    const out = { resortName: "", units: {}, stretches: [] };
    for (const resort of d.stockAvailability || []) {
      if (resort.resortId && resortId && resort.resortId !== resortId) continue;
      out.resortName = resort.resortName || out.resortName;
      for (const rt of resort.roomTypes || []) {
        const name = String(rt.roomType || "").trim();
        out.units[name] = { name, roomId: rt.roomId, unitSizeTypeId: rt.unitSizeTypeId, size: String(rt.roomSize || "").trim(), maxOccupancy: rt.maxOccupancy };
        for (const a of rt.availabilities || []) {
          const start = isoDay(a.checkInDate), end = isoDay(a.checkOutDate);
          out.stretches.push({ unit: name, start, end, nights: a.nights, unitsAvailable: a.unitsAvailable, source: a.source, rateTotal: a.rates && a.rates.rate, rateId: a.rates && a.rates.rateId, uniqueId: a.uniqueId, direct: !!a.isDirectMatch });
        }
      }
    }
    return out;
  }

  // The exact stock for one unit and one stay, needed to book it.
  async exactStock(resortId, unitName, checkIn, checkOut) {
    const d = await this.search(resortId, checkIn, checkOut);
    const want = nightsBetween(checkIn, checkOut);
    for (const resort of d.stockAvailability || []) {
      for (const rt of resort.roomTypes || []) {
        if (String(rt.roomType || "").trim() !== unitName) continue;
        for (const a of rt.availabilities || []) {
          if (isoDay(a.checkInDate) === checkIn && isoDay(a.checkOutDate) === checkOut && a.nights === want && a.unitsAvailable > 0) {
            return { resort, roomType: rt, availability: a };
          }
        }
      }
    }
    return null;
  }

  buildItem(stock, { adults = 2, children = 0, amount } = {}) {
    const { resort, roomType: rt, availability: a } = stock;
    return {
      uniqueStockID: a.uniqueId, reservationRateID: a.rates.rateId, resortID: resort.resortId, resortName: resort.resortName,
      unitSizeTypeID: rt.unitSizeTypeId, unitSize: String(rt.roomSize || "").trim(), unitNameID: rt.roomId, unitName: rt.roomType,
      checkInDate: a.checkInDate, checkOutDate: a.checkOutDate, numberOfNights: a.nights, noOfUnits: 1,
      maxOccupancy: rt.maxOccupancy, adultOccupancy: adults, childOccupancy: children, childAges: [], mealPlanRateID: 0,
      amountIncl: amount != null ? amount : a.rates.rate, source: a.source, sharedStockSourceID: null, reservationID: ZERO,
      hideRequestReservation: false, hidePayForReservation: false, minDepositRequired: 0, notAvailable: false, newQtyAvailable: 0, isRemoving: false,
      sourceObject: a,
    };
  }

  async createReservation({ items, guest, reference, notes }) {
    const t = await this.token();
    if (!guest || !String(guest.cellphone || "").trim()) throw new SNError("A cellphone number is required by Stock Network.", 400);
    const total = items.reduce((s, it) => s + (Number(it.amountIncl) || 0), 0);
    const body = {
      amountIncl: total, personID: null,
      fullName: String(guest.fullName || "").trim() || "Guest",
      emailAddress: String(guest.email || "").trim(), cellphone: String(guest.cellphone).trim(),
      currency: "ZAR", currencySymbol: "R", deleteCustomerInfoAfterCheckout: false,
      customerReferenceNo: String(reference || "").slice(0, 50), notes: String(notes || "").slice(0, 1000),
      membershipNo: null, preferredContactMethod: 0, discount: 0, isRequestAndPay: false, siteID: t.siteId, items,
    };
    const r = await this.call("/api/1/request?CallerDetails.SiteID=" + encodeURIComponent(t.siteId), { body });
    if (r.status !== 200 && r.status !== 201) throw new SNError("Stock Network did not create the booking (" + r.status + ").", r.status, r.data);
    const d = r.data || {};
    if (d.status && d.status !== "Success") throw new SNError("Stock Network answered: " + d.status, r.status, d);
    return {
      reservationId: d.reservationId, refNo: d.reservationRefNo, status: d.reservationStatus, total: d.totalAmountIncl,
      paymentUrl: d.paymentUrl || null, infoUrl: d.reservationInformationUrl || null, amountPaid: Number(d.amountPaid) || 0,
      details: (d.successfulItems || []).map((x) => ({ detailId: x.id, unit: x.unitName, start: isoDay(x.checkInDate), end: isoDay(x.checkOutDate) })),
      failed: d.failedItems || [],
    };
  }

  async getReservation(reservationId) {
    const r = await this.call("/api/1/request/" + encodeURIComponent(reservationId), { method: "GET" });
    if (!r.ok) throw new SNError("Could not read the booking (" + r.status + ").", r.status, r.data);
    return r.data;
  }

  async cancelReservation(reservationId) {
    const t = await this.token();
    const r = await this.call("/api/1/request/cancel/" + encodeURIComponent(reservationId) + "?CallerDetails.SiteID=" + encodeURIComponent(t.siteId));
    if (!r.ok || r.data === false) throw new SNError("Stock Network did not cancel the booking (" + r.status + ").", r.status, r.data);
    return true;
  }

  async cancelDetail(detailId) {
    const t = await this.token();
    const r = await this.call("/api/1/request/canceldetail/" + encodeURIComponent(detailId) + "?CallerDetails.SiteID=" + encodeURIComponent(t.siteId), { method: "PUT" });
    if (!r.ok || r.data === false) throw new SNError("Stock Network did not cancel that unit (" + r.status + ").", r.status, r.data);
    return true;
  }
}

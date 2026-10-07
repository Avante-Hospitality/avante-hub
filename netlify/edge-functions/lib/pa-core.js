// Property Affiliate: availability, bookings and channel sync for properties
// whose stock is managed manually on Stock Network (not NightsBridge).
//
// Stock Network stays the master. The hub:
//  1. reads each unit's open nights from SN (per property, with the property's
//     own SN site credentials, stored encrypted),
//  2. publishes per-unit, per-channel iCal feeds that block on Airbnb /
//     Booking.com / LekkeSlaap whatever is booked on SN or another channel,
//  3. reads those channels' calendars and books their reservations onto SN
//     (client = channel name), cancelling on SN when they disappear,
//  4. lets the property book, find, change (cancel + rebook) and cancel SN
//     bookings, for one or several units at a time.
// "Not on SN" nights (never given to SN) are never blocked elsewhere: only
// nights that were open on SN and then disappeared count as SN bookings.
//
// Storage is injected (Netlify Blobs in production, a Map in tests).

import { SNClient, SNError, addDays, nightsBetween } from "./sn-client.js";
import { parseIcs, buildIcs, nightsToRanges } from "./ical.js";
import { encryptJSON, decryptJSON, randomToken, sha256Hex } from "./pa-crypto.js";

export const CHANNELS = { bcom: "Booking.com", airbnb: "Airbnb", lekke: "LekkeSlaap" };
const HORIZON_DAYS = 365;
const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
const SESSION_DAYS = 30;
const APPROVAL_HOURS = 24;
const APPROVAL_MAX_TRIES = 5;
const PAY_MODES = ["both", "gateway", "eft"];
const DEFAULT_AFFILIATE_PASSWORD = "0000"; // same default as auth-api.js

export function slug(name) { return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function eachNight(start, end) { const out = []; for (let d = start; d < end; d = addDays(d, 1)) out.push(d); return out; }
function cleanStr(v, max = 200) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function isHttpsUrl(v) { try { const u = new URL(v); return u.protocol === "https:"; } catch (_) { return false; } }

export class PAError extends Error { constructor(message, status = 400, extra) { super(message); this.status = status; this.extra = extra; } }

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function maskEmail(e) { const m = /^(.)(.*)(@.*)$/.exec(String(e || "")); return m ? m[1] + "***" + m[3] : ""; }
// "082 123 4567" / "+27 82…" -> "27821234567" for wa.me links
export function waNumber(phone) { let d = String(phone || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("0")) d = "27" + d.slice(1); return d.length >= 9 ? d : ""; }

// affiliates: { getAuth(aff) -> {passwordHash}|null, getProfile(aff) -> {name,email,phone}|null }
// sendEmail(to, subject, html) -> Promise<boolean>
export function createCore({ store, resortStore, encKey, now = () => new Date(), clientFactory = (c) => new SNClient(c), fetchImpl = (...a) => fetch(...a), baseUrl = "", affiliates = null, sendEmail = async () => false }) {
  const today = () => now().toISOString().slice(0, 10);
  const getJSON = (k) => store.get(k, { type: "json" });
  const setJSON = (k, v) => store.setJSON(k, v);

  // ---------- properties & sessions ----------
  async function findResortsForSite(siteNr) {
    if (!resortStore) return [];
    const rec = await resortStore.get("current", { type: "json" }).catch(() => null);
    const rows = (rec && rec.resorts) || [];
    return rows.filter((r) => String(r.siteId || "").trim() === String(siteNr)).map((r) => ({ resortId: r.resortId, name: r.name }));
  }

  async function connect({ username, clientID, clientSecret, aff, resortId }) {
    const creds = { username: cleanStr(username, 100), clientID: cleanStr(clientID, 100), clientSecret: cleanStr(clientSecret, 100) };
    if (!creds.username || !creds.clientID || !creds.clientSecret) throw new PAError("Enter the Stock Network username, client ID and client secret.");
    const client = clientFactory(creds);
    let tok;
    try { tok = await client.login(); } catch (e) { throw new PAError(e.message || "Stock Network login failed.", 401); }

    let rid = cleanStr(resortId, 64);
    if (!rid) {
      const matches = await findResortsForSite(tok.site);
      if (matches.length === 1) rid = matches[0].resortId;
      else return { needResort: true, site: tok.site, candidates: matches };
    }
    const snap = await client.openStretches(rid, today(), addDays(today(), HORIZON_DAYS));
    const existing = await getJSON("site:" + tok.siteId);
    const units = Object.values(snap.units).map((u) => ({ name: u.name, size: u.size, roomId: u.roomId }));
    const prop = Object.assign({
      siteId: tok.siteId, site: tok.site, feedToken: randomToken(18), createdAt: now().toISOString(),
      settings: { email: "", phone: "", prices: {}, minStay: 2, autoBook: false, payMode: "both" }, channels: {},
    }, existing || {}, {
      resortId: rid, resortName: snap.resortName || (existing && existing.resortName) || "",
      units: mergeUnits(existing && existing.units, units), aff: cleanStr(aff, 40) || (existing && existing.aff) || "",
      credsEnc: await encryptJSON(creds, encKey), updatedAt: now().toISOString(),
    });
    await setJSON("site:" + prop.siteId, prop);
    await setJSON("feed:" + prop.feedToken, { siteId: prop.siteId });
    const token = randomToken(24);
    await setJSON("sess:" + token, { siteId: prop.siteId, aff: prop.aff, exp: now().getTime() + SESSION_DAYS * 86400000 });
    await saveSnapshot(prop, snap, true);
    return { token, property: publicProperty(prop) };
  }

  function mergeUnits(a, b) {
    const map = new Map();
    for (const u of (a || []).concat(b || [])) if (u && u.name) map.set(u.name, Object.assign({}, map.get(u.name) || {}, u));
    return [...map.values()].sort((x, y) => x.name.localeCompare(y.name, "en", { numeric: true }));
  }

  async function auth(token) {
    const t = cleanStr(token, 100);
    if (!t) throw new PAError("Not connected.", 401);
    const s = await getJSON("sess:" + t);
    if (!s || s.exp < now().getTime()) throw new PAError("Your session has expired. Connect your Stock Network site again.", 401);
    const prop = await getJSON("site:" + s.siteId);
    if (!prop) throw new PAError("This property is no longer connected.", 401);
    return prop;
  }

  async function disconnect(token) {
    const prop = await auth(token);
    await store.delete("sess:" + cleanStr(token, 100));
    await store.delete("feed:" + prop.feedToken);
    await store.delete("site:" + prop.siteId);
    return { ok: true };
  }

  function publicProperty(p) {
    return { siteId: p.siteId, site: p.site, resortId: p.resortId, resortName: p.resortName, units: p.units, settings: p.settings, connectedAt: p.createdAt };
  }

  async function clientFor(prop) { return clientFactory(await decryptJSON(prop.credsEnc, encKey)); }

  // ---------- snapshot of SN availability ----------
  async function bookingsOf(prop) { return (await getJSON("book:" + prop.siteId)) || []; }
  function activeNightsByUnit(bookings) {
    const m = {};
    for (const b of bookings) if (b.status !== "Cancelled") for (const it of b.items) if (!it.cancelled) for (const n of eachNight(it.start, it.end)) ((m[it.unit] = m[it.unit] || {})[n] = b);
    return m;
  }

  async function saveSnapshot(prop, snap, first) {
    const prev = (await getJSON("snap:" + prop.siteId)) || { open: {}, taken: {}, rates: {} };
    const bookings = await bookingsOf(prop);
    const ours = activeNightsByUnit(bookings);
    const open = {}, rates = {}, nightRates = {}, taken = {};
    for (const s of snap.stretches) {
      if (!(s.unitsAvailable > 0)) continue;
      const nights = eachNight(s.start, s.end);
      (open[s.unit] = open[s.unit] || []).push(...nights);
      if (s.rateTotal && s.nights) { const r = Math.round(s.rateTotal / s.nights); const m = (nightRates[s.unit] = nightRates[s.unit] || {}); for (const n of nights) m[n] = r; rates[s.unit] = Math.min(rates[s.unit] || Infinity, r); }
    }
    const t0 = today();
    for (const unit of new Set([...Object.keys(prev.open || {}), ...Object.keys(open), ...Object.keys(prev.taken || {})])) {
      const nowOpen = new Set(open[unit] || []);
      const keep = {};
      for (const [n, since] of Object.entries((prev.taken || {})[unit] || {})) if (n >= t0 && !nowOpen.has(n)) keep[n] = since;
      if (!first) for (const n of (prev.open || {})[unit] || []) if (n >= t0 && !nowOpen.has(n) && !(ours[unit] && ours[unit][n])) keep[n] = keep[n] || now().toISOString();
      if (Object.keys(keep).length) taken[unit] = keep;
    }
    const out = { open, taken, rates, nightRates, at: now().toISOString() };
    await setJSON("snap:" + prop.siteId, out);
    return out;
  }

  async function snapshot(prop, { force = false, client } = {}) {
    const cur = await getJSON("snap:" + prop.siteId);
    if (!force && cur && now().getTime() - Date.parse(cur.at) < SNAPSHOT_MAX_AGE_MS) return cur;
    const c = client || (await clientFor(prop));
    const snap = await c.openStretches(prop.resortId, today(), addDays(today(), HORIZON_DAYS));
    const units = Object.values(snap.units).map((u) => ({ name: u.name, size: u.size, roomId: u.roomId }));
    if (units.some((u) => !prop.units.find((x) => x.name === u.name))) { prop.units = mergeUnits(prop.units, units); await setJSON("site:" + prop.siteId, prop); }
    return saveSnapshot(prop, snap, false);
  }

  // ---------- availability for the grid / calendar ----------
  async function availability(prop, from, to) {
    from = from || today(); to = to || addDays(from, 14);
    if (nightsBetween(from, to) > 400 || to <= from) throw new PAError("Choose a shorter date range.");
    const snap = await snapshot(prop);
    const bookings = await bookingsOf(prop);
    const ours = activeNightsByUnit(bookings);
    const events = (await getJSON("chan:" + prop.siteId)) || {};
    const pend = {};
    for (const ev of Object.values(events)) if (ev.status === "detected" || ev.status === "clash" || ev.status === "needs-settings") for (const n of eachNight(ev.start, ev.end)) ((pend[ev.unit] = pend[ev.unit] || {})[n] = ev);
    const nights = {};
    for (const u of prop.units) {
      const open = new Set(snap.open[u.name] || []), taken = (snap.taken || {})[u.name] || {};
      const row = {};
      for (const n of eachNight(from, to)) {
        const b = ours[u.name] && ours[u.name][n];
        const p = pend[u.name] && pend[u.name][n];
        if (b) row[n] = { s: b.origin === "channel" ? b.channel : "hub", ref: b.ref };
        else if (p) row[n] = { s: p.status === "clash" ? "clash" : "pending", ch: p.channel };
        else if (open.has(n)) row[n] = { s: "open" };
        else if (taken[n]) row[n] = { s: "sn" };
        else row[n] = { s: "na" };
      }
      nights[u.name] = row;
    }
    const nightRates = {};
    for (const u of prop.units) { const nr = (snap.nightRates || {})[u.name] || {}; const m = {}; for (const n of eachNight(from, to)) if (nr[n]) m[n] = nr[n]; nightRates[u.name] = m; }
    return { from, to, snapshotAt: snap.at, units: prop.units.map((u) => ({ name: u.name, size: u.size, rateFrom: snap.rates[u.name] || null })), nights, nightRates, minStay: prop.settings.minStay || 2 };
  }

  async function search(prop, checkIn, checkOut) {
    if (!checkIn || !checkOut || checkOut <= checkIn) throw new PAError("Choose a check-out after the check-in.");
    const snap = await snapshot(prop);
    const ours = activeNightsByUnit(await bookingsOf(prop));
    const want = eachNight(checkIn, checkOut);
    const results = [];
    for (const u of prop.units) {
      const open = new Set(snap.open[u.name] || []);
      if (!want.every((n) => open.has(n) && !(ours[u.name] && ours[u.name][n]))) continue;
      const nr = (snap.nightRates || {})[u.name] || {};
      const total = want.every((n) => nr[n]) ? want.reduce((t, n) => t + nr[n], 0) : null;
      results.push({ unit: u.name, size: u.size, nights: want.length, rate: total ? Math.round(total / want.length) : null, total });
    }
    return { checkIn, checkOut, nights: want.length, results, minStay: prop.settings.minStay || 2 };
  }

  // ---------- bookings ----------
  async function saveBookings(prop, list) { await setJSON("book:" + prop.siteId, list); }

  async function createOnSN(prop, client, items, guest, { reference, notes, amountFor } = {}) {
    const snItems = [];
    for (const it of items) {
      if (!prop.units.find((u) => u.name === it.unit)) throw new PAError("Unknown unit " + it.unit + ".");
      if (!(it.start < it.end)) throw new PAError("Check-out must be after check-in for " + it.unit + ".");
      const stock = await client.exactStock(prop.resortId, it.unit, it.start, it.end);
      if (!stock) throw new PAError(it.unit + " is not open on Stock Network for " + it.start + " to " + it.end + ".", 409, { unavailable: it });
      snItems.push(client.buildItem(stock, { adults: it.adults || 2, children: it.children || 0, amount: amountFor ? amountFor(it, stock) : undefined }));
    }
    try {
      return await client.createReservation({ items: snItems, guest, reference, notes });
    } catch (e) {
      if (e instanceof SNError) throw new PAError(e.message + " If the nights now show as booked, Stock Network may still have taken the stock: check the back office.", 502, { sn: e.body });
      throw e;
    }
  }

  function validGuest(g) {
    const guest = { first: cleanStr(g && g.first, 80), last: cleanStr(g && g.last, 80), email: cleanStr(g && g.email, 120), cellphone: cleanStr(g && g.cellphone, 30) };
    if (!guest.cellphone) throw new PAError("A cellphone number is required by Stock Network.");
    if (!guest.first && !guest.last) throw new PAError("Enter the guest's name.");
    guest.fullName = (guest.first + " " + guest.last).trim();
    return guest;
  }

  // ---------- payments ----------
  function payMode(prop) { const m = prop.settings && prop.settings.payMode; return PAY_MODES.includes(m) ? m : "both"; }
  async function bankOf(prop) { if (!prop.bankEnc) return null; try { return await decryptJSON(prop.bankEnc, encKey); } catch (_) { return null; } }
  function isPaid(b) { return !!(b && (b.paidEft || (Number(b.amountPaid) || 0) > 0 || /paid/i.test(String(b.snStatus || "")))); }
  function payState(b) {
    if (!b || b.origin === "channel") return "channel";
    if (b.paidEft) return "paid-eft";
    if (/paid/i.test(String(b.snStatus || "")) || ((Number(b.amountPaid) || 0) >= (Number(b.total) || 0) && (Number(b.amountPaid) || 0) > 0)) return "paid";
    if ((Number(b.amountPaid) || 0) > 0) return "part-paid";
    return "unpaid";
  }
  function decorate(b) { return Object.assign({}, b, { payState: payState(b), locked: isPaid(b) }); }

  async function payInfoFor(prop, b) {
    if (!b || b.origin === "channel") return null;
    const mode = payMode(prop);
    const bank = mode === "gateway" ? null : await bankOf(prop);
    const gatewayUrl = mode === "eft" ? null : (b.paymentUrl || null);
    const g = b.guest || {};
    const nights = b.items.filter((i) => !i.cancelled).map((i) => i.unit + " " + i.start + " to " + i.end).join(", ");
    const lines = ["Hi " + (g.first || "") + ",", "", "Thank you for booking " + (prop.resortName || "with us") + " (" + nights + ").", "Booking reference: " + b.ref + (b.total ? " · Amount: R" + Math.round(b.total) : "")];
    if (gatewayUrl) { lines.push("", "Pay securely online:", gatewayUrl); }
    if (bank && bank.accountNumber) {
      lines.push("", gatewayUrl ? "Or pay by EFT:" : "Please pay by EFT:", "Bank: " + (bank.bankName || ""), "Account name: " + (bank.accountHolder || ""), "Account number: " + bank.accountNumber, "Branch code: " + (bank.branchCode || "") + (bank.accountType ? " (" + bank.accountType + ")" : ""), "Reference: " + b.ref);
      if (bank.note) lines.push(bank.note);
    }
    const message = lines.join("\n");
    const wa = waNumber(g.cellphone);
    return { mode, gatewayUrl, bank: bank && bank.accountNumber ? bank : null, message,
      whatsappUrl: "https://wa.me/" + wa + "?text=" + encodeURIComponent(message),
      emailUrl: g.email ? "mailto:" + encodeURIComponent(g.email) + "?subject=" + encodeURIComponent("Your booking " + b.ref + " at " + (prop.resortName || "")) + "&body=" + encodeURIComponent(message) : null,
      noMethod: !gatewayUrl && !(bank && bank.accountNumber) };
  }

  async function refreshPayment(client, b) {
    if (!b.reservationId || b.origin === "channel") return false;
    try {
      const r = await client.getReservation(b.reservationId);
      if (!r || r.status === "ReservationNotFound") return false;
      b.snStatus = r.reservationStatus || b.snStatus;
      b.amountPaid = Number(r.amountPaid) || 0;
      if (r.paymentUrl && !b.paymentUrl) b.paymentUrl = r.paymentUrl;
      if (/cancel/i.test(String(r.reservationStatus || "")) && b.status !== "Cancelled") { b.status = "Cancelled"; b.cancelledAt = now().toISOString(); b.cancelledOn = "sn"; }
      else if (b.status !== "Cancelled" && r.reservationStatus) b.status = r.reservationStatus;
      b.checkedAt = now().toISOString();
      return true;
    } catch (_) { return false; }
  }

  async function payInfo(prop, ref) {
    const { list, b } = await findBooking(prop, ref);
    const client = await clientFor(prop);
    if (await refreshPayment(client, b)) await saveBookings(prop, list);
    return { booking: decorate(b), pay: await payInfoFor(prop, b) };
  }

  async function markPaidEft(prop, ref) {
    const { list, b } = await findBooking(prop, ref);
    if (b.origin === "channel") throw new PAError("Channel bookings are paid on the channel.");
    if (payMode(prop) === "gateway") throw new PAError("EFT is switched off for this property (payment gateway only).");
    if (b.status === "Cancelled") throw new PAError(b.ref + " is cancelled.");
    if (!b.paidEft) b.paidEft = { at: now().toISOString() };
    await saveBookings(prop, list);
    return { booking: decorate(b) };
  }

  const PAID_LOCK_MSG = "This booking has been paid, so it can't be changed in the hub. The guest must contact the property; changes are made in Stock Network. To cancel it, use Request cancellation: the linked affiliate must approve.";

  async function book(prop, body) {
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 10).map((it) => ({ unit: cleanStr(it.unit, 60), start: cleanStr(it.start, 10), end: cleanStr(it.end, 10), adults: Math.max(1, Math.min(20, Number(it.adults) || Number(body.adults) || 2)), children: Math.max(0, Math.min(20, Number(it.children) || Number(body.children) || 0)) }));
    if (!items.length) throw new PAError("Choose at least one unit.");
    const guest = validGuest(body.guest);
    const source = cleanStr(body.source, 40) || "Direct";
    const channelRef = cleanStr(body.channelRef, 60);
    const client = await clientFor(prop);
    const res = await createOnSN(prop, client, items, guest, { reference: channelRef, notes: [source !== "Direct" ? "Booked through " + source : "", cleanStr(body.notes, 800), "Made in the Avante hub"].filter(Boolean).join(" · ") });
    const rec = { ref: "J" + res.refNo, reservationId: res.reservationId, status: res.status || "Request", origin: "hub", source, channelRef,
      guest: { first: guest.first, last: guest.last, email: guest.email, cellphone: guest.cellphone },
      items: items.map((it) => { const d = res.details.find((x) => x.unit === it.unit && x.start === it.start); return { unit: it.unit, start: it.start, end: it.end, detailId: d ? d.detailId : null }; }),
      total: res.total, paymentUrl: res.paymentUrl || null, infoUrl: res.infoUrl || null, amountPaid: res.amountPaid || 0, snStatus: res.status || "Request", createdAt: now().toISOString() };
    const list = await bookingsOf(prop); list.push(rec); await saveBookings(prop, list);
    await snapshot(prop, { force: true, client }).catch(() => null);
    return { booking: decorate(rec), pay: await payInfoFor(prop, rec) };
  }

  async function findBooking(prop, ref) {
    const list = await bookingsOf(prop);
    const b = list.find((x) => x.ref === cleanStr(ref, 20));
    if (!b) throw new PAError("Booking " + ref + " not found in the hub.", 404);
    return { list, b };
  }

  async function cancel(prop, ref) {
    const { list, b } = await findBooking(prop, ref);
    if (b.status === "Cancelled") return { booking: decorate(b) };
    const client = await clientFor(prop);
    if (await refreshPayment(client, b)) await saveBookings(prop, list);
    if (b.status === "Cancelled") return { booking: decorate(b), alreadyCancelled: true };
    if (isPaid(b)) return requestCancellation(prop, list, b);
    await client.cancelReservation(b.reservationId);
    b.status = "Cancelled"; b.cancelledAt = now().toISOString();
    await saveBookings(prop, list);
    await snapshot(prop, { force: true, client }).catch(() => null);
    return { booking: decorate(b) };
  }

  // ---------- affiliate approval for cancelling paid bookings ----------
  async function requestCancellation(prop, list, b) {
    const aff = cleanStr(prop.aff, 40);
    if (!aff || !affiliates) throw new PAError("This property isn't linked to an affiliate account, so a paid booking can't be cancelled from the hub. Cancel it in Stock Network.", 409);
    const profile = (await affiliates.getProfile(aff)) || {};
    const token = randomToken(24);
    const exp = now().getTime() + APPROVAL_HOURS * 3600000;
    await setJSON("appr:" + token, { siteId: prop.siteId, ref: b.ref, aff, exp, createdAt: now().toISOString(), used: false, fails: 0 });
    b.cancelRequest = { at: now().toISOString(), exp: new Date(exp).toISOString() };
    await saveBookings(prop, list);
    const link = baseUrl + "/approve-cancel.html?t=" + token;
    const units = b.items.filter((i) => !i.cancelled).map((i) => i.unit + " " + i.start + " to " + i.end).join(", ");
    const text = "Avante hub: " + (prop.resortName || "A property") + " asks you to approve cancelling PAID booking " + b.ref + " (" + units + "). Approve with your hub password (link valid " + APPROVAL_HOURS + " hours): " + link;
    let emailed = false;
    if (profile.email) {
      emailed = await sendEmail(profile.email, "Approve cancellation of paid booking " + b.ref,
        "<p>Hi " + esc(profile.name || "") + ",</p><p><b>" + esc(prop.resortName || "A property") + "</b> asks you to approve cancelling a <b>paid</b> booking.</p>" +
        "<p>Booking <b>" + esc(b.ref) + "</b><br>" + esc(units) + "<br>Guest: " + esc(((b.guest && b.guest.first) || "") + " " + ((b.guest && b.guest.last) || "")) + "<br>Amount paid: R" + esc(Math.round(Number(b.amountPaid) || Number(b.total) || 0)) + (b.paidEft ? " (EFT)" : "") + "</p>" +
        "<p><a href=\"" + esc(link) + "\" style=\"display:inline-block;background:#0e2f44;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700\">Review and approve</a></p>" +
        "<p>You'll need your Avante hub password. The link works once and expires in " + APPROVAL_HOURS + " hours. If you didn't expect this, ignore this email and nothing is cancelled.</p>").catch(() => false);
    }
    const wa = waNumber(profile.phone);
    return { needsApproval: true, booking: decorate(b),
      approval: { emailedTo: emailed ? maskEmail(profile.email) : null, hasPhone: !!wa, whatsappUrl: "https://wa.me/" + wa + "?text=" + encodeURIComponent(text), expiresAt: new Date(exp).toISOString(), affiliateName: profile.name || "" } };
  }

  async function approvalRecord(token) {
    const t = cleanStr(token, 80);
    const a = t ? await getJSON("appr:" + t) : null;
    if (!a) throw new PAError("This approval link isn't valid.", 404);
    if (a.used) throw new PAError("This approval link has already been used.", 410);
    if (a.exp < now().getTime()) throw new PAError("This approval link has expired. Ask the property to request the cancellation again.", 410);
    if (a.fails >= APPROVAL_MAX_TRIES) throw new PAError("Too many wrong passwords. Ask the property to request the cancellation again.", 429);
    const prop = await getJSON("site:" + a.siteId);
    if (!prop) throw new PAError("This property is no longer connected.", 404);
    const list = await bookingsOf(prop);
    const b = list.find((x) => x.ref === a.ref);
    if (!b) throw new PAError("Booking not found.", 404);
    return { t, a, prop, list, b };
  }

  async function approvalInfo(token) {
    const { a, prop, b } = await approvalRecord(token);
    return { resortName: prop.resortName, ref: b.ref, status: b.status, aff: a.aff,
      items: b.items.filter((i) => !i.cancelled).map((i) => ({ unit: i.unit, start: i.start, end: i.end })),
      guest: ((b.guest && b.guest.first) || "") + " " + ((b.guest && b.guest.last) || ""),
      total: b.total, amountPaid: b.amountPaid || 0, paidEft: !!b.paidEft, expiresAt: new Date(a.exp).toISOString() };
  }

  async function approveCancel(token, password) {
    const { t, a, prop, list, b } = await approvalRecord(token);
    const rec = affiliates ? await affiliates.getAuth(a.aff) : null;
    const stored = rec && rec.passwordHash ? rec.passwordHash : await sha256Hex(DEFAULT_AFFILIATE_PASSWORD);
    if ((await sha256Hex(String(password || ""))) !== stored) {
      a.fails = (a.fails || 0) + 1; await setJSON("appr:" + t, a);
      throw new PAError("Incorrect password." + (APPROVAL_MAX_TRIES - a.fails > 0 ? " " + (APPROVAL_MAX_TRIES - a.fails) + " tries left." : ""), 401);
    }
    if (b.status !== "Cancelled") {
      const client = await clientFor(prop);
      try { await client.cancelReservation(b.reservationId); }
      catch (e) { throw new PAError("Approved, but Stock Network didn't cancel the booking: " + (e.message || e) + " Cancel it in the Stock Network back office.", 502); }
      b.status = "Cancelled"; b.cancelledAt = now().toISOString();
      await snapshot(prop, { force: true, client }).catch(() => null);
    }
    b.cancelApproved = { by: a.aff, at: now().toISOString() };
    delete b.cancelRequest;
    a.used = true; a.usedAt = now().toISOString();
    await setJSON("appr:" + t, a);
    await saveBookings(prop, list);
    if (prop.settings && prop.settings.email) await sendEmail(prop.settings.email, "Booking " + b.ref + " cancelled (approved)", "<p>The affiliate approved the cancellation of paid booking <b>" + esc(b.ref) + "</b>. It is now cancelled on Stock Network. Any refund to the guest is handled outside the hub.</p>").catch(() => false);
    return { ref: b.ref, resortName: prop.resortName };
  }

  async function cancelUnit(prop, ref, unit) {
    const { list, b } = await findBooking(prop, ref);
    const live = b.items.filter((it) => !it.cancelled);
    const it = live.find((x) => x.unit === cleanStr(unit, 60));
    if (!it) throw new PAError(unit + " is not on " + ref + ".");
    if (live.length === 1) return cancel(prop, ref);
    if (!it.detailId) throw new PAError("Stock Network did not return a detail ID for " + unit + ", so it can't be removed on its own. Cancel and book again.");
    const client = await clientFor(prop);
    if (await refreshPayment(client, b)) await saveBookings(prop, list);
    if (isPaid(b)) throw new PAError(PAID_LOCK_MSG, 423);
    await client.cancelDetail(it.detailId);
    it.cancelled = true; it.cancelledAt = now().toISOString();
    await saveBookings(prop, list);
    await snapshot(prop, { force: true, client }).catch(() => null);
    return { booking: decorate(b) };
  }

  // Change unit and/or dates of a single-unit booking: SN can't edit, so cancel + rebook.
  async function edit(prop, ref, change) {
    const { list, b } = await findBooking(prop, ref);
    const live = b.items.filter((it) => !it.cancelled);
    if (live.length !== 1) throw new PAError("Only single-unit bookings can be moved. Remove units, or cancel and book again.");
    const old = live[0];
    const next = { unit: cleanStr(change.unit, 60) || old.unit, start: cleanStr(change.start, 10) || old.start, end: cleanStr(change.end, 10) || old.end };
    const guest = validGuest(Object.assign({}, b.guest, change.guest || {}));
    const client = await clientFor(prop);
    if (await refreshPayment(client, b)) await saveBookings(prop, list);
    if (b.status === "Cancelled") throw new PAError(b.ref + " has been cancelled on Stock Network.", 409);
    if (isPaid(b)) throw new PAError(PAID_LOCK_MSG, 423);
    if (next.unit === old.unit && next.start === old.start && next.end === old.end) {
      b.guest = { first: guest.first, last: guest.last, email: guest.email, cellphone: guest.cellphone };
      await saveBookings(prop, list);
      return { booking: decorate(b), unchanged: true };
    }
    const overlap = next.unit === old.unit && next.start < old.end && old.start < next.end;
    const notes = "Moved from " + b.ref + " in the Avante hub";
    let res;
    if (overlap) {
      await client.cancelReservation(b.reservationId);
      try {
        res = await createOnSN(prop, client, [next], guest, { reference: b.channelRef, notes });
      } catch (e) {
        let restored = null;
        try { restored = await createOnSN(prop, client, [old], guest, { reference: b.channelRef, notes: "Restored after a failed change of " + b.ref }); } catch (_) {}
        b.status = "Cancelled"; b.cancelledAt = now().toISOString();
        if (restored) list.push(Object.assign({}, b, { ref: "J" + restored.refNo, reservationId: restored.reservationId, status: restored.status || "Request", items: [Object.assign({}, old, { detailId: restored.details[0] && restored.details[0].detailId })], replaces: b.ref, createdAt: now().toISOString() }));
        await saveBookings(prop, list);
        throw new PAError("The change failed: " + e.message + (restored ? " The original stay was booked again as J" + restored.refNo + "." : " The original booking was cancelled and could NOT be restored. Check Stock Network now."), 409);
      }
    } else {
      res = await createOnSN(prop, client, [next], guest, { reference: b.channelRef, notes });
      await client.cancelReservation(b.reservationId);
    }
    b.status = "Cancelled"; b.cancelledAt = now().toISOString(); b.replacedBy = "J" + res.refNo;
    const rec = Object.assign({}, b, { ref: "J" + res.refNo, reservationId: res.reservationId, status: res.status || "Request", replaces: b.ref, cancelledAt: undefined, replacedBy: undefined,
      paymentUrl: res.paymentUrl || null, infoUrl: res.infoUrl || null, amountPaid: res.amountPaid || 0, snStatus: res.status || "Request", checkedAt: undefined, cancelRequest: undefined,
      guest: { first: guest.first, last: guest.last, email: guest.email, cellphone: guest.cellphone },
      items: [{ unit: next.unit, start: next.start, end: next.end, detailId: res.details[0] ? res.details[0].detailId : null }], total: res.total, createdAt: now().toISOString() });
    list.push(rec); await saveBookings(prop, list);
    await snapshot(prop, { force: true, client }).catch(() => null);
    return { booking: decorate(rec), replaced: b.ref, pay: await payInfoFor(prop, rec) };
  }

  async function find(prop, q, { refresh = true } = {}) {
    const s = cleanStr(q, 80).toLowerCase();
    const list = await bookingsOf(prop);
    if (refresh) {
      const stale = list.filter((b) => b.origin !== "channel" && b.status !== "Cancelled" && !isPaid(b) && (!b.checkedAt || now().getTime() - Date.parse(b.checkedAt) > 120000)).slice(-10);
      if (stale.length) {
        try { const client = await clientFor(prop); let changed = false; for (const b of stale) changed = (await refreshPayment(client, b)) || changed; if (changed) await saveBookings(prop, list); } catch (_) {}
      }
    }
    return { payMode: payMode(prop), bookings: list.map(decorate).filter((b) => !s || [b.ref, b.guest && b.guest.first, b.guest && b.guest.last, b.source, b.channel, b.channelRef].concat(b.items.map((i) => i.unit)).join(" ").toLowerCase().includes(s)).slice(-100).reverse() };
  }

  // ---------- settings & channels ----------
  async function saveSettings(prop, body) {
    const s = prop.settings || {};
    if (body.email !== undefined) s.email = cleanStr(body.email, 120);
    if (body.phone !== undefined) s.phone = cleanStr(body.phone, 30);
    if (body.minStay !== undefined) s.minStay = Math.max(1, Math.min(30, Number(body.minStay) || 1));
    if (body.autoBook !== undefined) s.autoBook = !!body.autoBook;
    if (body.payMode !== undefined) s.payMode = PAY_MODES.includes(body.payMode) ? body.payMode : "both";
    if (body.bank && typeof body.bank === "object") {
      const bk = { bankName: cleanStr(body.bank.bankName, 60), accountHolder: cleanStr(body.bank.accountHolder, 100), accountNumber: cleanStr(body.bank.accountNumber, 30).replace(/[^0-9 -]/g, ""), branchCode: cleanStr(body.bank.branchCode, 20), accountType: cleanStr(body.bank.accountType, 30), note: cleanStr(body.bank.note, 200) };
      if (bk.accountNumber && (!bk.bankName || !bk.accountHolder)) throw new PAError("Enter the bank name and account holder with the account number.");
      prop.bankEnc = bk.accountNumber ? await encryptJSON(bk, encKey) : null;
    }
    if (body.prices && typeof body.prices === "object") { s.prices = {}; for (const u of prop.units) { const v = Number(body.prices[u.name]); if (v > 0) s.prices[u.name] = Math.round(v); } }
    prop.settings = s;
    if (body.channels && typeof body.channels === "object") {
      const ch = prop.channels || {};
      for (const u of prop.units) for (const key of Object.keys(CHANNELS)) {
        const v = body.channels[u.name] && body.channels[u.name][key];
        if (v === undefined) continue;
        const url = cleanStr(v, 600);
        if (url && !isHttpsUrl(url)) throw new PAError("The " + CHANNELS[key] + " link for " + u.name + " must start with https://");
        ch[u.name] = ch[u.name] || {};
        ch[u.name][key] = Object.assign({}, ch[u.name][key] || {}, { importUrl: url, status: url ? (ch[u.name][key] && ch[u.name][key].importUrl === url ? ch[u.name][key].status : "waiting") : "off" });
      }
      prop.channels = ch;
    }
    if ((s.payMode || "both") === "eft" && !prop.bankEnc) throw new PAError("Add your bank details before choosing EFT only.");
    await setJSON("site:" + prop.siteId, prop);
    return channelsView(prop);
  }

  async function channelsView(prop) {
    const units = prop.units.map((u) => ({
      name: u.name, size: u.size,
      channels: Object.keys(CHANNELS).map((key) => {
        const c = (prop.channels || {})[u.name] && prop.channels[u.name][key] || {};
        return { key, label: CHANNELS[key], exportUrl: baseUrl + "/ical/" + prop.feedToken + "/" + slug(u.name) + "/" + key + ".ics", importUrl: c.importUrl || "", status: c.importUrl ? (c.status || "waiting") : "off", lastRead: c.lastRead || null, error: c.error || null, events: c.events || 0 };
      }),
    }));
    const settings = Object.assign({ payMode: "both" }, prop.settings || {});
    return { settings, bank: await bankOf(prop), units, affiliateLinked: !!prop.aff };
  }

  // ---------- iCal export ----------
  async function icalFeed(feedToken, unitSlug, channelKey) {
    const f = await getJSON("feed:" + cleanStr(feedToken, 60));
    if (!f) return null;
    const prop = await getJSON("site:" + f.siteId);
    if (!prop) return null;
    const unit = prop.units.find((u) => slug(u.name) === unitSlug);
    if (!unit || !CHANNELS[channelKey]) return null;
    const snap = (await getJSON("snap:" + prop.siteId)) || { taken: {} };
    const t0 = today();
    const block = new Set();
    for (const n of Object.keys((snap.taken || {})[unit.name] || {})) if (n >= t0) block.add(n);
    for (const b of await bookingsOf(prop)) {
      if (b.status === "Cancelled" || (b.origin === "channel" && b.channel === channelKey)) continue;
      for (const it of b.items) if (it.unit === unit.name && !it.cancelled) for (const n of eachNight(it.start, it.end)) if (n >= t0) block.add(n);
    }
    const events = (await getJSON("chan:" + prop.siteId)) || {};
    for (const ev of Object.values(events)) if (ev.unit === unit.name && ev.channel !== channelKey && (ev.status === "detected" || ev.status === "clash" || ev.status === "needs-settings")) for (const n of eachNight(ev.start, ev.end)) if (n >= t0) block.add(n);
    const ranges = nightsToRanges([...block]).map((r) => ({ start: r.start, end: r.end, uid: prop.siteId.slice(0, 8) + "-" + slug(unit.name) + "-" + r.start + "-" + r.end + "@avantetravel.co.za", summary: "Not available" }));
    return buildIcs((prop.resortName || "Property") + " " + unit.name + " (Avante)", ranges);
  }

  // ---------- channel import (every 15 minutes) ----------
  async function bookChannelEvent(prop, client, ev, list) {
    const s = prop.settings || {};
    if (!s.phone) { ev.status = "needs-settings"; ev.error = "Add a reservations phone number in Reservation settings."; return; }
    const label = CHANNELS[ev.channel];
    const nights = nightsBetween(ev.start, ev.end);
    try {
      const res = await createOnSN(prop, client, [{ unit: ev.unit, start: ev.start, end: ev.end }], { fullName: label, email: s.email || "", cellphone: s.phone }, {
        reference: String(ev.uid).slice(0, 50), notes: label + " booking imported by the Avante hub" + (ev.summary ? " · " + ev.summary : ""),
        amountFor: (it, stock) => (s.prices && s.prices[ev.unit] ? s.prices[ev.unit] * nights : stock.availability.rates.rate),
      });
      list.push({ ref: "J" + res.refNo, reservationId: res.reservationId, status: res.status || "Request", origin: "channel", channel: ev.channel, source: label, channelRef: ev.uid,
        guest: { first: label, last: "", email: s.email || "", cellphone: s.phone }, items: [{ unit: ev.unit, start: ev.start, end: ev.end, detailId: res.details[0] ? res.details[0].detailId : null }], total: res.total, createdAt: now().toISOString() });
      ev.status = "booked"; ev.ref = "J" + res.refNo; ev.error = null;
    } catch (e) {
      ev.status = e.status === 409 ? "clash" : "error"; ev.error = e.message;
    }
  }

  async function syncProperty(prop) {
    const client = await clientFor(prop);
    await snapshot(prop, { force: true, client });
    const events = (await getJSON("chan:" + prop.siteId)) || {};
    const list = await bookingsOf(prop);
    const t0 = today();
    const summary = { read: 0, added: 0, cancelled: 0, clashes: 0, errors: 0 };
    for (const u of prop.units) for (const key of Object.keys(CHANNELS)) {
      const c = (prop.channels || {})[u.name] && prop.channels[u.name][key];
      if (!c || !c.importUrl) continue;
      let parsed;
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000);
        const res = await fetchImpl(c.importUrl, { signal: ctl.signal, headers: { Accept: "text/calendar, */*" } });
        clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status);
        parsed = parseIcs(await res.text()).filter((e) => e.end > t0);
        c.status = "ok"; c.lastRead = now().toISOString(); c.error = null; c.events = parsed.length; summary.read++;
      } catch (e) {
        c.status = "error"; c.error = "Could not read the link: " + (e.message || e); summary.errors++;
        continue;
      }
      const seen = new Set();
      for (const e of parsed) {
        const id = u.name + "|" + key + "|" + e.uid;
        seen.add(id);
        const cur = events[id];
        if (cur && cur.start === e.start && cur.end === e.end && cur.status !== "error" && cur.status !== "needs-settings") continue;
        if (cur && cur.status === "booked" && cur.ref) {
          const b = list.find((x) => x.ref === cur.ref);
          if (b && b.status !== "Cancelled") { try { await client.cancelReservation(b.reservationId); b.status = "Cancelled"; b.cancelledAt = now().toISOString(); summary.cancelled++; } catch (_) {} }
        }
        const ev = { unit: u.name, channel: key, uid: e.uid, start: e.start, end: e.end, summary: e.summary || "", firstSeen: (cur && cur.firstSeen) || now().toISOString(), status: "detected" };
        if (prop.settings && prop.settings.autoBook) { await bookChannelEvent(prop, client, ev, list); if (ev.status === "booked") summary.added++; if (ev.status === "clash") summary.clashes++; }
        events[id] = ev;
      }
      for (const [id, ev] of Object.entries(events)) {
        if (!id.startsWith(u.name + "|" + key + "|") || seen.has(id) || ev.status === "removed") continue;
        if (ev.end <= t0) { delete events[id]; continue; }
        if (ev.status === "booked" && ev.ref) {
          const b = list.find((x) => x.ref === ev.ref);
          if (b && b.status !== "Cancelled") { try { await client.cancelReservation(b.reservationId); b.status = "Cancelled"; b.cancelledAt = now().toISOString(); summary.cancelled++; } catch (_) { continue; } }
        }
        ev.status = "removed"; ev.removedAt = now().toISOString();
      }
    }
    await saveBookings(prop, list);
    await setJSON("chan:" + prop.siteId, events);
    await setJSON("site:" + prop.siteId, prop);
    await snapshot(prop, { force: true, client }).catch(() => null);
    return summary;
  }

  async function runSync({ deadlineMs = 25000 } = {}) {
    const started = Date.now();
    const keys = (await store.list({ prefix: "site:" })).blobs.map((b) => b.key);
    const out = {};
    for (const k of keys) {
      if (Date.now() - started > deadlineMs) { out[k] = "skipped (time)"; continue; }
      const prop = await getJSON(k);
      if (!prop) continue;
      try { out[prop.site] = await syncProperty(prop); } catch (e) { out[prop.site] = { error: e.message }; }
    }
    return out;
  }

  async function channelEvents(prop) {
    const events = (await getJSON("chan:" + prop.siteId)) || {};
    return { events: Object.values(events).filter((e) => e.status !== "removed" && e.end > today()).sort((a, b) => a.start.localeCompare(b.start)) };
  }

  async function addChannelEvent(prop, unit, channel, uid) {
    const events = (await getJSON("chan:" + prop.siteId)) || {};
    const ev = events[cleanStr(unit, 60) + "|" + cleanStr(channel, 10) + "|" + cleanStr(uid, 300)];
    if (!ev) throw new PAError("That channel booking was not found.", 404);
    if (ev.status === "booked") return { event: ev };
    const list = await bookingsOf(prop);
    const client = await clientFor(prop);
    await bookChannelEvent(prop, client, ev, list);
    await saveBookings(prop, list);
    await setJSON("chan:" + prop.siteId, events);
    await snapshot(prop, { force: true, client }).catch(() => null);
    if (ev.status !== "booked") throw new PAError(ev.error || "Could not add it to Stock Network.", 409);
    return { event: ev };
  }

  return { connect, auth, disconnect, publicProperty, availability, search, book, cancel, cancelUnit, edit, find, saveSettings, channelsView, payInfo, markPaidEft, approvalInfo, approveCancel, icalFeed, runSync, syncProperty, channelEvents, addChannelEvent, snapshot, findResortsForSite };
}

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
const HORIZON_DAYS = 365;               // full read: at connect, and every SYNC_FULL_MS for channel-linked properties
const SYNC_NEAR_DAYS = 60;              // every 15-minute sync reads only this far ahead
const SYNC_FULL_MS = 2 * 3600 * 1000;   // ... and the full year this often
const WINDOW_MAX_AGE_MS = 5 * 60 * 1000; // a screen window is re-read from SN when older than this
const MAX_WINDOW_DAYS = 62;             // the screen never asks SN for more than this at once
const TOKEN_REUSE_MS = 50 * 60 * 1000;
const FEED_ACTIVE_MS = 48 * 3600 * 1000; // a calendar link fetched by a channel within this time counts as linked
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
// sendEmail(to, subject, html, { fromName, replyTo }?) -> Promise<boolean>
// reviews: { baseUrl, secret, tenant } for the Avante Reviews app (review links in after-stay messages)
export function createCore({ store, resortStore, encKey, now = () => new Date(), clientFactory = (c) => new SNClient(c), fetchImpl = (...a) => fetch(...a), baseUrl = "", affiliates = null, sendEmail = async () => false, reviews = null }) {
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
    const token = await newSession(prop);
    if (prop.aff) await setJSON("aff:" + prop.aff, { siteId: prop.siteId });
    // Connecting reads the full year once, to find every unit and its open nights.
    await mergeWindow(prop, snap, today(), addDays(today(), HORIZON_DAYS), { first: true });
    await setJSON("tok:" + prop.siteId, { enc: await encryptJSON(tok, encKey), until: Math.min(tok.expires || Infinity, now().getTime() + TOKEN_REUSE_MS) });
    return { token, property: publicProperty(prop) };
  }

  function mergeUnits(a, b) {
    const map = new Map();
    for (const u of (a || []).concat(b || [])) if (u && u.name) map.set(u.name, Object.assign({}, map.get(u.name) || {}, u));
    return [...map.values()].sort((x, y) => x.name.localeCompare(y.name, "en", { numeric: true }));
  }

  // A property stays connected until someone presses Disconnect: sessions
  // don't expire, and they stop working once the property is disconnected.
  async function newSession(prop) {
    const token = randomToken(24);
    await setJSON("sess:" + token, { siteId: prop.siteId, aff: prop.aff || "", createdAt: now().toISOString() });
    return token;
  }

  async function auth(token) {
    const t = cleanStr(token, 100);
    if (!t) throw new PAError("Not connected.", 401);
    const s = await getJSON("sess:" + t);
    if (!s) throw new PAError("Not connected on this device.", 401);
    const prop = await getJSON("site:" + s.siteId);
    if (!prop) throw new PAError("This property is no longer connected.", 401);
    if (prop.aff) { const link = await getJSON("aff:" + prop.aff); if (!link) await setJSON("aff:" + prop.aff, { siteId: prop.siteId }); }
    return prop;
  }

  async function disconnect(token) {
    const prop = await auth(token);
    await store.delete("sess:" + cleanStr(token, 100));
    await store.delete("feed:" + prop.feedToken);
    await store.delete("site:" + prop.siteId);
    await store.delete("tok:" + prop.siteId);
    if (prop.aff) { const link = await getJSON("aff:" + prop.aff); if (link && link.siteId === prop.siteId) await store.delete("aff:" + prop.aff); }
    return { ok: true };
  }

  // The property connected under an affiliate number (falls back to a scan for
  // properties connected before the link was recorded).
  async function propertyOfAff(aff) {
    aff = cleanStr(aff, 40);
    if (!aff) return null;
    const link = await getJSON("aff:" + aff);
    if (link) { const p = await getJSON("site:" + link.siteId); if (p) return p; await store.delete("aff:" + aff); }
    for (const b of (await store.list({ prefix: "site:" })).blobs) {
      const p = await getJSON(b.key);
      if (p && p.aff === aff) { await setJSON("aff:" + aff, { siteId: p.siteId }); return p; }
    }
    return null;
  }

  // Is this affiliate a property affiliate? (Used to open the hub on Property Affiliate.)
  async function affStatus(aff) {
    const p = await propertyOfAff(aff);
    return { linked: !!p, resortName: p ? p.resortName : "" };
  }

  // Open the connected property on a new device with the affiliate's hub
  // password (the hub login page does this automatically after logging in).
  async function resume(aff, password) {
    aff = cleanStr(aff, 40);
    const p = await propertyOfAff(aff);
    if (!p) throw new PAError("No property is connected to this affiliate account.", 404);
    const rec = affiliates ? await affiliates.getAuth(aff) : null;
    const stored = rec && rec.passwordHash ? rec.passwordHash : await sha256Hex(DEFAULT_AFFILIATE_PASSWORD);
    if ((await sha256Hex(String(password || ""))) !== stored) throw new PAError("Incorrect hub password.", 403);
    return { token: await newSession(p), property: publicProperty(p) };
  }

  function publicProperty(p) {
    return { siteId: p.siteId, site: p.site, resortId: p.resortId, resortName: p.resortName, units: p.units, settings: p.settings, connectedAt: p.createdAt, demoAllowed: ["3"].includes(String(p.site)), firstBookable: firstBookable(p) };
  }

  // Calendar start (property setup): "today", or a set date that is also the
  // first date guests can book from, until it has passed.
  function firstBookable(prop) {
    const cs = prop && prop.settings && prop.settings.calendarStart;
    const t = today();
    return cs && cs.mode === "date" && /^\d{4}-\d{2}-\d{2}$/.test(cs.date || "") && cs.date > t ? cs.date : t;
  }
  function checkBookable(prop, start) {
    const fb = firstBookable(prop);
    if (start < fb) throw new PAError(fb === today() ? "Choose a check-in from today." : "Bookings open from " + fb + " (the property's first bookable date).");
  }

  // One Stock Network login per property is reused across requests until it
  // is close to expiring (SN's expiry, capped at TOKEN_REUSE_MS); a rejected
  // login triggers one fresh login inside SNClient.call.
  async function clientFor(prop) {
    const c = clientFactory(await decryptJSON(prop.credsEnc, encKey));
    try {
      const cached = await getJSON("tok:" + prop.siteId);
      if (cached && cached.enc && cached.until > now().getTime() + 60000) c.tok = await decryptJSON(cached.enc, encKey);
    } catch (_) {}
    c.onLogin = async (tok) => {
      const until = Math.min(tok.expires || Infinity, now().getTime() + TOKEN_REUSE_MS);
      await setJSON("tok:" + prop.siteId, { enc: await encryptJSON(tok, encKey), until });
    };
    return c;
  }

  // ---------- what the hub knows about SN availability ----------
  // snap:{siteId} = { open:{unit:[nights]}, nightRates:{unit:{night:rate}}, rates:{unit:min},
  //                   taken:{unit:{night:since}}, readAt:{night:ms}, fullAt, at }
  // Each read covers a window of dates and is merged in; nothing outside the
  // window changes. "taken" = a night that was open on SN at an earlier read
  // and has gone (booked on SN), excluding nights the hub booked itself.
  async function bookingsOf(prop) { return (await getJSON("book:" + prop.siteId)) || []; }
  function activeNightsByUnit(bookings) {
    const m = {};
    for (const b of bookings) if (b.status !== "Cancelled") for (const it of b.items) if (!it.cancelled) for (const n of eachNight(it.start, it.end)) ((m[it.unit] = m[it.unit] || {})[n] = b);
    return m;
  }
  function emptySnap() { return { open: {}, nightRates: {}, rates: {}, taken: {}, readAt: {}, at: null }; }
  async function loadSnap(prop) {
    const s = (await getJSON("snap:" + prop.siteId)) || emptySnap();
    s.open = s.open || {}; s.nightRates = s.nightRates || {}; s.taken = s.taken || {}; s.readAt = s.readAt || {}; s.rates = s.rates || {};
    return s;
  }
  function windowFresh(snap, from, to, maxAge) {
    const limit = now().getTime() - maxAge;
    return eachNight(from, to).every((n) => (snap.readAt[n] || 0) >= limit);
  }

  async function mergeWindow(prop, read, from, to, { first = false } = {}) {
    const snap = await loadSnap(prop);
    const ours = activeNightsByUnit(await bookingsOf(prop));
    const t0 = today();
    const inWin = (n) => n >= from && n < to;
    const open = {}, rates = {};
    for (const st of read.stretches) {
      if (!(st.unitsAvailable > 0)) continue;
      const nights = eachNight(st.start, st.end).filter(inWin);
      (open[st.unit] = open[st.unit] || new Set());
      for (const n of nights) open[st.unit].add(n);
      if (st.rateTotal && st.nights) { const r = Math.round(st.rateTotal / st.nights); const m = (rates[st.unit] = rates[st.unit] || {}); for (const n of nights) m[n] = r; }
    }
    const units = new Set([...Object.keys(snap.open), ...Object.keys(open), ...Object.keys(snap.taken), ...prop.units.map((u) => u.name)]);
    const stamp = now().toISOString();
    for (const u of units) {
      const was = new Set((snap.open[u] || []).filter(inWin));
      const nowOpen = open[u] || new Set();
      const tk = snap.taken[u] || {};
      for (const n of Object.keys(tk)) if (n < t0 || (inWin(n) && nowOpen.has(n))) delete tk[n];
      if (!first) for (const n of was) if (n >= t0 && !nowOpen.has(n) && !(ours[u] && ours[u][n])) tk[n] = tk[n] || stamp;
      if (Object.keys(tk).length) snap.taken[u] = tk; else delete snap.taken[u];
      const keep = (snap.open[u] || []).filter((n) => n >= t0 && !inWin(n));
      const merged = keep.concat([...nowOpen]).sort();
      if (merged.length) snap.open[u] = merged; else delete snap.open[u];
      const nr = snap.nightRates[u] || {};
      for (const n of Object.keys(nr)) if (n < t0 || inWin(n)) delete nr[n];
      Object.assign(nr, rates[u] || {});
      if (Object.keys(nr).length) { snap.nightRates[u] = nr; snap.rates[u] = Math.min(...Object.values(nr)); } else { delete snap.nightRates[u]; delete snap.rates[u]; }
    }
    const ms = now().getTime();
    for (const n of Object.keys(snap.readAt)) if (n < t0) delete snap.readAt[n];
    for (const n of eachNight(from, to)) snap.readAt[n] = ms;
    snap.at = stamp;
    await setJSON("snap:" + prop.siteId, snap);
    await noteUnits(prop, read.units, { first });
    return snap;
  }

  // New unit names seen on SN are added to the property. After the first
  // connect they are also flagged, because a "new" unit may be a renamed one
  // whose channel links need moving across.
  async function noteUnits(prop, found, { first = false } = {}) {
    const units = Object.values(found || {}).map((u) => ({ name: u.name, size: u.size, roomId: u.roomId }));
    const fresh = units.filter((u) => !prop.units.find((x) => x.name === u.name));
    if (!fresh.length) return;
    prop.units = mergeUnits(prop.units, fresh);
    if (!first) prop.unitNotices = (prop.unitNotices || []).concat(fresh.map((u) => ({ name: u.name, at: now().toISOString() })));
    await setJSON("site:" + prop.siteId, prop);
  }

  // Make sure the hub has a recent read of SN for [from, to).
  async function ensureWindow(prop, from, to, { maxAge = WINDOW_MAX_AGE_MS, client, force = false } = {}) {
    const snap = await loadSnap(prop);
    if (!force && windowFresh(snap, from, to, maxAge)) return snap;
    const c = client || (await clientFor(prop));
    const read = await c.openStretches(prop.resortId, from, to);
    return mergeWindow(prop, read, from, to);
  }

  // After the hub books or cancels, those nights must be read again next time.
  async function invalidate(prop, items) {
    const snap = await getJSON("snap:" + prop.siteId);
    if (!snap || !snap.readAt) return;
    for (const it of items) for (const n of eachNight(it.start, it.end)) delete snap.readAt[n];
    await setJSON("snap:" + prop.siteId, snap);
  }

  // Kept for callers/tests: refresh the window the sync normally watches.
  async function snapshot(prop, { force = false, client } = {}) {
    return ensureWindow(prop, today(), addDays(today(), SYNC_NEAR_DAYS), { force, client });
  }

  // ---------- availability for the grid / calendar ----------
  async function availability(prop, from, to) {
    from = from || today(); to = to || addDays(from, 14);
    if (to <= from || nightsBetween(from, to) > MAX_WINDOW_DAYS) throw new PAError("Choose a shorter date range.");
    // Only the days on screen are read from SN (past days never are).
    const snap = to > today() ? await ensureWindow(prop, from < today() ? today() : from, to) : await loadSnap(prop);
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
        if (b) row[n] = { s: b.origin === "channel" ? b.channel : "hub", ref: b.ref, name: guestLabel(b) };
        else if (p) row[n] = { s: p.status === "clash" ? "clash" : "pending", ch: p.channel, name: (CHANNELS[p.channel] || "Channel") + " guest" };
        else if (open.has(n)) row[n] = { s: "open" };
        else if (taken[n]) row[n] = { s: "sn" };
        else row[n] = { s: "na" };
      }
      nights[u.name] = row;
    }
    const nightRates = {};
    for (const u of prop.units) { const nr = (snap.nightRates || {})[u.name] || {}; const m = {}; for (const n of eachNight(from, to)) if (nr[n]) m[n] = nr[n]; nightRates[u.name] = m; }
    return { from, to, firstBookable: firstBookable(prop), snapshotAt: snap.at, units: prop.units.map((u) => ({ name: u.name, size: u.size, rateFrom: snap.rates[u.name] || null })), nights, nightRates, minStay: prop.settings.minStay || 2 };
  }

  async function search(prop, checkIn, checkOut) {
    if (!checkIn || !checkOut || checkOut <= checkIn) throw new PAError("Choose a check-out after the check-in.");
    checkBookable(prop, checkIn);
    if (nightsBetween(checkIn, checkOut) > MAX_WINDOW_DAYS - 2) throw new PAError("Choose a shorter stay.");
    // Read the stay, and at least the 2 weeks the grid will show next, in one call.
    const wEnd = checkOut > addDays(checkIn, 14) ? checkOut : addDays(checkIn, 14);
    const snap = await ensureWindow(prop, checkIn, wEnd);
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
  function decorate(b) { return Object.assign({}, b, { payState: payState(b), locked: isPaid(b), contact: contactOf(b) }); }

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
    notDemo(b);
    const client = await clientFor(prop);
    if (await refreshPayment(client, b)) await saveBookings(prop, list);
    return { booking: decorate(b), pay: await payInfoFor(prop, b) };
  }

  async function markPaidEft(prop, ref) {
    const { list, b } = await findBooking(prop, ref);
    notDemo(b);
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
    for (const it of items) checkBookable(prop, it.start);
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
    await invalidate(prop, items);
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
    notDemo(b);
    if (b.status === "Cancelled") return { booking: decorate(b) };
    const client = await clientFor(prop);
    if (await refreshPayment(client, b)) await saveBookings(prop, list);
    if (b.status === "Cancelled") return { booking: decorate(b), alreadyCancelled: true };
    if (isPaid(b)) return requestCancellation(prop, list, b);
    await client.cancelReservation(b.reservationId);
    b.status = "Cancelled"; b.cancelledAt = now().toISOString();
    await saveBookings(prop, list);
    await invalidate(prop, b.items);
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
      await invalidate(prop, b.items);
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
    notDemo(b);
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
    await invalidate(prop, [it]);
    return { booking: decorate(b) };
  }

  // Change unit and/or dates of a single-unit booking: SN can't edit, so cancel + rebook.
  async function edit(prop, ref, change) {
    const { list, b } = await findBooking(prop, ref);
    notDemo(b);
    const live = b.items.filter((it) => !it.cancelled);
    if (live.length !== 1) throw new PAError("Only single-unit bookings can be moved. Remove units, or cancel and book again.");
    const old = live[0];
    const next = { unit: cleanStr(change.unit, 60) || old.unit, start: cleanStr(change.start, 10) || old.start, end: cleanStr(change.end, 10) || old.end };
    const guest = validGuest(Object.assign({}, b.guest, change.guest || {}));
    if (next.start !== old.start) checkBookable(prop, next.start);
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
    await invalidate(prop, [old, next]);
    return { booking: decorate(rec), replaced: b.ref, pay: await payInfoFor(prop, rec) };
  }

  async function find(prop, q, { refresh = true } = {}) {
    const s = cleanStr(q, 80).toLowerCase();
    const list = await bookingsOf(prop);
    if (refresh) {
      const stale = list.filter((b) => !b.demo && b.origin !== "channel" && b.status !== "Cancelled" && !isPaid(b) && (!b.checkedAt || now().getTime() - Date.parse(b.checkedAt) > 120000)).slice(-10);
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
    if (body.calendarStart && typeof body.calendarStart === "object") {
      const mode = body.calendarStart.mode === "date" ? "date" : "today";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.calendarStart.date || "")) ? String(body.calendarStart.date) : "";
      if (mode === "date" && !date) throw new PAError("Choose the date the calendar opens on.");
      s.calendarStart = { mode, date: mode === "date" ? date : "" };
    }
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
        return { key, label: CHANNELS[key], exportUrl: baseUrl + "/ical/" + prop.feedToken + "/" + slug(u.name) + "/" + key + ".ics", importUrl: c.importUrl || "", status: c.importUrl ? (c.status || "waiting") : "off", lastRead: c.lastRead || null, error: c.error || null, events: c.events || 0, next: c.importUrl ? (c.next || []) : [] };
      }),
    }));
    const settings = Object.assign({ payMode: "both" }, prop.settings || {});
    const linked = Object.keys(prop.channels || {}).filter((n) => Object.values(prop.channels[n] || {}).some((c) => c && c.importUrl));
    return { settings, firstBookable: firstBookable(prop), bank: await bankOf(prop), units, affiliateLinked: !!prop.aff, unitNotices: prop.unitNotices || [], linkedUnits: linked };
  }

  // A unit name appeared on SN. from = the old unit it replaces (renamed on SN),
  // or empty when it really is a new unit. Moving keeps the old calendar link working.
  async function resolveUnitNotice(prop, name, from) {
    name = cleanStr(name, 60); from = cleanStr(from, 60);
    prop.unitNotices = (prop.unitNotices || []).filter((n) => n.name !== name);
    if (from && from !== name) {
      if (!prop.units.find((u) => u.name === name) || !prop.units.find((u) => u.name === from)) throw new PAError("Unknown unit.");
      const ch = prop.channels || {};
      if (ch[from]) { ch[name] = Object.assign({}, ch[from], ch[name] || {}); delete ch[from]; }
      prop.channels = ch;
      const pr = (prop.settings && prop.settings.prices) || {};
      if (pr[from] && !pr[name]) pr[name] = pr[from];
      delete pr[from];
      prop.unitAliases = Object.assign({}, prop.unitAliases || {}, { [slug(from)]: name });
      for (const [k, v] of Object.entries(prop.unitAliases)) if (v === from) prop.unitAliases[k] = name;
      prop.units = prop.units.filter((u) => u.name !== from);
      const events = (await getJSON("chan:" + prop.siteId)) || {};
      const moved = {};
      for (const [id, ev] of Object.entries(events)) { if (ev.unit === from) { ev.unit = name; moved[name + id.slice(from.length)] = ev; } else moved[id] = ev; }
      await setJSON("chan:" + prop.siteId, moved);
      const list = await bookingsOf(prop);
      let changed = false;
      for (const b of list) for (const it of b.items) if (it.unit === from) { it.unit = name; changed = true; }
      if (changed) await saveBookings(prop, list);
      const snap = await getJSON("snap:" + prop.siteId);
      if (snap) { for (const k of ["open", "taken", "nightRates", "rates"]) if (snap[k]) delete snap[k][from]; await setJSON("snap:" + prop.siteId, snap); }
    }
    await setJSON("site:" + prop.siteId, prop);
    return channelsView(prop);
  }

  // ---------- iCal export ----------
  async function icalFeed(feedToken, unitSlug, channelKey) {
    const f = await getJSON("feed:" + cleanStr(feedToken, 60));
    if (!f) return null;
    const prop = await getJSON("site:" + f.siteId);
    if (!prop) return null;
    const alias = (prop.unitAliases || {})[unitSlug];
    const unit = prop.units.find((u) => slug(u.name) === unitSlug) || (alias && prop.units.find((u) => u.name === alias));
    if (!unit || !CHANNELS[channelKey]) return null;
    try {
      const hit = await getJSON("feedhit:" + prop.siteId);
      if (!hit || now().getTime() - Date.parse(hit.at) > 3600000) await setJSON("feedhit:" + prop.siteId, { at: now().toISOString() });
    } catch (_) {}
    const snap = (await getJSON("snap:" + prop.siteId)) || { taken: {} };
    const t0 = today();
    const block = new Set();
    for (const n of Object.keys((snap.taken || {})[unit.name] || {})) if (n >= t0) block.add(n);
    for (const b of await bookingsOf(prop)) {
      if (b.demo || b.status === "Cancelled" || (b.origin === "channel" && b.channel === channelKey)) continue;
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

  function importLinks(prop) {
    let n = 0;
    for (const u of Object.values(prop.channels || {})) for (const c of Object.values(u || {})) if (c && c.importUrl) n++;
    return n;
  }
  // Linked = a channel calendar link is saved, or a channel fetched our calendar recently.
  async function isLinked(prop) {
    if (importLinks(prop)) return true;
    const hit = await getJSON("feedhit:" + prop.siteId);
    return !!(hit && now().getTime() - Date.parse(hit.at) < FEED_ACTIVE_MS);
  }

  async function syncProperty(prop, { full } = {}) {
    const client = await clientFor(prop);
    // Near dates every run; the whole year every SYNC_FULL_MS (or when asked).
    const snap0 = await loadSnap(prop);
    const doFull = full || !snap0.fullAt || now().getTime() - Date.parse(snap0.fullAt) > SYNC_FULL_MS - 5 * 60000;
    const snapR = await ensureWindow(prop, today(), addDays(today(), doFull ? HORIZON_DAYS : SYNC_NEAR_DAYS), { client, force: true });
    if (doFull) { snapR.fullAt = now().toISOString(); await setJSON("snap:" + prop.siteId, snapR); }
    prop = (await getJSON("site:" + prop.siteId)) || prop; // may have gained units
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
        // Shown beside the link so the property can check it belongs to this unit.
        c.next = parsed.slice().sort((x, y) => x.start.localeCompare(y.start)).slice(0, 3).map((e) => ({ start: e.start, end: e.end }));
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
    // No second availability read: nights the hub just booked or cancelled are
    // read again the next time they're needed.
    summary.read_sn = doFull ? "full year" : SYNC_NEAR_DAYS + " days";
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
      try { const n = await remindMessages(prop); if (n) out[prop.site + " messages"] = n + " reminder(s) emailed"; } catch (_) {}
      // Properties without channels make no background calls to Stock Network.
      if (!(await isLinked(prop))) { out[prop.site] = "not linked to a channel: skipped"; continue; }
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
    await invalidate(prop, [ev]);
    if (ev.status !== "booked") throw new PAError(ev.error || "Could not add it to Stock Network.", 409);
    return { event: ev };
  }

  // ---------- guest details (every booking, incl. paid and channel bookings) ----------
  // Kept in the hub only: Stock Network bookings can't be edited and don't
  // need to be for this. Channel bookings stay under the channel's name on SN.
  function contactOf(b) {
    if (b.contact) return b.contact;
    if (b.origin === "channel") return {};
    const g = b.guest || {};
    return { name: ((g.first || "") + " " + (g.last || "")).trim(), cell: g.cellphone || "", email: g.email || "" };
  }
  // The name shown on a calendar block.
  function guestLabel(b) {
    const c = contactOf(b);
    if (c.name) return c.name;
    if (b.origin === "channel") return (b.source || CHANNELS[b.channel] || "Channel") + " guest";
    return "Guest";
  }
  async function saveContact(prop, ref, body) {
    const { list, b } = await findBooking(prop, ref);
    const c = Object.assign({}, contactOf(b));
    const set = (k, n) => { if (body[k] !== undefined) c[k] = cleanStr(String(body[k]), n); };
    set("name", 100); set("cell", 30); set("email", 120); set("arrival", 40); set("carReg", 20); set("notes", 1000);
    if (body.guests !== undefined) c.guests = Math.max(0, Math.min(50, Number(body.guests) || 0)) || "";
    if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new PAError("That email address doesn't look right.");
    if (c.carReg) c.carReg = c.carReg.toUpperCase();
    if (body.offers !== undefined) c.offers = !!body.offers;
    if (body.optOut !== undefined) { c.optOut = !!body.optOut; if (c.optOut) c.offers = false; }
    c.updatedAt = now().toISOString();
    b.contact = c;
    await saveBookings(prop, list);
    return { booking: decorate(b) };
  }
  async function checkIn(prop, ref, on) {
    const { list, b } = await findBooking(prop, ref);
    const c = Object.assign({}, contactOf(b));
    if (on) c.checkedInAt = now().toISOString(); else delete c.checkedInAt;
    b.contact = c;
    await saveBookings(prop, list);
    return { booking: decorate(b) };
  }

  // Every guest once (matched by cellphone, else email), for the property's
  // records and return business.
  async function guests(prop) {
    const map = new Map();
    for (const b of await bookingsOf(prop)) {
      if (b.status === "Cancelled") continue;
      const c = contactOf(b);
      if (!c.name && !c.cell && !c.email) continue;
      const key = waNumber(c.cell) || (c.email || "").toLowerCase() || ("ref:" + b.ref);
      const live = b.items.filter((i) => !i.cancelled);
      if (!live.length) continue;
      const start = live.map((i) => i.start).sort()[0], end = live.map((i) => i.end).sort().slice(-1)[0];
      const g = map.get(key) || { name: "", cell: "", email: "", carReg: "", stays: 0, nights: 0, firstStay: start, lastStay: start, channels: [], offers: false, optOut: false, refs: [] };
      g.stays++; g.nights += live.reduce((t, i) => t + nightsBetween(i.start, i.end), 0);
      if (start < g.firstStay) g.firstStay = start;
      if (start >= g.lastStay) { g.lastStay = start; g.name = c.name || g.name; g.cell = c.cell || g.cell; g.email = c.email || g.email; g.carReg = c.carReg || g.carReg; }
      else { g.name = g.name || c.name || ""; g.cell = g.cell || c.cell || ""; g.email = g.email || c.email || ""; g.carReg = g.carReg || c.carReg || ""; }
      const ch = b.origin === "channel" ? b.source : (b.source || "Direct");
      if (ch && !g.channels.includes(ch)) g.channels.push(ch);
      if (c.offers) g.offers = true;
      if (c.optOut) g.optOut = true;
      g.refs.push(b.ref);
      void end;
      map.set(key, g);
    }
    const rows = [...map.values()].map((g) => Object.assign(g, { offers: g.offers && !g.optOut })).sort((x, y) => y.lastStay.localeCompare(x.lastStay));
    return { guests: rows };
  }

  // ---------- guest communication (WhatsApp one tap, email sent by the hub) ----------
  // prop.messages = { list: [message] }, as many scheduled messages as the
  // property wants. A message:
  //   { id, name, on, anchor, days, date, time, wa, email, subject, text }
  // anchor: before_arrival | arrival | during | before_checkout | after_checkout | date
  //   days = how many days before/after (before_arrival, during, before_checkout,
  //   after_checkout); date = YYYY-MM-DD for "date" (guests staying that day).
  // wa: WhatsApp — the property taps Send (the hub emails them a reminder when due).
  // email: the hub emails the guest itself, from the property's name, with
  //   replies going to the property's email address.
  // Per booking: b.msgs[id] = { state: sent|skipped (WhatsApp), at, remindedAt,
  //   email: { state: sent|failed, at, error } }.
  // Older properties stored { welcome:{...}, after:{...} }: those become the
  // first two messages (ids "welcome" and "after").
  const ANCHORS = ["before_arrival", "arrival", "during", "before_checkout", "after_checkout", "date"];
  const MAX_MESSAGES = 30;
  const MSG_DEFAULTS = {
    welcome: { id: "welcome", name: "Welcome", on: false, anchor: "before_arrival", days: 2, time: "10:00", wa: true, email: true, subject: "Your stay at {property}",
      text: "Hi {first_name}, we look forward to welcoming you to {property} on {check_in}! 🌊\n\nYour booking: {unit}, {nights} nights (ref {ref}).\n\n🕑 Check-in from 14:00, check-out by 10:00.\n📍 Directions: [your Google Maps pin]\n🔑 Arrival: [gate code / where to collect keys]\n📶 Wi-Fi: [network] / [password]\n🚗 Parking: one bay per unit — please send us your car registration.\n\nAny questions, just reply here. Safe travels!" },
    after: { id: "after", name: "After stay", on: false, anchor: "after_checkout", days: 1, time: "10:00", wa: true, email: true, subject: "Thank you for staying at {property}",
      text: "Hi {first_name}, thank you for staying at {property}! We hope you had a wonderful time. 😊\n\nWould you take a minute to tell us how it was? Your review helps other travellers: {review_link}\n\nWe'd love to welcome you back. Book direct with us next time for our best rate." },
  };
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function cleanMessage(v, cur) {
    v = v || {}; cur = cur || {};
    const pick = (k, d) => (v[k] !== undefined ? v[k] : cur[k] !== undefined ? cur[k] : d);
    const anchor = ANCHORS.includes(pick("anchor")) ? pick("anchor") : "before_arrival";
    const m = {
      id: cleanStr(String(pick("id", "") || ""), 40).replace(/[^a-z0-9_-]/gi, "") || "m" + randomToken(6).replace(/[^a-z0-9]/gi, "").slice(0, 8),
      name: cleanStr(String(pick("name", "") || ""), 60) || "Message",
      on: !!pick("on", false),
      anchor,
      days: Math.max(0, Math.min(365, Math.round(Number(pick("days", 0))) || 0)),
      date: DATE_RE.test(String(pick("date", "") || "")) ? String(pick("date")) : "",
      time: TIME_RE.test(String(pick("time", "") || "")) ? String(pick("time")) : "10:00",
      wa: pick("wa", true) !== false,
      email: pick("email", true) !== false,
      subject: cleanStr(String(pick("subject", "") || ""), 150),
      text: cleanStr(String(pick("text", "") || ""), 3000),
    };
    if (anchor === "date" && !m.date) m.on = false;
    return m;
  }
  function msgList(prop) {
    const m = prop.messages || {};
    if (Array.isArray(m.list)) return m.list.map((x) => cleanMessage(x));
    // Old shape (welcome + after) or nothing yet: the two starter messages.
    return ["welcome", "after"].map((k) => {
      const old = m[k] || {};
      const base = Object.assign({}, MSG_DEFAULTS[k], old, { id: k, anchor: MSG_DEFAULTS[k].anchor, wa: true, email: old.email !== undefined ? old.email : (m[k] ? false : MSG_DEFAULTS[k].email) });
      return cleanMessage(base);
    });
  }
  const SAST = "+02:00";
  function stayOf(b) {
    const live = b.items.filter((i) => !i.cancelled);
    if (!live.length) return null;
    return { start: live.map((i) => i.start).sort()[0], end: live.map((i) => i.end).sort().slice(-1)[0], live };
  }
  // When a message goes to a booking, and until when it still makes sense.
  function timing(msg, b) {
    const st = stayOf(b); if (!st) return null;
    const { start, end } = st;
    let day, lastDay;
    switch (msg.anchor) {
      case "before_arrival": day = addDays(start, -msg.days); lastDay = start; break;
      case "arrival": day = start; lastDay = start; break;
      case "during": day = addDays(start, msg.days); if (day >= end) return null; lastDay = end; break;
      case "before_checkout": day = addDays(end, -msg.days); if (day < start) day = start; lastDay = end; break;
      case "after_checkout": day = addDays(end, msg.days); lastDay = addDays(day, 7); break;
      case "date": if (!msg.date || !(msg.date >= start && msg.date <= end)) return null; day = msg.date; lastDay = msg.date; break;
      default: return null;
    }
    return { at: Date.parse(day + "T" + msg.time + ":00" + SAST), until: Date.parse(lastDay + "T23:59:00" + SAST), start, end };
  }
  function timeState(tm) {
    const t = now().getTime();
    if (t > tm.until) return "missed";
    return t >= tm.at ? "due" : "scheduled";
  }
  // { wa, email } states for one message on one booking (null = not used).
  function messageState(msg, b) {
    if (!msg.on || b.status === "Cancelled") return null;
    const tm = timing(msg, b); if (!tm) return null;
    const rec = (b.msgs || {})[msg.id] || {};
    const ts = timeState(tm), c = contactOf(b);
    let wa = null, email = null;
    if (msg.wa) wa = rec.state === "sent" || rec.state === "skipped" ? rec.state : ts;
    if (msg.email) {
      const e = rec.email || {};
      email = e.state === "sent" ? "sent" : ts === "missed" ? "missed" : !validEmail(c.email) ? (ts === "scheduled" ? "scheduled-no-email" : "no-email") : e.state === "failed" && ts !== "due" ? "failed" : ts;
    }
    return { wa, email, dueAt: tm.at, start: tm.start };
  }
  function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "")); }
  function firstName(c) { return String(c.name || "").trim().split(/\s+/)[0] || ""; }
  function fillTemplate(text, prop, b, extra = {}) {
    const c = contactOf(b), st = stayOf(b) || { start: "", end: "", live: [] };
    const nice = (iso) => { if (!iso) return ""; const d = new Date(iso + "T00:00:00Z"); return d.getUTCDate() + " " + ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getUTCMonth()] + " " + d.getUTCFullYear(); };
    const vals = { first_name: firstName(c) || "there", name: c.name || "", property: prop.resortName || "", unit: st.live.map((i) => i.unit).join(", "),
      check_in: nice(st.start), check_out: nice(st.end), nights: st.start && st.end ? String(nightsBetween(st.start, st.end)) : "", ref: b.ref, review_link: extra.review_link || "" };
    return String(text || "").replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m)).replace(/\n{3,}/g, "\n\n").trim();
  }
  async function reviewLinksFor(prop, b) {
    if (!reviews || !reviews.baseUrl || !reviews.secret) throw new PAError("Avante Reviews isn't connected yet, so the review link can't be added.", 503);
    const c = contactOf(b), st = stayOf(b) || {};
    const res = await fetchImpl(reviews.baseUrl.replace(/\/$/, "") + "/internal/review-links/" + encodeURIComponent(reviews.tenant || "avante"), {
      method: "POST", headers: { "content-type": "application/json", "x-sync-secret": reviews.secret },
      body: JSON.stringify({ resort_id: prop.resortId, resort_name: prop.resortName, booking_ref: b.ref,
        start_date: st.start, end_date: st.end,
        guest: { full_name: c.name || "Guest", email: c.email || "", whatsapp_number: waNumber(c.cell) ? "+" + waNumber(c.cell) : "" } }),
    }).catch(() => null);
    if (!res || !res.ok) throw new PAError("Avante Reviews didn't answer, so the review link can't be added right now. Try again in a minute.", 502);
    const d = await res.json();
    return { guest: d.guest_link || null, property: d.property_link || null, guestReviewed: !!d.guest_reviewed, propertyReviewed: !!d.property_reviewed, expiresAt: d.expires_at || null };
  }
  function findMessage(prop, id) { return msgList(prop).find((m) => m.id === id) || null; }
  // Fills a message for one booking: { text, subject }. The review link line
  // is dropped when there is no link to put in it.
  async function composeFor(prop, b, text, subject, { strictReview = true } = {}) {
    let links = null;
    if (/\{review_link\}/.test(text)) {
      try { links = await reviewLinksFor(prop, b); } catch (e) { if (strictReview) throw e; links = { guest: null }; }
    }
    if (links && !links.guest) text = text.replace(/[^\n]*\{review_link\}[^\n]*\n?/g, "");
    return { text: fillTemplate(text, prop, b, { review_link: links && links.guest }), subject: fillTemplate(subject || "", prop, b) || ("Your stay at " + (prop.resortName || "our property")), guestReviewed: !!(links && links.guestReviewed) };
  }
  // The text to send and a WhatsApp link to the guest. kind: a message id, or "custom".
  async function prepareMessage(prop, ref, kind, customText) {
    const { b } = await findBooking(prop, ref);
    const c = contactOf(b);
    const wa = waNumber(c.cell);
    if (!wa) throw new PAError("Add the guest's cellphone number first (Guest details).");
    const msg = kind === "custom" ? null : findMessage(prop, kind);
    if (kind !== "custom" && !msg) throw new PAError("Unknown message.");
    const out = await composeFor(prop, b, kind === "custom" ? String(customText || "") : msg.text, msg && msg.subject);
    if (!out.text) throw new PAError("Write the message first.");
    return { text: out.text, subject: out.subject, whatsappUrl: "https://wa.me/" + wa + "?text=" + encodeURIComponent(out.text), guestReviewed: out.guestReviewed, hasEmail: validEmail(c.email) };
  }
  async function markMessage(prop, ref, kind, state, text) {
    const { list, b } = await findBooking(prop, ref);
    if (kind !== "custom" && !findMessage(prop, kind)) throw new PAError("Unknown message.");
    if (kind !== "custom") { b.msgs = b.msgs || {}; b.msgs[kind] = Object.assign({}, b.msgs[kind] || {}, { state: state === "skipped" ? "skipped" : "sent", at: now().toISOString() }); }
    if (state !== "skipped") b.msgLog = (b.msgLog || []).concat([{ at: now().toISOString(), kind, via: "whatsapp", text: cleanStr(String(text || ""), 1500) }]).slice(-30);
    await saveBookings(prop, list);
    return { booking: decorate(b) };
  }

  // ---------- email to guests ----------
  function linkify(s) { return s.replace(/(https?:\/\/[^\s<]+)/g, (u) => "<a href=\"" + u + "\">" + u + "</a>"); }
  function emailHtml(prop, text) {
    const body = linkify(esc(text)).replace(/\n/g, "<br>");
    return "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px\">" + body +
      "<p style=\"margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280\">" + esc(prop.resortName || "Your host") +
      (prop.settings && prop.settings.email ? " · Reply to this email to reach us." : "") + "</p></div>";
  }
  // Sends one email to a booking's guest and records it. Returns { sent, error }.
  async function emailGuest(prop, b, text, subject, kind) {
    const c = contactOf(b);
    if (!validEmail(c.email)) return { sent: false, error: "no-email" };
    const s = prop.settings || {};
    const ok = await sendEmail(c.email, subject, emailHtml(prop, text), { fromName: prop.resortName || "", replyTo: validEmail(s.email) ? s.email : "" }).catch(() => false);
    if (ok) b.msgLog = (b.msgLog || []).concat([{ at: now().toISOString(), kind, via: "email", subject: cleanStr(subject, 150), text: cleanStr(text, 1500) }]).slice(-30);
    return ok ? { sent: true } : { sent: false, error: "failed" };
  }
  // Email now, from the booking screen: a scheduled message (kind = its id) or a custom one.
  async function emailNow(prop, ref, kind, customText, customSubject) {
    const { list, b } = await findBooking(prop, ref);
    const c = contactOf(b);
    if (!validEmail(c.email)) throw new PAError("Add the guest's email address first (Guest details).");
    const msg = kind === "custom" ? null : findMessage(prop, kind);
    if (kind !== "custom" && !msg) throw new PAError("Unknown message.");
    const text0 = kind === "custom" ? String(customText || "") : msg.text;
    if (!text0.trim()) throw new PAError("Write the message first.");
    const out = await composeFor(prop, b, text0, kind === "custom" ? cleanStr(String(customSubject || ""), 150) : msg.subject);
    const r = await emailGuest(prop, b, out.text, out.subject, kind);
    if (!r.sent) throw new PAError("The email couldn't be sent right now. Try again in a minute.", 502);
    if (msg) { b.msgs = b.msgs || {}; b.msgs[msg.id] = Object.assign({}, b.msgs[msg.id] || {}, { email: { state: "sent", at: now().toISOString() } }); }
    await saveBookings(prop, list);
    return { booking: decorate(b), to: maskEmail(c.email) };
  }

  // ---------- guests staying now ----------
  function inHouseOf(list) {
    const t = today(), out = [];
    for (const b of list) {
      if (b.status === "Cancelled") continue;
      const st = stayOf(b); if (!st) continue;
      if (!(st.start <= t && t <= st.end)) continue;
      if (st.end === t && st.start !== t && b.contact && b.contact.checkedOutAt) continue;
      const c = contactOf(b);
      out.push({ ref: b.ref, name: c.name || (b.origin === "channel" ? (b.source || CHANNELS[b.channel] || "Channel") + " guest" : "Guest"), cell: c.cell || "", email: c.email || "",
        hasCell: !!waNumber(c.cell), hasEmail: validEmail(c.email), units: st.live.map((i) => i.unit).join(", "), start: st.start, end: st.end,
        arriving: st.start === t, leaving: st.end === t, checkedIn: !!(c.checkedInAt), source: b.origin === "channel" ? b.source : (b.source || "Direct") });
    }
    return out.sort((x, y) => x.units.localeCompare(y.units, "en", { numeric: true }));
  }
  async function inHouse(prop) { return { guests: inHouseOf(await bookingsOf(prop)), today: today() }; }
  // One email to each in-house guest the property ticked who has an email
  // address (each gets their own copy, with their own name filled in).
  async function emailInHouse(prop, body) {
    const text0 = String((body && body.text) || "").trim();
    if (!text0) throw new PAError("Write the message first.");
    const subject0 = cleanStr(String((body && body.subject) || ""), 150) || "A message from {property}";
    // The property chooses who gets it: only the bookings it ticked.
    if (!Array.isArray(body && body.refs) || !body.refs.length) throw new PAError("Choose the guests to send it to.");
    const want = new Set(body.refs.map((r) => cleanStr(String(r), 20)));
    const list = await bookingsOf(prop);
    const guestsNow = inHouseOf(list).filter((g) => !want || want.has(g.ref));
    let sent = 0, failed = 0; const noEmail = [];
    for (const g of guestsNow) {
      const b = list.find((x) => x.ref === g.ref);
      if (!g.hasEmail) { noEmail.push(g.name); continue; }
      const out = await composeFor(prop, b, text0, subject0, { strictReview: false });
      const r = await emailGuest(prop, b, out.text, out.subject, "in-house");
      if (r.sent) sent++; else failed++;
    }
    await saveBookings(prop, list);
    return { sent, failed, noEmail };
  }

  async function propertyReviewLink(prop, ref) {
    const { b } = await findBooking(prop, ref);
    const links = await reviewLinksFor(prop, b);
    return { link: links.property, reviewed: links.propertyReviewed };
  }
  function messageItems(prop, list) {
    const msgs = msgList(prop), out = [];
    for (const b of list) for (const msg of msgs) {
      const st = messageState(msg, b); if (!st) continue;
      const c = contactOf(b);
      out.push({ ref: b.ref, kind: msg.id, label: msg.name, wa: st.wa, email: st.email,
        state: st.wa === "due" || st.email === "due" ? "due" : (st.wa === "scheduled" || st.email === "scheduled" || st.email === "scheduled-no-email") ? "scheduled" : (st.wa || st.email),
        dueAt: new Date(st.dueAt).toISOString(), name: c.name || (b.origin === "channel" ? b.source + " guest" : ""), hasCell: !!waNumber(c.cell), hasEmail: validEmail(c.email),
        units: b.items.filter((i) => !i.cancelled).map((i) => i.unit).join(", "), start: st.start });
    }
    return out.sort((x, y) => x.dueAt.localeCompare(y.dueAt));
  }
  async function messagesView(prop) {
    const list = await bookingsOf(prop);
    const items = messageItems(prop, list);
    const t = now().getTime();
    return { list: msgList(prop), reviewsConnected: !!(reviews && reviews.baseUrl && reviews.secret), propertyEmail: (prop.settings && prop.settings.email) || "",
      // WhatsApp messages waiting for the property to tap Send.
      due: items.filter((i) => i.wa === "due"),
      // Emails the hub couldn't send (no address yet, or the send failed).
      emailIssues: items.filter((i) => i.wa !== "due" && (i.email === "failed" || (i.email === "no-email" && t - Date.parse(i.dueAt) < 3 * 86400000))),
      upcoming: items.filter((i) => i.state === "scheduled" && Date.parse(i.dueAt) - t < 14 * 86400000),
      inHouse: inHouseOf(list) };
  }
  async function saveMessages(prop, body) {
    const cur = msgList(prop);
    const incoming = Array.isArray(body && body.list) ? body.list.slice(0, MAX_MESSAGES) : null;
    if (!incoming) throw new PAError("Nothing to save.");
    const seen = new Set();
    const out = incoming.map((v) => {
      const m = cleanMessage(v, cur.find((x) => x.id === (v && v.id)));
      while (seen.has(m.id)) m.id = "m" + randomToken(6).replace(/[^a-z0-9]/gi, "").slice(0, 8);
      seen.add(m.id);
      if (m.on && !m.text) throw new PAError("Write the \"" + m.name + "\" message before switching it on.");
      if (m.on && !m.wa && !m.email) throw new PAError("Choose WhatsApp, email or both for \"" + m.name + "\".");
      if (m.anchor === "date" && v && v.on && !m.date) throw new PAError("Choose the date for \"" + m.name + "\".");
      return m;
    });
    prop.messages = { list: out };
    await setJSON("site:" + prop.siteId, prop);
    return messagesView(prop);
  }
  // 15-minute job, no Stock Network calls:
  //  - emails due messages to guests (from the property's name),
  //  - emails the property once about WhatsApp messages that are now due.
  const MAX_AUTO_EMAILS = 25;
  async function remindMessages(prop) {
    const msgs = msgList(prop).filter((m) => m.on);
    if (!msgs.length) return 0;
    const s = prop.settings || {};
    const list = await bookingsOf(prop);
    const fresh = []; let emailed = 0, changed = false;
    for (const b of list) {
      if (b.demo) continue; // demo bookings never email anyone
      for (const msg of msgs) {
        const st = messageState(msg, b);
        if (!st) continue;
        b.msgs = b.msgs || {};
        const rec = b.msgs[msg.id] || {};
        if (st.email === "due" && emailed < MAX_AUTO_EMAILS && !(rec.email && rec.email.state === "failed" && now().getTime() - Date.parse(rec.email.at) < 3600000)) {
          const out = await composeFor(prop, b, msg.text, msg.subject, { strictReview: false });
          const r = await emailGuest(prop, b, out.text, out.subject, msg.id);
          b.msgs[msg.id] = Object.assign({}, b.msgs[msg.id] || {}, { email: r.sent ? { state: "sent", at: now().toISOString(), auto: true } : { state: "failed", at: now().toISOString() } });
          emailed++; changed = true;
        }
        if (st.wa === "due" && !rec.remindedAt) {
          b.msgs[msg.id] = Object.assign({}, b.msgs[msg.id] || {}, { remindedAt: now().toISOString() });
          fresh.push({ b, msg }); changed = true;
        }
      }
    }
    if (changed) await saveBookings(prop, list);
    if (fresh.length && s.email) {
      const rows = fresh.map(({ b, msg }) => { const c = contactOf(b); return "<li><b>" + esc(msg.name) + "</b> to " + esc(c.name || "the guest") + " (" + esc(b.ref) + ")" + (waNumber(c.cell) ? "" : " — add their cellphone number first") + "</li>"; }).join("");
      await sendEmail(s.email, "WhatsApp messages to send: " + (prop.resortName || "your property"),
        "<p>These guest messages are ready to send on WhatsApp:</p><ul>" + rows + "</ul><p>Open the Avante hub, Property Affiliate → Communication, and tap <b>WhatsApp</b> on each one. WhatsApp opens with the message ready.</p>").catch(() => false);
    }
    return fresh.length + emailed;
  }

  // ---------- demo bookings (Property Testing, site 3, only) ----------
  // Hub-only examples to show guest details, the Guests list and messages.
  // Never sent to Stock Network or to channel calendars.
  const DEMO_SITES = ["3"];
  function isDemoSite(prop) { return DEMO_SITES.includes(String(prop.site)); }
  async function seedDemo(prop) {
    if (!isDemoSite(prop)) throw new PAError("Demo bookings are only for the Property Testing site.", 403);
    const list = (await bookingsOf(prop)).filter((b) => !b.demo);
    const u = (i) => (prop.units[i % Math.max(1, prop.units.length)] || { name: "Unit 1" }).name;
    const t = today(), d = (n) => addDays(t, n), ts = now().toISOString();
    const mk = (n, o) => Object.assign({ ref: "DEMO-" + n, demo: true, reservationId: null, status: "Booked", origin: "hub", source: "Direct", createdAt: ts, amountPaid: 0, snStatus: "Booked" }, o);
    list.push(
      mk(1, { items: [{ unit: u(0), start: d(1), end: d(4) }], total: 5400, guest: { first: "Thandi", last: "Mokoena", email: "thandi.demo@example.com", cellphone: "082 555 0101" },
        contact: { name: "Thandi Mokoena", cell: "082 555 0101", email: "thandi.demo@example.com", guests: 4, arrival: "About 15:00", carReg: "CA 123-456", offers: true, notes: "Celebrating an anniversary: flowers in the room." } }),
      mk(2, { origin: "channel", channel: "airbnb", source: "Airbnb", items: [{ unit: u(1), start: d(0), end: d(3) }], total: 4200,
        contact: { name: "Pieter van der Merwe", cell: "083 555 0202", email: "", guests: 2, arrival: "Late, after 20:00", carReg: "CY 98-765", checkedInAt: ts, notes: "Called him: arriving late, key in the lockbox." } }),
      mk(3, { items: [{ unit: u(0), start: d(-7), end: d(-2) }], total: 9000, amountPaid: 9000, snStatus: "Paid", status: "Paid", guest: { first: "Sarah", last: "Jacobs", email: "sarah.demo@example.com", cellphone: "071 555 0303" },
        contact: { name: "Sarah Jacobs", cell: "071 555 0303", email: "sarah.demo@example.com", guests: 3, carReg: "GP 45 ZZ GP", checkedInAt: new Date(Date.parse(d(-7) + "T14:30:00+02:00")).toISOString(), offers: true } }),
      mk(4, { origin: "channel", channel: "bcom", source: "Booking.com", items: [{ unit: u(1), start: d(9), end: d(12) }], total: 6300, contact: {} }),
      mk(5, { items: [{ unit: u(0), start: d(-60), end: d(-57) }], total: 5400, amountPaid: 5400, snStatus: "Paid", status: "Paid", guest: { first: "Sarah", last: "Jacobs", email: "sarah.demo@example.com", cellphone: "071 555 0303" },
        contact: { name: "Sarah Jacobs", cell: "071 555 0303", email: "sarah.demo@example.com", guests: 2, carReg: "GP 45 ZZ GP", offers: true }, msgs: { welcome: { state: "sent", at: ts }, after: { state: "sent", at: ts } } }),
      mk(6, { source: "Walk-in", items: [{ unit: u(2), start: d(16), end: d(18) }], total: 3600, guest: { first: "Lerato", last: "Dlamini", email: "", cellphone: "084 555 0606" },
        contact: { name: "Lerato Dlamini", cell: "084 555 0606", guests: 2, optOut: true } }),
    );
    await saveBookings(prop, list);
    const ml = msgList(prop);
    for (const m of ml) if (m.id === "welcome" || m.id === "after") m.on = true;
    prop.messages = { list: ml };
    await setJSON("site:" + prop.siteId, prop);
    return { added: 6 };
  }
  async function clearDemo(prop) {
    const list = await bookingsOf(prop);
    const keep = list.filter((b) => !b.demo);
    await saveBookings(prop, keep);
    return { removed: list.length - keep.length };
  }
  function notDemo(b) { if (b && b.demo) throw new PAError("This is a demo booking: it isn't on Stock Network, so it can't be changed, paid or cancelled.", 409); }

  return { connect, auth, disconnect, publicProperty, availability, search, book, cancel, cancelUnit, edit, find, saveSettings, channelsView, payInfo, markPaidEft, approvalInfo, approveCancel, affStatus, resume, seedDemo, clearDemo, isDemoSite, saveContact, checkIn, guests, messagesView, saveMessages, prepareMessage, markMessage, emailNow, inHouse, emailInHouse, firstBookable, propertyReviewLink, remindMessages, icalFeed, runSync, syncProperty, channelEvents, addChannelEvent, snapshot, ensureWindow, resolveUnitNotice, findResortsForSite };
}

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
import { emailList as listOf, badEmails, recipients } from "./emails.js";
import { allListings, readAllEntries } from "./blob-records.js";
import "../../../commission.js"; // globalThis.AvanteCommission: Avante's commission rates

export const CHANNELS = { bcom: "Booking.com", airbnb: "Airbnb", lekke: "LekkeSlaap" };
// The address properties invite on their channels, set in Admin > Property
// Listings > Channel setup help (kept in the property-affiliate store).
export const CHANNEL_HELP_KEY = "admincfg:channelHelp";
export const CHANNEL_HELP_DEFAULT = "admin@avantehospitality.co.za";
const CONNECT_DAYS = [14];               // connect reads only the first 14 days; later days load as the calendar moves (Jean: keep SN calls light)
const HORIZON_DAYS = 365;               // full read: at connect, and every SYNC_FULL_MS for channel-linked properties
const SYNC_NEAR_DAYS = 60;              // every 15-minute sync reads only this far ahead
const SYNC_FULL_MS = 2 * 3600 * 1000;   // ... and the full year this often
const WINDOW_MAX_AGE_MS = 5 * 60 * 1000; // a screen window is re-read from SN when older than this
const MAX_WINDOW_DAYS = 62;             // the screen never asks SN for more than this at once
const TOKEN_REUSE_MS = 50 * 60 * 1000;
const FEED_ACTIVE_MS = 48 * 3600 * 1000; // a calendar link fetched by a channel within this time counts as linked
const PAY_MODES = ["both", "gateway", "eft"];
const DEFAULT_AFFILIATE_PASSWORD = "0000"; // same default as auth-api.js

export function slug(name) { return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
// Weekend prices (Jean, 2026-10-22). Days 0 = Monday ... 6 = Sunday, the
// night guests sleep there. Weekend nights must follow each other (as in
// Stock Network's rates file, sn-export.js).
export function dayList(v) {
  const out = [];
  for (const p of Array.isArray(v) ? v : String(v == null ? "" : v).split(",")) { const n = parseInt(p, 10); if (n >= 0 && n <= 6 && !out.includes(n)) out.push(n); }
  return out.sort();
}
export function daysInARow(days) { return days.length > 0 && (days.length === 7 || days.filter((d) => !days.includes((d + 6) % 7)).length === 1); }
const dayOfIso = (iso) => (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;
// The property's own price for a night of a unit (Reservation settings), or 0.
export function nightPrice(settings, unit, iso) {
  const s = settings || {}, mid = (s.prices || {})[unit] || 0, we = (s.weekendPrices || {})[unit] || 0;
  return s.weekendRates && we > 0 && (s.weekendDays || [4, 5]).includes(dayOfIso(iso)) ? we : mid;
}
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
export function createCore({ store, resortStore, encKey, now = () => new Date(), clientFactory = (c) => new SNClient(c), fetchImpl = (...a) => fetch(...a), baseUrl = "", affiliates = null, sendEmail = async () => false, reviews = null, snFeed = null, listingStore = null, adminEmail = async () => "" }) {
  const today = () => now().toISOString().slice(0, 10);
  const getJSON = (k) => store.get(k, { type: "json" });
  // Set once every connected property has its "aff:<number>" link (see propertyOfAff).
  const AFF_LINKS_DONE = "meta:affLinksBackfilled";
  const setJSON = (k, v) => store.setJSON(k, v);

  // ---------- properties & sessions ----------
  async function resortRows() {
    if (!resortStore) return [];
    const rec = await resortStore.get("current", { type: "json" }).catch(() => null);
    return (rec && rec.resorts) || [];
  }
  // The property's name when its availability read didn't bring one (no free
  // nights in the first days read, Jean 2026-10-18: a channel property showed
  // "Your property · 0 units"): the hub's resort list, then the live feed.
  async function nameOf(rid) {
    const k = String(rid || "").trim().toLowerCase(); if (!k) return "";
    const row = (await resortRows()).find((r) => String(r.resortId || "").toLowerCase() === k);
    if (row && row.name) return row.name;
    const f = snFeed && snFeed.byResort ? await snFeed.byResort(k).catch(() => null) : null;
    return f ? String(f.name || f.resortName || "").trim() : "";
  }
  // The unit types on the property's Avante listing (filled from Stock Network
  // when the listing was made, "Pull again from Stock Network" refreshes them).
  async function listingUnits(rid) {
    const k = String(rid || "").trim().toLowerCase();
    if (!listingStore || !k) return [];
    const all = await allListings(listingStore);
    const rec = all.find((r) => r && String(r.resortId || "").toLowerCase() === k && (r.unitTypes || []).length);
    return rec ? rec.unitTypes.filter((u) => u && u.name).map((u) => ({ name: String(u.name).trim(), size: Number(u.maxOccupancy) || 0 })) : [];
  }
  // The hub's resort list first; then Avante's own Property Listings (admin
  // types a new property's ResortID there when Stock Network gives it); then
  // Stock Network's live feed, which also has properties created after the
  // list was loaded (Jean, 2026-10-16/17).
  async function findResortsForSite(siteNr, siteId) {
    const rows = await resortRows();
    const hit = rows.filter((r) => String(r.siteId || "").trim() === String(siteNr)).map((r) => ({ resortId: r.resortId, name: r.name }));
    if (hit.length) return hit;
    const listed = (await listingsForSite(siteNr).catch(() => [])).map((r) => ({ resortId: r.resortId, name: r.propertyName || "" }));
    if (listed.length || !snFeed) return listed;
    return (await snFeed.bySite(siteNr, siteId).catch(() => [])).map((r) => ({ resortId: r.resortId, name: r.name }));
  }
  async function listingsForSite(siteNr) {
    if (!listingStore || !String(siteNr || "").trim()) return [];
    const all = await allListings(listingStore);
    return all.filter((r) => r && r.resortId && String(r.siteNr || "").trim() === String(siteNr).trim());
  }
  // "Which property is this?" search: name or place, resort list plus the live feed, no duplicates.
  async function findResort(q) {
    q = cleanStr(q, 80).toLowerCase();
    if (q.length < 3) return { resorts: [] };
    // Properties whose name matches come first, then those in a matching place.
    const inName = (r) => String(r.name || "").toLowerCase().indexOf(q) > -1;
    const inPlace = (r) => [r.district, r.city, r.suburb].join(" ").toLowerCase().indexOf(q) > -1;
    const seen = new Set(), out = [];
    const add = (r) => { const id = String(r.resortId || "").toLowerCase(); if (!id || seen.has(id) || out.length >= 12) return; seen.add(id); out.push({ resortId: r.resortId, name: r.name, district: r.district || r.city || "" }); };
    const rows = await resortRows(), feed = snFeed ? await snFeed.search(q, 40).catch(() => []) : [];
    rows.filter(inName).forEach(add); feed.filter(inName).forEach(add);
    rows.filter(inPlace).forEach(add); feed.filter(inPlace).forEach(add);
    return { resorts: out };
  }

  async function connect({ username, clientID, clientSecret, aff, resortId }) {
    const creds = { username: cleanStr(username, 100), clientID: cleanStr(clientID, 100), clientSecret: cleanStr(clientSecret, 100) };
    if (!creds.username || !creds.clientID || !creds.clientSecret) throw new PAError("Enter your Avante login: username, client ID and client secret.");
    const client = clientFactory(creds);
    let tok;
    try { tok = await client.login(); } catch (e) { throw new PAError(e.message || "Your Avante login failed.", 401); }

    let rid = cleanStr(resortId, 64);
    if (!rid) {
      const matches = await findResortsForSite(tok.site, tok.siteId);
      if (matches.length === 1) rid = matches[0].resortId;
      else return { needResort: true, site: tok.site, candidates: matches };
    }
    const existing = await getJSON("site:" + tok.siteId);
    // A channel property is only asked about when the hook builder searches
    // (Jean, 2026-10-18): no availability read here. Its name comes from the
    // hub's lists, its units from its Avante listing.
    const channel = await isChannelAff(cleanStr(aff, 40) || (existing && existing.aff));
    // Start on the property's calendar start date (if it was connected before), today otherwise.
    const from0 = existing ? firstBookable(existing) : today();
    let snap = null, readTo = from0, lastErr = null;
    if (channel) snap = { resortName: "", units: {} };
    else for (const days of CONNECT_DAYS) {
      try { snap = await client.openStretches(rid, from0, addDays(from0, days)); readTo = addDays(from0, days); break; } catch (e) { lastErr = e; }
    }
    if (!snap) throw new PAError("Avante's booking system couldn't read this property's availability. " + ((lastErr && lastErr.message) || ""), 502);
    const units = channel ? await listingUnits(rid) : Object.values(snap.units).map((u) => ({ name: u.name, size: u.size, roomId: u.roomId }));
    const prop = Object.assign({
      siteId: tok.siteId, site: tok.site, feedToken: randomToken(18), createdAt: now().toISOString(),
      settings: { email: "", phone: "", prices: {}, minStay: 2, autoBook: false, payMode: "both" }, channels: {},
    }, existing || {}, {
      resortId: rid, resortName: snap.resortName || (existing && existing.resortName) || await nameOf(rid),
      units: mergeUnits(existing && existing.units, units), aff: cleanStr(aff, 40) || (existing && existing.aff) || "",
      credsEnc: await encryptJSON(creds, encKey), updatedAt: now().toISOString(),
    });
    await setJSON("site:" + prop.siteId, prop);
    await setJSON("feed:" + prop.feedToken, { siteId: prop.siteId });
    await syncChannelFlag(prop);
    const token = await newSession(prop);
    if (prop.aff) await setJSON("aff:" + prop.aff, { siteId: prop.siteId });
    // Connecting reads the first days once, to find every unit and its open nights (not for a channel property).
    if (!channel) await mergeWindow(prop, snap, from0, readTo, { first: true });
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
  // The token starts with the site id ("<siteId>~<random>"), so the session and the
  // property (and its grid) can be read at the same time instead of one after another.
  async function newSession(prop) {
    const token = String(prop.siteId).replace(/[^A-Za-z0-9-]/g, "") + "~" + randomToken(24).replace(/[^A-Za-z0-9_-]/g, "");
    await setJSON("sess:" + token, { siteId: prop.siteId, aff: prop.aff || "", createdAt: now().toISOString() });
    return token;
  }

  function siteOfToken(token) { const m = /^([A-Za-z0-9-]{8,64})~/.exec(String(token || "")); return m ? m[1] : null; }
  async function auth(token, { repairLink = false } = {}) {
    const t = cleanStr(token, 120);
    if (!t) throw new PAError("Not connected.", 401);
    const guess = siteOfToken(t);
    const [s, guessed] = await Promise.all([getJSON("sess:" + t), guess ? getJSON("site:" + guess) : null]);
    if (!s) throw new PAError("Not connected on this device.", 401);
    const prop = guess && s.siteId === guess ? guessed : await getJSON("site:" + s.siteId);
    if (!prop) throw new PAError("This property is no longer connected.", 401);
    if (!prop.resortName && prop.resortId) { const n = await nameOf(prop.resortId); if (n) { prop.resortName = n; await setJSON("site:" + prop.siteId, prop); } }
    if (repairLink && prop.aff) { const link = await getJSON("aff:" + prop.aff); if (!link) await setJSON("aff:" + prop.aff, { siteId: prop.siteId }); }
    await syncChannelFlag(prop);
    return prop;
  }

  // Channel Property Affiliate (Jean, 2026-10-13): a property on NightsBridge
  // (or another channel manager) that feeds Stock Network. It uses this module
  // like any property affiliate — same Stock Network login, Site Nr and Site
  // ID, activities (once admin ticks them), reviews — but never what its channel manager
  // already gives it: no calendar, channel (iCal) sync, guest records or guest
  // messages, no manual bookings or EFT, no hub minimum stay or calendar
  // start, no "approve each guest". Guests always pay on the Stock Network
  // payment page. The flag comes from the affiliate's types (admin ticks
  // "Channel Property Affiliate") and is kept on the property so the public
  // front store (stay-api.js, no affiliate lookup) follows the same rules.
  // Is this affiliate a Channel Property Affiliate (and not also a Property Affiliate)? null when unknown.
  // -> { channel, acts } or null when unknown. A Channel Property gets Activities
  // only when admin ticks it, and never a front store: it embeds its Promotions
  // page on its own website instead (Jean, 2026-10-20).
  async function channelOf(aff) {
    if (!affiliates || !aff) return null;
    let pr = null;
    try { pr = await affiliates.getProfile(aff); } catch (_) { return null; }
    const types = pr && Array.isArray(pr.types) ? pr.types : [];
    const channel = types.indexOf("channel") > -1 && types.indexOf("property") === -1;
    return { channel, acts: channel && pr.channelActivities === true };
  }
  async function isChannelAff(aff) { const c = await channelOf(aff); return c ? c.channel : null; }
  async function syncChannelFlag(prop) {
    if (!prop || !prop.aff) return;
    const c = await channelOf(prop.aff);
    if (!c) return;
    if (!!prop.channel !== c.channel || !!prop.chActs !== c.acts) {
      Object.assign(prop, { channel: c.channel, chActs: c.acts });
      await setJSON("site:" + prop.siteId, prop);
    }
  }
  // Avante's commission on the property's own bookings, as the property sees it (commission.js).
  const OWN_COMMISSION = globalThis.AvanteCommission.OWN;

  // Who gets the hub's emails about the property (Jean, 2026-10-14): its own
  // email (settings.email), its contact person for bookings and queries
  // (settings.contactEmail), or both (settings.notifyWho). Every field may
  // hold several addresses separated by commas.
  const NOTIFY_WHO = ["owner", "contact", "both"];
  function propertyTo(prop) { const s = (prop && prop.settings) || {}; return recipients(s.email, s.contactEmail, s.notifyWho || "both").join(", "); }
  // Saves the contact fields both kinds of property share; throws on a bad address.
  function saveContactFields(s, body) {
    const em = (k, label) => { if (body[k] === undefined) return; const v = cleanStr(body[k], 600); if (badEmails(v).length) throw new PAError(label + ": \"" + badEmails(v)[0] + "\" doesn't look like an email address. Separate several with a comma."); s[k] = listOf(v).join(", "); };
    em("email", "Email"); em("contactEmail", "Contact email");
    if (body.phone !== undefined) s.phone = cleanStr(body.phone, 120);
    if (body.contactName !== undefined) s.contactName = cleanStr(body.contactName, 120);
    if (body.contactPhone !== undefined) s.contactPhone = cleanStr(body.contactPhone, 120);
    if (body.notifyWho !== undefined) s.notifyWho = NOTIFY_WHO.includes(body.notifyWho) ? body.notifyWho : "both";
  }

  async function disconnect(token) {
    const prop = await auth(token);
    await store.delete("sess:" + cleanStr(token, 120));
    await store.delete("feed:" + prop.feedToken);
    await store.delete("site:" + prop.siteId);
    await store.delete("tok:" + prop.siteId);
    if (prop.aff) {
      const link = await getJSON("aff:" + prop.aff);
      // Another property may share this affiliate number: the next lookup scans again (propertyOfAff).
      if (link && link.siteId === prop.siteId) { await store.delete("aff:" + prop.aff); await store.delete(AFF_LINKS_DONE); }
    }
    return { ok: true };
  }

  // The property connected under an affiliate number. Every connect records an
  // "aff:<number>" link (and a session open repairs a missing one), so the link
  // is the answer. Properties connected before links were recorded are found
  // by one scan of every property, which records all their links and then
  // AFF_LINKS_DONE, so an affiliate with no property is answered at once
  // instead of by reading every property each time the hub opens.
  async function propertyOfAff(aff) {
    aff = cleanStr(aff, 40);
    if (!aff) return null;
    const link = await getJSON("aff:" + aff);
    if (link) { const p = await getJSON("site:" + link.siteId); if (p) return p; await store.delete("aff:" + aff); }
    if (await getJSON(AFF_LINKS_DONE)) return null;
    const found = await backfillAffLinks();
    return found.get(aff) || null;
  }
  // Links every connected property to its affiliate number (the first property
  // in list order wins, as the old one-by-one scan did); returns aff -> property.
  async function backfillAffLinks() {
    const found = new Map();
    for (const { value: p } of await readAllEntries(store, { prefix: "site:", strict: true })) {
      if (p && p.aff && !found.has(p.aff)) found.set(p.aff, p);
    }
    for (const [aff, p] of found) {
      const link = await getJSON("aff:" + aff);
      if (!link || !(await getJSON("site:" + link.siteId))) await setJSON("aff:" + aff, { siteId: p.siteId });
    }
    await setJSON(AFF_LINKS_DONE, { at: now().toISOString(), linked: found.size });
    return found;
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
    // At most 10 wrong passwords per affiliate per hour.
    const fk = "resumefail:" + aff + ":" + now().toISOString().slice(0, 13), fails = (await getJSON(fk)) || 0;
    if (fails >= 10) throw new PAError("Too many wrong passwords. Try again in an hour.", 429);
    const rec = affiliates ? await affiliates.getAuth(aff) : null;
    const stored = rec && rec.passwordHash ? rec.passwordHash : await sha256Hex(DEFAULT_AFFILIATE_PASSWORD);
    if ((await sha256Hex(String(password || ""))) !== stored) { await setJSON(fk, fails + 1); throw new PAError("Incorrect hub password.", 403); }
    await syncChannelFlag(p);
    return { token: await newSession(p), property: publicProperty(p) };
  }

  function publicProperty(p) {
    const settings = p.channel ? Object.assign({}, p.settings || {}, { payMode: "gateway", approveGuests: false, minStay: 1, calendarStart: { mode: "today", date: "" } }) : p.settings;
    return { siteId: p.siteId, site: p.site, resortId: p.resortId, resortName: p.resortName, units: p.units, settings, connectedAt: p.createdAt, demoAllowed: ["3"].includes(String(p.site)), firstBookable: firstBookable(p),
      channel: !!p.channel, commissionPct: OWN_COMMISSION,
      activities: !p.channel || !!p.chActs };
  }

  // Calendar start (property setup): "today", or a set date that is also the
  // first date guests can book from, until it has passed.
  function firstBookable(prop) {
    if (prop && prop.channel) return today();   // its channel manager's rules apply, through Stock Network
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
    const [creds, cached] = await Promise.all([decryptJSON(prop.credsEnc, encKey), getJSON("tok:" + prop.siteId).catch(() => null)]);
    const c = clientFactory(creds);
    try { if (cached && cached.enc && cached.until > now().getTime() + 60000) c.tok = await decryptJSON(cached.enc, encKey); } catch (_) {}
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
    const [snap, bks] = await Promise.all([loadSnap(prop), bookingsOf(prop)]);
    const ours = activeNightsByUnit(bks);
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
  // cached: answer straight from what was saved last time (no Stock Network call), so the
  // grid shows at once; the screen then asks again without cached to refresh from SN.
  // Reads that only need the site id, started before the login check finishes (see pa-api "open").
  function prefetch(siteId) { const p = { siteId }; return { siteId, snap: loadSnap(p), bookings: bookingsOf(p), events: getJSON("chan:" + siteId) }; }
  async function availability(prop, from, to, { cached = false, timing = null, pre = null } = {}) {
    from = from || today(); to = to || addDays(from, 14);
    if (!isoDate(from) || !isoDate(to) || !(nightsBetween(from, to) >= 1 && nightsBetween(from, to) <= MAX_WINDOW_DAYS)) throw new PAError("Choose a shorter date range.");
    const mark = (k) => { if (timing) timing[k] = Date.now() - timing._t0; };
    // Only the days on screen are read from SN (past days never are).
    const usePre = pre && pre.siteId === prop.siteId;
    const snapP = cached || !(to > today()) ? (usePre ? pre.snap : loadSnap(prop)) : ensureWindow(prop, from < today() ? today() : from, to);
    const [snap, bookings, events0] = await Promise.all([snapP, usePre ? pre.bookings : bookingsOf(prop), usePre ? pre.events : getJSON("chan:" + prop.siteId)]);
    mark(cached ? "savedGrid" : "stockNetwork");
    const ours = activeNightsByUnit(bookings);
    const events = events0 || {};
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
    const fresh = windowFresh(snap, from < today() ? today() : from, to > today() ? to : addDays(today(), 1), WINDOW_MAX_AGE_MS);
    return { from, to, cached: !!cached, fresh, firstBookable: firstBookable(prop), snapshotAt: snap.at, units: prop.units.map((u) => ({ name: u.name, size: u.size, rateFrom: snap.rates[u.name] || null })), nights, nightRates, minStay: prop.settings.minStay || 2 };
  }

  async function search(prop, checkIn, checkOut) {
    if (!isoDate(checkIn) || !isoDate(checkOut) || checkOut <= checkIn) throw new PAError("Choose a check-out after the check-in.");
    checkBookable(prop, checkIn);
    if (!(nightsBetween(checkIn, checkOut) <= MAX_WINDOW_DAYS - 2)) throw new PAError("Choose a shorter stay.");
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
    return { checkIn, checkOut, nights: want.length, results, minStay: minStayOf(prop) };
  }

  // ---------- bookings ----------
  async function saveBookings(prop, list) { await setJSON("book:" + prop.siteId, list); }

  async function createOnSN(prop, client, items, guest, { reference, notes, amountFor, requestAndPay = false } = {}) {
    const snItems = [];
    for (const it of items) {
      if (!prop.units.find((u) => u.name === it.unit)) throw new PAError("Unknown unit " + it.unit + ".");
      if (!(it.start < it.end)) throw new PAError("Check-out must be after check-in for " + it.unit + ".");
      const stock = await client.exactStock(prop.resortId, it.unit, it.start, it.end);
      if (!stock) throw new PAError(it.unit + " is not open for " + it.start + " to " + it.end + ".", 409, { unavailable: it });
      snItems.push(client.buildItem(stock, { adults: it.adults || 2, children: it.children || 0, amount: amountFor ? amountFor(it, stock) : undefined }));
    }
    try {
      return await client.createReservation({ items: snItems, guest, reference, notes, requestAndPay });
    } catch (e) {
      if (e instanceof SNError) throw new PAError(e.message + " If the nights now show as booked, Avante's booking system may still have taken them: check the Avante back office.", 502, { sn: e.body });
      throw e;
    }
  }

  // Status rules (Jean, 2026-10-12): channel bookings and bookings paid by EFT / on arrival
  // go to Booked right away (no Stock Network auto-cancel); bookings paid by a payment gateway
  // are made as "request and pay" (Booked, Stock Network cancels them if unpaid in its time);
  // front store bookings wait as Request when the property approves each new guest.
  // Paid comes from the gateway, or from the payment the property records in the hub.
  // Confirmed is never set by the hub.
  async function holdBooked(client, res, note) {
    try { const d = await client.setStatus(res.reservationId, "Booked", note || "Booked by the Avante hub"); return d.reservationStatus || "Booked"; }
    catch (e) { return null; }
  }

  function validGuest(g) {
    const guest = { first: cleanStr(g && g.first, 80), last: cleanStr(g && g.last, 80), email: cleanStr(g && g.email, 120), cellphone: cleanStr(g && g.cellphone, 30) };
    if (!guest.cellphone) throw new PAError("A cellphone number is required for the booking.");
    if (!guest.first && !guest.last) throw new PAError("Enter the guest's name.");
    guest.fullName = (guest.first + " " + guest.last).trim();
    return guest;
  }

  // ---------- payments ----------
  function payMode(prop) { if (prop && prop.channel) return "gateway"; const m = prop.settings && prop.settings.payMode; return PAY_MODES.includes(m) ? m : "both"; }
  async function bankOf(prop) { if (!prop.bankEnc) return null; try { return await decryptJSON(prop.bankEnc, encKey); } catch (_) { return null; } }
  function isPaid(b) { return !!(b && (b.paidEft || (Number(b.amountPaid) || 0) > 0 || /paid/i.test(String(b.snStatus || "")))); }
  function payState(b) {
    if (!b || b.origin === "channel") return "channel";
    if (b.paidEft) return "paid-eft";
    if (/paid/i.test(String(b.snStatus || "")) || ((Number(b.amountPaid) || 0) >= (Number(b.total) || 0) && (Number(b.amountPaid) || 0) > 0)) return "paid";
    if ((Number(b.amountPaid) || 0) > 0) return "part-paid";
    return "unpaid";
  }
  // Paid or Confirmed on Stock Network (Jean, 2026-10-19): can't be changed or
  // cancelled in the hub; a cancellation is escalated to Avante admin.
  function isLocked(b) { return isPaid(b) || /confirm/i.test(String((b && b.snStatus) || "")); }
  function decorate(b) { return Object.assign({}, b, { payState: payState(b), locked: isLocked(b), contact: contactOf(b) }); }

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

  // The property received the money (EFT, cash or card on arrival): record it on Stock Network,
  // which sets the booking to Paid when the balance is covered.
  async function markPaidEft(prop, ref, type = "EFT") {
    const { list, b } = await findBooking(prop, ref);
    notDemo(b);
    if (b.origin === "channel") throw new PAError("Channel bookings are paid on the channel.");
    if (payMode(prop) === "gateway") throw new PAError("Payments are by payment gateway only for this property: the gateway sets Paid.");
    if (b.status === "Cancelled") throw new PAError(b.ref + " is cancelled.");
    if (b.approval && b.approval.state === "pending") throw new PAError("Accept " + b.ref + " first.");
    const kind = ["EFT", "Cash", "Card"].includes(type) ? type : "EFT";
    const client = await clientFor(prop);
    await refreshPayment(client, b);
    const due = Math.max(0, Math.round(((Number(b.total) || 0) - (Number(b.amountPaid) || 0)) * 100) / 100);
    if (due > 0 && b.reservationId) {
      const d = await client.addPayment(b.reservationId, { type: kind, amount: due, reference: b.ref, note: kind + " received by the property (Avante hub)" });
      b.amountPaid = Number(d.amountPaid) || (Number(b.amountPaid) || 0) + due;
      b.snStatus = d.reservationStatus || b.snStatus;
      // If Stock Network doesn't move a fully paid booking to Paid by itself, set it.
      if (!/paid/i.test(String(b.snStatus)) && b.amountPaid >= (Number(b.total) || 0)) { try { const s2 = await client.setStatus(b.reservationId, "Paid", kind + " received (Avante hub)"); b.snStatus = s2.reservationStatus || "Paid"; } catch (_) {} }
      if (b.status !== "Cancelled") b.status = b.snStatus;
    }
    b.paidEft = { at: now().toISOString(), type: kind, amount: due };
    if (!b.paidAt && /paid/i.test(String(b.snStatus || "")) ) b.paidAt = now().toISOString();
    await saveBookings(prop, list);
    return { booking: decorate(b) };
  }

  // Front store requests waiting for the property: Accept → Booked, Decline → cancelled.
  async function decide(prop, ref, accept, reason) {
    const { list, b } = await findBooking(prop, ref);
    notDemo(b);
    if (!(b.approval && b.approval.state === "pending")) throw new PAError(b.ref + " isn't waiting for your approval.");
    const client = await clientFor(prop);
    await refreshPayment(client, b);
    if (b.status === "Cancelled") { b.approval.state = "expired"; await saveBookings(prop, list); throw new PAError(b.ref + " was already cancelled (its request time ran out).", 409); }
    const g = b.guest || {}, units = b.items.filter((i) => !i.cancelled).map((i) => i.unit + " " + i.start + " to " + i.end).join(", ");
    const fs = fsSettings(prop), replyTo = listOf(fs.email).length ? fs.email : propertyTo(prop);
    if (accept) {
      const d = await client.setStatus(b.reservationId, "Booked", "Accepted by the property (Avante hub)");
      b.status = b.snStatus = d.reservationStatus || "Booked";
      b.approval = { state: "accepted", at: now().toISOString() };
      await saveBookings(prop, list);
      const pay = await payInfoFor(prop, b);
      if (g.email && pay && !pay.noMethod) await sendEmail(g.email, "Your booking " + b.ref + " at " + (prop.resortName || "") + " is accepted",
        "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px\"><p>Hi " + esc(g.first || "") + ",</p><p>Good news: <b>" + esc(prop.resortName || "") + "</b> accepted your booking <b>" + esc(b.ref) + "</b> (" + esc(units) + ").</p><p style=\"white-space:pre-line\">" + esc(pay.message.split("\n").slice(3).join("\n")) + "</p></div>",
        { fromName: prop.resortName || "", replyTo }).catch(() => false);
      return { booking: decorate(b), pay };
    }
    await client.cancelReservation(b.reservationId);
    b.status = "Cancelled"; b.cancelledAt = now().toISOString(); b.approval = { state: "declined", at: now().toISOString() };
    await saveBookings(prop, list);
    await invalidate(prop, b.items);
    if (g.email) await sendEmail(g.email, "Your booking request at " + (prop.resortName || ""),
      "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px\"><p>Hi " + esc(g.first || "") + ",</p><p>Thank you for your interest in <b>" + esc(prop.resortName || "") + "</b>. Unfortunately we can't accept your booking request " + esc(b.ref) + " (" + esc(units) + ")." + (cleanStr(reason, 300) ? " " + esc(cleanStr(reason, 300)) : "") + "</p><p>You have not been charged.</p></div>",
      { fromName: prop.resortName || "", replyTo }).catch(() => false);
    return { booking: decorate(b) };
  }

  // Every 15 minutes and when Bookings opens: one "changed since" call to Stock Network
  // picks up Paid (gateway), cancellations and status changes made in the back office.
  async function refreshStatuses(prop, { client, minGapMs = 60000 } = {}) {
    const key = "stchk:" + prop.siteId;
    const last = (await getJSON(key)) || null;
    const t = now();
    if (last && t.getTime() - Date.parse(last.at) < minGapMs) return { skipped: true };
    const since = last ? new Date(Date.parse(last.at) - 5 * 60000).toISOString() : new Date(t.getTime() - 30 * 864e5).toISOString();
    const c = client || (await clientFor(prop));
    const changed = await c.listReservations({ modifiedSince: since });
    await setJSON(key, { at: t.toISOString() });
    if (!changed.length) return { changed: 0 };
    const list = await bookingsOf(prop);
    const byId = new Map(list.filter((b) => b.reservationId).map((b) => [b.reservationId, b]));
    let n = 0, added = 0;
    for (const r of changed) {
      let b = byId.get(r.reservationId);
      if (!b && prop.channel) {
        // Channel property: a booking from one of its hook / booking links is
        // made by the holiday builder under the property's own Site ID, so it
        // is a hub booking too and shows in its Bookings (Jean, 2026-10-13).
        const rec = linkBookingFrom(prop, r, t);
        if (rec) { list.push(rec); byId.set(rec.reservationId, rec); added++; }
        else await noteUnmatched(prop, r);
        continue;
      }
      if (!b) continue; // made directly in Stock Network: shows as taken nights in the calendar
      const st = String(r.reservationStatus || "");
      b.snStatus = st || b.snStatus;
      b.amountPaid = Number(r.amountPaid) || 0;
      if (/cancel/i.test(st)) { if (b.status !== "Cancelled") { b.status = "Cancelled"; b.cancelledAt = t.toISOString(); b.cancelledOn = "sn"; if (b.approval && b.approval.state === "pending") b.approval.state = "expired"; } }
      else if (b.status !== "Cancelled") b.status = st || b.status;
      if (/paid/i.test(st) && !b.paidAt) b.paidAt = t.toISOString(); // the hub takes over from Paid
      b.checkedAt = t.toISOString();
      n++;
    }
    if (n || added) await saveBookings(prop, list);
    return { changed: n, added };
  }

  // Which Stock Network site made a booking. Stock Network's booking list
  // isn't documented for this, so the likely field names are all tried; the
  // first bookings that don't match are kept (field names only, no guest
  // details) so the real field can be confirmed on the first live booking.
  const SITE_FIELDS = ["siteID", "siteId", "agentSiteID", "agentSiteId", "callerSiteID", "callerSiteId", "bookingSiteID", "bookingSiteId", "createdBySiteID", "createdBySiteId"];
  function madeBySite(r) {
    for (const f of SITE_FIELDS) if (r && r[f]) return String(r[f]).toLowerCase();
    if (r && r.callerDetails && r.callerDetails.siteID) return String(r.callerDetails.siteID).toLowerCase();
    return "";
  }
  function linkBookingFrom(prop, r, t) {
    const by = madeBySite(r);
    const tagged = /avante hub booking/i.test(String(r.notes || "") + " " + String(r.customerReferenceNo || ""));
    if (!(by && by === String(prop.siteId).toLowerCase()) && !tagged) return null;
    const day = (v) => (v ? String(v).slice(0, 10) : "");
    const its = Array.isArray(r.items) ? r.items : Array.isArray(r.details) ? r.details : [];
    const items = its.length ? its.map((x) => ({ unit: x.unitName || x.unit || "", start: day(x.checkInDate || x.start), end: day(x.checkOutDate || x.end), detailId: x.id || null }))
      : [{ unit: r.unitName || "", start: day(r.checkInDate || r.fromDate), end: day(r.checkOutDate || r.toDate), detailId: null }];
    const name = String(r.fullName || r.customerName || "").trim(), sp = name.indexOf(" ");
    const st = String(r.reservationStatus || "Booked");
    return { ref: "J" + (r.reservationRefNo || r.refNo || String(r.reservationId).slice(0, 8)), reservationId: r.reservationId, status: /cancel/i.test(st) ? "Cancelled" : st,
      origin: "link", source: "Hook / booking link", payBy: "gateway",
      guest: { first: sp > 0 ? name.slice(0, sp) : name, last: sp > 0 ? name.slice(sp + 1) : "", email: r.emailAddress || "", cellphone: r.cellphone || "" },
      items, total: Number(r.totalAmountIncl || r.amountIncl) || 0, amountPaid: Number(r.amountPaid) || 0, snStatus: st,
      paidAt: /paid/i.test(st) ? t.toISOString() : undefined, createdAt: t.toISOString(), checkedAt: t.toISOString() };
  }
  async function noteUnmatched(prop, r) {
    const k = "snkeys:" + prop.siteId, have = (await getJSON(k)) || [];
    if (have.length >= 5) return;
    have.push({ at: now().toISOString(), keys: Object.keys(r || {}).slice(0, 60), madeBy: madeBySite(r) || null });
    await setJSON(k, have);
  }

  const PAID_LOCK_MSG = "This booking is Paid or Confirmed, so it can't be changed or cancelled in the hub. The guest must contact the property. To cancel it, tap Ask Avante to cancel.";

  async function book(prop, body, { approval = false } = {}) {
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 10).map((it) => ({ unit: cleanStr(it.unit, 60), start: cleanStr(it.start, 10), end: cleanStr(it.end, 10), adults: Math.max(1, Math.min(20, Number(it.adults) || Number(body.adults) || 2)), children: Math.max(0, Math.min(20, Number(it.children) || Number(body.children) || 0)) }));
    if (!items.length) throw new PAError("Choose at least one unit.");
    for (const it of items) checkBookable(prop, it.start);
    const guest = validGuest(body.guest);
    const source = cleanStr(body.source, 40) || "Direct";
    const channelRef = cleanStr(body.channelRef, 60);
    const client = await clientFor(prop);
    const mode = payMode(prop);
    const payBy = mode === "gateway" ? "gateway" : mode === "eft" ? "eft" : (body.payBy === "gateway" ? "gateway" : "eft");
    const waitForApproval = !!approval;
    const res = await createOnSN(prop, client, items, guest, { reference: channelRef, requestAndPay: !waitForApproval && payBy === "gateway",
      // "Avante Hub booking" first, so the property sees in its channel
      // manager (e.g. NightsBridge) that this booking came from the hub (Jean, 2026-10-13).
      notes: ["Avante Hub booking", source !== "Direct" ? "Booked through " + source : "", cleanStr(body.notes, 800)].filter(Boolean).join(" · ") });
    let status = res.status || "Request", statusError = null;
    if (!waitForApproval && payBy === "gateway") status = "Booked";
    if (!waitForApproval && payBy === "eft") { const st = await holdBooked(client, res, "Booked by the Avante hub (pays by EFT or on arrival)"); if (st) status = st; else statusError = "Avante's booking system didn't accept Booked: it is still a Request, so it can be cancelled after a set number of days. Set it to Booked in Avante's booking system."; }
    const rec = { ref: "J" + res.refNo, reservationId: res.reservationId, status, origin: "hub", source, channelRef, payBy, statusError: statusError || undefined,
      approval: waitForApproval ? { state: "pending", at: now().toISOString() } : undefined,
      guest: { first: guest.first, last: guest.last, email: guest.email, cellphone: guest.cellphone },
      items: items.map((it) => { const d = res.details.find((x) => x.unit === it.unit && x.start === it.start); return { unit: it.unit, start: it.start, end: it.end, detailId: d ? d.detailId : null }; }),
      total: res.total, paymentUrl: res.paymentUrl || null, infoUrl: res.infoUrl || null, amountPaid: res.amountPaid || 0, snStatus: status, createdAt: now().toISOString() };
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
    if (isLocked(b)) return escalateCancellation(prop, list, b);
    await client.cancelReservation(b.reservationId);
    b.status = "Cancelled"; b.cancelledAt = now().toISOString();
    await saveBookings(prop, list);
    await invalidate(prop, b.items);
    return { booking: decorate(b) };
  }

  // ---------- Paid or Confirmed: the cancellation goes to Avante admin (Jean, 2026-10-19) ----------
  // Nothing is cancelled in the hub. Admin gets an email to escalate, cancels it
  // on Stock Network, and the hub picks up the new status.
  async function escalateCancellation(prop, list, b) {
    const to = await adminEmail().catch(() => "");
    const units = b.items.filter((i) => !i.cancelled).map((i) => i.unit + " " + i.start + " to " + i.end).join(", ");
    const guest = (((b.guest && b.guest.first) || "") + " " + ((b.guest && b.guest.last) || "")).trim() || (contactOf(b).name || "");
    const emailed = to ? await sendEmail(to, "ESCALATE: " + (prop.resortName || "A property") + " asks to cancel " + (b.snStatus || b.status) + " booking " + b.ref,
      "<p><b>" + esc(prop.resortName || "A property") + "</b> (Site Nr " + esc(prop.site || "") + (prop.channel ? ", channel property" : "") + ") asks Avante to cancel booking <b>" + esc(b.ref) + "</b>.</p>" +
      "<p>Status: <b>" + esc(b.snStatus || b.status) + "</b><br>" + esc(units) + "<br>Guest: " + esc(guest) + "<br>Total: R" + esc(Math.round(Number(b.total) || 0)) +
      "<br>Paid: R" + esc(Math.round(Number(b.amountPaid) || 0)) + (b.paidEft ? " (EFT)" : "") + (b.source ? "<br>Booked through: " + esc(b.source) : "") + "</p>" +
      "<p>It can't be cancelled from the hub because it is Paid or Confirmed. Cancel it on Stock Network and handle any refund; the hub then shows it as Cancelled.</p>").catch(() => false) : false;
    if (!emailed) throw new PAError("Your request couldn't be sent to Avante. Try again, or email info@avantehospitality.co.za.", 502);
    b.cancelRequest = { at: now().toISOString(), to: "admin" };
    await saveBookings(prop, list);
    return { escalated: true, booking: decorate(b) };
  }


  async function cancelUnit(prop, ref, unit) {
    const { list, b } = await findBooking(prop, ref);
    notDemo(b);
    const live = b.items.filter((it) => !it.cancelled);
    const it = live.find((x) => x.unit === cleanStr(unit, 60));
    if (!it) throw new PAError(unit + " is not on " + ref + ".");
    if (live.length === 1) return cancel(prop, ref);
    if (!it.detailId) throw new PAError("Avante's booking system did not return a detail ID for " + unit + ", so it can't be removed on its own. Cancel and book again.");
    const client = await clientFor(prop);
    if (await refreshPayment(client, b)) await saveBookings(prop, list);
    if (isLocked(b)) throw new PAError(PAID_LOCK_MSG, 423);
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
    if (b.status === "Cancelled") throw new PAError(b.ref + " has been cancelled.", 409);
    if (isLocked(b)) throw new PAError(PAID_LOCK_MSG, 423);
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
        throw new PAError("The change failed: " + e.message + (restored ? " The original stay was booked again as J" + restored.refNo + "." : " The original booking was cancelled and could NOT be restored. Check Avante's booking system now."), 409);
      }
    } else {
      res = await createOnSN(prop, client, [next], guest, { reference: b.channelRef, notes });
      await client.cancelReservation(b.reservationId);
    }
    // The new booking keeps the old one's place: Booked stays Booked (a Request waiting for approval stays a Request).
    let newStatus = res.status || "Request";
    if (!(b.approval && b.approval.state === "pending")) newStatus = (await holdBooked(client, res, "Moved from " + b.ref + " in the Avante hub")) || newStatus;
    b.status = "Cancelled"; b.cancelledAt = now().toISOString(); b.replacedBy = "J" + res.refNo;
    const rec = Object.assign({}, b, { ref: "J" + res.refNo, reservationId: res.reservationId, status: newStatus, replaces: b.ref, cancelledAt: undefined, replacedBy: undefined,
      paymentUrl: res.paymentUrl || null, infoUrl: res.infoUrl || null, amountPaid: res.amountPaid || 0, snStatus: newStatus, checkedAt: undefined, cancelRequest: undefined,
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
      try { const r = await refreshStatuses(prop); if (r.changed || r.added) return find(prop, q, { refresh: false }); } catch (_) {}
    }
    return { payMode: payMode(prop), bookings: list.map(decorate).filter((b) => !s || [b.ref, b.guest && b.guest.first, b.guest && b.guest.last, b.source, b.channel, b.channelRef].concat(b.items.map((i) => i.unit)).join(" ").toLowerCase().includes(s)).slice(-100).reverse() };
  }

  // ---------- settings & channels ----------
  async function saveSettings(prop, body) {
    if (prop.channel) {
      // Only the contact details: everything else comes from its channel manager.
      const s0 = prop.settings || {};
      saveContactFields(s0, body);
      prop.settings = s0;
      await setJSON("site:" + prop.siteId, prop);
      return { ok: true, settings: { email: s0.email || "", phone: s0.phone || "", contactName: s0.contactName || "", contactPhone: s0.contactPhone || "", contactEmail: s0.contactEmail || "", notifyWho: s0.notifyWho || "both" } };
    }
    const s = prop.settings || {};
    saveContactFields(s, body);
    if (body.minStay !== undefined) s.minStay = Math.max(1, Math.min(30, Number(body.minStay) || 1));
    if (body.autoBook !== undefined) s.autoBook = !!body.autoBook;
    if (body.calendarStart && typeof body.calendarStart === "object") {
      const mode = body.calendarStart.mode === "date" ? "date" : "today";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.calendarStart.date || "")) ? String(body.calendarStart.date) : "";
      if (mode === "date" && !date) throw new PAError("Choose the date the calendar opens on.");
      s.calendarStart = { mode, date: mode === "date" ? date : "" };
    }
    if (body.payMode !== undefined) s.payMode = PAY_MODES.includes(body.payMode) ? body.payMode : "both";
    // The owner has saved Reservation settings and Guest payments (one Save in
    // Channels) at least once (Admin > Set up shows "The owner's part" done, Jean 2026-10-25).
    if (body.calendarStart !== undefined && !s.setupBookings) s.setupBookings = now().toISOString();
    if (body.approveGuests !== undefined) s.approveGuests = !!body.approveGuests;
    if (body.bank && typeof body.bank === "object") {
      const bk = { bankName: cleanStr(body.bank.bankName, 60), accountHolder: cleanStr(body.bank.accountHolder, 100), accountNumber: cleanStr(body.bank.accountNumber, 30).replace(/[^0-9 -]/g, ""), branchCode: cleanStr(body.bank.branchCode, 20), accountType: cleanStr(body.bank.accountType, 30), note: cleanStr(body.bank.note, 200) };
      if (bk.accountNumber && (!bk.bankName || !bk.accountHolder)) throw new PAError("Enter the bank name and account holder with the account number.");
      prop.bankEnc = bk.accountNumber ? await encryptJSON(bk, encKey) : null;
    }
    if (body.prices && typeof body.prices === "object") { s.prices = {}; for (const u of prop.units) { const v = Number(body.prices[u.name]); if (v > 0) s.prices[u.name] = Math.round(v); } }
    if (body.weekendPrices && typeof body.weekendPrices === "object") { s.weekendPrices = {}; for (const u of prop.units) { const v = Number(body.weekendPrices[u.name]); if (v > 0) s.weekendPrices[u.name] = Math.round(v); } }
    if (body.weekendRates !== undefined) s.weekendRates = !!body.weekendRates;
    if (body.weekendDays !== undefined) {
      const wd = dayList(body.weekendDays);
      if (s.weekendRates && !daysInARow(wd)) throw new PAError("Weekend nights must follow each other, e.g. Fri + Sat, or Thu + Fri + Sat.");
      s.weekendDays = wd.length ? wd : [4, 5];
    }
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
    const help = await channelHelpConfig();
    return { settings, firstBookable: firstBookable(prop), bank: await bankOf(prop), units, affiliateLinked: !!prop.aff, unitNotices: prop.unitNotices || [], linkedUnits: linked,
      inviteEmail: help.inviteEmail, channelHelp: prop.channelHelp || null };
  }

  // ---------- "Let Avante set up my channels" (2026-10-13, Jean) ----------
  // The property invites Avante on each channel (Airbnb co-host, Booking.com extranet user,
  // LekkeSlaap user), then taps one button; the hub emails the people set in admin.
  function emailList(v) { return String(v || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => validEmail(e)).slice(0, 10); }
  async function channelHelpConfig() {
    const c = (await getJSON(CHANNEL_HELP_KEY).catch(() => null)) || {};
    const invite = emailList(c.inviteEmail)[0] || CHANNEL_HELP_DEFAULT;
    const notify = emailList(c.notifyEmails);
    return { inviteEmail: invite, notifyEmails: notify.length ? notify : [CHANNEL_HELP_DEFAULT] };
  }
  async function requestChannelHelp(prop, body) {
    body = body || {};
    const chans = (Array.isArray(body.channels) ? body.channels : []).filter((k) => CHANNELS[k]);
    if (!chans.length) throw new PAError("Tick the channels where you invited Avante.");
    const last = prop.channelHelp && Date.parse(prop.channelHelp.at);
    if (last && now().getTime() - last < 5 * 60000) throw new PAError("Avante already has your request. Give us a moment before sending it again.", 429);
    const cfg = await channelHelpConfig();
    const st = prop.settings || {}, fs = prop.frontStore || {};
    const note = cleanStr(body.note, 600);
    const contact = [st.email || fs.email, st.phone || fs.phone || fs.whatsapp].filter(Boolean).join(" · ");
    const html = "<p><b>" + esc(prop.resortName || "A property") + "</b> (Stock Network site " + esc(prop.site) + ") invited Avante to set up its channel calendars.</p>" +
      "<p><b>Invited on:</b> " + esc(chans.map((k) => CHANNELS[k]).join(", ")) + "<br><b>Invite sent to:</b> " + esc(cfg.inviteEmail) +
      "<br><b>Units:</b> " + esc(prop.units.map((u) => u.name).join(", ")) + (contact ? "<br><b>Property contact:</b> " + esc(contact) : "") + (prop.aff ? "<br><b>Hub affiliate:</b> " + esc(prop.aff) : "") + "</p>" +
      (note ? "<p><b>Note from the property:</b><br>" + esc(note) + "</p>" : "") +
      "<p>To do: accept the invites, then for every unit and channel copy the channel's calendar link into the hub (Property Affiliate → Channels → Channel links per unit) and paste the hub's Avante link into the channel's calendar import.</p>";
    let sent = 0;
    for (const to of cfg.notifyEmails) if (await sendEmail(to, "Set up channels: " + (prop.resortName || "property") + " (" + chans.map((k) => CHANNELS[k]).join(", ") + ")", html, { replyTo: validEmail(st.email || fs.email) ? (st.email || fs.email) : undefined }).catch(() => false)) sent++;
    if (!sent) throw new PAError("The request couldn't be emailed to Avante. Please try again in a minute.", 502);
    prop.channelHelp = { at: now().toISOString(), channels: chans, note };
    await setJSON("site:" + prop.siteId, prop);
    return channelsView(prop);
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
    try {
      const res = await createOnSN(prop, client, [{ unit: ev.unit, start: ev.start, end: ev.end }], { fullName: label, email: listOf(s.email)[0] || "", cellphone: s.phone }, {
        reference: String(ev.uid).slice(0, 50), notes: label + " booking imported by the Avante hub" + (ev.summary ? " · " + ev.summary : ""),
        amountFor: (it, stock) => (s.prices && s.prices[ev.unit] ? eachNight(ev.start, ev.end).reduce((t, d) => t + nightPrice(s, ev.unit, d), 0) : stock.availability.rates.rate),
      });
      // No payment on Stock Network for channel bookings: Booked straight away, so SN's request rule can't cancel them.
      const st = await holdBooked(client, res, label + " booking (paid on the channel)");
      list.push({ ref: "J" + res.refNo, reservationId: res.reservationId, status: st || res.status || "Request", snStatus: st || res.status || "Request", statusError: st ? undefined : "Still a Request in Avante's booking system: set it to Booked there.", origin: "channel", channel: ev.channel, source: label, channelRef: ev.uid,
        guest: { first: label, last: "", email: listOf(s.email)[0] || "", cellphone: s.phone }, items: [{ unit: ev.unit, start: ev.start, end: ev.end, detailId: res.details[0] ? res.details[0].detailId : null }], total: res.total, createdAt: now().toISOString() });
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
    let snapR;
    try { snapR = await ensureWindow(prop, today(), addDays(today(), doFull ? HORIZON_DAYS : SYNC_NEAR_DAYS), { client, force: true }); }
    catch (e) {
      // SN refused the long read: keep syncing the near dates and try the full year next time.
      if (!doFull) throw e;
      snapR = await ensureWindow(prop, today(), addDays(today(), SYNC_NEAR_DAYS), { client, force: true });
      snapR.fullError = String(e.message || e).slice(0, 300);
    }
    if (doFull && !snapR.fullError) { snapR.fullAt = now().toISOString(); await setJSON("snap:" + prop.siteId, snapR); }
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
      if (!prop.channel) { try { const n = await remindMessages(prop); if (n) out[prop.site + " messages"] = n + " reminder(s) emailed"; } catch (_) {} }
      // One light "changed since" call per property with open hub bookings (Paid, cancellations).
      try {
        const open = (await bookingsOf(prop)).some((b) => !b.demo && b.reservationId && b.status !== "Cancelled" && !b.paidAt && b.items.some((i) => i.end >= today()));
        // A channel property is only checked when it opens Bookings (Jean, 2026-10-18).
        if (open && !prop.channel) { const r = await refreshStatuses(prop, { minGapMs: 10 * 60000 }); if (r.changed || r.added) out[prop.site + " statuses"] = (r.changed || 0) + " changed, " + (r.added || 0) + " new from links"; }
      } catch (e) { out[prop.site + " statuses"] = { error: e.message }; }
      // Properties without channels make no background calls to Stock Network
      // (a channel property never syncs channels: NightsBridge does that).
      if (prop.channel || !(await isLinked(prop))) { out[prop.site] = "not linked to a channel: skipped"; continue; }
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
    if (ev.status !== "booked") throw new PAError(ev.error || "Could not add it to Avante.", 409);
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
    const ok = await sendEmail(c.email, subject, emailHtml(prop, text), { fromName: prop.resortName || "", replyTo: propertyTo(prop) }).catch(() => false);
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
    return { list: msgList(prop), reviewsConnected: !!(reviews && reviews.baseUrl && reviews.secret), propertyEmail: propertyTo(prop),
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
    if (fresh.length && propertyTo(prop)) {
      const rows = fresh.map(({ b, msg }) => { const c = contactOf(b); return "<li><b>" + esc(msg.name) + "</b> to " + esc(c.name || "the guest") + " (" + esc(b.ref) + ")" + (waNumber(c.cell) ? "" : " — add their cellphone number first") + "</li>"; }).join("");
      await sendEmail(propertyTo(prop), "WhatsApp messages to send: " + (prop.resortName || "your property"),
        "<p>These guest messages are ready to send on WhatsApp:</p><ul>" + rows + "</ul><p>Open the Avante hub, Property Affiliate → Communication, and tap <b>WhatsApp</b> on each one. WhatsApp opens with the message ready.</p>").catch(() => false);
    }
    return fresh.length + emailed;
  }

  // ---------- property front store (go.avantetravel.co.za/stay/<slug>) ----------
  // One public page per connected property: photos, live availability, book
  // and pay on the page (a normal hub booking, source "Front store", credited
  // to the property), plus an in-house guest page (/stay/<slug>/guest) and a
  // printable room card with QR codes. prop.frontStore holds the settings;
  // "fslug:<slug>" -> { siteId } finds the property from the link.
  const FS_DEFAULTS = { on: false, slug: "", showPrices: true, showCalendar: true, showActivities: true, showOffers: true,
    hiddenUnits: [], minNoticeDays: 0, nearbyKm: 30, welcome: "", description: "", phone: "", whatsapp: "", email: "",
    wifiName: "", wifiPassword: "", guestNotes: "", photos: null, guestKey: "",
    // Front store builder (Jean, 2026-10-13): the big headline, a price badge,
    // short highlights, a rating badge, a photo/beds/line per unit, and a
    // photo per nearby activity (or hidden).
    headline: "", priceFrom: "", highlights: [], ratingValue: "", ratingCount: "", ratingLink: "", unitInfo: {}, actPhotos: {}, actPinned: [], actHidden: [],
    // Where to find things to do from, when not the property's own pin/tree place: { p, t, s }.
    actPlace: null,
    // Where each photo sits in its frame ("Move photo" in the builder): { url: "x% y%" }.
    photoPos: {} };
  const FS_MAX_NIGHTS = 30, FS_PER_DAY = 10, FS_PER_EMAIL_DAY = 3;
  function isoDate(v) { v = String(v || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return ""; const d = new Date(v + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0, 10) === v ? v : ""; }
  function minStayOf(prop) { return prop && prop.channel ? 1 : (prop.settings && prop.settings.minStay) || 2; }
  const FS_RESERVED = ["guest", "card", "api", "admin", "hub", "new", "edit"];
  function fsSettings(prop) {
    const s = Object.assign({}, FS_DEFAULTS, prop.frontStore || {});
    if (!s.slug) s.slug = slug(prop.resortName || "") || "property-" + String(prop.site || "").toLowerCase();
    if (s.slug.length < 3) s.slug = (s.slug + "-stay").slice(0, 60);
    return s;
  }
  function fsUrl(prop) { return baseUrl + "/stay/" + fsSettings(prop).slug; }
  async function slugOwner(sl) { const r = await getJSON("fslug:" + sl); return r ? r.siteId : null; }
  async function saveFrontStore(prop, body) {
    body = body || {};
    if (prop.channel) throw new PAError("Channel properties don't have a front store. Put your Promotions embed link (Affiliate Marketing) on your website.");
    const cur = fsSettings(prop), s = Object.assign({}, cur);
    const bool = (k) => { if (body[k] !== undefined) s[k] = !!body[k]; };
    ["on", "showPrices", "showCalendar", "showActivities", "showOffers"].forEach(bool);
    if (body.slug !== undefined) s.slug = slug(body.slug).slice(0, 60);
    // Always check the link name, also the automatic one, before claiming it.
    if (s.slug.length < 3) throw new PAError("The link name needs at least 3 letters or numbers.");
    if (FS_RESERVED.includes(s.slug)) throw new PAError("That link name is reserved. Choose another one.");
    const owner = await slugOwner(s.slug);
    if (owner && owner !== prop.siteId) throw new PAError("Another property already uses /stay/" + s.slug + ". Choose another link name.");
    // The guest page and room card need a secret key, so Wi-Fi and house info aren't public.
    if (!s.guestKey || body.newGuestKey) s.guestKey = randomToken(9).replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase() || "g" + Date.now().toString(36);
    const str = (k, n) => { if (body[k] !== undefined) s[k] = cleanStr(String(body[k] || ""), n); };
    str("headline", 80); str("priceFrom", 40); str("ratingValue", 4); str("ratingCount", 12); str("ratingLink", 400);
    if (s.ratingValue && !/^[0-5](\.\d)?$/.test(s.ratingValue)) throw new PAError("The rating should be a number from 0 to 5, e.g. 4.6.");
    if (s.ratingLink && !/^https:\/\//.test(s.ratingLink)) s.ratingLink = "";
    if (Array.isArray(body.highlights)) s.highlights = body.highlights.map((x) => cleanStr(String(x || ""), 40)).filter(Boolean).slice(0, 6);
    const okPhoto = (u) => /^https:\/\//.test(u) || /^\/api\/stay\?(photo|gphoto|libphoto)=/.test(u) || /^\/api\/property-file\?key=/.test(u);
    if (body.unitInfo && typeof body.unitInfo === "object") {
      s.unitInfo = {};
      for (const u of prop.units) { const x = body.unitInfo[u.name]; if (!x || typeof x !== "object") continue;
        const photo = cleanStr(String(x.photo || ""), 600), o = { photo: okPhoto(photo) ? photo : "", beds: cleanStr(String(x.beds || ""), 80), blurb: cleanStr(String(x.blurb || ""), 300) };
        if (o.photo || o.beds || o.blurb) s.unitInfo[u.name] = o; }
    }
    if (body.actPhotos && typeof body.actPhotos === "object") { s.actPhotos = {}; for (const [k, v] of Object.entries(body.actPhotos).slice(0, 60)) { const u = cleanStr(String(v || ""), 600); if (okPhoto(u)) s.actPhotos[cleanStr(k, 120)] = u; } }
    if (body.photoPos && typeof body.photoPos === "object") { s.photoPos = {}; for (const [k, v] of Object.entries(body.photoPos).slice(0, 150)) { const u = cleanStr(String(k || ""), 600), pos = String(v || ""); if (okPhoto(u) && /^\d{1,3}% \d{1,3}%$/.test(pos) && pos !== "50% 50%") s.photoPos[u] = pos; } }
    if (body.actPlace === null) s.actPlace = null;
    else if (body.actPlace && typeof body.actPlace === "object") { const t = cleanStr(String(body.actPlace.t || ""), 80); s.actPlace = t ? { p: cleanStr(String(body.actPlace.p || ""), 80), t, s: cleanStr(String(body.actPlace.s || ""), 80) } : null; }
    // Things to do the property keeps on its page (the rest come up at random), at most 10.
    if (Array.isArray(body.actPinned)) s.actPinned = [...new Set(body.actPinned.map((x) => cleanStr(String(x || ""), 120)).filter(Boolean))].slice(0, 10);
    if (Array.isArray(body.actHidden)) s.actHidden = body.actHidden.map((x) => cleanStr(String(x || ""), 120)).filter(Boolean).slice(0, 100);
    str("welcome", 160); str("description", 3000); str("phone", 30); str("whatsapp", 30); str("email", 600);
    str("wifiName", 60); str("wifiPassword", 60); str("guestNotes", 1500);
    if (s.email && badEmails(s.email).length) throw new PAError("\"" + badEmails(s.email)[0] + "\" doesn't look like an email address. Separate several with a comma.");
    if (body.nearbyKm !== undefined) s.nearbyKm = Math.max(1, Math.min(150, Math.round(Number(body.nearbyKm)) || 30));
    if (body.minNoticeDays !== undefined) s.minNoticeDays = Math.max(0, Math.min(30, Math.round(Number(body.minNoticeDays)) || 0));
    if (Array.isArray(body.hiddenUnits)) s.hiddenUnits = body.hiddenUnits.map((u) => cleanStr(String(u), 200)).filter((u) => prop.units.some((x) => x.name === u));
    if (body.photos === null) s.photos = null;
    else if (Array.isArray(body.photos)) s.photos = body.photos.map((u) => cleanStr(String(u), 600)).filter((u) => /^https:\/\//.test(u) || /^\/api\/stay\?photo=/.test(u)).slice(0, 24);
    if (s.on && s.hiddenUnits.length >= prop.units.length) throw new PAError("Show at least one unit on your front store.");
    // Claim the link name; free the old one.
    if (s.on || body.slug !== undefined) {
      await setJSON("fslug:" + s.slug, { siteId: prop.siteId });
      if ((await slugOwner(s.slug)) !== prop.siteId) throw new PAError("Another property just took /stay/" + s.slug + ". Choose another link name.");
    }
    if (cur.slug && cur.slug !== s.slug && (await slugOwner(cur.slug)) === prop.siteId) await store.delete("fslug:" + cur.slug);
    prop.frontStore = s;
    await setJSON("site:" + prop.siteId, prop);
    return frontStoreView(prop);
  }
  function monthKey(d) { return (d || now()).toISOString().slice(0, 7); }
  async function fsStat(prop, field) {
    const k = "fsstat:" + prop.siteId + ":" + monthKey();
    const r = (await getJSON(k)) || {};
    r[field] = (r[field] || 0) + 1;
    await setJSON(k, r);
  }
  async function frontStoreView(prop) {
    const s = fsSettings(prop), d = now();
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const stats = { thisMonth: (await getJSON("fsstat:" + prop.siteId + ":" + monthKey(d))) || {}, lastMonth: (await getJSON("fsstat:" + prop.siteId + ":" + monthKey(prev))) || {} };
    const photos = [];
    for (const b of (await store.list({ prefix: "fsphoto:" + prop.siteId + ":" })).blobs) if (!fsExtraKey(prop, b.key)) photos.push("/api/stay?photo=" + encodeURIComponent(b.key.slice(8)));
    const k = s.guestKey ? "/" + s.guestKey : "";
    return { settings: Object.assign({}, s, { guestKey: undefined }), url: baseUrl + "/stay/" + s.slug, guestUrl: baseUrl + "/stay/" + s.slug + "/guest" + k, cardUrl: baseUrl + "/stay/" + s.slug + "/card" + k,
      stats, units: prop.units.map((u) => ({ name: u.name, size: u.size, price: ((prop.settings || {}).prices || {})[u.name] || 0,
        weekendPrice: (prop.settings || {}).weekendRates ? (((prop.settings || {}).weekendPrices || {})[u.name] || 0) : 0 })), uploadedPhotos: photos,
      propertyEmail: (prop.settings && prop.settings.email) || "", propertyPhone: (prop.settings && prop.settings.phone) || "" };
  }
  // Own photos (JPG/PNG/WebP, max 4 MB), served by /api/stay?photo=<siteId>:<id>.
  // Photos for things to do (kind "act") are kept apart (":x-…"), so they
  // don't show up in the property's own photo gallery.
  function fsExtraKey(prop, key) { return String(key).slice(("fsphoto:" + prop.siteId + ":").length).startsWith("x-"); }
  async function uploadFrontPhoto(prop, dataUrl, kind) {
    const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
    if (!m) throw new PAError("Choose a JPG, PNG or WebP photo.");
    const bin = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
    if (bin.length > 4 * 1024 * 1024) throw new PAError("That photo is bigger than 4 MB.");
    const isJpg = bin[0] === 0xff && bin[1] === 0xd8, isPng = bin[0] === 0x89 && bin[1] === 0x50, isWebp = bin[8] === 0x57 && bin[9] === 0x45 && bin[10] === 0x42 && bin[11] === 0x50;
    if (!(isJpg || isPng || isWebp)) throw new PAError("Choose a JPG, PNG or WebP photo.");
    const extra = kind === "act", all = (await store.list({ prefix: "fsphoto:" + prop.siteId + ":" })).blobs;
    const count = all.filter((b) => fsExtraKey(prop, b.key) === extra).length;
    if (count >= (extra ? 60 : 24)) throw new PAError(extra ? "That's the most photos for things to do. Remove one first." : "You can upload up to 24 photos. Remove one first.");
    const id = prop.siteId + ":" + (extra ? "x-" : "") + randomToken(8).replace(/[^a-z0-9]/gi, "").slice(0, 10);
    await store.set("fsphoto:" + id, bin, { metadata: { type: m[1] } });
    return { url: "/api/stay?photo=" + encodeURIComponent(id), view: await frontStoreView(prop) };
  }
  async function removeFrontPhoto(prop, url) {
    const id = decodeURIComponent((/photo=([^&]+)/.exec(String(url || "")) || [])[1] || "");
    if (!id.startsWith(prop.siteId + ":")) throw new PAError("That photo isn't yours.");
    await store.delete("fsphoto:" + id);
    const s = fsSettings(prop);
    if (Array.isArray(s.photos)) { s.photos = s.photos.filter((u) => u !== url); prop.frontStore = s; await setJSON("site:" + prop.siteId, prop); }
    return frontStoreView(prop);
  }
  async function frontPhoto(id) {
    const r = await store.getWithMetadata("fsphoto:" + cleanStr(id, 80), { type: "arrayBuffer" });
    return r ? { data: r.data, type: (r.metadata && r.metadata.type) || "image/jpeg" } : null;
  }
  // The property behind a public link, or null when the link isn't (or no longer) switched on.
  async function propertyBySlug(sl) {
    const owner = await slugOwner(slug(sl));
    if (!owner) return null;
    const prop = await getJSON("site:" + owner);
    if (!prop) return null;
    const s = fsSettings(prop);
    // Channel properties have no front store (Jean, 2026-10-17, 2026-10-20).
    return s.on && !prop.channel && s.slug === slug(sl) ? prop : null;
  }
  function fsFirstNight(prop) {
    const s = fsSettings(prop), fb = firstBookable(prop), notice = addDays(today(), s.minNoticeDays || 0);
    return notice > fb ? notice : fb;
  }
  function fsUnits(prop) { const hide = fsSettings(prop).hiddenUnits || []; return prop.units.filter((u) => !hide.includes(u.name)); }
  // Public page facts (no guest names, no prices when switched off).
  function publicFrontStore(prop) {
    const s = fsSettings(prop), st = prop.settings || {};
    return { name: prop.resortName || "", slug: s.slug, url: fsUrl(prop),
      welcome: s.welcome, description: s.description, photos: s.photos, showPrices: s.showPrices, showCalendar: s.showCalendar,
      showActivities: s.showActivities, showOffers: s.showOffers, nearbyKm: s.nearbyKm || 30, minStay: minStayOf(prop), firstBookable: fsFirstNight(prop),
      contact: { phone: s.phone || st.phone || "", whatsapp: waNumber(s.whatsapp || s.phone || st.phone || ""), email: s.email || st.email || "" },
      units: fsUnits(prop).map((u) => { const x = (s.unitInfo || {})[u.name] || {}, pr = s.showPrices && st.prices && st.prices[u.name] > 0 ? st.prices[u.name] : 0;
        const wp = pr && st.weekendRates && st.weekendPrices && st.weekendPrices[u.name] > 0 ? st.weekendPrices[u.name] : 0;
        return { name: u.name, size: u.size || "", photo: x.photo || "", beds: x.beds || "", blurb: x.blurb || "", price: pr, weekendPrice: wp, weekendDays: wp ? (st.weekendDays || [4, 5]) : undefined }; }),
      payMode: payMode(prop), approveGuests: !prop.channel && !!(prop.settings && prop.settings.approveGuests),
      headline: s.headline || "", highlights: s.highlights || [], priceFrom: fsPriceFrom(prop, s),
      rating: s.ratingValue ? { value: s.ratingValue, count: s.ratingCount || "", link: s.ratingLink || "" } : null,
      actPhotos: s.actPhotos || {}, actHidden: s.actHidden || [], actPinned: s.actPinned || [], actPlace: s.actPlace || null, photoPos: s.photoPos || {} };
  }
  // The price badge: what the property typed, else its lowest price a night
  // (Reservation settings), only when prices are switched on.
  function fsPriceFrom(prop, s) {
    if (!s.showPrices) return "";
    if (s.priceFrom) return s.priceFrom;
    const st = prop.settings || {}, list = fsUnits(prop).map((u) => (st.prices || {})[u.name]).filter((v) => v > 0);
    return list.length ? "From R" + String(Math.min(...list)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " a night" : "";
  }
  function guestKeyOk(prop, key) {
    const want = fsSettings(prop).guestKey || "", got = String(key || "");
    if (!want || want.length !== got.length) return false;
    let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
    return d === 0;
  }
  function publicGuestInfo(prop) {
    const s = fsSettings(prop);
    return { wifiName: s.wifiName, wifiPassword: s.wifiPassword, guestNotes: s.guestNotes };
  }
  // The property's own current offers (hooks it manages itself), for the page.
  async function publicOffers(prop, hookStore) {
    if (!prop.aff || !hookStore || !fsSettings(prop).showOffers) return [];
    const out = [], t = today();
    for (const b of (await hookStore.list({ prefix: prop.aff + ":" })).blobs) {
      const n = Number(b.key.slice(prop.aff.length + 1)); if (!Number.isInteger(n) || n < 1) continue;
      const r = await hookStore.get(b.key, { type: "json" }).catch(() => null);
      if (!r || r.mode !== "self" || r.hidden || !(r.booking || r.landing)) continue;
      const end = isoDate(r.endDate) || isoDate((/[?&]checkout=(\d{4}-\d{2}-\d{2})/.exec(r.booking || "") || [])[1]);
      if (end && end < t) continue;
      out.push({ hook: n, title: String(r.hookTitle || String(r.caption || "").split("\n")[0] || "Special offer").slice(0, 90), booking: isHttpsUrl(r.booking) ? r.booking : "", landing: isHttpsUrl(r.landing) ? r.landing : "", endDate: end || "",
        image: "/api/hook-image?aff=" + encodeURIComponent(prop.aff) + "&hook=" + n });
    }
    return out.slice(0, 12);
  }
  async function publicAvailability(prop, from, to) {
    const s = fsSettings(prop), first = fsFirstNight(prop);
    from = isoDate(from); to = isoDate(to);
    if (!from || !to || !(nightsBetween(from, to) >= 1 && nightsBetween(from, to) <= 62)) throw new PAError("Choose a shorter date range.");
    if (from > addDays(today(), 548)) throw new PAError("That's too far ahead.");
    const av = await availability(prop, from, to);
    const units = fsUnits(prop), open = {}, rates = {};
    for (const u of units) {
      open[u.name] = Object.keys(av.nights[u.name] || {}).filter((n) => av.nights[u.name][n].s === "open" && n >= first).sort();
      if (s.showPrices) rates[u.name] = av.nightRates[u.name] || {};
    }
    return { from: av.from, to: av.to, units: units.map((u) => ({ name: u.name, size: u.size || "" })), open, rates: s.showPrices ? rates : null, minStay: av.minStay, firstBookable: first };
  }
  async function publicQuote(prop, checkIn, checkOut) {
    const s = fsSettings(prop), first = fsFirstNight(prop);
    checkIn = isoDate(checkIn); checkOut = isoDate(checkOut);
    if (!checkIn || !checkOut || !(nightsBetween(checkIn, checkOut) >= 1)) throw new PAError("Choose a check-out after the check-in.");
    if (nightsBetween(checkIn, checkOut) > FS_MAX_NIGHTS) throw new PAError("For stays longer than " + FS_MAX_NIGHTS + " nights, please contact us.");
    if (checkIn > addDays(today(), 548)) throw new PAError("That's too far ahead.");
    if (checkIn < first) throw new PAError("The first date you can book is " + first + ".");
    const r = await search(prop, checkIn, checkOut);
    const hide = s.hiddenUnits || [];
    const results = r.results.filter((x) => !hide.includes(x.unit)).map((x) => (s.showPrices ? x : Object.assign({}, x, { rate: null, total: null })));
    return Object.assign({}, r, { results, showPrices: s.showPrices, minStay: minStayOf(prop), tooShort: r.nights < minStayOf(prop) });
  }
  // A guest books on the public page: a normal hub booking on Stock Network,
  // source "Front store". The guest gets a confirmation email with how to
  // pay; the property gets an email too.
  async function publicBook(prop, body) {
    body = body || {};
    const s = fsSettings(prop);
    const ci = isoDate(body.checkIn), co = isoDate(body.checkOut);
    const units = [...new Set((Array.isArray(body.units) ? body.units : [body.unit]).map((u) => cleanStr(String(u || ""), 200)).filter(Boolean))].slice(0, 4);
    if (!ci || !co) throw new PAError("Choose your dates.");
    if (!units.length) throw new PAError("Choose a unit.");
    if (units.some((u) => (s.hiddenUnits || []).includes(u) || !prop.units.some((x) => x.name === u))) throw new PAError("That unit can't be booked here.");
    if (ci < fsFirstNight(prop)) throw new PAError("The first date you can book is " + fsFirstNight(prop) + ".");
    const n = nightsBetween(ci, co);
    if (!(n >= 1)) throw new PAError("Choose a check-out after the check-in.");
    if (n < minStayOf(prop)) throw new PAError("The minimum stay is " + minStayOf(prop) + " nights.");
    if (n > FS_MAX_NIGHTS) throw new PAError("For stays longer than " + FS_MAX_NIGHTS + " nights, please contact us.");
    if (ci > addDays(today(), 548)) throw new PAError("That's too far ahead.");
    const g = body.guest || {};
    const email = cleanStr(g.email, 120).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PAError("Enter a valid email address.");
    // Names: letters, spaces, apostrophes, dots and dashes only (no links in emails sent under the property's name).
    const nameOk = (v) => /^[\p{L}][\p{L}\p{M} .'\-]{0,59}$/u.test(String(v || "").trim());
    if (!nameOk(g.first) || !nameOk(g.last)) throw new PAError("Enter your first and last name (letters only).");
    // Limits: per property per day, and per email per day.
    const day = today(), kp = "fsbk:" + prop.siteId + ":" + day, ke = "fsbe:" + prop.siteId + ":" + day + ":" + (await sha256Hex(email)).slice(0, 16);
    const cp = (await getJSON(kp)) || 0, ce = (await getJSON(ke)) || 0;
    if (cp >= FS_PER_DAY || ce >= FS_PER_EMAIL_DAY) throw new PAError("We can't take more online bookings like this today. Please contact the property directly.", 429);
    // Every night must still be open (also not held by a channel booking that isn't on Stock Network yet).
    const av = await availability(prop, ci, co);
    for (const u of units) for (const night of eachNight(ci, co)) { const st = av.nights[u] && av.nights[u][night]; if (!st || st.s !== "open") throw new PAError(u + " isn't free for all of those nights any more. Check availability again.", 409); }
    await setJSON(kp, cp + 1); await setJSON(ke, ce + 1);
    const approval = !prop.channel && !!(prop.settings && prop.settings.approveGuests);
    const res = await book(prop, { items: units.map((u) => ({ unit: u, start: ci, end: co })), guest: { first: String(g.first).trim(), last: String(g.last).trim(), email, cellphone: g.cellphone },
      adults: body.adults, children: body.children, source: "Front store", notes: cleanStr(body.notes, 600), payBy: body.payBy }, { approval });
    if (approval) {
      const b0 = res.booking, st0 = prop.settings || {}, u0 = b0.items.map((i) => i.unit + " " + i.start + " to " + i.end).join(", ");
      await fsStat(prop, "bookings").catch(() => {});
      if (propertyTo(prop)) await sendEmail(propertyTo(prop), "Booking request to approve " + b0.ref + " · " + (prop.resortName || ""),
        "<p>A guest asked to book on your Avante front store. Accept or decline it in the hub: Property Affiliate → Bookings.</p><p><b>" + esc(b0.ref) + "</b> · " + esc(u0) + "<br>Guest: " + esc(b0.guest.first + " " + b0.guest.last) + " · " + esc(b0.guest.cellphone) + " · " + esc(b0.guest.email) + (b0.total ? "<br>Total: R" + esc(Math.round(b0.total)) : "") + "</p><p>If you don't answer, Avante cancels the request after a set number of days.</p>").catch(() => false);
      await sendEmail(email, "Booking request " + b0.ref + " at " + (prop.resortName || ""),
        "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px\"><p>Hi " + esc(b0.guest.first) + ",</p><p>Thank you. <b>" + esc(prop.resortName || "") + "</b> has your booking request <b>" + esc(b0.ref) + "</b> (" + esc(u0) + ") and will confirm it soon. You'll get the payment details as soon as it's accepted.</p></div>",
        { fromName: prop.resortName || "", replyTo: propertyTo(prop) }).catch(() => false);
      return { ref: b0.ref, total: b0.total, items: b0.items.map((i) => ({ unit: i.unit, start: i.start, end: i.end })), status: "Request", awaitingApproval: true, pay: { gatewayUrl: null, bank: null, noMethod: false, emailed: true } };
    }
    const b = res.booking, pay = res.pay || {};
    await fsStat(prop, "bookings").catch(() => {});
    const units2 = b.items.map((i) => i.unit + " " + i.start + " to " + i.end).join(", ");
    const st = prop.settings || {};
    if (propertyTo(prop)) await sendEmail(propertyTo(prop), "New front store booking " + b.ref + " · " + (prop.resortName || ""),
      "<p>A guest booked on your Avante front store.</p><p><b>" + esc(b.ref) + "</b> · " + esc(units2) + "<br>Guest: " + esc(b.guest.first + " " + b.guest.last) + " · " + esc(b.guest.cellphone) + " · " + esc(b.guest.email) +
      (b.total ? "<br>Total: R" + esc(Math.round(b.total)) : "") + "</p><p>It's with Avante as " + esc(b.status) + " and in the hub under Property Affiliate → Bookings.</p>").catch(() => false);
    // Built from parts: only the payment gateway address becomes a link.
    const payLink = pay.gatewayUrl && isHttpsUrl(pay.gatewayUrl) ? "<p><a href=\"" + esc(pay.gatewayUrl) + "\" style=\"display:inline-block;background:#0DCDC2;color:#0e2f44;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700\">Pay now</a></p>" : "";
    const bankHtml = pay.bank ? "<p><b>" + (payLink ? "Or pay by EFT" : "Please pay by EFT") + "</b><br>Bank: " + esc(pay.bank.bankName) + "<br>Account name: " + esc(pay.bank.accountHolder) + "<br>Account number: " + esc(pay.bank.accountNumber) + "<br>Branch code: " + esc(pay.bank.branchCode || "") + "<br>Reference: <b>" + esc(b.ref) + "</b>" + (pay.bank.note ? "<br>" + esc(pay.bank.note) : "") + "</p>" : "";
    if (payLink || bankHtml) await sendEmail(email, "Your booking " + b.ref + " at " + (prop.resortName || ""),
      "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px\"><p>Hi " + esc(b.guest.first) + ",</p><p>Thank you for booking <b>" + esc(prop.resortName || "with us") + "</b>.</p><p>Booking reference: <b>" + esc(b.ref) + "</b><br>" + esc(units2) + (b.total ? "<br>Amount: R" + esc(Math.round(b.total)) : "") + "</p>" + payLink + bankHtml + "<p>Reply to this email if you have any questions.</p></div>",
      { fromName: prop.resortName || "", replyTo: propertyTo(prop) }).catch(() => false);
    return { ref: b.ref, total: b.total, items: b.items.map((i) => ({ unit: i.unit, start: i.start, end: i.end })), status: b.status,
      pay: { gatewayUrl: pay.gatewayUrl || null, bank: pay.bank || null, noMethod: !!pay.noMethod, emailed: !!(pay.gatewayUrl || pay.bank) } };
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
  function notDemo(b) { if (b && b.demo) throw new PAError("This is a demo booking: it isn't in Avante's booking system, so it can't be changed, paid or cancelled.", 409); }

  return { propertyTo, requestChannelHelp, prefetch, siteOfToken, newSession, decide, refreshStatuses, clientFor, connect, auth, disconnect, publicProperty, availability, search, book, cancel, cancelUnit, edit, find, saveSettings, channelsView, payInfo, markPaidEft, affStatus, resume, seedDemo, clearDemo, isDemoSite, saveContact, checkIn, guests, messagesView, saveMessages, prepareMessage, markMessage, emailNow, inHouse, emailInHouse, firstBookable, fsSettings, saveFrontStore, frontStoreView, uploadFrontPhoto, removeFrontPhoto, frontPhoto, propertyBySlug, publicFrontStore, publicGuestInfo, guestKeyOk, publicOffers, publicAvailability, publicQuote, publicBook, fsStat, propertyReviewLink, remindMessages, icalFeed, runSync, syncProperty, channelEvents, addChannelEvent, snapshot, ensureWindow, resolveUnitNotice, findResortsForSite, findResort };
}

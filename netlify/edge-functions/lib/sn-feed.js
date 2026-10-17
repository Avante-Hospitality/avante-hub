// Stock Network's own property feed (/api/1.0/resort, read with Avante's agent
// login — the same feed netlify/functions/stocknetwork-sync.mjs reads every
// night), looked up by NightsBridge BBID (the feed's "resortCode") so a
// property that only gives its BBID can be added (Jean, 2026-10-14).
//
// The hub's nightly sync never kept the feed's site fields, and Stock Network
// doesn't document their names, so every field with "site" in its name is
// returned as it is (siteFields), and the Site Nr / Site ID are picked out of
// them: the Site ID is the GUID, the Site Nr the whole number.
// The feed is big, so a slim index (BBID -> property + site fields) is kept for
// 6 hours in the "sn-feed" store.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

const BASE = "https://api.stocknetwork.co.za";
const CACHE_MS = 6 * 3600e3;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
export const normBbid = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/^0+/, "");

export function siteFieldsOf(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    if (!/site/i.test(k)) continue;
    const v = row[k];
    if (v === null || v === undefined || typeof v === "object") continue;
    const s = String(v).trim();
    if (s) out[k] = s;
  }
  return out;
}
export function pickSite(fields) {
  const vals = Object.entries(fields || {});
  const guid = (vals.find(([k, v]) => /iExchangeSiteFileID/i.test(k) && GUID.test(v)) || vals.find(([, v]) => GUID.test(v)) || [])[1] || "";
  const nr = (vals.find(([k, v]) => /^\d{1,7}$/.test(v) && /(no|nr|num|number|code)$/i.test(k)) || vals.find(([, v]) => /^\d{1,7}$/.test(v)) || [])[1] || "";
  return { siteId: guid, siteNr: nr };
}
function slim(row) {
  const num = (v) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? null : Number(v));
  return { resortId: String(row.iExchangeResortFileID || row.resortId || "").trim(), name: String(row.name || row.resortName || row.ResortName || "").trim(),
    latitude: num(row.latitude), longitude: num(row.longitude), siteFields: siteFieldsOf(row) };
}

async function loadIndex(fetchImpl) {
  const store = getStore({ name: "sn-feed", consistency: "strong" });
  const cached = await store.get("bbid-index", { type: "json" }).catch(() => null);
  if (cached && cached.at && Date.now() - Date.parse(cached.at) < CACHE_MS) return cached;
  const username = env("STOCKNETWORK_USERNAME"), clientID = env("STOCKNETWORK_CLIENT_ID"), clientSecret = env("STOCKNETWORK_CLIENT_SECRET");
  if (!username || !clientID || !clientSecret) throw new Error("The Stock Network login for the property feed isn't set on this site.");
  const t = await fetchImpl(BASE + "/api/1.0/token", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ username, clientID, clientSecret }) });
  if (!t.ok) throw new Error("Stock Network didn't accept Avante's login (" + t.status + ").");
  const tok = await t.json();
  const r = await fetchImpl(BASE + "/api/1.0/resort", { headers: { Authorization: "Bearer " + (tok.accessToken || tok.access_token), Accept: "application/json" } });
  if (!r.ok) throw new Error("Stock Network's property feed answered " + r.status + ".");
  const data = await r.json();
  const rows = Array.isArray(data) ? data : data.resorts || data.data || [];
  const byBbid = {}, byResort = {};
  for (const row of rows) {
    const code = normBbid(row && row.resortCode); if (code) (byBbid[code] = byBbid[code] || []).push(slim(row));
    const rid = String((row && (row.iExchangeResortFileID || row.resortId)) || "").trim().toLowerCase(); if (rid) byResort[rid] = compact(row);
  }
  const index = { at: new Date().toISOString(), count: rows.length, byBbid };
  await store.setJSON("bbid-index", index).catch(() => {});
  // Every property's full row too (Jean, 2026-10-14: onboarding pulls all it can).
  await store.setJSON("resort-index", { at: index.at, byResort }).catch(() => {});
  return index;
}

// A feed row with only its plain values (text, numbers, yes/no).
function compact(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v === null || v === undefined || typeof v === "object") continue;
    const s = typeof v === "string" ? v.trim().slice(0, 600) : v;
    if (s !== "") out[k] = s;
  }
  return out;
}
// Every property's full row, keyed by lower-case ResortID (refreshed every 6 hours).
async function resortIndex(fetchImpl) {
  const store = getStore({ name: "sn-feed", consistency: "strong" });
  let idx = await store.get("resort-index", { type: "json" }).catch(() => null);
  if (!idx || !idx.at || Date.now() - Date.parse(idx.at) > CACHE_MS) {
    try { await store.delete("bbid-index").catch(() => {}); await loadIndex(fetchImpl); idx = await store.get("resort-index", { type: "json" }).catch(() => null); } catch (e) { /* use what we have */ }
  }
  return (idx && idx.byResort) || {};
}
const feedName = (row) => String(row.name || row.resortName || row.ResortName || "").trim();
const feedPlace = (row) => String(row.district || row.city || row.suburb || "").trim();

// The property's full row from the feed, or null.
export async function feedRowByResort(resortId, fetchImpl = fetch) {
  const id = String(resortId || "").trim().toLowerCase(); if (!id) return null;
  return (await resortIndex(fetchImpl))[id] || null;
}

// Properties on one Stock Network site, matched by its Site Nr or Site ID
// (what a property's own login returns). Lets a property created on Stock
// Network after the hub's resort list was loaded still connect (Jean, 2026-10-16).
// -> [{ resortId, name, district }]
export async function feedBySite(siteNr, siteId, fetchImpl = fetch) {
  const nr = String(siteNr || "").trim(), id = String(siteId || "").trim().toLowerCase();
  if (!nr && !id) return [];
  const out = [];
  for (const [rid, row] of Object.entries(await resortIndex(fetchImpl))) {
    const s = pickSite(siteFieldsOf(row));
    if ((nr && s.siteNr === nr) || (id && s.siteId.toLowerCase() === id)) out.push({ resortId: rid, name: feedName(row), district: feedPlace(row) });
  }
  return out;
}

// Properties whose name or place contains q (lower case). -> [{ resortId, name, district }]
export async function feedSearch(q, max = 12, fetchImpl = fetch) {
  const out = [];
  for (const [rid, row] of Object.entries(await resortIndex(fetchImpl))) {
    if ((feedName(row) + " " + feedPlace(row)).toLowerCase().indexOf(q) < 0) continue;
    out.push({ resortId: rid, name: feedName(row), district: feedPlace(row) });
    if (out.length >= max) break;
  }
  return out;
}

// Property type: the feed only has Stock Network's type code (a GUID); the
// hub learns the words for each code once ("type-names") — from a listing
// where admin typed the type, or from a resort list spreadsheet with a
// Property Type column — and then fills it for every property with that code.
export function typeCodeOf(row) {
  const e = Object.entries(row || {});
  const hit = e.find(([k, v]) => /resort.?type/i.test(k) && GUID.test(String(v))) || e.find(([k, v]) => /type/i.test(k) && GUID.test(String(v)));
  return hit ? String(hit[1]).toLowerCase() : "";
}
export function typeTextOf(row) {
  const hit = Object.entries(row || {}).find(([k, v]) => /type/i.test(k) && !/id$/i.test(k) && typeof v === "string" && !GUID.test(v) && /[a-z]/i.test(v) && v.length < 60);
  return hit ? String(hit[1]).trim() : "";
}
export async function typeNames() { return (await getStore({ name: "sn-feed", consistency: "strong" }).get("type-names", { type: "json" }).catch(() => null)) || {}; }
export async function learnTypeName(code, name) {
  code = String(code || "").toLowerCase(); name = String(name || "").trim().slice(0, 60);
  if (!GUID.test(code) || !name) return false;
  const store = getStore({ name: "sn-feed", consistency: "strong" });
  const names = await typeNames();
  if (names[code] === name) return false;
  names[code] = name; await store.setJSON("type-names", names);
  return true;
}

// Fills the listing's EMPTY fields from the feed row (never overwrites what
// is there). Returns the list of fields it filled.
const PICK = [
  ["telephone", /^(tel|telephone|phone|phoneno|phonenumber|contactnumber|contactphone|resortphone|telno)$/i, (v) => /\d{6,}/.test(String(v).replace(/\D/g, ""))],
  ["email", /e-?mail/i, (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))],
  ["infoLink", /^(website|web|url|websiteurl|infolink|resortinfolink)$/i, (v) => /^https?:\/\/|^www\./i.test(String(v))],
  ["bookingLink", /booking.?link|bookingurl/i, (v) => /^https?:\/\//i.test(String(v))],
  ["checkInTime", /check.?in.?time/i, (v) => /\d/.test(String(v))],
  ["checkOutTime", /check.?out.?time/i, (v) => /\d/.test(String(v))],
  ["streetAddress", /^(address|streetaddress|address1|physicaladdress)$/i, (v) => String(v).length > 4],
  ["propertyName2", /^(name2|resortname2)$/i, (v) => String(v).length > 1],
  ["complexName", /complex/i, (v) => String(v).length > 1],
];
export function fillFromFeed(record, row, names) {
  const filled = [];
  if (!row) return filled;
  const code = typeCodeOf(row);
  if (code) record.snTypeCode = code;
  if (!String(record.propertyType || "").trim()) {
    const t = (code && names && names[code]) || typeTextOf(row);
    if (t) { record.propertyType = t; filled.push("propertyType"); }
  }
  for (const [field, keyRe, ok] of PICK) {
    if (String(record[field] || "").trim()) continue;
    const hit = Object.entries(row).find(([k, v]) => keyRe.test(k) && v !== "" && ok(v));
    if (hit) { record[field] = String(hit[1]).trim().slice(0, 300); filled.push(field); }
  }
  return filled;
}

// -> { ok, matches: [{ resortId, name, latitude, longitude, siteFields, siteNr, siteId }] } or { ok:false, error }
export async function feedByBbid(bbid, fetchImpl = fetch) {
  try {
    const index = await loadIndex(fetchImpl);
    const list = index.byBbid[normBbid(bbid)] || [];
    return { ok: true, matches: list.map((m) => Object.assign({}, m, pickSite(m.siteFields))) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

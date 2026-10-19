// Availability check, used by the hub's own hourly check (checkStock in
// property-onboarding-api.js). Only callers with the hub's PA_SYNC_SECRET (header
// x-pa-sync-secret) get an answer, so nobody else can spend Avante's Stock Network
// login (Jean, 2026-10-19). The separate search site has its own copy.
// Asks Stock Network's API one property at a time, so it never depends on SN's
// own location fields and isn't cut off at 15 like SN's booking site.
// Uses the hub's existing Avante SN API login (the same env vars the nightly
// stocknetwork-sync uses), so the secret never leaves the hub (Jean, 2026-10-11).
//   POST /api/sn-availability { op:"status" } -> { ok, configured }
//   POST /api/sn-availability { ids: [ResortID...] (max 60), checkIn, checkOut }
//   -> { ok, configured, results: { id: { available, units, from, firstOpen } } }
// firstOpen: the first date with any free unit in the period asked (Jean,
// 2026-10-17: a property is "Ready to go live" once Avante has stock for it).
// Read-only: it only reads availability, never books or changes anything.
const BASE = "https://api.stocknetwork.co.za";
let TOKEN = null; // { accessToken, siteId, expires }

const json = (b, status) => new Response(JSON.stringify(b), { status: status || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const day = (v) => String(v || "").slice(0, 10);
const ISO = /^\d{4}-\d{2}-\d{2}$/, GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function login() {
  const body = JSON.stringify({ clientID: process.env.STOCKNETWORK_CLIENT_ID, clientSecret: process.env.STOCKNETWORK_CLIENT_SECRET, username: process.env.STOCKNETWORK_USERNAME });
  for (const path of ["/api/1/token", "/api/1.0/token"]) {
    const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body, signal: AbortSignal.timeout(15000) });
    if (!r.ok) continue;
    const d = await r.json();
    const exp = Number(d.expiresDT) || Date.parse(d.expiresDT) || Date.now() + 20 * 60e3;
    TOKEN = { accessToken: d.accessToken, siteId: d.siteId, site: d.site, via: path, expires: exp };
    return TOKEN;
  }
  throw new Error("Stock Network did not accept the login.");
}
async function token() { return TOKEN && TOKEN.expires > Date.now() + 60e3 ? TOKEN : login(); }

async function search(id, checkIn, checkOut, retried, debug) {
  const t = await token();
  const body = { checkInDate: checkIn, checkOutDate: checkOut, resortID: id,
    geocoordinates: { latitude: 0, longitude: 0, withInKmRadius: 0 }, pricing: { minPrice: 0, maxPrice: 100000000 },
    region: { name: "" }, ignoreLocationData: true, groupStockToMatchDates: false, extendDatesIfNoMatchFound: false };
  const r = await fetch(BASE + "/api/1/search?Offset=1&Limit=50&CallerDetails.SiteID=" + encodeURIComponent(t.siteId), {
    method: "POST", headers: { authorization: "Bearer " + t.accessToken, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if ((r.status === 401 || r.status === 403) && !retried) { TOKEN = null; return search(id, checkIn, checkOut, true, debug); }
  if (!r.ok) throw new Error("search " + r.status);
  const d = await r.json().catch(() => ({}));
  // SN lists open stretches per unit (e.g. free 1-30 Nov). A stretch counts when
  // it covers the chosen dates; price: exact-date rate, else per-night share.
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 864e5);
  let units = 0, from = null, firstOpen = null; const sample = [];
  for (const resort of d.stockAvailability || []) {
    if (resort.resortId && String(resort.resortId).toLowerCase() !== id) continue;
    for (const rt of resort.roomTypes || []) for (const a of rt.availabilities || []) {
      const s = day(a.checkInDate), e = day(a.checkOutDate);
      if (sample.length < 8) sample.push({ unit: String(rt.roomType || "").trim(), start: s, end: e, nights: a.nights, units: a.unitsAvailable, rate: a.rates && a.rates.rate });
      if (a.unitsAvailable > 0 && s && (firstOpen === null || s < firstOpen)) firstOpen = s < checkIn ? checkIn : s;
      if (!(a.unitsAvailable > 0) || s > checkIn || e < checkOut) continue;
      units += a.unitsAvailable;
      let rate = a.rates && Number(a.rates.rate);
      if (rate > 0 && (s !== checkIn || e !== checkOut)) rate = a.nights > 0 ? Math.round(rate / a.nights * nights) : 0;
      if (rate > 0 && (from === null || rate < from)) from = rate;
    }
  }
  if (debug) return { available: units > 0, units, from, firstOpen, sample, resorts: (d.stockAvailability || []).length, loginSite: t.site, loginSiteId: t.siteId, loginVia: t.via, http: r.status, keys: Object.keys(d || {}), raw: JSON.stringify(d).slice(0, 600) };
  return { available: units > 0, units, from, firstOpen };
}


// One-property probe (debug only): ask SN the same question five ways and
// report how many resorts/rows each returns, to find the form SN answers.
async function probe(id, checkIn, checkOut, lat, lng) {
  const t = await token();
  const base = { checkInDate: checkIn, checkOutDate: checkOut, resortID: id,
    geocoordinates: { latitude: 0, longitude: 0, withInKmRadius: 0 }, pricing: { minPrice: 0, maxPrice: 100000000 },
    region: { name: "" }, ignoreLocationData: true, groupStockToMatchDates: false, extendDatesIfNoMatchFound: false };
  const variants = {
    asNow: base,
    group: { ...base, groupStockToMatchDates: true },
    extend: { ...base, extendDatesIfNoMatchFound: true },
    geo: { ...base, ignoreLocationData: false, geocoordinates: { latitude: lat || 0, longitude: lng || 0, withInKmRadius: 5 } },
    noResortGeo: { ...base, resortID: null, ignoreLocationData: false, geocoordinates: { latitude: lat || 0, longitude: lng || 0, withInKmRadius: 5 } },
  };
  const out = {};
  for (const [k, body] of Object.entries(variants)) {
    try {
      const r = await fetch(BASE + "/api/1/search?Offset=1&Limit=50&CallerDetails.SiteID=" + encodeURIComponent(t.siteId), {
        method: "POST", headers: { authorization: "Bearer " + t.accessToken, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const d = await r.json().catch(() => ({}));
      const sa = d.stockAvailability || [];
      out[k] = { http: r.status, rows: d.totalRowCount, resorts: sa.length, hasThis: sa.some((x) => String(x.resortId || "").toLowerCase() === id), names: sa.slice(0, 3).map((x) => x.resortName) };
    } catch (e) { out[k] = { error: String(e.message || e) }; }
  }
  return out;
}

// Field check (Jean, 2026-10-17): what Stock Network's other read calls send
// back for one property, as a list of field paths with a short sample each —
// version 2 search (which can filter on amenities, activities, experiences),
// the paged search, and resort info by area. Read-only, no values longer than
// 80 characters, no login details.
function fieldMap(v, path, out) {
  if (Object.keys(out).length >= 400) return out;
  if (Array.isArray(v)) { out[path + "[]"] = "(" + v.length + " items)"; v.slice(0, 2).forEach((x) => fieldMap(x, path + "[]", out)); return out; }
  if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) fieldMap(x, path ? path + "." + k : k, out); return out; }
  if (!(path in out)) out[path] = String(v).slice(0, 80);
  return out;
}
async function snCall(path, body, ms) {
  const t = await token();
  const r = await fetch(BASE + path.replace("{site}", encodeURIComponent(t.siteId)), {
    method: body ? "POST" : "GET", headers: { authorization: "Bearer " + t.accessToken, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms || 25000) });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch (e) {}
  return { http: r.status, fields: d ? fieldMap(d, "", {}) : { text: text.slice(0, 300) } };
}
// One read-only call per request, so each gets the full time: "v2search",
// "v1paged" or "resortinfo". extra: fields added to the search request (e.g.
// { unitSizes: [] }) to find the form Stock Network accepts.
async function fieldCheck(call, id, area, checkIn, checkOut, extra) {
  const body = Object.assign({ checkInDate: checkIn, checkOutDate: checkOut, resortID: id,
    geocoordinates: { latitude: 0, longitude: 0, withInKmRadius: 0 }, pricing: { minPrice: 0, maxPrice: 100000000 },
    region: { name: "" }, ignoreLocationData: true, groupStockToMatchDates: false, extendDatesIfNoMatchFound: false,
    amenities: [], activities: [], experiences: [], unitSizes: [] }, extra && typeof extra === "object" ? extra : {});
  const q = "?Offset=1&Limit=5&Date_From=" + checkIn + "&Date_To=" + checkOut + "&CallerDetails.SiteID={site}";
  try {
    if (call === "v2search") return await snCall("/api/2/search" + q, body, 24000);
    if (call === "v1paged") return await snCall("/api/1/search/paged" + q, body, 24000);
    if (call === "resortinfo") return await snCall("/api/1/search/resortinfo/" + encodeURIComponent(area || ""), null, 24000);
    return { error: "call must be v2search, v1paged or resortinfo" };
  } catch (e) { return { error: String(e.message || e) }; }
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  const secret = process.env.PA_SYNC_SECRET || "";
  if (!secret || req.headers.get("x-pa-sync-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
  const configured = !!(process.env.STOCKNETWORK_USERNAME && process.env.STOCKNETWORK_CLIENT_ID && process.env.STOCKNETWORK_CLIENT_SECRET);
  let b = {}; try { b = await req.json(); } catch (e) {}
  if (b.op === "status") return json({ ok: true, configured });
  if (!configured) return json({ ok: true, configured: false, results: {} });
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x) => String(x).toLowerCase()).filter((x) => GUID.test(x)))].slice(0, 60);
  if (!ISO.test(b.checkIn || "") || !ISO.test(b.checkOut || "") || b.checkOut <= b.checkIn) return json({ ok: false, error: "Pick a check-in and check-out date." }, 400);
  if (b.op === "fields" && ids.length === 1) return json({ ok: true, result: await fieldCheck(String(b.call || ""), ids[0], String(b.area || "").slice(0, 80), b.checkIn, b.checkOut, b.extra) });
  if (b.probe === true && ids.length === 1) return json({ ok: true, probe: await probe(ids[0], b.checkIn, b.checkOut, Number(b.lat), Number(b.lng)) });
  const results = {}; let i = 0;
  const worker = async () => { while (i < ids.length) { const id = ids[i++];
    try { results[id] = await search(id, b.checkIn, b.checkOut, false, b.debug === true && ids.length === 1); } catch (e) { results[id] = { error: String(e.message || e) }; } } };
  try { await Promise.all(Array.from({ length: 6 }, worker)); }
  catch (e) { return json({ ok: false, configured, error: e.message || "Stock Network didn't answer." }, 502); }
  return json({ ok: true, configured, results });
};

export const config = { path: "/api/sn-availability" };

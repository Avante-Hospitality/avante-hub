// Availability check for the separate Avante search site (avante-search.netlify.app).
// Asks Stock Network's API one property at a time, so it never depends on SN's
// own location fields and isn't cut off at 15 like SN's booking site.
// Uses the hub's existing Avante SN API login (the same env vars the nightly
// stocknetwork-sync uses), so the secret never leaves the hub (Jean, 2026-10-11).
//   POST /api/sn-availability { op:"status" } -> { ok, configured }
//   POST /api/sn-availability { ids: [ResortID...] (max 60), checkIn, checkOut }
//   -> { ok, configured, results: { id: { available, units, from } } }
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
    TOKEN = { accessToken: d.accessToken, siteId: d.siteId, expires: exp };
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
  let units = 0, from = null; const sample = [];
  for (const resort of d.stockAvailability || []) {
    if (resort.resortId && String(resort.resortId).toLowerCase() !== id) continue;
    for (const rt of resort.roomTypes || []) for (const a of rt.availabilities || []) {
      const s = day(a.checkInDate), e = day(a.checkOutDate);
      if (sample.length < 8) sample.push({ unit: String(rt.roomType || "").trim(), start: s, end: e, nights: a.nights, units: a.unitsAvailable, rate: a.rates && a.rates.rate });
      if (!(a.unitsAvailable > 0) || s > checkIn || e < checkOut) continue;
      units += a.unitsAvailable;
      let rate = a.rates && Number(a.rates.rate);
      if (rate > 0 && (s !== checkIn || e !== checkOut)) rate = a.nights > 0 ? Math.round(rate / a.nights * nights) : 0;
      if (rate > 0 && (from === null || rate < from)) from = rate;
    }
  }
  if (debug) return { available: units > 0, units, from, sample, resorts: (d.stockAvailability || []).length };
  return { available: units > 0, units, from };
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  const configured = !!(process.env.STOCKNETWORK_USERNAME && process.env.STOCKNETWORK_CLIENT_ID && process.env.STOCKNETWORK_CLIENT_SECRET);
  let b = {}; try { b = await req.json(); } catch (e) {}
  if (b.op === "status") return json({ ok: true, configured });
  if (!configured) return json({ ok: true, configured: false, results: {} });
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x) => String(x).toLowerCase()).filter((x) => GUID.test(x)))].slice(0, 60);
  if (!ISO.test(b.checkIn || "") || !ISO.test(b.checkOut || "") || b.checkOut <= b.checkIn) return json({ ok: false, error: "Pick a check-in and check-out date." }, 400);
  const results = {}; let i = 0;
  const worker = async () => { while (i < ids.length) { const id = ids[i++];
    try { results[id] = await search(id, b.checkIn, b.checkOut, false, b.debug === true && ids.length === 1); } catch (e) { results[id] = { error: String(e.message || e) }; } } };
  try { await Promise.all(Array.from({ length: 6 }, worker)); }
  catch (e) { return json({ ok: false, configured, error: e.message || "Stock Network didn't answer." }, 502); }
  return json({ ok: true, configured, results });
};

export const config = { path: "/api/sn-availability" };

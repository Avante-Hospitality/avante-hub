// /api/sn-prices — a property's prices from Stock Network's booking system, read with
// Avante's own agent login (Jean, 2026-10-23: Stock Network gave permission). For the
// hook builder's flyers: a property flyer's own unit types, and the Where to stay
// pages. Only the property asked about is read — never all of Stock Network.
//   GET ?resortId=<ResortID>&from=YYYY-MM-DD[&days=14]   (days 1–31)
//   -> { ok, result: { resortId, month, start, days, checkedAt, minNights, unitNames, units: [{ name, size, sleeps }],
//        nights: { "YYYY-MM-DD": { open, perNight, units: { <unit>: { perNight, avail } } } } } }
// The same shape the hook builder's old GitHub price job gave, so its flyers read it as
// before. An answer is kept an hour (the "sn-prices" store), so a property asked about
// again soon isn't read again.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { SNClient, addDays } from "./lib/sn-client.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEEP_MS = 3600e3;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" }; // the hook builder reads it
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const todaySA = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);

// One login per edge isolate, reused until it runs out (SNClient logs in again by itself).
let client = null;
function agentClient() {
  const creds = { username: env("STOCKNETWORK_USERNAME"), clientID: env("STOCKNETWORK_CLIENT_ID"), clientSecret: env("STOCKNETWORK_CLIENT_SECRET") };
  if (!creds.username || !creds.clientID || !creds.clientSecret) throw new Error("Avante's Stock Network login isn't set on the hub.");
  if (!client) client = new SNClient(creds);
  return client;
}

// Stock Network's open stretches → each night's price per unit (a stretch's total over its nights).
export function nightsFrom(read, from, to) {
  const nights = {}, names = new Set();
  for (const st of read.stretches || []) {
    if (!(st.unitsAvailable > 0) || !st.rateTotal || !st.nights) continue;
    const per = Math.round(st.rateTotal / st.nights);
    names.add(st.unit);
    for (let d = st.start; d < st.end; d = addDays(d, 1)) {
      if (d < from || d >= to) continue;
      const n = (nights[d] = nights[d] || { open: true, units: {}, perNight: 0 });
      const u = n.units[st.unit];
      if (!u || per < u.perNight) n.units[st.unit] = { perNight: per, avail: st.unitsAvailable };
      if (!n.perNight || per < n.perNight) n.perNight = per;
    }
  }
  return { nights, unitNames: [...names] };
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET") return json({ ok: false, error: "Use GET." }, 405);
  const u = new URL(request.url);
  const rid = String(u.searchParams.get("resortId") || "").trim().toLowerCase();
  let from = String(u.searchParams.get("from") || "").trim();
  const days = Math.max(1, Math.min(31, parseInt(u.searchParams.get("days") || "14", 10) || 14));
  if (!GUID.test(rid)) return json({ ok: false, error: "That isn't a valid ResortID." }, 400);
  if (!DAY.test(from) || from < todaySA()) from = todaySA();
  const to = addDays(from, days), key = "u|" + rid + "|" + from + "|" + days; // "u|": answers kept before units were added are not reused
  const store = getStore({ name: "sn-prices", consistency: "strong" });
  const kept = await store.get(key, { type: "json" }).catch(() => null);
  if (kept && Date.now() - Date.parse(kept.checkedAt) < KEEP_MS) return json({ ok: true, result: kept, kept: true });
  let read;
  try { read = await agentClient().openStretches(rid, from, to); }
  catch (e) { console.error("sn-prices: " + rid, e); return json({ ok: false, error: "Avante's booking system didn't give the prices: " + String((e && e.message) || e).slice(0, 160) }, 502); }
  const { nights, unitNames } = nightsFrom(read, from, to);
  // Every unit Stock Network's stock lists, with its size and how many it sleeps (Jean, 2026-10-27:
  // the property's info page can show fewer units than it really has, e.g. Chicuanga shows 1 of many).
  const units = Object.values(read.units || {}).filter((x) => x.name).map((x) => ({ name: x.name, size: x.size || "", sleeps: +x.maxOccupancy || +((x.size || "").match(/^\s*(\d+)\s*sleeper/i) || [])[1] || 0 }));
  const result = { resortId: rid, resortName: read.resortName || "", month: from, start: from, days, checkedAt: new Date().toISOString(), minNights: 1, unitNames, units, nights };
  await store.setJSON(key, result).catch((e) => console.error("sn-prices: couldn't keep " + key, e));
  return json({ ok: true, result });
};

export const config = { path: "/api/sn-prices" };

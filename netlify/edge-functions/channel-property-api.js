// /api/channel-property — the Channel Property Affiliate (Jean, 2026-10-13).
//
// A channel property is already on a channel manager (NightsBridge first)
// that feeds Stock Network, so it doesn't use the hub's calendar, iCal or
// booking module, nor a front store (it has its own). In the hub it gets the
// hook builder and this screen. We never offer what NightsBridge already
// gives the property; the hub only adds bookings from the property's hooks.
//
// Payments (Jean, 2026-10-13): guests who book through the property's hooks
// always pay through Avante's payment gateway (the Stock Network payment
// page) — no EFT or manual option — so Avante is always responsible for
// collecting payment on its bookings; the booking becomes Paid when the
// payment succeeds. Avante's commission on these bookings: 4.95% + VAT by
// default (commissionPct on the record overrides it).
//
// Later: a Communication & marketing module fed by an uploaded channel
// report — not built (NightsBridge already does guest communication).
//
// The affiliate signs in to the hub as usual; this checks the same hub
// session auth-api.js issues (affiliate-sessions store, tied to the
// password hash so a password change logs every device out).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { sha256Hex } from "./lib/pa-crypto.js";

const DEFAULT_PASSWORD = "0000";
const DEFAULT_COMMISSION = 4.95, VAT = 15;
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
const clean = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function validSession(aff, session) {
  if (!aff || !session) return false;
  const rec = await getStore({ name: "affiliate-auth", consistency: "strong" }).get(aff, { type: "json" });
  const storedHash = rec && rec.passwordHash ? rec.passwordHash : await sha256Hex(DEFAULT_PASSWORD);
  const s = await getStore({ name: "affiliate-sessions", consistency: "strong" }).get(String(session).slice(0, 100), { type: "json" });
  return !!(s && s.aff === aff && s.ph === storedHash.slice(0, 16));
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const aff = clean(body.aff, 100);
  try {
    if (!(await validSession(aff, body.session))) return json({ ok: false, relogin: true, error: "Please log in again." }, 401);
    const dir = await getStore({ name: "affiliates-directory", consistency: "strong" }).get(aff, { type: "json" });
    const types = (dir && Array.isArray(dir.types)) ? dir.types : [];
    if (types.indexOf("channel") === -1) return json({ ok: false, error: "This affiliate isn't set up as a channel property. Ask Avante Travel." }, 403);
    const rec = (await getStore({ name: "channel-property", consistency: "strong" }).get(aff, { type: "json" })) || {};

    if (body.action === "get") {
      const pct = +rec.commissionPct > 0 ? +rec.commissionPct : DEFAULT_COMMISSION;
      return json({ ok: true, name: (dir && dir.name) || "", siteNr: (dir && dir.siteNr) || "", payMode: "sn",
        commissionPct: pct, vatPct: VAT, commissionTotal: Math.round(pct * (100 + VAT)) / 100 });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 500);
  }
};

export const config = { path: "/api/channel-property" };

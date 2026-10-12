// TEMPORARY (Oct 2026): admin-only test of Stock Network's new API calls
// (list bookings, change status, record payment) on the Property Testing
// site (site 3) only. Used from sn-probe.html. Makes one test booking and
// cancels it again. REMOVE this file and sn-probe.html after testing.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { createCore } from "./lib/pa-core.js";
import { addDays } from "./lib/sn-client.js";

const json = (o, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cut = (v) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t && t.length > 2500 ? t.slice(0, 2500) + "…" : t; };

export default async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: "forbidden" }, 403);
  let body; try { body = await request.json(); } catch (_) { return json({ ok: false, error: "bad json" }, 400); }
  const sess = body.token ? await getStore({ name: "admin-sessions", consistency: "strong" }).get(String(body.token), { type: "json" }) : null;
  if (!sess || new Date(sess.expiresAt).getTime() < Date.now()) return json({ ok: false, error: "Log in to admin first (in this browser tab)." }, 401);
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  const store = getStore({ name: "property-affiliate", consistency: "strong" });
  const core = createCore({ store, resortStore: getStore({ name: "resort-list", consistency: "strong" }), encKey: env("PA_ENC_KEY"), baseUrl: new URL(request.url).origin });
  let prop = null;
  for (const b of (await store.list({ prefix: "site:" })).blobs) { const p = await store.get(b.key, { type: "json" }); if (p && String(p.site) === "3") { prop = p; break; } }
  if (!prop) return json({ ok: false, error: "Property Testing (site 3) isn't connected in Property Affiliate." }, 404);
  const c = await core.clientFor(prop);
  const t = await c.token();
  const log = [];
  const step = async (name, path, opts) => { const r = await c.call(path, opts); log.push({ step: name, request: ((opts && opts.method) || "POST") + " " + path, status: r.status, response: cut(r.data) }); return r; };
  const today = new Date().toISOString().slice(0, 10);
  const S = encodeURIComponent(t.siteId);
  const list = (q) => "/api/1/request?SiteID=" + S + "&CallerDetails.SiteID=" + S + q + "&Offset=0&Limit=10";
  try {
    if (body.action === "read") {
      await step("List bookings, dates", list("&FromDate=" + addDays(today, -60) + "&ToDate=" + addDays(today, 120)), { method: "GET" });
      await step("List changed in last 7 days", list("&ModifiedSince=" + encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())), { method: "GET" });
      await step("List status=Request", list("&Status=Request"), { method: "GET" });
      await step("List status=Booked", list("&Status=Booked"), { method: "GET" });
      return json({ ok: true, site: prop.site, siteId: t.siteId, results: log });
    }
    if (body.action === "cycle") {
      // A free night 30–75 days ahead: book it, try the new calls, then cancel it.
      const from = addDays(today, 30), snap = await c.openStretches(prop.resortId, from, addDays(today, 75));
      const minN = Math.max(1, (prop.settings && prop.settings.minStay) || 1);
      const st = snap.stretches.find((x) => x.unitsAvailable > 0 && x.nights >= minN);
      if (!st) return json({ ok: false, error: "No open stretch 30–75 days ahead on site 3 to test with.", results: log });
      const end = addDays(st.start, minN);
      const stock = await c.exactStock(prop.resortId, st.unit, st.start, end);
      if (!stock) return json({ ok: false, error: "Couldn't read exact stock for " + st.unit + " " + st.start + "–" + end });
      const res = await c.createReservation({ items: [c.buildItem(stock, { adults: 1, children: 0 })], guest: { fullName: "API Test (please ignore)", email: "", cellphone: "0820000000" }, notes: "Avante hub API test - cancelled automatically", requestAndPay: !!body.requestAndPay });
      log.push({ step: "Create booking (isRequestAndPay=" + !!body.requestAndPay + ")", status: 201, response: cut({ ref: res.refNo, id: res.reservationId, status: res.status, total: res.total, unit: st.unit, dates: st.start + " to " + end }) });
      const id = encodeURIComponent(res.reservationId), q = "?CallerDetails.SiteID=" + S;
      await step("Read it", "/api/1/request/" + id, { method: "GET" });
      if (!body.requestAndPay) {
        await step("Status -> Booked", "/api/1/request/status/" + id + q, { method: "PUT", body: { status: "Booked", note: "Hub API test: Request to Booked" } });
        await step("Read after Booked", "/api/1/request/" + id, { method: "GET" });
      }
      await step("Payment EFT R1 (part payment)", "/api/1/request/payment/" + id + q, { body: { type: "EFT", amount: 1, reference: "HUBTEST", note: "Hub API test payment" } });
      await step("Read after payment", "/api/1/request/" + id, { method: "GET" });
      await step("Status -> Confirmed", "/api/1/request/status/" + id + q, { method: "PUT", body: { status: "Confirmed", note: "Hub API test: to Confirmed" } });
      await step("Read after Confirmed", "/api/1/request/" + id, { method: "GET" });
      await step("List changed in last 15 min", list("&ModifiedSince=" + encodeURIComponent(new Date(Date.now() - 15 * 6e4).toISOString())), { method: "GET" });
      await step("Cancel (existing cancel call)", "/api/1/request/cancel/" + id + q, {});
      await step("Read after cancel", "/api/1/request/" + id, { method: "GET" });
      return json({ ok: true, site: prop.site, results: log });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), detail: cut(e && e.body), results: log }, 500);
  }
};

export const config = { path: "/api/sn-probe" };

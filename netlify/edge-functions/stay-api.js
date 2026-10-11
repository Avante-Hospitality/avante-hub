// /api/stay — the public side of a property's front store (stay.html at
// /stay/<slug>, the in-house guest page /stay/<slug>/guest and the room card
// /stay/<slug>/card). No login: everything here is what any visitor may see.
//   GET  ?slug=<slug>[&guest=1]          page facts, photos, place, nearby activities
//   GET  ?slug=<slug>&from=&to=          open nights per unit (no guest names)
//   GET  ?photo=<siteId>:<id>            a photo the property uploaded
//   POST { action:"quote", slug, checkIn, checkOut }
//   POST { action:"book", slug, checkIn, checkOut, unit, guest, adults, children, notes }
// Settings live in the Property Affiliate tab (pa-api.js → saveFrontStore).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { createCore, PAError } from "./lib/pa-core.js";
import { fetchResortInfo } from "./lib/hook-source.js";
import { propertyTreeOpts } from "./lib/tree-place.js";
import { nearestByDistance } from "./lib/geo-distance.js";

// Reading is open to any site; booking only from our own pages (checked below).
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type" };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extra } });
const INFO_TTL_MS = 24 * 3600 * 1000;
const BOOKINGS_PER_HOUR = 5; // per visitor (IP), to stop abuse of real Stock Network bookings

async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join(""); }

export default async (request, context) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  const url = new URL(request.url);
  const store = getStore({ name: "property-affiliate", consistency: "strong" });
  const core = createCore({
    store, resortStore: getStore({ name: "resort-list", consistency: "strong" }), encKey: env("PA_ENC_KEY"), baseUrl: url.origin,
    sendEmail: async (to, subject, html, opts = {}) => {
      const key = env("RESEND_API_KEY");
      if (!key || !to) return false;
      const name = String(opts.fromName || "").replace(/[\r\n"<>]/g, "").trim().slice(0, 80);
      const msg = { from: (name ? '"' + name + '"' : "Avante Travel") + " <bookings@go.avantetravel.co.za>", to: [to], subject, html };
      if (opts.replyTo) msg.reply_to = [opts.replyTo];
      try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(msg) }); return r.ok; } catch (_) { return false; }
    },
  });
  try {
    if (request.method === "GET") {
      const photo = url.searchParams.get("photo");
      if (photo) {
        const p = await core.frontPhoto(photo);
        if (!p) return new Response("Not found", { status: 404, headers: cors });
        return new Response(p.data, { headers: { "content-type": p.type, "x-content-type-options": "nosniff", "cache-control": "public, max-age=86400", ...cors } });
      }
      const prop = await core.propertyBySlug(url.searchParams.get("slug") || "");
      if (!prop) return json({ ok: false, error: "This page isn't available." }, 404);
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      if (from && to) return json(Object.assign({ ok: true }, await core.publicAvailability(prop, from, to)));

      const page = core.publicFrontStore(prop);
      const guest = url.searchParams.get("guest") === "1", card = url.searchParams.get("card") === "1";
      // Wi-Fi and house info only with the guest page's secret key (on the room card QR).
      const keyOk = (guest || card) && core.guestKeyOk(prop, url.searchParams.get("key") || "");
      if (!card) context.waitUntil(core.fsStat(prop, guest ? "guestVisits" : "visits").catch(() => {}));
      // Photos and description from Stock Network's resort info page (cached a day).
      let info = await store.get("fsinfo:" + prop.siteId, { type: "json" }).catch(() => null);
      if (!info || Date.now() - (info.at || 0) > INFO_TTL_MS) {
        const fresh = await fetchResortInfo(prop.resortId, prop.site).catch(() => null);
        if (fresh) { info = { at: Date.now(), description: fresh.description || "", attractions: fresh.attractions || "", moreInfo: fresh.moreInfo || "", images: fresh.images || [] }; context.waitUntil(store.setJSON("fsinfo:" + prop.siteId, info).catch(() => {})); }
      }
      info = info || { description: "", attractions: "", moreInfo: "", images: [] };
      const uploaded = (await store.list({ prefix: "fsphoto:" + prop.siteId + ":" })).blobs.map((b) => "/api/stay?photo=" + encodeURIComponent(b.key.slice(8)));
      const photos = Array.isArray(page.photos) && page.photos.length ? page.photos : uploaded.concat(info.images || []).slice(0, 24);
      // Where it is: the hub's location tree, and the pin from the resort list.
      const place = await propertyTreeOpts(prop.resortId, url.origin, prop.resortName).catch(() => ({}));
      const rl = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
      const pin = ((rl && rl.resorts) || []).find((r) => r && r.resortId === prop.resortId) || {};
      const lat = parseFloat(pin.latitude), lng = parseFloat(pin.longitude);
      let nearby = [], out_km = page.nearbyKm || 30;
      if (page.showActivities && isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0)) {
        const acts = ((await getStore({ name: "map-activities", consistency: "strong" }).get("all", { type: "json" }).catch(() => null)) || []).filter((a) => a && a.visible !== false);
        // The property sets its default distance; the guest can change it on the page (?km=).
        const km = Math.max(1, Math.min(150, Number(url.searchParams.get("km")) || page.nearbyKm || 30));
        out_km = km;
        nearby = nearestByDistance(lat, lng, acts, { limit: 24, maxKm: km }).map((a) => {
          const keys = Array.isArray(a.photoKeys) ? a.photoKeys : a.photoKey ? [a.photoKey] : [];
          return { name: a.name || "", area: a.area || "", price: a.price || "", description: String(a.description || "").slice(0, 300), link: a.contactLink || "",
            photo: keys[0] ? "/api/property-file?key=" + encodeURIComponent(keys[0]) : "", latitude: parseFloat(a.latitude), longitude: parseFloat(a.longitude), distance: a.distanceLabel };
        });
      }
      const out = Object.assign({ ok: true }, page, {
        photos, description: page.description || info.description || "", attractions: info.attractions || "", moreInfo: info.moreInfo || "",
        place: { country: place.country || "", province: place.province || "", region: place.region || "", city: place.city || "", suburb: place.suburb || "" },
        latitude: isFinite(lat) && lat !== 0 ? lat : null, longitude: isFinite(lng) && lng !== 0 ? lng : null, nearby, nearbyKm: out_km,
      });
      if (keyOk) out.guest = core.publicGuestInfo(prop);
      out.guestKeyOk = !!keyOk;
      if (!guest && !card) out.offers = await core.publicOffers(prop, getStore({ name: "promo-hooks", consistency: "strong" })).catch(() => []);
      return json(out);
    }

    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    // Booking and quotes only from our own pages (a browser always sends Origin on a POST).
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ ok: false, error: "forbidden" }, 403);
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: "Invalid request" }, 400); }
    const prop = await core.propertyBySlug(body.slug || "");
    if (!prop) return json({ ok: false, error: "This page isn't available." }, 404);
    if (body.action === "quote") return json(Object.assign({ ok: true }, await core.publicQuote(prop, String(body.checkIn || ""), String(body.checkOut || ""))));
    if (body.action === "book") {
      if (body.website) return json({ ok: false, error: "Please try again." }, 400); // honeypot field real people never fill in
      const ip = (context && context.ip) || request.headers.get("x-nf-client-connection-ip") || "unknown";
      const k = "fsrl:" + (await sha(ip)) + ":" + new Date().toISOString().slice(0, 13);
      const n = (await store.get(k, { type: "json" }).catch(() => null)) || 0;
      if (n >= BOOKINGS_PER_HOUR) return json({ ok: false, error: "Too many bookings from this connection. Please contact the property directly." }, 429);
      await store.setJSON(k, n + 1);
      return json(Object.assign({ ok: true }, await core.publicBook(prop, body)));
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    const status = e instanceof PAError ? e.status : 500;
    return json({ ok: false, error: e.message || "Something went wrong" }, status);
  }
};

export const config = { path: "/api/stay" };

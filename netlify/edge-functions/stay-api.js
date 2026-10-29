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
import { emailList } from "./lib/emails.js";
import { createCore, PAError } from "./lib/pa-core.js";
import { stayPayload } from "./lib/stay-payload.js";
import { GREF, LIBID, libImage, libGooglePhoto } from "./lib/photo-library.js";

// Reading is open to any site; booking only from our own pages (checked below).
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type" };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extra } });
const BOOKINGS_PER_HOUR = 5; // per visitor (IP), to stop abuse of real Stock Network bookings

async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join(""); }

export default async (request, context) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  const url = new URL(request.url);
  const store = getStore({ name: "property-affiliate", consistency: "strong" });
  const core = createCore({
    snSource: "Front store",
    store, resortStore: getStore({ name: "resort-list", consistency: "strong" }), encKey: env("PA_ENC_KEY"), baseUrl: url.origin,
    sendEmail: async (to, subject, html, opts = {}) => {
      const key = env("RESEND_API_KEY");
      if (!key || !to) return false;
      const name = String(opts.fromName || "").replace(/[\r\n"<>]/g, "").trim().slice(0, 80);
      const msg = { from: (name ? '"' + name + '"' : "Avante Travel") + " <bookings@go.avantetravel.co.za>", to: emailList(to, 20), subject, html };
    if (!msg.to.length) return false;
      if (opts.replyTo && emailList(opts.replyTo).length) msg.reply_to = emailList(opts.replyTo);
      try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(msg) }); return r.ok; } catch (_) { return false; }
    },
  });
  try {
    if (request.method === "GET") {
      const photo = url.searchParams.get("photo");
      if (photo) {
        const p = await core.frontPhoto(photo);
        if (!p) return new Response("Not found", { status: 404, headers: cors });
        return new Response(p.data, { headers: { "content-type": p.type, "x-content-type-options": "nosniff", "cache-control": "public, max-age=86400", "netlify-vary": "query=photo", ...cors } });
      }
      // A Google photo (by its reference) or a photo from the shared photo library,
      // for things to do (lib/act-photos.js). Browsers keep them a day.
      const gref = url.searchParams.get("gphoto"), lid = url.searchParams.get("libphoto");
      if (gref) {
        if (!GREF.test(gref)) return new Response("Bad photo", { status: 400, headers: cors });
        // Only Avante's own Google photos (the ones in the library).
        const img = await libGooglePhoto(gref, env("GOOGLE_PLACES_API_KEY")).catch(() => null);
        if (!img) return new Response("Not found", { status: 404, headers: cors });
        // Google's photos are never kept by Netlify's CDN (Google's terms): only the visitor's browser, for a day.
        return new Response(img.data, { headers: { "content-type": img.type, "cache-control": "public, max-age=86400", "netlify-cdn-cache-control": "no-store", ...cors } });
      }
      if (lid) {
        if (!LIBID.test(lid)) return new Response("Bad photo", { status: 400, headers: cors });
        // &th=1: the library's thumbnail (photo chooser grids).
        const img = await libImage(lid, url.searchParams.get("th") === "1").catch(() => null);
        if (!img) return new Response("Not found", { status: 404, headers: cors });
        // A library photo never changes under its id, so Netlify's CDN keeps it for 30 days and
        // serves it without this function or the library being asked again (Jean, 2026-10-23).
        return new Response(img.data, { headers: { "content-type": img.type, "cache-control": "public, max-age=604800",
          "netlify-cdn-cache-control": "public, durable, s-maxage=2592000", "netlify-vary": "query=libphoto|th", ...cors } });
      }
      const prop = await core.propertyBySlug(url.searchParams.get("slug") || "");
      if (!prop) return json({ ok: false, error: "This page isn't available." }, 404);
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      if (from && to) return json(Object.assign({ ok: true }, await core.publicAvailability(prop, from, to)));

      const guest = url.searchParams.get("guest") === "1", card = url.searchParams.get("card") === "1";
      // Wi-Fi and house info only with the guest page's secret key (on the room card QR).
      const keyOk = (guest || card) && core.guestKeyOk(prop, url.searchParams.get("key") || "");
      if (!card) context.waitUntil(core.fsStat(prop, guest ? "guestVisits" : "visits").catch(() => {}));
      const out = await stayPayload(core, prop, { store, origin: url.origin, km: url.searchParams.get("km"), later: (p) => context.waitUntil(p) });
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

// cache: "manual": the CDN may keep the photos this function marks as keepable; the page data is no-store.
export const config = { path: "/api/stay", cache: "manual" };

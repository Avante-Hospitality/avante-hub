// /api/property — Property Affiliate: connect a Stock Network site, read
// availability, book / find / change / cancel, channel settings, and the
// 15-minute channel sync (called by netlify/functions/pa-channel-sync.mjs).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { emailList } from "./lib/emails.js";
import { createCore, PAError } from "./lib/pa-core.js";
import { feedBySite, feedSearch, feedRowByResort } from "./lib/sn-feed.js";
import { createActivities } from "./lib/pa-activities.js";
import { stayPayload, resortInfo } from "./lib/stay-payload.js";
import { treeAreaList } from "./lib/tree-place.js";
import { libraryPhotos, googlePhotos } from "./lib/act-photos.js";
import { searchPlacePhotos } from "./lib/places-images.js";
import { reviewsConfig } from "./lib/review-app.js";
import { isAdminToken } from "./lib/admin-session.js";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, x-pa-sync-secret" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  // Guest emails go out under the property's name, with replies going to
  // the property's own email address (opts.fromName / opts.replyTo).
  const sendEmail = async (to, subject, html, opts = {}) => {
    const key = env("RESEND_API_KEY");
    if (!key || !to) return false;
    const name = String(opts.fromName || "").replace(/[\r\n"<>]/g, "").trim().slice(0, 80);
    const msg = { from: (name ? '"' + name + '"' : "Avante Travel") + " <bookings@go.avantetravel.co.za>", to: emailList(to, 20), subject, html };
    if (!msg.to.length) return false;
    if (opts.replyTo && emailList(opts.replyTo).length) msg.reply_to = emailList(opts.replyTo);
    try {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify(msg) });
      return r.ok;
    } catch (_) { return false; }
  };
  // How this request's Stock Network calls show in Admin > SN Calls.
  const act = String(body.action || "");
  const snSource = act === "runSync" ? "Channel sync (every 15 min)" : body.adminSite ? "Admin · " + act : "Property affiliate · " + act;
  const core = createCore({
    snSource,
    store: getStore({ name: "property-affiliate", consistency: "strong" }),
    resortStore: getStore({ name: "resort-list", consistency: "strong" }),
    encKey: env("PA_ENC_KEY"),
    baseUrl: new URL(request.url).origin,
    // Avante Reviews app: review links for after-stay messages.
    reviews: reviewsConfig(),
    // Same stores auth-api.js uses: the affiliate's password hash and profile.
    affiliates: {
      getAuth: (aff) => getStore({ name: "affiliate-auth", consistency: "strong" }).get(aff, { type: "json" }),
      getProfile: (aff) => getStore({ name: "affiliates-directory", consistency: "strong" }).get(aff, { type: "json" }),
    },
    sendEmail,
    // Stock Network's live property feed, for properties newer than the hub's resort list.
    snFeed: { bySite: (nr, id) => feedBySite(nr, id), search: (q, max) => feedSearch(q, max), byResort: (rid) => feedRowByResort(rid) },
    listingStore: getStore({ name: "property-listings", consistency: "strong" }),
    // Admin's address (Admin > Property Listings settings): escalated cancellations go there.
    adminEmail: async () => ((await getStore({ name: "property-settings", consistency: "strong" }).get("config", { type: "json" }).catch(() => null)) || {}).notificationEmail || "",
  });
  try {
    const a = String(body.action || "");
    if (a === "runSync") {
      const secret = env("PA_SYNC_SECRET");
      if (!secret || request.headers.get("x-pa-sync-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
      return json({ ok: true, result: await core.runSync() });
    }
    if (a === "connect") return json(Object.assign({ ok: true }, await core.connect(body)));
    if (a === "findResort") return json(Object.assign({ ok: true }, await core.findResort(body.q)));
    // Hub login: is this affiliate a property affiliate, and open its property on this device.
    if (a === "affStatus") return json(Object.assign({ ok: true }, await core.affStatus(body.aff)));
    if (a === "resume") return json(Object.assign({ ok: true }, await core.resume(body.aff, body.password)));
    // Admin > Property Listings > Set up > Channels (Jean, 2026-10-25): Avante
    // links a property's channel calendars itself, without logging in as the
    // property. An admin login, and only the channel actions.
    if (body.adminSite) {
      if (!(await isAdminToken(body.adminToken))) return json({ ok: false, error: "Not authenticated." }, 401);
      const ADMIN_ACTIONS = ["channels", "saveChannelLinks", "channelEvents", "addChannelEvent", "dismissChannelEvent", "syncNow"];
      if (ADMIN_ACTIONS.indexOf(a) < 0) return json({ ok: false, error: "Admin can't do that here." }, 403);
      const siteId = String(body.adminSite).trim().slice(0, 64);
      const prop = await getStore({ name: "property-affiliate", consistency: "strong" }).get("site:" + siteId, { type: "json" }).catch(() => null);
      if (!prop || !prop.credsEnc) return json({ ok: false, error: "This property isn't connected yet: do Connect it first." }, 404);
      if (prop.channel) return json({ ok: false, error: "A channel property's calendar comes from its channel manager." }, 403);
      switch (a) {
        case "channels": return json(Object.assign({ ok: true }, await core.channelsView(prop)));
        case "saveChannelLinks": return json(Object.assign({ ok: true }, await core.saveSettings(prop, { channels: body.channels || {} })));
        case "channelEvents": return json(Object.assign({ ok: true }, await core.channelEvents(prop)));
        case "addChannelEvent": return json(Object.assign({ ok: true }, await core.addChannelEvent(prop, body.unit, body.channel, body.uid)));
        case "dismissChannelEvent": return json(Object.assign({ ok: true }, await core.dismissChannelEvent(prop, body.unit, body.channel, body.uid)));
        case "syncNow": return json({ ok: true, result: await core.syncProperty(prop) });
      }
    }
    const t0 = Date.now();
    // Opening: start reading the saved grid while the login is checked (token carries the site id).
    const preSite = a === "open" ? core.siteOfToken(body.token) : null;
    const pre = preSite ? core.prefetch(preSite) : null;
    const prop = await core.auth(body.token, { repairLink: a === "status" });
    const authMs = Date.now() - t0;
    // A Channel Property Affiliate never gets what its channel manager
    // (NightsBridge etc.) already does (Jean, 2026-10-13; see pa-core.js syncChannelFlag).
    const CHANNEL_BLOCKED = ["book", "markPaid", "channels", "channelHelp", "channelEvents", "addChannelEvent", "dismissChannelEvent", "unitNotice", "syncNow",
      "guests", "messages", "saveMessages", "prepareMessage", "markMessage", "emailNow", "inHouse", "emailInHouse", "checkIn", "saveContact"];
    if (prop.channel && CHANNEL_BLOCKED.indexOf(a) > -1) return json({ ok: false, error: "Your channel manager (e.g. NightsBridge) already does this, so it isn't part of the hub for channel properties." }, 403);
    // No front store (its Promotions embed link instead), and Activities only when
    // admin has switched it on (Jean, 2026-10-20).
    const isFront = a === "saveFrontStore" || /^(front|uploadFront|removeFront)/.test(a);
    if (prop.channel && isFront) return json({ ok: false, error: "Channel properties don't have a front store. Put your Promotions embed link (Affiliate Marketing) on your website." }, 403);
    if (prop.channel && a.startsWith("act") && !prop.chActs) return json({ ok: false, error: "Activities isn't switched on for your property yet. Ask Avante Travel." }, 403);
    // Activities the property sells to guests, with the supplier's reference numbers.
    if (a.startsWith("act")) {
      const acts = createActivities({
        store: getStore({ name: "property-affiliate", consistency: "strong" }),
        sendEmail,
        getHubActivities: () => getStore({ name: "map-activities", consistency: "strong" }).get("all", { type: "json" }).catch(() => []),
        getPin: async (p) => {
          const rl = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
          return ((rl && rl.resorts) || []).find((r) => r && r.resortId === p.resortId) || null;
        },
      });
      // Replies go to the front store email, else to who the property chose (owner / contact person / both).
      const replyTo = (prop.frontStore && emailList(prop.frontStore.email).length && prop.frontStore.email) || core.propertyTo(prop);
      switch (a) {
        case "activities": return json(Object.assign({ ok: true }, await acts.view(prop)));
        case "actSave": return json(Object.assign({ ok: true }, await acts.save(prop, body.activity || {})));
        case "actDelete": return json(Object.assign({ ok: true }, await acts.remove(prop, body.id)));
        case "actNearby": return json(Object.assign({ ok: true }, await acts.nearby(prop, body.km)));
        case "actBook": return json(Object.assign({ ok: true }, await acts.book(prop, body.booking || {})));
        case "actUpdate": return json(Object.assign({ ok: true }, await acts.update(prop, body.ref, body.change || {})));
        case "actSend": return json(Object.assign({ ok: true }, await acts.sendRequest(prop, body.ref, replyTo)));
      }
    }
    switch (a) {
      case "status": await core.syncContact(prop); return json({ ok: true, property: core.publicProperty(prop) });
      // Opening the property: who it is plus the last saved grid in one call (no Stock Network call).
      case "open": {
        const timing = { _t0: t0 };
        await core.syncContact(prop);   // once per property: the listing's contact details
        const av = await core.availability(prop, body.from || core.firstBookable(prop), body.to, { cached: true, timing, pre });
        // Older logins get a new token in the faster format (the old one keeps working).
        const newToken = preSite ? undefined : await core.newSession(prop);
        delete timing._t0; timing.login = authMs; timing.total = Date.now() - t0;
        return json({ ok: true, property: core.publicProperty(prop), availability: av, timing, newToken });
      }
      case "disconnect": return json(await core.disconnect(body.token));
      case "availability": {
        const timing = { _t0: t0 };
        await core.syncContact(prop);   // once per property: the listing's contact details
        const av = await core.availability(prop, body.from, body.to, { timing });
        delete timing._t0; timing.login = authMs; timing.total = Date.now() - t0;
        return json(Object.assign({ ok: true, timing }, av));
      }
      case "search": return json(Object.assign({ ok: true }, await core.search(prop, body.checkIn, body.checkOut)));
      case "book": return json(Object.assign({ ok: true }, await core.book(prop, body)));
      case "cancel": return json(Object.assign({ ok: true }, await core.cancel(prop, body.ref)));
      case "cancelUnit": return json(Object.assign({ ok: true }, await core.cancelUnit(prop, body.ref, body.unit)));
      case "edit": return json(Object.assign({ ok: true }, await core.edit(prop, body.ref, body.change || {})));
      case "find": return json(Object.assign({ ok: true }, await core.find(prop, body.q)));
      case "channels": return json(Object.assign({ ok: true }, await core.channelsView(prop)));
      case "channelHelp": return json(Object.assign({ ok: true }, await core.requestChannelHelp(prop, body)));
      case "payInfo": return json(Object.assign({ ok: true }, await core.payInfo(prop, body.ref)));
      case "markPaid": return json(Object.assign({ ok: true }, await core.markPaidEft(prop, body.ref, body.type)));
      case "decide": return json(Object.assign({ ok: true }, await core.decide(prop, body.ref, !!body.accept, body.reason)));
      case "saveSettings": return json(Object.assign({ ok: true }, await core.saveSettings(prop, body)));
      case "channelEvents": return json(Object.assign({ ok: true }, await core.channelEvents(prop)));
      case "addChannelEvent": return json(Object.assign({ ok: true }, await core.addChannelEvent(prop, body.unit, body.channel, body.uid)));
      case "dismissChannelEvent": return json(Object.assign({ ok: true }, await core.dismissChannelEvent(prop, body.unit, body.channel, body.uid)));
      case "unitNotice": return json(Object.assign({ ok: true }, await core.resolveUnitNotice(prop, body.name, body.from)));
      case "saveContact": return json(Object.assign({ ok: true }, await core.saveContact(prop, body.ref, body.contact || {})));
      case "checkIn": return json(Object.assign({ ok: true }, await core.checkIn(prop, body.ref, !!body.on)));
      case "guests": return json(Object.assign({ ok: true }, await core.guests(prop)));
      case "messages": return json(Object.assign({ ok: true }, await core.messagesView(prop)));
      case "saveMessages": return json(Object.assign({ ok: true }, await core.saveMessages(prop, body)));
      case "prepareMessage": return json(Object.assign({ ok: true }, await core.prepareMessage(prop, body.ref, body.kind, body.text)));
      case "markMessage": return json(Object.assign({ ok: true }, await core.markMessage(prop, body.ref, body.kind, body.state, body.text)));
      // Front store (/stay/<slug>): settings, photos, link, stats.
      case "frontStore": {
        // Stock Network's photos for the photo picker (same cache the front store uses).
        const info = await resortInfo(getStore({ name: "property-affiliate", consistency: "strong" }), prop);
        return json(Object.assign({ ok: true, snPhotos: (info && info.images) || [], snDescription: (info && info.description) || "" }, await core.frontStoreView(prop)));
      }
      case "saveFrontStore": return json(Object.assign({ ok: true }, await core.saveFrontStore(prop, body.frontStore || {})));
      // Front store builder (Jean, 2026-10-13): the page exactly as guests see
      // it (also while it's switched off, and with the hidden activities), for
      // the live preview; and Google photos of a place, to use on the page.
      case "frontPreview": {
        const st = getStore({ name: "property-affiliate", consistency: "strong" });
        const pv = await stayPayload(core, prop, { store: st, origin: new URL(request.url).origin, km: body.km, all: true, actPlace: body.actPlace });
        pv.offers = await core.publicOffers(prop, getStore({ name: "promo-hooks", consistency: "strong" })).catch(() => []);
        return json(Object.assign(pv, { ok: true }));
      }
      // Photo choices for one thing to do: the shared library first; Google
      // (its photos then go into the library) when asked, or when the library has none.
      case "frontActPhotos": {
        const a = body.act || {}, act = { id: String(a.id || "").slice(0, 80), name: String(a.name || "").slice(0, 120), area: String(a.area || "").slice(0, 80), latitude: +a.latitude || null, longitude: +a.longitude || null };
        const library = body.google ? [] : await libraryPhotos(act);
        let google = null, gErr = "";
        if (body.google || !library.length) { const g = await googlePhotos(act, { query: String(body.query || "").trim().slice(0, 200) || undefined, limit: 6 }); if (g.ok) google = g.photos; else gErr = g.error; }
        return json({ ok: true, library, google, googleError: gErr });
      }
      case "frontAreas": return json({ ok: true, areas: await treeAreaList(new URL(request.url).origin) });
      case "frontGoogle": {
        const q = String(body.query || "").trim().slice(0, 200);
        if (!q) return json({ ok: false, error: "Type what to search for." }, 400);
        const r = await searchPlacePhotos(q, Deno.env.get("GOOGLE_PLACES_API_KEY") || "", Math.min(9, Number(body.limit) || 6));
        if (!r.ok) return json({ ok: false, error: r.reason === "ZERO_RESULTS" ? "Google has no photos for that. Try other words." : "Google photos didn't work this time (" + (r.message || r.reason) + ")." }, 200);
        return json({ ok: true, place: r.place, images: r.images.map((x) => ({ dataUri: x.dataUri, credit: x.attribution })) });
      }
      case "uploadFrontPhoto": return json(Object.assign({ ok: true }, await core.uploadFrontPhoto(prop, body.dataUrl, body.kind)));
      case "removeFrontPhoto": return json(Object.assign({ ok: true }, await core.removeFrontPhoto(prop, body.url)));
      case "emailNow": return json(Object.assign({ ok: true }, await core.emailNow(prop, body.ref, body.kind, body.text, body.subject)));
      case "inHouse": return json(Object.assign({ ok: true }, await core.inHouse(prop)));
      case "emailInHouse": return json(Object.assign({ ok: true }, await core.emailInHouse(prop, body)));
      case "propertyReviewLink": return json(Object.assign({ ok: true }, await core.propertyReviewLink(prop, body.ref)));
      case "seedDemo": return json(Object.assign({ ok: true }, await core.seedDemo(prop)));
      case "clearDemo": return json(Object.assign({ ok: true }, await core.clearDemo(prop)));
      case "syncNow": return json({ ok: true, result: await core.syncProperty(prop) });
      default: return json({ ok: false, error: "unknown action" }, 400);
    }
  } catch (e) {
    const status = e instanceof PAError ? e.status : 500;
    return json({ ok: false, error: e.message || "Something went wrong", detail: e.extra || undefined }, status);
  }
};

export const config = { path: "/api/property" };

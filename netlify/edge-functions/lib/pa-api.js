// /api/property — Property Affiliate: connect a Stock Network site, read
// availability, book / find / change / cancel, channel settings, and the
// 15-minute channel sync (called by netlify/functions/pa-channel-sync.mjs).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { createCore, PAError } from "./lib/pa-core.js";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, x-pa-sync-secret" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  const core = createCore({
    store: getStore({ name: "property-affiliate", consistency: "strong" }),
    resortStore: getStore({ name: "resort-list", consistency: "strong" }),
    encKey: env("PA_ENC_KEY"),
    baseUrl: new URL(request.url).origin,
  });
  try {
    const a = String(body.action || "");
    if (a === "runSync") {
      const secret = env("PA_SYNC_SECRET");
      if (!secret || request.headers.get("x-pa-sync-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
      return json({ ok: true, result: await core.runSync() });
    }
    if (a === "connect") return json(Object.assign({ ok: true }, await core.connect(body)));
    const prop = await core.auth(body.token);
    switch (a) {
      case "status": return json({ ok: true, property: core.publicProperty(prop) });
      case "disconnect": return json(await core.disconnect(body.token));
      case "availability": return json(Object.assign({ ok: true }, await core.availability(prop, body.from, body.to)));
      case "search": return json(Object.assign({ ok: true }, await core.search(prop, body.checkIn, body.checkOut)));
      case "book": return json(Object.assign({ ok: true }, await core.book(prop, body)));
      case "cancel": return json(Object.assign({ ok: true }, await core.cancel(prop, body.ref)));
      case "cancelUnit": return json(Object.assign({ ok: true }, await core.cancelUnit(prop, body.ref, body.unit)));
      case "edit": return json(Object.assign({ ok: true }, await core.edit(prop, body.ref, body.change || {})));
      case "find": return json(Object.assign({ ok: true }, await core.find(prop, body.q)));
      case "channels": return json(Object.assign({ ok: true }, core.channelsView(prop)));
      case "saveSettings": return json(Object.assign({ ok: true }, await core.saveSettings(prop, body)));
      case "channelEvents": return json(Object.assign({ ok: true }, await core.channelEvents(prop)));
      case "addChannelEvent": return json(Object.assign({ ok: true }, await core.addChannelEvent(prop, body.unit, body.channel, body.uid)));
      case "syncNow": return json({ ok: true, result: await core.syncProperty(prop) });
      default: return json({ ok: false, error: "unknown action" }, 400);
    }
  } catch (e) {
    const status = e instanceof PAError ? e.status : 500;
    return json({ ok: false, error: e.message || "Something went wrong", detail: e.extra || undefined }, status);
  }
};

export const config = { path: "/api/property" };

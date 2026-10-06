// /ical/{feedToken}/{unit}/{channel}.ics — per-unit, per-channel calendar that
// Airbnb / Booking.com / LekkeSlaap import. Blocks nights booked on Stock
// Network or on another channel; never blocks nights not given to SN.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { createCore } from "./lib/pa-core.js";

export default async (request) => {
  const m = /^\/ical\/([a-f0-9]{20,60})\/([a-z0-9-]{1,60})\/([a-z]{3,10})\.ics$/.exec(new URL(request.url).pathname);
  if (!m) return new Response("Not found", { status: 404 });
  const core = createCore({ store: getStore({ name: "property-affiliate", consistency: "strong" }), encKey: "" });
  const ics = await core.icalFeed(m[1], m[2], m[3]);
  if (!ics) return new Response("Not found", { status: 404 });
  return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/ical/*" };

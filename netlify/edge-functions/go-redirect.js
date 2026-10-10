import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { SHORT_LINK_HOST } from "./lib/short-link.js";
import { toHolidayBuilderUrl } from "./lib/booking-link.js";
import { withTreePath } from "./lib/tree-place.js";

const FALLBACK_URL = "https://stocknetwork-affiliate-link-builder.netlify.app/hub.html";

export default async (request, context) => {
  const url = new URL(request.url);

  // Every other host this site answers on (the main netlify.app domain,
  // deploy previews, etc.) is left completely untouched by this function
  // — it only ever acts when a request actually arrives on the branded
  // short-link domain.
  if (url.hostname !== SHORT_LINK_HOST) {
    return context.next();
  }

  const slug = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");

  if (!slug) {
    return Response.redirect(FALLBACK_URL, 302);
  }

  const store = getStore({ name: "short-links", consistency: "strong" });

  try {
    const record = await store.get(slug, { type: "json" });

    if (!record || !record.url) {
      // Every real page on this domain (hub.html, admin.html, the various
      // onboarding/application forms, etc.) reaches this function too, since
      // it's a catch-all on go.avantetravel.co.za. A slug that isn't a known
      // short link almost always means "this is a real page, not a short
      // link" — so it falls through to normal static serving rather than
      // hard-erroring. Genuinely nonexistent paths still end up 404ing
      // normally once nothing (short link or real file) matches them.
      return context.next();
    }

    // Count the click without holding up the redirect.
    context.waitUntil(
      store.setJSON(slug, {
        ...record,
        clicks: (record.clicks || 0) + 1,
        lastClickAt: new Date().toISOString(),
      })
    );

    // Short links made before the holiday builder switch still point at the
    // old Stock Network portal — send those to the holiday builder search
    // screen for the same site, dates and area instead.
    // A property link also gets its location tree path if it lacks one.
    let target = toHolidayBuilderUrl(record.url);
    try { target = await withTreePath(target, url.origin); } catch (e) { /* as saved */ }
    return Response.redirect(target, 302);
  } catch (err) {
    return new Response("Something went wrong resolving this link.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
};

export const config = { path: "/*" };

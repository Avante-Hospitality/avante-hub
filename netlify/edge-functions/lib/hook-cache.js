// CDN caching for the front store's hook list (GET /api/hook?aff=<id>&list=1,
// see hook-api.js), the cache purge that keeps it fresh after a save, and
// the version that lets flyer pictures be cached for a long time.
//
// The list is cached on Netlify's CDN for a minute (and served stale for up to
// five more while it refreshes in the background), tagged so a save can clear
// it straight away:
//   "hooks"        every front store (admin's Default Hooks show on all of them)
//   "hooks-<aff>"  one affiliate's front store
// Purging needs a Netlify access token in the environment variable
// NETLIFY_PURGE_API_TOKEN (Project configuration > Environment variables,
// scope: Functions). Without it nothing breaks: front stores just pick up a
// change within about a minute instead of straight away.

const ADMIN_KEY = "__admin__"; // same reserved key as hook-api.js
const ALL_TAG = "hooks";
// Affiliate ids are Stock Network GUIDs (or ADMIN_KEY). Anything else is not
// cached, so a made-up ?aff= can't put odd text into a cache tag header.
const CACHEABLE_AFF = /^[A-Za-z0-9_-]{1,64}$/;
const PURGE_URL = "https://api.netlify.com/api/v1/purge";

const affTag = (aff) => "hooks-" + aff.toLowerCase(); // tags are case-insensitive

// Response headers for one affiliate's front store hook list.
export function hookListCacheHeaders(aff) {
  if (!CACHEABLE_AFF.test(aff)) return { "cache-control": "no-store" };
  return {
    "cache-control": "public, max-age=0, must-revalidate", // browsers always ask; the CDN copy below is what a save purges
    "netlify-cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=300",
    "netlify-cache-tag": ALL_TAG + "," + affTag(aff),
  };
}

function env(name) {
  return (typeof Netlify !== "undefined" ? Netlify.env.get(name) : Deno.env.get(name)) || "";
}

let warnedNoToken = false;

async function purge(context, aff) {
  if (!CACHEABLE_AFF.test(aff)) return;
  const token = env("NETLIFY_PURGE_API_TOKEN");
  const siteId = (context && context.site && context.site.id) || env("SITE_ID");
  if (!token || !siteId) {
    if (!warnedNoToken) {
      warnedNoToken = true;
      console.warn("hook-cache.js: NETLIFY_PURGE_API_TOKEN (or the site id) is not available — front stores show hook changes within about a minute instead of straight away.");
    }
    return;
  }
  const body = JSON.stringify({ site_id: siteId, cache_tags: [aff === ADMIN_KEY ? ALL_TAG : affTag(aff)] });
  const send = () => fetch(PURGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf8", authorization: "Bearer " + token },
    body,
  });
  let res = await send();
  // Each tag can only be purged twice every 5 seconds — wait once and retry.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 5000));
    res = await send();
  }
  if (!res.ok) throw new Error("purge API returned " + res.status);
}

// A short version for a hook's current picture, so the front store can ask
// for a copy browsers and the Image CDN keep for a year
// (/api/hook-image/v/<aff>/<hook>/<version>, see hook-image.js). It changes
// whenever the picture does: every upload path records the picture's content
// hash (imageHash); a record without one falls back to its save times.
// Empty when there is nothing to go on, or when the hook rotates through
// gallery photos (a different picture per request) — those keep the plain,
// short-cached /api/hook-image URL.
export function hookImageVersion(record) {
  if (!record || (record.galleryCount || 0) > 0) return "";
  const basis = record.imageHash || [record.updatedAt, record.savedAt].filter(Boolean).join("|");
  if (!basis) return "";
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < basis.length; i++) h = Math.imul(h ^ basis.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + basis.length.toString(36);
}

// Clears the cached front store hook list(s) a write to hook `aff:<n>` changes:
// admin's records clear every front store, an affiliate's only their own.
// Runs after the response (context.waitUntil); a failure is logged, and the
// cache then simply expires on its own within about a minute.
export function purgeHookListCache(context, aff) {
  const job = purge(context, aff).catch((e) => {
    console.error("hook-cache.js: purge failed for " + aff + " —", String((e && e.message) || e));
  });
  if (context && typeof context.waitUntil === "function") context.waitUntil(job);
  return job;
}

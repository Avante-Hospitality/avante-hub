// Reading every record in a Netlify Blobs store, fast.
//
// Blobs has no bulk get: reading N records is N get() round trips. Two things
// keep that cheap here:
//  1. The gets run in parallel, a few at a time (mapWithConcurrency).
//  2. Each edge isolate remembers the records it has read, by key and etag.
//     store.list() returns every key's current etag (strong consistency), so
//     a record is only fetched again once it has changed since this isolate
//     last read it. Nothing is served stale: a changed, added or removed
//     record shows straight away — the list call is still made every time.
// The cache keeps each record's JSON text and parses it on every read, so a
// caller always gets its own objects to change, the same as store.get().
//
// Lives in netlify/edge-functions/lib/ so Netlify doesn't route it as its own
// function. No @netlify/blobs import: works with any store object (and a
// Map-based stub in tests).

const DEFAULT_CONCURRENCY = 20;

// Runs `fn` over `items` with at most `concurrency` calls in flight; results
// keep the order of `items`. A rejection from `fn` rejects the whole call
// (workers already mid-await are not cancelled), so a caller doing writes in
// `fn` must catch its own errors per item.
export async function mapWithConcurrency(items, fn, concurrency) {
  concurrency = concurrency || DEFAULT_CONCURRENCY;
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Store names read in full by more than one edge function, so every reader
// uses the same name (and so shares one cache within an isolate).
export const LISTINGS_STORE = "property-listings";
export const AFFILIATES_STORE = "affiliates-directory";
export const TRANSACTIONS_STORE = "stocknetwork-transactions";

const caches = new Map(); // cacheName -> Map(key -> { etag, text })

function parse(text, strict) {
  // A test stub may hand back the object itself rather than its text.
  if (text && typeof text === "object") return structuredClone(text);
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    if (strict) throw e;
    return null;
  }
}

// Every record in `store` (or only the keys under `prefix`), as
// [{ key, etag, value }] in list order; value is null where a record couldn't
// be read. cacheName: the store's name, to reuse this isolate's copies of
// unchanged records (leave it out to always fetch). strict: a failed read
// rejects the call instead of giving null.
export async function readAllEntries(store, { prefix = "", cacheName = "", strict = false } = {}) {
  const { blobs = [] } = await store.list(prefix ? { prefix } : undefined);
  let cache = null;
  if (cacheName) {
    cache = caches.get(cacheName);
    if (!cache) caches.set(cacheName, (cache = new Map()));
  }
  const texts = await mapWithConcurrency(blobs, async (b) => {
    const hit = cache && b.etag ? cache.get(b.key) : null;
    if (hit && hit.etag === b.etag) return hit.text;
    let text;
    try {
      text = await store.get(b.key, { type: "text" });
    } catch (e) {
      if (strict) throw e;
      return null;
    }
    if (cache && b.etag && typeof text === "string") cache.set(b.key, { etag: b.etag, text });
    return text;
  });
  // A full listing shows which keys were deleted: forget them.
  if (cache && !prefix) {
    const listed = new Set(blobs.map((b) => b.key));
    for (const k of cache.keys()) if (!listed.has(k)) cache.delete(k);
  }
  return blobs.map((b, i) => ({ key: b.key, etag: b.etag || "", value: parse(texts[i], strict) }));
}

// Just the records, in list order (null where one couldn't be read).
export async function readAllRecords(store, opts) {
  return (await readAllEntries(store, opts)).map((e) => e.value);
}

// Every property listing in the property-listings store, missing ones left
// out, in list order. Shared by map-api.js, property-onboarding-api.js,
// tree-lookup-api.js, lib/pa-core.js and lib/estates.js. strict: a failed
// read fails the call (default: that listing is left out).
export async function allListings(listingStore, { strict = false } = {}) {
  return (await readAllRecords(listingStore, { cacheName: LISTINGS_STORE, strict })).filter(Boolean);
}

// A fingerprint of a listing's keys and etags: it changes whenever any record
// is added, changed or removed. "" when the store gives no etags (then
// changes can't be told apart and the caller must not rely on it).
export async function entriesFingerprint(entries) {
  if (entries.some((e) => !e.etag)) return "";
  const text = entries.map((e) => e.key + "\u0000" + e.etag).join("\u0001");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

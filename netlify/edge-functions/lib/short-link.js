// Shared with hook-api.js (resolving an admin-set booking link before
// personalizing it) and admin-api.js (auditing/fixing hooks whose booking
// and landing links got collapsed into the same short link — see
// fixCollapsedHookLinks). Kept here so both can't drift on what counts as
// "one of our own short links" or how one gets resolved.

// Host used by the link shortener (go-redirect.js / shorten-api.js).
export const SHORT_LINK_HOST = "go.avantetravel.co.za";

export function isShortLink(rawUrl) {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl).hostname === SHORT_LINK_HOST;
  } catch (e) {
    return false;
  }
}

// Resolves one of our own go.avantetravel.co.za short links back to its
// original long URL via the short-links store. Falls back to the original
// URL untouched if it isn't one of ours, has no matching record, or the
// lookup fails — callers can detect "didn't resolve to anything new" by
// comparing the result back to rawUrl.
export async function resolveShortLink(rawUrl, shortLinksStore) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.hostname !== SHORT_LINK_HOST) return rawUrl;
    const slug = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!slug) return rawUrl;
    const record = await shortLinksStore.get(slug, { type: "json" });
    return record && record.url ? record.url : rawUrl;
  } catch (e) {
    return rawUrl;
  }
}

// Slug shape and per-affiliate index — shared by shorten-api.js's own POST
// /api/shorten handler and the two helpers below (admin-api.js's bulk
// short-code generator), so neither can drift from the other on what a
// slug looks like or how the per-affiliate index is keyed/capped.
// Every short link name: letters, numbers and hyphens, 2-40 long (random ones too).
export const isShortSlug = (s) => /^[a-zA-Z0-9-]{2,40}$/.test(String(s || ""));
export const SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/l/I
export const RANDOM_SLUG_LEN = 6;
export const MAX_LINKS_PER_AFFILIATE = 300; // cap the per-affiliate index so it can't grow unbounded

export function randomSlug() {
  let out = "";
  for (let i = 0; i < RANDOM_SLUG_LEN; i++) {
    out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return out;
}

export function affIndexKey(aff) {
  return "aff:" + aff;
}

// Adds `slug` to the front of `aff`'s short-link index (deduping any
// existing entry for the same slug, capped at MAX_LINKS_PER_AFFILIATE), so
// it shows up in that affiliate's own short-link listing (GET
// /api/shorten?aff=...). Shared by shorten-api.js's POST handler and
// createShortLink below, so the two write the index the same way.
//
// This read-modify-write isn't atomic (no compare-and-swap in Netlify
// Blobs) — two callers updating the same affiliate's index at the same
// time (e.g. a bulk generateShortCodes run overlapping the affiliate's own
// "Shorten this link" click) can still race, with one write silently
// overwritten by the other's. Mitigated, not fully eliminated, by
// re-reading after the write and retrying if our slug isn't there —
// narrows the lost-update window without a real atomic primitive to close
// it completely. A slug that still isn't recorded after all attempts still
// works (its own record exists and resolves fine); it just may not appear
// in this affiliate's listing until touched again.
export async function addToAffIndex(shortLinksStore, aff, slug) {
  if (!aff) return;
  const indexKey = affIndexKey(aff);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existingSlugs = (await shortLinksStore.get(indexKey, { type: "json" })) || [];
    const updatedSlugs = [slug, ...existingSlugs.filter((s) => s !== slug)].slice(0, MAX_LINKS_PER_AFFILIATE);
    await shortLinksStore.setJSON(indexKey, updatedSlugs);

    const verify = (await shortLinksStore.get(indexKey, { type: "json" })) || [];
    if (verify.includes(slug)) return;
  }
}

// The two functions below are used by admin-api.js's bulk short-code
// generator (generateShortCodes) — a separate, deliberately independent
// code path from shorten-api.js's own POST /api/shorten handler, which has
// its own (slightly different) custom-alias upsert semantics we don't want
// to entangle with a bulk/idempotent caller.

// Looks for a short link this affiliate already has pointing at exactly
// longUrl, so a bulk/idempotent caller can skip creating a duplicate for
// content that hasn't changed since the last run. Returns null if none
// exists (or aff is empty).
// Small, dependency-free bounded-concurrency helper — deliberately not
// importing lib/booking-stats.js's mapWithConcurrency here so this file
// keeps its existing zero-import footprint (it's pulled into hook-api.js's
// hot GET path, where every extra module is one more cold-start cost).
async function mapBounded(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function findExistingShortLink(shortLinksStore, aff, longUrl) {
  if (!aff || !longUrl) return null;
  const slugs = (await shortLinksStore.get(affIndexKey(aff), { type: "json" })) || [];
  // The index is capped at MAX_LINKS_PER_AFFILIATE (300), and this is
  // called once per hub/hook check (up to 7 times per affiliate) by
  // generateShortCodes' bulk run across many affiliates concurrently —
  // fetching one affiliate's up-to-300 slug records with an unbounded
  // Promise.all could still pile into a large simultaneous burst of Blobs
  // reads across the whole bulk run. Bounded to 20 at a time per call
  // instead, so an affiliate with many existing short links doesn't turn
  // one check into an unbounded read burst.
  const records = await mapBounded(slugs, (slug) => shortLinksStore.get(slug, { type: "json" }), 20);
  for (let i = 0; i < slugs.length; i++) {
    const record = records[i];
    if (record && record.url === longUrl) {
      return { slug: slugs[i], shortUrl: "https://" + SHORT_LINK_HOST + "/" + slugs[i], ...record };
    }
  }
  return null;
}

// Creates a brand-new random-slug short link for longUrl, tagged to aff,
// and indexes it under that affiliate (same index shorten-api.js's own GET
// ?aff= listing reads). Always creates fresh — callers wanting idempotency
// should check findExistingShortLink() first.
//
// Netlify Blobs has no compare-and-swap, so a "check candidate is free,
// then write it" pair isn't atomic — a bulk caller running many of these
// concurrently (see admin-api.js's mapWithConcurrency) could have two
// callers both see the same candidate slug as free and both write it, with
// the second silently clobbering the first's record. Guarded against by
// re-reading immediately after the write and confirming it's still ours;
// if another writer clobbered it in between, that attempt is abandoned and
// a fresh candidate is tried instead of returning a slug that doesn't
// actually point where we think it does. Returns null only if every
// attempt collides or loses that race.
export async function createShortLink(shortLinksStore, longUrl, aff) {
  const record = { url: longUrl, aff: aff || "", createdAt: new Date().toISOString(), clicks: 0 };

  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = randomSlug();
    const existing = await shortLinksStore.get(candidate, { type: "json" });
    if (existing) continue;

    await shortLinksStore.setJSON(candidate, record);

    const verify = await shortLinksStore.get(candidate, { type: "json" });
    if (!verify || verify.url !== record.url || verify.aff !== record.aff) continue; // lost the race — try another slug

    await addToAffIndex(shortLinksStore, aff, candidate);

    return { slug: candidate, shortUrl: "https://" + SHORT_LINK_HOST + "/" + candidate, ...record };
  }
  return null;
}

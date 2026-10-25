// The Avante Reviews app (avante-reviews.onrender.com): one place for its
// settings and for asking it for a property's rating link (Jean, 2026-10-25).
//
// A property's rating link is its page in the review app. It shows the
// property's Google rating until it has 3 Avante guest reviews, then
// Avante's own, so the hub only fetches it once. The review app also finds
// the property's Google listing itself: a sure match (same name, near the
// pin) is saved there; anything less comes back as a suggestion for admin
// to confirm on the listing.
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";

export function reviewsConfig() {
  return { baseUrl: env("REVIEWS_BASE_URL"), secret: env("REVIEWS_SYNC_SECRET"), tenant: env("REVIEWS_TENANT") || "avante" };
}

// What the hub keeps on the listing about its Google match, in plain words for admin.
export const GOOGLE_MATCH = {
  matched: "Found on Google",
  linked: "Found on Google",
  confirmed: "Google listing confirmed",
  needs_confirm: "Check the Google match",
  not_found: "Not found on Google",
  no_key: "Google lookup is switched off in the review app",
};

// -> { ok: true, ratingLink, google, candidate, avanteReviews } or { ok: false, error }
export async function fetchRatingLink(record, { confirmPlaceId = "", fetchImpl = fetch } = {}) {
  const cfg = reviewsConfig();
  if (!cfg.baseUrl || !cfg.secret) return { ok: false, error: "The review app isn't connected to the hub (REVIEWS_BASE_URL / REVIEWS_SYNC_SECRET)." };
  const resortId = String(record.resortId || "").trim().toLowerCase();
  if (!resortId) return { ok: false, error: "The listing has no ResortID yet." };
  let res;
  try {
    res = await fetchImpl(cfg.baseUrl.replace(/\/$/, "") + "/internal/rating-link/" + encodeURIComponent(cfg.tenant), {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-secret": cfg.secret },
      body: JSON.stringify({
        resort_id: resortId, resort_name: record.propertyName || "", site_id: String(record.siteId || ""),
        town: record.city || record.suburb || "", lat: record.latitude || null, lng: record.longitude || null,
        confirm_place_id: confirmPlaceId || undefined,
      }),
    });
  } catch (e) {
    return { ok: false, error: "The review app didn't answer: " + String((e && e.message) || e) };
  }
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.rating_link) return { ok: false, error: d.error || ("The review app answered " + res.status + ".") };
  return { ok: true, ratingLink: d.rating_link, google: d.google || "", candidate: d.candidate || null, avanteReviews: d.avante_reviews || 0 };
}

// Puts the answer on the listing record (the caller saves it). The rating
// link goes on as-is: it is the review app's own link, and the Stock Network
// property file sends it on (sn-export.js, "Rating Link").
export function applyRatingLink(record, r, now) {
  if (!r.ok) {
    record.ratingLinkError = r.error;
    return;
  }
  record.ratingLink = r.ratingLink;
  record.ratingLinkAt = now;
  record.ratingGoogle = r.google;
  record.ratingGoogleCandidate = r.google === "needs_confirm" ? r.candidate : null;
  delete record.ratingLinkError;
}

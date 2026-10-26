// A property's contact details have one home: its Avante listing (Jean,
// 2026-10-26). Property Listings and the property's own hub (Bookings tab)
// show and change the same values. The hub keeps a copy in the property's
// settings for the code that sends emails; every save on either side writes
// both (property-onboarding-api.js pushContactToPa, pa-core.js pushContactToListing).

// [hub settings field, listing field]
export const CONTACT_FIELDS = [
  ["email", "ownerEmail"],
  ["phone", "ownerPhone"],
  ["contactName", "contactName"],
  ["contactPhone", "contactPhone"],
  ["contactEmail", "contactEmail"],
  ["notifyWho", "notifyWho"],
];

const has = (v) => String(v == null ? "" : v).trim() !== "";

// Is listing l the listing of hub property pr (a "site:" record)?
export function listingMatchesProperty(l, pr) {
  if (!l || !pr) return false;
  return !!((l.paSiteId && l.paSiteId === pr.siteId) ||
    (l.resortId && pr.resortId && String(l.resortId).toLowerCase() === String(pr.resortId).toLowerCase()) ||
    (pr.channel && l.channelProperty === "Y" && pr.aff && l.affId === pr.aff));
}

// The listing's contact details, as the hub's settings name them.
export function contactFromListing(l) {
  const out = {};
  CONTACT_FIELDS.forEach(([s, k]) => { out[s] = String((l && l[k]) || ""); });
  if (!out.notifyWho) out.notifyWho = "both";
  return out;
}

// Merges the two when they first meet: the listing wins where it has a value,
// the hub's settings fill what the listing is missing. Returns both sides' values.
export function mergeContact(settings, l) {
  const s = settings || {}, out = {};
  CONTACT_FIELDS.forEach(([sk, lk]) => { out[sk] = has(l && l[lk]) ? String(l[lk]) : String(s[sk] || ""); });
  if (!out.notifyWho) out.notifyWho = "both";
  return out;
}

// Copies hub-settings-shaped contact values c onto a listing (onto = "listing")
// or onto the hub's settings (onto = "settings"). Returns true when something changed.
export function applyContact(target, c, onto) {
  let changed = false;
  CONTACT_FIELDS.forEach(([sk, lk]) => {
    if (c[sk] === undefined) return;
    const k = onto === "listing" ? lk : sk, v = String(c[sk] || "");
    if (String(target[k] || "") !== v) { target[k] = v; changed = true; }
  });
  return changed;
}

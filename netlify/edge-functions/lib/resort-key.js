// A stable identity for one row in the resort-list store (the ~5,900-row
// StockNetwork property master, kept by resorts-api.js's nightly sync).
//
// StockNetwork's own ResortID identifies the physical property; the same
// ResortID can appear under more than one SiteID (StockNetwork lists the
// same resort under multiple booking "sites"), so the pair is what actually
// identifies one listed row — matching resorts-api.js's own within-import
// de-duplication, which already keys on name+siteId+resortId.
//
// Used where the SAME row must resolve to the SAME key, e.g. admin-api.js's
// setResortAffId (the checkboxes ticked in the location tree read this key
// from each property's data-key attribute) and hook-draft.js. (The CSV
// upload that also used it was removed on 2026-10-17: the nightly sync now
// keeps the list.)
//
// Returns "" for a row with no resortId at all. Callers must treat "" as
// "not matchable", never as a real shared key.
export function resortKey(r) {
  const resortId = (r && r.resortId) || "";
  if (!resortId) return "";
  const siteId = (r && r.siteId) || "";
  return resortId + "|" + siteId;
}

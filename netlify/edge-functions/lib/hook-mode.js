// Shared by hook-api.js's GET (the source of truth for what an affiliate's
// storefront actually shows) and admin-api.js's generateShortCodes (which
// needs to know, ahead of time, whether a given affiliate+hook currently
// has anything worth a short code) — one definition of how a hook's mode
// resolves into what should actually be shown, so the two can't drift.
//
// Front store rules (Jean, 2026-10-10):
// - Hooks are unlimited: admin's Default Hooks are numbered 1, 2, 3, …
//   ("__admin__:<n>" records) with no upper limit; an affiliate's own
//   version of hook n lives in "<affId>:<n>".
// - A hook shows only while its promotion is current: its promotion end
//   date (endDate, YYYY-MM-DD — from the hook builder's landing page, or
//   typed in) or, without one, its booking link's check-out (else
//   check-in) date, is today or later. No date at all = always current.
// - Places: 1 = level 1 (the big one), 2–3 = level 2, 4–6 = level 3. A hook
//   can be fixed to a place (`pin`); everything else rotates through the
//   free places. Admin fixes a Default Hook for everyone; an affiliate can
//   fix only a hook they manage themselves, and that wins over admin's.
//   A fixed hook whose promotion ends leaves its place to the rotation.
// - An affiliate can hide any hook on their own front store (`hidden`).

export const PLACE_COUNT = 6;
export const MAX_HOOK_NUMBER = 999;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(raw) {
  if (!raw || !DATE_RE.test(String(raw))) return null;
  const d = new Date(String(raw) + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

function linkParam(bookingUrl, names) {
  if (!bookingUrl) return "";
  try {
    const u = new URL(bookingUrl);
    for (const n of names) {
      const v = u.searchParams.get(n);
      if (v) return v;
    }
  } catch (e) { /* not a URL */ }
  return "";
}

// The check-in date on a booking link — the old Stock Network shape
// (CheckInDT=) or the holiday builder's (checkin=). Links pasted in by hand
// may have none; that's fine, there's then nothing to expire on.
export function parseCheckInDate(bookingUrl) {
  return dateOnly(linkParam(bookingUrl, ["checkin", "CheckInDT"]));
}

export function parseCheckOutDate(bookingUrl) {
  return dateOnly(linkParam(bookingUrl, ["checkout", "CheckOutDT"]));
}

export function todayUTCDateOnly() {
  // South African time (UTC+2), so a promotion ends at local midnight.
  const now = new Date(Date.now() + 2 * 3600e3);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// The last day a hook's promotion runs, or null when it has no date.
export function promotionEnd(record) {
  if (!record) return null;
  return dateOnly(record.endDate) || parseCheckOutDate(record.booking) || parseCheckInDate(record.booking);
}

// True once a hook's promotion end date is behind us.
export function promotionEnded(record) {
  const end = promotionEnd(record);
  return !!end && todayUTCDateOnly() > end;
}

// A valid fixed place (1–6), or 0 for "rotates".
export function cleanPin(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= PLACE_COUNT ? n : 0;
}

export function cleanEndDate(v) {
  return typeof v === "string" && DATE_RE.test(v.trim()) ? v.trim() : "";
}

export function validHookNumber(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_HOOK_NUMBER ? n : 0;
}

// Admin's Default Hook numbers that exist, ascending. `store` is the
// promo-hooks store.
export async function adminHookNumbers(store) {
  const { blobs } = await store.list({ prefix: "__admin__:" });
  const nums = new Set();
  for (const b of blobs) {
    const n = validHookNumber(b.key.slice("__admin__:".length));
    if (n) nums.add(n);
  }
  return [...nums].sort((a, b) => a - b);
}

// Resolves a hook's actual serving mode/source/expired state from its own
// record (the "<affId>:<n>" record — the admin's own "__admin__:<n>"
// record has no mode concept and never goes through this). `mode`
// reflects what the affiliate has explicitly chosen (defaulting to
// "admin" if never set); `source` is what should actually be shown right
// now — a self-managed hook whose promotion has ended falls back to the
// shared admin default (source: "admin") even though its stored `mode`
// still says "self", so callers that care about what's really being
// served must use `source`, not `mode`.
export function resolveHookMode(ownRecord) {
  const mode = (ownRecord && ownRecord.mode) === "self" ? "self" : "admin";
  let source = mode;
  let expired = false;

  if (mode === "self" && promotionEnded(ownRecord)) {
    source = "admin";
    expired = true;
  }

  return { mode, source, expired };
}

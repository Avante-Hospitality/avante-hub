// Shared logic for importing StockNetwork's "Reservation Detail Listing"
// CSV export and turning the resulting per-affiliate transaction records
// into leaderboard/dashboard stats. Used by both admin-api.js (the Admin
// dashboard's import button + Bookings/Leaderboard panel) and auth-api.js
// (an affiliate's own "My Dashboard" tab in the Hub) — kept here so the two
// edge functions can't drift apart on how a booking status or a date gets
// parsed.
//
// Lives in netlify/edge-functions/lib/ rather than directly under
// netlify/edge-functions/ so Netlify doesn't try to auto-discover it as its
// own routed function (same reason hashtag-helper.js lives here too).

import { mapWithConcurrency, readAllRecords, entriesFingerprint, AFFILIATES_STORE, TRANSACTIONS_STORE } from "./blob-records.js";
// Re-exported so the existing importers of this file keep working.
export { mapWithConcurrency };

// Revenue channels — must stay in sync with CHANNEL_KEYS in admin-api.js /
// auth-api.js. Only "accommodation" has a real StockNetwork report feeding
// it right now; the others exist so the same stats/leaderboard code already
// works for them the moment a matching report is imported.
export const CHANNEL_KEYS = ["accommodation", "flights", "activities", "car", "package"];

export const STATUS_KEYS = ["request", "booked", "cancelled", "confirmed", "paid"];

// StockNetwork site numbers whose transactions are tracked (so they still
// show up in Admin) but never count as a competing affiliate on the
// leaderboard. Site 36 is Jean's own "Avante Travel" master account, which
// is also where miscellaneous test bookings land — ranking it alongside
// real affiliates would be misleading. Add more site numbers here later if
// another non-competing/master account is ever set up the same way.
export const LEADERBOARD_EXCLUDED_SITE_NRS = ["36"];

// ---- CSV parsing ----

// Minimal RFC-4180-ish CSV line parser: handles quoted fields, embedded
// commas inside quotes (StockNetwork resort names like "Seasons Golf,
// Leisure and Spa" have these), and "" as an escaped quote. Does not handle
// a quoted field containing a literal newline — StockNetwork's export never
// does that, so it's not worth the extra complexity here.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Parses the whole CSV export into an array of plain objects keyed by
// header name (e.g. row.RefNo, row.Site, row["Total Amount Incl."]).
export function parseStockNetworkCsv(text) {
  const lines = String(text || "")
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = (cells[c] || "").trim();
    rows.push(row);
  }
  return rows;
}

// The report's "Name" column is actually the booking's status (Request /
// Booked / Cancelled / Confirmed / Paid), not a person's name. A non-empty
// "Confirmed On" date always wins and maps to "confirmed", regardless of
// what's in "Name" — that's the one column that can't lie about whether
// payment came in. "Paid" is StockNetwork's own distinct status (seen on
// manually-captured bookings that skip a separate "Confirmed On" step) and
// is tracked as its own status here rather than folded into "confirmed" —
// kept separate throughout (stats, leaderboard, WhatsApp notify-on).
export function normalizeStockNetworkStatus(nameCol, confirmedOnCol) {
  if (confirmedOnCol && String(confirmedOnCol).trim()) return "confirmed";
  const n = String(nameCol || "").trim().toLowerCase();
  if (n === "confirmed") return "confirmed";
  if (n === "booked") return "booked";
  if (n === "cancelled" || n === "canceled") return "cancelled";
  if (n === "request") return "request";
  if (n === "paid") return "paid";
  return n || "unknown";
}

export function parseMoney(v) {
  if (v === null || v === undefined || v === "") return 0;
  const cleaned = String(v).replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

// StockNetwork dates are "M/D/YYYY h:mm:ss AM/PM" in the report's own local
// time. Deliberately kept as a plain "YYYY-MM-DD" string rather than
// converted through a JS Date/timezone — all this is used for is day-level
// MTD/prev-month/YTD bucketing, and a string comparison of "YYYY-MM-DD"
// values sorts correctly without any timezone ambiguity.
export function parseUsDateToYmd(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const mo = m[1].padStart(2, "0");
  const da = m[2].padStart(2, "0");
  return m[3] + "-" + mo + "-" + da;
}

// ---- Period bounds ----

// "Today" as seen by the edge function (UTC). South Africa is UTC+2 with no
// DST, so this can be up to ~2 hours off right around local midnight — not
// worth correcting for day-level MTD/prev-month/YTD bucketing.
export function periodBounds(now) {
  now = now || new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const pad = (n) => String(n).padStart(2, "0");
  const todayYmd = y + "-" + pad(m + 1) + "-" + pad(now.getUTCDate());
  const mtdStart = y + "-" + pad(m + 1) + "-01";
  const ytdStart = y + "-01-01";
  const prevMonthRef = new Date(Date.UTC(y, m - 1, 1));
  const py = prevMonthRef.getUTCFullYear();
  const pm = prevMonthRef.getUTCMonth();
  const prevMonthStart = py + "-" + pad(pm + 1) + "-01";
  const lastDayPrevMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of this month = last day of prev month
  const prevMonthEnd = py + "-" + pad(pm + 1) + "-" + pad(lastDayPrevMonth);
  return {
    mtd: { start: mtdStart, end: todayYmd },
    prevMonth: { start: prevMonthStart, end: prevMonthEnd },
    ytd: { start: ytdStart, end: todayYmd },
  };
}

function emptyStatusBucket() {
  const out = {};
  for (const s of STATUS_KEYS) out[s] = { count: 0, value: 0 };
  return out;
}

// Aggregates a flat list of transaction records (see admin-api.js's
// importStockNetworkReport for the record shape) into
// stats[period][channel][affId] = { request:{count,value}, booked:{...}, ... }
// plus an "all" pseudo-channel that sums every channel together, for every
// period in `periods` (as returned by periodBounds()).
export function aggregateTransactions(records, periods) {
  const periodNames = Object.keys(periods);
  const stats = {};
  for (const p of periodNames) {
    stats[p] = { all: {} };
    for (const ch of CHANNEL_KEYS) stats[p][ch] = {};
  }

  for (const rec of records) {
    if (!rec || !rec.affId || !rec.transactionDate) continue;
    const channel = CHANNEL_KEYS.includes(rec.channel) ? rec.channel : "accommodation";
    const status = STATUS_KEYS.includes(rec.status) ? rec.status : null;
    if (!status) continue;

    for (const p of periodNames) {
      const bounds = periods[p];
      if (rec.transactionDate < bounds.start || rec.transactionDate > bounds.end) continue;

      if (!stats[p][channel][rec.affId]) stats[p][channel][rec.affId] = emptyStatusBucket();
      stats[p][channel][rec.affId][status].count += 1;
      stats[p][channel][rec.affId][status].value += rec.amountIncl || 0;

      if (!stats[p].all[rec.affId]) stats[p].all[rec.affId] = emptyStatusBucket();
      stats[p].all[rec.affId][status].count += 1;
      stats[p].all[rec.affId][status].value += rec.amountIncl || 0;
    }
  }

  return stats;
}

// Turns one period+channel's per-affiliate stats into two ranked lists
// (by count, by value), using only the "confirmed" status — the leaderboard
// reflects closed, paid business, not open pipeline. Affiliates whose
// StockNetwork site number is in LEADERBOARD_EXCLUDED_SITE_NRS are left out
// entirely (they still have their raw stats available to Admin, just never
// ranked). Affiliates with zero confirmed transactions in this period are
// left out of the ranking too, rather than shown tied at the bottom.
export function buildLeaderboard(channelStats, affiliatesById) {
  const rows = [];
  for (const affId of Object.keys(channelStats)) {
    const aff = affiliatesById[affId];
    if (!aff) continue;
    if (LEADERBOARD_EXCLUDED_SITE_NRS.includes(String(aff.siteNr || "").trim())) continue;
    const confirmed = channelStats[affId].confirmed;
    if (!confirmed || confirmed.count <= 0) continue;
    rows.push({ affId: affId, name: aff.name || affId, count: confirmed.count, value: confirmed.value });
  }
  const byCount = rows.slice().sort((a, b) => b.count - a.count || b.value - a.value);
  const byValue = rows.slice().sort((a, b) => b.value - a.value || b.count - a.count);
  byCount.forEach((r, i) => (r.rankByCount = i + 1));
  byValue.forEach((r, i) => (r.rankByValue = i + 1));
  return { byCount: byCount, byValue: byValue, totalRanked: rows.length };
}

// ---- Blob store helpers ----

// Netlify Blobs has no bulk-get — reading N affiliates or transactions means
// N separate store.get() round trips. lib/blob-records.js runs them a few at
// a time and lets each edge isolate skip records that haven't changed since
// it last read them (by etag).

// Lists every key in `store` and fetches all of their records with bounded
// concurrency, in one shot. A single record's fetch failing doesn't lose
// the rest — it resolves to null there (filtered out by callers that want
// a plain list, kept as a positional null by callers, like siteToAff in
// admin-api.js, that need to line results back up with what they listed).
// cacheName: the store's name, to reuse this isolate's unchanged records.
export async function fetchAllRecords(store, cacheName) {
  return readAllRecords(store, { cacheName: cacheName || "" });
}

// Built as one final, ordered pass over the fetched results — not by
// mutating a shared object from inside each concurrent worker — so that if
// two directory records were ever somehow saved under the same affId, which
// one wins stays whichever came later in directoryStore.list()'s own order,
// the same every run.
function byAffId(affRecords) {
  const affiliatesById = {};
  for (const rec of affRecords) {
    if (rec) affiliatesById[rec.affId] = rec;
  }
  return affiliatesById;
}

// Shared by admin-api.js's `bookingStats` resource and auth-api.js's
// `getMyBookingStats` action (through loadBookingSummary below) — both need
// the full affiliate directory and every imported transaction, fetched and
// shaped the exact same way.
export async function loadAffiliatesAndTransactions(directoryStore, transactionsStore) {
  const [affRecords, records] = await Promise.all([
    fetchAllRecords(directoryStore, AFFILIATES_STORE),
    fetchAllRecords(transactionsStore, TRANSACTIONS_STORE),
  ]);
  return { affiliatesById: byAffId(affRecords), records: records.filter(Boolean) };
}

// Everything the Bookings dashboards show, computed from the two stores:
//   { periods, stats, leaderboard[period][channel], affiliateNames,
//     affiliateSiteNr, transactionCount }
function computeBookingSummary(affiliatesById, records, now) {
  const periods = periodBounds(now);
  const stats = aggregateTransactions(records, periods);
  const leaderboard = {};
  for (const p of Object.keys(stats)) {
    leaderboard[p] = {};
    for (const ch of Object.keys(stats[p])) leaderboard[p][ch] = buildLeaderboard(stats[p][ch], affiliatesById);
  }
  const affiliateNames = {};
  const affiliateSiteNr = {};
  for (const affId of Object.keys(affiliatesById)) {
    affiliateNames[affId] = affiliatesById[affId].name || affId;
    affiliateSiteNr[affId] = affiliatesById[affId].siteNr || "";
  }
  return { periods, stats, leaderboard, affiliateNames, affiliateSiteNr, transactionCount: records.length };
}

// The summary above, kept so an affiliate opening My Dashboard doesn't make
// the hub read every affiliate and every transaction each time. It is kept
// (in this isolate, and in the `summaryStore` blob for other isolates) with a
// fingerprint of both stores' keys and etags and the day it was computed for,
// and used only while both still match — so any import, edit or new
// affiliate, from anywhere, shows straight away, and the numbers are always
// the ones a fresh computation gives. Only the two key listings are read when
// nothing changed.
const SUMMARY_KEY = "summary";
const SUMMARY_VERSION = 1;
let summaryMemo = null; // { key, summary }

export async function loadBookingSummary(directoryStore, transactionsStore, summaryStore, now) {
  now = now || new Date();
  const day = JSON.stringify(periodBounds(now));
  const [affEntries, txEntries] = await Promise.all([
    listKeys(directoryStore),
    listKeys(transactionsStore),
  ]);
  const [fa, ft] = await Promise.all([entriesFingerprint(affEntries), entriesFingerprint(txEntries)]);
  const key = fa && ft ? SUMMARY_VERSION + ":" + day + ":" + fa + ":" + ft : "";
  if (key && summaryMemo && summaryMemo.key === key) return summaryMemo.summary;
  if (key && summaryStore) {
    const kept = await summaryStore.get(SUMMARY_KEY, { type: "json" }).catch(() => null);
    if (kept && kept.key === key && kept.summary) {
      summaryMemo = { key, summary: kept.summary };
      return kept.summary;
    }
  }
  const { affiliatesById, records } = await loadAffiliatesAndTransactions(directoryStore, transactionsStore);
  const summary = computeBookingSummary(affiliatesById, records, now);
  if (key) {
    summaryMemo = { key, summary };
    // Best-effort: the numbers are already right without it.
    if (summaryStore) await summaryStore.setJSON(SUMMARY_KEY, { key, at: now.toISOString(), summary }).catch(() => {});
  }
  return summary;
}

// Every key with its etag ({ key, etag }), without reading the records.
async function listKeys(store) {
  const { blobs = [] } = await store.list();
  return blobs.map((b) => ({ key: b.key, etag: b.etag || "" }));
}

export const BOOKING_SUMMARY_STORE = "booking-stats-summary";

import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import {
  periodBounds,
  aggregateTransactions,
  buildLeaderboard,
  loadAffiliatesAndTransactions,
  CHANNEL_KEYS as STATS_CHANNEL_KEYS,
  LEADERBOARD_EXCLUDED_SITE_NRS,
} from "./lib/booking-stats.js";

const DEFAULT_PASSWORD = "0000";

// Revenue channels — must stay in sync with CHANNEL_KEYS in admin-api.js.
// Only used here to shape a safe, read-only revenueShare object to hand
// back to an affiliate viewing their own Account Details — never written.
const CHANNEL_KEYS = ["accommodation", "flights", "activities", "car", "package"];

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sanitizeChannelShare(raw, fallbackPct) {
  if (raw && typeof raw === "object") {
    const type = raw.type === "amount" ? "amount" : "percent";
    let value = Number(raw.value);
    if (!isFinite(value) || value < 0) value = 0;
    if (type === "percent" && value > 100) value = 100;
    return { type: type, value: value };
  }
  let v = Number(raw);
  if (!isFinite(v)) v = isFinite(fallbackPct) ? Number(fallbackPct) : 0;
  v = Math.max(0, Math.min(100, v));
  return { type: "percent", value: v };
}

function sanitizeRevenueShare(input, fallbackPct) {
  const out = {};
  for (const key of CHANNEL_KEYS) {
    const raw = input && typeof input === "object" ? input[key] : undefined;
    out[key] = sanitizeChannelShare(raw, fallbackPct);
  }
  return out;
}

function sanitizeBankDetails(input) {
  const src = input && typeof input === "object" ? input : {};
  const clean = (v) => (typeof v === "string" ? v.trim().slice(0, 200) : "");
  return {
    bankName: clean(src.bankName),
    accountHolder: clean(src.accountHolder),
    accountNumber: clean(src.accountNumber),
    branchCode: clean(src.branchCode),
    accountType: clean(src.accountType),
  };
}

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const aff = typeof body.aff === "string" ? body.aff.trim() : "";
  const action = body.action;

  if (!aff) {
    return new Response(JSON.stringify({ error: "missing aff" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const store = getStore({ name: "affiliate-auth", consistency: "strong" });
  // Same store name admin-api.js uses for its affiliate directory, so a
  // profile an affiliate edits here shows up in the Admin dashboard too,
  // and vice versa.
  const directoryStore = getStore({ name: "affiliates-directory", consistency: "strong" });
  // Same store name admin-api.js's importStockNetworkReport writes to.
  const transactionsStore = getStore({ name: "stocknetwork-transactions", consistency: "strong" });

  try {
    const record = await store.get(aff, { type: "json" });
    const storedHash = record && record.passwordHash ? record.passwordHash : await sha256Hex(DEFAULT_PASSWORD);

    if (action === "login") {
      const password = typeof body.password === "string" ? body.password : "";
      const hash = await sha256Hex(password);
      if (hash === storedHash) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors },
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "Incorrect affiliate number or password" }), {
        status: 401,
        headers: { "content-type": "application/json", ...cors },
      });
    }

    if (action === "change") {
      const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

      if (!newPassword || newPassword.length < 4) {
        return new Response(JSON.stringify({ ok: false, error: "New password must be at least 4 characters" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      const oldHash = await sha256Hex(oldPassword);
      if (oldHash !== storedHash) {
        return new Response(JSON.stringify({ ok: false, error: "Current password is incorrect" }), {
          status: 401,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      const newHash = await sha256Hex(newPassword);
      await store.setJSON(aff, { passwordHash: newHash, updatedAt: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    if (action === "reset") {
      // No email system exists in this app, so "forgot password" simply
      // reverts the affiliate's account back to the default password (0000)
      // — the same one every new affiliate starts with. Anyone resetting
      // needs to already know the affiliate's ID, which matches this app's
      // existing security level throughout.
      await store.delete(aff);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    if (action === "getProfile") {
      // Self-service — an affiliate viewing their own Account Details tab.
      // revenueShare is included here purely for read-only display; the
      // updateProfile action below never accepts or writes it.
      const dirRecord = await directoryStore.get(aff, { type: "json" });
      const revenueShare = sanitizeRevenueShare(
        dirRecord && dirRecord.revenueShare,
        dirRecord && dirRecord.revenueSharePct
      );
      const bank = sanitizeBankDetails(dirRecord && dirRecord.bank);
      return new Response(
        JSON.stringify({
          ok: true,
          profile: {
            name: (dirRecord && dirRecord.name) || "",
            email: (dirRecord && dirRecord.email) || "",
            phone: (dirRecord && dirRecord.phone) || "",
            siteNr: (dirRecord && dirRecord.siteNr) || "",
            types: (dirRecord && Array.isArray(dirRecord.types)) ? dirRecord.types : [],
            bank: bank,
            revenueShare: revenueShare,
          },
        }),
        { headers: { "content-type": "application/json", ...cors } }
      );
    }

    if (action === "updateProfile") {
      // Self-service update of personal + bank details only. Revenue share
      // AND siteNr are intentionally never read from the request body —
      // whatever (if anything) an affiliate submits for either is silently
      // ignored, and the previously stored value is always what gets
      // carried forward below. Only the Admin dashboard (admin-api.js's
      // upsertAffiliate action, which requires an admin session token) can
      // change an affiliate's revenue share or StockNetwork site number.
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
      const email = typeof body.email === "string" ? body.email.trim().slice(0, 200) : "";
      const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 60) : "";
      const bank = sanitizeBankDetails(body.bank);

      const existing = await directoryStore.get(aff, { type: "json" });
      const revenueShare = sanitizeRevenueShare(
        existing && existing.revenueShare,
        existing && existing.revenueSharePct
      );

      const dirRecord = {
        affId: aff,
        name: name,
        email: email,
        phone: phone,
        siteNr: (existing && existing.siteNr) || "",
        bank: bank,
        revenueShare: revenueShare,
        notes: (existing && existing.notes) || "",
        status: (existing && existing.status) || "active",
        totalRevenue: (existing && existing.totalRevenue) || 0,
        totalOwed: (existing && existing.totalOwed) || 0,
        totalPaid: (existing && existing.totalPaid) || 0,
        channelRevenue: (existing && existing.channelRevenue) || {},
        createdAt: (existing && existing.createdAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await directoryStore.setJSON(aff, dirRecord);
      return new Response(
        JSON.stringify({
          ok: true,
          profile: {
            name: dirRecord.name,
            email: dirRecord.email,
            phone: dirRecord.phone,
            bank: dirRecord.bank,
            revenueShare: dirRecord.revenueShare,
          },
        }),
        { headers: { "content-type": "application/json", ...cors } }
      );
    }

    if (action === "getMyBookingStats") {
      // Self-service — an affiliate viewing their own "My Dashboard" tab.
      // Only ever returns this one affiliate's own numbers plus their rank
      // (a position and a total, never another affiliate's name or data),
      // even though the underlying stats/leaderboard are computed the same
      // way admin-api.js's bookingStats resource computes them.
      const { affiliatesById, records } = await loadAffiliatesAndTransactions(directoryStore, transactionsStore);

      const periods = periodBounds();
      const stats = aggregateTransactions(records, periods);
      const emptyBucket = { count: 0, value: 0 };
      const emptyStatus = { request: emptyBucket, booked: emptyBucket, cancelled: emptyBucket, confirmed: emptyBucket, paid: emptyBucket };

      const myStats = {};
      const myRank = {};
      for (const p of Object.keys(stats)) {
        myStats[p] = {};
        myRank[p] = {};
        for (const ch of Object.keys(stats[p])) {
          myStats[p][ch] = stats[p][ch][aff] || emptyStatus;
          const lb = buildLeaderboard(stats[p][ch], affiliatesById);
          const byCountRow = lb.byCount.find((r) => r.affId === aff);
          const byValueRow = lb.byValue.find((r) => r.affId === aff);
          myRank[p][ch] = {
            byCount: byCountRow ? { rank: byCountRow.rankByCount, of: lb.totalRanked } : null,
            byValue: byValueRow ? { rank: byValueRow.rankByValue, of: lb.totalRanked } : null,
          };
        }
      }

      const excludedFromLeaderboard = LEADERBOARD_EXCLUDED_SITE_NRS.includes(
        String((affiliatesById[aff] && affiliatesById[aff].siteNr) || "").trim()
      );

      return new Response(
        JSON.stringify({
          ok: true,
          periods: periods,
          channels: STATS_CHANNEL_KEYS,
          myStats: myStats,
          myRank: myRank,
          excludedFromLeaderboard: excludedFromLeaderboard,
        }),
        { headers: { "content-type": "application/json", ...cors } }
      );
    }

    return new Response(JSON.stringify({ error: "unknown action" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...cors },
    });
  }
};

export const config = { path: "/api/auth" };

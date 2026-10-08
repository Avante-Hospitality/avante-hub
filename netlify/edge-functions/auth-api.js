import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import {
  periodBounds,
  aggregateTransactions,
  buildLeaderboard,
  loadAffiliatesAndTransactions,
  CHANNEL_KEYS as STATS_CHANNEL_KEYS,
  LEADERBOARD_EXCLUDED_SITE_NRS,
} from "./lib/booking-stats.js";
import { hooksLink } from "./lib/hooks-ticket.js";

const DEFAULT_PASSWORD = "0000";
const RESET_LINK_MINUTES = 60;
const RESET_MAX_PER_HOUR = 3;

function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function maskEmail(e) { const m = /^(.)(.*)(@.*)$/.exec(String(e || "")); return m ? m[1] + "***" + m[3] : ""; }

async function sendResendEmail(to, subject, html) {
  const key = (typeof Netlify !== "undefined" ? Netlify.env.get("RESEND_API_KEY") : Deno.env.get("RESEND_API_KEY")) || "";
  if (!key || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ from: "Avante Travel <bookings@go.avantetravel.co.za>", to: [to], subject, html }),
    });
    return r.ok;
  } catch (_) { return false; }
}

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
  // Logged-in devices. A session is tied to the password at the time of
  // login, so changing or resetting the password logs every device out.
  const sessionStore = getStore({ name: "affiliate-sessions", consistency: "strong" });
  const resetStore = getStore({ name: "affiliate-password-reset", consistency: "strong" });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });

  try {
    const record = await store.get(aff, { type: "json" });
    const storedHash = record && record.passwordHash ? record.passwordHash : await sha256Hex(DEFAULT_PASSWORD);
    const newSession = async (hash) => {
      const token = randomToken(24);
      await sessionStore.setJSON(token, { aff, ph: hash.slice(0, 16), createdAt: new Date().toISOString() });
      return token;
    };
    const validSession = async () => {
      const t = typeof body.session === "string" ? body.session.trim().slice(0, 100) : "";
      if (!t) return false;
      const s = await sessionStore.get(t, { type: "json" });
      return !!(s && s.aff === aff && s.ph === storedHash.slice(0, 16));
    };
    const relogin = () => json({ ok: false, relogin: true, error: "Please log in again." }, 401);

    if (action === "login") {
      const password = typeof body.password === "string" ? body.password : "";
      const hash = await sha256Hex(password);
      if (hash === storedHash) {
        return json({ ok: true, session: await newSession(storedHash) });
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
      // Other devices are logged out; this one gets a fresh session.
      return json({ ok: true, session: await newSession(newHash) });
    }

    if (action === "reset") {
      // Forgot password: email a one-time reset link to the address on the
      // affiliate's profile. The answer is the same whether or not the
      // affiliate exists or has an email, so it can't be used to probe accounts.
      const generic = { ok: true, message: "If this affiliate number has an email address on file, a reset link is on its way. It works once and expires in " + RESET_LINK_MINUTES + " minutes. No email? Contact Avante Travel." };
      const dir = await directoryStore.get(aff, { type: "json" });
      const email = dir && typeof dir.email === "string" ? dir.email.trim() : "";
      if (!email) return json(generic);
      const rl = (await resetStore.get("rl:" + aff, { type: "json" })) || { times: [] };
      const hourAgo = Date.now() - 3600000;
      rl.times = (rl.times || []).filter((t) => t > hourAgo);
      if (rl.times.length >= RESET_MAX_PER_HOUR) return json(generic);
      rl.times.push(Date.now());
      await resetStore.setJSON("rl:" + aff, rl);
      const token = randomToken(24);
      await resetStore.setJSON("t:" + token, { aff, exp: Date.now() + RESET_LINK_MINUTES * 60000, used: false, createdAt: new Date().toISOString() });
      const link = new URL(request.url).origin + "/reset-password.html?aff=" + encodeURIComponent(aff) + "&t=" + token;
      await sendResendEmail(email, "Reset your Avante Travel Hub password",
        "<p>Hi " + escHtml(dir.name || "") + ",</p><p>Someone asked to reset the password for Avante Travel Hub affiliate <b>" + escHtml(aff) + "</b>.</p>" +
        "<p><a href=\"" + escHtml(link) + "\" style=\"display:inline-block;background:#0e2f44;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700\">Choose a new password</a></p>" +
        "<p>The link works once and expires in " + RESET_LINK_MINUTES + " minutes. If you didn't ask for this, ignore this email: your password stays the same.</p>");
      return json(generic);
    }

    if (action === "resetConfirm") {
      const t = typeof body.t === "string" ? body.t.trim().slice(0, 100) : "";
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
      const rec = t ? await resetStore.get("t:" + t, { type: "json" }) : null;
      if (!rec || rec.aff !== aff) return json({ ok: false, error: "This reset link isn't valid. Request a new one from the login page." }, 400);
      if (rec.used) return json({ ok: false, error: "This reset link has already been used. Request a new one from the login page." }, 400);
      if (rec.exp < Date.now()) return json({ ok: false, error: "This reset link has expired. Request a new one from the login page." }, 400);
      if (!newPassword || newPassword.length < 4) return json({ ok: false, error: "New password must be at least 4 characters" }, 400);
      if (newPassword === DEFAULT_PASSWORD) return json({ ok: false, error: "Choose a password other than 0000." }, 400);
      const newHash = await sha256Hex(newPassword);
      await store.setJSON(aff, { passwordHash: newHash, updatedAt: new Date().toISOString() });
      rec.used = true; rec.usedAt = new Date().toISOString();
      await resetStore.setJSON("t:" + t, rec);
      return json({ ok: true });
    }

    if (action === "getProfile") {
      if (!(await validSession())) return relogin();
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
            // Every affiliate has the hook builder unless admin switched it
            // off for them (Affiliates tab) or they're inactive.
            hooksAccess: !(dirRecord && (dirRecord.hooksAccess === false || dirRecord.status === "inactive")),
          },
        }),
        { headers: { "content-type": "application/json", ...cors } }
      );
    }

    if (action === "hooksTicket") {
      // A signed-in affiliate opening the hook builder — every affiliate,
      // unless admin switched it off for them or they're inactive.
      if (!(await validSession())) return relogin();
      const dirRecord = await directoryStore.get(aff, { type: "json" });
      if (dirRecord && (dirRecord.hooksAccess === false || dirRecord.status === "inactive")) {
        return json({ ok: false, error: "The hook builder is switched off for your account. Ask Avante Travel to switch it on." }, 403);
      }
      try {
        return json({ ok: true, url: await hooksLink({ sub: aff, name: (dirRecord && dirRecord.name) || aff, role: "affiliate" }) });
      } catch (e) {
        return json({ ok: false, error: e.message || "The hook builder couldn't be opened." }, 500);
      }
    }

    if (action === "updateProfile") {
      if (!(await validSession())) return relogin();
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

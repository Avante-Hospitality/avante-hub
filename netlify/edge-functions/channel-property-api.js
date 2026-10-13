// /api/channel-property — the Channel Property Affiliate (Jean, 2026-10-13).
//
// A channel property is already on a channel manager (NightsBridge first)
// that feeds Stock Network, so it doesn't use the hub's calendar/booking
// module. In the hub it only gets the hook builder and these settings:
//   - how guests pay: Avante's payment page (Stock Network), the property's
//     own payment gateway, EFT into the property's bank account, or not set.
// Later: a Communication & marketing module fed by an uploaded channel
// report (NightsBridge first) — not built yet.
//
// The affiliate signs in to the hub as usual; this checks the same hub
// session auth-api.js issues (affiliate-sessions store, tied to the
// password hash so a password change logs every device out).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { encryptJSON, decryptJSON, sha256Hex } from "./lib/pa-crypto.js";

const DEFAULT_PASSWORD = "0000";
const PAY_MODES = ["sn", "own", "eft", "none"];
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
const clean = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";

async function validSession(aff, session) {
  if (!aff || !session) return false;
  const rec = await getStore({ name: "affiliate-auth", consistency: "strong" }).get(aff, { type: "json" });
  const storedHash = rec && rec.passwordHash ? rec.passwordHash : await sha256Hex(DEFAULT_PASSWORD);
  const s = await getStore({ name: "affiliate-sessions", consistency: "strong" }).get(String(session).slice(0, 100), { type: "json" });
  return !!(s && s.aff === aff && s.ph === storedHash.slice(0, 16));
}

function bankView(bank) {
  if (!bank) return {};
  const acc = String(bank.accountNumber || "");
  return { bankName: bank.bankName || "", accountHolder: bank.accountHolder || "", accountNumber: acc, branchCode: bank.branchCode || "", accountType: bank.accountType || "", note: bank.note || "" };
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const aff = clean(body.aff, 100);
  try {
    if (!(await validSession(aff, body.session))) return json({ ok: false, relogin: true, error: "Please log in again." }, 401);
    const dir = await getStore({ name: "affiliates-directory", consistency: "strong" }).get(aff, { type: "json" });
    const types = (dir && Array.isArray(dir.types)) ? dir.types : [];
    if (types.indexOf("channel") === -1) return json({ ok: false, error: "This affiliate isn't set up as a channel property. Ask Avante Travel." }, 403);
    const store = getStore({ name: "channel-property", consistency: "strong" });
    const rec = (await store.get(aff, { type: "json" })) || { aff, payMode: "none", gatewayUrl: "", bankEnc: "" };
    const key = env("PA_ENC_KEY");

    if (body.action === "get") {
      let bank = null;
      if (rec.bankEnc && key) { try { bank = await decryptJSON(rec.bankEnc, key); } catch (_) { bank = null; } }
      return json({ ok: true, name: (dir && dir.name) || "", siteNr: (dir && dir.siteNr) || "", payMode: PAY_MODES.includes(rec.payMode) ? rec.payMode : "none",
        gatewayUrl: rec.gatewayUrl || "", bank: bankView(bank), updatedAt: rec.updatedAt || "" });
    }

    if (body.action === "saveSettings") {
      const payMode = PAY_MODES.includes(body.payMode) ? body.payMode : "none";
      const gatewayUrl = clean(body.gatewayUrl, 500);
      if (payMode === "own" && !/^https:\/\/\S+$/i.test(gatewayUrl)) return json({ ok: false, error: "Type your own payment gateway's link (starting with https://)." }, 400);
      const b = body.bank && typeof body.bank === "object" ? body.bank : {};
      const bank = { bankName: clean(b.bankName, 60), accountHolder: clean(b.accountHolder, 100), accountNumber: clean(b.accountNumber, 30).replace(/\s+/g, ""), branchCode: clean(b.branchCode, 20), accountType: clean(b.accountType, 40), note: clean(b.note, 200) };
      if (payMode === "eft" && !(bank.bankName && bank.accountHolder && bank.accountNumber && bank.branchCode)) {
        return json({ ok: false, error: "For EFT, fill in the bank, account holder, account number and branch code." }, 400);
      }
      const hasBank = !!(bank.bankName || bank.accountNumber);
      if (hasBank && !key) return json({ ok: false, error: "Bank details can't be stored yet (encryption key missing). Ask Avante Travel." }, 500);
      const next = { aff, payMode, gatewayUrl: payMode === "own" ? gatewayUrl : (rec.gatewayUrl || ""), bankEnc: hasBank ? await encryptJSON(bank, key) : "", updatedAt: new Date().toISOString(),
        history: (Array.isArray(rec.history) ? rec.history : []).concat([{ at: new Date().toISOString(), payMode }]).slice(-50) };
      await store.setJSON(aff, next);
      return json({ ok: true, payMode });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 500);
  }
};

export const config = { path: "/api/channel-property" };

// Making a property's hub affiliate (Jean, 2026-10-14/17): its affiliate
// number is its Site ID, with its Site Nr and name, typed Channel Property
// Affiliate ("channel") or Property Affiliate ("property"), with hook builder
// access. An affiliate that already exists is never overwritten.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

const REVENUE_KEYS = ["accommodation", "flights", "activities", "car", "package"];

// -> { created: true, aff } or { created: false, aff: existing }
export async function createPropertyAffiliate({ affId, name, email, phone, siteNr, type, note }) {
  const dir = getStore({ name: "affiliates-directory", consistency: "strong" });
  const existing = await dir.get(affId, { type: "json" }).catch(() => null);
  if (existing) return { created: false, aff: existing };
  const now = new Date().toISOString();
  const aff = { affId, name: name || "", email: email || "", siteNr: siteNr ? String(siteNr) : "",
    types: [type === "channel" ? "channel" : "property"], phone: phone || "",
    revenueShare: Object.fromEntries(REVENUE_KEYS.map((k) => [k, { type: "percent", value: 0 }])),
    bank: { bankName: "", accountHolder: "", accountNumber: "", branchCode: "", accountType: "" }, notes: note || "",
    status: "active", totalRevenue: 0, totalOwed: 0, totalPaid: 0, channelRevenue: {}, hooksAccess: true, createdAt: now, updatedAt: now };
  await dir.setJSON(affId, aff);
  return { created: true, aff };
}

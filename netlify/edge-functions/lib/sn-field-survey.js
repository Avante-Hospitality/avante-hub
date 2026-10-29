// Stock Network field survey (Jean, 2026-10-24): which property details the
// hub can read from Stock Network instead of copying them from SN's admin
// (Description, Conditions, More Information, Attractions, check-in/out
// times, amenities, contacts). Read-only, admin only. Three parts:
//   feedSurvey(idx)     every field in SN's property feed (/api/1.0/resort,
//                       already kept by the hub in "sn-feed"/"resort-index"),
//                       how many properties have it filled, all and channel
//                       (NightsBridge: a resortCode/BBID) — no new SN call.
//   pageSurvey(id)      every labelled section on the property's public
//                       Stock Network page (ResortInfo.aspx), with a sample.
//   the API calls       sn-availability.mjs op "fields" (v2search, v1paged,
//                       resortinfo), called from the admin action.
import { RESORT_INFO, decode } from "./sn-resort-info.js";
import { snFetch } from "./sn-log.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (v, n) => { const s = String(v).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
export const isChannelRow = (row) => String((row && row.resortCode) || "").trim() !== "";

export function feedSurvey(idx) {
  const rows = Object.values((idx && idx.byResort) || {});
  const channel = rows.filter(isChannelRow).length;
  const stats = {};
  for (const row of rows) {
    const ch = isChannelRow(row);
    for (const [k, v] of Object.entries(row)) {
      const f = stats[k] || (stats[k] = { field: k, filled: 0, filledChannel: 0, sample: "" });
      f.filled++; if (ch) f.filledChannel++;
      if (!f.sample || (ch && !f.sampleFromChannel)) { f.sample = short(v, 70); f.sampleFromChannel = ch; }
    }
  }
  const fields = Object.values(stats).sort((a, b) => b.filled - a.filled || a.field.localeCompare(b.field))
    .map(({ field, filled, filledChannel, sample }) => ({ field, filled, filledChannel, sample }));
  return { at: (idx && idx.at) || null, properties: rows.length, channelProperties: channel, fields };
}

// Every element on the public page with an id and some text (labels like
// lblAboutUs, sections like dvAmentities), as { id, sample }.
export async function pageSurvey(resortId, fetchImpl = snFetch({ source: "Field check" })) {
  if (!GUID.test(String(resortId || ""))) return { ok: false, error: "No valid Resort ID." };
  try {
    const res = await fetchImpl(RESORT_INFO + "?ResortID=" + encodeURIComponent(resortId), { headers: { "user-agent": "AvanteHub/1.0" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: "Stock Network answered " + res.status + "." };
    const html = await res.text(), out = [], seen = new Set();
    for (const m of html.matchAll(/<(span|div|p|h\d|label|ul|textarea)[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const id = m[2]; if (seen.has(id)) continue;
      const text = decode(m[3]); if (!text) continue;
      seen.add(id); out.push({ id, sample: short(text, 90) });
      if (out.length >= 80) break;
    }
    return { ok: true, sections: out };
  } catch (e) { return { ok: false, error: "Stock Network didn't respond." }; }
}

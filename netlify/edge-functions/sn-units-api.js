// /api/sn-units — unit types per property for the location tree (Jean, 2026-10-14).
//   GET                    { ok, generated, units: { resortId: [[type, sleeps, bedrooms, count, names], …] } }
//                          the seed file (sn-units.json) with every property read since then on top
//   GET ?messy=1           CSV: units that need tidying on Stock Network (for the clean-up later)
//   POST {action:"refresh"} with x-pa-sync-secret: read the next batch of resort pages
//                          (sn-units-sync, every 10 minutes, ~60 properties a time: a full round in about 15 hours)
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { parseUnits, unitLines } from "./lib/sn-units.js";

const RESORT_INFO = "https://old.stocknetwork.co.za/ResortInfo.aspx?ResortID=";
const BATCH = 60, PARALLEL = 4, BUDGET_MS = 25000;
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } });
let cache = null; // { at, body }

async function readOne(id) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(RESORT_INFO + encodeURIComponent(id), { headers: { "user-agent": "AvanteHub/1.0" }, signal: ctl.signal });
    if (!r.ok) return null;
    return unitLines(parseUnits(await r.text()));
  } catch (_) { return null; } finally { clearTimeout(t); }
}

export default async (request) => {
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  const url = new URL(request.url);
  const store = getStore({ name: "sn-units", consistency: "strong" });

  if (request.method === "POST") {
    const secret = env("PA_SYNC_SECRET");
    if (!secret || request.headers.get("x-pa-sync-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
    const t0 = Date.now();
    const rl = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
    const ids = [...new Set(((rl && rl.resorts) || []).map((r) => r && r.resortId).filter(Boolean))];
    if (!ids.length) return json({ ok: false, error: "no resort list" }, 500);
    const live = (await store.get("all", { type: "json" }).catch(() => null)) || { units: {}, messy: {} };
    live.units = live.units || {}; live.messy = live.messy || {};
    let cursor = (await store.get("cursor", { type: "json" }).catch(() => null)) || 0;
    if (cursor >= ids.length) cursor = 0;
    const batch = ids.slice(cursor, cursor + BATCH);
    let done = 0, read = 0;
    for (let i = 0; i < batch.length && Date.now() - t0 < BUDGET_MS; i += PARALLEL) {
      const part = batch.slice(i, i + PARALLEL);
      const res = await Promise.all(part.map(readOne));
      part.forEach((id, k) => {
        done++;
        const r = res[k]; if (!r) return; // not reachable now: keep what we had
        read++;
        live.units[id] = r.lines; // also when empty, so it wins over the first reading
        if (r.messy.length) live.messy[id] = r.messy; else delete live.messy[id];
      });
    }
    live.at = new Date().toISOString();
    await store.setJSON("all", live);
    const next = cursor + done >= ids.length ? 0 : cursor + done;
    await store.setJSON("cursor", next);
    return json({ ok: true, from: cursor, done, read, next, total: ids.length, ms: Date.now() - t0 });
  }

  if (url.searchParams.get("messy") === "1") {
    const live = (await store.get("all", { type: "json" }).catch(() => null)) || {};
    // The first full reading (sn-units-messy.json) with every property read since then on top.
    let seedMessy = {}; try { const r = await fetch(new URL("/sn-units-messy.json", url.origin)); if (r.ok) seedMessy = await r.json(); } catch (_) { /* live only */ }
    const messy = Object.assign({}, seedMessy); for (const id of Object.keys(live.units || {})) delete messy[id]; Object.assign(messy, live.messy || {});
    const rl = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
    const names = {}; for (const r of (rl && rl.resorts) || []) if (r && r.resortId && !names[r.resortId]) names[r.resortId] = r.name || "";
    const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const rows = [["ResortID", "Property", "Unit", "Room Type", "Max Guests", "What to fix"].map(q).join(",")];
    for (const [id, list] of Object.entries(messy)) for (const m of list) rows.push([id, names[id] || "", ...m].map(q).join(","));
    return new Response(rows.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="sn-units-to-tidy.csv"' } });
  }

  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return new Response(cache.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  let seed = { units: {} };
  try { const r = await fetch(new URL("/sn-units.json", url.origin)); if (r.ok) seed = await r.json(); } catch (_) { /* live only */ }
  const live = (await store.get("all", { type: "json" }).catch(() => null)) || {};
  const body = JSON.stringify({ ok: true, generated: seed.generated || "", updated: live.at || "", units: Object.assign({}, seed.units || {}, live.units || {}) });
  cache = { at: Date.now(), body };
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
};

export const config = { path: "/api/sn-units" };

// /api/sn-units — unit types per property for the location tree (Jean, 2026-10-14).
//   GET                    { ok, generated, units: { resortId: [[type, sleeps, bedrooms, count, names], …] } }
//                          the seed file (sn-units.json) with every property read since then on top
//   GET ?messy=1           CSV: units that need tidying on Stock Network (for the clean-up later)
//   POST {action:"refresh"} with x-pa-sync-secret (sn-units-sync, every hour, Jean 2026-10-19):
//                          new properties first, then any not read for 6 months, 35 a time.
//                          Nothing due: no Stock Network page is opened and nothing is saved.
//   POST {action:"refreshOne", resortId, token} (admin, Refresh units on the Master map): read one now
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { parseUnits, unitLines } from "./lib/sn-units.js";
import { isAdminToken } from "./lib/admin-session.js";

const RESORT_INFO = "https://old.stocknetwork.co.za/ResortInfo.aspx?ResortID=";
const BATCH = 35, PARALLEL = 4, BUDGET_MS = 25000, EVERY_MS = 182 * 864e5; // about 6 months
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" }; // the hook builder reads it too
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } });
let cache = null; // { at, body }
// The first full reading (sn-units.json, about 1MB) only changes with a
// deploy, and each deploy starts new isolates: read and parsed once here,
// not every time the 10-minute answer cache runs out.
let seedPromise = null;
function readSeed(origin) {
  if (!seedPromise) {
    seedPromise = fetch(new URL("/sn-units.json", origin))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    // A failed read is tried again next time.
    seedPromise.then((s) => { if (!s) seedPromise = null; });
  }
  return seedPromise.then((s) => s || { units: {} });
}

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
    let body = {}; try { body = await request.json(); } catch (_) { /* refresh */ }
    const live = (await store.get("all", { type: "json" }).catch(() => null)) || { units: {}, messy: {} };
    live.units = live.units || {}; live.messy = live.messy || {};
    // When each property was last read. The first full reading (sn-units.json)
    // counts as read on the day it was made.
    if (!live.readAt) {
      live.readAt = {};
      const seed = await readSeed(url.origin);
      const seedAt = seed.generated || live.at || new Date().toISOString();
      for (const id of Object.keys(seed.units || {})) live.readAt[id] = seedAt;
      for (const id of Object.keys(live.units)) live.readAt[id] = live.at || seedAt;
    }
    const keep = (id, r) => {
      const changed = JSON.stringify(live.units[id]) !== JSON.stringify(r.lines) || JSON.stringify(live.messy[id] || []) !== JSON.stringify(r.messy);
      live.units[id] = r.lines; // also when empty, so it wins over the first reading
      if (r.messy.length) live.messy[id] = r.messy; else delete live.messy[id];
      live.readAt[id] = new Date().toISOString();
      if (live.triedAt) delete live.triedAt[id];
      return changed;
    };

    if (body.action === "refreshOne") {
      if (!(await isAdminToken(body.token))) return json({ ok: false, error: "Log in to admin again." }, 403);
      const id = String(body.resortId || "").trim(); if (!id) return json({ ok: false, error: "Which property?" }, 400);
      const r = await readOne(id);
      if (!r) return json({ ok: false, error: "Stock Network's page didn't answer. Try again later." }, 502);
      keep(id, r); live.at = new Date().toISOString();
      await store.setJSON("all", live); cache = null;
      return json({ ok: true, resortId: id, units: r.lines });
    }

    const secret = env("PA_SYNC_SECRET");
    if (!secret || request.headers.get("x-pa-sync-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
    const t0 = Date.now();
    const rl = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
    const ids = [...new Set(((rl && rl.resorts) || []).map((r) => r && r.resortId).filter(Boolean))];
    if (!ids.length) return json({ ok: false, error: "no resort list" }, 500);
    // New properties first, then the longest unread, only once 6 months have passed.
    // A page that didn't answer is tried again a day later, not every hour.
    live.triedAt = live.triedAt || {};
    const resting = (id) => live.triedAt[id] && t0 - Date.parse(live.triedAt[id]) < 864e5;
    const fresh = ids.filter((id) => !live.readAt[id] && !resting(id));
    const due = ids.filter((id) => live.readAt[id] && t0 - Date.parse(live.readAt[id]) > EVERY_MS && !resting(id)).sort((a, b) => live.readAt[a].localeCompare(live.readAt[b]));
    const batch = fresh.concat(due).slice(0, BATCH);
    const migrated = !(await store.get("all", { type: "json" }).then((x) => x && x.readAt).catch(() => null));
    if (!batch.length) { if (migrated) await store.setJSON("all", live); return json({ ok: true, due: 0 }); }
    let done = 0, read = 0, changed = 0, tried = 0;
    for (let i = 0; i < batch.length && Date.now() - t0 < BUDGET_MS; i += PARALLEL) {
      const part = batch.slice(i, i + PARALLEL);
      const res = await Promise.all(part.map(readOne));
      part.forEach((id, k) => {
        done++;
        const r = res[k]; if (!r) { live.triedAt[id] = new Date().toISOString(); tried++; return; } // not reachable now: tried again tomorrow
        read++;
        if (keep(id, r)) changed++;
      });
    }
    // Saved when anything new was read (its read date, and its units if they changed).
    if (read || tried || migrated) { live.at = new Date().toISOString(); await store.setJSON("all", live); }
    return json({ ok: true, new: fresh.length, due: due.length, done, read, changed, ms: Date.now() - t0 });
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

  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return new Response(cache.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600", ...CORS } });
  const seed = await readSeed(url.origin);
  const live = (await store.get("all", { type: "json" }).catch(() => null)) || {};
  const body = JSON.stringify({ ok: true, generated: seed.generated || "", updated: live.at || "", units: Object.assign({}, seed.units || {}, live.units || {}) });
  cache = { at: Date.now(), body };
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600", ...CORS } });
};

export const config = { path: "/api/sn-units" };

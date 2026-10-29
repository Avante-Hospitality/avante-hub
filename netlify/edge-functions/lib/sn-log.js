// Stock Network call log (Jean, 2026-10-29): how often the hub calls Stock
// Network, and when it might be calling it too hard.
//
// Every call to a stocknetwork.co.za address goes through snFetch(), which
// records it as ONE small blob whose key holds the whole record:
//   c:<ISO time>|<source>|<path>|<site>|<HTTP status>|<ms>|<random>
// so a summary only needs to list keys, never read them, and concurrent calls
// never overwrite each other. Every hour, rollUp() folds each finished hour
// into the day's summary (d:<YYYY-MM-DD>) and removes that hour's call keys.
//   snFetch({ source, site })  -> a fetch() that logs Stock Network calls
//   recordCalls(records)       -> log calls made elsewhere (Netlify functions)
//   rollUp()                   -> run hourly by netlify/functions/sn-log-rollup.mjs
//   summary(days)              -> what Admin > SN Calls shows
// A failure to log is printed and never breaks the call itself.

import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

const STORE = "sn-call-log";
const KEEP_DAYS = 60;
// Warning levels until Stock Network tells us its real limit (editable in Admin > SN Calls).
export const DEFAULT_LIMITS = { perMinute: 60, perHour: 1000 };

const store = () => getStore({ name: STORE });
const enc = (v, max) => encodeURIComponent(String(v == null ? "" : v).slice(0, max));
const dec = (v) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// "api /api/1/search", "old site /ResortInfo.aspx", "photos /data/resort/:n/…": no query, no IDs.
export function callPath(url) {
  let u; try { u = new URL(String(url)); } catch (_) { return "?"; }
  const photo = /\.(jpe?g|png|gif|webp)$/i.test(u.pathname) || /\/image\/\d+\//.test(u.pathname);
  const host = u.hostname.startsWith("api.") ? "api" : u.hostname.startsWith("old.") ? (photo ? "photos" : "old site") : u.hostname.split(".")[0];
  const path = u.pathname.replace(GUID, ":id").replace(/\/\d{3,}(?=\/|$)/g, "/:n").replace(/\/[^/]+\.(jpe?g|png|gif|webp)$/i, "/…");
  return host + " " + path;
}
const isSN = (url) => { try { return /(^|\.)stocknetwork\.co\.za$/i.test(new URL(String(url)).hostname); } catch (_) { return false; } };

function keyOf(r) {
  const at = r.at || new Date().toISOString();
  return "c:" + at + "|" + enc(r.source || "Hub", 60) + "|" + enc(r.path, 100) + "|" + enc(r.site, 40) + "|" + (Number(r.status) || 0) + "|" + Math.max(0, Math.round(Number(r.ms) || 0)) + "|" + Math.random().toString(36).slice(2, 8);
}
function parseKey(key) {
  const p = key.slice(2).split("|");
  if (p.length < 7) return null;
  return { at: p[0], source: dec(p[1]), path: dec(p[2]), site: dec(p[3]), status: Number(p[4]) || 0, ms: Number(p[5]) || 0 };
}

async function writeOne(r) {
  try { await store().set(keyOf(r), "1"); }
  catch (e) { console.error("sn-log: could not log a Stock Network call", e && e.message); }
}

// A fetch() for anything: calls to Stock Network are timed and logged, others pass straight through.
export function snFetch(info = {}, base = (...a) => fetch(...a)) {
  return async (url, init) => {
    if (!isSN(typeof url === "string" ? url : url && url.url)) return base(url, init);
    const t0 = Date.now(), at = new Date(t0).toISOString(), path = callPath(typeof url === "string" ? url : url.url);
    try {
      const res = await base(url, init);
      await writeOne({ at, source: info.source, site: info.site, path, status: res.status, ms: Date.now() - t0 });
      return res;
    } catch (e) {
      await writeOne({ at, source: info.source, site: info.site, path, status: 0, ms: Date.now() - t0 });
      throw e;
    }
  };
}

// Calls a Netlify function made itself (it has no Blobs access of its own here).
export async function recordCalls(records) {
  const list = (Array.isArray(records) ? records : []).slice(0, 2000).filter((r) => r && r.at && r.path);
  for (let i = 0; i < list.length; i += 20) await Promise.all(list.slice(i, i + 20).map(writeOne));
  return list.length;
}

// ---------- adding up ----------
const blankHour = () => ({ n: 0, err: 0, r429: 0, r5xx: 0, msSum: 0, msMax: 0, min: {}, src: {}, path: {}, site: {} });
function add(h, c) {
  h.n++; h.msSum += c.ms; if (c.ms > h.msMax) h.msMax = c.ms;
  if (!c.status || c.status >= 400) h.err++;
  if (c.status === 429) h.r429++;
  if (c.status >= 500) h.r5xx++;
  const m = c.at.slice(14, 16); h.min[m] = (h.min[m] || 0) + 1;
  h.src[c.source] = (h.src[c.source] || 0) + 1;
  h.path[c.path] = (h.path[c.path] || 0) + 1;
  if (c.site) h.site[c.site] = (h.site[c.site] || 0) + 1;
}
async function rawCalls(s) {
  const { blobs } = await s.list({ prefix: "c:" });
  return blobs.map((b) => ({ key: b.key, call: parseKey(b.key) })).filter((x) => x.call);
}
const hourOf = (iso) => iso.slice(0, 13); // "2026-10-29T10" (UTC)

// Folds every hour that ended more than an hour ago (late reports from Netlify
// functions still land in the raw keys) into its day, then removes its keys.
export async function rollUp({ deadlineMs = 22000 } = {}) {
  const started = Date.now(), s = store();
  const keep = hourOf(new Date(Date.now() - 3600e3).toISOString());
  const byHour = {};
  for (const x of await rawCalls(s)) { const h = hourOf(x.call.at); if (h < keep) (byHour[h] = byHour[h] || []).push(x); }
  const out = { hours: 0, calls: 0, removed: 0, more: false };
  for (const hour of Object.keys(byHour).sort()) {
    if (Date.now() - started > deadlineMs) { out.more = true; break; }
    const day = hour.slice(0, 10), hh = hour.slice(11, 13);
    const d = (await s.get("d:" + day, { type: "json" }).catch(() => null)) || { day, hours: {} };
    const sum = d.hours[hh] || blankHour();
    for (const x of byHour[hour]) add(sum, x.call);
    d.hours[hh] = sum;
    await s.setJSON("d:" + day, d); // saved before the keys go, so nothing is lost if it stops halfway
    const keys = byHour[hour].map((x) => x.key);
    for (let i = 0; i < keys.length; i += 25) await Promise.all(keys.slice(i, i + 25).map((k) => s.delete(k)));
    out.hours++; out.calls += keys.length; out.removed += keys.length;
  }
  const oldest = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const { blobs } = await s.list({ prefix: "d:" });
  for (const b of blobs) if (b.key.slice(2) < oldest) await s.delete(b.key);
  return out;
}

export async function getLimits() {
  const c = await store().get("config", { type: "json" }).catch(() => null);
  return Object.assign({}, DEFAULT_LIMITS, c || {});
}
export async function saveLimits(body) {
  const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  const c = { perMinute: n(body.perMinute, 1, 100000), perHour: n(body.perHour, 1, 1000000) };
  await store().setJSON("config", c);
  return c;
}

// The last `days` days (1–31), hour by hour, in UTC hours (the page shows them in SA time).
export async function summary(days = 1) {
  days = Math.max(1, Math.min(31, Math.round(Number(days) || 1)));
  const s = store();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const first = since.slice(0, 10);
  const dayKeys = [];
  for (let t = Date.parse(first + "T00:00:00Z"); t <= Date.now(); t += 864e5) dayKeys.push(new Date(t).toISOString().slice(0, 10));
  const [dayBlobs, raw, limits] = await Promise.all([
    Promise.all(dayKeys.map((d) => s.get("d:" + d, { type: "json" }).catch(() => null))),
    rawCalls(s), getLimits(),
  ]);
  const hours = {};
  dayBlobs.forEach((d) => { if (d) for (const [hh, h] of Object.entries(d.hours || {})) hours[d.day + "T" + hh] = h; });
  for (const { call } of raw) { const h = hourOf(call.at); if (!hours[h] || hours[h].live) { hours[h] = hours[h] || Object.assign(blankHour(), { live: true }); add(hours[h], call); } }
  const tot = blankHour(), sinceHour = hourOf(since);
  let peakHour = null, peakMin = null;
  const rows = Object.keys(hours).filter((k) => k >= sinceHour).sort().map((k) => {
    const h = hours[k];
    tot.n += h.n; tot.err += h.err; tot.r429 += h.r429; tot.r5xx += h.r5xx; tot.msSum += h.msSum; if (h.msMax > tot.msMax) tot.msMax = h.msMax;
    for (const f of ["src", "path", "site"]) for (const [x, v] of Object.entries(h[f])) tot[f][x] = (tot[f][x] || 0) + v;
    let pm = null; for (const [m, v] of Object.entries(h.min)) if (!pm || v > pm.n) pm = { at: k + ":" + m, n: v };
    if (!peakHour || h.n > peakHour.n) peakHour = { at: k, n: h.n };
    if (pm && (!peakMin || pm.n > peakMin.n)) peakMin = pm;
    return { hour: k, n: h.n, err: h.err, r429: h.r429, r5xx: h.r5xx, avgMs: h.n ? Math.round(h.msSum / h.n) : 0, maxMs: h.msMax, peakMin: pm, overMin: Object.values(h.min).filter((v) => v > limits.perMinute).length };
  });
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
  return {
    days, limits, hours: rows,
    total: tot.n, errors: tot.err, tooMany: tot.r429, snErrors: tot.r5xx, avgMs: tot.n ? Math.round(tot.msSum / tot.n) : 0, maxMs: tot.msMax,
    peakHour, peakMin,
    hoursOver: rows.filter((r) => r.n > limits.perHour).length, minutesOver: rows.reduce((t, r) => t + r.overMin, 0),
    bySource: top(tot.src, 20), byPath: top(tot.path, 20), bySite: top(tot.site, 20),
  };
}

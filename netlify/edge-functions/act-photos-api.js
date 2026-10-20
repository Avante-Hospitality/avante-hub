// /api/act-photos — one main photo for every activity on the Avante map,
// filled in ahead of time (Jean, 2026-10-14), so front stores and the hook
// builder always have one. Order: the activity's own photo on the Avante map
// (admin's), else the shared photo library, else Google (then saved to the
// library). What's chosen is the activity's main photo ("act-photos" store);
// affiliates can still pick another one for their own front store.
//   POST {action:"fill"} with x-pa-sync-secret (act-photos-sync, every 2 min):
//        all activities with a map photo at once, plus up to 12 searches.
//   GET            → { ok, activities, done, found, notFound, toDo }
//   GET ?report=1  → the activities where nothing was found (for admin)
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { liveRemembered, fillActPhotos } from "./lib/act-photos.js";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
const SEARCHES_PER_RUN = 12;
const memoStore = () => getStore({ name: "act-photos", consistency: "strong" });
const mapPhoto = (a) => { const k = (Array.isArray(a.photoKeys) && a.photoKeys[0]) || a.photoKey; return k ? "/api/property-file?key=" + encodeURIComponent(k) : ""; };

async function state() {
  const acts = ((await getStore({ name: "map-activities", consistency: "strong" }).get("all", { type: "json" }).catch(() => null)) || [])
    .filter((a) => a && a.id && a.name && a.visible !== false);
  return { acts, memo: await liveRemembered().catch(() => ({})) };
}

export default async (request) => {
  const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";
  const url = new URL(request.url);
  if (request.method === "GET") {
    const { acts, memo } = await state();
    const nothing = acts.filter((a) => a.id in memo && !memo[a.id]);
    if (url.searchParams.get("report") === "1") return json({ ok: true, count: nothing.length, activities: nothing.map((a) => ({ id: a.id, name: a.name, area: a.area || "" })).sort((x, y) => x.area.localeCompare(y.area) || x.name.localeCompare(y.name)) });
    return json({ ok: true, activities: acts.length, done: acts.filter((a) => a.id in memo).length, found: acts.filter((a) => memo[a.id]).length, notFound: nothing.length, toDo: acts.filter((a) => !(a.id in memo)).length });
  }
  const secret = env("PA_SYNC_SECRET");
  if (!secret || request.headers.get("x-pa-sync-secret") !== secret) return json({ ok: false, error: "forbidden" }, 403);
  const { acts, memo } = await state();
  // 1. Admin's own photos on the Avante map: the main photo straight away.
  let quick = 0;
  for (const a of acts) { const p = mapPhoto(a); if (p && !memo[a.id]) { memo[a.id] = p; quick++; } }
  if (quick) await memoStore().setJSON("map", memo);
  // 2. The rest: library first, then Google, a few each run.
  const todo = acts.filter((a) => !(a.id in memo)).slice(0, SEARCHES_PER_RUN)
    .map((a) => ({ id: a.id, name: a.name, area: a.area || "", latitude: parseFloat(a.latitude), longitude: parseFloat(a.longitude) }));
  const found = todo.length ? await fillActPhotos(todo, SEARCHES_PER_RUN) : {};
  return json({ ok: true, fromMapPhotos: quick, looked: todo.length, found: Object.values(found).filter(Boolean).length, left: Math.max(0, acts.filter((a) => !(a.id in memo)).length - todo.length) });
};

export const config = { path: "/api/act-photos" };

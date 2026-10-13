// What a property's front store page shows (/stay/<slug>), built in one
// place so the public page (stay-api.js) and the builder's live preview in
// the Property Affiliate tab (pa-api.js → frontPreview) always match.
// opts: { store, origin, km, later(promise), all } — all = also the hidden
// activities (marked hidden: true), for the builder.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { fetchResortInfo } from "./hook-source.js";
import { propertyTreeOpts } from "./tree-place.js";
import { nearestByDistance } from "./geo-distance.js";

const INFO_TTL_MS = 24 * 3600 * 1000;

export async function stayPayload(core, prop, opts) {
  const { store, origin } = opts, later = opts.later || ((p) => p);
  const page = core.publicFrontStore(prop);
  // Photos and description from Stock Network's resort info page (cached a day).
  let info = await store.get("fsinfo:" + prop.siteId, { type: "json" }).catch(() => null);
  if (!info || Date.now() - (info.at || 0) > INFO_TTL_MS) {
    const fresh = await fetchResortInfo(prop.resortId, prop.site).catch(() => null);
    if (fresh) { info = { at: Date.now(), description: fresh.description || "", attractions: fresh.attractions || "", moreInfo: fresh.moreInfo || "", images: fresh.images || [] }; later(store.setJSON("fsinfo:" + prop.siteId, info).catch(() => {})); }
  }
  info = info || { description: "", attractions: "", moreInfo: "", images: [] };
  const own = "fsphoto:" + prop.siteId + ":";
  const uploaded = (await store.list({ prefix: own })).blobs.filter((b) => !b.key.slice(own.length).startsWith("x-")).map((b) => "/api/stay?photo=" + encodeURIComponent(b.key.slice(8)));
  const photos = Array.isArray(page.photos) && page.photos.length ? page.photos : uploaded.concat(info.images || []).slice(0, 24);
  // Where it is: the hub's location tree, and the pin from the resort list.
  const place = await propertyTreeOpts(prop.resortId, origin, prop.resortName).catch(() => ({}));
  const rl = await getStore({ name: "resort-list", consistency: "strong" }).get("current", { type: "json" }).catch(() => null);
  const pin = ((rl && rl.resorts) || []).find((r) => r && r.resortId === prop.resortId) || {};
  const lat = parseFloat(pin.latitude), lng = parseFloat(pin.longitude);
  let nearby = [], outKm = page.nearbyKm || 30;
  if ((page.showActivities || opts.all) && isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0)) {
    const acts = ((await getStore({ name: "map-activities", consistency: "strong" }).get("all", { type: "json" }).catch(() => null)) || []).filter((a) => a && a.visible !== false);
    // The property sets its default distance; the guest can change it on the page (?km=).
    const km = Math.max(1, Math.min(150, Number(opts.km) || page.nearbyKm || 30));
    outKm = km;
    const hidden = new Set(page.actHidden || []), mine = page.actPhotos || {};
    nearby = nearestByDistance(lat, lng, acts, { limit: opts.all ? 40 : 24 + hidden.size, maxKm: km }).map((a) => {
      const keys = Array.isArray(a.photoKeys) ? a.photoKeys : a.photoKey ? [a.photoKey] : [];
      return { name: a.name || "", area: a.area || "", price: a.price || "", description: String(a.description || "").slice(0, 300), link: a.contactLink || "",
        photo: mine[a.name] || (keys[0] ? "/api/property-file?key=" + encodeURIComponent(keys[0]) : ""), latitude: parseFloat(a.latitude), longitude: parseFloat(a.longitude), distance: a.distanceLabel,
        hidden: hidden.has(a.name), basePhoto: opts.all ? (keys[0] ? "/api/property-file?key=" + encodeURIComponent(keys[0]) : "") : undefined };
    }).filter((a) => opts.all || !a.hidden).slice(0, opts.all ? 40 : 24);
  }
  return Object.assign({ ok: true }, page, {
    photos, description: page.description || info.description || "", attractions: info.attractions || "", moreInfo: info.moreInfo || "",
    place: { country: place.country || "", province: place.province || "", region: place.region || "", city: place.city || "", suburb: place.suburb || "" },
    latitude: isFinite(lat) && lat !== 0 ? lat : null, longitude: isFinite(lng) && lng !== 0 ? lng : null, nearby, nearbyKm: outKm,
    actPhotos: undefined, actHidden: undefined,
  }, opts.all ? { snPhotos: info.images || [], snDescription: info.description || "", uploaded } : {});
}

// Reads a property's public Stock Network page (ResortInfo.aspx) — the same
// page and the same reading as the hook builder's /api/sn?info= (avante-hooks
// netlify/functions/sn.mjs). Used when admin creates a listing for a property
// that is already on Stock Network (Jean, 2026-10-13): a property on
// NightsBridge feeds Stock Network, so this is how the hub gets its details
// without asking the property to type them again.
//   readResortInfo(resortId) -> { ok, name, about, attractions, facilities[], units[{name, roomType, maxGuests, description}], photos[] }
import { snFetch } from "./sn-log.js";

export const RESORT_INFO = "https://old.stocknetwork.co.za/ResortInfo.aspx";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const decode = (s) => String(s || "")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&rsquo;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
function label(html, id) {
  const m = html.match(new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</(?:h\\d|span|div|p|label)>', "i"));
  return m ? decode(m[1]) : "";
}

export function parseResortInfo(html, page) {
  const name = label(html, "lblResortName").replace(/!+$/, "").trim();
  const about = label(html, "lblAboutUs");
  const attractions = label(html, "lblAttractions");
  const facilities = [];
  const fb = html.match(/id="dvAmentities"[\s\S]*?<\/div>\s*<\/div>\s*(?:\r?\n)/i) || html.match(/id="dvAmentities"[\s\S]{0,4000}/i);
  if (fb) for (const m of fb[0].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) { const t = decode(m[1]); if (t && !facilities.includes(t)) facilities.push(t); }
  const units = [];
  const ui = html.indexOf('id="dvModals"'), uj = html.indexOf('id="staticBackdrop"', ui);
  if (ui >= 0) {
    const seg = html.slice(ui, uj > ui ? uj : undefined);
    for (const blk of seg.split(/class='modal-title'/i).slice(1)) {
      const nm = blk.match(/<b>([\s\S]*?)<\/b>/i), rt = blk.match(/Room Type:<span>([^<]*)<\/span>/i), mg = blk.match(/Max Guests:<span>\s*(\d+)/i);
      units.push({ name: nm ? decode(nm[1]) : "", roomType: rt ? decode(rt[1]) : "", maxGuests: mg ? +mg[1] : 0, description: "" });
    }
  }
  const ti = html.indexOf('id="dvUnitTypes"');
  if (ti >= 0) {
    const end = html.indexOf('id="dvModals"', ti);
    const seg = html.slice(ti, end > ti ? end : undefined);
    for (const blk of seg.split(/<h3>\s*<b>/i).slice(1)) {
      const name = decode((blk.match(/^([\s\S]*?)<\/b>/) || ["", ""])[1]).trim();
      const desc = decode((blk.match(/<h5>([\s\S]*?)<\/h5>/i) || ["", ""])[1]).replace(/\s+/g, " ").trim();
      const rt = decode((blk.match(/Room Type:<span>([^<]*)<\/span>/i) || ["", ""])[1]).trim();
      const mg = +((blk.match(/Max Guests:<span>\s*(\d+)/i) || [0, 0])[1]);
      const sl = mg || +((rt.match(/(\d+)\s*-?\s*sleeper/i) || [0, 0])[1]) || +((desc.match(/(\d+)\s*-?\s*sleeper/i) || [0, 0])[1]) || +((desc.match(/sleeps\s*(\d+)/i) || [0, 0])[1]);
      const type = (desc.split(/\d+\s*-?\s*sleeper/i)[0] || "").trim() || rt;
      if (!name) continue;
      const u = units.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
      if (u) { if (!u.maxGuests && sl) u.maxGuests = sl; if (!u.roomType && type) u.roomType = type; if (!u.description && desc) u.description = desc; }
      else units.push({ name, roomType: type, maxGuests: sl, description: desc });
    }
  }
  const seen = new Set(), photos = [];
  for (const m of html.matchAll(/<img[^>]+src=['"]([^'"]+)['"]/gi)) {
    const src = m[1];
    const gallery = /\/image\/\d+\/gallery\//i.test(src);
    if (!/\/data\/resort\//i.test(src) && !gallery) continue;
    const abs = gallery ? new URL(src, page).href.replace(/\/image\/\d+\//, "/image/1200/") : new URL(src, page).href;
    if (!seen.has(abs)) { seen.add(abs); photos.push(abs); }
  }
  return { name, about, attractions, facilities, units: units.filter((u) => u.name), photos };
}

export async function readResortInfo(resortId, fetchImpl = snFetch({ source: "Property page" })) {
  if (!GUID.test(String(resortId || ""))) return { ok: false, error: "No valid Resort ID." };
  const page = RESORT_INFO + "?ResortID=" + encodeURIComponent(resortId);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetchImpl(page, { headers: { "user-agent": "AvanteHub/1.0" }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: "Stock Network answered " + res.status + "." };
    const info = parseResortInfo(await res.text(), page);
    if (!info.name && !info.photos.length) return { ok: false, error: "Stock Network has no public page for this property." };
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: "Stock Network didn't respond." };
  }
}

// Copies up to `max` of the property's Stock Network photos into the hub's
// listing files, so they show on the listing and its photo link.
export async function copySnPhotos(urls, listingId, filesStore, max = 12, fetchImpl = snFetch({ source: "Property photos" })) {
  const out = [];
  await Promise.all((urls || []).slice(0, max).map(async (u, i) => {
    try {
      const host = new URL(u).hostname;
      if (!/(^|\.)stocknetwork\.co\.za$/i.test(host)) return;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetchImpl(u, { signal: ctl.signal }); clearTimeout(t);
      if (!r.ok) return;
      const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
      if (!/^image\//.test(type)) return;
      const buf = await r.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 10 * 1024 * 1024) return;
      const fileName = "stocknetwork-" + String(i + 1).padStart(2, "0") + "." + (type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const key = listingId + "/image/" + Date.now() + "-" + i + "-" + fileName;
      await filesStore.set(key, buf, { metadata: { contentType: type, fileName, listingId, kind: "image", label: "stocknetwork" } });
      out[i] = { type: "Property", unitTypeName: "", key, fileName, caption: "Photo from Stock Network", cover: i === 0 ? "Y" : "N" };
    } catch (e) { /* a photo that can't be fetched is skipped */ }
  }));
  return out.filter(Boolean);
}

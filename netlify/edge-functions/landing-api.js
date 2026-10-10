// Landing pages from the hook builder (Jean, 2026-10-08).
//
// The hook builder publishes a hook's pages 2+ here; they're shown to the
// public by landing-page.js at go.avantetravel.co.za/l/<name>. Only the hook
// builder can publish: every POST must carry x-hooks-sig, an HMAC of the
// body with HOOKS_SSO_SECRET (the same secret the hook builder sign-in
// uses), and says who is publishing (owner). A page belongs to whoever
// published it first; only they (or admin) can replace it.
//
//   POST { op:"image", data:"data:image/jpeg;base64,…" } → { ok, key }   (stored once, by content)
//   POST { op:"publish", slug, content }                 → { ok, slug, url, version }
//   POST { op:"info", slug }                             → { ok, exists, mine, updatedAt, endDate }
//   POST { op:"slots" }                                  → { ok, slots:[{hook,title,landing,updatedAt}] }   (admin)
//   POST { op:"toHook", slug, hook, caption }            → { ok, hook }   (admin: fills Default Hook <hook>)
//   GET  ?img=<key>                                      → the picture (public)
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { ADMIN_MASTER_SITE_GUID, correctBookingLinkSiteId, holidayBuilderUrl } from "./lib/booking-link.js";
import { propertyTreeOpts, withTreePath } from "./lib/tree-place.js";
import { isShortLink, resolveShortLink } from "./lib/short-link.js";
import { generateHashtags } from "./lib/hashtag-helper.js";
import { AI_SCAN_CACHE_FIELDS_CLEARED } from "./lib/record-merge.js";

export const LANDING_STORE = "landing-pages";
const IMAGE_STORE = "landing-images";
const PUBLIC_HOST = "https://go.avantetravel.co.za";
const MAX_IMAGE = 3 * 1024 * 1024;
const KEEP_VERSIONS = 10;
const DEFAULT_HOOK_COUNT = 6;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

const enc = new TextEncoder();
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function validSig(raw, sig) {
  const secret = Deno.env.get("HOOKS_SSO_SECRET") || "";
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
  if (want.length !== sig.length) return false;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
function bytesOf(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const bin = atob(m[2]), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { type: "image/" + m[1], bytes: out };
}
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const isKey = (k) => /^[0-9a-f]{64}$/.test(String(k || ""));
// Only what the page shows — nothing else from the hook builder is kept.
function cleanContent(c) {
  c = c && typeof c === "object" ? c : {};
  const pages = (Array.isArray(c.pages) ? c.pages : []).slice(0, 8).filter((p) => p && isKey(p.img)).map((p) => ({
    img: p.img, w: +p.w || 1080, h: +p.h || 1350,
    links: (Array.isArray(p.links) ? p.links : []).slice(0, 8).filter((a) => a && /^(https?:|tel:|mailto:)/i.test(String(a.url || "")))
      .map((a) => ({ x: +a.x || 0, y: +a.y || 0, w: +a.w || 0, h: +a.h || 0, url: str(a.url, 600), label: str(a.label, 80) })),
    props: (Array.isArray(p.props) ? p.props : []).slice(0, 3).filter((x) => x && x.resortId)
      .map((x) => ({ name: str(x.name, 100), resortId: str(x.resortId, 60),
        at: x.at && [x.at.x, x.at.y, x.at.w, x.at.h].every((v) => Number.isFinite(+v)) ? { x: +x.at.x, y: +x.at.y, w: +x.at.w, h: +x.at.h } : null })),
  }));
  return {
    title: str(c.title, 120), kind: str(c.kind, 20), dates: str(c.dates, 120),
    checkIn: /^\d{4}-\d{2}-\d{2}$/.test(c.checkIn || "") ? c.checkIn : "", checkOut: /^\d{4}-\d{2}-\d{2}$/.test(c.checkOut || "") ? c.checkOut : "",
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(c.endDate || "") ? c.endDate : "",
    scenes: (Array.isArray(c.scenes) ? c.scenes : []).filter(isKey).slice(0, 6),
    cover: isKey(c.cover) ? c.cover : "", coverW: +c.coverW || 0, coverH: +c.coverH || 0, fbCover: isKey(c.fbCover) ? c.fbCover : "", description: str(c.description, 300),
    // The hook builder's own Booking link (Jean, 2026-10-08) — what Book now opens.
    booking: /^https:\/\/[^\s"<>]+$/i.test(String(c.booking || "")) ? str(c.booking, 600) : "",
    whatsapp: str(String(c.whatsapp || "").replace(/[^\d]/g, ""), 16), waText: str(c.waText, 300),
    pages,
  };
}

export default async (request) => {
  const store = getStore({ name: LANDING_STORE, consistency: "strong" });
  const images = getStore({ name: IMAGE_STORE, consistency: "strong" });
  const url = new URL(request.url);

  if (request.method === "GET") {
    const key = url.searchParams.get("img") || "";
    if (!isKey(key)) return new Response("Not found", { status: 404 });
    const rec = await images.getWithMetadata(key, { type: "arrayBuffer" });
    if (!rec || !rec.data) return new Response("Not found", { status: 404 });
    return new Response(rec.data, { headers: { "content-type": (rec.metadata && rec.metadata.type) || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Use GET or POST." }, 405);

  const raw = await request.text();
  if (raw.length > MAX_IMAGE * 1.4 + 20000) return json({ ok: false, error: "That's too big to publish." }, 413);
  if (!(await validSig(raw, request.headers.get("x-hooks-sig") || ""))) return json({ ok: false, error: "Only the hook builder can publish landing pages." }, 401);
  let b; try { b = JSON.parse(raw); } catch (e) { return json({ ok: false, error: "Bad request." }, 400); }
  if (!b.at || Math.abs(Date.now() - b.at) > 10 * 60 * 1000) return json({ ok: false, error: "This request is too old. Try again." }, 401);
  const owner = b.owner && b.owner.sub ? { sub: str(b.owner.sub, 80), role: b.owner.role === "admin" ? "admin" : "affiliate", name: str(b.owner.name, 80) } : null;
  if (!owner) return json({ ok: false, error: "Who is publishing?" }, 400);

  if (b.op === "image") {
    const img = bytesOf(b.data);
    if (!img || img.bytes.length > MAX_IMAGE) return json({ ok: false, error: "That picture can't be used." }, 400);
    const key = hex(await crypto.subtle.digest("SHA-256", img.bytes));
    const have = await images.getMetadata(key).catch(() => null);
    if (!have) await images.set(key, img.bytes.buffer, { metadata: { type: img.type, by: owner.sub, at: new Date().toISOString() } });
    return json({ ok: true, key });
  }

  // Admin's Default Hooks (Jean, 2026-10-08): "Send to hub" in the hook
  // builder puts a published landing page on Default Hook 1-6 — page 1 as
  // the hook's picture, the caption, the landing page as its "See full
  // details" link and a Book now link for the hook's dates. Affiliates see
  // it with their own ID in both links (hook-api.js).
  if (b.op === "slots" || b.op === "toHook") {
    if (owner.role !== "admin") return json({ ok: false, error: "Only Avante admin can change the Default Hooks." }, 403);
    const hooks = getStore({ name: "promo-hooks", consistency: "strong" });
    if (b.op === "slots") {
      const slots = [];
      for (let n = 1; n <= DEFAULT_HOOK_COUNT; n++) {
        const r = await hooks.get("__admin__:" + n, { type: "json" }).catch(() => null);
        slots.push({ hook: n, title: r ? str(r.hookTitle || (r.caption || "").split("\n")[0], 70) : "", landing: r ? r.landing || "" : "", used: !!(r && (r.booking || r.landing || r.caption)), updatedAt: r ? r.updatedAt || null : null });
      }
      return json({ ok: true, slots });
    }
    const n = Number(b.hook);
    if (!Number.isInteger(n) || n < 1 || n > DEFAULT_HOOK_COUNT) return json({ ok: false, error: "Pick Default Hook 1 to " + DEFAULT_HOOK_COUNT + "." }, 400);
    const lslug = str(b.slug, 60).toLowerCase();
    const lp = SLUG_RE.test(lslug) ? await store.get(lslug, { type: "json" }) : null;
    if (!lp || !lp.current) return json({ ok: false, error: "Publish the landing page first." }, 400);
    const c = lp.current, key = "__admin__:" + n, now = new Date().toISOString();
    const existing = (await hooks.get(key, { type: "json" }).catch(() => null)) || {};
    const fields = { landing: PUBLIC_HOST + "/l/" + lslug, landingSlug: lslug, hookTitle: c.title || "", updatedAt: now, galleryCount: 0, source: null,
      category: c.kind === "event" ? "event" : "property", flyerDates: c.dates || "" };
    // Book now: everything available for the hook's dates (a property hook:
    // that property), under the placeholder ID hook-api.js swaps per affiliate.
    const firstProp = c.kind === "property" ? (c.pages.find((x) => x.props && x.props.length) || {}).props : null;
    const propTree = firstProp && firstProp[0]
      ? await propertyTreeOpts(firstProp[0].resortId, new URL(request.url).origin, firstProp[0].name).catch(() => ({ property: firstProp[0].name }))
      : {};
    fields.booking = holidayBuilderUrl(ADMIN_MASTER_SITE_GUID, {
      ...propTree,
      resortId: firstProp && firstProp[0] ? firstProp[0].resortId : "",
      checkIn: c.checkIn || "",
      checkOut: c.checkOut || "",
    });
    // The hook builder's Booking link wins, with the placeholder ID hook-api.js swaps per affiliate.
    if (c.booking) {
      let link = c.booking;
      if (isShortLink(link)) link = (await resolveShortLink(link, getStore({ name: "short-links", consistency: "strong" })).catch(() => "")) || link;
      fields.booking = correctBookingLinkSiteId(link, ADMIN_MASTER_SITE_GUID).url;
      fields.booking = await withTreePath(fields.booking, new URL(request.url).origin).catch(() => fields.booking);
    }
    if (typeof b.caption === "string") {
      fields.caption = b.caption.trim().slice(0, 3000);
      fields.hashtags = await generateHashtags(fields.caption).catch(() => null);
    }
    // Page 1 becomes the hook's picture (a copy, so the hook keeps working on its own).
    if (c.cover) {
      const img = await images.getWithMetadata(c.cover, { type: "arrayBuffer" }).catch(() => null);
      if (img && img.data) {
        await getStore({ name: "promo-hook-images", consistency: "strong" }).set(key, img.data, { metadata: { contentType: (img.metadata && img.metadata.type) || "image/jpeg", sourceUrl: "landing:" + lslug } });
        fields.imageHash = c.cover;
        if (existing.imageHash !== c.cover) Object.assign(fields, AI_SCAN_CACHE_FIELDS_CLEARED);
      }
    }
    await hooks.setJSON(key, { ...existing, ...fields });
    return json({ ok: true, hook: n, landing: fields.landing });
  }

  const slug = str(b.slug, 60).toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ ok: false, error: "A link name needs 3–60 letters, numbers or dashes (e.g. dunes-december)." }, 400);
  const rec = await store.get(slug, { type: "json" });
  const mine = !rec || rec.owner.sub === owner.sub || owner.role === "admin";

  if (b.op === "info") {
    return json({ ok: true, exists: !!rec, mine, updatedAt: rec ? rec.updatedAt : null, endDate: rec && rec.current ? rec.current.endDate : null, version: rec ? rec.version : 0 });
  }
  if (b.op === "publish") {
    if (!mine) return json({ ok: false, error: `The link name "${slug}" is already used by someone else. Pick another name.` }, 409);
    const content = cleanContent(b.content);
    if (!content.pages.length) return json({ ok: false, error: "This hook has no pages to publish yet." }, 400);
    const now = new Date().toISOString();
    const versions = rec ? [{ at: rec.updatedAt, content: rec.current }, ...(rec.versions || [])].slice(0, KEEP_VERSIONS) : [];
    const next = { slug, owner: rec ? rec.owner : owner, current: content, versions, version: (rec ? rec.version || 1 : 0) + 1, createdAt: rec ? rec.createdAt : now, updatedAt: now, by: owner.name || owner.sub };
    await store.setJSON(slug, next);
    return json({ ok: true, slug, url: PUBLIC_HOST + "/l/" + slug, version: next.version });
  }
  return json({ ok: false, error: "Unknown request." }, 400);
};

export const config = { path: "/api/landing" };

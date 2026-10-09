// "Post to Facebook" under a hook (Jean, 2026-10-09).
//
// Posts a hook onto the Avante Travel Facebook Page's wall: the hook's
// caption (plus its Facebook hashtags) as the text, and its landing page
// link, so Facebook shows the landing page's picture and title as a
// clickable card. Testing phase: only admin and the affiliates listed in
// FB_POST_AFFILIATES (default: Avante's own site 36) can use it, and
// everything goes to the one Page in FB_PAGE_ID.
//
// Netlify environment variables (secret):
//   FB_PAGE_ID         the Avante Travel Page's ID (1250982098099907)
//   FB_USER_TOKEN      Jean's long-lived (60-day) user token from the
//                      "Avante Hub" Meta app, with pages_manage_posts. The
//                      first post swaps it for the Page's own token, which
//                      doesn't expire, and keeps that in the "fb-config" store.
//   FB_PAGE_TOKEN      optional: a Page token to use directly instead
//   FB_POST_AFFILIATES optional, comma-separated affiliate IDs allowed to post
//
//   POST { op:"status" }                                  → { ok, configured, allowed }
//   POST { op:"preview"|"post", hook, admin:token }       (admin)
//   POST { op:"preview"|"post", hook, aff, session }      (affiliate)
//     preview → { ok, message, link }     post → { ok, postId, url }
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { ADMIN_MASTER_SITE_GUID } from "./lib/booking-link.js";

const GRAPH = "https://graph.facebook.com/v26.0";
const DEFAULT_PASSWORD = "0000"; // same as auth-api.js
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAdmin(token) {
  if (typeof token !== "string" || !token) return false;
  const s = await getStore({ name: "admin-sessions", consistency: "strong" }).get(token, { type: "json" });
  return !!(s && new Date(s.expiresAt).getTime() > Date.now());
}

async function isAffiliate(aff, session) {
  if (!aff || typeof session !== "string" || !session) return false;
  const rec = await getStore({ name: "affiliate-auth", consistency: "strong" }).get(aff, { type: "json" });
  const hash = rec && rec.passwordHash ? rec.passwordHash : await sha256Hex(DEFAULT_PASSWORD);
  const s = await getStore({ name: "affiliate-sessions", consistency: "strong" }).get(session.trim().slice(0, 100), { type: "json" });
  return !!(s && s.aff === aff && s.ph === hash.slice(0, 16));
}

function allowedAffiliates() {
  const list = (Deno.env.get("FB_POST_AFFILIATES") || "").split(",").map((x) => x.trim()).filter(Boolean);
  return list.length ? list : [ADMIN_MASTER_SITE_GUID];
}

// The hook exactly as the hub shows it (same as GET /api/hook).
async function readHook(origin, aff, hook) {
  const r = await fetch(origin + "/api/hook?aff=" + encodeURIComponent(aff) + "&hook=" + encodeURIComponent(hook));
  if (!r.ok) return null;
  return r.json();
}

// The Page token to post with: FB_PAGE_TOKEN if set, else the one swapped
// from FB_USER_TOKEN (kept per user token, so pasting a new user token in
// Netlify makes a fresh swap). `fresh` skips the kept one after an error.
async function pageToken(pageId, fresh) {
  const direct = Deno.env.get("FB_PAGE_TOKEN") || "";
  if (direct) return direct;
  const user = Deno.env.get("FB_USER_TOKEN") || "";
  if (!user || !pageId) return "";
  const store = getStore({ name: "fb-config", consistency: "strong" });
  const key = "page-token:" + pageId + ":" + (await sha256Hex(user)).slice(0, 16);
  if (!fresh) { try { const kept = await store.get(key, { type: "json" }); if (kept && kept.token) return kept.token; } catch (e) {} }
  const r = await fetch(GRAPH + "/" + encodeURIComponent(pageId) + "?fields=access_token&access_token=" + encodeURIComponent(user));
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error((d.error && d.error.message) || "Couldn't get the Page's token from Facebook.");
  await store.setJSON(key, { token: d.access_token, at: new Date().toISOString() });
  return d.access_token;
}

function buildPost(h) {
  const caption = String(h.caption || "").trim();
  let tags = [];
  try { tags = (h.hashtags && h.hashtags.facebook) || []; } catch (e) {}
  const missing = tags.map((t) => "#" + String(t).replace(/^#/, "")).filter((t) => !caption.toLowerCase().includes(t.toLowerCase()));
  const link = /^https:\/\//i.test(h.landing || "") ? h.landing : /^https:\/\//i.test(h.booking || "") ? h.booking : "";
  const message = [caption, missing.join(" ")].filter(Boolean).join("\n\n");
  return { message, link };
}

export default async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "Bad request." }, 400); }
  const op = body.op || "status";
  const pageId = Deno.env.get("FB_PAGE_ID") || "";
  const configured = !!(pageId && (Deno.env.get("FB_PAGE_TOKEN") || Deno.env.get("FB_USER_TOKEN")));

  // Who is asking: admin, or an allowed affiliate who is logged in.
  let aff = "";
  if (body.admin) {
    if (!(await isAdmin(body.admin))) return json({ ok: false, relogin: true, error: "Please log in again." }, 401);
    aff = ADMIN_MASTER_SITE_GUID;
  } else {
    const a = String(body.aff || "").trim();
    if (!allowedAffiliates().includes(a)) return json({ ok: true, configured, allowed: false });
    if (!(await isAffiliate(a, body.session))) return json({ ok: false, relogin: true, error: "Please log in again." }, 401);
    aff = a;
  }
  if (op === "status") return json({ ok: true, configured, allowed: true });

  const hook = String(body.hook || "").replace(/[^0-9]/g, "");
  if (!hook) return json({ ok: false, error: "Which hook?" }, 400);
  const h = await readHook(new URL(request.url).origin, aff, hook);
  if (!h) return json({ ok: false, error: "Couldn't read this hook." }, 404);
  if (h.expired) return json({ ok: false, error: "This hook's offer has ended." }, 400);
  const post = buildPost(h);
  if (!post.message && !post.link) return json({ ok: false, error: "This hook has no caption or link yet." }, 400);
  if (op === "preview") return json({ ok: true, configured, ...post });
  if (op !== "post") return json({ ok: false, error: "Unknown op." }, 400);
  if (!configured) return json({ ok: false, error: "Facebook isn't connected yet (FB_PAGE_ID / FB_USER_TOKEN missing in Netlify)." }, 503);

  const send = async (fresh) => {
    const form = new URLSearchParams({ access_token: await pageToken(pageId, fresh) });
    if (post.message) form.set("message", post.message);
    if (post.link) form.set("link", post.link);
    const r = await fetch(GRAPH + "/" + encodeURIComponent(pageId) + "/feed", { method: "POST", body: form });
    return { r, d: await r.json().catch(() => ({})) };
  };
  let r, d;
  try {
    ({ r, d } = await send(false));
    // A kept Page token that stopped working: swap again once.
    if (d.error && d.error.code === 190 && !Deno.env.get("FB_PAGE_TOKEN")) ({ r, d } = await send(true));
  } catch (e) {
    return json({ ok: false, error: e.message || "Couldn't reach Facebook." }, 502);
  }
  if (!r.ok || !d.id) {
    const msg = (d.error && d.error.message) || "Facebook said no (" + r.status + ").";
    return json({ ok: false, error: msg, expiredToken: !!(d.error && d.error.code === 190) }, 502);
  }
  const [pid, sid] = String(d.id).split("_");
  return json({ ok: true, postId: d.id, url: "https://www.facebook.com/" + pid + "/posts/" + (sid || "") });
};

export const config = { path: "/api/fb-post" };

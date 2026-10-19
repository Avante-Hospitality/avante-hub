import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { SHORT_LINK_HOST, randomSlug, affIndexKey, addToAffIndex, SLUG_ALPHABET, RANDOM_SLUG_LEN, isShortSlug } from "./lib/short-link.js";

const MAX_ALIAS_LEN = 40;

function isSafeUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// Jean (2026-10-13): Admin's affiliate Details window shortened the same 5
// links every time it opened, filling an affiliate's list with copies. Now a
// link the affiliate already has a short code for gets that same code back,
// and the list shows one row per destination (clicks of older copies added;
// the older codes keep working in case one was shared).
async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join(""); }
// A custom name someone chose (e.g. "my-esim") is never folded into another row.
const RANDOM_RE = new RegExp("^[" + SLUG_ALPHABET + "]{" + RANDOM_SLUG_LEN + "}$");
const isCustom = (r) => !!(r && (r.alias || !RANDOM_RE.test(r.slug)));
const urlKey = async (aff, url) => "url:" + aff + ":" + (await sha(url));
async function existingSlugFor(store, aff, url) {
  if (!aff) return null;
  const k = await urlKey(aff, url);
  const known = await store.get(k, { type: "json" });
  if (known && known.slug) {
    const rec = await store.get(known.slug, { type: "json" });
    if (rec && rec.url === url) return { slug: known.slug, record: rec };
  }
  // Links made before this check: look through the affiliate's own list once (oldest first).
  const slugs = (await store.get(affIndexKey(aff), { type: "json" })) || [];
  for (let i = slugs.length - 1; i >= 0; i--) {
    const rec = await store.get(slugs[i], { type: "json" });
    if (rec && rec.url === url && !isCustom({ slug: slugs[i], ...rec })) { await store.setJSON(k, { slug: slugs[i] }); return { slug: slugs[i], record: rec }; }
  }
  return null;
}

const isValidAlias = isShortSlug;

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const store = getStore({ name: "short-links", consistency: "strong" });

  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const slug = (url.searchParams.get("slug") || "").trim();
      const aff = (url.searchParams.get("aff") || "").trim();

      if (aff) {
        // Every short link this affiliate has created, one row per
        // destination (newest destination first). Copies of the same link are
        // folded into the one with the most clicks (the oldest on a tie); their
        // clicks are added up and their codes listed as still working.
        const slugs = (await store.get(affIndexKey(aff), { type: "json" })) || [];
        const records = (await Promise.all(slugs.map((s) => store.get(s, { type: "json" }).then((r) => (r ? { slug: s, ...r } : null))))).filter(Boolean);
        const groups = new Map();
        for (const r of records) { const g = isCustom(r) ? "alias:" + r.slug : r.url; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
        const links = [];
        for (const g of groups.values()) {
          const main = g.slice().sort((a, b) => (b.clicks || 0) - (a.clicks || 0) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")))[0];
          const others = g.filter((r) => r.slug !== main.slug);
          links.push({ slug: main.slug, shortUrl: "https://" + SHORT_LINK_HOST + "/" + main.slug, url: main.url, aff: main.aff, createdAt: main.createdAt,
            clicks: g.reduce((n, r) => n + (r.clicks || 0), 0), copies: others.length, otherShortUrls: others.map((r) => "https://" + SHORT_LINK_HOST + "/" + r.slug) });
        }
        return new Response(JSON.stringify({ ok: true, links }), {
          headers: { "content-type": "application/json", ...cors },
        });
      }

      if (!slug) {
        return new Response(JSON.stringify({ error: "missing slug or aff" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }
      const record = await store.get(slug, { type: "json" });
      if (!record) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json", ...cors },
        });
      }
      return new Response(JSON.stringify({ ok: true, slug, ...record }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, error: "Invalid request body." }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      const longUrl = (body && body.url ? String(body.url) : "").trim();
      const requestedAlias = (body && body.alias ? String(body.alias) : "").trim();
      const aff = (body && body.aff ? String(body.aff) : "").trim();

      if (!longUrl || !isSafeUrl(longUrl)) {
        return new Response(JSON.stringify({ ok: false, error: "Please provide a valid link to shorten." }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      let slug;

      if (!requestedAlias) {
        const have = await existingSlugFor(store, aff, longUrl);
        if (have) {
          return new Response(
            JSON.stringify({ ok: true, slug: have.slug, shortUrl: "https://" + SHORT_LINK_HOST + "/" + have.slug, existing: true, ...have.record }),
            { headers: { "content-type": "application/json", ...cors } }
          );
        }
      }

      if (requestedAlias) {
        if (!isValidAlias(requestedAlias)) {
          return new Response(
            JSON.stringify({ ok: false, error: "Custom alias can only contain letters, numbers, and hyphens (2-40 characters)." }),
            { status: 400, headers: { "content-type": "application/json", ...cors } }
          );
        }
        const existing = await store.get(requestedAlias, { type: "json" });
        if (existing && existing.url && existing.url !== longUrl) {
          return new Response(JSON.stringify({ ok: false, error: "That short link name is already taken — try another." }), {
            status: 409,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        slug = requestedAlias;
      } else {
        // Generate a random slug, retrying on the (rare) collision.
        for (let attempt = 0; attempt < 6; attempt++) {
          const candidate = randomSlug();
          const existing = await store.get(candidate, { type: "json" });
          if (!existing) {
            slug = candidate;
            break;
          }
        }
        if (!slug) {
          return new Response(JSON.stringify({ ok: false, error: "Could not generate a short link — please try again." }), {
            status: 500,
            headers: { "content-type": "application/json", ...cors },
          });
        }
      }

      const now = new Date().toISOString();
      const existingRecord = await store.get(slug, { type: "json" });
      const record = {
        url: longUrl,
        aff: aff || (existingRecord && existingRecord.aff) || "",
        createdAt: (existingRecord && existingRecord.createdAt) || now,
        clicks: (existingRecord && existingRecord.clicks) || 0,
      };
      if (requestedAlias || (existingRecord && existingRecord.alias)) record.alias = true;
      await store.setJSON(slug, record);

      // Keep a per-affiliate index of slugs so an affiliate's own short links
      // can be listed later (GET /api/shorten?aff=...) without having to scan
      // every short link in the store.
      await addToAffIndex(store, record.aff, slug);
      if (record.aff && !requestedAlias) await store.setJSON(await urlKey(record.aff, longUrl), { slug });

      return new Response(
        JSON.stringify({ ok: true, slug, shortUrl: "https://" + SHORT_LINK_HOST + "/" + slug, ...record }),
        { headers: { "content-type": "application/json", ...cors } }
      );
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...cors },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...cors },
    });
  }
};

export const config = { path: "/api/shorten" };

// /stay/<slug>, /stay/<slug>/guest and /stay/<slug>/card — serves stay.html
// (the property front store, the in-house guest page, or the printable room
// card) with the property's name and photo filled into the page title and
// share-card tags, so a link pasted into WhatsApp or Facebook shows the
// property. The page itself loads everything else from /api/stay.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

export default async (request) => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["stay", slug, mode?]
  const slug = String(parts[1] || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
  const mode = parts[2] === "guest" ? "guest" : parts[2] === "card" ? "card" : "store";
  const key = mode === "store" ? "" : String(parts[3] || "").replace(/[^a-z0-9]/gi, "").slice(0, 20);
  const res = await fetch(new URL("/stay.html", url.origin));
  let html = await res.text();
  let title = "Book direct · Avante Travel", desc = "Book your stay direct, with live availability.", image = url.origin + "/home-hero.jpg";
  try {
    const store = getStore({ name: "property-affiliate", consistency: "strong" });
    const link = slug ? await store.get("fslug:" + slug, { type: "json" }) : null;
    const prop = link ? await store.get("site:" + link.siteId, { type: "json" }) : null;
    const fs = prop && prop.frontStore;
    if (prop && fs && fs.on && fs.slug === slug) {
      title = (prop.resortName || "Book direct") + (mode === "guest" ? " · Guest information" : " · Book direct");
      desc = fs.welcome || ("Book " + (prop.resortName || "your stay") + " direct, with live availability.");
      let photo = Array.isArray(fs.photos) && fs.photos[0];
      if (!photo) { const info = await store.get("fsinfo:" + prop.siteId, { type: "json" }); photo = info && info.images && info.images[0]; }
      if (photo) image = photo.startsWith("/") ? url.origin + photo : photo;
    }
  } catch (_) { /* plain page */ }
  const meta = '<title>' + esc(title) + '</title>\n<meta name="description" content="' + esc(desc) + '">\n' +
    '<meta property="og:type" content="website">\n<meta property="og:title" content="' + esc(title) + '">\n<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:image" content="' + esc(image) + '">\n<meta property="og:url" content="' + esc(url.origin + url.pathname) + '">\n<meta name="twitter:card" content="summary_large_image">\n' +
    '<script>window.STAY = ' + JSON.stringify({ slug, mode, key }).replace(/</g, "\\u003c") + ';</script>';
  html = html.replace("<!--STAY-META-->", meta);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
};

export const config = { path: ["/stay/*"] };

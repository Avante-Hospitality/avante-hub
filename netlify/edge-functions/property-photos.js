// /api/property-photos — the photos of an onboarding listing, for Stock
// Network to upload (Jean, 2026-10-13). Admin's "Send the files by email"
// puts this link in the email:
//   GET ?l=<listingId>&k=<photosToken>           -> a page with every photo
//   GET ?l=<listingId>&k=<photosToken>&i=<n>     -> photo n, full size (&dl=1 to download)
//   GET ?l=<listingId>&k=<photosToken>&zip=1     -> all photos in one .zip
// The token is random and kept on the listing (photosToken), so only people
// with the email's link can open it. Photos are the originals the owner or
// admin uploaded in the onboarding form (property-listing-files store).
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (title, body, status = 200) => new Response(
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
  "<title>" + esc(title) + "</title><style>" +
  "body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f8f7;color:#0e2f44}" +
  "header{background:#0e2f44;color:#fff;padding:18px 16px}header h1{margin:0;font-size:20px}header p{margin:4px 0 0;color:#cfe3e0;font-size:14px}" +
  "main{max-width:1100px;margin:0 auto;padding:16px}.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 16px}" +
  ".btn{display:inline-block;background:#3fb8a9;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px}" +
  "h2{font-size:17px;margin:22px 0 10px}" +
  ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}" +
  "figure{margin:0;background:#fff;border:1px solid #d6e3e1;border-radius:10px;overflow:hidden}figure img{display:block;width:100%;height:170px;object-fit:cover;background:#e8efee}" +
  "figcaption{padding:8px 10px;font-size:13px;display:flex;justify-content:space-between;gap:8px}figcaption a{color:#1f7a6e;font-weight:700;white-space:nowrap}" +
  ".hint{color:#5b6b76;font-size:14px}</style></head><body>" + body + "</body></html>",
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

function safeName(s) { return String(s || "photo").replace(/[\\/:*?"<>|\r\n]+/g, "_").trim().slice(0, 120) || "photo"; }
function extFor(type, name) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(name || ""));
  if (m) return m[1].toLowerCase();
  return ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" })[String(type || "").split(";")[0]] || "jpg";
}

// --- a plain .zip (stored, not compressed: photos are already compressed) ---
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

export default async (request) => {
  const url = new URL(request.url);
  const id = String(url.searchParams.get("l") || "").slice(0, 20);
  const k = String(url.searchParams.get("k") || "").slice(0, 100);
  const bad = () => page("Link not valid", "<header><h1>This photo link isn't valid</h1><p>Ask Avante Travel for a new link.</p></header>", 404);
  if (!id || !k) return bad();
  const rec = await getStore({ name: "property-listings", consistency: "strong" }).get(id, { type: "json" }).catch(() => null);
  if (!rec || !rec.photosToken || rec.photosToken !== k) return bad();
  const files = getStore({ name: "property-listing-files", consistency: "strong" });
  const images = (Array.isArray(rec.images) ? rec.images : []).filter((im) => im && im.key);
  const label = (im, n) => [im.type, im.unitTypeName].filter(Boolean).join(" — ") || "Photo " + (n + 1);
  const fileNameOf = (im, n, type) => safeName((rec.propertyName || "property") + " " + String(n + 1).padStart(2, "0") + (im.unitTypeName ? " " + im.unitTypeName : "")) + "." + extFor(type, im.fileName);

  const iParam = url.searchParams.get("i");
  if (iParam !== null) {
    const n = parseInt(iParam, 10), im = images[n];
    if (!im) return new Response("Not found", { status: 404 });
    const got = await files.getWithMetadata(im.key, { type: "arrayBuffer" });
    if (!got) return new Response("Not found", { status: 404 });
    const type = (got.metadata && got.metadata.contentType) || "image/jpeg";
    const h = { "content-type": type, "cache-control": "private, max-age=3600" };
    if (url.searchParams.get("dl")) h["content-disposition"] = 'attachment; filename="' + fileNameOf(im, n, type).replace(/"/g, "") + '"';
    return new Response(got.data, { headers: h });
  }

  if (url.searchParams.get("zip")) {
    const out = [];
    for (let n = 0; n < images.length; n++) {
      const got = await files.getWithMetadata(images[n].key, { type: "arrayBuffer" }).catch(() => null);
      if (got) out.push({ name: fileNameOf(images[n], n, got.metadata && got.metadata.contentType), data: new Uint8Array(got.data) });
    }
    if (!out.length) return new Response("No photos", { status: 404 });
    return new Response(makeZip(out), { headers: { "content-type": "application/zip", "cache-control": "no-store",
      "content-disposition": 'attachment; filename="' + safeName((rec.propertyName || "property") + " photos" + (rec.siteNr ? " site" + rec.siteNr : "")).replace(/"/g, "") + '.zip"' } });
  }

  const base = "?l=" + encodeURIComponent(id) + "&k=" + encodeURIComponent(k);
  const groups = [];
  images.forEach((im, n) => {
    const title = im.type === "Unit" && im.unitTypeName ? "Unit type: " + im.unitTypeName : "Property";
    let g = groups.find((x) => x.title === title); if (!g) { g = { title, items: [] }; groups.push(g); }
    g.items.push({ im, n });
  });
  groups.sort((a, b) => (a.title === "Property" ? -1 : b.title === "Property" ? 1 : a.title.localeCompare(b.title, "en", { numeric: true })));
  const title = (rec.propertyName || "Property") + " — photos";
  const body = "<header><h1>" + esc(title) + "</h1><p>" + esc([rec.siteNr ? "Site Nr " + rec.siteNr : "", rec.treePlaceText || [rec.suburb, rec.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ")) + "</p></header><main>" +
    (images.length
      ? '<div class="bar"><a class="btn" href="' + base + '&zip=1">Download all ' + images.length + " photos (.zip)</a><span class=\"hint\">Or tap a photo to open it full size.</span></div>" +
        // Grouped: the property's own photos, then each unit type's (Jean, 2026-10-19), so they go into the right place.
        groups.map((g) => "<h2>" + esc(g.title) + " (" + g.items.length + ")</h2><div class=\"grid\">" + g.items.map(({ im, n }) => '<figure><a href="' + base + "&i=" + n + '" target="_blank" rel="noopener"><img loading="lazy" src="' + base + "&i=" + n + '" alt="' + esc(label(im, n)) + '"></a><figcaption><span>' + esc(label(im, n)) + '</span><a href="' + base + "&i=" + n + '&dl=1">Download</a></figcaption></figure>').join("") + "</div>").join("")
      : '<p class="hint">There are no photos on this listing yet.</p>') +
    '<p class="hint" style="margin-top:20px">From Avante Travel.</p></main>';
  return page(title, body);
};

export const config = { path: "/api/property-photos" };

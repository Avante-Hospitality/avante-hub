// The public landing page for a published hook (Jean, 2026-10-08):
// go.avantetravel.co.za/l/<name>[?a=<affiliate id>]
//
// Shows the hook's pages 2+ (published from the hook builder, see
// landing-api.js) with everything clickable: each property's Book button,
// the pages' own Book now / phone / email spots, and a WhatsApp button to
// Avante. Bookings go out under the affiliate whose link it is (?a=), else
// whoever published the page, else Avante — so the right person is credited.
// Once the offer's end date has passed, or if the page doesn't exist, the
// visitor goes straight to that affiliate's storefront.
import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { correctBookingLinkSiteId, ADMIN_MASTER_SITE_GUID } from "./lib/booking-link.js";

const SN = "https://stock.stocknetwork.co.za/ui/";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isAff = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
// Today in South Africa (UTC+2), as YYYY-MM-DD.
const todaySA = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);

function bookUrl(agent, resortId, c) {
  const p = new URLSearchParams();
  if (resortId) p.set("ResortID", resortId);
  if (c.checkIn) p.set("CheckInDT", c.checkIn);
  if (c.checkOut) p.set("CheckOutDT", c.checkOut);
  const q = p.toString();
  return SN + encodeURIComponent(agent) + (q ? "?" + q : "");
}

function page(rec, agent, origin) {
  const c = rec.current, img = (k) => origin + "/api/landing?img=" + k;
  const cover = c.cover || (c.pages[0] && c.pages[0].img);
  const wa = c.whatsapp ? "https://wa.me/" + c.whatsapp + "?text=" + encodeURIComponent(c.waText || "Hi Avante Travel, I'd like to know more about " + c.title) : "";
  const mainBook = c.kind === "property" && c.pages.some((p) => p.props.length) ? bookUrl(agent, c.pages.find((p) => p.props.length).props[0].resortId, c) : "";
  const allBook = mainBook || bookUrl(agent, "", c);
  const pagesHtml = c.pages.map((p, i) => {
    const spots = p.links.map((a) => {
      const href = /^https?:/i.test(a.url) ? (a.label === "Book now" ? allBook : correctBookingLinkSiteId(a.url, agent).url) : a.url;
      const pct = (v, of) => ((v / of) * 100).toFixed(3) + "%";
      return `<a class="spot" href="${esc(href)}" ${/^https?:/i.test(href) ? 'target="_blank" rel="noopener"' : ""} aria-label="${esc(a.label || "Open")}" style="left:${pct(a.x, p.w)};top:${pct(a.y, p.h)};width:${pct(a.w, p.w)};height:${pct(a.h, p.h)}"></a>`;
    }).join("");
    // One "Book now" under every page (Jean, 2026-10-08): StockNetwork with
    // everything available for the hook's dates (a property hook: that property).
    const props = `<div class="props"><a class="book" href="${esc(allBook)}" target="_blank" rel="noopener">Book now<span>›</span></a></div>`;
    return `<section class="pg"><div class="pgimg"><img src="${esc(img(p.img))}" width="${p.w}" height="${p.h}" alt="${esc(c.title)} — page ${i + 2}" loading="lazy">${spots}</div>${props}</section>`;
  }).join("");
  // Page 1 (the hook itself, as seen on Facebook) comes first, also with Book now.
  const coverHtml = c.cover ? `<section class="pg"><div class="pgimg"><img src="${esc(img(c.cover))}" alt="${esc(c.title)} — page 1" loading="eager"></div><div class="props"><a class="book" href="${esc(allBook)}" target="_blank" rel="noopener">Book now<span>›</span></a></div></section>` : "";
  const title = c.title || "Avante Travel";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Avante Travel</title>
<meta name="description" content="${esc(c.description || c.dates || title)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(c.dates || c.description || "Book with Avante Travel")}">
${cover ? `<meta property="og:image" content="${esc(img(cover))}">` : ""}<meta property="og:url" content="${esc(origin + "/l/" + rec.slug)}">
<link rel="preconnect" href="https://fonts.gstatic.com"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Noto+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--teal:#0DCDC2;--teal-dark:#0aa89f;--navy:#0e2f44;--ink:#1d2b36;--mint:#f4fbfa}
*{box-sizing:border-box}body{margin:0;font-family:'Noto Sans',system-ui,sans-serif;color:var(--ink);background:#eef4f4}
header{background:#fff;border-bottom:1px solid #e3e9e8;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
.brand{font-family:Montserrat,sans-serif;font-weight:800;color:var(--teal);font-size:18px;letter-spacing:.02em;line-height:1}.brand span{display:block;color:var(--navy);font-size:11px;letter-spacing:.14em;margin-top:3px}
header a.hb{font-family:Montserrat,sans-serif;font-weight:700;font-size:13px;color:var(--navy);text-decoration:none;border:1.5px solid var(--navy);border-radius:999px;padding:7px 12px}
.intro{max-width:760px;margin:0 auto;padding:18px 16px 4px}.intro h1{font-family:Montserrat,sans-serif;font-size:22px;margin:0 0 4px;color:var(--navy)}.intro p{margin:0;color:#4a5b66}
main{max-width:760px;margin:0 auto;padding:10px 16px 120px}
.pg{margin:14px 0 22px}.pgimg{position:relative;border-radius:14px;overflow:hidden;box-shadow:0 6px 22px rgba(14,47,68,.14);background:#fff}
.pgimg img{display:block;width:100%;height:auto}.spot{position:absolute;display:block;border-radius:8px}.spot:focus-visible{outline:3px solid var(--teal)}
.props{display:grid;gap:8px;margin-top:10px}
.book{display:flex;justify-content:center;gap:10px;align-items:center;background:var(--navy);color:#fff;text-decoration:none;font-family:Montserrat,sans-serif;font-weight:700;font-size:15px;padding:14px 16px;border-radius:12px}
.book span{color:var(--teal);font-size:22px;line-height:1}
.booknow{position:absolute;z-index:2;display:flex;align-items:center;justify-content:center;background:var(--teal);color:var(--navy);text-decoration:none;font-family:Montserrat,sans-serif;font-weight:800;font-size:clamp(9px,2.2vw,15px);border-radius:999px;box-shadow:0 2px 8px rgba(14,47,68,.25);white-space:nowrap}
.booknow:active{transform:scale(.97)}.booknow::after{content:"";position:absolute;inset:-10px -6px}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:6;display:flex;gap:10px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid #e3e9e8;justify-content:center}
.bar a{flex:1;max-width:360px;text-align:center;text-decoration:none;font-family:Montserrat,sans-serif;font-weight:800;font-size:15px;padding:14px 12px;border-radius:999px}
.wa{background:#25D366;color:#fff}.bk{background:var(--teal);color:var(--navy)}
footer{text-align:center;color:#6b7c87;font-size:12px;padding:8px 16px 0}
</style></head><body>
<header><div class="brand">AVANTE<span>TRAVEL</span></div>${wa ? `<a class="hb" href="${esc(wa)}" target="_blank" rel="noopener">Ask us</a>` : ""}</header>
<div class="intro"><h1>${esc(title)}</h1>${c.dates ? `<p>${esc(c.dates)}</p>` : ""}</div>
<main>${coverHtml}${pagesHtml}<footer>Bookings are made securely through StockNetwork for Avante Travel.</footer></main>
<div class="bar">${wa ? `<a class="wa" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp us</a>` : ""}</div>
</body></html>`;
}

export default async (request) => {
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/l\/?/, "").replace(/\/+$/, "").toLowerCase();
  const a = url.searchParams.get("a");
  const storefront = (agent) => Response.redirect(url.origin + "/landing.html?aff=" + encodeURIComponent(agent), 302);
  let rec = null;
  try { if (slug) rec = await getStore({ name: "landing-pages", consistency: "strong" }).get(slug, { type: "json" }); } catch (e) {}
  // Whose bookings these are: the affiliate's link (?a=), else whoever published it, else Avante.
  const agent = isAff(a) ? a : rec && rec.owner && rec.owner.role === "affiliate" && isAff(rec.owner.sub) ? rec.owner.sub : ADMIN_MASTER_SITE_GUID;
  if (!rec || !rec.current || !rec.current.pages || !rec.current.pages.length) return storefront(agent);
  // The offer has ended: straight to the affiliate's storefront.
  if (rec.current.endDate && rec.current.endDate < todaySA()) return storefront(agent);
  return new Response(page(rec, agent, url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
};

export const config = { path: "/l/*" };

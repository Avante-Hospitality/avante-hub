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
import { correctBookingLinkSiteId, ADMIN_MASTER_SITE_GUID, holidayBuilderUrl, toHolidayBuilderUrl } from "./lib/booking-link.js";
import { isShortLink, resolveShortLink } from "./lib/short-link.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isAff = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
// Today in South Africa (UTC+2), as YYYY-MM-DD.
const todaySA = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);

// Book now: this affiliate's holiday builder search screen, pre-filled
// with the page's dates and (for a property page) the property.
function bookUrl(agent, prop, c) {
  return holidayBuilderUrl(agent, {
    destination: prop ? prop.name || prop.town || "" : (c.area || ""),
    resortId: prop ? prop.resortId || "" : "",
    checkIn: c.checkIn || "",
    checkOut: c.checkOut || "",
  });
}

// Meta Pixel "Avante Travel Pixel" (Jean, 2026-10-09). Counts page views, and
// clicks on Book (InitiateCheckout) and WhatsApp / phone / email (Contact),
// so Facebook ads report what people did on the landing page. The booking
// itself happens on StockNetwork, which the Pixel can't see.
const META_PIXEL_ID = "1747389042999072";
function pixel(title, slug) {
  const info = JSON.stringify({ content_name: title || "", landing: slug || "" }).replace(/</g, "\\u003c");
  return `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${META_PIXEL_ID}');fbq('track','PageView');
(function(){var info=${info};document.addEventListener('click',function(ev){var a=ev.target.closest&&ev.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';
if(/stocknetwork\\.co\\.za|holiday-builder/i.test(h))fbq('track','InitiateCheckout',info);
else if(/wa\\.me\\/|whatsapp/i.test(h))fbq('track','Contact',Object.assign({method:'whatsapp'},info));
else if(/^tel:/i.test(h))fbq('track','Contact',Object.assign({method:'phone'},info));
else if(/^mailto:/i.test(h))fbq('track','Contact',Object.assign({method:'email'},info));},true);})();
</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1" alt=""></noscript>`;
}

function page(rec, agent, origin, ownBook) {
  const c = rec.current, img = (k) => origin + "/api/landing?img=" + k;
  const cover = c.cover || (c.pages[0] && c.pages[0].img);
  const wa = c.whatsapp ? "https://wa.me/" + c.whatsapp + "?text=" + encodeURIComponent(c.waText || "Hi Avante Travel, I'd like to know more about " + c.title) : "";
  const mainBook = c.kind === "property" && c.pages.some((p) => p.props.length) ? bookUrl(agent, c.pages.find((p) => p.props.length).props[0], c) : "";
  // The hook builder's own Booking link if it has one (with the affiliate's ID), else built here.
  const allBook = ownBook || mainBook || bookUrl(agent, null, c);
  const pagesHtml = c.pages.map((p, i) => {
    const spots = p.links.map((a) => {
      const href = /^https?:/i.test(a.url) ? (a.label === "Book now" ? allBook : correctBookingLinkSiteId(a.url, agent).url) : a.url;
      const pct = (v, of) => ((v / of) * 100).toFixed(3) + "%";
      return `<a class="spot" href="${esc(href)}" ${/^https?:/i.test(href) ? 'target="_blank" rel="noopener"' : ""} aria-label="${esc(a.label || "Open")}" style="left:${pct(a.x, p.w)};top:${pct(a.y, p.h)};width:${pct(a.w, p.w)};height:${pct(a.h, p.h)}"></a>`;
    }).join("");
    // One "Book now" under every page (Jean, 2026-10-08): StockNetwork with
    // everything available for the hook's dates (a property hook: that property).
    const props = `<div class="props"><a class="book" href="${esc(allBook)}" target="_blank" rel="noopener">Book now<span>›</span></a></div>`;
    return `<section class="pg" style="--ar:${(p.w / p.h).toFixed(4)}"><div class="pgimg"><img src="${esc(img(p.img))}" width="${p.w}" height="${p.h}" alt="${esc(c.title)} — page ${i + 2}" loading="lazy">${spots}</div>${props}</section>`;
  }).join("");
  // Page 1 (the hook itself, as seen on Facebook) comes first, also with Book now.
  const coverHtml = c.cover ? `<section class="pg" style="--ar:${c.coverW && c.coverH ? (c.coverW / c.coverH).toFixed(4) : "0.8"}"><div class="pgimg"><img src="${esc(img(c.cover))}" alt="${esc(c.title)} — page 1" loading="eager"></div><div class="props"><a class="book" href="${esc(allBook)}" target="_blank" rel="noopener">Book now<span>›</span></a></div></section>` : "";
  const title = c.title || "Avante Travel";
  // Faded photos of the area down both sides on a computer (Jean, 2026-10-08):
  // the hook's own photos, slowly changing. Phones don't show them.
  const sc = (c.scenes || []).map(img);
  const sideOf = (list) => list.map((u, i) => `<img src="${esc(u)}" alt="" loading="lazy"${i ? "" : ' class="on"'}>`).join("");
  const scenesHtml = sc.length ? `<div class="side left" aria-hidden="true">${sideOf(sc.filter((_, i) => i % 2 === 0))}</div><div class="side right" aria-hidden="true">${sideOf(sc.length > 1 ? sc.filter((_, i) => i % 2 === 1) : sc)}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${pixel(title, rec.slug)}
<title>${esc(title)} — Avante Travel</title>
<meta name="description" content="${esc(c.description || c.dates || title)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(c.dates || c.description || "Book with Avante Travel")}">
${cover ? `<meta property="og:image" content="${esc(img(cover))}">` : ""}<meta property="og:url" content="${esc(origin + "/l/" + rec.slug)}">
${c.fbCover ? `<meta name="avante:fb-image" content="${esc(img(c.fbCover))}">` : ""}
<link rel="preconnect" href="https://fonts.gstatic.com"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Noto+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--teal:#0DCDC2;--teal-dark:#0aa89f;--navy:#0e2f44;--ink:#1d2b36;--mint:#f4fbfa}
*{box-sizing:border-box}body{margin:0;font-family:'Noto Sans',system-ui,sans-serif;color:var(--ink);background:#eef4f4}
header{background:#fff;border-bottom:1px solid #e3e9e8;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
.brand{font-family:Montserrat,sans-serif;font-weight:800;color:var(--teal);font-size:18px;letter-spacing:.02em;line-height:1}.brand span{display:block;color:var(--navy);font-size:11px;letter-spacing:.14em;margin-top:3px}
header a.hb{font-family:Montserrat,sans-serif;font-weight:700;font-size:13px;color:var(--navy);text-decoration:none;border:1.5px solid var(--navy);border-radius:999px;padding:7px 12px}
.intro{max-width:760px;margin:0 auto;padding:18px 16px 4px}.intro h1{font-family:Montserrat,sans-serif;font-size:22px;margin:0 0 4px;color:var(--navy)}.intro p{margin:0;color:#4a5b66}
main{max-width:760px;margin:0 auto;padding:10px 16px 120px}
.pg{margin:14px auto 22px;width:100%}
/* A computer screen shows one whole page at a time (Jean, 2026-10-08): each
   page is as big as fits between the header and the WhatsApp bar. */
@media (min-width:700px){html{scroll-snap-type:y proximity}main{max-width:1100px}
.pg{width:min(100%,calc((100vh - 270px) * var(--ar,0.8)));min-width:320px;scroll-snap-align:start;scroll-margin-top:72px}}.pgimg{position:relative;border-radius:14px;overflow:hidden;box-shadow:0 6px 22px rgba(14,47,68,.14);background:#fff}
.pgimg img{display:block;width:100%;height:auto}.spot{position:absolute;display:block;border-radius:8px}.spot:focus-visible{outline:3px solid var(--teal)}
.props{display:grid;gap:8px;margin-top:10px}
.book{display:flex;justify-content:center;gap:10px;align-items:center;background:var(--navy);color:#fff;text-decoration:none;font-family:Montserrat,sans-serif;font-weight:700;font-size:15px;padding:14px 16px;border-radius:12px}
.book span{color:var(--teal);font-size:22px;line-height:1}
.booknow{position:absolute;z-index:2;display:flex;align-items:center;justify-content:center;background:var(--teal);color:var(--navy);text-decoration:none;font-family:Montserrat,sans-serif;font-weight:800;font-size:clamp(9px,2.2vw,15px);border-radius:999px;box-shadow:0 2px 8px rgba(14,47,68,.25);white-space:nowrap}
.booknow:active{transform:scale(.97)}.booknow::after{content:"";position:absolute;inset:-10px -6px}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:6;display:flex;gap:10px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid #e3e9e8;justify-content:center}
.bar a{flex:1;max-width:360px;text-align:center;text-decoration:none;font-family:Montserrat,sans-serif;font-weight:800;font-size:15px;padding:14px 12px;border-radius:999px}
.wa{background:#25D366;color:#fff}.bk{background:var(--teal);color:var(--navy)}
.side{display:none}
@media (min-width:900px){
.side{display:block;position:fixed;top:0;bottom:0;width:50vw;z-index:0;pointer-events:none;overflow:hidden}
.side.left{left:0;-webkit-mask-image:linear-gradient(to right,#000 0,rgba(0,0,0,.85) 25%,transparent 62%);mask-image:linear-gradient(to right,#000 0,rgba(0,0,0,.85) 25%,transparent 62%)}
.side.right{right:0;-webkit-mask-image:linear-gradient(to left,#000 0,rgba(0,0,0,.85) 25%,transparent 62%);mask-image:linear-gradient(to left,#000 0,rgba(0,0,0,.85) 25%,transparent 62%)}
.side img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 2.2s ease;filter:saturate(.9)}
.side img.on{opacity:.62}
.intro,main{position:relative;z-index:1}header{z-index:5}.bar{z-index:6}
.intro h1,.intro p{text-shadow:0 1px 0 rgba(255,255,255,.7)}}
@media (prefers-reduced-motion:reduce){.side img{transition:none}}
footer{text-align:center;color:#6b7c87;font-size:12px;padding:8px 16px 0}
</style></head><body>
<header><div class="brand">AVANTE<span>TRAVEL</span></div>${wa ? `<a class="hb" href="${esc(wa)}" target="_blank" rel="noopener">Ask us</a>` : ""}</header>
${scenesHtml}<div class="intro"><h1>${esc(title)}</h1>${c.dates ? `<p>${esc(c.dates)}</p>` : ""}</div>
<main>${coverHtml}${pagesHtml}<footer>Bookings are made securely through StockNetwork for Avante Travel.</footer></main>
<div class="bar">${wa ? `<a class="wa" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp us</a>` : ""}</div>
${sc.length > 2 ? `<script>(function(){var t=0;setInterval(function(){t++;document.querySelectorAll(".side").forEach(function(s){var im=s.querySelectorAll("img");if(im.length<2)return;im.forEach(function(x,i){x.classList.toggle("on",i===t%im.length)})})},6500)})();</script>` : ""}
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
  let ownBook = "";
  if (rec.current.booking) {
    ownBook = rec.current.booking;
    if (isShortLink(ownBook)) { try { ownBook = (await resolveShortLink(ownBook, getStore({ name: "short-links", consistency: "strong" }))) || ownBook; } catch (e) {} }
    // An affiliate's link (or page) credits them; otherwise the link stays exactly as built.
    ownBook = agent !== ADMIN_MASTER_SITE_GUID ? correctBookingLinkSiteId(ownBook, agent).url : toHolidayBuilderUrl(ownBook);
  }
  return new Response(page(rec, agent, url.origin, ownBook), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
};

export const config = { path: "/l/*" };

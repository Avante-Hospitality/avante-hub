// One definition of what an accommodation booking link looks like, shared
// by every edge function that builds, personalizes or cleans up one
// (hook-api.js, admin-api.js, landing-api.js, landing-page.js,
// hook-draft.js, go-redirect.js) so they can't drift apart.
//
// Since 2026-10-10 every booking goes through the Avante holiday builder
// search screen (avantetravel.co.za/holiday-builder), which searches Stock
// Network through the SN API. Each affiliate (and each property affiliate)
// has its own company page there, named after their Stock Network site
// GUID:
//
//   https://avantetravel.co.za/holiday-builder/<site GUID>.php
//     ?country=&province=&region=&city=&suburb=&property=&resort=<ResortID>
//     &destination=<most specific of those>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD
//
// The place fields follow the hub's location tree (Country › Province ›
// Region › City › Suburb › Property, see lib/tree.js) down to whatever the
// link is for — a town link stops at city, a property link has them all.
// A property in two regions carries both, comma-separated. Links are built
// as if Stock Network and the holiday builder already follow the tree
// (Jean, 2026-10-10); `destination` repeats the most specific name so the
// search screen, which reads only destination/checkin/checkout today, still
// works.
//
// Company pages are set up by hand in holiday-builder/admin/companies.php
// (name, colours, intro iframe, the site's own SN token). The search page
// pre-fills destination/checkin/checkout from the query string (see its
// search.js); `resort` is passed too so a property link keeps its
// ResortID for when the search page learns to open one property directly.
//
// Old Stock Network portal links (stock.stocknetwork.co.za/ui/<GUID>
// ?ResortID=&CheckInDT=&CheckOutDT=&Filter=) are still recognised
// everywhere and converted on the fly, so anything saved before the switch
// (hooks, landing pages, short links) lands on the new search screen too.
export const STOCKNETWORK_HOST = "stock.stocknetwork.co.za";
export const HOLIDAY_BUILDER_HOST = "avantetravel.co.za";
export const HOLIDAY_BUILDER_BASE = "https://avantetravel.co.za/holiday-builder/";

// Jean's own real StockNetwork site GUID — also the slug of the Avante
// Travel company page on the holiday builder. Used as the placeholder site
// identifier admin default hooks are built with, so hook-api.js can
// recognise "nobody has customised this yet" and swap in whichever
// affiliate is actually viewing it. NOT the numeric StockNetwork "Site Nr"
// ("36") used for CSV/leaderboard matching (see booking-stats.js).
export const ADMIN_MASTER_SITE_GUID = "c2fef00f-7330-4eb3-b993-f5f43fc73dff";

// The tree levels a link can carry, top down.
export const TREE_FIELDS = ["country", "province", "region", "city", "suburb", "property"];

function clean(v) {
  if (Array.isArray(v)) v = v.filter(Boolean).join(", ");
  v = v == null ? "" : String(v).trim();
  return /^\(/.test(v) ? "" : v; // "(no region)", "(pin needs checking)" are not places
}

// The most specific place in opts (what the search box should show).
export function mostSpecificPlace(opts = {}) {
  for (let i = TREE_FIELDS.length - 1; i >= 0; i--) {
    const v = clean(opts[TREE_FIELDS[i]]);
    if (v) return TREE_FIELDS[i] === "region" ? v.split(", ")[0] : v;
  }
  return "";
}

// Builds a holiday builder search link for one site (affiliate or
// property). opts: { country, province, region, city, suburb, property,
// resortId, destination, checkIn, checkOut } — all optional; empty values
// are left out. destination defaults to the most specific tree field.
export function holidayBuilderUrl(siteId, opts = {}) {
  if (!siteId) return "";
  const p = new URLSearchParams();
  for (const f of TREE_FIELDS) {
    const v = clean(opts[f]);
    if (v) p.set(f, v);
  }
  if (opts.resortId) p.set("resort", String(opts.resortId));
  const destination = clean(opts.destination) || mostSpecificPlace(opts);
  if (destination) p.set("destination", destination);
  if (opts.checkIn) p.set("checkin", String(opts.checkIn));
  if (opts.checkOut) p.set("checkout", String(opts.checkOut));
  const q = p.toString();
  return HOLIDAY_BUILDER_BASE + encodeURIComponent(siteId) + ".php" + (q ? "?" + q : "");
}

// A tree place ({ c, p, r: [regions], t, s } — lib/tree.js) as link opts,
// down to `depth` (0 country … 4 suburb; default: as deep as it goes).
// propertyName adds the property level.
export function treeOpts(place, propertyName, depth) {
  if (!place) return propertyName ? { property: propertyName } : {};
  const t = clean(place.t);
  const s = clean(place.s);
  const all = {
    country: clean(place.c),
    province: clean(place.p),
    region: clean(place.r || []),
    city: t,
    suburb: s && s !== t ? s : "",
  };
  const out = {};
  TREE_FIELDS.slice(0, 5).forEach((f, i) => {
    if (depth == null || i <= depth) out[f] = all[f];
  });
  if (propertyName && depth == null) out.property = propertyName;
  return out;
}

// True if opts already carry any tree field.
export function hasTreePath(opts = {}) {
  return TREE_FIELDS.some((f) => clean(opts[f]));
}

// Reads a booking link of either shape. Returns null for anything else
// (a self-managed hook's booking link doesn't have to be ours at all),
// or { kind: "sn" | "hb", siteId, opts, url } — opts in holidayBuilderUrl's
// terms, with any query params we don't know about kept in opts.extra.
export function parseBookingLink(rawUrl) {
  if (!rawUrl) return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return null;
  }
  const segments = u.pathname.split("/").filter(Boolean);
  let seg = "";
  let kind = "";
  if (u.hostname === STOCKNETWORK_HOST && segments.length === 2 && segments[0] === "ui") {
    kind = "sn";
    seg = segments[1];
  } else if (
    (u.hostname === HOLIDAY_BUILDER_HOST || u.hostname === "www." + HOLIDAY_BUILDER_HOST) &&
    segments.length === 2 && segments[0] === "holiday-builder" && /\.php$/i.test(segments[1])
  ) {
    kind = "hb";
    seg = segments[1].replace(/\.php$/i, "");
  } else {
    return null;
  }
  let siteId;
  try {
    siteId = decodeURIComponent(seg);
  } catch (e) {
    return null;
  }
  if (!siteId) return null;
  // Not a site page (e.g. holiday-builder/index.php, map.php): leave alone.
  if (kind === "hb" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) return null;

  const q = u.searchParams;
  const known = kind === "sn"
    ? { ResortID: "resortId", CheckInDT: "checkIn", CheckOutDT: "checkOut", Filter: "destination" }
    : { resort: "resortId", checkin: "checkIn", checkout: "checkOut", destination: "destination",
        country: "country", province: "province", region: "region", city: "city", suburb: "suburb", property: "property" };
  const opts = { extra: [] };
  for (const [k, v] of q.entries()) {
    if (known[k]) opts[known[k]] = v;
    else opts.extra.push([k, v]);
  }
  return { kind, siteId, opts, url: rawUrl };
}

function rebuild(parsed, siteId) {
  const base = holidayBuilderUrl(siteId, parsed.opts);
  if (!parsed.opts.extra || !parsed.opts.extra.length) return base;
  const u = new URL(base);
  for (const [k, v] of parsed.opts.extra) if (!u.searchParams.has(k)) u.searchParams.append(k, v);
  return u.toString();
}

// Converts an old Stock Network portal link to the holiday builder search
// screen for the same site, dates and area/property. A holiday builder
// link, or anything we don't recognise, comes back unchanged.
export function toHolidayBuilderUrl(rawUrl) {
  const parsed = parseBookingLink(rawUrl);
  if (!parsed || parsed.kind !== "sn") return rawUrl;
  return rebuild(parsed, parsed.siteId);
}

// The site GUID a booking link books under (either shape), or "".
export function bookingLinkSiteId(rawUrl) {
  const parsed = parseBookingLink(rawUrl);
  return parsed ? parsed.siteId : "";
}

// Makes sure a booking link books under expectedSiteId, and is on the
// holiday builder. Leaves rawUrl completely unchanged (changed: false) if
// it isn't one of our two booking link shapes, or it is already a holiday
// builder link for expectedSiteId. previousSiteId is the site the link
// pointed at before (only meaningful when the site actually changed —
// siteChanged; a plain old-to-new conversion keeps the same site).
export function correctBookingLinkSiteId(rawUrl, expectedSiteId) {
  const unchanged = { url: rawUrl, changed: false, siteChanged: false, previousSiteId: null };
  if (!rawUrl || !expectedSiteId) return unchanged;
  const parsed = parseBookingLink(rawUrl);
  if (!parsed) return unchanged;
  if (parsed.kind === "hb" && parsed.siteId === expectedSiteId) return unchanged;
  const url = rebuild(parsed, expectedSiteId);
  const siteChanged = parsed.siteId !== expectedSiteId;
  return { url, changed: url !== rawUrl, siteChanged, previousSiteId: siteChanged ? parsed.siteId : null };
}

// Swaps the admin placeholder site (or a legacy "Affiliate <N>" segment)
// for the viewing affiliate's own site, converting old Stock Network links
// to the holiday builder on the way. Any other link is returned as-is
// (except an old SN link, which is still converted).
export function personalizeBookingLink(rawUrl, replacement) {
  if (!rawUrl) return rawUrl;
  const parsed = parseBookingLink(rawUrl) || parseLegacyAffiliateSegment(rawUrl);
  if (!parsed) return rawUrl;
  const isPlaceholder = parsed.siteId === ADMIN_MASTER_SITE_GUID || /^Affiliate\s+\d+$/i.test(parsed.siteId);
  if (isPlaceholder && replacement) return rebuild(parsed, replacement);
  if (parsed.legacy) return rawUrl; // "Affiliate <N>" with nobody to swap in: nothing valid to build
  return parsed.kind === "sn" ? rebuild(parsed, parsed.siteId) : rawUrl;
}

// Early admin default hooks used a literal "Affiliate <number>" text
// segment on the SN portal — never a real site, but still recognised so
// it gets personalised rather than shown broken.
function parseLegacyAffiliateSegment(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    if (u.hostname !== STOCKNETWORK_HOST || segments.length !== 2 || segments[0] !== "ui") return null;
    const seg = decodeURIComponent(segments[1]);
    if (!/^Affiliate\s+\d+$/i.test(seg)) return null;
    const p = parseBookingLink(u.protocol + "//" + u.host + "/ui/x" + u.search);
    return p ? { ...p, siteId: seg, legacy: true } : null;
  } catch (e) {
    return null;
  }
}

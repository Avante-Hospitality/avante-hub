// Accommodation booking links, for the hub's pages (hub.html, admin.html,
// landing.html, property-affiliate.js). The browser twin of
// netlify/edge-functions/lib/booking-link.js — keep the two in step.
//
// Every booking goes through the Avante holiday builder search screen,
// one company page per Stock Network site GUID:
//   https://avantetravel.co.za/holiday-builder/<site GUID>.php
//     ?destination=<area or property>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD
// Old Stock Network portal links (stock.stocknetwork.co.za/ui/<GUID>?...)
// are still understood and converted.
(function (root) {
  var BASE = 'https://avantetravel.co.za/holiday-builder/';
  var SN_HOST = 'stock.stocknetwork.co.za';
  var GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // opts: { destination, checkIn, checkOut, resortId } — all optional.
  function build(siteId, opts) {
    if (!siteId) return '';
    opts = opts || {};
    var p = new URLSearchParams();
    if (opts.destination) p.set('destination', String(opts.destination));
    if (opts.checkIn) p.set('checkin', String(opts.checkIn));
    if (opts.checkOut) p.set('checkout', String(opts.checkOut));
    if (opts.resortId) p.set('resort', String(opts.resortId));
    var q = p.toString();
    return BASE + encodeURIComponent(siteId) + '.php' + (q ? '?' + q : '');
  }

  // { kind: 'sn'|'hb', siteId, opts } for either booking link shape, else null.
  function parse(raw) {
    var u;
    try { u = new URL(raw); } catch (e) { return null; }
    var seg = u.pathname.split('/').filter(Boolean);
    var kind = '', id = '';
    if (u.hostname === SN_HOST && seg.length === 2 && seg[0] === 'ui') { kind = 'sn'; id = seg[1]; }
    else if (/^(www\.)?avantetravel\.co\.za$/.test(u.hostname) && seg.length === 2 && seg[0] === 'holiday-builder' && /\.php$/i.test(seg[1])) { kind = 'hb'; id = seg[1].replace(/\.php$/i, ''); }
    else return null;
    try { id = decodeURIComponent(id); } catch (e) { return null; }
    if (!id || (kind === 'hb' && !GUID_RE.test(id))) return null;
    var map = kind === 'sn'
      ? { ResortID: 'resortId', CheckInDT: 'checkIn', CheckOutDT: 'checkOut', Filter: 'destination' }
      : { resort: 'resortId', checkin: 'checkIn', checkout: 'checkOut', destination: 'destination' };
    var opts = {};
    u.searchParams.forEach(function (v, k) { if (map[k]) opts[map[k]] = v; });
    return { kind: kind, siteId: id, opts: opts };
  }

  // Old SN portal link -> holiday builder; anything else unchanged.
  function convert(raw) {
    var p = parse(raw);
    return p && p.kind === 'sn' ? build(p.siteId, p.opts) : raw;
  }

  // The site GUID a booking link books under, or ''.
  function siteId(raw) {
    var p = parse(raw);
    return p ? p.siteId : '';
  }

  root.AvanteBooking = { BASE: BASE, build: build, parse: parse, convert: convert, siteId: siteId };
})(window);

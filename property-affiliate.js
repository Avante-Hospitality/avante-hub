/* Property Affiliate — channel sync and bookings for properties whose stock is
   managed manually on Stock Network. Talks to /api/property (edge function).
   Renders into #pa-app inside the hub's Property Affiliate panel. */
(function () {
  'use strict';
  var root = document.getElementById('pa-app');
  if (!root) return;
  var onboarding = document.getElementById('pa-onboarding');
  var TOKEN_KEY = 'avante-pa-token';
  var CH = { bcom: 'Booking.com', airbnb: 'Airbnb', lekke: 'LekkeSlaap' };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var FRESH_MS = 5 * 60 * 1000; // a loaded window is reused for 5 minutes
  function isPhone() { return window.innerWidth < 700; }
  var WINDOW = isPhone() ? 7 : 14;
  window.addEventListener('resize', function () { var w = isPhone() ? 7 : 14; if (w !== WINDOW) { WINDOW = w; if (S.view === 'avail' && S.av) loadAvailability(S.from); } });
  var aff = new URLSearchParams(location.search).get('aff') || '';

  var S = { token: null, prop: null, view: 'avail', av: null, from: null, sel: null, cart: [], searched: null, results: null,
    modal: null, edit: null, found: null, findQ: '', msg: null, err: null, busy: false, channels: null, events: null,
    bookings: null, calUnit: null, calMonth: null, unitFilter: 'All units', connect: null };
  try { S.token = localStorage.getItem(TOKEN_KEY); } catch (e) {}

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { var d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10); }
  function add(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function dObj(iso) { return new Date(iso + 'T00:00:00Z'); }
  function dow(iso) { return DOW[dObj(iso).getUTCDay()]; }
  function nice(iso) { var d = dObj(iso); return DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  function short(iso) { var d = dObj(iso); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  function nightsBetween(a, b) { return Math.round((dObj(b) - dObj(a)) / 86400000); }
  function nw(n) { return n + (n === 1 ? ' night' : ' nights'); }
  function money(n) { return n == null ? '—' : 'R' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function each(a, b) { var o = []; for (var d = a; d < b; d = add(d, 1)) o.push(d); return o; }

  function api(action, data) {
    var body = Object.assign({ action: action, token: S.token }, data || {});
    return fetch('/api/property', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Unexpected answer (' + r.status + ')' }; }).then(function (d) { d._status = r.status; return d; }); })
      .then(function (d) {
        if (d._status === 401 && action !== 'connect') { setToken(null); S.prop = null; render(); }
        if (!d.ok) throw new Error(d.error || 'Something went wrong');
        return d;
      });
  }
  function setToken(t) { S.token = t; try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function busy(on) { S.busy = on; }
  function fail(e) { S.err = e.message || String(e); S.busy = false; render(); }

  // ---------- data ----------
  // Only the days on screen are read from Stock Network: the grid's 7 or 14
  // days, or the calendar's month. Everything read is kept here (merged), so
  // units picked in one window stay selected while moving Earlier / Later.
  function isLoaded(a, b) { if (!S.av) return false; var lim = Date.now() - FRESH_MS; return each(a, b).every(function (n) { return (S.av.loaded[n] || 0) >= lim; }); }
  function staleAll() { if (S.av) S.av.loaded = {}; }
  function staleRange(a, b) { if (S.av) each(a, b).forEach(function (n) { delete S.av.loaded[n]; }); }
  var inFlight = null;
  function loadWindow(a, b) {
    if (b <= today()) return render();
    if (a < today()) a = today();
    if (isLoaded(a, b)) return render();
    var key = a + '|' + b; if (inFlight === key) return; inFlight = key;
    busy(true); render();
    return api('availability', { from: a, to: b }).then(function (d) {
      inFlight = null; S.busy = false;
      var av = S.av || { nights: {}, nightRates: {}, loaded: {} };
      av.units = d.units; av.minStay = d.minStay; av.snapshotAt = d.snapshotAt;
      d.units.forEach(function (u) {
        var n = (av.nights[u.name] = av.nights[u.name] || {}), r = (av.nightRates[u.name] = av.nightRates[u.name] || {});
        Object.keys(d.nights[u.name] || {}).forEach(function (k) { n[k] = d.nights[u.name][k]; delete r[k]; });
        Object.keys(d.nightRates[u.name] || {}).forEach(function (k) { r[k] = d.nightRates[u.name][k]; });
      });
      var ms = Date.now(); each(a, b).forEach(function (k) { av.loaded[k] = ms; });
      S.av = av;
      if (!S.calUnit && d.units.length) S.calUnit = d.units[0].name;
      render();
    }).catch(function (e) { inFlight = null; fail(e); });
  }
  function loadAvailability(from) {
    S.from = from || S.from || today();
    if (S.from < today()) S.from = today();
    if (!S.calMonth) S.calMonth = S.from.slice(0, 7);
    return loadWindow(S.from, add(S.from, WINDOW));
  }
  function loadMonth() {
    var first = S.calMonth + '-01', y = +S.calMonth.slice(0, 4), m = +S.calMonth.slice(5, 7);
    var next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    return loadWindow(first, next);
  }
  function stateOf(unit, n) { var r = S.av && S.av.nights[unit]; return (r && r[n]) || { s: 'na' }; }
  function inCart(unit, n) { return S.cart.some(function (c) { return c.unit === unit && n >= c.start && n < c.end; }); }
  function openNight(unit, n) { return stateOf(unit, n).s === 'open' && !inCart(unit, n); }
  function rangeOpen(unit, a, b) { return each(a, b).every(function (n) { return openNight(unit, n); }); }
  function priceOf(unit, a, b) { var nr = (S.av && S.av.nightRates[unit]) || {}; var t = 0; var nights = each(a, b); for (var i = 0; i < nights.length; i++) { if (!nr[nights[i]]) return null; t += nr[nights[i]]; } return t; }
  function sizeOf(unit) { var u = S.av && S.av.units.find(function (x) { return x.name === unit; }); return u ? u.size : ''; }

  // ---------- render ----------
  function render() {
    var views = [['avail', 'Availability'], ['cal', 'My Calendar'], ['chan', 'Channels'], ['book', 'Bookings'], ['rev', 'Reviews'], ['onb', 'Onboarding Form']];
    var h = '<div class="pa"><h1>Property Affiliate</h1>';
    h += '<nav class="pa-subnav" aria-label="Property Affiliate sections">' + views.map(function (v) { return '<button type="button" data-act="view" data-v="' + v[0] + '"' + (S.view === v[0] ? ' aria-current="page"' : '') + '>' + v[1] + '</button>'; }).join('') + '</nav>';
    if (S.err) h += '<div class="pa-err" role="alert" style="margin-bottom:14px">' + esc(S.err) + ' <button type="button" class="pa-btn small ghost" data-act="dismiss" style="margin-left:8px">OK</button></div>';
    if (S.msg) h += '<div class="pa-ok" role="status" style="margin-bottom:14px">' + esc(S.msg) + '</div>';
    if (S.view === 'onb') h += '';
    else if (!S.token || !S.prop) h += viewConnect();
    else if (S.view === 'avail') h += viewAvail();
    else if (S.view === 'cal') h += viewCal();
    else if (S.view === 'chan') h += viewChan();
    else if (S.view === 'book') h += viewBookings();
    else if (S.view === 'rev') h += viewReviews();
    h += '</div>';
    if (S.modal) h += '<div class="pa">' + viewModal() + '</div>';
    root.innerHTML = h;
    if (onboarding) onboarding.style.display = S.view === 'onb' ? '' : 'none';
  }

  function propHeader(extra) {
    return '<div class="pa-row" style="justify-content:space-between;align-items:center;margin-bottom:14px"><div><p class="pa-title">' + esc(S.prop.resortName || 'Your property') + '</p>' +
      '<div class="pa-hint">' + S.prop.units.length + ' units · Stock Network site ' + esc(S.prop.site) + (extra ? ' · ' + extra : '') + '</div></div>' +
      '<button type="button" class="pa-btn small ghost" data-act="disconnect">Disconnect</button></div>';
  }

  function viewConnect() {
    var c = S.connect || {};
    var h = '<div class="pa-card"><p class="pa-h2">Connect your Stock Network site</p>' +
      '<p class="pa-hint">Use the API login for your property\'s own Stock Network site. The hub keeps it encrypted and uses it only to read your availability and to make, change and cancel bookings for you.</p>' +
      '<div class="pa-form" style="margin-top:10px">' +
      '<div class="pa-field"><label class="pa-label" for="pa-u">Username</label><input id="pa-u" type="text" autocomplete="off" value="' + esc(c.username || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ci">Client ID</label><input id="pa-ci" type="text" autocomplete="off" value="' + esc(c.clientID || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-cs">Client secret</label><input id="pa-cs" type="password" autocomplete="off"></div></div>';
    if (c.needResort) {
      h += '<div style="margin-top:14px"><p class="pa-h2">Which property is this?</p>';
      if (c.candidates && c.candidates.length) h += c.candidates.map(function (r) { return '<button type="button" class="pa-btn ghost small" style="margin:0 8px 8px 0" data-act="pickResort" data-id="' + esc(r.resortId) + '">' + esc(r.name) + '</button>'; }).join('');
      h += '<div class="pa-field" style="margin-top:8px"><label class="pa-label" for="pa-rs">Search by property name</label><input id="pa-rs" type="search" value="' + esc(c.q || '') + '" placeholder="e.g. The Dunes"></div>';
      if (c.matches) h += '<div class="pa-results">' + (c.matches.length ? c.matches.map(function (r) { return '<div class="pa-result"><div class="grow"><b>' + esc(r.name) + '</b><div class="pa-hint">' + esc(r.district || r.town || '') + '</div></div><button type="button" class="pa-btn small" data-act="pickResort" data-id="' + esc(r.resortId) + '">This one</button></div>'; }).join('') : '<span class="pa-hint">No property with that name.</span>') + '</div>';
      h += '</div>';
    }
    h += '<div class="pa-row" style="margin-top:14px"><button type="button" class="pa-btn" data-act="connect"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Connecting…' : 'Connect') + '</button></div></div>';
    return h;
  }

  // ---- Availability (home) ----
  function viewAvail() {
    if (!S.av) return propHeader() + '<div class="pa-card pa-hint">Loading availability from Stock Network…</div>';
    var units = S.av.units, days = each(S.from, add(S.from, WINDOW));
    var qIn = (S.searched && S.searched.ci) || S.from, qOut = (S.searched && S.searched.co) || add(S.from, 1);
    var h = propHeader('updated ' + new Date(S.av.snapshotAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    // search
    h += '<section class="pa-card pa-soft" aria-label="Find available units"><div class="pa-row">' +
      '<div class="pa-field"><label class="pa-label" for="pa-qin">Check-in</label><input id="pa-qin" type="date" value="' + qIn + '" min="' + today() + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-qout">Check-out</label><input id="pa-qout" type="date" value="' + qOut + '" min="' + add(today(), 1) + '"></div>' +
      '<button type="button" class="pa-btn" data-act="search">Search all units</button><button type="button" class="pa-btn ghost" data-act="openFind">Find a Booking</button></div>';
    if (S.results) {
      var r = S.results;
      h += '<div class="pa-results"><b style="font-size:13px;color:#0e2f44">' + r.results.filter(function (x) { return rangeOpen(x.unit, r.checkIn, r.checkOut) || inCart(x.unit, r.checkIn); }).length + ' of ' + units.length + ' units open · ' + nice(r.checkIn) + ' to ' + nice(r.checkOut) + ' · ' + nw(r.nights) + '</b>';
      var shown = r.results.filter(function (x) { return rangeOpen(x.unit, r.checkIn, r.checkOut); });
      h += shown.map(function (x) {
        return '<div class="pa-result"><div class="grow"><b>' + esc(x.unit) + '</b> <span class="pa-hint">· ' + esc(x.size) + '</span><div class="pa-hint">' + (x.rate ? money(x.rate) + ' per night' : '') + (r.nights < r.minStay ? ' · below the ' + r.minStay + '-night minimum' : '') + '</div></div>' +
          '<span class="pa-price">' + money(x.total) + '</span><button type="button" class="pa-btn" data-act="selectResult" data-u="' + esc(x.unit) + '">Select</button></div>';
      }).join('');
      if (!shown.length) h += '<span class="pa-err">No unit is open on Stock Network for all of those nights.</span>';
      h += '</div>';
    }
    h += '</section>';
    // grid
    var phone = isPhone();
    var cols = (phone ? '62px' : '150px') + ' repeat(' + WINDOW + ', minmax(0,1fr))';
    h += '<section class="pa-card" aria-label="Unit by unit"><div class="pa-row" style="justify-content:space-between;align-items:center">' +
      '<div><p class="pa-h2">Unit by unit</p><div class="pa-hint">' + (S.sel ? 'Check-in ' + nice(S.sel.start) + ' on ' + esc(S.sel.unit) + '. Now click the last night of the stay.' : 'Click an open night to set check-in, then the last night of the stay. Repeat on other units to book several together.') + '</div></div>' +
      '<div class="pa-row" style="gap:8px"><button type="button" class="pa-btn small ghost" data-act="shift" data-n="-' + WINDOW + '" aria-label="Previous ' + WINDOW + ' days">‹ Earlier</button><button type="button" class="pa-btn small ghost" data-act="shift" data-n="' + WINDOW + '" aria-label="Next ' + WINDOW + ' days">Later ›</button></div></div>';
    h += '<div class="pa-legend"><span><i style="background:#0DCDC2"></i>Open</span><span><i style="background:#e7ebeb"></i>Booked</span><span><i style="background:#fff4e5;border:2px dashed #ED8B00"></i>Channel booking not yet on SN</span><span><i style="background:#f3f5f5;border:1.5px dashed #c9d3d3"></i>Not on SN</span></div>';
    h += '<div class="pa-grid-wrap"><div class="pa-grid' + (phone ? ' phone' : '') + '" style="grid-template-columns:' + cols + '"><div class="pa-label" style="align-self:end">Unit</div>';
    h += days.map(function (d) { return '<div class="hd">' + (phone ? dow(d).slice(0, 2) : dow(d)) + '<b>' + dObj(d).getUTCDate() + '</b>' + (dObj(d).getUTCDate() === 1 || d === days[0] ? MON[dObj(d).getUTCMonth()] : '') + '</div>'; }).join('');
    var perNight = {}, totalOpen = 0, weekend = 0, weekendAll = 0;
    units.forEach(function (u) {
      var open = 0, cells = '';
      days.forEach(function (d) {
        var st = stateOf(u.name, d).s, cls, lbl, isOpen = false;
        if (inCart(u.name, d)) { cls = 'sel'; lbl = 'Selected'; }
        else if (st === 'open') { isOpen = true; cls = S.sel && S.sel.unit === u.name && S.sel.start === d ? 'start' : 'open'; lbl = cls === 'start' ? 'Check-in' : 'Open'; }
        else if (st === 'na') { cls = 'na'; lbl = 'Not on SN'; }
        else if (st === 'pending' || st === 'clash') { cls = 'warn'; lbl = st === 'clash' ? 'Clash' : 'Pending'; }
        else { cls = 'booked'; lbl = 'Booked'; }
        if (isOpen || cls === 'sel') { open++; totalOpen++; perNight[d] = (perNight[d] || 0) + 1; if (dow(d) === 'Fri' || dow(d) === 'Sat') weekend++; }
        var shown = phone ? ({ Selected: '✓', 'Check-in': 'In', Clash: '!', Pending: '!' }[lbl] || '') : lbl;
        cells += isOpen ? '<button type="button" class="pa-cell ' + cls + '" data-act="cell" data-u="' + esc(u.name) + '" data-d="' + d + '" aria-label="' + esc(u.name) + ', ' + nice(d) + ', open">' + shown + '</button>'
          : '<div class="pa-cell ' + cls + '" aria-label="' + esc(u.name) + ', ' + nice(d) + ', ' + lbl + '" title="' + lbl + '">' + shown + '</div>';
      });
      h += '<div class="unit"><b>' + esc(u.name) + '</b><span>' + open + (phone ? '/' + WINDOW : ' of ' + WINDOW + ' open') + '</span></div>' + cells;
    });
    days.forEach(function (d) { if (dow(d) === 'Fri' || dow(d) === 'Sat') weekendAll += units.length; });
    h += '<div class="pa-label" style="align-self:center;color:#0e2f44">Units open</div>' + days.map(function (d) { var n = perNight[d] || 0; return '<div style="text-align:center;font:700 13px Montserrat,sans-serif;color:' + (n ? '#0e2f44' : '#8a3a00') + '">' + n + '/' + units.length + '</div>'; }).join('');
    h += '</div></div>' + (totalOpen ? '' : '<p class="pa-hint" style="margin-top:10px">Nothing open on Stock Network in these days. Use Later ›, or search your dates above.</p>') + '</section>';
    // cart
    if (S.cart.length) {
      var tot = S.cart.reduce(function (t, c) { return t + (priceOf(c.unit, c.start, c.end) || 0); }, 0);
      h += '<section class="pa-cart" aria-label="Selected units"><div class="grow"><b style="font:700 14px Montserrat,sans-serif">' + S.cart.length + (S.cart.length === 1 ? ' unit' : ' units') + ' selected · ' + money(tot) + '</b><div>' +
        S.cart.map(function (c, i) { return '<span class="pa-chip">' + esc(c.unit) + ' · ' + short(c.start) + ' – ' + short(c.end) + '<button type="button" data-act="uncart" data-i="' + i + '" aria-label="Remove ' + esc(c.unit) + '">✕</button></span>'; }).join('') +
        '</div><span style="font-size:12px;color:#d6e2e9">Add another unit by clicking its nights in the grid, or search again.</span></div>' +
        '<button type="button" class="pa-btn ghost" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.5)" data-act="clearCart">Clear</button>' +
        '<button type="button" class="pa-btn teal" data-act="openBook">' + (S.cart.length === 1 ? 'Book this unit' : 'Book ' + S.cart.length + ' units together') + '</button></section>';
    }
    // stats
    h += '<div class="pa-stats"><div class="pa-stat" style="background:#0e2f44;color:#fff"><b>' + totalOpen + ' <small style="font-size:16px;color:#d6e2e9">of ' + units.length * WINDOW + '</small></b><span style="color:#d6e2e9">unit-nights open to sell in these ' + WINDOW + ' days</span></div>' +
      '<div class="pa-stat" style="background:#f4fbfa;border:1.5px solid #e3e9e8"><b style="color:#0e2f44">' + (perNight[days[0]] || 0) + ' <small style="font-size:16px">of ' + units.length + '</small></b><span>units open on ' + nice(days[0]) + '</span></div>' +
      '<div class="pa-stat" style="background:#fff4e5;border:1.5px solid #f5c98a;color:#6b3a00"><b>' + weekend + ' <small style="font-size:16px">of ' + weekendAll + '</small></b><span>Friday and Saturday unit-nights open</span></div></div>';
    // sell these + share
    var link = function (unit, a, b) { return 'https://stock.stocknetwork.co.za/ui/' + S.prop.siteId + '?ResortID=' + S.prop.resortId + '&CheckInDT=' + a + '&CheckOutDT=' + b + (aff ? '' : ''); };
    var stretches = [];
    units.forEach(function (u) {
      if (S.unitFilter !== 'All units' && S.unitFilter !== u.name) return;
      var i = 0;
      while (i < days.length) {
        if (openNight(u.name, days[i])) { var a = days[i]; while (i < days.length && openNight(u.name, days[i])) i++; var b = i < days.length ? days[i] : add(days[days.length - 1], 1); stretches.push({ unit: u.name, a: a, b: b, n: nightsBetween(a, b) }); }
        else i++;
      }
    });
    var lines = [S.prop.resortName + ' has open dates from ' + nice(days[0]) + ':'], last = '';
    stretches.forEach(function (s) { if (S.unitFilter === 'All units' && s.unit !== last) { lines.push(''); lines.push(s.unit + ':'); last = s.unit; } lines.push('• ' + nice(s.a) + ' – ' + nice(s.b) + ' (' + nw(s.n) + ')'); });
    lines.push(''); lines.push('Book: ' + link('', days[0], add(days[0], 2)));
    h += '<div class="pa-two"><section aria-label="Sell these"><div class="pa-row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><p class="pa-h2" style="margin:0">Sell these</p><div class="pa-seg" role="group" aria-label="Filter by unit">' +
      ['All units'].concat(units.map(function (u) { return u.name; })).map(function (n) { return '<button type="button" data-act="filter" data-u="' + esc(n) + '" aria-pressed="' + (S.unitFilter === n) + '">' + esc(n) + '</button>'; }).join('') + '</div></div>' +
      (stretches.length ? stretches.map(function (s) { return '<div class="pa-stretch"><div class="n"><b>' + s.n + '</b><span class="pa-hint">' + (s.n === 1 ? 'night' : 'nights') + '</span></div><div class="grow"><div class="pa-label">' + esc(s.unit) + '</div><b style="color:#0e2f44">' + nice(s.a) + ' – ' + nice(s.b) + '</b><div class="pa-hint">' + (s.n < (S.av.minStay || 2) ? 'Below the ' + (S.av.minStay || 2) + '-night minimum' : nw(s.n) + ' in a row') + '</div></div>' +
        '<button type="button" class="pa-btn small" data-act="copy" data-text="' + esc(link(s.unit, s.a, s.b)) + '">Copy booking link</button></div>'; }).join('') : '<p class="pa-hint">Nothing open in these ' + WINDOW + ' days.</p>') +
      '</section><section class="pa-card pa-soft" aria-label="Share your open dates"><p class="pa-h2">Share your open dates</p><p class="pa-hint">A ready-made message for WhatsApp, Facebook or email. It follows the unit filter.</p>' +
      '<label class="pa-label" for="pa-share">Message</label><textarea id="pa-share" rows="10">' + esc(lines.join('\n')) + '</textarea><button type="button" class="pa-btn teal" style="margin-top:10px" data-act="copyShare">Copy message</button></section></div>';
    return h;
  }

  // ---- My Calendar ----
  function viewCal() {
    if (!S.av) return propHeader() + '<div class="pa-card pa-hint">Loading…</div>';
    var ym = S.calMonth, y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    var first = ym + '-01', days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var lead = (dObj(first).getUTCDay() + 6) % 7;
    var h = propHeader();
    h += '<div class="pa-card"><div class="pa-row" style="justify-content:space-between;align-items:center;margin-bottom:12px"><div class="pa-seg" role="group" aria-label="Choose unit">' +
      S.av.units.map(function (u) { return '<button type="button" data-act="calUnit" data-u="' + esc(u.name) + '" aria-pressed="' + (S.calUnit === u.name) + '">' + esc(u.name) + '</button>'; }).join('') + '</div>' +
      '<div class="pa-row" style="gap:8px;align-items:center"><button type="button" class="pa-btn small ghost" data-act="calMonth" data-n="-1" aria-label="Previous month">‹</button><b style="font:700 16px Montserrat,sans-serif;color:#0e2f44;min-width:150px;text-align:center">' + MONTH_FULL[m] + ' ' + y + '</b><button type="button" class="pa-btn small ghost" data-act="calMonth" data-n="1" aria-label="Next month">›</button></div></div>';
    h += '<div class="pa-grid-wrap"><div class="pa-cal">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) { return '<div class="dow">' + d + '</div>'; }).join('');
    for (var i = 0; i < lead; i++) h += '<div></div>';
    for (var d = 1; d <= days; d++) {
      var iso = ym + '-' + (d < 10 ? '0' + d : d), c = stateOf(S.calUnit, iso), past = iso < today();
      var look = { open: ['#ffffff', '#0e2f44', 'Open'], na: ['#f3f5f5', '#6b7477', 'Not on SN'], sn: ['#0e2f44', '#ffffff', 'Booked on SN'], hub: ['#0e2f44', '#ffffff', c.ref || 'Booked'], pending: ['#fff4e5', '#6b3a00', (CH[c.ch] || '') + ' · not on SN yet'], clash: ['#fff4e5', '#6b3a00', 'Clash'], airbnb: ['#ffe0da', '#7a1f12', 'Airbnb ' + (c.ref || '')], bcom: ['#dbe6ff', '#0b2f80', 'Booking.com ' + (c.ref || '')], lekke: ['#d9f2e3', '#0f5a32', 'LekkeSlaap ' + (c.ref || '')] }[c.s] || ['#fff', '#0e2f44', ''];
      if (past) look = ['#fff', '#8a9699', ''];
      else if (!S.av.nights[S.calUnit] || !S.av.loaded[iso]) look = ['#fff', '#8a9699', '…'];
      h += '<div class="day" style="background:' + look[0] + ';color:' + look[1] + (past ? ';opacity:.55' : '') + '"><b>' + d + '</b><span>' + esc(look[2]) + '</span></div>';
    }
    h += '</div></div><p class="pa-hint" style="margin-top:10px">Change availability or rates on Stock Network. The hub picks up changes within 15 minutes.</p></div>';
    return h;
  }

  // ---- Channels ----
  function viewChan() {
    if (!S.channels) return propHeader() + '<div class="pa-card pa-hint">Loading channels…</div>';
    var st = S.channels.settings || {}, h = propHeader();
    (S.channels.unitNotices || []).forEach(function (n) {
      var fresh = (S.channels.unitNotices || []).map(function (x) { return x.name; }), linked = S.channels.linkedUnits || [];
      var others = S.channels.units.map(function (u) { return u.name; }).filter(function (x) { return fresh.indexOf(x) < 0; }).sort(function (x, y) { return (linked.indexOf(y) >= 0) - (linked.indexOf(x) >= 0); });
      h += '<section class="pa-card" style="border-color:#f5c98a;background:#fff4e5" aria-label="New unit"><p class="pa-h2" style="color:#6b3a00">New unit on Stock Network: ' + esc(n.name) + '</p>' +
        '<p class="pa-hint" style="color:#6b3a00">If this is a unit that was renamed on Stock Network, move its channel links across so its calendars keep working (its old Avante links keep working too).</p>' +
        '<div class="pa-row" style="margin-top:8px">' + (others.length ? '<div class="pa-field" style="flex:1 1 200px"><label class="pa-label" for="pa-mv-' + esc(n.name) + '">Renamed from</label><select id="pa-mv-' + esc(n.name) + '">' + others.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('') + '</select></div>' +
        '<button type="button" class="pa-btn" data-act="unitMove" data-u="' + esc(n.name) + '">Move links to ' + esc(n.name) + '</button>' : '') +
        '<button type="button" class="pa-btn ghost" data-act="unitNew" data-u="' + esc(n.name) + '">It\'s a new unit</button></div></section>';
    });
    h += '<section class="pa-card" aria-label="Reservation settings"><p class="pa-h2">Reservation settings</p><p class="pa-hint">Used when the hub books another channel\'s reservation onto Stock Network (client name = the channel).</p><div class="pa-form" style="margin-top:10px">' +
      '<div class="pa-field"><label class="pa-label" for="pa-se">Email on SN reservations</label><input id="pa-se" type="email" value="' + esc(st.email || '') + '" placeholder="Your reservations inbox"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-sp">Phone on SN reservations (required)</label><input id="pa-sp" type="tel" value="' + esc(st.phone || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-sm">Minimum stay (nights)</label><input id="pa-sm" type="number" min="1" max="30" value="' + esc(st.minStay || 2) + '"></div></div>' +
      '<p class="pa-label" style="margin:14px 0 6px">Nightly channel price per unit (calendar links don\'t include prices)</p><div class="pa-form">' +
      S.channels.units.map(function (u) { return '<div class="pa-field"><label class="pa-label" for="pa-pr-' + esc(u.name) + '" style="color:#0e2f44">' + esc(u.name) + '</label><input id="pa-pr-' + esc(u.name) + '" data-price="' + esc(u.name) + '" type="number" min="0" value="' + esc((st.prices || {})[u.name] || '') + '" placeholder="Uses the SN rate if empty"></div>'; }).join('') + '</div>' +
      '<label class="pa-check" style="display:flex;align-items:center;gap:10px;margin-top:14px"><input id="pa-auto" type="checkbox"' + (st.autoBook ? ' checked' : '') + ' style="width:18px;height:18px">Book other channels\' reservations onto Stock Network automatically</label>' +
      '<p class="pa-hint">Leave this off at first: new channel bookings then wait below for you to add them with one click, so you can check everything is right.</p></section>';
    var bk = S.channels.bank || {}, pm = st.payMode || 'both';
    var pmOpt = function (v, label, hint) { return '<label class="pa-check pa-radio"><input type="radio" name="pa-pm" value="' + v + '"' + (pm === v ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="pa-hint">' + hint + '</span></span></label>'; };
    h += '<section class="pa-card" aria-label="Guest payments"><p class="pa-h2">Guest payments</p><p class="pa-hint">How guests pay for bookings you make in the hub. Bookings from Airbnb, Booking.com and LekkeSlaap are paid on those channels.</p>' +
      '<fieldset class="pa-fieldset"><legend class="pa-label">How guests can pay</legend>' +
      pmOpt('both', 'Both (recommended)', 'Avante payment gateway link and EFT to your bank account.') +
      pmOpt('gateway', 'Avante payment gateway only', 'Stock Network sets the booking to Paid automatically.') +
      pmOpt('eft', 'EFT to our bank account only', 'You mark EFT payments as paid in the hub, and in Stock Network.') + '</fieldset>' +
      '<p class="pa-label" style="margin:16px 0 6px">Your bank account for EFT</p><div class="pa-form">' +
      '<div class="pa-field"><label class="pa-label" for="pa-bn" style="color:#0e2f44">Bank</label><input id="pa-bn" type="text" value="' + esc(bk.bankName || '') + '" placeholder="e.g. FNB"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bh" style="color:#0e2f44">Account holder</label><input id="pa-bh" type="text" value="' + esc(bk.accountHolder || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ba" style="color:#0e2f44">Account number</label><input id="pa-ba" type="text" inputmode="numeric" autocomplete="off" value="' + esc(bk.accountNumber || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bb" style="color:#0e2f44">Branch code</label><input id="pa-bb" type="text" inputmode="numeric" value="' + esc(bk.branchCode || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bt" style="color:#0e2f44">Account type</label><select id="pa-bt">' + ['', 'Cheque / Current', 'Savings', 'Business'].map(function (o) { return '<option' + ((bk.accountType || '') === o ? ' selected' : '') + ' value="' + esc(o) + '">' + (o || 'Choose…') + '</option>'; }).join('') + '</select></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bx" style="color:#0e2f44">Note for guests (optional)</label><input id="pa-bx" type="text" value="' + esc(bk.note || '') + '" placeholder="e.g. Send proof of payment to …"></div></div>' +
      '<p class="pa-hint">Kept encrypted. Guests see these only in the payment message you send them, with the booking reference to use.</p>' +
      '<div class="pa-row" style="margin-top:12px"><button type="button" class="pa-btn" data-act="saveChannels">Save payment settings</button></div></section>';
    h += '<section class="pa-card" aria-label="Channel links"><div class="pa-row" style="justify-content:space-between;align-items:center"><div><p class="pa-h2">Channel links per unit</p><p class="pa-hint">Step 1: copy the Avante link into that unit\'s listing on the channel. Step 2: paste the channel\'s own calendar link back here.</p></div><button type="button" class="pa-btn ghost small" data-act="syncNow">Check channels now</button></div>';
    S.channels.units.forEach(function (u) {
      h += '<h3 style="font:700 15px Montserrat,sans-serif;color:#0e2f44;margin:18px 0 0">' + esc(u.name) + ' <span class="pa-hint" style="font-weight:600">· ' + esc(u.size) + '</span></h3><div class="pa-chan">';
      u.channels.forEach(function (c) {
        var badge = c.status === 'ok' ? ['#d4f5f2', '#065e58', 'Connected · read ' + (c.lastRead ? new Date(c.lastRead).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')] : c.status === 'error' ? ['#ffe2bf', '#6b3a00', 'Needs attention'] : c.status === 'waiting' ? ['#eef2f2', '#333', 'Waiting for first read'] : ['#eef2f2', '#333', 'Not connected'];
        h += '<div class="pa-card" style="margin:0;box-shadow:none"><div class="pa-row" style="justify-content:space-between;align-items:center"><b style="font:700 14px Montserrat,sans-serif;color:#0e2f44">' + esc(c.label) + '</b><span class="pa-pill" style="background:' + badge[0] + ';color:' + badge[1] + '">' + esc(badge[2]) + '</span></div>' +
          '<label class="pa-label" style="display:block;margin-top:10px">Avante link for ' + esc(c.label) + '</label><div class="pa-copy"><input type="text" readonly value="' + esc(c.exportUrl) + '" aria-label="Avante link for ' + esc(u.name) + ' on ' + esc(c.label) + '"><button type="button" class="pa-btn small" data-act="copy" data-text="' + esc(c.exportUrl) + '">Copy</button></div>' +
          '<label class="pa-label" style="display:block;margin-top:10px" for="pa-imp-' + esc(u.name + c.key) + '">' + esc(c.label) + '\'s calendar link</label><input id="pa-imp-' + esc(u.name + c.key) + '" type="url" data-imp="' + esc(u.name) + '|' + c.key + '" value="' + esc(c.importUrl) + '" placeholder="https://… .ics">' +
          (c.error ? '<p class="pa-err" style="margin-top:8px">' + esc(c.error) + '</p>' : '') +
          (c.status === 'ok' ? '<p class="pa-hint" style="margin:8px 0 0">' + (c.next && c.next.length ? 'Next on this link: <b style="color:#0e2f44">' + c.next.map(function (x) { return short(x.start) + ' – ' + short(x.end); }).join(', ') + '</b>. Check these match ' + esc(u.name) + ' on ' + esc(c.label) + '.' : 'No upcoming bookings on this link.') + '</p>' : '') + '</div>';
      });
      h += '</div>';
    });
    h += '<div class="pa-row" style="margin-top:16px"><button type="button" class="pa-btn" data-act="saveChannels">Save settings and links</button></div></section>';
    var ev = (S.events || []).filter(function (e) { return e.status !== 'booked'; });
    h += '<section class="pa-card" aria-label="Channel bookings"><p class="pa-h2">Channel bookings not yet on Stock Network</p>' + (ev.length ? ev.map(function (e) {
      return '<div class="pa-result"><div class="grow"><b>' + esc(CH[e.channel]) + ' · ' + esc(e.unit) + '</b><div class="pa-hint">' + nice(e.start) + ' – ' + nice(e.end) + ' · ' + nw(nightsBetween(e.start, e.end)) + (e.summary ? ' · ' + esc(e.summary) : '') + '</div>' + (e.error ? '<div class="pa-err" style="margin-top:6px">' + esc(e.error) + '</div>' : '') + '</div>' +
        (e.status === 'clash' ? '<span class="pa-pill" style="background:#ffe2bf;color:#6b3a00">Clash · sold on SN</span>' : '<button type="button" class="pa-btn small" data-act="addEvent" data-u="' + esc(e.unit) + '" data-c="' + esc(e.channel) + '" data-uid="' + esc(e.uid) + '">Add to Stock Network</button>') + '</div>';
    }).join('') : '<p class="pa-hint">None. New bookings from Airbnb, Booking.com and LekkeSlaap appear here within 15 minutes.</p>') + '</section>';
    return h;
  }

  // ---- Bookings ----
  var PAY_PILL = { paid: ['#d4f5f2', '#065e58', 'Paid'], 'paid-eft': ['#d4f5f2', '#065e58', 'Paid (EFT)'], 'part-paid': ['#fff4e5', '#6b3a00', 'Part paid'], unpaid: ['#fff4e5', '#6b3a00', 'Unpaid'], channel: ['#eef2f2', '#333', 'Paid on channel'] };
  function payPill(b) {
    if (b.status === 'Cancelled') return '';
    var p = PAY_PILL[b.payState] || PAY_PILL.unpaid;
    return '<span class="pa-pill" style="background:' + p[0] + ';color:' + p[1] + '">' + p[2] + (b.payState === 'part-paid' ? ' ' + money(b.amountPaid) : '') + '</span>';
  }
  function statusPill(b) { var c = b.status === 'Cancelled' ? ['#e7ebeb', '#333'] : ['#dbe6ff', '#0b2f80']; return '<span class="pa-pill" style="background:' + c[0] + ';color:' + c[1] + '">' + esc(b.status) + '</span>'; }
  function whoOf(b) { return b.origin === 'channel' ? (b.source || '') : ((b.guest && (b.guest.first + ' ' + b.guest.last).trim()) || ''); }
  function bookingActions(b) {
    var live = b.items.filter(function (i) { return !i.cancelled; });
    if (b.status === 'Cancelled' || !live.length) return '';
    var h = '<button type="button" class="pa-btn small" data-act="editBooking" data-ref="' + esc(b.ref) + '">' + (b.locked ? 'View' : 'Edit') + '</button>';
    if (b.origin !== 'channel' && !b.locked) {
      h += '<button type="button" class="pa-btn small ghost" data-act="payLink" data-ref="' + esc(b.ref) + '">Payment link</button>';
      if (S.payMode !== 'gateway') h += '<button type="button" class="pa-btn small ghost" data-act="markPaid" data-ref="' + esc(b.ref) + '">Mark paid (EFT)</button>';
    }
    if (b.cancelRequest) h += '<span class="pa-hint" style="width:100%">Cancellation waiting for affiliate approval</span>';
    return '<div class="pa-actions">' + h + '</div>';
  }
  function viewBookings() {
    var h = propHeader();
    h += '<section class="pa-card"><div class="pa-row" style="justify-content:space-between;align-items:center"><p class="pa-h2">Bookings made or synced by the hub</p><div class="pa-field" style="flex:0 1 280px"><label class="pa-label" for="pa-bq">Search</label><input id="pa-bq" type="search" value="' + esc(S.findQ) + '" placeholder="Reference, guest, unit or channel"></div></div>';
    if (!S.bookings) return h + '<p class="pa-hint">Loading…</p></section>';
    var units = function (b) { return b.items.map(function (i) { return (i.cancelled ? '<s>' : '') + esc(i.unit) + ' · ' + short(i.start) + ' – ' + short(i.end) + (i.cancelled ? '</s>' : ''); }).join('<br>'); };
    if (!S.bookings.length) h += '<p class="pa-hint" style="margin-top:12px">No bookings yet.</p>';
    else if (isPhone()) {
      h += '<div class="pa-bk-list">' + S.bookings.map(function (b) {
        return '<article class="pa-bk"><div class="pa-row" style="justify-content:space-between;align-items:center;gap:6px"><b style="font:700 15px Montserrat,sans-serif;color:#0e2f44">' + esc(b.ref) + '</b><span>' + statusPill(b) + ' ' + payPill(b) + '</span></div>' +
          '<div style="font-size:13px;margin-top:6px;line-height:1.5">' + units(b) + '</div><div class="pa-hint">' + esc(whoOf(b)) + ' · ' + money(b.total) + (b.replaces ? ' · replaces ' + esc(b.replaces) : '') + '</div>' + bookingActions(b) + '</article>';
      }).join('') + '</div>';
    } else {
      h += '<div class="pa-grid-wrap" style="margin-top:10px"><table class="pa-table"><thead><tr><th>Ref</th><th>Units and dates</th><th>Guest / channel</th><th>Amount</th><th>Status</th><th>Payment</th><th></th></tr></thead><tbody>';
      h += S.bookings.map(function (b) {
        return '<tr><td><b>' + esc(b.ref) + '</b>' + (b.replaces ? '<div class="pa-hint">replaces ' + esc(b.replaces) + '</div>' : '') + '</td><td>' + units(b) + '</td>' +
          '<td>' + esc(whoOf(b)) + (b.origin !== 'channel' && b.source && b.source !== 'Direct' ? '<div class="pa-hint">via ' + esc(b.source) + '</div>' : '') + '</td><td>' + money(b.total) + '</td>' +
          '<td>' + statusPill(b) + '</td><td>' + payPill(b) + '</td><td>' + bookingActions(b) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    }
    h += '<p class="pa-hint">Paid bookings are locked: the guest contacts the property to change them, and cancelling needs the linked affiliate\'s approval. Stock Network bookings made outside the hub show on the Availability grid as Booked; manage those in Stock Network.</p></section>';
    return h;
  }

  // ---- Reviews ----
  function viewReviews() {
    return propHeader() + '<div class="pa-stats"><div class="pa-stat" style="background:#0e2f44;color:#fff"><span style="font:700 12px Montserrat,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#9fe9e3">Avante guest rating</span><span style="color:#d6e2e9;line-height:1.5">Shows on your listing once you have 3 Avante guest reviews. Until then guests see your Google reviews.</span></div>' +
      '<div class="pa-stat" style="background:#f4fbfa;border:1.5px solid #e3e9e8"><span class="pa-label">What Google says</span><span style="line-height:1.5">Your Google rating and reviews show on your listing through Avante Reviews once your Google Place ID is set.</span></div>' +
      '<div class="pa-stat" style="background:#f4fbfa;border:1.5px solid #e3e9e8"><span class="pa-label">Ask guests for a review</span><span class="pa-pill" style="background:#fff4e5;color:#6b3a00;align-self:flex-start">Coming after the hub launches</span></div></div>' +
      '<div class="pa-card pa-soft"><p class="pa-h2">Rate your guests</p><p class="pa-hint">Coming after the hub launches: rate guests after their stay, shared only with Avante partner properties.</p></div>';
  }

  // ---- Payment block (after booking, or "Payment link") ----
  function payBlock(pay) {
    if (!pay) return '';
    S.payMsg = pay.message;
    var h = '<div class="pa-pay"><p class="pa-label" style="margin:0">Payment</p>';
    if (pay.noMethod) return h + '<p class="pa-err">No payment method is set up. Add your bank details or allow the payment gateway in Channels → Guest payments.</p></div>';
    if (pay.gatewayUrl) h += '<div class="pa-actions"><button type="button" class="pa-btn teal" data-act="openPay" data-url="' + esc(pay.gatewayUrl) + '">Pay now</button><button type="button" class="pa-btn small ghost" data-act="copy" data-text="' + esc(pay.gatewayUrl) + '">Copy payment link</button></div>';
    if (pay.bank) h += '<div class="pa-bankbox"><b>EFT</b><br>' + esc(pay.bank.bankName) + ' · ' + esc(pay.bank.accountHolder) + '<br>Account ' + esc(pay.bank.accountNumber) + ' · Branch ' + esc(pay.bank.branchCode || '') + (pay.bank.accountType ? ' · ' + esc(pay.bank.accountType) : '') + '</div>';
    h += '<p class="pa-label" style="margin:6px 0 0">Send to the guest</p><div class="pa-actions">' +
      '<a class="pa-btn small" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(pay.whatsappUrl) + '" target="_blank" rel="noopener">WhatsApp</a>' +
      (pay.emailUrl ? '<a class="pa-btn small ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(pay.emailUrl) + '">Email</a>' : '') +
      '<button type="button" class="pa-btn small ghost" data-act="copyPayMsg">Copy message</button></div></div>';
    return h;
  }

  // ---- Modals ----
  function viewModal() {
    var m = S.modal, h = '<div class="pa-modal" data-act="backdrop"><div class="pa-dialog" role="dialog" aria-modal="true" aria-labelledby="pa-dlg-t">';
    var hdr = function (t, s) { return '<header><div><b id="pa-dlg-t">' + esc(t) + '</b><span>' + esc(s || (S.prop.resortName + ' · site ' + S.prop.site)) + '</span></div><button type="button" data-act="close" aria-label="Close">✕</button></header>'; };
    if (m.type === 'pay') {
      return h.replace('pa-dialog"', 'pa-dialog pa-dialog-wide"') + '<header><div><b id="pa-dlg-t">Pay booking</b><span>Secure payment page on Stock Network</span></div><button type="button" data-act="payBack" aria-label="Close payment">✕</button></header>' +
        '<iframe class="pa-payframe" src="' + esc(m.url) + '" title="Stock Network payment"></iframe>' +
        '<div class="pa-payfoot">Payment page not loading, or your bank asks to leave this window? <a href="' + esc(m.url) + '" target="_blank" rel="noopener">Open it in a new tab</a></div></div></div>';
    }
    if (m.done) {
      var ap = m.done.approval;
      return h + hdr(m.done.title) + '<div class="body"><p style="margin:0;font-size:14px;line-height:1.55">' + esc(m.done.text) + '</p>' +
        payBlock(m.done.pay) +
        (ap ? '<div class="pa-pay"><p class="pa-label" style="margin:0">Affiliate approval</p><p style="margin:0;font-size:13.5px;line-height:1.5">' + (ap.emailedTo ? 'Approval link emailed to ' + esc(ap.emailedTo) + '.' : 'The approval email could not be sent (no email on the affiliate\'s account).') + ' The link is valid for 24 hours and needs the affiliate\'s hub password.</p>' +
          '<div class="pa-actions"><a class="pa-btn small" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(ap.whatsappUrl) + '" target="_blank" rel="noopener">Send by WhatsApp' + (ap.hasPhone ? '' : ' (choose contact)') + '</a></div></div>' : '') +
        '<button type="button" class="pa-btn" style="align-self:flex-start" data-act="close">Done</button></div></div></div>';
    }
    if (m.type === 'find') {
      h += hdr('Find a Booking') + '<div class="body"><div class="pa-field"><label class="pa-label" for="pa-fq">Reference, guest name, unit or channel</label><input id="pa-fq" type="search" value="' + esc(S.findQ) + '" placeholder="e.g. J111672, Airbnb, FV10"></div>';
      h += (S.found || []).filter(function (b) { return b.status !== 'Cancelled'; }).map(function (b) { return '<div class="pa-result"><div class="grow"><b>' + esc(b.ref) + ' · ' + esc(b.items.filter(function (i) { return !i.cancelled; }).map(function (i) { return i.unit; }).join(', ')) + '</b><div class="pa-hint">' + esc(b.origin === 'channel' ? b.source : ((b.guest && (b.guest.first + ' ' + b.guest.last)) || '')) + ' · ' + b.items.filter(function (i) { return !i.cancelled; }).map(function (i) { return short(i.start) + ' – ' + short(i.end); }).join(', ') + '</div></div><button type="button" class="pa-btn small" data-act="editBooking" data-ref="' + esc(b.ref) + '">Edit</button></div>'; }).join('') || '<p class="pa-hint">No active booking matches.</p>';
      return h + '<p class="pa-hint">Stock Network can\'t edit a booking. Changing the unit or dates cancels it on SN and makes a new booking with a new reference.</p></div></div></div>';
    }
    var editing = m.type === 'edit', b = S.edit, live = editing ? b.items.filter(function (i) { return !i.cancelled; }) : null;
    if (editing && b.locked) {
      h += hdr('Booking ' + b.ref + ' · ' + (PAY_PILL[b.payState] || PAY_PILL.paid)[2]);
      h += '<div class="body"><div class="pa-items">' + live.map(function (it) { return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + '</b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span></div>'; }).join('') +
        '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + esc(whoOf(b)) + '</span><b>' + money(b.total) + '</b></div></div>' +
        '<div class="pa-lock"><b>Paid: locked</b><br>This booking can\'t be changed in the hub. The guest must contact the property, and changes are made in Stock Network. To cancel it, request cancellation: the affiliate linked to this property approves it with their hub password.</div>' +
        (b.cancelRequest ? '<p class="pa-hint">Cancellation already requested ' + esc(new Date(b.cancelRequest.at).toLocaleString()) + '. Requesting again sends a new link.</p>' : '') +
        '<div class="pa-row"><button type="button" class="pa-btn danger" data-act="cancelBooking"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Sending…' : 'Request cancellation') + '</button><button type="button" class="pa-btn ghost" data-act="close">Close</button></div></div></div></div>';
      return h;
    }
    var items = editing ? live : S.cart, total = 0, short2 = false, g = editing ? (b.guest || {}) : {};
    h += hdr(editing ? 'Edit booking ' + b.ref : (S.cart.length > 1 ? 'New booking · ' + S.cart.length + ' units' : 'New booking on Stock Network'));
    h += '<div class="body"><div class="pa-items">' + items.map(function (it, i) {
      var p = priceOf(it.unit, it.start, it.end); total += p || 0; if (nightsBetween(it.start, it.end) < (S.av ? S.av.minStay : 2)) short2 = true;
      var rm = editing ? (live.length > 1 ? '<button type="button" class="pa-btn small danger" data-act="removeUnit" data-u="' + esc(it.unit) + '">Remove unit</button>' : '') : (S.cart.length > 1 ? '<button type="button" class="pa-btn small danger" data-act="uncart" data-i="' + i + '">Remove</button>' : '');
      return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + ' <span class="pa-hint">· ' + esc(sizeOf(it.unit)) + '</span></b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span><b>' + money(editing ? null : p) + '</b>' + rm + '</div>';
    }).join('') + (editing ? '' : '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + (items.length === 1 ? '1 unit' : items.length + ' units, one reservation') + '</span><b style="font:800 16px Montserrat,sans-serif;color:#0e2f44">Total ' + money(total) + '</b></div>') + '</div>';
    if (editing && live.length === 1) {
      h += '<div class="pa-form"><div class="pa-field"><label class="pa-label" for="pa-eu">Unit</label><select id="pa-eu">' + S.av.units.map(function (u) { return '<option' + (u.name === live[0].unit ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="pa-field"><label class="pa-label" for="pa-ei">Check-in</label><input id="pa-ei" type="date" value="' + live[0].start + '"></div><div class="pa-field"><label class="pa-label" for="pa-eo">Check-out</label><input id="pa-eo" type="date" value="' + live[0].end + '"></div></div>';
    }
    if (short2) h += '<p class="pa-err">Shorter than the ' + S.av.minStay + '-night minimum stay.</p>';
    if (!editing || b.origin !== 'channel') {
      h += '<div class="pa-form"><div class="pa-field"><label class="pa-label" for="pa-gf">First name</label><input id="pa-gf" type="text" value="' + esc(g.first || '') + '"></div><div class="pa-field"><label class="pa-label" for="pa-gl">Last name</label><input id="pa-gl" type="text" value="' + esc(g.last || '') + '"></div>' +
        '<div class="pa-field"><label class="pa-label" for="pa-ge">Email</label><input id="pa-ge" type="email" value="' + esc(g.email || '') + '"></div><div class="pa-field"><label class="pa-label" for="pa-gc">Cellphone (required)</label><input id="pa-gc" type="tel" value="' + esc(g.cellphone || '') + '" required></div>';
      if (!editing) h += '<div class="pa-field"><label class="pa-label" for="pa-ga">Adults</label><input id="pa-ga" type="number" min="1" value="2"></div><div class="pa-field"><label class="pa-label" for="pa-gk">Children</label><input id="pa-gk" type="number" min="0" value="0"></div>' +
        '<div class="pa-field"><label class="pa-label" for="pa-gs">Booked through</label><select id="pa-gs"><option>Direct</option><option>Walk-in</option><option>Booking.com</option><option>Airbnb</option><option>LekkeSlaap</option><option>Other</option></select></div><div class="pa-field"><label class="pa-label" for="pa-gr">Channel reference</label><input id="pa-gr" type="text" placeholder="Optional"></div>';
      h += '</div>';
      if (!editing) h += '<div class="pa-field"><label class="pa-label" for="pa-gn">Notes</label><textarea id="pa-gn" rows="2"></textarea></div>';
    }
    h += '<p class="pa-hint">' + (editing ? (live.length === 1 ? 'Saving a new unit or new dates cancels ' + b.ref + ' on Stock Network and makes a new booking with a new reference.' : 'Removing a unit cancels only that unit on Stock Network; the booking keeps its reference. To change dates, cancel and book again.') : (items.length > 1 ? 'All units go on one Stock Network reservation with one reference.' : 'Created on Stock Network as a Request, then blocked on your other channels within 15 minutes.')) + '</p>';
    if (editing && b.origin !== 'channel') h += '<div class="pa-row"><button type="button" class="pa-btn small ghost" data-act="payLink" data-ref="' + esc(b.ref) + '">Payment link</button></div>';
    h += '<div class="pa-row">' + (editing ? (live.length === 1 ? '<button type="button" class="pa-btn" data-act="saveEdit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save changes') + '</button>' : '') + '<button type="button" class="pa-btn danger" data-act="cancelBooking">Cancel this booking</button>'
      : '<button type="button" class="pa-btn" data-act="confirmBook"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Booking…' : (items.length > 1 ? 'Book ' + items.length + ' units on Stock Network' : 'Make booking on Stock Network')) + '</button>') + '<button type="button" class="pa-btn ghost" data-act="close">Close</button></div>';
    return h + '</div></div></div>';
  }

  // ---------- actions ----------
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function setView(v) {
    S.view = v; S.err = null; S.msg = null; render();
    if (!S.prop) return;
    if (v === 'avail') loadAvailability(S.from);
    if (v === 'cal') { if (!S.calMonth) S.calMonth = (S.from || today()).slice(0, 7); loadMonth(); }
    if (v === 'chan') Promise.all([api('channels'), api('channelEvents')]).then(function (r) { S.channels = r[0]; S.events = r[1].events; render(); }).catch(fail);
    if (v === 'book') api('find', { q: S.findQ }).then(function (d) { S.bookings = d.bookings; S.payMode = d.payMode; render(); }).catch(fail);
  }
  function closePay() {
    var back = S.modal && S.modal.back; S.modal = back || null;
    // The guest may just have paid: refresh payment status when the bookings list is next shown.
    S.bookings = null; render();
    if (S.view === 'book') setView('book');
  }
  function afterChange(done) {
    S.busy = false; S.modal = { done: done }; S.cart = []; S.sel = null; S.results = null; S.bookings = null;
    staleAll(); loadAvailability(S.from);
  }
  var findTimer = null;

  root.addEventListener('input', function (e) {
    if (e.target.id === 'pa-fq' || e.target.id === 'pa-bq') {
      S.findQ = e.target.value; clearTimeout(findTimer);
      var inModal = e.target.id === 'pa-fq';
      findTimer = setTimeout(function () { api('find', { q: S.findQ }).then(function (d) { if (inModal) S.found = d.bookings; else S.bookings = d.bookings; render(); var el = document.getElementById(inModal ? 'pa-fq' : 'pa-bq'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }).catch(fail); }, 300);
    }
    if (e.target.id === 'pa-rs') {
      var q = e.target.value.trim().toLowerCase(); S.connect.q = e.target.value; clearTimeout(findTimer);
      findTimer = setTimeout(function () {
        if (q.length < 3) return;
        fetch('/api/resorts').then(function (r) { return r.json(); }).then(function (d) {
          S.connect.matches = ((d && d.resorts) || []).filter(function (r) { return String(r.name || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 12);
          rememberConnect(); render(); var el = document.getElementById('pa-rs'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        });
      }, 300);
    }
  });
  function rememberConnect() { S.connect = Object.assign(S.connect || {}, { username: val('pa-u') || (S.connect && S.connect.username), clientID: val('pa-ci') || (S.connect && S.connect.clientID), clientSecret: val('pa-cs') || (S.connect && S.connect.clientSecret) }); }
  function doConnect(resortId) {
    rememberConnect(); var c = S.connect; S.err = null; busy(true); render();
    api('connect', { username: c.username, clientID: c.clientID, clientSecret: c.clientSecret, resortId: resortId || '', aff: aff }).then(function (d) {
      S.busy = false;
      if (d.needResort) { S.connect.needResort = true; S.connect.candidates = d.candidates; render(); return; }
      setToken(d.token); S.prop = d.property; S.connect = null; S.view = 'avail'; render(); loadAvailability();
    }).catch(fail);
  }

  root.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]'); if (!t) return;
    var a = t.dataset.act;
    if (a === 'backdrop' && e.target !== t) return;
    if (a === 'view') return setView(t.dataset.v);
    if (a === 'dismiss') { S.err = null; return render(); }
    if (a === 'connect') return doConnect();
    if (a === 'pickResort') return doConnect(t.dataset.id);
    if (a === 'disconnect') { if (!confirm('Disconnect this property from the hub? Channel sync stops until you connect again.')) return; return api('disconnect').then(function () { setToken(null); S.prop = null; S.av = null; render(); }).catch(fail); }
    if ((a === 'close' || a === 'backdrop') && S.modal && S.modal.type === 'pay') return closePay();
    if (a === 'close' || a === 'backdrop') { S.modal = null; S.edit = null; return render(); }
    if (a === 'payBack') return closePay();
    if (a === 'openPay') { S.modal = { type: 'pay', url: t.dataset.url, back: S.modal }; return render(); }
    if (a === 'copyPayMsg') { var pm = S.payMsg || ''; (navigator.clipboard ? navigator.clipboard.writeText(pm) : Promise.reject()).then(function () { t.textContent = 'Copied'; }, function () { prompt('Copy this:', pm); }); return; }
    if (a === 'payLink') {
      t.textContent = 'Loading…';
      return api('payInfo', { ref: t.dataset.ref }).then(function (d) {
        if (d.booking.locked) { S.modal = { done: { title: d.booking.ref + ' is paid', text: 'Stock Network shows this booking as paid, so no payment link is needed.' } }; S.bookings = null; setView(S.view); return; }
        S.modal = { done: { title: 'Payment for ' + d.booking.ref, text: d.booking.items.filter(function (i) { return !i.cancelled; }).map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ') + ' · ' + money(d.booking.total), pay: d.pay } }; render();
      }).catch(fail);
    }
    if (a === 'markPaid') {
      if (!confirm('Mark ' + t.dataset.ref + ' as paid by EFT?\n\nOnly do this once the money is in your account. A paid booking is locked: it can\'t be changed in the hub, and cancelling needs the affiliate\'s approval.\n\nAlso mark it paid in Stock Network, so SN doesn\'t auto-cancel the request.')) return;
      return api('markPaid', { ref: t.dataset.ref }).then(function () { S.msg = t.dataset.ref + ' marked as paid (EFT). Remember to mark it paid in Stock Network too.'; return api('find', { q: S.findQ }).then(function (d) { S.bookings = d.bookings; S.payMode = d.payMode; render(); }); }).catch(fail);
    }
    if (a === 'shift') { var nf = add(S.from, +t.dataset.n); if (nf < today()) nf = today(); return loadAvailability(nf); }
    if (a === 'search') {
      var ci = val('pa-qin'), co = val('pa-qout'); S.searched = { ci: ci, co: co };
      return api('search', { checkIn: ci, checkOut: co }).then(function (d) {
        S.results = d;
        // The search read the stay and the next 2 weeks, so showing them costs no extra call to SN.
        if (ci < S.from || ci >= add(S.from, WINDOW)) { staleRange(ci, co > add(ci, 14) ? co : add(ci, 14)); return loadAvailability(ci); }
        staleRange(ci, co); loadWindow(ci, co);
      }).catch(fail);
    }
    if (a === 'selectResult') { S.cart.push({ unit: t.dataset.u, start: S.results.checkIn, end: S.results.checkOut }); S.results = null; return render(); }
    if (a === 'cell') {
      var u = t.dataset.u, d = t.dataset.d;
      if (!S.sel || S.sel.unit !== u || d <= S.sel.start) { S.sel = { unit: u, start: d }; return render(); }
      if (!rangeOpen(u, S.sel.start, add(d, 1))) { S.sel = { unit: u, start: d }; return render(); }
      S.cart.push({ unit: u, start: S.sel.start, end: add(d, 1) }); S.sel = null; return render();
    }
    if (a === 'uncart') { S.cart.splice(+t.dataset.i, 1); if (!S.cart.length && S.modal && S.modal.type === 'book') S.modal = null; return render(); }
    if (a === 'clearCart') { S.cart = []; S.sel = null; return render(); }
    if (a === 'openBook') { S.modal = { type: 'book' }; return render(); }
    if (a === 'filter') { S.unitFilter = t.dataset.u; return render(); }
    if (a === 'calUnit') { S.calUnit = t.dataset.u; return render(); }
    if (a === 'calMonth') {
      var y = +S.calMonth.slice(0, 4), mo = +S.calMonth.slice(5, 7) - 1 + (+t.dataset.n); var dt = new Date(Date.UTC(y, mo, 1)); S.calMonth = dt.toISOString().slice(0, 7);
      return loadMonth();
    }
    if (a === 'copy' || a === 'copyShare') {
      var text = a === 'copy' ? t.dataset.text : val('pa-share');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { t.textContent = 'Copied'; }, function () { prompt('Copy this:', text); });
      return;
    }
    if (a === 'confirmBook') {
      var bookBody = { items: S.cart, guest: { first: val('pa-gf'), last: val('pa-gl'), email: val('pa-ge'), cellphone: val('pa-gc') }, adults: val('pa-ga'), children: val('pa-gk'), source: val('pa-gs'), channelRef: val('pa-gr'), notes: val('pa-gn') };
      if (!bookBody.guest.cellphone.trim()) { var gc = document.getElementById('pa-gc'); if (gc) { gc.focus(); gc.setAttribute('aria-invalid', 'true'); } return; }
      busy(true); render();
      return api('book', bookBody)
        .then(function (d) { var b = d.booking; afterChange({ title: 'Booking ' + b.ref + ' created', text: b.items.map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ') + ' · ' + money(b.total) + '. Status ' + b.status + ' on Stock Network. Your other channels are blocked within 15 minutes.', pay: d.pay }); })
        .catch(function (err) { S.busy = false; S.err = err.message; S.modal = null; render(); });
    }
    if (a === 'openFind') { S.modal = { type: 'find' }; return api('find', { q: S.findQ }).then(function (d) { S.found = d.bookings; render(); }).catch(fail); }
    if (a === 'editBooking') {
      var list = (S.found || []).concat(S.bookings || []); var bk = list.find(function (x) { return x.ref === t.dataset.ref; });
      if (!bk) return; S.edit = bk; S.modal = { type: 'edit' }; if (!S.av) loadAvailability(S.from); return render();
    }
    if (a === 'saveEdit') {
      var editBody = { ref: S.edit.ref, change: { unit: val('pa-eu'), start: val('pa-ei'), end: val('pa-eo'), guest: S.edit.origin === 'channel' ? undefined : { first: val('pa-gf'), last: val('pa-gl'), email: val('pa-ge'), cellphone: val('pa-gc') } } };
      busy(true); render();
      return api('edit', editBody)
        .then(function (d) { afterChange(d.booking && d.replaced ? { title: 'Booking ' + d.booking.ref + ' created', text: d.replaced + ' was cancelled on Stock Network and replaced by ' + d.booking.ref + ' · ' + money(d.booking.total) + '. Send the guest the new payment link.', pay: d.pay } : { title: 'Details updated', text: 'The unit and dates are unchanged, so ' + S.edit.ref + ' stays as it is on Stock Network.' }); })
        .catch(function (err) { S.busy = false; S.err = err.message; S.modal = null; staleAll(); render(); loadAvailability(S.from); });
    }
    if (a === 'removeUnit') {
      if (!confirm('Cancel ' + t.dataset.u + ' on ' + S.edit.ref + '? The other units stay booked.')) return;
      busy(true); render();
      return api('cancelUnit', { ref: S.edit.ref, unit: t.dataset.u }).then(function () { afterChange({ title: t.dataset.u + ' removed from ' + S.edit.ref, text: 'Only ' + t.dataset.u + ' was cancelled on Stock Network. The booking keeps its other units and its reference.' }); }).catch(fail);
    }
    if (a === 'cancelBooking') {
      var locked = S.edit.locked;
      if (!confirm(locked ? 'Request cancellation of PAID booking ' + S.edit.ref + '?\n\nThe affiliate linked to this property gets a link by email (and WhatsApp if you send it) and must approve with their hub password. Refunds are handled outside the hub.' : 'Cancel ' + S.edit.ref + ' on Stock Network?')) return;
      busy(true); render();
      return api('cancel', { ref: S.edit.ref }).then(function (d) {
        if (d.needsApproval) { S.busy = false; S.bookings = null; S.modal = { done: { title: 'Approval requested for ' + S.edit.ref, text: 'This booking is paid, so it is NOT cancelled yet. It will be cancelled on Stock Network as soon as the affiliate approves.', approval: d.approval } }; S.edit = null; render(); return; }
        afterChange({ title: 'Booking ' + S.edit.ref + ' cancelled', text: d.alreadyCancelled ? 'It had already been cancelled in Stock Network.' : 'Cancelled on Stock Network. The nights are open again and your other channels are unblocked within 15 minutes.' });
      }).catch(function (err) { S.busy = false; S.err = err.message; S.modal = null; render(); });
    }
    if (a === 'saveChannels') {
      var prices = {}; root.querySelectorAll('[data-price]').forEach(function (el) { prices[el.dataset.price] = el.value; });
      var channels = {}; root.querySelectorAll('[data-imp]').forEach(function (el) { var p = el.dataset.imp.split('|'); (channels[p[0]] = channels[p[0]] || {})[p[1]] = el.value.trim(); });
      var pmEl = root.querySelector('input[name="pa-pm"]:checked');
      return api('saveSettings', { email: val('pa-se'), phone: val('pa-sp'), minStay: val('pa-sm'), autoBook: document.getElementById('pa-auto').checked, prices: prices, channels: channels,
        payMode: pmEl ? pmEl.value : 'both', bank: { bankName: val('pa-bn'), accountHolder: val('pa-bh'), accountNumber: val('pa-ba'), branchCode: val('pa-bb'), accountType: val('pa-bt'), note: val('pa-bx') } })
        .then(function (d) { S.channels = d; S.msg = 'Saved. The hub reads your channel links every 15 minutes.'; render(); window.scrollTo(0, 0); }).catch(function (e) { fail(e); window.scrollTo(0, 0); });
    }
    if (a === 'unitMove' || a === 'unitNew') {
      var from = a === 'unitMove' ? val('pa-mv-' + t.dataset.u) : '';
      if (from && !confirm('Move the channel links, prices and hub bookings of ' + from + ' to ' + t.dataset.u + '? ' + from + ' will no longer show in the hub.')) return;
      return api('unitNotice', { name: t.dataset.u, from: from }).then(function (d) { S.channels = d; S.msg = from ? 'Moved ' + from + ' to ' + t.dataset.u + '.' : t.dataset.u + ' added as a new unit.'; staleAll(); render(); }).catch(fail);
    }
    if (a === 'syncNow') {
      t.textContent = 'Checking…';
      return api('syncNow').then(function (d) { return Promise.all([api('channels'), api('channelEvents')]).then(function (r) { S.channels = r[0]; S.events = r[1].events; S.msg = 'Checked: ' + d.result.read + ' links read, ' + d.result.added + ' added, ' + d.result.cancelled + ' cancelled' + (d.result.clashes ? ', ' + d.result.clashes + ' clashes' : '') + '.'; staleAll(); render(); }); }).catch(fail);
    }
    if (a === 'addEvent') {
      t.textContent = 'Adding…';
      return api('addChannelEvent', { unit: t.dataset.u, channel: t.dataset.c, uid: t.dataset.uid }).then(function (d) { return api('channelEvents').then(function (r) { S.events = r.events; staleAll(); S.msg = 'Added to Stock Network as ' + d.event.ref + '.'; render(); }); }).catch(fail);
    }
  });

  // ---------- start ----------
  render();
  if (S.token) api('status').then(function (d) { S.prop = d.property; render(); loadAvailability(); }).catch(function (e) { if (S.token) fail(e); });
})();

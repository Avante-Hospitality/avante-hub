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
    bookings: null, more: false, msgEdit: null, unitFilter: 'All units', connect: null };
  // One connection per affiliate on this device (a shared computer can hold several).
  if (aff) TOKEN_KEY = 'avante-pa-token:' + aff;
  try {
    S.token = localStorage.getItem(TOKEN_KEY);
    var legacy = localStorage.getItem('avante-pa-token');
    if (!S.token && legacy && aff) { S.token = legacy; localStorage.setItem(TOKEN_KEY, legacy); }
    if (legacy) localStorage.removeItem('avante-pa-token');
  } catch (e) {}

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
      render();
    }).catch(function (e) { inFlight = null; fail(e); });
  }
  function loadAvailability(from) {
    S.from = from || S.from || startDate();
    if (S.from < today()) S.from = today();
    return loadWindow(S.from, add(S.from, WINDOW));
  }
  function stateOf(unit, n) { var r = S.av && S.av.nights[unit]; return (r && r[n]) || { s: 'na' }; }
  function inCart(unit, n) { return S.cart.some(function (c) { return c.unit === unit && n >= c.start && n < c.end; }); }
  function openNight(unit, n) { return stateOf(unit, n).s === 'open' && !inCart(unit, n); }
  function rangeOpen(unit, a, b) { return each(a, b).every(function (n) { return openNight(unit, n); }); }
  function priceOf(unit, a, b) { var nr = (S.av && S.av.nightRates[unit]) || {}; var t = 0; var nights = each(a, b); for (var i = 0; i < nights.length; i++) { if (!nr[nights[i]]) return null; t += nr[nights[i]]; } return t; }
  function sizeOf(unit) { var u = S.av && S.av.units.find(function (x) { return x.name === unit; }); return u ? u.size : ''; }

  // ---------- render ----------
  // Slim header + one sticky tab bar. Calendar is the home view (the date
  // search with the unit calendar right under it).
  var TABS = [['avail', 'Calendar'], ['book', 'Bookings'], ['guests', 'Guests'], ['msgs', 'Communication'], ['chan', 'Channels'], ['rev', 'Reviews']];
  function render() {
    if (S.view === 'msgs') collectMsgEdit(); // keep what was typed in the scheduled messages
    var connected = !!(S.token && S.prop);
    var h = '<div class="pa">';
    h += '<header class="pa-top"><span class="pa-kicker">Property Affiliate</span>' + (connected ? '<b class="pa-propname">' + esc(S.prop.resortName || 'Your property') + '</b><span class="pa-hint pa-top-meta">' + S.prop.units.length + ' units · SN site ' + esc(S.prop.site) + '</span>' : '') + '</header>';
    var inMore = S.view === 'onb';
    h += '<nav class="pa-tabbar" aria-label="Property Affiliate sections"><div class="pa-tabscroll">' + TABS.map(function (v) {
      var badge = v[0] === 'msgs' && S.msgsDue ? '<span class="pa-badge" aria-label="' + S.msgsDue + ' to send">' + S.msgsDue + '</span>' : '';
      return '<button type="button" data-act="view" data-v="' + v[0] + '"' + (S.view === v[0] ? ' aria-current="page"' : '') + '>' + v[1] + badge + '</button>';
    }).join('') + '</div>' +
      '<div class="pa-more"><button type="button" data-act="more" aria-haspopup="true" aria-expanded="' + (!!S.more) + '"' + (inMore ? ' aria-current="page"' : '') + '>More ▾</button>' +
      (S.more ? '<div class="pa-menu" role="menu"><button type="button" role="menuitem" data-act="view" data-v="onb">Onboarding Form</button><button type="button" role="menuitem" data-act="hookbuilder">Hook Builder</button>' +
        (connected ? '<button type="button" role="menuitem" class="pa-menu-danger" data-act="disconnect">Disconnect property</button>' : '') + '</div>' : '') +
      '</div></nav>';
    if (S.err) h += '<div class="pa-err" role="alert" style="margin-bottom:12px">' + esc(S.err) + ' <button type="button" class="pa-btn small ghost" data-act="dismiss" style="margin-left:8px">OK</button></div>';
    if (S.msg) h += '<div class="pa-ok" role="status" style="margin-bottom:12px">' + esc(S.msg) + '</div>';
    if (S.view === 'onb') h += '';
    else if (!connected) h += viewConnect();
    else if (S.view === 'avail') h += viewAvail();
    else if (S.view === 'chan') h += viewChan();
    else if (S.view === 'book') h += viewBookings();
    else if (S.view === 'guests') h += viewGuests();
    else if (S.view === 'msgs') h += viewMessages();
    else if (S.view === 'rev') h += viewReviews();
    h += '</div>';
    if (S.modal) h += '<div class="pa">' + viewModal() + '</div>';
    root.innerHTML = h;
    if (onboarding) onboarding.style.display = S.view === 'onb' ? '' : 'none';
  }

  // Kept for the views that used it: the slim header already shows the property.
  function propHeader() { return ''; }

  // The first date the calendar opens on (Channels → Reservation settings):
  // today, or a set date that is also the first bookable date.
  function startDate() { var fb = S.prop && S.prop.firstBookable; return fb && fb > today() ? fb : today(); }
  function firstBookable() { return startDate(); }

  function viewConnect() {
    var c = S.connect || {};
    var h = '';
    if (S.resume) {
      h += '<div class="pa-card"><p class="pa-h2">' + esc(S.resume.resortName || 'Your property') + ' is connected to your account</p>' +
        '<p class="pa-hint">To open it on this device, enter your Avante hub password (the one you log in with).</p>' +
        '<div class="pa-row" style="margin-top:10px"><div class="pa-field"><label class="pa-label" for="pa-rp">Hub password</label><input id="pa-rp" type="password" autocomplete="current-password"></div>' +
        '<button type="button" class="pa-btn" data-act="resume"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Opening…' : 'Open ' + esc(S.resume.resortName || 'property')) + '</button></div></div>' +
        '<details class="pa-card pa-soft"><summary class="pa-h2" style="cursor:pointer">Connect a different Stock Network site</summary>';
    }
    h += '<div class="pa-card"' + (S.resume ? ' style="margin:12px 0 0;box-shadow:none"' : '') + '><p class="pa-h2">Connect your Stock Network site</p>' +
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
    if (S.resume) h += '</details>';
    return h;
  }

  // ---- Calendar (home): date search, then every unit's nights ----
  // Bookings show as one block across their nights with the guest's name
  // (or "Airbnb guest" etc.); tap a block to open the booking. Open nights
  // are tapped to pick a stay.
  var BLOCK = { hub: 'bk-hub', sn: 'bk-sn', airbnb: 'bk-airbnb', bcom: 'bk-bcom', lekke: 'bk-lekke', pending: 'bk-warn', clash: 'bk-warn', na: 'bk-na', closed: 'bk-na' };
  function blockKey(st) { return st.ref ? 'ref:' + st.ref : st.s === 'pending' || st.s === 'clash' ? st.s + ':' + (st.ch || '') : st.s; }
  function viewAvail() {
    if (!S.av) return '<div class="pa-card pa-hint">Loading availability from Stock Network…</div>';
    var units = S.av.units, days = each(S.from, add(S.from, WINDOW)), fb = firstBookable();
    var qIn = (S.searched && S.searched.ci) || (S.from < fb ? fb : S.from), qOut = (S.searched && S.searched.co) || add(qIn, Math.max(1, S.av.minStay || 1));
    var h = '';
    if (S.msgsDue) h += '<div class="pa-ok pa-row" role="status" style="justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px"><span>' + S.msgsDue + (S.msgsDue === 1 ? ' WhatsApp message is' : ' WhatsApp messages are') + ' ready to send to guests.</span><button type="button" class="pa-btn small" data-act="view" data-v="msgs">Open Communication</button></div>';
    if (fb > today()) h += '<div class="pa-note">Bookings open from <b>' + nice(fb) + '</b> (your calendar start date, set in Channels → Reservation settings).</div>';
    // search
    h += '<section class="pa-search" aria-label="Find available units"><div class="pa-row">' +
      '<div class="pa-field"><label class="pa-label" for="pa-qin">Check-in</label><input id="pa-qin" type="date" value="' + qIn + '" min="' + fb + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-qout">Check-out</label><input id="pa-qout" type="date" value="' + qOut + '" min="' + add(fb, 1) + '"></div>' +
      '<button type="button" class="pa-btn" data-act="search">Search all units</button><button type="button" class="pa-btn ghost" data-act="openFind">Find a booking</button></div>';
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
    // calendar
    var phone = isPhone();
    var cols = (phone ? '62px' : '150px') + ' repeat(' + WINDOW + ', minmax(0,1fr))';
    var last = add(days[days.length - 1], 0);
    h += '<section class="pa-card pa-calcard" aria-label="Calendar"><div class="pa-caltools">' +
      '<div class="pa-row" style="gap:6px;align-items:center"><button type="button" class="pa-btn small ghost" data-act="shift" data-n="-' + WINDOW + '" aria-label="Previous ' + WINDOW + ' days"' + (S.from <= today() ? ' disabled' : '') + '>‹</button>' +
      '<b class="pa-calrange">' + short(days[0]) + ' – ' + short(last) + ' ' + dObj(last).getUTCFullYear() + '</b>' +
      '<button type="button" class="pa-btn small ghost" data-act="shift" data-n="' + WINDOW + '" aria-label="Next ' + WINDOW + ' days">›</button>' +
      (S.from !== startDate() ? '<button type="button" class="pa-btn small ghost" data-act="goStart">' + (startDate() === today() ? 'Today' : 'Start date') + '</button>' : '') + '</div>' +
      '<span class="pa-hint">' + (S.sel ? 'Check-in ' + nice(S.sel.start) + ' on ' + esc(S.sel.unit) + ': now tap the last night.' : 'Tap an open night for check-in, then the last night. Tap a booking to open it.') +
      (S.av.snapshotAt ? ' · Updated ' + new Date(S.av.snapshotAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '</span></div>';
    h += '<div class="pa-legend"><span><i class="lg-open"></i>Open</span><span><i class="lg-hub"></i>Hub booking</span><span><i class="lg-sn"></i>Booked on SN</span><span><i class="lg-airbnb"></i>Airbnb</span><span><i class="lg-bcom"></i>Booking.com</span><span><i class="lg-lekke"></i>LekkeSlaap</span><span><i class="lg-warn"></i>Channel booking not yet on SN</span><span><i class="lg-na"></i>Not on SN</span></div>';
    h += '<div class="pa-grid-wrap"><div class="pa-grid pa-blocks' + (phone ? ' phone' : '') + '" style="grid-template-columns:' + cols + '"><div class="pa-label" style="align-self:end">Unit</div>';
    h += days.map(function (d) { var we = dow(d) === 'Fri' || dow(d) === 'Sat'; return '<div class="hd' + (we ? ' we' : '') + (d === today() ? ' today' : '') + '">' + (phone ? dow(d).slice(0, 2) : dow(d)) + '<b>' + dObj(d).getUTCDate() + '</b>' + (dObj(d).getUTCDate() === 1 || d === days[0] ? MON[dObj(d).getUTCMonth()] : '') + '</div>'; }).join('');
    var perNight = {}, totalOpen = 0, weekend = 0, weekendAll = 0;
    units.forEach(function (u) {
      var open = 0, cells = '', i = 0;
      while (i < days.length) {
        var d = days[i], st = stateOf(u.name, d);
        if (st.s === 'open' && d < fb) st = { s: 'closed' };
        if (inCart(u.name, d) || st.s === 'open') {
          var sel = inCart(u.name, d), isStart = S.sel && S.sel.unit === u.name && S.sel.start === d;
          open++; totalOpen++; perNight[d] = (perNight[d] || 0) + 1; if (dow(d) === 'Fri' || dow(d) === 'Sat') weekend++;
          var lbl = sel ? 'Selected' : isStart ? 'Check-in' : 'Open';
          cells += sel ? '<div class="pa-cell sel" aria-label="' + esc(u.name) + ', ' + nice(d) + ', selected">' + (phone ? '✓' : 'Selected') + '</div>'
            : '<button type="button" class="pa-cell ' + (isStart ? 'start' : 'open') + '" data-act="cell" data-u="' + esc(u.name) + '" data-d="' + d + '" aria-label="' + esc(u.name) + ', ' + nice(d) + ', ' + lbl.toLowerCase() + '">' + (phone ? (isStart ? 'In' : '') : lbl) + '</button>';
          i++; continue;
        }
        // A run of nights with the same booking (or the same state) is one block.
        var key = blockKey(st), j = i + 1;
        while (j < days.length) { var s2 = stateOf(u.name, days[j]); if (s2.s === 'open' && days[j] < fb) s2 = { s: 'closed' }; if (inCart(u.name, days[j]) || s2.s === 'open' || blockKey(s2) !== key) break; j++; }
        var span = j - i, cls = BLOCK[st.s] || 'bk-sn';
        var contL = i === 0 && st.ref && stateOf(u.name, add(d, -1)).ref === st.ref, contR = j === days.length && st.ref && stateOf(u.name, add(days[j - 1], 1)).ref === st.ref;
        var text = st.ref ? (st.name || 'Guest') : st.s === 'sn' ? 'Booked on SN' : st.s === 'pending' ? (CH[st.ch] || 'Channel') + ' guest · not on SN yet' : st.s === 'clash' ? 'Clash · ' + (CH[st.ch] || 'channel') : st.s === 'closed' ? 'Not bookable yet' : 'Not on SN';
        var range = nice(d) + (span > 1 ? ' – ' + nice(days[j - 1]) : '');
        var style = ' style="grid-column:span ' + span + '"';
        var classes = 'pa-block ' + cls + (contL ? ' cont-l' : '') + (contR ? ' cont-r' : '');
        if (st.ref) cells += '<button type="button" class="' + classes + '"' + style + ' data-act="openRef" data-ref="' + esc(st.ref) + '" title="' + esc(text + ' · ' + st.ref) + '" aria-label="' + esc(u.name + ', ' + range + ': ' + text + ', booking ' + st.ref + '. Open the booking') + '"><span>' + esc(text) + '</span></button>';
        else cells += '<div class="' + classes + '"' + style + ' title="' + esc(text) + '" aria-label="' + esc(u.name + ', ' + range + ': ' + text) + '"><span>' + esc((phone && span < 3) || span === 1 ? '' : text) + '</span></div>';
        i = j;
      }
      h += '<div class="unit"><b>' + esc(u.name) + '</b><span>' + open + (phone ? '/' + WINDOW : ' of ' + WINDOW + ' open') + '</span></div>' + cells;
    });
    days.forEach(function (d) { if (dow(d) === 'Fri' || dow(d) === 'Sat') weekendAll += units.length; });
    h += '<div class="pa-label" style="align-self:center;color:#0e2f44">Units open</div>' + days.map(function (d) { var n = perNight[d] || 0; return '<div style="text-align:center;font:700 13px Montserrat,sans-serif;color:' + (n ? '#0e2f44' : '#8a3a00') + '">' + n + '/' + units.length + '</div>'; }).join('');
    h += '</div></div>' + (totalOpen ? '' : '<p class="pa-hint" style="margin-top:10px">Nothing open on Stock Network in these days. Use ›, or search your dates above.</p>') + '</section>';
    // cart
    if (S.cart.length) {
      var tot = S.cart.reduce(function (t, c) { return t + (priceOf(c.unit, c.start, c.end) || 0); }, 0);
      h += '<section class="pa-cart" aria-label="Selected units"><div class="grow"><b style="font:700 14px Montserrat,sans-serif">' + S.cart.length + (S.cart.length === 1 ? ' unit' : ' units') + ' selected · ' + money(tot) + '</b><div>' +
        S.cart.map(function (c, i) { return '<span class="pa-chip">' + esc(c.unit) + ' · ' + short(c.start) + ' – ' + short(c.end) + '<button type="button" data-act="uncart" data-i="' + i + '" aria-label="Remove ' + esc(c.unit) + '">✕</button></span>'; }).join('') +
        '</div><span style="font-size:12px;color:#d6e2e9">Add another unit by tapping its nights in the calendar, or search again.</span></div>' +
        '<button type="button" class="pa-btn ghost" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.5)" data-act="clearCart">Clear</button>' +
        '<button type="button" class="pa-btn teal" data-act="openBook">' + (S.cart.length === 1 ? 'Book this unit' : 'Book ' + S.cart.length + ' units together') + '</button></section>';
    }
    // stats
    h += '<div class="pa-stats"><div class="pa-stat" style="background:#0e2f44;color:#fff"><b>' + totalOpen + ' <small style="font-size:16px;color:#d6e2e9">of ' + units.length * WINDOW + '</small></b><span style="color:#d6e2e9">unit-nights open to sell in these ' + WINDOW + ' days</span></div>' +
      '<div class="pa-stat" style="background:#f4fbfa;border:1.5px solid #e3e9e8"><b style="color:#0e2f44">' + (perNight[days[0]] || 0) + ' <small style="font-size:16px">of ' + units.length + '</small></b><span>units open on ' + nice(days[0]) + '</span></div>' +
      '<div class="pa-stat" style="background:#fff4e5;border:1.5px solid #f5c98a;color:#6b3a00"><b>' + weekend + ' <small style="font-size:16px">of ' + weekendAll + '</small></b><span>Friday and Saturday unit-nights open</span></div></div>';
    // sell these + share
    // The property's own page on the Avante holiday builder search screen,
    // pre-filled with the property and dates (see booking-links.js).
    // ...with the property's location tree path once the tree has loaded
    // (it re-renders when it does); until then, its name.
    var link = function (unit, a, b) {
      var place = (S.treePathFor === S.prop.resortId && S.treePath) || { property: S.prop.resortName };
      return AvanteBooking.build(S.prop.siteId, Object.assign({}, place, { property: S.prop.resortName || place.property, resortId: S.prop.resortId, checkIn: a, checkOut: b }));
    };
    if (S.prop.resortId && S.treeLookedUp !== S.prop.resortId) {
      var rid = S.prop.resortId;
      S.treeLookedUp = rid;
      AvanteBooking.loadTree().then(function (tree) {
        var p = tree.forResort(rid);
        if (p && p.country && S.prop && S.prop.resortId === rid) { S.treePath = p; S.treePathFor = rid; render(); }
      }).catch(function () {});
    }
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
      (function () {
        var cs = st.calendarStart || {}, isDate = cs.mode === 'date';
        return '<fieldset class="pa-fieldset"><legend class="pa-label">Calendar opens on</legend>' +
          '<label class="pa-check pa-radio"><input type="radio" name="pa-cs-mode" value="today"' + (isDate ? '' : ' checked') + '><span><b>Today</b><br><span class="pa-hint">The calendar always opens on today\'s date.</span></span></label>' +
          '<label class="pa-check pa-radio"><input type="radio" name="pa-cs-mode" value="date"' + (isDate ? ' checked' : '') + '><span><b>A set date</b><br><span class="pa-hint">The calendar opens on this date, and it is the first date that can be booked in the hub until it has passed (for example when you open for the season).</span>' +
          '<span style="display:block;margin-top:8px;max-width:220px"><input id="pa-cs-date" type="date" aria-label="Calendar start date" value="' + esc(cs.date || '') + '" min="' + today() + '"></span></span></label></fieldset>';
      })() +
      '<p class="pa-label" style="margin:14px 0 6px">Nightly channel price per unit (calendar links don\'t include prices)</p><div class="pa-form">' +
      S.channels.units.map(function (u) { return '<div class="pa-field"><label class="pa-label" for="pa-pr-' + esc(u.name) + '" style="color:#0e2f44">' + esc(u.name) + '</label><input id="pa-pr-' + esc(u.name) + '" data-price="' + esc(u.name) + '" type="number" min="0" value="' + esc((st.prices || {})[u.name] || '') + '" placeholder="Uses the SN rate if empty"></div>'; }).join('') + '</div>' +
      '<label class="pa-check" style="display:flex;align-items:center;gap:10px;margin-top:14px"><input id="pa-auto" type="checkbox"' + (st.autoBook ? ' checked' : '') + ' style="width:18px;height:18px">Book other channels\' reservations onto Stock Network automatically</label>' +
      '<p class="pa-hint">Leave this off at first: new channel bookings then wait below for you to add them with one click, so you can check everything is right.</p>' +
      '<div class="pa-row" style="margin-top:12px"><button type="button" class="pa-btn" data-act="saveChannels">Save reservation settings</button></div></section>';
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
  function statusPill(b) { var c = b.status === 'Cancelled' ? ['#e7ebeb', '#333'] : ['#dbe6ff', '#0b2f80']; return (b.demo ? '<span class="pa-pill" style="background:#f3e8ff;color:#5b21b6">Demo</span> ' : '') + '<span class="pa-pill" style="background:' + c[0] + ';color:' + c[1] + '">' + esc(b.status) + '</span>'; }
  function whoOf(b) { var c = b.contact || {}; if (b.origin === 'channel') return (c.name ? c.name + ' · ' : '') + (b.source || ''); return c.name || ((b.guest && (b.guest.first + ' ' + b.guest.last).trim()) || ''); }
  function bookingActions(b) {
    var live = b.items.filter(function (i) { return !i.cancelled; });
    if (b.status === 'Cancelled' || !live.length) return '';
    var h = '<button type="button" class="pa-btn small" data-act="editBooking" data-ref="' + esc(b.ref) + '">Open</button>';
    if (b.origin !== 'channel' && !b.locked && !b.demo) {
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
    h += '<p class="pa-hint">Open a booking to add or change the guest\'s details (also on paid and channel bookings) and to send WhatsApp messages and emails. Paid bookings can\'t be changed in the hub, and cancelling them needs the linked affiliate\'s approval. Stock Network bookings made outside the hub show on the Calendar as Booked on SN; manage those in Stock Network.</p></section>';
    if (S.prop.demoAllowed) h += '<section class="pa-card pa-soft" aria-label="Demo bookings"><p class="pa-h2">Demo bookings (Property Testing only)</p><p class="pa-hint">Six example bookings with guest details, plus example welcome and after-stay messages switched on, to show how the hub works. They stay in the hub: they are never sent to Stock Network or to your channel calendars.</p>' +
      '<div class="pa-actions" style="margin-top:10px"><button type="button" class="pa-btn" data-act="seedDemo">Load demo bookings</button><button type="button" class="pa-btn ghost" data-act="clearDemo">Remove demo bookings</button></div></section>';
    return h;
  }

  // ---- Guests (records and return business) ----
  function csvCell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function guestRows() { var q = (S.guestQ || '').toLowerCase(); return (S.guests || []).filter(function (g) { return !q || [g.name, g.cell, g.email, g.carReg, g.channels.join(' ')].join(' ').toLowerCase().indexOf(q) >= 0; }); }
  function viewGuests() {
    var h = propHeader();
    h += '<section class="pa-card"><div class="pa-row" style="justify-content:space-between;align-items:flex-end"><div><p class="pa-h2">Guests</p><p class="pa-hint" style="margin:0">Everyone who stayed or is booked, once each (matched by cellphone or email). Add details from a booking\'s Guest section.</p></div>' +
      '<div class="pa-row" style="gap:8px;flex:1 1 260px;justify-content:flex-end"><div class="pa-field" style="flex:1 1 200px"><label class="pa-label" for="pa-gq">Search</label><input id="pa-gq" type="search" value="' + esc(S.guestQ || '') + '" placeholder="Name, number, email, car"></div><button type="button" class="pa-btn ghost" data-act="guestsCsv">Download (Excel)</button></div></div>';
    if (!S.guests) return h + '<p class="pa-hint">Loading…</p></section>';
    var rows = guestRows();
    if (!rows.length) h += '<p class="pa-hint" style="margin-top:12px">' + (S.guests.length ? 'No guest matches.' : 'No guest details yet. Open a booking and fill in the Guest section.') + '</p>';
    else if (isPhone()) {
      h += '<div class="pa-bk-list">' + rows.map(function (g) {
        return '<article class="pa-bk"><div class="pa-row" style="justify-content:space-between;gap:6px"><b style="color:#0e2f44">' + esc(g.name || 'No name') + '</b><span class="pa-hint">' + g.stays + (g.stays === 1 ? ' stay' : ' stays') + '</span></div>' +
          '<div style="font-size:13px;line-height:1.55;margin-top:4px">' + esc(g.cell || '') + (g.email ? '<br>' + esc(g.email) : '') + (g.carReg ? '<br>Car ' + esc(g.carReg) : '') + '</div>' +
          '<div class="pa-hint">Last stay ' + short(g.lastStay) + ' · ' + esc(g.channels.join(', ')) + (g.optOut ? ' · opted out' : g.offers ? ' · OK for offers' : '') + '</div>' + guestButtons(g) + '</article>';
      }).join('') + '</div>';
    } else {
      h += '<div class="pa-grid-wrap" style="margin-top:10px"><table class="pa-table"><thead><tr><th>Guest</th><th>Contact</th><th>Car</th><th>Stays</th><th>Last stay</th><th>Booked via</th><th>Offers</th><th></th></tr></thead><tbody>' +
        rows.map(function (g) { return '<tr><td><b>' + esc(g.name || 'No name') + '</b></td><td>' + esc(g.cell || '') + (g.email ? '<div class="pa-hint">' + esc(g.email) + '</div>' : '') + '</td><td>' + esc(g.carReg || '') + '</td><td>' + g.stays + ' · ' + nw(g.nights) + '</td><td>' + short(g.lastStay) + '</td><td>' + esc(g.channels.join(', ')) + '</td><td>' + (g.optOut ? 'Opted out' : g.offers ? 'Yes' : '—') + '</td><td>' + guestButtons(g) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    h += '<p class="pa-hint">Offers: only guests marked "OK to send offers" (and not opted out) may receive marketing messages. Airbnb and Booking.com guests may only be sent offers if they agreed with you directly.</p></section>';
    return h;
  }
  function guestButtons(g) {
    var wa = waNum(g.cell);
    return '<div class="pa-actions" style="margin-top:6px">' + (g.cell ? '<a class="pa-btn small ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="tel:' + esc(g.cell.replace(/\s/g, '')) + '">Call</a>' : '') +
      (wa ? '<a class="pa-btn small ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="https://wa.me/' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
      '<button type="button" class="pa-btn small ghost" data-act="openRef" data-ref="' + esc(g.refs[g.refs.length - 1]) + '">Last booking</button></div>';
  }
  function waNum(phone) { var d = String(phone || '').replace(/\D/g, ''); if (d.indexOf('00') === 0) d = d.slice(2); if (d.charAt(0) === '0') d = '27' + d.slice(1); return d.length >= 9 ? d : ''; }

  // ---- Communication (email sent by the hub, WhatsApp one tap) ----
  var PLACEHOLDERS = [['{first_name}', 'first name'], ['{name}', 'full name'], ['{property}', 'property'], ['{unit}', 'unit'], ['{check_in}', 'check-in date'], ['{check_out}', 'check-out date'], ['{nights}', 'nights'], ['{ref}', 'booking ref'], ['{review_link}', 'review link']];
  var ANCHORS = [['before_arrival', 'Days before arrival'], ['arrival', 'On arrival day'], ['during', 'Days into the stay'], ['before_checkout', 'Days before check-out'], ['after_checkout', 'Days after check-out'], ['date', 'On a set date']];
  function msgList() { return (S.messages && S.messages.list) || []; }
  function msgLabel(kind) { if (kind === 'custom') return 'Message'; if (kind === 'in-house') return 'Message to in-house guests'; var m = msgList().find(function (x) { return x.id === kind; }); return m ? m.name : 'Message'; }
  function niceDate(iso) { var d = dObj(iso); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function describeWhen(m) {
    var n = +m.days || 0, d = n + (n === 1 ? ' day' : ' days'), at = ' at ' + (m.time || '10:00');
    return ({ before_arrival: n ? d + ' before arrival' : 'On arrival day', arrival: 'On arrival day', during: n ? d + ' into the stay' : 'On arrival day', before_checkout: n ? d + ' before check-out' : 'On check-out day', after_checkout: n ? d + ' after check-out' : 'On check-out day', date: m.date ? 'On ' + niceDate(m.date) + ' (guests staying that day)' : 'On a set date (choose it)' }[m.anchor] || '') + at;
  }
  function stayOf(b) { var live = b.items.filter(function (i) { return !i.cancelled; }); if (!live.length) return null; return { start: live.map(function (i) { return i.start; }).sort()[0], end: live.map(function (i) { return i.end; }).sort().slice(-1)[0] }; }
  // Same timing as the server (lib/pa-core.js timing()), for the booking screen.
  function msgTiming(m, b) {
    var st = stayOf(b); if (!st) return null;
    var day, lastDay, n = +m.days || 0;
    if (m.anchor === 'before_arrival') { day = add(st.start, -n); lastDay = st.start; }
    else if (m.anchor === 'arrival') { day = st.start; lastDay = st.start; }
    else if (m.anchor === 'during') { day = add(st.start, n); if (day >= st.end) return null; lastDay = st.end; }
    else if (m.anchor === 'before_checkout') { day = add(st.end, -n); if (day < st.start) day = st.start; lastDay = st.end; }
    else if (m.anchor === 'after_checkout') { day = add(st.end, n); lastDay = add(day, 7); }
    else if (m.anchor === 'date') { if (!m.date || m.date < st.start || m.date > st.end) return null; day = m.date; lastDay = m.date; }
    else return null;
    var at = Date.parse(day + 'T' + (m.time || '10:00') + ':00+02:00'), until = Date.parse(lastDay + 'T23:59:00+02:00'), t = Date.now();
    return { at: at, state: t > until ? 'missed' : t >= at ? 'due' : 'scheduled' };
  }
  function when(ms) { var w = new Date(ms); return w.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + w.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function dayOnly(iso) { return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }); }
  // Lines like "WhatsApp: sent 12 Oct" / "Email: goes out 14 Oct 10:00".
  function msgStatus(b, m) {
    if (b.status === 'Cancelled') return ['Booking cancelled'];
    var tm = msgTiming(m, b), rec = (b.msgs || {})[m.id] || {}, c = b.contact || {}, out = [];
    if (!tm) return ['Doesn\'t apply to this stay'];
    if (!m.on) out.push('Switched off (Communication tab)');
    if (m.wa) out.push('WhatsApp: ' + (rec.state === 'sent' ? 'sent ' + dayOnly(rec.at) : rec.state === 'skipped' ? 'skipped' : !m.on ? 'not scheduled' : tm.state === 'due' ? 'ready to send' : tm.state === 'missed' ? 'not sent' : 'goes out ' + when(tm.at)));
    if (m.email) {
      var e = rec.email || {};
      out.push('Email: ' + (e.state === 'sent' ? 'sent ' + dayOnly(e.at) : !m.on ? 'not scheduled' : tm.state === 'missed' ? 'not sent' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || '') ? 'add the guest\'s email address' : e.state === 'failed' ? 'couldn\'t be sent, trying again' : tm.state === 'due' ? 'going out within 15 minutes' : 'goes out ' + when(tm.at)));
    }
    return out;
  }
  function msgItem(i) {
    var lines = [];
    if (i.wa && i.wa !== 'scheduled') lines.push('WhatsApp ' + (i.wa === 'due' ? 'ready' : i.wa));
    if (i.email === 'no-email' || i.email === 'scheduled-no-email') lines.push('<b style="color:#8a3a00">no email address</b>');
    else if (i.email === 'failed') lines.push('<b style="color:#8a3a00">email failed</b>');
    else if (i.email) lines.push('email ' + (i.email === 'due' ? 'going out' : i.email));
    var waBtn = i.wa === 'due' || (i.wa === 'scheduled');
    return '<div class="pa-result"><div class="grow"><b>' + esc(i.label || msgLabel(i.kind)) + ' · ' + esc(i.name || i.ref) + '</b><div class="pa-hint">' + esc(i.units) + ' · arrives ' + short(i.start) + ' · ' + esc(i.ref) + ' · ' + (i.state === 'due' ? 'due since ' : 'goes out ') + when(i.dueAt) + (lines.length ? ' · ' + lines.join(' · ') : '') + (i.wa && !i.hasCell ? ' · <b style="color:#8a3a00">no cellphone yet</b>' : '') + '</div></div>' +
      '<div class="pa-actions">' + (waBtn && i.hasCell ? '<button type="button" class="pa-btn small teal" data-act="compose" data-ref="' + esc(i.ref) + '" data-kind="' + esc(i.kind) + '">' + (i.wa === 'due' ? 'WhatsApp' : 'WhatsApp now') + '</button>' : '') +
      ((i.wa && !i.hasCell) || ((i.email === 'no-email' || i.email === 'scheduled-no-email') && !i.hasEmail) ? '<button type="button" class="pa-btn small" data-act="openRef" data-ref="' + esc(i.ref) + '" data-tab="guest">Add details</button>' : '') +
      (i.wa === 'due' ? '<button type="button" class="pa-btn small ghost" data-act="skipMsg" data-ref="' + esc(i.ref) + '" data-kind="' + esc(i.kind) + '">Skip</button>' : '') + '</div></div>';
  }
  function inHouseRow(g) {
    var wa = waNum(g.cell);
    var tags = [g.arriving ? 'arrives today' : '', g.leaving ? 'leaves today' : '', g.checkedIn ? 'checked in' : ''].filter(Boolean).join(' · ');
    return '<div class="pa-result"><div class="grow"><b>' + esc(g.name) + '</b> <span class="pa-hint">· ' + esc(g.units) + '</span><div class="pa-hint">' + short(g.start) + ' – ' + short(g.end) + ' · ' + esc(g.source) + (tags ? ' · ' + tags : '') + ' · ' + esc(g.ref) + '</div></div><div class="pa-actions">' +
      (wa || g.hasEmail ? '<button type="button" class="pa-btn small teal" data-act="bulk" data-ref="' + esc(g.ref) + '">Message</button>' : '') +
      (g.cell ? '<a class="pa-btn small ghost pa-linkbtn" href="tel:' + esc(String(g.cell).replace(/\s/g, '')) + '">Call</a>' : '') +
      (!wa && !g.hasEmail ? '<button type="button" class="pa-btn small" data-act="openRef" data-ref="' + esc(g.ref) + '" data-tab="guest">Add details</button>' : '<button type="button" class="pa-btn small ghost" data-act="openRef" data-ref="' + esc(g.ref) + '">Open</button>') + '</div></div>';
  }
  // Editing copy of the scheduled messages, so adding or removing one keeps what was typed.
  function msgEditList() { if (!S.msgEdit) S.msgEdit = JSON.parse(JSON.stringify(msgList())); return S.msgEdit; }
  function collectMsgEdit() {
    if (!S.msgEdit) return;
    S.msgEdit.forEach(function (m, i) {
      var g = function (f) { return document.getElementById('pa-m-' + i + '-' + f); };
      if (!g('text')) return;
      m.name = g('name').value; m.on = g('on').checked; m.anchor = g('anchor').value; m.time = g('time').value || '10:00';
      if (g('days')) m.days = g('days').value; if (g('date')) m.date = g('date').value;
      m.wa = g('wa').checked; m.email = g('email').checked; m.subject = g('subject').value; m.text = g('text').value;
      var dt = g('det'); m._open = dt ? dt.open : m._open;
    });
  }
  function msgCard(m, i) {
    var needDays = ['before_arrival', 'during', 'before_checkout', 'after_checkout'].indexOf(m.anchor) >= 0;
    var p = function (f) { return 'pa-m-' + i + '-' + f; };
    return '<details class="pa-card pa-msgcard" id="' + p('det') + '"' + (m._open ? ' open' : '') + '><summary><span class="pa-msgsum"><b>' + esc(m.name || 'Message') + '</b><span class="pa-hint">' + esc(describeWhen(m)) + ' · ' + [m.wa ? 'WhatsApp' : '', m.email ? 'Email' : ''].filter(Boolean).join(' + ') + '</span></span>' +
      '<span class="pa-pill" style="background:' + (m.on ? '#d4f5f2;color:#065e58' : '#eef2f2;color:#333') + '">' + (m.on ? 'On' : 'Off') + '</span></summary>' +
      '<div class="pa-msgbody"><div class="pa-row"><div class="pa-field" style="flex:2 1 220px"><label class="pa-label" for="' + p('name') + '">Name</label><input id="' + p('name') + '" type="text" maxlength="60" value="' + esc(m.name || '') + '"></div>' +
      '<label class="pa-check" style="display:flex;align-items:center;gap:8px;min-height:44px"><input type="checkbox" id="' + p('on') + '"' + (m.on ? ' checked' : '') + '> Switched on</label></div>' +
      '<div class="pa-row" style="margin-top:10px"><div class="pa-field" style="flex:1 1 200px"><label class="pa-label" for="' + p('anchor') + '">When</label><select id="' + p('anchor') + '" data-msgrerender="1">' + ANCHORS.map(function (a) { return '<option value="' + a[0] + '"' + (m.anchor === a[0] ? ' selected' : '') + '>' + a[1] + '</option>'; }).join('') + '</select></div>' +
      (needDays ? '<div class="pa-field" style="flex:0 1 110px"><label class="pa-label" for="' + p('days') + '">Days</label><input id="' + p('days') + '" type="number" min="0" max="365" value="' + esc(m.days || 0) + '"></div>' : '') +
      (m.anchor === 'date' ? '<div class="pa-field" style="flex:0 1 170px"><label class="pa-label" for="' + p('date') + '">Date</label><input id="' + p('date') + '" type="date" value="' + esc(m.date || '') + '" min="' + today() + '"></div>' : '') +
      '<div class="pa-field" style="flex:0 1 130px"><label class="pa-label" for="' + p('time') + '">At (SA time)</label><input id="' + p('time') + '" type="time" value="' + esc(m.time || '10:00') + '"></div></div>' +
      '<fieldset class="pa-fieldset pa-sendby"><legend class="pa-label">Send by</legend><label class="pa-check"><input type="checkbox" id="' + p('email') + '"' + (m.email ? ' checked' : '') + '> Email (the hub sends it automatically)</label><label class="pa-check"><input type="checkbox" id="' + p('wa') + '"' + (m.wa ? ' checked' : '') + '> WhatsApp (you tap Send)</label></fieldset>' +
      '<div class="pa-field" style="margin-top:10px"><label class="pa-label" for="' + p('subject') + '">Email subject</label><input id="' + p('subject') + '" type="text" maxlength="150" value="' + esc(m.subject || '') + '" placeholder="e.g. Your stay at {property}"></div>' +
      '<div class="pa-field" style="margin-top:10px"><label class="pa-label" for="' + p('text') + '">Message</label><textarea id="' + p('text') + '" rows="8">' + esc(m.text || '') + '</textarea></div>' +
      '<div class="pa-actions" style="margin-top:6px">' + PLACEHOLDERS.map(function (x) { return '<button type="button" class="pa-chipbtn" data-act="insertPh" data-target="' + p('text') + '" data-ph="' + x[0] + '" title="Insert ' + x[1] + '">' + x[0] + '</button>'; }).join('') + '</div>' +
      (/\{review_link\}/.test(m.text || '') && S.messages && !S.messages.reviewsConnected ? '<p class="pa-err" style="margin-top:8px">Avante Reviews isn\'t connected yet, so the line with {review_link} is left out. Avante Travel sets this up.</p>' : '') +
      '<div class="pa-actions" style="margin-top:10px;justify-content:flex-end"><button type="button" class="pa-btn small danger" data-act="removeMsg" data-i="' + i + '">Remove this message</button></div></div></details>';
  }
  function viewMessages() {
    var h = '', M = S.messages;
    if (!M) return '<div class="pa-card pa-hint">Loading…</div>';
    var propEmail = M.propertyEmail;
    h += '<div class="pa-note"><b>Email</b> is sent by the hub automatically, from <b>' + esc(S.prop.resortName || 'your property') + '</b>. ' +
      (propEmail ? 'Guests\' replies go to ' + esc(propEmail) + '.' : '<span style="color:#8a3a00">Add your email address in Channels → Reservation settings so guests\' replies reach you.</span>') +
      ' <b>WhatsApp</b> opens on your phone with the message ready; you tap Send.<br><span class="pa-hint">WhatsApp messages can also go out automatically with a paid WhatsApp Business setup. Ask Avante Travel if you\'d like that.</span></div>';
    // in-house
    var ih = M.inHouse || [];
    h += '<section class="pa-card" aria-label="Guests staying now"><div class="pa-row" style="justify-content:space-between;align-items:center"><div><p class="pa-h2" style="margin:0">Staying now</p><p class="pa-hint" style="margin:0">' + (ih.length ? ih.length + (ih.length === 1 ? ' booking' : ' bookings') + ' in house today, including arrivals and departures.' : 'Nobody is staying today.') + '</p></div>' +
      (ih.length ? '<button type="button" class="pa-btn teal" data-act="bulk" data-ref="">Message in-house guests</button>' : '') + '</div>' +
      (ih.length ? '<div class="pa-results">' + ih.map(inHouseRow).join('') + '</div>' : '') + '</section>';
    h += '<section class="pa-card" aria-label="WhatsApp messages to send"><p class="pa-h2">WhatsApp to send</p>' + (M.due.length ? '<div class="pa-results">' + M.due.map(msgItem).join('') + '</div>' : '<p class="pa-hint">Nothing to send right now.</p>') + '</section>';
    if (M.emailIssues && M.emailIssues.length) h += '<section class="pa-card" style="border-color:#f5c98a" aria-label="Emails not sent"><p class="pa-h2">Emails that couldn\'t go out</p><p class="pa-hint">Add the guest\'s email address and the hub sends it on its next round (every 15 minutes).</p><div class="pa-results">' + M.emailIssues.map(msgItem).join('') + '</div></section>';
    if (M.upcoming.length) h += '<section class="pa-card pa-soft" aria-label="Coming up"><p class="pa-h2">Coming up (next 14 days)</p><div class="pa-results">' + M.upcoming.map(msgItem).join('') + '</div></section>';
    // scheduled messages
    var list = msgEditList();
    h += '<div class="pa-row" style="justify-content:space-between;align-items:center;margin:6px 0 10px"><div><p class="pa-h2" style="margin:0">Scheduled messages</p><p class="pa-hint" style="margin:0">As many as you like. Each goes to every booking at its time. Words in {curly brackets} fill themselves in.</p></div>' +
      '<button type="button" class="pa-btn ghost" data-act="addMsg">+ Add a message</button></div>';
    h += list.length ? list.map(msgCard).join('') : '<div class="pa-card pa-hint">No scheduled messages. Add one above.</div>';
    h += '<div class="pa-row" style="margin-bottom:18px"><button type="button" class="pa-btn" data-act="saveMessages">Save messages</button></div>';
    return h;
  }

  // ---- booking popup: Guest / Messages / Booking ----
  function viewGuestSection(b) {
    var c = b.contact || {}, wa = waNum(c.cell);
    var h = '<div class="pa-form">' +
      '<div class="pa-field"><label class="pa-label" for="pa-c-name">Guest name</label><input id="pa-c-name" type="text" autocomplete="off" value="' + esc(c.name || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-c-cell">Cellphone</label><input id="pa-c-cell" type="tel" value="' + esc(c.cell || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-c-email">Email</label><input id="pa-c-email" type="email" value="' + esc(c.email || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-c-guests">Number of guests</label><input id="pa-c-guests" type="number" min="0" max="50" value="' + esc(c.guests || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-c-arrival">Expected arrival</label><input id="pa-c-arrival" type="text" value="' + esc(c.arrival || '') + '" placeholder="e.g. about 15:00"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-c-car">Car registration</label><input id="pa-c-car" type="text" autocapitalize="characters" value="' + esc(c.carReg || '') + '" placeholder="e.g. CA 123-456"></div></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-c-notes">Notes</label><textarea id="pa-c-notes" rows="2">' + esc(c.notes || '') + '</textarea></div>' +
      '<label class="pa-check" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="pa-c-offers"' + (c.offers ? ' checked' : '') + '><span>OK to send offers (the guest agreed to hear about specials)</span></label>' +
      '<label class="pa-check" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="pa-c-optout"' + (c.optOut ? ' checked' : '') + '><span>Opted out (asked not to receive offers)</span></label>' +
      '<div class="pa-checkin">' + (c.checkedInAt ? '<span><b>Checked in</b> ' + esc(new Date(c.checkedInAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</span><button type="button" class="pa-btn small ghost" data-act="checkIn" data-on="0">Undo</button>'
        : '<span>Not checked in yet</span><button type="button" class="pa-btn small teal" data-act="checkIn" data-on="1">Mark checked in</button>') + '</div>' +
      '<div class="pa-actions"><button type="button" class="pa-btn" data-act="saveContact">Save guest details</button>' +
      (c.cell ? '<a class="pa-btn ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="tel:' + esc(String(c.cell).replace(/\s/g, '')) + '">Call</a>' : '') +
      (wa ? '<a class="pa-btn ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="https://wa.me/' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '') + '</div>' +
      '<p class="pa-hint">Kept in the hub for your records' + (b.origin === 'channel' ? '; on Stock Network this booking stays under ' + esc(b.source) : '; Stock Network keeps the details it was booked with') + '.</p>';
    return h;
  }
  function viewMsgSection(b) {
    var c = b.contact || {}, wa = waNum(c.cell), hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || ''), st = stayOf(b), ended = st && st.end <= today();
    var h = '';
    if (!wa || !hasEmail) h += '<div class="pa-lock">' + (!wa && !hasEmail ? 'Add the guest\'s cellphone number and email address in the Guest section to message them.' : !wa ? 'Add the guest\'s cellphone number in the Guest section to send WhatsApp messages.' : 'Add the guest\'s email address in the Guest section so the hub can email them.') + '</div>';
    var list = msgList();
    h += list.length ? list.map(function (m) {
      return '<div class="pa-result"><div class="grow"><b>' + esc(m.name) + '</b><div class="pa-hint">' + esc(describeWhen(m)) + '</div><div class="pa-hint">' + msgStatus(b, m).map(esc).join('<br>') + '</div></div><div class="pa-actions">' +
        (wa ? '<button type="button" class="pa-btn small teal" data-act="compose" data-ref="' + esc(b.ref) + '" data-kind="' + esc(m.id) + '">WhatsApp</button>' : '') +
        (hasEmail ? '<button type="button" class="pa-btn small" data-act="emailNow" data-ref="' + esc(b.ref) + '" data-kind="' + esc(m.id) + '">Email now</button>' : '') + '</div></div>';
    }).join('') : '<p class="pa-hint">No scheduled messages yet. Set them up in the Communication tab.</p>';
    h += '<div class="pa-field"><label class="pa-label" for="pa-custom">Write a message</label><textarea id="pa-custom" rows="3" placeholder="e.g. Hi {first_name}, your braai pack is in the fridge."></textarea></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-custom-subj">Email subject</label><input id="pa-custom-subj" type="text" maxlength="150" placeholder="A message from {property}"></div>' +
      '<div class="pa-actions"><button type="button" class="pa-btn teal" data-act="compose" data-ref="' + esc(b.ref) + '" data-kind="custom"' + (wa ? '' : ' disabled') + '>Send on WhatsApp</button>' +
      '<button type="button" class="pa-btn" data-act="emailNow" data-ref="' + esc(b.ref) + '" data-kind="custom"' + (hasEmail ? '' : ' disabled') + '>Send by email</button></div>';
    if (ended) h += '<div class="pa-result"><div class="grow"><b>Rate this guest</b><div class="pa-hint">Your review of the guest, shared only with Avante partner properties.</div></div><button type="button" class="pa-btn small ghost" data-act="rateGuest" data-ref="' + esc(b.ref) + '">Rate guest</button></div>';
    var log = (b.msgLog || []).slice().reverse();
    if (log.length) h += '<p class="pa-label" style="margin:6px 0 0">Sent</p>' + log.map(function (l) { return '<div class="pa-logline"><b>' + esc(msgLabel(l.kind)) + '</b> · ' + (l.via === 'email' ? 'Email' : 'WhatsApp') + ' · ' + esc(new Date(l.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + (l.subject ? '<div><b>' + esc(l.subject) + '</b></div>' : '') + '<div>' + esc(l.text).replace(/\n/g, '<br>') + '</div></div>'; }).join('');
    return h;
  }

  // Fill {first_name} etc. for one in-house guest in the browser (for WhatsApp one by one).
  function fillLocal(text, g) {
    var first = String(g.name || '').trim().split(/\s+/)[0] || 'there';
    var vals = { first_name: /guest$/i.test(g.name || '') ? 'there' : first, name: g.name || '', property: (S.prop && S.prop.resortName) || '', unit: g.units || '', check_in: g.start ? niceDate(g.start) : '', check_out: g.end ? niceDate(g.end) : '', nights: g.start && g.end ? String(nightsBetween(g.start, g.end)) : '', ref: g.ref || '' };
    return String(text || '').replace(/\{(\w+)\}/g, function (m, k) { return k in vals ? vals[k] : m; }).trim();
  }

  // ---- Reviews ----
  function viewReviews() {
    return propHeader() + '<div class="pa-stats"><div class="pa-stat" style="background:#0e2f44;color:#fff"><span style="font:700 12px Montserrat,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#9fe9e3">Avante guest rating</span><span style="color:#d6e2e9;line-height:1.5">Shows on your listing once you have 3 Avante guest reviews. Until then guests see your Google reviews.</span></div>' +
      '<div class="pa-stat" style="background:#f4fbfa;border:1.5px solid #e3e9e8"><span class="pa-label">What Google says</span><span style="line-height:1.5">Your Google rating and reviews show on your listing through Avante Reviews once your Google Place ID is set.</span></div>' +
      '<div class="pa-stat" style="background:#f4fbfa;border:1.5px solid #e3e9e8"><span class="pa-label">Ask guests for a review</span><span style="line-height:1.5">Switch on the after-stay message in <b>Communication</b>. It includes the guest\'s personal Avante review link.</span><button type="button" class="pa-btn small" style="align-self:flex-start" data-act="view" data-v="msgs">Open Communication</button></div></div>' +
      '<div class="pa-card pa-soft"><p class="pa-h2">Rate your guests</p><p class="pa-hint">After check-out, open the booking, go to Messages and tap <b>Rate guest</b>. Guest ratings are shared only with Avante partner properties.</p></div>';
  }

  // ---- Payment block (after booking, or "Payment link") ----
  function payBlock(pay) {
    if (!pay) return '';
    S.payMsg = pay.message;
    var h = '<div class="pa-pay"><p class="pa-label" style="margin:0">Payment</p>';
    if (pay.noMethod) return h + '<p class="pa-err">No payment method is set up. Add your bank details or allow the payment gateway in Channels → Guest payments.</p></div>';
    if (pay.gatewayUrl) h += '<div class="pa-actions"><button type="button" class="pa-btn teal" data-act="openPay" data-ref="' + esc(pay.ref || '') + '" data-url="' + esc(pay.gatewayUrl) + '">Pay now</button><button type="button" class="pa-btn small ghost" data-act="copy" data-text="' + esc(pay.gatewayUrl) + '">Copy payment link</button></div>';
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
    if (m.type === 'bulk') {
      // The property picks which in-house guests get the message (nobody is ticked to start with),
      // and can start from one of its own templates.
      var all = (S.messages && S.messages.inHouse) || [], sel = m.sel || {};
      var gs = all.filter(function (g) { return sel[g.ref]; });
      var withEmail = gs.filter(function (g) { return g.hasEmail; }), withWa = gs.filter(function (g) { return waNum(g.cell); });
      h += hdr('Message in-house guests', all.length + (all.length === 1 ? ' booking' : ' bookings') + ' staying now') + '<div class="body">';
      if (m.result) h += '<div class="pa-ok" role="status">' + esc(m.result) + '</div>';
      h += '<fieldset class="pa-fieldset"><legend class="pa-label">Send to</legend>' +
        '<div class="pa-actions"><button type="button" class="pa-btn small ghost" data-act="bulkSel" data-v="all">Select all</button><button type="button" class="pa-btn small ghost" data-act="bulkSel" data-v="none">Clear</button><span class="pa-hint">' + gs.length + ' of ' + all.length + ' selected</span></div>' +
        all.map(function (g) {
          var how = [waNum(g.cell) ? 'WhatsApp' : '', g.hasEmail ? 'email' : ''].filter(Boolean).join(' + ') || 'no contact details';
          return '<label class="pa-check pa-radio"><input type="checkbox" data-bulkref="' + esc(g.ref) + '"' + (sel[g.ref] ? ' checked' : '') + '><span><b>' + esc(g.name) + '</b> <span class="pa-hint">· ' + esc(g.units) + ' · ' + short(g.start) + ' – ' + short(g.end) + (g.arriving ? ' · arrives today' : g.leaving ? ' · leaves today' : '') + ' · ' + how + '</span></span></label>';
        }).join('') + '</fieldset>';
      var tpls = msgList();
      if (tpls.length) h += '<div class="pa-field"><label class="pa-label" for="pa-bulk-tpl">Start from a template</label><select id="pa-bulk-tpl" data-bulktpl="1"><option value="">Write my own</option>' + tpls.map(function (x) { return '<option value="' + esc(x.id) + '"' + (m.tpl === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>';
      h += '<div class="pa-field"><label class="pa-label" for="pa-bulk-subj">Email subject</label><input id="pa-bulk-subj" type="text" maxlength="150" value="' + esc(m.subject || '') + '" placeholder="A message from {property}"></div>' +
        '<div class="pa-field"><label class="pa-label" for="pa-bulk-text">Message</label><textarea id="pa-bulk-text" rows="7" placeholder="e.g. Hi {first_name}, the water will be off from 14:00 to 15:00 today. Sorry for the trouble!">' + esc(m.text || '') + '</textarea></div>' +
        '<div class="pa-actions">' + PLACEHOLDERS.filter(function (x) { return x[0] !== '{review_link}'; }).map(function (x) { return '<button type="button" class="pa-chipbtn" data-act="insertPh" data-target="pa-bulk-text" data-ph="' + x[0] + '" title="Insert ' + x[1] + '">' + x[0] + '</button>'; }).join('') + '</div>';
      if (!gs.length) h += '<p class="pa-hint" style="margin:0">Tick the guests above to send to them.</p>';
      else {
        h += '<div class="pa-pay"><p class="pa-label" style="margin:0">Email</p><p class="pa-hint" style="margin:0">' + (withEmail.length ? 'Each guest gets their own copy with their name filled in: ' + withEmail.length + ' of ' + gs.length + ' selected have an email address.' : 'None of the selected guests has an email address yet.') + '</p>' +
          (withEmail.length ? '<div class="pa-actions"><button type="button" class="pa-btn" data-act="bulkEmail"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Sending…' : 'Email ' + withEmail.length + (withEmail.length === 1 ? ' guest' : ' guests')) + '</button></div>' : '') + '</div>';
        h += '<div class="pa-pay"><p class="pa-label" style="margin:0">WhatsApp, one by one</p><p class="pa-hint" style="margin:0">Each button opens WhatsApp with the message ready for that guest; press Send there, then come back for the next.</p>' +
          (withWa.length ? withWa.map(function (g) { var done = (m.waDone || {})[g.ref]; return '<div class="pa-row" style="align-items:center;justify-content:space-between;gap:8px"><span><b>' + esc(g.name) + '</b> <span class="pa-hint">· ' + esc(g.units) + '</span></span><button type="button" class="pa-btn small ' + (done ? 'ghost' : 'teal') + '" data-act="bulkWa" data-ref="' + esc(g.ref) + '">' + (done ? 'Sent ✓ · again' : 'WhatsApp') + '</button></div>'; }).join('') : '<p class="pa-hint" style="margin:0">None of the selected guests has a cellphone number yet.</p>') + '</div>';
      }
      return h + '<div class="pa-row"><button type="button" class="pa-btn ghost" data-act="close">Done</button></div></div></div></div>';
    }
    if (m.type === 'compose') {
      return h + hdr('WhatsApp to ' + (m.name || 'the guest'), msgLabel(m.kind) + ' · ' + m.ref) + '<div class="body">' +
        (m.sent ? '<div class="pa-ok">Opened in WhatsApp and marked as sent. Press Send in WhatsApp if you haven\'t yet.</div>' : '<p class="pa-hint" style="margin:0">Check the message, change it if you like, then open WhatsApp. It opens on this phone or computer with the message ready for ' + esc(m.name || 'the guest') + '.</p>') +
        '<div class="pa-field"><label class="pa-label" for="pa-compose">Message</label><textarea id="pa-compose" rows="12">' + esc(m.text) + '</textarea></div>' +
        '<div class="pa-actions"><button type="button" class="pa-btn teal" data-act="sendCompose">' + (m.sent ? 'Open WhatsApp again' : 'Open WhatsApp') + '</button><button type="button" class="pa-btn ghost" data-act="composeBack">' + (m.sent ? 'Done' : 'Back') + '</button></div></div></div></div>';
    }
    if (m.type === 'paying') {
      var st = m.state;
      return h + hdr('Payment for ' + m.ref, 'Secure payment page on Stock Network') + '<div class="body">' +
        (m.blocked ? '<p style="margin:0;font-size:14px;line-height:1.55">Your browser blocked the payment window. Open it here:</p>' :
          '<p style="margin:0;font-size:14px;line-height:1.55">The payment page is open in its own window. Complete the payment there, including any bank or Instant EFT steps. When that window closes, the hub checks the payment.</p>') +
        (st === 'checking' ? '<p class="pa-hint">Checking the payment on Stock Network…</p>' : '') +
        (st === 'unpaid' ? '<div class="pa-lock">Stock Network doesn\'t show this booking as paid yet. If the payment has just gone through, wait a minute and check again.</div>' : '') +
        '<div class="pa-actions"><a class="pa-btn teal" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(m.url) + '" target="avante-pay" rel="noopener" data-act="reopenPay">' + (m.blocked ? 'Open payment page' : 'Open payment page again') + '</a>' +
        '<button type="button" class="pa-btn" data-act="checkPay"' + (st === 'checking' ? ' disabled' : '') + '>Check payment now</button>' +
        '<button type="button" class="pa-btn ghost" data-act="close">Close</button></div></div></div></div>';
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
    var editing = m.type === 'edit', b = S.edit, live = editing ? b.items.filter(function (i) { return !i.cancelled; }) : null, segHtml = '';
    if (editing) {
      var tab = S.bTab || 'guest';
      segHtml = '<div class="pa-seg pa-tabs" role="tablist" aria-label="Booking sections">' + [['guest', 'Guest'], ['msgs', 'Messages'], ['stay', 'Booking']].map(function (x) { return '<button type="button" role="tab" data-act="bTab" data-t="' + x[0] + '" aria-pressed="' + (tab === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
        (S.modalNote ? '<div class="pa-ok" role="status">' + esc(S.modalNote) + '</div>' : '');
      var sub = whoOf(b) + ' · ' + live.map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ');
      if (tab !== 'stay' || b.demo || b.status === 'Cancelled') {
        var bodyHtml = tab === 'guest' ? viewGuestSection(b) : tab === 'msgs' ? viewMsgSection(b)
          : '<div class="pa-items">' + live.map(function (it) { return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + '</b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span></div>'; }).join('') + '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + esc(b.status) + '</span><b>' + money(b.total) + '</b></div></div>' +
            '<p class="pa-hint">' + (b.demo ? 'Demo booking: it isn\'t on Stock Network, so it can\'t be changed, paid or cancelled. Remove demo bookings from the Bookings tab.' : 'This booking was cancelled.') + '</p>';
        // Cancel is on every section of the booking (paid bookings: request cancellation).
        var cancelBtn = !b.demo && b.status !== 'Cancelled' ? '<button type="button" class="pa-btn danger" data-act="cancelBooking"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Working…' : b.locked ? 'Request cancellation' : 'Cancel this booking') + '</button>' : '';
        return h + hdr('Booking ' + b.ref, sub) + '<div class="body">' + segHtml + bodyHtml + '<div class="pa-row pa-dlgfoot">' + cancelBtn + '<button type="button" class="pa-btn ghost" data-act="close">Close</button></div></div></div></div>';
      }
    }
    if (editing && b.locked) {
      h += hdr('Booking ' + b.ref + ' · ' + (PAY_PILL[b.payState] || PAY_PILL.paid)[2]);
      h += '<div class="body">' + segHtml + '<div class="pa-items">' + live.map(function (it) { return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + '</b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span></div>'; }).join('') +
        '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + esc(whoOf(b)) + '</span><b>' + money(b.total) + '</b></div></div>' +
        '<div class="pa-lock"><b>Paid: locked</b><br>This booking can\'t be changed in the hub. The guest must contact the property, and changes are made in Stock Network. To cancel it, request cancellation: the affiliate linked to this property approves it with their hub password.</div>' +
        (b.cancelRequest ? '<p class="pa-hint">Cancellation already requested ' + esc(new Date(b.cancelRequest.at).toLocaleString()) + '. Requesting again sends a new link.</p>' : '') +
        '<div class="pa-row"><button type="button" class="pa-btn danger" data-act="cancelBooking"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Sending…' : 'Request cancellation') + '</button><button type="button" class="pa-btn ghost" data-act="close">Close</button></div></div></div></div>';
      return h;
    }
    var items = editing ? live : S.cart, total = 0, short2 = false, g = editing ? (b.guest || {}) : {};
    h += hdr(editing ? 'Edit booking ' + b.ref : (S.cart.length > 1 ? 'New booking · ' + S.cart.length + ' units' : 'New booking on Stock Network'));
    h += '<div class="body">' + segHtml + '<div class="pa-items">' + items.map(function (it, i) {
      var p = priceOf(it.unit, it.start, it.end); total += p || 0; if (nightsBetween(it.start, it.end) < (S.av ? S.av.minStay : 2)) short2 = true;
      var rm = editing ? (live.length > 1 ? '<button type="button" class="pa-btn small danger" data-act="removeUnit" data-u="' + esc(it.unit) + '">Remove unit</button>' : '') : (S.cart.length > 1 ? '<button type="button" class="pa-btn small danger" data-act="uncart" data-i="' + i + '">Remove</button>' : '');
      return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + ' <span class="pa-hint">· ' + esc(sizeOf(it.unit)) + '</span></b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span><b>' + money(editing ? null : p) + '</b>' + rm + '</div>';
    }).join('') + (editing ? '' : '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + (items.length === 1 ? '1 unit' : items.length + ' units, one reservation') + '</span><b style="font:800 16px Montserrat,sans-serif;color:#0e2f44">Total ' + money(total) + '</b></div>') + '</div>';
    if (editing && live.length === 1) {
      h += '<div class="pa-form"><div class="pa-field"><label class="pa-label" for="pa-eu">Unit</label><select id="pa-eu">' + S.av.units.map(function (u) { return '<option' + (u.name === live[0].unit ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="pa-field"><label class="pa-label" for="pa-ei">Check-in</label><input id="pa-ei" type="date" value="' + live[0].start + '"></div><div class="pa-field"><label class="pa-label" for="pa-eo">Check-out</label><input id="pa-eo" type="date" value="' + live[0].end + '"></div></div>';
    }
    if (short2) h += '<p class="pa-err">Shorter than the ' + S.av.minStay + '-night minimum stay.</p>';
    if (!editing) {
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
    if (v === 'cal') v = 'avail';
    S.view = v; S.more = false; S.err = null; S.msg = null; render();
    if (!S.prop) return;
    if (v === 'avail') loadAvailability(S.from);
    if (v === 'chan') Promise.all([api('channels'), api('channelEvents')]).then(function (r) { S.channels = r[0]; S.events = r[1].events; render(); }).catch(fail);
    if (v === 'book') api('find', { q: S.findQ }).then(function (d) { S.bookings = d.bookings; S.payMode = d.payMode; render(); }).catch(fail);
    if (v === 'guests') api('guests').then(function (d) { S.guests = d.guests; render(); }).catch(fail);
    if (v === 'msgs') loadMessages();
  }
  function openBooking(bk, tab) { S.edit = bk; S.bTab = tab || 'guest'; S.modalNote = null; S.modal = { type: 'edit' }; if (!S.av) loadAvailability(S.from); if (!S.messages) loadMessages(); render(); }
  function updateBooking(bk) {
    if (S.edit && S.edit.ref === bk.ref) S.edit = bk;
    [S.bookings, S.found].forEach(function (list) { if (!list) return; for (var i = 0; i < list.length; i++) if (list[i].ref === bk.ref) list[i] = bk; });
    S.guests = null;
  }
  function alertInModal(msg) { S.modalNote = null; S.err = msg; S.modal = S.modal; render(); var e = root.querySelector('.pa-err'); if (e) e.scrollIntoView({ block: 'nearest' }); }
  function loadMessages() { return api('messages').then(function (d) { if (S.view === 'msgs') collectMsgEdit(); S.messages = d; S.msgsDue = d.due.length; if (!S.msgDirty) S.msgEdit = null; render(); }).catch(function () {}); }
  // Pay now opens Stock Network's payment page in its own window: bank and
  // Instant EFT pages refuse to run inside another site's page.
  var payTimer = null;
  function watchPay(win) {
    clearInterval(payTimer);
    if (!win) return;
    payTimer = setInterval(function () { if (win.closed) { clearInterval(payTimer); checkPay(); } }, 1000);
  }
  function checkPay() {
    var m = S.modal; if (!m || m.type !== 'paying' || !m.ref) return;
    m.state = 'checking'; render();
    api('payInfo', { ref: m.ref }).then(function (d) {
      if (!S.modal || S.modal.type !== 'paying') return;
      S.bookings = null; staleAll();
      if (d.booking.locked) { clearInterval(payTimer); S.modal = { done: { title: d.booking.ref + ' is paid', text: 'Stock Network shows ' + money(d.booking.amountPaid || d.booking.total) + ' paid. The booking is now locked: changes go through the property.' } }; render(); if (S.view === 'book') setView('book'); return; }
      S.modal.state = 'unpaid'; render();
    }).catch(function (e) { if (S.modal && S.modal.type === 'paying') { S.modal.state = null; S.err = e.message; render(); } });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.modal && S.modal.type === 'paying' && S.modal.state !== 'checking') checkPay(); });
  function afterChange(done) {
    S.busy = false; S.modal = { done: done }; S.cart = []; S.sel = null; S.results = null; S.bookings = null;
    staleAll(); loadAvailability(S.from);
  }
  var findTimer = null;

  var lastFocusedText = null;
  root.addEventListener('focusin', function (e) { if (e.target.tagName === 'TEXTAREA') lastFocusedText = e.target; });
  root.addEventListener('input', function (e) {
    if (/^pa-m-\d+-/.test(e.target.id || '')) S.msgDirty = true;
    if (e.target.id === 'pa-gq') { S.guestQ = e.target.value; render(); var gq = document.getElementById('pa-gq'); if (gq) { gq.focus(); gq.setSelectionRange(gq.value.length, gq.value.length); } return; }
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

  // The More menu closes when you tap anywhere else.
  document.addEventListener('click', function (e) { if (S.more && !e.target.closest('.pa-more')) { S.more = false; render(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.more) { S.more = false; render(); var b = root.querySelector('[data-act="more"]'); if (b) b.focus(); } });
  // Changing when a scheduled message goes out shows the matching fields (days or date).
  root.addEventListener('change', function (e) {
    if (e.target.dataset && e.target.dataset.bulkref && S.modal && S.modal.type === 'bulk') {
      var bm = S.modal; bm.text = val('pa-bulk-text'); bm.subject = val('pa-bulk-subj'); bm.sel = bm.sel || {}; bm.sel[e.target.dataset.bulkref] = e.target.checked;
      var rf = e.target.dataset.bulkref; render(); var cb = root.querySelector('[data-bulkref="' + rf + '"]'); if (cb) cb.focus(); return;
    }
    if (e.target.dataset && e.target.dataset.bulktpl && S.modal && S.modal.type === 'bulk') {
      var bt = S.modal, tp = msgList().find(function (x) { return x.id === e.target.value; });
      bt.tpl = e.target.value;
      if (tp) { bt.text = tp.text.replace(/[^\n]*\{review_link\}[^\n]*\n?/g, ''); bt.subject = tp.subject || ''; } else { bt.text = val('pa-bulk-text'); bt.subject = val('pa-bulk-subj'); }
      render(); var ts = document.getElementById('pa-bulk-tpl'); if (ts) ts.focus(); return;
    } if (e.target.dataset && e.target.dataset.msgrerender) { S.msgDirty = true; var id = e.target.id; render(); var el = document.getElementById(id); if (el) el.focus(); } else if (/^pa-m-\d+-/.test(e.target.id || '')) S.msgDirty = true; });
  root.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'pa-rp') { var b = root.querySelector('[data-act="resume"]'); if (b) b.click(); } });
  root.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]'); if (!t) return;
    var a = t.dataset.act;
    if (a === 'backdrop' && e.target !== t) return;
    if (a === 'view') return setView(t.dataset.v);
    if (a === 'more') { S.more = !S.more; return render(); }
    if (S.more && a !== 'more' && a !== 'hookbuilder') S.more = false;
    if (a === 'goStart') { S.searched = null; return loadAvailability(startDate()); }
    // Hook Builder (2026-10-08): opens the hook builder signed in with this hub login (hub.html's openHookBuilder).
    if (a === 'hookbuilder') { if (typeof window.openHookBuilder === 'function') window.openHookBuilder(t); return; }
    if (a === 'dismiss') { S.err = null; return render(); }
    if (a === 'connect') return doConnect();
    if (a === 'resume') {
      var pw = val('pa-rp'); if (!pw) { var rp = document.getElementById('pa-rp'); if (rp) rp.focus(); return; }
      S.err = null; busy(true); render();
      return api('resume', { aff: aff, password: pw }).then(function (d) { S.busy = false; S.resume = null; setToken(d.token); S.prop = d.property; S.view = 'avail'; render(); loadAvailability(); }).catch(fail);
    }
    if (a === 'pickResort') return doConnect(t.dataset.id);
    if (a === 'disconnect') { if (!confirm('Disconnect this property from the hub? Channel sync stops until you connect again.')) return; return api('disconnect').then(function () { setToken(null); S.prop = null; S.av = null; render(); }).catch(fail); }
    if ((a === 'close' || a === 'backdrop') && S.modal && S.modal.type === 'paying') { clearInterval(payTimer); S.bookings = null; S.modal = null; render(); if (S.view === 'book') setView('book'); return; }
    if (a === 'close' || a === 'backdrop') { S.modal = null; S.edit = null; return render(); }
    if (a === 'openPay') {
      var pw = window.open(t.dataset.url, 'avante-pay', 'popup,width=560,height=800');
      S.modal = { type: 'paying', ref: t.dataset.ref, url: t.dataset.url, blocked: !pw };
      watchPay(pw); return render();
    }
    if (a === 'reopenPay') { var pw2 = window.open(t.getAttribute('href'), 'avante-pay', 'popup,width=560,height=800'); if (pw2) { e.preventDefault(); S.modal.blocked = false; S.modal.state = null; watchPay(pw2); render(); } return; }
    if (a === 'checkPay') return checkPay();
    if (a === 'copyPayMsg') { var pm = S.payMsg || ''; (navigator.clipboard ? navigator.clipboard.writeText(pm) : Promise.reject()).then(function () { t.textContent = 'Copied'; }, function () { prompt('Copy this:', pm); }); return; }
    if (a === 'payLink') {
      t.textContent = 'Loading…';
      return api('payInfo', { ref: t.dataset.ref }).then(function (d) {
        if (d.booking.locked) { S.modal = { done: { title: d.booking.ref + ' is paid', text: 'Stock Network shows this booking as paid, so no payment link is needed.' } }; S.bookings = null; setView(S.view); return; }
        S.modal = { done: { title: 'Payment for ' + d.booking.ref, text: d.booking.items.filter(function (i) { return !i.cancelled; }).map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ') + ' · ' + money(d.booking.total), pay: Object.assign({ ref: d.booking.ref }, d.pay) } }; render();
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
      if (d < firstBookable()) return;
      if (!S.sel || S.sel.unit !== u || d <= S.sel.start) { S.sel = { unit: u, start: d }; return render(); }
      if (!rangeOpen(u, S.sel.start, add(d, 1))) { S.sel = { unit: u, start: d }; return render(); }
      S.cart.push({ unit: u, start: S.sel.start, end: add(d, 1) }); S.sel = null; return render();
    }
    if (a === 'uncart') { S.cart.splice(+t.dataset.i, 1); if (!S.cart.length && S.modal && S.modal.type === 'book') S.modal = null; return render(); }
    if (a === 'clearCart') { S.cart = []; S.sel = null; return render(); }
    if (a === 'openBook') { S.modal = { type: 'book' }; return render(); }
    if (a === 'filter') { S.unitFilter = t.dataset.u; return render(); }
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
        .then(function (d) { var b = d.booking; afterChange({ title: 'Booking ' + b.ref + ' created', text: b.items.map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ') + ' · ' + money(b.total) + '. Status ' + b.status + ' on Stock Network. Your other channels are blocked within 15 minutes.', pay: d.pay && Object.assign({ ref: b.ref }, d.pay) }); })
        .catch(function (err) { S.busy = false; S.err = err.message; S.modal = null; render(); });
    }
    if (a === 'openFind') { S.modal = { type: 'find' }; return api('find', { q: S.findQ }).then(function (d) { S.found = d.bookings; render(); }).catch(fail); }
    if (a === 'editBooking') {
      var list = (S.found || []).concat(S.bookings || []); var bk = list.find(function (x) { return x.ref === t.dataset.ref; });
      if (!bk) return; return openBooking(bk, 'guest');
    }
    if (a === 'saveEdit') {
      var editBody = { ref: S.edit.ref, change: { unit: val('pa-eu'), start: val('pa-ei'), end: val('pa-eo') } };
      busy(true); render();
      return api('edit', editBody)
        .then(function (d) { afterChange(d.booking && d.replaced ? { title: 'Booking ' + d.booking.ref + ' created', text: d.replaced + ' was cancelled on Stock Network and replaced by ' + d.booking.ref + ' · ' + money(d.booking.total) + '. Send the guest the new payment link.', pay: d.pay && Object.assign({ ref: d.booking.ref }, d.pay) } : { title: 'Details updated', text: 'The unit and dates are unchanged, so ' + S.edit.ref + ' stays as it is on Stock Network.' }); })
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
      var csMode = root.querySelector('input[name="pa-cs-mode"]:checked');
      return api('saveSettings', { calendarStart: { mode: csMode ? csMode.value : 'today', date: val('pa-cs-date') }, email: val('pa-se'), phone: val('pa-sp'), minStay: val('pa-sm'), autoBook: document.getElementById('pa-auto').checked, prices: prices, channels: channels,
        payMode: pmEl ? pmEl.value : 'both', bank: { bankName: val('pa-bn'), accountHolder: val('pa-bh'), accountNumber: val('pa-ba'), branchCode: val('pa-bb'), accountType: val('pa-bt'), note: val('pa-bx') } })
        .then(function (d) { S.channels = d; S.prop.settings = d.settings; if (d.firstBookable) S.prop.firstBookable = d.firstBookable; S.from = startDate(); S.searched = null; S.msg = 'Saved. The hub reads your channel links every 15 minutes.'; render(); window.scrollTo(0, 0); }).catch(function (e) { fail(e); window.scrollTo(0, 0); });
    }
    if (a === 'unitMove' || a === 'unitNew') {
      var from = a === 'unitMove' ? val('pa-mv-' + t.dataset.u) : '';
      if (from && !confirm('Move the channel links, prices and hub bookings of ' + from + ' to ' + t.dataset.u + '? ' + from + ' will no longer show in the hub.')) return;
      return api('unitNotice', { name: t.dataset.u, from: from }).then(function (d) { S.channels = d; S.msg = from ? 'Moved ' + from + ' to ' + t.dataset.u + '.' : t.dataset.u + ' added as a new unit.'; staleAll(); render(); }).catch(fail);
    }
    if (a === 'openRef') {
      var tabWanted = t.dataset.tab || 'guest', refW = t.dataset.ref;
      var have = (S.bookings || []).concat(S.found || []).find(function (x) { return x.ref === refW; });
      if (have) return openBooking(have, tabWanted);
      return api('find', { q: refW }).then(function (d) { var bk2 = d.bookings.find(function (x) { return x.ref === refW; }); if (bk2) openBooking(bk2, tabWanted); else { S.err = 'Booking ' + refW + ' was not found in the hub.'; render(); } }).catch(fail);
    }
    if (a === 'bTab') { S.bTab = t.dataset.t; S.modalNote = null; return render(); }
    if (a === 'saveContact') {
      var cb = { name: val('pa-c-name'), cell: val('pa-c-cell'), email: val('pa-c-email'), guests: val('pa-c-guests'), arrival: val('pa-c-arrival'), carReg: val('pa-c-car'), notes: val('pa-c-notes'),
        offers: document.getElementById('pa-c-offers').checked, optOut: document.getElementById('pa-c-optout').checked };
      t.textContent = 'Saving…';
      return api('saveContact', { ref: S.edit.ref, contact: cb }).then(function (d) { updateBooking(d.booking); S.modalNote = 'Guest details saved.'; render(); }).catch(function (e) { S.modalNote = null; t.textContent = 'Save guest details'; alertInModal(e.message); });
    }
    if (a === 'checkIn') {
      return api('checkIn', { ref: S.edit.ref, on: t.dataset.on === '1' }).then(function (d) { updateBooking(d.booking); S.modalNote = t.dataset.on === '1' ? 'Checked in.' : 'Check-in undone.'; render(); }).catch(fail);
    }
    if (a === 'compose') {
      var kind = t.dataset.kind, refC = t.dataset.ref, custom = kind === 'custom' ? val('pa-custom') : '';
      if (kind === 'custom' && !custom.trim()) { var ta = document.getElementById('pa-custom'); if (ta) ta.focus(); return; }
      t.textContent = 'Preparing…';
      var back = S.modal;
      return api('prepareMessage', { ref: refC, kind: kind, text: custom }).then(function (d) {
        var bk3 = (S.bookings || []).concat(S.found || [], S.edit ? [S.edit] : []).find(function (x) { return x.ref === refC; }) || {};
        S.modal = { type: 'compose', ref: refC, kind: kind, text: d.text, wa: (/wa\.me\/(\d+)/.exec(d.whatsappUrl) || [])[1], name: (bk3.contact && bk3.contact.name) || '', back: back };
        render();
      }).catch(function (e) { t.textContent = 'Send'; if (back && back.type === 'edit') alertInModal(e.message); else fail(e); });
    }
    if (a === 'sendCompose') {
      var cm = S.modal, txt = val('pa-compose');
      window.open('https://wa.me/' + cm.wa + '?text=' + encodeURIComponent(txt), '_blank', 'noopener');
      cm.text = txt;
      if (cm.sent) return;
      return api('markMessage', { ref: cm.ref, kind: cm.kind, state: 'sent', text: txt }).then(function (d) { updateBooking(d.booking); cm.sent = true; render(); loadMessages(); }).catch(fail);
    }
    if (a === 'composeBack') { var bm = S.modal.back; S.modal = bm && bm.type === 'edit' ? bm : null; if (S.modal) { S.bTab = 'msgs'; S.modalNote = null; } if (S.view === 'msgs') loadMessages(); return render(); }
    if (a === 'skipMsg') {
      if (!confirm('Skip the WhatsApp "' + msgLabel(t.dataset.kind) + '" message for ' + t.dataset.ref + '? It won\'t come up again.')) return;
      return api('markMessage', { ref: t.dataset.ref, kind: t.dataset.kind, state: 'skipped' }).then(function () { loadMessages(); }).catch(fail);
    }
    if (a === 'rateGuest') {
      var rw = window.open('', '_blank');
      return api('propertyReviewLink', { ref: t.dataset.ref }).then(function (d) { if (d.link && rw) rw.location = d.link; else { if (rw) rw.close(); alertInModal(d.reviewed ? 'You have already rated this guest.' : 'The rating link isn\'t available.'); } }).catch(function (e) { if (rw) rw.close(); alertInModal(e.message); });
    }
    if (a === 'insertPh') {
      var tgt = document.getElementById(t.dataset.target); if (!tgt) return;
      // Insert where the cursor was last in this message, or at the end if it hasn't been clicked yet.
      var st0 = tgt === lastFocusedText ? tgt.selectionStart : tgt.value.length, en0 = tgt === lastFocusedText ? tgt.selectionEnd : st0;
      tgt.value = tgt.value.slice(0, st0) + t.dataset.ph + tgt.value.slice(en0); tgt.focus(); tgt.selectionStart = tgt.selectionEnd = st0 + t.dataset.ph.length; return;
    }
    if (a === 'addMsg') {
      collectMsgEdit();
      msgEditList().push({ id: '', name: 'New message', on: false, anchor: 'before_arrival', days: 1, date: '', time: '10:00', wa: true, email: true, subject: 'A message from {property}', text: '', _open: true });
      S.msgDirty = true; render();
      var nm = document.getElementById('pa-m-' + (S.msgEdit.length - 1) + '-name'); if (nm) { nm.focus(); nm.select(); }
      return;
    }
    if (a === 'removeMsg') {
      collectMsgEdit();
      var rmM = S.msgEdit[+t.dataset.i]; if (!rmM) return;
      if (!confirm('Remove the "' + (rmM.name || 'Message') + '" message? It stops going to guests once you save.')) return;
      S.msgEdit.splice(+t.dataset.i, 1); S.msgDirty = true; return render();
    }
    if (a === 'saveMessages') {
      collectMsgEdit();
      var sendList = msgEditList().map(function (m) { var o = Object.assign({}, m); delete o._open; return o; });
      var openIds = msgEditList().map(function (m) { return m._open; });
      t.textContent = 'Saving…';
      return api('saveMessages', { list: sendList }).then(function (d) {
        S.messages = d; S.msgsDue = d.due.length; S.msgDirty = false; S.msgEdit = null;
        msgEditList().forEach(function (m, k) { m._open = openIds[k]; });
        S.msg = 'Messages saved.'; render(); window.scrollTo(0, 0);
      }).catch(function (e) { fail(e); window.scrollTo(0, 0); });
    }
    if (a === 'emailNow') {
      var kindE = t.dataset.kind, refE = t.dataset.ref, txtE = kindE === 'custom' ? val('pa-custom') : '', subjE = kindE === 'custom' ? val('pa-custom-subj') : '';
      if (kindE === 'custom' && !txtE.trim()) { var tc = document.getElementById('pa-custom'); if (tc) tc.focus(); return; }
      if (kindE !== 'custom' && !confirm('Email the "' + msgLabel(kindE) + '" message to this guest now?')) return;
      t.disabled = true; t.textContent = 'Sending…';
      return api('emailNow', { ref: refE, kind: kindE, text: txtE, subject: subjE }).then(function (d) { updateBooking(d.booking); S.err = null; S.modalNote = 'Email sent to ' + d.to + '.'; render(); loadMessages(); }).catch(function (e) { t.disabled = false; t.textContent = 'Email now'; alertInModal(e.message); });
    }
    if (a === 'bulk') {
      if (!S.messages) return;
      var pre = {}; if (t.dataset.ref) pre[t.dataset.ref] = true;
      S.modal = { type: 'bulk', sel: pre, waDone: {} }; return render();
    }
    if (a === 'bulkSel') {
      var bmS = S.modal; bmS.text = val('pa-bulk-text'); bmS.subject = val('pa-bulk-subj'); bmS.sel = {};
      if (t.dataset.v === 'all') ((S.messages && S.messages.inHouse) || []).forEach(function (g) { bmS.sel[g.ref] = true; });
      return render();
    }
    if (a === 'bulkEmail') {
      var bm2 = S.modal; bm2.text = val('pa-bulk-text'); bm2.subject = val('pa-bulk-subj');
      if (!bm2.text.trim()) { var bt = document.getElementById('pa-bulk-text'); if (bt) bt.focus(); return; }
      busy(true); bm2.result = null; render();
      var refsE = Object.keys(bm2.sel || {}).filter(function (r) { return bm2.sel[r]; });
      if (!refsE.length) { S.busy = false; return render(); }
      return api('emailInHouse', { text: bm2.text, subject: bm2.subject, refs: refsE }).then(function (d) {
        S.busy = false;
        bm2.result = (d.sent ? 'Emailed ' + d.sent + (d.sent === 1 ? ' guest.' : ' guests.') : 'No email was sent.') + (d.failed ? ' ' + d.failed + ' could not be sent; try again in a minute.' : '') + (d.noEmail && d.noEmail.length ? ' No email address for: ' + d.noEmail.join(', ') + '.' : '');
        render();
      }).catch(function (e) { S.busy = false; S.err = e.message; render(); });
    }
    if (a === 'bulkWa') {
      var bm3 = S.modal, gW = ((S.messages && S.messages.inHouse) || []).find(function (g) { return g.ref === t.dataset.ref; });
      bm3.text = val('pa-bulk-text'); bm3.subject = val('pa-bulk-subj');
      if (!gW) return;
      if (!bm3.text.trim()) { var bt2 = document.getElementById('pa-bulk-text'); if (bt2) bt2.focus(); return; }
      var filled = fillLocal(bm3.text, gW);
      window.open('https://wa.me/' + waNum(gW.cell) + '?text=' + encodeURIComponent(filled), '_blank', 'noopener');
      bm3.waDone[gW.ref] = true; render();
      return api('markMessage', { ref: gW.ref, kind: 'custom', state: 'sent', text: filled }).catch(function () {});
    }
    if (a === 'guestsCsv') {
      var head = ['Name', 'Cellphone', 'Email', 'Car registration', 'Stays', 'Nights', 'First stay', 'Last stay', 'Booked via', 'OK for offers', 'Opted out', 'Bookings'];
      var lines = [head.join(',')].concat(guestRows().map(function (g) { return [g.name, g.cell, g.email, g.carReg, g.stays, g.nights, g.firstStay, g.lastStay, g.channels.join(' / '), g.offers ? 'Yes' : 'No', g.optOut ? 'Yes' : 'No', g.refs.join(' ')].map(csvCell).join(','); }));
      var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var dl = document.createElement('a'); dl.href = URL.createObjectURL(blob); dl.download = 'guests-' + (S.prop.resortName || 'property').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + today() + '.csv';
      document.body.appendChild(dl); dl.click(); setTimeout(function () { URL.revokeObjectURL(dl.href); dl.remove(); }, 500); return;
    }
    if (a === 'seedDemo' || a === 'clearDemo') {
      t.textContent = a === 'seedDemo' ? 'Loading…' : 'Removing…';
      return api(a).then(function (d) { var note = a === 'seedDemo' ? d.added + ' demo bookings loaded, and the example welcome and after-stay messages switched on. Open one to try the Guest and Messages sections, and look at the Guests and Communication tabs.' : d.removed + ' demo bookings removed.'; S.guests = null; staleAll(); loadMessages(); setView('book'); S.msg = note; render(); }).catch(fail);
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
  // Property affiliates land on Property Affiliate when the hub opens.
  function openOwnTab() { var tab = document.querySelector('.tab[data-panel="property"]'); if (tab && !tab.classList.contains('active')) tab.click(); }
  function checkAffiliate() {
    if (!aff) return;
    api('affStatus', { aff: aff }).then(function (d) { if (d.linked) { S.resume = { resortName: d.resortName }; openOwnTab(); render(); } }).catch(function () {});
  }
  if (S.token) {
    openOwnTab();
    api('status').then(function (d) { S.prop = d.property; render(); loadAvailability(); loadMessages(); }).catch(function (e) { if (S.token) fail(e); else checkAffiliate(); });
  } else checkAffiliate();
})();

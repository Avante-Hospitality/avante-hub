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
      if (d.timing && window.console) console.info('[hub] grid from Stock Network, ms:', d.timing);
      mergeAv(d, a, b, Date.now());
      render(); afterFirstGrid();
    }).catch(function (e) { inFlight = null; fail(e); afterFirstGrid(); });
  }
  // Put a grid answer into what the screen holds. stamp 0 = shown, but still to be refreshed from SN.
  function mergeAv(d, a, b, stamp) {
    var av = S.av || { nights: {}, nightRates: {}, loaded: {} };
    av.units = d.units; av.minStay = d.minStay; av.snapshotAt = d.snapshotAt;
    d.units.forEach(function (u) {
      var n = (av.nights[u.name] = av.nights[u.name] || {}), r = (av.nightRates[u.name] = av.nightRates[u.name] || {});
      Object.keys(d.nights[u.name] || {}).forEach(function (k) { n[k] = d.nights[u.name][k]; delete r[k]; });
      Object.keys(d.nightRates[u.name] || {}).forEach(function (k) { r[k] = d.nightRates[u.name][k]; });
    });
    each(a, b).forEach(function (k) { av.loaded[k] = stamp; });
    S.av = av;
  }
  // Communication loads only after the grid, so it doesn't slow the grid down.
  var msgsStarted = false;
  function afterFirstGrid() { if (msgsStarted) return; msgsStarted = true; loadMessages(); }
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
  // Channel Property Affiliate (Jean, 2026-10-13): on NightsBridge or another
  // channel manager, so it gets only what NightsBridge doesn't give it:
  // Bookings (from the hub only) and Reviews, and Activities when admin ticks
  // it. No front store: it embeds its Promotions page instead (Jean, 2026-10-20).
  function isCh() { return !!(S.prop && S.prop.channel); }
  // Contact person for bookings and queries, and who gets the hub's emails
  // about the property (Jean, 2026-10-14). Email boxes take several addresses.
  function contactBlock(st) {
    var who = st.notifyWho || 'both';
    return '<fieldset class="pa-fieldset" style="margin-top:10px"><legend class="pa-label">Contact person for bookings and queries</legend><div class="pa-form">' +
      '<div class="pa-field"><label class="pa-label" for="pa-cn">Contact person</label><input id="pa-cn" type="text" value="' + esc(st.contactName || '') + '" placeholder="e.g. a manager or reservations office"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-cp">Contact phone</label><input id="pa-cp" type="tel" value="' + esc(st.contactPhone || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ce">Contact email</label><input id="pa-ce" type="text" inputmode="email" value="' + esc(st.contactEmail || '') + '" placeholder="name@example.com, other@example.com"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-nw">Send Avante\'s emails to</label><select id="pa-nw">' +
        [['both', 'Both (your email and the contact person)'], ['owner', 'Your email only'], ['contact', 'The contact person only']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === who ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select></div></div><p class="pa-hint">Several email addresses? Separate them with a comma.</p></fieldset>';
  }
  function contactVals() { return { contactName: val('pa-cn').trim(), contactPhone: val('pa-cp').trim(), contactEmail: val('pa-ce').trim(), notifyWho: val('pa-nw') || 'both' }; }
  function chTabs() { return ['book', 'rev'].concat(S.prop.activities ? ['acts'] : []); }
  function tabsFor() { return isCh() ? TABS.filter(function (v) { return chTabs().indexOf(v[0]) > -1; }) : TABS; }
  function homeView() { return isCh() ? 'book' : 'avail'; }
  var TABS = [['avail', 'Calendar'], ['book', 'Bookings'], ['guests', 'Guests'], ['acts', 'Activities'], ['msgs', 'Communication'], ['front', 'Front store'], ['chan', 'Channels'], ['rev', 'Reviews']];
  function render() {
    if (S.view === 'msgs') collectMsgEdit(); // keep what was typed in the scheduled messages
    if (S.view === 'front' && S.front && !S.front._fresh) keepFront(); // keep what was typed in the front store builder
    if (S.front) delete S.front._fresh;
    var connected = !!(S.token && S.prop);
    var h = '<div class="pa">';
    // "How to" opens this screen's part of the property affiliate guide (how-to-property.html).
    var howTo = !connected ? 'how-to-property.html#connect' : S.view === 'onb' ? 'how-to.html#property' : isCh() ? 'how-to-property.html#channel' : 'how-to-property.html#' + ({ avail: 'avail', book: 'book', guests: 'guests', acts: 'acts', msgs: 'msgs', front: 'frontstore', chan: 'chan', rev: 'rev' }[S.view] || 'tabs');
    if (connected && isCh() && chTabs().indexOf(S.view) === -1 && S.view !== 'onb') S.view = 'book';
    h += '<header class="pa-top"><span class="pa-kicker">' + (connected && isCh() ? 'Channel Property' : 'Property Affiliate') + '</span>' + (connected ? '<b class="pa-propname">' + esc(S.prop.resortName || 'Your property') + '</b><span class="pa-hint pa-top-meta">' + (S.prop.units.length ? S.prop.units.length + ' units · ' : '') + 'Site Nr ' + esc(S.prop.site) +
      (isCh() ? ' · Avante commission ' + esc(S.prop.commissionPct) + '% + VAT' : '') + '</span>' : '') +
      '<a class="pa-howto" href="' + howTo + '" target="_blank" rel="noopener" aria-label="How to use this screen (opens the guide in a new tab)">❓ How to</a></header>';
    var inMore = S.view === 'onb';
    h += '<nav class="pa-tabbar" aria-label="Property Affiliate sections"><div class="pa-tabscroll">' + tabsFor().map(function (v) {
      var badge = v[0] === 'msgs' && S.msgsDue ? '<span class="pa-badge" aria-label="' + S.msgsDue + ' to send">' + S.msgsDue + '</span>' : '';
      return '<button type="button" data-act="view" data-v="' + v[0] + '"' + (S.view === v[0] ? ' aria-current="page"' : '') + '>' + v[1] + badge + '</button>';
    }).join('') +
      // Hook Builder sits with the tabs, after Reviews (Jean, 2026-10-18); it opens in a new tab.
      '<button type="button" data-act="hookbuilder" aria-label="Hook Builder (opens in a new tab)">Hook Builder ↗</button></div>' +
      '<div class="pa-more"><button type="button" data-act="more" aria-haspopup="true" aria-expanded="' + (!!S.more) + '"' + (inMore ? ' aria-current="page"' : '') + '>More ▾</button>' +
      (S.more ? '<div class="pa-menu" role="menu"><button type="button" role="menuitem" data-act="view" data-v="onb">Onboarding Form</button>' +
        (connected ? '<button type="button" role="menuitem" class="pa-menu-danger" data-act="disconnect">Disconnect property</button>' : '') + '</div>' : '') +
      '</div></nav>';
    if (S.err) h += '<div class="pa-err" role="alert" style="margin-bottom:12px">' + esc(S.err) + ' <button type="button" class="pa-btn small ghost" data-act="dismiss" style="margin-left:8px">OK</button></div>';
    if (S.msg) h += '<div class="pa-ok" role="status" style="margin-bottom:12px">' + esc(S.msg) + '</div>';
    if (S.view === 'onb') h += '';
    else if (!connected && S.opening) h += '<div class="pa-card pa-hint" role="status">Opening ' + esc((S.prop && S.prop.resortName) || 'your property') + '…</div>';
    else if (!connected) h += viewConnect();
    else if (S.view === 'avail') h += viewAvail();
    else if (S.view === 'chan') h += viewChan();
    else if (S.view === 'book') h += viewBookings();
    else if (S.view === 'guests') h += viewGuests();
    else if (S.view === 'acts') h += viewActivities();
    else if (S.view === 'msgs') h += viewMessages();
    else if (S.view === 'rev') h += viewReviews();
    else if (S.view === 'front') h += viewFront();
    h += '</div>';
    if (S.modal) h += '<div class="pa">' + viewModal() + '</div>';
    root.innerHTML = h;
    if (onboarding) onboarding.style.display = S.view === 'onb' ? '' : 'none';
    pvAfterRender();
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
        '<details class="pa-card pa-soft"><summary class="pa-h2" style="cursor:pointer">Connect a different property</summary>';
    }
    h += '<div class="pa-card"' + (S.resume ? ' style="margin:12px 0 0;box-shadow:none"' : '') + '><p class="pa-h2">Connect to Avante</p>' +
      '<p class="pa-hint">Use your Avante login: the username, client ID and client secret Avante gave you. The hub keeps it encrypted and uses it only to read your availability and to make, change and cancel bookings for you.</p>' +
      '<div class="pa-form" style="margin-top:10px">' +
      '<div class="pa-field"><label class="pa-label" for="pa-u">Username</label><input id="pa-u" type="text" autocomplete="off" value="' + esc(c.username || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ci">Client ID</label><input id="pa-ci" type="text" autocomplete="off" value="' + esc(c.clientID || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-cs">Client secret</label><input id="pa-cs" type="password" autocomplete="off"></div></div>';
    if (c.needResort) {
      h += '<div style="margin-top:14px"><p class="pa-h2">Which property is this?</p>';
      if (c.candidates && c.candidates.length) h += c.candidates.map(function (r) { return '<button type="button" class="pa-btn ghost small" style="margin:0 8px 8px 0" data-act="pickResort" data-id="' + esc(r.resortId) + '">' + esc(r.name) + '</button>'; }).join('');
      h += '<div class="pa-field" style="margin-top:8px"><label class="pa-label" for="pa-rs">Search by property name or town</label><input id="pa-rs" type="search" value="' + esc(c.q || '') + '" placeholder="e.g. The Dunes"></div>';
      if (c.matches) h += '<div class="pa-results">' + (c.matches.length ? c.matches.map(function (r) { return '<div class="pa-result"><div class="grow"><b>' + esc(r.name) + '</b><div class="pa-hint">' + esc(r.district || r.town || '') + '</div></div><button type="button" class="pa-btn small" data-act="pickResort" data-id="' + esc(r.resortId) + '">This one</button></div>'; }).join('') : '<span class="pa-hint">No property with that name or town.</span>') + '</div>';
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
    if (!S.av) return '<div class="pa-card pa-hint">Loading availability from Avante…</div>';
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
      if (!shown.length) h += '<span class="pa-err">No unit is open for all of those nights.</span>';
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
      (S.busy ? ' · <b style="color:#08776f">Updating from Avante…</b>' : S.av.snapshotAt ? ' · Updated ' + new Date(S.av.snapshotAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '</span></div>';
    h += '<div class="pa-legend"><span><i class="lg-open"></i>Open</span><span><i class="lg-hub"></i>Hub booking</span><span><i class="lg-sn"></i>Booked elsewhere</span><span><i class="lg-airbnb"></i>Airbnb</span><span><i class="lg-bcom"></i>Booking.com</span><span><i class="lg-lekke"></i>LekkeSlaap</span><span><i class="lg-warn"></i>Channel booking not yet with Avante</span><span><i class="lg-na"></i>Not with Avante</span></div>';
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
        var text = st.ref ? (st.name || 'Guest') : st.s === 'sn' ? 'Booked elsewhere' : st.s === 'pending' ? (CH[st.ch] || 'Channel') + ' guest · not with Avante yet' : st.s === 'clash' ? 'Clash · ' + (CH[st.ch] || 'channel') : st.s === 'closed' ? 'Not bookable yet' : 'Not with Avante';
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
    h += '</div></div>' + (totalOpen ? '' : '<p class="pa-hint" style="margin-top:10px">Nothing open in these days. Use ›, or search your dates above.</p>') + '</section>';
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
      h += '<section class="pa-card" style="border-color:#f5c98a;background:#fff4e5" aria-label="New unit"><p class="pa-h2" style="color:#6b3a00">New unit with Avante: ' + esc(n.name) + '</p>' +
        '<p class="pa-hint" style="color:#6b3a00">If this is a unit that was renamed with Avante, move its channel links across so its calendars keep working (its old Avante links keep working too).</p>' +
        '<div class="pa-row" style="margin-top:8px">' + (others.length ? '<div class="pa-field" style="flex:1 1 200px"><label class="pa-label" for="pa-mv-' + esc(n.name) + '">Renamed from</label><select id="pa-mv-' + esc(n.name) + '">' + others.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('') + '</select></div>' +
        '<button type="button" class="pa-btn" data-act="unitMove" data-u="' + esc(n.name) + '">Move links to ' + esc(n.name) + '</button>' : '') +
        '<button type="button" class="pa-btn ghost" data-act="unitNew" data-u="' + esc(n.name) + '">It\'s a new unit</button></div></section>';
    });
    h += viewConnectChannels();
    h += '<section class="pa-card" aria-label="Reservation settings"><p class="pa-h2">Reservation settings</p><p class="pa-hint">Used when the hub books another channel\'s reservation onto Avante\'s booking system (client name = the channel).</p><div class="pa-form" style="margin-top:10px">' +
      '<div class="pa-field"><label class="pa-label" for="pa-se">Your email (and on Avante reservations)</label><input id="pa-se" type="text" inputmode="email" value="' + esc(st.email || '') + '" placeholder="Your reservations inbox, another@example.com"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-sp">Phone on Avante reservations (required)</label><input id="pa-sp" type="tel" value="' + esc(st.phone || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-sm">Minimum stay (nights)</label><input id="pa-sm" type="number" min="1" max="30" value="' + esc(st.minStay || 2) + '"></div></div>' + contactBlock(st) +
      (function () {
        var cs = st.calendarStart || {}, isDate = cs.mode === 'date';
        return '<fieldset class="pa-fieldset"><legend class="pa-label">Calendar opens on</legend>' +
          '<label class="pa-check pa-radio"><input type="radio" name="pa-cs-mode" value="today"' + (isDate ? '' : ' checked') + '><span><b>Today</b><br><span class="pa-hint">The calendar always opens on today\'s date.</span></span></label>' +
          '<label class="pa-check pa-radio"><input type="radio" name="pa-cs-mode" value="date"' + (isDate ? ' checked' : '') + '><span><b>A set date</b><br><span class="pa-hint">The calendar opens on this date, and it is the first date that can be booked in the hub until it has passed (for example when you open for the season).</span>' +
          '<span style="display:block;margin-top:8px;max-width:220px"><input id="pa-cs-date" type="date" aria-label="Calendar start date" value="' + esc(cs.date || '') + '" min="' + today() + '"></span></span></label></fieldset>';
      })() +
      '<p class="pa-label" style="margin:14px 0 6px">Nightly channel price per unit (calendar links don\'t include prices)</p><div class="pa-form">' +
      S.channels.units.map(function (u) { return '<div class="pa-field"><label class="pa-label" for="pa-pr-' + esc(u.name) + '" style="color:#0e2f44">' + esc(u.name) + '</label><input id="pa-pr-' + esc(u.name) + '" data-price="' + esc(u.name) + '" type="number" min="0" value="' + esc((st.prices || {})[u.name] || '') + '" placeholder="Uses the Avante rate if empty"></div>'; }).join('') + '</div>' +
      '<label class="pa-check" style="display:flex;align-items:center;gap:10px;margin-top:14px"><input id="pa-auto" type="checkbox"' + (st.autoBook ? ' checked' : '') + ' style="width:18px;height:18px">Book other channels\' reservations onto Avante automatically</label>' +
      '<p class="pa-hint">Leave this off at first: new channel bookings then wait below for you to add them with one click, so you can check everything is right.</p>' +
      '<div class="pa-row" style="margin-top:12px"><button type="button" class="pa-btn" data-act="saveChannels">Save reservation settings</button></div></section>';
    var bk = S.channels.bank || {}, pm = st.payMode || 'both';
    var pmOpt = function (v, label, hint) { return '<label class="pa-check pa-radio"><input type="radio" name="pa-pm" value="' + v + '"' + (pm === v ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="pa-hint">' + hint + '</span></span></label>'; };
    h += '<section class="pa-card" aria-label="Guest payments"><p class="pa-h2">Guest payments</p><p class="pa-hint">How guests pay for bookings you make in the hub. Bookings from Airbnb, Booking.com and LekkeSlaap are paid on those channels.</p>' +
      '<fieldset class="pa-fieldset"><legend class="pa-label">How guests can pay</legend>' +
      pmOpt('both', 'Both (recommended)', 'Avante payment gateway link and EFT to your bank account.') +
      pmOpt('gateway', 'Avante payment gateway only', 'The gateway sets the booking to Paid. Unpaid bookings are cancelled by Avante after the payment time.') +
      pmOpt('eft', 'EFT to our bank account only', 'Bookings are Booked straight away. Tap Paid by EFT when the money is in: the hub records it with Avante, which sets Paid.') + '</fieldset>' +
      '<label class="pa-check" style="display:flex;align-items:flex-start;gap:10px;margin-top:14px"><input id="pa-appr" type="checkbox"' + (st.approveGuests ? ' checked' : '') + ' style="width:18px;height:18px;margin-top:2px"><span><b>Approve each new front store guest</b><br><span class="pa-hint">Front store bookings wait as a Request until you tap Accept (Booked) or Decline (cancelled). If you don\'t answer, Avante cancels the request after a set number of days.</span></span></label>' +
      '<p class="pa-label" style="margin:16px 0 6px">Your bank account for EFT</p><div class="pa-form">' +
      '<div class="pa-field"><label class="pa-label" for="pa-bn" style="color:#0e2f44">Bank</label><input id="pa-bn" type="text" value="' + esc(bk.bankName || '') + '" placeholder="e.g. FNB"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bh" style="color:#0e2f44">Account holder</label><input id="pa-bh" type="text" value="' + esc(bk.accountHolder || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ba" style="color:#0e2f44">Account number</label><input id="pa-ba" type="text" inputmode="numeric" autocomplete="off" value="' + esc(bk.accountNumber || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bb" style="color:#0e2f44">Branch code</label><input id="pa-bb" type="text" inputmode="numeric" value="' + esc(bk.branchCode || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bt" style="color:#0e2f44">Account type</label><select id="pa-bt">' + ['', 'Cheque / Current', 'Savings', 'Business'].map(function (o) { return '<option' + ((bk.accountType || '') === o ? ' selected' : '') + ' value="' + esc(o) + '">' + (o || 'Choose…') + '</option>'; }).join('') + '</select></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-bx" style="color:#0e2f44">Note for guests (optional)</label><input id="pa-bx" type="text" value="' + esc(bk.note || '') + '" placeholder="e.g. Send proof of payment to …"></div></div>' +
      '<p class="pa-hint">Kept encrypted. Guests see these only in the payment message you send them, with the booking reference to use.</p>' +
      '<div class="pa-row" style="margin-top:12px"><button type="button" class="pa-btn" data-act="saveChannels">Save payment settings</button></div></section>';
    h += '<section class="pa-card" id="pa-chlinks" aria-label="Channel links"><div class="pa-row" style="justify-content:space-between;align-items:center"><div><p class="pa-h2">Channel links per unit</p><p class="pa-hint">Step 1: copy the Avante link into that unit\'s listing on the channel. Step 2: paste the channel\'s own calendar link back here.</p></div><button type="button" class="pa-btn ghost small" data-act="syncNow">Check channels now</button></div>';
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
    h += '<section class="pa-card" aria-label="Channel bookings"><p class="pa-h2">Channel bookings not yet with Avante</p>' + (ev.length ? ev.map(function (e) {
      return '<div class="pa-result"><div class="grow"><b>' + esc(CH[e.channel]) + ' · ' + esc(e.unit) + '</b><div class="pa-hint">' + nice(e.start) + ' – ' + nice(e.end) + ' · ' + nw(nightsBetween(e.start, e.end)) + (e.summary ? ' · ' + esc(e.summary) : '') + '</div>' + (e.error ? '<div class="pa-err" style="margin-top:6px">' + esc(e.error) + '</div>' : '') + '</div>' +
        (e.status === 'clash' ? '<span class="pa-pill" style="background:#ffe2bf;color:#6b3a00">Clash · already sold</span>' : '<button type="button" class="pa-btn small" data-act="addEvent" data-u="' + esc(e.unit) + '" data-c="' + esc(e.channel) + '" data-uid="' + esc(e.uid) + '">Add to Avante</button>') + '</div>';
    }).join('') : '<p class="pa-hint">None. New bookings from Airbnb, Booking.com and LekkeSlaap appear here within 15 minutes.</p>') + '</section>';
    return h;
  }


  // ---- Connect Airbnb, Booking.com and LekkeSlaap (2026-10-13): easiest way first. ----
  function viewConnectChannels() {
    var C = S.channels, inv = esc(C.inviteEmail || 'admin@avantehospitality.co.za'), req = C.channelHelp;
    var units = C.units.map(function (u) { return esc(u.name); }).join(', ');
    var allOk = C.units.length && C.units.every(function (u) { return u.channels.some(function (c) { return c.status === 'ok'; }); });
    var step = function (items) { return '<ol class="pa-steps">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>'; };
    var b = function (t) { return '<b>' + t + '</b>'; };
    var h = '<section class="pa-card" aria-label="Connect your channels"><p class="pa-h2">Connect Airbnb, Booking.com and LekkeSlaap</p>' +
      '<p class="pa-hint">This stops double bookings: a booking on one channel blocks the same nights everywhere. Do it once for every unit (' + units + ') on every channel you use. Choose one of the two ways.</p>';
    if (allOk) h += '<div class="pa-ok" style="margin-top:8px">Every unit has at least one channel connected. Check the list under Channel links per unit.</div>';
    // Option 1
    h += '<details class="pa-opt"' + (allOk ? '' : ' open') + '><summary><span class="pa-opt-badge">Easiest</span> <b>Way 1: Let Avante set it up for you</b><br><span class="pa-hint">About 2 minutes for you. You invite Avante on each channel, Avante does the rest.</span></summary>' +
      '<p style="margin:10px 0 4px">On every channel you use, invite this email address:</p>' +
      '<div class="pa-copy" style="max-width:420px"><input type="text" readonly value="' + inv + '" aria-label="Email address to invite"><button type="button" class="pa-btn small" data-act="copy" data-text="' + inv + '">Copy</button></div>' +
      '<p class="pa-label" style="margin:16px 0 4px;color:#0e2f44">Airbnb</p>' + step([
        'Open ' + b('airbnb.co.za') + ' on a computer and log in.',
        'Tap ' + b('Listings') + ' (top of the page, or in the menu at the top right).',
        'Tap the listing of your first unit.',
        'Find ' + b('Co-hosts') + ' in the list on the left (or scroll down to it).',
        'Tap ' + b('Invite a co-host') + ' (or ' + b('Add co-host') + ').',
        'Paste the email address above.',
        'Choose the permission that includes the ' + b('calendar') + ' (for example "Calendar and messaging" or "Full access").',
        'Tap ' + b('Send invite') + '.',
        'Do the same for every other unit that has its own listing.']) +
      '<p class="pa-label" style="margin:12px 0 4px;color:#0e2f44">Booking.com</p>' + step([
        'Open ' + b('admin.booking.com') + ' (the extranet) on a computer and log in.',
        'Tap your account name or ' + b('Account') + ' at the top right.',
        'Tap ' + b('User management') + ' (sometimes just ' + b('Users') + ').',
        'Tap ' + b('Create new user') + ' (or ' + b('Add user') + ').',
        'Paste the email address above.',
        'Give access to ' + b('Rates & availability') + ' (the calendar).',
        'Tap ' + b('Send') + ' / ' + b('Save') + '.']) +
      '<p class="pa-label" style="margin:12px 0 4px;color:#0e2f44">LekkeSlaap</p>' + step([
        'Log in to your ' + b('LekkeSlaap host profile') + '.',
        'Look for ' + b('Users') + ', ' + b('Team') + ' or ' + b('Access') + ' in your account settings and add the email address above.',
        'Can\'t find it? Skip LekkeSlaap here and use Way 2 for LekkeSlaap only, or tick it below and write "please help with LekkeSlaap" in the note.']) +
      '<p class="pa-label" style="margin:14px 0 6px;color:#0e2f44">Done? Tell Avante:</p>' +
      '<div class="pa-row" style="gap:4px 16px">' + [['airbnb', 'Airbnb'], ['bcom', 'Booking.com'], ['lekke', 'LekkeSlaap']].map(function (c) { return '<label class="pa-check" style="min-height:44px"><input type="checkbox" data-chhelp="' + c[0] + '"' + (req && req.channels.indexOf(c[0]) >= 0 ? ' checked' : '') + '> I invited Avante on ' + c[1] + '</label>'; }).join('') + '</div>' +
      '<div class="pa-field" style="margin-top:6px"><label class="pa-label" for="pa-chnote">Note for Avante (optional)</label><textarea id="pa-chnote" rows="2" placeholder="e.g. FV10 and FV11 are one listing on Airbnb">' + esc((req && req.note) || '') + '</textarea></div>' +
      '<div class="pa-row" style="margin-top:10px;align-items:center"><button type="button" class="pa-btn" data-act="chHelp"' + (S.busy ? ' disabled' : '') + '>Tell Avante I\'ve sent the invites</button>' +
      (req ? '<span class="pa-hint">Sent ' + new Date(req.at).toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + new Date(req.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. Avante will connect your channels and they\'ll show "Connected" below.</span>' : '') + '</div></details>';
    // Option 2
    h += '<details class="pa-opt"><summary><b>Way 2: Do it yourself</b><br><span class="pa-hint">About 5 minutes per unit and channel. Two links per unit: copy ours into the channel, and the channel\'s into the hub.</span></summary>' +
      '<p style="margin:10px 0 4px">For each unit, the two links are under ' + b('Channel links per unit') + ' further down this page. <button type="button" class="pa-btn small ghost" data-act="toLinks">Show me the links</button></p>' +
      '<p class="pa-label" style="margin:14px 0 4px;color:#0e2f44">Airbnb</p>' + step([
        'Open ' + b('airbnb.co.za') + ' and log in.',
        'Tap ' + b('Calendar') + ', then choose the listing of your first unit.',
        'Tap ' + b('Availability') + '.',
        'Scroll to ' + b('Connect calendars') + ' and tap ' + b('Connect to another website') + '.',
        'Copy the link Airbnb shows. In the hub, paste it in that unit\'s box ' + b('Airbnb\'s calendar link') + '.',
        'In the hub, tap ' + b('Copy') + ' next to that unit\'s ' + b('Avante link for Airbnb') + '.',
        'Back on Airbnb, paste it in the calendar address box, type the name ' + b('Avante') + ' and tap ' + b('Add calendar') + '.',
        'Repeat for every unit, then tap ' + b('Save settings and links') + ' in the hub.']) +
      '<p class="pa-label" style="margin:12px 0 4px;color:#0e2f44">Booking.com</p>' + step([
        'Open ' + b('admin.booking.com') + ' and log in.',
        'Tap ' + b('Calendar & Pricing') + ', then ' + b('Sync calendars') + '.',
        'Tap ' + b('Add calendar connection') + '.',
        'In the hub, tap ' + b('Copy') + ' next to that unit\'s ' + b('Avante link for Booking.com') + ', and paste it in Booking.com\'s box. Tap ' + b('Next') + '.',
        'Type the name ' + b('Avante') + ' and tap ' + b('Export calendar') + '.',
        'Copy the link Booking.com shows. In the hub, paste it in that unit\'s box ' + b('Booking.com\'s calendar link') + '. Tap ' + b('Done') + ' on Booking.com.',
        'Repeat for every unit, then tap ' + b('Save settings and links') + ' in the hub.']) +
      '<div class="pa-note" style="margin:6px 0">No ' + b('Sync calendars') + ' on Booking.com? Your property already uses a channel manager there. Use Way 1 and Avante will help.</div>' +
      '<p class="pa-label" style="margin:12px 0 4px;color:#0e2f44">LekkeSlaap</p>' + step([
        'Log in to your ' + b('LekkeSlaap host profile') + '.',
        'Tap ' + b('Calendar Settings') + ', then under ' + b('Calendar Integration') + ' choose ' + b('iCal') + '.',
        'Tap ' + b('Enable iCal for this Property') + ' at the bottom, choose a platform and tap ' + b('Next') + '.',
        'Tap ' + b('Copy Link') + '. In the hub, paste it in that unit\'s box ' + b('LekkeSlaap\'s calendar link') + '.',
        'In the hub, tap ' + b('Copy') + ' next to ' + b('Avante link for LekkeSlaap') + ', paste it in LekkeSlaap\'s import box and tap ' + b('Import') + '.',
        'Then tap ' + b('Save settings and links') + ' in the hub.']) +
      '<p class="pa-hint">A link shows "Connected" in the hub within 15 minutes. Button names on the channels sometimes change: if you get stuck, use Way 1.</p></details></section>';
    return h;
  }
  // ---- Bookings ----
  var PAY_PILL = { paid: ['#d4f5f2', '#065e58', 'Paid'], 'paid-eft': ['#d4f5f2', '#065e58', 'Paid (EFT)'], 'part-paid': ['#fff4e5', '#6b3a00', 'Part paid'], unpaid: ['#fff4e5', '#6b3a00', 'Unpaid'], channel: ['#eef2f2', '#333', 'Paid on channel'] };
  function payPill(b) {
    if (b.status === 'Cancelled') return '';
    var p = PAY_PILL[b.payState] || PAY_PILL.unpaid;
    return '<span class="pa-pill" style="background:' + p[0] + ';color:' + p[1] + '">' + p[2] + (b.payState === 'part-paid' ? ' ' + money(b.amountPaid) : '') + '</span>';
  }
  // A Paid or Confirmed booking the property asked Avante to cancel: "Paid (Cancel requested)" (Jean, 2026-10-19).
  function statusText(b) { return b.status + (b.cancelRequest && b.status !== 'Cancelled' ? ' (Cancel requested)' : ''); }
  function statusPill(b) { var c = b.status === 'Cancelled' ? ['#e7ebeb', '#333'] : ['#dbe6ff', '#0b2f80']; return (b.demo ? '<span class="pa-pill" style="background:#f3e8ff;color:#5b21b6">Demo</span> ' : '') + '<span class="pa-pill" style="background:' + c[0] + ';color:' + c[1] + '">' + esc(statusText(b)) + '</span>'; }
  function whoOf(b) { var c = b.contact || {}; if (b.origin === 'channel') return (c.name ? c.name + ' · ' : '') + (b.source || ''); return c.name || ((b.guest && (b.guest.first + ' ' + b.guest.last).trim()) || ''); }
  function bookingActions(b) {
    var live = b.items.filter(function (i) { return !i.cancelled; });
    if (b.status === 'Cancelled' || !live.length) return '';
    var h = '<button type="button" class="pa-btn small" data-act="editBooking" data-ref="' + esc(b.ref) + '">Open</button>';
    if (b.approval && b.approval.state === 'pending') {
      h += '<button type="button" class="pa-btn small" data-act="decide" data-yes="1" data-ref="' + esc(b.ref) + '">Accept</button><button type="button" class="pa-btn small danger" data-act="decide" data-ref="' + esc(b.ref) + '">Decline</button>' +
        '<span class="pa-hint" style="width:100%">Waiting for you to accept. Avante cancels it if not accepted in time.</span>';
    } else if (b.origin !== 'channel' && !b.locked && !b.demo) {
      h += '<button type="button" class="pa-btn small ghost" data-act="payLink" data-ref="' + esc(b.ref) + '">Payment link</button>';
      if (S.payMode !== 'gateway') h += '<button type="button" class="pa-btn small ghost" data-act="markPaid" data-type="EFT" data-ref="' + esc(b.ref) + '">Paid by EFT</button><button type="button" class="pa-btn small ghost" data-act="markPaid" data-type="Cash" data-ref="' + esc(b.ref) + '">Paid on arrival</button>';
    }
    if (b.statusError) h += '<span class="pa-err" style="width:100%;font-size:12.5px">' + esc(b.statusError) + '</span>';
    return '<div class="pa-actions">' + h + '</div>';
  }
  function viewBookings() {
    var h = propHeader();
    if (isCh()) {
      var cs = S.prop.settings || {};
      h += '<section class="pa-card" aria-label="How it works"><p class="pa-h2">Bookings from the hub</p>' +
        '<p class="pa-hint">This list shows only bookings that came through Avante: your hook and booking links. They reach your NightsBridge (or other channel manager) through Avante, marked <b>Avante Hub booking</b>. Guests pay on Avante\'s secure payment page (all bookings are paid to you within 3 to 5 working days, or before the guest\'s arrival, whichever is sooner).</p>' +
        '<div class="pa-form" style="margin-top:10px"><div class="pa-field"><label class="pa-label" for="ch-email">Your email for new booking notices</label><input id="ch-email" type="text" inputmode="email" value="' + esc(cs.email || '') + '" placeholder="name@example.com, other@example.com"></div>' +
        '<div class="pa-field"><label class="pa-label" for="ch-phone">Phone</label><input id="ch-phone" type="tel" value="' + esc(cs.phone || '') + '"></div></div>' + contactBlock(cs) +
        '<div class="pa-row" style="margin-top:8px"><button type="button" class="pa-btn small" data-act="chSaveContact">Save</button></div></section>';
    }
    h += '<section class="pa-card"><div class="pa-row" style="justify-content:space-between;align-items:center"><p class="pa-h2">' + (isCh() ? 'Your hub bookings' : 'Bookings made or synced by the hub') + '</p><div class="pa-field" style="flex:0 1 280px"><label class="pa-label" for="pa-bq">Search</label><input id="pa-bq" type="search" value="' + esc(S.findQ) + '" placeholder="Reference, guest, unit or channel"></div></div>';
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
    h += '<p class="pa-hint">Open a booking to add or change the guest\'s details (also on paid and channel bookings) and to send WhatsApp messages and emails. Paid or Confirmed bookings can\'t be changed or cancelled in the hub: tap Ask Avante to cancel and Avante does it. Bookings made outside the hub show on the Calendar as Booked elsewhere; manage those in Avante\'s booking system.</p></section>';
    if (S.prop.demoAllowed) h += '<section class="pa-card pa-soft" aria-label="Demo bookings"><p class="pa-h2">Demo bookings (Property Testing only)</p><p class="pa-hint">Six example bookings with guest details, plus example welcome and after-stay messages switched on, to show how the hub works. They stay in the hub: they are never sent to Avante\'s booking system or to your channel calendars.</p>' +
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
      '<p class="pa-hint">Kept in the hub for your records' + (b.origin === 'channel' ? '; in Avante\'s booking system this booking stays under ' + esc(b.source) : '; Avante\'s booking system keeps the details it was booked with') + '.</p>';
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

  // ---- Front store (public page /stay/<slug>, guest page, room card) ----
  // qrcode.js loads the first time a QR is shown (load-script.js): until it
  // has, the QR box holds a placeholder that is filled in once it arrives.
  function qrSvg(text, px) {
    if (!window.qrcode) {
      if (window.AvanteScripts) AvanteScripts.qrcode().then(fillQrPlaceholders, function () {});
      return '<span class="pa-qr-wait" data-qr-text="' + esc(text) + '" data-qr-px="' + (px || 150) + '" style="display:inline-block;width:' + (px || 150) + 'px;height:' + (px || 150) + 'px"></span>';
    }
    try { var q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }).replace('<svg ', '<svg style="width:' + (px || 150) + 'px;height:' + (px || 150) + 'px" role="img" aria-label="QR code for ' + esc(text) + '" '); } catch (e) { return ''; }
  }
  function fillQrPlaceholders() {
    Array.prototype.forEach.call(document.querySelectorAll('.pa-qr-wait'), function (el) {
      el.outerHTML = qrSvg(el.getAttribute('data-qr-text'), +el.getAttribute('data-qr-px') || 150);
    });
  }
  function frontPhotos() {
    var F = S.front, all = [];
    var chosen = Array.isArray(F.settings.photos) ? F.settings.photos.slice() : null;
    // Photos added by link (e.g. Stock Network photos) are only in the chosen list.
    (F.uploadedPhotos || []).concat(F.snPhotos || [], chosen || []).forEach(function (u) { if (all.indexOf(u) < 0) all.push(u); });
    return { all: all, chosen: chosen };
  }
  function linkRow(label, url, act) {
    return '<div class="pa-field" style="margin-top:10px"><span class="pa-label">' + label + '</span><div class="pa-copy"><input type="text" readonly value="' + esc(url) + '" aria-label="' + esc(label) + '">' +
      '<button type="button" class="pa-btn small" data-act="copy" data-text="' + esc(url) + '">Copy</button><a class="pa-btn small ghost pa-linkbtn" href="' + esc(url) + '" target="_blank" rel="noopener">Open</a></div></div>';
  }
  // Front store builder (Jean, 2026-10-13): numbered steps on the left, a live
  // preview of the real page (stay.html?preview=1) on the right. Everything
  // typed shows in the preview straight away; nothing is live until Save.
  var FS_STEPS = [['link', 'Switch on and link', 'hero'], ['top', 'Top of the page', 'hero'], ['photos', 'Photos', 'photos'], ['hl', 'Highlights', 'hl'],
    ['units', 'Your units', 'units'], ['acts', 'Things to do nearby', 'nearby'], ['shows', 'What shows on the page', 'calsec'], ['words', 'Words and contact details', 'about'],
    ['guest', 'Guest page and room card', '']];
  function fsStep(id, n, title, status, body) {
    var open = (S.fsOpen || {})[id];
    return '<details class="fs-step" data-fsstep="' + id + '"' + (open ? ' open' : '') + '><summary><span class="fs-n" aria-hidden="true">' + n + '</span><span class="fs-st"><b>' + esc(title) + '</b>' +
      (status ? '<span class="fs-stat">' + status + '</span>' : '') + '</span><span class="fs-chev" aria-hidden="true">▾</span></summary><div class="fs-body">' + body + '</div></details>';
  }
  function fsAutoPrice(st) {
    if (!st.showPrices) return '';
    var hid = st.hiddenUnits || [], list = S.front.units.filter(function (u) { return hid.indexOf(u.name) < 0 && u.price > 0; }).map(function (u) { return u.price; });
    return list.length ? 'From ' + money(Math.min.apply(null, list)) + ' a night' : '';
  }
  function fsPosCss(u) { var p = ((S.front && S.front.settings.photoPos) || {})[u]; return p ? ';background-position:' + p : ''; }
  // The 10 things to do on the page now: the ones kept by the property (📌),
  // then a random pick of the rest (same pick until the list reloads).
  function fsPageActs() {
    var st = S.front.settings, all = (S.fpv && S.fpv.nearby) || [], hid = st.actHidden || [], pins = st.actPinned || [];
    var ord = S.fpvOrder || all.map(function (a, i) { return i; });
    var kept = [], rest = [];
    // Guests only see things to do that have a photo.
    var ap = st.actPhotos || {}, hasPh = function (a) { return !!(ap[a.name] || a.autoPhoto || a.basePhoto); };
    all.forEach(function (a, i) { if (hid.indexOf(a.name) < 0 && pins.indexOf(a.name) >= 0 && hasPh(a)) kept.push(i); });
    ord.forEach(function (i) { var a = all[i]; if (a && hid.indexOf(a.name) < 0 && pins.indexOf(a.name) < 0 && hasPh(a)) rest.push(i); });
    return kept.slice(0, 10).concat(rest).slice(0, 10).sort(function (x, y) { return x - y; });
  }
  // "Change photo" for a thing to do: the shared photo library first, then Google
  // (Google's photos go into the library too). Jean, 2026-10-14.
  function fsActChoices(i, a, photo) {
    var c = S.fsAP && S.fsAP.i === i ? S.fsAP : null, h = '';
    var grid = function (list) { return '<div class="fs-gres">' + list.map(function (p) { var on = p.url === photo;
      return '<div class="fs-gimg"><img src="' + esc(p.url) + '" alt="" loading="lazy"><button type="button" class="pa-btn small ' + (on ? '' : 'teal') + '" data-act="fsActUse" data-name="' + esc(a.name) + '" data-u="' + esc(p.url) + '"' + (on ? ' aria-pressed="true"' : '') + '>' + (on ? '✓ Chosen' : 'Use') + '</button>' + (p.credit ? '<span>' + esc(p.credit) + '</span>' : '') + '</div>'; }).join('') + '</div>'; };
    if (!c || c.busy) return '<p class="pa-hint" role="status" style="margin-top:8px">Looking in the photo library…</p>';
    if (c.library && c.library.length) h += '<p class="pa-label" style="margin:10px 0 4px">In the photo library</p>' + grid(c.library);
    else h += '<p class="pa-hint" style="margin:10px 0 0">Nothing in the photo library for this yet.</p>';
    h += '<p class="pa-label" style="margin:12px 0 4px"><label for="fs-apq">Google photos</label></p><div class="pa-copy"><input type="search" id="fs-apq" value="' + esc(c.q || (a.name + ' ' + (a.area || '')).trim()) + '" aria-label="Search Google photos for"><button type="button" class="pa-btn small" data-act="fsAPg" data-i="' + i + '">Search Google</button></div>';
    if (c.gbusy) h += '<p class="pa-hint" role="status">Looking on Google…</p>';
    if (c.gerr) h += '<p class="pa-err">' + esc(c.gerr) + '</p>';
    if (c.google && c.google.length) h += '<p class="pa-hint" style="margin:6px 0 0">These are now in the photo library too, for next time.</p>' + grid(c.google);
    return h;
  }
  function fsActLoad(i, google) {
    var a = (S.fpv && S.fpv.nearby || [])[i]; if (!a) return;
    var q = google && document.getElementById('fs-apq') ? document.getElementById('fs-apq').value.trim() : '';
    var prev = S.fsAP && S.fsAP.i === i ? S.fsAP : null;
    S.fsAP = google ? Object.assign({}, prev, { i: i, gbusy: true, gerr: '', q: q }) : { i: i, busy: true };
    keepFront(); S.front._fresh = true; render();
    return api('frontActPhotos', { act: { id: a.id, name: a.name, area: a.area, latitude: a.latitude, longitude: a.longitude }, google: !!google, query: q }).then(function (d) {
      if (!S.fsAP || S.fsAP.i !== i) return;
      if (google) { S.fsAP.gbusy = false; S.fsAP.google = d.google || []; S.fsAP.gerr = d.googleError || ''; }
      else { S.fsAP = { i: i, library: d.library || [], google: d.google || null, gerr: d.googleError || '' }; }
      keepFront(); S.front._fresh = true; render();
    }).catch(function (e) { if (S.fsAP && S.fsAP.i === i) { S.fsAP.busy = false; S.fsAP.gbusy = false; S.fsAP.library = S.fsAP.library || []; S.fsAP.gerr = e.message; } keepFront(); S.front._fresh = true; render(); });
  }
  function fsAreaLabel(a) { return [a.s, a.t, a.p].filter(function (x, i, l) { return x && l.indexOf(x) === i; }).join(', '); }
  function fsPlace() { var p = (S.fpv && S.fpv.place) || {}; return p.suburb || p.city || p.region || ''; }
  function fsThumbs(sel, data, list) {
    return '<div class="fs-thumbs" role="group">' + list.map(function (u, i) {
      var on = u === sel;
      return '<button type="button" class="fs-thumb' + (on ? ' on' : '') + '" ' + data + ' data-u="' + esc(u) + '" aria-pressed="' + on + '" aria-label="Photo ' + (i + 1) + (on ? ' (chosen)' : '') + '"><img src="' + esc(u) + '" alt="" loading="lazy">' + (on ? '<span class="fs-tick" aria-hidden="true">✓</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function fsGoogleBox(target, q) {
    var g = S.fsG && S.fsG.target === target ? S.fsG : null;
    var h = '<div class="fs-g"><div class="pa-copy"><input type="search" data-fsgq="' + esc(target) + '" value="' + esc(g ? g.q : q) + '" aria-label="Search Google photos for"><button type="button" class="pa-btn small" data-act="fsG" data-target="' + esc(target) + '">Search Google</button></div>';
    if (g && g.busy) h += '<p class="pa-hint" role="status">Looking on Google…</p>';
    if (g && g.err) h += '<p class="pa-err">' + esc(g.err) + '</p>';
    if (g && g.images) h += '<p class="pa-hint" style="margin:6px 0 0">' + (g.place ? 'Photos of <b>' + esc(g.place) + '</b>. ' : '') + 'Tap <b>Use</b> on the one you like.</p><div class="fs-gres">' + g.images.map(function (im, i) {
      return '<div class="fs-gimg"><img src="' + esc(im.dataUri) + '" alt=""><button type="button" class="pa-btn small teal" data-act="fsGUse" data-i="' + i + '">Use</button>' + (im.credit ? '<span>' + esc(im.credit) + '</span>' : '') + '</div>';
    }).join('') + '</div>';
    return h + '</div>';
  }
  function viewFront() {
    var F = S.front;
    if (!F) return '<div class="pa-card pa-hint">Loading…</div>';
    var st = F.settings, on = st.on, ph = frontPhotos(), shown = ph.chosen || ph.all, n = 0;
    if (!S.fsOpen) S.fsOpen = on ? { top: true } : { link: true };
    var h = '<section class="pa-card fs-head" aria-label="Front store"><div class="fs-headrow"><div><p class="pa-h2" style="margin:0">Your front store <span class="pa-pill" style="vertical-align:2px;margin-left:6px;background:' + (on ? '#d4f5f2;color:#065e58' : '#eef2f2;color:#333') + '">' + (on ? '● On' : '○ Off') + '</span></p>' +
      '<p class="pa-hint" style="margin:2px 0 0">Your own page that sells only ' + esc(S.prop.resortName || 'your property') + '. Work through the steps; the preview shows what guests see as you type. Nothing changes for guests until you tap <b>Save front store</b>.</p></div>' +
      '<div class="pa-actions"><button type="button" class="pa-btn teal" data-act="fsFill">✨ Fill in my store</button><button type="button" class="pa-btn" data-act="saveFront">Save front store</button>' +
      (on ? '<a class="pa-btn ghost pa-linkbtn" href="' + esc(F.url) + '" target="_blank" rel="noopener">View my front store</a>' : '') + '</div></div>' +
      '<p class="fs-dirty" id="fs-dirty" role="status"' + (S.fsDirty ? '' : ' hidden') + '>⚠ Changes not saved yet</p>' + (S.fsFillMsg ? '<p class="pa-hint" role="status" style="margin:6px 0 0">' + esc(S.fsFillMsg) + '</p>' : '') + '</section>';
    h += '<div class="fs-wrap"><div class="fs-steps">';
    // 1 link
    h += fsStep('link', ++n, 'Switch on and link', on ? '✓ On · /stay/' + esc(st.slug) : 'Off',
      '<div class="pa-field"><label class="pa-label" for="fs-slug">Link name</label><div class="pa-copy"><span style="align-self:center;font-size:13px;color:#5f6b6e;white-space:nowrap">go.avantetravel.co.za/stay/</span><input id="fs-slug" type="text" value="' + esc(st.slug) + '" maxlength="60" autocapitalize="off" spellcheck="false"></div></div>' +
      '<label class="pa-check" style="min-height:44px;margin-top:8px"><input type="checkbox" id="fs-on"' + (on ? ' checked' : '') + '> Front store switched on</label><p class="pa-hint">Switched off = nobody can open the page. You can build it first and switch it on when it looks right.</p>');
    // 2 top
    var auto = fsAutoPrice(st);
    h += fsStep('top', ++n, 'Top of the page', st.headline ? '✓ ' + esc(st.headline) : 'Headline, price and rating',
      '<div class="pa-field"><label class="pa-label" for="fs-headline">Headline (the big words on the photo)</label><input id="fs-headline" type="text" maxlength="80" value="' + esc(st.headline) + '" placeholder="e.g. Your getaway in ' + esc(fsPlace() || 'the bush') + '"></div>' +
      '<p class="pa-hint">Empty = your property name. Short and specific works best: what guests get, where.</p>' +
      '<div class="pa-field" style="margin-top:10px"><label class="pa-label" for="fs-welcome">Line under the headline</label><input id="fs-welcome" type="text" maxlength="160" value="' + esc(st.welcome) + '" placeholder="e.g. Self-catering cottages 10 minutes from the dam"></div>' +
      '<div class="pa-field" style="margin-top:10px"><label class="pa-label" for="fs-pricefrom">Price badge</label><input id="fs-pricefrom" type="text" maxlength="40" value="' + esc(st.priceFrom) + '" placeholder="' + esc(auto || 'Switch on prices in step 7') + '"></div>' +
      '<p class="pa-hint">Empty = your lowest price a night from ' + (isCh() ? 'Avante' : 'Reservation settings') + (auto ? ' (' + esc(auto) + ')' : '') + '. Only shows when prices are switched on.</p>' +
      '<fieldset class="pa-fieldset" style="margin-top:10px"><legend class="pa-label">Google rating badge (optional)</legend><div class="pa-form">' +
      '<div class="pa-field"><label class="pa-label" for="fs-rv">Stars (0 to 5)</label><input id="fs-rv" type="text" inputmode="decimal" maxlength="3" value="' + esc(st.ratingValue) + '" placeholder="e.g. 4.6"></div>' +
      '<div class="pa-field"><label class="pa-label" for="fs-rc">Number of reviews</label><input id="fs-rc" type="text" inputmode="numeric" maxlength="12" value="' + esc(st.ratingCount) + '" placeholder="e.g. 212"></div></div>' +
      '<div class="pa-field" style="margin-top:8px"><label class="pa-label" for="fs-rl">Link to your Google reviews</label><input id="fs-rl" type="url" maxlength="400" value="' + esc(st.ratingLink) + '" placeholder="https://…"></div>' +
      '<p class="pa-hint">Copy the stars and number from your Google listing. Empty stars = no badge.</p></fieldset>');
    // 3 photos
    var ph3 = ph.all.length ? '<div class="pa-photos">' + ph.all.slice().sort(function (a, b) { var ia = shown.indexOf(a), ib = shown.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); }).map(function (u) {
      var i = shown.indexOf(u), mine = (F.uploadedPhotos || []).indexOf(u) >= 0;
      return '<div class="pa-photo' + (i < 0 ? ' off' : '') + (i === 0 ? ' cover' : '') + '"><img src="' + esc(u) + '" alt="" loading="lazy"><div class="pa-actions" style="gap:4px;padding:6px">' +
        '<label class="pa-check" style="font-size:12.5px"><input type="checkbox" data-fsphoto="' + esc(u) + '"' + (i >= 0 ? ' checked' : '') + '> ' + (i === 0 ? '★ Cover' : 'Show') + '</label>' +
        (i > 0 ? '<button type="button" class="pa-btn small ghost" data-act="fsUp" data-u="' + esc(u) + '" aria-label="Move earlier">↑</button>' : '') +
        (i >= 0 ? '<button type="button" class="pa-btn small ghost" data-act="fsMove" data-u="' + esc(u) + '" aria-label="Move this photo in its frame">✥ Move</button>' : '') +
        (mine ? '<button type="button" class="pa-btn small danger" data-act="fsDel" data-u="' + esc(u) + '" aria-label="Delete photo">✕</button>' : '') + '</div></div>';
    }).join('') + '</div>' : '<p class="pa-hint">No photos yet. Upload some, or find some on Google below.</p>';
    h += fsStep('photos', ++n, 'Photos', shown.length + ' photo' + (shown.length === 1 ? '' : 's') + ' showing',
      '<p class="pa-hint" style="margin:0">' + (ph.chosen ? 'Your own choice and order.' : 'Automatic: your uploaded photos, then Avante\'s.') + ' The first photo is the big one at the top (★ Cover). The next five make the photo block under it.</p>' +
      '<div class="pa-actions" style="margin-top:8px"><button type="button" class="pa-btn small" data-act="fsUpload">Upload photo</button><input type="file" id="fs-file" accept="image/jpeg,image/png,image/webp" style="display:none">' + (ph.chosen ? '<button type="button" class="pa-btn small ghost" data-act="fsAuto">Back to automatic</button>' : '') + '</div>' + ph3 +
      '<p class="pa-label" style="margin:14px 0 4px"><label for="fs-plink">Add a photo by link</label></p><div class="pa-copy"><input type="url" id="fs-plink" placeholder="https://… (one or more links, e.g. from your Avante listing)"><button type="button" class="pa-btn small" data-act="fsLink">Add photo</button></div>' +
      '<p class="pa-hint" style="margin:4px 0 0">Paste the link of a photo that is already online (it starts with https://). Several links? Put a space between them.</p>' +
      '<p class="pa-label" style="margin:14px 0 4px">Find photos on Google</p>' + fsGoogleBox('gallery', (S.prop.resortName || '') + ' ' + fsPlace()));
    // 4 highlights
    var hl = (st.highlights || []).slice(); while (hl.length < 6) hl.push('');
    h += fsStep('hl', ++n, 'Highlights', hl.filter(Boolean).length + ' of 6',
      '<p class="pa-hint" style="margin:0">Short things guests look for, e.g. <i>Swimming pool</i>, <i>Sleeps 6</i>, <i>Pet friendly</i>. Up to 6, 40 letters each.</p><div class="fs-hlgrid">' +
      hl.map(function (x, i) { return '<input type="text" maxlength="40" data-fshl="' + i + '" value="' + esc(x) + '" aria-label="Highlight ' + (i + 1) + '" placeholder="Highlight ' + (i + 1) + '">'; }).join('') + '</div>');
    // 5 units
    var ui = st.unitInfo || {}, hidU = st.hiddenUnits || [];
    h += fsStep('units', ++n, 'Your units', (F.units.length - hidU.length) + ' of ' + F.units.length + ' showing',
      '<p class="pa-hint" style="margin:0">' + (isCh() ? 'Each unit gets a card with a photo, sleeps and beds. Guests see the Avante price when they choose their dates.' : 'Each unit gets a card with a photo, sleeps, beds and its price a night (from Reservation settings).') + '</p>' + F.units.map(function (u, ix) {
        var x = ui[u.name] || {}, off = hidU.indexOf(u.name) >= 0;
        return '<div class="fs-unit' + (off ? ' off' : '') + '"><label class="pa-check"><input type="checkbox" data-fsunit="' + esc(u.name) + '"' + (off ? '' : ' checked') + '> <b>' + esc(u.name) + '</b>' + (u.size ? ' <span class="pa-hint">· ' + esc(u.size) + '</span>' : '') + '</label>' +
          '<p class="pa-hint" style="margin:2px 0 6px">' + (u.price > 0 ? 'Price: ' + money(u.price) + ' a night' + (st.showPrices ? '' : ' (prices are switched off in step 7)') : (isCh() ? 'Price: the Avante price, shown when guests choose dates.' : 'No price yet: add it in Channels → Reservation settings.')) + '</p>' +
          '<div class="pa-form"><div class="pa-field"><label class="pa-label" for="fs-ub-' + ix + '">Beds</label><input id="fs-ub-' + ix + '" type="text" maxlength="80" data-fsui="' + esc(u.name) + '|beds" value="' + esc(x.beds) + '" placeholder="e.g. 1 queen, 2 singles"></div>' +
          '<div class="pa-field"><label class="pa-label" for="fs-ux-' + ix + '">One line about it</label><input id="fs-ux-' + ix + '" type="text" maxlength="300" data-fsui="' + esc(u.name) + '|blurb" value="' + esc(x.blurb) + '" placeholder="e.g. Private braai and dam views"></div></div>' +
          '<p class="pa-label" style="margin:8px 0 4px">Photo for this unit' + (x.photo ? '' : ' <span class="pa-hint" style="text-transform:none;letter-spacing:0">(none chosen: a gallery photo is used)</span>') + '</p>' +
          (shown.length ? fsThumbs(x.photo, 'data-act="fsUnitPhoto" data-unit="' + esc(u.name) + '"', shown.slice(0, 24)) : '<p class="pa-hint">Add photos in step 3 first.</p>') + '</div>';
      }).join(''));
    // 6 things to do
    var acts = (S.fpv && S.fpv.nearby) || [], hidA = st.actHidden || [], ap = st.actPhotos || {};
    var actsBody = '<div class="pa-row"><label class="pa-check"><input type="checkbox" id="fs-acts"' + (st.showActivities ? ' checked' : '') + '> Show things to do on the page</label>' +
      '<div class="pa-field" style="flex:0 1 200px"><label class="pa-label" for="fs-km">Within</label><select id="fs-km">' + [5, 10, 20, 30, 50, 75, 100, 150].map(function (k) { return '<option value="' + k + '"' + (+st.nearbyKm === k ? ' selected' : '') + '>' + k + ' km</option>'; }).join('') + '</select></div></div>' +
      '<div class="pa-field" style="margin-top:10px"><label class="pa-label" for="fs-area">Your area (things to do are found from here)</label><input id="fs-area" type="text" list="fs-areas" autocomplete="off" value="' + esc(st.actPlace ? fsAreaLabel(st.actPlace) : '') + '" placeholder="' + esc((S.fpv && S.fpv.area ? 'Automatic: ' + fsAreaLabel(S.fpv.area) : 'Type your town or suburb')) + '"><datalist id="fs-areas">' + (S.fsAreas || []).map(function (a) { return '<option value="' + esc(fsAreaLabel(a)) + '">'; }).join('') + '</datalist></div>' +
      '<p class="pa-hint">Empty = automatic: your map pin, or your town in the location tree. Type a few letters and pick your suburb or town from the list.' + (S.fsAreaErr ? ' <b style="color:#8a3a00">' + esc(S.fsAreaErr) + '</b>' : '') + '</p>' +
      '<p class="pa-hint">Guests see <b>10 of these, picked at random</b> on every visit, closest first. They can pick another distance on the page. Untick one to never show it. Tap <b>Change photo</b> to pick a map photo, a Google photo or your own; <b>Move photo</b> to choose which part shows.</p>';
    if (!S.fpv || S.fsActsBusy) actsBody += '<p class="pa-hint" role="status">Loading things to do…</p>';
    else if (!acts.length) actsBody += '<p class="pa-hint">' + (S.fpv.area || st.actPlace ? 'Nothing on the Avante map within ' + esc(st.nearbyKm) + ' km yet. Try a bigger distance.' : 'We don\'t know where your property is yet: type your area above.') + '</p>';
    else {
      // On the page now: kept ones stay, the rest are random (Jean, 2026-10-14).
      var pins = st.actPinned || [], onPage = fsPageActs();
      actsBody += '<div class="fs-onpage"><p class="pa-label" style="margin:12px 0 2px">On your page now (' + onPage.length + ')</p>' +
        '<p class="pa-hint" style="margin:0 0 6px">📌 Kept = you chose it, it stays. 🔀 Random = guests get a new random pick on every visit. Tap <b>Swap</b> to choose another one: that one then stays.</p>' +
        onPage.map(function (i) { var a = acts[i], kept = pins.indexOf(a.name) >= 0, sw = S.fsSwap === i;
          var others = acts.map(function (b, k) { return k; }).filter(function (k) { return onPage.indexOf(k) < 0 && hidA.indexOf(acts[k].name) < 0; });
          return '<div class="fs-oprow"><span class="fs-optag">' + (kept ? '📌 Kept' : '🔀 Random') + '</span><span class="grow"><b>' + esc(a.name) + '</b> <span class="pa-hint">' + esc(a.distance || '') + '</span></span>' +
            '<span class="pa-actions" style="gap:4px">' + (kept ? '<button type="button" class="pa-btn small ghost" data-act="fsPin" data-name="' + esc(a.name) + '" data-on="0">Let it be random</button>' : '<button type="button" class="pa-btn small ghost" data-act="fsPin" data-name="' + esc(a.name) + '" data-on="1"' + (pins.length >= 10 ? ' disabled' : '') + '>Keep</button>') +
            '<button type="button" class="pa-btn small' + (sw ? '' : ' ghost') + '" data-act="fsSwapOpen" data-i="' + i + '" aria-expanded="' + sw + '">Swap</button></span>' +
            (sw ? '<div class="fs-swap"><label class="pa-label" for="fs-swapsel">Show this instead</label><div class="pa-copy"><select id="fs-swapsel">' + others.map(function (k) { return '<option value="' + k + '">' + esc(acts[k].name) + ' · ' + esc(acts[k].distance || '') + '</option>'; }).join('') + '</select>' +
              '<button type="button" class="pa-btn small teal" data-act="fsSwapDo" data-old="' + esc(a.name) + '">Choose</button></div></div>' : '') + '</div>';
        }).join('') + '</div><p class="pa-label" style="margin:14px 0 2px">All things to do within ' + esc(st.nearbyKm) + ' km</p>';
    }
    if (S.fpv && !S.fsActsBusy && acts.length) actsBody += acts.map(function (a, i) {
      var photo = ap[a.name] || a.autoPhoto || a.basePhoto, off = hidA.indexOf(a.name) >= 0, gt = 'act:' + i, open = S.fsActOpen === i;
      var body = '';
      if (open) {
        var mp = (a.mapPhotos || []).filter(function (u, k, l) { return u && l.indexOf(u) === k; });
        body = '<div class="fs-actpick">' + (mp.length ? '<p class="pa-label" style="margin:8px 0 4px">Photos on the Avante map</p>' + fsThumbs(photo, 'data-act="fsActUse" data-name="' + esc(a.name) + '"', mp) : '') +
          fsActChoices(i, a, photo) +
          '<div class="pa-actions" style="margin-top:8px"><button type="button" class="pa-btn small ghost" data-act="fsActUp" data-name="' + esc(a.name) + '">Upload my own photo</button><button type="button" class="pa-btn small ghost" data-act="fsActPick" data-i="' + i + '">Close</button></div></div>';
      }
      return '<div class="fs-act' + (off ? ' off' : '') + '"><div class="fs-actimg"' + (photo ? ' style="background-image:url(\'' + esc(photo) + '\')' + fsPosCss(photo) + '"' : '') + '>' + (photo ? '' : '<span>No photo</span>') + '</div>' +
        '<div class="grow"><label class="pa-check"><input type="checkbox" data-fsact="' + esc(a.name) + '"' + (off ? '' : ' checked') + '> <b>' + esc(a.name) + '</b></label><span class="pa-hint">' + esc(a.distance || '') + (a.area ? ' · ' + esc(a.area) : '') + '</span>' +
        (photo ? '' : '<span class="pa-hint"><b>Not shown to guests until it has a photo.</b> Tap Change photo to give it one.</span>') +
        '<div class="pa-actions" style="margin-top:6px"><button type="button" class="pa-btn small' + (open ? '' : ' ghost') + '" data-act="fsActPick" data-i="' + i + '" aria-expanded="' + open + '">Change photo</button>' +
        (photo ? '<button type="button" class="pa-btn small ghost" data-act="fsMove" data-u="' + esc(photo) + '">Move photo</button>' : '') +
        (ap[a.name] ? '<button type="button" class="pa-btn small ghost" data-act="fsActReset" data-name="' + esc(a.name) + '">' + (a.autoPhoto ? 'Back to the automatic photo' : 'Remove my photo') + '</button>' : '') + '</div>' +
        body + '</div></div>';
    }).join('');
    actsBody += '<input type="file" id="fs-actfile" accept="image/jpeg,image/png,image/webp" style="display:none">';
    h += fsStep('acts', ++n, 'Things to do nearby', st.showActivities ? (S.fpv ? acts.filter(function (a) { return hidA.indexOf(a.name) < 0; }).length + ' within ' + esc(st.nearbyKm) + ' km · 10 shown at random' : esc(st.nearbyKm) + ' km') : 'Switched off', actsBody);
    // 7 what shows
    h += fsStep('shows', ++n, 'What shows on the page', '', '<div class="pa-form">' +
      [['fs-prices', 'showPrices', 'Prices'], ['fs-cal', 'showCalendar', 'Availability calendar'], ['fs-offers', 'showOffers', 'Your special offers (hooks you manage yourself)']].map(function (x) {
        return '<label class="pa-check"><input type="checkbox" id="' + x[0] + '"' + (st[x[1]] ? ' checked' : '') + '> ' + x[2] + '</label>'; }).join('') + '</div>' +
      '<div class="pa-field" style="margin-top:10px;max-width:240px"><label class="pa-label" for="fs-notice">Book at least … days ahead</label><input id="fs-notice" type="number" min="0" max="30" value="' + esc(st.minNoticeDays || 0) + '"></div>' +
      '<p class="pa-hint">0 days ahead means guests can book for tonight. ' + (isCh() ? 'Your minimum stay and other rules come from your channel manager through Avante.' : 'Your minimum stay and calendar start date (Channels) also apply.') + '</p>');
    // 8 words + contact
    h += fsStep('words', ++n, 'Words and contact details', '',
      '<div class="pa-field"><label class="pa-label" for="fs-desc">About the property</label><textarea id="fs-desc" rows="6" placeholder="' + esc(F.snDescription ? 'Empty = your Avante description is used' : 'Tell guests about your property') + '">' + esc(st.description) + '</textarea></div>' +
      '<div class="pa-form" style="margin-top:10px"><div class="pa-field"><label class="pa-label" for="fs-phone">Phone</label><input id="fs-phone" type="tel" value="' + esc(st.phone) + '" placeholder="' + esc(F.propertyPhone || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="fs-wa">WhatsApp number</label><input id="fs-wa" type="tel" value="' + esc(st.whatsapp) + '" placeholder="Empty = the phone number"></div>' +
      '<div class="pa-field"><label class="pa-label" for="fs-email">Email</label><input id="fs-email" type="text" inputmode="email" value="' + esc(st.email) + '" placeholder="' + esc(F.propertyEmail || 'name@example.com, other@example.com') + '"></div></div>' +
      '<p class="pa-hint">' + (isCh() ? 'Empty boxes use the email and phone on your Bookings tab.' : 'Empty boxes use your Reservation settings (Channels).') + '</p>');
    // 9 guest page
    h += fsStep('guest', ++n, 'Guest page and room card', st.wifiName ? '✓ Wi-Fi added' : 'Not on the public page',
      '<p class="pa-hint" style="margin:0">Only on the guest page and the printed room card, not on the public front store.</p>' +
      '<div class="pa-form"><div class="pa-field"><label class="pa-label" for="fs-wifi">Wi-Fi network</label><input id="fs-wifi" type="text" value="' + esc(st.wifiName) + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="fs-wifipw">Wi-Fi password</label><input id="fs-wifipw" type="text" value="' + esc(st.wifiPassword) + '"></div></div>' +
      '<div class="pa-field" style="margin-top:10px"><label class="pa-label" for="fs-notes">Good to know (house info)</label><textarea id="fs-notes" rows="5" placeholder="e.g. Check-out by 10:00. Braai wood at reception. Gate code 1234. Quiet time after 22:00.">' + esc(st.guestNotes) + '</textarea></div>');
    h += '<div class="pa-row" style="margin:6px 0 18px"><button type="button" class="pa-btn" data-act="saveFront">Save front store</button></div>';
    if (on) {
      h += '<section class="pa-card" aria-label="Links and QR codes"><p class="pa-h2">Links and QR codes</p><div class="pa-qrgrid">' +
        '<div class="pa-qr"><div class="pa-qrbox">' + qrSvg(F.url, 150) + '</div><b>Front store</b><span class="pa-hint">For your website, Instagram bio, WhatsApp status, flyers and guests.</span>' + linkRow('Link', F.url) +
        '<div class="pa-actions" style="margin-top:8px"><button type="button" class="pa-btn small ghost" data-act="dlQr" data-url="' + esc(F.url) + '" data-name="front-store">Download QR</button><a class="pa-btn small ghost pa-linkbtn" href="https://wa.me/?text=' + encodeURIComponent('Book ' + (S.prop.resortName || 'with us') + ' direct: ' + F.url) + '" target="_blank" rel="noopener">Share on WhatsApp</a></div></div>' +
        '<div class="pa-qr"><div class="pa-qrbox">' + qrSvg(F.guestUrl, 150) + '</div><b>Guest page (in-house guests)</b><span class="pa-hint">Contact details, Wi-Fi, house info and things to do. For guests who are staying.</span>' + linkRow('Link', F.guestUrl) +
        '<div class="pa-actions" style="margin-top:8px"><button type="button" class="pa-btn small ghost" data-act="dlQr" data-url="' + esc(F.guestUrl) + '" data-name="guest-page">Download QR</button><a class="pa-btn small teal pa-linkbtn" href="' + esc(F.cardUrl) + '" target="_blank" rel="noopener">🖨️ Print room card</a><button type="button" class="pa-btn small ghost" data-act="fsNewKey">New guest link</button></div></div></div>' +
        '<p class="pa-hint" style="margin:10px 0 0">The room card has the guest page QR, your contact details and Wi-Fi, and a small QR to book the next stay. Print one for every room. The guest page link is secret (Wi-Fi is on it): only give it to guests. <b>New guest link</b> makes a new one; old cards and links then stop showing Wi-Fi and house info.</p></section>';
      var s1 = F.stats.thisMonth || {}, s0 = F.stats.lastMonth || {};
      h += '<div class="pa-stats"><div class="pa-stat" style="background:#0e2f44;color:#fff"><b>' + (s1.visits || 0) + '</b><span style="color:#d6e2e9">front store visits this month (last month ' + (s0.visits || 0) + ')</span></div>' +
        '<div class="pa-stat" style="background:#f4fbfa;border:1.5px solid #e3e9e8"><b style="color:#0e2f44">' + (s1.bookings || 0) + '</b><span>bookings from the front store this month (last month ' + (s0.bookings || 0) + ')</span></div>' +
        '<div class="pa-stat" style="background:#fff4e5;border:1.5px solid #f5c98a;color:#6b3a00"><b>' + (s1.guestVisits || 0) + '</b><span>guest page visits this month</span></div></div>';
    }
    h += '</div><div class="fs-pvslot" id="fs-pvslot" aria-hidden="true"></div></div>';
    h += '<button type="button" class="fs-pvbtn" data-act="fsPvOpen">👁 Preview</button>';
    if (S.fsMove) {
      var mv = S.fsMove;
      h += '<div class="fs-mv" role="dialog" aria-modal="true" aria-labelledby="fs-mv-t"><div class="fs-mvbox"><b id="fs-mv-t">Move the photo</b><p class="pa-hint" style="margin:2px 0 10px">Drag the photo to choose which part shows, or use the arrows. It changes everywhere this photo is used on your front store.</p>' +
        '<div class="fs-mvframe" id="fs-mvframe" style="background-image:url(\'' + esc(mv.u) + '\');background-position:' + mv.x + '% ' + mv.y + '%"></div>' +
        '<div class="pa-actions" style="margin-top:10px;justify-content:center"><button type="button" class="pa-btn small ghost" data-act="fsMvStep" data-dx="-10" data-dy="0" aria-label="Show more of the left">←</button><button type="button" class="pa-btn small ghost" data-act="fsMvStep" data-dx="0" data-dy="-10" aria-label="Show more of the top">↑</button><button type="button" class="pa-btn small ghost" data-act="fsMvStep" data-dx="0" data-dy="10" aria-label="Show more of the bottom">↓</button><button type="button" class="pa-btn small ghost" data-act="fsMvStep" data-dx="10" data-dy="0" aria-label="Show more of the right">→</button><button type="button" class="pa-btn small ghost" data-act="fsMvCentre">Centre</button></div>' +
        '<div class="pa-actions" style="margin-top:12px;justify-content:flex-end"><button type="button" class="pa-btn ghost" data-act="fsMvCancel">Cancel</button><button type="button" class="pa-btn" data-act="fsMvDone">Done</button></div></div></div>';
    }
    return h;
  }
  function collectFront() {
    var F = S.front, b = {};
    var g = function (id) { var el = document.getElementById(id); return el ? el : null; };
    if (!g('fs-slug')) return null;
    var all = function (sel) { return [].slice.call(root.querySelectorAll(sel)); };
    b.slug = g('fs-slug').value; b.on = g('fs-on').checked;
    b.showPrices = g('fs-prices').checked; b.showCalendar = g('fs-cal').checked; b.showActivities = g('fs-acts').checked; b.showOffers = g('fs-offers').checked;
    b.nearbyKm = +g('fs-km').value; b.minNoticeDays = g('fs-notice').value;
    b.hiddenUnits = all('[data-fsunit]').filter(function (x) { return !x.checked; }).map(function (x) { return x.dataset.fsunit; });
    b.welcome = g('fs-welcome').value; b.description = g('fs-desc').value; b.phone = g('fs-phone').value; b.whatsapp = g('fs-wa').value; b.email = g('fs-email').value;
    b.wifiName = g('fs-wifi').value; b.wifiPassword = g('fs-wifipw').value; b.guestNotes = g('fs-notes').value;
    b.headline = g('fs-headline').value; b.priceFrom = g('fs-pricefrom').value; b.ratingValue = g('fs-rv').value.replace(',', '.').trim(); b.ratingCount = g('fs-rc').value; b.ratingLink = g('fs-rl').value.trim();
    b.highlights = all('[data-fshl]').map(function (x) { return x.value.trim(); }).filter(Boolean);
    var ui = {}, old = F.settings.unitInfo || {};
    F.units.forEach(function (u) { ui[u.name] = { photo: (old[u.name] || {}).photo || '', beds: '', blurb: '' }; });
    all('[data-fsui]').forEach(function (x) { var p = x.dataset.fsui.split('|'), k = p.pop(), n = p.join('|'); if (ui[n]) ui[n][k] = x.value; });
    b.unitInfo = ui;
    if (S.fpv) { var shownA = all('[data-fsact]'); var hid = (F.settings.actHidden || []).filter(function (n) { return !shownA.some(function (x) { return x.dataset.fsact === n; }); }); shownA.forEach(function (x) { if (!x.checked) hid.push(x.dataset.fsact); }); b.actHidden = hid; }
    b.actPhotos = F.settings.actPhotos || {};
    b.actPlace = F.settings.actPlace || null;
    b.actPinned = F.settings.actPinned || [];
    b.photoPos = F.settings.photoPos || {};
    b.photos = F.settings.photos; // changed by the photo controls directly
    return b;
  }
  // What the preview shows: the page as the server builds it (S.fpv), with the
  // boxes as they are now (not saved yet) on top.
  function fsDraft() {
    var F = S.front, st = F.settings, d = Object.assign({}, S.fpv), ph = frontPhotos(), hid = st.hiddenUnits || [], ui = st.unitInfo || {};
    d.name = S.prop.resortName || d.name; d.slug = st.slug || d.slug;
    ['welcome', 'headline', 'showPrices', 'showCalendar', 'showActivities', 'showOffers'].forEach(function (k) { d[k] = st[k]; });
    d.description = st.description || F.snDescription || S.fpv.description || '';
    d.photos = (ph.chosen && ph.chosen.length ? ph.chosen : ph.all).slice(0, 24);
    d.highlights = (st.highlights || []).filter(Boolean);
    d.units = F.units.filter(function (u) { return hid.indexOf(u.name) < 0; }).map(function (u) { var x = ui[u.name] || {}; return { name: u.name, size: u.size || '', photo: x.photo || '', beds: x.beds || '', blurb: x.blurb || '', price: st.showPrices && u.price > 0 ? u.price : 0 }; });
    d.priceFrom = st.showPrices ? (st.priceFrom || fsAutoPrice(st)) : '';
    d.rating = /^[0-5](\.\d)?$/.test(st.ratingValue || '') ? { value: st.ratingValue, count: st.ratingCount || '', link: /^https:\/\//.test(st.ratingLink || '') ? st.ratingLink : '' } : null;
    var wa = String(st.whatsapp || st.phone || F.propertyPhone || '').replace(/\D/g, ''); if (wa.indexOf('00') === 0) wa = wa.slice(2); if (wa.charAt(0) === '0') wa = '27' + wa.slice(1);
    d.contact = { phone: st.phone || F.propertyPhone || '', whatsapp: wa.length >= 9 ? wa : '', email: st.email || F.propertyEmail || '' };
    var hidA = st.actHidden || [], ap = st.actPhotos || {};
    var all = S.fpv.nearby || [];
    d.nearby = fsPageActs()
      .map(function (i) { return Object.assign({}, all[i], { photo: ap[all[i].name] || all[i].autoPhoto || all[i].basePhoto || '' }); });
    d.offers = st.showOffers ? (S.fpv.offers || []) : [];
    d.mapActs = (S.fpv.nearby || []).filter(function (a) { return hidA.indexOf(a.name) < 0 && (ap[a.name] || a.autoPhoto || a.basePhoto); }).map(function (a) { return Object.assign({}, a, { photo: ap[a.name] || a.autoPhoto || a.basePhoto || '' }); });
    d.photoPos = st.photoPos || {};
    return d;
  }

  // ---- Front store builder: live preview panel ----
  // One iframe for the whole session (kept on <body>, so a re-render of the
  // tab doesn't reload it). It sits over the empty column next to the steps
  // (#fs-pvslot); on phones it opens full screen from the Preview button.
  var PV = null, pvTimer = null, pvTick = 0;
  function pvEnsure() {
    if (PV) return PV;
    var box = document.createElement('div');
    box.className = 'fs-pv'; box.style.display = 'none';
    box.innerHTML = '<div class="fs-pvbar"><b>Live preview</b><span class="fs-pvseg" role="group" aria-label="Preview size"><button type="button" data-pvw="phone" aria-pressed="true">📱 Phone</button><button type="button" data-pvw="desk" aria-pressed="false">💻 Computer</button></span>' +
      '<button type="button" class="fs-pvclose" data-pvclose aria-label="Close preview">✕ Close</button></div><div class="fs-pvstage"><iframe title="Front store preview" src="/stay.html?preview=1"></iframe><p class="fs-pvload" role="status">Loading preview…</p></div>';
    document.body.appendChild(box);
    PV = { box: box, frame: box.querySelector('iframe'), ready: false, w: 'phone', full: false };
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.pvw) { PV.w = b.dataset.pvw; [].forEach.call(box.querySelectorAll('[data-pvw]'), function (x) { x.setAttribute('aria-pressed', String(x === b)); }); pvFollow(); }
      if (b.hasAttribute('data-pvclose')) { PV.full = false; pvFollow(); var pb = root.querySelector('.fs-pvbtn'); if (pb) pb.focus(); }
    });
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'fs-preview-ready' || e.source !== PV.frame.contentWindow) return;
      PV.ready = true; pvSend();
    });
    window.addEventListener('resize', pvFollowSoon);
    document.addEventListener('scroll', pvFollowSoon, true);
    document.addEventListener('visibilitychange', function () { pvWatch(); if (!document.hidden) pvFollow(); });
    return PV;
  }
  // While the Front store tab is open (and the browser tab is visible), check
  // the preview's place every 600ms: this also notices the hub switching to
  // another panel. Stopped on every other view, so it costs nothing there.
  function pvWatch() {
    var want = !!PV && S.view === 'front' && !document.hidden;
    if (want && !pvTick) pvTick = setInterval(pvFollow, 600);
    else if (!want && pvTick) { clearInterval(pvTick); pvTick = 0; }
  }
  var pvRaf = 0;
  function pvFollowSoon() { if (!pvRaf) pvRaf = requestAnimationFrame(function () { pvRaf = 0; pvFollow(); }); }
  function pvFollow() {
    if (!PV) return;
    var box = PV.box, slot = document.getElementById('fs-pvslot');
    var live = S.view === 'front' && slot && root.getClientRects().length > 0;
    if (!live) { box.style.display = 'none'; PV.full = false; return; }
    var r = slot.getBoundingClientRect(), wide = r.width > 200;
    if (!wide && !PV.full) { box.style.display = 'none'; return; }
    box.classList.toggle('full', !wide);
    var top, left, width, height;
    if (wide) {
      var bar = root.querySelector('.pa-tabbar'), barB = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
      top = Math.max(r.top, barB + 8); var bottom = Math.min(window.innerHeight - 10, r.bottom);
      left = r.left; width = r.width; height = bottom - top;
      if (height < 120) { box.style.display = 'none'; return; } // short windows: it grows as you scroll
      box.style.cssText = 'display:flex;top:' + top + 'px;left:' + left + 'px;width:' + width + 'px;height:' + height + 'px';
    } else box.style.cssText = 'display:flex';
    // Scale a phone-wide (390px) or computer-wide (1280px) page into the box.
    var stage = box.querySelector('.fs-pvstage'), sw = stage.clientWidth, sh = stage.clientHeight, tw = PV.w === 'desk' ? 1280 : 390;
    var k = Math.min(1, (sw - (PV.w === 'desk' ? 0 : 16)) / tw);
    PV.frame.style.width = tw + 'px'; PV.frame.style.height = Math.round(sh / k) + 'px'; PV.frame.style.transform = 'scale(' + k + ')';
    PV.frame.style.left = Math.max(0, Math.round((sw - tw * k) / 2)) + 'px';
  }
  function pvSend(scrollTo) {
    if (!PV || !PV.ready || !S.fpv || !S.front || S.view !== 'front') return;
    PV.box.classList.add('ok');
    try { PV.frame.contentWindow.postMessage({ type: 'fs-preview', data: fsDraft(), scrollTo: scrollTo || null }, location.origin); } catch (e) {}
  }
  function pvQueue() { clearTimeout(pvTimer); pvTimer = setTimeout(function () { keepFront(); pvSend(); }, 250); }
  function pvAfterRender() {
    if (S.view !== 'front' || !S.front || !S.prop) { if (PV) pvFollow(); pvWatch(); return; }
    pvEnsure(); pvFollow(); pvSend(); pvWatch();
  }
  function fsMarkDirty() { S.fsDirty = true; var el = document.getElementById('fs-dirty'); if (el) el.hidden = false; }
  function fsLoadPreview(km) {
    S.fsActsBusy = true;
    return api('frontPreview', { km: km || (S.front && S.front.settings.nearbyKm) || 30, actPlace: S.front ? S.front.settings.actPlace || null : undefined }).then(function (d) {
      S.fpv = d; S.fsActsBusy = false; S.fsActOpen = null; S.fsAP = null; S.fsSwap = null;
      // The preview shows 10 picked at random, like the real page (same pick until the list reloads).
      var ord = (d.nearby || []).map(function (a, i) { return i; }); for (var k = ord.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)), x = ord[k]; ord[k] = ord[j]; ord[j] = x; } S.fpvOrder = ord;
      if (S.front) { S.front.snPhotos = d.snPhotos || []; S.front.snDescription = d.snDescription || ''; }
      render();
    }).catch(function (e) { S.fsActsBusy = false; fail(e); });
  }
  function fsGoogle(target, q) {
    q = String(q || '').trim(); if (!q) return;
    keepFront(); S.fsG = { target: target, q: q, busy: true }; render();
    return api('frontGoogle', { query: q, limit: 6 }).then(function (d) {
      if (!S.fsG || S.fsG.target !== target) return;
      S.fsG.busy = false; S.fsG.images = d.images || []; S.fsG.place = d.place && d.place.name; render();
    }).catch(function (e) { if (!S.fsG || S.fsG.target !== target) return; S.fsG.busy = false; S.fsG.err = e.message; render(); });
  }
  // Puts a Google photo (data: URL) in the property's own photos: the gallery,
  // or (kind "act") as the photo of one of the things to do.
  function fsAddPhoto(dataUrl, kind) {
    return api('uploadFrontPhoto', { dataUrl: dataUrl, kind: kind || '' }).then(function (d) {
      var keep = S.front.settings, sn = S.front.snPhotos, sd = S.front.snDescription; S.front = d.view; S.front.snPhotos = sn; S.front.snDescription = sd;
      S.front.settings = Object.assign({}, S.front.settings, keep);
      return d.url;
    });
  }
  // "Fill in my store": fills only the empty boxes from what we already know
  // (Stock Network description, units, photos, the Avante map), and finds a
  // Google photo for things to do that have none. Nothing is saved yet.
  var FS_WORDS = [[/pool/i, 'Swimming pool'], [/braai/i, 'Braai area'], [/wi-?fi|internet/i, 'Free Wi-Fi'], [/pet[- ]friendly|pets (are )?welcome/i, 'Pet friendly'], [/self[- ]catering|kitchen/i, 'Self-catering'],
    [/secure parking|parking/i, 'Secure parking'], [/beach|sea view|ocean/i, 'Near the beach'], [/dam\b/i, 'Near the dam'], [/mountain/i, 'Mountain views'], [/golf/i, 'Golf nearby'],
    [/air[- ]?con/i, 'Air-conditioning'], [/fireplace|fire place/i, 'Fireplace'], [/dstv|tv\b/i, 'TV / DStv'], [/game drive|wildlife|bush/i, 'Bush and wildlife'], [/hik(e|ing)|trail/i, 'Hiking trails'], [/spa\b|jacuzzi|hot tub/i, 'Hot tub / spa']];
  function fsFill(btn) {
    var F = S.front; if (!F || !S.fpv) { S.err = 'Wait a moment: the page is still loading.'; return render(); }
    keepFront();
    var st = F.settings, done = [], desc = st.description || F.snDescription || S.fpv.description || '', town = fsPlace();
    if (!st.headline) { st.headline = town ? 'Your getaway in ' + town : (S.prop.resortName || ''); if (st.headline) done.push('headline'); }
    if (!st.welcome && desc) {
      // First sentence of the description, without "<Name> is …" at the start.
      var s1 = ((desc.replace(/\s+/g, ' ').match(/^.{20,200}?[.!?](\s|$)/) || [])[0] || '').trim(), nm = String(S.prop.resortName || '').trim();
      if (nm && s1.toLowerCase().indexOf(nm.toLowerCase() + ' is ') === 0) { s1 = s1.slice(nm.length + 4); s1 = s1.charAt(0).toUpperCase() + s1.slice(1); }
      if (s1 && s1.length <= 160) { st.welcome = s1; done.push('line under the headline'); }
    }
    if (!(st.highlights || []).filter(Boolean).length) {
      var hl = [], sleeps = 0;
      F.units.forEach(function (u) { var m = String(u.size || '').match(/(\d+)/); if (m) sleeps = Math.max(sleeps, +m[1]); });
      if (sleeps) hl.push('Sleeps up to ' + sleeps);
      if (F.units.length > 1) hl.push(F.units.length + ' units to choose from');
      FS_WORDS.forEach(function (w) { if (hl.length < 6 && w[0].test(desc + ' ' + (S.fpv.attractions || '') + ' ' + (S.fpv.moreInfo || '')) && hl.indexOf(w[1]) < 0) hl.push(w[1]); });
      var na = (S.fpv.nearby || []).length; if (hl.length < 6 && na) hl.push(na + ' things to do nearby');
      st.highlights = hl.slice(0, 6); if (hl.length) done.push(hl.length + ' highlights');
    }
    var ph = frontPhotos(), gal = (ph.chosen || ph.all), ui = Object.assign({}, st.unitInfo || {}), nu = 0;
    if (gal.length) F.units.forEach(function (u, i) { var x = Object.assign({}, ui[u.name] || {}); if (!x.photo) { x.photo = gal[(i + 1) % gal.length]; ui[u.name] = x; nu++; } });
    st.unitInfo = ui; if (nu) done.push('photos for ' + nu + ' unit' + (nu === 1 ? '' : 's'));
    // Photos for things to do are found by themselves (library first, then Google) when the list loads.
    var before = (S.fpv.nearby || []).filter(function (a) { return a.autoPhoto; }).length;
    fsMarkDirty(); S.fsFillMsg = 'Filling in… finding photos for things to do.';
    S.fsOpen = { top: true }; F._fresh = true; render(); pvSend('hero');
    fsLoadPreview().then(function () {
      var after = ((S.fpv && S.fpv.nearby) || []).filter(function (a) { return a.autoPhoto; }).length;
      if (after > before) done.push('photos for ' + (after - before) + ' things to do');
      S.fsFillMsg = done.length ? 'Filled in: ' + done.join(', ') + '. Only empty boxes were filled. Check the preview, change what you like, then tap Save front store.' : 'Everything already has something in it, so nothing was changed.';
      render();
    });
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
    if (pay.noMethod) return h + '<p class="pa-err">' + (isCh() ? 'Avante\'s booking system didn\'t send a payment link for this booking. Ask Avante Travel to check it.' : 'No payment method is set up. Add your bank details or allow the payment gateway in Channels → Guest payments.') + '</p></div>';
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
      return h + hdr('Payment for ' + m.ref, 'Avante\'s secure payment page') + '<div class="body">' +
        (m.blocked ? '<p style="margin:0;font-size:14px;line-height:1.55">Your browser blocked the payment window. Open it here:</p>' :
          '<p style="margin:0;font-size:14px;line-height:1.55">The payment page is open in its own window. Complete the payment there, including any bank or Instant EFT steps. When that window closes, the hub checks the payment.</p>') +
        (st === 'checking' ? '<p class="pa-hint">Checking the payment with Avante…</p>' : '') +
        (st === 'unpaid' ? '<div class="pa-lock">Avante\'s booking system doesn\'t show this booking as paid yet. If the payment has just gone through, wait a minute and check again.</div>' : '') +
        '<div class="pa-actions"><a class="pa-btn teal" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(m.url) + '" target="avante-pay" rel="noopener" data-act="reopenPay">' + (m.blocked ? 'Open payment page' : 'Open payment page again') + '</a>' +
        '<button type="button" class="pa-btn" data-act="checkPay"' + (st === 'checking' ? ' disabled' : '') + '>Check payment now</button>' +
        '<button type="button" class="pa-btn ghost" data-act="close">Close</button></div></div></div></div>';
    }
    if (m.done) {
      return h + hdr(m.done.title) + '<div class="body"><p style="margin:0;font-size:14px;line-height:1.55">' + esc(m.done.text) + '</p>' +
        payBlock(m.done.pay) +
        '<button type="button" class="pa-btn" style="align-self:flex-start" data-act="close">Done</button></div></div></div>';
    }
    if (m.type === 'find') {
      h += hdr('Find a Booking') + '<div class="body"><div class="pa-field"><label class="pa-label" for="pa-fq">Reference, guest name, unit or channel</label><input id="pa-fq" type="search" value="' + esc(S.findQ) + '" placeholder="e.g. J111672, Airbnb, FV10"></div>';
      h += (S.found || []).filter(function (b) { return b.status !== 'Cancelled'; }).map(function (b) { return '<div class="pa-result"><div class="grow"><b>' + esc(b.ref) + ' · ' + esc(b.items.filter(function (i) { return !i.cancelled; }).map(function (i) { return i.unit; }).join(', ')) + '</b><div class="pa-hint">' + esc(b.origin === 'channel' ? b.source : ((b.guest && (b.guest.first + ' ' + b.guest.last)) || '')) + ' · ' + b.items.filter(function (i) { return !i.cancelled; }).map(function (i) { return short(i.start) + ' – ' + short(i.end); }).join(', ') + '</div></div><button type="button" class="pa-btn small" data-act="editBooking" data-ref="' + esc(b.ref) + '">Edit</button></div>'; }).join('') || '<p class="pa-hint">No active booking matches.</p>';
      return h + '<p class="pa-hint">Avante\'s booking system can\'t edit a booking. Changing the unit or dates cancels it and makes a new booking with a new reference.</p></div></div></div>';
    }
    var editing = m.type === 'edit', b = S.edit, live = editing ? b.items.filter(function (i) { return !i.cancelled; }) : null, segHtml = '';
    if (editing) {
      var tab = S.bTab || 'guest';
      segHtml = '<div class="pa-seg pa-tabs" role="tablist" aria-label="Booking sections">' + (isCh() ? [['stay', 'Booking']] : [['guest', 'Guest'], ['msgs', 'Messages'], ['stay', 'Booking']]).map(function (x) { return '<button type="button" role="tab" data-act="bTab" data-t="' + x[0] + '" aria-pressed="' + (tab === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
        (S.modalNote ? '<div class="pa-ok" role="status">' + esc(S.modalNote) + '</div>' : '');
      var sub = whoOf(b) + ' · ' + live.map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ');
      if (tab !== 'stay' || b.demo || b.status === 'Cancelled') {
        var bodyHtml = tab === 'guest' ? viewGuestSection(b) : tab === 'msgs' ? viewMsgSection(b)
          : '<div class="pa-items">' + live.map(function (it) { return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + '</b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span></div>'; }).join('') + '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + esc(statusText(b)) + '</span><b>' + money(b.total) + '</b></div></div>' +
            '<p class="pa-hint">' + (b.demo ? 'Demo booking: it isn\'t in Avante\'s booking system, so it can\'t be changed, paid or cancelled. Remove demo bookings from the Bookings tab.' : 'This booking was cancelled.') + '</p>';
        // Cancel is on every section of the booking (paid bookings: request cancellation).
        var cancelBtn = !b.demo && b.status !== 'Cancelled' ? '<button type="button" class="pa-btn danger" data-act="cancelBooking"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Working…' : b.locked ? 'Ask Avante to cancel' : 'Cancel this booking') + '</button>' : '';
        return h + hdr('Booking ' + b.ref, sub) + '<div class="body">' + segHtml + bodyHtml + '<div class="pa-row pa-dlgfoot">' + cancelBtn + '<button type="button" class="pa-btn ghost" data-act="close">Close</button></div></div></div></div>';
      }
    }
    if (editing && b.locked) {
      h += hdr('Booking ' + b.ref + ' · ' + statusText(b));
      h += '<div class="body">' + segHtml + '<div class="pa-items">' + live.map(function (it) { return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + '</b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span></div>'; }).join('') +
        '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + esc(whoOf(b)) + '</span><b>' + money(b.total) + '</b></div></div>' +
        '<div class="pa-lock"><b>' + esc(b.status) + ': locked</b><br>A Paid or Confirmed booking can\'t be changed or cancelled in the hub. The guest must contact the property. To cancel it, tap Ask Avante to cancel: Avante cancels it and the status changes here. Already cancelled it in your channel manager? Still tap it, so Avante can update the booking.</div>' +
        (b.cancelRequest ? '<p class="pa-hint">You asked Avante to cancel it on ' + esc(new Date(b.cancelRequest.at).toLocaleString()) + '. Asking again sends Avante another email.</p>' : '') +
        '<div class="pa-row"><button type="button" class="pa-btn danger" data-act="cancelBooking"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Sending…' : 'Ask Avante to cancel') + '</button><button type="button" class="pa-btn ghost" data-act="close">Close</button></div></div></div></div>';
      return h;
    }
    var items = editing ? live : S.cart, total = 0, short2 = false, g = editing ? (b.guest || {}) : {};
    h += hdr(editing ? 'Edit booking ' + b.ref : (S.cart.length > 1 ? 'New booking · ' + S.cart.length + ' units' : 'New booking'));
    h += '<div class="body">' + segHtml + '<div class="pa-items">' + items.map(function (it, i) {
      var p = priceOf(it.unit, it.start, it.end); total += p || 0; if (S.av && nightsBetween(it.start, it.end) < S.av.minStay) short2 = true; // checked once availability is loaded
      var rm = editing ? (live.length > 1 ? '<button type="button" class="pa-btn small danger" data-act="removeUnit" data-u="' + esc(it.unit) + '">Remove unit</button>' : '') : (S.cart.length > 1 ? '<button type="button" class="pa-btn small danger" data-act="uncart" data-i="' + i + '">Remove</button>' : '');
      return '<div class="pa-item"><b style="flex:1 1 140px;color:#0e2f44">' + esc(it.unit) + ' <span class="pa-hint">· ' + esc(sizeOf(it.unit)) + '</span></b><span style="flex:1 1 170px;font-size:13px">' + short(it.start) + ' – ' + short(it.end) + ' · ' + nw(nightsBetween(it.start, it.end)) + '</span><b>' + money(editing ? null : p) + '</b>' + rm + '</div>';
    }).join('') + (editing ? '' : '<div class="pa-row" style="justify-content:space-between"><span class="pa-label">' + (items.length === 1 ? '1 unit' : items.length + ' units, one reservation') + '</span><b style="font:800 16px Montserrat,sans-serif;color:#0e2f44">Total ' + money(total) + '</b></div>') + '</div>';
    if (editing && live.length === 1) {
      h += '<div class="pa-form"><div class="pa-field"><label class="pa-label" for="pa-eu">Unit</label><select id="pa-eu">' + (S.av ? S.av.units : [{ name: live[0].unit }]).map(function (u) { return '<option' + (u.name === live[0].unit ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
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
      if (!editing && ((S.prop.settings || {}).payMode || 'both') === 'both') h += '<fieldset class="pa-fieldset"><legend class="pa-label">Guest pays by</legend><label class="pa-check pa-radio"><input type="radio" name="pa-payby" value="eft" checked><span><b>EFT or on arrival</b><br><span class="pa-hint">Booked straight away. You record the payment when it arrives.</span></span></label>' +
        '<label class="pa-check pa-radio"><input type="radio" name="pa-payby" value="gateway"><span><b>Payment gateway (pay now)</b><br><span class="pa-hint">Booked; Avante cancels it if the guest doesn\'t pay within the payment time.</span></span></label></fieldset>';
    }
    h += '<p class="pa-hint">' + (editing ? (live.length === 1 ? 'Saving a new unit or new dates cancels ' + b.ref + ' and makes a new booking with a new reference.' : 'Removing a unit cancels only that unit; the booking keeps its reference. To change dates, cancel and book again.') : (items.length > 1 ? 'All units go on one Avante reservation with one reference, as Booked.' : 'Created with Avante as Booked, then blocked on your other channels within 15 minutes.')) + '</p>';
    if (editing && b.origin !== 'channel') h += '<div class="pa-row"><button type="button" class="pa-btn small ghost" data-act="payLink" data-ref="' + esc(b.ref) + '">Payment link</button></div>';
    h += '<div class="pa-row">' + (editing ? (live.length === 1 ? '<button type="button" class="pa-btn" data-act="saveEdit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save changes') + '</button>' : '') + '<button type="button" class="pa-btn danger" data-act="cancelBooking">Cancel this booking</button>'
      : '<button type="button" class="pa-btn" data-act="confirmBook"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Booking…' : (items.length > 1 ? 'Book ' + items.length + ' units' : 'Make booking')) + '</button>') + '<button type="button" class="pa-btn ghost" data-act="close">Close</button></div>';
    return h + '</div></div></div>';
  }


  // ---- Activities (2026-10-12): the property's own activity list, with the
  // supplier's reference numbers, and activity bookings for guests. ----
  var ACT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var ACT_STATUS_CLASS = { 'Requested': 'pa-warn', 'Sent to supplier': 'pa-hint', 'Confirmed': 'pa-okt', 'Cancelled': 'pa-hint' };
  // [id, label, type, hint, width]
  var ACT_FIELDS = [
    ['h', 'The activity'],
    ['name', 'Activity name', 'text', 'e.g. Robberg seal swim'], ['supplier', 'Supplier / operator', 'text', 'Company that runs it'],
    ['category', 'Category', 'text', 'e.g. Water, Adventure, Wine'], ['duration', 'Duration', 'text', 'e.g. 2 hours'],
    ['startTimes', 'Start times', 'text', 'e.g. 08:00, 11:00'], ['meetingPoint', 'Meeting point', 'text', 'Where guests go'],
    ['description', 'Description', 'area', 'What guests will do'], ['whatToBring', 'What to bring', 'text', 'e.g. Towel, sunscreen'],
    ['h', 'Reference numbers (to book it)'],
    ['bookingSystem', 'Booking system', 'system'], ['systemName', 'System name', 'text', 'Name of the booking system'],
    ['supplierRef', 'Operator / supplier account', 'text', 'Activitar: name before .activitar.com · ActivityBridge: supplier ID'], ['productCode', 'Product code / activity ID', 'text', 'Activitar: service nr · ActivityBridge: activity ID'],
    ['optionCode', 'Option / rate code', 'text', 'e.g. Morning trip, adult rate'],
    ['h', 'Price and rules'],
    ['adultPrice', 'Adult price (R)', 'number'], ['childPrice', 'Child price (R)', 'number'], ['childAge', 'Child up to age', 'number'],
    ['netPrice', 'Net price to supplier (R)', 'number'], ['commissionPct', 'Commission %', 'number'],
    ['minPax', 'Minimum people', 'number'], ['maxPax', 'Maximum people', 'number'], ['cutoffHours', 'Book at least … hours before', 'number'],
    ['days', 'Runs on', 'days'], ['pickup', 'Pick-up from the property possible', 'check'],
    ['h', 'How to book it with the supplier'],
    ['bookingUrl', 'Booking link', 'url', 'Paste the Activitar / ActivityBridge link: codes fill in'], ['bookingEmail', 'Booking email', 'text', 'Booking requests are emailed here (several: separate with commas)'], ['bookingPhone', 'Booking phone', 'tel'],
    ['notes', 'Notes for your staff', 'area'], ['active', 'Available to book', 'check'],
  ];
  function loadActivities() { return api('activities').then(function (d) { S.acts = d; render(); }).catch(fail); }
  function actById(id) { return ((S.acts && S.acts.activities) || []).find(function (a) { return a.id === id; }); }
  function actField(f, a) {
    var id = 'pa-a-' + f[0], v = a[f[0]], h = '';
    if (f[2] === 'check') return '<label class="pa-check" style="min-height:44px"><input type="checkbox" id="' + id + '"' + (v || (v === undefined && f[0] === 'active') ? ' checked' : '') + '> ' + esc(f[1]) + '</label>';
    if (f[2] === 'days') return '<fieldset class="pa-fieldset" style="grid-column:1/-1"><legend class="pa-label">' + esc(f[1]) + ' <span class="pa-hint" style="text-transform:none;letter-spacing:0">(none ticked = every day)</span></legend><div class="pa-row" style="gap:4px 14px">' +
      ACT_DAYS.map(function (d) { return '<label class="pa-check"><input type="checkbox" data-actday="' + d + '"' + ((v || []).indexOf(d) >= 0 ? ' checked' : '') + '> ' + d + '</label>'; }).join('') + '</div></fieldset>';
    if (f[0] === 'systemName' && (a.bookingSystem || 'direct') !== 'other') return '';
    h += '<div class="pa-field"' + (f[2] === 'area' ? ' style="grid-column:1/-1"' : '') + '><label class="pa-label" for="' + id + '">' + esc(f[1]) + '</label>';
    if (f[2] === 'system') {
      var sy = (S.acts && S.acts.systems) || { direct: 'Direct with the supplier' };
      h += '<select id="' + id + '" data-actrerender="1">' + Object.keys(sy).map(function (k) { return '<option value="' + k + '"' + ((a.bookingSystem || 'direct') === k ? ' selected' : '') + '>' + esc(sy[k]) + '</option>'; }).join('') + '</select>';
    } else if (f[2] === 'area') h += '<textarea id="' + id + '" rows="3" placeholder="' + esc(f[3] || '') + '">' + esc(v || '') + '</textarea>';
    else h += '<input id="' + id + '" type="' + f[2] + '"' + (f[2] === 'number' ? ' min="0" step="any" inputmode="decimal"' : '') + ' value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(f[3] || '') + '">';
    return h + '</div>';
  }
  function collectAct() {
    var a = Object.assign({}, S.actEdit || {});
    ACT_FIELDS.forEach(function (f) {
      if (f[0] === 'h') return;
      if (f[2] === 'days') { a.days = Array.prototype.slice.call(root.querySelectorAll('[data-actday]:checked')).map(function (x) { return x.dataset.actday; }); return; }
      var el = document.getElementById('pa-a-' + f[0]); if (!el) return;
      a[f[0]] = f[2] === 'check' ? el.checked : el.value;
    });
    return a;
  }
  function viewActEdit() {
    var a = S.actEdit, h = '<section class="pa-card" id="pa-actform"><p class="pa-h2">' + (a.id ? 'Edit ' + esc(a.name) : 'New activity') + '</p>';
    if (a.hubActivityId) h += '<p class="pa-hint">Copied from the hub\'s activity list. Add the supplier\'s reference numbers so it can be booked.</p>';
    var open = false;
    ACT_FIELDS.forEach(function (f) {
      if (f[0] === 'h') { if (open) h += '</div>'; h += '<p class="pa-label" style="margin:16px 0 8px;font-size:12.5px;color:#0e2f44">' + esc(f[1]) + '</p><div class="pa-form">'; open = true; return; }
      h += actField(f, a);
    });
    if (open) h += '</div>';
    h += '<div class="pa-row" style="margin-top:14px"><button type="button" class="pa-btn" data-act="actSave"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save activity') + '</button><button type="button" class="pa-btn ghost" data-act="actCancelEdit">Cancel</button>' +
      (a.id ? '<button type="button" class="pa-btn danger" data-act="actDelete" data-id="' + esc(a.id) + '">Delete</button>' : '') + '</div></section>';
    return h;
  }
  function actPrice(act, ad, ch) { if (act.adultPrice == null || act.adultPrice === '') return null; return Math.round(act.adultPrice * ad + (act.childPrice != null && act.childPrice !== '' ? act.childPrice : act.adultPrice) * ch); }
  function viewActBook() {
    var b = S.actBook, act = actById(b.activityId), list = ((S.acts && S.acts.activities) || []).filter(function (x) { return x.active; });
    var h = '<section class="pa-card" id="pa-actbook"><p class="pa-h2">Book an activity for a guest</p><div class="pa-form">' +
      '<div class="pa-field" style="grid-column:1/-1"><label class="pa-label" for="pa-ab-act">Activity</label><select id="pa-ab-act" data-actrerender="1"><option value="">Choose…</option>' + list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === b.activityId ? ' selected' : '') + '>' + esc(x.name) + (x.supplier ? ' · ' + esc(x.supplier) : '') + '</option>'; }).join('') + '</select></div>';
    if (act) {
      h += '<div class="pa-note" style="grid-column:1/-1">' + [act.supplier, act.productCode && 'Product ' + act.productCode, act.optionCode && 'Option ' + act.optionCode, act.supplierRef && 'Account ' + act.supplierRef, act.days.length && 'Runs ' + act.days.join(', '), act.startTimes && 'Starts ' + act.startTimes, act.minPax && 'Min ' + act.minPax, act.maxPax && 'Max ' + act.maxPax, act.cutoffHours && 'Book ' + act.cutoffHours + ' h ahead'].filter(Boolean).map(esc).join(' · ') + '</div>';
    }
    h += '<div class="pa-field"><label class="pa-label" for="pa-ab-date">Date</label><input id="pa-ab-date" type="date" min="' + today() + '" value="' + esc(b.date || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ab-time">Time</label><input id="pa-ab-time" type="time" value="' + esc(b.time || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ab-ad">Adults</label><input id="pa-ab-ad" type="number" min="0" inputmode="numeric" value="' + esc(b.adults == null ? 2 : b.adults) + '" data-actrerender="1"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ab-ch">Children</label><input id="pa-ab-ch" type="number" min="0" inputmode="numeric" value="' + esc(b.children || 0) + '" data-actrerender="1"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ab-gn">Guest name</label><input id="pa-ab-gn" type="text" value="' + esc(b.guestName || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ab-gc">Guest cellphone</label><input id="pa-ab-gc" type="tel" value="' + esc(b.guestCell || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ab-ge">Guest email</label><input id="pa-ab-ge" type="email" value="' + esc(b.guestEmail || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="pa-ab-sr">Stay booking ref (optional)</label><input id="pa-ab-sr" type="text" value="' + esc(b.stayRef || '') + '" placeholder="Links it to the guest\'s stay"></div>';
    var est = act ? actPrice(act, +b.adults || 0, +b.children || 0) : null;
    h += '<div class="pa-field"><label class="pa-label" for="pa-ab-tot">Total (R)</label><input id="pa-ab-tot" type="number" min="0" step="any" value="' + esc(b.total != null && b.total !== '' ? b.total : est == null ? '' : est) + '"></div>';
    if (act && act.pickup) h += '<label class="pa-check" style="min-height:44px"><input type="checkbox" id="pa-ab-pu"' + (b.pickup ? ' checked' : '') + '> Pick up from the property</label>';
    h += '<div class="pa-field" style="grid-column:1/-1"><label class="pa-label" for="pa-ab-no">Notes for the supplier</label><textarea id="pa-ab-no" rows="2">' + esc(b.notes || '') + '</textarea></div></div>' +
      '<div class="pa-row" style="margin-top:14px"><button type="button" class="pa-btn" data-act="actBookSave"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Booking…' : 'Make activity booking') + '</button><button type="button" class="pa-btn ghost" data-act="actCancelBook">Cancel</button></div></section>';
    return h;
  }
  function collectActBook() {
    var b = S.actBook || {};
    b.activityId = val('pa-ab-act'); b.date = val('pa-ab-date'); b.time = val('pa-ab-time'); b.adults = val('pa-ab-ad'); b.children = val('pa-ab-ch');
    b.guestName = val('pa-ab-gn'); b.guestCell = val('pa-ab-gc'); b.guestEmail = val('pa-ab-ge'); b.stayRef = val('pa-ab-sr'); b.notes = val('pa-ab-no');
    var tot = document.getElementById('pa-ab-tot'); b.total = tot && tot.dataset.touched ? tot.value : undefined;
    var pu = document.getElementById('pa-ab-pu'); b.pickup = !!(pu && pu.checked);
    return b;
  }
  function viewActivities() {
    if (!S.acts) return '<div class="pa-card pa-hint">Loading activities…</div>';
    var A = S.acts, h = '';
    if (S.actEdit) h += viewActEdit();
    if (S.actBook) h += viewActBook();
    // Activity bookings
    var upcoming = A.bookings.filter(function (b) { return b.date >= today() || S.actShowPast; });
    h += '<section class="pa-card"><div class="pa-row" style="justify-content:space-between;align-items:center"><p class="pa-h2" style="margin:0">Activity bookings</p><div class="pa-row" style="gap:8px">' +
      '<label class="pa-check"><input type="checkbox" data-act="actPast"' + (S.actShowPast ? ' checked' : '') + '> Show past</label>' +
      (A.activities.some(function (x) { return x.active; }) ? '<button type="button" class="pa-btn" data-act="actNewBook">Book an activity</button>' : '') + '</div></div>';
    if (!upcoming.length) h += '<p class="pa-hint" style="margin-top:10px">' + (A.activities.length ? 'No activity bookings yet.' : 'Add an activity below first, then book it for guests here.') + '</p>';
    else h += '<div class="pa-bk-list" style="margin-top:10px">' + upcoming.map(function (b) {
      var cls = ACT_STATUS_CLASS[b.status] || 'pa-hint';
      return '<article class="pa-bk"><div class="pa-row" style="justify-content:space-between;gap:6px"><b style="color:#0e2f44">' + esc(b.activity) + '</b><span class="' + cls + '" style="font-weight:700">' + esc(b.status) + '</span></div>' +
        '<div style="font-size:13px;line-height:1.55;margin-top:4px">' + nice(b.date) + (b.time ? ' ' + esc(b.time) : '') + ' · ' + b.adults + (b.adults === 1 ? ' adult' : ' adults') + (b.children ? ', ' + b.children + (b.children === 1 ? ' child' : ' children') : '') + (b.total != null ? ' · ' + money(b.total) : '') + '<br>' +
        esc(b.guestName) + (b.guestCell ? ' · ' + esc(b.guestCell) : '') + (b.stayRef ? ' · stay ' + esc(b.stayRef) : '') + '</div>' +
        '<div class="pa-hint">' + esc(b.ref) + (b.supplier ? ' · ' + esc(b.supplier) : '') + (b.productCode ? ' · product ' + esc(b.productCode) : '') + (b.optionCode ? ' · option ' + esc(b.optionCode) : '') + (b.supplierConfirmation ? ' · supplier conf. ' + esc(b.supplierConfirmation) : '') + '</div>' +
        (b.status !== 'Cancelled' ? '<div class="pa-actions" style="margin-top:6px">' +
          (b.bookingPage && b.status !== 'Confirmed' ? '<a class="pa-btn small ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(b.bookingPage) + '" target="_blank" rel="noopener">' + (b.bookingSystem === 'activitar' ? 'Book on Activitar' : b.bookingSystem === 'activitybridge' ? 'Book on ActivityBridge' : 'Supplier booking page') + '</a>' : '') +
          (b.status !== 'Confirmed' ? '<button type="button" class="pa-btn small ghost" data-act="actSend" data-ref="' + esc(b.ref) + '">' + (b.sentAt ? 'Email supplier again' : 'Email booking to supplier') + '</button><button type="button" class="pa-btn small" data-act="actConfirm" data-ref="' + esc(b.ref) + '">Confirmed by supplier</button>' : '') +
          '<button type="button" class="pa-btn small danger" data-act="actCancelBk" data-ref="' + esc(b.ref) + '">Cancel</button></div>' : '') + '</article>';
    }).join('') + '</div>';
    h += '</section>';
    // The property's activity list
    h += '<section class="pa-card"><div class="pa-row" style="justify-content:space-between;align-items:center"><div><p class="pa-h2" style="margin:0">Your activities</p><p class="pa-hint" style="margin:4px 0 0">Activities you sell to guests, with the supplier\'s reference numbers.</p></div>' +
      '<div class="pa-row" style="gap:8px"><button type="button" class="pa-btn ghost" data-act="actNearby">Add from nearby activities</button><button type="button" class="pa-btn" data-act="actNew">Add activity</button></div></div>';
    if (S.actNear) {
      var N = S.actNear;
      h += '<div class="pa-results" style="margin-top:12px"><div class="pa-row" style="justify-content:space-between;align-items:center"><b style="font-size:13px;color:#0e2f44">' + (N.noPin ? 'Your property has no map pin yet, so nearby activities can\'t be found.' : N.nearby.length + ' hub activities within ' + N.km + ' km') + '</b>' +
        '<div class="pa-row" style="gap:6px;align-items:center"><label class="pa-label" for="pa-a-km">Distance</label><select id="pa-a-km" data-act-km="1">' + [10, 25, 50, 100, 150].map(function (k) { return '<option' + (k === N.km ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select><button type="button" class="pa-btn small ghost" data-act="actNearClose">Close</button></div></div>' +
        N.nearby.map(function (x) {
          return '<div class="pa-result"><div class="grow"><b>' + esc(x.name) + '</b><div class="pa-hint">' + esc([x.area, x.distance, x.price, x.system && (S.acts.systems || {})[x.system]].filter(Boolean).join(' · ')) + '</div></div>' +
            (x.added ? '<span class="pa-hint">Added</span>' : '<button type="button" class="pa-btn small" data-act="actCopy" data-id="' + esc(x.id) + '">Add</button>') + '</div>';
        }).join('') + '</div>';
    }
    if (!A.activities.length) h += '<p class="pa-hint" style="margin-top:12px">No activities yet. Add one, or pick from the hub\'s activities near you.</p>';
    else h += '<div class="pa-bk-list" style="margin-top:12px">' + A.activities.map(function (x) {
      var missing = [];
      if (!x.productCode && x.bookingSystem !== 'direct') missing.push('product code');
      if (!x.bookingEmail && !x.bookingPhone && !x.bookingUrl) missing.push('booking contact');
      if (x.adultPrice == null) missing.push('price');
      return '<article class="pa-bk"><div class="pa-row" style="justify-content:space-between;gap:6px"><b style="color:#0e2f44">' + esc(x.name) + '</b><span class="pa-hint">' + (x.active ? esc((A.systems || {})[x.bookingSystem] || x.bookingSystem) + (x.systemName ? ': ' + esc(x.systemName) : '') : 'Switched off') + '</span></div>' +
        '<div style="font-size:13px;line-height:1.55;margin-top:4px">' + esc([x.supplier, x.duration, x.adultPrice != null ? money(x.adultPrice) + ' adult' : '', x.childPrice != null ? money(x.childPrice) + ' child' : '', x.commissionPct != null ? x.commissionPct + '% commission' : ''].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="pa-hint">' + esc([x.supplierRef && 'Account ' + x.supplierRef, x.productCode && 'Product ' + x.productCode, x.optionCode && 'Option ' + x.optionCode].filter(Boolean).join(' · ') || 'No reference numbers yet') + '</div>' +
        (missing.length ? '<div class="pa-warn" style="font-size:12.5px">Missing: ' + missing.join(', ') + '</div>' : '') +
        '<div class="pa-actions" style="margin-top:6px">' + (x.bookingPage ? '<a class="pa-btn small ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(x.bookingPage) + '" target="_blank" rel="noopener">Booking page</a>' : '') + '<button type="button" class="pa-btn small ghost" data-act="actEdit" data-id="' + esc(x.id) + '">Edit</button>' + (x.active ? '<button type="button" class="pa-btn small" data-act="actNewBook" data-id="' + esc(x.id) + '">Book</button>' : '') + '</div></article>';
    }).join('') + '</div>';
    return h + '</section>';
  }
  function actScroll(id) { setTimeout(function () { var el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 0); }
  function actDone(d, msg) { S.busy = false; S.acts = d; S.msg = msg || null; S.err = null; render(); }
  function loadNearby(km) { S.actNear = S.actNear || { nearby: [], km: km || 50 }; return api('actNearby', { km: km || S.actNear.km || 50 }).then(function (d) { S.actNear = d; render(); }).catch(fail); }
  var ACT_ACTIONS = {
    actNew: function () { S.actEdit = { active: true, bookingSystem: 'direct', days: [] }; S.actBook = null; render(); actScroll('pa-actform'); },
    actEdit: function (t) { S.actEdit = Object.assign({}, actById(t.dataset.id)); S.actBook = null; render(); actScroll('pa-actform'); },
    actCancelEdit: function () { S.actEdit = null; S.err = null; render(); },
    actSave: function () {
      var a = collectAct(); S.actEdit = a; S.err = null; busy(true); render();
      api('actSave', { activity: a }).then(function (d) { S.actEdit = null; if (S.actNear) loadNearby(S.actNear.km); actDone(d, d.saved.name + ' saved.'); }).catch(fail);
    },
    actDelete: function (t) {
      var x = actById(t.dataset.id); if (!confirm('Delete ' + (x ? x.name : 'this activity') + '? Past bookings stay in the list.')) return;
      api('actDelete', { id: t.dataset.id }).then(function (d) { S.actEdit = null; actDone(d, 'Activity deleted.'); }).catch(fail);
    },
    actNearby: function () { loadNearby(50); },
    actNearClose: function () { S.actNear = null; render(); },
    actCopy: function (t) {
      var x = (S.actNear.nearby || []).find(function (n) { return n.id === t.dataset.id; }); if (!x) return;
      var p = parseFloat(String(x.price || '').replace(/[^\d.]/g, ''));
      S.actEdit = { name: x.name, description: x.description, bookingUrl: /^https?:\/\//.test(x.link) ? x.link : '', adultPrice: isFinite(p) ? p : '', hubActivityId: x.id, active: true, bookingSystem: x.system || 'direct', days: [] };
      var am = /^https:\/\/([a-z0-9-]+)\.activitar\.com\/services\/(\d+)/i.exec(x.link || ''), bm = /activitybridge\.com\/book\?.*activityid=(\d+)/i.exec(x.link || '');
      if (am) { S.actEdit.supplierRef = am[1]; S.actEdit.productCode = am[2]; } else if (bm) S.actEdit.productCode = bm[1];
      S.actBook = null; render(); actScroll('pa-actform');
    },
    actNewBook: function (t) { S.actBook = { activityId: t.dataset.id || '', adults: 2, children: 0 }; S.actEdit = null; render(); actScroll('pa-actbook'); },
    actCancelBook: function () { S.actBook = null; S.err = null; render(); },
    actBookSave: function () {
      var b = collectActBook(); S.err = null; busy(true); render();
      api('actBook', { booking: b }).then(function (d) { S.actBook = null; actDone(d, 'Booked ' + d.booking.activity + ' (' + d.booking.ref + '). Now send it to the supplier.'); }).catch(fail);
    },
    actSend: function (t) {
      t.textContent = 'Sending…';
      api('actSend', { ref: t.dataset.ref }).then(function (d) { actDone(d, 'Booking request emailed to ' + d.sentTo + '. Mark it confirmed when the supplier replies.'); }).catch(fail);
    },
    actConfirm: function (t) {
      var nr = prompt('The supplier\'s confirmation number:'); if (nr == null) return; nr = nr.trim(); if (!nr) return;
      api('actUpdate', { ref: t.dataset.ref, change: { status: 'Confirmed', supplierConfirmation: nr } }).then(function (d) { actDone(d, t.dataset.ref + ' confirmed.'); }).catch(fail);
    },
    actCancelBk: function (t) {
      if (!confirm('Cancel activity booking ' + t.dataset.ref + '?\n\nThis only marks it cancelled in the hub. Tell the supplier too.')) return;
      api('actUpdate', { ref: t.dataset.ref, change: { status: 'Cancelled' } }).then(function (d) { actDone(d, t.dataset.ref + ' cancelled in the hub. Remember to tell the supplier.'); }).catch(fail);
    },
    actPast: function (t) { S.actShowPast = t.checked; render(); },
  };
  // Re-draw the activity forms when a choice changes what they show.
  root.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'pa-a-km') return loadNearby(+t.value);
    if (t.dataset && t.dataset.actrerender) {
      if (S.actEdit && document.getElementById('pa-actform')) S.actEdit = collectAct();
      if (S.actBook && document.getElementById('pa-actbook')) S.actBook = collectActBook();
      var id = t.id; render(); var el = document.getElementById(id); if (el) el.focus();
    }
  });
  root.addEventListener('input', function (e) { if (e.target.id === 'pa-ab-tot') e.target.dataset.touched = '1'; });

  // ---------- actions ----------
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function setView(v) {
    if (v === 'cal') v = 'avail';
    if (S.view === 'front' && v !== 'front' && S.fsDirty && !confirm('Your front store changes aren\'t saved yet. Leave without saving?')) return;
    if (v !== 'front') { S.fsDirty = false; S.fsG = null; S.fsFillMsg = null; }
    if (v === 'front' && S.view !== 'front') S.front = null;
    S.view = v; S.more = false; S.err = null; S.msg = null; render();
    if (!S.prop) return;
    if (v === 'avail') loadAvailability(S.from);
    if (v === 'chan') Promise.all([api('channels'), api('channelEvents')]).then(function (r) { S.channels = r[0]; S.events = r[1].events; render(); }).catch(fail);
    if (v === 'book') api('find', { q: S.findQ }).then(function (d) { S.bookings = d.bookings; S.payMode = d.payMode; render(); }).catch(fail);
    if (v === 'acts') loadActivities();
    if (v === 'guests') api('guests').then(function (d) { S.guests = d.guests; render(); }).catch(fail);
    if (v === 'msgs') loadMessages();
    if (v === 'front') api('frontStore').then(function (d) { if (S.fpv) { d.snPhotos = S.fpv.snPhotos || []; d.snDescription = S.fpv.snDescription || ''; } S.front = d; S.fsDirty = false; render(); if (!S.fsAreas) api('frontAreas').then(function (r) { S.fsAreas = r.areas || []; render(); }).catch(function () {}); return fsLoadPreview(d.settings.nearbyKm); }).catch(fail);
  }
  function openBooking(bk, tab) { S.edit = bk; S.bTab = isCh() ? 'stay' : (tab || 'guest'); S.modalNote = null; S.modal = { type: 'edit' }; if (!S.av) loadAvailability(S.from); if (!S.messages && !isCh()) loadMessages(); render(); }
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
      if (d.booking.locked) { clearInterval(payTimer); S.modal = { done: { title: d.booking.ref + ' is paid', text: 'Avante shows ' + money(d.booking.amountPaid || d.booking.total) + ' paid. The booking is now locked: changes go through the property.' } }; render(); if (S.view === 'book') setView('book'); return; }
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
      var showMatches = function () { rememberConnect(); render(); var el = document.getElementById('pa-rs'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } };
      // Fewer than 3 letters: no result list, so an old "No property" never lingers.
      if (q.length < 3) { if (S.connect.matches) { S.connect.matches = null; showMatches(); } return; }
      findTimer = setTimeout(function () {
        // Searches name and place, in the hub's list and Stock Network's live feed.
        api('findResort', { q: q }).then(function (d) {
          if (String(S.connect.q || '').trim().toLowerCase() !== q) return;
          S.connect.matches = d.resorts || []; showMatches();
        }).catch(fail);
      }, 300);
    }
  });
  function rememberConnect() { S.connect = Object.assign(S.connect || {}, { username: val('pa-u') || (S.connect && S.connect.username), clientID: val('pa-ci') || (S.connect && S.connect.clientID), clientSecret: val('pa-cs') || (S.connect && S.connect.clientSecret) }); }
  function doConnect(resortId) {
    rememberConnect(); var c = S.connect; S.err = null; busy(true); render();
    api('connect', { username: c.username, clientID: c.clientID, clientSecret: c.clientSecret, resortId: resortId || '', aff: aff }).then(function (d) {
      S.busy = false;
      if (d.needResort) { S.connect.needResort = true; S.connect.candidates = d.candidates; render(); return; }
      setToken(d.token); S.prop = d.property; S.connect = null; if (isCh()) { S.view = 'avail'; setView('book'); } else { S.view = 'avail'; render(); loadAvailability(); }
    }).catch(fail);
  }

  // The More menu closes when you tap anywhere else.
  document.addEventListener('click', function (e) { if (S.more && !e.target.closest('.pa-more')) { S.more = false; render(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.more) { S.more = false; render(); var b = root.querySelector('[data-act="more"]'); if (b) b.focus(); } });
  // Changing when a scheduled message goes out shows the matching fields (days or date).
  // Front store helpers: keep what was typed when the photo list re-renders; QR as a PNG.
  function keepFront() { var b = collectFront(); if (b) Object.assign(S.front.settings, b); }
  function mergeFront(d) { d.snPhotos = S.front && S.front.snPhotos || d.snPhotos || []; d.snDescription = S.front && S.front.snDescription || ''; d._fresh = true; S.front = d; }
  function qrPng(text) {
    var q = qrcode(0, 'M'); q.addData(text); q.make();
    var n = q.getModuleCount(), cell = 20, m = 4, c = document.createElement('canvas'); c.width = c.height = (n + m * 2) * cell;
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var k = 0; k < n; k++) if (q.isDark(r, k)) x.fillRect((k + m) * cell, (r + m) * cell, cell, cell);
    return c.toDataURL('image/png');
  }
  function shrinkPhoto(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { var max = 1800, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h)); var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.86)); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file isn\'t a photo the browser can read.')); };
      img.src = url;
    });
  }
  root.addEventListener('change', function (e) {
    if (e.target.id === 'fs-area') {
      var v = e.target.value.trim().toLowerCase(), hit = (S.fsAreas || []).filter(function (a) { return fsAreaLabel(a).toLowerCase() === v; })[0];
      var cur = S.front.settings.actPlace; if ((hit && cur && fsAreaLabel(hit) === fsAreaLabel(cur)) || (!v && !cur)) return; // nothing changed (also stops a second change event while the box is redrawn)
      if (v && !hit) { S.fsAreaErr = 'Pick a place from the list.'; keepFront(); return render(); }
      S.fsAreaErr = null; keepFront(); S.front.settings.actPlace = hit || null; fsMarkDirty(); S.fsActsBusy = true; S.front._fresh = true; render(); return fsLoadPreview();
    }
    if (e.target.id === 'fs-km') { keepFront(); fsMarkDirty(); S.fsActsBusy = true; render(); return fsLoadPreview(+e.target.value); }
    if (e.target.dataset && (e.target.dataset.fsunit || e.target.dataset.fsact)) { keepFront(); fsMarkDirty(); return render(); }
    if (e.target.dataset && e.target.dataset.fsphoto) { fsMarkDirty();
      keepFront(); var F = S.front, ph = frontPhotos(), list = ph.chosen || ph.all.slice(), u = e.target.dataset.fsphoto;
      if (e.target.checked) { if (list.indexOf(u) < 0) list.push(u); } else list = list.filter(function (x) { return x !== u; });
      F.settings.photos = list; return render();
    }
    if (e.target.id === 'fs-file') {
      var file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file) return;
      keepFront(); S.msg = 'Uploading photo…'; render();
      return shrinkPhoto(file).then(function (du) { return api('uploadFrontPhoto', { dataUrl: du }); }).then(function (d) {
        var keep = S.front.settings; mergeFront(d.view); S.front.settings = Object.assign({}, S.front.settings, keep);
        if (Array.isArray(S.front.settings.photos)) S.front.settings.photos.push(d.url);
        S.msg = 'Photo uploaded. Tap Save front store to keep your photo choices.'; render();
      }).catch(function (err) { S.msg = null; fail(err); });
    }
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
  // "Move the photo": drag inside the frame (Jean, 2026-10-13).
  function fsMvShow() { var fr = document.getElementById('fs-mvframe'), m = S.fsMove; if (fr && m) fr.style.backgroundPosition = Math.round(m.x) + '% ' + Math.round(m.y) + '%'; }
  var fsDrag = null;
  root.addEventListener('pointerdown', function (e) { if (e.target.id !== 'fs-mvframe' || !S.fsMove) return; e.preventDefault(); fsDrag = { x: e.clientX, y: e.clientY, w: e.target.clientWidth, h: e.target.clientHeight, sx: S.fsMove.x, sy: S.fsMove.y }; try { e.target.setPointerCapture(e.pointerId); } catch (er) {} });
  root.addEventListener('pointermove', function (e) { if (!fsDrag || !S.fsMove) return; S.fsMove.x = Math.max(0, Math.min(100, fsDrag.sx - (e.clientX - fsDrag.x) / fsDrag.w * 100)); S.fsMove.y = Math.max(0, Math.min(100, fsDrag.sy - (e.clientY - fsDrag.y) / fsDrag.h * 100)); fsMvShow(); });
  root.addEventListener('pointerup', function () { fsDrag = null; });
  root.addEventListener('change', function (e) {
    if (e.target.id !== 'fs-actfile') return;
    var file = e.target.files && e.target.files[0], nm = S.fsActUpName; e.target.value = ''; if (!file || !nm) return;
    keepFront(); S.msg = 'Uploading photo…'; S.front._fresh = true; render();
    shrinkPhoto(file).then(function (du) { return fsAddPhoto(du, 'act'); }).then(function (url) {
      var st3 = S.front.settings; st3.actPhotos = Object.assign({}, st3.actPhotos || {}); st3.actPhotos[nm] = url; S.msg = null; fsMarkDirty(); S.front._fresh = true; render();
    }).catch(function (err) { S.msg = null; fail(err); });
  });
  // Front store builder: every change shows in the preview; opening a step scrolls the preview to that part.
  root.addEventListener('input', function (e) {
    if (S.view !== 'front' || !S.front || !e.target.closest('.fs-steps') || e.target.dataset.fsgq !== undefined || e.target.id === 'fs-apq') return;
    fsMarkDirty(); pvQueue();
  });
  root.addEventListener('toggle', function (e) {
    var d = e.target; if (!d.dataset || !d.dataset.fsstep) return;
    S.fsOpen = S.fsOpen || {}; if (d.open) S.fsOpen[d.dataset.fsstep] = true; else delete S.fsOpen[d.dataset.fsstep];
    if (d.open) { var st = FS_STEPS.filter(function (x) { return x[0] === d.dataset.fsstep; })[0]; if (st && st[2]) { keepFront(); pvSend(st[2]); } }
  }, true);
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.fsgq !== undefined) { e.preventDefault(); fsGoogle(e.target.dataset.fsgq, e.target.value); }
    if (e.key === 'Enter' && e.target.id === 'fs-apq' && S.fsAP) { e.preventDefault(); fsActLoad(S.fsAP.i, true); }
  });
  root.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'pa-rp') { var b = root.querySelector('[data-act="resume"]'); if (b) b.click(); } });
  root.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]'); if (!t) return;
    var a = t.dataset.act;
    if (a === 'backdrop' && e.target !== t) return;
    if (a === 'view') return setView(t.dataset.v);
    if (a.indexOf('act') === 0 && ACT_ACTIONS[a]) return ACT_ACTIONS[a](t);
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
      return api('resume', { aff: aff, password: pw }).then(function (d) { S.busy = false; S.resume = null; setToken(d.token); S.prop = d.property; if (isCh()) { S.view = 'avail'; setView('book'); } else { S.view = 'avail'; render(); loadAvailability(); } }).catch(fail);
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
        if (d.booking.locked) { S.modal = { done: { title: d.booking.ref + ' is paid', text: 'Avante shows this booking as paid, so no payment link is needed.' } }; S.bookings = null; setView(S.view); return; }
        S.modal = { done: { title: 'Payment for ' + d.booking.ref, text: d.booking.items.filter(function (i) { return !i.cancelled; }).map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ') + ' · ' + money(d.booking.total), pay: Object.assign({ ref: d.booking.ref }, d.pay) } }; render();
      }).catch(fail);
    }
    if (a === 'chSaveContact') {
      return api('saveSettings', Object.assign({ email: val('ch-email').trim(), phone: val('ch-phone').trim() }, contactVals())).then(function (d) {
        S.prop.settings = Object.assign({}, S.prop.settings || {}, d.settings || {}); S.msg = 'Saved.'; render();
      }).catch(fail);
    }
    if (a === 'markPaid') {
      var how = t.dataset.type === 'Cash' ? 'on arrival (cash or card)' : 'by EFT';
      if (!confirm('Record ' + t.dataset.ref + ' as paid ' + how + '?\n\nOnly do this once you have the money. The hub records the payment with Avante, which sets the booking to Paid. A paid booking is locked: it can\'t be changed or cancelled in the hub (Ask Avante to cancel).')) return;
      t.textContent = 'Saving…';
      return api('markPaid', { ref: t.dataset.ref, type: t.dataset.type || 'EFT' }).then(function (d) { S.msg = t.dataset.ref + ' recorded as paid ' + how + '. Avante now shows ' + (d.booking.snStatus || d.booking.status) + '.'; return api('find', { q: S.findQ }).then(function (d2) { S.bookings = d2.bookings; S.payMode = d2.payMode; render(); }); }).catch(fail);
    }
    if (a === 'decide') {
      var yes = !!t.dataset.yes, why = '';
      if (yes) { if (!confirm('Accept ' + t.dataset.ref + '? It becomes Booked and the guest gets the payment details by email.')) return; }
      else { why = prompt('Decline ' + t.dataset.ref + '? It is cancelled and the guest gets a polite email.\n\nOptional short reason for the guest:', ''); if (why === null) return; }
      t.textContent = yes ? 'Accepting…' : 'Declining…';
      return api('decide', { ref: t.dataset.ref, accept: yes, reason: why }).then(function (d) { S.msg = t.dataset.ref + (yes ? ' accepted: Booked. The guest was emailed the payment details.' : ' declined and cancelled. The guest was emailed.'); return api('find', { q: S.findQ }).then(function (d2) { S.bookings = d2.bookings; S.payMode = d2.payMode; render(); }); }).catch(fail);
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
      var bookBody = { items: S.cart, guest: { first: val('pa-gf'), last: val('pa-gl'), email: val('pa-ge'), cellphone: val('pa-gc') }, adults: val('pa-ga'), children: val('pa-gk'), source: val('pa-gs'), channelRef: val('pa-gr'), notes: val('pa-gn'), payBy: (root.querySelector('input[name="pa-payby"]:checked') || {}).value };
      if (!bookBody.guest.cellphone.trim()) { var gc = document.getElementById('pa-gc'); if (gc) { gc.focus(); gc.setAttribute('aria-invalid', 'true'); } return; }
      busy(true); render();
      return api('book', bookBody)
        .then(function (d) { var b = d.booking; afterChange({ title: 'Booking ' + b.ref + ' created', text: b.items.map(function (i) { return i.unit + ' ' + short(i.start) + ' – ' + short(i.end); }).join(', ') + ' · ' + money(b.total) + '. Status ' + b.status + ' with Avante. Your other channels are blocked within 15 minutes.', pay: d.pay && Object.assign({ ref: b.ref }, d.pay) }); })
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
        .then(function (d) { afterChange(d.booking && d.replaced ? { title: 'Booking ' + d.booking.ref + ' created', text: d.replaced + ' was cancelled and replaced by ' + d.booking.ref + ' · ' + money(d.booking.total) + '. Send the guest the new payment link.', pay: d.pay && Object.assign({ ref: d.booking.ref }, d.pay) } : { title: 'Details updated', text: 'The unit and dates are unchanged, so ' + S.edit.ref + ' stays as it is.' }); })
        .catch(function (err) { S.busy = false; S.err = err.message; S.modal = null; staleAll(); render(); loadAvailability(S.from); });
    }
    if (a === 'removeUnit') {
      if (!confirm('Cancel ' + t.dataset.u + ' on ' + S.edit.ref + '? The other units stay booked.')) return;
      busy(true); render();
      return api('cancelUnit', { ref: S.edit.ref, unit: t.dataset.u }).then(function () { afterChange({ title: t.dataset.u + ' removed from ' + S.edit.ref, text: 'Only ' + t.dataset.u + ' was cancelled. The booking keeps its other units and its reference.' }); }).catch(fail);
    }
    if (a === 'cancelBooking') {
      var locked = S.edit.locked;
      if (!confirm(locked ? 'Ask Avante to cancel ' + S.edit.status + ' booking ' + S.edit.ref + '?\n\nIt is NOT cancelled yet: Avante gets an email, cancels it and handles any refund.' : 'Cancel ' + S.edit.ref + '?')) return;
      busy(true); render();
      return api('cancel', { ref: S.edit.ref }).then(function (d) {
        if (d.escalated) { S.busy = false; S.bookings = null; S.modal = { done: { title: 'Avante has your request for ' + S.edit.ref, text: 'It is NOT cancelled yet. Avante will cancel it and the status changes here. Until then it shows ' + d.booking.status + ' (Cancel requested).' } }; S.edit = null; render(); return; }
        afterChange({ title: 'Booking ' + S.edit.ref + ' cancelled', text: d.alreadyCancelled ? 'It had already been cancelled.' : 'Cancelled. The nights are open again and your other channels are unblocked within 15 minutes.' });
      }).catch(function (err) { S.busy = false; S.err = err.message; S.modal = null; render(); });
    }
    if (a === 'toLinks') { var lk = document.getElementById('pa-chlinks'); if (lk) lk.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (a === 'chHelp') {
      var chs = Array.prototype.slice.call(root.querySelectorAll('[data-chhelp]:checked')).map(function (x) { return x.dataset.chhelp; });
      if (!chs.length) { S.err = 'Tick the channels where you invited Avante.'; render(); window.scrollTo(0, 0); return; }
      t.textContent = 'Sending…'; t.disabled = true;
      return api('channelHelp', { channels: chs, note: val('pa-chnote') }).then(function (d) { S.channels = d; S.msg = 'Thank you. Avante has your request and will connect your channels. They show "Connected" here when done.'; render(); window.scrollTo(0, 0); }).catch(function (e) { fail(e); window.scrollTo(0, 0); });
    }
    if (a === 'saveChannels') {
      var prices = {}; root.querySelectorAll('[data-price]').forEach(function (el) { prices[el.dataset.price] = el.value; });
      var channels = {}; root.querySelectorAll('[data-imp]').forEach(function (el) { var p = el.dataset.imp.split('|'); (channels[p[0]] = channels[p[0]] || {})[p[1]] = el.value.trim(); });
      var pmEl = root.querySelector('input[name="pa-pm"]:checked');
      var csMode = root.querySelector('input[name="pa-cs-mode"]:checked');
      return api('saveSettings', { calendarStart: { mode: csMode ? csMode.value : 'today', date: val('pa-cs-date') }, email: val('pa-se'), phone: val('pa-sp'), contactName: contactVals().contactName, contactPhone: contactVals().contactPhone, contactEmail: contactVals().contactEmail, notifyWho: contactVals().notifyWho, minStay: val('pa-sm'), autoBook: document.getElementById('pa-auto').checked, prices: prices, channels: channels,
        payMode: pmEl ? pmEl.value : 'both', approveGuests: !!(document.getElementById('pa-appr') || {}).checked, bank: { bankName: val('pa-bn'), accountHolder: val('pa-bh'), accountNumber: val('pa-ba'), branchCode: val('pa-bb'), accountType: val('pa-bt'), note: val('pa-bx') } })
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
    if (a === 'fsPvOpen') { pvEnsure(); PV.full = true; pvFollow(); pvSend(); var cb2 = PV.box.querySelector('[data-pvclose]'); if (cb2) cb2.focus(); return; }
    if (a === 'fsG') { var gq = root.querySelector('[data-fsgq="' + t.dataset.target + '"]'); return fsGoogle(t.dataset.target, gq ? gq.value : ''); }
    if (a === 'fsGOpen') { if (S.fsG && S.fsG.target === t.dataset.target) { keepFront(); S.fsG = null; return render(); } return fsGoogle(t.dataset.target, t.dataset.q); }
    if (a === 'fsGUse') {
      var gs = S.fsG, im = gs && gs.images && gs.images[+t.dataset.i]; if (!im) return;
      keepFront(); t.disabled = true; t.textContent = 'Adding…';
      var actI = /^act:(\d+)$/.exec(gs.target), actA = actI && S.fpv && (S.fpv.nearby || [])[+actI[1]];
      var before = frontPhotos(), keepOrder = (before.chosen || before.all).slice(); // a new gallery photo goes at the end, not in front of the cover
      return fsAddPhoto(im.dataUri, actA ? 'act' : '').then(function (url) {
        var st2 = S.front.settings;
        if (actA) { st2.actPhotos = Object.assign({}, st2.actPhotos || {}); st2.actPhotos[actA.name] = url; }
        else st2.photos = (Array.isArray(st2.photos) ? st2.photos : keepOrder).concat(url).slice(0, 24);
        S.fsG = null; if (actA) S.fsActOpen = null; fsMarkDirty(); S.front._fresh = true; render();
      }).catch(function (err) { t.disabled = false; t.textContent = 'Use'; fail(err); });
    }
    if (a === 'fsUnitPhoto') {
      keepFront(); var ui2 = S.front.settings.unitInfo = Object.assign({}, S.front.settings.unitInfo || {}), ux = ui2[t.dataset.unit] = Object.assign({}, ui2[t.dataset.unit] || {});
      ux.photo = ux.photo === t.dataset.u ? '' : t.dataset.u; fsMarkDirty(); S.front._fresh = true; render(); pvSend('units'); return;
    }
    if (a === 'fsActReset') { keepFront(); var ap2 = S.front.settings.actPhotos = Object.assign({}, S.front.settings.actPhotos || {}); delete ap2[t.dataset.name]; fsMarkDirty(); S.front._fresh = true; render(); return; }
    if (a === 'fsFill') return fsFill(t);
    if (a === 'fsActPick') { keepFront(); var ai = +t.dataset.i; S.fsActOpen = S.fsActOpen === ai ? null : ai; S.fsG = null; S.front._fresh = true; render();
      if (S.fsActOpen === ai) fsActLoad(ai, false); else S.fsAP = null; return; }
    if (a === 'fsAPg') return fsActLoad(+t.dataset.i, true);
    if (a === 'fsPin') { keepFront(); var pn = (S.front.settings.actPinned || []).filter(function (x) { return x !== t.dataset.name; }); if (t.dataset.on === '1') pn.push(t.dataset.name); S.front.settings.actPinned = pn.slice(0, 10); fsMarkDirty(); S.front._fresh = true; render(); pvSend('nearby'); return; }
    if (a === 'fsSwapOpen') { keepFront(); var si = +t.dataset.i; S.fsSwap = S.fsSwap === si ? null : si; S.front._fresh = true; render(); return; }
    if (a === 'fsSwapDo') {
      keepFront(); var sel = document.getElementById('fs-swapsel'), nw = sel && (S.fpv.nearby || [])[+sel.value]; if (!nw) return;
      var p2 = (S.front.settings.actPinned || []).filter(function (x) { return x !== t.dataset.old && x !== nw.name; }); p2.push(nw.name);
      // The swapped-out one makes room: a random one leaves the random pick, a kept one is no longer kept.
      if (S.fpvOrder) { var oi = (S.fpv.nearby || []).findIndex(function (x) { return x.name === t.dataset.old; }); if (oi >= 0) S.fpvOrder = S.fpvOrder.filter(function (k) { return k !== oi; }).concat([oi]); }
      S.front.settings.actPinned = p2.slice(0, 10); S.fsSwap = null; fsMarkDirty(); S.front._fresh = true; render(); pvSend('nearby'); return;
    }
    if (a === 'fsActUse') { keepFront(); var apu = S.front.settings.actPhotos = Object.assign({}, S.front.settings.actPhotos || {}); apu[t.dataset.name] = t.dataset.u; fsMarkDirty(); S.front._fresh = true; render(); pvSend('nearby'); return; }
    if (a === 'fsActUp') { S.fsActUpName = t.dataset.name; var af = document.getElementById('fs-actfile'); if (af) af.click(); return; }
    if (a === 'fsMove') { keepFront(); var cur = ((S.front.settings.photoPos || {})[t.dataset.u] || '50% 50%').split(' '); S.fsMove = { u: t.dataset.u, x: parseInt(cur[0], 10), y: parseInt(cur[1], 10) }; S.front._fresh = true; render(); var fr = document.getElementById('fs-mvframe'); if (fr) fr.focus(); return; }
    if (a === 'fsMvStep') { var m1 = S.fsMove; m1.x = Math.max(0, Math.min(100, m1.x + +t.dataset.dx)); m1.y = Math.max(0, Math.min(100, m1.y + +t.dataset.dy)); fsMvShow(); return; }
    if (a === 'fsMvCentre') { S.fsMove.x = 50; S.fsMove.y = 50; fsMvShow(); return; }
    if (a === 'fsMvCancel') { keepFront(); S.fsMove = null; S.front._fresh = true; return render(); }
    if (a === 'fsMvDone') { keepFront(); var m2 = S.fsMove, pp = S.front.settings.photoPos = Object.assign({}, S.front.settings.photoPos || {}); if (m2.x === 50 && m2.y === 50) delete pp[m2.u]; else pp[m2.u] = Math.round(m2.x) + '% ' + Math.round(m2.y) + '%'; S.fsMove = null; fsMarkDirty(); S.front._fresh = true; return render(); }
    if (a === 'fsLink') {
      var li = document.getElementById('fs-plink'), links = String(li ? li.value : '').split(/\s+/).filter(function (x) { return /^https:\/\/\S+$/.test(x); });
      if (!links.length) { S.err = 'Paste a photo link that starts with https://'; return render(); }
      keepFront(); var bf = frontPhotos(), lst = (bf.chosen || bf.all).slice();
      links.forEach(function (x) { if (lst.indexOf(x) < 0) lst.push(x); });
      S.front.settings.photos = lst.slice(0, 24); fsMarkDirty(); S.front._fresh = true; render(); return;
    }
    if (a === 'saveFront') {
      var fb = collectFront(); if (!fb) return;
      t.textContent = 'Saving…';
      return api('saveFrontStore', { frontStore: fb }).then(function (d) { mergeFront(d); S.fsDirty = false; S.fsFillMsg = null; S.msg = d.settings.on ? 'Front store saved. It\'s live at ' + d.url : 'Front store saved (switched off).'; render(); window.scrollTo(0, 0); }).catch(function (e) { fail(e); window.scrollTo(0, 0); });
    }
    if (a === 'fsNewKey') {
      if (!confirm('Make a new guest page link?\n\nThe old link and the QR on printed room cards stop showing your Wi-Fi and house info. Print new room cards afterwards.')) return;
      var fk = collectFront() || {}; fk.newGuestKey = true;
      return api('saveFrontStore', { frontStore: fk }).then(function (d) { mergeFront(d); S.msg = 'New guest link made. Print new room cards.'; render(); window.scrollTo(0, 0); }).catch(fail);
    }
    if (a === 'fsUpload') { var fi = document.getElementById('fs-file'); if (fi) fi.click(); return; }
    if (a === 'fsAuto') { keepFront(); fsMarkDirty(); S.front.settings.photos = null; return render(); }
    if (a === 'fsUp') { keepFront(); fsMarkDirty(); var ph2 = frontPhotos(), l2 = ph2.chosen || ph2.all.slice(), ix = l2.indexOf(t.dataset.u); if (ix > 0) { l2.splice(ix, 1); l2.splice(ix - 1, 0, t.dataset.u); } S.front.settings.photos = l2; return render(); }
    if (a === 'fsDel') {
      if (!confirm('Delete this photo? It can\'t be undone.')) return;
      keepFront(); var keep2 = S.front.settings;
      return api('removeFrontPhoto', { url: t.dataset.u }).then(function (d) { mergeFront(d); S.front.settings = Object.assign({}, S.front.settings, keep2, { photos: Array.isArray(keep2.photos) ? keep2.photos.filter(function (x) { return x !== t.dataset.u; }) : null }); render(); }).catch(fail);
    }
    if (a === 'dlQr') { (window.AvanteScripts ? AvanteScripts.qrcode() : Promise.resolve()).then(function () { try { var dl2 = document.createElement('a'); dl2.href = qrPng(t.dataset.url); dl2.download = (S.prop.resortName || 'property').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + t.dataset.name + '-qr.png'; document.body.appendChild(dl2); dl2.click(); dl2.remove(); } catch (e2) { fail(e2); } }, fail); return; }
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
      return api('addChannelEvent', { unit: t.dataset.u, channel: t.dataset.c, uid: t.dataset.uid }).then(function (d) { return api('channelEvents').then(function (r) { S.events = r.events; staleAll(); S.msg = 'Added to Avante as ' + d.event.ref + '.'; render(); }); }).catch(fail);
    }
  });

  // ---------- start ----------
  render();
  // Property affiliates land on Property Affiliate when the hub opens.
  function openOwnTab() { var tab = document.querySelector('.tab[data-panel="property"]'); if (tab && !tab.classList.contains('active')) tab.click(); document.documentElement.classList.remove('pa-first'); }
  function checkAffiliate() {
    if (!aff) return;
    api('affStatus', { aff: aff }).then(function (d) { if (d.linked) { S.resume = { resortName: d.resortName }; openOwnTab(); render(); } }).catch(function () {});
  }
  if (S.token) {
    openOwnTab();
    // One call: the property and its last saved grid, shown at once; then a refresh from Stock Network.
    S.opening = true; render();
    api('open').then(function (d) {
      S.opening = false;
      S.prop = d.property;
      if (d.newToken) setToken(d.newToken);
      if (d.timing && window.console) console.info('[hub] property + saved grid, ms:', d.timing);
      var av = d.availability;
      if (av && av.units && av.units.length) { S.from = av.from; mergeAv(av, av.from, av.to, av.fresh ? Date.now() : 0); }
      if (isCh()) { S.view = 'avail'; setView('book'); return; }
      render();
      if (av && av.fresh) afterFirstGrid(); else loadAvailability(S.from || startDate());
    }).catch(function (e) { S.opening = false; if (S.token) fail(e); else { render(); checkAffiliate(); } });
  } else checkAffiliate();
})();

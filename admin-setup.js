// Admin > Property Listings > Set up (Jean, 2026-10-25): adding a property in
// one pop-up, step by step, so admin never has to go looking around the hub.
// The steps and whose turn each is come from the server (lib/onboarding.js,
// action "onboarding"); this file only shows them and runs each step's buttons.
// "What's outstanding?" lists what is left, for one property or for all of
// them, with Go there buttons that open the step.
//
// Uses admin.html's propAdminPost, escapeHtml and ADMIN_TOKEN, and opens its
// listing pop-up (window.openPropertyDetailsModal) and Activate pop-up
// (window.openActivateFor) on top of this one for the bigger jobs.
(function(){
  var ov = document.getElementById('obwOverlay');
  if(!ov) return;
  var railEl = document.getElementById('obwRail'), mainEl = document.getElementById('obwMain');
  var titleEl = document.getElementById('obwTitle'), subEl = document.getElementById('obwSub'), progEl = document.getElementById('obwProgress');
  var backBtn = document.getElementById('obwBack'), nextBtn = document.getElementById('obwNext');
  var S = { id: '', D: null, step: '', audit: false, all: null, msg: '', err: '', busy: false, ch: null };
  var esc = window.escapeHtml;
  var WHO = { done: 'Done', you: 'Your turn', owner: "Owner's turn", wait: 'Waiting on Stock Network', later: 'Not yet' };

  function post(action, body){ return window.propAdminPost(action, body).then(function(r){ return r.data || {}; }); }
  // Property Affiliate actions as admin, for one property's channels (pa-api.js adminSite).
  function paPost(action, body){
    return fetch('/api/property', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, adminSite: S.D.pa.siteId, adminToken: window.ADMIN_TOKEN }, body || {})) })
      .then(function(r){ return r.json().catch(function(){ return {}; }); });
  }
  function chip(st){ return '<span class="obw-chip obw-' + st + '">' + esc(WHO[st] || st) + '</span>'; }
  function row(label, value, cls){ return '<div class="obw-row' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><span>' + value + '</span></div>'; }
  function btn(act, label, kind, extra){ return '<button type="button" class="' + (kind === 'primary' ? 'primary' : 'btn-outline') + '" data-act="' + act + '"' + (extra || '') + (S.busy ? ' disabled' : '') + '>' + esc(label) + '</button>'; }
  function yes(v){ return v ? '<b class="obw-yes">Yes</b>' : '<b class="obw-no">Not yet</b>'; }
  function fmt(iso){ if(!iso) return ''; var d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function stepOf(id){ return (S.D.steps || []).filter(function(s){ return s.id === id; })[0]; }

  // ---------- loading ----------
  function load(stepWanted){
    S.err = '';
    return post('onboarding', { listingId: S.id }).then(function(d){
      if(!d.ok){ S.err = d.error || 'Could not load the property.'; render(); return; }
      S.D = d; S.ch = null;
      if(stepWanted) { S.step = stepWanted; S.audit = false; }
      else if(!S.step && !S.audit) S.audit = true;
      render();
    }).catch(function(){ S.err = 'No connection. Try again.'; render(); });
  }
  function open(listingId, stepWanted){
    S = { id: listingId, D: null, step: stepWanted || '', audit: !stepWanted, all: null, msg: '', err: '', busy: false, ch: null };
    titleEl.textContent = 'Loading…'; subEl.textContent = ''; progEl.innerHTML = ''; railEl.innerHTML = ''; mainEl.innerHTML = '<p class="hint">Loading…</p>';
    ov.classList.add('show'); document.addEventListener('keydown', onKey);
    load(stepWanted);
  }
  function openAll(){
    S = { id: '', D: null, step: '', audit: true, all: null, msg: '', err: '', busy: false, ch: null };
    titleEl.textContent = "What's outstanding: all properties"; subEl.textContent = 'Every property still being set up, the ones waiting on you first.'; progEl.innerHTML = ''; railEl.innerHTML = '';
    mainEl.innerHTML = '<p class="hint">Checking every property…</p>';
    ov.classList.add('show'); document.addEventListener('keydown', onKey);
    post('onboardingAll').then(function(d){ S.all = d.ok ? d.listings : []; if(!d.ok) S.err = d.error || 'Could not check the properties.'; render(); })
      .catch(function(){ S.err = 'No connection. Try again.'; render(); });
  }
  function close(){ ov.classList.remove('show'); document.removeEventListener('keydown', onKey); if(window.refreshPropertyListings) window.refreshPropertyListings(); }
  function onKey(e){ if(e.key === 'Escape' && !document.querySelector('.modal-overlay.show:not(#obwOverlay)')) close(); }

  // ---------- drawing ----------
  function render(){
    ov.classList.toggle('obw-all', !S.id);
    backBtn.style.visibility = S.id && !S.audit ? 'visible' : 'hidden';
    nextBtn.style.display = S.id ? '' : 'none';
    if(!S.id){ railEl.innerHTML = ''; mainEl.innerHTML = renderAll(); return; }
    var D = S.D;
    if(!D){ mainEl.innerHTML = S.err ? '<p class="acw-err">' + esc(S.err) + '</p>' : '<p class="hint">Loading…</p>'; return; }
    var L = D.listing;
    titleEl.textContent = L.propertyName || 'Property';
    subEl.textContent = [D.path === 'channel' ? 'Channel property' + (L.bbid ? ' · NightsBridge ' + L.bbid : '') : 'Property Affiliate (no channel manager' + (D.listedChannels.length ? ', iCal' : '') + ')',
      L.siteNr ? 'Site Nr ' + L.siteNr : '', L.siteId ? 'Site ID ' + L.siteId : ''].filter(Boolean).join(' · ');
    progEl.innerHTML = '<span><b>' + D.done + ' of ' + D.total + '</b> steps done</span><span class="obw-bar"><span style="width:' + Math.round(D.done / D.total * 100) + '%"></span></span>';
    railEl.innerHTML = D.steps.map(function(s){
      var on = !S.audit && S.step === s.id;
      return '<button type="button" class="obw-step' + (on ? ' on' : '') + '" data-go="' + s.id + '">' +
        '<span class="obw-n' + (s.status === 'done' ? ' done' : '') + '">' + (s.status === 'done' ? '✓' : s.n) + '</span>' +
        '<span class="obw-st"><b>' + esc(s.title) + '</b>' + chip(s.status) + '</span></button>';
    }).join('') + '<p class="hint obw-railnote">' + (D.path === 'channel' ? 'Channel property: rooms, rates and calendar come from its channel manager.' : 'Everything saves as you go. Close any time and carry on later.') + '</p>';
    var h = S.audit ? renderAudit() : renderStep(stepOf(S.step) || D.steps[0]);
    if(S.msg) h = '<p class="acw-ok">' + esc(S.msg) + '</p>' + h;
    if(S.err) h = '<p class="acw-err">' + esc(S.err) + '</p>' + h;
    mainEl.innerHTML = h;
    nextBtn.textContent = S.audit ? 'Start with the first' : 'Next step';
  }

  function renderAudit(){
    var D = S.D, o = D.outstanding || [];
    var h = '<h3>What’s outstanding</h3><p class="acw-what">Checked just now, in the order it needs doing. Tap <b>Go there</b> to open that step.</p>';
    if(!o.length) return h + (D.listing.liveAt ? '<p class="acw-ok">✔ Live since ' + esc(fmt(D.listing.liveAt)) + '. Nothing outstanding.</p>' : '<p class="acw-ok">✔ Nothing waiting on anyone.</p>');
    return h + o.map(function(x){
      return '<div class="obw-out"><span class="obw-n">' + x.n + '</span><span class="obw-what"><b>' + esc(x.what) + '</b><small>' + esc(x.title) + ' · ' + esc(x.who) + '</small></span>' +
        '<button type="button" class="btn-outline" data-go="' + x.id + '">Go there</button></div>';
    }).join('');
  }

  function renderAll(){
    if(S.err) return '<p class="acw-err">' + esc(S.err) + '</p>';
    if(!S.all) return '<p class="hint">Checking every property…</p>';
    if(!S.all.length) return '<p class="acw-ok">✔ No property is being set up right now.</p>';
    return S.all.map(function(p){
      var items = p.outstanding.length ? p.outstanding.map(function(x){
        return '<div class="obw-out obw-out-sm"><span class="obw-what"><b>' + esc(x.what) + '</b><small>' + x.n + '. ' + esc(x.title) + ' · ' + esc(x.who) + '</small></span>' +
          '<button type="button" class="btn-outline" data-open="' + esc(p.listingId) + '" data-step="' + x.id + '">Go there</button></div>';
      }).join('') : '<p class="hint">Nothing waiting: ready for Go live.</p>';
      return '<div class="obw-prop"><div class="obw-prophead"><b>' + esc(p.propertyName || p.listingId) + '</b><span class="hint" style="margin:0">' + (p.path === 'channel' ? 'Channel property' : 'Property Affiliate') + ' · ' + p.done + ' of ' + p.total + ' done</span>' +
        '<button type="button" class="btn-outline" data-open="' + esc(p.listingId) + '">Open</button></div>' + items + '</div>';
    }).join('');
  }

  function head(s, what){ return '<h3>' + s.n + ' · ' + esc(s.title) + ' ' + chip(s.status) + '</h3><p class="acw-what">' + what + '</p>' + (s.note && s.status !== 'done' ? '<p class="obw-note">' + esc(s.note) + '</p>' : ''); }

  function renderStep(s){
    var D = S.D, L = D.listing, E = D.entry, SN = D.sn, h = '';
    switch(s.id){
      case 'request':
        h = head(s, 'How the property asked to join, and who Avante talks to.') + '<div class="obw-box">' +
          row('How they take bookings', esc(D.path === 'channel' ? (L.channelManager || 'Channel manager') + (L.bbid ? ' · BBID ' + L.bbid : '') : 'No channel manager')) +
          (L.nb ? row('Checked on NightsBridge', '<a href="' + esc(L.nb.bookingPage) + '" target="_blank" rel="noopener">' + esc(L.nb.name) + '</a>') : '') +
          row('Listed on now', esc(L.listedOn || '—')) +
          row('Bookings contact', esc([L.contactName, L.contactEmail, L.contactPhone].filter(Boolean).join(' · ') || '—')) +
          row('Owner', esc([L.ownerFullName, L.ownerPhone].filter(Boolean).join(' · ') || '—')) + '</div>' +
          '<div class="obw-btns">' + btn('openListing', 'Open the listing to change these') + '</div>';
        break;
      case 'listing':
        h = head(s, 'Filled in by the owner from their edit link, or by you from their screenshots and documents.') + '<div class="obw-box">' +
          (L.readyTodo.length ? L.readyTodo.map(function(t){ return row(esc(t), '<b class="obw-no">To do</b>'); }).join('') : row('The listing’s Ready check', '<b class="obw-yes">All done</b>')) +
          '<div class="obw-row' + (L.checkInTime ? '' : ' obw-warn') + '"><span>Check-in time</span><span><input id="obwCheckIn" value="' + esc(L.checkInTime || '') + '" placeholder="14:00" style="width:90px; margin:0;"> ' + btn('saveCheckIn', 'Save') + '</span></div>' +
          (L.helpRequest ? row('The owner asked Avante to fill it in', esc(fmt(L.helpRequest.at))) : '') + '</div>' +
          '<div class="obw-btns">' + btn('editLink', 'Email the owner their edit link') + btn('openListing', 'Open the listing (full form, screenshots)') + '</div>';
        break;
      case 'siteNr':
        h = head(s, 'The hub gives the next free Site Nr and emails Stock Network’s set-up sheet. Stock Network loads the site from the channel manager.') + '<div class="obw-box">' +
          row('Site Nr', esc(L.siteNr || '—')) + row('Sheet', esc(E ? E.status : '—')) +
          (E && E.sendLog.length ? E.sendLog.map(function(x){ return row(esc(fmt(x.at)) + ' · ' + esc(x.to || ''), x.ok ? '<b class="obw-yes">Sent</b>' : '<b class="obw-no">Not sent</b>'); }).join('') : '') + '</div>' +
          '<div class="obw-btns">' + (L.siteNr ? btn('sendSheet', 'Send the sheet again') : '') + btn('checkSN', 'Check Stock Network now') + '</div>';
        break;
      case 'verify':
        var m = function(a, b){ return a && b && String(a).toLowerCase().replace(/[^a-z0-9]/g, '') === String(b).toLowerCase().replace(/[^a-z0-9]/g, ''); };
        h = head(s, 'Check that the site Stock Network made is this property, before it is connected.');
        if(!SN && !L.resortId) h += '<div class="obw-btns">' + btn('checkSN', 'Check Stock Network now') + '</div>';
        else {
          h += '<table class="obw-tbl"><tr><th></th><th>What we sent</th><th>What Stock Network has</th></tr>' +
            '<tr><td>NightsBridge BBID</td><td>' + esc(L.bbid || (E && E.bbid) || '—') + '</td><td class="' + (SN && m(SN.externalResortCode, L.bbid) ? 'obw-yes' : 'obw-warn') + '">' + esc(SN ? SN.externalResortCode || '—' : '—') + '</td></tr>' +
            '<tr><td>Name</td><td>' + esc(L.propertyName) + (L.nb && L.nb.name !== L.propertyName ? '<br><small>NightsBridge: ' + esc(L.nb.name) + '</small>' : '') + '</td><td class="' + (SN && m(SN.name, L.propertyName) ? 'obw-yes' : 'obw-warn') + '">' + esc(SN ? SN.name : (E && E.snName) || '—') + '</td></tr>' +
            '<tr><td>Site Nr</td><td>' + esc(L.siteNr || '—') + '</td><td>' + (E && E.status === 'Set up' ? esc(L.siteNr) + ' <small>(found by the hourly check)</small>' : '—') + '</td></tr>' +
            '<tr><td>Site ID (affiliate number)</td><td class="hint">comes from Stock Network</td><td>' + esc(L.siteId || (SN && SN.siteId) || (E && E.snSiteId) || '—') + '</td></tr>' +
            '<tr><td>ResortID</td><td class="hint">comes from Stock Network</td><td>' + esc(L.resortId || '—') + '</td></tr></table>' +
            (L.siteVerifiedAt ? '<p class="acw-ok">✔ Checked on ' + esc(fmt(L.siteVerifiedAt)) + '</p>' : '<div class="obw-btns">' + btn('verifySite', 'Yes, this is the right site', 'primary') + btn('wrongSite', 'Wrong site: ask Stock Network') + '</div>');
        }
        break;
      case 'location':
        var staleDistrict = /\bdistrict\b/i.test(L.district || '');
        var diffs = D.locationDiffs || [];
        h = head(s, 'The pin is checked with Google and the place names come from the hub’s location tree, which is the master. Stock Network gets the hub’s names.') + '<div class="obw-box">' +
          row('Pin', esc([L.latitude, L.longitude].filter(Boolean).join(', ') || '—')) + row('Checked with Google', yes(L.coordsVerified === 'Y')) +
          row('Hub tree', esc(L.treePlaceText || [L.suburb, L.city, L.area, L.stateProvince].filter(Boolean).join(' · ') || '—')) + '</div>';
        if(diffs.length){
          h += '<table class="obw-tbl"><tr><th>Field</th><th>Stock Network now</th><th>Hub tree</th></tr>' + diffs.map(function(x){
            return '<tr><td>' + esc(x.label) + '</td><td class="obw-warn">' + esc(x.sn || '—') + '</td><td><b>' + esc(x.hub) + '</b></td></tr>'; }).join('') + '</table>' +
            (L.locationSentAt ? '<p class="acw-ok">✔ Sent to Stock Network on ' + esc(fmt(L.locationSentAt)) + '</p>'
              : staleDistrict ? '' : '<p class="obw-note">Is the pin on the property? Then tap <b>Send the hub’s names to Stock Network</b>. You don’t type anything: the hub’s names are the right ones.</p>');
        }
        h += '<div class="obw-btns">' +
          (L.coordsVerified !== 'Y' || staleDistrict ? btn('checkPin', staleDistrict ? 'Check the pin with Google again' : 'Check the pin with Google', 'primary') : '') +
          (diffs.length && !staleDistrict ? btn('sendLocation', L.locationSentAt ? 'Send again' : 'Send the hub’s names to Stock Network', L.locationSentAt ? '' : 'primary') : '') +
          btn('openListing', 'Pin in the wrong spot? Move it') + '</div>';
        break;
      case 'rates':
        h = head(s, 'The property gives rack rates; the hub works out Avante’s rate. Nights booked on other channels stay open: their calendar links close them.') + '<div class="obw-box">' +
          row('Rate periods on the calendar', esc(String(L.rateSeasons))) + row('Nights marked booked on other channels', esc(String(L.blockedNights)) + ' (open on Avante)') + '</div>' +
          '<div class="obw-btns">' + btn('openListing', 'See or change the rates (open the listing)') + '</div>';
        break;
      case 'sn':
        h = head(s, 'Stock Network gets the property and rates files, sets the site up, then loads the stock. The hub checks every hour.') + '<div class="obw-box">' +
          row('Site Nr', esc(L.siteNr || '—')) +
          (L.snEmailLog.length ? L.snEmailLog.map(function(x){ return row('Files emailed ' + esc(fmt(x.at)) + ' to ' + esc(x.to), x.ok ? '<b class="obw-yes">Sent</b>' : '<b class="obw-no">Not sent</b>'); }).join('') : row('Files emailed', '<b class="obw-no">Not yet</b>')) +
          row('Set up on Stock Network', yes(!!L.resortId)) + (E && E.goLive ? row('Stock', esc(E.goLive + (E.stockFrom ? ' (from ' + E.stockFrom + ')' : ''))) : '') + '</div>' +
          '<div class="obw-btns">' + btn('openListing', 'Send the files (open the listing)') + btn('checkSN', 'Check Stock Network now') + '</div>';
        break;
      case 'connect':
        h = head(s, 'Paste the Avante login Stock Network sends after set-up. The hub makes the affiliate, connects it, gets the rating link and sends the welcome email.') + '<div class="obw-box">' +
          row('Connected in Property Affiliate', yes(D.pa && D.pa.connected)) + row('Affiliate', esc(D.aff ? D.aff.affId + ' · ' + (D.aff.types || []).join(', ') : '—')) +
          row('Bookings through the Avante marketing tool (all transaction fees included)', esc(AvanteCommission.ownText)) + row('Bookings by Avante’s other platforms', esc(AvanteCommission.STANDARD + '% + VAT')) + '</div>' +
          (D.pa && D.pa.connected ? '' : '<div class="obw-btns">' + btn('activate', 'Paste the Avante login', 'primary') + '</div>');
        break;
      case 'reviews':
        var cand = L.ratingGoogle === 'needs_confirm' && L.ratingGoogleCandidate;
        h = head(s, 'The rating link comes from the review app by itself. It shows Google’s rating until the property has 3 Avante reviews, then Avante’s own.') + '<div class="obw-box">' +
          row('Rating link', L.ratingLink ? '<a href="' + esc(L.ratingLink) + '" target="_blank" rel="noopener">open it</a>' : '<b class="obw-no">Not yet</b>') +
          (SN ? row('Stock Network says', esc('Supplier ' + (SN.supplierRating || '—') + ' · Tourism Board ' + (SN.tourismBoardRating || '—'))) : '') +
          (L.nb && L.nb.stars ? row('NightsBridge says', esc(L.nb.stars + ' (' + L.nb.starsSource + ')')) : '') +
          '<div class="obw-row"><span>Star rating <b>' + esc(L.selfSupplierRating || '—') + '</b></span><span>' + [1, 2, 3, 4, 5].map(function(n){ return btn('stars', n + '★', '', ' data-stars="' + n + ' Star"'); }).join(' ') + '</span></div></div>' +
          (cand ? '<div class="obw-box obw-warnbox"><b>Is this the property on Google?</b><br>' + esc(cand.name || '') + '<br><small>' + esc(cand.address || '') + (cand.distance_km != null ? ' · ' + esc(String(cand.distance_km)) + ' km from its pin' : '') + '</small><div class="obw-btns">' + btn('googleYes', 'Yes, that’s it', 'primary') + '</div></div>' : '') +
          '<div class="obw-btns">' + btn('ratingLink', L.ratingLink ? 'Check the rating link again' : 'Get the rating link') + '</div>';
        break;
      case 'channels':
        h = head(s, 'Done here by Avante: no need to log in as the property. The owner only invites Avante on each channel.') + '<div class="obw-box">' +
          row('Listed on', esc(D.listedChannels.join(', ') || 'No other channels')) +
          row('Owner invited Avante on', esc((L.channelInvites ? L.channelInvites.channels.join(', ') : '') || (D.pa && D.pa.channelHelp ? (D.pa.channelHelp.channels || []).join(', ') : '') || 'Not yet')) + '</div>';
        if(D.pa && D.pa.connected) h += renderChannels();
        else h += '<p class="hint">Connect it first (step ' + (stepOf('connect') || {}).n + ').</p>';
        break;
      case 'owner':
        h = head(s, 'What the owner does in their own hub. Each takes a minute or two. The password doesn’t hold up Go live: the owner chooses it with Forgot your password? when they first log in.') + '<div class="obw-box">' +
          row('Chose a password', yes(D.hasPassword)) +
          (D.path === 'hosted' ? row('Saved how they take bookings and how guests pay (Channels)', yes(D.pa && D.pa.setupBookings)) : '') + '</div>' +
          '<div class="obw-btns">' + btn('ownerReminder', 'Send a reminder') + '</div>';
        break;
      case 'golive':
        var open = D.steps.filter(function(x){ return x.blocksGoLive; });
        var pwLater = !D.hasPassword && D.steps.some(function(x){ return x.id === 'owner' && x.status === 'owner' && !x.blocksGoLive; });
        h = head(s, 'Once every step above is done, Go live lists the property. The owner’s password doesn’t hold it up.') + '<div class="obw-box">' +
          (open.length ? open.map(function(x){ return row(x.n + '. ' + esc(x.title), chip(x.status)); }).join('') : row('Every step above', '<b class="obw-yes">Done</b>')) +
          (pwLater ? row('The owner’s password', 'They choose it with <b>Forgot your password?</b> when they first log in') : '') +
          (D.pa && D.pa.slug && D.path === 'hosted' ? row('Its booking page', '<a href="/stay/' + esc(D.pa.slug) + '" target="_blank" rel="noopener">open it to test a midweek and a weekend night</a>') : '') + '</div>' +
          (L.liveAt ? '<p class="acw-ok">✔ Live since ' + esc(fmt(L.liveAt)) + '</p>' : '<div class="obw-btns">' + btn('goLive', 'Go live', 'primary', s.status === 'you' ? '' : ' disabled') + '</div>');
        break;
    }
    return h;
  }

  // ---------- channels (iCal) for a property not on a channel manager ----------
  function renderChannels(){
    if(!S.ch){ loadChannels(); return '<p class="hint">Loading the channel links…</p>'; }
    if(S.ch.error) return '<p class="acw-err">' + esc(S.ch.error) + '</p>';
    var units = S.ch.view.units || [], listed = S.D.listedChannels;
    var h = units.map(function(u){
      return '<div class="obw-box"><b>' + esc(u.name) + '</b>' + u.channels.filter(function(c){ return c.importUrl || listed.indexOf(c.label) > -1; }).map(function(c){
        return '<div class="obw-chan"><div class="obw-row"><span><b>' + esc(c.label) + '</b></span><span>' + chip(c.status === 'ok' ? 'done' : c.importUrl ? 'wait' : 'you').replace(WHO.done, 'Connected').replace(WHO.wait, c.status === 'error' ? 'Not read' : 'Waiting for first read').replace(WHO.you, 'Not linked') + '</span></div>' +
          '<label class="hint">Avante link for ' + esc(c.label) + ' (paste it into ' + esc(c.label) + '’s calendar import)</label>' +
          '<div class="obw-copy"><input readonly value="' + esc(c.exportUrl) + '"><button type="button" class="btn-outline" data-copy="' + esc(c.exportUrl) + '">Copy</button></div>' +
          '<label class="hint">' + esc(c.label) + '’s calendar link (ends in .ics)</label><input data-imp="' + esc(u.name) + '|' + c.key + '" value="' + esc(c.importUrl) + '" placeholder="https://… .ics">' +
          (c.error ? '<p class="acw-err">' + esc(c.error) + '</p>' : '') + '</div>';
      }).join('') + '</div>';
    }).join('');
    var ev = S.ch.events || [], names = {};
    units.forEach(function(u){ u.channels.forEach(function(c){ names[c.key] = c.label; }); });
    h += '<div class="obw-btns">' + btn('saveLinks', 'Save the links', 'primary') + btn('syncNow', 'Check channels now') + '</div>';
    h += ev.length ? '<div class="obw-box obw-warnbox"><b>' + ev.length + ' channel booking' + (ev.length === 1 ? '' : 's') + ' not on Avante yet</b>' + ev.map(function(e){
      return '<div class="obw-row"><span>' + esc((names[e.channel] || e.channel || '') + ' · ' + e.start + ' → ' + e.end + ' · ' + (e.unit || '')) + (e.error ? '<br><small class="acw-err">' + esc(e.error) + '</small>' : '') + '</span>' +
        '<span>' + btn('addEvent', 'Add to Avante', 'primary', evAttrs(e)) + ' ' + btn('dismissEvent', 'Not a booking', '', evAttrs(e)) + '</span></div>';
    }).join('') + '</div>' : '<p class="hint">No channel bookings waiting.</p>';
    return h;
  }
  function evAttrs(e){ return ' data-unit="' + esc(e.unit) + '" data-channel="' + esc(e.channel) + '" data-uid="' + esc(e.uid) + '"'; }
  function loadChannels(){
    Promise.all([paPost('channels'), paPost('channelEvents')]).then(function(r){
      S.ch = r[0].ok ? { view: r[0], events: (r[1].events || []).filter(function(e){ return e.status !== 'booked'; }) } : { error: r[0].error || 'Could not read the channel links.' };
      render();
    }).catch(function(){ S.ch = { error: 'No connection. Try again.' }; render(); });
  }

  // ---------- buttons ----------
  function doStep(op, extra, okMsg){
    S.busy = true; S.msg = ''; S.err = ''; render();
    return post('onboardingDo', Object.assign({ listingId: S.id, op: op }, extra || {})).then(function(d){
      S.busy = false;
      if(!d.ok){ S.err = d.error || 'Could not do that.'; render(); return; }
      S.msg = okMsg || 'Done.'; return load(S.step);
    }).catch(function(){ S.busy = false; S.err = 'No connection. Try again.'; render(); });
  }
  function run(promise, okMsg){
    S.busy = true; S.msg = ''; S.err = ''; render();
    return promise.then(function(d){
      S.busy = false;
      if(d && d.ok === false || (d && d.error)){ S.err = d.error || 'Could not do that.'; render(); return; }
      S.msg = okMsg || 'Done.'; return load(S.step);
    }).catch(function(){ S.busy = false; S.err = 'No connection. Try again.'; render(); });
  }
  // A bigger job opens its own pop-up on top; this one checks again when it closes.
  function onTop(overlayId, opener){
    var other = document.getElementById(overlayId);
    opener();
    if(!other) return;
    var mo = new MutationObserver(function(){ if(!other.classList.contains('show')){ mo.disconnect(); load(S.step); } });
    mo.observe(other, { attributes: true, attributeFilter: ['class'] });
  }

  mainEl.addEventListener('click', function(e){
    var t = e.target.closest('button'); if(!t) return;
    var go = t.getAttribute('data-go');
    if(go){ S.step = go; S.audit = false; S.msg = ''; S.err = ''; render(); mainEl.scrollTop = 0; return; }
    var openId = t.getAttribute('data-open');
    if(openId){ open(openId, t.getAttribute('data-step') || ''); return; }
    var cp = t.getAttribute('data-copy');
    if(cp){ (navigator.clipboard ? navigator.clipboard.writeText(cp) : Promise.reject()).then(function(){ t.textContent = 'Copied ✔'; }, function(){ window.prompt('Copy this link:', cp); }); return; }
    var a = t.getAttribute('data-act'), L = S.D && S.D.listing;
    if(!a || !L) return;
    if(a === 'openListing') return onTop('propertyDetailsModalOverlay', function(){ window.openPropertyDetailsModal(L.listingId); });
    if(a === 'activate') return onTop('acwOverlay', function(){ window.openActivateFor({ hosted: S.D.path === 'hosted', resortId: L.resortId, name: L.propertyName, bbid: L.bbid }); });
    if(a === 'saveCheckIn') return doStep('setCheckIn', { checkInTime: (document.getElementById('obwCheckIn') || {}).value || '' }, 'Check-in time saved.');
    if(a === 'editLink') return run(post('sendEditLink', { listingId: L.listingId, to: L.contactEmail }), 'Edit link emailed to ' + L.contactEmail + '.');
    if(a === 'sendSheet') return run(post('siteNrSend', { siteNr: L.siteNr }), 'Set-up sheet sent again.');
    if(a === 'checkSN') return run(post('checkWaitingSetUps'), 'Checked Stock Network.');
    if(a === 'verifySite') return doStep('verifySite', null, 'Marked as the right site.');
    if(a === 'wrongSite'){ var note = window.prompt('What looks wrong? (This goes to Stock Network.)', ''); if(note === null) return; return doStep('wrongSite', { note: note }, 'Stock Network has been asked to check it.'); }
    if(a === 'checkPin') return doStep('checkPin', null, 'Pin checked and placed in the hub tree.');
    if(a === 'sendLocation') return doStep('sendLocation', null, 'The hub’s place names went to Stock Network.');
    if(a === 'stars') return doStep('setStars', { stars: t.getAttribute('data-stars') }, 'Star rating saved.');
    if(a === 'ratingLink') return run(post('getRatingLink', { listingId: L.listingId }), 'Rating link checked.');
    if(a === 'googleYes') return run(post('getRatingLink', { listingId: L.listingId, confirmPlaceId: L.ratingGoogleCandidate.place_id }), 'Google listing confirmed.');
    if(a === 'ownerReminder') return doStep('ownerReminder', null, 'Reminder emailed to the owner.');
    if(a === 'goLive'){ if(!window.confirm('List ' + L.propertyName + ' as live?')) return; return doStep('goLive', null, L.propertyName + ' is live.'); }
    if(a === 'saveLinks'){
      var channels = {};
      mainEl.querySelectorAll('[data-imp]').forEach(function(el){ var p = el.getAttribute('data-imp').split('|'); (channels[p[0]] = channels[p[0]] || {})[p[1]] = el.value.trim(); });
      S.ch = null; return run(paPost('saveChannelLinks', { channels: channels }), 'Links saved. The hub reads them every 15 minutes.');
    }
    if(a === 'syncNow'){ S.ch = null; return run(paPost('syncNow'), 'Channels read just now.'); }
    if(a === 'addEvent' || a === 'dismissEvent'){
      var ev = { unit: t.getAttribute('data-unit'), channel: t.getAttribute('data-channel'), uid: t.getAttribute('data-uid') };
      S.ch = null; return a === 'addEvent' ? run(paPost('addChannelEvent', ev), 'Added to Avante.') : run(paPost('dismissChannelEvent', ev), 'Removed: it was not a booking.');
    }
  });
  railEl.addEventListener('click', function(e){ var t = e.target.closest('[data-go]'); if(!t) return; S.step = t.getAttribute('data-go'); S.audit = false; S.msg = ''; S.err = ''; render(); mainEl.scrollTop = 0; });
  document.getElementById('obwOutstanding').addEventListener('click', function(){ if(S.id){ S.audit = true; S.msg = ''; render(); } else openAll(); });
  document.getElementById('obwClose').addEventListener('click', close);
  backBtn.addEventListener('click', function(){
    if(!S.D) return; var ids = S.D.steps.map(function(x){ return x.id; }), i = ids.indexOf(S.step);
    if(i <= 0){ S.audit = true; } else S.step = ids[i - 1];
    S.msg = ''; S.err = ''; render(); mainEl.scrollTop = 0;
  });
  nextBtn.addEventListener('click', function(){
    if(!S.D) return; var ids = S.D.steps.map(function(x){ return x.id; });
    if(S.audit){ S.step = (S.D.outstanding[0] || {}).id || ids[0]; S.audit = false; }
    else { var i = ids.indexOf(S.step); if(i < ids.length - 1) S.step = ids[i + 1]; else S.audit = true; }
    S.msg = ''; S.err = ''; render(); mainEl.scrollTop = 0;
  });

  window.openPropertySetup = open;
  window.openOutstandingAll = openAll;
})();

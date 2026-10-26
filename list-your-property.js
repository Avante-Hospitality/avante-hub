// List your property, step by step (Jean, 2026-10-25). See the comment at the
// top of avante-channel-manager-listing.html for the two paths.
(function(){
  var API = '/api/property-onboarding';
  var C = window.AvanteCommission;
  var $ = function(id){ return document.getElementById(id); };
  var form = $('lyp'), back = $('back'), next = $('next'), errEl = $('err');
  var ICAL = ['Airbnb', 'Booking.com', 'LekkeSlaap'];
  var INVITE_HOW = {
    'Airbnb': 'On Airbnb, invite Avante as a co-host on your listing, using the email above.',
    'Booking.com': 'On Booking.com, add Avante as a user on your property, using the email above.',
    'LekkeSlaap': 'On LekkeSlaap, add Avante as a user on your account, using the email above.'
  };
  var S = { i: 0, how: '', chans: {}, nb: null, nbOk: false, nbBusy: false, pin: null, map: null, marker: null, busy: false };

  function post(body){
    return fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){ d.__status = r.status; return d; }); });
  }
  function val(id){ return ($(id).value || '').trim(); }
  function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function showErr(m){ errEl.textContent = m || ''; errEl.hidden = !m; if(m) errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function picked(){ return Object.keys(S.chans).filter(function(k){ return S.chans[k]; }); }
  function icalPicked(){ return picked().filter(function(c){ return ICAL.indexOf(c) > -1; }); }
  function listText(a){ return a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : (a[0] || ''); }
  function pages(){
    if(S.how === 'channel') return ['how', 'prop', 'terms', 'done'];
    if(S.how === 'none') return ['how', 'prop', 'fill'].concat(icalPicked().length ? ['cal'] : []).concat(['terms', 'done']);
    return ['how'];
  }
  function cm(){ return $('cm').value; }

  // Commission wording comes from commission.js, the one place it is set.
  document.querySelectorAll('[data-own]').forEach(function(el){ el.textContent = C.ownText; });
  document.querySelectorAll('[data-std]').forEach(function(el){ el.textContent = C.STANDARD + '% + VAT'; });

  // ---------- drawing ----------
  function render(){
    var P = pages(), id = P[Math.min(S.i, P.length - 1)], count = Math.max(P.length - 1, 3);
    form.querySelectorAll('section[data-step]').forEach(function(s){ s.hidden = s.getAttribute('data-step') !== id; });
    form.querySelectorAll('[data-when]').forEach(function(el){ el.hidden = el.getAttribute('data-when') !== S.how; });
    form.querySelectorAll('[data-when-cm]').forEach(function(el){ el.hidden = el.getAttribute('data-when-cm') !== cm(); });
    form.querySelector('[data-when-other]').hidden = !S.chans.Other;
    $('lypStepNo').textContent = id === 'done' ? 'DONE' : 'STEP ' + (S.i + 1) + (S.how ? ' OF ' + count : '');
    $('lypBar').style.width = (id === 'done' ? 100 : Math.round((S.i + 1) / count * 100)) + '%';
    $('foot').hidden = id === 'done';
    back.style.visibility = S.i > 0 ? 'visible' : 'hidden';
    next.textContent = id === 'terms' ? 'Send to Avante' : 'Next';
    next.disabled = S.busy;
    // Channels note
    var ic = icalPicked(), note = $('chNote');
    if(S.how === 'none' && (ic.length || S.chans.None)){
      note.hidden = false;
      note.textContent = ic.length ? 'We’ll link ' + listText(ic) + ' to your Avante calendar, so you’re never double-booked.' : 'No calendars to link. Your Avante calendar is your only one, and you can add a channel later.';
    } else note.hidden = true;
    if(id === 'prop') propStep();
    if(id === 'fill') $('fillAvanteText').textContent = 'Send us screenshots of your ' + (ic[0] || 'Airbnb or LekkeSlaap') + ' listing and calendar, or your rate sheet (Word, Excel or PDF). We read them and fill in your listing.';
    if(id === 'cal') calStep(ic);
  }

  // ---------- step 1: how, the BBID ----------
  form.addEventListener('change', function(e){
    if(e.target.name === 'how'){ S.how = e.target.value; showErr(''); render(); }
    if(e.target.id === 'cm'){ render(); }
  });
  $('chips').addEventListener('click', function(e){
    var b = e.target.closest('[data-ch]'); if(!b) return;
    var k = b.getAttribute('data-ch');
    if(k === 'None') S.chans = { None: !S.chans.None };
    else { S.chans[k] = !S.chans[k]; delete S.chans.None; }
    document.querySelectorAll('#chips [data-ch]').forEach(function(x){ x.setAttribute('aria-pressed', S.chans[x.getAttribute('data-ch')] ? 'true' : 'false'); });
    showErr(''); render();
  });
  var bbidTimer = null;
  $('bbid').addEventListener('input', function(){ S.nb = null; S.nbOk = false; $('nbFound').hidden = true; clearTimeout(bbidTimer); bbidTimer = setTimeout(lookupBbid, 700); });
  function lookupBbid(){
    var id = val('bbid').replace(/^0+/, '');
    if(!/^\d{2,9}$/.test(id)) return;
    S.nbBusy = true;
    var box = $('nbFound'); box.hidden = false; box.className = 'lyp-found'; box.textContent = 'Checking NightsBridge…';
    post({ action: 'nbLookup', bbid: id }).then(function(d){
      S.nbBusy = false;
      if(val('bbid').replace(/^0+/, '') !== id) return;
      if(d.ok){
        S.nb = d.property;
        box.innerHTML = '<span>Found on NightsBridge: <b>' + esc(d.property.name) + '</b>' + (d.property.suburb ? ', ' + esc(d.property.suburb) : '') + '. Is this you?</span>' +
          '<button type="button" class="lyp-btn2" id="nbYes" style="flex:none;min-height:44px">Yes, that’s me</button>';
        $('nbYes').addEventListener('click', function(){ S.nbOk = true; box.innerHTML = '<span>✓ <b>' + esc(S.nb.name) + '</b></span>'; showErr(''); });
      } else {
        S.nb = null;
        box.className = 'lyp-found lyp-bad';
        box.textContent = d.notFound ? (d.error || 'NightsBridge has no property with that number. Check it.') : 'We couldn’t check NightsBridge just now. You can carry on: Avante will check it.';
        if(!d.notFound) S.nbOk = true;
      }
    }).catch(function(){ S.nbBusy = false; box.className = 'lyp-found lyp-bad'; box.textContent = 'We couldn’t check NightsBridge just now. You can carry on: Avante will check it.'; S.nbOk = true; });
  }

  // ---------- step 2: the property and its pin ----------
  function propStep(){
    var nb = S.nb;
    $('propSub').textContent = S.how === 'channel' ? 'Your photos, rooms and rates come from ' + cm() + '. We filled in what it shows: check it and add who handles bookings.' : 'Who Avante talks to, and where your property is.';
    if(nb && S.how === 'channel' && !form.__prefilled){
      form.__prefilled = true;
      if(!val('pname')) $('pname').value = nb.name || '';
      if(!val('cname')) $('cname').value = nb.contact || '';
      if(!val('cemail')) $('cemail').value = nb.email || '';
      if(!val('cphone')) $('cphone').value = nb.phone || '';
      if(nb.lat != null) S.pin = { lat: nb.lat, lng: nb.lng };
    }
    setTimeout(drawMap, 0);
  }
  function drawMap(){
    if(!window.L) return;
    var c = S.pin || { lat: -29, lng: 25 };
    if(!S.map){
      S.map = L.map('map', { scrollWheelZoom: false }).setView([c.lat, c.lng], S.pin ? 15 : 5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.map);
      S.map.on('click', function(e){ setPin(e.latlng.lat, e.latlng.lng); });
      if(S.pin) setPin(S.pin.lat, S.pin.lng, true);
    } else S.map.invalidateSize();
  }
  function setPin(lat, lng, center){
    S.pin = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    $('pinText').textContent = 'Pin: ' + S.pin.lat + ', ' + S.pin.lng;
    if(!window.L || !S.map) return; // the map didn't load: the pin is kept all the same
    if(!S.marker){ S.marker = L.marker([S.pin.lat, S.pin.lng], { draggable: true }).addTo(S.map); S.marker.on('dragend', function(){ var p = S.marker.getLatLng(); setPin(p.lat, p.lng); }); }
    else S.marker.setLatLng([S.pin.lat, S.pin.lng]);
    if(center) S.map.setView([S.pin.lat, S.pin.lng], 15);
  }
  $('findPin').addEventListener('click', function(){
    var name = val('pname'), town = val('ptown'), out = $('pinHits');
    if(!name && !town){ showErr('Type the property name or town first.'); return; }
    out.innerHTML = '<p class="lyp-sub">Looking it up…</p>';
    post({ action: 'lookupLocation', name: name, address: town }).then(function(d){
      if(!d.ok){ out.innerHTML = '<p class="lyp-sub">' + esc(d.message || 'Not found. Tap the map where your property is instead.') + '</p>'; return; }
      out.innerHTML = d.candidates.map(function(c, i){ return '<button type="button" class="lyp-hit" data-hit="' + i + '"><b>' + esc(c.name || c.town || 'Here') + '</b> <small>' + esc(c.address || '') + '</small></button>'; }).join('') +
        '<p class="lyp-sub">Not there? Tap the map where your property is.</p>';
      out.__hits = d.candidates;
    }).catch(function(){ out.innerHTML = '<p class="lyp-sub">No connection. Tap the map where your property is instead.</p>'; });
  });
  $('pinHits').addEventListener('click', function(e){ var b = e.target.closest('[data-hit]'); if(!b) return; var c = $('pinHits').__hits[+b.getAttribute('data-hit')]; setPin(c.lat, c.lng, true); $('pinHits').innerHTML = ''; });

  // ---------- step 4: calendar invites ----------
  function calStep(ic){
    var box = $('calCards'), done = box.__done || {};
    box.innerHTML = ic.map(function(c){
      return '<div class="lyp-card"><b>' + esc(c) + '</b><p>' + esc(INVITE_HOW[c]) + '</p><label class="lyp-check"><input type="checkbox" data-inv="' + esc(c) + '"' + (done[c] ? ' checked' : '') + '><span>I’ve invited Avante on ' + esc(c) + '</span></label></div>';
    }).join('');
    box.__done = done;
  }
  $('calCards').addEventListener('change', function(e){ var c = e.target.getAttribute('data-inv'); if(c) $('calCards').__done[c] = e.target.checked; });
  post({ action: 'listingPageInfo' }).then(function(d){ if(d.ok && d.inviteEmail) $('inviteEmail').textContent = d.inviteEmail; }).catch(function(){});
  $('copyInvite').addEventListener('click', function(){ var t = $('inviteEmail').textContent, b = this; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function(){ b.textContent = 'Copied'; }, function(){ window.prompt('Copy this email address:', t); }); });

  // ---------- terms ----------
  $('openTerms').addEventListener('click', function(){ $('termsModal').hidden = false; });
  $('closeTerms').addEventListener('click', function(){ $('termsModal').hidden = true; });

  // ---------- moving on ----------
  function check(id){
    if(id === 'how'){
      if(!S.how) return 'Choose how you take bookings now.';
      if(S.how === 'channel'){
        if(cm() === 'NightsBridge'){
          if(!/^\d{2,9}$/.test(val('bbid').replace(/^0+/, ''))) return 'Type your NightsBridge number (BBID): only digits, e.g. 26762.';
          if(S.nbBusy) return 'One moment: still checking NightsBridge.';
          if(S.nb && !S.nbOk) return 'Tap “Yes, that’s me”, or check the number.';
          if(!S.nb && !S.nbOk){
            // Not looked up yet (typed and tapped Next at once): look it up now.
            if(!$('nbFound').classList.contains('lyp-bad')){ lookupBbid(); return 'Checking your NightsBridge number…'; }
            return 'Check your NightsBridge number: we couldn’t find it.';
          }
        } else if(!val('eres')) return 'Type your eRes / NebulaCRS property reference.';
      } else {
        if(!picked().length) return 'Tap where else you are listed, or Nowhere else yet.';
        if(S.chans.Other && !val('other')) return 'Type which other website you are on.';
      }
    }
    if(id === 'prop'){
      if(!val('pname')) return 'Type the property name.';
      if(!val('cname')) return 'Type who handles bookings and questions.';
      var em = val('cemail').split(/[,;\s]+/).filter(Boolean);
      if(!em.length || em.some(function(x){ return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); })) return 'Check the email address. Separate several with a comma.';
      if(!val('cphone')) return 'Type their phone number.';
    }
    if(id === 'terms' && !$('terms').checked) return 'Tick that you accept the Avante Terms & Conditions.';
    return '';
  }
  next.addEventListener('click', function(){
    var P = pages(), id = P[S.i], m = check(id);
    showErr(m); if(m) return;
    if(id === 'terms') return submit();
    S.i = Math.min(S.i + 1, P.length - 1); render(); form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  back.addEventListener('click', function(){ if(S.i > 0){ S.i--; showErr(''); render(); } });

  function submit(){
    var channel = S.how === 'channel', ch = picked();
    var body = {
      action: 'listingRequest', propertyName: val('pname'), contactPerson: val('cname'), phone: val('cphone'), email: val('cemail'),
      ownerName: val('oname'), ownerPhone: val('ophone'),
      channelManager: channel ? cm() : 'None yet', bbid: channel && cm() === 'NightsBridge' ? val('bbid') : '', eresRef: channel && cm() !== 'NightsBridge' ? val('eres') : '',
      channels: channel ? ['None'] : ch, channelsOther: S.chans.Other ? val('other') : '',
      propertyAffiliate: true, acceptTerms: true,
      lat: S.pin ? S.pin.lat : null, lng: S.pin ? S.pin.lng : null,
      fillChoice: channel ? '' : ((form.querySelector('input[name=fill]:checked') || {}).value || 'avante'),
      channelInvites: channel ? [] : icalPicked().filter(function(k){ return ($('calCards').__done || {})[k]; })
    };
    S.busy = true; next.textContent = 'Sending…'; render();
    post(body).then(function(d){
      S.busy = false;
      if(!d.ok){ showErr(d.error || 'Something went wrong. Please try again, or email info@avantehospitality.co.za.'); render(); return; }
      var name = body.propertyName, text, link = '';
      if(channel) text = 'Avante is setting up ' + name + '. We’ll email your hub login as soon as it’s ready. There’s nothing else you need to do now.';
      else if(d.continueLink){
        var easy = body.fillChoice === 'avante';
        link = d.continueLink + (easy ? '#help' : '');
        text = easy ? 'Next, send us your screenshots or rate sheet and Avante fills in your listing. Every night starts open; once your calendars are linked, your other bookings close them by themselves.'
          : 'Next, your rooms, photos and rates, step by step. It saves every time you tap Next, and the link is in your email too.';
      } else text = d.linkSent ? 'We’ve emailed you the link to your listing. Open it to carry on.' : 'Your details are with Avante. We’ll be in touch.';
      $('doneText').textContent = text;
      var a = $('doneLink'); a.hidden = !link; if(link){ a.href = link; a.textContent = body.fillChoice === 'avante' ? 'Send Avante my files' : 'Fill in my listing'; }
      S.i = pages().length - 1; render();
    }).catch(function(){ S.busy = false; showErr('No connection. Please try again.'); render(); });
  }

  // Links in Avante's invite emails (Jean, 2026-10-26):
  //   ?bbid=26762  picks "I use a channel manager", NightsBridge, fills in the
  //                number and looks it up, so the owner only taps "Yes, that's me".
  //   ?how=none    picks "I don't use one".
  (function(){
    var q = new URLSearchParams(location.search);
    var bb = (q.get('bbid') || '').replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
    var how = bb ? 'channel' : (q.get('how') === 'none' ? 'none' : q.get('how') === 'channel' ? 'channel' : '');
    if(!how) return;
    var radio = form.querySelector('input[name="how"][value="' + how + '"]');
    if(radio) radio.checked = true;
    S.how = how;
    if(bb){ $('cm').value = 'NightsBridge'; $('bbid').value = bb; }
    render();
    if(bb) lookupBbid();
  })();

  render();
})();

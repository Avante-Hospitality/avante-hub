/* Search (Jean, 2026-10-20): a magnifying glass in the header of the hub and
   Admin. Type what you're looking for; it lists the screens, parts of screens
   and how-to steps that match, and takes you straight there.
     <script src="site-search.js" data-guides="how-to.html how-to-property.html@property" defer></script>
   data-guides: the how-to guides to search. "guide@panel" = only when that
   panel (tab) is shown to this user. A guide section whose id is a panel id
   (panel-accom -> #accom) is only listed when that panel is shown, so people
   only find what they can use (affiliate types, channel properties).
   Nothing to keep up to date: it reads the page's own tabs and headings and
   the guides as they are. */
(function () {
  'use strict';
  var me = document.currentScript || document.querySelector('script[src*="site-search.js"]');
  var GUIDES = ((me && me.getAttribute('data-guides')) || '').split(/\s+/).filter(Boolean).map(function (g) { var p = g.split('@'); return { url: p[0], panel: p[1] || '' }; });
  // Words people use for the same thing. Any word in a group finds the others.
  var SAME = [
    ['pay', 'payment', 'payments', 'payout', 'payouts', 'paid', 'commission', 'earn', 'earnings', 'money', 'revenue'],
    ['flyer', 'flyers', 'hook', 'hooks', 'photo', 'photos', 'caption', 'captions', 'builder', 'image', 'images', 'post', 'canva'],
    ['link', 'links', 'url', 'short', 'shortlink'],
    ['password', 'login', 'log', 'sign', 'signin'],
    ['store', 'storefront', 'shop', 'front'],
    ['activity', 'activities', 'tour', 'tours', 'things', 'excursion', 'excursions'],
    ['booking', 'bookings', 'reservation', 'reservations', 'book'],
    ['property', 'properties', 'listing', 'listings', 'accommodation', 'stay', 'hotel', 'resort'],
    ['map', 'maps', 'pin', 'coordinates', 'location', 'tree'],
    ['esim', 'sim', 'data'],
    ['car', 'cars', 'rental', 'hire'],
    ['flight', 'flights', 'fly'],
    ['account', 'bank', 'profile', 'details'],
    ['email', 'emails', 'mail'],
    ['calendar', 'availability', 'dates'],
    ['review', 'reviews', 'rating'],
    ['affiliate', 'affiliates', 'agent', 'agents'],
    ['help', 'how', 'guide', 'tutorial', 'tutorials']
  ];
  function words(t) { return String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean); }
  function variants(w) {
    var out = [w];
    SAME.forEach(function (g) { if (g.indexOf(w) >= 0) out = out.concat(g); });
    return out;
  }
  function clean(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

  var css = document.createElement('style');
  css.textContent =
    '.ss-btn{width:46px;height:46px;border-radius:10px;border:1.5px solid #e3e9e8;background:#fff;color:#0e2f44;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none;margin-left:auto;margin-right:8px;}' +
    '.ss-btn:hover,.ss-btn:focus-visible{border-color:#0DCDC2;outline:none;}' +
    '.ss-pop{position:absolute;right:16px;top:100%;margin-top:6px;width:min(520px,calc(100vw - 32px));background:#fff;border:1.5px solid #e3e9e8;border-radius:14px;box-shadow:0 18px 40px rgba(14,47,68,.18);padding:10px;z-index:80;display:none;}' +
    '.ss-pop.open{display:block;}' +
    '.ss-pop input{width:100%;box-sizing:border-box;min-height:44px;padding:0 12px;border:1.5px solid #e3e9e8;border-radius:10px;font:16px Montserrat,sans-serif;color:#0e2f44;}' +
    '.ss-pop input:focus{outline:none;border-color:#0DCDC2;}' +
    '.ss-list{list-style:none;margin:8px 0 0;padding:0;max-height:60vh;overflow-y:auto;}' +
    '.ss-list li{margin:0;}' +
    '.ss-list button{display:block;width:100%;text-align:left;background:none;border:0;border-radius:8px;padding:9px 10px;cursor:pointer;font:600 14px Montserrat,sans-serif;color:#0e2f44;}' +
    '.ss-list button:hover,.ss-list button.on{background:#e9faf8;}' +
    '.ss-list small{display:block;font-weight:500;font-size:12px;color:#5b6b76;margin-top:2px;}' +
    '.ss-none{padding:10px;font:14px Montserrat,sans-serif;color:#5b6b76;}' +
    '.ss-flash{outline:3px solid #0DCDC2;outline-offset:4px;border-radius:6px;transition:outline-color 1.5s;}' +
    '@media (max-width:600px){.ss-btn{width:42px;height:42px;margin-right:6px;}.ss-pop{right:8px;width:calc(100vw - 16px);}}';
  document.head.appendChild(css);

  var header = document.querySelector('header.hub-header');
  if (!header) return;
  var brand = header.querySelector('.brand');
  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'ss-btn'; btn.setAttribute('aria-label', 'Search'); btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4.2-4.2"></path></svg>';
  if (brand && brand.nextSibling) header.insertBefore(btn, brand.nextSibling); else header.appendChild(btn);
  if (getComputedStyle(header).position === 'static') header.style.position = 'relative';
  var pop = document.createElement('div');
  pop.className = 'ss-pop'; pop.setAttribute('role', 'search');
  pop.innerHTML = '<input type="search" placeholder="What are you looking for?" aria-label="What are you looking for?" autocomplete="off"><ul class="ss-list" role="listbox"></ul>';
  header.appendChild(pop);
  var input = pop.querySelector('input'), list = pop.querySelector('.ss-list');

  // ---- What can be found ----
  function hiddenOn(el, stopAt) {
    for (var n = el; n && n !== stopAt && n.nodeType === 1; n = n.parentElement) {
      if (n.classList.contains('type-hidden') || n.hidden || n.style.display === 'none') return true;
    }
    return false;
  }
  function shownTab(tab) { return !hiddenOn(tab, document.body); }
  function panelShown(name) { var t = document.querySelector('.tab[data-panel="' + name + '"]'); return !!t && shownTab(t); }
  function pageItems() {
    var out = [];
    document.querySelectorAll('.tab[data-panel]').forEach(function (tab) {
      if (!shownTab(tab)) return;
      var name = tab.getAttribute('data-panel'), tabName = clean(tab.textContent), panel = document.getElementById('panel-' + name);
      out.push({ label: tabName, where: 'Screen', text: tabName, go: function () { tab.click(); window.scrollTo(0, 0); } });
      if (!panel) return;
      panel.querySelectorAll('h1, h2, h3, h4').forEach(function (h) {
        var t = clean(h.textContent);
        if (!t || t.length > 90 || hiddenOn(h, panel)) return;
        // The words just under the heading help it be found ("resort file" finds "Add from Stock Network's file").
        var next = h.nextElementSibling, more = next && /^(P|DIV)$/.test(next.tagName) ? clean(next.textContent).slice(0, 300) : '';
        out.push({ label: t, where: tabName, text: t + ' ' + tabName + ' ' + more, go: function () { tab.click(); flash(h); } });
      });
      // Property Affiliate's own tabs (only the ones this property has).
      panel.querySelectorAll('.pa-tabbar button[data-act="view"]').forEach(function (b) {
        var t = clean(b.textContent), v = b.getAttribute('data-v');
        out.push({ label: t, where: tabName, text: t + ' ' + tabName, go: function () {
          tab.click(); var again = panel.querySelector('.pa-tabbar button[data-act="view"][data-v="' + v + '"]'); if (again) again.click(); flash(panel.querySelector('.pa-tabbar') || panel);
        } });
      });
    });
    // Menu links (How-to Guide, Change Password, Log Out ...).
    document.querySelectorAll('nav.tabs .menu-actions a').forEach(function (a) {
      var t = clean(a.textContent); if (!t || hiddenOn(a, document.body)) return;
      out.push({ label: t, where: 'Menu', text: t, go: function () { a.click(); } });
    });
    return out;
  }
  var guideCache = null;
  function guideItems() {
    if (guideCache) return Promise.resolve(guideCache);
    return Promise.all(GUIDES.map(function (g) {
      return fetch(g.url).then(function (r) { return r.ok ? r.text() : ''; }).then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html'), out = [];
        doc.querySelectorAll('section[id]').forEach(function (s) {
          var h2 = s.querySelector('h2'), title = clean(h2 && h2.textContent).replace(/^[^A-Za-z0-9]+/, '');
          // Split the section at its h3s: each part is one result.
          var part = { label: title, text: '' }, parts = [part];
          [].slice.call(s.children).forEach(function (c) {
            if (c.tagName === 'H3') { part = { label: clean(c.textContent), text: '' }; parts.push(part); }
            else if (c.tagName !== 'H2') part.text += ' ' + clean(c.textContent);
          });
          parts.forEach(function (p, i) {
            if (!p.label) return;
            out.push({ label: p.label, where: 'How-to guide' + (i ? ' · ' + title : ''), text: p.label + ' ' + title + ' ' + p.text, href: g.url + '#' + s.id, section: s.id, onlyWith: g.panel });
          });
        });
        return out;
      }).catch(function () { return []; });
    })).then(function (all) { guideCache = [].concat.apply([], all); return guideCache; });
  }
  // Property guide sections for Property Affiliate's own tabs: listed only when this
  // property has that tab (a channel property's Front store and Activities are off until Avante ticks them).
  var PA_VIEW = { avail: 'avail', book: 'book', guests: 'guests', acts: 'acts', msgs: 'msgs', frontstore: 'front', chan: 'chan', 'channels-links': 'chan', rev: 'rev' };
  function canUse(it) {
    if (!it.href) return true;
    if (it.onlyWith && !panelShown(it.onlyWith)) return false;
    var bar = it.onlyWith && document.querySelector('.pa-tabbar');
    if (bar && PA_VIEW[it.section] && !bar.querySelector('button[data-v="' + PA_VIEW[it.section] + '"]')) return false;
    // A step about the front store or activities inside another part (e.g. Bookings).
    if (bar && /front store/i.test(it.label) && !bar.querySelector('button[data-v="front"]')) return false;
    if (bar && /activit/i.test(it.label) && !bar.querySelector('button[data-v="acts"]')) return false;
    // A guide section about a screen this user doesn't have.
    var t = document.querySelector('.tab[data-panel="' + it.section + '"]');
    return !t || shownTab(t);
  }

  // ---- Matching ----
  function score(it, q) {
    var label = ' ' + words(it.label).join(' ') + ' ', text = ' ' + words(it.text).join(' ') + ' ', s = 0;
    for (var i = 0; i < q.length; i++) {
      var vs = variants(q[i]), best = 0;
      vs.forEach(function (v) {
        var exact = v === q[i];
        if (label.indexOf(' ' + v) >= 0) best = Math.max(best, exact ? 4 : 3);
        else if (text.indexOf(' ' + v) >= 0) best = Math.max(best, exact ? 2 : 1);
      });
      if (!best) return 0;
      s += best;
    }
    return s + (it.href ? 0 : 0.5); // a screen first when equal
  }
  var shown = [], sel = 0, page = [];
  function run() {
    var q = words(input.value);
    if (!q.length) { list.innerHTML = ''; shown = []; return; }
    guideItems().then(function (guide) {
      if (words(input.value).join(' ') !== q.join(' ')) return;
      var seen = {}, hits = page.concat(guide.filter(canUse)).map(function (it) { return { it: it, s: score(it, q) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .filter(function (x) { var k = x.it.label.toLowerCase() + '|' + x.it.where; if (seen[k]) return false; seen[k] = 1; return true; });
      var screens = hits.filter(function (x) { return !x.it.href; }).slice(0, 8), guides = hits.filter(function (x) { return x.it.href; }).slice(0, 5);
      shown = screens.concat(guides).map(function (x) { return x.it; }); sel = 0;
      list.innerHTML = shown.length ? shown.map(function (it, i) {
        return '<li><button type="button" role="option" data-i="' + i + '"' + (i === 0 ? ' class="on"' : '') + '>' + esc(it.label) + '<small>' + esc(it.href ? it.where + ' (opens in a new tab)' : it.where === 'Screen' ? 'Go to this screen' : 'On ' + it.where) + '</small></button></li>';
      }).join('') : '<li class="ss-none">Nothing found. Try another word, like "link", "payout" or "hook".</li>';
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function flash(el) {
    if (!el) return;
    setTimeout(function () {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ss-flash'); setTimeout(function () { el.classList.remove('ss-flash'); }, 2200);
    }, 60);
  }
  function pick(i) {
    var it = shown[i]; if (!it) return;
    setOpen(false);
    if (it.href) window.open(it.href, '_blank', 'noopener'); else it.go();
  }
  function setOpen(open) {
    pop.classList.toggle('open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { page = pageItems(); input.value = ''; list.innerHTML = ''; shown = []; input.focus(); guideItems(); }
  }
  btn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(!pop.classList.contains('open')); });
  input.addEventListener('input', run);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!shown.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      list.querySelectorAll('button').forEach(function (b, i) { b.classList.toggle('on', i === sel); });
    }
  });
  list.addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (b) pick(+b.getAttribute('data-i')); });
  document.addEventListener('click', function (e) { if (pop.classList.contains('open') && !pop.contains(e.target) && e.target !== btn) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pop.classList.contains('open')) { setOpen(false); btn.focus(); } });
})();

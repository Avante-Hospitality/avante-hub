// Accommodation booking links, for the hub's pages (hub.html, admin.html,
// landing.html, property-affiliate.js). The browser twin of
// netlify/edge-functions/lib/booking-link.js and lib/tree-place.js — keep
// them in step.
//
// Every booking goes through the Avante holiday builder search screen,
// one company page per Stock Network site GUID:
//   https://avantetravel.co.za/holiday-builder/<site GUID>.php
//     ?country=&province=&region=&city=&suburb=&property=&resort=<ResortID>
//     &destination=<most specific of those>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD
// The place fields follow the hub's location tree (Country › Province ›
// Region › City › Suburb › Property) down to whatever the link is for. A
// property in two regions carries both, comma-separated. Old Stock Network
// portal links (stock.stocknetwork.co.za/ui/<GUID>?...) are still understood
// and converted.
(function (root) {
  var BASE = 'https://avantetravel.co.za/holiday-builder/';
  var SN_HOST = 'stock.stocknetwork.co.za';
  var GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var FIELDS = ['country', 'province', 'region', 'city', 'suburb', 'property'];
  var LEVELS = ['Country', 'Province', 'Region', 'City', 'Suburb', 'Property'];

  function clean(v) {
    if (Array.isArray(v)) v = v.filter(Boolean).join(', ');
    v = v == null ? '' : String(v).trim();
    return /^\(/.test(v) ? '' : v; // "(no region)" etc. are not places
  }
  function mostSpecific(opts) {
    for (var i = FIELDS.length - 1; i >= 0; i--) {
      var v = clean(opts[FIELDS[i]]);
      if (v) return FIELDS[i] === 'region' ? v.split(', ')[0] : v;
    }
    return '';
  }

  // opts: { country, province, region, city, suburb, property, resortId,
  //         destination, checkIn, checkOut } — all optional.
  function build(siteId, opts) {
    if (!siteId) return '';
    opts = opts || {};
    var p = new URLSearchParams();
    FIELDS.forEach(function (f) { var v = clean(opts[f]); if (v) p.set(f, v); });
    if (opts.resortId) p.set('resort', String(opts.resortId));
    var dest = clean(opts.destination) || mostSpecific(opts);
    if (dest) p.set('destination', dest);
    if (opts.checkIn) p.set('checkin', String(opts.checkIn));
    if (opts.checkOut) p.set('checkout', String(opts.checkOut));
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
      : { resort: 'resortId', checkin: 'checkIn', checkout: 'checkOut', destination: 'destination',
          country: 'country', province: 'province', region: 'region', city: 'city', suburb: 'suburb', property: 'property' };
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

  // ---------- The location tree ----------
  // Loads the same placements the Hub's pages use: tree-places.json, with
  // the live placements (/api/tree-lookup) winning, and names from
  // /api/resorts. Resolves to a tree object (see makeTree). Loaded once.
  var treePromise = null;
  function loadTree() {
    if (treePromise) return treePromise;
    treePromise = Promise.all([
      fetch('tree-places.json').then(function (r) { return r.json(); }),
      fetch('/api/tree-lookup?kind=properties').then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetch('/api/resorts').then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      var places = Object.assign({}, (res[0] && res[0].places) || {}, (res[1] && res[1].properties) || {});
      var list = (res[2] && (res[2].resorts || res[2].list)) || (Array.isArray(res[2]) ? res[2] : []);
      var names = {};
      list.forEach(function (r) { if (r && r.resortId && r.name && !names[r.resortId]) names[r.resortId] = r.name; });
      return makeTree(places, names);
    });
    treePromise.catch(function () { treePromise = null; });
    return treePromise;
  }

  function makeTree(places, names) {
    // One path per (property, region): a property in two regions sits under both.
    var rows = [];
    Object.keys(places).forEach(function (id) {
      var pl = places[id];
      if (!pl || !names[id]) return; // only properties that are on the resort list
      var t = clean(pl.t), s = clean(pl.s);
      var regions = (pl.r || []).map(clean).filter(Boolean);
      (regions.length ? regions : ['']).forEach(function (reg) {
        rows.push({ id: id, name: names[id], path: [clean(pl.c), clean(pl.p), reg, t, s && s !== t ? s : ''] });
      });
    });
    // A property's own link opts: full path, every region, its name.
    function forResort(id) {
      var pl = places[id];
      if (!pl) return names[id] ? { property: names[id] } : {};
      var t = clean(pl.t), s = clean(pl.s);
      return { country: clean(pl.c), province: clean(pl.p), region: clean(pl.r || []), city: t,
        suburb: s && s !== t ? s : '', property: names[id] || '' };
    }
    function under(r, sel) {
      for (var i = 0; i < sel.length; i++) if (r.path[i] !== sel[i]) return false;
      return true;
    }
    // Place names one level below a partial path (values for levels 0..n-1).
    function children(sel) {
      var depth = sel.length, seen = {}, out = [];
      rows.forEach(function (r) {
        var v = r.path[depth];
        if (!v || seen[v] || !under(r, sel)) return;
        seen[v] = 1;
        out.push(v);
      });
      // South Africa first, then the rest A–Z.
      return out.sort(function (a, b) { return (b === 'South Africa') - (a === 'South Africa') || a.localeCompare(b); });
    }
    // Properties anywhere under a partial path, as [{ id, name }].
    function properties(sel) {
      var seen = {}, out = [];
      rows.forEach(function (r) {
        if (seen[r.id] || !under(r, sel)) return;
        seen[r.id] = 1;
        out.push({ id: r.id, name: r.name });
      });
      return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    }
    // A picked partial path (or one property) as link opts.
    function optsFor(sel, resortId) {
      if (resortId) {
        var o = forResort(resortId);
        o.resortId = resortId;
        return o;
      }
      var o2 = {};
      sel.forEach(function (v, i) { if (v) o2[FIELDS[i]] = v; });
      return o2;
    }
    return { forResort: forResort, children: children, properties: properties, optsFor: optsFor, count: rows.length };
  }

  // A cascading "Country › Province › Region › City › Suburb › Property"
  // picker inside `container`. onChange(opts) gets link opts for the
  // deepest level picked ({} when nothing is). Returns { reset() }.
  function mountTreePicker(container, onChange) {
    container.innerHTML = '<div class="tree-picker-status" style="font-size:12px;color:#808080;padding:4px 0;">Loading the location tree…</div>';
    var api = { reset: function () {} };
    loadTree().then(function (tree) {
      container.innerHTML = '';
      var wrap = document.createElement('div');
      wrap.className = 'tree-picker';
      wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;';
      container.appendChild(wrap);
      var path = container.appendChild(document.createElement('div'));
      path.className = 'hint tree-picker-path';
      path.style.marginTop = '6px';
      var selects = [], usel = null;
      LEVELS.forEach(function (lv, i) {
        var lab = document.createElement('label');
        lab.style.cssText = 'display:flex;flex-direction:column;gap:3px;font-size:12px;margin:0;';
        lab.textContent = lv;
        var sel = document.createElement('select');
        sel.disabled = true;
        sel.addEventListener('change', function () { fill(i + 1); emit(); });
        lab.appendChild(sel);
        wrap.appendChild(lab);
        selects.push(sel);
      });
      // The consecutive levels picked so far, top down (at most `upto`).
      function picked(upto) {
        var out = [];
        for (var i = 0; i < upto && i < 5; i++) { if (!selects[i].value) break; out.push(selects[i].value); }
        return out;
      }
      function option(sel, value, label) {
        var op = document.createElement('option');
        op.value = value; op.textContent = label; sel.appendChild(op);
      }
      // Refill every level from `from` down. Places come one level at a
      // time; properties are listed once a city is picked (all of them
      // under the deepest level picked, suburb or not).
      function fill(from) {
        for (var i = from; i < selects.length; i++) {
          var sel = selects[i];
          var sofar = picked(i);
          sel.innerHTML = '';
          var items = [];
          if (i < 5) {
            if (sofar.length === i) items = tree.children(sofar).map(function (v) { return { value: v, label: v }; });
          } else {
            var deep = picked(5);
            if (deep.length >= 4) items = tree.properties(deep).map(function (p) { return { value: p.id, label: p.name }; });
          }
          var last = sofar[sofar.length - 1];
          option(sel, '', i === 0 ? 'Pick a country' : (items.length ? (i < 5 ? 'All of ' + last : 'No single property') : '—'));
          items.forEach(function (o) { option(sel, o.value, o.label); });
          sel.disabled = !items.length;
        }
      }
      function emit() {
        var sel = picked(5);
        var resortId = selects[5].value;
        var opts = sel.length || resortId ? tree.optsFor(sel, resortId) : {};
        var shown = [];
        FIELDS.forEach(function (f) { if (opts[f]) shown.push(opts[f]); });
        path.textContent = shown.length ? shown.join(' › ') : 'Nothing picked: the link searches everything.';
        if (usel && usel._for !== selects[5].value) { usel._for = selects[5].value; fillUnits(); }
        onChange(opts);
      }
      // Under the property: its unit types (Jean, 2026-10-14) — each kind of
      // unit once, with what it sleeps. For information only: the link stays
      // the property's own link.
      var ulab = document.createElement('label');
      ulab.style.cssText = 'display:flex;flex-direction:column;gap:3px;font-size:12px;margin:0;';
      ulab.textContent = 'Unit type';
      usel = document.createElement('select'); usel.disabled = true; usel._for = null; ulab.appendChild(usel); wrap.appendChild(ulab);
      var udet = container.appendChild(document.createElement('div'));
      udet.className = 'hint tree-picker-unit'; udet.style.marginTop = '4px';
      function fillUnits() {
        var id = selects[5].value; usel.innerHTML = ''; udet.textContent = '';
        if (!id) { option(usel, '', '—'); usel.disabled = true; return; }
        option(usel, '', 'Loading…'); usel.disabled = true;
        loadUnits().then(function (u) {
          if (selects[5].value !== id) return;
          var ls = u[id] || u[String(id).toLowerCase()] || []; usel.innerHTML = '';
          option(usel, '', ls.length ? ls.length + (ls.length === 1 ? ' unit type' : ' unit types') : 'None listed on Stock Network');
          ls.forEach(function (l, k) { option(usel, String(k), unitLabel(l)); });
          usel.disabled = !ls.length; usel._lines = ls;
        });
      }
      usel.addEventListener('change', function () { var l = (usel._lines || [])[+usel.value]; udet.textContent = usel.value === '' || !l ? '' : unitDetail(l); });
      api.reset = function () { selects[0].value = ''; fill(1); emit(); };
      fill(0);
      emit();
    }).catch(function () {
      container.innerHTML = '<div style="font-size:12px;color:#b42318;padding:4px 0;">The location tree could not be loaded. Refresh the page to try again.</div>';
    });
    return api;
  }

  // ---------- Unit types per property (/api/sn-units, Jean 2026-10-14) ----------
  // Line: [type, sleeps, bedrooms, count, unitNames]. Loaded only when needed (about 300 KB).
  var unitsPromise = null;
  function loadUnits() {
    if (unitsPromise) return unitsPromise;
    unitsPromise = fetch('/api/sn-units').then(function (r) { if (!r.ok) throw new Error('units'); return r.json(); })
      .catch(function () { return fetch('sn-units.json').then(function (r) { return r.json(); }); })
      .then(function (d) { return (d && d.units) || {}; });
    unitsPromise.catch(function () { unitsPromise = null; });
    return unitsPromise;
  }
  function unitLabel(l) { return l[0] + (l[1] ? ' · ' + l[1] + ' sleeper' : '') + (l[3] > 1 ? ' (×' + l[3] + ')' : ''); }
  function unitDetail(l) {
    var d = [l[1] ? 'Sleeps ' + l[1] : 'Sleeps: not given on Stock Network'];
    if (l[2] === 0) d.push('studio'); else if (l[2]) d.push(l[2] + (l[2] === 1 ? ' bedroom' : ' bedrooms'));
    d.push(l[3] + (l[3] === 1 ? ' unit' : ' units') + (l[4] && l[4].length ? ': ' + l[4].join(', ') : ''));
    return d.join(' · ');
  }

  // A small "Units ▸" button for a property row in any tree, and the list it
  // opens (put the list right after the row). Jean, 2026-10-14.
  function unitToggle(resortId) {
    var btn = document.createElement('button'), list = document.createElement('div');
    btn.type = 'button'; btn.textContent = 'Units ▸'; btn.setAttribute('aria-expanded', 'false');
    btn.style.cssText = 'margin-left:auto;flex:none;border:1px solid #cfdcdb;background:#fff;color:#0e2f44;border-radius:6px;font:600 11.5px inherit;padding:2px 8px;cursor:pointer;';
    list.hidden = true; list.style.cssText = 'margin:0 0 6px 40px;padding-left:10px;border-left:2px solid #e3e9e8;font-size:12.5px;';
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var open = list.hidden; list.hidden = !open; btn.textContent = open ? 'Units ▾' : 'Units ▸'; btn.setAttribute('aria-expanded', String(open));
      if (!open || list.childNodes.length) return;
      list.textContent = 'Loading…';
      loadUnits().then(function (u) {
        var ls = u[resortId] || u[String(resortId).toLowerCase()] || []; list.innerHTML = '';
        if (!ls.length) { list.textContent = 'No unit types listed on Stock Network.'; return; }
        ls.forEach(function (l) {
          var d = document.createElement('div'); d.style.padding = '2px 0';
          var b = document.createElement('b'); b.textContent = unitLabel(l); d.appendChild(b);
          var sm = document.createElement('div'); sm.style.cssText = 'color:#5f6b6e;font-size:11.5px;'; sm.textContent = unitDetail(l); d.appendChild(sm);
          list.appendChild(d);
        });
      }).catch(function () { list.textContent = 'Unit types could not be loaded.'; });
    });
    return { btn: btn, list: list };
  }

  root.AvanteBooking = {
    BASE: BASE, FIELDS: FIELDS, build: build, parse: parse, convert: convert, siteId: siteId,
    loadTree: loadTree, mountTreePicker: mountTreePicker, loadUnits: loadUnits, unitLabel: unitLabel, unitDetail: unitDetail, unitToggle: unitToggle
  };
})(window);

/* The hub's one photo chooser (Jean, 2026-10-17). Every page that needs
   photos opens this instead of its own file box. Load photo-chooser.css too.

   PhotoChooser.open({
     title:   'Photos for Little Gem',
     auth:    { token } | { listingId, key }         // who is asking (/api/photo-library)
     listing: [{ key, thumb, name, used }]           // "This listing": photos already with it
     filingFor: { resortId, listingId, name, unit, place: { c, p, r, t, s } }
                                                     // what "Show photos for" offers (unit, property, suburb … country); closest first
     filing:  [{ key, name }]                        // or: the "Show photos for" list itself (e.g. an activity)
     listingLabel: 'This activity',                  // name of the first tab (default "This listing")
     single:  true,                                  // one photo only (tapping another swaps it)
     tab:     'library',                             // the tab to start on
     filesOnly: true,                                // leave out Google photos (kept by reference only, can't become files)
     upload:  true,                                  // "From your device"
     onDone:  function (picked) { ... }              // { listing: [items], library: [photos], files: [File] }
   });

   The chooser only picks. The page saves what was picked (upload the files,
   copy library photos with /api/photo-library toListing, ...). */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function open(opts) {
    opts = opts || {};
    var listing = opts.listing || [], filing = [];
    var tabs = [];
    if (listing.length) tabs.push(['listing', (opts.listingLabel || 'This listing') + ' (' + listing.length + ')']);
    tabs.push(['library', 'Photo library']);
    if (opts.upload !== false) tabs.push(['device', 'From your device']);
    var S = { tab: tabs[0][0], picked: { listing: {}, library: {} }, files: [], lib: null, libKey: '', libQ: '', libBusy: false, libErr: '', filed: !opts.filingFor };
    if (opts.filing && opts.filing.length) { filing = opts.filing; S.libKey = filing[0].key; S.filed = true; }
    if (opts.tab && tabs.some(function (t) { return t[0] === opts.tab; })) S.tab = opts.tab;

    var ov = document.createElement('div');
    ov.className = 'pc-overlay';
    ov.innerHTML = '<div class="pc-box" role="dialog" aria-modal="true" aria-labelledby="pc-title">' +
      '<div class="pc-head"><h2 id="pc-title">' + esc(opts.title || 'Choose photos') + '</h2><button type="button" class="pc-x" data-pc="close" aria-label="Close">×</button></div>' +
      '<div class="pc-tabs" role="tablist">' + tabs.map(function (t) { return '<button type="button" class="pc-tab" role="tab" data-pc-tab="' + t[0] + '">' + esc(t[1]) + '</button>'; }).join('') + '</div>' +
      '<div class="pc-body"></div>' +
      '<div class="pc-foot"><span class="pc-hint" data-pc="count"></span><span><button type="button" class="pc-btn" data-pc="close">Cancel</button> <button type="button" class="pc-btn go" data-pc="done" disabled>Use photos</button></span></div></div>';
    document.body.appendChild(ov);
    var body = ov.querySelector('.pc-body');
    var lastFocus = document.activeElement;

    function count() { return Object.keys(S.picked.listing).length + Object.keys(S.picked.library).length + S.files.length; }
    function grid(items, from) {
      if (!items.length) return '';
      return '<div class="pc-grid">' + items.map(function (it, i) {
        var id = from === 'listing' ? it.key : it.id, on = !!S.picked[from][id];
        var label = it.name || '';
        if (it.used) label = 'Already used here';
        else if (from === 'library' && it.credit) label = it.credit;
        return '<button type="button" class="pc-item' + (on ? ' on' : '') + (it.used ? ' used' : '') + '" data-pc-pick="' + from + '" data-i="' + i + '"' + (it.used ? ' disabled' : '') + ' aria-pressed="' + on + '">' +
          '<img src="' + esc(it.thumb) + '" alt="" loading="lazy"><span>' + esc(label) + '</span></button>';
      }).join('') + '</div>';
    }
    function render() {
      Array.prototype.forEach.call(ov.querySelectorAll('[data-pc-tab]'), function (b) { var on = b.getAttribute('data-pc-tab') === S.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      var h = '';
      if (S.tab === 'listing') {
        h = '<p class="pc-hint">Tap the photos to use. Photos already used here are greyed out.</p>' + grid(listing, 'listing');
      } else if (S.tab === 'library') {
        h = '<div class="pc-tools">' +
          (filing.length ? '<label>Show photos for<select data-pc="libKey">' + filing.map(function (f) { return '<option value="' + esc(f.key) + '"' + (f.key === S.libKey ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '<option value=""' + (S.libKey ? '' : ' selected') + '>Anything</option></select></label>' : '') +
          '<label>Name or tag contains<input type="search" data-pc="libQ" value="' + esc(S.libQ) + '" autocomplete="off" placeholder="e.g. pool, beach"></label></div>';
        if (S.libErr) h += '<p class="pc-hint">' + esc(S.libErr) + '</p>';
        else if (S.libBusy && !S.lib) h += '<p class="pc-hint">Loading photos…</p>';
        else if (S.lib && !S.lib.length) h += '<p class="pc-hint">No photos here yet. Try another place in <b>Show photos for</b>, other words, or upload your own.</p>';
        else if (S.lib) h += grid(S.lib, 'library');
      } else {
        h = '<div class="pc-drop" tabindex="0" role="button" data-pc="drop">Drop photos here, or tap to choose them</div><input type="file" accept="image/*" multiple hidden data-pc="file">';
        if (S.files.length) h += '<div class="pc-grid">' + S.files.map(function (f, i) { return '<button type="button" class="pc-item on" data-pc-unfile="' + i + '" aria-label="Remove ' + esc(f.file.name) + '"><img src="' + f.url + '" alt=""><span>' + esc(f.file.name) + ' · tap to remove</span></button>'; }).join('') + '</div>';
      }
      body.innerHTML = h;
      var n = count();
      ov.querySelector('[data-pc="count"]').textContent = n ? n + ' photo' + (n === 1 ? '' : 's') + ' chosen' : 'Nothing chosen yet';
      var go = ov.querySelector('[data-pc="done"]'); go.disabled = !n; go.textContent = n ? 'Use ' + n + ' photo' + (n === 1 ? '' : 's') : 'Use photos';
      if (S.tab === 'library' && !S.lib && !S.libBusy && !S.libErr) (S.filed ? loadLibrary : loadFiling)();
    }
    function post(payload) {
      return fetch('/api/photo-library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign(payload, opts.auth || {})) }).then(function (r) { return r.json(); });
    }
    // First the "Show photos for" list, then the photos of its first choice.
    function loadFiling() {
      S.libBusy = true;
      post(Object.assign({ action: 'filing' }, opts.filingFor)).then(function (d) {
        filing = (d && d.filing) || []; S.libKey = filing.length ? filing[0].key : '';
      }).catch(function () { filing = []; }).then(function () { S.filed = true; S.libBusy = false; loadLibrary(); });
    }
    var libTimer = null, libAsk = 0;
    function loadLibrary() {
      var ask = ++libAsk; S.libBusy = true; S.libErr = '';
      post({ action: 'find', keys: S.libKey ? [S.libKey] : [], q: S.libQ, filesOnly: !!opts.filesOnly })
        .then(function (d) {
          if (ask !== libAsk) return;
          S.libBusy = false;
          if (!d || !d.ok) { S.libErr = (d && d.error) || 'The photo library didn\'t answer. Try again.'; S.lib = null; }
          else S.lib = d.photos || [];
          var q = S.tab === 'library' ? body.querySelector('[data-pc="libQ"]') : null, typing = q && document.activeElement === q;
          render();
          if (typing) { q = body.querySelector('[data-pc="libQ"]'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
        })
        .catch(function () { if (ask !== libAsk) return; S.libBusy = false; S.libErr = 'The photo library didn\'t answer. Try again.'; render(); });
    }
    function addFiles(list) {
      if (opts.single) { S.picked = { listing: {}, library: {} }; S.files.forEach(function (f) { URL.revokeObjectURL(f.url); }); S.files = []; list = Array.prototype.slice.call(list || [], 0, 1); }
      Array.prototype.forEach.call(list || [], function (f) { if (/^image\//.test(f.type || '')) S.files.push({ file: f, url: URL.createObjectURL(f) }); });
      render();
    }
    function close(picked) {
      S.files.forEach(function (f) { URL.revokeObjectURL(f.url); });
      document.removeEventListener('keydown', onKey);
      ov.remove();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      if (picked && opts.onDone) opts.onDone(picked);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }
    document.addEventListener('keydown', onKey);

    ov.addEventListener('click', function (e) {
      if (e.target === ov) return close(null);
      var t = e.target.closest('[data-pc-tab]'); if (t) { S.tab = t.getAttribute('data-pc-tab'); return render(); }
      var p = e.target.closest('[data-pc-pick]');
      if (p && !p.disabled) {
        var from = p.getAttribute('data-pc-pick'), it = (from === 'listing' ? listing : S.lib)[+p.getAttribute('data-i')], id = from === 'listing' ? it.key : it.id;
        if (S.picked[from][id]) delete S.picked[from][id];
        else { if (opts.single) { S.picked = { listing: {}, library: {} }; S.files.forEach(function (f) { URL.revokeObjectURL(f.url); }); S.files = []; } S.picked[from][id] = it; }
        return render();
      }
      var u = e.target.closest('[data-pc-unfile]'); if (u) { var f = S.files.splice(+u.getAttribute('data-pc-unfile'), 1)[0]; URL.revokeObjectURL(f.url); return render(); }
      if (e.target.closest('[data-pc="drop"]')) return body.querySelector('[data-pc="file"]').click();
      var a = e.target.closest('[data-pc]'); if (!a) return;
      var act = a.getAttribute('data-pc');
      if (act === 'close') close(null);
      else if (act === 'done') close({ listing: values(S.picked.listing), library: values(S.picked.library), files: S.files.map(function (f) { return f.file; }) });
    });
    ov.addEventListener('change', function (e) {
      var w = e.target.getAttribute('data-pc');
      if (w === 'file') addFiles(e.target.files);
      else if (w === 'libKey') { S.libKey = e.target.value; S.lib = null; loadLibrary(); render(); }
    });
    ov.addEventListener('input', function (e) {
      if (e.target.getAttribute('data-pc') !== 'libQ') return;
      S.libQ = e.target.value; clearTimeout(libTimer);
      libTimer = setTimeout(loadLibrary, 350);
    });
    ov.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute('data-pc') === 'drop') { e.preventDefault(); body.querySelector('[data-pc="file"]').click(); } });
    ov.addEventListener('dragover', function (e) { var d = e.target.closest('[data-pc="drop"]'); if (d) { e.preventDefault(); d.classList.add('over'); } });
    ov.addEventListener('dragleave', function (e) { var d = e.target.closest('[data-pc="drop"]'); if (d) d.classList.remove('over'); });
    ov.addEventListener('drop', function (e) { var d = e.target.closest('[data-pc="drop"]'); if (d) { e.preventDefault(); d.classList.remove('over'); addFiles(e.dataTransfer.files); } });

    render();
    ov.querySelector('.pc-tab.on').focus();
  }
  function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }

  window.PhotoChooser = { open: open };
})();

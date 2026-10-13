/* Channel Property Affiliate (Jean, 2026-10-13) — a property already on a
   channel manager (NightsBridge first). In the hub's Property Affiliate
   panel it gets only: the hook builder, and how guests pay (Avante's
   payment page on Stock Network, its own gateway, EFT into its bank
   account, or not set). The Communication & marketing module (fed by an
   uploaded channel report) comes later.
   hub.html calls window.ChannelProperty.start(aff, session) once the
   affiliate's profile says it is a channel property. Talks to
   /api/channel-property. Uses the pa-* styles from property-affiliate.css. */
(function () {
  'use strict';
  var root, AFF, SESSION, S = { data: null, msg: null, err: null, busy: false };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(action, extra) {
    return fetch('/api/channel-property', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action, aff: AFF, session: SESSION }, extra || {})) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'No answer from the server.' }; }); })
      .catch(function () { return { ok: false, error: 'No connection. Check your internet and try again.' }; });
  }
  function load() {
    api('get').then(function (d) {
      if (!d.ok) { S.err = d.error || 'Could not load.'; render(); return; }
      S.data = d; render();
    });
  }
  function render() {
    if (!root) return;
    var d = S.data, h = '';
    h += '<header class="pa-top"><span class="pa-kicker">Channel Property</span><b class="pa-propname">' + esc((d && d.name) || 'Your property') + '</b>' +
      (d && d.siteNr ? '<span class="pa-hint pa-top-meta">SN site ' + esc(d.siteNr) + '</span>' : '') +
      '<a class="pa-btn ghost small" href="how-to-property.html#channel" target="_blank" rel="noopener" style="margin-left:auto">❓ How to</a></header>';
    if (S.err && !d) { root.innerHTML = h + '<p class="pa-err" role="alert">' + esc(S.err) + '</p>'; return; }
    if (!d) { root.innerHTML = h + '<p class="pa-hint">Loading…</p>'; return; }
    // Hook builder
    h += '<section class="pa-card" aria-label="Hook builder"><p class="pa-h2">Hook builder</p>' +
      '<p class="pa-hint">Make promotions (hooks) for your property: flyers, captions and landing pages to share. Your bookings keep coming through your channel manager.</p>' +
      '<div class="pa-row" style="margin-top:10px"><button type="button" class="pa-btn" data-cp="hooks">Open the hook builder</button></div></section>';
    // Payments
    var pm = d.payMode || 'none', bk = d.bank || {};
    var opt = function (v, label, hint) { return '<label class="pa-check pa-radio"><input type="radio" name="cp-pm" value="' + v + '"' + (pm === v ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="pa-hint">' + hint + '</span></span></label>'; };
    h += '<section class="pa-card" aria-label="Guest payments"><p class="pa-h2">Guest payments</p>' +
      '<p class="pa-hint">How guests who book through your Avante promotions pay you.</p>' +
      '<fieldset class="pa-fieldset"><legend class="pa-label">How guests pay</legend>' +
      opt('sn', 'Avante payment gateway', 'Guests pay on the Stock Network payment page for the booking.') +
      opt('own', 'Our own payment gateway', 'Guests pay through your own payment link.') +
      opt('eft', 'EFT into our bank account only', 'Guests pay by EFT into your bank account, using the booking reference.') +
      opt('none', 'Not set yet', 'Choose later. Avante will contact you before a guest needs to pay.') + '</fieldset>' +
      '<div id="cp-own"' + (pm === 'own' ? '' : ' hidden') + '><div class="pa-field" style="margin-top:12px"><label class="pa-label" for="cp-gw" style="color:#0e2f44">Your payment gateway link</label><input id="cp-gw" type="url" value="' + esc(d.gatewayUrl || '') + '" placeholder="https://…"></div></div>' +
      '<div id="cp-eft"' + (pm === 'eft' ? '' : ' hidden') + '><p class="pa-label" style="margin:16px 0 6px">Your bank account for EFT</p><div class="pa-form">' +
      '<div class="pa-field"><label class="pa-label" for="cp-bn" style="color:#0e2f44">Bank</label><input id="cp-bn" type="text" value="' + esc(bk.bankName || '') + '" placeholder="e.g. FNB"></div>' +
      '<div class="pa-field"><label class="pa-label" for="cp-bh" style="color:#0e2f44">Account holder</label><input id="cp-bh" type="text" value="' + esc(bk.accountHolder || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="cp-ba" style="color:#0e2f44">Account number</label><input id="cp-ba" type="text" inputmode="numeric" autocomplete="off" value="' + esc(bk.accountNumber || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="cp-bb" style="color:#0e2f44">Branch code</label><input id="cp-bb" type="text" inputmode="numeric" value="' + esc(bk.branchCode || '') + '"></div>' +
      '<div class="pa-field"><label class="pa-label" for="cp-bt" style="color:#0e2f44">Account type</label><select id="cp-bt">' + ['', 'Cheque / Current', 'Savings', 'Business'].map(function (o) { return '<option' + ((bk.accountType || '') === o ? ' selected' : '') + ' value="' + esc(o) + '">' + (o || 'Choose…') + '</option>'; }).join('') + '</select></div>' +
      '<div class="pa-field"><label class="pa-label" for="cp-bx" style="color:#0e2f44">Note for guests (optional)</label><input id="cp-bx" type="text" value="' + esc(bk.note || '') + '" placeholder="e.g. Send proof of payment to …"></div></div>' +
      '<p class="pa-hint">Kept encrypted.</p></div>' +
      '<div class="pa-row" style="margin-top:12px"><button type="button" class="pa-btn" data-cp="save">Save payment settings</button></div>' +
      '<div id="cp-status"></div></section>';
    // Coming later
    h += '<section class="pa-card" aria-label="Communication and marketing"><p class="pa-h2">Communication &amp; marketing</p>' +
      '<p class="pa-hint">Coming soon: upload your NightsBridge booking report and the hub will hold your guests\' contact details, so you can send them messages and promotions from here.</p></section>';
    root.innerHTML = h;
  }
  function onClick(e) {
    var b = e.target.closest && e.target.closest('[data-cp]'); if (!b) return;
    if (b.getAttribute('data-cp') === 'hooks') { if (window.openHookBuilder) window.openHookBuilder(b); return; }
    if (b.getAttribute('data-cp') === 'save') {
      var pmEl = root.querySelector('input[name="cp-pm"]:checked'), pm = pmEl ? pmEl.value : 'none';
      var v = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
      // Only the button and the message change while saving, so nothing
      // the person picked or typed is lost if the save is refused.
      var st = document.getElementById('cp-status');
      b.disabled = true; b.textContent = 'Saving…'; st.innerHTML = '';
      api('saveSettings', { payMode: pm, gatewayUrl: v('cp-gw'), bank: { bankName: v('cp-bn'), accountHolder: v('cp-bh'), accountNumber: v('cp-ba'), branchCode: v('cp-bb'), accountType: v('cp-bt'), note: v('cp-bx') } })
        .then(function (d) {
          b.disabled = false; b.textContent = 'Save payment settings';
          if (d.ok) { S.data.payMode = d.payMode; S.data.gatewayUrl = v('cp-gw'); S.data.bank = { bankName: v('cp-bn'), accountHolder: v('cp-bh'), accountNumber: v('cp-ba'), branchCode: v('cp-bb'), accountType: v('cp-bt'), note: v('cp-bx') }; st.innerHTML = '<p class="pa-ok" role="status">Saved.</p>'; }
          else st.innerHTML = '<p class="pa-err" role="alert">' + esc(d.error || 'Could not save.') + '</p>';
        });
    }
  }
  function onChange(e) {
    if (e.target.name === 'cp-pm') {
      var pm = e.target.value;
      document.getElementById('cp-own').hidden = pm !== 'own';
      document.getElementById('cp-eft').hidden = pm !== 'eft';
      var st = document.getElementById('cp-status'); if (st) st.innerHTML = '';
    }
  }
  window.ChannelProperty = {
    start: function (aff, session) {
      root = document.getElementById('cp-app');
      if (!root || AFF) return;
      AFF = aff; SESSION = session;
      root.classList.add('pa');   // the pa-* colours and styles (property-affiliate.css)
      root.addEventListener('click', onClick);
      root.addEventListener('change', onChange);
      render(); load();
    }
  };
})();

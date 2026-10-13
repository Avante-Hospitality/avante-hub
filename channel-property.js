/* Channel Property Affiliate (Jean, 2026-10-13) — a property already on a
   channel manager (NightsBridge first) that feeds Stock Network. In the hub's
   Property Affiliate panel it gets only the hook builder and this screen:
   how guests pay (always Avante's payment gateway, the Stock Network payment
   page — no EFT or manual option, so Avante is responsible for collecting
   payment) and Avante's commission (4.95% + VAT by default). No calendar,
   iCal, front store or guest messaging: NightsBridge already gives those.
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
    // Payments (Jean, 2026-10-13): always Avante's payment gateway, no EFT
    // or manual option, so Avante is responsible for collecting payment.
    h += '<section class="pa-card" aria-label="Guest payments"><p class="pa-h2">Guest payments</p>' +
      '<p>Guests who book through your Avante hooks pay through <b>Avante\'s payment gateway</b> (the Stock Network payment page). Avante collects the payment.</p>' +
      '<p class="pa-hint">Bookings from your hooks reach your NightsBridge (or other channel manager) through Stock Network, like any other Stock Network booking. Your rates, availability and guest messages stay in your channel manager.</p>' +
      '<p class="pa-hint" style="margin-top:8px">Avante\'s commission on bookings from your hooks: <b>' + esc(d.commissionPct) + '% + VAT (' + esc(Number(d.commissionTotal).toFixed(2)) + '%)</b>.</p></section>';
    root.innerHTML = h;
  }
  function onClick(e) {
    var b = e.target.closest && e.target.closest('[data-cp]'); if (!b) return;
    if (b.getAttribute('data-cp') === 'hooks') { if (window.openHookBuilder) window.openHookBuilder(b); return; }
  }
  window.ChannelProperty = {
    start: function (aff, session) {
      root = document.getElementById('cp-app');
      if (!root || AFF) return;
      AFF = aff; SESSION = session;
      root.classList.add('pa');   // the pa-* colours and styles (property-affiliate.css)
      root.addEventListener('click', onClick);
      render(); load();
    }
  };
})();

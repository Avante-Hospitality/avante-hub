/* Admin > SN Calls (Jean, 2026-10-29): how often the hub calls Stock Network,
   and when it might be calling it too hard. Numbers come from /api/sn-log
   (netlify/edge-functions/lib/sn-log.js). Times are shown in SA time. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var panel = $('panel-snCalls'); if (!panel) return;
  var days = 1, data = null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (n) { return Number(n || 0).toLocaleString('en-ZA'); };
  // "2026-10-29T08" (UTC) -> "Thu 29 Oct 10:00" (SA time); with minutes too.
  function saTime(utc, withDay) {
    var t = new Date((utc.length === 13 ? utc + ':00' : utc) + ':00Z');
    return t.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: withDay ? 'short' : undefined, day: withDay ? 'numeric' : undefined, month: withDay ? 'short' : undefined, hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function say(t, bad) { var el = $('sncStatus'); el.textContent = t; el.className = 'status' + (t ? ' show' : '') + (bad ? '' : ' ok'); }
  function post(action, extra) {
    return fetch('/api/sn-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action, token: window.ADMIN_TOKEN }, extra || {})) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'The hub answered ' + r.status + '.' }; }); });
  }

  function tile(n, label, warn) { return '<div class="stat-card"' + (warn ? ' style="border-color:#e0a23a;background:#fff6e8;"' : '') + '><div class="num">' + n + '</div><div class="lbl">' + label + '</div></div>'; }
  function table(title, rows, total) {
    if (!rows.length) return '';
    return '<h3 class="section-heading" style="font-size:14px;margin:18px 0 8px;">' + title + '</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th style="text-align:right;">Calls</th><th style="text-align:right;">Share</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td style="text-align:right;">' + num(r.count) + '</td><td style="text-align:right;">' + Math.round(r.count * 100 / (total || 1)) + '%</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  // One bar per hour; over the hourly limit in amber.
  function chart(d) {
    var hrs = d.hours, lim = d.limits.perHour;
    if (!hrs.length) return '<p class="hint">No calls to Stock Network in this period.</p>';
    var max = Math.max(lim, Math.max.apply(null, hrs.map(function (h) { return h.n; })));
    var W = Math.max(hrs.length, 24), H = 120, bw = W / hrs.length;
    var bars = hrs.map(function (h, i) {
      var y = H - (h.n / max) * H, tip = saTime(h.hour, true) + ': ' + num(h.n) + ' calls' + (h.r429 ? ', ' + h.r429 + ' "too many"' : '') + (h.peakMin ? ', busiest minute ' + h.peakMin.n : '');
      return '<rect x="' + (i * bw + bw * 0.1).toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + (bw * 0.8).toFixed(2) + '" height="' + (H - y).toFixed(2) + '" fill="' + (h.n > lim || h.r429 ? '#e0a23a' : '#0DCDC2') + '"><title>' + esc(tip) + '</title></rect>';
    }).join('');
    var ly = H - (lim / max) * H;
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:140px;display:block;background:var(--mint);border-radius:8px;" role="img" aria-label="Calls to Stock Network per hour">' + bars +
      '<line x1="0" x2="' + W + '" y1="' + ly.toFixed(2) + '" y2="' + ly.toFixed(2) + '" stroke="#0e2f44" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"><title>Your hourly limit: ' + num(lim) + '</title></line></svg>' +
      '<div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--muted);margin-top:4px;"><span>' + esc(saTime(hrs[0].hour, true)) + '</span><span>Dashed line: your limit of ' + num(lim) + ' an hour</span><span>' + esc(saTime(hrs[hrs.length - 1].hour, true)) + '</span></div>';
  }

  function render() {
    var d = data; if (!d) return;
    var L = d.limits, warn = [];
    if (d.tooMany) warn.push('Stock Network answered <b>"too many requests"</b> ' + num(d.tooMany) + ' time' + (d.tooMany === 1 ? '' : 's') + '. That is Stock Network telling us to slow down.');
    if (d.minutesOver) warn.push(num(d.minutesOver) + ' minute' + (d.minutesOver === 1 ? '' : 's') + ' went over your limit of ' + num(L.perMinute) + ' calls a minute.');
    if (d.hoursOver) warn.push(num(d.hoursOver) + ' hour' + (d.hoursOver === 1 ? '' : 's') + ' went over your limit of ' + num(L.perHour) + ' calls an hour.');
    if (d.snErrors) warn.push('Stock Network had ' + num(d.snErrors) + ' server error' + (d.snErrors === 1 ? '' : 's') + ' (it may have been busy).');
    $('sncTiles').innerHTML =
      tile(num(d.total), 'Calls to Stock Network') +
      tile(d.peakHour ? num(d.peakHour.n) + '<span style="font-size:12px;font-weight:600;"> · ' + esc(saTime(d.peakHour.at, true)) + '</span>' : '0', 'Busiest hour', d.hoursOver) +
      tile(d.peakMin ? num(d.peakMin.n) + '<span style="font-size:12px;font-weight:600;"> · ' + esc(saTime(d.peakMin.at, true)) + '</span>' : '0', 'Busiest minute', d.minutesOver) +
      tile(num(d.tooMany), '"Too many" answers', d.tooMany) +
      tile(num(d.errors), 'Calls that failed', d.snErrors) +
      tile(d.total ? num(d.avgMs) + ' ms' : '—', 'Average answer time');
    $('sncWarn').innerHTML = warn.length ? '<div class="status show" style="background:#fff6e8;border-color:#e0a23a;color:#6b3a00;"><b>Watch out</b><br>' + warn.join('<br>') + '</div>'
      : (d.total ? '<div class="status show ok">All calm: nothing over your limits, and Stock Network never said "too many".</div>' : '');
    $('sncChart').innerHTML = chart(d);
    $('sncTables').innerHTML = table('Which part of the hub calls', d.bySource, d.total) + table('Which property (Site Nr)', d.bySite, d.total) + table('Which Stock Network address', d.byPath, d.total);
    $('sncPerMinute').value = L.perMinute; $('sncPerHour').value = L.perHour;
    panel.querySelectorAll('[data-snc-days]').forEach(function (b) { b.className = Number(b.getAttribute('data-snc-days')) === days ? 'primary' : 'btn-outline'; });
  }

  function load() {
    say('Reading the log…');
    post('summary', { days: days }).then(function (d) {
      if (d.ok === false && /log in/i.test(d.error || '') && typeof window.goToLogin === 'function') return window.goToLogin();
      if (!d.ok) { say(d.error || 'Could not read the log.', true); return; }
      data = d; say(''); render();
    }).catch(function () { say('Could not read the log: lost the connection.', true); });
  }

  panel.addEventListener('click', function (e) {
    var b = e.target.closest('[data-snc-days]');
    if (b) { days = Number(b.getAttribute('data-snc-days')) || 1; load(); return; }
    if (e.target.id === 'sncRefresh') { load(); return; }
    if (e.target.id === 'sncSaveLimits') {
      var st = $('sncLimitsStatus'); st.textContent = 'Saving…'; st.className = 'status show ok';
      post('saveLimits', { perMinute: $('sncPerMinute').value, perHour: $('sncPerHour').value }).then(function (d) {
        if (!d.ok) { st.textContent = d.error || 'Not saved.'; st.className = 'status show'; return; }
        st.textContent = 'Saved: warn above ' + num(d.limits.perMinute) + ' a minute or ' + num(d.limits.perHour) + ' an hour.';
        if (data) { data.limits = d.limits; load(); }
      }).catch(function () { st.textContent = 'Not saved: lost the connection.'; st.className = 'status show'; });
    }
  });
  var tab = document.querySelector('.tab[data-panel="snCalls"]'); if (tab) tab.addEventListener('click', load);
})();

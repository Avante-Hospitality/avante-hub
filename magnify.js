/* Magnifier for the hub (Jean, 2026-10-20): tap Aa, then tap any small text
   (or picture) and it opens big in a popup. Tap Aa again to switch it off.
   Its button says "Aa" so it isn't mistaken for the search (magnifying glass, site-search.js).
   On every hub and admin page: <script src="magnify.js" defer></script> */
(function () {
  'use strict';
  var KEY = 'avante-magnify', on = false;
  try { on = localStorage.getItem(KEY) === 'on'; } catch (e) {}
  var css = document.createElement('style');
  css.textContent =
    '.mag-btn{position:fixed;left:14px;bottom:14px;z-index:9998;width:52px;height:52px;border-radius:50%;border:2px solid #0DCDC2;background:#fff;color:#0e2f44;font:800 20px/1 Montserrat,sans-serif;box-shadow:0 4px 14px rgba(14,47,68,.25);cursor:pointer}' +
    '.mag-btn[aria-pressed="true"]{background:#0DCDC2;color:#fff}' +
    'body.mag-on,body.mag-on *{cursor:zoom-in!important}' +
    'body.mag-on .mag-btn{cursor:pointer!important}' +
    '.mag-tip{position:fixed;left:74px;bottom:22px;z-index:9998;background:#0e2f44;color:#fff;padding:8px 12px;border-radius:10px;font:600 14px "Noto Sans",sans-serif;max-width:calc(100vw - 100px)}' +
    '.mag-ov{position:fixed;inset:0;z-index:9999;background:rgba(14,47,68,.6);display:flex;align-items:center;justify-content:center;padding:18px;cursor:zoom-out}' +
    '.mag-box{background:#fff;color:#0e2f44;border-radius:18px;padding:24px 22px;max-width:760px;width:100%;max-height:86vh;overflow:auto;font:500 26px/1.45 "Noto Sans",sans-serif;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 12px 40px rgba(0,0,0,.3)}' +
    '.mag-box img{max-width:100%;height:auto;display:block;margin:0 auto;border-radius:10px}' +
    '.mag-box small{display:block;margin-top:16px;font-size:15px;color:#5b7180;text-align:center}';
  document.head.appendChild(css);

  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'mag-btn'; btn.textContent = 'Aa';
  btn.title = 'Magnifier: tap, then tap any small text to see it big';
  btn.setAttribute('aria-label', 'Magnifier');
  var tip = null;
  function set(v) {
    on = v; btn.setAttribute('aria-pressed', String(on)); document.body.classList.toggle('mag-on', on);
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
    if (tip) { tip.remove(); tip = null; }
    if (on) { tip = document.createElement('div'); tip.className = 'mag-tip'; tip.textContent = 'Tap any text to see it big. Tap Aa to stop.'; document.body.appendChild(tip); setTimeout(function () { if (tip) { tip.remove(); tip = null; } }, 4000); }
  }
  btn.addEventListener('click', function (e) { e.stopPropagation(); set(!on); });

  function show(el) {
    var ov = document.createElement('div'), box = document.createElement('div');
    ov.className = 'mag-ov'; box.className = 'mag-box';
    if (el.tagName === 'IMG' && el.src) { var im = document.createElement('img'); im.src = el.currentSrc || el.src; im.alt = el.alt || ''; box.appendChild(im); }
    else {
      var v = (el.value && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) ? (el.tagName === 'SELECT' ? (el.options[el.selectedIndex] || {}).text : el.value) : '';
      var text = (v || el.innerText || el.textContent || el.placeholder || el.title || '').trim();
      if (!text) return;
      box.textContent = text.slice(0, 3000);
    }
    var s = document.createElement('small'); s.textContent = 'Tap anywhere to close'; box.appendChild(s);
    ov.appendChild(box); document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', esc); };
    var esc = function (e) { if (e.key === 'Escape') close(); };
    ov.addEventListener('click', close); document.addEventListener('keydown', esc);
  }
  // While on, a tap shows the text big instead of doing what it normally does.
  document.addEventListener('click', function (e) {
    if (!on || e.target.closest('.mag-btn,.mag-ov')) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target;
    // A tiny bit of text (one word in a line): show the whole line or box around it.
    while (el.parentElement && el !== document.body && el.tagName !== 'IMG' && (el.innerText || '').trim().length < 12 && el.parentElement.innerText && el.parentElement.innerText.length < 600) el = el.parentElement;
    show(el);
  }, true);

  function start() { document.body.appendChild(btn); set(on); }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

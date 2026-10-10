/* Adds a "❓ How to" button to the top of every panel, linking to its section of
   the how-to guide. Used by hub.html and admin.html:
     <script src="how-to-links.js" data-guide="how-to.html" data-skip="panel-property" defer></script>
   The section id in the guide is the panel id without "panel-" (panel-accom -> #accom).
   When you add a panel, add its section to the guide too (see CLAUDE.md). */
(function () {
  'use strict';
  var me = document.currentScript || document.querySelector('script[src*="how-to-links.js"]');
  var guide = (me && me.getAttribute('data-guide')) || 'how-to.html';
  var skip = ((me && me.getAttribute('data-skip')) || '').split(/\s*,\s*/).filter(Boolean);
  var css = document.createElement('style');
  css.textContent = '.howto-btn{float:right;position:relative;z-index:2;display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;margin:0 0 8px 12px;border-radius:999px;border:1.5px solid #0e2f44;background:#fff;color:#0e2f44;font:700 12.5px Montserrat,sans-serif;text-decoration:none;}' +
    '.howto-btn:hover,.howto-btn:focus-visible{background:#0DCDC2;border-color:#0DCDC2;outline:none;}' +
    '@media (max-width:600px){.howto-btn{min-height:32px;padding:0 10px;font-size:12px;}}';
  document.head.appendChild(css);
  function add() {
    document.querySelectorAll('section.panel[id^="panel-"]').forEach(function (p) {
      if (skip.indexOf(p.id) >= 0 || p.querySelector(':scope > .howto-btn')) return;
      var a = document.createElement('a');
      a.className = 'howto-btn';
      a.href = guide + '#' + p.id.slice(6);
      a.target = '_blank'; a.rel = 'noopener';
      a.textContent = '❓ How to';
      a.setAttribute('aria-label', 'How to use this screen (opens the guide in a new tab)');
      p.insertBefore(a, p.firstChild);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();

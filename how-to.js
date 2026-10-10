/* How-to guides: contents list, search, and highlight of the section a "How to" button opened. */
(function () {
  'use strict';
  var main = document.querySelector('.ht-main'), side = document.querySelector('.ht-side');
  if (!main || !side) return;
  var sections = [].slice.call(main.querySelectorAll('section[id]'));
  var list = document.createElement('ol');
  sections.forEach(function (s) {
    var h = s.querySelector('h2'); if (!h) return;
    var li = document.createElement('li'), a = document.createElement('a');
    a.href = '#' + s.id; a.textContent = h.textContent; li.appendChild(a); list.appendChild(li);
    var up = document.createElement('a'); up.href = '#top'; up.className = 'ht-totop'; up.textContent = '↑ Back to the contents'; s.appendChild(up);
  });
  side.appendChild(list);
  var empty = document.createElement('p'); empty.className = 'ht-empty ht-none'; empty.textContent = 'Nothing matches. Try another word, like "link", "password" or "hook".'; main.appendChild(empty);
  var q = side.querySelector('input');
  if (q) q.addEventListener('input', function () {
    var t = q.value.trim().toLowerCase(), shown = 0;
    sections.forEach(function (s, i) {
      var hit = !t || s.textContent.toLowerCase().indexOf(t) >= 0;
      s.classList.toggle('ht-none', !hit); if (list.children[i]) list.children[i].classList.toggle('ht-none', !hit); if (hit) shown++;
    });
    empty.classList.toggle('ht-none', shown > 0);
  });
  // Mark the contents entry for the section on screen.
  if ('IntersectionObserver' in window) {
    var links = [].slice.call(list.querySelectorAll('a'));
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id); }); });
    }, { rootMargin: '-30% 0px -60% 0px' });
    sections.forEach(function (s) { io.observe(s); });
  }
})();

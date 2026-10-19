/* Puts a listing's photos into the shared photo library, the hook builder's
   (Jean, 2026-10-13/19). Used by Admin (Property Listings) and the onboarding
   form, so every listing photo lands in the library, filed by the hub under
   the listing, its property (ResortID) and, for a unit photo, its unit type.
   The browser makes the 1600px copy, the 360px thumbnail and the picture hash,
   exactly as the hook builder does; the hub (action libraryAdd) files it.

   ListingPhotoLibrary.add({
     listingId, name,                       // the listing and its property name
     images: [{ key, unitTypeName }],       // the listing's photos
     done: { imageKey: libraryId },         // already in the library (skipped)
     post: function (body) { ... },         // sends body to /api/property-onboarding, answers a Promise of its JSON
     progress: function (i, n) { ... }      // optional
   }) -> Promise { added, failed, lastErr, done } */
(function () {
  'use strict';
  function loadBitmap(key) {
    return fetch('/api/property-file?key=' + encodeURIComponent(key))
      .then(function (r) { if (!r.ok) throw new Error('photo ' + r.status); return r.blob(); })
      .then(function (b) { return createImageBitmap(b); });
  }
  function scaledJpeg(img, max, q) {
    var k = Math.min(1, max / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    var c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
    return { url: c.toDataURL('image/jpeg', q), w: w, h: h, canvas: c };
  }
  function dhashOf(src) {
    var c = document.createElement('canvas'); c.width = 9; c.height = 8;
    var x = c.getContext('2d'); x.drawImage(src, 0, 0, 9, 8); var d = x.getImageData(0, 0, 9, 8).data, bits = '';
    for (var y = 0; y < 8; y++) for (var k = 0; k < 8; k++) { var a = (y * 9 + k) * 4, b = a + 4; bits += (d[a] + d[a + 1] + d[a + 2]) > (d[b] + d[b + 1] + d[b + 2]) ? '1' : '0'; }
    return bits.match(/.{4}/g).map(function (n) { return parseInt(n, 2).toString(16); }).join('');
  }
  function add(o) {
    var done = Object.assign({}, o.done || {}), images = (o.images || []).filter(function (im) { return im && im.key; });
    var todo = images.filter(function (im) { return !done[im.key]; });
    var res = { added: 0, failed: 0, lastErr: '', done: done }, chain = Promise.resolve();
    todo.forEach(function (im, i) {
      chain = chain.then(function () {
        if (o.progress) o.progress(i + 1, todo.length);
        return loadBitmap(im.key).then(function (bmp) {
          var full = scaledJpeg(bmp, 1600, 0.82), th = scaledJpeg(bmp, 360, 0.72);
          return o.post({ action: 'libraryAdd', listingId: o.listingId, imageKey: im.key,
            item: { name: (o.name || 'Property') + ' ' + (images.indexOf(im) + 1) + (im.unitTypeName ? ' — ' + im.unitTypeName : ''), w: full.w, h: full.h, hash: dhashOf(th.canvas) },
            full: full.url, thumb: th.url });
        }).then(function (d) {
          if (d && d.ok) { done[im.key] = d.id; res.added++; } else { res.failed++; res.lastErr = (d && d.error) || 'unknown reason'; }
        }).catch(function (e) { res.failed++; res.lastErr = e.message || String(e); });
      });
    });
    return chain.then(function () { return res; });
  }
  window.ListingPhotoLibrary = { add: add };
})();

// Loads a script the first time a page needs it, not when the page opens
// (Jean, 2026-10-21: faster hub and admin). Used by admin.html, hub.html and
// property-form.html for the big tools only some screens use.
//
//   AvanteScripts.load(url)  -> Promise, resolved once the script has run.
//                               Asked again for the same url: the same Promise.
//                               A failed load is tried again the next time.
//   AvanteScripts.xlsx()     -> Promise of window.XLSX (SheetJS: Excel files)
//   AvanteScripts.mammoth()  -> Promise of window.mammoth (Word .docx reader)
//   AvanteScripts.qrcode()   -> Promise of window.qrcode (qrcode.js, QR codes)
(function (root) {
  var loading = {};
  function load(url) {
    if (!loading[url]) {
      loading[url] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () {
          delete loading[url];
          s.remove();
          reject(new Error('Could not load ' + url + '. Check your internet and try again.'));
        };
        document.head.appendChild(s);
      });
    }
    return loading[url];
  }
  // A library that sets a global: resolves with it, or fails if it didn't appear.
  function global(url, name) {
    return function () {
      if (root[name]) return Promise.resolve(root[name]);
      return load(url).then(function () {
        if (!root[name]) throw new Error('The ' + name + ' tool did not load. Check your internet and reload the page.');
        return root[name];
      });
    };
  }
  root.AvanteScripts = {
    load: load,
    xlsx: global('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'XLSX'),
    mammoth: global('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', 'mammoth'),
    qrcode: global('qrcode.js', 'qrcode')
  };
})(window);

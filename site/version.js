// Row 114 — shows the latest version from version.json (generated at deploy time
// from releases/manifest.json). Same origin only (CSP connect-src 'self'); no
// third-party requests. If the file is missing, the page still works.
(function () {
  'use strict';
  var n = document.getElementById('ver-n');
  var d = document.getElementById('ver-d');
  if (!n || typeof fetch !== 'function') return;
  fetch('version.json', { cache: 'no-store', credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (v) {
      if (!v || typeof v.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(v.version)) return;
      n.textContent = v.version;
      if (typeof v.built_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v.built_at)) {
        d.textContent = '(' + v.built_at.slice(0, 10) + ')';
      }
    })
    .catch(function () { /* offline or not deployed yet: keep the placeholder */ });
})();

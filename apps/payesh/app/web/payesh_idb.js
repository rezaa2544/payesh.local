// Row 199 — the browser edition (app.payeshschool.ir): the app's files (SQLite database, settings,
// session) live in this browser's IndexedDB, so a reload or a new visit keeps the user signed in
// with the school's data. Used by BrowserHost (packages/payesh_core/lib/src/io/web/host.dart).
// The 32-bit Windows shell has its own real files (window.payeshHost) and never calls this.
(function () {
  'use strict';
  var DB = 'payesh-web', STORE = 'files';
  var opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { opening = null; reject(r.error); };
      r.onblocked = function () { reject(new Error('indexedDB blocked')); };
    });
    return opening;
  }
  window.payeshIdb = {
    // [[key, value], ...] — value is {d: Uint8Array, m: mtime} for a file, a JSON string for meta keys
    loadAll: function () {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var out = [];
          var tx = db.transaction(STORE, 'readonly');
          var c = tx.objectStore(STORE).openCursor();
          c.onsuccess = function () {
            var cur = c.result;
            if (cur) { out.push([String(cur.key), cur.value]); cur.continue(); } else resolve(out);
          };
          c.onerror = function () { reject(c.error); };
        });
      });
    },
    // one transaction: every put and delete lands together (or none does)
    commit: function (puts, dels) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readwrite');
          var st = tx.objectStore(STORE);
          for (var i = 0; i < puts.length; i++) st.put(puts[i][1], puts[i][0]);
          for (var j = 0; j < dels.length; j++) st.delete(dels[j]);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error || new Error('aborted')); };
        });
      });
    },
    // ask the browser not to evict the data under storage pressure (best effort)
    persist: function () {
      try {
        if (navigator.storage && navigator.storage.persist) return navigator.storage.persist();
      } catch (e) { /* not supported */ }
      return Promise.resolve(false);
    },
    // flush hook set by Dart; called when the page is hidden or closed
    onHide: null,
    // the browser's own «choose file» dialog → [name, Uint8Array] or null (cancelled)
    pickFile: function (accept) {
      return new Promise(function (resolve) {
        var input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.style.display = 'none';
        var done = false;
        function finish(v) {
          if (done) return;
          done = true;
          window.removeEventListener('focus', onFocus);
          if (input.parentNode) input.parentNode.removeChild(input);
          resolve(v);
        }
        // older browsers have no `cancel` event: when the page gets focus back with no file
        function onFocus() { setTimeout(function () { if (!input.files || !input.files.length) finish(null); }, 1500); }
        input.addEventListener('cancel', function () { finish(null); });
        input.addEventListener('change', function () {
          var f = input.files && input.files[0];
          if (!f) { finish(null); return; }
          f.arrayBuffer().then(function (buf) { finish([f.name, new Uint8Array(buf)]); }, function () { finish(null); });
        });
        document.body.appendChild(input);
        window.addEventListener('focus', onFocus);
        input.click();
      });
    },
  };
  function hidden() { try { if (window.payeshIdb.onHide) window.payeshIdb.onHide(); } catch (e) { /* ignore */ } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') hidden(); });
  window.addEventListener('pagehide', hidden);
})();

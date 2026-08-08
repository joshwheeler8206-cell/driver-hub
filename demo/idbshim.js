(function () {
  var BACK = '__fakeidb__';
  function read() { try { return JSON.parse(localStorage.getItem(BACK)) || {}; } catch (e) { return {}; } }
  function write(b) { localStorage.setItem(BACK, JSON.stringify(b)); }
  window.__shim = { opens: 0, mics: 0, onsucc: 0 };
  function later(fn) {
    window.__shim.mics++;
    var wrapped = function () { try { fn(); } catch (e) { window.__shimErr = String((e && e.stack) || e); } };
    if (window.queueMicrotask) queueMicrotask(wrapped); else Promise.resolve().then(wrapped);
  }
  var shim = {
    open: function (name, ver) {
      window.__shim.opens++;
      var req = { name: name, version: ver };
      req.result = {
        name: name,
        version: ver,
        objectStoreNames: { contains: function () { return false; } },
        createObjectStore: function () { return {}; },
        close: function () {},
        transaction: function (store, mode) {
          var tx = { store: store, mode: mode };
          tx.objectStore = function () {
            return {
              get: function (key) {
                var r = {};
                later(function () {
                  r.result = (read()[name] || {})[key];
                  if (r.onsuccess) r.onsuccess();
                });
                return r;
              },
              put: function (val, key) {
                var b = read();
                if (!b[name]) b[name] = {};
                b[name][key] = val;
                write(b);
                var r = { result: key };
                later(function () {
                  if (r.onsuccess) r.onsuccess();
                  if (tx.oncomplete) tx.oncomplete();
                });
                return r;
              }
            };
          };
          return tx;
        }
      };
      later(function () {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  try {
    Object.defineProperty(window, 'indexedDB', { value: shim, configurable: true, writable: true });
  } catch (e) {
    try { window.indexedDB = shim; } catch (e2) {}
  }
})();

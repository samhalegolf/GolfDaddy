/* Course maps live in IndexedDB, not localStorage.
 *
 * localStorage is one small bucket per origin - about 5MB of text in an iOS
 * WebView - and the course libraries alone were filling it. Once it was full,
 * saving a downloaded course threw QuotaExceededError, the read-back found
 * nothing, and the app reported "no playable map" for a course it had just
 * downloaded (Derllys Court, 6 Oct 2026: the phone sat at its 10,240KB ceiling
 * and the biggest map in the database would not fit). IndexedDB has the same
 * lifetime but is sized against the device's disk, not a fixed 5MB.
 *
 * Every reader of these keys calls localStorage synchronously, and IndexedDB is
 * async. So, like gd-durable-storage.js, this sits behind the existing calls
 * rather than replacing them: Storage.prototype getItem/setItem/removeItem/clear
 * are wrapped so that, for the keys below only, localStorage is answered from an
 * in-memory copy and every write is persisted to IndexedDB in the background.
 * No other call site changes.
 *
 *   boot    - a key still sitting in localStorage (first run after this ships)
 *             is taken into memory immediately, copied to IndexedDB, and only
 *             removed from localStorage once that copy has committed. Every
 *             other key is loaded from IndexedDB, which takes milliseconds.
 *   before  - a read before that load lands answers null, exactly like an empty
 *   ready     library. A write before it lands is held and MERGED into what
 *             loads (course by course), so an early save cannot wipe the
 *             library it never saw. Anything that must see the library first
 *             awaits GDCourseStorage.ready.
 *   write   - memory is updated at once, so a read straight after a write sees
 *             it. Disk writes are coalesced: a mapping run saves the store once
 *             per object, and only the latest value needs to reach disk.
 *   failure - no IndexedDB (some private-browsing modes): fall back to plain
 *             localStorage, which is exactly how it behaved before this file.
 *             A failed disk write is reported and the player told once - the
 *             course still plays from memory this session.
 *
 * Must load before every script that reads these keys: straight after
 * gd-durable-storage.js on both index.html and app/index.html.
 */
(function () {
  "use strict";

  var KEYS = [
    "gd_published_course_library_v1",   /* the published courses this device has opened */
    "gd_user_course_library_v1",        /* the player's own course library */
    "clarity:course-library:v1",        /* /app/'s downloaded courses (app/js/course-store.js) */
    "gd_course_play_pipeline_v1"        /* per-course play pipeline state */
  ];
  var DB_NAME = "clarity-course-storage";
  var DB_STORE = "kv";
  var FLUSH_DELAY_MS = 40;
  var CHANNEL = "clarity-course-storage";

  var big = {};
  KEYS.forEach(function (key) { big[key] = true; });

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }

  var storage = safe(function () { return window.localStorage; }, null);
  var proto = storage ? Object.getPrototypeOf(storage) : null;
  if (!storage || !proto || typeof proto.getItem !== "function") return;

  /* Whatever is installed right now - gd-durable-storage.js may already have
     wrapped setItem/removeItem. Its keys and these never overlap, so calling
     through to its wrapper for anything that is not ours is correct. */
  var orig = {
    getItem: proto.getItem,
    setItem: proto.setItem,
    removeItem: proto.removeItem,
    clear: proto.clear
  };
  if (orig.getItem.__gdCourseStorage) return;

  var mode = "starting";                /* starting | idb | local */
  var mem = Object.create(null);         /* key -> string | null, once known */
  var known = Object.create(null);       /* key -> true once mem[key] is authoritative */
  var early = Object.create(null);       /* writes made before the key was known */
  var dirty = Object.create(null);       /* keys whose mem value has not reached disk */
  var migrating = [];                    /* keys to drop from localStorage once IndexedDB has them */
  var db = null;
  var flushTimer = null;
  var failure = null;
  var warned = false;
  var channel = null;
  var resolveReady;
  var ready = new Promise(function (resolve) { resolveReady = resolve; });

  function nativeGet(key) { return safe(function () { return orig.getItem.call(storage, key); }, null); }
  function nativeRemove(key) { safe(function () { orig.removeItem.call(storage, key); }); }
  function nativeSet(key, value) { orig.setItem.call(storage, key, value); }

  function parse(text) {
    if (text === null || text === undefined) return null;
    return safe(function () { return JSON.parse(text); }, null);
  }
  function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }

  /* A write made before the library loaded was computed from an empty one, so
     it holds only what it added. Lay it over what loaded, course by course -
     the stores are either {courses:{id:...}} or {id:...} at the top. */
  function mergeEarly(loadedText, earlyText) {
    if (earlyText === null) return null;
    var loaded = parse(loadedText);
    var added = parse(earlyText);
    if (!isObject(loaded) || !isObject(added)) return earlyText;
    var out = Object.assign({}, loaded, added);
    if (isObject(loaded.courses) && isObject(added.courses)) {
      out.courses = Object.assign({}, loaded.courses, added.courses);
    }
    return JSON.stringify(out);
  }

  function report(message, detail) {
    safe(function () {
      if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
        window.ClarityErrorReporter.report(message, detail);
      }
    });
  }

  function noteFailure(key, error) {
    var quota = !!(error && (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014));
    failure = { at: Date.now(), key: key, quota: quota, error: String(error && (error.message || error.name) || error) };
    report(quota ? "Course storage full" : "Course storage write failed", key + " | " + failure.error);
    if (!warned) {
      warned = true;
      safe(function () {
        var text = window.GDI18n ? window.GDI18n.t("course.storageFull") : "Device storage full - map save failed";
        if (typeof window.toast === "function") window.toast(text);
      });
    }
  }

  /* ---- disk ---------------------------------------------------------------- */

  function scheduleFlush() {
    if (mode === "starting" || flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    var keys = Object.keys(dirty);
    if (!keys.length) return;
    dirty = Object.create(null);
    if (mode === "local") {
      keys.forEach(function (key) {
        try {
          if (mem[key] === null) nativeRemove(key);
          else nativeSet(key, mem[key]);
        } catch (error) {
          noteFailure(key, error);
        }
      });
      return;
    }
    var tx;
    try {
      tx = db.transaction(DB_STORE, "readwrite");
      var store = tx.objectStore(DB_STORE);
      keys.forEach(function (key) {
        if (mem[key] === null) store.delete(key);
        else store.put(mem[key], key);
      });
    } catch (error) {
      keys.forEach(function (key) { dirty[key] = true; });
      noteFailure(keys.join(","), error);
      return;
    }
    tx.oncomplete = function () { finishMigration(keys); };
    tx.onabort = tx.onerror = function () {
      /* Left dirty so the next write retries. Memory still has it, so play goes on. */
      keys.forEach(function (key) { if (!(key in dirty)) dirty[key] = true; });
      noteFailure(keys.join(","), tx.error);
    };
  }

  /* Only once IndexedDB has committed a key's value is the localStorage copy
     safe to drop - and dropping it is the whole point: that is the space the
     rest of the app has been starved of. */
  function finishMigration(keys) {
    if (!migrating.length) return;
    migrating = migrating.filter(function (key) {
      if (keys.indexOf(key) === -1) return true;
      nativeRemove(key);
      return false;
    });
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var idb = safe(function () { return window.indexedDB; }, null);
      if (!idb) { reject(new Error("IndexedDB unavailable")); return; }
      var request;
      try { request = idb.open(DB_NAME, 1); } catch (error) { reject(error); return; }
      request.onupgradeneeded = function () {
        var handle = request.result;
        if (!handle.objectStoreNames.contains(DB_STORE)) handle.createObjectStore(DB_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB open failed")); };
      request.onblocked = function () { reject(new Error("IndexedDB open blocked")); };
    });
  }

  function readAll(handle) {
    return new Promise(function (resolve, reject) {
      var values = {};
      var tx = handle.transaction(DB_STORE, "readonly");
      var store = tx.objectStore(DB_STORE);
      KEYS.forEach(function (key) {
        var request = store.get(key);
        request.onsuccess = function () { values[key] = request.result === undefined ? null : request.result; };
      });
      tx.oncomplete = function () { resolve(values); };
      tx.onabort = tx.onerror = function () { reject(tx.error || new Error("IndexedDB read failed")); };
    });
  }

  /* Every key becomes known here, whichever way boot went. */
  function settle(loaded) {
    KEYS.forEach(function (key) {
      if (known[key]) return;
      var value = loaded[key] === undefined ? null : loaded[key];
      if (key in early) {
        mem[key] = mergeEarly(value, early[key]);
        dirty[key] = true;
      } else {
        mem[key] = value;
      }
      known[key] = true;
    });
    early = Object.create(null);
  }

  function boot() {
    openDb().then(function (handle) {
      db = handle;
      safe(function () {
        /* Another WebView (a second tab, or a future version) asking to
           upgrade: let go rather than block it. */
        db.onversionchange = function () { safe(function () { db.close(); }); };
      });
      return readAll(handle);
    }).then(function (loaded) {
      mode = "idb";
      settle(loaded);
      migrating.forEach(function (key) { dirty[key] = true; });
      flush();
      resolveReady({ mode: mode });
      announce();
    }).catch(function (error) {
      /* No IndexedDB: behave exactly as before this file existed. */
      mode = "local";
      var loaded = {};
      KEYS.forEach(function (key) { loaded[key] = nativeGet(key); });
      settle(loaded);
      migrating = [];
      flush();
      report("Course storage fell back to localStorage", String(error && (error.message || error.name) || error));
      resolveReady({ mode: mode });
      announce();
    });
  }

  function announce() {
    safe(function () {
      window.dispatchEvent(new CustomEvent("clarity:course-storage-ready", { detail: { mode: mode } }));
    });
  }

  /* ---- the localStorage face ----------------------------------------------- */

  function write(key, value, fromPeer) {
    if (mode === "local") {
      /* Straight through, so a full localStorage still throws to the caller
         the way it always did - the callers already handle that. */
      if (value === null) orig.removeItem.call(storage, key);
      else nativeSet(key, value);
      mem[key] = value;
      return;
    }
    if (!known[key]) {
      early[key] = value;
    } else {
      mem[key] = value;
      if (!fromPeer) dirty[key] = true;
    }
    if (!fromPeer) {
      safe(function () { if (channel) channel.postMessage({ key: key, value: value }); });
      scheduleFlush();
    }
  }

  function read(key) {
    if (known[key]) return mem[key];
    if (mode === "local") return nativeGet(key);
    return key in early ? early[key] : null;
  }

  function define(name, fn) {
    fn.__gdCourseStorage = true;
    /* Carry the durable mirror's installed flag through: it checks for it to
       avoid installing twice, and it is still underneath doing its job. */
    if (orig[name] && orig[name].__gdDurableMirror) fn.__gdDurableMirror = true;
    return safe(function () {
      Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: true });
      return storage[name] === fn;
    }, false);
  }

  /* Taken straight into memory, synchronously, before any app script runs: the
     data that is already here is available from the first line. */
  KEYS.forEach(function (key) {
    var value = nativeGet(key);
    if (value === null) return;
    mem[key] = value;
    known[key] = true;
    migrating.push(key);
  });

  var installed = define("getItem", function (key) {
    if (this === storage && big[key]) return read(String(key));
    return orig.getItem.apply(this, arguments);
  }) && define("setItem", function (key, value) {
    if (this === storage && big[key]) return write(String(key), String(value), false);
    return orig.setItem.apply(this, arguments);
  }) && define("removeItem", function (key) {
    if (this === storage && big[key]) return write(String(key), null, false);
    return orig.removeItem.apply(this, arguments);
  }) && define("clear", function () {
    var result = orig.clear.apply(this, arguments);
    if (this === storage) KEYS.forEach(function (key) { write(key, null, false); });
    return result;
  });

  if (!installed) {
    /* Put back anything that did take, and stay out of the way. */
    ["getItem", "setItem", "removeItem", "clear"].forEach(function (name) {
      safe(function () { Object.defineProperty(proto, name, { value: orig[name], writable: true, configurable: true, enumerable: true }); });
    });
    return;
  }

  /* Two tabs of the web app each hold a memory copy; without this the second
     one to save would overwrite the first one's courses on disk. */
  safe(function () {
    if (typeof BroadcastChannel !== "function") return;
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = function (event) {
      var data = event && event.data;
      if (!data || !big[data.key]) return;
      write(data.key, data.value === null ? null : String(data.value), true);
    };
  });

  /* A WebView can be killed in the background without warning. */
  window.addEventListener("pagehide", function () { safe(flush); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") safe(flush);
  });

  window.GDCourseStorage = {
    keys: function () { return KEYS.slice(); },
    /* Resolves once every key is loaded. Anything that must see the existing
       library before deciding something (the round hand-off, a mapping run)
       awaits this; in practice it has resolved before the first tap. */
    ready: ready,
    mode: function () { return mode; },
    lastFailure: function () { return failure; },
    /* Used by clear-my-data, which walks localStorage's own keys and so would
       never see these. Returns how many were cleared. */
    clear: function () {
      var count = 0;
      KEYS.forEach(function (key) {
        if (read(key) !== null) count += 1;
        write(key, null, false);
      });
      return count;
    },
    flush: flush,
    usage: function () {
      return KEYS.map(function (key) {
        var value = read(key);
        return { key: key, bytes: value ? value.length * 2 : 0 };
      });
    }
  };

  boot();
})();

(function () {
  "use strict";

  var root = window.Clarity = window.Clarity || {};
  var JSON_PREFIX = "clarity:";

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback;
    }
  }

  function getRaw(key) {
    return safe(function () {
      return window.localStorage.getItem(key);
    }, null);
  }

  function setRaw(key, value) {
    return safe(function () {
      window.localStorage.setItem(key, String(value));
      emit(key);
      return true;
    }, false);
  }

  function remove(key) {
    return safe(function () {
      window.localStorage.removeItem(key);
      emit(key);
      return true;
    }, false);
  }

  function getJson(key, fallback) {
    var raw = getRaw(key);
    if (raw == null || raw === "") return fallback;
    return safe(function () {
      return JSON.parse(raw);
    }, fallback);
  }

  function setJson(key, value) {
    return setRaw(key, JSON.stringify(value));
  }

  function domainKey(domain, key) {
    return JSON_PREFIX + String(domain || "app") + ":" + String(key || "state");
  }

  function get(domain, key, fallback) {
    return getJson(domainKey(domain, key), fallback);
  }

  function set(domain, key, value) {
    return setJson(domainKey(domain, key), value);
  }

  function emit(key) {
    safe(function () {
      window.dispatchEvent(new CustomEvent("clarity:store-changed", {
        detail: { key: key }
      }));
    });
  }

  root.store = root.store || {};
  root.store.safe = root.store.safe || safe;
  root.store.getRaw = getRaw;
  root.store.setRaw = setRaw;
  root.store.remove = remove;
  root.store.getJson = getJson;
  root.store.setJson = setJson;
  root.store.key = domainKey;
  root.store.get = get;
  root.store.set = set;

  window.ClarityStore = root.store;
})();

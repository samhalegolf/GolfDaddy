/* Translation layer: the one place the app turns a text key into words.

   Every language is a plain dictionary of flat keys ("gpsSettings.title")
   registered by a file in scripts/i18n/ (en.js, and one file per language
   added later). English is the base: a key missing from the player's language
   falls back to the English wording, and a key missing from English too comes
   back as the key itself, so a gap shows up as an odd label instead of a blank.

   Language choice, first match wins:
     1. a saved choice (localStorage "clarity:locale"), set via setLocale()
     2. the device languages (navigator.languages), "pt-BR" trying "pt-BR"
        then "pt"
     3. English

   Two ways to use it:
     - HTML: data-i18n="key" replaces an element's text; data-i18n-placeholder,
       data-i18n-aria-label and data-i18n-title set those attributes. apply()
       runs over the whole page on DOMContentLoaded, and the English text
       stays in the HTML as first paint.
     - JS: GDI18n.t("key", { n: 3 }) for text a module writes itself;
       "{n} holes" fills in {n}. Modules that write text register onChange()
       to redraw when the language is switched.

   Browser global (window.GDI18n) and a node module, so tests run it for
   real. */
(function (root) {
  "use strict";

  var STORE_KEY = "clarity:locale";
  var BASE = "en";
  var ATTRS = ["placeholder", "aria-label", "title"];

  var dictionaries = {};
  var listeners = [];
  var current = null;

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function savedLocale() {
    var s = storage();
    try { return s ? s.getItem(STORE_KEY) : null; } catch (e) { return null; }
  }

  function deviceLocales() {
    var nav = root.navigator || {};
    if (Array.isArray(nav.languages) && nav.languages.length) return nav.languages.slice();
    return nav.language ? [nav.language] : [];
  }

  /* "pt-BR" -> the first of "pt-br", "pt" that has a dictionary. */
  function match(tag) {
    if (!tag) return null;
    var lower = String(tag).toLowerCase().replace(/_/g, "-");
    if (dictionaries[lower]) return lower;
    var primary = lower.split("-")[0];
    return dictionaries[primary] ? primary : null;
  }

  function resolve() {
    var picked = match(savedLocale());
    if (picked) return picked;
    var device = deviceLocales();
    for (var i = 0; i < device.length; i++) {
      picked = match(device[i]);
      if (picked) return picked;
    }
    return BASE;
  }

  function locale() {
    /* Resolved lazily: language files register after this one loads, so the
       answer is only known once something asks for a word. */
    if (!current || !dictionaries[current]) current = resolve();
    return current;
  }

  function t(key, vars) {
    var dict = dictionaries[locale()] || {};
    var text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key]
      : (dictionaries[BASE] && Object.prototype.hasOwnProperty.call(dictionaries[BASE], key)) ? dictionaries[BASE][key]
      : key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole;
    });
  }

  function apply(scope) {
    var doc = root.document;
    var base = scope || doc;
    if (!base || !base.querySelectorAll) return;
    if (!scope && doc.documentElement) doc.documentElement.setAttribute("lang", locale());
    var nodes = base.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute("data-i18n"));
    ATTRS.forEach(function (attr) {
      var marked = base.querySelectorAll("[data-i18n-" + attr + "]");
      for (var j = 0; j < marked.length; j++) marked[j].setAttribute(attr, t(marked[j].getAttribute("data-i18n-" + attr)));
    });
  }

  function add(tag, dict) {
    dictionaries[String(tag).toLowerCase()] = Object.assign(dictionaries[String(tag).toLowerCase()] || {}, dict);
  }

  /* null clears the saved choice and goes back to following the device. */
  function setLocale(tag) {
    var s = storage();
    try {
      if (s) { if (tag) s.setItem(STORE_KEY, String(tag)); else s.removeItem(STORE_KEY); }
    } catch (e) {}
    current = tag ? (match(tag) || resolve()) : resolve();
    apply();
    listeners.forEach(function (fn) { try { fn(current); } catch (e) {} });
    return current;
  }

  var api = {
    t: t,
    add: add,
    apply: apply,
    locale: locale,
    setLocale: setLocale,
    languages: function () { return Object.keys(dictionaries); },
    has: function (key) { return !!(dictionaries[BASE] && Object.prototype.hasOwnProperty.call(dictionaries[BASE], key)); },
    onChange: function (fn) { listeners.push(fn); }
  };

  root.GDI18n = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (root.document && root.document.addEventListener) {
    root.document.addEventListener("DOMContentLoaded", function () { apply(); });
  }
})(typeof window !== "undefined" ? window : globalThis);

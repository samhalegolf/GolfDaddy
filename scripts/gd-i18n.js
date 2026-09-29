/* Translation layer: the one place the app turns a text key into words.

   Every language is a plain dictionary of flat keys ("gpsSettings.title") in
   its own file in scripts/i18n/ (en.js, fr.js, ...), listed in LANGUAGES
   below. English is the base and always loaded: a key missing from the
   player's language falls back to the English wording, and a key missing
   from English too comes back as the key itself, so a gap shows up as an
   odd label instead of a blank.

   Only the player's own language is fetched, on demand, right after this
   file loads - shipping every language to every phone at boot would grow
   with each screen translated. Until it arrives the page is in English;
   when it lands the page is re-applied and onChange listeners redraw.

   Language choice, first match wins:
     1. a saved choice (localStorage "clarity:locale"), set via setLocale()
     2. the device languages (navigator.languages), "fr-CA" trying "fr-ca"
        then "fr"
     3. English

   Two ways to use it:
     - HTML: data-i18n="key" replaces an element's text; data-i18n-placeholder,
       data-i18n-aria-label and data-i18n-title set those attributes. apply()
       runs over the whole page on DOMContentLoaded, and the English text
       stays in the HTML as first paint.
     - JS: GDI18n.t("key", { n: 3 }) for text a module writes itself;
       "{n} holes" fills in {n}. Modules that write text register onChange()
       to redraw when the language changes or arrives.

   Browser global (window.GDI18n) and a node module, so tests run it for
   real. */
(function (root) {
  "use strict";

  var STORE_KEY = "clarity:locale";
  var BASE = "en";
  var ATTRS = ["placeholder", "aria-label", "title"];

  /* Tag -> the language's name in itself, for the picker. Adding a language
     is a file in scripts/i18n/ plus a line here. */
  var LANGUAGES = {
    en: "English",
    bg: "Български",
    cs: "Čeština",
    da: "Dansk",
    de: "Deutsch",
    el: "Ελληνικά",
    es: "Español",
    et: "Eesti",
    fi: "Suomi",
    fr: "Français",
    hr: "Hrvatski",
    hu: "Magyar",
    it: "Italiano",
    lt: "Lietuvių",
    lv: "Latviešu",
    nb: "Norsk",
    nl: "Nederlands",
    pl: "Polski",
    pt: "Português",
    ro: "Română",
    sk: "Slovenčina",
    sl: "Slovenščina",
    sv: "Svenska"
  };
  /* Device tags that should read another file: "no" and Nynorsk phones get
     Bokmål, the only Norwegian written here. */
  var ALIASES = { no: "nb", nn: "nb" };

  var dictionaries = {};
  var listeners = [];
  var requested = {};
  var current = null;

  /* Where the language files live, from this script's own URL, so it works
     from / and /app/ on the web and from capacitor://localhost natively. */
  var script = root.document && root.document.currentScript;
  var FILES = script && script.src ? script.src.replace(/[^/]*$/, "") + "i18n/" : null;

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

  function known(tag) {
    return Object.prototype.hasOwnProperty.call(LANGUAGES, tag) || !!dictionaries[tag];
  }

  /* "fr-CA" -> the first of "fr-ca", "fr" this app has. */
  function match(tag) {
    if (!tag) return null;
    var lower = String(tag).toLowerCase().replace(/_/g, "-");
    if (known(lower)) return lower;
    var primary = lower.split("-")[0];
    primary = ALIASES[primary] || primary;
    return known(primary) ? primary : null;
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
    if (!current) current = resolve();
    return current;
  }

  /* Fetch a language file once. English never is: the page loads en.js
     itself, straight after this file. Failure leaves the page in English,
     which is the same state it was already showing. */
  function load(tag) {
    if (tag === BASE || dictionaries[tag] || requested[tag] || !FILES || !root.document) return;
    requested[tag] = true;
    var el = root.document.createElement("script");
    el.src = FILES + tag + ".js";
    el.async = true;
    (root.document.head || root.document.documentElement).appendChild(el);
  }

  function lookup(dict, key) {
    return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
  }

  function t(key, vars) {
    var text = lookup(dictionaries[locale()], key);
    if (text === null) text = lookup(dictionaries[BASE], key);
    if (text === null) text = key;
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

  function changed() {
    apply();
    listeners.forEach(function (fn) { try { fn(current); } catch (e) {} });
  }

  function add(tag, dict) {
    var key = String(tag).toLowerCase();
    dictionaries[key] = Object.assign(dictionaries[key] || {}, dict);
    /* The player's language arriving after first paint. */
    if (key === current && key !== BASE) changed();
  }

  /* null clears the saved choice and goes back to following the device. */
  function setLocale(tag) {
    var s = storage();
    try {
      if (s) { if (tag) s.setItem(STORE_KEY, String(tag)); else s.removeItem(STORE_KEY); }
    } catch (e) {}
    current = resolve();
    load(current);
    changed();
    return current;
  }

  var api = {
    t: t,
    add: add,
    apply: apply,
    locale: locale,
    setLocale: setLocale,
    /* The saved choice as a supported tag, or null when following the device. */
    saved: function () { return match(savedLocale()); },
    /* [{ tag, name }] in picker order: English first, the rest by tag. */
    languages: function () {
      return Object.keys(LANGUAGES).map(function (tag) { return { tag: tag, name: LANGUAGES[tag] }; });
    },
    has: function (key) { return lookup(dictionaries[BASE], key) !== null; },
    onChange: function (fn) { listeners.push(fn); }
  };

  root.GDI18n = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  load(locale());
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener("DOMContentLoaded", function () { apply(); });
  }
})(typeof window !== "undefined" ? window : globalThis);

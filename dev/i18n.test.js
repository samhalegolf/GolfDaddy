/*
 * Translation layer (scripts/gd-i18n.js) and the first screen moved onto it,
 * GPS Settings on the play surface.
 *
 * Pinned here:
 *   - the language is picked saved choice -> device -> English, with "pt-BR"
 *     falling back to "pt" and "no" to Norwegian Bokmal;
 *   - only the player's language file is fetched, and the page redraws when
 *     it arrives;
 *   - every language file in scripts/i18n/ is listed, has exactly English's
 *     keys (no typos, nothing silently left in English) and keeps the same
 *     {placeholders};
 *   - a word missing from a language falls back to English, then to the key;
 *   - {name} placeholders fill in;
 *   - every key app/index.html and gps-settings.js ask for exists in English,
 *     so a typo'd key cannot ship as a raw "gpsSettings.foo" label;
 *   - GPS Settings writes its toggle text through the layer, redraws when
 *     the language is switched, and its picker saves or clears the choice.
 *
 * Run: node dev/i18n.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-i18n.js'), 'utf8');
const EN_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'i18n', 'en.js'), 'utf8');

function memoryStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    data
  };
}

/* A fresh window per case: the layer caches its resolved language. */
function boot({ languages = ['en-NZ'], saved = null, extra = {}, document } = {}) {
  const window = {
    navigator: { languages },
    localStorage: memoryStorage(saved ? { 'clarity:locale': saved } : {}),
    document
  };
  window.window = window;
  window.globalThis = window;
  const ctx = vm.createContext(window);
  vm.runInContext(I18N_SRC, ctx);
  vm.runInContext(EN_SRC, ctx);
  Object.keys(extra).forEach((tag) => window.GDI18n.add(tag, extra[tag]));
  return window;
}

const SPANISH = { 'common.on': 'Sí', 'gpsSettings.unitsYards': 'Yardas' };

/* ---- Language choice ---- */
assert.strictEqual(boot().GDI18n.locale(), 'en', 'a device with no matching dictionary uses English');
assert.strictEqual(boot({ languages: ['es-MX', 'en'], extra: { es: SPANISH } }).GDI18n.locale(), 'es',
  '"es-MX" falls back to "es"');
assert.strictEqual(boot({ languages: ['ja-JP', 'es'], extra: { es: SPANISH } }).GDI18n.locale(), 'es',
  'the first device language the app has wins');
assert.strictEqual(boot({ languages: ['fr-CA'] }).GDI18n.locale(), 'fr', 'a listed language counts before its file loads');
assert.strictEqual(boot({ languages: ['no-NO'] }).GDI18n.locale(), 'nb', '"no" reads Norwegian Bokmal');
assert.strictEqual(boot({ languages: ['nn'] }).GDI18n.locale(), 'nb', 'Nynorsk reads Norwegian Bokmal');
assert.strictEqual(boot({ languages: ['es'], saved: 'en', extra: { es: SPANISH } }).GDI18n.locale(), 'en',
  'a saved choice beats the device language');
assert.strictEqual(boot({ languages: [], extra: { es: SPANISH } }).GDI18n.locale(), 'en',
  'no device languages at all still answers English');

/* ---- Lookup and fallback ---- */
{
  const { GDI18n } = boot({ languages: ['es'], extra: { es: SPANISH } });
  assert.strictEqual(GDI18n.t('common.on'), 'Sí');
  assert.strictEqual(GDI18n.t('common.off'), 'Off', 'a word the language lacks falls back to English');
  assert.strictEqual(GDI18n.t('no.such.key'), 'no.such.key', 'a key missing everywhere comes back as itself');
}
{
  const { GDI18n } = boot({ extra: { en: { 'test.holes': '{n} holes at {course}' } } });
  assert.strictEqual(GDI18n.t('test.holes', { n: 9, course: 'Akarana' }), '9 holes at Akarana');
  assert.strictEqual(GDI18n.t('test.holes', { n: 9 }), '9 holes at {course}', 'an unfilled placeholder is left visible');
}

/* ---- setLocale saves, notifies, and clears ---- */
{
  const window = boot({ languages: ['en'], extra: { es: SPANISH } });
  const heard = [];
  window.GDI18n.onChange((tag) => heard.push(tag));
  assert.strictEqual(window.GDI18n.setLocale('es-ES'), 'es');
  assert.strictEqual(window.localStorage.data['clarity:locale'], 'es-ES');
  assert.strictEqual(window.GDI18n.setLocale(null), 'en', 'clearing goes back to the device language');
  assert.ok(!('clarity:locale' in window.localStorage.data));
  assert.deepStrictEqual(heard, ['es', 'en']);
}

/* ---- Storage that throws must not break anything ---- */
{
  const window = { navigator: { languages: ['en'] } };
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
  window.window = window;
  const ctx = vm.createContext(window);
  vm.runInContext(I18N_SRC, ctx);
  vm.runInContext(EN_SRC, ctx);
  assert.strictEqual(window.GDI18n.t('common.on'), 'On');
  assert.strictEqual(window.GDI18n.setLocale('en'), 'en');
}

/* ---- Only the player's language file is fetched, and its arrival redraws ---- */
{
  const appended = [];
  const document = {
    currentScript: { src: 'https://caddy.example/scripts/gd-i18n.js?v=1' },
    head: { appendChild: (el) => appended.push(el) },
    createElement: () => ({}),
    documentElement: { setAttribute() {} },
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const window = boot({ languages: ['de-AT', 'en'], document });
  assert.deepStrictEqual(appended.map((el) => el.src), ['https://caddy.example/scripts/i18n/de.js'],
    'exactly the German file, next to gd-i18n.js');
  const heard = [];
  window.GDI18n.onChange((tag) => heard.push(tag));
  assert.strictEqual(window.GDI18n.t('common.on'), 'On', 'English until German arrives');
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts', 'i18n', 'de.js'), 'utf8'), vm.createContext(window));
  assert.strictEqual(window.GDI18n.t('common.on'), 'An');
  assert.deepStrictEqual(heard, ['de'], 'listeners redraw when the language lands');
  window.GDI18n.setLocale('de');
  assert.strictEqual(appended.length, 1, 'a loaded language is never fetched twice');
  boot({ languages: ['en-GB'], document });
  assert.strictEqual(appended.length, 1, 'English players fetch nothing extra');
}

/* ---- Every language file is listed and complete ---- */
{
  const { GDI18n } = boot();
  const listed = Array.from(GDI18n.languages(), (l) => l.tag).sort();
  const files = fs.readdirSync(path.join(ROOT, 'scripts', 'i18n')).filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, '')).sort();
  assert.deepStrictEqual(listed, files, 'LANGUAGES in gd-i18n.js and the files in scripts/i18n/ must match');

  const captured = {};
  const capture = { GDI18n: { add: (tag, dict) => { captured[tag] = dict; } } };
  capture.window = capture;
  files.forEach((tag) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts', 'i18n', tag + '.js'), 'utf8'), vm.createContext(capture));
    assert.ok(captured[tag], tag + '.js must register itself as "' + tag + '"');
  });
  const english = captured.en;
  const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(',');
  const PLURAL = /\.(zero|one|two|few|many|other)$/;
  /* Plural keys ("x.one", "x.other") are checked per base: each language has
     exactly the forms its own grammar picks for a whole number of shots,
     clubs or strokes (0-200) - Polish one/few/many, Latvian zero/one/other -
     rather than English's two. */
  const pluralBases = new Set(Object.keys(english).filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')));
  const formsFor = (tag) => {
    const rules = new Intl.PluralRules(tag);
    const forms = new Set(['other']);
    for (let n = 0; n <= 200; n++) forms.add(rules.select(n));
    return forms;
  };
  const isPlural = (k) => PLURAL.test(k) && pluralBases.has(k.replace(PLURAL, ''));
  files.filter((tag) => tag !== 'en').forEach((tag) => {
    const dict = captured[tag];
    const extra = Object.keys(dict).filter((k) => !(k in english) && !isPlural(k));
    const missing = Object.keys(english).filter((k) => !isPlural(k) && !(k in dict));
    assert.deepStrictEqual(extra, [], tag + '.js has keys English does not (typo?)');
    assert.deepStrictEqual(missing, [], tag + '.js is missing translations');
    const forms = formsFor(tag);
    pluralBases.forEach((base) => {
      const have = Object.keys(dict).filter((k) => k.replace(PLURAL, '') === base && PLURAL.test(k)).map((k) => k.match(PLURAL)[1]).sort();
      assert.deepStrictEqual(have, [...forms].sort(), tag + ' ' + base + ' needs exactly the plural forms ' + [...forms].sort().join('/'));
    });
    Object.keys(dict).forEach((k) => {
      assert.ok(typeof dict[k] === 'string' && dict[k].trim(), tag + ' ' + k + ' is empty');
      const source = isPlural(k) ? english[k.replace(PLURAL, '') + '.other'] : english[k];
      assert.strictEqual(placeholders(dict[k]), placeholders(source), tag + ' ' + k + ' changes the {placeholders}');
    });
  });
}

/* ---- Every key the play page uses exists in English ---- */
{
  const { GDI18n } = boot();
  const english = new Set();
  const capture = { GDI18n: { add: (tag, dict) => Object.keys(dict).forEach((k) => english.add(k)) } };
  capture.window = capture;
  vm.runInContext(EN_SRC, vm.createContext(capture));
  const known = (key) => english.has(key) || english.has(key + '.other');
  /* A key is any quoted "namespace.word" whose namespace English uses, so a
     typo'd key in code fails here instead of shipping as a raw label. */
  const namespaces = new Set([...english].map((k) => k.split('.')[0]));
  const sources = [path.join('app', 'index.html')]
    .concat(fs.readdirSync(path.join(ROOT, 'app', 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join('app', 'js', f)))
    .concat([path.join('scripts', 'gd-bag-core.js'), path.join('scripts', 'gd-practice-bubble-preview.js')]);
  const used = new Map();
  sources.forEach((file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/["']([a-z][A-Za-z]*\.[a-z][A-Za-z]*)["']/g)) {
      if (namespaces.has(m[1].split('.')[0])) used.set(m[1], file);
    }
  });
  assert.ok(used.size >= 150, 'expected the play page keys to be found, got ' + used.size);
  const missing = [...used.keys()].filter((key) => !known(key)).map((key) => key + ' (' + used.get(key) + ')');
  assert.deepStrictEqual(missing, [], 'keys used but not in scripts/i18n/en.js');
  /* And the other way: a word nothing asks for is one more thing to
     translate 22 times for no reason. */
  const unused = [...english].filter((k) => !used.has(k) && !used.has(k.replace(/\.(zero|one|two|few|many|other)$/, '')));
  assert.deepStrictEqual(unused, [], 'keys in scripts/i18n/en.js that nothing uses');
  assert.ok(GDI18n.has('common.hole'));
}

/* ---- Plurals follow each language's own rules ---- */
{
  const { GDI18n } = boot({ languages: ['pl'], extra: { pl: {
    'complete.shotsLogged.one': '{n} strzał', 'complete.shotsLogged.few': '{n} strzały',
    'complete.shotsLogged.many': '{n} strzałów', 'complete.shotsLogged.other': '{n} strzału' } } });
  assert.strictEqual(GDI18n.tn('complete.shotsLogged', 1), '1 strzał');
  assert.strictEqual(GDI18n.tn('complete.shotsLogged', 3), '3 strzały');
  assert.strictEqual(GDI18n.tn('complete.shotsLogged', 5), '5 strzałów');
  const en = boot().GDI18n;
  assert.strictEqual(en.tn('complete.shotsLogged', 1), '1 shot logged');
  assert.strictEqual(en.tn('complete.shotsLogged', 2), '2 shots logged');
  assert.strictEqual(en.tn('no.such.plural', 2), 'no.such.plural');
}

/* ---- Text written through set() re-translates on a language switch ---- */
{
  const made = [];
  const node = () => {
    const n = { attrs: {}, textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; } };
    made.push(n);
    return n;
  };
  const document = {
    documentElement: node(),
    querySelectorAll: (sel) => {
      const attr = sel.slice(1, -1);
      return made.filter((n) => n.getAttribute(attr) !== null);
    },
    addEventListener() {}
  };
  const window = boot({ languages: ['en'], document, extra: { es: { 'common.hole': 'Hoyo {n}', 'complete.shotsLogged.one': '{n} golpe registrado', 'complete.shotsLogged.other': '{n} golpes registrados', 'rail.windLevel': 'Viento {n}' } } });
  const { GDI18n } = window;
  const title = node(), shots = node(), button = node(), course = node();
  GDI18n.set(title, 'common.hole', { n: 7 });
  GDI18n.setPlural(shots, 'complete.shotsLogged', 2);
  GDI18n.setAttr(button, 'aria-label', 'rail.windLevel', { n: 3 });
  course.setAttribute('data-i18n', 'loading.course');
  GDI18n.plain(course, 'Akarana Golf Club');
  assert.strictEqual(title.textContent, 'Hole 7');
  assert.strictEqual(shots.textContent, '2 shots logged');
  assert.strictEqual(button.attrs['aria-label'], 'Wind 3');
  GDI18n.setLocale('es');
  assert.strictEqual(title.textContent, 'Hoyo 7');
  assert.strictEqual(shots.textContent, '2 golpes registrados');
  assert.strictEqual(button.attrs['aria-label'], 'Viento 3');
  assert.strictEqual(course.textContent, 'Akarana Golf Club', 'plain() text is never re-translated');
  GDI18n.set(title, null);
  assert.strictEqual(title.textContent, '');
  assert.strictEqual(title.getAttribute('data-i18n'), null, 'a cleared element is forgotten');
}

/* ---- The page loads the layer before GPS Settings ---- */
{
  const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
  const at = (src) => html.indexOf('src="' + src);
  assert.ok(at('../scripts/gd-i18n.js') > 0, 'app/index.html loads gd-i18n.js');
  assert.ok(at('../scripts/gd-i18n.js') < at('../scripts/i18n/en.js'), 'the layer loads before its dictionary');
  assert.ok(at('../scripts/i18n/en.js') < at('js/gps-settings.js'), 'English loads before GPS Settings');
}

/* ---- GPS Settings draws through the layer and follows a switch ---- */
{
  const elements = {};
  const listeners = {};
  const el = (id) => (elements[id] = elements[id] || {
    id, textContent: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener() {},
    classList: { add() {}, remove() {} },
    children: [],
    set innerHTML(v) { this.children = []; },
    appendChild(child) { this.children.push(child); }
  });
  const document = {
    documentElement: el('html'),
    getElementById: el,
    createElement: () => ({}),
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }
  };
  const window = boot({ languages: ['en-GB'], extra: { es: SPANISH }, document });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'js', 'gps-settings.js'), 'utf8'), vm.createContext(window));
  listeners.DOMContentLoaded.forEach((fn) => fn());

  assert.strictEqual(elements.setUnits.textContent, 'Metres');
  assert.strictEqual(elements.setAimLine.textContent, 'On');
  assert.strictEqual(elements.setFrameTight.textContent, 'Medium');
  assert.strictEqual(elements.setFrameTightSub.textContent, 'Balanced shot view');

  window.ClarityApp.gpsSettings.set('units', 'yd');
  assert.strictEqual(elements.setUnits.textContent, 'Yards');

  window.GDI18n.setLocale('es');
  assert.strictEqual(elements.setUnits.textContent, 'Yardas', 'the panel redraws in the new language');
  assert.strictEqual(elements.setAimLine.textContent, 'Sí');
  assert.strictEqual(elements.setFrameTight.textContent, 'Medium', 'untranslated words fall back to English');
  assert.strictEqual(elements.html.attrs.lang, 'es', '<html lang> follows the language');

  /* The picker: "follow the phone" first, then every language in its own name. */
  const picker = elements.setLanguage;
  assert.strictEqual(picker.children[0].value, '');
  assert.ok(picker.children.some((o) => o.value === 'de' && o.textContent === 'Deutsch'));
  assert.strictEqual(picker.value, 'es', 'shows the saved choice');
  window.GDI18n.setLocale(null);
  assert.strictEqual(picker.value, '', 'following the phone again');
  assert.strictEqual(picker.children[0].textContent, 'Phone language');
}

console.log('i18n tests passed');

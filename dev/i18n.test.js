/*
 * Translation layer (scripts/gd-i18n.js) and the first screen moved onto it,
 * GPS Settings on the play surface.
 *
 * Pinned here:
 *   - the language is picked saved choice -> device -> English, with "pt-BR"
 *     falling back to "pt";
 *   - a word missing from a language falls back to English, then to the key;
 *   - {name} placeholders fill in;
 *   - every key app/index.html and gps-settings.js ask for exists in English,
 *     so a typo'd key cannot ship as a raw "gpsSettings.foo" label;
 *   - GPS Settings writes its toggle text through the layer and redraws when
 *     the language is switched.
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
assert.strictEqual(boot({ languages: ['fr-FR', 'es'], extra: { es: SPANISH } }).GDI18n.locale(), 'es',
  'the first device language with a dictionary wins');
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

/* ---- Every key the play page and GPS Settings use exists in English ---- */
{
  const { GDI18n } = boot();
  const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'app', 'js', 'gps-settings.js'), 'utf8');
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of settingsSrc.matchAll(/"((?:gpsSettings|common)\.[A-Za-z]+)"/g)) used.add(m[1]);
  assert.ok(used.size >= 15, 'expected the GPS Settings keys to be found, got ' + used.size);
  const missing = [...used].filter((key) => !GDI18n.has(key));
  assert.deepStrictEqual(missing, [], 'keys used but not in scripts/i18n/en.js');
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
    classList: { add() {}, remove() {} }
  });
  const document = {
    documentElement: el('html'),
    getElementById: el,
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
}

console.log('i18n tests passed');

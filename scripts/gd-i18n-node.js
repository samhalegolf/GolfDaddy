/* The app's language files, read on the server.
 *
 * Emails are written in Netlify functions, which have no GDI18n. This reads the same
 * scripts/i18n/<tag>.js files the app loads (each one only calls GDI18n.add) and gives back
 * t()/tn() with the app's rules: the language's own text, then English, then the key; {name}
 * placeholders; plural forms from Intl.PluralRules. One set of translations for the app and
 * its emails.
 *
 * Node only. netlify.toml pins scripts/i18n/*.js into the function bundle. */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BASE = "en";

/* Where the language files are. Next to this file in the source tree and in a function that
   Netlify zips as plain files - but an ES-module function (.mjs) is bundled by esbuild, which
   inlines this file into the function and leaves __dirname pointing at the bundle, not at
   scripts/. The pinned scripts/i18n/*.js are still in the zip at their repo path, so look for
   them there too, and from the working directory, before giving up. Found once, kept. Without
   this every t() returned its key, and the course-ready email went out reading
   "email.courseReady.subject" (2026-10-15, 2026-10-19). */
let resolvedDir = null;
function dir() {
  if (resolvedDir !== null) return resolvedDir;
  const candidates = [
    path.join(__dirname, "i18n"),
    path.join(__dirname, "scripts", "i18n"),
    path.join(process.cwd(), "scripts", "i18n")
  ];
  let up = __dirname;
  for (let i = 0; i < 4; i++) {
    up = path.dirname(up);
    candidates.push(path.join(up, "scripts", "i18n"));
  }
  resolvedDir = candidates.find((candidate) => {
    try { return fs.statSync(path.join(candidate, BASE + ".js")).isFile(); } catch (e) { return false; }
  }) || "";
  if (!resolvedDir) console.warn("gd-i18n-node: no language files found; emails will show translation keys. Looked in: " + candidates.join(", "));
  return resolvedDir;
}
const ALIASES = { no: "nb", nn: "nb" };
const cache = {};

function available() {
  try {
    return fs.readdirSync(dir()).filter((f) => /^[a-z]{2}\.js$/.test(f)).map((f) => f.slice(0, 2));
  } catch (e) {
    return [BASE];
  }
}

function dictionary(tag) {
  if (Object.prototype.hasOwnProperty.call(cache, tag)) return cache[tag];
  let dict = null;
  try {
    const context = { GDI18n: { add: (_tag, d) => { dict = d; } } };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(dir(), tag + ".js"), "utf8"), context);
  } catch (e) {
    dict = null;
  }
  cache[tag] = dict;
  return dict;
}

/* "fr-CA", "FR", "nn" -> a tag this app has, or English. */
function match(tag) {
  const lower = String(tag || "").toLowerCase().replace(/_/g, "-");
  if (!lower) return BASE;
  const have = available();
  if (have.includes(lower)) return lower;
  let primary = lower.split("-")[0];
  primary = ALIASES[primary] || primary;
  return have.includes(primary) ? primary : BASE;
}

/* A tag the app has, or "" - for anything that will be stored. An unknown tag is "", not
   English, so it never overwrites a real choice. */
function clean(value) {
  const input = String(value || "").trim().slice(0, 20);
  if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(input)) return "";
  const tag = match(input);
  return tag === BASE && !/^en\b/i.test(input) ? "" : tag;
}

function lookup(dict, key) {
  return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
}

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
}

function pluralForm(tag, n) {
  try { return new Intl.PluralRules(tag).select(n); } catch (e) { return n === 1 ? "one" : "other"; }
}

function translator(requested) {
  const locale = match(requested);
  const own = dictionary(locale);
  const base = dictionary(BASE);
  function t(key, vars) {
    let text = lookup(own, key);
    if (text === null) text = lookup(base, key);
    if (text === null) text = key;
    return fill(text, vars);
  }
  function pluralText(tag, dict, key, n) {
    const text = lookup(dict, key + "." + pluralForm(tag, n));
    return text !== null ? text : lookup(dict, key + ".other");
  }
  function tn(key, n, vars) {
    let text = pluralText(locale, own, key, n);
    if (text === null) text = pluralText(BASE, base, key, n);
    if (text === null) text = key;
    return fill(text, Object.assign({ n }, vars || {}));
  }
  return { locale, t, tn };
}

module.exports = { translator, match, clean, BASE };

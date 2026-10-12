/* GPS Play's scorecard (app/js/scorecard.js) shows the card it is given: par, SI when the card
 * has one, a distance for the tee picked, a tee picker only for a card with several tees, and
 * Out / In / Total. A tiny stand-in DOM, no browser.
 *
 * Run: node dev/app-scorecard.test.js */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app", "js", "scorecard.js"), "utf8");

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this._text = ""; this.className = ""; this.attrs = {}; this.listeners = {}; this.value = ""; this.classList = { add: () => {}, remove: () => {} }; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  querySelector(sel) { const tag = sel.toUpperCase(); const walk = n => { for (const c of n.children) { if (c.tagName === tag) return c; const f = walk(c); if (f) return f; } return null; }; return walk(this); }
}

function world(card, tee) {
  const body = new El("div");
  const list = body.appendChild(new El("div")); list.id = "scoreList";
  const total = body.appendChild(new El("div")); total.id = "scoreTotal";
  const panel = new El("div"); panel.id = "scorePanel";
  const ids = { scoreList: list, scoreTotal: total, scorePanel: panel };
  const store = tee ? { "clarity:scorecard:tee:v1": tee } : {};
  const document = {
    createElement: t => new El(t),
    getElementById: id => ids[id] || (body.children.find(c => c.id === id)) || null,
    addEventListener: () => {}
  };
  const label = k => ({ "common.parWord": "Par", "scorecard.indexShort": "SI", "logged.score": "Score", "scorecard.out": "Out", "scorecard.in": "In", "bagPage.total": "Total", "scorePage.teeMarker": "Tee marker" }[k] || k);
  const window = {
    ClarityApp: {
      courseKey: k => k,
      marshal: { round: () => ({ holesInPlay: card.holes.map(h => h.hole), hole: 1 }) },
      gpsSettings: { unitLabel: () => "m", toDisplay: m => Math.round(m) }
    },
    GDI18n: { set: (el, k) => { el.textContent = label(k); }, plain: (el, t) => { el.textContent = t; }, setAttr: () => {}, setPlural: (el, k, n) => { el.textContent = n + " strokes"; } }
  };
  const ctx = {
    window, document,
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    fetch: async () => ({ ok: true, json: async () => ({ found: true, scorecard: card }) }),
    AbortController, setTimeout, clearTimeout, console
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { app: window.ClarityApp, list, body };
}

const rows = list => list.children.map(r => r.children.map(c => c.textContent.trim()));

(async () => {
  const tees = { White: { metres: 0 }, Red: { metres: 0 } };
  const eighteen = { holes: Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, index: i + 1, metres: 300 + i, tees: { White: { metres: 300 + i }, Red: { metres: 250 + i } } })) };

  let w = world(eighteen, "Red");
  await w.app.scorecard.setCourse("x", "X");
  let r = rows(w.list);
  assert.deepStrictEqual(r[0].slice(0, 4), ["#", "Par", "SI", "m"], "a card with SI and distances shows both");
  assert.deepStrictEqual(r[1].slice(0, 4), ["1", "", "1", "250"], "the saved tee's distance");
  assert.deepStrictEqual(r.slice(-3).map(x => x[0]), ["Out", "In", "Total"]);
  assert.strictEqual(r[r.length - 1][1], "72");
  assert.ok(w.body.children.some(c => c.id === "scoreTee"), "several tees: a tee picker");

  const plain = { holes: Array.from({ length: 9 }, (_, i) => ({ hole: i + 1, par: 3, metres: 120 + i })) };
  w = world(plain);
  await w.app.scorecard.setCourse("y", "Y");
  r = rows(w.list);
  assert.deepStrictEqual(r[0].slice(0, 3), ["#", "Par", "m"], "no SI on the card, no SI column");
  assert.strictEqual(r[1][2], "120");
  assert.deepStrictEqual(r.slice(-1).map(x => x[0]), ["Total"], "a nine has one total");
  assert.ok(!w.body.children.some(c => c.id === "scoreTee"), "one tee: no picker");

  const parOnly = { holes: [{ hole: 1, par: 4 }, { hole: 2, par: 5 }] };
  w = world(parOnly);
  await w.app.scorecard.setCourse("z", "Z");
  assert.deepStrictEqual(rows(w.list)[0].slice(0, 2), ["#", "Par"]);
  assert.strictEqual(rows(w.list)[0].length, 3, "par only: hole, par, score");
  assert.strictEqual(w.app.scorecard.parFor(2), 5);

  console.log("app scorecard tests passed");
})().catch(error => { console.error(error); process.exit(1); });

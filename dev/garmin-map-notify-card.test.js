/* The "email me when it's ready" card for a Garmin waiting on a Garmin map still being built:
 * scripts/gd-course-map-notify.js offer(course, {garmin}) driven by the /app/ shell's
 * app/js/native-round-bridge.js when the watch delivery hears "building" (Springfield,
 * 2026-11-02 - a course mapped and teed off on in the same minute).
 *
 * Pinned: the card appears once per course with the Garmin wording, posts kind "garmin",
 * says what it will do, comes down once the map reaches the watch, says so when the map
 * finished while the player typed, and dismiss() never takes down another course's card.
 * A few lines of fake DOM stand in for the page. Run: node dev/garmin-map-notify-card.test.js */
const vm = require("vm"), fs = require("fs"), assert = require("assert");
const root = require("path").join(__dirname, "..") + "/";
// --- minimal DOM: one card element whose querySelector hands back fake controls ---
function makeEl() {
  const controls = {};
  const el = { id: "", className: "", dataset: {}, innerHTML: "", style: {},
    classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
    setAttribute() {}, appendChild() {},
    querySelector(sel) {
      const m = sel.match(/data-gd-notify-(\w+)/); if (!m) return null;
      if (!this.innerHTML.includes("data-gd-notify-" + m[1])) return null;
      return controls[m[1]] || (controls[m[1]] = { value: m[1] === "email" ? "guest@example.com" : "", disabled: false, focus() {} });
    } };
  return el;
}
let card = null;
const posts = [];
const ctx = {
  console, setTimeout: (fn) => 0, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { body: { appendChild(el) { card = el; } }, head: { appendChild() {} },
    getElementById: (id) => (card && card.id === id ? card : null), createElement: () => makeEl() },
  fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ctx.reply }; },
  reply: { requested: true, courseId: "springfield", email: "guest@example.com" }
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(root + "scripts/gd-i18n.js", "utf8"), ctx);
vm.runInContext(fs.readFileSync(root + "scripts/i18n/en.js", "utf8"), ctx);
vm.runInContext(fs.readFileSync(root + "scripts/gd-course-map-notify.js", "utf8"), ctx);

// --- the bridge hook, with a delivery that answers "building" then "delivered" ---
let answer = { delivered: false, reason: "building" };
ctx.GDWatchMapDelivery = { deliver: () => Promise.resolve(answer) };
ctx.GDWatchPlayerDelivery = { deliver() {} };
vm.runInContext(fs.readFileSync(root + "app/js/native-round-bridge.js", "utf8"), ctx);
let onScene = null;
const scene = { course: { key: "springfield", name: "Springfield Country Club" } };
ctx.GDNativeRoundBridge.attach({ onScene: (fn) => { onScene = fn; }, scene: () => scene });

(async () => {
  await new Promise(r => setImmediate(r));
  assert.ok(card && !card.classList.contains("hidden"), "card shown on building");
  assert.strictEqual(card.dataset.gdNotifyKind, "garmin");
  assert.ok(card.innerHTML.includes("Your Garmin map for Springfield Country Club is being built"), card.innerHTML);
  const shownOnce = card.dataset.gdNotifyOffer;
  onScene(scene); await new Promise(r => setImmediate(r));
  assert.strictEqual(card.dataset.gdNotifyOffer, shownOnce, "offered once per course");

  await card.querySelector("[data-gd-notify-go]").onclick();
  assert.deepStrictEqual(posts[0].body, { courseId: "springfield", courseName: "Springfield Country Club", email: "guest@example.com", kind: "garmin" });
  assert.ok(card.innerHTML.includes("email guest@example.com when the Garmin map for Springfield Country Club is ready."), card.innerHTML);

  answer = { delivered: true, sent: 1, watch: "garmin" };
  onScene(scene); await new Promise(r => setImmediate(r));
  assert.ok(card.classList.contains("hidden"), "card taken down once the map reaches the watch");

  // a map that finished while typing
  ctx.reply = { requested: false, ready: true, courseId: "other" };
  ctx.GDCourseMapNotify.offer({ courseId: "other", courseName: "Other" }, { garmin: true });
  await card.querySelector("[data-gd-notify-go]").onclick();
  assert.ok(card.innerHTML.includes("Your Garmin map is ready"), card.innerHTML);

  // dismiss leaves a different course's card alone
  ctx.GDCourseMapNotify.offer({ courseId: "third", courseName: "Third" }, { garmin: true });
  assert.strictEqual(ctx.GDCourseMapNotify.dismiss("springfield", "garmin"), false);
  assert.ok(!card.classList.contains("hidden"));
  console.log("garmin card + bridge: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });

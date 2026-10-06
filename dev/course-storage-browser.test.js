/* Browser acceptance for scripts/inline/gd-course-storage.js: the course libraries
   move out of localStorage into IndexedDB without any reader noticing.

   Run: node dev/course-storage-browser.test.js */
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const playwright = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const MODULE = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-course-storage.js"), "utf8");
const USER = "gd_user_course_library_v1";
const APP = "clarity:course-library:v1";

/* The page records what a reader sees synchronously at load, before IndexedDB
   has answered, and can make an early write - the two moments that matter. */
const PAGE = `<!doctype html><meta charset="utf-8"><script>${MODULE}</script>
<script>
  window.atLoad = localStorage.getItem(${JSON.stringify(USER)});
  if (location.hash === "#early") {
    localStorage.setItem(${JSON.stringify(USER)}, JSON.stringify({ courses: { b: { id: "b" } } }));
  }
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(req.url.startsWith("/raw") ? "<!doctype html><p>raw</p>" : PAGE);
});

const nativeKeys = () => {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return keys;
};
const readIdb = (key) => new Promise((resolve, reject) => {
  const open = indexedDB.open("clarity-course-storage", 1);
  open.onsuccess = () => {
    const get = open.result.transaction("kv").objectStore("kv").get(key);
    get.onsuccess = () => { resolve(get.result === undefined ? null : get.result); open.result.close(); };
    get.onerror = () => reject(get.error);
  };
  open.onerror = () => reject(open.error);
});
const settled = async (page) => {
  await page.evaluate(() => window.GDCourseStorage.ready);
  await page.evaluate(() => { window.GDCourseStorage.flush(); return new Promise((r) => setTimeout(r, 150)); });
};

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port + "/";
  let browser;
  try {
    try { browser = await playwright.chromium.launch(); }
    catch (e) { browser = await playwright.chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }); }

    /* ---- migration from an existing localStorage library ---- */
    const context = await browser.newContext();
    const page = await context.newPage();
    const legacy = JSON.stringify({ courses: { a: { id: "a" } } });
    /* A page without the module: this is a phone from before the change. */
    await page.goto(base + "raw.html");
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [USER, legacy]);

    await page.goto(base + "app.html");
    assert.strictEqual(await page.evaluate(() => window.atLoad), legacy,
      "a library still in localStorage is readable synchronously, from the first script");
    await settled(page);
    assert.ok(!(await page.evaluate(nativeKeys)).includes(USER), "once IndexedDB has it, the localStorage copy is gone");
    assert.strictEqual(await page.evaluate(readIdb, USER), legacy, "IndexedDB holds the migrated library");
    assert.strictEqual(await page.evaluate((k) => localStorage.getItem(k), USER), legacy, "readers still see it");

    /* ---- later loads come from IndexedDB ---- */
    await page.reload();
    assert.strictEqual(await page.evaluate(() => window.atLoad), null, "before IndexedDB answers, a reader sees an empty library");
    await page.evaluate(() => window.GDCourseStorage.ready);
    assert.strictEqual(await page.evaluate((k) => localStorage.getItem(k), USER), legacy, "after ready it is all there");
    assert.strictEqual(await page.evaluate(() => window.GDCourseStorage.mode()), "idb");

    /* ---- a write made before the load landed is merged, not a wipe ---- */
    await page.goto(base + "early.html#early");   /* a new document, not a hash change */
    await settled(page);
    const merged = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), USER));
    assert.deepStrictEqual(Object.keys(merged.courses).sort(), ["a", "b"], "the early save kept the course it never saw");
    assert.deepStrictEqual(Object.keys(JSON.parse(await page.evaluate(readIdb, USER)).courses).sort(), ["a", "b"]);

    /* ---- far past localStorage's quota ---- */
    const huge = await page.evaluate((k) => {
      const value = JSON.stringify({ blob: "x".repeat(12 * 1024 * 1024) });
      localStorage.setItem(k, value);   /* would throw QuotaExceededError in localStorage */
      return value.length;
    }, APP);
    await settled(page);
    await page.reload();
    await page.evaluate(() => window.GDCourseStorage.ready);
    assert.strictEqual(await page.evaluate((k) => (localStorage.getItem(k) || "").length, APP), huge,
      "a 12MB library saves and survives a reload");
    assert.strictEqual(await page.evaluate(() => window.GDCourseStorage.lastFailure()), null);

    /* ---- other keys are untouched ---- */
    await page.evaluate(() => localStorage.setItem("gd_other_v1", "plain"));
    assert.ok((await page.evaluate(nativeKeys)).includes("gd_other_v1"), "only the course keys are redirected");

    /* ---- clear() reaches them ---- */
    await page.evaluate(() => localStorage.clear());
    await settled(page);
    assert.strictEqual(await page.evaluate((k) => localStorage.getItem(k), USER), null);
    assert.strictEqual(await page.evaluate(readIdb, USER), null, "localStorage.clear() clears the course libraries too");
    await context.close();

    /* ---- no IndexedDB: plain localStorage, exactly as before ---- */
    const bare = await browser.newContext();
    await bare.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: undefined }); });
    const p2 = await bare.newPage();
    await p2.goto(base + "app.html");
    await p2.evaluate(() => window.GDCourseStorage.ready);
    assert.strictEqual(await p2.evaluate(() => window.GDCourseStorage.mode()), "local");
    await p2.evaluate((k) => localStorage.setItem(k, "{\"courses\":{}}"), USER);
    assert.ok((await p2.evaluate(nativeKeys)).includes(USER), "without IndexedDB the key lives in localStorage");
    await bare.close();

    console.log("course-storage-browser: all checks passed");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

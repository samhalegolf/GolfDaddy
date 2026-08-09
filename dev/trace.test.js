/* Trace's own behaviour: does it actually tell you where a change came from?

   The claim in PLAY_OWNER_CONCEPT.md §11 is specific — a write inside a paint
   window is an Order, a write outside one is a Leak named with the file and line
   that did it. This drives both against a real DOM in a real browser, because
   the whole mechanism is per-instance property shadowing and none of it exists
   in node.

   Run: node dev/trace.test.js */
const http = require("http");
const fs = require("fs");
const path = require("path");
const playwright = require("playwright");

const ROOT = path.join(__dirname, "..");

async function launchBrowser() {
  if (process.env.GD_BOOT_CHROMIUM) {
    return playwright.chromium.launch({ executablePath: process.env.GD_BOOT_CHROMIUM });
  }
  try { return await playwright.chromium.launch(); }
  catch (e) { return playwright.chromium.launch({ channel: "chrome" }); }
}

/* A page with just the watched elements Trace cares about, plus a "leaky
   module" in its own file so the culprit line has a real filename to report. */
const PAGE = `<!doctype html><html><body>
<div id="gpsDot"></div><div id="aimBubble" class="hiddenState"></div><svg id="bubbleSvg"></svg>
<div id="distanceBar"></div><button id="shotActionBtn"></button>
<div id="startPill"></div><div id="map"></div>
<link rel="stylesheet" href="/app/styles.css">
<script src="/app/js/trace.js"></script>
<script src="/leaky-module.js"></script>
</body></html>`;

const LEAKY = `
/* Stands in for any module reaching past the Marshal. */
function leakyToggle() { document.body.classList.add("shot-active"); }
function leakyMove() { document.getElementById("gpsDot").style.left = "123px"; }
`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/page.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(PAGE); }
  if (p === "/leaky-module.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(LEAKY); }
  fs.readFile(path.join(ROOT, decodeURIComponent(p)), (err, body) => {
    if (err) { res.writeHead(404); return res.end(); }
    /* The panel's collapsed state is CSS, so the stylesheet has to arrive with
       a stylesheet mime type or the browser refuses it and the test measures
       an unstyled div. */
    res.writeHead(200, {
      "Content-Type": p.endsWith(".css") ? "text/css" : "text/javascript"
    });
    res.end(body);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/page.html?trace=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.ClarityApp && window.ClarityApp.trace);

  check("Trace turns itself on from ?trace=1",
    await page.evaluate(() => ClarityApp.trace.enabled()));

  // ---- an Order: a write inside a paint window ----
  const order = await page.evaluate(() => {
    ClarityApp.trace.paint("LOCK", "aim", () => {
      document.getElementById("aimBubble").classList.remove("hiddenState");
      document.getElementById("gpsDot").style.left = "40px";
    });
    return ClarityApp.trace.rows().slice(0, 2);
  });
  check("a write inside a paint window is an Order carrying its Signal",
    order.length === 2 && order.every((r) => r.kind === "order" && r.signal === "LOCK"),
    order.map((r) => `${r.kind}:${r.target}.${r.field}`).join(", "));

  // ---- a Leak: the same writes from outside ----
  const leak = await page.evaluate(() => {
    leakyToggle();
    return ClarityApp.trace.rows()[0];
  });
  check("a write outside a paint window is a Leak",
    leak.kind === "leak" && leak.target === "body", `${leak.kind}:${leak.target}.${leak.field}`);
  check("and the Leak names the file and line that did it",
    /leaky-module\.js:\d+/.test(leak.from), leak.from);

  const leak2 = await page.evaluate(() => { leakyMove(); return ClarityApp.trace.rows()[0]; });
  check("a style write leaks too, and is attributed",
    leak2.kind === "leak" && leak2.field === "style.left" && /leaky-module\.js:\d+/.test(leak2.from),
    `${leak2.field} ← ${leak2.from}`);

  check("the leak counter tracks them",
    (await page.evaluate(() => ClarityApp.trace.leaks())) === 2);

  // ---- a no-op write is not a change ----
  const noop = await page.evaluate(() => {
    const before = ClarityApp.trace.rows().length;
    ClarityApp.trace.paint("FIX_RECEIVED", "track", () => {
      document.getElementById("gpsDot").style.left = "123px";   // already 123px
      document.body.classList.add("shot-active");               // already on
    });
    return ClarityApp.trace.rows().length - before;
  });
  check("re-asserting the current value records nothing", noop === 0, `${noop} rows`);

  // ---- signals ----
  const signalRows = await page.evaluate(() => {
    ClarityApp.trace.signal("BACK", null, { known: true, changed: false, before: { flow: "live", mode: "track" }, after: { flow: "live", mode: "track" } });
    ClarityApp.trace.signal("VIEW_HOLE_CHANGED", { hole: 5 }, { known: true, changed: true, before: { flow: "live", mode: "track" }, after: { flow: "preview", mode: "setup" } });
    ClarityApp.trace.signal("NONSENSE", null, { known: false, changed: false });
    return ClarityApp.trace.rows().slice(0, 3);
  });
  check("an unknown signal is reported as unknown",
    signalRows[0].kind === "inert" && signalRows[0].note === "unknown signal");
  check("a flow change gets its own row saying what caused it",
    signalRows[1].kind === "flow" && signalRows[1].from === "live"
      && signalRows[1].to === "preview" && signalRows[1].signal === "VIEW_HOLE_CHANGED",
    `${signalRows[1].from}→${signalRows[1].to} ← ${signalRows[1].signal}`);
  check("an accepted-but-inert signal is shown rather than swallowed",
    signalRows[2].kind === "inert" && signalRows[2].signal === "BACK");

  // ---- replay export ----
  const log = await page.evaluate(() => JSON.parse(ClarityApp.trace.exportLog()));
  check("the export carries the signal list, in order, for replay",
    Array.isArray(log.signals) && log.signals.length === 3
      && log.signals[0].name === "BACK" && log.signals[2].name === "NONSENSE",
    log.signals.map((s) => s.name).join(" → "));
  check("and the leaks, so a report explains itself",
    Array.isArray(log.leaks) && log.leaks.length === 2);

  // ---- the window ----
  /* Collapsed by default so the panel does not sit on top of the play
     controls; the leak count still shows in the header. */
  check("collapsed, it shows the leak count and no rows",
    await page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(r));
      const list = document.getElementById("traceList");
      return getComputedStyle(list).display === "none"
        && /leak/.test(document.getElementById("traceCount").textContent);
    }));

  check("tapping the header opens the log",
    await page.evaluate(async () => {
      document.getElementById("traceHead").click();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      const list = document.getElementById("traceList");
      return getComputedStyle(list).display !== "none" && list.children.length > 0;
    }));

  check("no uncaught exceptions", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

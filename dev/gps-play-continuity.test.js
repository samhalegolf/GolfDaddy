/* GPS Play continuity, end to end.

   marshal.test.js proves the transition table in node. This proves the whole
   thing assembled: Marshal → Scene → Painter → screen, in a real browser, with
   Leaflet, the bubble engine and the real DOM.

   It walks a scripted round through every flow in PLAY_OWNER_CONCEPT.md and
   finishes on the check that keeps the architecture honest: **Trace reports
   zero leaks**. If any module writes to a watched element without going through
   the Painter, that check fails and names the file.

   Run: node dev/gps-play-continuity.test.js
   GD_BOOT_CHROMIUM=/path/to/chromium overrides the browser. */
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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

const TEE = { lat: -36.9174, lng: 174.7400 };
function offsetM(base, northM, eastM) {
  return { lat: base.lat + northM / 111320,
    lng: base.lng + eastM / (111320 * Math.cos(base.lat * Math.PI / 180)) };
}
const GREEN = offsetM(TEE, -300, 0);

const PKG = {
  status: "lite-geo-ready", geometryVersion: "v1", packageVersion: 1,
  holes: [
    { holeNumber: 1, tee: TEE, green: GREEN, greenShape: [], route: [] },
    { holeNumber: 2, tee: offsetM(TEE, -340, 60), green: offsetM(TEE, -640, 60), greenShape: [], route: [] },
    { holeNumber: 3, tee: offsetM(TEE, -700, 0), green: offsetM(TEE, -900, 0), greenShape: [], route: [] }
  ]
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p.startsWith("/api/course-package")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(PKG));
  }
  if (p.startsWith("/api/client-errors")) { res.writeHead(200); return res.end("{}"); }
  if (p.startsWith("/api/")) { res.writeHead(404); return res.end("{}"); }
  fs.readFile(path.join(ROOT, decodeURIComponent(p)), (err, body) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await launchBrowser();
  const context = await browser.newContext({
    geolocation: { latitude: TEE.lat, longitude: TEE.lng },
    permissions: ["geolocation"]
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));

  /* NO courseLat/courseLng: the hand-off case that used to hand the round a
     centre at (0,0) and reject every fix for the whole round. */
  await page.goto(`http://127.0.0.1:${port}/app/index.html?trace=1&courseId=verify&courseName=Verify`,
    { waitUntil: "load" });
  await page.waitForFunction(() => window.ClarityApp && window.ClarityApp.booted, { timeout: 15000 });
  await page.waitForFunction(() => window.ClarityApp.marshal, { timeout: 15000 });
  await wait(600);

  const look = (fn, arg) => page.evaluate(fn, arg);
  const scene = () => page.evaluate(() => window.ClarityApp.marshal.scene());
  const setFix = async (pt) => {
    await context.setGeolocation({ latitude: pt.lat, longitude: pt.lng });
    await wait(420);
  };
  const visible = (id) => page.evaluate(
    (x) => { const e = document.getElementById(x); return !!e && !e.classList.contains("hiddenState"); }, id);

  console.log("\n— opening in Preview —");

  let s = await scene();
  check("a round opens in Preview", s.flow === "preview" && s.mode === "setup", `${s.flow}/${s.mode}`);
  check("the banner says so", (await look(() => document.getElementById("playBannerLabel").textContent))
    === "PREVIEW · Hole 1");
  check("the start pill is up and there is no bubble",
    (await visible("startPill")) && !(await visible("aimBubble")));

  check("Play is offered, because a trusted fix says we are at the course",
    await visible("playButton"), "with no courseLat/courseLng on the URL — the derived centre");

  console.log("\n— Preview: placing yourself IS the plan —");

  await page.click("#headToTeeBtn");
  await wait(300);
  s = await scene();
  check("Head To the Tee places you and the bubble is there with nothing pressed",
    s.mode === "aim" && s.bubble.show, `${s.mode}, bubble=${s.bubble.show}`);
  check("the pill has gone", !(await visible("startPill")));
  check("no Lock exists in Preview",
    (await look(() => ClarityApp.marshal.signal("LOCK"))) === false);
  check("and nothing was recorded",
    (await look(() => ClarityApp.marshal.shots(1).length)) === 0);

  /* Click the real control, not the signal: Head To the Tee was a one-way door
     because the dock was gated on Live, so Preview aiming had no button at all
     and there was no way back to the pill. */
  check("Preview aiming shows a way back", await visible("shotActionBtn"),
    `face=${await look(() => document.getElementById("shotActionBtn").dataset.action)}`);
  check("and it does not offer Shot End, since Preview records nothing",
    !(await visible("shotEndBtn")));
  await page.click("#shotActionBtn");
  await wait(250);
  check("Unlock returns the pill — Preview rests at Setup",
    (await visible("startPill")) && !(await visible("aimBubble")));

  console.log("\n— going Live —");

  await setFix(offsetM(TEE, -6, 0));
  await page.click("#playButton");
  await wait(400);
  s = await scene();
  check("Play starts the hole you are standing on", s.flow === "live" && s.hole.number === 1);
  check("the banner switches to LIVE",
    (await look(() => document.getElementById("playBannerLabel").textContent)) === "LIVE · Hole 1");
  check("Play is gone once the round is up", !(await visible("playButton")));
  check("Track shows the distances and no bubble",
    (await visible("distanceBar")) && !(await visible("aimBubble")));

  await setFix(offsetM(TEE, -40, 0));
  await setFix(offsetM(TEE, -80, 0));
  check("fixes move the dot but never raise a bubble",
    !(await visible("aimBubble")) && (await scene()).mode === "track");

  console.log("\n— Lock, and the stale-bubble regression —");

  await page.click("#shotActionBtn");
  await wait(300);
  check("Lock raises the bubble", await visible("aimBubble"));
  check("Shot End and Log shot are laid out sensibly",
    (await visible("shotEndBtn")) && !(await visible("finishControl")),
    "while aiming, Shot End is the action");

  await page.click("#shotActionBtn");     // Unlock
  await wait(250);
  await setFix(offsetM(TEE, -140, 8));
  await setFix(offsetM(TEE, -170, 8));
  check("Unlock hides the bubble, and later fixes do not resurrect it",
    !(await visible("aimBubble")) && !(await visible("bubbleSvg")));
  check("the shot is still in flight for Course Data",
    await look(() => !!ClarityApp.marshal.openShot(1)));
  check("Log shot appears now there is something outstanding and we are at rest",
    await visible("finishControl"));

  console.log("\n— Aim releases itself —");

  await page.click("#shotActionBtn");     // Lock again (closes the first shot)
  await wait(250);
  check("locking again closed the previous shot",
    (await look(() => ClarityApp.marshal.shots(1).length)) === 2);
  await setFix(offsetM(TEE, -180, 8));    // near the lock point
  check("a fix near the lock point holds Aim", (await scene()).mode === "aim");
  await setFix(offsetM(TEE, -230, 8));
  await setFix(offsetM(TEE, -260, 8));
  check("two fixes clear of it release Aim back to Track",
    (await scene()).mode === "track", "you hit and walked");

  console.log("\n— arriving at the green —");

  await setFix(offsetM(GREEN, 12, 3));
  await wait(300);
  s = await scene();
  check("Finish opens on arrival, because there is a shot to log", s.mode === "finish");
  check("the ball and the shot's origin are both drawn",
    (await visible("greenFocusBall")) && (await visible("finishOrigin")));

  /* Confirm by CLICKING the dock, not by firing the signal. Green focus had a
     ball and no way to confirm it — the dock was hidden in finish mode and the
     #finishDone button the painter listened for did not exist in the shell.
     Driving signals in the test is exactly what hid that. */
  check("green focus offers Shot End on the dock",
    (await visible("shotActionBtn"))
      && (await look(() => document.getElementById("shotActionBtn").dataset.action)) === "shotEnd");
  await page.evaluate(() => ClarityApp.marshal.signal("BALL_MOVED", { point: { lat: -36.92, lng: 174.74 } }));
  await page.click("#shotActionBtn");
  await wait(300);
  check("logging lands on the Logged screen", await visible("loggedScreen"));
  check("which offers the next hole and waits",
    (await look(() => document.getElementById("loggedNext").textContent)) === "Hole 2"
      && (await scene()).hole.number === 1, "you still have to putt");

  await page.click("#loggedScoreUp");
  await wait(200);
  check("the score stepper writes through to the scorecard",
    (await look(() => ClarityApp.marshal.state().scores["1"])) > 0,
    `score=${await look(() => ClarityApp.marshal.state().scores["1"])}`);

  await page.click("#loggedNext");
  await wait(400);
  s = await scene();
  check("pressing the hole number advances the round",
    s.hole.number === 2 && s.flow === "live" && s.mode === "track");

  console.log("\n— catching up on a hole later —");

  await page.click("#shotActionBtn");        // Lock
  await wait(200);
  await page.click("#nextHole");             // the real arrow
  await wait(350);
  check("hole 2 is flagged in the picker, left with an open shot",
    (await scene()).picker.flagged.join(",") === "2");
  check("and the tile carries the dot",
    await look(() => {
      const t = document.querySelector('#holePickerGrid [data-hole="2"]');
      return !!t && t.classList.contains("pending");
    }));

  /* Navigate by the real picker tile, which is also the control that carries
     the pending flag. */
  await page.click("#holeNumber");
  await wait(150);
  await page.click('#holePickerGrid [data-hole="2"]');
  await wait(350);
  s = await scene();
  check("looking back at it is Preview, and it says so",
    s.flow === "preview"
      && (await look(() => document.getElementById("playBannerLabel").textContent)) === "PREVIEW · Hole 2");
  check("the way back to the live hole is right there",
    (await visible("playBannerReturn"))
      && (await look(() => document.getElementById("playBannerReturn").textContent)) === "Return to 3");
  check("Log shot is offered on it, because the shot is still open",
    await visible("finishControl"));

  console.log("\n— the camera never chases —");

  const edged = await look(() => ({
    dot: !document.getElementById("gpsDot").classList.contains("hiddenState"),
    clamped: document.getElementById("gpsDot").classList.contains("edged"),
    label: document.getElementById("edgeDistance").textContent,
    labelShown: !document.getElementById("edgeDistance").classList.contains("hiddenState")
  }));
  check("a player who is not on the previewed hole is clamped to the edge with a distance",
    edged.dot && edged.clamped && edged.labelShown && /\d/.test(edged.label),
    `${edged.label}`);

  console.log("\n— losing GPS —");

  await page.click("#playBannerReturn");     // the banner's way back
  await wait(300);
  check("the banner's Return button goes back to the live hole",
    (await scene()).flow === "live");
  await page.evaluate(() => ClarityApp.marshal.signal("FIX_LOST"));
  await wait(300);
  s = await scene();
  check("losing GPS does not end the round", s.flow === "live" && s.hole.number === 3);
  check("the dot goes quiet rather than vanishing",
    await look(() => document.getElementById("gpsDot").classList.contains("stale")));

  console.log("\n— dragging the bubble does not move the camera —");

  /* The regression: painter.js used to key the stage camera on the aim target,
     so every pointermove of a drag re-solved the whole frame. And because the
     bubble engine reads the on-screen scale back through the same projection
     seam to clamp its cluster, the camera moved the projection, which moved the
     model, which moved the camera. On a phone that reads as the map going
     berserk under your finger. A locked shot view has to be stationary. */
  /* Get back onto the LIVE hole — Lock does not exist in Preview, so a drag
     test has to run where a shot can actually be opened. */
  const liveHole = await look(() => ClarityApp.marshal.round().liveHole);
  await setFix(offsetM(TEE, -700 + 6, 0));      // hole 3's tee
  await page.click("#shotActionBtn");           // Lock, by the button
  await wait(300);
  check("locked in on the live hole, ready to drag",
    (await scene()).mode === "aim" && (await visible("aimBubble")), `hole ${liveHole}`);
  const before = await look(() => ClarityApp.painter.cameraSolves());

  /* Drive the real pointer handlers rather than the mouse: the cluster can
     render off-screen depending on bag and hole, and this regression is about
     what the handler does with the events, not where the art happens to be.
     Coordinates sit mid-viewport, well inside the edge-pan band. */
  const aimBefore = await look((h) => JSON.stringify(ClarityApp.marshal.openShot(h).target), liveHole);
  await page.evaluate(() => {
    const el = document.getElementById("aimBubble");
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1
    }));
    ev("pointerdown", cx, cy);
    for (let i = 1; i <= 12; i++) ev("pointermove", cx + i * 4, cy + i * 3);
    ev("pointerup", cx + 48, cy + 36);
  });
  await wait(250);
  const after = await look(() => ClarityApp.painter.cameraSolves());
  check("12 drag moves re-solve the camera zero times", after - before === 0,
    `${after - before} solves`);
  const aimAfter = await look((h) => JSON.stringify(ClarityApp.marshal.openShot(h).target), liveHole);
  check("but the aim actually moved", aimBefore !== aimAfter && !!aimAfter,
    `${aimBefore} → ${aimAfter}`);

  console.log("\n— no free-hand zoom, and say what is on screen —");

  check("every Leaflet gesture handler is off",
    await look(() => {
      const m = ClarityApp.painter.mapState();
      return !!m && ClarityApp.painter.gesturesEnabled() === false;
    }), "the camera owns the view; a pinch has no way back");

  check("the page itself cannot be zoomed",
    await look(() => {
      const v = document.querySelector('meta[name=viewport]').content;
      return /user-scalable=no/.test(v) && /maximum-scale=1/.test(v);
    }));

  check("the source tag says what is on screen",
    await look(() => {
      const chip = document.getElementById("surfaceSource");
      return !!chip && !chip.classList.contains("hiddenState")
        && /LIVE MAP · /.test(chip.textContent);
    }), await look(() => document.getElementById("surfaceSource").textContent));

  check("and it names the basemap rather than guessing",
    await look(() => document.getElementById("surfaceSource").dataset.source) === "live");

  console.log("\n— the guards the old play.js earned —");

  /* Each of these existed in play.js with a comment explaining what broke
     without it, and each was dropped in the rewrite. */

  check("the dock's face is current even while it is hidden",
    await look(() => {
      /* Logged hides the dock. If the face is only refreshed while shown, it
         comes back wearing the previous coin until the new PNG decodes. */
      const before = document.getElementById("shotActionBtn").dataset.action;
      return before === ClarityApp.marshal.scene().dock.face;
    }), "no stale coin on the way back");

  check("leaving the round tears the presentation down",
    await look(() => {
      ClarityApp.painter.detach();
      return !document.body.classList.contains("surface-published")
        && !document.body.classList.contains("map-framed")
        && document.body.dataset.frameStage === undefined;
    }), "so the next course cannot open on this one's surface");

  check("and a second round re-presents from scratch",
    await look(() => {
      ClarityApp.marshal.signal("ROUND_OPENED", {
        courseKey: "second", pkg: { status: "lite-geo-ready", holes: [
          { holeNumber: 1, tee: { lat: -36.8, lng: 174.7 }, green: { lat: -36.803, lng: 174.7 }, greenShape: [], route: [] }
        ] }, hole: 1
      });
      return ClarityApp.marshal.round().courseKey === "second"
        && ClarityApp.marshal.scene().hole.number === 1;
    }));

  console.log("\n— the architecture holds —");

  const leaks = await look(() => ClarityApp.trace.rows()
    .filter((r) => r.kind === "leak").map((r) => `${r.target}.${r.field} ← ${r.from}`));
  check("Trace reports ZERO leaks across the whole round", leaks.length === 0,
    leaks.slice(0, 5).join(" | "));
  check("no uncaught exceptions", errors.length === 0, errors.slice(0, 3).join(" | "));

  const replay = await look(() => JSON.parse(ClarityApp.trace.exportLog()).signals.length);
  check("and the round is replayable from its signal log", replay > 20, `${replay} signals`);

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

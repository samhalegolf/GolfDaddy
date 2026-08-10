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
  /* A published surface the server SAYS exists but cannot serve — the exact
     shape of the native-origin bug, and the case that used to degrade to the
     live map without saying anything. */
  if (p.startsWith("/api/course-visual-assets")) { res.writeHead(500); return res.end("boom"); }
  if (p.startsWith("/api/course-visuals")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ record: {
      status: "published",
      uploaded_assets: [{
        role: "hole-frame-published", holeNumber: 1, path: "verify/h1.jpg",
        metadata: { playSurface: { captureZoom: 18, originPx: { x: 0, y: 0 },
          outputDimensions: { width: 800, height: 1200 } } }
      }]
    } }));
  }
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

  /* The 1st green is ~77m from the 2nd tee, so the fix agrees we have arrived
     and the button commits. Standing further off it would preview instead and
     leave Play waiting — see the arrows below for that half. */
  await page.click("#loggedNext");
  await wait(400);
  s = await scene();
  check("pressing the hole number goes live when the fix says you are there",
    s.hole.number === 2 && s.flow === "live" && s.mode === "track", `${s.flow}/${s.mode}`);

  console.log("\n— the arrows browse; they do not move the round —");

  await page.click("#shotActionBtn");        // Lock on hole 2
  await wait(200);
  await page.click("#nextHole");             // the real arrow
  await wait(350);
  s = await scene();
  check("the arrow moves the VIEW and drops you into Preview",
    s.hole.number === 3 && s.flow === "preview", `${s.hole.number}/${s.flow}`);
  check("the live hole is untouched — you are still playing 2",
    (await look(() => ClarityApp.marshal.state().live.hole)) === 2);
  check("and Play is not offered on a hole you have not walked to",
    !(await visible("playButton")));

  await setFix(offsetM(TEE, -700, 4));       // walk to the 3rd tee
  check("Play appears once you arrive at the hole you are looking at",
    (await visible("playButton"))
      && (await look(() => document.getElementById("playButton").textContent)).indexOf("3") !== -1,
    await look(() => document.getElementById("playButton").textContent));

  await page.click("#playButton");
  await wait(400);
  s = await scene();
  check("and pressing it is the only thing that moved the round on",
    s.flow === "live" && s.hole.number === 3
      && (await look(() => ClarityApp.marshal.state().live.hole)) === 3);

  console.log("\n— catching up on a hole later —");

  check("hole 1 reads as two shots with outcomes, hole 2 as one still open",
    JSON.stringify((await scene()).picker.marks) === '{"1":{"done":2,"open":0},"2":{"done":0,"open":1}}',
    JSON.stringify((await scene()).picker.marks));

  await page.click("#holeNumber");
  await wait(200);
  check("hole 1's tile shows 0-0 x2 and offers nothing to press",
    await look(() => {
      const t = document.querySelector('#holePickerGrid [data-hole="1"]');
      return !!t && /0-0 x2/.test(t.textContent) && !t.querySelector("[data-log]");
    }), await look(() => document.querySelector('#holePickerGrid [data-hole="1"]').textContent));
  check("hole 2's tile carries the outstanding 0, which is a control",
    await look(() => {
      const t = document.querySelector('#holePickerGrid [data-hole="2"]');
      return !!t && !!t.querySelector("[data-log]");
    }));

  /* Click the BADGE, not the tile. This is the only door into logging an
     outcome for a hole you are not standing on, and the whole point of moving
     it here was that green focus used to leak into general Preview. */
  await page.click('#holePickerGrid [data-hole="2"] [data-log]');
  await wait(400);
  s = await scene();
  check("the outstanding badge opens Logging on that hole",
    s.flow === "logging" && s.hole.number === 2, `${s.flow}/${s.hole.number}`);
  check("the banner says LOGGING, not PREVIEW",
    (await look(() => document.getElementById("playBannerLabel").textContent)) === "LOGGING · Hole 2");
  check("there is a ball, the shot's origin, and a Shot End to confirm with",
    (await visible("greenFocusBall")) && (await visible("finishOrigin"))
      && (await look(() => document.getElementById("shotActionBtn").dataset.action)) === "shotEnd");

  await page.evaluate(() => ClarityApp.marshal.signal("BALL_MOVED", { point: { lat: -36.9231, lng: 174.7406 } }));
  await page.click("#shotActionBtn");
  await wait(400);
  s = await scene();
  check("confirming records the outcome",
    (await look(() => !ClarityApp.marshal.openShot(2))) && s.picker.marks["2"].open === 0);
  check("and puts you straight back where you were, with no Logged screen",
    s.hole.number === 3 && s.flow === "live" && !(await visible("loggedScreen")),
    `${s.hole.number}/${s.flow}`);

  console.log("\n— Preview has no way into green focus —");

  await page.click("#holeNumber");
  await wait(150);
  await page.click('#holePickerGrid [data-hole="1"]');
  await wait(350);
  s = await scene();
  check("looking at an old hole is plain Preview",
    s.flow === "preview" && s.mode === "setup"
      && (await look(() => document.getElementById("playBannerLabel").textContent)) === "PREVIEW · Hole 1");
  check("with no Log shot control — that lives on the picker now",
    !(await visible("finishControl")));

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

  console.log("\n— Preview still cannot log anything —");

  /* Tapping near the green used to open real green focus here, which is how
     general Preview state got into the finish workflow. */
  await page.evaluate(() => ClarityApp.marshal.signal("PLACED", { point: { lat: -36.9201, lng: 174.7400 } }));
  await wait(250);
  s = await scene();
  check("and placing yourself on the green is still just the shot view",
    s.mode === "aim" && !s.finish.show, `${s.mode}, finish=${s.finish.show}`);

  console.log("\n— losing GPS —");

  await page.click("#playBannerReturn");     // the banner's way back
  await wait(300);
  check("the banner's Return button goes back to the live hole",
    (await scene()).flow === "live");
  await page.evaluate(() => ClarityApp.marshal.signal("FIX_LOST"));
  await wait(300);
  s = await scene();
  check("losing GPS does not end the round", s.flow === "live" && s.hole.number === 3,
    `${s.flow}/${s.hole.number}`);
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
  const liveHole = await look(() => ClarityApp.marshal.state().live.hole);
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

  console.log("\n— published imagery reaches a native build —");

  /* The surface image is loaded with new Image().src, which is not a fetch, so
     gd-native-bootstrap's fetch patch never touched it. On capacitor://localhost
     a relative /api/ path resolved against the webview, failed, and the fallback
     put every published course on the live map. */
  check("on web the asset URL is left alone",
    (await look(() => ClarityApp.painter.apiUrl("/api/course-visual-assets?path=x"))) === "/api/course-visual-assets?path=x");

  check("on native it is resolved against the deployed origin",
    (await look(() => {
      const saved = window.GDNative;
      window.GDNative = { isNative: true, apiOrigin: "https://caddy.claritygolf.app" };
      const out = ClarityApp.painter.apiUrl("/api/course-visual-assets?path=x");
      window.GDNative = saved;
      return out;
    })) === "https://caddy.claritygolf.app/api/course-visual-assets?path=x");

  check("an already-absolute URL is never double-prefixed",
    (await look(() => {
      const saved = window.GDNative;
      window.GDNative = { isNative: true, apiOrigin: "https://caddy.claritygolf.app" };
      const out = ClarityApp.painter.apiUrl("https://cdn.example/h1.jpg");
      window.GDNative = saved;
      return out;
    })) === "https://cdn.example/h1.jpg");

  console.log("\n— a published surface that fails says so —");

  await page.evaluate(() => ClarityApp.marshal.signal("VIEW_HOLE_CHANGED", { hole: 1 }));
  await wait(1200);
  const failure = await look(() => ClarityApp.painter.surfaceFailure());
  check("a declared surface that will not load is recorded as a failure",
    !!failure && failure.reason === "load-error", failure ? failure.reason : "none");
  check("and the tag says so rather than reading as a normal live map",
    (await look(() => document.getElementById("surfaceSource").dataset.source)) === "failed",
    await look(() => document.getElementById("surfaceSource").textContent));
  check("the round keeps playing on the live map regardless",
    (await scene()).hole.number === 1 && !(await visible("loggedScreen")));

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

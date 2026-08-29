/* The blank-screen bug.
 *
 * gd-auth-reset-route-bootstrap adds html.gdAuthRouteBoot pre-paint, guessing
 * from localStorage that the user is signed out. gd-app-base.css uses that class
 * to hide #shellHome, #courseScreen, #shellTop, #shellDock and every panel with
 * display:none!important.
 *
 * Four places are meant to remove it after sign-in. When none of them do, the app
 * renders as a black screen while the router happily reports route "home" with no
 * hidden class set - which is exactly what the on-device probe captured:
 *
 *   route=home  acctNull=false  shellHome[shown/none/hidden/1]
 *
 * The gate is the authoritative signed-in check, so it must clear the stale
 * pre-paint guess. These run the real page. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2"
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function launchBrowser(playwright) {
  const explicit = process.env.GD_BOOT_CHROMIUM;
  if (explicit) return playwright.chromium.launch({ executablePath: explicit, headless: true });
  try {
    return await playwright.chromium.launch({ headless: true });
  } catch (_e) {
    return playwright.chromium.launch({ channel: "chrome", headless: true });
  }
}

(async () => {
  let playwright;
  try {
    playwright = require("playwright-core");
  } catch (_e) {
    console.error("auth-route-boot-release: playwright-core is not installed. Run: npm install");
    process.exit(2);
  }

  /* Static assertions first - cheap, and they pin the contract. */
  const gate = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-auth-gate-v1.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "styles", "inline", "gd-app-base.css"), "utf8");
  let failed = 0;
  function check(name, fn) {
    try { fn(); console.log("  ok  " + name); }
    catch (err) { failed += 1; console.error("  FAIL " + name); console.error("       " + (err && err.message || err)); }
  }

  check("the boot class still hides the shell with !important", () => {
    assert.ok(
      /html\.gdAuthRouteBoot #shellHome/.test(css) && /display:none!important/.test(css),
      "if this rule changes, the reasoning behind the release below needs revisiting"
    );
  });

  /* applyGate is what the gate exports as window.gdApplyAuthGate, and clearing
     the stale pre-paint class is now its whole job - releaseGate was folded into
     it when the gate stopped being a wall (see gd-auth-gate-v1.js). The contract
     under test is unchanged: something authoritative must clear gdAuthRouteBoot. */
  check("applyGate clears the stale pre-paint boot class", () => {
    const idx = gate.indexOf("function applyGate(");
    assert.notStrictEqual(idx, -1, "applyGate must exist");
    const fn = gate.slice(idx, idx + 1200);
    assert.ok(
      /documentElement\.classList\.remove\('gdAuthRouteBoot'\)/.test(fn),
      "applyGate must clear gdAuthRouteBoot, or a missed removal leaves a blank screen"
    );
  });

  check("applyGate is what the gate exports", () => {
    assert.ok(
      /window\.gdApplyAuthGate\s*=\s*applyGate/.test(gate),
      "the browser half of this test calls window.gdApplyAuthGate"
    );
  });

  check("the password-reset boot class is left alone", () => {
    const idx = gate.indexOf("function applyGate(");
    const fn = gate.slice(idx, idx + 1200);
    assert.ok(
      !/remove\([^)]*gdResetRouteBoot/.test(fn),
      "gdResetRouteBoot belongs to the reset flow and has no CSS - releasing it here would be scope creep"
    );
  });

  /* The rejection guard. Build 740 was rejected under guideline 5.1.1(v) for
     requiring an account to reach features that are not account based, and the
     two lines below are where that wall used to be re-armed. If either comes
     back, the app ships a login wall again. */
  check("no route is gated on merely having an account", () => {
    const bootstrap = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-auth-reset-route-bootstrap.js"), "utf8");
    assert.ok(
      !/signedOut/.test(bootstrap),
      "gd-auth-reset-route-bootstrap must not hide the shell for a signed-out visitor"
    );
    const audit = fs.readFileSync(path.join(ROOT, "scripts", "gd-route-audit.js"), "utf8");
    assert.ok(
      !/gdBrowserHasAccount/.test(audit),
      "browser back must not route a signed-out player into the auth screen"
    );
  });

  /* The rangefinder is the feature Apple said must stay reachable. These pin
     the two halves of that: the signals that measure distance are never gated,
     and a failed membership check downgrades entry rather than refusing it. */
  check("the rangefinder signals are never gated", () => {
    const access = fs.readFileSync(path.join(ROOT, "app", "js", "access.js"), "utf8");
    const gated = access.slice(access.indexOf("var GATED_SIGNALS"), access.indexOf("function rangefinderParam"));
    ["FIX_RECEIVED", "PLACED", "BALL_MOVED", "LOCK", "UNLOCK", "NEXT_HOLE", "PREV_HOLE"].forEach((sig) => {
      assert.ok(!gated.includes(sig), sig + " is how the rangefinder works and must not need an account");
    });
    assert.ok(gated.includes("SCORE_SET"), "keeping score is account-based and must stay gated");
  });

  /* The bubble is the shop window: free, ghost-bag driven, and what a player
     pays to personalise. Gating the draw would hide the thing being sold. */
  check("the bubble is not gated on the play surface", () => {
    const painter = fs.readFileSync(path.join(ROOT, "app", "js", "painter.js"), "utf8");
    const idx = painter.indexOf("function drawShot(");
    const head = painter.slice(idx, idx + 600);
    assert.ok(
      !/app\.access/.test(head),
      "drawShot must not check access - the bubble is free, the bag behind it is not"
    );
    const bag = fs.readFileSync(path.join(ROOT, "app", "js", "bag.js"), "utf8");
    assert.ok(/function canEdit\(\)/.test(bag), "bag.js must gate editing");
    assert.ok(
      !/clarity:bag:v1/.test(bag.slice(bag.indexOf("(function ()"))),
      "the second bag store is retired; bag.js reads the profile bag"
    );
  });

  check("a failed membership check downgrades rather than refuses", () => {
    const picker = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
    const fn = picker.slice(picker.indexOf("function enterGpsPlay("), picker.indexOf("function navigateToAppPlay("));
    assert.ok(
      !/active paid access is required/.test(fn),
      "refusing entry outright is the shape that was rejected under 5.1.1(v)"
    );
    assert.strictEqual(
      (fn.match(/rangefinder:\s*true/g) || []).length, 2,
      "both the denied branch and the check-failed branch must fall through to rangefinder mode"
    );
  });

  const server = await startServer();
  const browser = await launchBrowser(playwright);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    /* Reproduce the broken state: the pre-paint guess says signed out, but a real
       account exists by the time the gate runs. */
    await page.addInitScript(() => {
      document.documentElement.classList.add("gdAuthRouteBoot");
    });

    /* ?login=1 declines the web landing redirect. scripts/inline/gd-landing-redirect-v1.js
       runs at the top of index.html and replaces it with welcome.html for a SIGNED-OUT
       visitor, decided synchronously from localStorage - and a fresh browser profile is
       always signed out, so without this the page under test is the landing page, not the
       app. ?login=1 is the redirect's own documented escape hatch (one of its SKIP_PARAMS). */
    await page.goto(`${base}/index.html?login=1`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1800);

    const state = await page.evaluate(() => {
      /* Install the signed-in account AFTER boot: the app assigns
         window.GolfDaddyAccounts during startup, so a stub defined beforehand is
         replaced. This is the state that matters anyway - the pre-paint guess was
         made while signed out, and an account exists by the time the gate runs. */
      window.GolfDaddyAccounts = {
        current: function () { return { accountId: "acct_test", email: "t@e.com", name: "T" }; }
      };
      /* The boot class may have been re-added during startup; assert the gate
         clears whatever is there now. */
      document.documentElement.classList.add("gdAuthRouteBoot");
      if (window.gdApplyAuthGate) window.gdApplyAuthGate();
      const home = document.getElementById("shellHome");
      const bootClass = document.documentElement.classList.contains("gdAuthRouteBoot");
      /* Isolate the boot rule from the route. The route legitimately hides home
         via the `hidden` class here, since this stub never navigates. Dropping
         that class leaves only the boot rule: if it still applied, its
         display:none!important would keep the element hidden regardless. */
      return {
        bootClass: bootClass,
        /* Test the offending selector directly. Computed style is not usable
           here: other legitimate rules also hide home in this state - notably
           body.gdProfileOpen:not(.gdAuthLocked) #shellHome, since the profile
           panel is open during a signed-out boot. This asks the precise
           question: does the boot rule still match the element? */
        bootRuleMatches: !!document.querySelector("html.gdAuthRouteBoot #shellHome"),
        homeExists: !!home
      };
    });

    check("the boot class is gone once an account exists", () => {
      assert.strictEqual(
        state.bootClass, false,
        "the pre-paint guess must not outlive the authoritative gate check"
      );
    });

    check("the boot rule no longer matches the shell", () => {
      assert.strictEqual(state.homeExists, true, "shellHome must exist for this to mean anything");
      assert.strictEqual(
        state.bootRuleMatches, false,
        "html.gdAuthRouteBoot #shellHome still matches, so display:none!important "
        + "would keep the whole shell blank regardless of the route"
      );
    });

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  if (failed) {
    console.error("auth-route-boot-release failed: " + failed + " check(s)");
    process.exit(1);
  }
  console.log("auth-route-boot-release passed");
})().catch((err) => {
  console.error("auth-route-boot-release failed:", err && err.stack || err);
  process.exit(1);
});

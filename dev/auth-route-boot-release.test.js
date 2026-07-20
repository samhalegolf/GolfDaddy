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

  check("releaseGate clears the stale pre-paint boot class", () => {
    const idx = gate.indexOf("function releaseGate(");
    assert.notStrictEqual(idx, -1, "releaseGate must exist");
    const fn = gate.slice(idx, idx + 1200);
    assert.ok(
      /documentElement\.classList\.remove\('gdAuthRouteBoot'\)/.test(fn),
      "releaseGate must clear gdAuthRouteBoot, or a missed removal leaves a blank screen"
    );
  });

  check("the password-reset boot class is left alone", () => {
    const idx = gate.indexOf("function releaseGate(");
    const fn = gate.slice(idx, idx + 1200);
    assert.ok(
      !/remove\([^)]*gdResetRouteBoot/.test(fn),
      "gdResetRouteBoot belongs to the reset flow and has no CSS - releasing it here would be scope creep"
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

    await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
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

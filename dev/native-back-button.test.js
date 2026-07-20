/* Android hardware back button behaviour.
 *
 * The failure that matters is exiting the app from a screen that should have gone
 * back one level - in a GPS app that means losing an in-progress round. These
 * cases are unreachable by hand without signing in, so they are driven directly
 * against the real module with the shell and Capacitor bridge stubbed. */
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

function androidStub() {
  window.__nb = { exits: 0, backCalls: [], listeners: [] };
  window.Capacitor = {
    getPlatform: function () { return "android"; },
    isNativePlatform: function () { return true; },
    Plugins: {
      App: {
        addListener: function (name, cb) { window.__nb.listeners.push(name); return { remove: function () {} }; },
        exitApp: function () { window.__nb.exits += 1; }
      }
    }
  };
}

(async () => {
  let playwright;
  try {
    playwright = require("playwright-core");
  } catch (_e) {
    console.error("native-back-button: playwright-core is not installed. Run: npm install");
    process.exit(2);
  }

  const server = await startServer();
  const browser = await launchBrowser(playwright);
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;

  function check(name, fn) {
    try { fn(); console.log("  ok  " + name); }
    catch (err) { failed += 1; console.error("  FAIL " + name); console.error("       " + (err && err.message || err)); }
  }

  /* Replace GDShell with a stub reporting a given route, then fire back. */
  async function backFrom(page, route, options) {
    return page.evaluate(({ route, options }) => {
      window.__nb.exits = 0;
      window.__nb.backCalls = [];
      window.GDShell = {
        getState: function () { return { route: route }; },
        back: function (opts) { window.__nb.backCalls.push(opts && opts.source || ""); return false; }
      };
      if (options && options.overlay) {
        const el = document.createElement("div");
        el.id = "clarityReferralLanding";
        document.body.appendChild(el);
      }
      if (options && options.strayPanel) {
        const el = document.createElement("div");
        el.className = "modulePanel open";
        el.id = "strayTestPanel";
        document.body.appendChild(el);
      }
      window.GDNativeBackButton.handleBack();
      return {
        exits: window.__nb.exits,
        backCalls: window.__nb.backCalls.slice(),
        overlayGone: !document.getElementById("clarityReferralLanding"),
        strayClosed: !document.querySelector("#strayTestPanel.open")
      };
    }, { route, options: options || {} });
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(androidStub);
    await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1800);

    const installed = await page.evaluate(() => ({
      installed: window.GDNativeBackButton && window.GDNativeBackButton.installed,
      listeners: window.__nb.listeners.slice()
    }));

    check("registers a backButton listener on android", () => {
      assert.strictEqual(installed.installed, true, "listener must be installed");
      assert.ok(installed.listeners.indexOf("backButton") !== -1, "must listen for backButton");
    });

    const atHome = await backFrom(page, "home");
    check("back at home exits the app", () => {
      assert.strictEqual(atHome.exits, 1, "root is where Android expects back to exit");
      assert.deepStrictEqual(atHome.backCalls, [], "the shell must not be asked to go back from root");
    });

    const atAuth = await backFrom(page, "auth");
    check("back at the auth gate exits rather than trapping the user", () => {
      assert.strictEqual(atAuth.exits, 1);
    });

    const atModule = await backFrom(page, "module");
    check("back in a module closes it instead of exiting", () => {
      assert.strictEqual(atModule.exits, 0, "exiting here would be the wrong response");
      assert.deepStrictEqual(atModule.backCalls, ["native-back-button"], "must delegate to GDShell.back");
    });

    const atPicker = await backFrom(page, "course-picker");
    check("back in the course picker delegates to the shell", () => {
      assert.strictEqual(atPicker.exits, 0);
      assert.deepStrictEqual(atPicker.backCalls, ["native-back-button"]);
    });

    const inGps = await backFrom(page, "gps");
    check("back during a round never exits the app", () => {
      assert.strictEqual(inGps.exits, 0, "exiting mid-round would lose the round");
      assert.deepStrictEqual(inGps.backCalls, ["native-back-button"]);
    });

    const withOverlay = await backFrom(page, "gps", { overlay: true });
    check("an overlay is dismissed before the shell route is considered", () => {
      assert.strictEqual(withOverlay.overlayGone, true, "the referral overlay must close first");
      assert.deepStrictEqual(withOverlay.backCalls, [], "and the shell must not also go back");
      assert.strictEqual(withOverlay.exits, 0);
    });

    const strayAtHome = await backFrom(page, "home", { strayPanel: true });
    check("a stray open panel at home is closed rather than exiting", () => {
      assert.strictEqual(strayAtHome.strayClosed, true, "the open panel must close");
      assert.strictEqual(strayAtHome.exits, 0, "closing something beats exiting");
    });

    /* A shell that throws must not strand the user with a dead back button. */
    const shellThrows = await page.evaluate(() => {
      window.__nb.exits = 0;
      window.GDShell = {
        getState: function () { return { route: "module" }; },
        back: function () { throw new Error("shell exploded"); }
      };
      window.GDNativeBackButton.handleBack();
      return { exits: window.__nb.exits };
    });
    check("a throwing shell falls back to exiting rather than doing nothing", () => {
      assert.strictEqual(shellThrows.exits, 1, "back must always do something");
    });

    await page.close();
    await context.close();

    /* Web must be untouched: no listener, no exit path. */
    const webContext = await browser.newContext();
    const webPage = await webContext.newPage();
    const webErrors = [];
    webPage.on("pageerror", (err) => webErrors.push(String(err && err.stack || err)));
    await webPage.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await webPage.waitForTimeout(1500);
    const web = await webPage.evaluate(() => ({
      exists: !!window.GDNativeBackButton,
      installed: window.GDNativeBackButton && window.GDNativeBackButton.installed
    }));
    check("web build installs no back handler", () => {
      assert.deepStrictEqual(webErrors, [], "must not throw on the website");
      assert.strictEqual(web.exists, true);
      assert.strictEqual(web.installed, false, "there is no hardware back button on the web");
    });

    await webPage.close();
    await webContext.close();
  } finally {
    await browser.close();
    server.close();
  }

  if (failed) {
    console.error("native-back-button failed: " + failed + " check(s)");
    process.exit(1);
  }
  console.log("native-back-button passed");
})().catch((err) => {
  console.error("native-back-button failed:", err && err.stack || err);
  process.exit(1);
});

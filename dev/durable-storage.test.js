/* Durable storage for keys that cannot be re-fetched.
 *
 * A WebView can evict localStorage under storage pressure. Everything here lives
 * there - session, accounts, profiles, and the round currently being played - so
 * eviction signs the user out and loses the round mid-play.
 *
 * Preferences is durable native storage but async, and 278 call sites read
 * localStorage synchronously, so it cannot be swapped in. This mirrors instead.
 *
 * These check the parts that would be dangerous to get wrong: that a write is
 * never delayed or broken by mirroring, that a restore actually recovers the
 * session, that the reload cannot loop, and that the web build is untouched. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const MODULE = path.join(ROOT, "scripts", "inline", "gd-durable-storage.js");
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
  try { return await playwright.chromium.launch({ headless: true }); }
  catch (_e) { return playwright.chromium.launch({ channel: "chrome", headless: true }); }
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  " + name); }
  catch (err) { failed += 1; console.error("  FAIL " + name); console.error("       " + (err && err.message || err)); }
}

/* A fake Preferences plugin whose store survives a page reload, the way native
   storage does. Kept on a global the init script re-reads. */
function nativeStub(seeded) {
  window.__prefs = Object.assign({}, seeded || {});
  window.__prefCalls = { set: 0, get: 0, remove: 0 };
  window.Capacitor = {
    getPlatform: function () { return "android"; },
    isNativePlatform: function () { return true; },
    Plugins: {
      Preferences: {
        set: async function (o) { window.__prefCalls.set += 1; window.__prefs[o.key] = String(o.value); return {}; },
        get: async function (o) { window.__prefCalls.get += 1; return { value: Object.prototype.hasOwnProperty.call(window.__prefs, o.key) ? window.__prefs[o.key] : null }; },
        remove: async function (o) { window.__prefCalls.remove += 1; delete window.__prefs[o.key]; return {}; }
      }
    }
  };
}

(async () => {
  let playwright;
  try { playwright = require("playwright-core"); }
  catch (_e) { console.error("durable-storage: playwright-core is not installed."); process.exit(2); }

  const server = await startServer();
  const browser = await launchBrowser(playwright);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    /* --- native: mirroring --- */
    const context = await browser.newContext();
    await context.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const page = await context.newPage();
    await page.addInitScript(nativeStub, {});
    await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1500);

    const mirrored = await page.evaluate(async () => {
      localStorage.setItem("clarity:supabase-auth-session:v1", "session-token-abc");
      localStorage.setItem("gd_gps_resume_round_v1", '{"hole":14}');
      localStorage.setItem("some_other_key", "should not be mirrored");
      await new Promise((r) => setTimeout(r, 200));
      return {
        session: window.__prefs["durable:clarity:supabase-auth-session:v1"],
        round: window.__prefs["durable:gd_gps_resume_round_v1"],
        other: window.__prefs["durable:some_other_key"],
        active: window.GDDurableStorage.state().active
      };
    });

    check("the mirror is active on native", () => {
      assert.strictEqual(mirrored.active, true);
    });

    check("critical keys are mirrored to durable storage", () => {
      assert.strictEqual(mirrored.session, "session-token-abc", "the session must be mirrored");
      assert.strictEqual(mirrored.round, '{"hole":14}', "the in-progress round must be mirrored");
    });

    check("uninteresting keys are not mirrored", () => {
      assert.strictEqual(
        mirrored.other, undefined,
        "mirroring everything would waste native storage protecting data that re-fetches"
      );
    });

    const writeStillWorks = await page.evaluate(() => {
      localStorage.setItem("gd_accounts_v1", "account-data");
      return localStorage.getItem("gd_accounts_v1");
    });

    check("mirroring does not disturb the write itself", () => {
      assert.strictEqual(
        writeStillWorks, "account-data",
        "localStorage stays the source of truth; a mirror failure must not lose a write"
      );
    });

    const removed = await page.evaluate(async () => {
      localStorage.removeItem("gd_accounts_v1");
      await new Promise((r) => setTimeout(r, 150));
      return window.__prefs["durable:gd_accounts_v1"];
    });

    check("a deliberate removal clears the mirror too", () => {
      assert.strictEqual(removed, undefined, "a signed-out session must not be resurrected on next boot");
    });

    /* localStorage is a WebIDL legacy platform object with a named-property
       setter, so `storage.setItem = fn` stores an ENTRY called "setItem" holding
       the function's source text. Chromium ALSO overrides the method, so the
       mirror appeared to work here while on iOS WebKit it did not override at
       all - only boot-time seed() ever mirrored, and the durable copy of the
       in-progress round sat hours stale. The install must therefore use
       Object.defineProperty, and must not write its installed-flag onto storage.

       Asserting on the stray entries rather than on override behaviour is what
       makes this catchable in a Chromium-only harness: the entries appear in
       both engines, the failed override only in WebKit. */
    const strays = await page.evaluate(() => {
      const names = ["setItem", "removeItem", "__gdDurableMirror"];
      const keys = Object.keys(localStorage);
      return {
        present: names.filter((n) => keys.includes(n) || localStorage.getItem(n) !== null),
        setItemIsFunction: typeof localStorage.setItem === "function",
        mirrorPatched: localStorage.setItem.__gdDurableMirror === true
      };
    });

    check("the mirror install writes no stray keys into the quota it protects", () => {
      assert.deepStrictEqual(
        strays.present, [],
        "assigning onto localStorage stores an entry instead of setting a property - " +
        "use Object.defineProperty and keep the installed flag off storage"
      );
    });

    check("the patched setter is installed on the storage object itself", () => {
      assert.strictEqual(strays.setItemIsFunction, true, "setItem must remain callable");
      assert.strictEqual(
        strays.mirrorPatched, true,
        "the flag belongs on the patched function; a flag on storage is a storage write"
      );
    });

    await page.close();
    await context.close();

    /* --- native: recovery from eviction --- */
    const evictedCtx = await browser.newContext();
    await evictedCtx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const evicted = await evictedCtx.newPage();
    /* Durable storage holds a session; localStorage is empty, exactly as it is
       after the WebView evicts web storage. */
    await evicted.addInitScript(nativeStub, {
      "durable:clarity:supabase-auth-session:v1": "recovered-session",
      "durable:gd_player_profiles_v27": '{"profiles":[{"id":"player47"}]}'
    });
    await evicted.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await evicted.waitForTimeout(2500);

    const recovered = await evicted.evaluate(() => ({
      session: localStorage.getItem("clarity:supabase-auth-session:v1"),
      profiles: localStorage.getItem("gd_player_profiles_v27"),
      reloadGuard: sessionStorage.getItem("gd_durable_restore_reloaded_v1")
    }));

    check("an evicted session is restored from durable storage", () => {
      assert.strictEqual(
        recovered.session, "recovered-session",
        "without this the user is silently signed out and their round is gone"
      );
      assert.ok(recovered.profiles, "user-entered profile data must come back too");
    });

    check("the recovery reload is guarded against looping", () => {
      assert.strictEqual(
        recovered.reloadGuard, "1",
        "a persistent restore failure must not reload forever"
      );
    });

    await evicted.close();
    await evictedCtx.close();

    /* --- web: untouched --- */
    const webCtx = await browser.newContext();
    await webCtx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const web = await webCtx.newPage();
    const webErrors = [];
    web.on("pageerror", (e) => webErrors.push(String(e)));
    await web.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await web.waitForTimeout(1500);

    const webState = await web.evaluate(() => {
      localStorage.setItem("clarity:supabase-auth-session:v1", "web-session");
      return {
        exists: !!window.GDDurableStorage,
        active: window.GDDurableStorage ? window.GDDurableStorage.state().active : null,
        stillReadable: localStorage.getItem("clarity:supabase-auth-session:v1")
      };
    });

    check("the web build is unaffected", () => {
      assert.deepStrictEqual(webErrors, [], "must not throw on the website");
      assert.strictEqual(webState.exists, true, "the module still defines itself");
      assert.strictEqual(webState.active, false, "but does not patch localStorage where there is no native storage");
      assert.strictEqual(webState.stillReadable, "web-session", "web writes keep working normally");
    });

    await web.close();
    await webCtx.close();
  } finally {
    await browser.close();
    server.close();
  }

  const src = fs.readFileSync(MODULE, "utf8");

  check("mirroring is fire-and-forget", () => {
    assert.ok(
      /Fire and forget/.test(src) && !/await api\.set/.test(src),
      "awaiting the mirror would make every critical write wait on native storage"
    );
  });

  check("the course library is deliberately not mirrored", () => {
    assert.ok(
      !/gd_published_course_library_v1/.test(src),
      "it is large and re-pulls from the server, so mirroring it protects nothing"
    );
  });

  check("restore writes through the original setter", () => {
    assert.ok(
      /originalSetItem/.test(src),
      "using the patched setter would mirror back the value just read out of Preferences"
    );
  });

  check("the round being played does not force a reload", () => {
    /* The reload exists because app scripts read localStorage synchronously
       while booting, so a restore they missed is invisible without loading
       again. Nothing reads the round key during boot - the Resume Round button
       and the resume prompt both read it lazily - so reloading for it throws the
       player to home to fix something that was already working. On a device
       where the webview evicts storage mid-round that was the difference between
       an invisible recovery and losing your place. */
    const block = /var RELOAD_REQUIRED_KEYS = \[([\s\S]*?)\];/.exec(src);
    assert.ok(block, "RELOAD_REQUIRED_KEYS not found");
    assert.ok(
      !/gd_gps_resume_round_v1/.test(block[1]),
      "the round key forces a reload — restoring it is already effective, and the reload costs the player their place"
    );
    ["clarity:supabase-auth-session:v1", "gd_accounts_v1", "gd_player_profiles_v27"].forEach((key) => {
      assert.ok(
        block[1].includes(key),
        key + " is not in RELOAD_REQUIRED_KEYS — it is read synchronously at boot, so a restore without a reload is invisible"
      );
    });
    assert.ok(
      /var needsReload = restored\.some/.test(src),
      "the reload is not conditional on which keys were restored"
    );
  });

  check("storage usage is measured but stays quiet when it is fine", () => {
    assert.ok(/function storageUsage\(/.test(src), "there is no way to measure what is filling the quota");
    assert.ok(
      /usage\.total < REPORT_BYTES\) return/.test(src),
      "usage is reported unconditionally — routine sessions would be noise"
    );
    assert.ok(
      /sessionStorage\.getItem\(USAGE_REPORTED\)/.test(src),
      "usage is not limited to once per session"
    );
  });

  if (failed) { console.error("durable-storage failed: " + failed + " check(s)"); process.exit(1); }
  console.log("durable-storage passed");
})().catch((err) => {
  console.error("durable-storage failed:", err && err.stack || err);
  process.exit(1);
});

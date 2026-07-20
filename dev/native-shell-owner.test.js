/* Locks gd-native-bootstrap as the sole owner of native platform detection and
   API origin resolution.

   Two things must hold at once: the web build has to stay byte-for-byte in
   behaviour (inert bootstrap, untouched fetch, relative /api), and the native
   path has to actually rewrite. The native half is exercised by re-evaluating
   the module source against a stubbed Capacitor global, so it is verified
   without a device or emulator. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const OWNER = "scripts/inline/gd-native-bootstrap.js";
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
    console.error("native-shell-owner: playwright-core is not installed. Run: npm install");
    process.exit(2);
  }

  /* Static source assertions - no browser needed. */
  const ownerSource = fs.readFileSync(path.join(ROOT, OWNER), "utf8");
  assert.ok(
    /window\.GDNative\s*=/.test(ownerSource),
    "owner must define window.GDNative"
  );

  /* The bundled app is served from https://localhost, so every /api call is
     cross-origin and the Netlify functions send no CORS headers. Without native
     HTTP the auth config fetch fails, the Supabase client never configures, and
     login silently falls back to local accounts - which looks like "Supabase is
     not connected" rather than like a network error. Verified on device:
     enabling this turned that fetch from "Failed to fetch" into 200.
     Mocked-route tests cannot catch this, so the setting is locked here. */
  const capConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "capacitor.config.json"), "utf8"));
  assert.strictEqual(
    capConfig.plugins && capConfig.plugins.CapacitorHttp && capConfig.plugins.CapacitorHttp.enabled,
    true,
    "CapacitorHttp must stay enabled or cross-origin /api calls are CORS-blocked in the app"
  );

  const otherDefiners = [];
  const scanDirs = ["scripts", "scripts/inline"];
  scanDirs.forEach((dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    fs.readdirSync(abs).forEach((name) => {
      if (!name.endsWith(".js")) return;
      const rel = path.posix.join(dir, name);
      if (rel === OWNER) return;
      const body = fs.readFileSync(path.join(abs, name), "utf8");
      if (/window\.GDNative\s*=/.test(body)) otherDefiners.push(rel);
    });
  });
  assert.deepStrictEqual(
    otherDefiners, [],
    "GDNative must have exactly one owner; also assigned in: " + otherDefiners.join(", ")
  );

  const server = await startServer();
  const pageErrors = [];
  const browser = await launchBrowser(playwright);
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.deepStrictEqual(pageErrors, [], "native bootstrap must not introduce page errors");

    const web = await page.evaluate(() => {
      const srcs = Array.from(document.scripts).map((s) => s.getAttribute("src") || "");
      const ownerIndex = srcs.findIndex((s) => s.includes("gd-native-bootstrap"));
      const redirectIndex = srcs.findIndex((s) => s.includes("gd-file-protocol-redirect"));
      return {
        ownerIndex: ownerIndex,
        redirectIndex: redirectIndex,
        present: !!window.GDNative,
        isNative: window.GDNative && window.GDNative.isNative,
        platform: window.GDNative && window.GDNative.platform,
        apiOrigin: window.GDNative && window.GDNative.apiOrigin,
        /* A patched fetch loses its native source text. */
        fetchIsNative: /\{\s*\[native code\]\s*\}/.test(String(window.fetch)),
        hasNativeClass: document.documentElement.classList.contains("gdNative")
      };
    });

    assert.ok(web.present, "GDNative must be defined on the web build");
    assert.ok(web.ownerIndex >= 0, "gd-native-bootstrap must be present in index.html");
    assert.strictEqual(web.ownerIndex, 0, "gd-native-bootstrap must be the first script in index.html");
    assert.ok(
      web.redirectIndex > web.ownerIndex,
      "gd-file-protocol-redirect must load after the bootstrap so it can read GDNative"
    );
    assert.strictEqual(web.isNative, false, "web build must not report native");
    assert.strictEqual(web.platform, "web", "web build platform must be 'web'");
    assert.strictEqual(web.apiOrigin, "", "web build must keep an empty apiOrigin so /api stays same-origin");
    assert.strictEqual(web.fetchIsNative, true, "web build must leave window.fetch unpatched");
    assert.strictEqual(web.hasNativeClass, false, "web build must not carry the gdNative class");

    /* Native half: re-run the owner source with Capacitor stubbed in. */
    const native = await page.evaluate((source) => {
      const calls = [];
      const sandbox = {
        Capacitor: { getPlatform: function () { return "android"; } },
        location: { protocol: "https:" },
        document: { documentElement: { classList: { add: function () {} } } },
        fetch: function (input) { calls.push(typeof input === "string" ? input : input.url); return Promise.resolve("ok"); },
        Request: window.Request
      };
      /* Run the module with `window` bound to the sandbox rather than the real
         one, so the live page's fetch and GDNative are left alone. */
      new Function("window", "location", "document", "Request", source)
        .call(sandbox, sandbox, sandbox.location, sandbox.document, sandbox.Request);

      sandbox.fetch("/api/auth-login");
      sandbox.fetch("/api/course-maps?q=akarana");
      sandbox.fetch("https://api.open-meteo.com/v1/elevation");
      sandbox.fetch("assets/vendor/leaflet/leaflet.js");

      return {
        isNative: sandbox.GDNative.isNative,
        platform: sandbox.GDNative.platform,
        apiOrigin: sandbox.GDNative.apiOrigin,
        calls: calls
      };
    }, ownerSource);

    assert.strictEqual(native.isNative, true, "stubbed android must report native");
    assert.strictEqual(native.platform, "android", "stubbed android must report the android platform");
    assert.ok(native.apiOrigin.startsWith("https://"), "native apiOrigin must be an absolute https origin");

    assert.strictEqual(
      native.calls[0], native.apiOrigin + "/api/auth-login",
      "native fetch must rewrite relative /api paths to the deployed origin"
    );
    assert.strictEqual(
      native.calls[1], native.apiOrigin + "/api/course-maps?q=akarana",
      "native rewrite must preserve query strings"
    );
    assert.strictEqual(
      native.calls[2], "https://api.open-meteo.com/v1/elevation",
      "native fetch must leave absolute third-party URLs untouched"
    );
    assert.strictEqual(
      native.calls[3], "assets/vendor/leaflet/leaflet.js",
      "native fetch must leave non-/api relative URLs untouched"
    );

    console.log(
      "native-shell-owner passed: bootstrap first, web inert (fetch unpatched), native rewrites " +
      "/api -> " + native.apiOrigin
    );
  } finally {
    await browser.close();
    server.close();
  }
})().catch((err) => {
  console.error("native-shell-owner failed:", err && err.message || err);
  process.exit(1);
});

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
    console.error("app-permissions-smoke: playwright-core is not installed. Run: npm install");
    process.exit(2);
  }

  const server = await startServer();
  const pageErrors = [];
  const browser = await launchBrowser(playwright);
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.deepStrictEqual(pageErrors, [], "permissions carve must not introduce page errors");

    const result = await page.evaluate(() => {
      const scripts = Array.from(document.scripts).map((script) => script.getAttribute("src") || "");
      const permissionsIndex = scripts.findIndex((src) => src.includes("gd-app-permissions.js"));
      const coreIndex = scripts.findIndex((src) => src.includes("gd-app-core.js"));
      const resolverIndex = scripts.findIndex((src) => src.includes("clarity-permissions.js"));
      const originalCurrent = window.GolfDaddyAccounts.current;
      window.GolfDaddyAccounts.current = () => ({ accountId: "acct_smoke", profileId: "profile_smoke", role: "coach" });
      const accountPermission = window.GolfDaddyPermissions.get();
      window.GolfDaddyAccounts.current = originalCurrent;
      window.GolfDaddyPermissions.render();
      return {
        permissionsIndex,
        coreIndex,
        resolverIndex,
        accountPermission,
        aliasPreserved: window.ClarityCaddiePermissions === window.GolfDaddyPermissions,
        resolverPreserved: !!(window.ClarityPermissions && typeof window.ClarityPermissions.canUse === "function"),
        subscribedLabel: window.GolfDaddyPermissions.label("subscribed"),
        adminCardRendered: /Account Permissions/.test(document.getElementById("gdPermissionCard").textContent || ""),
        bodyPermission: document.body.dataset.gdPermission || ""
      };
    });

    assert.ok(result.permissionsIndex >= 0, "gd-app-permissions.js must be loaded");
    assert.ok(result.coreIndex >= 0, "gd-app-core.js must be loaded");
    assert.ok(result.permissionsIndex < result.coreIndex, "local permissions owner must load before app core boot");
    assert.ok(result.resolverIndex > result.coreIndex, "server resolver API remains a separate later platform script");
    assert.strictEqual(result.accountPermission, "coach", "account role still drives app permission");
    assert.strictEqual(result.aliasPreserved, true, "ClarityCaddiePermissions alias is preserved");
    assert.strictEqual(result.resolverPreserved, true, "ClarityPermissions resolver API is preserved");
    assert.strictEqual(result.subscribedLabel, "Subscribed Player", "normalization and labels are preserved");
    assert.strictEqual(result.adminCardRendered, true, "permissions admin card still renders");
    assert.ok(result.bodyPermission, "permission chrome still writes body dataset");
    console.log("app-permissions-smoke tests passed");
  } finally {
    await browser.close();
    server.close();
  }
})().catch((err) => {
  console.error("app-permissions-smoke failed:", err);
  process.exit(1);
});

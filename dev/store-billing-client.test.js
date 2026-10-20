/* Store billing client wiring.
 *
 * Runs the real index.html in a browser with the Capacitor bridge stubbed, so the
 * whole native path is exercised end to end: GDNative flips to native, the fetch
 * rewrite engages, clarity-payments refuses Stripe and delegates, and
 * clarity-store-billing drives the RevenueCat plugin.
 *
 * The two failures that would matter most in production are the ones asserted
 * hardest here: a Stripe checkout call escaping from inside the app (an IAP
 * policy violation), and a purchase attaching to the wrong appUserID (the only
 * join the webhook has back to an account). */
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

const ACCOUNT_ID = "acct_native_1";
const STORE_PRODUCT_ID = "clarity_membership_monthly";

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

/* Injected before any app script runs, so gd-native-bootstrap sees a native
   platform and clarity-store-billing sees a usable plugin. */
/* Playwright's addInitScript passes exactly one argument, so options arrive as a
   single object rather than positionally. */
function nativeStub(options) {
  const accountId = options.accountId;
  const storeProductId = options.storeProductId;
  window.__rc = { calls: [], configuredWith: null, loggedInAs: null, purchased: null };

  const Purchases = {
    configure: async function (options) { window.__rc.configuredWith = options; window.__rc.calls.push("configure"); },
    logIn: async function (options) {
      window.__rc.loggedInAs = options.appUserID;
      window.__rc.calls.push("logIn");
      /* The real SDK returns the (possibly transferred) customerInfo. */
      return {
        created: false,
        customerInfo: window.__rc.purchased
          ? { entitlements: { active: { membership: { productIdentifier: storeProductId, expirationDate: null, willRenew: true } } } }
          : {}
      };
    },
    logOut: async function () { window.__rc.loggedInAs = null; window.__rc.calls.push("logOut"); return {}; },
    getOfferings: async function () {
      window.__rc.calls.push("getOfferings");
      return {
        current: {
          identifier: "default",
          availablePackages: [
            { identifier: "$rc_monthly", packageType: "MONTHLY", product: { identifier: storeProductId, priceString: "$9.99" } },
            { identifier: "other", packageType: "CUSTOM", product: { identifier: "something_else", priceString: "$1.00" } }
          ]
        },
        all: {}
      };
    },
    purchasePackage: async function (options) {
      window.__rc.calls.push("purchasePackage");
      window.__rc.purchased = options.aPackage;
      /* A real purchase comes back with the entitlement already active on the
         customerInfo - that is what the device entitlement cache is fed from. */
      return {
        customerInfo: {
          entitlements: {
            active: {
              membership: { productIdentifier: storeProductId, expirationDate: null, willRenew: true }
            }
          }
        }
      };
    },
    restorePurchases: async function () { window.__rc.calls.push("restorePurchases"); return { customerInfo: {} }; },
    getCustomerInfo: async function () { window.__rc.calls.push("getCustomerInfo"); return { customerInfo: {} }; }
  };

  window.Capacitor = {
    getPlatform: function () { return "android"; },
    isNativePlatform: function () { return true; },
    Plugins: { Purchases: Purchases }
  };

  /* The app's own account system is not exercised here; the module only needs a
     current account with an id. Defined as a getter so it survives whatever the
     real scripts assign later. */
  window.__stubAccount = { accountId: accountId, email: "native@example.com" };
  Object.defineProperty(window, "GolfDaddyAccounts", {
    configurable: true,
    /* An empty accountId means the signed-out pass: current() answers null,
       exactly as the real accounts module does for a guest. */
    get: function () { return { current: function () { return window.__stubAccount.accountId ? window.__stubAccount : null; } }; },
    set: function () { /* ignore the app's own assignment */ }
  });

  /* The app defines its own window.toast during boot, so a stub installed here is
     overwritten. Tests that care about toast text wrap it at call time instead. */
}

(async () => {
  let playwright;
  try {
    playwright = require("playwright-core");
  } catch (_e) {
    console.error("store-billing-client: playwright-core is not installed. Run: npm install");
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

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const apiCalls = [];

    /* The native fetch rewrite sends /api/* to the deployed origin. Intercept it
       so the test never touches the network, and so we can see exactly which
       endpoints the app tried to call. */
    await context.route("https://caddy.claritygolf.app/api/**", async (route) => {
      const url = route.request().url();
      apiCalls.push(url.replace("https://caddy.claritygolf.app", ""));
      if (url.includes("/api/store-config")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            configured: true,
            apiKeys: { android: "goog_test_key", ios: "appl_test_key" },
            products: { monthly_membership: STORE_PRODUCT_ID, month_pass: "clarity_month_pass" },
            entitlementId: "membership"
          })
        });
      }
      if (url.includes("/api/payment-entitlement")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ configured: true, active: true, paymentState: "store_membership_active", entitlements: [] })
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.addInitScript(nativeStub, { accountId: ACCOUNT_ID, storeProductId: STORE_PRODUCT_ID });
    await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);

    const boot = await page.evaluate(() => ({
      native: window.GDNative && window.GDNative.isNative,
      platform: window.GDNative && window.GDNative.platform,
      hasModule: !!window.ClarityStoreBilling,
      available: window.ClarityStoreBilling && window.ClarityStoreBilling.available(),
      configuredWith: window.__rc.configuredWith
    }));

    check("bootstrap reports native from the Capacitor bridge", () => {
      assert.strictEqual(boot.native, true);
      assert.strictEqual(boot.platform, "android");
    });

    check("store billing module loads and reports available", () => {
      assert.strictEqual(boot.hasModule, true, "ClarityStoreBilling must exist");
      assert.strictEqual(boot.available, true, "must report available when native with a plugin");
    });

    check("SDK is configured with our account id as appUserID", () => {
      assert.ok(boot.configuredWith, "configure() must be called at boot");
      assert.strictEqual(boot.configuredWith.apiKey, "goog_test_key", "must use the android key on android");
      assert.strictEqual(
        boot.configuredWith.appUserID, ACCOUNT_ID,
        "appUserID must equal our account_id - it is the only join the webhook has"
      );
    });

    /* The real entry point: the paywall calls ClarityPayments.buy, not the store
       module directly. */
    const purchase = await page.evaluate(async () => {
      const result = await window.ClarityPayments.buy("monthly_membership");
      return {
        result: result,
        calls: window.__rc.calls.slice(),
        purchased: window.__rc.purchased,
        loggedInAs: window.__rc.loggedInAs
      };
    });

    check("ClarityPayments.buy delegates to the store when native", () => {
      assert.ok(
        purchase.calls.indexOf("purchasePackage") !== -1,
        "a purchase must go through the store plugin, not Stripe"
      );
      assert.strictEqual(purchase.result, true);
    });

    check("the correct package is purchased for the product key", () => {
      assert.ok(purchase.purchased, "a package must be passed to purchasePackage");
      assert.strictEqual(
        purchase.purchased.product.identifier, STORE_PRODUCT_ID,
        "must match the product key to its configured store product id"
      );
    });

    check("no Stripe checkout is reachable from inside the app", () => {
      const stripeCalls = apiCalls.filter((u) => u.includes("create-checkout-session") || u.includes("billing-portal"));
      assert.deepStrictEqual(
        stripeCalls, [],
        "selling a digital membership via Stripe in-app is an IAP violation on both stores"
      );
    });

    check("access is confirmed from our backend, not from the client", () => {
      assert.ok(
        apiCalls.some((u) => u.includes("/api/payment-entitlement")),
        "after purchasing, the app must re-ask the backend what the user is entitled to"
      );
    });

    /* Store policy: a subscription must be recoverable on a new device. */
    const restored = await page.evaluate(async () => {
      window.__rc.calls.length = 0;
      const result = await window.ClarityStoreBilling.restore();
      return { result: result, calls: window.__rc.calls.slice() };
    });

    check("restore purchases is wired", () => {
      assert.ok(restored.calls.indexOf("restorePurchases") !== -1, "restorePurchases must be called");
      assert.strictEqual(restored.result, true, "an active entitlement means the restore succeeded");
    });

    const managed = await page.evaluate(async () => {
      const seen = [];
      const original = window.toast;
      window.toast = function (message) { seen.push(String(message)); };
      let result;
      try { result = await window.ClarityPayments.manageMembership(); }
      finally { window.toast = original; }
      return { result: result, toast: seen[0] || "" };
    });

    check("billing management does not open the Stripe portal in the app", () => {
      assert.strictEqual(managed.result, false);
      assert.ok(/renews outside this app/i.test(managed.toast), "should say where billing lives, not link out to Stripe");
    });

    await page.close();
    await context.close();

    /* Signed-out pass: Apple 5.1.1(v) - build 757 was rejected because a
       purchase could not happen without registering. A guest must be able to
       buy, the purchase runs anonymously (no appUserID), and access is honoured
       on this device from the store's own customerInfo. */
    const anonApiCalls = [];
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonContext.route("https://caddy.claritygolf.app/api/**", async (route) => {
      const url = route.request().url();
      anonApiCalls.push(url.replace("https://caddy.claritygolf.app", ""));
      if (url.includes("/api/store-config")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            configured: true,
            apiKeys: { android: "goog_test_key", ios: "appl_test_key" },
            products: { monthly_membership: STORE_PRODUCT_ID, month_pass: "clarity_month_pass" },
            entitlementId: "membership"
          })
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await anonPage.addInitScript(nativeStub, { accountId: "", storeProductId: STORE_PRODUCT_ID });
    await anonPage.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await anonPage.waitForTimeout(2000);

    const anonPurchase = await anonPage.evaluate(async () => {
      const result = await window.ClarityPayments.buy("monthly_membership");
      return {
        result: result,
        calls: window.__rc.calls.slice(),
        configuredWith: window.__rc.configuredWith,
        loggedInAs: window.__rc.loggedInAs,
        deviceEntitled: window.ClarityStoreBilling.entitlementActive(),
        hasAccess: window.ClarityPayments.hasActiveAccess()
      };
    });

    check("a signed-out player can complete a purchase (5.1.1(v))", () => {
      assert.strictEqual(anonPurchase.result, true, "buy() must not refuse a guest");
      assert.ok(anonPurchase.calls.indexOf("purchasePackage") !== -1, "the store sheet must open for a guest");
    });

    check("the guest purchase is anonymous, never a made-up user id", () => {
      assert.ok(!anonPurchase.configuredWith.appUserID, "configure() must pass no appUserID for a guest");
      assert.strictEqual(anonPurchase.loggedInAs, null, "logIn() must not run without an account");
    });

    check("the store's answer grants access on this device", () => {
      assert.strictEqual(anonPurchase.deviceEntitled, true, "entitlementActive() must reflect the purchase");
      assert.strictEqual(anonPurchase.hasAccess, true, "hasActiveAccess() must include the device entitlement");
    });

    check("no backend entitlement poll runs without an account to ask about", () => {
      assert.ok(
        !anonApiCalls.some((u) => u.includes("/api/payment-entitlement")),
        "polling the backend for a guest could only 401 - the device entitlement is the record"
      );
    });

    /* Signing in afterwards must transfer the anonymous purchase: identify() ->
       logIn(accountId), which is the join the webhook needs. */
    const anonSignIn = await anonPage.evaluate(async () => {
      window.__stubAccount = { accountId: "acct_after_purchase", email: "native@example.com" };
      await window.ClarityStoreBilling.identify("acct_after_purchase");
      return { loggedInAs: window.__rc.loggedInAs, calls: window.__rc.calls.slice() };
    });

    check("signing in transfers the anonymous purchase to the account", () => {
      assert.strictEqual(anonSignIn.loggedInAs, "acct_after_purchase", "logIn must run with the real account id");
    });

    await anonPage.close();
    await anonContext.close();

    /* Second pass with no Capacitor bridge at all: the website must be untouched. */
    const webContext = await browser.newContext();
    const webPage = await webContext.newPage();
    const webErrors = [];
    webPage.on("pageerror", (err) => webErrors.push(String(err && err.stack || err)));
    await webPage.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await webPage.waitForTimeout(1500);

    const web = await webPage.evaluate(() => ({
      native: window.GDNative && window.GDNative.isNative,
      hasModule: !!window.ClarityStoreBilling,
      available: window.ClarityStoreBilling && window.ClarityStoreBilling.available(),
      buyReturns: null
    }));

    check("web build is unaffected by the store module", () => {
      assert.deepStrictEqual(webErrors, [], "the store module must not throw on the website");
      assert.strictEqual(web.native, false, "web must not report native");
      assert.strictEqual(web.hasModule, true, "module still defines itself");
      assert.strictEqual(web.available, false, "but reports unavailable, so Stripe stays the web path");
    });

    await webPage.close();
    await webContext.close();
  } finally {
    await browser.close();
    server.close();
  }

  if (failed) {
    console.error("store-billing-client failed: " + failed + " check(s)");
    process.exit(1);
  }
  console.log("store-billing-client passed");
})().catch((err) => {
  console.error("store-billing-client failed:", err && err.stack || err);
  process.exit(1);
});

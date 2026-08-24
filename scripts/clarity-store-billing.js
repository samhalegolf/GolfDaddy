/* Store billing client. Sole owner of Apple/Google purchase flow in the apps.
 *
 * This repo has no bundler, so the RevenueCat JS SDK cannot be imported. We talk
 * to the same native plugin through the Capacitor bridge instead - the SDK's own
 * wrapper registers under the name "Purchases", so window.Capacitor.Plugins.Purchases
 * exposes the identical method surface. Signatures here match
 * @revenuecat/purchases-capacitor 13.2.3.
 *
 * Inert on web: every entry point returns early unless GDNative reports native, so
 * the website keeps using Stripe exactly as before.
 *
 * Backend grants still come only from the RevenueCat webhook after the receipt
 * has been validated with the store. What this file additionally holds, since the
 * August 2026 App Store rejection under 5.1.1(v), is the DEVICE entitlement: a
 * signed-out player may buy without registering (Apple requires this - a purchase
 * is not an account-based feature), and their access is honoured from the store's
 * own answer, customerInfo.entitlements, cached locally. That answer comes from
 * the store via RevenueCat, not from anything the client asserts, so it is no
 * more spoofable than the webhook path - and when the player later signs in,
 * logIn() transfers the anonymous purchase to their account and the webhook
 * writes the backend entitlement as before. */
(function () {
  "use strict";

  var CONFIG_ENDPOINT = "/api/store-config";
  var STATUS_ENDPOINT = "/api/payment-entitlement";

  /* The webhook is asynchronous: the store confirms the purchase to the device
     before RevenueCat has necessarily told our backend about it. Poll rather than
     assume, so the user is not shown "purchase failed" for a purchase that
     succeeded and is simply still in flight. */
  var ENTITLEMENT_POLL_ATTEMPTS = 6;
  var ENTITLEMENT_POLL_DELAY_MS = 1200;

  /* Device entitlement cache. Written only from customerInfo returned by the
     store plugin (purchase, restore, logIn, getCustomerInfo) - never from user
     input - and persisted so a signed-out member is not locked out between
     launches while offline. Refreshed from the store on every boot, which is
     how expiry and refunds catch up with the cache. */
  var ENTITLEMENT_CACHE_KEY = "clarity:store-entitlement:v1";

  var config = null;
  var configured = false;
  var identifiedAs = "";
  var busy = false;
  var prices = null;        /* productKey -> localized store price, once loaded */
  var pricesLoading = false;
  var lastPriceDiagnostic = "";  /* why prices are missing, for diagnostics() */
  var deviceEntitlement = readEntitlementCache();

  function isNative() {
    return !!(window.GDNative && window.GDNative.isNative);
  }

  function plugin() {
    var cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.Purchases ? cap.Plugins.Purchases : null;
  }

  function platform() {
    return window.GDNative && window.GDNative.platform === "ios" ? "ios" : "android";
  }

  function toast(message) {
    try { if (window.toast) window.toast(message); } catch (_e) {}
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function currentAccount() {
    try {
      var accounts = window.GolfDaddyAccounts;
      var account = accounts && typeof accounts.current === "function" ? accounts.current() : null;
      if (!account) return null;
      return {
        accountId: account.accountId || account.id || "",
        email: account.email || ""
      };
    } catch (_e) {
      return null;
    }
  }

  function readEntitlementCache() {
    try {
      var raw = localStorage.getItem(ENTITLEMENT_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_e) {
      return null;
    }
  }

  /* Reduce a customerInfo to the one fact the app needs: is this device
     entitled, on what product, until when. Called with every customerInfo the
     plugin hands back, so the cache can only ever say what the store last said.

     The configured id is preferred, but ANY active entitlement counts. Clarity
     has exactly one access tier - an entitlement being active means "has full
     access", whatever it is called - and the id in RevenueCat is a display-level
     name that has already drifted from the configured one once. Requiring an
     exact match would mean a real, paid-for purchase silently granting nothing,
     which is the worst failure this file can have. If a second tier is ever
     added, this must become an explicit check again. */
  function saveEntitlementFromCustomerInfo(customerInfo) {
    try {
      var entitlementId = config && config.entitlementId || "membership";
      var active = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active || {};
      var entry = active[entitlementId] || active[Object.keys(active)[0]] || null;
      deviceEntitlement = entry ? {
        active: true,
        productId: String(entry.productIdentifier || ""),
        expiresAt: entry.expirationDate ? String(entry.expirationDate) : "",
        willRenew: entry.willRenew !== false,
        updatedAt: new Date().toISOString()
      } : { active: false, updatedAt: new Date().toISOString() };
      localStorage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify(deviceEntitlement));
    } catch (_e) {}
    refreshPaymentsUi();
    return deviceEntitlement;
  }

  /* True when the store last said this device holds the entitlement and it has
     not visibly expired. A subscription's expirationDate moves forward on each
     renewal, so a stale "expired" answer only ever under-grants until the next
     boot refresh - it never over-grants. Non-expiring grants have no date. */
  function entitlementActive() {
    if (!isNative()) return false;
    var cached = deviceEntitlement;
    if (!cached || !cached.active) return false;
    if (cached.expiresAt) {
      var expires = new Date(cached.expiresAt).getTime();
      if (Number.isFinite(expires) && expires < Date.now()) return false;
    }
    return true;
  }

  async function refreshEntitlementFromStore() {
    if (!available()) return deviceEntitlement;
    try {
      await ensureConfigured();
      var result = await plugin().getCustomerInfo();
      return saveEntitlementFromCustomerInfo(result && result.customerInfo);
    } catch (_e) {
      return deviceEntitlement;
    }
  }

  async function loadConfig() {
    if (config) return config;
    var response = await fetch(CONFIG_ENDPOINT, { cache: "no-store" });
    if (!response.ok) throw new Error("Store billing is unavailable");
    var body = await response.json();
    if (!body || !body.configured) throw new Error("Store billing is not set up yet");
    var key = body.apiKeys && body.apiKeys[platform()];
    if (!key) throw new Error("Store billing is not set up for this platform");
    config = body;
    return config;
  }

  /* Configure once per app launch. RevenueCat tolerates being configured before a
     user is known; identify() then attaches the purchase to the right account. */
  async function ensureConfigured() {
    if (configured) return;
    var api = plugin();
    if (!api) throw new Error("Store billing is unavailable");
    var cfg = await loadConfig();
    var account = currentAccount();
    await api.configure({
      apiKey: cfg.apiKeys[platform()],
      /* Passing appUserID up front avoids an anonymous purchase that would later
         need aliasing. The webhook joins on this exact value. */
      appUserID: account && account.accountId ? account.accountId : null
    });
    configured = true;
    if (account && account.accountId) identifiedAs = account.accountId;
  }

  /* The single most important line in this file: RevenueCat's appUserID must equal
     our account_id, because that is the only join the webhook has back to an
     account. Get it wrong and entitlements land on the wrong user or nobody. */
  async function identify(accountId) {
    if (!isNative()) return false;
    var clean = String(accountId || "").trim();
    if (!clean) return false;
    try {
      await ensureConfigured();
      if (identifiedAs === clean) return true;
      var api = plugin();
      /* logIn also TRANSFERS any anonymous purchase made on this device to the
         account, which is what turns a signed-out App Store purchase into a
         normal webhook-backed entitlement. */
      var result = await api.logIn({ appUserID: clean });
      identifiedAs = clean;
      if (result && result.customerInfo) saveEntitlementFromCustomerInfo(result.customerInfo);
      return true;
    } catch (_e) {
      /* Identification failing must not block sign-in; the user simply cannot
         purchase until it succeeds, and buy() re-attempts it. */
      return false;
    }
  }

  async function signOut() {
    if (!isNative() || !configured) return false;
    /* logOut throws when the current RevenueCat user is already anonymous, and a
       device that never signed in stays anonymous by design - its purchase must
       survive other people's sign-in/sign-out is not a case here because
       identify() only ever runs for the signed-in account. */
    if (!identifiedAs) return false;
    try {
      var result = await plugin().logOut();
      identifiedAs = "";
      /* The new anonymous user starts without the account's entitlement, and the
         cache must say so - otherwise a shared iPad keeps the previous owner's
         membership after they sign out. */
      saveEntitlementFromCustomerInfo(result && result.customerInfo);
      return true;
    } catch (_e) {
      return false;
    }
  }

  /* Find the package whose underlying store product matches the product key the
     paywall asked for. Falls back to a package whose identifier matches, which
     covers offerings configured by package identifier rather than product id. */
  function findPackage(offerings, storeProductId, productKey) {
    var offering = offerings && offerings.current;
    var packages = offering && Array.isArray(offering.availablePackages) ? offering.availablePackages : [];
    if (!packages.length && offerings && offerings.all) {
      Object.keys(offerings.all).forEach(function (name) {
        var entry = offerings.all[name];
        if (entry && Array.isArray(entry.availablePackages)) {
          packages = packages.concat(entry.availablePackages);
        }
      });
    }
    var byProduct = packages.filter(function (pkg) {
      return pkg && pkg.product && pkg.product.identifier === storeProductId;
    })[0];
    if (byProduct) return byProduct;
    return packages.filter(function (pkg) {
      return pkg && pkg.identifier === productKey;
    })[0] || null;
  }

  /* Store prices for the paywall cards. The store is the only honest source of
     what the user will actually be charged - the Stripe-derived labels describe
     the web price, which can differ by currency and by Apple/Google price tier,
     and "Configured in Stripe" on a store build is exactly the wording a
     reviewer reads as payment taken outside the store. Loaded once after
     configure; clarity-payments reads the cache synchronously via price(). */
  async function loadPrices() {
    if (prices || pricesLoading) return prices;
    if (!available()) {
      lastPriceDiagnostic = !isNative()
        ? "not a native build"
        : "RevenueCat plugin missing from this build";
      return prices;
    }
    pricesLoading = true;
    try {
      await ensureConfigured();
      var cfg = await loadConfig();
      var offerings = await plugin().getOfferings();
      var found = {};
      var seen = [];
      Object.keys(cfg.products || {}).forEach(function (productKey) {
        var pkg = findPackage(offerings, cfg.products[productKey], productKey);
        var priceString = pkg && pkg.product && pkg.product.priceString;
        if (priceString) found[productKey] = String(priceString);
        else seen.push(productKey + "->" + cfg.products[productKey] + (pkg ? " (package, no price)" : " (no package)"));
      });
      prices = found;
      /* Say WHY when nothing came back. A silent empty result here has three
         very different causes - the Paid Apps Agreement not being active, the
         products not yet Ready to Submit, or the offering not containing them -
         and they are indistinguishable from the UI without this. */
      lastPriceDiagnostic = Object.keys(found).length
        ? ""
        : "offerings returned " + countPackages(offerings) + " package(s); " + (seen.join("; ") || "no products configured");
      /* Cards may already be rendered with the placeholder - repaint them. */
      refreshPaymentsUi();
    } catch (error) {
      /* A missing price is a display gap, not a failure - buy() resolves the
         package itself. Leave the cache null so a later render can retry. */
      lastPriceDiagnostic = "getOfferings failed: " + (error && error.message ? error.message : String(error));
    } finally {
      pricesLoading = false;
    }
    return prices;
  }

  function countPackages(offerings) {
    var n = 0;
    try {
      if (offerings && offerings.current && Array.isArray(offerings.current.availablePackages)) {
        n += offerings.current.availablePackages.length;
      }
      if (offerings && offerings.all) {
        Object.keys(offerings.all).forEach(function (name) {
          var entry = offerings.all[name];
          if (entry && Array.isArray(entry.availablePackages)) n += entry.availablePackages.length;
        });
      }
    } catch (_e) {}
    return n;
  }

  /* One line describing why the paywall has no prices, for the Refresh Status
     button to surface on a device where no console is attached. */
  function diagnostics() {
    if (!isNative()) return "Web build - store billing is inert here.";
    if (!plugin()) return "RevenueCat plugin not registered in this build.";
    var parts = [
      "configured=" + configured,
      "prices=" + (prices ? Object.keys(prices).length : "not loaded"),
      "user=" + (identifiedAs || "anonymous")
    ];
    if (lastPriceDiagnostic) parts.push(lastPriceDiagnostic);
    return parts.join(" | ");
  }

  function price(productKey) {
    if (!prices) loadPrices();
    return prices && prices[String(productKey || "")] || "";
  }

  /* Ask our backend what it now believes, retrying while the webhook lands. */
  async function awaitEntitlement(account) {
    var payload = { accountId: account.accountId, email: account.email };
    for (var attempt = 0; attempt < ENTITLEMENT_POLL_ATTEMPTS; attempt += 1) {
      if (attempt) await wait(ENTITLEMENT_POLL_DELAY_MS);
      try {
        var response = await fetch(STATUS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) continue;
        var body = await response.json();
        if (body && body.active) return body;
      } catch (_e) {
        /* Keep polling - a transient network error here is not a failed purchase. */
      }
    }
    return null;
  }

  function refreshPaymentsUi() {
    try {
      if (window.ClarityPayments && typeof window.ClarityPayments.refresh === "function") {
        window.ClarityPayments.refresh();
      }
    } catch (_e) {}
  }

  async function buy(productKey) {
    if (!isNative()) return false;
    if (busy) return false;

    /* No sign-in wall here. Apple rejected build 757 under 5.1.1(v) because the
       only path to a purchase ran through registration. A signed-out purchase is
       anonymous to RevenueCat; identify() transfers it to the account whenever
       the player does sign in. */
    var account = currentAccount();

    busy = true;
    try {
      /* Immediate feedback: the store sheet can take a few seconds to present,
         and a tap that visibly does nothing gets tapped again - which the busy
         guard then swallows, which reads as "the app did not respond". */
      toast("Contacting the App Store…");
      await ensureConfigured();
      if (account && account.accountId) await identify(account.accountId);

      var api = plugin();
      var cfg = await loadConfig();
      var storeProductId = cfg.products && cfg.products[productKey];
      if (!storeProductId) throw new Error("That option is not available in the app");

      var offerings = await api.getOfferings();
      var pkg = findPackage(offerings, storeProductId, productKey);
      if (!pkg) throw new Error("That option is not available right now");

      var result = await api.purchasePackage({ aPackage: pkg });

      /* The store has confirmed the purchase; honour it on this device now. */
      if (result && result.customerInfo) saveEntitlementFromCustomerInfo(result.customerInfo);

      if (account && account.accountId) {
        /* Signed in: the backend entitlement comes from the webhook. */
        var entitlement = await awaitEntitlement(account);
        refreshPaymentsUi();
        if (entitlement) {
          toast("Membership active");
        } else {
          /* The money was taken and the webhook has not landed yet. Say so plainly
             rather than implying the purchase failed - it did not. */
          toast("Purchase complete. Access will appear shortly.");
        }
      } else {
        toast(entitlementActive()
          ? "Membership active on this device"
          : "Purchase complete. Access will appear shortly.");
      }
      return true;
    } catch (error) {
      /* A user backing out of the store sheet is not an error worth shouting
         about. RevenueCat flags exactly that case on the error object. */
      if (error && error.userCancelled) return false;
      toast(error && error.message ? error.message : "Could not complete purchase");
      /* Keep the last failure visible to the paywall's diagnostic line - a
         sheet that never presents otherwise leaves no trace on a device. */
      lastPriceDiagnostic = "purchase failed: " + (error && error.message ? error.message : String(error));
      return false;
    } finally {
      busy = false;
      refreshPaymentsUi();
    }
  }

  /* Both stores require a visible way to restore purchases - Apple will reject an
     app whose subscription cannot be recovered on a new device. */
  async function restore() {
    if (!isNative() || busy) return false;
    /* Restore also works signed out - the store account, not the Clarity
       account, is what owns the purchase being recovered. */
    var account = currentAccount();
    busy = true;
    try {
      await ensureConfigured();
      if (account && account.accountId) await identify(account.accountId);
      var result = await plugin().restorePurchases();
      saveEntitlementFromCustomerInfo(result && result.customerInfo);
      var restored = account && account.accountId
        ? !!(await awaitEntitlement(account))
        : entitlementActive();
      toast(restored ? "Purchases restored" : "No purchases found to restore");
      return restored;
    } catch (error) {
      if (error && error.userCancelled) return false;
      toast(error && error.message ? error.message : "Could not restore purchases");
      return false;
    } finally {
      busy = false;
      refreshPaymentsUi();
    }
  }

  function available() {
    return isNative() && !!plugin();
  }

  window.ClarityStoreBilling = {
    available: available,
    buy: buy,
    identify: identify,
    restore: restore,
    signOut: signOut,
    price: price,
    loadPrices: loadPrices,
    /* The device-local answer: did the store last say this device holds the
       entitlement? clarity-payments folds this into hasActiveAccess() so a
       signed-out purchaser is a member on this device. */
    entitlementActive: entitlementActive,
    refreshEntitlement: refreshEntitlementFromStore,
    diagnostics: diagnostics,
    /* Force a re-fetch: clears the cache so loadPrices tries the store again. */
    reloadPrices: function () { prices = null; lastPriceDiagnostic = ""; return loadPrices(); },
    /* Exposed for the boot smoke test and for diagnostics. */
    __state: function () {
      return { configured: configured, identifiedAs: identifiedAs, busy: busy, native: isNative() };
    }
  };

  /* Configure early on native so the first paywall tap is not waiting on a network
     round trip, then warm the price cache so the paywall opens with real store
     prices. Failure is silent by design - buy() reports it in context. */
  if (isNative()) {
    document.addEventListener("DOMContentLoaded", function () {
      ensureConfigured()
        .then(function () { return refreshEntitlementFromStore(); })
        .then(function () { return loadPrices(); })
        .catch(function () {});
    });

    /* Keep RevenueCat's user in step with the Clarity session. Signing in
       transfers any anonymous purchase to the account (identify -> logIn);
       signing out drops back to a fresh anonymous user so the device does not
       keep the departed account's membership. */
    window.addEventListener("clarity:session-changed", function () {
      var account = currentAccount();
      if (account && account.accountId) {
        identify(account.accountId).catch(function () {});
      } else if (identifiedAs) {
        signOut().catch(function () {});
      }
    });
  }
})();

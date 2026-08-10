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
 * Grants are never made from here. A purchase is only ever a signal to re-ask our
 * own backend what the user is entitled to; the entitlement itself is written by
 * the RevenueCat webhook after the receipt has been validated with the store. A
 * client that could grant its own access would be trivially spoofable. */
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

  var config = null;
  var configured = false;
  var identifiedAs = "";
  var busy = false;
  var prices = null;        /* productKey -> localized store price, once loaded */
  var pricesLoading = false;

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
      await api.logIn({ appUserID: clean });
      identifiedAs = clean;
      return true;
    } catch (_e) {
      /* Identification failing must not block sign-in; the user simply cannot
         purchase until it succeeds, and buy() re-attempts it. */
      return false;
    }
  }

  async function signOut() {
    if (!isNative() || !configured) return false;
    try {
      await plugin().logOut();
      identifiedAs = "";
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
    if (prices || pricesLoading || !available()) return prices;
    pricesLoading = true;
    try {
      await ensureConfigured();
      var cfg = await loadConfig();
      var offerings = await plugin().getOfferings();
      var found = {};
      Object.keys(cfg.products || {}).forEach(function (productKey) {
        var pkg = findPackage(offerings, cfg.products[productKey], productKey);
        var priceString = pkg && pkg.product && pkg.product.priceString;
        if (priceString) found[productKey] = String(priceString);
      });
      prices = found;
      /* Cards may already be rendered with the placeholder - repaint them. */
      refreshPaymentsUi();
    } catch (_e) {
      /* A missing price is a display gap, not a failure - buy() resolves the
         package itself. Leave the cache null so a later render can retry. */
    } finally {
      pricesLoading = false;
    }
    return prices;
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

    var account = currentAccount();
    if (!account || !account.accountId) {
      toast("Sign in before buying access");
      try { if (window.gdOpenProfileV67) window.gdOpenProfileV67(); } catch (_e) {}
      return false;
    }

    busy = true;
    try {
      await ensureConfigured();
      await identify(account.accountId);

      var api = plugin();
      var cfg = await loadConfig();
      var storeProductId = cfg.products && cfg.products[productKey];
      if (!storeProductId) throw new Error("That option is not available in the app");

      var offerings = await api.getOfferings();
      var pkg = findPackage(offerings, storeProductId, productKey);
      if (!pkg) throw new Error("That option is not available right now");

      await api.purchasePackage({ aPackage: pkg });

      /* Purchased on the store. Access still comes from our backend. */
      var entitlement = await awaitEntitlement(account);
      refreshPaymentsUi();
      if (entitlement) {
        toast("Membership active");
      } else {
        /* The money was taken and the webhook has not landed yet. Say so plainly
           rather than implying the purchase failed - it did not. */
        toast("Purchase complete. Access will appear shortly.");
      }
      return true;
    } catch (error) {
      /* A user backing out of the store sheet is not an error worth shouting
         about. RevenueCat flags exactly that case on the error object. */
      if (error && error.userCancelled) return false;
      toast(error && error.message ? error.message : "Could not complete purchase");
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
    var account = currentAccount();
    if (!account || !account.accountId) {
      toast("Sign in to restore purchases");
      return false;
    }
    busy = true;
    try {
      await ensureConfigured();
      await identify(account.accountId);
      await plugin().restorePurchases();
      var entitlement = await awaitEntitlement(account);
      toast(entitlement ? "Purchases restored" : "No purchases found to restore");
      return !!entitlement;
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
      ensureConfigured().then(function () { return loadPrices(); }).catch(function () {});
    });
  }
})();

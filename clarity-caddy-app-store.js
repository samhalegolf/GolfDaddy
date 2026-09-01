/* One canonical App Store destination for every Clarity Caddy surface.
 *
 * This small UMD module deliberately works in both the static web app and
 * Netlify functions. Keep the listing URL here; consumers must not duplicate
 * it in markup or email templates. */
(function (root, factory) {
  var config = factory();
  if (typeof module === "object" && module.exports) module.exports = config;
  if (root) {
    root.CLARITY_CADDY_APP_STORE_URL = config.CLARITY_CADDY_APP_STORE_URL;
    root.clarityCaddyAppStoreUrl = config.appStoreUrl;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var DEFAULT_APP_STORE_URL = "https://apps.apple.com/nz/app/clarity-caddy/id6795475144";
  function appStoreUrl() {
    return (typeof process !== "undefined" && process.env && process.env.CLARITY_CADDY_APP_STORE_URL)
      || DEFAULT_APP_STORE_URL;
  }
  return {
    CLARITY_CADDY_APP_STORE_URL: appStoreUrl(),
    appStoreUrl: appStoreUrl
  };
});

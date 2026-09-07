/* One canonical store destination per platform, for every Clarity Caddy surface.
 *
 * This small UMD module deliberately works in both the static web app and
 * Netlify functions. Keep the listing URLs here; consumers must not duplicate
 * them in markup or email templates.
 *
 * Both listings are live. The Play URL is derived from the same applicationId the
 * Android bundle ships with (android/app/build.gradle) and the same package name
 * .well-known/assetlinks.json delegates link handling to - if one of those three
 * ever changes the others have to change with it, so they are worth reading
 * together rather than trusting this string alone. */
(function (root, factory) {
  var config = factory();
  if (typeof module === "object" && module.exports) module.exports = config;
  if (root) {
    root.CLARITY_CADDY_APP_STORE_URL = config.CLARITY_CADDY_APP_STORE_URL;
    root.CLARITY_CADDY_PLAY_STORE_URL = config.CLARITY_CADDY_PLAY_STORE_URL;
    root.clarityCaddyAppStoreUrl = config.appStoreUrl;
    root.clarityCaddyPlayStoreUrl = config.playStoreUrl;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var DEFAULT_APP_STORE_URL = "https://apps.apple.com/nz/app/clarity-caddy/id6795475144";
  var DEFAULT_PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.claritygolf.caddy";
  function env(name) {
    return (typeof process !== "undefined" && process.env && process.env[name]) || "";
  }
  function appStoreUrl() { return env("CLARITY_CADDY_APP_STORE_URL") || DEFAULT_APP_STORE_URL; }
  function playStoreUrl() { return env("CLARITY_CADDY_PLAY_STORE_URL") || DEFAULT_PLAY_STORE_URL; }
  return {
    CLARITY_CADDY_APP_STORE_URL: appStoreUrl(),
    CLARITY_CADDY_PLAY_STORE_URL: playStoreUrl(),
    appStoreUrl: appStoreUrl,
    playStoreUrl: playStoreUrl
  };
});

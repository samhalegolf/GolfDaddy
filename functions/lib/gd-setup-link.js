"use strict";

/* The password link that emails actually carry.
 *
 * Supabase's admin/generate_link hands back an `action_link` pointing at
 * <project>.supabase.co/auth/v1/verify?..., which 302s to our site. That works, but it costs
 * the app: iOS Universal Links and Android App Links only fire for the URL the user TAPPED,
 * never for a server-side redirect. So a player with Clarity installed still landed in a
 * browser, set their password in a different session from the app, and then had to sign in by
 * hand - while .well-known/apple-app-site-association, the applinks entitlement and the
 * autoVerify intent-filter all sat there unused, because nothing ever tapped our domain.
 *
 * The same response also carries `hashed_token`. Building the link ourselves puts it on
 * caddy.claritygolf.app - a domain both platforms have verified - so the tap opens the app,
 * gd-native-deep-links.js carries the parameters in, and clarity-supabase-auth.js exchanges
 * the token for a session with POST /auth/v1/verify. With no app installed the identical URL
 * opens the browser and behaves exactly as before.
 *
 * ALWAYS falls back to action_link. If Supabase ever moves or renames hashed_token the worst
 * case is the old browser-first behaviour, not an invite email nobody can act on.
 */

/* generate_link has returned these fields at the top level and under `properties` depending on
   the version; read both rather than betting on one. */
function field(generated, name) {
  if (!generated || typeof generated !== "object") return "";
  const props = generated.properties && typeof generated.properties === "object" ? generated.properties : null;
  const value = generated[name] || (props ? props[name] : "");
  return typeof value === "string" ? value : "";
}

function trimSite(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/* `routeParams` is what tells the shell which screen to open - claritySetPassword for the
   password form, clarityAccountSetup so it says "Set up account" rather than "Reset". They
   are the same flags the old redirect_to carried, so nothing downstream has to change. */
function buildSetupLink(generated, siteUrl, routeParams) {
  const site = trimSite(siteUrl);
  const actionLink = field(generated, "action_link") || field(generated, "actionLink");
  const hashedToken = field(generated, "hashed_token") || field(generated, "hashedToken");
  const type = field(generated, "verification_type") || field(generated, "verificationType") || "recovery";

  if (!site || !hashedToken) {
    return { link: actionLink, firstParty: false, reason: !site ? "no_site_url" : "no_hashed_token" };
  }
  const params = Object.assign({}, routeParams || {}, { token_hash: hashedToken, type: type });
  const query = Object.keys(params)
    .filter((key) => params[key] !== "" && params[key] != null)
    .map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])))
    .join("&");
  return { link: site + "/?" + query, firstParty: true, reason: "" };
}

module.exports = { buildSetupLink };

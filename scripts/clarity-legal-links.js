/* Terms of Use and Privacy Policy links.
 *
 * Apple guideline 3.1.2 requires an app that sells an auto-renewing subscription
 * to carry functional links to both documents in the purchase flow itself, not
 * only in App Store Connect metadata. Google Play asks for the same. A build
 * without them is a routine rejection, and the fix is cheap, so the links live
 * here rather than being pasted into each surface that needs them.
 *
 * The hrefs are RELATIVE on purpose. privacy.html and terms.html ship inside the
 * app bundle (clarity-deploy-build.js copies them into dist, and cap sync copies
 * dist into the shells), so tapping one is in-webview navigation to a local
 * file: it works with no signal, which matters on a course, and it never hands
 * off to an external browser. Both pages carry a "Back to Clarity Caddy" link
 * home. Do not "improve" these into absolute https:// links - that would break
 * the offline case and turn an internal document into an outbound one.
 */
(function () {
  "use strict";

  var LINKS = [
    { href: "terms.html", label: "Terms of Service", hint: "How paid access and renewals work" },
    { href: "privacy.html", label: "Privacy Policy", hint: "What we collect, and how to delete it" }
  ];

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  /* Markup for the payments screen. Kept inline-small so it reads as fine print
     under the purchase buttons rather than competing with them.
     ?from=membership makes the legal pages' back link return to the paywall
     (index.html?membership=1) instead of home - the pages are separate
     documents, so going "back" reboots the shell, and without the param the
     reader was dumped on the home screen with the paywall gone. */
  function markup() {
    var anchors = LINKS.map(function (link) {
      return '<a href="' + link.href + '?from=membership">' + link.label + '</a>';
    }).join(" · ");
    return '<div class="clarityPaymentLegal">' + anchors + '</div>';
  }

  /* Settings rows, mirroring how clarity-account-delete installs its own row:
     the menu is built lazily, so installation is re-run whenever a section is
     shown rather than assuming the list exists at load. */
  function installMenuRows() {
    var list = document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
    if (!list) return;
    var danger = document.getElementById("gdPlayerSettingsDeleteAccountRow");
    LINKS.forEach(function (link) {
      var id = "gdPlayerSettingsLegal-" + link.href.replace(/\W+/g, "-");
      if (document.getElementById(id)) return;
      var row = document.createElement("a");
      row.className = "gdPlayerSettingsRow";
      row.id = id;
      row.href = link.href;
      row.innerHTML = '<div><strong>' + link.label + '</strong><span>' + link.hint + '</span></div>';
      /* Legal links sit above "Delete account" so the destructive row stays last. */
      if (danger && danger.parentNode === list) list.insertBefore(row, danger);
      else list.appendChild(row);
    });
  }

  function boot() {
    installMenuRows();
    safe(function () {
      var original = window.gdPlayerSettingsShowSection;
      if (typeof original !== "function" || original.__clarityLegalWrapped) return;
      var wrapped = function () {
        var result = original.apply(this, arguments);
        installMenuRows();
        return result;
      };
      wrapped.__clarityLegalWrapped = true;
      window.gdPlayerSettingsShowSection = wrapped;
    });
  }

  window.ClarityLegalLinks = { markup: markup, install: installMenuRows };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

/* "You're set up - now get the app."
 *
 * A password link cannot install an app, so a brand-new player always finishes setup in a
 * browser. Until now that was the end of it: clearPasswordResetRoute() stripped the
 * parameters, dropped them into the web app, and nothing ever mentioned that Clarity Caddy is
 * a phone app they are meant to be holding on a golf course. They had to go back to the email
 * and find a badge.
 *
 * This is that prompt, shown at the one moment it is actually wanted - the password is saved
 * and the account is live. It is not a nag: it appears once per account per device, only on
 * the web, and never when the player is already inside the native app.
 *
 * Badge artwork and store URLs are the same ones the emails use
 * (clarity-caddy-app-store.js, assets/brand/*.png), so a store link changes in one place.
 */
(function () {
  "use strict";

  var SEEN_KEY = "clarity:app-download-prompt-seen:v1";
  var BADGE_HEIGHT = 47;

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }
  function isNative() {
    return !!safe(function () { return window.GDNative && window.GDNative.isNative; }, false);
  }
  function storeUrls() {
    return {
      apple: safe(function () { return window.CLARITY_CADDY_APP_STORE_URL; }, "") || "",
      play: safe(function () { return window.CLARITY_CADDY_PLAY_STORE_URL; }, "") || ""
    };
  }
  function alreadySeen() {
    return safe(function () { return localStorage.getItem(SEEN_KEY) === "1"; }, false);
  }
  function markSeen() {
    safe(function () { localStorage.setItem(SEEN_KEY, "1"); });
  }

  function badge(url, src, label, width) {
    return "<a href='" + url + "' target='_blank' rel='noopener' aria-label='" + label + "'"
      + " style='display:block;text-decoration:none'>"
      + "<img src='" + src + "' alt='" + label + "' width='" + width + "' height='" + BADGE_HEIGHT + "'"
      + " style='display:block;width:" + width + "px;height:" + BADGE_HEIGHT + "px;border:0'></a>";
  }

  /* Resolves when the player has moved on - dismissed, or opened a store. The caller awaits it
     before reloading, so the prompt is never yanked out from under them mid-tap. Resolves
     immediately when there is nothing to show, so it can be awaited unconditionally. */
  function show(options) {
    options = options || {};
    return new Promise(function (resolve) {
      var urls = storeUrls();
      if (isNative() || (!urls.apple && !urls.play) || (alreadySeen() && !options.force)) return resolve(false);
      if (document.getElementById("clarityAppDownloadPrompt")) return resolve(false);

      var badges = [];
      if (urls.apple) badges.push(badge(urls.apple, "/assets/brand/app-store-badge.png", "Download Clarity Caddy on the App Store", 159));
      if (urls.play) badges.push(badge(urls.play, "/assets/brand/google-play-badge.png", "Get Clarity Caddy on Google Play", 158));

      var host = document.createElement("div");
      host.id = "clarityAppDownloadPrompt";
      host.style.cssText = "position:fixed;inset:0;z-index:1000000;background:rgba(3,8,5,.92);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Arial,Helvetica,sans-serif;color:#fff";
      host.innerHTML = [
        "<div role='dialog' aria-modal='true' aria-labelledby='clarityAppDownloadTitle' style='width:min(420px,100%);background:#101b15;border:1px solid rgba(255,255,255,.16);border-radius:22px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.45)'>",
        "<div style='color:#42b66a;font-weight:900;letter-spacing:.12em;text-transform:uppercase;font-size:12px;margin-bottom:10px'>You're all set</div>",
        "<h1 id='clarityAppDownloadTitle' style='font-size:26px;line-height:1.1;margin:0 0 10px'>Get Clarity Caddy on your phone</h1>",
        "<p style='margin:0 0 18px;color:#c8d1cc;line-height:1.45'>Your password is saved and your account is live. Clarity Caddy is built to be used on the course — install it and sign in with this email address.</p>",
        "<div style='display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px'>" + badges.join("") + "</div>",
        "<button id='clarityAppDownloadDismiss' style='width:100%;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:transparent;color:#c8d1cc;font-weight:700;padding:12px 16px;font-size:14px'>Continue in this browser</button>",
        "</div>"
      ].join("");

      document.body.appendChild(host);
      markSeen();

      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        safe(function () { host.remove(); });
        resolve(value);
      }
      safe(function () { document.getElementById("clarityAppDownloadDismiss").onclick = function () { finish(false); }; });
      /* Opening a store leaves this tab in place; close the prompt behind them so returning
         does not land back on a modal they have already acted on. */
      safe(function () {
        host.querySelectorAll("a[href]").forEach(function (link) {
          link.addEventListener("click", function () { setTimeout(function () { finish(true); }, 400); });
        });
      });
    });
  }

  window.GDAppDownloadPrompt = {
    show: show,
    /* Exposed so the behaviour can be exercised without completing a real signup. */
    reset: function () { safe(function () { localStorage.removeItem(SEEN_KEY); }); }
  };
})();

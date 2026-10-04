/* Settings > Garmin Watch: choosing which Garmin the phone talks to.
 *
 * It is free. Like the Apple Watch, a Garmin only mirrors what the phone is
 * already doing, so it carries no paywall of its own: distances and the
 * Bubble reach the wrist for everyone, and anything that writes round history
 * (scorecard, shot logging) is still decided by app/js/access.js on the phone,
 * whichever surface the tap came from.
 *
 * WHY THIS PAGE EXISTS. The Garmin transport on both native platforms
 * (ios/App/App/Wearables/Garmin/GarminTransport.swift,
 * android/.../wearables/garmin/GarminTransport.java) acts on whatever device
 * GarminDeviceStore currently holds, and only ever on that one. Nothing was
 * choosing it: GarminDeviceStore.select() existed on both platforms with zero
 * callers, so activate() found no selected device and did nothing, forever.
 * This is the missing half.
 *
 * WHAT DOES NOT WORK YET, and is not pretended otherwise anywhere in this
 * file: the Connect IQ Mobile SDK is not bundled in either native build, so
 * `garminDevices` resolves { devices: [], sdkLinked: false, reason }. The page
 * words that as "cannot look" rather than "found none" — those are different
 * answers and a player deserves the real one. Every other part of the flow —
 * selection, persistence, state, disconnect — is real and runs today.
 */
(function () {
  "use strict";

  var SECTION = "garmin";
  var PAGE_ID = "gdPlayerSettingsGarminSection";
  var ROW_ID = "gdPlayerSettingsGarminRow";
  var LINE_ID = "gdPlayerSettingsGarminLine";
  var BODY_ID = "clarityGarminBody";

  var originalShowSection = null;
  var state = null;          /* last garminState() answer, or null before the first */
  var devices = null;        /* last garminDevices() answer, or null if never asked */
  var busy = false;

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function plugin() {
    return safe(function () {
      var cap = window.Capacitor;
      var p = cap && cap.Plugins && cap.Plugins.NativeRoundBridge;
      return (p && typeof p.garminState === "function") ? p : null;
    }, null);
  }

  /* Native-only. In a browser there is no plugin and this whole page is
     meaningless, so the row does not appear at all rather than appearing and
     failing. */
  function available() {
    return !!plugin();
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* ------------------------------------------------------------- native IO */

  function refreshState() {
    var p = plugin();
    if (!p) return Promise.resolve(null);
    return Promise.resolve(safe(function () { return p.garminState(); }, null))
      .then(function (next) { state = next || null; return state; })
      .catch(function () { state = null; return null; });
  }

  function selectedDevice() {
    return (state && state.selectedDevice) || null;
  }

  /* ------------------------------------------------------------- menu row */

  function L(key, vars) { return window.GDI18n.t(key, vars); }
  function H(key, vars) { return window.GDI18n.html(key, vars); }

  function menuList() {
    return document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
  }

  function installMenuRow() {
    if (!available()) return;
    var list = menuList();
    if (!list || document.getElementById(ROW_ID)) return;
    var row = document.createElement("button");
    row.className = "gdPlayerSettingsRow";
    row.id = ROW_ID;
    row.type = "button";
    row.onclick = function () { show(SECTION); };
    row.innerHTML = '<div><strong data-i18n="garmin.title">Garmin Watch</strong><span id="' + LINE_ID + '"></span></div>';
    window.GDI18n.apply(row);
    window.GDI18n.set(row.querySelector("#" + LINE_ID), "garmin.rowHint");
    /* Sits with the other device/access rows rather than among profile
       fields: after Access & Membership when clarity-payments has installed
       it, otherwise at the end. */
    var payRow = document.getElementById("gdPlayerSettingsPaymentsRow");
    var referralRow = document.getElementById("gdPlayerSettingsReferralRow");
    var anchor = referralRow || payRow;
    if (anchor && anchor.nextSibling) list.insertBefore(row, anchor.nextSibling);
    else list.appendChild(row);
    syncMenuRow();
  }

  function syncMenuRow() {
    var line = document.getElementById(LINE_ID);
    if (!line) return;
    var device = selectedDevice();
    if (!device) { window.GDI18n.set(line, "garmin.noWatchLine"); return; }
    window.GDI18n.set(line, state && state.reachable ? "garmin.deviceConnected" : "garmin.deviceNotConnected",
      { device: device.deviceName || L("garmin.defaultDevice") });
  }

  /* ----------------------------------------------------------- the page */

  function page() {
    var existing = document.getElementById(PAGE_ID);
    if (existing) return existing;
    var sheet = document.querySelector("#playerSettingsPanel .gdPlayerSettingsSheet");
    if (!sheet) return null;
    var panel = document.createElement("div");
    panel.className = "moduleCard gdPlayerSettingsSubPage";
    panel.id = PAGE_ID;
    panel.hidden = true;
    panel.innerHTML = [
      '<button class="gdPlayerSettingsSubBack" type="button" onclick="gdPlayerSettingsShowSection(&quot;menu&quot;)" data-i18n="garmin.backToSettings">‹ Settings</button>',
      '<strong data-i18n="garmin.title">Garmin Watch</strong>',
      '<span data-i18n="garmin.pageHint">Distances, your Bubble and shot logging on your wrist.</span>',
      '<div class="clarityPaymentSection" id="' + BODY_ID + '"></div>'
    ].join("");
    window.GDI18n.apply(panel);
    sheet.appendChild(panel);
    return panel;
  }

  function connectedHTML(device) {
    var reachable = !!(state && state.reachable);
    return [
      '<div class="clarityReferralHead"><strong>' + escapeHTML(device.deviceName || L("garmin.defaultDevice")) + "</strong>",
      "<span>" + H(reachable ? "garmin.connected" : "garmin.savedNotConnected") + "</span></div>",
      device.model ? "<p>" + escapeHTML(device.model) + "</p>" : "",
      /* appInstalled is a real answer from the SDK now, not a proxy for "the
         device is connected", so this only appears when the watch genuinely
         has no Clarity Caddy on it — the one case where telling someone to
         install it is useful rather than noise. It stays silent while we
         cannot tell (watch out of range), rather than nagging. */
      (state && state.reachable && state.appInstalled === false)
        ? "<p><strong>" + H("garmin.notInstalled") + "</strong> " + H("garmin.installHint") + "</p>"
        : "<p>" + H("garmin.startRound") + "</p>",
      '<div class="clarityPaymentActions">',
      '<button type="button" onclick="ClarityGarmin.disconnect()">' + H("garmin.disconnect") + '</button>',
      "</div>"
    ].join("");
  }

  function deviceListHTML() {
    if (!devices) return "";
    /* Three different answers, worded as three different things, because a
       player can act on two of them and not the third:
         sdkLinked false  -> this build cannot talk to Garmin at all
         a reason         -> we tried and could not look (Garmin Connect not
                             ready, service unreachable)
         empty list       -> we looked and there is nothing paired
       Collapsing the middle one into "none found" sends people to re-pair a
       watch that was never the problem. */
    if (devices.sdkLinked === false) {
      return [
        "<p><strong>" + H("garmin.notInBuild") + "</strong></p>",
        "<p>" + escapeHTML(devices.reason || L("garmin.notBundled")) + "</p>"
      ].join("");
    }
    /* iOS cannot list paired watches in-process — there is no equivalent of
       Android's getKnownDevices(). Choosing one means leaving for the Garmin
       Connect app and being handed back through a URL scheme, so there is
       never a list to draw here: the phone has already switched away by the
       time this renders, and the answer arrives as a state change. Saying
       "no watches found" in that moment would be both wrong and alarming. */
    if (devices.handoff) {
      return "<p>" + escapeHTML(devices.reason || L("garmin.chooseInConnectApp")) + "</p>";
    }
    var list = (devices.devices || []);
    if (devices.reason) {
      return "<p>" + escapeHTML(devices.reason) + "</p>";
    }
    if (!list.length) {
      return "<p>" + H("garmin.noneFound") + "</p>";
    }
    return list.map(function (device) {
      var id = escapeHTML(device.deviceId);
      var name = escapeHTML(device.deviceName || L("garmin.defaultDevice"));
      var model = escapeHTML(device.model || "");
      /* A watch that is paired but out of range is still the watch they want
         to pick, so it stays selectable and just says where it stands. */
      var sub = L(device.connected ? "garmin.rowConnected" : "garmin.rowNotConnected");
      if (model) sub = L("garmin.rowModel", { model: device.model, status: sub });
      return '<button class="gdPlayerSettingsRow" type="button" onclick="ClarityGarmin.choose(&quot;' + id +
        '&quot;,&quot;' + name + '&quot;,&quot;' + model + '&quot;)">' +
        "<div><strong>" + name + "</strong><span>" + escapeHTML(sub) + "</span></div></button>";
    }).join("");
  }

  /* On iOS the button leaves the app, so it should say so rather than
     implying an in-app scan. selectionStyle comes from the native state. */
  function connectLabel() {
    return H((state && state.selectionStyle === "handoff") ? "garmin.chooseInConnect" : "garmin.connectWatch");
  }

  function disconnectedHTML() {
    return [
      '<div class="clarityReferralHead"><strong>' + H("garmin.noWatchTitle") + '</strong>',
      "<span>" + H("garmin.noWatchHint") + "</span></div>",
      '<div class="clarityPaymentActions">',
      '<button type="button" onclick="ClarityGarmin.scan()"' + (busy ? " disabled" : "") + ">" +
        (busy ? H("garmin.looking") : connectLabel()) + "</button>",
      "</div>",
      deviceListHTML()
    ].join("");
  }

  function render() {
    syncMenuRow();
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    var device = selectedDevice();
    body.innerHTML = device ? connectedHTML(device) : disconnectedHTML();
  }

  /* --------------------------------------------------------------- actions */

  function scan() {
    var p = plugin();
    if (!p || typeof p.garminDevices !== "function") return false;
    busy = true;
    render();
    Promise.resolve(safe(function () { return p.garminDevices(); }, null))
      .then(function (answer) { devices = answer || { devices: [], sdkLinked: false }; })
      .catch(function () { devices = { devices: [], sdkLinked: false, reason: L("garmin.couldNotLook") }; })
      .then(function () { busy = false; render(); });
    return false;
  }

  function choose(deviceId, deviceName, model) {
    var p = plugin();
    if (!p || typeof p.selectGarminDevice !== "function") return false;
    Promise.resolve(safe(function () {
      return p.selectGarminDevice({ deviceId: deviceId, deviceName: deviceName, model: model });
    }, null))
      .then(function (next) {
        state = next || state;
        devices = null;
        render();
        safe(function () { return window.toast && window.toast(L("garmin.watchConnected")); });
      })
      .catch(function () {
        safe(function () { return window.toast && window.toast(L("garmin.couldNotConnect")); });
      });
    return false;
  }

  function disconnect() {
    var p = plugin();
    if (!p || typeof p.clearGarminDevice !== "function") return false;
    Promise.resolve(safe(function () { return p.clearGarminDevice(); }, null))
      .then(function (next) { state = next || null; devices = null; render(); })
      .catch(function () {});
    return false;
  }

  /* ------------------------------------------------ settings-panel wiring

     Same approach clarity-payments.js uses: wrap the base section switcher.
     It only knows its own sections, so an unknown name hides the menu and
     every page it owns — exactly the blank canvas this page needs. */
  function show(name) {
    if (originalShowSection) originalShowSection(name);
    var panel = page();
    var menu = document.getElementById("gdPlayerSettingsMenu");
    var mine = name === SECTION;
    if (panel) panel.hidden = !mine;
    if (mine) {
      if (menu) menu.hidden = true;
      devices = null;
      refreshState().then(render);
    }
    return false;
  }

  /* WRAPPING ORDER IS LOAD-BEARING — read before moving this.

     clarity-payments.js's install() re-captures whatever
     window.gdPlayerSettingsShowSection currently is whenever that is not its
     own showSection, and it runs again on every clarity:session-changed. So
     if this module wraps AFTER payments has installed, payments' next
     install captures *this* wrapper as its "original" while this wrapper is
     still holding payments' — the two then call each other until the stack
     blows. That is not hypothetical; it is what happened the first time this
     was written, on the very first click.

     The fix is order, not defence: wrap synchronously at DOMContentLoaded,
     which is strictly before payments' own 150ms timer. Payments then wraps
     us, its guard never fires again, and the chain is
     payments -> this -> base, which terminates. Wrapping is also done exactly
     once (guarded on the marker below), so no later caller can re-enter the
     cycle by calling install() again.

     The switcher is wrapped unconditionally, even with no plugin present: it
     is inert without the menu row, and deferring it to the same late timer as
     the row would put us back on the wrong side of payments. */
  function installSwitcher() {
    if (show.__clarityGarminWrapped) return;
    var current = window.gdPlayerSettingsShowSection;
    if (typeof current !== "function") return;
    if (current.__clarityGarminWrapped) return;
    originalShowSection = current;
    show.__clarityGarminWrapped = true;
    window.gdPlayerSettingsShowSection = show;
  }

  /* The row. Deliberately later than the switcher: it wants
     clarity-payments' own menu row to exist so it can sit beneath it. */
  function install() {
    if (!available()) return;
    installMenuRow();
    refreshState().then(syncMenuRow);
  }

  window.ClarityGarmin = {
    /* Exposed so the row can be put back if the settings sheet is ever
       rebuilt under us, and so this module is testable without a device. */
    install: install,
    scan: scan,
    choose: choose,
    disconnect: disconnect,
    render: render,
    state: function () { return state; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      installSwitcher();          /* before payments' 150ms timer — see above */
      setTimeout(install, 400);
    });
  } else {
    installSwitcher();
    setTimeout(install, 400);
  }
  /* The page body is drawn from template strings: redraw it in the new words. */
  safe(function () {
    window.GDI18n.onChange(function () {
      var panel = document.getElementById(PAGE_ID);
      if (panel && !panel.hidden) render();
    });
  });
})();

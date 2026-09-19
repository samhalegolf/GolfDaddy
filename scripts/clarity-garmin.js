/* Settings > Garmin Watch: choosing which Garmin the phone talks to, and the
 * paid gate on doing it at all.
 *
 * WHY THIS PAGE EXISTS. The Garmin transport on both native platforms
 * (ios/App/App/Wearables/Garmin/GarminTransport.swift,
 * android/.../wearables/garmin/GarminTransport.java) acts on whatever device
 * GarminDeviceStore currently holds, and only ever on that one. Nothing was
 * choosing it: GarminDeviceStore.select() existed on both platforms with zero
 * callers, so activate() found no selected device and did nothing, forever.
 * This is the missing half.
 *
 * WHERE THE PAID LINE IS. Two gates, deliberately, because a settings row is
 * not a security boundary:
 *
 *   1. Here, in the UI — "Connect a Watch" asks ClarityPayments.requireAccess,
 *      which toasts and opens the paywall when there is no active access. This
 *      is the polite one, and it is the only one a player ever sees.
 *   2. In the native transport — send() refuses outright while its `entitled`
 *      flag is false, so nothing reaches a Garmin regardless of what the web
 *      layer believes or how it was reached. setEntitlement() below is what
 *      raises it, and it defaults to FALSE on both platforms: the feature
 *      fails closed if this file never loads.
 *
 * The page itself is readable without a membership on purpose. A feature
 * nobody can see is a feature nobody buys, and App Store guideline 5.1.1(v)
 * is about account-gating things that are not account based — this one
 * genuinely is, so showing the locked state and the price is the honest
 * arrangement. What it will not do without access is pair.
 *
 * A LAPSE DOES NOT UNPAIR. The chosen device survives a membership ending and
 * starts working again the moment access returns. Forcing a re-pair after
 * every billing hiccup would be its own bug, so the native side keeps the
 * selection and only stops sending.
 *
 * WHAT DOES NOT WORK YET, and is not pretended otherwise anywhere in this
 * file: the Connect IQ Mobile SDK is not bundled in either native build, so
 * `garminDevices` resolves { devices: [], sdkLinked: false, reason }. The page
 * words that as "cannot look" rather than "found none" — those are different
 * answers and a player deserves the real one. Every other part of the flow —
 * gating, selection, persistence, state, disconnect — is real and runs today.
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
  var lastEntitlementSent = null;

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

  function payments() {
    return safe(function () { return window.ClarityPayments || null; }, null);
  }

  function hasAccess() {
    var pay = payments();
    if (!pay || typeof pay.hasActiveAccess !== "function") return false;
    return !!safe(function () { return pay.hasActiveAccess(); }, false);
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* ------------------------------------------------------ entitlement push

     The native flag is the gate that actually bites, so it has to track the
     membership answer rather than being set once at boot. There is no
     payments-status event to subscribe to, so this is re-asserted at every
     moment the answer can plausibly have changed: boot, a session change, the
     app coming back to the foreground, and any render of this page. Each push
     is skipped when the answer has not moved, so the common case costs
     nothing. */
  function setEntitlement(force) {
    var p = plugin();
    if (!p || typeof p.setGarminEnabled !== "function") return;
    var enabled = hasAccess();
    if (!force && lastEntitlementSent === enabled) return;
    lastEntitlementSent = enabled;
    safe(function () { return p.setGarminEnabled({ enabled: enabled }); });
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
    row.innerHTML = '<div><strong>Garmin Watch</strong><span id="' + LINE_ID + '">Play from your wrist.</span></div>';
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
    if (!hasAccess()) { line.textContent = "Membership required."; return; }
    if (!device) { line.textContent = "No watch connected."; return; }
    line.textContent = (device.deviceName || "Garmin watch") +
      (state && state.reachable ? " — connected" : " — not connected");
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
      '<button class="gdPlayerSettingsSubBack" type="button" onclick="gdPlayerSettingsShowSection(&quot;menu&quot;)">‹ Settings</button>',
      "<strong>Garmin Watch</strong>",
      "<span>Distances, your Bubble and shot logging on your wrist.</span>",
      '<div class="clarityPaymentSection" id="' + BODY_ID + '"></div>'
    ].join("");
    sheet.appendChild(panel);
    return panel;
  }

  function lockedHTML() {
    var label = safe(function () {
      var pay = payments();
      return pay && pay.accessLabel ? pay.accessLabel() : "";
    }, "");
    return [
      '<div class="clarityReferralHead"><strong>Membership required</strong>',
      "<span>Playing from a Garmin watch is part of a Clarity membership. ",
      "The rangefinder on your phone stays free.</span></div>",
      label ? "<p>" + escapeHTML(label) + "</p>" : "",
      '<div class="clarityPaymentActions">',
      '<button type="button" onclick="ClarityGarmin.openMembership()">See Membership</button>',
      "</div>"
    ].join("");
  }

  function connectedHTML(device) {
    var reachable = !!(state && state.reachable);
    return [
      '<div class="clarityReferralHead"><strong>' + escapeHTML(device.deviceName || "Garmin watch") + "</strong>",
      "<span>" + (reachable ? "Connected." : "Saved, but not currently connected.") + "</span></div>",
      device.model ? "<p>" + escapeHTML(device.model) + "</p>" : "",
      /* Said plainly rather than left for the player to discover by the map
         staying blank. Both are real, current limitations. */
      "<p>Install Clarity Caddy on the watch from the Connect IQ store, then start a round on your phone.</p>",
      '<div class="clarityPaymentActions">',
      '<button type="button" onclick="ClarityGarmin.disconnect()">Disconnect</button>',
      "</div>"
    ].join("");
  }

  function deviceListHTML() {
    if (!devices) return "";
    if (devices.sdkLinked === false) {
      return [
        "<p><strong>Not available in this build.</strong></p>",
        "<p>" + escapeHTML(devices.reason || "Garmin support is not bundled in this build yet.") + "</p>"
      ].join("");
    }
    var list = (devices.devices || []);
    if (!list.length) {
      return "<p>No Garmin watches found. Open the Garmin Connect app, make sure your watch is paired there, then try again.</p>";
    }
    return list.map(function (device) {
      var id = escapeHTML(device.deviceId);
      var name = escapeHTML(device.deviceName || "Garmin watch");
      var model = escapeHTML(device.model || "");
      return '<button class="gdPlayerSettingsRow" type="button" onclick="ClarityGarmin.choose(&quot;' + id +
        '&quot;,&quot;' + name + '&quot;,&quot;' + model + '&quot;)">' +
        "<div><strong>" + name + "</strong><span>" + (model || "Tap to connect") + "</span></div></button>";
    }).join("");
  }

  function disconnectedHTML() {
    return [
      '<div class="clarityReferralHead"><strong>No watch connected</strong>',
      "<span>Connect a Garmin to see distances and your Bubble on your wrist.</span></div>",
      '<div class="clarityPaymentActions">',
      '<button type="button" onclick="ClarityGarmin.scan()"' + (busy ? " disabled" : "") + ">" +
        (busy ? "Looking…" : "Connect a Watch") + "</button>",
      "</div>",
      deviceListHTML()
    ].join("");
  }

  function render() {
    setEntitlement(false);
    syncMenuRow();
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    if (!hasAccess()) { body.innerHTML = lockedHTML(); return; }
    var device = selectedDevice();
    body.innerHTML = device ? connectedHTML(device) : disconnectedHTML();
  }

  /* --------------------------------------------------------------- actions */

  /* The membership question, asked once and in one place. requireAccess
     toasts and opens the paywall itself when the answer is no, so callers
     only have to stop. */
  function requireAccess() {
    var pay = payments();
    if (!pay || typeof pay.requireAccess !== "function") return hasAccess();
    return !!pay.requireAccess("use a Garmin watch");
  }

  function scan() {
    if (!requireAccess()) return false;
    var p = plugin();
    if (!p || typeof p.garminDevices !== "function") return false;
    busy = true;
    render();
    Promise.resolve(safe(function () { return p.garminDevices(); }, null))
      .then(function (answer) { devices = answer || { devices: [], sdkLinked: false }; })
      .catch(function () { devices = { devices: [], sdkLinked: false, reason: "Could not look for watches." }; })
      .then(function () { busy = false; render(); });
    return false;
  }

  function choose(deviceId, deviceName, model) {
    if (!requireAccess()) return false;
    var p = plugin();
    if (!p || typeof p.selectGarminDevice !== "function") return false;
    Promise.resolve(safe(function () {
      return p.selectGarminDevice({ deviceId: deviceId, deviceName: deviceName, model: model });
    }, null))
      .then(function (next) {
        state = next || state;
        devices = null;
        /* Raise the native gate immediately rather than waiting for the next
           sync: the player has just paid for this and pressed the button. */
        setEntitlement(true);
        render();
        safe(function () { return window.toast && window.toast("Watch connected."); });
      })
      .catch(function () {
        safe(function () { return window.toast && window.toast("Could not connect that watch."); });
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

  function openMembership() {
    var pay = payments();
    if (pay && typeof pay.openPaywall === "function") pay.openPaywall();
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

  /* The row, and the first entitlement push. Deliberately later than the
     switcher: this one wants clarity-payments' own menu row to exist so it can
     sit beneath it, and wants a loaded membership status so the first push is
     the real answer rather than a default. */
  function install() {
    if (!available()) return;
    installMenuRow();
    refreshState().then(function () { setEntitlement(true); syncMenuRow(); });
  }

  window.ClarityGarmin = {
    /* Exposed so the row can be put back if the settings sheet is ever
       rebuilt under us, and so this module is testable without a device. */
    install: install,
    scan: scan,
    choose: choose,
    disconnect: disconnect,
    openMembership: openMembership,
    render: render,
    state: function () { return state; },
    /* Callable by anything that changes the membership answer. Harmless to
       over-call: it only crosses the bridge when the answer has moved. */
    syncEntitlement: function () { setEntitlement(false); }
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
  window.addEventListener("clarity:session-changed", function () {
    lastEntitlementSent = null;
    setEntitlement(true);
    syncMenuRow();
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) setEntitlement(false);
  });
})();

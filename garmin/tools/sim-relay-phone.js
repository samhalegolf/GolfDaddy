/* The phone half of the simulator relay. Evaluated INSIDE the Clarity app's
   WebView by tools/sim-relay.js over the Chrome DevTools protocol; never
   shipped, never loaded by the app itself.

   It defines one function, window.__simRelayDeliver(message), which takes a
   dictionary exactly as the watch app transmitted it ({command}, {watchMapHave}
   or {watchPlayerHave}) and does what app/js/native-round-bridge.js does when
   the native plugin fires the matching event - the same receiveCommand, the
   same acknowledgement shape, the same inventory notes. The acknowledgement
   still goes out through the real native plugin, so the wrist receives it over
   the tether: only the watch -> phone hop is replaced, because that is the hop
   the simulator cannot make. */
(function () {
  "use strict";
  var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeRoundBridge;
  var handled = 0;

  window.__simRelayDeliver = function (message) {
    var app = window.ClarityApp;
    var watch = app && app.caddyWatch;
    if (!message || !watch) return { ok: false, reason: watch ? "empty message" : "no watch bridge on this page" };
    handled += 1;

    if (message.command) {
      var command = message.command;
      var result = watch.receiveCommand(command);
      if (command.commandId && plugin && typeof plugin.acknowledgeCommand === "function") {
        try {
          plugin.acknowledgeCommand({ acknowledgement: {
            commandId: command.commandId,
            accepted: result.accepted === true,
            reason: result.reason || null,
            revision: result.revision == null ? null : result.revision
          } });
        } catch (e) {}
      }
      return { ok: true, kind: "command", type: command.type, accepted: result.accepted === true, reason: result.reason || null, active: watch.scene().surface.active };
    }
    if (message.watchMapHave) {
      var delivery = window.GDWatchMapDelivery;
      if (delivery && typeof delivery.noteInventory === "function") delivery.noteInventory(message.watchMapHave);
      return { ok: true, kind: "watchMapHave", holes: (message.watchMapHave.holes || []).length };
    }
    if (message.watchPlayerHave) {
      var player = window.GDWatchPlayerDelivery;
      if (player && typeof player.noteInventory === "function") player.noteInventory(message.watchPlayerHave);
      return { ok: true, kind: "watchPlayerHave" };
    }
    return { ok: false, reason: "unknown message keys " + Object.keys(message).join(",") };
  };
  window.__simRelayStats = function () { return { handled: handled, page: location.pathname, round: (window.ClarityApp && ClarityApp.caddyWatch && ClarityApp.caddyWatch.scene().roundId) || null }; };
})();

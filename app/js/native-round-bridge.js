/* The web half of NativeRoundBridge.

   This adapter is intentionally thin: it serialises the latest portable
   CaddyWatchScene for native consumers and returns native Watch commands to
   the shared command gate. It is inert in browsers and does not own an outbox;
   WatchConnectivity owns durable delivery on iOS. */
(function (window) {
  "use strict";
  var bridge = window.GDNativeRoundBridge = window.GDNativeRoundBridge || {};
  bridge.attach = function (watch) {
    if (!watch || typeof watch.onScene !== "function") return false;
    function publish(scene) {
      var cap = window.Capacitor;
      var plugin = cap && cap.Plugins && cap.Plugins.NativeRoundBridge;
      if (!plugin || typeof plugin.publishScene !== "function") return false;
      try { plugin.publishScene({ scene: scene }); return true; } catch (e) { return false; }
    }
    watch.onScene(publish);
    publish(watch.scene());
    var cap = window.Capacitor;
    var plugin = cap && cap.Plugins && cap.Plugins.NativeRoundBridge;
    if (plugin && typeof plugin.addListener === "function") {
      try {
        plugin.addListener("watchCommand", function (event) {
          var command = event && event.command;
          var result = watch.receiveCommand(command);
          if (!command || !command.commandId || typeof plugin.acknowledgeCommand !== "function") return;
          try {
            plugin.acknowledgeCommand({ acknowledgement: {
              commandId: command.commandId,
              accepted: result.accepted === true,
              reason: result.reason || null,
              revision: result.revision == null ? null : result.revision
            } });
          } catch (e) {}
        });
      } catch (e) {}
    }
    bridge.receiveCommand = function (command) { return watch.receiveCommand(command); };
    return true;
  };
})(window);

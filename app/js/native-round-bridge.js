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
    /* A round tells us which course is in play; that is the cue to get its
       baked Watch maps onto the wrist. Driven off the Scene stream rather than
       round start so it also covers a resumed round and a late-registering
       native plugin. The delivery module is idempotent per course, so calling
       it on every Scene costs one object lookup. */
    function deliverMaps(scene) {
      var key = scene && scene.course && scene.course.key;
      if (!key || !window.GDWatchMapDelivery) return;
      try { window.GDWatchMapDelivery.deliver(key); } catch (e) {}
    }

    /* The bag and the saved My Bubble, so the wrist can size a Bubble without
       asking. Driven off the Scene stream for the same reasons the maps are -
       it covers a resumed round and a late-registering plugin - and the module
       is a fingerprint compare when nothing has changed, which is most Scenes. */
    function deliverPlayer() {
      if (!window.GDWatchPlayerDelivery) return;
      try { window.GDWatchPlayerDelivery.deliver(); } catch (e) {}
    }

    watch.onScene(function (scene) { publish(scene); deliverMaps(scene); deliverPlayer(); });
    publish(watch.scene());
    deliverMaps(watch.scene());
    deliverPlayer();

    /* A bag edit or a My Bubble save mid-round must not wait for the player to
       change something else. my-bubble.js already broadcasts an adopted aim;
       clearing the delivery's note makes the next Scene re-publish. */
    if (window.ClarityApp && window.ClarityApp.myBubble && typeof window.ClarityApp.myBubble.onChange === "function") {
      window.ClarityApp.myBubble.onChange(function () {
        if (window.GDWatchPlayerDelivery) { try { window.GDWatchPlayerDelivery.invalidate(); } catch (e) {} }
        deliverPlayer();
      });
    }
    var cap = window.Capacitor;
    var plugin = cap && cap.Plugins && cap.Plugins.NativeRoundBridge;
    /* Whether there is a Watch to hand over to at all. Native reports it on
       activation and on every reachability/pairing change; the answer rides
       the Scene so the phone's Send to Watch and the wrist's status strip read
       the same fact. Absent on web, so the handover UI simply never appears. */
    if (plugin && typeof watch.setWatchState === "function") {
      var applyWatchState = function (state) { try { watch.setWatchState(state || {}); } catch (e) {} };
      if (typeof plugin.addListener === "function") {
        try { plugin.addListener("watchState", applyWatchState); } catch (e) {}
      }
      if (typeof plugin.watchState === "function") {
        try { plugin.watchState().then(applyWatchState, function () {}); } catch (e) {}
      }
    }
    /* How much of the course is on the wrist rides the Scene too, so the
       phone's handover card and the Watch's Receiving face count the same
       holes. The delivery module counts what it sends; the Watch's own
       inventory report, relayed by native, overrides that count. */
    var delivery = window.GDWatchMapDelivery;
    if (delivery && typeof delivery.onProgress === "function" && typeof watch.setWatchMaps === "function") {
      delivery.onProgress(function (progress) { try { watch.setWatchMaps(progress); } catch (e) {} });
    }
    if (plugin && delivery && typeof delivery.noteInventory === "function" && typeof plugin.addListener === "function") {
      try {
        plugin.addListener("watchMapInventory", function (event) { delivery.noteInventory(event && event.inventory); });
      } catch (e) {}
    }
    /* What the wrist says it already holds, so an unchanged bag is never
       re-sent. Losing this report costs one re-send, never correctness. */
    if (plugin && typeof plugin.addListener === "function" && window.GDWatchPlayerDelivery) {
      try {
        plugin.addListener("watchPlayerInventory", function (event) {
          window.GDWatchPlayerDelivery.noteInventory(event && event.inventory);
          deliverPlayer();
        });
      } catch (e) {}
    }
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

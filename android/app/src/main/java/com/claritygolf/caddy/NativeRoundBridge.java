package com.claritygolf.caddy;

import com.claritygolf.caddy.wearables.garmin.GarminDeviceStore;
import com.claritygolf.caddy.wearables.garmin.GarminTransport;
import com.claritygolf.caddy.wearables.garmin.JsonBridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Map;

/*
 NativeRoundBridge is Android's half of the native boundary for active-round
 consumers — the Capacitor plugin JavaScript already calls uniformly on
 every platform (app/js/native-round-bridge.js, watch-map-delivery.js,
 watch-player-delivery.js). It does not interpret golf rules: JavaScript
 Marshal validates every command and publishes the portable CaddyWatchScene.

 Unlike iOS's NativeRoundBridge — which was refactored to sit above a
 WearableCoordinator that can hold both an AppleWatchTransport and a
 GarminTransport — this talks to GarminTransport DIRECTLY. Android's only
 wearable target is Garmin (see the Garmin-on-Android scope note this
 project's memory records): there is nothing for a coordinator to arbitrate
 between, so that indirection is not built here. If Android ever gains a
 second wearable target, introducing a coordinator at that point is a known
 move, not a redesign — see WearableCoordinator.swift for the shape to copy.

 This plugin does:
   - receive a Capacitor call
   - validate required top-level input
   - convert JSObject/JSArray to plain Map/List (JsonBridge) so GarminTransport
     never depends on Capacitor types
   - forward to GarminTransport
   - resolve the Capacitor call
   - publish incoming GarminTransport events to JavaScript

 GarminTransport itself is currently an inert, safe stub — see its own
 header comment and garmin/README.md. This plugin compiles and resolves
 every call correctly today; it simply cannot yet reach a real Garmin
 device, because the Connect IQ Mobile SDK for Android is not vendored in
 this repo.
*/
@CapacitorPlugin(name = "NativeRoundBridge")
public class NativeRoundBridge extends Plugin implements GarminTransport.Listener {

    // Must always equal garmin/manifest.xml's <iq:application id="...">
    // once that placeholder is replaced — this is what scopes a message to
    // Caddy specifically among any other Connect IQ apps a paired device
    // might have installed.
    private static final String CONNECT_IQ_APP_ID = "GARMIN-APP-ID-PLACEHOLDER";

    private GarminTransport transport;

    /* The last inventory each side reported. Only a hint, exactly as on
       iOS: JavaScript uses it to skip re-sending a package/bag the wrist
       already has, and sending everything again is always a correct
       fallback. */
    private Map<String, Object> watchMapInventoryReport;
    private Map<String, Object> watchPlayerInventoryReport;

    @Override
    public void load() {
        GarminDeviceStore deviceStore = new GarminDeviceStore(getContext());
        transport = new GarminTransport(getContext(), deviceStore, CONNECT_IQ_APP_ID);
        transport.setListener(this);
        transport.activate();
    }

    @PluginMethod
    public void publishScene(PluginCall call) {
        JSObject scene = call.getObject("scene");
        if (scene == null) {
            call.reject("A CaddyWatchScene is required");
            return;
        }
        transport.publishScene(JsonBridge.toMap(scene), published -> {
            JSObject result = new JSObject();
            if (published) {
                result.put("published", true);
            } else {
                result.put("published", false);
                result.put("queuedForReconciliation", true);
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void publishWatchMap(PluginCall call) {
        JSObject manifest = call.getObject("manifest");
        if (manifest == null) {
            call.reject("A Watch map manifest is required");
            return;
        }
        transport.publishMapManifest(JsonBridge.toMap(manifest), published -> {
            JSObject result = new JSObject();
            result.put("published", published);
            call.resolve(result);
        });
    }

    /* Android/Garmin never receives map imagery as pushed bytes — Garmin
       pulls each hole raster by URL (see garmin/GarminMapDownloader.mc's
       header comment: there is no public Monkey C API for decoding an
       arbitrary byte buffer the app assembled itself, but
       Communications.makeImageRequestWithDictionary decodes a fetched URL
       directly). This method still has to exist and resolve successfully,
       though: app/js/watch-map-delivery.js gates its ENTIRE native map
       delivery — including publishWatchMap, which Garmin does need for its
       manifest — on both publishWatchMap AND publishWatchMapAsset being
       present as functions. Omitting this method would silently break
       manifest delivery too, not just asset delivery. */
    @PluginMethod
    public void publishWatchMapAsset(PluginCall call) {
        String courseKey = call.getString("courseKey");
        String asset = call.getString("asset");
        String base64 = call.getString("base64");
        if (courseKey == null || courseKey.isEmpty() || asset == null || asset.isEmpty()
                || base64 == null || base64.isEmpty()) {
            call.reject("A Watch map asset requires courseKey, asset and base64 bytes");
            return;
        }
        JSObject result = new JSObject();
        result.put("sent", false);
        call.resolve(result);
    }

    @PluginMethod
    public void watchMapInventory(PluginCall call) {
        JSObject result = new JSObject();
        result.put("inventory", watchMapInventoryReport == null ? null : JsonBridge.toJSObject(watchMapInventoryReport));
        call.resolve(result);
    }

    @PluginMethod
    public void publishWatchPlayer(PluginCall call) {
        JSObject player = call.getObject("player");
        if (player == null) {
            call.reject("A Watch player snapshot is required");
            return;
        }
        transport.publishPlayer(JsonBridge.toMap(player), published -> {
            JSObject result = new JSObject();
            result.put("published", published);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void watchPlayerInventory(PluginCall call) {
        JSObject result = new JSObject();
        result.put("inventory", watchPlayerInventoryReport == null ? null : JsonBridge.toJSObject(watchPlayerInventoryReport));
        call.resolve(result);
    }

    @PluginMethod
    public void watchState(PluginCall call) {
        call.resolve(stateAsJSObject());
    }

    /* This is the only authoritative acknowledgement path. Native transport
       does not infer success: JavaScript returns the result after Marshal
       has accepted or rejected the command. */
    @PluginMethod
    public void acknowledgeCommand(PluginCall call) {
        JSObject acknowledgement = call.getObject("acknowledgement");
        if (acknowledgement == null || acknowledgement.getString("commandId") == null) {
            call.reject("A command acknowledgement is required");
            return;
        }
        transport.acknowledge(JsonBridge.toMap(acknowledgement), () -> call.resolve());
    }

    // -------------------------------------------------- GarminTransport.Listener

    @Override
    public void onCommandReceived(Map<String, Object> command) {
        // JavaScript applies the generic command through its deduplicating
        // CaddyWatchBridge. Matches NativeRoundBridge.swift's watchCommand
        // event exactly, including retainUntilConsumed(true) — a command
        // that arrives before JavaScript has attached its listener must not
        // be dropped.
        JSObject data = new JSObject();
        data.put("command", JsonBridge.toJSObject(command));
        notifyListeners("watchCommand", data, true);
    }

    @Override
    public void onMapInventoryReceived(Map<String, Object> inventory) {
        watchMapInventoryReport = inventory;
        JSObject data = new JSObject();
        data.put("inventory", JsonBridge.toJSObject(inventory));
        notifyListeners("watchMapInventory", data, false);
    }

    @Override
    public void onPlayerInventoryReceived(Map<String, Object> inventory) {
        watchPlayerInventoryReport = inventory;
        JSObject data = new JSObject();
        data.put("inventory", JsonBridge.toJSObject(inventory));
        notifyListeners("watchPlayerInventory", data, false);
    }

    @Override
    public void onStateChanged() {
        notifyListeners("watchState", stateAsJSObject(), false);
    }

    private JSObject stateAsJSObject() {
        GarminTransport.State state = transport.state();
        JSObject result = new JSObject();
        result.put("supported", state.supported);
        result.put("activated", state.activated);
        result.put("paired", state.paired);
        result.put("appInstalled", state.appInstalled);
        result.put("reachable", state.reachable);
        return result;
    }
}

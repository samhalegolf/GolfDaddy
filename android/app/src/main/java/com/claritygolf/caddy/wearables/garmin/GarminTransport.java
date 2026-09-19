package com.claritygolf.caddy.wearables.garmin;

import android.content.Context;
import java.util.Map;

/**
 * UNVERIFIED Connect IQ Mobile SDK calls — see below. NOW CALLED from
 * {@link com.claritygolf.caddy.NativeRoundBridge}, Android's Capacitor
 * plugin (built after this class, in a later session — see the
 * Garmin-on-Android scope note this repo's memory records for why Android
 * has no WearableCoordinator-style indirection above this transport).
 *
 * Everything referencing the Connect IQ Mobile SDK for Android below
 * ({@code com.garmin.android.connectiq.ConnectIQ}/{@code IQDevice}/
 * {@code IQApp}) is commented out and written against this session's best
 * understanding of that SDK's public shape — a singleton-ish
 * {@code ConnectIQ.getInstance(context, ConnectIQ.IQConnectType)}, an
 * {@code IQDevice} for a paired device, an {@code IQApp} scoping a message to
 * one installed watch app, and listener interfaces for device/app events and
 * send results. It has NOT been checked against the actual SDK, which is not
 * vendored in this repo (no Maven coordinate is declared in
 * android/app/build.gradle) — obtain it from Garmin's developer portal
 * before uncommenting anything here. Because the SDK-specific code stays
 * commented, this file compiles as an inert stub today and will not break
 * the existing Android build, which auto-includes every .java file under
 * src/main/java.
 *
 * Mirrors GarminTransport.swift's responsibilities and — per the
 * Garmin-on-Android scope note — talks directly to whatever calls it, with
 * no WearableCoordinator-style indirection: Android has exactly one
 * wearable target, so that abstraction (built for iOS to arbitrate Apple
 * Watch vs Garmin) has nothing to arbitrate here.
 *
 * Does NOT implement a bytes-over-the-wire map asset path, for the same
 * reason GarminTransport.swift does not: Garmin pulls hole imagery by URL
 * (see garmin/GarminMapDownloader.mc's header comment) rather than
 * receiving pushed bytes, so publishMapManifest is the only map-related
 * method here — PROVIDED the manifest it is given already carries a `url`
 * per hole.
 *
 * <p>DONE 2026-09-19: app/js/watch-map-delivery.js now attaches an absolute
 * {@code url} to every manifest hole, so the manifest this forwards is
 * complete.
 */
public final class GarminTransport {

    /** Mirrors WearableTransportDelegate's shape from the iOS refactor, so a
     *  future Android NativeRoundBridge relays events to JavaScript the same
     *  way NativeRoundBridge.swift does via WearableCoordinatorDelegate. */
    public interface Listener {
        void onCommandReceived(Map<String, Object> command);
        void onMapInventoryReceived(Map<String, Object> inventory);
        void onPlayerInventoryReceived(Map<String, Object> inventory);
        void onStateChanged();
    }

    public static final class State {
        public final boolean supported;
        public final boolean activated;
        public final boolean paired;
        public final boolean appInstalled;
        public final boolean reachable;

        State(boolean supported, boolean activated, boolean paired, boolean appInstalled, boolean reachable) {
            this.supported = supported;
            this.activated = activated;
            this.paired = paired;
            this.appInstalled = appInstalled;
            this.reachable = reachable;
        }
    }

    private final Context context;
    private final GarminDeviceStore deviceStore;
    // The Connect IQ app identifier — must always equal garmin/manifest.xml's
    // <iq:application id="...">. See NativeRoundBridge.CONNECT_IQ_APP_ID for
    // why Android holds the undashed spelling and iOS the dashed one.
    private final String connectIqAppId;

    /* Garmin is a paid feature, and this is the gate that enforces it:
       send() refuses while it is false, so a membership that lapses stops the
       watch receiving rather than merely greying out a settings row.

       Defaults to FALSE and is only raised by JavaScript
       (NativeRoundBridge.setGarminEnabled, driven by
       ClarityPayments.hasActiveAccess). Failing closed is deliberate: if the
       payments module never loads we would rather one paying player reports a
       dead Garmin than every non-paying player quietly gets the feature.
       Volatile because setEntitled is called from the Capacitor bridge thread
       and read on whichever thread happens to be publishing. */
    private volatile boolean entitled = false;

    private Listener listener;

    public GarminTransport(Context context, GarminDeviceStore deviceStore, String connectIqAppId) {
        this.context = context.getApplicationContext();
        this.deviceStore = deviceStore;
        this.connectIqAppId = connectIqAppId;
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void activate() {
        // UNVERIFIED:
        // ConnectIQ connectIQ = ConnectIQ.getInstance(context, ConnectIQ.IQConnectType.WIRELESS);
        // connectIQ.initialize(context, true, new ConnectIQ.ConnectIQListener() {
        //     public void onSdkReady() {
        //         GarminDeviceStore.SelectedDevice selected = deviceStore.getSelectedDevice();
        //         if (selected == null) { return; }
        //         IQDevice device = new IQDevice(Long.parseLong(selected.deviceId), selected.deviceName);
        //         IQApp app = new IQApp(connectIqAppId);
        //         connectIQ.registerForDeviceEvents(device, (d, status) -> {
        //             deviceStore.recordConnectionState(status == IQDevice.IQDeviceStatus.CONNECTED
        //                 ? GarminDeviceStore.ConnectionState.CONNECTED
        //                 : GarminDeviceStore.ConnectionState.NOT_CONNECTED);
        //             if (listener != null) { listener.onStateChanged(); }
        //         });
        //         connectIQ.registerForAppEvents(device, app, (d, a, message, status) -> {
        //             if (message instanceof Map) { handleIncoming((Map<String, Object>) message); }
        //         });
        //     }
        //     public void onInitializeError(ConnectIQ.IQSdkErrorStatus status) { /* record + surface */ }
        //     public void onSdkShutDown() { /* no-op */ }
        // });
    }

    public void publishScene(Map<String, Object> scene, Callback<Boolean> completion) {
        send(mapOf("scene", scene), completion);
    }

    /** See this class's header: {@code manifest} must carry a Garmin-specific
     *  `url` per hole for GarminMapDownloader to have anything to fetch.
     *  That attachment is not implemented here. */
    public void publishMapManifest(Map<String, Object> manifest, Callback<Boolean> completion) {
        send(mapOf("watchMapManifest", manifest), completion);
    }

    public void publishPlayer(Map<String, Object> player, Callback<Boolean> completion) {
        send(mapOf("watchPlayer", player), completion);
    }

    public void acknowledge(Map<String, Object> acknowledgement, Runnable completion) {
        send(mapOf("acknowledgement", acknowledgement), sent -> completion.run());
    }

    public State state() {
        GarminDeviceStore.SelectedDevice selected = deviceStore.getSelectedDevice();
        boolean connected = deviceStore.getLastKnownConnectionState() == GarminDeviceStore.ConnectionState.CONNECTED;
        return new State(
            true, // UNVERIFIED: should reflect ConnectIQ actually initialising
            selected != null,
            selected != null,
            connected, // best-effort proxy until device-status callbacks are wired
            connected
        );
    }

    public void setEntitled(boolean value) {
        if (entitled == value) { return; }
        entitled = value;
        /* A lapse does not clear the chosen device: the pairing survives and
           starts working again the moment access returns. Re-pairing after
           every billing hiccup would be its own bug. */
        if (listener != null) { listener.onStateChanged(); }
    }

    // ------------------------------------------- device selection (Settings)

    /** What the Settings > Garmin Watch page lists: the devices, plus whether
     *  the SDK is actually linked — "no devices" and "we cannot look" are
     *  different answers and the page words them differently.
     *
     *  UNVERIFIED / NOT YET POSSIBLE: the real implementation is
     *  {@code connectIQ.getKnownDevices()} (or getConnectedDevices()), which
     *  needs the SDK this repo does not vendor. Until then this reports
     *  honestly that it cannot look rather than returning a misleading empty
     *  list. */
    public Map<String, Object> availableDevices() {
        java.util.HashMap<String, Object> out = new java.util.HashMap<>();
        out.put("devices", new java.util.ArrayList<Map<String, Object>>());
        out.put("sdkLinked", false);
        out.put("reason", "The Connect IQ Mobile SDK is not bundled in this build yet.");
        return out;
    }

    public void selectDevice(String deviceId, String deviceName, String model) {
        deviceStore.select(deviceId, deviceName, model);
        activate();
        if (listener != null) { listener.onStateChanged(); }
    }

    public void clearSelectedDevice() {
        deviceStore.clearSelection();
        if (listener != null) { listener.onStateChanged(); }
    }

    /** The richer state the settings page needs, over and above the five
     *  booleans {@link #state()} reports. */
    public Map<String, Object> garminState() {
        State current = state();
        java.util.HashMap<String, Object> out = new java.util.HashMap<>();
        out.put("supported", current.supported);
        out.put("activated", current.activated);
        out.put("paired", current.paired);
        out.put("appInstalled", current.appInstalled);
        out.put("reachable", current.reachable);
        out.put("entitled", entitled);
        out.put("sdkLinked", false);
        out.put("connectionState", String.valueOf(deviceStore.getLastKnownConnectionState()));
        GarminDeviceStore.SelectedDevice selected = deviceStore.getSelectedDevice();
        if (selected != null) {
            java.util.HashMap<String, Object> device = new java.util.HashMap<>();
            device.put("deviceId", selected.deviceId);
            device.put("deviceName", selected.deviceName);
            device.put("model", selected.model);
            out.put("selectedDevice", device);
        }
        return out;
    }

    private void send(Map<String, Object> message, Callback<Boolean> completion) {
        // The paid gate, enforced below the web layer: no entitlement,
        // nothing leaves the phone.
        if (!entitled) { completion.onResult(false); return; }
        if (deviceStore.getSelectedDevice() == null) { completion.onResult(false); return; }
        // UNVERIFIED: connectIQ.sendMessage(device, app, message, listener) —
        // the real send call. Until the SDK is linked this stub reports
        // failure honestly, matching the "native transport never infers
        // success" rule (Garmin Phase 1 plan step 8): a stub must not claim
        // it sent something it did not.
        completion.onResult(false);
    }

    private void handleIncoming(Map<String, Object> message) {
        if (listener == null) { return; }
        Object command = message.get("command");
        if (command instanceof Map) { listener.onCommandReceived((Map<String, Object>) command); }
        Object mapInventory = message.get("watchMapHave");
        if (mapInventory instanceof Map) { listener.onMapInventoryReceived((Map<String, Object>) mapInventory); }
        Object playerInventory = message.get("watchPlayerHave");
        if (playerInventory instanceof Map) { listener.onPlayerInventoryReceived((Map<String, Object>) playerInventory); }
    }

    private static Map<String, Object> mapOf(String key, Object value) {
        java.util.HashMap<String, Object> m = new java.util.HashMap<>();
        m.put(key, value);
        return m;
    }

    public interface Callback<T> {
        void onResult(T value);
    }
}

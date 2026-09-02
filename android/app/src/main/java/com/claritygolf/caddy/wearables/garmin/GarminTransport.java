package com.claritygolf.caddy.wearables.garmin;

import android.content.Context;
import java.util.Map;

/**
 * UNVERIFIED / NOT YET CALLED FROM ANY CAPACITOR PLUGIN.
 *
 * Android has no NativeRoundBridge Capacitor plugin at all yet (unlike iOS,
 * where this session refactored an existing one) — see the Garmin-on-Android
 * scope note this session produced earlier. This class exists on its own so
 * the transport shape is ready once that plugin is built; nothing registers
 * or calls it today.
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
 * per hole, which is unresolved phone-side work flagged in
 * garmin/README.md, not solved by this class.
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
    // <iq:application id="..."> once that placeholder is replaced.
    private final String connectIqAppId;

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

    private void send(Map<String, Object> message, Callback<Boolean> completion) {
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

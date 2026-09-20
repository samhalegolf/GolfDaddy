package com.claritygolf.caddy.wearables.garmin;

import android.content.Context;
import android.util.Log;

import com.claritygolf.caddy.BuildConfig;
import com.garmin.android.connectiq.ConnectIQ;
import com.garmin.android.connectiq.IQApp;
import com.garmin.android.connectiq.IQDevice;
import com.garmin.android.connectiq.exception.InvalidStateException;
import com.garmin.android.connectiq.exception.ServiceUnavailableException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Talks to a Garmin wearable through the Garmin Connect Mobile app, using the
 * Connect IQ Mobile SDK (com.garmin.connectiq:ciq-companion-app-sdk, declared
 * in android/app/build.gradle). Called from
 * {@link com.claritygolf.caddy.NativeRoundBridge}, Android's Capacitor plugin.
 *
 * <p><b>Written against the real SDK as of 2026-09-20</b>, verified by
 * javap-ing the 2.4.0 AAR rather than from documentation. Until then every
 * call in here was commented out and written from inference; those inferences
 * were wrong in ways worth recording:
 *
 * <ul>
 *   <li>{@code IQApplicationEventListener.onMessageReceived} delivers a
 *       {@code List<Object>}, NOT the {@code Map} the old code tested for with
 *       {@code instanceof}. One watch message arrives as a list holding the
 *       Monkey C Dictionary. That shape would have compiled, run, and silently
 *       dropped every inbound command forever.</li>
 *   <li>Device status is {@code IQDevice.IQDeviceStatus} with four cases
 *       including {@code NOT_PAIRED} and {@code UNKNOWN}, not the two the old
 *       code collapsed to.</li>
 *   <li>Nearly every SDK call throws {@code InvalidStateException} (used
 *       before the SDK is ready) or {@code ServiceUnavailableException}
 *       (Garmin Connect Mobile missing, stopped or too old). Both are checked,
 *       so the old shape would not have compiled once uncommented.</li>
 * </ul>
 *
 * <p>Whether the app is installed on the watch is a real answer here, from
 * {@code getApplicationInfo}, rather than the "device is connected" proxy the
 * stub used. The two differ exactly when it matters: a connected watch with no
 * Clarity Caddy on it.
 *
 * <p>Mirrors GarminTransport.swift's responsibilities and talks directly to
 * whatever calls it, with no WearableCoordinator-style indirection: Android
 * has exactly one wearable target, so that abstraction (built for iOS to
 * arbitrate Apple Watch vs Garmin) has nothing to arbitrate here.
 *
 * <p>Does NOT implement a bytes-over-the-wire map asset path, for the same
 * reason GarminTransport.swift does not: Garmin pulls hole imagery by URL (see
 * garmin/source/Maps/GarminMapDownloader.mc) rather than receiving pushed
 * bytes, so publishMapManifest is the only map-related method here. The
 * manifest it forwards carries an absolute {@code url} per hole as of
 * 2026-09-19 (app/js/watch-map-delivery.js).
 *
 * <p>Package visibility needs nothing in our own manifest: the AAR declares
 * {@code <queries><package android:name="com.garmin.android.apps.connectmobile"/>}
 * itself, and manifest merging folds it in.
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

    private static final String TAG = "GarminTransport";

    private ConnectIQ connectIQ;
    private IQApp app;
    /** The device we are registered against. Held so we can unregister before
     *  registering a different one — the SDK keeps per-device listeners and
     *  would otherwise leak the old one and keep delivering its events. */
    private volatile IQDevice registeredDevice;
    /* Written from SDK callbacks (main thread), read from state() on the
       Capacitor bridge thread — same reasoning as `entitled` above. */
    private volatile boolean sdkReady;
    /** Real answer from getApplicationInfo, not "the device is connected".
     *  The two differ on a connected watch with no Clarity Caddy installed,
     *  which is exactly the case the pairing UI has to explain. */
    private volatile boolean appInstalledOnDevice;

    public GarminTransport(Context context, GarminDeviceStore deviceStore, String connectIqAppId) {
        this.context = context.getApplicationContext();
        this.deviceStore = deviceStore;
        this.connectIqAppId = connectIqAppId;
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    /** Brings the SDK up and, once it is ready, binds to whichever device the
     *  store currently holds. Safe to call repeatedly: initialize() is done
     *  once, and a later call just re-binds (which is what selectDevice wants
     *  after the player picks a different watch).
     *
     *  <p>autoUI = true lets the SDK put up Garmin's own dialogs when Garmin
     *  Connect Mobile is missing or too old. That is the right call here —
     *  those are the two failure modes a player can actually fix, and
     *  Garmin's wording for them is better than anything invented. */
    public void activate() {
        if (connectIQ == null) {
            connectIQ = ConnectIQ.getInstance(context, connectType());
            app = new IQApp(connectIqAppId);
        }
        if (sdkReady) { bindSelectedDevice(); return; }
        connectIQ.initialize(context, true, new ConnectIQ.ConnectIQListener() {
            @Override
            public void onSdkReady() {
                sdkReady = true;
                bindSelectedDevice();
                notifyStateChanged();
            }

            @Override
            public void onInitializeError(ConnectIQ.IQSdkErrorStatus status) {
                /* GCM_NOT_INSTALLED, GCM_UPGRADE_NEEDED or SERVICE_ERROR. The
                   first two are already on screen via autoUI; all three leave
                   us not ready, which state() reports honestly rather than
                   pretending the transport is live. */
                sdkReady = false;
                Log.w(TAG, "Connect IQ SDK did not initialise: " + status);
                notifyStateChanged();
            }

            @Override
            public void onSdkShutDown() {
                sdkReady = false;
                registeredDevice = null;
                appInstalledOnDevice = false;
                notifyStateChanged();
            }
        });
    }

    /** WIRELESS goes through Garmin Connect Mobile to a real watch. TETHERED
     *  is the SDK's simulator hook: it opens a socket on port 7381 and expects
     *  the desktop Connect IQ simulator on the other end of an adb forward, so
     *  the phone app and the watch app can be exercised together with no
     *  hardware. In that mode the SDK reports exactly one device, "Simulator",
     *  and getApplicationInfo answers for whatever the simulator is running.
     *
     *  <p>Chosen at build time (android/app/build.gradle, debug builds only)
     *  rather than at runtime so the choice cannot leak into a release. */
    private static ConnectIQ.IQConnectType connectType() {
        if (BuildConfig.GARMIN_TETHERED) {
            Log.i(TAG, "Connect IQ in TETHERED mode: expecting the simulator via `adb forward tcp:7381 tcp:7381`");
            return ConnectIQ.IQConnectType.TETHERED;
        }
        return ConnectIQ.IQConnectType.WIRELESS;
    }

    /** Releases the SDK. Paired with activate(); the selected device survives
     *  in the store, so coming back does not mean re-pairing. */
    public void deactivate() {
        if (connectIQ == null || !sdkReady) { return; }
        try {
            unregisterCurrentDevice();
            connectIQ.shutdown(context);
        } catch (InvalidStateException error) {
            /* Already down. Nothing to undo. */
        }
        sdkReady = false;
        registeredDevice = null;
        appInstalledOnDevice = false;
    }

    private void bindSelectedDevice() {
        GarminDeviceStore.SelectedDevice selected = deviceStore.getSelectedDevice();
        if (selected == null) { unregisterCurrentDevice(); return; }
        IQDevice device = toIQDevice(selected);
        if (device == null) { return; }
        if (registeredDevice != null && registeredDevice.getDeviceIdentifier() == device.getDeviceIdentifier()) { return; }
        unregisterCurrentDevice();
        try {
            connectIQ.registerForDeviceEvents(device, new ConnectIQ.IQDeviceEventListener() {
                @Override
                public void onDeviceStatusChanged(IQDevice changed, IQDevice.IQDeviceStatus status) {
                    deviceStore.recordConnectionState(connectionStateOf(status));
                    /* Whether the watch app is there can only be asked of a
                       connected device, so this is the moment to ask. */
                    if (status == IQDevice.IQDeviceStatus.CONNECTED) { refreshAppInstalled(changed); }
                    else { appInstalledOnDevice = false; }
                    notifyStateChanged();
                }
            });
            connectIQ.registerForAppEvents(device, app, new ConnectIQ.IQApplicationEventListener() {
                @Override
                public void onMessageReceived(IQDevice from, IQApp fromApp, List<Object> messages, ConnectIQ.IQMessageStatus status) {
                    if (status != ConnectIQ.IQMessageStatus.SUCCESS || messages == null) { return; }
                    /* A LIST, not a Map — one watch send arrives as a list
                       holding the Monkey C Dictionary. Testing the list itself
                       with `instanceof Map` (as the pre-SDK stub did) is false
                       every time and drops the message without a trace. */
                    for (Object message : messages) {
                        if (message instanceof Map) {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> dictionary = (Map<String, Object>) message;
                            handleIncoming(dictionary);
                        }
                    }
                }
            });
            registeredDevice = device;
            deviceStore.recordConnectionState(connectionStateOf(currentStatusOf(device)));
            if (currentStatusOf(device) == IQDevice.IQDeviceStatus.CONNECTED) { refreshAppInstalled(device); }
        } catch (InvalidStateException | ServiceUnavailableException error) {
            Log.w(TAG, "could not bind Garmin device", error);
            registeredDevice = null;
        }
    }

    private void unregisterCurrentDevice() {
        if (connectIQ == null || registeredDevice == null) { return; }
        try { connectIQ.unregisterForEvents(registeredDevice); }
        catch (InvalidStateException error) { /* SDK already down */ }
        registeredDevice = null;
        appInstalledOnDevice = false;
    }

    private IQDevice.IQDeviceStatus currentStatusOf(IQDevice device) {
        try { return connectIQ.getDeviceStatus(device); }
        catch (InvalidStateException | ServiceUnavailableException error) { return IQDevice.IQDeviceStatus.UNKNOWN; }
    }

    private void refreshAppInstalled(IQDevice device) {
        try {
            connectIQ.getApplicationInfo(connectIqAppId, device, new ConnectIQ.IQApplicationInfoListener() {
                @Override
                public void onApplicationInfoReceived(IQApp installed) {
                    appInstalledOnDevice = true;
                    notifyStateChanged();
                }

                @Override
                public void onApplicationNotInstalled(String applicationId) {
                    appInstalledOnDevice = false;
                    notifyStateChanged();
                }
            });
        } catch (InvalidStateException | ServiceUnavailableException error) {
            appInstalledOnDevice = false;
        }
    }

    /** GarminDeviceStore keeps the id as a String because that is what crosses
     *  the JavaScript bridge; the SDK wants the long it really is. A value
     *  that is not a long cannot name a device, so it yields null rather than
     *  a device that will never match. */
    private IQDevice toIQDevice(GarminDeviceStore.SelectedDevice selected) {
        try {
            return new IQDevice(Long.parseLong(selected.deviceId), selected.deviceName);
        } catch (NumberFormatException error) {
            Log.w(TAG, "stored Garmin device id is not a device identifier: " + selected.deviceId);
            return null;
        }
    }

    private static GarminDeviceStore.ConnectionState connectionStateOf(IQDevice.IQDeviceStatus status) {
        if (status == IQDevice.IQDeviceStatus.CONNECTED) { return GarminDeviceStore.ConnectionState.CONNECTED; }
        if (status == IQDevice.IQDeviceStatus.NOT_PAIRED) { return GarminDeviceStore.ConnectionState.UNAVAILABLE; }
        if (status == IQDevice.IQDeviceStatus.NOT_CONNECTED) { return GarminDeviceStore.ConnectionState.NOT_CONNECTED; }
        return GarminDeviceStore.ConnectionState.UNKNOWN;
    }

    private void notifyStateChanged() {
        if (listener != null) { listener.onStateChanged(); }
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
            /* supported: the SDK actually came up. False means Garmin Connect
               Mobile is missing, too old, or its service failed — all real,
               all worth showing differently from "no watch chosen". */
            sdkReady,
            /* activated: bound to a device and listening. */
            registeredDevice != null,
            /* paired: the player has chosen a watch. Survives disconnection
               and a membership lapse. */
            selected != null,
            /* appInstalled: the real answer from getApplicationInfo, not a
               proxy — a connected watch without Clarity Caddy reports false. */
            appInstalledOnDevice,
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
     *  different answers and the page words them differently. */
    public Map<String, Object> availableDevices() {
        HashMap<String, Object> out = new HashMap<>();
        ArrayList<Map<String, Object>> devices = new ArrayList<>();
        out.put("devices", devices);
        out.put("sdkLinked", true);
        if (connectIQ == null || !sdkReady) {
            /* Distinct from "looked and found none", and the settings page
               words it differently. activate() is called here so the common
               case — player opens the page before anything else has woken the
               SDK — resolves itself on their second tap rather than needing an
               app restart. */
            activate();
            out.put("reason", "Garmin Connect is not ready yet. Make sure the Garmin Connect app is installed and signed in, then try again.");
            return out;
        }
        try {
            /* Known, not connected: a watch that is paired in Garmin Connect
               but currently out of range is still the watch the player wants
               to choose. Its live status rides along so the page can say so. */
            for (IQDevice device : connectIQ.getKnownDevices()) {
                HashMap<String, Object> entry = new HashMap<>();
                entry.put("deviceId", String.valueOf(device.getDeviceIdentifier()));
                entry.put("deviceName", device.getFriendlyName());
                entry.put("model", partNumberOf(device));
                entry.put("connected", currentStatusOf(device) == IQDevice.IQDeviceStatus.CONNECTED);
                devices.add(entry);
            }
        } catch (InvalidStateException | ServiceUnavailableException error) {
            Log.w(TAG, "could not list Garmin devices", error);
            out.put("reason", "Could not reach Garmin Connect to list your watches.");
        }
        return out;
    }

    /** The device's part number, which is as close to a model name as the SDK
     *  offers. Best-effort: it needs a live service, and a missing model is
     *  cosmetic on the pairing row. */
    private String partNumberOf(IQDevice device) {
        try {
            String partNumber = connectIQ.getDevicePartNumber(device);
            return partNumber == null ? "" : partNumber;
        } catch (InvalidStateException | ServiceUnavailableException | IllegalArgumentException error) {
            return "";
        }
    }

    public void selectDevice(String deviceId, String deviceName, String model) {
        deviceStore.select(deviceId, deviceName, model);
        /* Re-binds listeners onto the newly chosen device; activate() is
           idempotent and unregisters the previous one first. */
        activate();
        notifyStateChanged();
    }

    public void clearSelectedDevice() {
        unregisterCurrentDevice();
        deviceStore.clearSelection();
        notifyStateChanged();
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
        // The SDK is bundled and this build talked to it: only false when
        // initialize() failed or has not run. A stub-era hard-coded false
        // survived here until 2026-09-20 and contradicted garminDevices().
        out.put("sdkLinked", sdkReady);
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
        if (connectIQ == null || !sdkReady || registeredDevice == null) { completion.onResult(false); return; }
        try {
            connectIQ.sendMessage(registeredDevice, app, message, new ConnectIQ.IQSendMessageListener() {
                @Override
                public void onMessageStatus(IQDevice device, IQApp sentApp, ConnectIQ.IQMessageStatus status) {
                    /* Reported, never inferred: only the SDK's own SUCCESS
                       counts as sent (Garmin Phase 1 plan step 8). The other
                       seven cases are all genuine failures, and
                       FAILURE_MESSAGE_TOO_LARGE in particular is one the
                       caller must see rather than have smoothed over — a
                       Scene that outgrew the link fails every time, not
                       intermittently. */
                    if (status != ConnectIQ.IQMessageStatus.SUCCESS) {
                        Log.w(TAG, "Garmin send failed: " + status);
                    }
                    completion.onResult(status == ConnectIQ.IQMessageStatus.SUCCESS);
                }
            });
        } catch (InvalidStateException | ServiceUnavailableException error) {
            Log.w(TAG, "Garmin send could not be attempted", error);
            completion.onResult(false);
        }
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

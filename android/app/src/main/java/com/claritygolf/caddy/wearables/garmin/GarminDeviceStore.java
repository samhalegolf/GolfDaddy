package com.claritygolf.caddy.wearables.garmin;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Persists which Garmin device Caddy should treat as the wearable target.
 * Mirrors ios/App/App/Wearables/Garmin/GarminDeviceStore.swift field for
 * field, backed by SharedPreferences instead of UserDefaults (see the
 * Garmin-on-Android scope note this session wrote earlier: Android's
 * wearable target is Garmin only, no Wear OS, so there is exactly one
 * transport and this store has exactly one caller).
 *
 * Caddy chooses which Garmin is the Caddy wearable deliberately — this store
 * never auto-selects from device discovery. A future device-picker UI
 * supplies the choice explicitly via {@link #select}.
 */
public final class GarminDeviceStore {
    private static final String PREFS_NAME = "GarminDeviceStoreV1";
    private static final String KEY_DEVICE_ID = "deviceId";
    private static final String KEY_DEVICE_NAME = "deviceName";
    private static final String KEY_MODEL = "model";
    private static final String KEY_CONNECTION_STATE = "connectionState";

    public enum ConnectionState {
        UNKNOWN, NOT_CONNECTED, CONNECTED, UNAVAILABLE
    }

    public static final class SelectedDevice {
        public final String deviceId;
        public final String deviceName;
        public final String model;

        public SelectedDevice(String deviceId, String deviceName, String model) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.model = model;
        }
    }

    private final SharedPreferences prefs;

    public GarminDeviceStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public SelectedDevice getSelectedDevice() {
        String id = prefs.getString(KEY_DEVICE_ID, null);
        String name = prefs.getString(KEY_DEVICE_NAME, null);
        if (id == null || name == null) { return null; }
        String model = prefs.getString(KEY_MODEL, "");
        return new SelectedDevice(id, name, model);
    }

    public ConnectionState getLastKnownConnectionState() {
        String raw = prefs.getString(KEY_CONNECTION_STATE, ConnectionState.UNKNOWN.name());
        try {
            return ConnectionState.valueOf(raw);
        } catch (IllegalArgumentException e) {
            return ConnectionState.UNKNOWN;
        }
    }

    public void select(String deviceId, String deviceName, String model) {
        prefs.edit()
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_DEVICE_NAME, deviceName)
            .putString(KEY_MODEL, model)
            .apply();
    }

    public void clearSelection() {
        prefs.edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_DEVICE_NAME)
            .remove(KEY_MODEL)
            .apply();
    }

    public void recordConnectionState(ConnectionState state) {
        prefs.edit().putString(KEY_CONNECTION_STATE, state.name()).apply();
    }
}

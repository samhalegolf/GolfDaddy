package com.claritygolf.caddy.wearables.garmin;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Converts between Capacitor's JSObject/JSArray (a JS call's parsed payload)
 * and plain java.util.Map/List, so {@link GarminTransport} — the actual
 * transport logic — never depends on Capacitor types. Mirrors the boundary
 * NativeRoundBridge.swift draws with its {@code withoutNulls}: JavaScript
 * bridges a JS {@code null} to {@code JSONObject.NULL} here (Capacitor's
 * Android bridge does the equivalent of iOS's NSNull bridging), and this
 * strips it the same way — an absent key is what the wearable side already
 * treats a missing field as, so dropping a null is lossless.
 */
public final class JsonBridge {
    private JsonBridge() {}

    public static Map<String, Object> toMap(JSONObject object) {
        Map<String, Object> map = new HashMap<>();
        if (object == null) { return map; }
        java.util.Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (object.isNull(key)) { continue; }
            try {
                map.put(key, toJavaValue(object.get(key)));
            } catch (JSONException e) {
                // A single malformed field must not reject the whole payload
                // — the same tolerance WatchScene's Codable decode and
                // GarminWire's dictionary helpers apply on the other two
                // platforms.
            }
        }
        return map;
    }

    public static List<Object> toList(JSONArray array) {
        List<Object> list = new ArrayList<>();
        if (array == null) { return list; }
        for (int i = 0; i < array.length(); i += 1) {
            if (array.isNull(i)) { continue; }
            try {
                list.add(toJavaValue(array.get(i)));
            } catch (JSONException e) {
                // best-effort, same reasoning as toMap
            }
        }
        return list;
    }

    private static Object toJavaValue(Object value) throws JSONException {
        if (value instanceof JSONObject) { return toMap((JSONObject) value); }
        if (value instanceof JSONArray) { return toList((JSONArray) value); }
        return value;
    }

    @SuppressWarnings("unchecked")
    public static JSObject toJSObject(Map<String, Object> map) {
        JSObject object = new JSObject();
        if (map == null) { return object; }
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            object.put(entry.getKey(), toJsValue(entry.getValue()));
        }
        return object;
    }

    @SuppressWarnings("unchecked")
    private static Object toJsValue(Object value) {
        if (value instanceof Map) { return toJSObject((Map<String, Object>) value); }
        if (value instanceof List) {
            List<Object> list = (List<Object>) value;
            List<Object> converted = new ArrayList<>();
            for (Object item : list) { converted.add(toJsValue(item)); }
            return new JSArray(converted);
        }
        return value;
    }
}

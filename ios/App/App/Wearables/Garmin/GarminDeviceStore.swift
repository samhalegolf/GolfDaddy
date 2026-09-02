import Foundation

/*
 UNVERIFIED / NOT WIRED INTO THE BUILD. This file is not in project.pbxproj's
 Sources build phase — see garmin/README.md and the Garmin Phase 1 plan
 step 5. Add it once the Garmin Connect IQ Mobile SDK for iOS is linked.

 Persists which Garmin device Caddy should treat as the wearable target.
 Unlike Apple Watch — where WCSession always addresses "the paired Watch,"
 singular — a phone may have Garmin Connect paired to several devices, and
 Caddy must not silently send a round to all of them. This store holds the
 one deliberate choice, mirroring the field list the Garmin Phase 1 plan
 step 5 calls for.
*/
final class GarminDeviceStore {
    struct SelectedDevice: Equatable {
        let deviceId: String
        let deviceName: String
        let model: String
    }

    enum ConnectionState: String {
        case unknown, notConnected, connected, unavailable
    }

    private static let deviceIdKey = "GarminSelectedDeviceIdV1"
    private static let deviceNameKey = "GarminSelectedDeviceNameV1"
    private static let modelKey = "GarminSelectedDeviceModelV1"
    private static let connectionStateKey = "GarminLastKnownConnectionStateV1"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var selectedDevice: SelectedDevice? {
        guard let id = defaults.string(forKey: Self.deviceIdKey),
              let name = defaults.string(forKey: Self.deviceNameKey) else { return nil }
        let model = defaults.string(forKey: Self.modelKey) ?? ""
        return SelectedDevice(deviceId: id, deviceName: name, model: model)
    }

    var lastKnownConnectionState: ConnectionState {
        ConnectionState(rawValue: defaults.string(forKey: Self.connectionStateKey) ?? "") ?? .unknown
    }

    /* Caddy should deliberately choose which Garmin is the Caddy wearable —
       this is never set automatically from device discovery. The caller
       (a future device-picker UI) supplies the choice explicitly. */
    func select(deviceId: String, deviceName: String, model: String) {
        defaults.set(deviceId, forKey: Self.deviceIdKey)
        defaults.set(deviceName, forKey: Self.deviceNameKey)
        defaults.set(model, forKey: Self.modelKey)
    }

    func clearSelection() {
        defaults.removeObject(forKey: Self.deviceIdKey)
        defaults.removeObject(forKey: Self.deviceNameKey)
        defaults.removeObject(forKey: Self.modelKey)
    }

    func recordConnectionState(_ state: ConnectionState) {
        defaults.set(state.rawValue, forKey: Self.connectionStateKey)
    }
}

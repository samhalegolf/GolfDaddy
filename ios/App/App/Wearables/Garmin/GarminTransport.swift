import Foundation
import UIKit
import ConnectIQ

/*
 Talks to a Garmin wearable through the Garmin Connect Mobile app, using the
 Connect IQ Mobile SDK for iOS (the ConnectIQ Swift package, pinned in
 App.xcodeproj). Registered alongside AppleWatchTransport in
 NativeRoundBridge.load(); WearableCoordinator fans out to both.

 WRITTEN AGAINST THE REAL SDK as of 2026-09-20, read from the xcframework's
 own headers rather than documentation. Until then every call here was
 commented out and written from inference, and most of those inferences were
 wrong:

   - IQApp is built with `appWith(uuid:storeUuid:device:)` — THREE arguments,
     including the Store UUID Garmin issues at publish time. The inferred
     `IQApp(uuid:store:device:)` and its `IQAppStore()` do not exist at all.
   - A device is `IQDevice.deviceWith(id:modelName:friendlyName:)`, a class
     factory, and the id is an NSUUID. (Android's is a `long`. Same concept,
     different type, and GarminDeviceStore keeps the String that crosses the
     JavaScript bridge either way.)
   - Messages go to an APP, not a device: `sendMessage(_:toApp:progress:completion:)`.
     The IQApp carries its device.
   - IQDeviceStatus has five cases, including BluetoothNotReady and NotFound,
     which are worth telling apart from NotConnected when explaining to a
     player why their watch is not there.

 THE BIG STRUCTURAL DIFFERENCE FROM ANDROID, and the reason this file cannot
 mirror GarminTransport.java: iOS has no way to enumerate paired devices in
 process. There is no getKnownDevices(). Instead `showConnectIQDeviceSelection()`
 hands off to the Garmin Connect app, which comes back into this app through a
 registered URL scheme, and `parseDeviceSelectionResponseFromURL(_:)` turns that
 URL into the chosen devices. So on iOS "Connect a Watch" leaves the app and
 returns, where on Android it fills a list in place. AppDelegate routes the URL
 here via `handleOpenURL`.

 Two Info.plist entries make that work, and both fail silently when missing:
 our own `claritycaddy-ciq` scheme under CFBundleURLTypes (or Garmin Connect
 has nowhere to hand control back to), and `gcm-ciq` under
 LSApplicationQueriesSchemes (or canOpenURL returns false and the SDK reports
 Garmin Connect as not installed even when it is).

 Does NOT own Caddy golf state — it is transport, exactly like
 AppleWatchTransport. Does NOT implement WearableFileAssetTransport: Garmin
 pulls map imagery by URL (see garmin/source/Maps/GarminMapDownloader.mc), so
 publishMapManifest is the only map path. The manifest carries an absolute
 `url` per hole as of 2026-09-19 (app/js/watch-map-delivery.js).
*/
final class GarminTransport: NSObject, WearableTransport {
    let platform: WearablePlatform = .garmin
    weak var delegate: WearableTransportDelegate?

    private let deviceStore: GarminDeviceStore
    private let queue = DispatchQueue(label: "com.claritygolf.caddy.garmin-transport")

    // The Connect IQ app identifier — the same UUID as garmin/manifest.xml's
    // <iq:application id="...">, supplied DASHED by NativeRoundBridge because
    // UUID(uuidString:) below rejects the undashed form the manifest uses (see
    // that constant's comment). Both must always agree: this is what scopes a
    // message to Caddy specifically among any other Connect IQ apps the paired
    // device might have.
    private let connectIQAppId: String

    private var latestScene: [String: Any]?

    /* The URL scheme Garmin Connect uses to hand control back after device
       selection. Must match an entry in Info.plist's CFBundleURLTypes. */
    static let urlScheme = "claritycaddy-ciq"

    /* AppDelegate posts every incoming URL here rather than reaching into the
       plugin for the transport. Keeps AppDelegate ignorant of Garmin and this
       class free of a mutable global, and means a URL that arrives before the
       plugin has loaded is simply ignored rather than crashing. */
    static let openURLNotification = Notification.Name("com.claritygolf.caddy.garmin.openURL")

    private var initialized = false
    private var boundApp: IQApp?
    private var boundDevice: IQDevice?
    /* Real answer from getAppStatus, not "the device is connected". The two
       differ on a connected watch with no Clarity Caddy installed. */
    private var appInstalledOnDevice = false
    /* Set while a hand-off to Garmin Connect is outstanding, so the settings
       page can say what it is waiting for. */
    private var awaitingSelection = false
    private var urlObserver: NSObjectProtocol?

    init(deviceStore: GarminDeviceStore = GarminDeviceStore(), connectIQAppId: String) {
        self.deviceStore = deviceStore
        self.connectIQAppId = connectIQAppId
        super.init()
    }

    func activate() {
        if urlObserver == nil {
            urlObserver = NotificationCenter.default.addObserver(
                forName: Self.openURLNotification, object: nil, queue: .main
            ) { [weak self] note in
                guard let url = note.userInfo?["url"] as? URL else { return }
                self?.handleOpenURL(url)
            }
        }
        if !initialized {
            /* uiOverrideDelegate lets us answer "Garmin Connect is not
               installed" ourselves rather than letting the SDK decide; see the
               IQUIOverrideDelegate conformance at the foot of this file. */
            ConnectIQ.sharedInstance().initialize(withUrlScheme: Self.urlScheme, uiOverrideDelegate: self)
            initialized = true
        }
        bindSelectedDevice()
    }

    /* Hands off to the Garmin Connect app to choose a watch. iOS has no
       in-process device list, so this LEAVES the app; the answer arrives back
       through handleOpenURL below. Returns false when Garmin Connect is not
       there to hand off to, which the caller words for the player. */
    func beginDeviceSelection() -> Bool {
        activate()
        awaitingSelection = true
        ConnectIQ.sharedInstance().showDeviceSelection()
        return true
    }

    /* Called by AppDelegate for any URL on our scheme. Returns true when this
       was a device-selection response and it has been consumed. */
    @discardableResult
    func handleOpenURL(_ url: URL) -> Bool {
        guard url.scheme == Self.urlScheme else { return false }
        awaitingSelection = false
        guard let devices = ConnectIQ.sharedInstance().parseDeviceSelectionResponse(from: url) as? [IQDevice] else {
            return false
        }
        /* Garmin Connect can return several. The transport speaks to exactly
           one, and the first is the one the player picked first — the settings
           page shows which one landed. */
        guard let chosen = devices.first else {
            /* An empty response means the player backed out, which is not an
               error and must not clear a device they already had. */
            delegate?.wearableTransportStateDidChange(self)
            return true
        }
        deviceStore.select(
            deviceId: chosen.uuid.uuidString,
            deviceName: chosen.friendlyName ?? "Garmin watch",
            model: chosen.modelName ?? ""
        )
        bindSelectedDevice()
        delegate?.wearableTransportStateDidChange(self)
        return true
    }

    private func bindSelectedDevice() {
        guard initialized else { return }
        guard let selected = deviceStore.selectedDevice, let device = iqDevice(from: selected) else {
            unbind()
            return
        }
        if let bound = boundDevice, bound.uuid == device.uuid { return }
        unbind()

        ConnectIQ.sharedInstance().register(forDeviceEvents: device, delegate: self)
        /* storeUuid is the id Garmin issues when the app is first published,
           which does not exist until then; nil is what the SDK expects in the
           meantime and the app uuid alone scopes the messages. */
        let app = IQApp(uuid: UUID(uuidString: connectIQAppId), store: nil, device: device)
        if let app {
            ConnectIQ.sharedInstance().register(forAppMessages: app, delegate: self)
            boundApp = app
            refreshAppStatus(app)
        }
        boundDevice = device
        deviceStore.recordConnectionState(Self.connectionStateFor(ConnectIQ.sharedInstance().getDeviceStatus(device)))
    }

    private func unbind() {
        if let app = boundApp {
            ConnectIQ.sharedInstance().unregister(forAppMessages: app, delegate: self)
        }
        if let device = boundDevice {
            ConnectIQ.sharedInstance().unregister(forDeviceEvents: device, delegate: self)
        }
        boundApp = nil
        boundDevice = nil
        appInstalledOnDevice = false
    }

    func clearSelectedDevice() {
        unbind()
        deviceStore.clearSelection()
        delegate?.wearableTransportStateDidChange(self)
    }

    private func refreshAppStatus(_ app: IQApp) {
        ConnectIQ.sharedInstance().getAppStatus(app) { [weak self] status in
            guard let self else { return }
            self.appInstalledOnDevice = status?.isInstalled ?? false
            self.delegate?.wearableTransportStateDidChange(self)
        }
    }

    /* Whether Garmin Connect is on the phone at all. This is the whole reason
       `gcm-ciq` is in Info.plist's LSApplicationQueriesSchemes: without that
       entry canOpenURL always answers false and we would tell every player
       Garmin Connect is missing. The SDK offers no synchronous check of its
       own — IQUIOverrideDelegate.needsToInstallConnectMobile only fires after
       the fact, which is too late to word the button. */
    static var isConnectMobileInstalled: Bool {
        guard let url = URL(string: "gcm-ciq://") else { return false }
        return UIApplication.shared.canOpenURL(url)
    }

    /* GarminDeviceStore keeps the id as the String that crosses the JavaScript
       bridge; the SDK wants the UUID it really is. A value that is not a UUID
       cannot name a device, so this yields nil rather than one that will never
       match. */
    private func iqDevice(from selected: GarminDeviceStore.SelectedDevice) -> IQDevice? {
        guard let uuid = UUID(uuidString: selected.deviceId) else { return nil }
        return IQDevice(id: uuid, modelName: selected.model, friendlyName: selected.deviceName)
    }

    fileprivate static func connectionStateFor(_ status: IQDeviceStatus) -> GarminDeviceStore.ConnectionState {
        switch status {
        case .connected: return .connected
        case .notConnected, .notFound: return .notConnected
        case .invalidDevice, .bluetoothNotReady: return .unavailable
        @unknown default: return .unknown
        }
    }

    // MARK: - WearableTransport

    func publishScene(_ scene: [String: Any], completion: @escaping (Bool) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            self.latestScene = scene
            self.send(["scene": scene], completion: completion)
        }
    }

    func publishMapManifest(_ manifest: [String: Any], completion: @escaping (Bool) -> Void) {
        // See this file's header: `manifest` must carry a Garmin-specific
        // `url` per hole (garmin/GarminMapManifest.mc's `url` field) for
        // GarminMapDownloader to have anything to fetch. That attachment is
        // not implemented here — this method forwards whatever it is given.
        queue.async { [weak self] in
            guard let self else { return }
            self.send(["watchMapManifest": manifest], completion: completion)
        }
    }

    func publishPlayer(_ player: [String: Any], completion: @escaping (Bool) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            self.send(["watchPlayer": player], completion: completion)
        }
    }

    func acknowledge(_ acknowledgement: [String: Any], completion: @escaping () -> Void) {
        queue.async { [weak self] in
            guard let self else { completion(); return }
            self.send(["acknowledgement": acknowledgement]) { _ in completion() }
        }
    }

    func state() -> WearableTransportState {
        let selected = deviceStore.selectedDevice
        let connected = deviceStore.lastKnownConnectionState == .connected
        return WearableTransportState(
            /* supported: the SDK came up and has somewhere to hand off to. */
            supported: initialized,
            /* activated: bound to a device and listening. */
            activated: boundApp != nil,
            /* paired: the player has chosen a watch. Survives disconnection
               and a membership lapse. */
            paired: selected != nil,
            /* appInstalled: the real getAppStatus answer, not a proxy — a
               connected watch without Clarity Caddy reports false. */
            appInstalled: appInstalledOnDevice,
            reachable: connected
        )
    }

    // MARK: - Entitlement

    /* Garmin is a paid feature. This is the gate that actually enforces it:
       `send()` refuses while it is false, so a membership that lapses stops
       the watch receiving rather than merely greying out a settings row.

       It defaults to FALSE and is only ever raised by JavaScript
       (NativeRoundBridge.setGarminEnabled, driven by
       ClarityPayments.hasActiveAccess). Failing closed is deliberate: if the
       payments module never loads we would rather a paying player reports a
       dead Garmin than every non-paying player quietly gets the feature.
       Apple Watch is untouched by this — it has its own rules. */
    private var entitled = false

    func setEntitled(_ value: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.entitled != value else { return }
            self.entitled = value
            /* A lapse does not clear the chosen device. The player keeps their
               pairing and it starts working again the moment access returns —
               re-pairing after every billing hiccup would be its own bug. */
            self.delegate?.wearableTransportStateDidChange(self)
        }
    }

    // MARK: - Device selection (the Settings > Garmin Watch page)

    /* What the settings page lists. Returns the devices plus whether the SDK
       is actually linked, because "no devices" and "we cannot look" are
       different answers and the page says so in different words.

       UNVERIFIED / NOT YET POSSIBLE: the real implementation asks
       ConnectIQ.sharedInstance() for known devices, which on iOS means
       handing off to the Garmin Connect Mobile app and receiving the
       selection back through the registered URL scheme — there is no
       in-process device list to enumerate. Until the .xcframework is
       vendored this reports honestly that it cannot look. */
    /* iOS has no getKnownDevices(): the only way to choose is to hand off to
       the Garmin Connect app and be called back on our URL scheme. So this
       never returns a list — it starts the hand-off and tells the caller what
       is about to happen, and the answer arrives later through handleOpenURL.
       Android fills a list in place; the settings page branches on
       `selectionStyle`. */
    func availableDevices() -> [String: Any] {
        guard Self.isConnectMobileInstalled else {
            return [
                "devices": [[String: Any]](),
                "sdkLinked": true,
                "selectionStyle": "handoff",
                "reason": "The Garmin Connect app is needed to choose a watch. Install it, sign in, then try again."
            ]
        }
        _ = beginDeviceSelection()
        return [
            "devices": [[String: Any]](),
            "sdkLinked": true,
            "selectionStyle": "handoff",
            "handoff": true,
            "reason": "Choose your watch in the Garmin Connect app — you will come straight back here."
        ]
    }

    func selectDevice(id: String, name: String, model: String) {
        deviceStore.select(deviceId: id, deviceName: name, model: model)
        activate()
        delegate?.wearableTransportStateDidChange(self)
    }

    // MARK: - Receiving

    private func handleIncoming(_ message: [String: Any]) {
        if let command = message["command"] as? [String: Any] {
            delegate?.wearableTransport(self, didReceiveCommand: command)
        }
        if let inventory = message["watchMapHave"] as? [String: Any] {
            delegate?.wearableTransport(self, didReceiveMapInventory: inventory)
        }
        if let held = message["watchPlayerHave"] as? [String: Any] {
            delegate?.wearableTransport(self, didReceivePlayerInventory: held)
        }
    }

    /* The richer state the settings page needs, over and above the five
       booleans every transport reports through WearableTransportState. */
    func garminStateDictionary() -> [String: Any] {
        var out = state().asDictionary
        out["entitled"] = queue.sync { entitled }
        out["sdkLinked"] = true
        /* iOS chooses a device by leaving the app for Garmin Connect, so the
           settings page has a waiting state Android does not. */
        out["awaitingSelection"] = awaitingSelection
        out["selectionStyle"] = "handoff"
        if let selected = deviceStore.selectedDevice {
            out["selectedDevice"] = [
                "deviceId": selected.deviceId,
                "deviceName": selected.deviceName,
                "model": selected.model
            ]
        }
        out["connectionState"] = deviceStore.lastKnownConnectionState.rawValue
        return out
    }

    // MARK: - Sending

    private func send(_ message: [String: Any], completion: @escaping (Bool) -> Void) {
        // The paid gate, enforced where it cannot be talked around from the
        // web layer: no entitlement, nothing leaves the phone.
        guard entitled else { completion(false); return }
        guard let app = boundApp else { completion(false); return }
        /* Messages go to an APP, not a device — the IQApp carries its device.
           Reported, never inferred: only the SDK's own Success counts as sent
           (Garmin Phase 1 plan step 8). */
        ConnectIQ.sharedInstance().sendMessage(message, to: app, progress: nil) { result in
            if result != .success {
                NSLog("Garmin send failed: %@", NSStringFromSendMessageResult(result))
            }
            completion(result == .success)
        }
    }

}

// MARK: - SDK delegates

extension GarminTransport: IQDeviceEventDelegate {
    func deviceStatusChanged(_ device: IQDevice, status: IQDeviceStatus) {
        deviceStore.recordConnectionState(Self.connectionStateFor(status))
        /* Whether the watch app is there can only be asked of a connected
           device, so this is the moment to ask. */
        if status == .connected, let app = boundApp { refreshAppStatus(app) }
        else { appInstalledOnDevice = false }
        delegate?.wearableTransportStateDidChange(self)
    }
}

extension GarminTransport: IQAppMessageDelegate {
    func receivedMessage(_ message: Any!, from app: IQApp!) {
        /* Unlike Android — where the payload is a List holding the Dictionary —
           iOS hands back the Monkey C Dictionary itself, as an NSDictionary. */
        guard let dictionary = message as? [String: Any] else { return }
        handleIncoming(dictionary)
    }
}

extension GarminTransport: IQUIOverrideDelegate {
    func needsToInstallConnectMobile() {
        /* Deliberately NOT sending the player to the App Store from here.
           This fires from inside an SDK call that may have been triggered by
           background work, and a store page appearing unbidden is worse than
           the settings page saying plainly what is missing — which it does,
           via the `reason` availableDevices() returns. */
        NSLog("Garmin Connect is not installed; device selection is unavailable")
        delegate?.wearableTransportStateDidChange(self)
    }
}

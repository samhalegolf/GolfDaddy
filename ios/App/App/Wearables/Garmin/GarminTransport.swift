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
    /// The largest package part the watch says it wants (0 = no preference);
    /// 1 is hole by hole. From its map inventory report.
    private var watchMaxPart = 0

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

    /* The course package, slimmed and delivered in growing parts.

       SLIMMED as Android's GarminTransport.slimManifestForWatch is: the watch
       reads one thing out of each hole's `reference` - the green - and the
       full reference made Millbrook's package ~27 KB, which the Connect IQ
       link refuses outright (FAILURE_MESSAGE_TOO_LARGE). This path used to
       send it whole and unslimmed.

       IN PARTS through an AdaptiveGate: hole 1 alone, then 2, 4, 8 ...,
       stepping back on a refused send; never larger than the watch's own
       `maxPart`. Each part carries `part: {from, count, total}` and the watch
       merges them (GarminMapStore.receiveManifest). Five refusals in a row
       end the attempt; watch-map-delivery.js's cooldown retries the course. */
    func publishMapManifest(_ manifest: [String: Any], completion: @escaping (Bool) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            var manifest = manifest
            let skeleton = manifest.removeValue(forKey: "skeleton") as? [String: Any]
            let outlines = (manifest.removeValue(forKey: "outlines") as? [[String: Any]]) ?? []
            let slim = Self.slimForWatch(manifest)
            /* The outlines follow the manifest, hole by hole, and never hold up
               its completion: the package is delivered once its parts are. */
            let afterManifest: (Bool) -> Void = { delivered in
                completion(delivered)
                guard delivered, !outlines.isEmpty else { return }
                self.queue.async { self.deliverOutlines(outlines, index: 0, failures: 0) }
            }
            let deliverManifest = {
                guard let holes = slim["holes"] as? [Any], !holes.isEmpty else {
                    self.send(["watchMapManifest": slim], completion: afterManifest)
                    return
                }
                var gate = AdaptiveGate(max: holes.count)
                gate.limit(to: self.watchMaxPart)
                self.deliverPart(base: slim, holes: holes, from: 0, gate: gate, failures: 0, completion: afterManifest)
            }
            guard let skeleton, let skeletonHoles = skeleton["holes"] as? [Any], !skeletonHoles.isEmpty else {
                deliverManifest()
                return
            }
            self.deliverSkeleton(base: skeleton, holes: skeletonHoles, from: 0, chunk: skeletonHoles.count, failures: 0) { _ in
                self.queue.async { deliverManifest() }
            }
        }
    }

    /* The hole OUTLINES (app/js/watch-map-delivery.js courseOutlines): one
       message per hole, ~0.3-1 KB each, the surfaces a watch draws when it
       cannot fetch the picture. A refused hole is split in two - each surface
       list halved, the second half marked `part` so the watch appends it -
       and five refusals in a row stop the run; what has landed stays. */
    private func deliverOutlines(_ messages: [[String: Any]], index: Int, failures: Int) {
        guard index < messages.count else { return }
        send(["courseOutlines": messages[index]]) { [weak self] sent in
            guard let self else { return }
            self.queue.async {
                if sent {
                    self.deliverOutlines(messages, index: index + 1, failures: 0)
                    return
                }
                NSLog("Garmin outlines for hole %@ refused (failure %d)", "\(messages[index]["n"] ?? "?")", failures + 1)
                if failures + 1 >= 5 { return }
                var next = messages
                if let halves = Self.splitOutline(messages[index]) {
                    next.replaceSubrange(index...index, with: [halves.0, halves.1])
                }
                self.queue.asyncAfter(deadline: .now() + .seconds(failures + 1)) {
                    self.deliverOutlines(next, index: index, failures: failures + 1)
                }
            }
        }
    }

    private static func splitOutline(_ message: [String: Any]) -> ([String: Any], [String: Any])? {
        var first = message, second = message
        second.removeValue(forKey: "g")
        second["part"] = true
        var moved = false
        for key in ["f", "b", "w", "t"] {
            let rings = (message[key] as? [Any]) ?? []
            let half = rings.count / 2
            first[key] = Array(rings[half...])
            second[key] = Array(rings[..<half])
            if half > 0 { moved = true }
        }
        return moved ? (first, second) : nil
    }

    /* The course skeleton (app/js/watch-map-delivery.js courseSkeleton): a few
       KB of per-hole geometry the watch plays every hole from on its own GPS.
       AHEAD of the manifest parts and the opposite way round to them - the
       whole course in one message first, since that is the point of it, and
       only halved when the link refuses it (to one hole at worst). Parts
       carry `part` like the manifest's and the watch merges them. An extra,
       never a gate: five refusals give up on it and the manifest goes anyway. */
    private func deliverSkeleton(base: [String: Any], holes: [Any], from: Int, chunk: Int,
                                 failures: Int, completion: @escaping (Bool) -> Void) {
        guard from < holes.count else { completion(true); return }
        let to = min(holes.count, from + chunk)
        var part = base
        part["holes"] = Array(holes[from..<to])
        if chunk < holes.count { part["part"] = ["from": from, "count": to - from, "total": holes.count] }
        send(["courseSkeleton": part]) { [weak self] sent in
            guard let self else { return }
            self.queue.async {
                if sent {
                    self.deliverSkeleton(base: base, holes: holes, from: to, chunk: chunk, failures: 0, completion: completion)
                    return
                }
                NSLog("Garmin course skeleton refused at %d holes (failure %d)", to - from, failures + 1)
                if failures + 1 >= 5 { completion(false); return }
                self.queue.asyncAfter(deadline: .now() + .seconds(failures + 1)) {
                    self.deliverSkeleton(base: base, holes: holes, from: from, chunk: max(1, chunk / 2),
                                         failures: failures + 1, completion: completion)
                }
            }
        }
    }

    private func deliverPart(base: [String: Any], holes: [Any], from: Int, gate: AdaptiveGate,
                             failures: Int, completion: @escaping (Bool) -> Void) {
        guard from < holes.count else { completion(true); return }
        let to = min(holes.count, from + gate.size)
        var part = base
        part["holes"] = Array(holes[from..<to])
        part["part"] = ["from": from, "count": to - from, "total": holes.count]
        send(["watchMapManifest": part]) { [weak self] sent in
            guard let self else { return }
            self.queue.async {
                var gate = gate
                if sent {
                    gate.succeeded()
                    self.deliverPart(base: base, holes: holes, from: to, gate: gate, failures: 0, completion: completion)
                    return
                }
                gate.failed()
                NSLog("Garmin manifest part refused; gate now %d (failure %d)", gate.size, failures + 1)
                if failures + 1 >= 5 { completion(false); return }
                self.queue.asyncAfter(deadline: .now() + .seconds(failures + 1)) {
                    self.deliverPart(base: base, holes: holes, from: from, gate: gate, failures: failures + 1, completion: completion)
                }
            }
        }
    }

    private static func slimForWatch(_ manifest: [String: Any]) -> [String: Any] {
        guard let holes = manifest["holes"] as? [[String: Any]] else { return manifest }
        var out = manifest
        out["holes"] = holes.map { hole -> [String: Any] in
            var slim = hole
            slim.removeValue(forKey: "reference")
            if let reference = hole["reference"] as? [String: Any], let green = reference["green"] {
                slim["reference"] = ["green": green]
            }
            return slim
        }
        return out
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
            /* paired: the player has chosen a watch. Survives disconnection. */
            paired: selected != nil,
            /* appInstalled: the real getAppStatus answer, not a proxy — a
               connected watch without Clarity Caddy reports false. */
            appInstalled: appInstalledOnDevice,
            reachable: connected
        )
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
        /* The watch's sender batches up to its gate's worth of commands into
           one message (garmin/source/Session/GarminSender.mc); each is handled
           and acknowledged exactly as a single one would be. */
        if let commands = message["commands"] as? [[String: Any]] {
            for command in commands { delegate?.wearableTransport(self, didReceiveCommand: command) }
        }
        if let inventory = message["watchMapHave"] as? [String: Any] {
            let wanted = (inventory["maxPart"] as? NSNumber)?.intValue ?? 0
            queue.async { [weak self] in self?.watchMaxPart = wanted }
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

/* How many items to put in the next message - start small, work up, back
   off. The same rule as Android's AdaptiveGate.java (unit-tested there) and
   the watch's GarminGate.mc: double until the first refusal; after one, grow
   a step at a time below the size that was refused; PROBE_AFTER clean sends
   at the edge probe one step past it; a refused probe returns to what last
   worked, any other refusal halves. `limit(to:)` is the far end asking for
   less (the watch's maxPart; 1 is hole by hole). */
struct AdaptiveGate {
    static let probeAfter = 8
    private(set) var size = 1
    private var max: Int
    private var ceiling = Int.max
    private var cleanAtEdge = 0
    private var lastGood = 0

    init(max: Int) { self.max = Swift.max(1, max) }

    mutating func limit(to requested: Int) {
        if requested >= 1 && requested < max { max = requested }
        if size > max { size = max }
    }

    mutating func succeeded() {
        lastGood = size
        if ceiling == Int.max { size = Swift.min(max, size * 2); return }
        if size + 1 < ceiling { size = Swift.min(max, size + 1); cleanAtEdge = 0; return }
        cleanAtEdge += 1
        if cleanAtEdge >= Self.probeAfter {
            ceiling += 1
            cleanAtEdge = 0
            size = Swift.min(max, size + 1)
        }
    }

    mutating func failed() {
        let probe = lastGood > 0 && size == lastGood + 1
        ceiling = Swift.max(1, size)
        cleanAtEdge = 0
        size = probe ? lastGood : Swift.max(1, size / 2)
        lastGood = 0
    }
}

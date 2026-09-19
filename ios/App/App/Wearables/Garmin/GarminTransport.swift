import Foundation
// import ConnectIQ  // Garmin Connect IQ Mobile SDK for iOS — not vendored in
                      // this repo yet. Add the .xcframework from Garmin's
                      // developer portal (developer.garmin.com/connect-iq),
                      // then uncomment this import and the commented
                      // conformances/calls below. This file IS in
                      // App.xcodeproj's Sources build phase and IS
                      // registered with WearableCoordinator
                      // (NativeRoundBridge.load()) — it compiles and runs
                      // today as a safe stub that never claims to reach a
                      // device (see `state()`/`send()` below), not because
                      // it's excluded from the build.

/*
 UNVERIFIED Connect IQ Mobile SDK calls — see below. WIRED INTO THE BUILD
 (Garmin Phase 1 plan step 4): registered alongside AppleWatchTransport in
 NativeRoundBridge.load(), and WearableCoordinator now fans out to both
 rather than only the first-registered transport — see
 WearableCoordinator.swift's header comment for why that had to change here
 rather than staying "deliberately left undefined."

 Everything that calls into `ConnectIQ`/`IQDevice`/`IQApp` below is written
 against this session's best understanding of the Connect IQ Mobile SDK for
 iOS's public API shape (ConnectIQ.sharedInstance() singleton; IQDevice for a
 paired device; IQApp scoping a message to one installed watch app;
 IQDeviceEventDelegate / IQAppMessageDelegate for callbacks). It has not been
 checked against the actual SDK headers — do that before trusting any single
 method or parameter name here. The ARCHITECTURE (what this class is
 responsible for, and the shape of WearableTransport it implements) is the
 part this session is confident about; the exact Garmin API calls are not.

 Mirrors AppleWatchTransport.swift's shape and responsibilities, adapted for
 Connect IQ:
   - initialise the Connect IQ SDK
   - discover/select a Garmin device (delegates the actual selection to
     GarminDeviceStore — this class only acts on whatever is already chosen)
   - register for device + app events
   - send/receive messages
   - expose state

 Does NOT own Caddy golf state — it is transport, exactly like
 AppleWatchTransport. Does NOT implement WearableFileAssetTransport: Garmin
 pulls map imagery by URL (see garmin/GarminMapDownloader.mc's header
 comment for why), so there is no bytes-over-the-wire asset path to
 implement on the phone side — publishMapManifest is enough, PROVIDED the
 manifest handed to this transport already carries a `url` per hole. That is
 not yet true of the manifest NativeRoundBridge.publishWatchMap forwards
 today (it is built once, generically, for whichever transports are
 registered) — wiring a Garmin-specific URL into that manifest is unresolved
 phone-side work, flagged here and in garmin/README.md, not silently assumed
 solved.
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

    init(deviceStore: GarminDeviceStore = GarminDeviceStore(), connectIQAppId: String) {
        self.deviceStore = deviceStore
        self.connectIQAppId = connectIQAppId
        super.init()
    }

    func activate() {
        // UNVERIFIED: ConnectIQ.sharedInstance().initialize(withUrlScheme:uiOverrideDelegate:)
        // or similar — the SDK needs a URL scheme registered in Info.plist
        // for the Connect Mobile app to hand control back to Caddy after
        // any device-pairing UI it presents. Also register for device
        // events on whichever device GarminDeviceStore currently holds, so
        // reachability/pairing changes reach `delegate` the same way
        // AppleWatchTransport's WCSessionDelegate callbacks do.
        //
        // if let selected = deviceStore.selectedDevice {
        //     let device = IQDevice(id: selected.deviceId, modelName: selected.model, friendlyName: selected.deviceName)
        //     ConnectIQ.sharedInstance().register(forDeviceEvents: device, delegate: self)
        //     let app = IQApp(uuid: UUID(uuidString: connectIQAppId), store: IQAppStore(), device: device)
        //     ConnectIQ.sharedInstance().register(forAppMessages: app, delegate: self)
        // }
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
            supported: true, // UNVERIFIED: should reflect ConnectIQ.sharedInstance() actually initialising
            activated: selected != nil,
            paired: selected != nil,
            appInstalled: connected, // best-effort proxy until device-status callbacks are wired
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
    func availableDevices() -> [String: Any] {
        // if ConnectIQ is linked:
        //   ConnectIQ.sharedInstance().showDeviceSelection()  // hands off to Garmin Connect
        //   and the chosen devices arrive via the URL-scheme callback, which
        //   should then call selectDevice(...) below.
        return [
            "devices": [[String: Any]](),
            "sdkLinked": false,
            "reason": "The Connect IQ Mobile SDK is not bundled in this build yet."
        ]
    }

    func selectDevice(id: String, name: String, model: String) {
        deviceStore.select(deviceId: id, deviceName: name, model: model)
        activate()
        delegate?.wearableTransportStateDidChange(self)
    }

    func clearSelectedDevice() {
        deviceStore.clearSelection()
        delegate?.wearableTransportStateDidChange(self)
    }

    /* The richer state the settings page needs, over and above the five
       booleans every transport reports through WearableTransportState. */
    func garminStateDictionary() -> [String: Any] {
        var out = state().asDictionary
        out["entitled"] = queue.sync { entitled }
        out["sdkLinked"] = false
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
        guard deviceStore.selectedDevice != nil else { completion(false); return }
        // UNVERIFIED: ConnectIQ.sharedInstance().sendMessage(_:toDevice:progress:completion:)
        // — the real send call. Until the SDK is linked this is a stub that
        // reports failure honestly rather than pretending to have sent
        // anything, matching the "native transport never infers success"
        // rule (Garmin Phase 1 plan step 8) — a stub must not claim
        // `published: true` it cannot back up.
        completion(false)
    }

    // MARK: - Receiving (wired once IQAppMessageDelegate is implemented)

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
}

/*
 UNVERIFIED conformances, commented out until ConnectIQ types are linked:

 extension GarminTransport: IQDeviceEventDelegate {
     func deviceStatusChanged(_ device: IQDevice, status: IQDeviceStatus) {
         deviceStore.recordConnectionState(status == .connected ? .connected : .notConnected)
         delegate?.wearableTransportStateDidChange(self)
     }
 }

 extension GarminTransport: IQAppMessageDelegate {
     func receivedMessage(_ message: Any, from app: IQApp) {
         guard let dict = message as? [String: Any] else { return }
         handleIncoming(dict)
     }
 }
*/

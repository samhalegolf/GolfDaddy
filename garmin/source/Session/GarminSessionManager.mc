using Toybox.Lang;
using Toybox.Communications;
using Toybox.System;
using Toybox.Time;

// The Garmin equivalent of ios/App/ClarityCaddyWatch/WatchSessionManager.swift.
// Mirrors its responsibilities exactly (see the Garmin Phase 1 plan step 10):
// current Scene, round state, handover state, pending commands, command
// retry, last rejection, player snapshot, map state, local GPS, local Bubble
// result, take-over/hand-back, and Scene revision protection — newer
// revision wins, older is ignored, and a new round ID discards pending
// commands from the old one.
//
// Deliberately NOT a WearableTransport-style abstraction: on the phone side,
// GarminTransport IS the transport and something else (WearableCoordinator)
// owns policy. On the device itself there is exactly one channel to the
// phone, so this class owns Communications directly — the same shape
// WatchSessionManager.swift itself takes on watchOS (it implements
// WCSessionDelegate directly; there is no separate AppleWatchTransport
// *inside* the Watch app).
class GarminSessionManager {

    // Face mirrors WatchSessionManager.Face: noRound, receiving, ready,
    // taking, playing.
    static var FACE_NO_ROUND = "noRound";
    static var FACE_RECEIVING = "receiving";
    static var FACE_READY = "ready";
    static var FACE_TAKING = "taking";
    static var FACE_PLAYING = "playing";

    var scene;              // GarminScene or null
    var state;               // "noRound" | "live" | "stale"
    var outbox;
    var locationManager;
    var playerStore;
    var mapStore;
    var playState;
    var lastRejection;       // GarminAcknowledgement or null
    var lockedShot;          // GarminLockedShot or null
    var handoverNotice;      // String or null
    var answeredHandovers;   // Dictionary used as a Set of handover ids

    function initialize() {
        scene = null;
        state = "noRound";
        outbox = new GarminOutbox();
        locationManager = new GarminLocationManager();
        playerStore = new GarminPlayerStore();
        mapStore = new GarminMapStore();
        playState = new GarminPlayState();
        lastRejection = null;
        lockedShot = null;
        handoverNotice = null;
        answeredHandovers = {};

        locationManager.onFix = method(:onLocationFix);

        try {
            Communications.registerForPhoneAppMessages(method(:onPhoneAppMessage));
        } catch (e) {
            // Communications not supported on this simulator/device config;
            // the numbers view still renders whatever it last held.
        }

        reportPlayerInventory();
    }

    // -------------------------------------------------------------- face

    function isDriving() { return scene != null && scene.isDriving(); }

    function mapsExpectedCount() {
        // Phase 1 does not yet carry a maps.total on the Scene the way the
        // Apple contract does (Surface.watch.maps) — Garmin reads it the
        // same way once GarminScene exposes it; until then this defers to
        // the map store's own manifest hole count when a manifest exists.
        var manifest = mapStore.manifest;
        return (manifest != null) ? manifest.holes.size() : 0;
    }

    function mapsHeldCount() {
        return mapStore.readyHoleCount(scene != null ? scene.courseKey() : null);
    }

    function face() {
        if (scene == null || !scene.hasRound()) { return FACE_NO_ROUND; }
        if (scene.isDriving()) { return FACE_PLAYING; }
        if ((scene.handoverState() != null && scene.handoverState().equals("offered"))
                || outbox.pendingOfType(GarminCommandKind.TAKE_OVER) != null) {
            return FACE_TAKING;
        }
        var expected = mapsExpectedCount();
        if (expected > 0 && mapsHeldCount() < expected) { return FACE_RECEIVING; }
        return FACE_READY;
    }

    // ------------------------------------------------------------ engine

    // Dictionary { "state" => ..., "mayComputeLocally" => Boolean }
    function engineAgreement() {
        var sceneVersion = (scene != null) ? scene.bubbleEngineVersion() : null;
        var snapshotVersion = (playerStore.snapshot != null) ? playerStore.snapshot.engineVersion : null;
        return GarminEngineVersion.agreement(sceneVersion, snapshotVersion);
    }

    // Garmin's own Bubble for the target currently in play. nil is a
    // complete, non-error answer with four honest causes: version
    // disagreement, no bag, no target, or no trustworthy fix — see
    // WatchSessionManager.localBubble's identical reasoning.
    function localBubble() {
        var agreement = engineAgreement();
        if (!agreement["mayComputeLocally"]) { return null; }
        if (playerStore.snapshot == null) { return null; }
        var fix = locationManager.lastFix;
        if (fix == null) { return null; }
        var aim = (scene != null) ? scene.aimTarget() : null;
        if (aim == null) { return null; }
        return GarminBubbleEngine.calculate({
            "player" => fix, "target" => aim,
            "bag" => playerStore.snapshot.bag, "bubble" => playerStore.snapshot.bubble
        });
    }

    // The point the numbers/map faces draw the player at: Garmin's own fix
    // while trustworthy, the phone's otherwise.
    function playerPoint() {
        if (locationManager.lastFix != null) { return locationManager.lastFix; }
        return (scene != null) ? scene.phoneLocation() : null;
    }

    // -------------------------------------------------------------- send

    // LOCK always resolves against Garmin's own GPS when a recent, accurate
    // fix exists — the phone can then stay in the bag. Falls back to
    // phone-authoritative LOCK only when Garmin has no trustworthy fix.
    // Mirrors WatchSessionManager.send(_:) exactly, including which wire
    // type is actually queued.
    function send(type) {
        if (scene == null || !scene.hasRound() || outbox.isPending(type)) { return; }
        lastRejection = null;
        var roundId = scene.roundId();
        var nowMs = nowEpochMillis();
        var wireType = type;
        var location = null;

        if (type.equals(GarminCommandKind.LOCK)) {
            var fix = locationManager.lastFix;
            var obs = GarminLocationObservation.build(
                fix, locationManager.lastAccuracy, locationManager.lastFixEpochMillis, nowMs, 30.0);
            if (obs != null) {
                wireType = GarminCommandKind.LOCK_AT;
                location = obs;
            }
        }

        var command = new GarminCommand(
            uuid(), roundId, scene.revision(), nowMs, wireType, location, null);

        // A LOCK Garmin computed for itself can show as locked at once,
        // rather than after a round trip — recorded against THIS command's
        // id so the acknowledgement that returns settles exactly this
        // record. If Garmin has no Bubble of its own, nothing is recorded
        // and the button waits, as it always did.
        if (type.equals(GarminCommandKind.LOCK)) {
            var bubble = localBubble();
            var fix = locationManager.lastFix;
            if (bubble != null && fix != null) {
                lockedShot = new GarminLockedShot(command.commandId, roundId, scene.revision(), scene.holeNumber(), bubble, fix, nowMs);
            }
        }

        outbox.enqueue(command);
        attempt(command.commandId);
    }

    // The aim, sent once — not on every drag frame (Phase 3 wires the UI
    // side of this; the send path exists now so it never needs a second
    // implementation). Raw, with no clamp of its own: Marshal owns the aim
    // roof, Garmin accepts its correction on the next Scene.
    function sendAim(point) {
        if (scene == null || !scene.hasRound() || !scene.canAim()) { return; }
        lastRejection = null;
        var command = new GarminCommand(
            uuid(), scene.roundId(), scene.revision(), nowEpochMillis(), GarminCommandKind.AIM_AT, null, point);
        outbox.enqueue(command);
        attempt(command.commandId);
    }

    function sendSimple(type) {
        if (scene == null || !scene.hasRound() || outbox.isPending(type)) { return; }
        lastRejection = null;
        var command = new GarminCommand(uuid(), scene.roundId(), scene.revision(), nowEpochMillis(), type, null, null);
        outbox.enqueue(command);
        attempt(command.commandId);
    }

    function attempt(commandId) {
        var wire = outbox.beginAttempt(commandId, nowEpochMillis());
        if (wire == null) { return; }
        transmit({ "command" => wire });
    }

    function retryPending() {
        var ids = outbox.allCommandIds();
        for (var i = 0; i < ids.size(); i += 1) { attempt(ids[i]); }
    }

    function dismissRejection() { lastRejection = null; }
    function dismissHandoverNotice() { handoverNotice = null; }

    // ----------------------------------------------------------- receive

    function onPhoneAppMessage(msg) {
        var data = msg.data;
        if (!(data instanceof Lang.Dictionary)) { return; }
        if (data.hasKey("scene")) { receiveScene(GarminWire.dictVal(data, "scene")); return; }
        // Garmin does not receive pushed map-asset bytes the way Apple does
        // (see GarminMapDownloader.mc's header comment): the manifest
        // carries a URL per hole, and GarminMapStore.bitmapFor() pulls on
        // demand, so there is no `watchMapAsset` message to handle here.
        if (data.hasKey("watchMapManifest")) { mapStore.receiveManifest(GarminWire.dictVal(data, "watchMapManifest")); reportMapInventory(); return; }
        if (data.hasKey("watchPlayer")) {
            if (playerStore.receive(GarminWire.dictVal(data, "watchPlayer"))) { reportPlayerInventory(); }
            return;
        }
        if (data.hasKey("acknowledgement")) { receiveAcknowledgement(GarminWire.dictVal(data, "acknowledgement")); return; }
    }

    function receiveScene(raw) {
        if (raw == null) { return; }
        var incoming = new GarminScene(raw);
        if (!incoming.isSupported()) { return; }
        if (!incoming.hasRound()) {
            scene = null;
            state = "noRound";
            lockedShot = null;
            locationManager.stop();
            return;
        }
        // Newer Scene revision wins; older is ignored — never regress the
        // driving surface's picture of the round.
        if (scene != null && scene.roundId() != null && incoming.roundId() != null
                && scene.roundId().equals(incoming.roundId()) && incoming.revision() < scene.revision()) {
            return;
        }
        var previous = scene;
        scene = incoming;
        state = "live";
        locationManager.start();
        reconcileOutbox(incoming);
        noteSurface(previous, incoming);
    }

    // A Scene arriving is proof the phone is listening. Commands for a round
    // that is no longer current are discarded (never retried); the rest
    // retry if they have been waiting a while. The phone dedupes by command
    // ID, so a repeat is safe.
    function reconcileOutbox(incoming) {
        outbox.discardCommandsForOtherRounds(incoming.roundId());
        var now = nowEpochMillis();
        var stale = outbox.staleCommandIds(now);
        for (var i = 0; i < stale.size(); i += 1) { attempt(stale[i]); }
        refreshLockedShot();
    }

    // Garmin's side of a handover. A phone-initiated one arrives "offered":
    // answering TAKE_OVER is how the phone learns the round actually
    // reached this device rather than a pocket. Answered once per handover
    // ID so a repeated Scene never becomes a repeated command.
    function noteSurface(previous, incoming) {
        var handoverId = incoming.handoverId();
        if (incoming.isDriving() && incoming.handoverState() != null && incoming.handoverState().equals("offered")
                && handoverId != null && !answeredHandovers.hasKey(handoverId)) {
            answeredHandovers[handoverId] = true;
            sendSimple(GarminCommandKind.TAKE_OVER);
        }
        var settledType = incoming.isDriving() ? GarminCommandKind.TAKE_OVER : GarminCommandKind.HAND_BACK;
        outbox.settleByType(settledType);

        var wasDriving = (previous != null) && previous.isDriving();
        if (wasDriving == incoming.isDriving()) { return; }
        if (incoming.isDriving()) {
            handoverNotice = (incoming.handoverFrom() != null && incoming.handoverFrom().equals("phone")) ? "Phone handed over" : "You're driving";
        } else if (previous != null) {
            handoverNotice = "Back on phone";
        }
    }

    function receiveAcknowledgement(raw) {
        if (raw == null) { return; }
        var ack = new GarminAcknowledgement(raw);
        outbox.settle(ack.commandId);
        if (!ack.accepted) {
            lastRejection = ack;
            if (lockedShot != null && lockedShot.commandId.equals(ack.commandId)) { lockedShot = null; }
        }
        refreshLockedShot();
    }

    // Ends 2 and 3 of GarminLockedShot's three honest outcomes: the Scene
    // has caught up, the round changed, or nothing came back at all.
    function refreshLockedShot() {
        if (lockedShot == null) { return; }
        var stillPending = false;
        for (var i = 0; i < outbox.pending.size(); i += 1) {
            if (outbox.pending[i]["command"]["commandId"].equals(lockedShot.commandId)) { stillPending = true; break; }
        }
        var sceneRevision = (scene != null) ? scene.revision() : null;
        var currentRound = (scene != null) ? scene.roundId() : null;
        if (!lockedShot.isStillShowing(currentRound, sceneRevision, stillPending, nowEpochMillis())) {
            lockedShot = null;
        }
    }

    function onLocationFix(coordinate, accuracy, epochMillis) {
        // Location updates recompute distance/local Bubble on the fly; the
        // target itself never moves because of a GPS update (Phase 3
        // aiming's rule, honoured here from day one).
        if (scene != null) { playState.update(coordinate); }
    }

    // ----------------------------------------------------------- report

    // Tells the phone which hole maps this device already holds, so the
    // phone re-sends only what is missing.
    function reportMapInventory() {
        transmit({ "watchMapHave" => mapStore.inventory() });
    }

    // Which bag this device holds, plus the engine it implements, so the
    // phone can spot a mismatch from its own side too.
    function reportPlayerInventory() {
        var held = playerStore.inventory();
        var engine = GarminEngineVersion.report();
        held["engineVersion"] = engine["engineVersion"];
        transmit({ "watchPlayerHave" => held });
    }

    // -------------------------------------------------------- transport

    function transmit(dict) {
        try {
            Communications.transmit(dict, null, method(:onTransmitComplete));
        } catch (e) {
            // Best-effort: a Scene/ack/inventory report is presentation
            // data, never a command-style outbox item, so a dropped send
            // simply waits for the next opportunity.
        }
    }

    function onTransmitComplete(data, transmitError) {
        // No further action: commands rely on the phone's ACK, never on
        // "message delivered" — see the Garmin Phase 1 plan step 8. This
        // callback exists only because Communications.transmit requires one.
    }

    // ----------------------------------------------------------- helpers

    function nowEpochMillis() {
        return Time.now().value() * 1000.0;
    }

    // Monkey C has no UUID generator in Toybox.Lang; commands only need to
    // be unique enough that the phone's dedupe-by-id never collides two
    // genuinely different commands. Time + Math.rand()'s pseudo-random
    // 32-bit value is sufficient at human interaction rates (one command
    // roughly every few seconds at most).
    function uuid() {
        return Lang.format("garmin-$1$-$2$", [nowEpochMillis().toNumber(), Toybox.Math.rand()]);
    }
}

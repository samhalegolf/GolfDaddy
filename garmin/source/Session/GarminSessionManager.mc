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

    // Face mirrors WatchSessionManager.Face: noRound, ready, taking, playing.
    // Apple's `receiving` face has no Garmin equivalent and is deliberately
    // absent: the phone pushes every hole image to an Apple Watch up front,
    // so "Receiving course 7/18" counts real progress there. Garmin pulls
    // each hole by URL the first time the map face asks for it
    // (GarminMapStore.bitmapFor), so nothing downloads while a status face
    // is showing — a Garmin "receiving" face could only ever sit at 0/18,
    // and it did, with SELECT (TAKE_OVER) unreachable behind it.
    static var FACE_NO_ROUND = "noRound";
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
    var sender;              // GarminSender: the one door to the phone
    var handoverNotice;      // String or null
    var answeredHandovers;   // Dictionary used as a Set of handover ids
    var skeleton;            // GarminCourseSkeleton or null
    var outlines;            // GarminCourseOutlines: what the map draws with no picture
    var lastSceneAt = null;  // System.getTimer() at the last Scene, or null
    var localHole = null;    // hole this wrist moved to on its own while the Scene was quiet

    // How long a Scene stays the authority on its own. Past this the wrist
    // plays from the course skeleton and its own GPS - unless the phone is
    // still connected over Bluetooth, which buys it PHONE_CONNECTED_FRESH_MS
    // (a phone standing still sends no new Scene, and that is not silence).
    static var SCENE_FRESH_MS = 20000;
    static var PHONE_CONNECTED_FRESH_MS = 300000;
    // Standing this close to the NEXT hole's tee, with the Scene quiet, is
    // walking onto it (the phone's own tee-zone idea, wrist-side).
    static var TEE_ZONE_M = 25.0d;

    function initialize() {
        scene = null;
        state = "noRound";
        outbox = new GarminOutbox();
        sender = new GarminSender(self);
        locationManager = new GarminLocationManager();
        playerStore = new GarminPlayerStore();
        mapStore = new GarminMapStore();
        playState = new GarminPlayState();
        lastRejection = null;
        lockedShot = null;
        handoverNotice = null;
        answeredHandovers = {};
        skeleton = GarminCourseSkeleton.restore();
        outlines = new GarminCourseOutlines();

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

    // A round that is not being driven from this wrist is READY to take
    // over the moment its Scene arrives. Maps never gate this: the map face
    // fetches its own hole on demand and says "Loading map..." until it has
    // it, and the numbers face needs no map at all.
    function face() {
        if (scene == null || !scene.hasRound()) { return FACE_NO_ROUND; }
        if (scene.isDriving()) { return FACE_PLAYING; }
        if ((scene.handoverState() != null && scene.handoverState().equals("offered"))
                || outbox.pendingOfType(GarminCommandKind.TAKE_OVER) != null
                || outbox.pendingOfType(GarminCommandKind.DEMO_APPROACH) != null) {
            return FACE_TAKING;
        }
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
    //
    // Phase 3 note: Apple's own architecture keeps two separate local-Bubble
    // paths — WatchSessionManager.localBubble (Scene-target-based, for the
    // read-only faces) and AimableHoleMap's own private WatchPlayState
    // (locally-aimed-target-based, owned entirely by the map view). Garmin
    // shares one GarminPlayState instance instead of instantiating a second
    // engine, so this method reproduces the same OUTCOME by preferring
    // playState's own target/bubble once GarminMapView has actually moved
    // one (drag, nudge, or the seed move `enterAimMode()` makes) — see
    // GarminMapView.mc's header comment for how playState gets driven.
    var lastBubbleReason = "";
    // Simulator-only trace: says which of the four honest causes is holding
    // the local Bubble back, once per change. Compiled out of live builds.
    function noteBubbleReason(reason) {
        if (!GarminTransmitPolicy.muted()) { return; }
        if (reason.equals(lastBubbleReason)) { return; }
        lastBubbleReason = reason;
        System.println("local bubble: " + reason
            + " (fix=" + locationManager.lastFix + " accuracy=" + locationManager.lastAccuracy + ")");
    }

    function localBubble() {
        var agreement = engineAgreement();
        if (!agreement["mayComputeLocally"]) { noteBubbleReason("engine " + agreement["state"]); return null; }
        if (playerStore.snapshot == null) { noteBubbleReason("no player snapshot"); return null; }
        var fix = effectiveFix();
        if (fix == null) { noteBubbleReason("no usable fix"); return null; }
        if (playState.target != null && playState.bubble != null) {
            noteBubbleReason("local aim bubble");
            return playState.bubble;
        }
        var aim = aimTarget();
        if (aim == null) { noteBubbleReason("no aim target"); return null; }
        // Memoised on its inputs. The engine (club choice + a 168-point
        // ring) is the single most expensive thing the app does, and both
        // faces ask for this on every redraw - once a second at least. On a
        // 120k watchdog budget (Forerunner 255) recomputing it inside the
        // map's draw pass tripped the watchdog (2026-10-05). It is warmed in
        // receiveScene / onLocationFix, each its own callback and budget, so
        // a draw normally only reads the cache.
        var key = fix.lat + "," + fix.lng + "|" + aim.lat + "," + aim.lng + "|" + playerStore.snapshot.fingerprint;
        if (key.equals(bubbleCacheKey)) { return bubbleCache; }
        noteBubbleReason("computing for scene aim");
        bubbleCache = GarminBubbleEngine.calculate({
            "player" => fix, "target" => aim,
            "bag" => playerStore.snapshot.bag, "bubble" => playerStore.snapshot.bubble
        });
        bubbleCacheKey = key;
        return bubbleCache;
    }
    var bubbleCache = null;
    var bubbleCacheKey = "";

    // The point the numbers/map faces draw the player at: Garmin's own fix
    // while trustworthy, the phone's otherwise.
    function playerPoint() {
        var fix = effectiveFix();
        if (fix != null) { return fix; }
        return (scene != null) ? scene.phoneLocation() : null;
    }

    // Where this wrist believes the player is: the demo's planted point
    // while a demo approach is on, the wrist's own GPS otherwise.
    function isDemo() { return scene != null && scene.isDemo(); }
    function effectiveFix() {
        if (isDemo()) { return scene.demoPosition(); }
        return locationManager.lastFix;
    }

    // -------------------------------------------------------- skeleton

    function receiveSkeleton(raw) {
        var incoming = GarminCourseSkeleton.fromDict(raw);
        if (incoming == null) { return; }
        var isPart = raw.hasKey("part");
        if (!(isPart && skeleton != null && skeleton.merge(incoming))) { skeleton = incoming; }
        skeleton.persist();
        if (GarminTransmitPolicy.muted()) {
            System.println("skeleton in: " + skeleton.courseKey + " v" + skeleton.version + " holes=" + skeleton.holes.size());
        }
    }

    // The skeleton, only while it describes the course being played AND the
    // same package version as the map under it: a newer package may have
    // moved a green, and a skeleton from the older one would put the numbers
    // and the picture in different places.
    function skeletonFor() {
        if (skeleton == null || scene == null) { return null; }
        var key = scene.courseKey();
        if (key == null || !key.equals(skeleton.courseKey)) { return null; }
        var manifest = mapStore.manifest;
        if (manifest != null && manifest.courseKey.equals(key) && manifest.version != skeleton.version) { return null; }
        return skeleton;
    }

    // A hole's outlines (image pixels), only while they were cut from the
    // very package the map holds - the same course and version - since
    // pixels mean nothing against another package's spatial reference.
    function outlinesFor(holeNumber) {
        var manifest = mapStore.manifest;
        if (manifest == null || outlines.courseKey == null || scene == null) { return null; }
        var key = scene.courseKey();
        if (key == null || !key.equals(manifest.courseKey) || !manifest.courseKey.equals(outlines.courseKey)) { return null; }
        if (manifest.version != outlines.version) { return null; }
        return outlines.hole(holeNumber);
    }

    // The colours a drawn map uses: the package palette the phone sent with
    // the skeleton, else the base palette every package started from
    // (scripts/gd-watch-map-core.js WATCH_MAP_RECIPE_V1.colors).
    //
    // Only on a full-colour (AMOLED) screen. The memory-in-pixel screens show
    // 64 colours - each channel 00/55/AA/FF - and snap the package's soft
    // greens to the nearest, which is GREY (0x315833 -> 0x555555, seen on the
    // fenix 7 sim 2026-10-06). They get the closest honest picks instead:
    // rough darkest, fairway, green lightest, sand, water. Trees are the
    // rough with black mixed in (black alone where there is no pattern
    // fill), hazards (gorse, scrub) dark olive, waste the 64-colour palette's
    // olive sand.
    // Each turf surface has a dark and a light variant for the terrain
    // pieces (rd/rl, fd/fl, gd/gl). The 64-colour screens show shadow only -
    // a lighter green than the surface reads as a different surface there
    // (seen in the 2026-10-06 previews) - so their light variant IS the
    // surface's own colour - as a solid colour. With pattern fills
    // (Connect IQ 4.0, Dc.setFill) each turf surface instead mixes in its
    // neighbours (Sam, 2026-10-06): its shadow a sprinkle of the next DARKER
    // surface, its light a sprinkle of the next LIGHTER one - rough with
    // black and fairway green, fairway with rough and green, green with
    // fairway. A pattern is [base, mix, n, fallback]: a 2x2 tile with n of
    // its 4 pixels in `mix`, an in-between shade this screen cannot show any
    // other way (the only solid colour darker than the rough is black, which
    // was far too dark). `fallback` is the solid colour for a watch without
    // pattern fills, or null to leave that surface flat there.
    static var MIP_PALETTE = {
        "r" => 0x005500, "rd" => [0x005500, 0x000000, 2, null], "rl" => [0x005500, 0x55AA55, 2, null],
        "f" => 0x55AA55, "fd" => [0x55AA55, 0x005500, 1, 0x00AA55], "fl" => [0x55AA55, 0xAAFFAA, 2, null],
        "g" => 0xAAFFAA, "gd" => [0xAAFFAA, 0x55AA55, 1, 0x55FF55], "gl" => 0xAAFFAA,
        "b" => 0xFFFFAA, "w" => 0x0055AA,
        "k" => [0x005500, 0x000000, 3, 0x000000], "h" => 0x555500, "z" => 0xAAAA55
    };
    // The base palette every package started from, with its variants worked
    // out as the phone does (watch-map-delivery.js cleanPalette: x0.8, x1.22).
    static var BASE_PALETTE = {
        "r" => 0x315833, "rd" => 0x274629, "rl" => 0x3C6B3E,
        "f" => 0x4E9A52, "fd" => 0x3E7B42, "fl" => 0x5FBC64,
        "g" => 0x8BD28D, "gd" => 0x6FA871, "gl" => 0xAAFFAC,
        "b" => 0xE9DAAE, "w" => 0x2D69A2,
        "k" => 0x18361A, "h" => 0x756533, "z" => 0xB1A47E
    };
    function mapPalette() {
        var settings = System.getDeviceSettings();
        var amoled = (settings has :requiresBurnInProtection) && settings.requiresBurnInProtection;
        if (!amoled) { return MIP_PALETTE; }
        var out = {};
        var keys = BASE_PALETTE.keys();
        for (var i = 0; i < keys.size(); i += 1) { out[keys[i]] = BASE_PALETTE[keys[i]]; }
        var pal = (skeleton != null) ? skeleton.palette() : null;
        if (pal != null) {
            var pk = pal.keys();
            for (var j = 0; j < pk.size(); j += 1) {
                var v = pal[pk[j]];
                if (v instanceof Lang.Number && out.hasKey(pk[j])) { out[pk[j]] = v; }
            }
        }
        return out;
    }

    // Whether the Scene still speaks for the round (see SCENE_FRESH_MS).
    function sceneFresh() {
        if (scene == null || lastSceneAt == null) { return false; }
        var age = System.getTimer() - lastSceneAt;
        if (age < SCENE_FRESH_MS) { return true; }
        if (!GarminSimDemoPolicy.phoneLinkCounts()) { return false; }
        var settings = System.getDeviceSettings();
        return (settings has :phoneConnected) && settings.phoneConnected && age < PHONE_CONNECTED_FRESH_MS;
    }

    // The hole being played: the Scene's, or the one this wrist walked onto
    // by itself while the Scene was quiet.
    function currentHole() {
        if (localHole != null) { return localHole; }
        return (scene != null) ? scene.holeNumber() : null;
    }

    // Whether the Scene describes the hole being played right now.
    function sceneSpeaksForHole() {
        return scene != null && localHole == null && sceneFresh();
    }

    // { "front", "centre", "back", "fromWatch" }: the phone's numbers while
    // the Scene speaks for this hole and carries them, otherwise this wrist's
    // own - the skeleton measured from its fix - and the phone's last ones
    // only when there is no skeleton to measure from at all.
    function greenDistances() {
        if (sceneSpeaksForHole() && scene.distanceCentreM() != null) {
            lastSourceWatch = false;
            return { "front" => scene.distanceFrontM(), "centre" => scene.distanceCentreM(), "back" => scene.distanceBackM(), "fromWatch" => false };
        }
        var sk = skeletonFor();
        var fix = effectiveFix();
        var mine = (sk != null) ? sk.distances(currentHole(), fix) : null;
        if (mine != null) {
            mine["fromWatch"] = true;
            if (GarminTransmitPolicy.muted() && !lastSourceWatch) {
                System.println("skeleton: numbers from watch GPS, hole " + currentHole() + " centre " + mine["centre"].toNumber() + "m");
            }
            lastSourceWatch = true;
            return mine;
        }
        if (scene != null && localHole == null) {
            return { "front" => scene.distanceFrontM(), "centre" => scene.distanceCentreM(), "back" => scene.distanceBackM(), "fromWatch" => false };
        }
        return null;
    }

    var lastSourceWatch = false;   // simulator trace only: log the flip once

    function holeLengthM() {
        if (scene != null && localHole == null && scene.holeTeeToGreenM() != null) { return scene.holeTeeToGreenM(); }
        var sk = skeletonFor();
        return (sk != null) ? sk.lengthM(currentHole()) : null;
    }

    // The fairway line the layup guide is drawn against.
    function holeLine() {
        if (scene != null && localHole == null) {
            var line = scene.holeLine();
            if (line.size() >= 2) { return line; }
        }
        var sk = skeletonFor();
        return (sk != null) ? sk.line(currentHole()) : [];
    }

    // What the Bubble aims at by default: the Scene's target for its own
    // hole, the skeleton's green for a hole the wrist walked onto itself.
    function aimTarget() {
        if (scene == null) { return null; }
        if (localHole == null) { return scene.aimTarget(); }
        var sk = skeletonFor();
        return (sk != null) ? sk.green(localHole) : null;
    }

    function holePar() {
        var n = currentHole();
        if (scene == null || n == null) { return null; }
        if (localHole == null && scene.holePar() != null) { return scene.holePar(); }
        return scene.parFor(n);
    }

    // With the Scene quiet, reaching the next hole's tee moves this wrist on
    // to it - the numbers, the map and the Bubble with it. Never while the
    // Scene speaks (the phone owns hole changes then), never during a demo,
    // and never backwards.
    function noteTeeZone(fix) {
        if (fix == null || sceneFresh()) { return; }
        var sk = skeletonFor();
        var n = currentHole();
        if (sk == null || n == null) { return; }
        var nextTee = sk.tee(n + 1);
        if (nextTee == null || GarminGeo.distance(fix, nextTee) > TEE_ZONE_M) { return; }
        localHole = n + 1;
        playState.enter(localHole);
        if (GarminTransmitPolicy.muted()) { System.println("skeleton: walked onto hole " + localHole + " tee"); }
    }

    // ------------------------------------------------------------ demo

    // The Ready face's hole cursor, when the phone offers the demo. Holes come
    // off the Scene's pars (sorted), else 1-18; the phone refuses any hole it
    // does not have, so the fallback can only cost a "Couldn't" notice.
    var demoIndex = null;
    function demoHoles() {
        var out = [];
        var pars = (scene != null) ? scene.coursePars() : null;
        if (pars != null) {
            var keys = pars.keys();
            for (var i = 0; i < keys.size(); i += 1) {
                var n = (keys[i] instanceof Lang.String) ? keys[i].toNumber() : null;
                if (n != null) { out.add(n); }
            }
        }
        // No pars: the delivered package's holes, as Apple's demoHoles does,
        // then 1-18 as the last resort.
        if (out.size() == 0 && mapStore.manifest != null && scene != null
                && scene.courseKey() != null && mapStore.manifest.courseKey.equals(scene.courseKey())) {
            for (var m = 0; m < mapStore.manifest.holes.size(); m += 1) { out.add(mapStore.manifest.holes[m].holeNumber); }
        }
        if (out.size() == 0) {
            for (var h = 1; h <= 18; h += 1) { out.add(h); }
        }
        // Insertion sort: no Array.sort before API 5.
        for (var j = 1; j < out.size(); j += 1) {
            var v = out[j];
            var k = j - 1;
            while (k >= 0 && out[k] > v) { out[k + 1] = out[k]; k -= 1; }
            out[k + 1] = v;
        }
        return out;
    }
    // What the browser steps through: the Scene's named situations when it
    // offers them, otherwise one entry per hole.
    function demoEntries() {
        var options = (scene != null) ? scene.demoOptions() : [];
        if (options.size() > 0) { return options; }
        var holes = demoHoles();
        var out = [];
        for (var i = 0; i < holes.size(); i += 1) { out.add({ "hole" => holes[i], "option" => null, "label" => null }); }
        return out;
    }
    function demoEntry() {
        var entries = demoEntries();
        if (demoIndex == null) {
            // Open on the hole the phone is showing.
            demoIndex = 0;
            var current = (scene != null) ? scene.holeNumber() : null;
            for (var i = entries.size() - 1; i >= 0; i -= 1) { if (current != null && entries[i]["hole"] == current) { demoIndex = i; } }
        }
        if (demoIndex >= entries.size()) { demoIndex = 0; }
        return entries[demoIndex];
    }
    function demoHole() { return demoEntry()["hole"]; }
    function stepDemo(delta) {
        var entries = demoEntries();
        demoEntry();
        demoIndex = (demoIndex + delta + entries.size()) % entries.size();
    }
    function startDemo() {
        if (scene == null || !scene.hasRound() || outbox.isPending(GarminCommandKind.DEMO_APPROACH)) { return; }
        lastRejection = null;
        var command = new GarminCommand(uuid(), scene.roundId(), scene.revision(), nowEpochMillis(), GarminCommandKind.DEMO_APPROACH, null, null);
        var entry = demoEntry();
        command.payloadHole = entry["hole"];
        command.payloadOption = entry["option"];
        outbox.enqueue(command);
        attempt(command.commandId);
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

        // In a demo there is no wrist GPS to stamp a LOCK with: the phone
        // plays it from the planted point.
        if (type.equals(GarminCommandKind.LOCK) && !isDemo()) {
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
            var fix = effectiveFix();
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

    // Commands no longer go out one by one the moment they are made: the
    // sender batches what is due, through its gate (GarminSender.mc).
    function attempt(commandId) { sender.pump(); }
    function retryPending() { sender.pump(); }

    // Called every second by the app's refresh timer: timeouts, spacing and
    // resends all move on the clock, not only on events.
    function tick() { sender.pump(); }

    function dismissRejection() { lastRejection = null; }
    function dismissHandoverNotice() { handoverNotice = null; }

    // ----------------------------------------------------------- receive

    // Typed: registerForPhoneAppMessages wants Communications.PhoneMessageCallback.
    function onPhoneAppMessage(msg as Communications.PhoneAppMessage) as Void {
        var data = msg.data;
        if (!(data instanceof Lang.Dictionary)) { return; }
        sender.noteLinkProven();
        // Simulator-only build: the console is the only window into what
        // the tether delivered. Compiled out of every live build.
        if (GarminTransmitPolicy.muted()) {
            var sc = data.hasKey("scene") ? GarminWire.dictVal(data, "scene") : null;
            var rev = (sc != null) ? sc["revision"] : null;
            var surf = (sc != null && sc.hasKey("surface")) ? sc["surface"] : null;
            System.println("rx: " + data.keys() + (rev != null ? " rev " + rev : "")
                + " surface=" + surf + " face=" + face());
        }
        if (data.hasKey("scene")) { receiveScene(GarminWire.dictVal(data, "scene")); return; }
        // Garmin does not receive pushed map-asset bytes the way Apple does
        // (see GarminMapDownloader.mc's header comment): the manifest
        // carries a URL per hole, and GarminMapStore.bitmapFor() pulls on
        // demand, so there is no `watchMapAsset` message to handle here.
        if (data.hasKey("courseSkeleton")) { receiveSkeleton(GarminWire.dictVal(data, "courseSkeleton")); return; }
        if (data.hasKey("courseOutlines")) { outlines.receive(GarminWire.dictVal(data, "courseOutlines")); return; }
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
        sender.noteLinkProven();
        if (!incoming.hasRound()) {
            scene = null;
            state = "noRound";
            lockedShot = null;
            // A new hole is a new shot, and no round at all is the same
            // rule at a larger scale: everything about the old target/held
            // club/Bubble goes (GarminPlayState.enter's own reasoning).
            playState = new GarminPlayState();
            locationManager.stop();
            return;
        }
        // Newer Scene revision wins; older is ignored — never regress the
        // driving surface's picture of the round.
        if (scene != null && scene.roundId() != null && incoming.roundId() != null
                && scene.roundId().equals(incoming.roundId()) && incoming.revision() < scene.revision()) {
            return;
        }
        var previousHole = currentHole();
        var previous = scene;
        scene = incoming;
        state = "live";
        // The Scene is the authority again: whatever hole the wrist walked
        // to on its own while it was quiet gives way to the phone's.
        lastSceneAt = System.getTimer();
        localHole = null;
        // A new hole discards the old one's local target/held club/Bubble —
        // GarminPlayState.enter() (Garmin Phase 2+3 plan step 30): "load new
        // map, reset local target state, adopt new authoritative Scene
        // target, recompute local Bubble, reframe camera." The map/camera
        // half of that is GarminMapView's own framedHoleNumber check
        // (Phase 2); this is the target/Bubble half.
        var incomingHole = incoming.holeNumber();
        if (incomingHole != null && (previousHole == null || previousHole != incomingHole)) {
            playState.enter(incomingHole);
        }
        // A demo plants the player and the wrist's GPS sits it out (stop()
        // reports a null fix, which onLocationFix ignores during a demo, so
        // the planted point is written after). Leaving the demo hands the
        // job straight back.
        var planted = incoming.demoPosition();
        if (planted != null) {
            if (previous == null || !previous.isDemo()) { locationManager.stop(); }
            playState.update(planted);
            if (playState.target != null && playerStore.snapshot != null) {
                playState.moveTarget(playState.target, playerStore.snapshot.bag, playerStore.snapshot.bubble);
            }
        } else {
            if (previous != null && previous.isDemo()) { playState.update(null); }
            locationManager.start();
            locationManager.poll();
        }
        if (!incoming.canDemo()) { demoIndex = null; }
        localBubble();   // warm the Bubble cache in this callback, not in a draw
        // And unpack the hole's outlines here too: a curved green or bunker
        // is ~50 points, and decoding a hole inside the first map draw on top
        // of everything else tripped the Forerunner 255's watchdog.
        outlinesFor(currentHole());
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

    // A fresh fix moves the player and re-sizes the Bubble for the new
    // distance (plan step 31). It never moves the target: walking towards a
    // target already placed is the point. Mirrors
    // AimableHoleMap.swift's .onChange(of: player) exactly — update the
    // player, then re-run moveTarget against whatever target is already
    // held, if any, so the ring on screen tracks the walk.
    function onLocationFix(coordinate, accuracy, epochMillis) {
        if (scene == null || scene.isDemo()) { return; }
        noteTeeZone(coordinate);
        playState.update(coordinate);
        if (playState.target != null && playerStore.snapshot != null) {
            playState.moveTarget(playState.target, playerStore.snapshot.bag, playerStore.snapshot.bubble);
        }
        localBubble();
    }

    // ----------------------------------------------------------- report

    // Tells the phone which hole maps this device already holds, so the
    // phone re-sends only what is missing.
    function reportMapInventory() {
        var inventory = mapStore.inventory();
        // Hole by hole when the watch needs it: a small watch-app memory
        // budget, or a link that has been failing. The phone's adaptive
        // sender never goes above this (AdaptiveGate.limitTo / limitTo).
        var stats = System.getSystemStats();
        if (sender.struggling() || stats.totalMemory < 600 * 1024) { inventory["maxPart"] = 1; }
        sender.queueReport("watchMapHave", inventory);
    }

    // Which bag this device holds, plus the engine it implements, so the
    // phone can spot a mismatch from its own side too.
    function reportPlayerInventory() {
        var held = playerStore.inventory();
        var engine = GarminEngineVersion.report();
        held["engineVersion"] = engine["engineVersion"];
        sender.queueReport("watchPlayerHave", held);
    }

    // -------------------------------------------------------- transport

    // The wire itself, used only by GarminSender, which is told the outcome
    // (sender.onSent) by whichever path carried it.
    function rawTransmit(dict) {
        // The standalone simulator demo answers for the phone (compiled to
        // `false` everywhere else - GarminSimDemoPolicy.mc); it reports the
        // send's outcome to the sender itself.
        if (GarminSimDemoPolicy.handle(dict)) { return; }
        // Simulator-only muted build (GarminTransmitPolicy.mc): the reply
        // is logged and dropped, because sending it would kill the
        // simulator. A normal build compiles this branch to `false`.
        if (GarminTransmitPolicy.muted()) {
            var relay = GarminTransmitPolicy.relayUrl();
            if (relay == null) {
                System.println("transmit muted: " + dict.keys());
                sender.onSent(true);
                return;
            }
            // Simulator relay (GarminTransmitPolicy.relayUrl): the message
            // goes to the Mac as an HTTP POST instead of over the tether.
            // Same dictionary, same moment; only the wire differs.
            System.println("transmit relayed: " + dict.keys());
            try {
                Communications.makeWebRequest(relay, dict, {
                    :method => Communications.HTTP_REQUEST_METHOD_POST,
                    :headers => { "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON },
                    :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
                }, method(:onRelayResponse));
            } catch (e) {
                System.println("relay threw: " + e.getErrorMessage());
                sender.onSent(false);
            }
            return;
        }
        try {
            Communications.transmit(dict, null, new GarminTransmitListener(sender));
        } catch (e) {
            // Refused before it left: a failure like any other, so the gate
            // narrows and the command stays queued for its resend.
            sender.onSent(false);
        }
    }

    // The relay's answer is only ever informative: a command is settled by
    // the phone's acknowledgement (which still arrives over the tether, the
    // direction that works), never by "the relay took it". Compiled into
    // every build so the method reference above always resolves; the live
    // build simply never calls it.
    function onRelayResponse(responseCode as Lang.Number, data as Lang.Dictionary or Lang.String or Null) as Void {
        if (responseCode != 200) { System.println("relay answered " + responseCode + " " + data); }
        sender.onSent(responseCode == 200);
    }

    // Communications.transmit takes a ConnectionListener object (onComplete /
    // onError, both no-arg) — not a Method reference. Nothing to do in either:
    // commands rely on the phone's ACK, never on "message delivered" — see the
    // Garmin Phase 1 plan step 8. The listener exists only because transmit
    // requires one.

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

// The transmit's two outcomes, finally heard: they drive the sender's gate.
// (Commands are still settled only by the phone's acknowledgement.)
class GarminTransmitListener extends Communications.ConnectionListener {
    var sender;
    function initialize(sender) {
        ConnectionListener.initialize();
        self.sender = sender;
    }
    function onComplete() as Void { sender.onSent(true); }
    function onError() as Void { sender.onSent(false); }
}

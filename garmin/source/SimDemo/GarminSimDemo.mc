using Toybox.Lang;
using Toybox.System;
using Toybox.Timer;
using Toybox.WatchUi;

// The phone, for a demo round in the simulator. Compiled only into
// `CIQ_SIM_DEMO=1` builds (see GarminSimDemoPolicy.mc).
//
// A demo round needs nothing from GPS and nothing the watch does not already
// hold: a lite-map package, the hole images, the player's bag, and a Scene
// saying which hole is live and where the demo put the player. So this
// loads a fixture course (resources-sim-demo/, built from a real package by
// tools/make-sim-demo-fixture.js), hands the watch its package and bag as if
// the phone had sent them, and then answers the watch's OWN commands the way
// app/js/caddy-watch.js + demo-approach.js would: DEMO_APPROACH starts a hole
// with the wrist driving, LOCK puts the shot on the green (a demo approach is
// always in reach), AIM_AT moves the target, UNLOCK and DEMO_END go back.
// Every answer is a real acknowledgement followed by a real Scene, through
// the same receiveAcknowledgement / receiveScene a phone message reaches -
// so everything downstream of the transport is the code that ships.
//
// It is deliberately not a second Marshal: one demo position per hole, the
// green as the only default target. What it proves is the WATCH: the
// browser, the hand-over, distances, the local Bubble, the map, aiming.
(:sim_demo)
class GarminSimDemo {
    static var instance = null;

    var session;
    var fixture;
    var courseKey;
    var revision = 0;
    var hole = null;        // the live demo hole, or null in Preview
    var situation = null;   // the fixture situation being played
    var driving = false;
    var locked = false;
    var target = null;      // GarminCoordinate while locked
    var queue = [];         // answers waiting for the timer: [ack, scene]
    var timer = null;
    var bitmapHole = null;
    var bitmapCache = null;

    function initialize(session) {
        self.session = session;
    }

    function start() {
        fixture = WatchUi.loadResource(Rez.JsonData.simDemo);
        courseKey = fixture["course"]["key"];
        session.playerStore.receive(fixture["player"]);
        session.mapStore.receiveManifest(manifestDict());
        System.println("sim demo: " + fixture["course"]["name"] + " holes=" + fixture["holes"].size()
            + " bag=" + (session.playerStore.snapshot != null));
        session.receiveScene(scene());
    }

    // ------------------------------------------------------------ commands

    function handle(dict) {
        if (!(dict instanceof Lang.Dictionary)) { return true; }
        var command = dict.hasKey("command") ? dict["command"] : null;
        // Inventory reports and anything else the watch tells a phone: there
        // is nobody to tell. Swallowed, never transmitted.
        if (!(command instanceof Lang.Dictionary)) { return true; }
        var type = command["type"];
        var payload = command.hasKey("payload") ? command["payload"] : {};
        var accepted = apply(type, payload);
        System.println("sim demo: " + type + (accepted ? " accepted" : " rejected"));
        queue.add([{
            "commandId" => command["commandId"],
            "accepted" => accepted,
            "reason" => accepted ? null : "marshal-rejected",
            "revision" => revision
        }, accepted ? scene() : null]);
        // A phone answers later, never inside the send that asked. Answering
        // re-entrantly would settle the outbox before send() has finished
        // recording what it sent.
        if (timer == null) { timer = new Timer.Timer(); }
        timer.start(method(:flush), 150, false);
        return true;
    }

    function flush() as Void {
        var pending = queue;
        queue = [];
        for (var i = 0; i < pending.size(); i += 1) {
            session.receiveAcknowledgement(pending[i][0]);
            if (pending[i][1] != null) { session.receiveScene(pending[i][1]); }
        }
        WatchUi.requestUpdate();
    }

    function apply(type, payload) {
        if (type.equals(GarminCommandKind.DEMO_APPROACH)) {
            var n = (payload instanceof Lang.Dictionary && payload.hasKey("hole")) ? payload["hole"] : null;
            var option = (payload instanceof Lang.Dictionary && payload.hasKey("option")) ? payload["option"] : null;
            var picked = situationFor(n, option);
            if (picked == null || holeFixture(n) == null) { return false; }
            hole = n;
            situation = picked;
            driving = true;
            locked = false;
            target = null;
            return true;
        }
        if (type.equals(GarminCommandKind.DEMO_END)) {
            if (hole == null) { return false; }
            hole = null;
            situation = null;
            driving = false;
            locked = false;
            target = null;
            return true;
        }
        if (type.equals(GarminCommandKind.TAKE_OVER)) {
            if (hole == null) { return false; }
            driving = true;
            return true;
        }
        if (type.equals(GarminCommandKind.HAND_BACK)) {
            driving = false;
            return true;
        }
        if (type.equals(GarminCommandKind.LOCK) || type.equals(GarminCommandKind.LOCK_AT)) {
            if (hole == null || locked) { return false; }
            locked = true;
            target = defaultTarget();
            return true;
        }
        if (type.equals(GarminCommandKind.UNLOCK)) {
            if (!locked) { return false; }
            locked = false;
            target = null;
            return true;
        }
        if (type.equals(GarminCommandKind.AIM_AT)) {
            var p = (payload instanceof Lang.Dictionary) ? GarminWire.coordinate(GarminWire.dictVal(payload, "point")) : null;
            if (!locked || p == null) { return false; }
            target = p;
            return true;
        }
        return false;
    }

    // --------------------------------------------------------------- Scene

    function scene() {
        revision += 1;
        var n = (hole != null) ? hole : fixture["holes"][0]["n"];
        var f = holeFixture(n);
        var pos = (situation != null) ? point(situation["pos"]) : null;
        var line = [];
        for (var i = 0; i < f["line"].size(); i += 1) { line.add(geo(point(f["line"][i]))); }

        var out = {
            "schemaVersion" => 1,
            "roundId" => "sim-demo",
            "revision" => revision,
            "flow" => hole != null ? "live" : "preview",
            "mode" => locked ? "bubble" : "standard",
            "course" => { "key" => courseKey, "name" => fixture["course"]["name"] },
            "hole" => { "number" => n, "live" => hole != null, "teeToGreenM" => f["len"], "line" => line },
            "shot" => { "locked" => locked, "open" => locked },
            "controls" => {
                "canLock" => hole != null && !locked, "canUnlock" => locked, "canAim" => locked,
                "canPreviousHole" => false, "canNextHole" => false,
                "canPlay" => false, "canDemo" => true
            },
            "demoOptions" => demoOptions(),
            "surface" => {
                "active" => driving ? "watch" : "phone",
                "watch" => { "paired" => true, "appInstalled" => true, "reachable" => true, "vendor" => "garmin" }
            }
        };
        if (driving) {
            out["surface"]["handover"] = { "id" => "sim-demo", "state" => "confirmed", "from" => "watch" };
        }
        if (hole != null) {
            var targetM = (target != null) ? GarminGeo.distance(pos, target) : situation["centre"];
            out["distance"] = { "target" => targetM, "front" => situation["front"], "centre" => situation["centre"], "back" => situation["back"] };
            out["demo"] = { "active" => true, "hole" => hole, "position" => geo(pos), "metres" => situation["metres"] };
            out["location"] = { "coordinate" => geo(pos), "source" => "phone-web", "fresh" => true };
            // The phone's club for the green, before anything is locked
            // (app.shotSuggestion), from the same engine the watch runs.
            if (!locked) {
                var snap = session.playerStore.snapshot;
                if (snap != null) {
                    var r = GarminBubbleEngine.calculate({ "player" => pos, "target" => defaultTarget(), "bag" => snap.bag, "bubble" => snap.bubble });
                    if (r != null && r.club != null) {
                        out["suggestion"] = { "club" => r.club.club, "carryM" => r.club.carryM, "totalM" => r.club.totalM };
                    }
                }
            }
        }
        if (locked && target != null) {
            out["target"] = geo(target);
            out["bubble"] = { "engineVersion" => GarminEngineVersion.CURRENT, "centre" => geo(target) };
        }
        return out;
    }

    // ----------------------------------------------------------------- maps

    function bitmap(holeNumber) {
        if (holeNumber == bitmapHole && bitmapCache != null) { return bitmapCache; }
        var id = null;
        if (holeNumber == 1) { id = Rez.Drawables.simHole1; }
        else if (holeNumber == 2) { id = Rez.Drawables.simHole2; }
        else if (holeNumber == 3) { id = Rez.Drawables.simHole3; }
        if (id == null) { return null; }
        // One resident at a time: a hole map is several hundred KB decoded.
        bitmapCache = null;
        bitmapCache = WatchUi.loadResource(id);
        bitmapHole = holeNumber;
        return bitmapCache;
    }

    function manifestDict() {
        var holes = [];
        var m = fixture["manifest"];
        for (var i = 0; i < m.size(); i += 1) {
            var h = m[i];
            var sr = h["sr"];
            holes.add({
                "holeNumber" => h["holeNumber"], "asset" => h["asset"], "url" => h["url"],
                "width" => h["width"], "height" => h["height"],
                "spatialReference" => {
                    "version" => sr["version"], "refZoom" => sr["refZoom"],
                    "imageWidth" => sr["imageWidth"], "imageHeight" => sr["imageHeight"],
                    "rotationDegrees" => dbl(sr["rotationDegrees"]), "metresPerPixel" => dbl(sr["metresPerPixel"]),
                    "transform" => { "a" => dbl(sr["a"]), "b" => dbl(sr["b"]), "tx" => dbl(sr["tx"]), "ty" => dbl(sr["ty"]) }
                },
                "reference" => { "green" => geo(point(h["green"])) }
            });
        }
        return { "courseKey" => courseKey, "version" => 1, "holes" => holes };
    }

    // ---------------------------------------------------------------- helps

    function holeFixture(n) {
        if (n == null) { return null; }
        var holes = fixture["holes"];
        for (var i = 0; i < holes.size(); i += 1) {
            if (holes[i]["n"] == n) { return holes[i]; }
        }
        return null;
    }

    // The phone's own target rule (engine targetForGreenCentre): the green
    // when the bag reaches it, else the fairway-line layup at the bag's reach.
    function defaultTarget() {
        var g = green(hole);
        var snap = session.playerStore.snapshot;
        if (snap == null || situation == null) { return g; }
        var line = holeFixture(hole)["line"];
        var route = [];
        for (var i = 0; i < line.size(); i += 1) { route.add(point(line[i])); }
        var t = GarminBubbleEngine.defaultTarget(point(situation["pos"]), g, route, snap.bag);
        return t != null ? t : g;
    }

    function situationFor(n, option) {
        var list = fixture["situations"];
        for (var i = 0; i < list.size(); i += 1) {
            if (option != null && option.equals(list[i]["id"])) { return list[i]; }
        }
        for (var i = 0; i < list.size(); i += 1) {
            if (n != null && list[i]["hole"] == n) { return list[i]; }
        }
        return null;
    }

    function demoOptions() {
        var out = [];
        var list = fixture["situations"];
        for (var i = 0; i < list.size(); i += 1) {
            out.add({ "id" => list[i]["id"], "hole" => list[i]["hole"], "label" => list[i]["label"] });
        }
        return out;
    }

    function green(n) {
        var line = holeFixture(n)["line"];
        return point(line[line.size() - 1]);
    }

    function point(pair) { return new GarminCoordinate(dbl(pair[0]), dbl(pair[1])); }
    function geo(c) { return { "lat" => c.lat, "lng" => c.lng }; }

    // A decimal string, parsed exactly into a Double. The fixture writes its
    // coordinates and map transform as strings because resource JSON may
    // decode decimals as 32-bit floats, and a float32 tx (~8.6e7) is several
    // pixels out. Integer and fraction are parsed as whole numbers and joined.
    static function dbl(v) {
        if (v instanceof Lang.Number || v instanceof Lang.Long || v instanceof Lang.Float || v instanceof Lang.Double) {
            return v.toDouble();
        }
        if (!(v instanceof Lang.String)) { return null; }
        var s = v;
        var negative = s.substring(0, 1).equals("-");
        if (negative) { s = s.substring(1, s.length()); }
        var dot = s.find(".");
        var whole = (dot == null) ? s : s.substring(0, dot);
        var frac = (dot == null) ? "" : s.substring(dot + 1, s.length());
        if (frac.length() > 9) { frac = frac.substring(0, 9); }
        var out = whole.length() > 0 ? whole.toNumber().toDouble() : 0.0d;
        if (frac.length() > 0) {
            var scale = 1.0d;
            for (var i = 0; i < frac.length(); i += 1) { scale *= 10.0d; }
            out += frac.toNumber().toDouble() / scale;
        }
        return negative ? -out : out;
    }
}

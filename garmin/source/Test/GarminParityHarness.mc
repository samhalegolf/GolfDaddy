using Toybox.System;
using Toybox.Lang;
using Toybox.Math;
using Toybox.Timer;

// Bubble Engine parity — the Monkey C half, and the project's own stated
// completion bar for this port (garmin/README.md, "Parity fixtures").
//
// Runs every case in GarminParityFixture (compiled from
// dev/fixtures/bubble-engine-parity.json — the same file the JavaScript and
// Swift harnesses read) through GarminBubbleEngine and compares the answers
// field by field at the fixture's own tolerances. It is a direct port of
// BubbleEngineParityTests.testEveryCaseMatchesTheJavaScriptEngine: same bag
// (expect.bagSent, because the wrist is SENT a finished bag rather than
// deriving the ghost stand-in), same default-target call before the shot,
// same fields in the same order.
//
// HOW THE RESULT GETS OUT. There is no test runner here and nothing this can
// return to. `monkeyc -t` exists but its output lands in the simulator's own
// console window, which is not readable from a terminal. What IS readable:
// System.println reaches monkeydo's stdout when monkeydo is run from a shell
// against an already-running simulator, which is how every other trace in
// this build (`rx: [scene]`, `map frame:`) has been read. So the harness
// prints, tools/run-parity.js reads, and the last line is machine-checked:
//
//     parity: RESULT PASS 11/11
//     parity: RESULT FAIL 9/11
//
// Annotated (:parity): excluded from every ordinary build, so none of this —
// nor the ~600-line fixture table — is in the store package.
(:parity)
module GarminParityHarness {

    // Fixture numbers arrive as strings; see GarminParityFixture's header for
    // why (a Monkey C decimal literal is a 32-bit Float and these latitudes
    // need nine significant digits).
    function n(value) {
        if (value == null) { return null; }
        if (value instanceof Lang.String) { return parseDouble(value); }
        return value.toDouble();
    }

    // Decimal text -> Double, digit by digit.
    //
    // `String.toDouble()` does NOT exist on this API level — the S62 is
    // Connect IQ 3.0 and the call dies with "Could not find symbol
    // 'toDouble'" at runtime, having compiled perfectly. `toFloat()` does
    // exist and is exactly the 32-bit trap the strings are here to avoid, so
    // the digits are accumulated into a Double instead. Only `toNumber()` is
    // used, which is the oldest and safest of the family, and only ever on a
    // single character.
    //
    // Handles a leading sign and an `e`/`E` exponent, because the fixture's
    // coordinate tolerance is written `1e-7`.
    function parseDouble(text) {
        var s = text;
        var exponent = 0;
        var eAt = s.find("e");
        if (eAt == null) { eAt = s.find("E"); }
        if (eAt != null) {
            exponent = s.substring(eAt + 1, s.length()).toNumber();
            if (exponent == null) { exponent = 0; }
            s = s.substring(0, eAt);
        }

        var sign = 1;
        var head = s.substring(0, 1);
        if (head.equals("-")) { sign = -1; s = s.substring(1, s.length()); }
        else if (head.equals("+")) { s = s.substring(1, s.length()); }

        var dot = s.find(".");
        var whole = (dot == null) ? s : s.substring(0, dot);
        var frac = (dot == null) ? "" : s.substring(dot + 1, s.length());

        var value = 0.toDouble();
        for (var i = 0; i < whole.length(); i += 1) { value = value * 10 + digitAt(whole, i); }
        var scale = 1.toDouble();
        for (var i = 0; i < frac.length(); i += 1) {
            scale = scale / 10;
            value = value + digitAt(frac, i) * scale;
        }
        if (exponent != 0) { value = value * Math.pow(10.0, exponent.toDouble()); }
        return sign < 0 ? -value : value;
    }

    function digitAt(text, index) {
        var d = text.substring(index, index + 1).toNumber();
        return d == null ? 0 : d;
    }

    function coord(pair) {
        if (pair == null) { return null; }
        return new GarminCoordinate(n(pair[0]), n(pair[1]));
    }

    function bagOf(rows, isGhost) {
        var clubs = [];
        for (var i = 0; i < rows.size(); i += 1) {
            clubs.add(new GarminClub(rows[i][0], n(rows[i][1]), n(rows[i][2])));
        }
        return new GarminBagSnapshot(1, clubs, isGhost);
    }

    function routeOf(list) {
        var out = [];
        for (var i = 0; i < list.size(); i += 1) { out.add(coord(list[i])); }
        return out;
    }

    // ------------------------------------------------------------ comparing

    var failures = 0;

    function fail(name, field, message) {
        failures += 1;
        System.println("parity FAIL " + name + ": " + field + " " + message);
    }

    function near(actual, expected, tolerance, name, field) {
        if (actual == null) { fail(name, field, "expected " + expected + ", got null"); return; }
        var d = actual - expected;
        if (d < 0) { d = -d; }
        if (d > tolerance) {
            fail(name, field, "expected " + expected + " +/- " + tolerance + ", got " + actual);
        }
    }

    function nearCoord(actual, expected, tolerance, name, field) {
        if (actual == null || expected == null) { fail(name, field, "expected a coordinate, got null"); return; }
        var dLat = actual.lat - expected.lat;
        if (dLat < 0) { dLat = -dLat; }
        var dLng = actual.lng - expected.lng;
        if (dLng < 0) { dLng = -dLng; }
        if (dLat > tolerance || dLng > tolerance) {
            fail(name, field, "expected (" + expected.lat + ", " + expected.lng + "), got (" + actual.lat + ", " + actual.lng + ")");
        }
    }

    // ----------------------------------------------------------------- run

    // Held so the runner is not collected between its own timer ticks.
    var runner = null;

    // Flip to true to print the profile/payload intermediates the result
    // object does not carry. Earned its keep immediately: a visualWidthM
    // mismatch on one case was only diagnosable once the trace showed
    // clusterWidthM arriving as 38.9 where the JavaScript had 39.0.
    const TRACE = false;

    function trace(name, player, target, bag, bubble) {
        var distanceM = GarminGeo.distance(player, target);
        var row = GarminBag.resolveClub(bag, distanceM, null);
        if (row == null) { return; }
        var prof = GarminBubbleProfile.derive(
            row.club, GarminJS.round(row.carryM), row.totalM, bubble.effectiveOffsetDeg(), bubble);
        var pay = GarminBubblePayload.build(prof, bag.isGhost).normalised().displayed(distanceM);
        System.println("trace " + name + ": carry=" + prof.baseCarryM
            + " clusterW=" + prof.clusterWidthM + " clusterD=" + prof.clusterDepthM
            + " faceWin=" + prof.faceWindowDeg + " visualW=" + pay.visual.visualWidthM);
    }

    function run() {
        failures = 0;
        runner = new GarminParityRunner();
        runner.start();
    }

    function runCase(entry, tMetres, tDegrees, tDistance, tCoord) {
        var name = entry["name"];
        var bag = bagOf(entry["bag"], entry["ghostBag"]);
        var bubble = new GarminMyBubble(1, n(entry["offsetDeg"]), entry["handedness"]);
        var player = coord(entry["player"]);
        var green = coord(entry["green"]);
        var route = routeOf(entry["route"]);
        var expect = entry["expect"];

        // The default-target rule first, asked before a target is placed —
        // the same call the wrist makes on hole change and on Reset.
        var defaulted = GarminBubbleEngine.defaultTarget(player, green, route, bag);
        var wantDefault = coord(expect["defaultTarget"]);
        if (defaulted != null) {
            nearCoord(defaulted, wantDefault, tCoord, name, "defaultTarget");
        } else if (entry["target"] == null) {
            fail(name, "defaultTarget", "no default target produced, but the case has none of its own");
        }

        var target = coord(entry["target"]);
        if (target == null) { target = defaulted != null ? defaulted : wantDefault; }

        if (TRACE) { trace(name, player, target, bag, bubble); }

        var result = GarminBubbleEngine.calculate({
            "player" => player, "target" => target, "bag" => bag, "bubble" => bubble
        });
        if (result == null) { fail(name, "calculate", "the engine produced no result"); return; }

        near(result.targetDistanceM, n(expect["targetDistanceM"]), tDistance, name, "targetDistanceM");
        near(result.shotBearingDeg, n(expect["shotBearingDeg"]), tDegrees, name, "shotBearingDeg");
        if (!result.club.club.equals(expect["club"])) {
            fail(name, "club", "expected " + expect["club"] + ", got " + result.club.club);
        }
        near(result.club.carryM, n(expect["carryM"]), tMetres, name, "carryM");
        near(result.club.totalM, n(expect["totalM"]), tMetres, name, "totalM");
        if (result.club.isGhost != entry["ghostBag"]) {
            fail(name, "ghostBag", "expected " + entry["ghostBag"] + ", got " + result.club.isGhost);
        }
        near(result.aimOffsetDeg, n(expect["aimOffsetDeg"]), tDegrees, name, "aimOffsetDeg");
        near(result.widthM, n(expect["visualWidthM"]), tMetres, name, "visualWidthM");
        near(result.depthM, n(expect["visualDepthM"]), tMetres, name, "visualDepthM");
        near(result.tiltDeg, n(expect["visualTiltDeg"]), tDegrees, name, "visualTiltDeg");
        nearCoord(result.centre, coord(expect["bubbleCentre"]), tCoord, name, "bubbleCentre");

        var sample = expect["ringSample"];
        if (result.ring.size() != expect["ringResolution"]) {
            fail(name, "ringResolution", "expected " + expect["ringResolution"] + ", got " + result.ring.size());
            return;
        }
        // Same sampling arithmetic as the other two harnesses: evenly spaced
        // indices round the ring, rounded the same way, so the three are
        // comparing the same points and not neighbours of them.
        var step = result.ring.size().toDouble() / sample.size().toDouble();
        for (var i = 0; i < sample.size(); i += 1) {
            var index = Math.round(i * step).toNumber() % result.ring.size();
            nearCoord(result.ring[index], coord(sample[i]), tCoord, name, "ringSample[" + i + "]");
        }
    }
}

// Drives the cases one per timer tick.
//
// All eleven in a single call trips Connect IQ's watchdog — "Code Executed
// Too Long", which kills the app. That is not a sign the engine is slow: each
// case builds a 168-point ring, which the live map does on every frame of a
// drag quite happily. It is that a watch may not sit inside one callback for
// as long as eleven of them take. So each tick runs exactly one case and the
// verdict is printed when the last one is in.
//
// A class rather than more module functions because Timer needs `method()`,
// which belongs to an object; a module has none.
(:parity)
class GarminParityRunner {
    var timer;
    var index;
    var passed;
    var total;
    var tMetres;
    var tDegrees;
    var tDistance;
    var tCoord;

    function initialize() {
        index = 0;
        passed = 0;
        total = GarminParityFixture.count();
        tMetres = GarminParityHarness.n(GarminParityFixture.toleranceMetres());
        tDegrees = GarminParityHarness.n(GarminParityFixture.toleranceDegrees());
        tDistance = GarminParityHarness.n(GarminParityFixture.toleranceDistanceM());
        tCoord = GarminParityHarness.n(GarminParityFixture.toleranceCoord());
    }

    function start() {
        System.println("parity: " + GarminParityFixture.bubbleEngineVersion() + ", " + total
            + " cases, engine " + GarminEngineVersion.CURRENT);
        timer = new Timer.Timer();
        timer.start(method(:step), 120, true);
    }

    function step() as Void {
        if (index >= total) {
            timer.stop();
            System.println("parity: RESULT " + (GarminParityHarness.failures == 0 ? "PASS" : "FAIL")
                + " " + passed + "/" + total);
            return;
        }
        var before = GarminParityHarness.failures;
        GarminParityHarness.runCase(GarminParityFixture.caseAt(index), tMetres, tDegrees, tDistance, tCoord);
        if (GarminParityHarness.failures == before) { passed += 1; }
        index += 1;
    }
}

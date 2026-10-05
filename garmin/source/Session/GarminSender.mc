using Toybox.Lang;
using Toybox.System;
using Toybox.Application.Storage;

// Everything this watch sends to the phone, through one gate.
//
// WHY. On this Mac the Connect IQ simulator dies on ANY watch -> phone
// transmit while tethered (garmin/UPLOAD.md). Its real-world relatives are
// not exotic: a BLE stack or firmware bug that kills the app mid-send, a send
// that never calls back, a link that refuses a message as too large or simply
// drops while a phone sleeps in a bag. The old path transmitted the moment
// anything wanted to, ignored both callbacks, retried every 10 s forever, and
// sent its first report at app start before anything proved a phone was
// listening - which on the simulator was an instant crash loop. This is the
// sender that survives those:
//
//   PROVE THE LINK FIRST. Nothing leaves until a message from the phone has
//   arrived in this process (a Scene, a manifest, an ack). Reports raised
//   before that wait, latest-only.
//
//   ONE IN FLIGHT. A send owns the link until its callback - or TIMEOUT_MS,
//   which counts as a failure. Connect IQ's transmit is a queue that reports
//   success on enqueue; firing more just piles up behind a slow link.
//
//   START SMALL, WORK UP. `gate` is how many queued commands may ride in one
//   message (sent as "commands" when more than one). It starts at 1, doubles
//   on every success up to MAX_GATE, and halves on every failure - so a link
//   that refuses big messages settles at what it will take, and a good one
//   drains a backlog in a few sends. `spacingMs` between sends tightens on
//   success and backs off exponentially on failure, the same idea in time.
//
//   CRASH-LOOP GUARD. The ids in flight are written to Storage before the
//   transmit and cleared by its callback. Finding them at startup means the
//   process died inside that send: each such command gets a strike, the gate
//   drops to 1 and spacing to its ceiling, and a command with STRIKES_LIMIT
//   strikes is set aside instead of being sent into the same wall again.
//
//   TELL THE PHONE. Outcome counts (ok / error / timeout / crash / set aside)
//   ride on every report as "link", so field failures are visible per device
//   without a debugger attached.
class GarminSender {
    static var MAX_GATE = 4;
    static var MIN_SPACING_MS = 400;
    static var START_SPACING_MS = 2000;
    static var MAX_SPACING_MS = 60000;
    static var TIMEOUT_MS = 15000;
    static var RESEND_AFTER_MS = 10000.0;
    static var STRIKES_LIMIT = 2;
    static var IN_FLIGHT_KEY = "GarminSendInFlightV1";
    static var STRIKES_KEY = "GarminSendStrikesV1";

    var session;
    var gate;                // GarminGate: commands per message
    var spacingMs = START_SPACING_MS;
    var nextAllowedAt = 0;
    var inFlight = false;
    var inFlightSince = 0;
    var linkProven = false;
    var reports = {};        // key -> latest Dictionary, sent whole
    var strikes = {};        // commandId -> Number
    var stats = { "ok" => 0, "error" => 0, "timeout" => 0, "crash" => 0, "setAside" => 0 };

    function initialize(session) {
        self.session = session;
        gate = new GarminGate(MAX_GATE);
        var stored = null;
        try { stored = Storage.getValue(STRIKES_KEY); } catch (e) { stored = null; }
        if (stored instanceof Lang.Dictionary) { strikes = stored; }
        var died = null;
        try { died = Storage.getValue(IN_FLIGHT_KEY); } catch (e) { died = null; }
        if (died instanceof Lang.Array && died.size() > 0) {
            // The last process never heard back from its send: it died in it.
            stats["crash"] = 1;
            for (var i = 0; i < died.size(); i += 1) {
                var id = died[i];
                strikes[id] = (strikes.hasKey(id) ? strikes[id] : 0) + 1;
            }
            gate.reset();
            spacingMs = MAX_SPACING_MS / 4;
            persistStrikes();
            System.println("sender: last run died mid-send " + died + " strikes " + strikes);
        }
        clearInFlight();
    }

    // ------------------------------------------------------------ inputs

    // A message from the phone has arrived: the link exists.
    function noteLinkProven() {
        if (!linkProven) {
            linkProven = true;
            nextAllowedAt = 0;
        }
        pump();
    }

    // Reports carry state, not intent: only the newest of each matters.
    function queueReport(key, value) {
        reports[key] = value;
        pump();
    }

    // ------------------------------------------------------------- pump

    function pump() {
        var now = System.getTimer();
        if (inFlight) {
            if (now - inFlightSince < TIMEOUT_MS) { return; }
            stats["timeout"] = stats["timeout"] + 1;
            onSent(false);
            return;
        }
        if (!linkProven || now < nextAllowedAt) { return; }
        if (!GarminTransmitPolicy.muted()) {
            var settings = System.getDeviceSettings();
            if ((settings has :phoneConnected) && !settings.phoneConnected) { return; }
        }

        var message = commandsMessage();
        var ids = message != null ? message["ids"] : [];
        var dict = message != null ? message["dict"] : null;
        if (dict == null) {
            var keys = reports.keys();
            if (keys.size() == 0) { return; }
            var key = keys[0];
            dict = { key => reports[key], "link" => stats };
            reports.remove(key);
        }

        inFlight = true;
        inFlightSince = now;
        markInFlight(ids);
        session.rawTransmit(dict);
    }

    // Up to `gate` commands that are due (never sent, or unacknowledged for
    // RESEND_AFTER_MS). Commands with too many crash strikes are set aside.
    function commandsMessage() {
        var outbox = session.outbox;
        var due = outbox.staleCommandIds(session.nowEpochMillis());
        var wires = [];
        var ids = [];
        for (var i = 0; i < due.size() && wires.size() < gate.size; i += 1) {
            var id = due[i];
            if (strikes.hasKey(id) && strikes[id] >= STRIKES_LIMIT) {
                System.println("sender: setting aside " + id + " after " + strikes[id] + " crashes");
                outbox.settle(id);
                strikes.remove(id);
                persistStrikes();
                stats["setAside"] = stats["setAside"] + 1;
                continue;
            }
            var wire = outbox.beginAttempt(id, session.nowEpochMillis());
            if (wire != null) { wires.add(wire); ids.add(id); }
        }
        if (wires.size() == 0) { return null; }
        var dict = (wires.size() == 1) ? { "command" => wires[0] } : { "commands" => wires };
        return { "dict" => dict, "ids" => ids };
    }

    // The transport's answer: true for delivered to the link, false for any
    // failure. Never a command's acknowledgement - that is the phone's.
    function onSent(ok) {
        if (!inFlight) { return; }
        inFlight = false;
        clearInFlight();
        if (ok) {
            stats["ok"] = stats["ok"] + 1;
            gate.succeeded();
            spacingMs = (spacingMs * 7) / 10;
            if (spacingMs < MIN_SPACING_MS) { spacingMs = MIN_SPACING_MS; }
        } else {
            stats["error"] = stats["error"] + 1;
            gate.failed();
            spacingMs = spacingMs * 2 > MAX_SPACING_MS ? MAX_SPACING_MS : spacingMs * 2;
        }
        nextAllowedAt = System.getTimer() + spacingMs;
        if (GarminTransmitPolicy.muted()) {
             System.println("sender: " + (ok ? "ok" : "FAILED") + " gate " + gate.size + " spacing " + spacingMs + "ms");
        }
    }

    // Whether this link has shown trouble: a send that killed the app, or
    // repeated failures. Used to ask the phone for hole-by-hole delivery.
    function struggling() {
        return stats["crash"] > 0 || stats["error"] + stats["timeout"] >= 3;
    }

    // ---------------------------------------------------------- storage

    function markInFlight(ids) {
        if (ids.size() == 0) { return; }
        try { Storage.setValue(IN_FLIGHT_KEY, ids); } catch (e) { }
    }

    function clearInFlight() {
        try { Storage.deleteValue(IN_FLIGHT_KEY); } catch (e) { }
    }

    function persistStrikes() {
        try { Storage.setValue(STRIKES_KEY, strikes); } catch (e) { }
    }
}

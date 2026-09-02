using Toybox.Lang;
using Toybox.Application.Storage;

// The Garmin command outbox. Mirrors the pendingCommands/persistOutbox/
// restoreOutbox/attempt/reconcileOutbox behaviour in
// ios/App/ClarityCaddyWatch/WatchSessionManager.swift, and the Garmin Phase 1
// plan step 11's field list (commandId, roundId, baseRevision, createdAt,
// device, type, payload, attemptCount, lastAttemptAt).
//
// Durable across a temporary disconnect and an app relaunch: everything
// lives in Application.Storage, a persisted key/value store, keyed the same
// way WatchSessionManager keys UserDefaults.
//
// The phone dedupes by command ID (app/js/caddy-watch.js's seenCommands), so
// a retry must NEVER generate a new command ID — see `attempt()` below.
class GarminOutbox {
    static var STORAGE_KEY = "GarminOutboxV1";

    // Array of Dictionary: { "command" => wireDict, "attemptCount" => Number,
    // "lastAttemptAt" => Number or null }
    var pending;

    function initialize() {
        pending = [];
        restore();
    }

    function count() { return pending.size(); }

    // Is a command of this type already queued? Mirrors isPending, including
    // the LOCK/LOCK_AT alias: the LOCK button reads "busy" whichever wire
    // type the pending command actually took.
    function isPending(type) {
        for (var i = 0; i < pending.size(); i += 1) {
            var t = pending[i]["command"]["type"];
            if (t.equals(type)) { return true; }
            if (type.equals(GarminCommandKind.LOCK) && t.equals(GarminCommandKind.LOCK_AT)) { return true; }
        }
        return false;
    }

    function pendingOfType(type) {
        for (var i = 0; i < pending.size(); i += 1) {
            if (pending[i]["command"]["type"].equals(type)) { return pending[i]; }
        }
        return null;
    }

    // Enqueues a new command and persists immediately, so a crash right
    // after this call cannot lose an already-accepted-by-the-UI command.
    function enqueue(command) {
        pending.add({ "command" => command.wire(), "attemptCount" => 0, "lastAttemptAt" => null });
        persist();
    }

    // Marks an attempt just made (about to call the transport), for the
    // retry backoff below. Returns the wire Dictionary to actually send.
    function beginAttempt(commandId, nowEpochMillis) {
        for (var i = 0; i < pending.size(); i += 1) {
            if (pending[i]["command"]["commandId"].equals(commandId)) {
                pending[i]["attemptCount"] = pending[i]["attemptCount"] + 1;
                pending[i]["lastAttemptAt"] = nowEpochMillis;
                persist();
                return pending[i]["command"];
            }
        }
        return null;
    }

    // Both outcomes of a command are definitive. Accepted commands wait for
    // the next authoritative Scene; rejected ones do not loop forever, but
    // their command ID remains retryable on the phone if resent.
    function settle(commandId) {
        var next = [];
        for (var i = 0; i < pending.size(); i += 1) {
            if (!pending[i]["command"]["commandId"].equals(commandId)) { next.add(pending[i]); }
        }
        if (next.size() != pending.size()) {
            pending = next;
            persist();
            return true;
        }
        return false;
    }

    // A Scene arriving is proof the phone is listening. Commands for a round
    // that is no longer the one on the phone can never be accepted (Marshal
    // checks the round ID first), so they are dropped rather than retried
    // forever.
    function discardCommandsForOtherRounds(currentRoundId) {
        var next = [];
        for (var i = 0; i < pending.size(); i += 1) {
            if (pending[i]["command"]["roundId"].equals(currentRoundId)) { next.add(pending[i]); }
        }
        if (next.size() != pending.size()) {
            pending = next;
            persist();
            return true;
        }
        return false;
    }

    // Commands idle more than 10s since their last attempt, ready to retry.
    function staleCommandIds(nowEpochMillis) {
        var ids = [];
        for (var i = 0; i < pending.size(); i += 1) {
            var last = pending[i]["lastAttemptAt"];
            var elapsed = (last == null) ? 999999.0 : (nowEpochMillis - last);
            if (elapsed > 10000.0) { ids.add(pending[i]["command"]["commandId"]); }
        }
        return ids;
    }

    function allCommandIds() {
        var ids = [];
        for (var i = 0; i < pending.size(); i += 1) { ids.add(pending[i]["command"]["commandId"]); }
        return ids;
    }

    // Settled by the Scene itself for a surface command (TAKE_OVER/
    // HAND_BACK): once the phone says who is driving, an outstanding
    // surface command has plainly landed, acknowledgement or not.
    function settleByType(type) {
        var next = [];
        var removed = false;
        for (var i = 0; i < pending.size(); i += 1) {
            if (pending[i]["command"]["type"].equals(type)) { removed = true; }
            else { next.add(pending[i]); }
        }
        if (removed) { pending = next; persist(); }
        return removed;
    }

    function persist() {
        try {
            Storage.setValue(STORAGE_KEY, pending);
        } catch (e) {
            // Persisted state is a durability nicety, not correctness: losing
            // a write here costs a re-send after the next relaunch, never a
            // wrong outcome.
        }
    }

    function restore() {
        var stored = null;
        try {
            stored = Storage.getValue(STORAGE_KEY);
        } catch (e) {
            stored = null;
        }
        if (stored instanceof Lang.Array) {
            pending = stored;
        }
    }
}

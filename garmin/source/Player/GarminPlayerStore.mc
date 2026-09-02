using Toybox.Lang;
using Toybox.Application.Storage;

// The player's bag and saved My Bubble, cached on the device. Mirrors
// ios/App/ClarityCaddyWatch/WatchPlayerStore.swift. Unlike the lite-map
// package there is nothing partial about a snapshot: it arrives whole or not
// at all, so there is only "which fingerprint do I hold" to report.
//
// Durable via Application.Storage so a snapshot survives a relaunch — the
// point of the whole exercise is a device that keeps working with the phone
// out of range.
class GarminPlayerStore {
    static var STORAGE_KEY = "GarminPlayerSnapshotV1";

    var snapshot;   // GarminPlayerSnapshot or null

    function initialize() {
        snapshot = null;
        refresh();
    }

    function inventory() {
        return { "fingerprint" => (snapshot != null) ? snapshot.fingerprint : "" };
    }

    // Adopts a snapshot pushed by the phone. Refuses anything malformed;
    // isUsable() recomputes the fingerprint from the contents. Returns
    // whether anything actually changed, so the caller reports only real
    // news — reporting unconditionally made a hot loop on iOS once (a
    // rejected snapshot still triggered a report, the phone answered with
    // another publish, and the two spun at hundreds of messages a second).
    function receive(raw) {
        var incoming = GarminPlayerSnapshot.fromDict(raw);
        if (incoming == null || !incoming.isUsable()) { return false; }
        if (snapshot != null && incoming.fingerprint.equals(snapshot.fingerprint)) { return false; }
        snapshot = incoming;
        persist();
        return true;
    }

    function persist() {
        if (snapshot == null) { return; }
        try {
            Storage.setValue(STORAGE_KEY, {
                "version" => snapshot.version,
                "fingerprint" => snapshot.fingerprint,
                "engineVersion" => snapshot.engineVersion,
                "bag" => {
                    "version" => snapshot.bag.version,
                    "isGhost" => snapshot.bag.isGhost,
                    "clubs" => clubsToStorable(snapshot.bag.clubs)
                },
                "bubble" => {
                    "version" => snapshot.bubble.version,
                    "offsetDeg" => snapshot.bubble.offsetDeg,
                    "handedness" => snapshot.bubble.handedness
                }
            });
        } catch (e) {
            // A snapshot that cannot be written is still usable for this
            // launch — losing it costs a re-send next time, never a wrong bag.
        }
    }

    function clubsToStorable(clubs) {
        var out = [];
        for (var i = 0; i < clubs.size(); i += 1) {
            out.add({ "club" => clubs[i].club, "carryM" => clubs[i].carryM, "totalM" => clubs[i].totalM });
        }
        return out;
    }

    // Re-reads the cache. A stored snapshot that no longer validates — an
    // older schema, or storage truncated mid-write — is discarded rather
    // than trusted, and the phone is asked for a fresh one next time it
    // reports the (now empty) fingerprint.
    function refresh() {
        var stored = null;
        try {
            stored = Storage.getValue(STORAGE_KEY);
        } catch (e) {
            stored = null;
        }
        if (!(stored instanceof Lang.Dictionary)) { return; }
        var incoming = GarminPlayerSnapshot.fromDict(stored);
        if (incoming != null && incoming.isUsable()) {
            snapshot = incoming;
        }
    }
}

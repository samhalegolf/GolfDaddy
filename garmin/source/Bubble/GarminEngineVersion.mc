using Toybox.Lang;

// May this device compute a Bubble of its own, or must it render the phone's?
// Mirrors ios/WatchBubbleEngine/Sources/WatchBubbleEngine/EngineVersion.swift
// exactly, including the "exact match only" rule: there is no compatibility
// range, because this engine's every change is behavioural. See that file's
// header comment for the full "why this is a type and not an if" reasoning —
// the short version is that two engines answering confidently and
// differently produces a wrist that silently disagrees with the phone about
// which club to hit, with no error anywhere.
module GarminEngineVersion {

    // Bump in step with BUBBLE_ENGINE_VERSION in app/js/caddy-watch.js and
    // with the bubbleEngineVersion recorded in the parity fixtures.
    var CURRENT = "bubble-engine-v1";

    // Agreement outcomes, as strings (Monkey C has no enum-with-payload):
    //   "agreed"              - same engine on both ends; local compute is on
    //   "mismatch"             - phone runs a different engine; render its Bubble
    //   "phoneInconsistent"    - phone's own two declarations disagree
    //   "undeclared"           - nothing has declared a version yet
    //
    // Returns a Dictionary: { "state" => <one of the above>, "mayComputeLocally" => Boolean }
    function agreement(sceneVersion, snapshotVersion) {
        var scene = (sceneVersion != null && sceneVersion.length() > 0) ? sceneVersion : null;
        var snapshot = (snapshotVersion != null && snapshotVersion.length() > 0) ? snapshotVersion : null;

        if (scene != null && snapshot != null && !scene.equals(snapshot)) {
            return { "state" => "phoneInconsistent", "mayComputeLocally" => false, "phone" => scene, "snapshot" => snapshot };
        }
        var declared = (scene != null) ? scene : snapshot;
        if (declared == null) {
            return { "state" => "undeclared", "mayComputeLocally" => false };
        }
        if (declared.equals(CURRENT)) {
            return { "state" => "agreed", "mayComputeLocally" => true, "version" => declared };
        }
        return { "state" => "mismatch", "mayComputeLocally" => false, "phone" => declared, "watch" => CURRENT };
    }

    // What this wrist reports back, so the phone can see a mismatch from its
    // own side rather than only inferring one from a device that never
    // computes.
    function report() {
        return { "engineVersion" => CURRENT };
    }
}

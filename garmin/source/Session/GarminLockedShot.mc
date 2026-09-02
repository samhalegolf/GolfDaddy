using Toybox.Lang;
using Toybox.Time;

// The shot Garmin believes it just locked. Mirrors
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/WatchLockedShot.swift.
//
// WHY IT EXISTS: pressing LOCK sends a command and waits for the phone. On a
// good link that's fast; at the far end of a fairway with a marginal
// connection, it is not, and the player has already walked off. This record
// lets Garmin say "locked" the instant the button is pressed, from what it
// already knows.
//
// WHY IT IS DANGEROUS: it is INTENT, not truth. Marshal owns the round and
// can refuse. Every path out of the uncertainty is explicit: rejected
// (discard at once), confirmed (the Scene has moved past it), or expired
// (nothing came back — stop claiming, whatever the reason).
class GarminLockedShot {
    static var MAX_UNCONFIRMED_AGE_MS = 20000.0;

    var commandId;
    var roundId;
    var baseRevision;
    var holeNumber;
    var player;          // GarminCoordinate
    var target;           // GarminCoordinate
    var club;
    var targetDistanceM;
    var widthM;
    var depthM;
    var tiltDeg;
    var engineVersion;
    var createdAtEpochMillis;

    // Built only from a Bubble Garmin computed itself — see
    // GarminSessionManager.send(): if Garmin did not compute the shot, it
    // has nothing of its own to show and waits like it always did.
    function initialize(commandId, roundId, baseRevision, holeNumber, bubbleResult, player, nowEpochMillis) {
        self.commandId = commandId;
        self.roundId = roundId;
        self.baseRevision = baseRevision;
        self.holeNumber = holeNumber;
        self.player = player;
        self.target = bubbleResult.target;
        self.club = bubbleResult.club.club;
        self.targetDistanceM = bubbleResult.targetDistanceM;
        self.widthM = bubbleResult.widthM;
        self.depthM = bubbleResult.depthM;
        self.tiltDeg = bubbleResult.tiltDeg;
        self.engineVersion = bubbleResult.engineVersion;
        self.createdAtEpochMillis = nowEpochMillis;
    }

    // sceneRevision nil means no Scene has arrived at all, which is not
    // confirmation of anything; a round that has changed underneath
    // discards outright — a lock belongs to the round it was made in.
    function isStillShowing(currentRoundId, sceneRevision, commandStillPending, nowEpochMillis) {
        if (currentRoundId == null || !currentRoundId.equals(roundId)) { return false; }
        if (nowEpochMillis - createdAtEpochMillis >= MAX_UNCONFIRMED_AGE_MS) { return false; }
        if (sceneRevision != null && sceneRevision > baseRevision) { return false; }
        return commandStillPending || sceneRevision != null;
    }
}

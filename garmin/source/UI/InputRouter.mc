using Toybox.Lang;
using Toybox.WatchUi;

// Semantic Garmin actions (Garmin Phase 1 plan step 12/27). The round engine
// never learns whether an action came from a drag or a button — physical
// input is translated to one of these constants here, once, and every view
// consumes only the semantic form. Phase 1 wires NEXT/PREVIOUS/SELECT/BACK/
// LOCK/UNLOCK/NEXT_HOLE/PREVIOUS_HOLE; the AIM_* and MAP/NUMBERS actions are
// declared now so Phase 2/3 extends this module instead of redesigning it.
module InputAction {
    var NEXT = "NEXT";
    var PREVIOUS = "PREVIOUS";
    var SELECT = "SELECT";
    var BACK = "BACK";

    var OPEN_MAP = "OPEN_MAP";
    var OPEN_NUMBERS = "OPEN_NUMBERS";

    var AIM_MODE = "AIM_MODE";
    var AIM_UP = "AIM_UP";
    var AIM_DOWN = "AIM_DOWN";
    var AIM_LEFT = "AIM_LEFT";
    var AIM_RIGHT = "AIM_RIGHT";
    var CONFIRM_AIM = "CONFIRM_AIM";
    var CANCEL_AIM = "CANCEL_AIM";

    var LOCK = "LOCK";
    var UNLOCK = "UNLOCK";

    var NEXT_HOLE = "NEXT_HOLE";
    var PREVIOUS_HOLE = "PREVIOUS_HOLE";
}

// Maps physical input to InputAction constants. Button devices (Fenix 6,
// Forerunner 55) get UP/DOWN/SELECT/BACK mapped directly; touch devices
// layer tap gestures on top through the same dispatch method, so a view
// never has to ask which kind of device it is running on.
class InputRouter {
    var onAction;   // callback: onAction.invoke(actionConstant)

    function initialize(onAction) {
        self.onAction = onAction;
    }

    function dispatch(action) {
        if (onAction != null) { onAction.invoke(action); }
    }

    // WatchUi.InputDelegate.onKey's key event -> semantic action. Mirrors
    // the Garmin Phase 1 plan step 25's suggested button pattern for the
    // numbers face: UP/DOWN move between hole/adjacent info (Phase 1 does
    // not yet have a scrollable numbers face, so these are reserved),
    // SELECT is context-sensitive (LOCK on the playing face), BACK backs out
    // of nothing yet in Phase 1 (no aim mode to cancel).
    function onKey(keyEvent) {
        var key = keyEvent.getKey();
        if (key == WatchUi.KEY_ENTER) { dispatch(InputAction.SELECT); return true; }
        if (key == WatchUi.KEY_ESC) { dispatch(InputAction.BACK); return true; }
        if (key == WatchUi.KEY_UP) { dispatch(InputAction.PREVIOUS_HOLE); return true; }
        if (key == WatchUi.KEY_DOWN) { dispatch(InputAction.NEXT_HOLE); return true; }
        return false;
    }

    // Touch tap on a named on-screen hit target (e.g. "lock", "nextHole",
    // "previousHole") — NumbersView owns the hit-testing and calls this with
    // the resolved semantic action directly, so InputRouter stays the single
    // place physical-to-semantic translation happens without needing to know
    // NumbersView's layout.
    function onTap(action) {
        dispatch(action);
    }
}

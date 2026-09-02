using Toybox.Lang;
using Toybox.WatchUi;

// Semantic Garmin actions (Garmin Phase 1 plan step 12/27). The round engine
// never learns whether an action came from a drag or a button — physical
// input is translated to one of these constants here, once, and every view
// consumes only the semantic form. Phase 1 wired NEXT/PREVIOUS/SELECT/BACK/
// LOCK/UNLOCK/NEXT_HOLE/PREVIOUS_HOLE. Phase 3 wires AIM_UP/DOWN/LEFT/RIGHT
// (CaddyInputDelegate.onAction, nudging GarminMapView's target) and
// OPEN_MAP/OPEN_NUMBERS (CaddyAppView).
//
// AIM_MODE/CONFIRM_AIM/CANCEL_AIM are declared but NOT dispatched through
// onAction in this pass: entering/confirming/cancelling an aim needs the
// current face and Numbers-vs-Map state that only
// CaddyInputDelegate.handleSelect()/onAction(BACK) already have in scope,
// so those call GarminMapView.enterAimMode()/confirmAim()/cancelAim()
// directly rather than round-tripping through a same-named action. The
// constants stay part of the semantic vocabulary for a future caller that
// doesn't have that context to hand — e.g. an on-screen touch button.
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

    // NOTE: there is deliberately no generic onKey() here. WatchUi.
    // BehaviorDelegate already turns KEY_ENTER/KEY_ESC/KEY_UP/KEY_DOWN into
    // its own semantic onSelect/onBack/onNextPage/onPreviousPage callbacks
    // before a raw key would ever reach an onKey handler, so a second
    // translation of the same four keys here would be unreachable in
    // practice. CaddyInputDelegate overrides onKey() directly, but only for
    // WatchUi.KEY_LAP (Phase 3's "LOCK from the map" input) — the one key
    // BehaviorDelegate has no semantic method for.

    // Touch tap on a named on-screen hit target (e.g. "lock", "nextHole",
    // "previousHole") — NumbersView owns the hit-testing and calls this with
    // the resolved semantic action directly, so InputRouter stays the single
    // place physical-to-semantic translation happens without needing to know
    // NumbersView's layout.
    function onTap(action) {
        dispatch(action);
    }
}

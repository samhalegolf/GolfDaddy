using Toybox.WatchUi;
using Toybox.Lang;

// Translates physical input into InputRouter's semantic actions and applies
// them to GarminSessionManager. Extends WatchUi.BehaviorDelegate rather than
// the lower-level InputDelegate: BehaviorDelegate already normalises
// button-vs-touch physical input into onSelect/onBack/onNextPage/
// onPreviousPage across Connect IQ's device matrix, which is exactly the
// button/touch convergence InputRouter exists to guarantee at the semantic
// layer above this one (Garmin Phase 1 plan step 12).
class CaddyInputDelegate extends WatchUi.BehaviorDelegate {
    var session;    // GarminSessionManager
    var view;        // CaddyAppView
    var router;

    function initialize(session, view) {
        BehaviorDelegate.initialize();
        self.session = session;
        self.view = view;
        router = new InputRouter(method(:onAction));
    }

    function onSelect() {
        router.dispatch(InputAction.SELECT);
        return true;
    }

    function onBack() {
        router.dispatch(InputAction.BACK);
        return true;
    }

    // The dedicated MENU input (a long-press or MENU button on most Garmin
    // devices) toggles between Numbers and Map on the playing face — the
    // Garmin Phase 1+2 plan step 23's "two main surfaces... move between
    // them quickly," with no deep menu hierarchy in between. Phase 3 will
    // likely also want a touch-only path (e.g. a swipe or tap zone) once
    // GarminMapView's own input handling exists; MENU is the one semantic
    // action every device in the Phase 1 matrix is expected to have.
    function onMenu() {
        if (session.face().equals(GarminSessionManager.FACE_PLAYING)) {
            router.dispatch(view.showingMap ? InputAction.OPEN_NUMBERS : InputAction.OPEN_MAP);
        }
        return true;
    }

    function onNextPage() {
        router.dispatch(InputAction.NEXT_HOLE);
        return true;
    }

    function onPreviousPage() {
        router.dispatch(InputAction.PREVIOUS_HOLE);
        return true;
    }

    // The semantic action handler. Phase 1 wires exactly what the numbers
    // face needs; AIM_*/OPEN_MAP/OPEN_NUMBERS are declared in InputAction
    // for Phase 2/3 and intentionally do nothing yet.
    function onAction(action) {
        if (action.equals(InputAction.SELECT)) {
            handleSelect();
        } else if (action.equals(InputAction.NEXT_HOLE)) {
            if (session.scene != null && session.scene.canNextHole()) { session.sendSimple(GarminCommandKind.NEXT_HOLE); }
        } else if (action.equals(InputAction.PREVIOUS_HOLE)) {
            if (session.scene != null && session.scene.canPreviousHole()) { session.sendSimple(GarminCommandKind.PREVIOUS_HOLE); }
        } else if (action.equals(InputAction.OPEN_MAP)) {
            view.showMap();
        } else if (action.equals(InputAction.OPEN_NUMBERS)) {
            view.showNumbers();
        } else if (action.equals(InputAction.BACK)) {
            // On the map, BACK is the quick way back to Numbers (plan step
            // 23); everywhere else it dismisses whatever transient state is
            // showing, same as Phase 1.
            if (view.showingMap) {
                view.showNumbers();
            } else {
                session.dismissRejection();
                session.dismissHandoverNotice();
            }
        }
        WatchUi.requestUpdate();
    }

    // SELECT is context-sensitive per the Garmin Phase 1 plan step 25: LOCK
    // on the playing face, TAKE_OVER on the taking/ready face when a round
    // is waiting.
    function handleSelect() {
        var face = session.face();
        if (face.equals(GarminSessionManager.FACE_PLAYING)) {
            if (session.scene != null && session.scene.canLock()) {
                session.send(GarminCommandKind.LOCK);
            }
        } else if (face.equals(GarminSessionManager.FACE_READY)) {
            session.sendSimple(GarminCommandKind.TAKE_OVER);
        }
    }
}

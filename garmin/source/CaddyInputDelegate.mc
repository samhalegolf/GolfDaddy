using Toybox.WatchUi;
using Toybox.Lang;

// Translates physical input into InputRouter's semantic actions and applies
// them to GarminSessionManager / GarminMapView. Extends
// WatchUi.BehaviorDelegate rather than the lower-level InputDelegate:
// BehaviorDelegate already normalises button-vs-touch physical input into
// onSelect/onBack/onNextPage/onPreviousPage/onMenu across Connect IQ's
// device matrix, which is exactly the button/touch convergence InputRouter
// exists to guarantee at the semantic layer above this one (Garmin Phase 1
// plan step 12).
//
// Phase 3 button semantics on the Map face (plan step 25's suggested
// pattern, adapted to what a real 5-button Garmin actually exposes — see
// the per-method comments for the specific calls made):
//   SELECT   not aiming -> enter Aim Mode / aiming -> confirm (send AIM_AT once)
//   BACK     aiming -> cancel (no AIM_AT sent) / not aiming -> back to Numbers
//   UP/DOWN  aiming -> nudge target / not aiming -> hole navigation (unchanged)
//   KEY_LAP  not aiming -> LOCK directly from the map (plan step 22)
// Lateral (LEFT/RIGHT) nudging is NOT wired for button devices in this pass
// — no device in the Phase 1 matrix (Approach S62/S70, Fenix 6, Forerunner
// 55) has a physical left/right control, and inventing an unproven
// axis-toggle UX without real hardware to test it against would be a guess
// dressed up as a decision. Touch devices get full 2D freedom via drag
// (onTouch below). See garmin/README.md's Phase 3 section.
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
    // them quickly," with no deep menu hierarchy in between. Leaving the
    // map this way cancels an in-progress aim rather than abandoning it
    // silently — matches BACK's own cancel behaviour so switching screens
    // never strands a half-placed target.
    function onMenu() {
        if (!session.face().equals(GarminSessionManager.FACE_PLAYING)) { return true; }
        if (view.showingMap) {
            if (view.mapView.aiming) { view.mapView.cancelAim(); }
            router.dispatch(InputAction.OPEN_NUMBERS);
        } else {
            router.dispatch(InputAction.OPEN_MAP);
        }
        return true;
    }

    function onNextPage() {
        if (view.showingMap && view.mapView.aiming) {
            router.dispatch(InputAction.AIM_UP);
        } else {
            router.dispatch(InputAction.PREVIOUS_HOLE);
        }
        return true;
    }

    function onPreviousPage() {
        if (view.showingMap && view.mapView.aiming) {
            router.dispatch(InputAction.AIM_DOWN);
        } else {
            router.dispatch(InputAction.NEXT_HOLE);
        }
        return true;
    }

    // KEY_LAP: the physical LAP/light button most 5-button Garmin devices
    // in the Phase 1 matrix expose, used here for "LOCK directly from the
    // map" (plan step 22) since SELECT is already spoken for by Aim Mode
    // entry/confirm. UNVERIFIED — see garmin/README.md's Phase 3 section:
    // whether WatchUi.KEY_LAP fires through onKey on a BehaviorDelegate
    // subclass (rather than needing the lower-level InputDelegate) needs
    // confirming against the installed SDK and real devices.
    function onKey(keyEvent) {
        if (keyEvent has :getKey && keyEvent.getKey() == WatchUi.KEY_LAP) {
            if (view.showingMap && !view.mapView.aiming
                    && session.face().equals(GarminSessionManager.FACE_PLAYING)
                    && session.scene != null && session.scene.canLock()) {
                session.send(GarminCommandKind.LOCK);
                WatchUi.requestUpdate();
            }
            return true;
        }
        return false;
    }

    // ---- Touch drag (plan step 13) ----
    //
    // UNVERIFIED: this session does not have high confidence in Connect
    // IQ's exact touch-event API shape (constant names for start/move/end,
    // and whether coordinates arrive via getCoordinates() returning
    // [x, y]). Written defensively — every field access is guarded with
    // `has :symbol` so this degrades to doing nothing rather than crashing
    // on an SDK version where the shape differs. GarminMapView's
    // dragStart/dragTo/dragEnd (the state machine + screen->image->
    // coordinate->Bubble pipeline) are the part of this session's work that
    // IS confident; only this OS-event binding needs real-device
    // confirmation.
    function onTouch(touchEvent) {
        if (!view.showingMap || !session.face().equals(GarminSessionManager.FACE_PLAYING)) { return false; }
        if (!(touchEvent has :getCoordinates)) { return false; }
        var coords = touchEvent.getCoordinates();
        if (coords == null || coords.size() < 2) { return false; }
        var x = coords[0];
        var y = coords[1];

        var type = (touchEvent has :getType) ? touchEvent.getType() : null;
        if (type != null && WatchUi has :TOUCH_START && type == WatchUi.TOUCH_START) {
            view.mapView.dragStart(x, y);
        } else if (type != null && WatchUi has :TOUCH_MOVE && type == WatchUi.TOUCH_MOVE) {
            view.mapView.dragTo(x, y);
        } else if (type != null && WatchUi has :TOUCH_END && type == WatchUi.TOUCH_END) {
            view.mapView.dragEnd();
        } else if (type != null && WatchUi has :TOUCH_RELEASE && type == WatchUi.TOUCH_RELEASE) {
            view.mapView.dragEnd();
        } else if (!view.mapView.dragActive) {
            // No recognised type constant on this SDK: treat a bare touch
            // report as a tap-start-and-end so the target still moves under
            // a single tap even without continuous drag tracking.
            view.mapView.dragStart(x, y);
            view.mapView.dragEnd();
        }
        WatchUi.requestUpdate();
        return true;
    }

    // The semantic action handler.
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
        } else if (action.equals(InputAction.AIM_UP)) {
            view.mapView.nudge(0, -GarminMapView.NUDGE_STEP_IMAGE_PX);
        } else if (action.equals(InputAction.AIM_DOWN)) {
            view.mapView.nudge(0, GarminMapView.NUDGE_STEP_IMAGE_PX);
        } else if (action.equals(InputAction.AIM_LEFT)) {
            view.mapView.nudge(-GarminMapView.NUDGE_STEP_IMAGE_PX, 0);
        } else if (action.equals(InputAction.AIM_RIGHT)) {
            view.mapView.nudge(GarminMapView.NUDGE_STEP_IMAGE_PX, 0);
        } else if (action.equals(InputAction.BACK)) {
            // On the map while aiming, BACK cancels the aim (plan step 21)
            // rather than leaving the screen. Otherwise it is the quick way
            // back to Numbers (plan step 23), or — on Numbers — dismisses
            // whatever transient state is showing, same as Phase 1.
            if (view.showingMap && view.mapView.aiming) {
                view.mapView.cancelAim();
            } else if (view.showingMap) {
                view.showNumbers();
            } else {
                session.dismissRejection();
                session.dismissHandoverNotice();
            }
        }
        WatchUi.requestUpdate();
    }

    // SELECT is context-sensitive: LOCK on the Numbers face (plan step 25),
    // TAKE_OVER on the taking/ready face when a round is waiting, and on
    // the Map face — enter Aim Mode, or confirm one already in progress
    // (send AIM_AT once, per plan step 20).
    function handleSelect() {
        var face = session.face();
        if (face.equals(GarminSessionManager.FACE_PLAYING)) {
            if (view.showingMap) {
                if (view.mapView.aiming) {
                    view.mapView.confirmAim();
                } else {
                    view.mapView.enterAimMode();
                }
            } else if (session.scene != null && session.scene.canLock()) {
                session.send(GarminCommandKind.LOCK);
            }
        } else if (face.equals(GarminSessionManager.FACE_READY)) {
            session.sendSimple(GarminCommandKind.TAKE_OVER);
        }
    }
}

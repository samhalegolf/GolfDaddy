using Toybox.Lang;

// Whether this build plays a standalone demo round in the simulator, with no
// phone at all.
//
// Same two-definitions-one-annotation shape as GarminTransmitPolicy and
// GarminParityPolicy, and for the same reason: the thing switched on here (a
// fixture course, three bundled hole images and a local stand-in for the
// phone) must never be in the store package. monkey.jungle excludes
// `sim_demo`, so every ordinary build compiles the empty definitions below.
// `CIQ_SIM_DEMO=1 ./build.sh build` chains monkey-sim-demo.jungle, which
// excludes `sim_demo_off` instead and adds resources-sim-demo/.
//
// Why it exists: on this Mac the Connect IQ simulator segfaults on any watch
// -> phone transmit while tethered, and its map images need Garmin's image
// service and a Connect sign-in (see garmin/UPLOAD.md). A demo round needs
// none of that - everything it uses is already on the watch - so the sim can
// show the whole Garmin demo flow on its own. See GarminSimDemo.mc.
class GarminSimDemoPolicy {
    (:sim_demo_off)
    static function start(session) { }

    (:sim_demo_off)
    static function handle(dict) { return false; }

    (:sim_demo_off)
    static function bitmap(holeNumber) { return null; }

    // Whether the Bluetooth link to a phone counts as the phone listening.
    // Not in the sim demo: its "phone" is the stand-in below, and the
    // simulator reports a connected phone regardless, which would hold the
    // course skeleton back for its full PHONE_CONNECTED_FRESH_MS.
    (:sim_demo_off)
    static function phoneLinkCounts() { return true; }

    (:sim_demo)
    static function phoneLinkCounts() { return false; }

    (:sim_demo)
    static function start(session) {
        GarminSimDemo.instance = new GarminSimDemo(session);
        GarminSimDemo.instance.start();
    }

    // Everything the watch would transmit to the phone comes here first; true
    // means the stand-in answered it and nothing goes on the wire.
    (:sim_demo)
    static function handle(dict) {
        return GarminSimDemo.instance != null && GarminSimDemo.instance.handle(dict);
    }

    (:sim_demo)
    static function bitmap(holeNumber) {
        return GarminSimDemo.instance != null ? GarminSimDemo.instance.bitmap(holeNumber) : null;
    }
}

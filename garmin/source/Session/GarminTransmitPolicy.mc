// Whether this build may send anything to the phone at all.
//
// Exists for exactly one reason: the Connect IQ simulator on Apple-silicon
// macOS 26 segfaults on ANY Communications.transmit while the adb tether to
// a phone is live (SDKs 8.4.1, 9.1.0 and 9.2.0 alike - see garmin/UPLOAD.md,
// "Known simulator bug"). The phone -> watch direction works, so a build that
// never replies can still show a real round arriving on the simulated watch:
// the face, the hole map, distances and the Bubble. Commands from the wrist
// (TAKE_OVER, LOCK, the inventory reports) simply never leave in that build.
//
// Two definitions of the same function, one per annotation. monkey.jungle
// excludes `tx_muted` by default, so a normal build - debug or the store
// package - is always the live one. `CIQ_MUTE_TX=1 ./build.sh build` chains
// monkey-sim-mute.jungle on top, which flips the exclusion and produces a
// .prg with "-muted" in its name so it cannot be mistaken for the real thing.
// build.sh's package verb never reads that variable.
class GarminTransmitPolicy {
    (:tx_live)
    static function muted() { return false; }

    (:tx_muted)
    static function muted() { return true; }
}

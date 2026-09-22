// Whether this build runs the Bubble Engine parity fixtures at startup.
//
// Same two-definitions-one-annotation shape as GarminTransmitPolicy, and for
// the same reason: the decision has to be made at COMPILE time, because the
// thing being switched off is ~600 lines of fixture table that must not be in
// the store package. monkey.jungle excludes `parity` by default, so every
// ordinary build — debug or release — compiles the empty definition and
// carries none of it. `CIQ_PARITY=1 ./build.sh build` chains
// monkey-parity.jungle, which excludes `parity_off` instead (and mutes
// transmit, since the harness has no business talking to a phone).
//
// Read the result with tools/run-parity.js, or by eye in monkeydo's stdout:
// the harness's last line is `parity: RESULT PASS n/n`.
class GarminParityPolicy {
    (:parity_off)
    static function run() { }

    (:parity)
    static function run() { GarminParityHarness.run(); }
}

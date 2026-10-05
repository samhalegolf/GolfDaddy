// How many items to put in the next message - start small, work up, back off.
// The same rule as the phone's AdaptiveGate.java (unit-tested there): double
// until the first refusal; after one, grow a step at a time below the size
// that was refused; PROBE_AFTER clean sends at the edge probe one step past
// it; a refused probe returns to what last worked, any other refusal halves.
class GarminGate {
    static var PROBE_AFTER = 8;
    static var NO_CEILING = 1000000;

    var max;
    var size = 1;
    var ceiling = NO_CEILING;
    var cleanAtEdge = 0;
    var lastGood = 0;

    function initialize(max) { self.max = max < 1 ? 1 : max; }

    function succeeded() {
        lastGood = size;
        if (ceiling == NO_CEILING) {
            size = size * 2 > max ? max : size * 2;
            return;
        }
        if (size + 1 < ceiling) {
            size = size + 1 > max ? max : size + 1;
            cleanAtEdge = 0;
            return;
        }
        cleanAtEdge += 1;
        if (cleanAtEdge >= PROBE_AFTER) {
            ceiling += 1;
            cleanAtEdge = 0;
            size = size + 1 > max ? max : size + 1;
        }
    }

    function failed() {
        var probe = lastGood > 0 && size == lastGood + 1;
        ceiling = size < 1 ? 1 : size;
        cleanAtEdge = 0;
        size = probe ? lastGood : (size / 2 < 1 ? 1 : size / 2);
        lastGood = 0;
    }

    function reset() {
        size = 1;
        ceiling = NO_CEILING;
        cleanAtEdge = 0;
        lastGood = 0;
    }
}

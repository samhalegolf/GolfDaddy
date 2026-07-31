/* Owns exactly one decision: given a Full Map Package that just became available mid-round,
   is it safe to swap the rendered course visual right now, or must the swap wait for the
   player's active hole to change first?

   Per docs/architecture/SYSTEM_MAP.md's ownership convention:
     Owns: the swap-timing decision, and nothing else.
     Must NOT own: GPS-play rendering, frame downloading/caching, or hole tracking - it takes
       hole numbers as plain input from whoever already tracks them (window.gdActivePlayingHole,
       exported by scripts/gd-course-library-pin-lock.js) rather than reaching into globals
       itself, so it stays testable in isolation and has nothing to break if hole-tracking
       internals change.

   Fails open by design: if either hole number is unknown, or nothing has been armed yet,
   the initial doc language "only swap at a safe boundary" is a promise not to interrupt an
   ACTIVE hole - it is not a promise to block a package the app cannot positively confirm
   would interrupt one. A confirmed "still on the hole we armed against" is the only case
   that holds. */
(function () {
  if (window.GDCoursePackageBoundaryGate) return;

  function validHole(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 && n <= 36 ? Math.round(n) : null;
  }

  /* context: {armedAtHole, currentHole}. Returns true (activate now) unless both hole
     numbers are known and identical. */
  function shouldActivateNow(context) {
    const armed = validHole(context && context.armedAtHole);
    const current = validHole(context && context.currentHole);
    if (armed == null || current == null) return true;
    return current !== armed;
  }

  /* Stateful convenience wrapper for the common case: arm once when a package starts
     building/downloading, then ask repeatedly (e.g. from a poll) whether it's safe yet. */
  function createWatch(armedAtHole) {
    const armed = validHole(armedAtHole);
    return {
      armedAtHole: armed,
      check(currentHole) { return shouldActivateNow({ armedAtHole: armed, currentHole }); }
    };
  }

  window.GDCoursePackageBoundaryGate = { shouldActivateNow, createWatch };
})();

/* One flat undo stack for player-set state during a hole - wind and pin
   placement today, anything else that mutates player-set state later.
   Each entry is a closure that puts the state back the way it was; Back
   pops and runs the most recent one instead of leaving the play screen,
   so nothing here needs to know what kind of action it is undoing.
   Cleared on every hole change and at round start/stop (boot.js/play.js) -
   undoing into a different hole's state would be more confusing than
   having nothing left to undo. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var stack = [];

  app.undo = {
    push: function (revert) { if (typeof revert === "function") stack.push(revert); },
    clear: function () { stack = []; },
    any: function () { return stack.length > 0; },
    /* Runs and discards the most recent entry. Returns whether there was
       one, so a caller (Back) knows whether it handled anything. */
    pop: function () {
      var revert = stack.pop();
      if (!revert) return false;
      try { revert(); } catch (e) {}
      return true;
    }
  };
})();

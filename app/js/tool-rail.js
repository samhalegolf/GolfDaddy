/* Tool rail: a single tab in the top-right corner that drops down a panel of
   play-time tools, instead of loose buttons scattered across the screen.
   Empty for now — tools land in here one at a time as they're built. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  function toggle() {
    var tab = document.getElementById("toolRailTab");
    var rail = document.getElementById("toolRail");
    if (!tab || !rail) return;
    var open = rail.classList.contains("hiddenState");
    rail.classList.toggle("hiddenState", !open);
    tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  app.toolRail = { toggle: toggle };

  document.addEventListener("DOMContentLoaded", function () {
    var tab = document.getElementById("toolRailTab");
    if (tab) tab.addEventListener("click", toggle);
  });
})();

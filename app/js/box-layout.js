/* Free-position layout for the shot card's own text. Every label and value
   inside #distanceBar (data-move) is a separate movable, resizable box —
   dragging moves it, the small handle on its corner resizes it — so the
   card's arrangement is something to try by hand rather than guess at in
   CSS. Positions persist per box in localStorage; nothing here talks to a
   server or any course/surface table.

   Edit mode is off by default (a normal readout, no handles, no outlines).
   The gear in the card's corner toggles it. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var STORAGE_KEY = "clarity:shot-card-boxes:v1";
  var MIN_SCALE = 0.5, MAX_SCALE = 3;

  var layout = {};
  try { layout = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; } catch (e) { layout = {}; }
  var editing = false;

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch (e) {}
  }

  function boxes() {
    var bar = document.getElementById("distanceBar");
    return bar ? Array.prototype.slice.call(bar.querySelectorAll("[data-move]")) : [];
  }

  function applyBox(el) {
    var b = el.id && layout[el.id];
    el.style.transform = b ? "translate(" + b.x + "px," + b.y + "px) scale(" + b.s + ")" : "";
  }

  function setBox(id, next) {
    layout[id] = next;
    save();
  }

  function ensureHandle(el) {
    var handle = el.querySelector(".boxHandle");
    if (handle) return handle;
    handle = document.createElement("span");
    handle.className = "boxHandle";
    el.appendChild(handle);
    return handle;
  }

  /* Drag on the box body moves it; drag on its handle resizes it. Both read
     the box's position at pointerdown and write a fresh {x,y,s} on every
     move — no incremental math to drift out of sync with what is on screen. */
  function wire(el) {
    if (!el.id || el.dataset.boxWired) return;
    el.dataset.boxWired = "1";
    var handle = ensureHandle(el);

    el.addEventListener("pointerdown", function (e) {
      if (!editing || e.target === handle) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      var start = layout[el.id] || { x: 0, y: 0, s: 1 };
      var sx = e.clientX, sy = e.clientY;
      function move(ev) {
        setBox(el.id, { x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy), s: start.s });
        applyBox(el);
      }
      function up() { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); }
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });

    handle.addEventListener("pointerdown", function (e) {
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      var start = layout[el.id] || { x: 0, y: 0, s: 1 };
      var sy = e.clientY;
      function move(ev) {
        var s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, start.s + (sy - ev.clientY) / 80));
        setBox(el.id, { x: start.x, y: start.y, s: s });
        applyBox(el);
      }
      function up() { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  function wireAll() { boxes().forEach(wire); }
  function applyAll() { boxes().forEach(applyBox); }

  function setEditing(on) {
    editing = !!on;
    var bar = document.getElementById("distanceBar");
    if (bar) bar.classList.toggle("layout-editing", editing);
  }

  app.boxLayout = {
    toggle: function () { setEditing(!editing); },
    /* Escape hatch for a botched drag session — clears every saved box. */
    reset: function () { layout = {}; save(); applyAll(); }
  };

  document.addEventListener("DOMContentLoaded", function () {
    wireAll();
    applyAll();
    var toggle = document.getElementById("cardEditToggle");
    if (toggle) {
      toggle.addEventListener("click", function (e) { e.stopPropagation(); app.boxLayout.toggle(); });
      /* A drag session gone wrong can push boxes off-screen with no visible
         outline left to grab — double-tap the gear is the way back. */
      toggle.addEventListener("dblclick", function (e) { e.stopPropagation(); e.preventDefault(); app.boxLayout.reset(); });
    }
  });
})();

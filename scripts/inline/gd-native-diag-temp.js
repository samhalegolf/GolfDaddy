/* TEMPORARY diagnostic - not for commit.
   Records who blanks the shell when Home is pressed. */
(function () {
  "use strict";
  var KEY = "gd_home_diag_v1";
  /* Load what previous sessions recorded. Starting empty meant every app restart
     wiped the evidence, which is exactly what happens after reproducing a bug. */
  var log = (function () {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]") || []; } catch (_e) { return []; }
  })();
  var session = Math.random().toString(36).slice(2, 7);

  function push(entry) {
    entry.t = new Date().toISOString().slice(11, 23);
    entry.s = session;
    log.push(entry);
    if (log.length > 200) log = log.slice(-200);
    try { localStorage.setItem(KEY, JSON.stringify(log)); } catch (_e) {}
  }

  function safe(fn, fb) { try { return fn(); } catch (e) { return fb; } }

  function styleOf(id) {
    var el = document.getElementById(id);
    if (!el) return "missing";
    var cs = getComputedStyle(el);
    return [
      el.classList.contains("hidden") ? "hidden" : "shown",
      cs.display, cs.visibility, cs.opacity
    ].join("/");
  }

  function snap(tag) {
    return {
      tag: tag,
      route: safe(function () { return window.GDShell && window.GDShell.getState().route; }, "?"),
      accountNull: safe(function () {
        var a = window.GolfDaddyAccounts;
        return !(a && typeof a.current === "function" && a.current());
      }, "?"),
      activeId: safe(function () { return window.GD_ACCOUNT_STATE && window.GD_ACCOUNT_STATE.activeId; }, "?"),
      viewing: safe(function () { return window.GD_ACCOUNT_STATE && window.GD_ACCOUNT_STATE.viewingProfileId; }, "?"),
      shellHome: styleOf("shellHome"),
      courseScreen: styleOf("courseScreen"),
      profile: styleOf("gdProfileV67"),
      body: safe(function () { return document.body.className.split(/\s+/).filter(Boolean).join(" ").slice(0, 220); }, "")
    };
  }

  /* Who hid it. Patch the instance so we capture a synchronous stack at the
     moment 'hidden' is added or display is set to none. */
  function watchHome() {
    var home = document.getElementById("shellHome");
    if (!home || home.__gdWatched) return;
    home.__gdWatched = true;

    safe(function () {
      var list = home.classList;
      var origAdd = list.add.bind(list);
      list.add = function () {
        var args = [].slice.call(arguments);
        if (args.indexOf("hidden") !== -1) {
          push({ tag: "HIDDEN-via-classList", stack: String(new Error().stack || "").split("\n").slice(1, 7).join(" | ") });
        }
        return origAdd.apply(null, args);
      };
    });

    safe(function () {
      var st = home.style;
      var origSet = st.setProperty.bind(st);
      st.setProperty = function (name, value) {
        if ((name === "display" && value === "none") || (name === "visibility" && value === "hidden") || (name === "opacity" && String(value) === "0")) {
          push({ tag: "HIDDEN-via-style", prop: name + "=" + value, stack: String(new Error().stack || "").split("\n").slice(1, 7).join(" | ") });
        }
        return origSet(name, value);
      };
    });

    /* Catches direct .style.display = 'none' assignments too. */
    safe(function () {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          if (m.attributeName === "class" || m.attributeName === "style") {
            push({ tag: "mutation:" + m.attributeName, now: styleOf("shellHome") });
          }
        });
      }).observe(home, { attributes: true, attributeFilter: ["class", "style"] });
    });
  }

  /* Capture-phase, so we snapshot before any app handler runs. */
  function describe(el) {
    if (!el || !el.tagName) return "?";
    var bits = [el.tagName.toLowerCase()];
    if (el.id) bits.push("#" + el.id);
    if (el.className && typeof el.className === "string") bits.push("." + el.className.trim().split(/\s+/).slice(0, 3).join("."));
    var txt = (el.textContent || "").trim().slice(0, 24);
    if (txt) bits.push('"' + txt + '"');
    var oc = el.getAttribute && el.getAttribute("onclick");
    if (oc) bits.push("on=" + oc.slice(0, 40));
    return bits.join(" ").slice(0, 140);
  }

  /* Every click is logged, not just ones matching a home selector - zero clicks
     were captured last time, which means the control being pressed did not match
     what was guessed. The home-ish ones additionally get delayed snapshots. */
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var el = t.closest("button,a,[onclick],[role='button']") || t;
    var desc = describe(el);
    var homeish = /home|brand|shellHome/i.test(desc);
    push({ tag: homeish ? "CLICK-HOME" : "click", el: desc, shellHome: styleOf("shellHome") });
    if (!homeish) return;
    push(snap("BEFORE"));
    setTimeout(function () { push(snap("AFTER-0ms")); }, 0);
    setTimeout(function () { push(snap("AFTER-250ms")); }, 250);
    setTimeout(function () { push(snap("AFTER-1200ms")); }, 1200);
  }, true);

  function start() { watchHome(); push(snap("BOOT")); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(start, 800); });
  else setTimeout(start, 800);

  window.gdHomeDiag = function () { return log; };
  window.gdHomeDiagClear = function () { log = []; try { localStorage.removeItem(KEY); } catch (_e) {} return "cleared"; };
})();

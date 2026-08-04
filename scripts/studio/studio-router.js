/* Clarity Studio in-memory router — Studio-only.
 * v1 deliberately does NOT use history.pushState/popstate: scripts/gd-route-audit.js already owns
 * the browser's pushState/popstate globally (gdInstallBrowserRouteBridge), and its popstate handler
 * falls back to "go home" for any history state it doesn't recognize. Coordinating a second history
 * owner is out of scope for this branch — see docs/reports/CLARITY_STUDIO_WIRING_COMPARISON.md.
 * Real deep-linkable /studio/... URLs are a documented follow-up, not silently dropped. */
(function () {
  "use strict";

  var stack = [];
  var listeners = [];

  function notify() {
    var current = stack[stack.length - 1] || null;
    listeners.forEach(function (fn) {
      try { fn(current); } catch (e) {}
    });
  }

  function resolve(id) {
    var registry = window.GDStudioRegistry;
    if (!registry) return null;
    return registry.get(id);
  }

  function go(id, opts) {
    var record = resolve(id);
    if (!record) return false;
    var replace = !!(opts && opts.replace);
    if (replace && stack.length) stack[stack.length - 1] = id;
    else stack.push(id);
    notify();
    return true;
  }

  function back() {
    if (stack.length <= 1) return false;
    stack.pop();
    notify();
    return true;
  }

  function reset(id) {
    stack = [id || "overview"];
    notify();
  }

  function current() {
    return stack[stack.length - 1] || null;
  }

  function breadcrumb() {
    var registry = window.GDStudioRegistry;
    var id = current();
    var trail = [];
    while (id) {
      var record = registry ? registry.get(id) : null;
      if (!record) break;
      trail.unshift(record);
      id = record.parent;
    }
    return trail;
  }

  window.GDStudioRouter = {
    go: go,
    back: back,
    reset: reset,
    current: current,
    breadcrumb: breadcrumb,
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }
  };
})();

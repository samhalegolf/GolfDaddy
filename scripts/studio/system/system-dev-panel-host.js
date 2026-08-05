/* Clarity Studio — shared reparent-a-#developerPanel-card host. Studio-only.
 *
 * Same reparenting technique as course-database-page.js's GDStudioCourseDbHost (move the real,
 * unmodified DOM node, don't duplicate it — there is then only ever one of each id in the
 * document, so no duplicate-id risk regardless of what's nested inside). Used for cards that
 * are static in index.html AND for ones injected asynchronously at boot (e.g. clarity-backup.js
 * inserts #clarityBackupCard on a 1s interval, so it may not exist yet the instant this mounts —
 * this polls briefly before giving up honestly instead of silently showing nothing). */
(function () {
  "use strict";

  function mount(containerEl, selector, opts) {
    opts = opts || {};
    var maxAttempts = opts.maxAttempts || 10;
    var pollMs = opts.pollMs || 300;
    var cleanup = null;

    function tryMount() {
      var node = document.querySelector(selector);
      if (!node) return null;
      var originalParent = node.parentNode;
      var originalNextSibling = node.nextSibling;
      var wrap = document.createElement("div");
      wrap.className = "gdStudioDevPanelHost";
      wrap.appendChild(node);
      containerEl.appendChild(wrap);
      return function () {
        if (originalParent) originalParent.insertBefore(node, originalNextSibling);
      };
    }

    cleanup = tryMount();
    if (cleanup) return cleanup;

    var pending = document.createElement("p");
    pending.className = "gdStudioMuted";
    pending.textContent = "Loading…";
    containerEl.appendChild(pending);

    var attempts = 0;
    var interval = setInterval(function () {
      attempts += 1;
      var found = tryMount();
      if (found) {
        clearInterval(interval);
        pending.remove();
        cleanup = found;
        return;
      }
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        pending.textContent = "Not available on this build (" + selector + " was not found).";
      }
    }, pollMs);

    return function () {
      clearInterval(interval);
      if (typeof cleanup === "function") cleanup();
    };
  }

  window.GDStudioDevPanelHost = { mount: mount };
})();

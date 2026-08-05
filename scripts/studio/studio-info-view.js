/* Clarity Studio Info tab + wiring diagram — Studio-only.
 * Diagram is intentionally simple (stacked boxes + arrow glyphs, not computed SVG line routing) —
 * "does not require introducing a framework" per the task spec. Each render call owns its own
 * focus-history stack (in-panel Back/Reset/Open-parent controls); it does not touch browser
 * history — see studio-router.js header comment for why. */
(function () {
  "use strict";

  var REPO_BLOB_BASE = "https://github.com/samhalegolf/GolfDaddy/blob/main/";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function list(items) {
    if (!items || !items.length) return '<p class="gdStudioMuted">None documented.</p>';
    return "<ul>" + items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
  }

  function runtimeBadges(runtime) {
    if (!runtime) return "";
    var keys = ["app", "studio", "server"];
    return keys.map(function (k) {
      return '<span class="gdStudioRuntimeBadge' + (runtime[k] ? " isOn" : "") + '">' + k + "</span>";
    }).join("");
  }

  function nodeBox(record, opts) {
    if (!record) return "";
    opts = opts || {};
    var cls = "gdStudioDiagramNode" + (opts.focus ? " isFocus" : "");
    return '<button type="button" class="' + cls + '" data-gd-studio-node="' + esc(record.id) + '">' + esc(record.label) + "</button>";
  }

  function renderDiagram(record, focusStack, container) {
    var registry = window.GDStudioRegistry;
    var parent = record.parent ? registry.get(record.parent) : null;
    var children = registry.childrenOf(record.id);
    var connections = record.connections || [];

    var html = '<div class="gdStudioDiagram">';
    if (parent) {
      html += '<div class="gdStudioDiagramRow gdStudioDiagramParentRow">' + nodeBox(parent) + '<span class="gdStudioDiagramArrow">↓ parent</span></div>';
    }
    html += '<div class="gdStudioDiagramRow gdStudioDiagramFocusRow">' + nodeBox(record, { focus: true }) + "</div>";
    if (children.length) {
      html += '<div class="gdStudioDiagramRow gdStudioDiagramChildRow"><span class="gdStudioDiagramArrow">↓ children</span>' +
        children.map(function (c) { return nodeBox(c); }).join("") + "</div>";
    }
    if (connections.length) {
      html += '<div class="gdStudioDiagramRow gdStudioDiagramConnRow"><span class="gdStudioDiagramArrow">⇢ connections</span>' +
        connections.map(function (conn) {
          var target = registry.get(conn.target);
          var label = conn.direction + (conn.label ? ": " + conn.label : "");
          return '<span class="gdStudioDiagramConn">' + (target ? nodeBox(target) : '<em>' + esc(conn.target) + "</em>") +
            '<span class="gdStudioDiagramConnLabel">' + esc(label) + "</span></span>";
        }).join("") + "</div>";
    }
    html += "</div>";

    var canGoBack = focusStack.length > 1;
    html += '<div class="gdStudioDiagramControls">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-studio-diagram-action="back"' + (canGoBack ? "" : " disabled") + '>Back one level</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-studio-diagram-action="reset">Reset to section</button>' +
      (parent ? '<button type="button" class="gdStudioDiagramBtn" data-gd-studio-diagram-action="open-parent">Open parent section</button>' : "") +
      "</div>";

    html += '<div class="gdStudioDiagramDetail" id="gdStudioDiagramDetail" hidden></div>';
    return html;
  }

  function detailPanelHtml(node) {
    var codeRows = (node.code || []).map(function (c) {
      var href = REPO_BLOB_BASE + c.path;
      return '<li><code>' + esc(c.path) + "</code> — " + esc(c.role) +
        ' <a href="' + esc(href) + '" target="_blank" rel="noopener">Open on GitHub</a>' +
        ' <button type="button" class="gdStudioCopyPath" data-gd-studio-copy-path="' + esc(c.path) + '">Copy file path</button></li>';
    }).join("");
    return '<div class="gdStudioDiagramDetailInner">' +
      "<h4>" + esc(node.label) + "</h4>" +
      "<p>" + esc(node.function || "") + "</p>" +
      (node.needsVerification ? '<p class="gdStudioNeedsVerification">Needs verification — ownership not confirmed from code.</p>' : "") +
      (codeRows ? "<ul>" + codeRows + "</ul>" : "") +
      "</div>";
  }

  function render(containerEl, sectionId) {
    var registry = window.GDStudioRegistry;
    var focusStack = [sectionId];

    function paint() {
      var focusId = focusStack[focusStack.length - 1];
      var record = registry.get(focusId);
      if (!record) { containerEl.innerHTML = '<p class="gdStudioMuted">Unknown section.</p>'; return; }

      var keyFnRows = (record.keyFunctions || []).map(function (fn) {
        return "<li><code>" + esc(fn.name) + "</code> — " + esc(fn.purpose) + " (<code>" + esc(fn.codePath) + "</code>)</li>";
      }).join("");
      var codeRows = (record.code || []).map(function (c) {
        var href = REPO_BLOB_BASE + c.path;
        return "<li><code>" + esc(c.path) + "</code> — " + esc(c.role) + ' <a href="' + esc(href) + '" target="_blank" rel="noopener">Open on GitHub</a></li>';
      }).join("");
      var warnings = (record.warnings || []).slice();
      if (record.needsVerification) warnings.unshift("Ownership for this section has not been confirmed by reading source — treat as a lead, not a fact.");

      containerEl.innerHTML =
        '<div class="gdStudioInfo">' +
        '<section><h3>Function</h3><p>' + esc(record.function || "") + "</p></section>" +
        "<section><h3>Interactive wiring diagram</h3>" + renderDiagram(record, focusStack, containerEl) + "</section>" +
        "<section><h3>Inputs</h3>" + list(record.inputs) + "</section>" +
        "<section><h3>Outputs</h3>" + list(record.outputs) + "</section>" +
        "<section><h3>Connected systems</h3>" + list((record.connections || []).map(function (c) { return c.target + " (" + c.direction + (c.label ? ": " + c.label : "") + ")"; })) + "</section>" +
        "<section><h3>Code owner</h3><p>" + esc(record.owner || "") + "</p>" + (codeRows ? "<ul>" + codeRows + "</ul>" : "") + "</section>" +
        "<section><h3>Key functions</h3>" + (keyFnRows ? "<ul>" + keyFnRows + "</ul>" : '<p class="gdStudioMuted">None documented.</p>') + "</section>" +
        "<section><h3>Data ownership</h3><p><strong>Owns:</strong></p>" + list(record.owns) + "<p><strong>Does not own:</strong></p>" + list(record.doesNotOwn) + "</section>" +
        '<section><h3>Runtime</h3><div class="gdStudioRuntimeBadges">' + runtimeBadges(record.runtime) + "</div></section>" +
        "<section><h3>Architecture warnings</h3>" + list(warnings) + "</section>" +
        "</div>";

      var detailEl = containerEl.querySelector("#gdStudioDiagramDetail");

      containerEl.querySelectorAll("[data-gd-studio-node]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-gd-studio-node");
          var node = registry.get(id);
          if (!node || !detailEl) return;
          detailEl.hidden = false;
          detailEl.innerHTML = detailPanelHtml(node) +
            '<button type="button" class="gdStudioDiagramBtn" data-gd-studio-diagram-action="explore" data-gd-studio-explore-id="' + esc(id) + '">Explore wiring</button>';
          var exploreBtn = detailEl.querySelector("[data-gd-studio-diagram-action='explore']");
          if (exploreBtn) exploreBtn.addEventListener("click", function () {
            focusStack.push(id);
            paint();
          });
        });
      });

      containerEl.querySelectorAll("[data-gd-studio-diagram-action]").forEach(function (btn) {
        var action = btn.getAttribute("data-gd-studio-diagram-action");
        if (action === "explore") return; // wired above with its own id
        btn.addEventListener("click", function () {
          if (action === "back" && focusStack.length > 1) { focusStack.pop(); paint(); }
          else if (action === "reset") { focusStack = [sectionId]; paint(); }
          else if (action === "open-parent" && window.GDStudioRouter) {
            var current = registry.get(focusStack[focusStack.length - 1]);
            if (current && current.parent) window.GDStudioRouter.go(current.parent);
          }
        });
      });

      containerEl.querySelectorAll("[data-gd-studio-copy-path]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var path = btn.getAttribute("data-gd-studio-copy-path");
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(path).catch(function () {});
          }
        });
      });
    }

    paint();
  }

  window.GDStudioInfoView = { render: render };
})();

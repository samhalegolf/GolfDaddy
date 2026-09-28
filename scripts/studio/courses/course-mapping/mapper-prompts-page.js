/* Studio > Courses > Course Mapping > Claude Debug Prompts.
 *
 * One editor per kind of mapping failure. What the operator types here is the first
 * thing Claude reads when a job of that kind fails for good and is handed to the
 * mapper-debug Routine (docs/CLAUDE_MAPPER_DEBUG_ROUTINE.md). Everything after the
 * prompt - the job facts, the satellite and OSM captures with their georeference, the
 * output contract, the diagnostics - is appended by the worker and shown here as an
 * outline so nobody has to guess what follows their words.
 *
 * Reads and writes /api/course-mapper-prompts (admin only). The kinds and defaults come
 * from the server, never from a copy here. */
(function () {
  "use strict";
  var API = "/api/course-mapper-prompts";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function token() {
    if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
    return Promise.resolve("");
  }

  function call(method, body) {
    return token().then(function (t) {
      return fetch(API, {
        method: method,
        cache: "no-store",
        headers: Object.assign({ Accept: "application/json" }, t ? { Authorization: "Bearer " + t } : {}, body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data && data.error || ("HTTP " + r.status));
        return data;
      });
    });
  }

  function renderKind(entry, placeholders, promptMax) {
    var card = document.createElement("section");
    card.className = "gdStudioCard";
    card.style.cssText = "display:block;text-align:left;margin:0 0 16px;padding:14px;cursor:default";
    card.innerHTML =
      '<div class="gdStudioCardLabel">' + esc(entry.label) + ' <span class="gdAdminCourseStatusDot ' + (entry.stored ? "good" : "muted") + '" data-role="badge">' + (entry.stored ? "custom" : "default") + "</span></div>" +
      '<div class="gdStudioCardHint">' + esc(entry.when) + "</div>" +
      '<textarea data-role="prompt" rows="9" maxlength="' + promptMax + '" style="width:100%;margin:10px 0 8px;font:inherit;font-size:13px;line-height:1.4;padding:8px;box-sizing:border-box"></textarea>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button type="button" class="gdStudioDiagramBtn" data-role="save">Save prompt</button>' +
        '<button type="button" class="gdStudioDiagramBtn" data-role="reset">Reset to default</button>' +
        '<span class="gdStudioMuted" data-role="status"></span>' +
      "</div>" +
      "<details style=\"margin-top:10px\"><summary class=\"gdStudioMuted\">What Claude receives after your prompt</summary>" +
        '<pre data-role="outline" style="white-space:pre-wrap;font-size:12px;line-height:1.35;max-height:320px;overflow:auto;padding:8px;background:rgba(0,0,0,.04)"></pre>' +
      "</details>";
    var prompt = card.querySelector('[data-role="prompt"]');
    var status = card.querySelector('[data-role="status"]');
    var badge = card.querySelector('[data-role="badge"]');
    prompt.value = entry.prompt || "";
    card.querySelector('[data-role="outline"]').textContent = entry.outline || "";

    function apply(saved) {
      prompt.value = saved.prompt || "";
      badge.textContent = saved.stored ? "custom" : "default";
      badge.className = "gdAdminCourseStatusDot " + (saved.stored ? "good" : "muted");
      status.textContent = saved.stored ? "Saved " + (saved.updatedAt ? new Date(saved.updatedAt).toLocaleString() : "") : "Using the default";
    }
    card.querySelector('[data-role="save"]').addEventListener("click", function () {
      status.textContent = "Saving...";
      call("POST", { kind: entry.kind, prompt: prompt.value }).then(function (data) { apply(data.saved); })
        .catch(function (e) { status.textContent = "Not saved: " + (e && e.message || e); });
    });
    card.querySelector('[data-role="reset"]').addEventListener("click", function () {
      status.textContent = "Resetting...";
      call("POST", { kind: entry.kind, reset: true }).then(function (data) { apply(data.saved); })
        .catch(function (e) { status.textContent = "Not reset: " + (e && e.message || e); });
    });
    return card;
  }

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.innerHTML =
      "<p>When a mapping job fails for good, the worker works out what kind of failure it is and " +
      "hands it to the Claude mapper-debug Routine with the prompt below for that kind, then the " +
      "job facts, two georeferenced captures of the course (satellite and OpenStreetMap) and the " +
      "shape the drawn geometry must come back in. Edit the prompt for each kind here. " +
      "Placeholders are filled from the job.</p>";
    var legend = document.createElement("p");
    legend.className = "gdStudioMuted";
    var list = document.createElement("div");
    list.innerHTML = '<p class="gdStudioMuted">Loading prompts...</p>';
    containerEl.appendChild(intro);
    containerEl.appendChild(legend);
    containerEl.appendChild(list);

    call("GET").then(function (data) {
      legend.innerHTML = "Placeholders: " + (data.placeholders || []).map(function (p) {
        return "<code>" + esc(p.token) + "</code> " + esc(p.meaning);
      }).join(" &middot; ");
      list.innerHTML = "";
      (data.kinds || []).forEach(function (entry) {
        list.appendChild(renderKind(entry, data.placeholders || [], data.promptMax || 8000));
      });
    }).catch(function (e) {
      list.innerHTML = '<p class="gdStudioMuted">Could not load prompts: ' + esc(e && e.message || e) + ". Sign in as an admin and try again.</p>";
    });
    return function cleanup() {};
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["mapper-prompts"] = render;
})();

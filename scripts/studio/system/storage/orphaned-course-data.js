/* Clarity Studio — System / Storage: orphaned course data. Studio-only.
 *
 * Lists every course id that still owns rows or rendered frames but has no
 * course_maps row, and clears them one at a time.
 *
 * Exists because leftovers are not cosmetic and were invisible. A published
 * course_visuals row whose course_maps row is gone made /api/course-package answer
 * "full-map-ready" for a null map and 502 on every request for that course id.
 * Four courses sat in that state holding 233MB of frames, and nothing in the app
 * could show it, let alone clear it.
 *
 * Reads and writes /api/course-orphans, which is admin-verified server-side - this
 * panel does no gating of its own beyond passing the session token along. */
(function () {
  "use strict";

  var ENDPOINT = "/api/course-orphans";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  async function accessToken() {
    try {
      if (window.GDSupabaseAuth && typeof window.GDSupabaseAuth.getAccessToken === "function") {
        return await window.GDSupabaseAuth.getAccessToken();
      }
    } catch (e) {}
    try {
      var raw = localStorage.getItem("gd_supabase_session");
      return raw ? (JSON.parse(raw) || {}).access_token || "" : "";
    } catch (e) { return ""; }
  }

  async function call(method, body) {
    var token = await accessToken();
    var response = await fetch(ENDPOINT, {
      method: method,
      headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { Authorization: "Bearer " + token } : {}
      ),
      body: body ? JSON.stringify(body) : undefined
    });
    var payload = await response.json().catch(function () { return null; });
    if (!response.ok) throw new Error((payload && payload.error) || ("HTTP " + response.status));
    return payload;
  }

  function render(containerEl) {
    var card = el("div", "gdStudioCard");
    var head = el("div");
    head.appendChild(el("h3", null, "Orphaned course data"));
    head.appendChild(el("p", "gdStudioMuted",
      "Courses with no course_maps row that still own visual rows, job history or rendered frames. "
      + "A published visual with no map makes /api/course-package fail for that course."));
    card.appendChild(head);

    var status = el("p", "gdStudioMuted", "Loading…");
    var list = el("div");
    var refresh = el("button", "gdStudioBtn", "Refresh");
    refresh.style.marginBottom = "10px";
    card.appendChild(refresh);
    card.appendChild(status);
    card.appendChild(list);
    containerEl.appendChild(card);

    function row(orphan) {
      var wrap = el("div", "gdStudioRow");
      wrap.style.cssText = "display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08)";

      var left = el("div");
      left.style.flex = "1";
      var title = el("div", null, orphan.courseId);
      title.style.fontWeight = "600";
      if (orphan.published) {
        var flag = el("span", null, " published — breaks course-package");
        flag.style.cssText = "color:#ff9a9a;font-weight:400;font-size:12px";
        title.appendChild(flag);
      }
      left.appendChild(title);
      left.appendChild(el("div", "gdStudioMuted",
        [orphan.visuals + " visual row(s)", orphan.visualJobs + " visual job(s)",
         orphan.mapperJobs + " mapper job(s)", orphan.files + " file(s)", orphan.bytesLabel].join(" · ")));

      var button = el("button", "gdStudioBtn", "Delete");
      button.onclick = function () {
        /* Irreversible and it removes files, so it asks - and it names the course
           rather than saying "are you sure", because the whole failure mode this
           panel cleans up came from acting on the wrong course id. */
        if (!window.confirm("Permanently delete all leftover data and files for " + orphan.courseId + "?\n\n"
          + orphan.files + " file(s), " + orphan.bytesLabel + ". This cannot be undone.")) return;
        button.disabled = true;
        button.textContent = "Deleting…";
        call("POST", { courseId: orphan.courseId }).then(function (result) {
          wrap.style.opacity = ".5";
          button.textContent = "Deleted";
          if (result && result.errors && result.errors.length) {
            wrap.appendChild(el("div", "gdStudioMuted", "Partial: " + result.errors.join("; ")));
          }
          load();
        }).catch(function (error) {
          button.disabled = false;
          button.textContent = "Delete";
          wrap.appendChild(el("div", "gdStudioMuted", "Failed: " + error.message));
        });
      };

      wrap.appendChild(left);
      wrap.appendChild(button);
      return wrap;
    }

    function load() {
      status.textContent = "Loading…";
      list.textContent = "";
      call("GET").then(function (payload) {
        var orphans = (payload && payload.orphans) || [];
        if (!orphans.length) {
          status.textContent = "Nothing orphaned — every course with data has a course_maps row.";
          return;
        }
        status.textContent = orphans.length + " orphaned course(s), " + payload.totalBytesLabel + " of files.";
        orphans.forEach(function (orphan) { list.appendChild(row(orphan)); });
      }).catch(function (error) {
        status.textContent = "Could not load: " + error.message;
      });
    }

    refresh.onclick = load;
    load();
    return null;
  }

  window.GDStudioOrphanedCourseData = { render: render };
})();

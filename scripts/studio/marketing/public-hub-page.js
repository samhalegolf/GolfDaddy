/* Clarity Studio — Marketing › Public Facing Hub. Studio-only.
 *
 * Where public course pages (/courses/<courseId>, functions/course-page.mjs) are run from:
 *
 *   1. RULES      two rule makers of the same shape. "Lands in the hub" picks the courses that
 *                 should get header snapshots; "Auto publish" picks the courses publishing
 *                 switches on. Countries, minimum holes/objects/bunkers/water/trees, and
 *                 whether the map, the visual and the headers must be there.
 *   2. PUBLISH    run publishing: everything that matches Auto publish and is not on yet. It
 *                 never takes a page down by itself - pages that stopped matching are listed
 *                 with a button each, because a live page has search ranking to lose.
 *   3. HUB        the courses that land here, with their header frames and page status. Headers
 *                 are added by hand for now: send the course to the Snapshot Machine, shoot it,
 *                 then drop the frames on its row (or use the runner's --upload).
 *
 * Every rule, count and decision comes from /api/public-hub (functions/public-hub.mjs, rules in
 * functions/lib/gd-public-hub-rules.mjs); this page draws what the server says and posts
 * changes. Switching a page off by hand holds it, so publishing never switches it back on. */
(function () {
  "use strict";

  var FILTER_KEY = "clarity:studio:public-hub:filter:v1";
  var WEB_WIDTH = 585;           // marketing/course-page-assets.mjs WEB_WIDTH
  var COUNTS = [
    { key: "minHoles", label: "Holes" },
    { key: "minObjects", label: "Objects" },
    { key: "minBunkers", label: "Bunkers" },
    { key: "minWater", label: "Water" },
    { key: "minTrees", label: "Trees" }
  ];
  var CHECKS = [
    { key: "publishedMap", label: "Map published" },
    { key: "publishedVisual", label: "Visual published" },
    { key: "headers", label: "All three headers" }
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function button(label, className) {
    var b = el("button", className || "gdStudioDiagramBtn", label);
    b.type = "button";
    return b;
  }

  async function accessToken() {
    if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
    try {
      var auth = window.ClaritySupabaseAuth;
      if (auth && typeof auth.freshAccessToken === "function") return (await auth.freshAccessToken()) || "";
    } catch (e) {}
    return "";
  }

  async function api(method, body) {
    var token = await accessToken();
    if (!token) throw new Error("Sign in as an admin first.");
    var res = await fetch("/api/public-hub", {
      method: method,
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }

  function readFilter() { try { return localStorage.getItem(FILTER_KEY) || "hub"; } catch (e) { return "hub"; } }
  function writeFilter(v) { try { localStorage.setItem(FILTER_KEY, v); } catch (e) {} }

  /* A snapshot frame (1170x2532 PNG) as the page's web-size JPEG, base64 without the prefix. */
  function toHeaderJpeg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = Math.min(WEB_WIDTH, img.naturalWidth);
        var h = Math.round(img.naturalHeight * w / img.naturalWidth);
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.86).split(",")[1]);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(file.name + " is not an image")); };
      img.src = url;
    });
  }

  /* Which frame a dropped file is: by name (the runner's names, or just 01/02/03), otherwise
     the next frame not yet claimed, in the order the files were picked. */
  function assignFrames(files, frames) {
    var out = [], taken = {};
    var named = Array.prototype.map.call(files, function (file) {
      var name = file.name.toLowerCase();
      var hit = frames.filter(function (f, i) {
        return name.indexOf(f) >= 0 || name.indexOf(f.split("-").slice(1).join("-")) >= 0 || new RegExp("(^|[^0-9])0?" + (i + 1) + "([^0-9]|$)").test(name);
      })[0] || null;
      if (hit && !taken[hit]) { taken[hit] = true; return { file: file, frame: hit }; }
      return { file: file, frame: null };
    });
    named.forEach(function (entry) {
      if (!entry.frame) entry.frame = frames.filter(function (f) { return !taken[f]; })[0] || null;
      if (entry.frame) { taken[entry.frame] = true; out.push(entry); }
    });
    return out;
  }

  function render(containerEl) {
    var destroyed = false;
    var data = null;
    var draft = null;      // the rules being edited, saved on Save
    var filter = readFilter();
    var busy = {};

    var root = el("div", "gdMktRoot");
    containerEl.appendChild(root);

    root.appendChild(el("div", "gdStudioLede",
      "<p>The public course pages, run from one place. Set the rules for which courses <strong>land in the hub</strong> " +
      "to get their header snapshots, and which are <strong>published automatically</strong>. Headers are added by hand for now: " +
      "send a course to the Snapshot Machine, shoot it, then drop its frames on its row below.</p>"));

    var status = el("p", "gdStudioMuted", "Loading…");
    root.appendChild(status);

    // ---- section 1: rules
    var rulesHead = el("div", "gdMktSectionHead");
    rulesHead.appendChild(el("h3", null, "1 &middot; Rules"));
    var saveBtn = button("Save rules");
    var revertBtn = button("Undo changes");
    rulesHead.appendChild(saveBtn);
    rulesHead.appendChild(revertBtn);
    root.appendChild(rulesHead);
    var rulesEl = el("div", "gdHubRules");
    root.appendChild(rulesEl);

    // ---- section 2: publishing
    var pubHead = el("div", "gdMktSectionHead");
    pubHead.appendChild(el("h3", null, "2 &middot; Publishing"));
    var publishBtn = button("Run publishing");
    pubHead.appendChild(publishBtn);
    root.appendChild(pubHead);
    var pubEl = el("div", "gdMktOut");
    root.appendChild(pubEl);

    // ---- section 3: the hub
    var hubHead = el("div", "gdMktSectionHead");
    hubHead.appendChild(el("h3", null, "3 &middot; Courses"));
    var filterSel = el("select", "gdHubFilter",
      '<option value="hub">In the hub</option><option value="headers">In the hub, headers missing</option>' +
      '<option value="public">Page on</option><option value="all">Every course</option>');
    filterSel.value = filter;
    hubHead.appendChild(filterSel);
    root.appendChild(hubHead);
    var hubEl = el("div", "gdHubTableWrap");
    root.appendChild(hubEl);

    // ------------------------------------------------------------ load

    function load() {
      status.textContent = "Loading…";
      return api("GET").then(function (got) {
        if (destroyed) return;
        data = got;
        draft = JSON.parse(JSON.stringify(got.rules));
        status.innerHTML = got.updatedAt
          ? "Rules last saved " + esc(new Date(got.updatedAt).toLocaleString()) + (got.updatedBy ? " by " + esc(got.updatedBy) : "") + "."
          : "These are the starting rules - nothing has been saved yet.";
        renderAll();
      }).catch(function (error) {
        if (!destroyed) status.textContent = "Could not load the hub: " + (error.message || error);
      });
    }

    // ------------------------------------------------------------ rules

    function countryOptions() {
      var seen = {};
      (data.courses || []).forEach(function (c) {
        if (!c.countryCode) return;
        var entry = seen[c.countryCode] || (seen[c.countryCode] = { code: c.countryCode, name: c.country || c.countryCode, n: 0 });
        entry.n += 1;
      });
      [draft.hub, draft.autoPublish].forEach(function (rule) {
        rule.countries.forEach(function (code) { if (!seen[code]) seen[code] = { code: code, name: code, n: 0 }; });
      });
      return Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return b.n - a.n; });
    }

    function ruleCard(title, lede, rule, matchCount, withEnable) {
      var card = el("div", "gdMktCard gdHubRule");
      card.appendChild(el("div", "gdMktCardHead", "<strong>" + esc(title) + "</strong> " +
        '<span class="gdStudioMuted">&middot; ' + matchCount + " course" + (matchCount === 1 ? "" : "s") + " match the saved rule</span>"));
      card.appendChild(el("p", "gdStudioMuted", lede));

      if (withEnable) {
        var on = el("label", "gdMktToggle", '<input type="checkbox"' + (rule.enabled ? " checked" : "") + "> Publishing switches matches on");
        on.querySelector("input").addEventListener("change", function (e) { rule.enabled = e.target.checked; markDirty(); });
        card.appendChild(on);
      }

      card.appendChild(el("div", "gdHubLabel", "Countries " + '<span class="gdStudioMuted">(none ticked = any country)</span>'));
      var chips = el("div", "gdHubChips");
      countryOptions().forEach(function (c) {
        var chip = el("label", "gdHubChip" + (rule.countries.indexOf(c.code) >= 0 ? " isOn" : ""),
          '<input type="checkbox"' + (rule.countries.indexOf(c.code) >= 0 ? " checked" : "") + "> " + esc(c.name) +
          ' <span class="gdStudioMuted">' + c.n + "</span>");
        chip.querySelector("input").addEventListener("change", function (e) {
          var i = rule.countries.indexOf(c.code);
          if (e.target.checked && i < 0) rule.countries.push(c.code);
          if (!e.target.checked && i >= 0) rule.countries.splice(i, 1);
          chip.classList.toggle("isOn", e.target.checked);
          markDirty();
        });
        chips.appendChild(chip);
      });
      card.appendChild(chips);

      card.appendChild(el("div", "gdHubLabel", "At least " + '<span class="gdStudioMuted">(0 = no minimum)</span>'));
      var fields = el("div", "gdMktFields");
      COUNTS.forEach(function (f) {
        var wrap = el("label", "gdStudioViewportField", esc(f.label) + " ");
        var input = el("input");
        input.type = "number";
        input.min = "0";
        input.value = String(rule[f.key] || 0);
        input.addEventListener("input", function () { rule[f.key] = Math.max(0, Math.floor(Number(input.value) || 0)); markDirty(); });
        wrap.appendChild(input);
        fields.appendChild(wrap);
      });
      card.appendChild(fields);

      var checks = el("div", "gdHubChecks");
      CHECKS.forEach(function (f) {
        var label = el("label", "gdMktToggle", '<input type="checkbox"' + (rule[f.key] ? " checked" : "") + "> " + esc(f.label));
        label.querySelector("input").addEventListener("change", function (e) { rule[f.key] = e.target.checked; markDirty(); });
        checks.appendChild(label);
      });
      card.appendChild(checks);
      return card;
    }

    function dirty() { return !!(data && JSON.stringify(draft) !== JSON.stringify(data.rules)); }
    function markDirty() {
      saveBtn.disabled = !dirty();
      revertBtn.disabled = !dirty();
    }

    function renderRules() {
      rulesEl.innerHTML = "";
      var courses = data.courses || [];
      rulesEl.appendChild(ruleCard("Lands in the hub",
        "Courses that pass this are listed below to get their header snapshots.",
        draft.hub, courses.filter(function (c) { return c.inHub; }).length, false));
      rulesEl.appendChild(ruleCard("Auto publish",
        "Courses that pass this get their public page switched on when publishing runs. " +
        "The page itself still needs a published map and something to show - a published visual or a Garmin package - whatever this says.",
        draft.autoPublish, courses.filter(function (c) { return c.autoMatch; }).length, true));
      markDirty();
    }

    saveBtn.addEventListener("click", function () {
      if (!dirty()) return;
      saveBtn.disabled = true;
      api("POST", { action: "rules", rules: draft }).then(load).catch(function (error) {
        status.textContent = "Rules not saved: " + (error.message || error);
        markDirty();
      });
    });
    revertBtn.addEventListener("click", function () {
      draft = JSON.parse(JSON.stringify(data.rules));
      renderRules();
    });

    // ------------------------------------------------------------ publishing

    function renderPublish() {
      var plan = data.publish || { toPublish: [], notMatching: [] };
      var held = data.courses.filter(function (c) { return c.held; });
      pubEl.innerHTML = "";
      publishBtn.disabled = !plan.toPublish.length;
      publishBtn.textContent = plan.toPublish.length ? "Publish " + plan.toPublish.length + " course" + (plan.toPublish.length === 1 ? "" : "s") : "Nothing to publish";

      pubEl.appendChild(el("p", "gdStudioMuted", !data.rules.autoPublish.enabled
        ? "Auto publish is switched off in its rule, so publishing does nothing."
        : plan.toPublish.length
          ? plan.toPublish.length + " course" + (plan.toPublish.length === 1 ? " matches" : "s match") + " Auto publish and " + (plan.toPublish.length === 1 ? "is" : "are") + " not on yet: " +
            esc(plan.toPublish.slice(0, 12).map(function (c) { return c.name; }).join(", ")) + (plan.toPublish.length > 12 ? " and " + (plan.toPublish.length - 12) + " more" : "") + "."
          : "Every course that matches Auto publish is already on."));

      var notLive = data.courses.filter(function (c) { return c.pagePublic && !c.live; });
      if (notLive.length) {
        pubEl.appendChild(el("p", "gdMktErr", notLive.length + " page" + (notLive.length === 1 ? " is" : "s are") +
          " switched on but not showing (no published map, visual or Garmin package yet) - they answer 404 until that changes."));
      }

      if (plan.notMatching.length) {
        var d = el("details", "gdMktScores");
        d.appendChild(el("summary", null, plan.notMatching.length + " page" + (plan.notMatching.length === 1 ? " is" : "s are") + " on but no longer match Auto publish"));
        var list = el("div");
        plan.notMatching.forEach(function (c) { list.appendChild(courseLine(c, "Take down", false)); });
        d.appendChild(list);
        pubEl.appendChild(d);
      }
      if (held.length) {
        var h = el("details", "gdMktScores");
        h.appendChild(el("summary", null, held.length + " held back by hand - publishing skips " + (held.length === 1 ? "it" : "them")));
        var hl = el("div");
        held.forEach(function (c) { hl.appendChild(courseLine(c, "Publish now", true)); });
        h.appendChild(hl);
        pubEl.appendChild(h);
      }
    }

    function courseLine(c, label, on) {
      var row = el("div", "gdMktRow");
      row.appendChild(el("div", "gdMktRowBody", "<strong>" + esc(c.name) + "</strong> " + '<span class="gdStudioMuted"><code>' + esc(c.courseId) + "</code></span>"));
      var b = button(label, "gdStudioCopyPath");
      b.addEventListener("click", function () { setPage(c.courseId, on); });
      row.appendChild(b);
      return row;
    }

    publishBtn.addEventListener("click", function () {
      var n = (data.publish && data.publish.toPublish.length) || 0;
      if (!n) return;
      if (!window.confirm("Switch on the public page for " + n + " course" + (n === 1 ? "" : "s") + "?\n\nThey go live at /courses/<course> and into the sitemap.")) return;
      publishBtn.disabled = true;
      api("POST", { action: "publish" }).then(function (got) {
        status.textContent = "Published " + (got.published || []).length + " course page" + ((got.published || []).length === 1 ? "" : "s") + ". The CDN copy of a page can lag up to a day.";
        return load();
      }).catch(function (error) {
        status.textContent = "Publishing failed: " + (error.message || error);
        publishBtn.disabled = false;
      });
    });

    function setPage(courseId, on) {
      if (!on && !window.confirm("Take /courses/" + courseId + " down? It will be held, so publishing will not switch it back on.")) return;
      api("POST", { action: "page", courseId: courseId, pagePublic: on }).then(function () {
        status.textContent = on ? "/courses/" + courseId + " is on." : "/courses/" + courseId + " taken down and held.";
        return load();
      }).catch(function (error) { status.textContent = "Page switch failed: " + (error.message || error); });
    }

    // ------------------------------------------------------------ the hub table

    function visible() {
      return (data.courses || []).filter(function (c) {
        if (filter === "all") return true;
        if (filter === "public") return c.pagePublic;
        if (filter === "headers") return c.inHub && c.headerCount < data.frames.length;
        return c.inHub;
      }).sort(function (a, b) { return b.objectCount - a.objectCount; });
    }

    function pageCell(c) {
      if (c.live) return '<a href="/courses/' + encodeURIComponent(c.courseId) + '" target="_blank" rel="noopener">Live &#8599;</a>';
      if (c.pagePublic) return '<span class="gdMktErr">On, not showing</span>';
      if (c.held) return '<span class="gdStudioMuted">Held</span>';
      return c.autoMatch ? '<span class="gdStudioMuted">Off &middot; next publish</span>' : '<span class="gdStudioMuted">Off</span>';
    }

    function renderHub() {
      var list = visible();
      hubEl.innerHTML = "";
      if (!list.length) {
        hubEl.appendChild(el("p", "gdStudioMuted", filter === "hub" ? "No course passes the hub rule yet." : "Nothing to show."));
        return;
      }
      var table = el("table", "gdStudioJobTable gdHubTable",
        "<thead><tr><th>Course</th><th>Country</th><th>Holes</th><th>Objects</th><th>Bunkers</th><th>Water</th><th>Trees</th>" +
        "<th>Headers</th><th>Page</th><th></th></tr></thead>");
      var body = el("tbody");
      list.forEach(function (c) {
        var tr = el("tr");
        var why = filter === "all" && !c.inHub ? '<div class="gdStudioMuted">Not in hub: ' + esc(c.hubMisses.join(", ")) + "</div>" : "";
        tr.innerHTML = "<td><strong>" + esc(c.name) + '</strong><div class="gdStudioMuted"><code>' + esc(c.courseId) + "</code></div>" + why + "</td>" +
          "<td>" + esc(c.countryCode || "—") + "</td><td>" + c.holeCount + "</td><td>" + c.objectCount + "</td><td>" + c.bunkerCount +
          "</td><td>" + c.waterCount + "</td><td>" + c.treeCount + "</td>" +
          "<td>" + (busy[c.courseId] ? esc(busy[c.courseId]) : c.headerCount + "/" + data.frames.length) + "</td>" +
          "<td>" + pageCell(c) + "</td>";
        var actions = el("td", "gdHubActions");

        var shoot = button(window.GDSnapshotBasket && window.GDSnapshotBasket.has(c.courseId) ? "In Snapshot Machine" : "Snapshot", "gdStudioCopyPath");
        shoot.title = "Add to the Snapshot Machine's basket";
        shoot.addEventListener("click", function () {
          if (!window.GDSnapshotBasket) return;
          window.GDSnapshotBasket.add(c);
          if (window.GDStudioRouter) window.GDStudioRouter.go("marketing-snapshots");
        });
        actions.appendChild(shoot);

        var pick = el("input");
        pick.type = "file";
        pick.accept = "image/png,image/jpeg";
        pick.multiple = true;
        pick.hidden = true;
        pick.addEventListener("change", function () { uploadHeaders(c, pick.files); pick.value = ""; });
        var add = button("Add headers", "gdStudioCopyPath");
        add.title = "Pick the frames (01-pre-lock, 02-head-to-tee, 03-approach) from a snapshot run";
        add.addEventListener("click", function () { pick.click(); });
        actions.appendChild(add);
        actions.appendChild(pick);

        var toggle = button(c.pagePublic ? "Take down" : "Publish", "gdStudioCopyPath");
        toggle.addEventListener("click", function () { setPage(c.courseId, !c.pagePublic); });
        actions.appendChild(toggle);

        tr.appendChild(actions);
        body.appendChild(tr);
      });
      table.appendChild(body);
      hubEl.appendChild(table);
    }

    async function uploadHeaders(c, files) {
      var planned = assignFrames(files || [], data.frames);
      if (!planned.length) return;
      for (var i = 0; i < planned.length; i += 1) {
        busy[c.courseId] = "Uploading " + (i + 1) + "/" + planned.length + "…";
        renderHub();
        try {
          var jpeg = await toHeaderJpeg(planned[i].file);
          await api("POST", { action: "header", courseId: c.courseId, frame: planned[i].frame, jpegBase64: jpeg });
        } catch (error) {
          delete busy[c.courseId];
          status.textContent = "Header upload failed for " + c.name + " (" + planned[i].frame + "): " + (error.message || error);
          return load();
        }
      }
      delete busy[c.courseId];
      status.textContent = planned.length + " header frame" + (planned.length === 1 ? "" : "s") + " stored for " + c.name + ": " +
        planned.map(function (p) { return p.frame; }).join(", ") + ". The page picks them up on its next render (CDN copy up to a day).";
      if (!destroyed) load();
    }

    filterSel.addEventListener("change", function () {
      filter = filterSel.value;
      writeFilter(filter);
      renderHub();
    });

    function renderAll() {
      if (!data) return;
      renderRules();
      renderPublish();
      renderHub();
    }

    load();

    return function cleanup() { destroyed = true; };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["marketing-public-hub"] = render;
  /* For dev/public-hub.test.js. */
  window.GDPublicHubPage = { assignFrames: assignFrames };
})();

/* Clarity Studio - Snapshots: see and download the imagery a course actually holds.
   STUDIO ONLY (data-gd-surface="studio"), loaded after scripts/studio/gd-admin-course-db.js.

   Two different sets of pixels live in the course-visuals bucket and this shows either:

     Baked frames   <courseId>/frames/<buildId>/h<N>.jpg   one per hole, plus an overview.
                    What GPS Play puts on screen. Eighteen images for an 18-hole course.
     Raw captures   <courseId>/captures/...                the ingredients the bake composites:
                    play-corridor segments, green-surrounds, the course backdrop and the
                    terrain reference. Fifty-odd for the same course, several per hole.

   Read-only by construction: everything here is a GET through /api/course-visual-assets, and
   nothing in this file writes a job, a recipe or a row. Looking at a course's imagery must
   never be able to change it.

   Downloads are built in the browser rather than by a function. The images are already
   same-origin (the asset proxy sits on the Studio's own origin), so a canvas can composite
   them untainted, and an eighteen-image contact sheet would otherwise mean eighteen
   Supabase round trips inside one 10-second synchronous function invocation - the exact
   shape of a timeout that only shows up on the biggest courses. */
(function () {
  "use strict";

  var ASSET_API = "/api/course-visual-assets";
  var indexes = {};        // "<courseId>:<kind>" -> {state:"loading"|"ready"|"error"|"empty", items, meta, error}
  var kindByCourse = {};   // courseId -> "frames" | "captures"
  var busyByCourse = {};   // courseId -> a label while a download is being built

  function esc(v) { return typeof gdEscapeHTML === "function" ? gdEscapeHTML(v) : String(v == null ? "" : v); }
  function assetUrl(path) { return ASSET_API + "?path=" + encodeURIComponent(String(path || "")); }
  function kindFor(courseId) { return kindByCourse[String(courseId || "")] === "captures" ? "captures" : "frames"; }
  function cacheKey(courseId, kind) { return String(courseId || "") + ":" + kind; }

  /* The version this course is at, from the Course Database's own lookup. Stamped into the
     sheet and into every filename, because a folder of hole images with no version in the
     name is exactly the thing that becomes unidentifiable three weeks later. */
  function versionLabel(courseId) {
    try {
      if (typeof gdAdminCourseVersionLabel === "function") {
        return gdAdminCourseVersionLabel({ id: courseId, key: courseId }) || "";
      }
    } catch (e) {}
    return "";
  }

  /* ------------------------------------------------------------------ index */

  /* Both index.json files describe the same bucket but not the same way, so each is
     normalised to one shape here: {key, label, hole, role, path, width, height}. `path` is
     what gets fetched - for a capture that is the export rendition rather than the
     full-resolution master, because the master runs to 17 megapixels and the rendition is
     the copy the bake itself consumes. */
  function normalizeFrames(index) {
    var items = [];
    if (index && index.overview && index.overview.path) {
      items.push({
        key: "overview", label: "Course overview", hole: null, role: "overview",
        path: index.overview.path, width: index.overview.width, height: index.overview.height
      });
    }
    (index && index.holes || []).forEach(function (hole) {
      if (!hole || !hole.path) return;
      items.push({
        key: "h" + hole.holeNumber, label: "Hole " + hole.holeNumber, hole: Number(hole.holeNumber),
        role: "hole frame", path: hole.path, width: hole.width, height: hole.height
      });
    });
    return items;
  }

  function normalizeCaptures(index) {
    return (index && index.captures || []).map(function (capture, i) {
      var hole = Number(capture && capture.holeNumber);
      var role = String(capture && capture.role || "capture");
      var has = Number.isFinite(hole) && hole > 0;
      return {
        key: "c" + i,
        label: (has ? "Hole " + hole + " · " : "") + role + (capture.terrainStageOnly ? " (terrain)" : ""),
        hole: has ? hole : null,
        role: role,
        segment: Number.isFinite(Number(capture.segmentIndex)) ? Number(capture.segmentIndex) : null,
        path: capture.pathExport || capture.path,
        width: capture.width, height: capture.height
      };
    }).filter(function (item) { return item.path; });
  }

  /* Sorted the way the course is played - overview first, then hole 1 upward, with a hole's
     several captures kept together in a stable order. An index's own array order is the
     order the worker happened to render in, which is not something to show anybody. */
  function sortItems(items) {
    return items.slice().sort(function (a, b) {
      var ah = a.hole == null ? -1 : a.hole, bh = b.hole == null ? -1 : b.hole;
      if (ah !== bh) return ah - bh;
      if (a.role !== b.role) return String(a.role).localeCompare(String(b.role));
      return (a.segment || 0) - (b.segment || 0);
    });
  }

  function loadIndex(courseId, kind) {
    var key = cacheKey(courseId, kind);
    if (indexes[key] && indexes[key].state !== "error") return;
    indexes[key] = { state: "loading" };
    fetch(assetUrl(courseId + "/" + kind + "/index.json"), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) {
        /* A course that was never scanned has no index, and the proxy answers 404. That is
           an ordinary state for this panel, not a failure to report as one. */
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (index) {
        if (!index) { indexes[key] = { state: "empty" }; return; }
        var items = sortItems(kind === "captures" ? normalizeCaptures(index) : normalizeFrames(index));
        indexes[key] = items.length
          ? { state: "ready", items: items, meta: { buildId: index.exportVersion || "", generatedAt: index.generatedAt || "" } }
          : { state: "empty" };
      })
      .catch(function (error) { indexes[key] = { state: "error", error: error && error.message || String(error) }; })
      .finally(function () { rerender(); });
  }

  function rerender() {
    if (typeof gdRenderAdminCourseDatabase === "function") gdRenderAdminCourseDatabase();
  }

  /* ------------------------------------------------------------- image loading */

  /* Same-origin, so the canvas stays untainted and toBlob works. Bounded concurrency: the
     browser will happily open eighteen 3-megapixel decodes at once and then stall the tab
     it is drawing into. */
  function loadImage(path) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("could not load " + path)); };
      img.src = assetUrl(path);
    });
  }

  async function mapLimited(items, limit, fn) {
    var out = new Array(items.length);
    var next = 0;
    async function worker() {
      while (next < items.length) {
        var i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  /* ------------------------------------------------------------- contact sheet */

  function sheetLayout(items) {
    /* Wider tiles when there are few images, narrower when a capture set runs to fifty -
       the sheet is meant to be looked at, and a 50-tile grid at full width is a canvas no
       viewer will open comfortably. */
    var many = items.length > 20;
    var cols = many ? 5 : 3;
    var tileW = many ? 520 : 720;
    /* One tile box for the whole sheet, sized off the median aspect so the common case
       fills it and the odd shape letterboxes rather than distorting.
     *
     * The median earns its keep here: a course's holes are NOT all one orientation - a
     * dogleg north runs tall where the next hole runs wide, measured on the real thing at
     * 2975x1891 one way and the reverse the next. Averaging those would size the box for a
     * shape no hole actually is; the median picks a box half of them fill. */
    var ratios = items.map(function (it) {
      var w = Number(it.width), h = Number(it.height);
      return w > 0 && h > 0 ? w / h : 1.5;
    }).sort(function (a, b) { return a - b; });
    var median = ratios[Math.floor(ratios.length / 2)] || 1.5;
    /* Clamped so one freak aspect cannot produce a tile box taller than it is useful. A
       sheet of 18 mixed-orientation holes ran to 7000px before this. */
    var tileH = Math.min(Math.round(tileW / median), Math.round(tileW * 1.35));
    return { cols: cols, tileW: tileW, tileH: tileH, pad: Math.round(tileW / 45), labelH: Math.round(tileW / 18) };
  }

  async function buildContactSheet(courseId, kind, entry) {
    var items = entry.items;
    var L = sheetLayout(items);
    var rows = Math.ceil(items.length / L.cols);
    var headerH = Math.round(L.tileW / 7);
    var cellW = L.tileW + L.pad;
    var cellH = L.tileH + L.labelH + L.pad;
    var canvas = document.createElement("canvas");
    canvas.width = L.cols * cellW + L.pad;
    canvas.height = headerH + rows * cellH + L.pad;
    var ctx = canvas.getContext("2d");

    ctx.fillStyle = "#0a1410";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var version = versionLabel(courseId);
    var title = courseId + (version ? "  " + version : "");
    ctx.fillStyle = "#e6f3ea";
    ctx.font = "600 " + Math.round(headerH * 0.34) + "px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, L.pad, Math.round(headerH * 0.45));
    ctx.fillStyle = "rgba(226,243,234,.55)";
    ctx.font = Math.round(headerH * 0.22) + "px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(
      (kind === "captures" ? "raw captures" : "baked frames") + " · " + items.length + " images"
      + (entry.meta && entry.meta.buildId ? " · build " + entry.meta.buildId : "")
      + " · sheet made " + new Date().toISOString().slice(0, 10),
      L.pad, Math.round(headerH * 0.75)
    );

    var loaded = 0;
    await mapLimited(items, 6, async function (item, i) {
      var col = i % L.cols, row = Math.floor(i / L.cols);
      var x = L.pad + col * cellW, y = headerH + row * cellH;
      ctx.fillStyle = "rgba(255,255,255,.035)";
      ctx.fillRect(x, y, L.tileW, L.tileH);
      try {
        var img = await loadImage(item.path);
        /* contain, never cover: a contact sheet exists to show what the image IS, and
           cropping to fill the box would hide the very edges a framing problem shows up at. */
        var scale = Math.min(L.tileW / img.width, L.tileH / img.height);
        var w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, x + (L.tileW - w) / 2, y + (L.tileH - h) / 2, w, h);
      } catch (e) {
        ctx.fillStyle = "rgba(255,120,120,.75)";
        ctx.font = Math.round(L.labelH * 0.5) + "px ui-monospace, monospace";
        ctx.fillText("missing", x + L.pad, y + L.tileH / 2);
      }
      ctx.fillStyle = "#cfe3d6";
      ctx.font = "600 " + Math.round(L.labelH * 0.52) + "px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(item.label, x + 2, y + L.tileH + Math.round(L.labelH * 0.72));
      loaded += 1;
      busyByCourse[courseId] = "Building sheet… " + loaded + "/" + items.length;
      rerender();
    });

    return await new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, "image/jpeg", 0.9);
    });
  }

  /* ---------------------------------------------------------------------- zip */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* A stored (uncompressed) ZIP. Deflate would buy nothing here - every member is already a
     JPEG - and writing the container by hand keeps a build-time dependency out of a Studio
     page that loads as a plain script. */
  function zipStore(files) {
    var encoder = new TextEncoder();
    var parts = [], central = [], offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
    var dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    files.forEach(function (file) {
      var nameBytes = encoder.encode(file.name);
      var data = file.data;
      var crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0, true);
      local.setUint16(8, 0, true);            // stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      var dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, nameBytes.length, true);
      dir.setUint32(42, offset, true);
      central.push(new Uint8Array(dir.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    });

    var centralSize = central.reduce(function (n, p) { return n + p.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: "application/zip" });
  }

  /* ----------------------------------------------------------------- download */

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* "<course>-<version>-<kind>" - the version is in the filename because the whole point of
     pulling these out of the database is being able to say later which bake they came from. */
  function baseName(courseId, kind) {
    var version = versionLabel(courseId);
    return [courseId, version ? version.replace(/[^\w.-]/g, "") : "", kind].filter(Boolean).join("-");
  }

  function memberName(item) {
    var stem = item.hole == null ? item.key : "h" + String(item.hole).padStart(2, "0");
    var suffix = item.role && item.role !== "hole frame" ? "-" + String(item.role).replace(/[^\w-]/g, "") : "";
    var segment = item.segment != null ? "-" + item.segment : "";
    var ext = /\.png$/i.test(item.path) ? ".png" : ".jpg";
    return stem + suffix + segment + ext;
  }

  async function downloadSheet(courseId) {
    var kind = kindFor(courseId);
    var entry = indexes[cacheKey(courseId, kind)];
    if (!entry || entry.state !== "ready" || busyByCourse[courseId]) return false;
    busyByCourse[courseId] = "Building sheet…";
    rerender();
    try {
      var blob = await buildContactSheet(courseId, kind, entry);
      if (blob) saveBlob(blob, baseName(courseId, kind) + "-contact-sheet.jpg");
    } catch (error) {
      busyByCourse[courseId] = "";
      rerender();
      if (typeof gdToast === "function") gdToast("Could not build the sheet: " + (error && error.message || error));
      return false;
    }
    busyByCourse[courseId] = "";
    rerender();
    return false;
  }

  async function downloadZip(courseId) {
    var kind = kindFor(courseId);
    var entry = indexes[cacheKey(courseId, kind)];
    if (!entry || entry.state !== "ready" || busyByCourse[courseId]) return false;
    var items = entry.items;
    busyByCourse[courseId] = "Fetching 0/" + items.length + "…";
    rerender();
    try {
      var done = 0;
      var files = await mapLimited(items, 6, async function (item) {
        var res = await fetch(assetUrl(item.path), { cache: "force-cache" });
        if (!res.ok) throw new Error(item.label + ": HTTP " + res.status);
        var buffer = await res.arrayBuffer();
        done += 1;
        busyByCourse[courseId] = "Fetching " + done + "/" + items.length + "…";
        rerender();
        return { name: memberName(item), data: new Uint8Array(buffer) };
      });
      saveBlob(zipStore(files), baseName(courseId, kind) + "-images.zip");
    } catch (error) {
      busyByCourse[courseId] = "";
      rerender();
      if (typeof gdToast === "function") gdToast("Could not build the zip: " + (error && error.message || error));
      return false;
    }
    busyByCourse[courseId] = "";
    rerender();
    return false;
  }

  /* ------------------------------------------------------------------ markup */

  function setKind(courseId, kind) {
    kindByCourse[String(courseId || "")] = kind === "captures" ? "captures" : "frames";
    rerender();
    return false;
  }

  function markup(selected) {
    var courseId = String(selected && selected.id || "");
    if (!courseId) return '<div class="gdCoursePlayDebugEmpty">No course selected.</div>';
    var kind = kindFor(courseId);
    var entry = indexes[cacheKey(courseId, kind)] || { state: "loading" };
    var busy = busyByCourse[courseId] || "";
    var id = typeof gdAdminJsArg === "function" ? gdAdminJsArg(courseId) : JSON.stringify(courseId);

    var tabs = '<div class="gdAdminSnapKinds">'
      + '<button type="button" class="' + (kind === "frames" ? "active" : "") + '" onclick="return gdAdminCourseSnapshotsSetKind(' + id + ',\'frames\')">Baked frames</button>'
      + '<button type="button" class="' + (kind === "captures" ? "active" : "") + '" onclick="return gdAdminCourseSnapshotsSetKind(' + id + ',\'captures\')">Raw captures</button>'
      + '</div>';

    var body;
    if (entry.state === "loading") body = '<div class="gdCoursePlayDebugEmpty">Reading the bucket…</div>';
    else if (entry.state === "error") body = '<div class="gdCoursePlayDebugEmpty">Could not read the image index: ' + esc(entry.error) + '</div>';
    else if (entry.state === "empty") {
      body = '<div class="gdCoursePlayDebugEmpty">'
        + (kind === "frames"
          ? "No baked frames for this course yet — it has not been through a visual bake."
          : "No captures stored for this course yet — it has not been scanned.")
        + '</div>';
    } else {
      body = '<div class="gdAdminSnapGrid">' + entry.items.map(function (item) {
        return '<figure class="gdAdminSnapTile">'
          + '<a href="' + esc(assetUrl(item.path)) + '" target="_blank" rel="noopener">'
          + '<img loading="lazy" decoding="async" src="' + esc(assetUrl(item.path)) + '" alt="' + esc(item.label) + '">'
          + '</a>'
          + '<figcaption><b>' + esc(item.label) + '</b>'
          + '<span>' + esc((item.width || "?") + "×" + (item.height || "?")) + '</span></figcaption>'
          + '</figure>';
      }).join("") + '</div>';
    }

    var ready = entry.state === "ready";
    var count = ready ? entry.items.length : 0;
    var actions = '<div class="gdAdminCourseVisualActions">'
      + '<button type="button" ' + (ready && !busy ? "" : "disabled") + ' onclick="return gdAdminCourseSnapshotsSheet(' + id + ')">Download contact sheet</button>'
      + '<button type="button" ' + (ready && !busy ? "" : "disabled") + ' onclick="return gdAdminCourseSnapshotsZip(' + id + ')">Download all (' + count + ' images, .zip)</button>'
      + (busy ? '<span class="gdAdminSnapBusy">' + esc(busy) + '</span>' : "")
      + '</div>';

    var version = versionLabel(courseId);
    var caption = kind === "frames"
      ? "One image per hole, plus the course overview — the pictures GPS Play draws."
      : "The ingredients a bake composites: corridor segments, green surrounds, backdrop and terrain. Shown at export resolution, not the full-size master.";

    return '<div class="gdAdminSnapPanel">'
      + '<div class="gdAdminCourseActionHead"><div><h4>Snapshots' + (version ? ' <span class="gdAdminCourseVersion">' + esc(version) + '</span>' : "") + '</h4>'
      + '<span>' + esc(caption) + '</span></div>' + actions + '</div>'
      + tabs + body + '</div>';
  }

  function afterRender(selected) {
    var courseId = String(selected && selected.id || "");
    if (!courseId) return;
    loadIndex(courseId, kindFor(courseId));
  }

  window.gdAdminCourseSnapshotsMarkup = markup;
  window.gdAdminCourseSnapshotsAfterRender = afterRender;
  window.gdAdminCourseSnapshotsSetKind = setKind;
  window.gdAdminCourseSnapshotsSheet = downloadSheet;
  window.gdAdminCourseSnapshotsZip = downloadZip;
  /* Exposed for dev/course-snapshots.test.js, which runs the zip writer and the layout
     maths under node without a DOM. */
  window.__gdAdminCourseSnapshotsInternals = {
    normalizeFrames: normalizeFrames,
    normalizeCaptures: normalizeCaptures,
    sortItems: sortItems,
    sheetLayout: sheetLayout,
    memberName: memberName,
    crc32: crc32,
    zipStore: zipStore
  };
})();

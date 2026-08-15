/* Clarity Studio - Bubble Geometry. Studio-only.
 *
 * The authoritative place to see, tune and publish the Bubble Micro-Geometry
 * model. Unlike the Practice Data page next door, this is a real workspace
 * rather than a jump-in, because no app screen shows any of it: a player sees
 * their bubble, not the reasoning that shaped it.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS THE REAL PIPELINE
 *
 * Nothing here re-implements detection or geometry. Every number on the page
 * comes out of scripts/gd-bubble-signals-core.js - the same file
 * functions/bubble-model.js requires server-side - and the Base bubble is
 * drawn from the live engine's own getGDBForClub()/bubbleRadiusFactor(), not
 * from a drawing that resembles it. "Verify on server" then POSTs the same
 * rows to /api/bubble-model and diffs the two results, so a claim that the
 * page and the server agree is checked rather than asserted.
 *
 * Data can come from three places, all of which land in the same engine:
 *   - a pre-loaded scenario (section 9)
 *   - a custom generated set (sections 7 and 8)
 *   - the player's real Shot Library session(s)
 *
 * ---------------------------------------------------------------------------
 * EXAGGERATION IS A MAGNIFYING GLASS, NOT A SETTING
 *
 * Production deformation is a fraction of a percent and is meant to be. The
 * 1x/5x/10x control exists so a human can see whether the shape moved the way
 * the region table says, and it is deliberately not part of the published
 * config: it drives this page's drawing, and the dev-panel field it mirrors
 * (bubbleGeometry.microExaggeration) is stripped from the phone build.
 */
(function () {
  "use strict";

  var STYLE_ID = "gdStudioBubbleGeometryStyle";
  var DRAFT_KEY = "gd_studio_bubble_geometry_draft_v1";

  function core() { return window.GDBubbleSignalsCore || null; }
  function generator() { return window.GDBubbleSignalTestData || null; }

  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function pct(value) {
    var n = (Number(value) - 1) * 100;
    if (!Number.isFinite(n)) return "0.00%";
    return (n >= 0 ? "+" : "") + n.toFixed(3) + "%";
  }

  /* ------------------------------------------------------------------
     Styles - scoped to this page's root so nothing leaks into the shell
     ------------------------------------------------------------------ */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".gdBgRoot{display:flex;flex-direction:column;gap:16px;max-width:1180px}",
      ".gdBgRow{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}",
      ".gdBgPanel{background:var(--gdStudioPanel);border:1px solid var(--gdStudioBorder);border-radius:10px;padding:14px 16px;flex:1 1 320px;min-width:300px}",
      ".gdBgPanel h3{margin:0 0 10px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--gdStudioAccent)}",
      ".gdBgPanel h4{margin:12px 0 6px;font-size:12.5px;color:var(--gdStudioText)}",
      ".gdBgNote{font-size:12px;color:var(--gdStudioMuted);margin:6px 0 0;line-height:1.5}",
      ".gdBgControls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
      ".gdBgControls label{font-size:12px;color:var(--gdStudioMuted);display:flex;gap:6px;align-items:center}",
      ".gdBgRoot select,.gdBgRoot input[type=number],.gdBgRoot input[type=text]{background:var(--gdStudioPanelAlt);color:var(--gdStudioText);border:1px solid var(--gdStudioBorder);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px}",
      ".gdBgRoot input[type=number]{width:78px}",
      ".gdBgBtn{background:var(--gdStudioPanelAlt);color:var(--gdStudioText);border:1px solid var(--gdStudioBorder);border-radius:6px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}",
      ".gdBgBtn:hover:not(:disabled){color:var(--gdStudioAccent);border-color:var(--gdStudioAccentDim)}",
      ".gdBgBtn:disabled{opacity:.4;cursor:default}",
      ".gdBgBtn.isPrimary{border-color:var(--gdStudioAccentDim);color:var(--gdStudioAccent)}",
      ".gdBgBtn.isOn{background:rgba(60,255,141,.14);color:var(--gdStudioAccent);border-color:var(--gdStudioAccentDim)}",
      ".gdBgTable{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}",
      ".gdBgTable th{text-align:left;color:var(--gdStudioMuted);font-weight:600;padding:4px 6px;border-bottom:1px solid var(--gdStudioBorder)}",
      ".gdBgTable td{padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.04)}",
      ".gdBgTable td.num{text-align:right;font-variant-numeric:tabular-nums}",
      ".gdBgPos{color:var(--gdStudioAccent)}.gdBgNeg{color:var(--gdStudioWarn)}.gdBgZero{color:var(--gdStudioMuted)}",
      ".gdBgSignal{border:1px solid var(--gdStudioBorder);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--gdStudioPanelAlt)}",
      ".gdBgSignal.isFired{border-color:var(--gdStudioAccentDim)}",
      ".gdBgSignalHead{display:flex;justify-content:space-between;align-items:baseline;gap:10px}",
      ".gdBgSignalName{font-weight:700;font-size:13px}",
      ".gdBgSignalState{font-size:11px;text-transform:uppercase;letter-spacing:.05em}",
      ".gdBgEvidence{list-style:none;margin:8px 0 0;padding:0;font-size:12px}",
      ".gdBgEvidence li{display:flex;gap:8px;padding:2px 0;color:var(--gdStudioMuted)}",
      ".gdBgEvidence li .mark{width:1.1em;flex:none}",
      ".gdBgEvidence li.isOk{color:var(--gdStudioText)}",
      ".gdBgMeter{height:5px;border-radius:3px;background:rgba(255,255,255,.07);margin-top:7px;overflow:hidden}",
      ".gdBgMeter span{display:block;height:100%;background:var(--gdStudioAccentDim)}",
      /* the class the shared drawer stamps on its <svg> */
      ".gdBubbleGeometryView{width:100%;height:auto;background:var(--gdStudioPanelAlt);border:1px solid var(--gdStudioBorder);border-radius:8px;display:block}",
      ".gdBgLegend{display:flex;gap:14px;font-size:11.5px;color:var(--gdStudioMuted);margin-top:8px;flex-wrap:wrap}",
      ".gdBgLegend i{display:inline-block;width:14px;height:0;border-top-width:2px;border-top-style:solid;margin-right:5px;vertical-align:middle}",
      ".gdBgProjection{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}",
      ".gdBgProjection figure{margin:0;flex:1 1 150px;min-width:130px;text-align:center}",
      ".gdBgProjection figcaption{font-size:11.5px;color:var(--gdStudioMuted);margin-top:2px}",
      ".gdBgStatus{font-size:12px;color:var(--gdStudioMuted);min-height:1.4em}",
      ".gdBgStatus.isWarn{color:var(--gdStudioWarn)}",
      ".gdBgStatus.isGood{color:var(--gdStudioAccent)}",
      ".gdBgTune{display:grid;grid-template-columns:1fr auto auto;gap:6px 10px;align-items:center;font-size:12px;margin-top:8px}",
      ".gdBgTune .name{color:var(--gdStudioText)}",
      ".gdBgWarnBox{border:1px solid var(--gdStudioWarn);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--gdStudioWarn);line-height:1.5}"
    ].join("\n");
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------
     Drawing

     The ring comes from scripts/gd-bubble-geometry-view.js, which Practice's
     Projected Clubs view also draws through. A bubble that looks one way in
     Studio and another way in Practice would be confidently wrong, so there is
     one drawing implementation rather than two that agree today.
     ------------------------------------------------------------------ */

  function drawer() { return window.GDBubbleGeometryView || null; }

  function basePayload(club, carryM) {
    var api = drawer();
    if (api) return api.basePayload(club, carryM);
    return { lateralRadiusM: Math.max(6, carryM * 0.075), depthRadiusM: Math.max(8, carryM * 0.105), visual: {}, synthetic: true };
  }

  function bubbleSvg(payload, geometry, exaggeration, options) {
    var api = drawer();
    if (!api) return '<p class="gdBgNote">scripts/gd-bubble-geometry-view.js is not loaded.</p>';
    options = options || {};
    return api.bubbleSvg(payload, geometry, {
      width: options.width || 340,
      height: options.height || 300,
      exaggeration: exaggeration,
      ariaLabel: "Base and adjusted bubble"
    });
  }

  /* ------------------------------------------------------------------
     Page
     ------------------------------------------------------------------ */

  function render(containerEl) {
    ensureStyle();
    var api = core();
    var gen = generator();

    if (!api) {
      containerEl.innerHTML = '<div class="gdBgWarnBox">scripts/gd-bubble-signals-core.js is not loaded on this build, '
        + "so there is nothing authoritative to show. Bubble Geometry deliberately does not fall back to its own copy of "
        + "the model - one implementation is the whole point of moving it out of the phone.</div>";
      return;
    }

    var state = {
      rows: [],
      sourceLabel: "nothing loaded",
      seed: null,
      config: loadDraft(api),
      detected: [],
      geometry: api.identityGeometry(),
      model: null,
      club: null,
      exaggeration: 1,
      status: "",
      statusTone: ""
    };

    containerEl.innerHTML = "";
    var root = document.createElement("div");
    root.className = "gdBgRoot";
    containerEl.appendChild(root);

    function loadDraft(coreApi) {
      var stored = safe(function () { return JSON.parse(window.localStorage.getItem(DRAFT_KEY) || "null"); }, null);
      return coreApi.resolveConfig(stored);
    }

    function saveDraft() {
      safe(function () { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(state.config)); });
    }

    function setStatus(message, tone) {
      state.status = message || "";
      state.statusTone = tone || "";
      var el = root.querySelector("#gdBgStatus");
      if (el) {
        el.textContent = state.status;
        el.className = "gdBgStatus" + (tone ? " is" + tone : "");
      }
    }

    /* Detection is run locally by the same core the server runs. This is not a
       shortcut around the server - it is the point of the file being shared. */
    function analyse() {
      state.detected = api.detectSignals(state.rows, state.config);
      state.geometry = api.buildMicroGeometry(state.detected, state.config);
      state.model = api.buildPlayerModel({
        rows: state.rows,
        config: state.config,
        offsetDeg: savedOffsetDeg(),
        handedness: "right",
        generatedAt: new Date().toISOString()
      });
      if (!state.club) {
        /* Default to a middle club: the progression is easiest to read from
           somewhere in the middle of the bag, not from a wedge. */
        var clubs = state.model.projection.representativeClubs;
        state.club = clubs.length ? clubs[Math.min(2, clubs.length - 1)].club : null;
      }
      drawResults();
    }

    function savedOffsetDeg() {
      var myBubble = window.ClarityApp && window.ClarityApp.myBubble;
      var saved = myBubble && typeof myBubble.current === "function"
        ? safe(function () { return myBubble.current(); }, null)
        : null;
      return saved && Number.isFinite(Number(saved.offsetDeg)) ? Number(saved.offsetDeg) : 0;
    }

    function carryForClub(club) {
      var projection = state.model && state.model.projection;
      var found = projection ? projection.clubs.filter(function (entry) { return entry.club === club; })[0] : null;
      return found ? found.carryM : (projection && projection.referenceCarryM) || 150;
    }

    /* ---------------- sections ---------------- */

    function sourceSectionHtml() {
      var scenarios = gen ? gen.SCENARIOS : [];
      var providers = gen ? gen.PROVIDER_KEYS : [];
      var relationships = gen ? Object.keys(gen.RELATIONSHIPS) : [];
      return '<div class="gdBgPanel" style="flex:1 1 100%">'
        + "<h3>Test data</h3>"
        + '<div class="gdBgControls">'
        + '<label>Scenario <select id="gdBgScenario">'
        + scenarios.map(function (item) { return '<option value="' + esc(item.id) + '">' + esc(item.label) + "</option>"; }).join("")
        + "</select></label>"
        + '<button type="button" class="gdBgBtn isPrimary" id="gdBgLoadScenario">Load scenario</button>'
        + '<button type="button" class="gdBgBtn" id="gdBgLoadLibrary">Load my Shot Library</button>'
        + "</div>"
        + "<h4>Custom set</h4>"
        + '<div class="gdBgControls">'
        + '<label>Provider <select id="gdBgProvider">'
        + providers.map(function (key) {
          return '<option value="' + esc(key) + '">' + esc(gen.PROVIDER_EMIT[key].label) + "</option>";
        }).join("")
        + "</select></label>"
        + '<label>Relationship <select id="gdBgRelationship">'
        + relationships.map(function (key) {
          return '<option value="' + esc(key) + '">' + esc(gen.RELATIONSHIPS[key].label) + "</option>";
        }).join("")
        + "</select></label>"
        + '<label>Strength <select id="gdBgStrength"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></label>'
        + '<label>Direction <select id="gdBgDirection"><option value="1">Right / more</option><option value="-1">Left / less</option></select></label>'
        + '<label>Shots <input type="number" id="gdBgShots" value="30" min="1" max="500"></label>'
        + '<label>Clubs <input type="number" id="gdBgClubs" value="5" min="1" max="9"></label>'
        + '<label>Seed <input type="number" id="gdBgSeed" placeholder="random"></label>'
        + '<button type="button" class="gdBgBtn" id="gdBgGenerate">Generate</button>'
        + "</div>"
        + '<p class="gdBgNote" id="gdBgSourceNote"></p>'
        + '<p class="gdBgStatus" id="gdBgStatus"></p>'
        + "</div>";
    }

    function signalsSectionHtml() {
      if (!state.detected.length) {
        return '<div class="gdBgPanel"><h3>Detected Signals</h3><p class="gdBgNote">Load or generate a set to run the detector.</p></div>';
      }
      var fired = state.detected.filter(function (record) { return record.fired; });
      var body = state.detected.map(function (record) {
        var state_ = record.fired ? "fired" : (record.enabled ? "not fired" : "disabled");
        return '<div class="gdBgSignal' + (record.fired ? " isFired" : "") + '">'
          + '<div class="gdBgSignalHead"><span class="gdBgSignalName">' + esc(record.label) + "</span>"
          + '<span class="gdBgSignalState ' + (record.fired ? "gdBgPos" : "gdBgZero") + '">' + esc(state_) + "</span></div>"
          + '<div class="gdBgNote">Evidence strength ' + record.evidenceStrength.toFixed(3)
          + (record.effectiveThreshold ? " (needs " + record.effectiveThreshold.toFixed(3) + ")" : "")
          + (record.route ? " &middot; via " + esc(record.routeLabel) : "")
          + (record.requiredShots ? " &middot; " + record.sampleShots + "/" + record.requiredShots + " shots" : "")
          + (record.fired ? "" : " &middot; " + esc(record.reason || "no evidence"))
          + "</div>"
          + '<div class="gdBgMeter"><span style="width:' + Math.round(record.evidenceStrength * 100) + '%"></span></div>'
          + (record.evidence.length
            ? '<ul class="gdBgEvidence">' + record.evidence.map(function (item) {
              return '<li class="' + (item.ok ? "isOk" : "") + '"><span class="mark">' + (item.ok ? "&#10003;" : "&mdash;")
                + "</span><span>" + esc(item.label) + " &middot; " + esc(item.detail) + "</span></li>";
            }).join("") + "</ul>"
            : "")
          + (record.fired && record.appliesToClubs.length
            ? '<div class="gdBgNote">Applies to: ' + esc(record.appliesToClubs.join(" → ")) + "</div>"
            : "")
          + (record.fired
            ? '<div class="gdBgNote">Effect: ' + core().REGIONS.filter(function (name) { return record.effect[name]; })
              .map(function (name) {
                var value = record.effect[name];
                return core().REGION_LABELS[name] + " " + (value >= 0 ? "+" : "") + value.toFixed(3) + "%";
              }).join(", ") + (record.axisAdjustmentDeg ? " &middot; axis " + record.axisAdjustmentDeg.toFixed(3) + "&deg;" : "") + "</div>"
            : "")
          + "</div>";
      }).join("");
      return '<div class="gdBgPanel"><h3>Detected Signals</h3>'
        + '<p class="gdBgNote">' + fired.length + " of " + state.detected.length + " firing on "
        + esc(state.sourceLabel) + ".</p>" + body + "</div>";
    }

    function geometrySectionHtml() {
      var api2 = core();
      var identity = api2.isIdentityGeometry(state.geometry);
      var rows = api2.REGIONS.map(function (name) {
        var value = state.geometry[name];
        var klass = value > 1 ? "gdBgPos" : value < 1 ? "gdBgNeg" : "gdBgZero";
        return "<tr><td>" + esc(api2.REGION_LABELS[name]) + '</td><td class="num ' + klass + '">' + pct(value) + "</td>"
          + '<td class="num ' + klass + '">' + pct(1 + (value - 1) * state.exaggeration) + "</td></tr>";
      }).join("");
      return '<div class="gdBgPanel"><h3>Region deformation</h3>'
        + (identity
          ? '<p class="gdBgNote"><strong>Identity.</strong> Base and Adjusted are the same bubble - '
            + "every region 1.0, axis 0. This is what the phone renders today.</p>"
          : "")
        + '<table class="gdBgTable"><thead><tr><th>Region</th><th class="num">Production</th><th class="num">At '
        + state.exaggeration + "&times;</th></tr></thead><tbody>" + rows + "</tbody></table>"
        + '<p class="gdBgNote">Axis correction: ' + Number(state.geometry.axisAdjustmentDeg || 0).toFixed(3)
        + "&deg; (capped at &plusmn;0.5&deg;, and only Curvature Bias may ask).</p>"
        + "</div>";
    }

    function bubbleSectionHtml() {
      var club = state.club;
      if (!club) return '<div class="gdBgPanel"><h3>Base vs Adjusted</h3><p class="gdBgNote">No club data yet.</p></div>';
      var carry = carryForClub(club);
      var payload = basePayload(club, carry);
      var clubs = state.model ? state.model.projection.clubs : [];
      return '<div class="gdBgPanel" style="flex:1 1 380px"><h3>Base vs Adjusted</h3>'
        + '<div class="gdBgControls">'
        + '<label>Club <select id="gdBgClub">'
        + clubs.map(function (entry) {
          return '<option value="' + esc(entry.club) + '"' + (entry.club === club ? " selected" : "") + ">"
            + esc(entry.club) + " &middot; " + Math.round(entry.carryM) + "m</option>";
        }).join("")
        + "</select></label>"
        + "<span>Exaggeration</span>"
        + [1, 5, 10].map(function (value) {
          return '<button type="button" class="gdBgBtn gdBgExag' + (state.exaggeration === value ? " isOn" : "")
            + '" data-exag="' + value + '">' + value + "&times;</button>";
        }).join("")
        + "</div>"
        + bubbleSvg(payload, state.geometry, state.exaggeration)
        + '<div class="gdBgLegend">'
        + '<span><i style="border-top-color:#8fa79c;border-top-style:dashed"></i>Base bubble</span>'
        + '<span><i style="border-top-color:#3cff8d"></i>Adjusted bubble</span>'
        + "</div>"
        + '<p class="gdBgNote">'
        + (payload.synthetic
          ? "Drawn from the club ratios: the live engine's getGDBForClub() was not reachable on this page, so this is a stand-in shape, not the bubble that renders."
          : "Drawn from the live engine's own payload for this club - the same call GPS Play makes.")
        + " Down the line: the shot travels up the drawing, a right miss is on the right.</p>"
        + "</div>";
    }

    function projectionSectionHtml() {
      if (!state.model) return "";
      var clubs = state.model.projection.representativeClubs;
      if (!clubs.length) return "";
      return '<div class="gdBgPanel" style="flex:1 1 100%"><h3>Projected club progression</h3>'
        + '<p class="gdBgNote">The same player model expressed at different points through the bag. These are '
        + "projections of one model, not separate bubbles built from each club's own shots - a projected 5i exists "
        + "whether or not a 5i was hit.</p>"
        + '<div class="gdBgProjection">'
        + clubs.map(function (entry) {
          var payload = basePayload(entry.club, entry.carryM);
          return "<figure>" + bubbleSvg(payload, state.geometry, state.exaggeration, { width: 170, height: 170 })
            + "<figcaption>" + esc(entry.club) + " &middot; " + Math.round(entry.carryM) + "m</figcaption></figure>";
        }).join("")
        + "</div></div>";
    }

    function tuningSectionHtml() {
      var api2 = core();
      var signals = api2.SIGNAL_DEFINITIONS.map(function (definition) {
        var tuning = state.config.signals[definition.id] || {};
        return '<span class="name">' + esc(definition.label) + "</span>"
          + '<label><input type="checkbox" data-signal-enable="' + esc(definition.id) + '"' + (tuning.enabled ? " checked" : "") + "> on</label>"
          + '<label>threshold <input type="number" step="0.01" min="0" max="0.99" data-signal-threshold="'
          + esc(definition.id) + '" value="' + Number(tuning.evidenceThreshold).toFixed(2) + '"></label>';
      }).join("");
      return '<div class="gdBgPanel" style="flex:1 1 100%"><h3>Geometry settings</h3>'
        + '<div class="gdBgControls">'
        + '<label><input type="checkbox" id="gdBgEngineEnabled"' + (state.config.enabled ? " checked" : "")
        + "> Micro-Geometry engine enabled</label>"
        + '<label>Max region % <input type="number" step="0.1" min="0" max="10" id="gdBgCapRegion" value="'
        + Number(state.config.caps.maxRegionPct) + '"></label>'
        + '<label>Max axis &deg; <input type="number" step="0.05" min="0" max="2" id="gdBgCapAxis" value="'
        + Number(state.config.caps.maxAxisDeg) + '"></label>'
        + "</div>"
        + '<div class="gdBgTune">' + signals + "</div>"
        + '<p class="gdBgNote">Master switch off is the shipped state and forces identity geometry whatever the '
        + "individual Signals say. Publishing writes a new server-side config version - it does not need a phone "
        + "release, and it marks every stored player model stale so each one rebuilds on its next analysis.</p>"
        + '<div class="gdBgControls" style="margin-top:10px">'
        + '<button type="button" class="gdBgBtn" id="gdBgSaveDraft">Save draft</button>'
        + '<button type="button" class="gdBgBtn" id="gdBgResetDraft">Reset to shipped defaults</button>'
        + '<button type="button" class="gdBgBtn" id="gdBgVerifyServer">Verify on server</button>'
        + '<button type="button" class="gdBgBtn isPrimary" id="gdBgPublish">Publish geometry settings</button>'
        + '<button type="button" class="gdBgBtn" id="gdBgCompareSessions">Compare Practice Sessions</button>'
        + "</div></div>";
    }

    /* ---------------- draw + wire ----------------

       Three slots, redrawn independently.

       Everything used to live in one innerHTML that every change rebuilt,
       which meant ticking a Signal's checkbox destroyed that checkbox while
       the browser was still delivering its change event - so a loop that
       toggled several in a row silently applied only the first one, and any
       half-typed threshold lost its focus. The results are the only thing a
       tuning change needs to redraw, so they are the only thing it redraws. */

    function drawAll() {
      root.innerHTML =
        '<div class="gdBgRow" id="gdBgSourceSlot"></div>'
        + '<div id="gdBgResultsSlot"></div>'
        + '<div class="gdBgRow" id="gdBgTuningSlot"></div>';
      drawSource();
      drawResults();
      drawTuning();
      setStatus(state.status, state.statusTone);
    }

    function drawSource() {
      var slot = root.querySelector("#gdBgSourceSlot");
      if (!slot) return;
      slot.innerHTML = sourceSectionHtml();
      wireSource();
      refreshSourceNote();
      setStatus(state.status, state.statusTone);
    }

    function drawResults() {
      var slot = root.querySelector("#gdBgResultsSlot");
      if (!slot) return;
      slot.innerHTML =
        '<div class="gdBgRow">' + bubbleSectionHtml() + geometrySectionHtml() + "</div>"
        + '<div class="gdBgRow">' + projectionSectionHtml() + "</div>"
        + '<div class="gdBgRow">' + signalsSectionHtml() + "</div>";
      wireResults();
      refreshSourceNote();
    }

    function drawTuning() {
      var slot = root.querySelector("#gdBgTuningSlot");
      if (!slot) return;
      slot.innerHTML = tuningSectionHtml();
      wireTuning();
    }

    function refreshSourceNote() {
      var note = root.querySelector("#gdBgSourceNote");
      if (!note) return;
      note.textContent = state.rows.length
        ? state.rows.length + " shots from " + state.sourceLabel
          + (state.seed !== null ? " (seed " + state.seed + ")" : "")
          + (state.model ? " · " + state.model.projection.clubs.length + " clubs" : "")
        : "No data loaded. Pick a scenario, generate a custom set, or load a real Shot Library session.";
    }

    function on(selector, event, handler) {
      var el = root.querySelector(selector);
      if (el) el.addEventListener(event, handler);
    }

    function wireSource() {
      on("#gdBgLoadScenario", "click", function () {
        if (!gen) return setStatus("The test-data generator is not loaded on this build.", "Warn");
        var id = root.querySelector("#gdBgScenario").value;
        var result = gen.scenario(id);
        if (!result) return setStatus("Unknown scenario.", "Warn");
        adopt(result, "scenario “" + id + "”");
      });

      on("#gdBgGenerate", "click", function () {
        if (!gen) return setStatus("The test-data generator is not loaded on this build.", "Warn");
        var seedInput = root.querySelector("#gdBgSeed").value;
        var result = gen.generateAndVerify({
          provider: root.querySelector("#gdBgProvider").value,
          relationship: root.querySelector("#gdBgRelationship").value,
          strength: root.querySelector("#gdBgStrength").value,
          direction: Number(root.querySelector("#gdBgDirection").value),
          shots: Number(root.querySelector("#gdBgShots").value),
          clubs: Number(root.querySelector("#gdBgClubs").value),
          seed: seedInput === "" ? null : Number(seedInput)
        });
        adopt(result, "generated " + result.provider.label + " set");
      });

      on("#gdBgLoadLibrary", "click", function () {
        var lm = window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData;
        if (!lm || typeof lm.displayStore !== "function") {
          return setStatus("The Shot Library is not loaded on this page.", "Warn");
        }
        var store = safe(function () { return lm.displayStore(); }, null) || {};
        var shots = Array.isArray(store.shots) ? store.shots : [];
        if (!shots.length) return setStatus("No shots in the Shot Library for the signed-in player.", "Warn");
        state.rows = shots;
        state.seed = null;
        state.sourceLabel = "the signed-in player's Shot Library";
        state.club = null;
        setStatus("", "");
        analyse();
      });
    }

    function wireResults() {
      on("#gdBgClub", "change", function (event) {
        state.club = event.target.value;
        drawResults();
      });

      Array.prototype.forEach.call(root.querySelectorAll(".gdBgExag"), function (button) {
        button.addEventListener("click", function () {
          state.exaggeration = Number(button.getAttribute("data-exag")) || 1;
          drawResults();
        });
      });
    }

    function wireTuning() {
      on("#gdBgEngineEnabled", "change", function (event) {
        state.config.enabled = !!event.target.checked;
        analyse();
      });
      on("#gdBgCapRegion", "change", function (event) {
        state.config.caps.maxRegionPct = Number(event.target.value) || 0;
        analyse();
      });
      on("#gdBgCapAxis", "change", function (event) {
        state.config.caps.maxAxisDeg = Number(event.target.value) || 0;
        analyse();
      });

      Array.prototype.forEach.call(root.querySelectorAll("[data-signal-enable]"), function (input) {
        input.addEventListener("change", function () {
          var id = input.getAttribute("data-signal-enable");
          state.config.signals[id].enabled = !!input.checked;
          analyse();
        });
      });
      Array.prototype.forEach.call(root.querySelectorAll("[data-signal-threshold]"), function (input) {
        input.addEventListener("change", function () {
          var id = input.getAttribute("data-signal-threshold");
          state.config.signals[id].evidenceThreshold = Number(input.value) || 0;
          analyse();
        });
      });

      on("#gdBgSaveDraft", "click", function () {
        saveDraft();
        setStatus("Draft saved to this browser. It is not live for anyone until it is published.", "Good");
      });
      on("#gdBgResetDraft", "click", function () {
        state.config = core().defaultConfig();
        saveDraft();
        analyse();
        /* The only tuning change that must redraw its own panel: the control
           values themselves all changed. */
        drawTuning();
        setStatus("Reset to shipped defaults - every Signal off.", "Good");
      });
      on("#gdBgVerifyServer", "click", verifyOnServer);
      on("#gdBgPublish", "click", publish);
      on("#gdBgCompareSessions", "click", function () {
        if (typeof window.gdOpenPracticeSessionComparison === "function") {
          window.gdOpenPracticeSessionComparison();
          return;
        }
        setStatus("Session comparison is not available on this build.", "Warn");
      });
    }

    function adopt(result, label) {
      state.rows = result.rows;
      state.seed = result.seed;
      state.sourceLabel = label;
      state.club = null;
      var detection = result.detection;
      var eligibility = result.eligibility;
      if (eligibility && !eligibility.eligible) {
        setStatus("Warning: " + eligibility.failureCount + " generated row(s) fall outside the Bubble's own eligibility window.", "Warn");
      } else if (detection && detection.target && !detection.targetFired) {
        setStatus("The planted " + detection.target + " relationship is NOT detectable at this size and strength - "
          + "the engine says " + (detection.targetRecord ? detection.targetRecord.reason : "no record") + ".", "Warn");
      } else if (detection && detection.controlClean === true) {
        setStatus("Control set: no Signal fires, so Base and Adjusted must be identical.", "Good");
      } else {
        setStatus("", "");
      }
      analyse();
    }

    /* The page and the server share one file. This proves it rather than
       trusting it: same rows, same config, and the geometry has to match. */
    async function verifyOnServer() {
      if (!state.rows.length) return setStatus("Load a set first.", "Warn");
      setStatus("Asking the server…", "");
      try {
        var headers = { "Content-Type": "application/json" };
        var auth = window.ClaritySupabaseAuth;
        if (auth && typeof auth.freshAccessToken === "function") {
          var token = await auth.freshAccessToken().catch(function () { return ""; });
          if (token) headers.Authorization = "Bearer " + token;
        }
        var response = await fetch("/api/bubble-model", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({ action: "preview", rows: state.rows, config: state.config, offsetDeg: savedOffsetDeg() })
        });
        var body = await response.json().catch(function () { return {}; });
        if (!response.ok) return setStatus("Server said: " + (body.error || response.status), "Warn");
        var serverGeometry = body.model && body.model.geometry;
        var same = JSON.stringify(serverGeometry) === JSON.stringify(state.geometry);
        setStatus(same
          ? "Server agrees: identical geometry from the same rows and config."
          : "MISMATCH - the server produced different geometry. Server: " + JSON.stringify(serverGeometry),
          same ? "Good" : "Warn");
      } catch (error) {
        setStatus("Could not reach /api/bubble-model: " + (error && error.message), "Warn");
      }
    }

    async function publish() {
      var enabledSignals = Object.keys(state.config.signals)
        .filter(function (id) { return state.config.signals[id].enabled; });
      var summary = state.config.enabled
        ? (enabledSignals.length ? enabledSignals.join(", ") : "no Signals enabled")
        : "engine OFF (identity geometry)";
      if (!window.confirm(
        "Publish a new geometry config version?\n\n" + summary
        + "\n\nEvery player's stored model is marked stale and rebuilds on its next analysis. "
        + "This takes effect without a phone release."
      )) return;

      setStatus("Publishing…", "");
      try {
        var headers = { "Content-Type": "application/json" };
        var auth = window.ClaritySupabaseAuth;
        if (auth && typeof auth.freshAccessToken === "function") {
          var token = await auth.freshAccessToken().catch(function () { return ""; });
          if (token) headers.Authorization = "Bearer " + token;
        }
        var response = await fetch("/api/bubble-model", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            action: "publish",
            config: state.config,
            label: summary,
            note: "Published from Studio Bubble Geometry."
          })
        });
        var body = await response.json().catch(function () { return {}; });
        if (!response.ok) return setStatus("Publish refused: " + (body.error || response.status), "Warn");
        setStatus("Published as config version " + body.version + ".", "Good");
      } catch (error) {
        setStatus("Could not reach /api/bubble-model: " + (error && error.message), "Warn");
      }
    }

    drawAll();
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["bubble-geometry"] = render;
})();

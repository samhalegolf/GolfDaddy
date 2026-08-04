/* Clarity Studio ownership registry — data only, no rendering.
 * Studio-only. Consumed by studio-shell.js (nav) and studio-info-view.js (Info tab + wiring diagram).
 * Entries with needsVerification:true have not had their code ownership confirmed by reading source —
 * do not present them as authoritative; studio-info-view.js must visibly flag them. */
(function () {
  "use strict";

  var REGISTRY = [
    // ---- Top-level nav ----
    {
      id: "overview", label: "Overview", parent: null,
      function: "Landing page for Clarity Studio — orientation, environment/source status, and quick links into each owned system.",
      owner: "Studio shell", runtime: { app: false, studio: true, server: false },
      code: [{ role: "Shell", path: "scripts/studio/overview/overview-page.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "implemented", needsVerification: false
    },
    {
      id: "courses", label: "Courses", parent: null,
      function: "Groups the four systems that discover, store, visualize, and publish course data. Not itself a workspace.",
      owner: "n/a (nav grouping only)", runtime: { app: false, studio: true, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "group", needsVerification: false
    },
    {
      id: "shot-system", label: "Shot System", parent: null,
      function: "Groups practice-data ingestion, pattern analysis, and shot-shape systems used to build a player's bubble and recommendations.",
      owner: "n/a (nav grouping only)", runtime: { app: false, studio: true, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "group", needsVerification: false
    },
    {
      id: "gps-play", label: "GPS Play", parent: null,
      function: "Groups the on-course round/hole state machine, map & camera, shot planning/capture, and scorecard systems.",
      owner: "n/a (nav grouping only)", runtime: { app: false, studio: true, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "group", needsVerification: false
    },
    {
      id: "players-coaches", label: "Players & Coaches", parent: null,
      function: "Not yet moved into Studio. Player settings and profile hydration are handled by scripts/clarity-player-settings.js and scripts/clarity-profile-hydrate.js; no dedicated coach-facing module was found in this branch's recon.",
      owner: "Needs verification", runtime: { app: true, studio: false, server: false },
      code: [
        { role: "Player settings (app-facing, unconfirmed scope)", path: "scripts/clarity-player-settings.js" },
        { role: "Profile hydration (app-facing, unconfirmed scope)", path: "scripts/clarity-profile-hydrate.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "placeholder", needsVerification: true
    },
    {
      id: "commerce", label: "Commerce", parent: null,
      function: "Not yet moved into Studio. In-app purchase/subscription flow and checkout/billing-portal integration were located by filename but not read in depth this branch.",
      owner: "Needs verification", runtime: { app: true, studio: false, server: false },
      code: [
        { role: "Store billing client (unconfirmed scope)", path: "scripts/clarity-store-billing.js" },
        { role: "Checkout / billing portal (unconfirmed scope)", path: "scripts/clarity-payments.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "placeholder", needsVerification: true
    },
    {
      id: "communications", label: "Communications", parent: null,
      function: "Not yet moved into Studio. Notification preferences/events were located by filename but not read in depth this branch.",
      owner: "Needs verification", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Email/notification events (unconfirmed scope)", path: "scripts/clarity-email.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "placeholder", needsVerification: true
    },
    {
      id: "system", label: "System", parent: null,
      function: "Groups cross-cutting infrastructure: external integrations, local/cloud storage, diagnostics, and feature controls.",
      owner: "n/a (nav grouping only)", runtime: { app: false, studio: true, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [], keyFunctions: [],
      status: "group", needsVerification: false
    },

    // ---- Courses: Database / Mapping / Visuals / Publishing / Diagnostics ----
    {
      id: "course-database", label: "Course Database", parent: "courses",
      function: "Stores the accepted and authoritative course record: identity, names/aliases, location, scorecard, accepted tee/green/fairway/route geometry, versions, saved source metadata, and database activity. Does not own the tools used to discover or repair that data.",
      owner: "Course Database Controller (scripts/studio/gd-admin-course-db.js)",
      runtime: { app: false, studio: true, server: false },
      code: [
        { role: "Primary owner (unmoved this branch — see doesNotOwn/warnings)", path: "scripts/studio/gd-admin-course-db.js" },
        { role: "Studio page wrapper", path: "scripts/studio/courses/course-database/course-database-page.js" },
        { role: "Location resolution owner (consumed, not owned)", path: "scripts/gd-course-location.js" }
      ],
      inputs: ["Accepted mapping draft (from Course Mapping)", "/api/course-maps (Supabase-backed)"],
      outputs: ["Course records read by Course Visuals and Publishing", "Deleted/updated course records via /api/course-maps"],
      owns: ["Course identity, location, scorecard", "Accepted geometry", "Course versions", "Database activity log"],
      doesNotOwn: ["Discovery/repair tooling (owned by Course Mapping)", "Visual assets (owned by Course Visuals)", "Release/publish state (owned by Publishing)"],
      connections: [
        { target: "course-mapping", direction: "reads-from", label: "Accepted mapping draft" },
        { target: "course-visuals", direction: "read-by", label: "Accepted course record + geometry" },
        { target: "publishing", direction: "read-by", label: "Course record promoted to release" }
      ],
      keyFunctions: [
        { name: "gdRenderAdminCourseDatabase", purpose: "Top-level render orchestrator for the whole Database workspace.", codePath: "scripts/studio/gd-admin-course-db.js" },
        { name: "gdAdminCourseDbDelete", purpose: "Admin delete of a published course.", codePath: "scripts/studio/gd-admin-course-db.js" },
        { name: "gdAdminCourseDbUpdate", purpose: "Update course admin metadata.", codePath: "scripts/studio/gd-admin-course-db.js" }
      ],
      status: "implemented", needsVerification: false
    },
    {
      id: "course-mapping", label: "Course Mapping", parent: "courses",
      function: "Discovers, labels, validates and repairs course data before it is accepted into the Course Database. v1 groups its subsections into one Mapping Workspace (see nested records below); the workspace embeds the existing Mapping Diagnostics panel and re-uses the Course Database's location-edit tooling, since that code physically lives in gd-admin-course-db.js and is pinned there by dev/course-location-behavior.test.js.",
      owner: "Course Mapping (composed from gd-course-mapping-debug.js + gd-course-library-pin-lock.js + gd-course-location.js)",
      runtime: { app: true, studio: true, server: false },
      code: [
        { role: "Studio Mapping Workspace (new, composition-only)", path: "scripts/studio/courses/course-mapping/course-mapping-page.js" },
        { role: "Mapping diagnostics (observational)", path: "scripts/gd-course-mapping-debug.js" },
        { role: "AutoMapper / on-device mapper (app-facing, do not move)", path: "scripts/gd-course-library-pin-lock.js" },
        { role: "Course-centre resolution owner", path: "scripts/gd-course-location.js" },
        { role: "Location edit/remove actions (physically in Course Database file, pinned by test)", path: "scripts/studio/gd-admin-course-db.js" }
      ],
      inputs: ["Course identity", "Course location", "OSM/Overpass objects", "Scorecard", "Manual corrections"],
      outputs: ["Mapping draft", "Mapping attempt evidence", "Validation results"],
      owns: ["Mapping drafts", "Mapping attempts", "Candidate geometry"],
      doesNotOwn: ["Accepted course records (Course Database)", "Course visuals", "GPS round state"],
      connections: [
        { target: "course-database", direction: "writes", label: "Accepted mapping draft" },
        { target: "mapping-diagnostics", direction: "events", label: "Attempt evidence" }
      ],
      keyFunctions: [
        { name: "GDCourseMappingDebug.renderAdminPanel", purpose: "Renders observational mapping-attempt diagnostics.", codePath: "scripts/gd-course-mapping-debug.js" },
        { name: "GDCourseLocation.resolve", purpose: "Resolves a course's authoritative centre point.", codePath: "scripts/gd-course-location.js" }
      ],
      status: "implemented", needsVerification: false
    },
    { id: "location-resolution", label: "Location Resolution", parent: "course-mapping",
      function: "Resolves and confirms a course's centre point from picker/GPS/manual sources; separates proposed from confirmed records.",
      owner: "scripts/gd-course-location.js (window.GDCourseLocation)", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Owner", path: "scripts/gd-course-location.js" }],
      inputs: ["Picker GPS proposal", "Manual pin"], outputs: ["Confirmed course centre"],
      owns: ["Course centre confirmation state"], doesNotOwn: ["Course geometry"],
      connections: [{ target: "course-mapping", direction: "child-of", label: "" }],
      keyFunctions: [{ name: "resolve", purpose: "Resolve centre point.", codePath: "scripts/gd-course-location.js" }],
      status: "documented-only", needsVerification: false },
    { id: "osm-scan", label: "OSM Scan", parent: "course-mapping",
      function: "Fetches and caches OpenStreetMap/Overpass course objects used as mapping candidates.",
      owner: "scripts/gd-course-library-pin-lock.js (mapperOsmGuideFetch/Memory)", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Owner", path: "scripts/gd-course-library-pin-lock.js" }],
      inputs: ["Course location"], outputs: ["OSM candidate objects"],
      owns: ["OSM fetch cache"], doesNotOwn: ["Accepted geometry"],
      connections: [{ target: "course-mapping", direction: "child-of", label: "" }],
      keyFunctions: [], status: "documented-only", needsVerification: false },
    { id: "geometry-resolution", label: "Geometry Resolution", parent: "course-mapping",
      function: "Resolves candidate hole/tee/green/fairway geometry from mapping inputs. Server-side AutoMapper and Native Geometry Resolver already own this per prior course-package migration work — see docs/reports/course-package-migration notes.",
      owner: "Needs verification (server-side per prior migration; not re-confirmed this branch)", runtime: { app: false, studio: false, server: true },
      code: [], inputs: ["OSM candidates", "Scorecard"], outputs: ["Candidate geometry"],
      owns: [], doesNotOwn: [],
      connections: [{ target: "course-mapping", direction: "child-of", label: "" }],
      keyFunctions: [], status: "documented-only", needsVerification: true },
    { id: "hole-labelling", label: "Hole Labelling", parent: "course-mapping",
      function: "Resolves which physical hole a captured record belongs to during mapping and play.",
      owner: "Needs verification", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Referenced by (unconfirmed as sole owner)", path: "scripts/gd-course-play-pipeline.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [],
      connections: [{ target: "course-mapping", direction: "child-of", label: "" }],
      keyFunctions: [], status: "documented-only", needsVerification: true },
    { id: "manual-mapping", label: "Manual Mapping", parent: "course-mapping",
      function: "Manual green/pin fallback and hand-corrected geometry when automated mapping cannot resolve a hole.",
      owner: "scripts/gd-app-core.js (gdGreenFocusScreenFallback) + scripts/gd-course-play-pipeline.js (interactiveGreenFallbackActive)",
      runtime: { app: true, studio: false, server: false },
      code: [
        { role: "Fallback UI (do not move — in-round, app-facing)", path: "scripts/gd-app-core.js" },
        { role: "Fallback state gate", path: "scripts/gd-course-play-pipeline.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [],
      connections: [{ target: "course-mapping", direction: "child-of", label: "" }],
      keyFunctions: [], status: "documented-only", needsVerification: false },
    { id: "validation", label: "Validation", parent: "course-mapping",
      function: "Checks a mapping draft's completeness/consistency before it is eligible for Course Database acceptance.",
      owner: "Needs verification", runtime: { app: false, studio: false, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [],
      connections: [{ target: "course-mapping", direction: "child-of", label: "" }],
      keyFunctions: [], status: "documented-only", needsVerification: true },
    { id: "mapping-attempts", label: "Mapping Attempts", parent: "course-mapping",
      function: "Records each mapping attempt (tool, input, result) as evidence, surfaced by Mapping Diagnostics.",
      owner: "scripts/gd-course-mapping-debug.js", runtime: { app: false, studio: true, server: false },
      code: [{ role: "Owner", path: "scripts/gd-course-mapping-debug.js" }],
      inputs: ["Mapping tool events"], outputs: ["Attempt evidence"],
      owns: ["Attempt history"], doesNotOwn: ["Choosing which mapping tool to run — observational only"],
      connections: [{ target: "mapping-diagnostics", direction: "writes", label: "" }, { target: "course-mapping", direction: "child-of", label: "" }],
      keyFunctions: [], status: "documented-only", needsVerification: false },

    {
      id: "course-visuals", label: "Course Visuals", parent: "courses",
      function: "Converts accepted course data and imagery into Clarity course visuals: source imagery, visual recipes, preview generation, frame inspection, terrain/presentation controls, generated assets, and visual review.",
      owner: "Course Visuals Controller (scripts/studio/gd-admin-course-db.js visuals bucket + scripts/gd-course-visual-engine.js)",
      runtime: { app: false, studio: true, server: false },
      code: [
        { role: "Preview/recipe/tuning UI (unmoved this branch)", path: "scripts/studio/gd-admin-course-db.js" },
        { role: "Studio page wrapper", path: "scripts/studio/courses/course-visuals/course-visuals-page.js" },
        { role: "Full authoring engine (Studio-only)", path: "scripts/gd-course-visual-engine.js" },
        { role: "Generated app-facing client (do not hand-edit)", path: "scripts/gd-course-visual-client.js" }
      ],
      inputs: ["Accepted course record + geometry (Course Database)", "Captured imagery"],
      outputs: ["Visual recipes", "Generated preview assets", "Cloud visual jobs"],
      owns: ["Visual recipes", "Preview/product assembly", "Local recipe library"],
      doesNotOwn: ["Accepted geometry", "Release/publish state"],
      connections: [
        { target: "course-database", direction: "reads-from", label: "Accepted geometry" },
        { target: "publishing", direction: "writes", label: "Build/job requests" }
      ],
      keyFunctions: [
        { name: "gdAdminCourseVisualControls", purpose: "Renders the full visual-tuning control panel.", codePath: "scripts/studio/gd-admin-course-db.js" },
        { name: "gdAdminCoursePreviewFrameFromObjects", purpose: "Computes preview frame geometry from captured objects.", codePath: "scripts/studio/gd-admin-course-db.js" }
      ],
      status: "implemented", needsVerification: false
    },
    {
      id: "publishing", label: "Publishing", parent: "courses",
      function: "Validates and promotes accepted course records and visual assets into the package consumed by production. v1 exposes only the real existing build/publish/reset/revert actions — no release-history system exists yet, so History/Draft-Changes tabs are honestly labelled as not yet available.",
      owner: "Publishing Controller (scripts/studio/gd-admin-course-db.js publish/job bucket)",
      runtime: { app: false, studio: true, server: false },
      code: [
        { role: "Build/publish/reset/revert actions (unmoved this branch)", path: "scripts/studio/gd-admin-course-db.js" },
        { role: "Studio page wrapper", path: "scripts/studio/courses/publishing/course-publishing-page.js" }
      ],
      inputs: ["Course Visuals build state"], outputs: ["Published visual asset (via /api/course-visual-jobs)"],
      owns: ["Publish/reset/revert actions", "Cloud job status polling"], doesNotOwn: ["Course record data", "Visual recipe authoring"],
      connections: [{ target: "course-visuals", direction: "reads-from", label: "Build state" }, { target: "course-database", direction: "read-by", label: "Published status" }],
      keyFunctions: [
        { name: "gdAdminCourseVisualPublish", purpose: "Publishes the current build.", codePath: "scripts/studio/gd-admin-course-db.js" },
        { name: "gdAdminCourseVisualRevert", purpose: "Reverts to the previously published asset.", codePath: "scripts/studio/gd-admin-course-db.js" }
      ],
      status: "implemented", needsVerification: false
    },
    {
      id: "mapping-diagnostics", label: "Mapping Diagnostics", parent: "courses",
      function: "Observational diagnostics for course mapping and course-play-pipeline attempts. Never chooses the next mapping tool — display only.",
      owner: "scripts/gd-course-mapping-debug.js + scripts/studio/gd-course-play-debug.js",
      runtime: { app: false, studio: true, server: false },
      code: [
        { role: "Mapping attempt diagnostics", path: "scripts/gd-course-mapping-debug.js" },
        { role: "Course-play pipeline debug renderers (unmoved)", path: "scripts/studio/gd-course-play-debug.js" },
        { role: "Studio page wrapper", path: "scripts/studio/courses/mapping-diagnostics/mapping-diagnostics-page.js" }
      ],
      inputs: ["Mapping attempt events", "Course-play pipeline debug events"], outputs: ["Diagnostic display only — no writes"],
      owns: ["Diagnostic display state"], doesNotOwn: ["Mapping decisions", "Course-play pipeline state"],
      connections: [{ target: "course-mapping", direction: "reads-from", label: "Attempt evidence" }],
      keyFunctions: [{ name: "gdRenderCoursePlayPipelineDebug", purpose: "Renders the pipeline debug table/timeline.", codePath: "scripts/studio/gd-course-play-debug.js" }],
      status: "implemented", needsVerification: false,
      warnings: ["Live refresh (2200ms interval + 2 CustomEvent listeners) is gated on #developerPanel.open — will not auto-refresh when only the new Studio shell is open. See CLARITY_STUDIO_WIRING_COMPARISON.md."]
    },

    // ---- Shot System ----
    { id: "photo-scan", label: "Photo Scan", parent: "shot-system",
      function: "Not yet moved into Studio. OCR/table-scan pipeline that turns a photo of a launch-monitor screen into structured practice shots.",
      owner: "scripts/gd-app-core.js (gdRunDefaultPracticePhotoScanFromCheckpoint) — app-facing, do not move",
      runtime: { app: true, studio: false, server: false },
      code: [
        { role: "Scan trigger/cancel (do not move)", path: "scripts/gd-app-core.js" },
        { role: "Import bridge (do not move)", path: "scripts/inline/gd-practice-import-action-bridge.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "photo-scan-intake", label: "Intake", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-image-prep", label: "Image Preparation", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-table-detection", label: "Table Detection", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-region-mapping", label: "Region Mapping", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-ocr", label: "OCR", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-row-interpretation", label: "Row Interpretation", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-normalisation", label: "Normalisation", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-review", label: "Review", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-save", label: "Save", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "photo-scan-failures", label: "Failures", parent: "photo-scan", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "photo-scan", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },

    { id: "practice-data", label: "Practice Data", parent: "shot-system",
      function: "Not yet moved into Studio. Local practice-shot gate/store and the shared parser core (also required server-side by functions/practice-data-parser.js).",
      owner: "scripts/gd-native-practice-data.js + scripts/gd-practice-parser-core.js — app-facing, do not move",
      runtime: { app: true, studio: false, server: true },
      code: [
        { role: "Gate/store (do not move)", path: "scripts/gd-native-practice-data.js" },
        { role: "Shared parser core (do not move — server also requires this file)", path: "scripts/gd-practice-parser-core.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "pattern-finder", label: "Pattern Finder", parent: "shot-system",
      function: "Not yet moved into Studio. No standalone file — lives inside scripts/gd-app-core.js / scripts/gd-route-audit.js per this branch's recon; not read in depth.",
      owner: "Needs verification", runtime: { app: true, studio: false, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "my-bubble", label: "My Bubble", parent: "shot-system",
      function: "Not yet moved into Studio. Player shot-shape bubble, compared against practice/on-course data.",
      owner: "scripts/gd-app-core.js (isMyBubble) + scripts/gd-shot-snapshot.js + scripts/course-data/gd-course-data-comparison.js — app-facing, do not move",
      runtime: { app: true, studio: false, server: false },
      code: [
        { role: "Bubble flag (do not move)", path: "scripts/gd-app-core.js" },
        { role: "Shot snapshot (do not move)", path: "scripts/gd-shot-snapshot.js" },
        { role: "Comparison feed (do not move)", path: "scripts/course-data/gd-course-data-comparison.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "shot-system-course-data", label: "Course Data", parent: "shot-system",
      function: "Not yet moved into Studio. Course-data intake/comparison, gated by gdCourseDataCanManage() (admin OR coach) — stays on the phone by design.",
      owner: "scripts/course-data/gd-course-data-intake.js + gd-course-data-comparison.js — app-facing, do not move",
      runtime: { app: true, studio: false, server: false },
      code: [
        { role: "Intake (do not move)", path: "scripts/course-data/gd-course-data-intake.js" },
        { role: "Comparison (do not move)", path: "scripts/course-data/gd-course-data-comparison.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "conditions", label: "Conditions", parent: "shot-system",
      function: "Not yet moved into Studio. Course-conditions engine (geometry + tolerance profile). A Studio-only debug surface exists but is dead code (nothing calls it).",
      owner: "scripts/course-data/conditions-engine/*", runtime: { app: true, studio: false, server: false },
      code: [
        { role: "Engine", path: "scripts/course-data/conditions-engine/gd-conditions-engine.js" },
        { role: "Geometry", path: "scripts/course-data/conditions-engine/gd-conditions-geometry.js" },
        { role: "Tolerance profile", path: "scripts/course-data/conditions-engine/gd-conditions-tolerance-profile.js" },
        { role: "Dead Studio-only debug surface — not wired to anything, do not treat as the real UI", path: "scripts/course-data/gd-conditions-debug.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "recommendations", label: "Recommendations", parent: "shot-system",
      function: "Not yet documented — no dedicated file found in this branch's recon.",
      owner: "Needs verification", runtime: { app: true, studio: false, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: true },

    // ---- GPS Play ----
    { id: "gps-course-selection", label: "Course Selection", parent: "gps-play",
      function: "Not yet moved into Studio. Course Picker search/selection UI — app-facing, do not move.",
      owner: "scripts/inline/gd-course-picker-search-v2.js", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Owner (do not move)", path: "scripts/inline/gd-course-picker-search-v2.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "gps-round-setup", label: "Round Setup", parent: "gps-play", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-hole-lifecycle", label: "Hole Lifecycle", parent: "gps-play",
      function: "Not yet moved into Studio. Hole/round state machine (HOLE_STATES/COURSE_STATES) — app-facing, do not move.",
      owner: "scripts/gd-course-play-pipeline.js", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Owner (do not move)", path: "scripts/gd-course-play-pipeline.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "gps-hole-completion", label: "Hole Completion", parent: "gps-hole-lifecycle", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-hole-lifecycle", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-round-completion", label: "Round Completion", parent: "gps-hole-lifecycle", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-hole-lifecycle", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-map-camera", label: "Map & Camera", parent: "gps-play",
      function: "Not yet moved into Studio. GPS framed camera model (bearing orientation, camera transform) — app-facing, do not move.",
      owner: "scripts/gd-app-core.js (gdOrientGpsCameraToBearing, gdApplyGpsMapCameraTransform)", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Owner (do not move)", path: "scripts/gd-app-core.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "gps-positioning", label: "Positioning", parent: "gps-map-camera", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-map-camera", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-shot-planning", label: "Shot Planning", parent: "gps-play",
      function: "Not yet moved into Studio. Includes the on-course flag/pin placement tool (verified — its name mentions neither GPS nor shot planning, flagged here so it isn't missed).",
      owner: "scripts/gd-flag-pin.js (flag/pin placement — do not confuse with a feature-flag system)", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Flag/pin placement (do not move)", path: "scripts/gd-flag-pin.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "gps-bubble-projection", label: "Bubble Projection", parent: "gps-shot-planning", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-shot-planning", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-shot-capture", label: "Shot Capture", parent: "gps-play",
      function: "Not yet moved into Studio. On-course hole-frame capture / capture pixel caching — app-facing, do not move.",
      owner: "scripts/gd-course-play-pipeline.js (FRAME_INDEX_KEY)", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Owner (do not move)", path: "scripts/gd-course-play-pipeline.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "gps-shot-commitment", label: "Shot Commitment", parent: "gps-shot-capture", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-shot-capture", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-scorecard", label: "Scorecard", parent: "gps-play", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-course-data-capture", label: "Course Data Capture", parent: "gps-play",
      function: "Not yet moved into Studio. On-course shots feed Course Data (per this repo's most recent commit on main) — app-facing, do not move.",
      owner: "scripts/course-data/gd-course-data-intake.js", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Owner (do not move)", path: "scripts/course-data/gd-course-data-intake.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "gps-sync-recovery", label: "Sync & Recovery", parent: "gps-play",
      function: "Not yet moved into Studio. Account/round sync — app-facing, do not move.",
      owner: "scripts/clarity-cloud-sync.js (unconfirmed scope beyond account-sync endpoint)", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Sync client (unconfirmed full scope)", path: "scripts/clarity-cloud-sync.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-sync", label: "Sync", parent: "gps-sync-recovery", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-sync-recovery", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-recovery", label: "Recovery", parent: "gps-sync-recovery", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-sync-recovery", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "gps-demo-mode", label: "Demo Mode", parent: "gps-play",
      function: "Not yet moved into Studio. Demo capture harness used for marketing/QA captures.",
      owner: "demo/run-demo.mjs (unconfirmed full scope)", runtime: { app: false, studio: false, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: true },

    // ---- System ----
    { id: "system-integrations", label: "Integrations", parent: "system", function: "Not yet documented — placeholder nav entry.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "system", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "system-storage", label: "Storage", parent: "system",
      function: "Not yet moved into Studio. Generic local key/value storage wrapper used across the app.",
      owner: "scripts/clarity-store.js (unconfirmed full scope)", runtime: { app: true, studio: false, server: false },
      code: [{ role: "Storage wrapper (unconfirmed full scope)", path: "scripts/clarity-store.js" }],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "system", direction: "child-of", label: "" }],
      keyFunctions: [], status: "placeholder", needsVerification: true },
    { id: "system-diagnostics", label: "Diagnostics", parent: "system",
      function: "Not yet moved into Studio as a general surface — the Courses area already has a working Mapping Diagnostics page (see courses > Mapping Diagnostics).",
      owner: "n/a — see mapping-diagnostics", runtime: { app: false, studio: true, server: false },
      code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "system", direction: "child-of", label: "" }, { target: "mapping-diagnostics", direction: "see-also", label: "Existing diagnostics surface" }],
      keyFunctions: [], status: "placeholder", needsVerification: false },
    { id: "system-feature-controls", label: "Feature Controls", parent: "system", function: "Not yet documented — placeholder nav entry. No feature-flag system was confirmed in this branch's recon.", owner: "Needs verification", runtime: { app: true, studio: false, server: false }, code: [], inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "system", direction: "child-of", label: "" }], keyFunctions: [], status: "placeholder", needsVerification: true }
  ];

  var byId = {};
  REGISTRY.forEach(function (r) { byId[r.id] = r; });

  var NAV_TREE = [
    { id: "overview" },
    { id: "courses", children: ["course-database", "course-mapping", "course-visuals", "publishing"] },
    { id: "shot-system", children: ["photo-scan", "practice-data", "pattern-finder", "my-bubble", "shot-system-course-data", "conditions", "recommendations"] },
    { id: "gps-play", children: ["gps-course-selection", "gps-round-setup", "gps-hole-lifecycle", "gps-map-camera", "gps-shot-planning", "gps-shot-capture", "gps-scorecard", "gps-course-data-capture", "gps-sync-recovery", "gps-demo-mode"] },
    { id: "players-coaches" },
    { id: "commerce" },
    { id: "communications" },
    { id: "system", children: ["system-integrations", "system-storage", "system-diagnostics", "system-feature-controls"] }
  ];

  window.GDStudioRegistry = {
    all: function () { return REGISTRY.slice(); },
    get: function (id) { return byId[id] || null; },
    childrenOf: function (id) {
      return REGISTRY.filter(function (r) { return r.parent === id; });
    },
    navTree: NAV_TREE
  };
})();

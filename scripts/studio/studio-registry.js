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
      function: "Player settings and profile hydration are app-facing (scripts/clarity-player-settings.js, scripts/clarity-profile-hydrate.js). The real admin/coach surface — an all-users roster + coach-account management for admins, a linked-players roster + invite QR flow for coaches — lives inline inside the Profile screen's Coaching Portal view (#gdProfileV67, created dynamically, not static markup), not a separate admin screen. Both render unconditionally as <details> blocks gated by role, with no manual toggle to call — opening the profile is enough.",
      owner: "scripts/inline/gd-auth-account-shell.js (coachAdminPanel/coachPanel) + scripts/clarity-player-settings.js/gd-app-permissions.js for the underlying role data",
      runtime: { app: true, studio: true, server: false },
      code: [
        { role: "Coaching Portal admin/coach panels (coachAdminPanel, coachPanel, coachInvitePanel)", path: "scripts/inline/gd-auth-account-shell.js" },
        { role: "Studio jump-in page (new, composition-only)", path: "scripts/studio/players-coaches/players-coaches-page.js" },
        { role: "Player settings (app-facing, unconfirmed full scope)", path: "scripts/clarity-player-settings.js" },
        { role: "Profile hydration (app-facing, unconfirmed full scope)", path: "scripts/clarity-profile-hydrate.js" }
      ],
      inputs: ["Account role (admin/coach/player/subscribedPlayer)"], outputs: ["Coach-account records", "Coach/player links"],
      owns: ["All-users roster (admin)", "Coach-account creation (admin)", "Linked-players roster + invite (coach)"], doesNotOwn: ["Payment/commerce data", "Course/practice data itself"],
      connections: [],
      keyFunctions: [
        { name: "coachAdminPanel", purpose: "All-users roster + coach-account management, role===\"admin\" only.", codePath: "scripts/inline/gd-auth-account-shell.js" },
        { name: "coachPanel", purpose: "Linked-players roster + coach-invite QR flow, admin or coach.", codePath: "scripts/inline/gd-auth-account-shell.js" }
      ],
      status: "implemented", needsVerification: false
    },
    {
      id: "commerce", label: "Commerce", parent: null,
      function: "In-app purchase/subscription flow is app-facing (scripts/clarity-store-billing.js — native RevenueCat bridge). The real admin surface is renderAdminSettings() in scripts/clarity-payments.js: Stripe/webhook/price connection status, product list + edit (Stripe Price ID, label, kind, active state), webhook/membership diagnostics, and an \"Advanced tools\" section (free-pass issuance, entitlement viewer + revoke, manual permission grant, permission-resolver tester). Gated role===\"admin\" only — unlike most other admin surfaces here, coach does not qualify. It renders inline at the bottom of Player Settings' Payments section, with no independent DOM to reparent.",
      owner: "scripts/clarity-payments.js",
      runtime: { app: true, studio: true, server: false },
      code: [
        { role: "Full commerce admin (renderAdminSettings + product/diagnostics/advanced-tools)", path: "scripts/clarity-payments.js" },
        { role: "Studio jump-in page (new, composition-only)", path: "scripts/studio/commerce/commerce-page.js" },
        { role: "Native purchase bridge (app-facing, do not move)", path: "scripts/clarity-store-billing.js" }
      ],
      inputs: ["Stripe webhook events", "Account role"], outputs: ["Product records", "Entitlement grants/revokes", "Membership state"],
      owns: ["Commerce admin UI", "Manual entitlement grants"], doesNotOwn: ["Native purchase flow (owned by clarity-store-billing.js)", "Account role itself (owned by gd-app-permissions.js)"],
      connections: [],
      keyFunctions: [
        { name: "renderAdminSettings", purpose: "Renders the full commerce admin block — products, diagnostics, advanced tools.", codePath: "scripts/clarity-payments.js" },
        { name: "showSettings / showSection(\"payments\")", purpose: "Opens the Payments section of Player Settings that hosts the admin block.", codePath: "scripts/clarity-payments.js" }
      ],
      status: "implemented", needsVerification: false
    },
    {
      id: "communications", label: "Communications", parent: null,
      function: "Every outbound email Clarity sends: what fires it, who receives it, what suppresses it, and a live preview of the real template. Read-only — sending and copy edits live elsewhere.",
      owner: "Studio Communications page + the shared template core",
      runtime: { app: true, studio: true, server: true },
      code: [
        { role: "Studio page", path: "scripts/studio/communications/communications-page.js" },
        { role: "Templates, copy and the catalogue (shared browser/server)", path: "scripts/gd-email-templates-core.js" },
        { role: "Delivery + service senders", path: "functions/email-notification.js" },
        { role: "Account setup / invite send", path: "functions/admin-user-invite.js" },
        { role: "Password reset send", path: "functions/auth-reset-password.js" },
        { role: "Opt-in activity events and per-account preferences", path: "scripts/clarity-email.js" }
      ],
      inputs: [
        "RESEND_API_KEY, CLARITY_EMAIL_FROM, CLARITY_SITE_URL, EMAIL_NOTIFICATIONS_ENABLED (reported as booleans by payment-admin's settings action)",
        "Per-account notification preferences, stored on the account row by clarity-email.js"
      ],
      outputs: ["Outbound email via Resend"],
      owns: [
        "The one email layout and every subject/title/detail string",
        "The catalogue of what is sent and why"
      ],
      doesNotOwn: [
        "Delivery credentials (Netlify env only)",
        "Whether an entitlement or account exists — the email only describes what another system already wrote"
      ],
      connections: [
        { target: "commerce", direction: "used-by", label: "comped access email; the comped-month tick shares its entitlement writer" },
        { target: "players-coaches", direction: "used-by", label: "creating an account sends the setup email" }
      ],
      keyFunctions: [
        { name: "catalogue", purpose: "Every email, its trigger and what suppresses it.", codePath: "scripts/gd-email-templates-core.js" },
        { name: "build", purpose: "Subject + HTML + plain text for one event type.", codePath: "scripts/gd-email-templates-core.js" },
        { name: "sendAccountSetupEmail", purpose: "Account setup, with the comped variant folded in.", codePath: "functions/email-notification.js" },
        { name: "sendCompedAccessEmail", purpose: "Comped access issued on its own from Commerce.", codePath: "functions/email-notification.js" }
      ],
      status: "implemented", needsVerification: false
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
      id: "map-viewport", label: "Map Viewport", parent: "courses",
      function: "View-only window onto the ground the mapper works over. Establishes the first view through the real course picker (pick-only mode — no round is started, no recent course recorded), then lets you pan, zoom and switch between every live imagery provider the app plays over. \"Scanner view\" asks /api/imagery-source which source the scan registry resolves here and snaps to that source's live twin at its zoom ceiling. Writes nothing: no pin, no package, no scan, no course record.",
      owner: "scripts/studio/courses/map-viewport/map-viewport-page.js",
      runtime: { app: false, studio: true, server: true },
      code: [
        { role: "Page (owner)", path: "scripts/studio/courses/map-viewport/map-viewport-page.js" },
        { role: "Provider list + layer building (window.GDMapSources, do not copy)", path: "scripts/gd-app-core.js" },
        { role: "Course selection (pick-only mode, app-facing owner)", path: "scripts/inline/gd-course-picker-search-v2.js" },
        { role: "Scan-source answer (reads the imagery registry server side)", path: "functions/imagery-source.mjs" },
        { role: "Scan source registry (source of truth, never copied client side)", path: "functions/lib/gd-imagery-sources.mjs" }
      ],
      inputs: ["Course selection from the real picker", "Scan source resolved for the view's centre"],
      outputs: ["Display only — nothing is written"],
      owns: ["The viewport UI and its provider switcher"],
      doesNotOwn: [
        "The provider list itself (owned by gd-app-core.js's mapSources)",
        "The course picker (owned by gd-course-picker-search-v2.js)",
        "The scan registry (owned by functions/lib/gd-imagery-sources.mjs)",
        "Course location/pin state — this page never writes one"
      ],
      connections: [
        { target: "courses", direction: "child-of", label: "" },
        { target: "course-mapping", direction: "see-also", label: "Where location actually gets written" }
      ],
      keyFunctions: [
        { name: "GDCoursePicker.open({onPick})", purpose: "Pick-only mode — hands back the resolved course instead of entering the mapping/GPS pipeline.", codePath: "scripts/inline/gd-course-picker-search-v2.js" },
        { name: "GDMapSources.buildLayer", purpose: "Turns a live map source into a Leaflet layer, including the bbox-endpoint sources that have no tile template.", codePath: "scripts/gd-app-core.js" },
        { name: "GET /api/imagery-source", purpose: "Which scan source covers a point, its zoom ceiling and its licence. Returns no endpoints or keys.", codePath: "functions/imagery-source.mjs" }
      ],
      status: "implemented", needsVerification: false,
      warnings: ["The providers shown here are LIVE display sources. Several (Esri, Queensland) are licensed for display only and must never be added to functions/lib/gd-imagery-sources.mjs — seeing a course over one of them here says nothing about whether it can be scanned."]
    },
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
      owns: ["Visual recipes", "Preview/product assembly", "Shared recipe library", "Which recipe is active"],
      doesNotOwn: ["Accepted geometry", "Release/publish state"],
      connections: [
        { target: "course-database", direction: "reads-from", label: "Accepted geometry" },
        { target: "publishing", direction: "writes", label: "Build/job requests" }
      ],
      keyFunctions: [
        { name: "gdAdminCourseVisualControls", purpose: "Renders the full visual-tuning control panel.", codePath: "scripts/studio/gd-admin-course-db.js" },
        { name: "gdAdminCoursePreviewFrameFromObjects", purpose: "Computes preview frame geometry from captured objects.", codePath: "scripts/studio/gd-admin-course-db.js" },
        { name: "gdAdminCourseVisualRecipeCenterMarkup", purpose: "The active-recipe area: pick which saved recipe the pipeline applies to new courses.", codePath: "scripts/studio/gd-admin-course-db.js" },
        { name: "gdAdminCourseVisualUpdateWithActiveRecipe", purpose: "Re-bakes one course on the server with the active recipe (explicit, so it beats the course's last published one).", codePath: "scripts/studio/gd-admin-course-db.js" }
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
      function: "Observational diagnostics for course mapping and course-play-pipeline attempts. Never chooses the next mapping tool — display only. Since 2026-08-05 also shows a live Server Job History pulled from GET /api/course-mapper-jobs (functions/course-mapper-jobs.mjs) — the actual course_mapper_jobs status/error/stage for the selected course. That endpoint and its data already existed; nothing anywhere displayed it, which is why a schema type-mismatch bug (course_maps.geometry_version declared integer, every consumer writes/compares it as a string) silently failed 100% of server-side geometry saves for 5 days before being found by querying the database directly. See supabase/migrations/20260805_fix_course_map_geometry_version_type.sql.",
      owner: "scripts/gd-course-mapping-debug.js + scripts/studio/gd-course-play-debug.js + functions/course-mapper-jobs.mjs (job data, read-only)",
      runtime: { app: false, studio: true, server: true },
      code: [
        { role: "Mapping attempt diagnostics", path: "scripts/gd-course-mapping-debug.js" },
        { role: "Course-play pipeline debug renderers (unmoved)", path: "scripts/studio/gd-course-play-debug.js" },
        { role: "Studio page wrapper + Server Job History section", path: "scripts/studio/courses/mapping-diagnostics/mapping-diagnostics-page.js" },
        { role: "Job status API this page reads (GET only, public, pre-existing)", path: "functions/course-mapper-jobs.mjs" },
        { role: "Server-side geometry resolution + save (what the job history is watching)", path: "functions/course-mapper-worker-background.mjs" }
      ],
      inputs: ["Mapping attempt events", "Course-play pipeline debug events", "course_mapper_jobs rows (via API)"], outputs: ["Diagnostic display only — no writes"],
      owns: ["Diagnostic display state"], doesNotOwn: ["Mapping decisions", "Course-play pipeline state", "course_mapper_jobs data (owned by functions/course-mapper-jobs.mjs)"],
      connections: [{ target: "course-mapping", direction: "reads-from", label: "Attempt evidence" }],
      keyFunctions: [
        { name: "gdRenderCoursePlayPipelineDebug", purpose: "Renders the pipeline debug table/timeline.", codePath: "scripts/studio/gd-course-play-debug.js" },
        { name: "renderJobHistory", purpose: "Fetches and renders the selected course's server_mapper_jobs status/error table, polled every 4s.", codePath: "scripts/studio/courses/mapping-diagnostics/mapping-diagnostics-page.js" }
      ],
      status: "implemented", needsVerification: false,
      warnings: [
        "Live refresh (2200ms interval + 2 CustomEvent listeners) is gated on #developerPanel.open — will not auto-refresh when only the new Studio shell is open. See CLARITY_STUDIO_WIRING_COMPARISON.md.",
        "The Server Job History section only shows the last 8 jobs (functions/course-mapper-jobs.mjs's mapperBuildState query is limit=8) and only for one course at a time — there is still no cross-course \"show me every currently failing course\" view. A future improvement worth doing: a dashboard query across all courses' latest job status.",
        "The player-facing app itself still cannot see a job's error — GET /api/course-package's response never surfaces course_mapper_jobs.error to the client (functions/gd-course-package-shape.mjs's \"manual-required\" state is derived but never actually written by the worker). This Studio view is currently the only place a human can see why a course failed to map without querying Supabase directly."
      ]
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
      function: "The real, live Practice Data screen (#practiceDataPanel, embedded in #dataHubPanel) — app-facing, ships to every player. Three distinct things live under this one screen, not one: (1) the player-facing import/review flow (camera, email, OCR scan, CSV/text paste); (2) an Admin tab (tolerance/gate-tuning sliders) that the app itself already hides via CSS for player/subscribedPlayer permission and only exposes to admin/coach; (3) nested inside that Admin tab, a Studio-only live scan/import debug feed + raw-JSON dump that is physically stripped from the phone app build and additionally requires admin permission specifically (coach does not qualify for it, unlike (2)). This Studio page does not reimplement any of this — it opens the real screen, in admin mode, via the existing gdOpenPracticeAdminTab().",
      owner: "Screen/admin-toggle: scripts/gd-route-audit.js. Live debug panel: scripts/gd-app-core.js. Parser/store: scripts/gd-native-practice-data.js + scripts/gd-practice-parser-core.js (also required server-side by functions/practice-data-parser.js). Visibility gating: styles/inline/gd-app-base.css.",
      runtime: { app: true, studio: true, server: true },
      code: [
        { role: "Screen shell, Admin tab toggle (gdTogglePracticeAdmin, gdOpenPracticeAdminTab) — app-facing, do not move", path: "scripts/gd-route-audit.js" },
        { role: "Studio-only live scan/import debug feed (gdRenderPracticeLiveDebugPanel) — do not move", path: "scripts/gd-app-core.js" },
        { role: "Gate/store (do not move)", path: "scripts/gd-native-practice-data.js" },
        { role: "Shared parser core (do not move — server also requires this file)", path: "scripts/gd-practice-parser-core.js" },
        { role: "Studio jump-in page (new, composition-only)", path: "scripts/studio/shot-system/practice-data/practice-data-page.js" },
        { role: "Hides the Admin tab button for player/subscribedPlayer permission (.gdPracticeAdminExpander rule)", path: "styles/inline/gd-app-base.css" }
      ],
      inputs: ["Camera/email/OCR import", "CSV/text paste"],
      outputs: ["Native practice-shot store (gd_native_practice_shot_data_v1)", "Tolerance/gate settings (admin/coach only)"],
      owns: ["Practice-shot import/review UI", "Tolerance/gate tuning controls"],
      doesNotOwn: ["My Bubble computation", "Pattern Finder", "Course Data"],
      connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [
        { name: "gdOpenPracticeAdminTab", purpose: "Force-opens the real Practice Data screen with the Admin tab expanded, regardless of current state.", codePath: "scripts/gd-route-audit.js" },
        { name: "gdTogglePracticeAdmin", purpose: "Toggles the Admin tab section and renders the tolerance controls.", codePath: "scripts/gd-route-audit.js" }
      ],
      status: "implemented", needsVerification: false,
      warnings: ["The Admin tab's CSS-only visibility gate reads document.body's data-gd-permission attribute, which is only set at runtime by gdRefreshPermissionChrome() (not present in the initial static markup) — a narrow pre-boot window exists where the selector wouldn't yet match. Not observable in practice since the panel is closed at that point, but the gate is not watertight from first paint."] },
    { id: "practice-email", label: "Practice Email", parent: "shot-system",
      function: "Read-only admin view of the practice email intake: what arrived at the practice inbox, which attachment it carried, and how far it got - parsed and staged, landed but unreadable, or a photo waiting for a player's device to scan it. Unlike Practice Data this is not a jump-in to an app screen, because no app screen shows this: the app shows a player their own address and their own imports, never the picture across all players. The intake tables are RLS'd to the service role, so the page reads through /api/practice-email-admin rather than querying Supabase, and that function checks the caller is an admin first.",
      owner: "functions/practice-email-admin.js (read) + functions/practice-email-intake.js (the webhook that writes what this shows)",
      runtime: { app: false, studio: true, server: true },
      code: [
        { role: "Studio page (read-only)", path: "scripts/studio/shot-system/practice-email/practice-email-page.js" },
        { role: "Admin read endpoint", path: "functions/practice-email-admin.js" },
        { role: "Inbound webhook that writes the rows shown here (do not move)", path: "functions/practice-email-intake.js" },
        { role: "Shared parser core - decides row counts and units (do not move)", path: "scripts/gd-practice-parser-core.js" }
      ],
      inputs: ["practice_email_intake_events", "practice_import_batches", "practice_email_addresses", "practice_email_senders"],
      outputs: ["Nothing - the page never writes"],
      owns: ["Cross-player view of practice email intake"],
      doesNotOwn: ["Sender approval/revocation (the player's own screen)", "Parsing itself", "Photo scanning"],
      connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [
        { name: "handler", purpose: "GET only, admin only. Returns recent intakes with their batches, plus issued addresses and their approved senders.", codePath: "functions/practice-email-admin.js" }
      ],
      status: "implemented", needsVerification: false,
      warnings: ["Read-only by design. Revoking a sender is a real action against a player's account and is deliberately not wired here."] },
    {
      id: "bubble-geometry", label: "Bubble Geometry", parent: "shot-system",
      function: "The authoritative surface for the Bubble Micro-Geometry model: which Bubble Signals a set of practice data triggers, what evidence route each one used, how much the eight bubble regions move as a result, and whether that is published. A real workspace rather than a jump-in, because no app screen shows any of it - a player sees their bubble, not the reasoning that shaped it. Runs the same scripts/gd-bubble-signals-core.js the server runs (no second copy of the model), draws Base from the live engine's own getGDBForClub() payload, and can POST the same rows to /api/bubble-model to prove the two agree. Also hosts the Bubble Signal Test Data Generator (seeded, provider-flavoured, plants a chosen relationship) and the six pre-loaded scenarios including the Control set whose contract is that Base and Adjusted come out identical.",
      owner: "scripts/gd-bubble-signals-core.js (the model) + functions/bubble-model.js (persistence and publishing) + this page (the view)",
      runtime: { app: false, studio: true, server: true },
      code: [
        { role: "Studio workspace", path: "scripts/studio/shot-system/bubble-geometry/bubble-geometry-page.js" },
        { role: "The model itself - shared verbatim with the server, do not fork", path: "scripts/gd-bubble-signals-core.js" },
        { role: "Seeded test-data generator (Studio-only, stripped from the phone build)", path: "scripts/gd-bubble-signal-test-data.js" },
        { role: "Server binding: analyse, persist, publish", path: "functions/bubble-model.js" },
        { role: "Cache-first client that feeds the engine (both shells)", path: "scripts/gd-bubble-model-client.js" },
        { role: "Render-time application: region factors + axis correction", path: "scripts/gd-app-core.js" },
        { role: "Generated mirror for the fresh app shell - do not hand-edit", path: "app/js/bubble-engine.js" },
        { role: "Tables: bubble_geometry_configs, bubble_player_models", path: "supabase/migrations/20260815_bubble_micro_geometry.sql" }
      ],
      inputs: ["Practice rows (Shot Library, gate input, or generated)", "Published geometry config version"],
      outputs: ["Versioned player-model payload (base, geometry, signals, projection)", "New geometry config versions"],
      owns: ["Signal definitions", "Evidence aliases and route confidence", "Region deformation amounts", "Axis caps", "Minimum sample gates", "Geometry config versions"],
      doesNotOwn: [
        "The Bubble itself - club progression, size and aim are unchanged and remain primary",
        "My Bubble's aim (only Practice Bubble adoption may change it - Bubble Bible s1)",
        "Practice import/parsing (owned by gd-practice-parser-core.js)"
      ],
      connections: [
        { target: "shot-system", direction: "child-of", label: "" },
        { target: "practice-data", direction: "reads-from", label: "Practice rows" },
        { target: "gps-bubble-projection", direction: "writes", label: "Approved region geometry + axis correction" }
      ],
      keyFunctions: [
        { name: "detectSignals", purpose: "Runs all five Signals over a row set and reports, for each, whether it fired and why not if it did not.", codePath: "scripts/gd-bubble-signals-core.js" },
        { name: "buildMicroGeometry", purpose: "Merges fired Signals into eight region multipliers plus an axis correction, under hard caps. Returns identity when the engine is disabled.", codePath: "scripts/gd-bubble-signals-core.js" },
        { name: "buildPlayerModel", purpose: "The versioned payload the phone hydrates: base, geometry, signals, projection.", codePath: "scripts/gd-bubble-signals-core.js" },
        { name: "gdMicroGeometryRadiusFactor", purpose: "Where the approved geometry actually reaches the drawn ring, inside buildBubbleShape's rel loop.", codePath: "scripts/gd-app-core.js" }
      ],
      status: "implemented", needsVerification: false,
      warnings: [
        "SHIPPED OFF. defaultConfig().enabled is false and every Signal is disabled, so the rendered bubble is byte-identical to the one that shipped before this layer existed. dev/bubble-micro-geometry.test.js pins that against the real generated client, not against the core's own idea of identity. Turning the engine on is a Studio publish, not a code change.",
        "The 1x/5x/10x exaggeration is a magnifying glass, not a setting. It drives this page's drawing and the dev-only bubbleGeometry.microExaggeration field, and is deliberately not part of the published config. Production deformation is a fraction of a percent by design - do not judge a real bubble with it above 1.",
        "Publishing marks EVERY stored player model stale in one statement. Each rebuilds on its next analysis and the phone keeps rendering its cached model until then, so nobody waits - but the write does touch every row."
      ]
    },
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
      function: "Course-data intake/comparison (scripts/course-data/gd-course-data-intake.js, gd-course-data-comparison.js) stays on the phone by design. The real admin surface is the .gdCourseAdminExpander button inside #statsPanel (\"Shot Data\") — raw upload, tuning fields, and a sandbox data generator that injects fake course/practice shots into live storage — gated gdCourseDataCanManage() (admin OR coach). Two definitions of gdRenderCourseDataAdminPanel exist (gd-app-core.js's simpler one, gd-route-audit.js's richer one); gd-route-audit.js's window export wins since it loads later, so that's the one actually shown.",
      owner: "scripts/gd-route-audit.js (gdSetCourseDataTab, gdRenderCourseDataAdminPanel, openCourseData) + scripts/course-data/gd-course-data-intake.js/gd-course-data-comparison.js",
      runtime: { app: true, studio: true, server: false },
      code: [
        { role: "Course Data admin panel (upload/tuning/sandbox generator) — the effective one", path: "scripts/gd-route-audit.js" },
        { role: "Studio jump-in page (new, composition-only)", path: "scripts/studio/shot-system/course-data/course-data-page.js" },
        { role: "Intake (do not move)", path: "scripts/course-data/gd-course-data-intake.js" },
        { role: "Comparison (do not move)", path: "scripts/course-data/gd-course-data-comparison.js" }
      ],
      inputs: ["Uploaded/pasted course data", "Sandbox-generated shot data (admin only)"], outputs: ["Course data records", "Tuning field values"],
      owns: ["Course data admin UI"], doesNotOwn: ["My Bubble computation", "Practice data store"],
      connections: [{ target: "shot-system", direction: "child-of", label: "" }],
      keyFunctions: [
        { name: "openCourseData", purpose: "Opens #statsPanel via the Data Hub course accordion; {adminTab:true} jumps straight to the admin panel.", codePath: "scripts/gd-route-audit.js" },
        { name: "gdSetCourseDataTab", purpose: "Toggles the admin panel open, permission-checked.", codePath: "scripts/gd-route-audit.js" }
      ],
      status: "implemented", needsVerification: false,
      warnings: ["The sandbox data generator (gdRenderSandboxGeneratorHTML) injects fake shots into live storage — real, not a toy, treat with care when opened from Studio."] },
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
      function: "On-course flag/pin placement (its file name mentions neither GPS nor shot planning, flagged here so it isn't missed) plus a jump into Bubble Projection's tuning group — see the nested gps-bubble-projection record for the bubble engine itself.",
      owner: "scripts/gd-flag-pin.js (flag/pin placement — do not confuse with a feature-flag system)", runtime: { app: true, studio: true, server: false },
      code: [
        { role: "Flag/pin placement (do not move)", path: "scripts/gd-flag-pin.js" },
        { role: "Studio page (jump button into Bubble Geometry tuning)", path: "scripts/studio/gps-play/shot-planning/shot-planning-page.js" }
      ],
      inputs: [], outputs: [], owns: [], doesNotOwn: [], connections: [{ target: "gps-play", direction: "child-of", label: "" }, { target: "gps-bubble-projection", direction: "child-of", label: "" }],
      keyFunctions: [], status: "implemented", needsVerification: false },
    { id: "gps-bubble-projection", label: "Bubble Projection", parent: "gps-shot-planning",
      function: "The live on-course GPS shot-pattern bubble overlay — distinct from \"My Bubble\" (the practice-data shot-shape comparison). Engine: calculateBubbleProfile/calculateVisualBubbleRender/getGpsBubblePayload build a smoothed polygon ring from club/carry/face-offset, clamped to on-screen caps, drawn by renderShot() onto the live map. Mirrored byte-for-byte into app/js/bubble-engine.js for the newer app shell by dev/generate-bubble-engine-client.js, verified identical by dev/fresh-app-boot.test.js. Design intent documented in docs/BUBBLE-BIBLE.md.",
      owner: "scripts/gd-app-core.js (lines ~17915-18270, 19811) + generated mirror app/js/bubble-engine.js",
      runtime: { app: true, studio: true, server: false },
      code: [
        { role: "Bubble engine (profile/payload/ring math) — do not move", path: "scripts/gd-app-core.js" },
        { role: "Generated byte-identical mirror for the fresh app shell — do not hand-edit", path: "app/js/bubble-engine.js" },
        { role: "Fresh-app render/consumption of the mirror", path: "app/js/play.js" },
        { role: "Generator that keeps the two copies in sync", path: "dev/generate-bubble-engine-client.js" },
        { role: "Design-intent documentation", path: "docs/BUBBLE-BIBLE.md" },
        { role: "Studio jump-in (via gps-shot-planning's page)", path: "scripts/studio/gps-play/shot-planning/shot-planning-page.js" }
      ],
      inputs: ["Active club + carry distance", "Shot bearing (bearing(start,target) — geometric, NOT live device compass)", "bubbleGeometry.* dev-panel tuning"],
      outputs: ["Smoothed polygon ring rendered onto the live map"],
      owns: ["Bubble shape/tilt/display-clamp math"], doesNotOwn: ["My Bubble practice-data comparison (gd-app-core.js:21874+, a different system despite the shared name)", "Map camera rotation (owned by gdOrientGpsCameraToBearing, also bearing-based, not compass-based)"],
      connections: [{ target: "gps-shot-planning", direction: "child-of", label: "" }],
      keyFunctions: [
        { name: "getGpsBubblePayload", purpose: "Public entry point: profile → GDB payload → fallback chain.", codePath: "scripts/gd-app-core.js" },
        { name: "gdBubbleGeometryTuning", purpose: "Reads the bubbleGeometry.* dev-panel knobs (width/depth/tilt scale, tilt clamp, GPS display caps) — this is the tunable surface, confirmed wired end-to-end, no naming drift found.", codePath: "scripts/gd-app-core.js" },
        { name: "gdBubbleShotBearing", purpose: "Returns bearing(start,target) — the orientation the bubble actually uses. Confirmed NOT fed by any live device heading.", codePath: "scripts/gd-app-core.js" },
        { name: "renderShot", purpose: "Live-map render call site — draws the bubble's Leaflet layers.", codePath: "scripts/gd-app-core.js" }
      ],
      status: "implemented", needsVerification: false,
      warnings: [
        "Not fed by a real compass \"deg\" value: gdBubbleShotBearing() and the map's gdOrientGpsCameraToBearing() both compute orientation purely from bearing(start,target)/bearing(start,northTarget) — geometric lat/lng trig, not device heading. A real live-heading reader exists (phoneHeading, from deviceorientation/webkitCompassHeading) but is wired only to an unrelated feature — the green-search phone-direction helper — never to the bubble or the map camera. If the bubble/camera is meant to track true device compass heading, that link does not exist in code.",
        "Bubble-SHAPE tilt (bubbleGeometry.tiltScale/tiltMaxDeg) is real and correctly wired to the dev panel — confirmed by tracing gdBubbleGeometryTuning() -> gdDeriveClusterTilt() -> calculateVisualBubbleRender() -> gdBubbleLocalToLatLng()'s rotation.",
        "A separate CAMERA/perspective tilt system (styles/inline/gd-gps-play-camera-tilt-v1.css, --gd-gps-play-camera-tilt-deg etc.) was found to be fully dead — defined, linked, styled, but no script ever set those custom properties or toggled its gating body classes, and its target element (#gdHoleImageCameraLayer) did not exist anywhere else in the codebase. Removed 2026-08-05 (see git history) rather than left as misleading dead configuration.",
        "The newer app/ shell has its own perspective tilt (--tiltDeg:32 in app/styles.css, actively used and read back for input un-tilting in app/js/play.js's unTilt()) — but it's a hardcoded constant with no dev-panel/config path at all, since app/ has no DEV_DEFS/devTuningControls mechanism. It shares no config with bubbleGeometry.tiltScale/tiltMaxDeg."
      ] },
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
      function: "scripts/clarity-store.js is a generic local key/value wrapper (unconfirmed full scope). The real admin surface for storage is the Data Safety card (#clarityBackupCard, scripts/clarity-backup.js) — export/import this browser's local backup (profiles, coach/player links, course mapping, shot data, practice data, settings), reparented here from #developerPanel. No permission gate beyond reaching #developerPanel.",
      owner: "scripts/clarity-backup.js (Data Safety card) + scripts/clarity-store.js (unconfirmed full scope)",
      runtime: { app: true, studio: true, server: false },
      code: [{ role: "Orphaned course data", path: "scripts/studio/system/storage/orphaned-course-data.js" }, 
        { role: "Data Safety export/import card (unmoved, reparented)", path: "scripts/clarity-backup.js" },
        { role: "Studio page (reparent host)", path: "scripts/studio/system/storage/storage-page.js" },
        { role: "Storage wrapper (unconfirmed full scope)", path: "scripts/clarity-store.js" }
      ],
      inputs: ["Backup JSON file (import)"], outputs: ["Backup JSON file (export)"],
      owns: ["Backup export/import UI"], doesNotOwn: ["The underlying local storage keys it backs up (owned by their respective modules)"],
      connections: [{ target: "system", direction: "child-of", label: "" }],
      keyFunctions: [{ name: "downloadBackup / handleImportFile", purpose: "Export/import the browser's Clarity data as JSON.", codePath: "scripts/clarity-backup.js" }],
      status: "implemented", needsVerification: false,
      warnings: ["A second entry point, window.gdOpenPlayerSettingsBackup (scripts/clarity-player-settings.js), has no button wired to it anywhere in index.html — looks dead. #developerPanel's card is the only live way to reach this today."] },
    { id: "system-diagnostics", label: "Diagnostics", parent: "system",
      function: "The Courses area already has a working Mapping Diagnostics page (see courses > Mapping Diagnostics). This page now also hosts the Launch Monitor Intake Test card (.gdLmAdmin, scripts/gd-app-core.js), reparented from #developerPanel — an admin-only test lane for captured practice data.",
      owner: "scripts/gd-app-core.js (gdRenderLaunchMonitorAdmin) — see also mapping-diagnostics",
      runtime: { app: false, studio: true, server: false },
      code: [
        { role: "Launch Monitor Intake Test card (unmoved, reparented)", path: "scripts/gd-app-core.js" },
        { role: "Studio page (reparent host)", path: "scripts/studio/system/diagnostics/launch-monitor-diagnostics-page.js" }
      ],
      inputs: ["Uploaded launch-monitor practice data"], outputs: ["Diagnostic display only"],
      owns: ["Launch monitor intake test UI"], doesNotOwn: ["Course mapping diagnostics (see mapping-diagnostics)"],
      connections: [{ target: "system", direction: "child-of", label: "" }, { target: "mapping-diagnostics", direction: "see-also", label: "Existing diagnostics surface" }],
      keyFunctions: [{ name: "gdRenderLaunchMonitorAdmin", purpose: "Renders launch-monitor intake analysis into the reparented card.", codePath: "scripts/gd-app-core.js" }],
      status: "implemented", needsVerification: false },
    { id: "system-feature-controls", label: "Feature Controls", parent: "system",
      function: "No formal feature-flag system exists. The closest real thing is #devTuningControls (scripts/gd-app-core.js's renderDevPanel(), driven by DEV_DEFS/DEV_FIELDS) — numeric tuning across Shot Engine, Shot Visuals, GPS Behaviour, Live Wind, Wand Integration, Bubble Geometry, and more, several of which are literal 0/1 toggles. Reparented here from #developerPanel.",
      owner: "scripts/gd-app-core.js (renderDevPanel, DEV_DEFS/DEV_FIELDS)",
      runtime: { app: true, studio: true, server: false },
      code: [
        { role: "Dev tuning controls (unmoved, reparented)", path: "scripts/gd-app-core.js" },
        { role: "Studio page (reparent host)", path: "scripts/studio/system/feature-controls/feature-controls-page.js" }
      ],
      inputs: [], outputs: ["Tuning field values (localStorage-backed)"],
      owns: ["Dev tuning UI"], doesNotOwn: ["The systems each field tunes"],
      connections: [{ target: "system", direction: "child-of", label: "" }],
      keyFunctions: [{ name: "renderDevPanel", purpose: "Renders the full numeric tuning UI from DEV_DEFS/DEV_FIELDS.", codePath: "scripts/gd-app-core.js" }],
      status: "implemented", needsVerification: false,
      warnings: ["Not a real feature-flag registry — this is numeric dev tuning that happens to include some 0/1 toggle-shaped fields. Labelled honestly as the closest match, not a fabricated flag system."] }
  ];

  var byId = {};
  REGISTRY.forEach(function (r) { byId[r.id] = r; });

  var NAV_TREE = [
    { id: "overview" },
    { id: "courses", children: ["course-database", "course-mapping", "map-viewport", "course-visuals", "publishing"] },
    { id: "shot-system", children: ["photo-scan", "practice-data", "practice-email", "bubble-geometry", "pattern-finder", "my-bubble", "shot-system-course-data", "conditions", "recommendations"] },
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

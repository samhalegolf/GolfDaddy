/* What a course map version is CALLED. One file, because the same string has to be
   produced in five places that share no other code: /api/course-library (the manifest),
   /api/course-package (the package the app plays), /api/course-watch-maps, the bake
   worker (which freezes the label onto every hole image it writes), and both browser
   shells. Five hand-written copies of "v" + a + "." + b is how the two ends of the
   freshness check drifted the first time - see the header of app/js/course-versions.js,
   which exists for exactly that reason.

   Loaded two ways, same convention as scripts/gd-watch-map-core.js and the other shared
   cores (pinned in netlify.toml [functions].included_files because it sits outside
   functions/):
     - browser, via <script> in index.html and app/index.html, as
       window.ClarityApp.courseVersionLabel
     - Netlify functions, via `import courseVersionLabel from "../scripts/gd-course-version-label.js"`

   THE SCHEME
   ----------
     v<bake>.<geometry>

     major = course_visuals.bake_number     - which baked picture this is. 0 means there
                                              is no baked picture: the course is playing
                                              off objects alone.
     minor = how many times the GEOMETRY has moved since that bake
             (course_maps.objects_revision - course_visuals.bake_objects_revision)

   so:
     Akarana Golf Club (v1.4)   baked once, greens/tees/bunkers edited four times since
     Akarana Golf Club (v0.1)   object-only - no baked picture, first geometry revision
     W-v1.0                     the Watch package, same rule, its own build counter

   The minor resets on a re-bake because a re-bake re-photographs the course at its
   current geometry: v1.4 -> re-bake -> v2.0. That is the whole point of splitting the
   number - the major says which pictures you have, the minor says how far the ground has
   moved out from under them.

   TWO VERSIONS, NOT ONE
   ---------------------
   A baked hole image carries the label it was baked with, frozen, in its own asset
   record. The course carries the label it is at now. They disagree exactly when the
   geometry has moved since the bake - a hole image stamped v1.2 sitting in a course at
   v1.3 means "this picture predates the last geometry edit", which is the single most
   useful thing the stamp can tell you. So: never recompute an image's label from the
   course. Read it off the asset you actually loaded. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.courseVersionLabel = api;
    root.GDCourseVersionLabel = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /* A revision is a count, so the only values that mean anything are whole numbers at or
     above zero. Everything else - null, "", "v1", NaN, a timestamp - is "we do not know",
     and the callers all render nothing rather than a number they cannot stand behind.
     An unproven badge is the bug this whole area exists to stop. */
  function count(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  }

  function parts(major, minor) {
    return { major: major, minor: minor, label: "v" + major + "." + minor };
  }

  /* The course's CURRENT version.

       bakeNumber           course_visuals.bake_number            (null/0 = object-only)
       objectsRevision      course_maps.objects_revision
       bakeObjectsRevision  course_visuals.bake_objects_revision

     Returns null when objectsRevision is unknown - without it there is no minor number
     and no honest label to print. */
  function courseVersion(input) {
    var objects = count(input && input.objectsRevision);
    if (objects === null) return null;
    var bake = count(input && input.bakeNumber) || 0;
    if (!bake) return parts(0, objects);
    /* bakeObjectsRevision missing means a bake written before it was recorded. Reading it
       as "baked from the geometry it is sitting on" prints v<n>.0 rather than inventing a
       drift figure out of a column that was never filled in. */
    var baseline = count(input && input.bakeObjectsRevision);
    if (baseline === null) baseline = objects;
    return parts(bake, Math.max(0, objects - baseline));
  }

  /* The Watch package, same rule against its own build counter. Prefixed so a Watch asset
     can never be mistaken for the phone asset of the same course - they are separate
     pipelines built from the same geometry, and "v1.0" alone would read as either. */
  function watchVersion(input) {
    var objects = count(input && input.objectsRevision);
    if (objects === null) return null;
    var build = count(input && input.buildNumber) || 0;
    if (!build) return null;   // nothing generated yet - there is no Watch asset to name
    var baseline = count(input && input.sourceObjectsRevision);
    if (baseline === null) baseline = objects;
    var v = parts(build, Math.max(0, objects - baseline));
    v.label = "W-" + v.label;
    return v;
  }

  /* The label a baked asset was stamped with, read back off the asset's own record.
     Accepts the stamp this module's stampFor() wrote; returns "" for anything else so a
     caller can render the chip without first proving the shape. */
  function assetLabel(stamp) {
    if (!stamp) return "";
    if (typeof stamp === "string") return /^W?-?v\d+\.\d+$/.test(stamp) ? stamp : "";
    return typeof stamp.label === "string" ? stamp.label : "";
  }

  /* What the bake worker freezes onto each hole image. buildId is the export content hash
     ("r1alw6nz") - it names the BUILD, which is what identifies the exact pixels when two
     bakes share a version number because something was republished without a geometry
     move. Kept beside the label rather than folded into it: the label is for reading, the
     hash is for matching against storage. */
  function stampFor(version, extra) {
    if (!version) return null;
    return {
      label: version.label,
      major: version.major,
      minor: version.minor,
      buildId: (extra && extra.buildId) || null,
      bakedAt: (extra && extra.bakedAt) || null
    };
  }

  /* The one bracket rule: "<text> (v1.4)", or the bare text when there is no version.
     Bare, not "<text> ()" and not "<text> (unknown)" - a course whose revision cannot be
     counted reads exactly as it did before versions existed. Every surface that shows a
     version goes through here so they cannot drift into different punctuation or a
     different answer for the unknown case. */
  function suffixed(text, label) {
    var t = String(text == null ? "" : text);
    var l = typeof label === "string" ? label : label && label.label;
    return l ? t + " (" + l + ")" : t;
  }

  /* "Akarana Golf Club (v1.4)" - the course you are holding. */
  function withName(name, label) {
    return suffixed(name, label);
  }

  /* "Update Available (v1.5)" - the version being OFFERED, never the one held. */
  function updateAvailable(label) {
    return suffixed("Update Available", label);
  }

  return {
    courseVersion: courseVersion,
    watchVersion: watchVersion,
    assetLabel: assetLabel,
    stampFor: stampFor,
    suffixed: suffixed,
    withName: withName,
    updateAvailable: updateAvailable
  };
});

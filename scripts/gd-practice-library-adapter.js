/* Clarity-native shot rows -> Clarity Shot Library payload.
 *
 * THE contract seam. Every ingestion path (pasted CSV, uploaded file, emailed
 * CSV, and in time the photo scanner) produces Clarity-native rows; this is the
 * one place those rows become the library's clubGroups/metrics shape. One
 * mapping, written down once, instead of each importer inventing its own.
 *
 * It is deliberately dependency-injected rather than reaching for globals
 * directly, so the mapping can be tested headlessly without a browser:
 *   deps.metricForKey(key, value)  - gdLmMetricForKey, the alias/normalise step
 *   deps.clubBaselineM(club)       - gdClarityClubBaselineM, the bag distance
 *
 * Two conventions this file must not break:
 *   - Direction: left is negative on both sides of the seam (offline, sideSpin,
 *     sideAngle), so signs pass through untouched.
 *   - expectedDistanceM is the BAG BASELINE, never the shot's own carry.
 *     expectedDistanceM feeds depth (carry - expected), the distance-viability
 *     gate and the plot's %-of-bag scaling; setting it to carry zeroes every
 *     depth and draws the shots in a vertical line.
 */
(function () {
  'use strict';

  /* Clarity-native field -> library metric key. Anything absent from this table
     is not carried across, on purpose:
       side, targetLine   labels, not measurements
       curve              no library metric exists for it
       spin               a bare "spin" column means backspin on some monitors
                          and total spin on others. The parser records it as
                          stated; guessing which one it is here would put a
                          number the source never gave into the library, so it
                          stays out until the source tells us which it is.
     Add a row here only when the two sides genuinely mean the same thing. */
  var NATIVE_TO_LIBRARY_METRIC = {
    carryDistance: 'carry',
    totalDistance: 'total',
    offlineDistance: 'offline',
    ballSpeed: 'ballSpeed',
    clubSpeed: 'clubSpeed',
    launchAngle: 'launch',
    backspin: 'backspin',
    sideSpin: 'sideSpin',
    totalSpin: 'totalSpin',
    spinAxis: 'spinAxis',
    faceAngle: 'faceAngle',
    pathAngle: 'clubPath',
    faceToPath: 'faceToPath',
    startDirection: 'launchDirection'
  };

  var NATIVE_FIELDS = Object.keys(NATIVE_TO_LIBRARY_METRIC);

  function cleanClub(value, fallback) {
    var club = String(value === null || value === undefined ? '' : value).trim();
    return club || fallback || 'Unknown';
  }

  function defaultMetricForKey(key, value) {
    return typeof window !== 'undefined' && typeof window.gdLmMetricForKey === 'function'
      ? window.gdLmMetricForKey(key, value, { strict: false })
      : null;
  }

  function defaultClubBaselineM(club) {
    return typeof window !== 'undefined' && typeof window.gdClarityClubBaselineM === 'function'
      ? window.gdClarityClubBaselineM(club)
      : 155;
  }

  /* rows: Clarity-native shots (the shape gd-practice-parser-core produces).
     Rows carrying errors are left out - they are the rejected pile, and the
     caller is told how many there were rather than finding out by counting. */
  function nativeRowsToLibraryPayload(rows, opts, deps) {
    opts = opts || {};
    deps = deps || {};
    var metricForKey = typeof deps.metricForKey === 'function' ? deps.metricForKey : defaultMetricForKey;
    var clubBaselineM = typeof deps.clubBaselineM === 'function' ? deps.clubBaselineM : defaultClubBaselineM;

    var clubGroups = [];
    var rejectedRows = [];

    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row) return;
      if (Array.isArray(row.errors) && row.errors.length) {
        rejectedRows.push({ club: cleanClub(row.club, ''), errors: row.errors.slice() });
        return;
      }
      var club = cleanClub(row.club, opts.club);
      var metrics = [];
      NATIVE_FIELDS.forEach(function (field) {
        var value = row[field];
        /* null must not pass: Number(null) is 0, which is finite, and a zero
           carry is a very different claim from a missing one. */
        if (value === null || value === undefined || value === '') return;
        if (!Number.isFinite(Number(value))) return;
        var metric = metricForKey(NATIVE_TO_LIBRARY_METRIC[field], Number(value));
        if (metric) metrics.push(metric);
      });
      if (!metrics.length) {
        rejectedRows.push({ club: club, errors: ['no_library_metrics'] });
        return;
      }
      clubGroups.push({
        originClubLabel: club,
        candidateClub: club,
        expectedDistanceM: clubBaselineM(club),
        metrics: metrics
      });
    });

    return {
      label: opts.label || 'Practice import',
      /* Must stay a value captureDisplayLane() in gd-launch-monitor-data.js
         counts as practice evidence. An unlisted type imports fine and then
         never appears on the Practice Data screen, which looks exactly like
         the import having failed. dev/practice-library-adapter.test.js holds
         the two files to the same list. */
      inputType: opts.inputType || 'native-csv',
      timestamp: opts.timestamp || new Date().toISOString(),
      sourceIdentity: opts.sourceIdentity || {
        providerGuess: opts.provider || 'clarity_native',
        confidence: opts.provider ? 0.9 : 0.7,
        evidence: [opts.label || 'Clarity-native practice rows']
      },
      /* Carried for the record, not acted on here: the library stores distances
         as metres, and an imperial batch is not converted at this seam. The
         batch says what it is so the layer that does the conversion can see it. */
      unitSystem: opts.unitSystem || null,
      sessionDate: opts.sessionDate || null,
      rawTextBlocks: Array.isArray(opts.rawTextBlocks) ? opts.rawTextBlocks : [],
      clubGroups: clubGroups,
      rejectedRows: rejectedRows
    };
  }

  var api = {
    NATIVE_TO_LIBRARY_METRIC: NATIVE_TO_LIBRARY_METRIC,
    nativeRowsToLibraryPayload: nativeRowsToLibraryPayload
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.GDPracticeLibraryAdapter = api;
    window.GolfDaddy = window.GolfDaddy || {};
    window.GolfDaddy.modules = window.GolfDaddy.modules || {};
    window.GolfDaddy.modules.practiceLibraryAdapter = api;
  }
})();

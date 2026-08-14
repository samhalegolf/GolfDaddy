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

  /* The unit the library stores each metric in (from the alias registry's
     metricConfig). Distances are metres; speeds are not all the same, which is
     why this is a table and not a constant. */
  var LIBRARY_METRIC_UNIT = {
    carry: 'm',
    total: 'm',
    offline: 'm',
    ballSpeed: 'mph',
    clubSpeed: 'm/s',
    launch: 'deg',
    backspin: 'rpm',
    sideSpin: 'rpm',
    totalSpin: 'rpm',
    spinAxis: 'deg',
    faceAngle: 'deg',
    clubPath: 'deg',
    faceToPath: 'deg',
    launchDirection: 'deg'
  };

  /* Only the distance fields take their unit from the batch's declared system.
     A speed or an angle has to state its own unit or go unconverted. */
  var DISTANCE_FIELDS = { carryDistance: true, totalDistance: true, offlineDistance: true };

  var IN_METRES = { m: 1, cm: 0.01, km: 1000, yd: 0.9144, ft: 0.3048, in: 0.0254 };
  var IN_METRES_PER_SECOND = { 'm/s': 1, mph: 0.44704, kph: 1 / 3.6 };

  function round2(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  /* Returns the converted number, or null when no conversion applies - which
     covers the case that matters most: a source that never said what unit it
     was in is left exactly as it was. We convert what we were told; we do not
     convert what we guessed. */
  function convertValue(value, fromUnit, toUnit) {
    if (!fromUnit || !toUnit || fromUnit === toUnit) return null;
    if (IN_METRES[fromUnit] && IN_METRES[toUnit]) return round2(value * IN_METRES[fromUnit] / IN_METRES[toUnit]);
    if (IN_METRES_PER_SECOND[fromUnit] && IN_METRES_PER_SECOND[toUnit]) {
      return round2(value * IN_METRES_PER_SECOND[fromUnit] / IN_METRES_PER_SECOND[toUnit]);
    }
    return null;
  }

  /* What unit the source stated for this field: the per-field hint the parser
     read off a header or a cell first, then the batch's declared system for
     distances. An undeclared batch yields '' and nothing is converted. */
  function sourceUnitFor(field, opts) {
    var hint = (opts.unitHints || {})[field];
    if (hint) return hint;
    if (!DISTANCE_FIELDS[field]) return '';
    if (opts.unitSystem === 'imperial') return 'yd';
    if (opts.unitSystem === 'metric') return 'm';
    return '';
  }

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
    var conversions = {};

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
        var number = Number(value);
        var libraryKey = NATIVE_TO_LIBRARY_METRIC[field];
        var sourceUnit = sourceUnitFor(field, opts);
        var targetUnit = LIBRARY_METRIC_UNIT[libraryKey] || '';
        var converted = convertValue(number, sourceUnit, targetUnit);
        var metric = metricForKey(libraryKey, converted === null ? number : converted);
        if (!metric) return;
        if (converted !== null) {
          /* The library holds the converted number because that is the unit it
             stores in. The number the source actually wrote stays on the metric
             beside it, so the import can always be read back against the file
             it came from rather than taken on trust. */
          metric.rawValue = String(number);
          metric.sourceValue = number;
          metric.sourceUnit = sourceUnit;
          metric.convertedTo = targetUnit;
          conversions[field] = { field: field, metric: libraryKey, from: sourceUnit, to: targetUnit };
        }
        metrics.push(metric);
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
      /* 'unknown' when the source never named a monitor - importCapture treats
         that as "fingerprint it yourself" and reads the text. Putting a
         made-up provider here would stop that and leave every native import
         permanently attributed to a monitor nobody used. */
      sourceIdentity: opts.sourceIdentity || {
        providerGuess: opts.provider || 'unknown',
        confidence: opts.provider ? 0.9 : 0,
        evidence: [opts.label || 'Clarity-native practice rows']
      },
      /* The unit system the SOURCE was in. The values above are in the
         library's units - unitConversions says which fields were changed on the
         way through and from what. */
      unitSystem: opts.unitSystem || null,
      unitConversions: Object.keys(conversions).map(function (field) { return conversions[field]; }),
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

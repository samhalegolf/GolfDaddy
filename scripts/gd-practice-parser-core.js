/* Practice import parser - the single implementation.
 *
 * This file is loaded two ways and must stay portable between them:
 *   - browser, via <script> in index.html, as window.GDPracticeParserCore
 *   - Netlify function, via require("../scripts/gd-practice-parser-core.js")
 *     from functions/practice-data-parser.js
 *
 * It previously existed as two hand-maintained copies - one in functions/, one
 * in scripts/ - which had already drifted (alias table, dead spin-axis cleanup,
 * different player-scope fallbacks). A parser that decides what a launch
 * monitor's CSV means cannot have two versions of that opinion, because the
 * server stages the import and the browser previews it and they must agree on
 * every row. Hence one file, and the two callers inject only what genuinely
 * differs between the platforms.
 *
 * The two injection points, and nothing else:
 *   createId     - crypto.randomUUID on the server, Math.random in the browser
 *   resolveScope - the browser resolves the active player from session state;
 *                  the server is told who the player is by its caller
 *
 * Keep this file free of platform APIs (no localStorage, no crypto, no window
 * beyond the export tail). Everything above the export tail is pure.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GDPracticeParserCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;

  var VALID_STATUSES = {
    imported: true,
    native_valid: true,
    native_invalid: true,
    ready_for_gate: true,
    rejected: true
  };

  /* Header text -> canonical field. Lookup goes through fieldKey(), which
     strips punctuation and parenthesised units, so "Carry (m)", "carry_m" and
     "CarryM" all land on the same entry. Entries containing separators are
     therefore unreachable but harmless - they are kept so this table remains a
     superset of both former copies. */
  var FIELD_ALIASES = {
    club: 'club',
    clubname: 'club',
    shot: 'shotNumber',
    shotno: 'shotNumber',
    shotnumber: 'shotNumber',
    shotid: 'shotNumber',
    ball: 'ballSpeed',
    ballspeed: 'ballSpeed',
    bs: 'ballSpeed',
    ballspd: 'ballSpeed',
    clubspeed: 'clubSpeed',
    chs: 'clubSpeed',
    clubspd: 'clubSpeed',
    launch: 'launchAngle',
    launchangle: 'launchAngle',
    launchangledeg: 'launchAngle',
    spin: 'spin',
    spinrate: 'spin',
    backspin: 'backspin',
    sidespin: 'sideSpin',
    side_spin: 'sideSpin',
    sidespinrpm: 'sideSpin',
    totalspin: 'totalSpin',
    total_spin: 'totalSpin',
    spinaxis: 'spinAxis',
    carry: 'carryDistance',
    carrydistance: 'carryDistance',
    carrydistancey: 'carryDistance',
    carrym: 'carryDistance',
    total: 'totalDistance',
    totaldistance: 'totalDistance',
    totaldistm: 'totalDistance',
    totalm: 'totalDistance',
    offline: 'offlineDistance',
    offlinedistance: 'offlineDistance',
    offdistance: 'offlineDistance',
    offdist: 'offlineDistance',
    lr: 'offlineDistance',
    left: 'offlineDistance',
    right: 'offlineDistance',
    side: 'side',
    face: 'faceAngle',
    faceangle: 'faceAngle',
    faceangledeg: 'faceAngle',
    path: 'pathAngle',
    pathangle: 'pathAngle',
    clubpath: 'pathAngle',
    pathangledeg: 'pathAngle',
    facetopath: 'faceToPath',
    f2p: 'faceToPath',
    start: 'startDirection',
    startdirection: 'startDirection',
    startdirectiondeg: 'startDirection',
    startdir: 'startDirection',
    curve: 'curve',
    target: 'targetLine',
    targetline: 'targetLine',
    date: 'hitAt',
    shotdate: 'hitAt',
    sessiondate: 'hitAt',
    datetime: 'hitAt',
    timestamp: 'hitAt',
    time: 'hitAt',
    hittime: 'hitAt',
    hitat: 'hitAt',
    playedat: 'hitAt'
  };

  var FIELD_LABELS = {
    club: 'club',
    shotNumber: 'shot',
    carryDistance: 'carry',
    totalDistance: 'total',
    offlineDistance: 'offline',
    ballSpeed: 'ball speed',
    clubSpeed: 'club speed',
    launchAngle: 'launch',
    spin: 'spin',
    sideSpin: 'side spin',
    totalSpin: 'total spin',
    backspin: 'backspin',
    spinAxis: 'spin axis',
    faceAngle: 'face',
    pathAngle: 'path',
    faceToPath: 'face-to-path',
    startDirection: 'start',
    curve: 'curve',
    targetLine: 'target',
    side: 'side',
    hitAt: 'shot time'
  };

  var NUMERIC_FIELDS = {
    shotNumber: true,
    carryDistance: true,
    totalDistance: true,
    offlineDistance: true,
    ballSpeed: true,
    clubSpeed: true,
    launchAngle: true,
    spin: true,
    sideSpin: true,
    totalSpin: true,
    backspin: true,
    spinAxis: true,
    faceAngle: true,
    pathAngle: true,
    faceToPath: true,
    startDirection: true,
    curve: true
  };

  /* Column order assumed when a file arrives with no usable header row. */
  var HEADERLESS_DEFAULTS = ['club', 'carryDistance', 'totalDistance', 'offlineDistance', 'faceAngle', 'pathAngle', 'startDirection'];

  /* ---------------------------------------------------------------------
     Unit system.

     A row reading "7 Iron,142,151" is meaningless on its own: 142 yards is a
     good amateur 7-iron and 142 metres is tour level, and nothing downstream
     can recover which was meant. So the unit is read from the source where the
     source states it, and where it does not, the batch records that it does
     not know. It is never inferred from the magnitude of the numbers - that is
     a guess dressed as a measurement, and it would be wrong for exactly the
     strong players whose data matters most.

     An unknown unit does NOT hold up the import - see batchGateStatus. It
     stops distance metrics being computed for that batch, and it shows up in
     the report's coverage footer. Nothing else.

     Only DISTANCE units set the batch's unit system. Speed and height units
     are recorded per field but deliberately do not vote, because mixed
     conventions are normal and legitimate: monitors routinely report carry in
     metres and apex in feet, and that is not a conflict.
     --------------------------------------------------------------------- */

  var UNIT_TOKENS = {
    m: { system: 'metric', kind: 'distance', unit: 'm' },
    meter: { system: 'metric', kind: 'distance', unit: 'm' },
    meters: { system: 'metric', kind: 'distance', unit: 'm' },
    metre: { system: 'metric', kind: 'distance', unit: 'm' },
    metres: { system: 'metric', kind: 'distance', unit: 'm' },
    cm: { system: 'metric', kind: 'distance', unit: 'cm' },
    km: { system: 'metric', kind: 'distance', unit: 'km' },
    y: { system: 'imperial', kind: 'distance', unit: 'yd' },
    yd: { system: 'imperial', kind: 'distance', unit: 'yd' },
    yds: { system: 'imperial', kind: 'distance', unit: 'yd' },
    yard: { system: 'imperial', kind: 'distance', unit: 'yd' },
    yards: { system: 'imperial', kind: 'distance', unit: 'yd' },
    ft: { system: 'imperial', kind: 'distance', unit: 'ft' },
    foot: { system: 'imperial', kind: 'distance', unit: 'ft' },
    feet: { system: 'imperial', kind: 'distance', unit: 'ft' },
    inch: { system: 'imperial', kind: 'distance', unit: 'in' },
    inches: { system: 'imperial', kind: 'distance', unit: 'in' },
    mph: { system: 'imperial', kind: 'speed', unit: 'mph' },
    kph: { system: 'metric', kind: 'speed', unit: 'kph' },
    kmh: { system: 'metric', kind: 'speed', unit: 'kph' },
    'km/h': { system: 'metric', kind: 'speed', unit: 'kph' },
    'm/s': { system: 'metric', kind: 'speed', unit: 'm/s' },
    mps: { system: 'metric', kind: 'speed', unit: 'm/s' },
    ms: { system: 'metric', kind: 'speed', unit: 'm/s' },
    rpm: { system: '', kind: 'spin', unit: 'rpm' },
    deg: { system: '', kind: 'angle', unit: 'deg' },
    degree: { system: '', kind: 'angle', unit: 'deg' },
    degrees: { system: '', kind: 'angle', unit: 'deg' }
  };

  /* Aliases that carry their unit inside the field name itself, which
     fieldKey() would otherwise flatten away ("Carry Distance (y)" -> yards). */
  var ALIAS_UNIT_TOKENS = {
    carrym: 'm',
    totalm: 'm',
    totaldistm: 'm',
    carrydistancey: 'yd'
  };

  /* Fields whose unit decides the batch's declared system. */
  var UNIT_SYSTEM_FIELDS = { carryDistance: true, totalDistance: true, offlineDistance: true };

  /* Launch monitors, matched against the file name and any hint the caller
     passes (an email subject, say). Unknown stays unknown - the point of the
     column is to let rules skip monitors that cannot measure what they test,
     and a wrong provider is worse than no provider. */
  var PROVIDER_PATTERNS = [
    { provider: 'trackman', re: /trackman|\btm4\b/i },
    { provider: 'foresight', re: /foresight|gc\s?quad|gcquad|gc\s?hawk|gchawk|gc3|gc2/i },
    { provider: 'flightscope', re: /flightscope|mevo/i },
    { provider: 'skytrak', re: /sky\s?trak/i },
    { provider: 'garmin', re: /garmin|approach\s?r10|\br10\b/i },
    { provider: 'rapsodo', re: /rapsodo|mlm2pro|mlm\s?2/i },
    { provider: 'uneekor', re: /uneekor|eye\s?xo|qed/i },
    { provider: 'bushnell', re: /bushnell|launch\s?pro/i },
    { provider: 'square_golf', re: /square\s?golf/i },
    { provider: 'voice_caddie', re: /voice\s?caddie|sc4|sc300/i },
    { provider: 'ernest', re: /ernest\s?sports|\bes\s?tour\b/i },
    { provider: 'full_swing', re: /full\s?swing\s?kit|fullswing/i }
  ];

  function nowIso() {
    return new Date().toISOString();
  }

  function cleanString(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function asNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var cleaned = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
    var n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function fieldKey(value) {
    return String(value || '').trim().toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '');
  }

  /* Unit tokens longest-first, so "inches" is stripped before "in" and
     "yards" before "y". */
  var UNIT_SUFFIXES = Object.keys(UNIT_TOKENS)
    .map(function (token) { return token.replace(/[^a-z0-9]/g, ''); })
    .filter(Boolean)
    .sort(function (a, b) { return b.length - a.length; });

  function canonicalField(name) {
    var key = fieldKey(name);
    var direct = FIELD_ALIASES[key];
    if (direct) return direct;
    /* "Carry_yards" flattens to "carryyards", which matches nothing. Strip a
       trailing unit and retry, so a header that states its unit inline still
       maps to the field instead of falling through to unknown. */
    for (var i = 0; i < UNIT_SUFFIXES.length; i += 1) {
      var suffix = UNIT_SUFFIXES[i];
      if (key.length > suffix.length && key.slice(-suffix.length) === suffix) {
        var stripped = FIELD_ALIASES[key.slice(0, -suffix.length)];
        if (stripped) return stripped;
      }
    }
    return '';
  }

  function fieldLabel(field) {
    return FIELD_LABELS[field] || field;
  }

  function isNumericField(field) {
    return !!NUMERIC_FIELDS[field];
  }

  function splitDelimitedLine(line) {
    var cells = [];
    var cell = '';
    var quoted = false;
    for (var i = 0; i < line.length; i += 1) {
      var ch = line.charAt(i);
      var next = line.charAt(i + 1);
      if (ch === '"' && quoted && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function splitPracticeLine(line, delimiter) {
    if (delimiter === ',') return splitDelimitedLine(line);
    return String(line || '').trim().split(/\t|\s{2,}|[|;]/).map(function (cell) {
      return cell.trim();
    });
  }

  function detectDelimiter(lines) {
    var candidates = [',', '\t', ';', '|'];
    var scores = { ',': 0, '\t': 0, ';': 0, '|': 0 };
    (Array.isArray(lines) ? lines : []).slice(0, 25).forEach(function (line) {
      if (!String(line).trim()) return;
      var text = String(line);
      candidates.forEach(function (candidate) {
        scores[candidate] += text.split(candidate).length - 1;
      });
    });
    var best = ',';
    var bestScore = -1;
    candidates.forEach(function (candidate) {
      if (scores[candidate] > bestScore) {
        bestScore = scores[candidate];
        best = candidate;
      }
    });
    return bestScore > 0 ? best : ',';
  }

  function looksLikeHeader(cells) {
    var known = 0;
    cells.forEach(function (cell) {
      if (canonicalField(cell)) known += 1;
    });
    return known >= 2 || (known >= 1 && cells.some(function (cell) {
      return /club|carry|total|offline|face|path/i.test(cell);
    }));
  }

  /* The unit token a header states, if any: "Carry (m)", "Carry [yds]",
     "carry_yards", "Ball Speed mph". Returns '' when the header is silent. */
  function unitTokenFromHeader(rawHeader) {
    var text = cleanString(rawHeader).toLowerCase();
    if (!text) return '';
    var bracketed = text.match(/[([{]\s*([^)\]}]+?)\s*[)\]}]/);
    if (bracketed && UNIT_TOKENS[bracketed[1]]) return bracketed[1];
    var trailing = text.match(/[\s_\-.]([a-z/]{1,6})$/);
    if (trailing && UNIT_TOKENS[trailing[1]]) return trailing[1];
    var aliasToken = ALIAS_UNIT_TOKENS[fieldKey(rawHeader)];
    if (aliasToken && UNIT_TOKENS[aliasToken]) return aliasToken;
    return '';
  }

  function unitFromHeader(rawHeader) {
    var token = unitTokenFromHeader(rawHeader);
    return token ? UNIT_TOKENS[token] : null;
  }

  /* Decide the batch's unit system from the distance columns. Returns a null
     system rather than a default when the headers are silent or disagree - the
     caller is expected to hold the batch, not to pick one. */
  function resolveUnitSystem(columns, opts) {
    opts = opts || {};
    var hints = {};
    var systems = {};
    (Array.isArray(columns) ? columns : []).forEach(function (column) {
      if (!column.unit) return;
      hints[column.key] = column.unit.unit;
      if (column.unit.system && UNIT_SYSTEM_FIELDS[column.key]) systems[column.unit.system] = true;
    });
    var found = Object.keys(systems);

    /* An explicit declaration from the caller outranks the headers: it comes
       from a provider profile or an operator who knows the source, whereas a
       header is only a label someone typed. */
    var declared = cleanString(opts.unitSystem).toLowerCase();
    if (declared === 'metric' || declared === 'imperial') {
      return { unitSystem: declared, unitSource: 'declared', unitHints: hints, unitConflict: false };
    }

    if (found.length === 1) return { unitSystem: found[0], unitSource: 'header', unitHints: hints, unitConflict: false };
    if (found.length > 1) return { unitSystem: null, unitSource: '', unitHints: hints, unitConflict: true };
    return { unitSystem: null, unitSource: '', unitHints: hints, unitConflict: false };
  }

  /* Only unambiguous date forms are accepted. "07/08/2026" is either 7 August
     or 8 July depending on where the file was written, and a session dated six
     months wrong is worse than a session with no date at all - the undated
     batch is visibly incomplete, the misdated one silently poisons every trend
     it appears in. Locale formats therefore need a per-provider declaration,
     the same way units do. */
  function parseShotDate(value) {
    var text = cleanString(value);
    if (!text) return null;
    var match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var date = year + '-' + pad(month) + '-' + pad(day);
    var time = match[4] ? pad(Number(match[4])) + ':' + match[5] + ':' + (match[6] || '00') : '';
    return { date: date, iso: time ? date + 'T' + time : date };
  }

  function detectProvider(/* ...candidates */) {
    var haystack = Array.prototype.slice.call(arguments).map(cleanString).join(' ');
    if (!haystack.trim()) return '';
    for (var i = 0; i < PROVIDER_PATTERNS.length; i += 1) {
      if (PROVIDER_PATTERNS[i].re.test(haystack)) return PROVIDER_PATTERNS[i].provider;
    }
    return '';
  }

  function buildColumns(cells, useDefaults) {
    var columns = [];
    var used = {};
    for (var i = 0; i < (cells || []).length; i += 1) {
      var rawHeader = cleanString(cells[i]);
      var key = useDefaults ? (HEADERLESS_DEFAULTS[i] || ('unknown' + (i + 1))) : canonicalField(rawHeader);
      if (!key) key = 'unknown' + (i + 1);
      if (!useDefaults && used[key]) key = 'unknown' + (i + 1);
      else used[key] = true;
      columns.push({
        index: i,
        key: key,
        rawHeader: rawHeader,
        assigned: key.indexOf('unknown') !== 0,
        /* A headerless file has no labels to read a unit off, so its columns
           stay silent rather than inheriting the defaults' notional units. */
        unit: useDefaults ? null : unitFromHeader(rawHeader)
      });
    }
    return columns;
  }

  function hasMappedHeaders(columns) {
    return (Array.isArray(columns) ? columns : []).some(function (column) {
      return column.assigned;
    });
  }

  function inferClubValue(value) {
    var text = cleanString(value).toLowerCase();
    if (!text) return '';
    if (/\d/.test(text) && /[a-z]/i.test(text)) return cleanString(value);
    if (/^(sw|lw|mw|rw|gw|pw|u|driver|iron|wedge|wood|hybrid|hyb|putter|fw|uw|iw|[0-9]+i?)$/i.test(text)) return cleanString(value);
    if (/^[0-9]+\s*(i|w|iron|wedge|wood)$/i.test(text)) return cleanString(value);
    return '';
  }

  function parseClub(value) {
    var text = inferClubValue(value);
    return text ? cleanString(text) : '';
  }

  /* Sign convention: negative offline = left. An explicit side column wins over
     the sign, because a source that ships "6" plus "L" means left and the
     number carries no sign to read. Note this only labels the shot - the stored
     offlineDistance keeps whatever sign the source gave it. */
  function sideFromOffline(value, explicitSide) {
    var side = cleanString(explicitSide).toLowerCase();
    if (side === 'left' || side === 'l') return 'left';
    if (side === 'right' || side === 'r') return 'right';
    if (Number.isFinite(Number(value))) {
      if (Number(value) < 0) return 'left';
      if (Number(value) > 0) return 'right';
    }
    return '';
  }

  /* Spin axis when the monitor reported the spin components but not the axis.
     Skipped when the source gave an axis directly, and when backspin is too
     small to make the ratio meaningful. */
  function deriveRowMetrics(row) {
    var derived = {};
    if (Number.isFinite(Number(row.spinAxis))) return derived;
    var sideSpin = asNumber(row.sideSpin);
    var backspin = asNumber(row.backspin) || asNumber(row.totalSpin);
    if (!Number.isFinite(sideSpin) || !Number.isFinite(backspin) || Math.abs(backspin) <= 100) return derived;
    var axis = Math.atan2(sideSpin, Math.abs(backspin)) * 180 / Math.PI;
    if (Number.isFinite(axis)) derived.spinAxis = Math.round(axis * 100) / 100;
    return derived;
  }

  function parsePracticeImportText(text, opts) {
    opts = opts || {};
    var rawText = String(text || '');
    var sourceLines = rawText
      .split(/\r?\n/)
      .map(function (line, index) {
        return { text: String(line || '').trim(), lineNumber: index + 1 };
      })
      .filter(function (line) {
        return !!line.text;
      });
    var warnings = [];

    if (!sourceLines.length) {
      return {
        rows: [],
        warnings: ['empty_input'],
        errors: ['No rows detected'],
        sourceType: opts.sourceType || 'text',
        rawText: rawText,
        unitSystem: null,
        unitSource: '',
        unitHints: {},
        provider: '',
        sessionDate: null
      };
    }

    var delimiter = detectDelimiter(sourceLines.map(function (line) { return line.text; }));
    var firstCells = splitPracticeLine(sourceLines[0].text, delimiter);
    var hasHeader = opts.headers === true || (opts.headers !== false && looksLikeHeader(firstCells));
    var columns = buildColumns(firstCells, !hasHeader);
    if (!hasHeader) warnings.push('header_inferred');

    if (hasHeader && !hasMappedHeaders(columns)) {
      warnings.push('Unknown headers');
      hasHeader = false;
      columns = buildColumns(firstCells, true);
    }

    var dataLines = hasHeader ? sourceLines.slice(1) : sourceLines;
    var headers = columns.map(function (column) { return column.key; });

    var units = resolveUnitSystem(columns, opts);
    if (units.unitConflict) warnings.push('unit_system_conflict');
    if (!units.unitSystem) warnings.push('unit_system_undeclared');

    var provider = cleanString(opts.provider) || detectProvider(opts.sourceName, opts.providerHint, sourceLines[0].text);
    var shotDates = [];

    var rows = dataLines
      .map(function (line, index) {
        var cells = splitPracticeLine(line.text, delimiter);
        if (!cells.length || !cells.some(function (cell) { return cleanString(cell); })) return null;

        /* rawSource is the audit trail: the original line, the cell each value
           came from, and the header it was read under. Downstream work is
           allowed to disagree with our parse, so keep the evidence. */
        var rawSource = {
          line: line.text,
          lineNumber: line.lineNumber,
          lineIndex: index,
          rowIndex: hasHeader ? index + 2 : index + 1,
          cells: {},
          cutouts: []
        };

        var unknownFields = {};
        var row = {
          rawSource: rawSource,
          sourceType: opts.sourceType || 'text',
          rowIndex: line.lineNumber,
          errors: [],
          warnings: [],
          derivedMetrics: {}
        };
        var knownFieldCount = 0;

        columns.forEach(function (column, cellIndex) {
          var rawValue = cleanString(cells[cellIndex]);
          rawSource.cells[column.key] = rawValue;
          rawSource.cutouts.push({
            index: column.index,
            key: column.key,
            header: column.rawHeader,
            raw: rawValue
          });

          if (!rawValue) return;

          if (column.key.indexOf('unknown') === 0) {
            unknownFields[column.key] = rawValue;
            return;
          }

          if (column.key === 'club') {
            knownFieldCount += 1;
            row.club = parseClub(rawValue) || rawValue;
            return;
          }

          if (isNumericField(column.key)) {
            var numericValue = asNumber(rawValue);
            if (numericValue === null) {
              row.errors.push('Invalid ' + fieldLabel(column.key));
              return;
            }
            row[column.key] = numericValue;
            knownFieldCount += 1;
            return;
          }

          knownFieldCount += 1;
          row[column.key] = rawValue;
        });

        for (var extraIndex = columns.length; extraIndex < cells.length; extraIndex += 1) {
          var extraValue = cleanString(cells[extraIndex]);
          if (!extraValue) continue;
          var extraKey = 'unknown' + (extraIndex + 1);
          unknownFields[extraKey] = extraValue;
          rawSource.cells[extraKey] = extraValue;
          rawSource.cutouts.push({ index: extraIndex, key: extraKey, header: '', raw: extraValue });
        }

        if (row.hitAt) {
          var shotDate = parseShotDate(row.hitAt);
          if (shotDate) {
            row.hitAt = shotDate.iso;
            shotDates.push(shotDate.date);
          } else {
            /* Keep the original text - it is still evidence of when the shot
               was hit, just not in a form we will date a session from. */
            row.warnings.push('Unrecognised shot time format');
          }
        }

        if (!row.club) {
          var inferredClub = parseClub(cells[0]);
          if (inferredClub) {
            row.club = inferredClub;
            row.warnings.push('Club inferred from first column');
          }
        }

        if (Object.keys(unknownFields).length) {
          row.warnings.push('Unknown fields');
          row.unknownFields = unknownFields;
        }

        if (!row.club || (!Number.isFinite(Number(row.carryDistance)) && !Number.isFinite(Number(row.totalDistance)))) {
          row.errors.push('Missing required fields');
        }

        if (!knownFieldCount) row.errors.push('No valid row fields');

        var derived = deriveRowMetrics(row);
        if (Object.keys(derived).length) row.derivedMetrics = derived;

        row.errors = Array.from(new Set(row.errors));
        row.warnings = Array.from(new Set(row.warnings));
        if (!Object.keys(unknownFields).length) row.unknownFields = {};

        return row;
      })
      .filter(function (row) { return !!row; });

    /* A session is dated by its earliest shot. Sorting strings is safe here
       because parseShotDate only ever emits YYYY-MM-DD. */
    var declaredSessionDate = parseShotDate(opts.sessionDate);
    var sessionDate = declaredSessionDate
      ? declaredSessionDate.date
      : (shotDates.length ? shotDates.slice().sort()[0] : null);

    return {
      rows: rows,
      warnings: warnings,
      sourceType: opts.sourceType || 'text',
      sourceName: opts.sourceName || '',
      rawText: rawText,
      hasHeader: hasHeader,
      headers: headers,
      columns: columns,
      delimiter: delimiter,
      unitSystem: units.unitSystem,
      unitSource: units.unitSource,
      unitHints: units.unitHints,
      provider: provider,
      sessionDate: sessionDate,
      sessionDateSource: declaredSessionDate ? 'declared' : (sessionDate ? 'shot_times' : ''),
      errors: rows.length ? [] : ['No rows detected']
    };
  }

  function validateNativePracticeShot(input) {
    var shot = Object.assign({}, input || {});
    var errors = Array.isArray(shot.errors) ? shot.errors.slice() : [];
    var warnings = Array.isArray(shot.warnings) ? shot.warnings.slice() : [];
    /* Compare against null, not through Number(): a missing distance is null,
       and Number(null) is 0, which is finite and <= 0. Reading it that way
       made every carry-only row fail as "invalid total distance" - so a file
       from any monitor that reports carry without total produced zero valid
       rows and a misleading reason. */
    var carry = asNumber(shot.carryDistance);
    var total = asNumber(shot.totalDistance);
    if (!cleanString(shot.club)) errors.push('missing_club');
    if (carry === null && total === null) errors.push('missing_distance');
    if (carry !== null && carry <= 0) errors.push('invalid_carry_distance');
    if (total !== null && total <= 0) errors.push('invalid_total_distance');
    if (asNumber(shot.offlineDistance) === null) warnings.push('missing_offline_distance');
    shot.errors = Array.from(new Set(errors));
    shot.warnings = Array.from(new Set(warnings));
    shot.status = shot.errors.length ? 'native_invalid' : 'native_valid';
    shot.updatedAt = nowIso();
    return shot;
  }

  /* Whether an import staged. This asks one question only - did the file read
     cleanly - because that is the only question the import step is qualified
     to answer. Provenance we could not establish is recorded, not enforced:
     an unlabelled source is still the player's data, and holding it back would
     block a coach over a header someone forgot to type.

     The protection that matters lives downstream instead, where it is precise:
     rules declare `require_unit_declared` and simply do not fire on a batch
     whose unit is unknown, and the report's coverage footer names those
     batches so the coach can see what was left out. A distance metric is never
     computed across mixed or unknown units - it just isn't computed at import
     time, and it isn't the importer's job to say so. */
  function batchGateStatus(batch) {
    if (!batch || !Number(batch.validCount)) return 'needs_review';
    return 'staged';
  }

  /* Provenance the source never supplied. Advisory - this gates nothing at
     import. It is what the metric layer filters on and what the report's
     coverage footer lists. */
  function batchProvenanceGaps(batch) {
    var gaps = [];
    if (!batch || !Number(batch.validCount)) gaps.push('no_valid_rows');
    if (batch && !batch.unitSystem) gaps.push('unit_system_undeclared');
    if (batch && !batch.sessionDate) gaps.push('session_date_unknown');
    if (batch && !batch.provider) gaps.push('provider_unknown');
    return gaps;
  }

  /* Portable fallback id. Both callers override this - the server with
     crypto.randomUUID, the browser with its own shorter form - so it exists
     only so the core is usable standalone (tests, node REPL). */
  function defaultCreateId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function createPracticeParser(options) {
    options = options || {};
    var createId = typeof options.createId === 'function' ? options.createId : defaultCreateId;
    var resolveScope = typeof options.resolveScope === 'function' ? options.resolveScope : function () { return {}; };

    function normalizeNativeShot(input, context) {
      input = input || {};
      context = context || {};
      /* Caller-supplied scope wins over the ambient one: an explicit import is
         being staged for a named player, whoever happens to be signed in. */
      var scope = Object.assign({}, resolveScope() || {}, context.playerScope || {});
      var created = input.createdAt || nowIso();
      return validateNativePracticeShot({
        shotId: cleanString(input.shotId) || createId('practice-shot'),
        sessionId: cleanString(input.sessionId || context.sessionId),
        playerId: cleanString(input.playerId || scope.playerId || scope.profileId),
        playerName: cleanString(input.playerName || scope.playerName || scope.name || 'Player'),
        accountId: cleanString(input.accountId || scope.accountId),
        club: cleanString(input.club),
        shotNumber: asNumber(input.shotNumber),
        hitAt: cleanString(input.hitAt),
        ballSpeed: asNumber(input.ballSpeed),
        clubSpeed: asNumber(input.clubSpeed),
        launchAngle: asNumber(input.launchAngle),
        spin: asNumber(input.spin),
        carryDistance: asNumber(input.carryDistance),
        totalDistance: asNumber(input.totalDistance),
        offlineDistance: asNumber(input.offlineDistance),
        side: sideFromOffline(input.offlineDistance, input.side),
        faceAngle: asNumber(input.faceAngle),
        pathAngle: asNumber(input.pathAngle),
        faceToPath: asNumber(input.faceToPath),
        startDirection: asNumber(input.startDirection),
        curve: asNumber(input.curve),
        targetLine: cleanString(input.targetLine),
        sideSpin: asNumber(input.sideSpin),
        totalSpin: asNumber(input.totalSpin),
        backspin: asNumber(input.backspin),
        spinAxis: asNumber(input.spinAxis),
        rawSource: input.rawSource || null,
        derivedMetrics: input.derivedMetrics && typeof input.derivedMetrics === 'object' ? Object.assign({}, input.derivedMetrics) : null,
        sourceType: cleanString(input.sourceType || context.sourceType || 'text') || 'text',
        importBatchId: cleanString(input.importBatchId || context.importBatchId),
        status: VALID_STATUSES[input.status] ? input.status : 'imported',
        schemaVersion: SCHEMA_VERSION,
        createdAt: created,
        updatedAt: input.updatedAt || created,
        errors: Array.isArray(input.errors) ? input.errors.slice() : [],
        warnings: Array.isArray(input.warnings) ? input.warnings.slice() : [],
        unknownFields: input.unknownFields && typeof input.unknownFields === 'object' ? Object.assign({}, input.unknownFields) : {}
      });
    }

    /* Returns the minimal batch/session envelope. The browser store decorates
       the result with its own local-record fields (status, deletedAt, ...);
       the server persists these columns as they are. */
    function createPracticeImportBatch(rows, source, playerScope) {
      source = source || {};
      playerScope = Object.assign({}, resolveScope() || {}, playerScope || source.playerScope || {});
      var createdAt = nowIso();
      var importBatchId = cleanString(source.importBatchId) || createId('practice-import');
      var sessionId = cleanString(source.sessionId) || createId('practice-session');
      var nativeRows = (Array.isArray(rows) ? rows : []).map(function (row, index) {
        return normalizeNativeShot(Object.assign({}, row, {
          shotNumber: Number.isFinite(Number(row && row.shotNumber)) ? Number(row.shotNumber) : index + 1,
          importBatchId: importBatchId,
          sessionId: sessionId,
          sourceType: source.sourceType || row && row.sourceType || 'text'
        }), {
          importBatchId: importBatchId,
          sessionId: sessionId,
          sourceType: source.sourceType || 'text',
          playerScope: playerScope
        });
      });
      /* Provenance the observations engine cannot work without: which unit the
         numbers are in, when the session happened, and which monitor produced
         it. Missing values stay missing - see batchGateStatus below for what
         that costs the batch. */
      var unitSystem = cleanString(source.unitSystem).toLowerCase();
      if (unitSystem !== 'metric' && unitSystem !== 'imperial') unitSystem = null;
      var sessionDateSource = cleanString(source.sessionDateSource);
      var sessionDate = parseShotDate(source.sessionDate);
      if (!sessionDate) {
        var earliest = nativeRows
          .map(function (row) { return row.hitAt; })
          .filter(Boolean)
          .sort()[0];
        sessionDate = parseShotDate(earliest);
        if (sessionDate) sessionDateSource = sessionDateSource || 'shot_times';
      }

      var batch = {
        importBatchId: importBatchId,
        sessionId: sessionId,
        sourceType: source.sourceType || 'text',
        sourceName: source.sourceName || '',
        provider: cleanString(source.provider),
        unitSystem: unitSystem,
        unitSource: unitSystem ? (cleanString(source.unitSource) || 'declared') : '',
        sessionDate: sessionDate ? sessionDate.date : null,
        sessionDateSource: sessionDate ? (sessionDateSource || 'declared') : '',
        rowCount: nativeRows.length,
        validCount: nativeRows.filter(function (row) { return !row.errors.length; }).length,
        invalidCount: nativeRows.filter(function (row) { return row.errors.length; }).length,
        createdAt: createdAt,
        updatedAt: createdAt
      };
      var session = {
        sessionId: sessionId,
        importBatchId: importBatchId,
        playerId: playerScope.playerId || playerScope.profileId || '',
        playerName: playerScope.playerName || playerScope.name || 'Player',
        accountId: playerScope.accountId || '',
        sourceType: batch.sourceType,
        sourceName: batch.sourceName,
        shotCount: nativeRows.length,
        createdAt: createdAt,
        updatedAt: createdAt
      };
      return { batch: batch, session: session, rows: nativeRows };
    }

    return {
      SCHEMA_VERSION: SCHEMA_VERSION,
      createId: createId,
      parsePracticeImportText: parsePracticeImportText,
      normalizeNativeShot: normalizeNativeShot,
      validateNativePracticeShot: validateNativePracticeShot,
      createPracticeImportBatch: createPracticeImportBatch,
      batchGateStatus: batchGateStatus,
      batchProvenanceGaps: batchProvenanceGaps
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    VALID_STATUSES: VALID_STATUSES,
    FIELD_ALIASES: FIELD_ALIASES,
    HEADERLESS_DEFAULTS: HEADERLESS_DEFAULTS,
    UNIT_TOKENS: UNIT_TOKENS,
    PROVIDER_PATTERNS: PROVIDER_PATTERNS,
    createPracticeParser: createPracticeParser,
    defaultCreateId: defaultCreateId,
    unitFromHeader: unitFromHeader,
    resolveUnitSystem: resolveUnitSystem,
    parseShotDate: parseShotDate,
    detectProvider: detectProvider,
    batchGateStatus: batchGateStatus,
    batchProvenanceGaps: batchProvenanceGaps,
    nowIso: nowIso,
    cleanString: cleanString,
    asNumber: asNumber,
    fieldKey: fieldKey,
    canonicalField: canonicalField,
    fieldLabel: fieldLabel,
    isNumericField: isNumericField,
    splitDelimitedLine: splitDelimitedLine,
    splitPracticeLine: splitPracticeLine,
    detectDelimiter: detectDelimiter,
    looksLikeHeader: looksLikeHeader,
    buildColumns: buildColumns,
    hasMappedHeaders: hasMappedHeaders,
    inferClubValue: inferClubValue,
    parseClub: parseClub,
    sideFromOffline: sideFromOffline,
    deriveRowMetrics: deriveRowMetrics,
    parsePracticeImportText: parsePracticeImportText,
    validateNativePracticeShot: validateNativePracticeShot
  };
});

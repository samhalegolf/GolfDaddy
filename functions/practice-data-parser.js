"use strict";

const crypto = require("crypto");

const SCHEMA_VERSION = 1;

const VALID_STATUSES = {
  imported: true,
  native_valid: true,
  native_invalid: true,
  ready_for_gate: true,
  rejected: true
};

const FIELD_ALIASES = {
  club: "club",
  clubname: "club",
  shot: "shotNumber",
  shotno: "shotNumber",
  shotnumber: "shotNumber",
  shotid: "shotNumber",
  ball: "ballSpeed",
  ballspeed: "ballSpeed",
  bs: "ballSpeed",
  ballspd: "ballSpeed",
  clubspeed: "clubSpeed",
  chs: "clubSpeed",
  clubspd: "clubSpeed",
  launch: "launchAngle",
  launchangle: "launchAngle",
  launchangledeg: "launchAngle",
  spin: "spin",
  spinrate: "spin",
  backspin: "backspin",
  sidespin: "sideSpin",
  sidespinrpm: "sideSpin",
  totalspin: "totalSpin",
  spinaxis: "spinAxis",
  carry: "carryDistance",
  carrydistance: "carryDistance",
  carrydistancey: "carryDistance",
  carrym: "carryDistance",
  total: "totalDistance",
  totaldistance: "totalDistance",
  totaldistm: "totalDistance",
  totalm: "totalDistance",
  offline: "offlineDistance",
  offlinedistance: "offlineDistance",
  offdistance: "offlineDistance",
  offdist: "offlineDistance",
  lr: "offlineDistance",
  left: "offlineDistance",
  right: "offlineDistance",
  side: "side",
  face: "faceAngle",
  faceangle: "faceAngle",
  faceangledeg: "faceAngle",
  path: "pathAngle",
  pathangle: "pathAngle",
  clubpath: "pathAngle",
  pathangledeg: "pathAngle",
  facetopath: "faceToPath",
  f2p: "faceToPath",
  start: "startDirection",
  startdirection: "startDirection",
  startdirectiondeg: "startDirection",
  startdir: "startDirection",
  curve: "curve",
  target: "targetLine",
  targetline: "targetLine"
};

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  if (crypto.randomUUID) return prefix + "-" + crypto.randomUUID();
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function cleanString(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = typeof value === "string" ? value.replace(/,/g, "").trim() : value;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function fieldKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, "");
}

function canonicalField(name) {
  return FIELD_ALIASES[fieldKey(name)] || "";
}

function fieldLabel(field) {
  return ({
    club: "club",
    shotNumber: "shot",
    carryDistance: "carry",
    totalDistance: "total",
    offlineDistance: "offline",
    ballSpeed: "ball speed",
    clubSpeed: "club speed",
    launchAngle: "launch",
    spin: "spin",
    sideSpin: "side spin",
    totalSpin: "total spin",
    backspin: "backspin",
    spinAxis: "spin axis",
    faceAngle: "face",
    pathAngle: "path",
    faceToPath: "face-to-path",
    startDirection: "start",
    curve: "curve",
    targetLine: "target",
    side: "side"
  })[field] || field;
}

function isNumericField(field) {
  return !!{
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
  }[field];
}

function splitDelimitedLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    const next = line.charAt(i + 1);
    if (ch === "\"" && quoted && next === "\"") {
      cell += "\"";
      i += 1;
    } else if (ch === "\"") {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function splitPracticeLine(line, delimiter) {
  if (delimiter === ",") return splitDelimitedLine(line);
  return String(line || "").trim().split(/\t|\s{2,}|[|;]/).map(function (cell) {
    return cell.trim();
  });
}

function detectDelimiter(lines) {
  const candidates = [",", "\t", ";", "|"];
  const scores = { ",": 0, "\t": 0, ";": 0, "|": 0 };
  (Array.isArray(lines) ? lines : []).slice(0, 25).forEach(function (line) {
    if (!String(line).trim()) return;
    candidates.forEach(function (candidate) {
      scores[candidate] += String(line).split(candidate).length - 1;
    });
  });
  let best = ",";
  let bestScore = -1;
  candidates.forEach(function (candidate) {
    if (scores[candidate] > bestScore) {
      bestScore = scores[candidate];
      best = candidate;
    }
  });
  return bestScore > 0 ? best : ",";
}

function looksLikeHeader(cells) {
  let known = 0;
  cells.forEach(function (cell) {
    if (canonicalField(cell)) known += 1;
  });
  return known >= 2 || (known >= 1 && cells.some(function (cell) {
    return /club|carry|total|offline|face|path/i.test(cell);
  }));
}

function buildColumns(cells, useDefaults) {
  const defaults = ["club", "carryDistance", "totalDistance", "offlineDistance", "faceAngle", "pathAngle", "startDirection"];
  const columns = [];
  const used = {};
  for (let i = 0; i < (cells || []).length; i += 1) {
    const rawHeader = cleanString(cells[i]);
    let key = useDefaults ? (defaults[i] || ("unknown" + (i + 1))) : canonicalField(rawHeader);
    if (!key) key = "unknown" + (i + 1);
    if (!useDefaults && used[key]) key = "unknown" + (i + 1);
    else used[key] = true;
    columns.push({
      index: i,
      key,
      rawHeader,
      assigned: key.indexOf("unknown") !== 0
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
  const text = cleanString(value).toLowerCase();
  if (!text) return "";
  if (/\d/.test(text) && /[a-z]/i.test(text)) return cleanString(value);
  if (/^(sw|lw|mw|rw|gw|pw|u|driver|iron|wedge|wood|hybrid|hyb|putter|fw|uw|iw|[0-9]+i?)$/i.test(text)) return cleanString(value);
  if (/^[0-9]+\s*(i|w|iron|wedge|wood)$/i.test(text)) return cleanString(value);
  return "";
}

function parseClub(value) {
  const text = inferClubValue(value);
  return text ? cleanString(text) : "";
}

function sideFromOffline(value, explicitSide) {
  const side = cleanString(explicitSide).toLowerCase();
  if (side === "left" || side === "l") return "left";
  if (side === "right" || side === "r") return "right";
  if (Number.isFinite(Number(value))) {
    if (Number(value) < 0) return "left";
    if (Number(value) > 0) return "right";
  }
  return "";
}

function deriveRowMetrics(row) {
  const derived = {};
  if (Number.isFinite(Number(row.spinAxis))) return derived;
  const sideSpin = asNumber(row.sideSpin);
  const backspin = asNumber(row.backspin) || asNumber(row.totalSpin);
  if (!Number.isFinite(sideSpin) || !Number.isFinite(backspin) || Math.abs(backspin) <= 100) return derived;
  const axis = Math.atan2(sideSpin, Math.abs(backspin)) * 180 / Math.PI;
  if (Number.isFinite(axis)) derived.spinAxis = Math.round(axis * 100) / 100;
  return derived;
}

function parsePracticeImportText(text, opts) {
  opts = opts || {};
  const rawText = String(text || "");
  const sourceLines = rawText
    .split(/\r?\n/)
    .map(function (line, index) {
      return { text: String(line || "").trim(), lineNumber: index + 1 };
    })
    .filter(function (line) {
      return !!line.text;
    });
  const warnings = [];

  if (!sourceLines.length) {
    return {
      rows: [],
      warnings: ["empty_input"],
      errors: ["No rows detected"],
      sourceType: opts.sourceType || "text",
      rawText
    };
  }

  const delimiter = detectDelimiter(sourceLines.map(function (line) { return line.text; }));
  const firstCells = splitPracticeLine(sourceLines[0].text, delimiter);
  let hasHeader = opts.headers === true || (opts.headers !== false && looksLikeHeader(firstCells));
  let columns = buildColumns(firstCells, !hasHeader);
  if (!hasHeader) warnings.push("header_inferred");

  if (hasHeader && !hasMappedHeaders(columns)) {
    warnings.push("Unknown headers");
    hasHeader = false;
    columns = buildColumns(firstCells, true);
  }

  const dataLines = hasHeader ? sourceLines.slice(1) : sourceLines;
  const headers = columns.map(function (column) { return column.key; });
  const rows = dataLines
    .map(function (line, index) {
      const cells = splitPracticeLine(line.text, delimiter);
      if (!cells.length || !cells.some(function (cell) { return cleanString(cell); })) return null;

      const rawSource = {
        line: line.text,
        lineNumber: line.lineNumber,
        lineIndex: index,
        rowIndex: hasHeader ? index + 2 : index + 1,
        cells: {},
        cutouts: []
      };
      const unknownFields = {};
      const row = {
        rawSource,
        sourceType: opts.sourceType || "text",
        rowIndex: line.lineNumber,
        errors: [],
        warnings: [],
        derivedMetrics: {}
      };
      let knownFieldCount = 0;

      columns.forEach(function (column, cellIndex) {
        const rawValue = cleanString(cells[cellIndex]);
        rawSource.cells[column.key] = rawValue;
        rawSource.cutouts.push({ index: column.index, key: column.key, header: column.rawHeader, raw: rawValue });
        if (!rawValue) return;
        if (column.key.indexOf("unknown") === 0) {
          unknownFields[column.key] = rawValue;
          return;
        }
        if (column.key === "club") {
          knownFieldCount += 1;
          row.club = parseClub(rawValue) || rawValue;
          return;
        }
        if (isNumericField(column.key)) {
          const numericValue = asNumber(rawValue);
          if (numericValue === null) {
            row.errors.push("Invalid " + fieldLabel(column.key));
            return;
          }
          row[column.key] = numericValue;
          knownFieldCount += 1;
          return;
        }
        knownFieldCount += 1;
        row[column.key] = rawValue;
      });

      for (let extraIndex = columns.length; extraIndex < cells.length; extraIndex += 1) {
        const extraValue = cleanString(cells[extraIndex]);
        if (!extraValue) continue;
        const extraKey = "unknown" + (extraIndex + 1);
        unknownFields[extraKey] = extraValue;
        rawSource.cells[extraKey] = extraValue;
        rawSource.cutouts.push({ index: extraIndex, key: extraKey, header: "", raw: extraValue });
      }

      if (!row.club) {
        const inferredClub = parseClub(cells[0]);
        if (inferredClub) {
          row.club = inferredClub;
          row.warnings.push("Club inferred from first column");
        }
      }
      if (Object.keys(unknownFields).length) {
        row.warnings.push("Unknown fields");
        row.unknownFields = unknownFields;
      }
      if (!row.club || (!Number.isFinite(Number(row.carryDistance)) && !Number.isFinite(Number(row.totalDistance)))) {
        row.errors.push("Missing required fields");
      }
      if (!knownFieldCount) row.errors.push("No valid row fields");

      const derived = deriveRowMetrics(row);
      if (Object.keys(derived).length) row.derivedMetrics = derived;
      row.errors = Array.from(new Set(row.errors));
      row.warnings = Array.from(new Set(row.warnings));
      if (!Object.keys(unknownFields).length) row.unknownFields = {};
      return row;
    })
    .filter(Boolean);

  return {
    rows,
    warnings,
    sourceType: opts.sourceType || "text",
    sourceName: opts.sourceName || "",
    rawText,
    hasHeader,
    headers,
    columns,
    delimiter,
    errors: rows.length ? [] : ["No rows detected"]
  };
}

function validateNativePracticeShot(input) {
  const shot = Object.assign({}, input || {});
  const errors = Array.isArray(shot.errors) ? shot.errors.slice() : [];
  const warnings = Array.isArray(shot.warnings) ? shot.warnings.slice() : [];
  if (!cleanString(shot.club)) errors.push("missing_club");
  if (!Number.isFinite(Number(shot.carryDistance)) && !Number.isFinite(Number(shot.totalDistance))) errors.push("missing_distance");
  if (Number.isFinite(Number(shot.carryDistance)) && Number(shot.carryDistance) <= 0) errors.push("invalid_carry_distance");
  if (Number.isFinite(Number(shot.totalDistance)) && Number(shot.totalDistance) <= 0) errors.push("invalid_total_distance");
  if (!Number.isFinite(Number(shot.offlineDistance))) warnings.push("missing_offline_distance");
  shot.errors = Array.from(new Set(errors));
  shot.warnings = Array.from(new Set(warnings));
  shot.status = shot.errors.length ? "native_invalid" : "native_valid";
  shot.updatedAt = nowIso();
  return shot;
}

function normalizeNativeShot(input, context) {
  input = input || {};
  context = context || {};
  const scope = Object.assign({}, context.playerScope || {});
  const created = input.createdAt || nowIso();
  return validateNativePracticeShot({
    shotId: cleanString(input.shotId) || createId("practice-shot"),
    sessionId: cleanString(input.sessionId || context.sessionId),
    playerId: cleanString(input.playerId || scope.playerId || scope.profileId),
    playerName: cleanString(input.playerName || scope.playerName || scope.name || "Player"),
    accountId: cleanString(input.accountId || scope.accountId),
    club: cleanString(input.club),
    shotNumber: asNumber(input.shotNumber),
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
    derivedMetrics: input.derivedMetrics && typeof input.derivedMetrics === "object" ? Object.assign({}, input.derivedMetrics) : null,
    sourceType: cleanString(input.sourceType || context.sourceType || "text") || "text",
    importBatchId: cleanString(input.importBatchId || context.importBatchId),
    status: VALID_STATUSES[input.status] ? input.status : "imported",
    schemaVersion: SCHEMA_VERSION,
    createdAt: created,
    updatedAt: input.updatedAt || created,
    errors: Array.isArray(input.errors) ? input.errors.slice() : [],
    warnings: Array.isArray(input.warnings) ? input.warnings.slice() : [],
    unknownFields: input.unknownFields && typeof input.unknownFields === "object" ? Object.assign({}, input.unknownFields) : {}
  });
}

function createPracticeImportBatch(rows, source, playerScope) {
  source = source || {};
  playerScope = Object.assign({}, playerScope || source.playerScope || {});
  const createdAt = nowIso();
  const importBatchId = cleanString(source.importBatchId) || createId("practice-import");
  const sessionId = cleanString(source.sessionId) || createId("practice-session");
  const nativeRows = (Array.isArray(rows) ? rows : []).map(function (row, index) {
    return normalizeNativeShot(Object.assign({}, row, {
      shotNumber: Number.isFinite(Number(row && row.shotNumber)) ? Number(row.shotNumber) : index + 1,
      importBatchId,
      sessionId,
      sourceType: source.sourceType || row && row.sourceType || "text"
    }), {
      importBatchId,
      sessionId,
      sourceType: source.sourceType || "text",
      playerScope
    });
  });
  const batch = {
    importBatchId,
    sessionId,
    sourceType: source.sourceType || "text",
    sourceName: source.sourceName || "",
    rowCount: nativeRows.length,
    validCount: nativeRows.filter(function (row) { return !row.errors.length; }).length,
    invalidCount: nativeRows.filter(function (row) { return row.errors.length; }).length,
    createdAt,
    updatedAt: createdAt
  };
  const session = {
    sessionId,
    importBatchId,
    playerId: playerScope.playerId || playerScope.profileId || "",
    playerName: playerScope.playerName || playerScope.name || "Player",
    accountId: playerScope.accountId || "",
    sourceType: batch.sourceType,
    sourceName: batch.sourceName,
    shotCount: nativeRows.length,
    createdAt,
    updatedAt: createdAt
  };
  return { batch, session, rows: nativeRows };
}

module.exports = {
  SCHEMA_VERSION,
  createId,
  parsePracticeImportText,
  createPracticeImportBatch,
  normalizeNativeShot,
  validateNativePracticeShot
};

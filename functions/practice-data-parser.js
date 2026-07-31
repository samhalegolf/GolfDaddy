"use strict";

/* Server binding for the shared practice parser.
 *
 * The parsing itself lives in scripts/gd-practice-parser-core.js, which the
 * browser also loads - see the header there for why there is exactly one copy.
 * This file supplies the only server-specific piece (crypto-backed ids) and
 * re-exports the same surface practice-email-intake.js has always required.
 *
 * The core is outside functions/, so netlify.toml pins it via
 * [functions] included_files to guarantee it lands in the bundle rather than
 * relying on the bundler's require tracing.
 */

const crypto = require("crypto");
const core = require("../scripts/gd-practice-parser-core.js");

function createId(prefix) {
  if (crypto.randomUUID) return prefix + "-" + crypto.randomUUID();
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/* No ambient scope on the server: the caller states who the import is for. */
const parser = core.createPracticeParser({ createId });

module.exports = {
  SCHEMA_VERSION: core.SCHEMA_VERSION,
  createId,
  parsePracticeImportText: parser.parsePracticeImportText,
  createPracticeImportBatch: parser.createPracticeImportBatch,
  normalizeNativeShot: parser.normalizeNativeShot,
  validateNativePracticeShot: parser.validateNativePracticeShot,
  batchGateStatus: parser.batchGateStatus,
  batchProvenanceGaps: parser.batchProvenanceGaps
};

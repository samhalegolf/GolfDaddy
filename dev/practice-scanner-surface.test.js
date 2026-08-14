// The photo scanner is a beta feature. That is a promise about how it behaves,
// not just a label: it says it is beta, it speaks plainly while it works, it
// fails cleanly instead of hanging, and being interrupted is not the same as
// going wrong.
//
// The scanner's own logic is deliberately untouched by these tests - this is
// about what a player sees while it runs.
//
// Run: node dev/practice-scanner-surface.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'scripts/gd-app-core.js'), 'utf8');
const markup = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles/inline/gd-app-base.css'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}

// ---- it says it is beta, where the scanning happens ----

const scannerBlock = markup.slice(
  markup.indexOf('<div class="gdPracticeScanner"'),
  markup.indexOf('id="gdPracticeScanPhotoBtn"')
);
assert(scannerBlock.length > 0, 'the scanner block was found in the markup');
assert(/gdPracticeBetaChip">Beta</.test(scannerBlock), 'the scanner carries a Beta marker above the frame');
assert(
  /check the shots it reads before you save/i.test(scannerBlock),
  'and says plainly what beta means here - check the shots before saving'
);
assert(css.includes('.gdPracticeBetaChip{'), 'the beta chip is styled rather than relying on a class that does not exist');

// ---- the status the player reads is plain language ----

const statusFn = core.slice(
  core.indexOf('const GD_PRACTICE_SCAN_USER_STATUS='),
  core.indexOf('function gdNativeShotDataProcessingTrackHTML')
);
assert(statusFn.length > 0, 'the user-facing status mapping exists');

const ctx = { GD_PRACTICE_SCAN_USER_STATUS: null };
vm.createContext(ctx);
vm.runInContext(statusFn + '\nthis.map = gdPracticeUserFacingScanStatus;', ctx);
const map = ctx.map;

assert(map({ status: 'queued' }, 0) === 'Getting ready', 'a queued scan says it is getting ready');
assert(map({ status: 'scanning' }, 0) === 'Scanning', 'stage one says Scanning');
assert(map({ status: 'scanning' }, 1) === 'Reading shot data', 'stage two says Reading shot data');
assert(map({ status: 'scanning' }, 2) === 'Preparing your data', 'stage three says Preparing your data');
assert(map({ status: 'saving' }, 3) === 'Almost finished', 'saving says Almost finished');
assert(map({ status: 'scanning' }, 99) === 'Almost finished', 'an out-of-range stage still returns something sayable');
assert(map({}, undefined) === 'Scanning', 'a job with nothing useful on it still returns a sentence');

// The internal vocabulary must not reach that function's output.
const INTERNAL = ['offcut', 'Deep scan', 'strip', 'corridor', 'Splitting columns', 'boxes'];
INTERNAL.forEach((word) => {
  assert(
    !new RegExp(word, 'i').test(GD_STATUS_VALUES().join(' ')),
    `"${word}" is not something the player is shown`
  );
});
function GD_STATUS_VALUES() {
  return [
    map({ status: 'queued' }, 0), map({ status: 'scanning' }, 0), map({ status: 'scanning' }, 1),
    map({ status: 'scanning' }, 2), map({ status: 'saving' }, 3)
  ];
}

// The progress track must use the mapping, not the raw checkpoint text.
const trackFn = core.slice(
  core.indexOf('function gdNativeShotDataProcessingTrackHTML'),
  core.indexOf('function gdNativeShotDataProcessingStopHTML')
);
assert(
  trackFn.includes('gdPracticeUserFacingScanStatus'),
  'the progress track shows the mapped status'
);
assert(
  !/const label=gdPracticeImportIsActive\(job\)&&job\?\.checkpointText/.test(trackFn),
  'and no longer prints job.checkpointText straight at the player'
);

// ...while the debug feed still gets the real thing.
const debugPanel = core.slice(
  core.indexOf('function gdRenderPracticeLiveDebugPanel'),
  core.indexOf('function gdPracticeRecordLiveDebugEvent')
);
assert(
  debugPanel.includes('job?.checkpointText'),
  'the Studio debug feed still shows the internal checkpoint text unchanged'
);

// ---- a stalled scan fails cleanly ----

assert(core.includes('const GD_PRACTICE_SCAN_STALL_MS='), 'there is a stall threshold');
const stallMs = Number((core.match(/const GD_PRACTICE_SCAN_STALL_MS=(\d+)/) || [])[1]);
assert(stallMs >= 30000 && stallMs <= 180000, 'the threshold is a sane wait (30s-3min), got ' + stallMs);
const stallFn = core.slice(core.indexOf('function gdPracticeCheckScanStall'), core.indexOf('function gdPracticeProcessingStart'));
assert(stallFn.includes('gdPracticeFailImportJob'), 'a stalled scan fails the job rather than leaving it spinning');
assert(/try again/i.test(stallFn), 'and the message tells the player to try again');
assert(
  stallFn.includes('job.checkpointText') && stallFn.includes('job.progress'),
  'the stall watch keys off real progress, so a slow-but-moving scan is never killed'
);
assert(
  core.includes('function gdPracticeResetScanStallWatch'),
  'the watch resets, so one stall does not poison the next scan'
);

// ---- interrupted is not failed ----

assert(
  core.includes('status:"interrupted"'),
  'leaving mid-scan marks the job interrupted'
);
assert(
  !core.includes('userMessage:"Import stopped before it completed"'),
  'the old "Import stopped before it completed" wording is gone'
);
assert(
  core.includes('interrupted:"Scan interrupted"'),
  'interrupted has its own label rather than falling through to "Import status"'
);
assert(
  /\["failed","interrupted"\]\.includes/.test(core),
  'an interrupted job clears itself out of the way of the next scan'
);

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;

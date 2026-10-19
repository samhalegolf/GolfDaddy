/*
 * Template mode wiring in the app (gd-app-core.js + index.html).
 *
 * The pure reader is tested in dev/clarity-template-ocr.test.js. This pins
 * the plumbing around it:
 *   - the Template select is on the scanner and the module loads before the
 *     app core;
 *   - the select helpers fill from the layout registry, remember the choice,
 *     and answer "" for anything that is not a layout;
 *   - the Scan button's dispatcher sends a template key down the template
 *     route and no key down the discovery route;
 *   - the template route never reads headers or splits columns, borrows the
 *     direction deep scan with the layout's own direction columns, and lands
 *     through the same single checkpoint and job boundary as the old route;
 *   - the guided camera tags its photo with the frame and selects the layout.
 *
 * Run: node dev/practice-template-mode.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const core = read('scripts/gd-app-core.js');
const markup = read('index.html');
const camera = read('scripts/gd-practice-camera-guide.js');

function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, 'found: ' + from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, 'found end: ' + to);
  return src.slice(a, b);
}

/* ---- page ---- */
const tplTag = markup.indexOf('scripts/clarity-template-ocr.js');
assert.ok(tplTag > markup.indexOf('scripts/clarity-table-ocr-pixels.js'), 'the template module loads after the pixel glue it may share');
assert.ok(tplTag < markup.indexOf('scripts/gd-app-core.js'), 'and before the app core that calls it');
const scanner = slice(markup, '<div class="gdPracticeScanner"', 'id="gdPracticeScanPhotoBtn"');
assert.ok(/<select id="gdPracticeScanTemplateSelect"[^>]*onchange="gdPracticeScanTemplateChanged\(\)"/.test(scanner), 'the Template select is on the scanner, next to the club');
assert.ok(/data-i18n="dataPage.scanTemplateNone"/.test(scanner), 'with a translated "No template" choice');
assert.ok(read('styles/inline/gd-app-base.css').includes('.gdPracticeScanTemplateField select{'), 'and is styled like the club field');

/* ---- select helpers, run against a tiny DOM ---- */
const helpers = slice(core, 'const GD_PRACTICE_SCAN_TEMPLATE_KEY=', 'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",gdPracticeRenderScanTemplateSelect);');
{
  const storage = {};
  const select = {
    value: '', dataset: {}, children: [], innerHTML: '',
    appendChild(o) { this.children.push(o); },
    set innerHTMLReset(v) { this.children = []; }
  };
  Object.defineProperty(select, 'innerHTML', { set() { this.children = []; }, get() { return ''; } });
  const win = {
    document: {
      getElementById: (id) => (id === 'gdPracticeScanTemplateSelect' ? select : null),
      createElement: () => ({ setAttribute() {} })
    },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    gdT: (k) => k
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('scripts/gd-launch-monitor-layouts.js'), win);
  vm.runInContext(helpers, win);
  const layouts = win.GolfDaddyLaunchMonitorLayouts.list();

  win.gdPracticeRenderScanTemplateSelect();
  assert.strictEqual(select.children.length, layouts.length + 1, 'one option per layout plus "No template"');
  assert.strictEqual(select.children[0].value, '');
  assert.strictEqual(select.value, '', 'nothing remembered means no template');
  assert.strictEqual(win.gdPracticeScanTemplateKey(), '');

  assert.strictEqual(win.gdPracticeSetScanTemplate('garmin-r10'), 'garmin-r10');
  assert.strictEqual(select.value, 'garmin-r10');
  assert.strictEqual(storage.gd_practice_scan_template_v1, 'garmin-r10', 'the choice is remembered');
  assert.strictEqual(win.gdPracticeScanTemplateKey(), 'garmin-r10');
  assert.strictEqual(win.gdPracticeScanTemplateLayout().brand, 'Garmin');

  select.value = 'not-a-layout';
  assert.strictEqual(win.gdPracticeScanTemplateKey(), '', 'an unknown value is no template, so the old route runs');
  assert.strictEqual(win.gdPracticeSetScanTemplate(''), '', 'clearing works');
  assert.strictEqual(storage.gd_practice_scan_template_v1, '');

  /* a remembered choice survives a re-render */
  storage.gd_practice_scan_template_v1 = 'skytrak';
  select.dataset = {};
  win.gdPracticeRenderScanTemplateSelect();
  assert.strictEqual(select.value, 'skytrak');
}

/* ---- the dispatcher ---- */
const dispatcher = slice(core, 'async function gdRunDefaultPracticePhotoScanFromCheckpoint(checkpoint,opts={}){', '\n}\n');
assert.ok(dispatcher.includes('gdPracticeScanTemplateKey()'), 'the Scan button asks the select which route to take');
assert.ok(/if\(templateKey\)return gdClarityTemplateScanFromCheckpoint\(checkpoint,/.test(dispatcher), 'a template key goes down the template route');
assert.ok(/return gdClarityTableOcrScanFromCheckpoint\(checkpoint,opts\);/.test(dispatcher), 'no key goes down the discovery route, unchanged');

/* ---- the template route ---- */
const route = slice(core, 'async function gdClarityTemplateScanFromCheckpoint(checkpoint,opts={}){', '\nasync function gdRunDefaultPracticePhotoScanFromCheckpoint');
['gdClarityNameStrips', 'allocateHeaders', 'splitColumns', 'detectNumberBoxes', 'gdClarityOffcutScan', 'trimUnresolvedEdges'].forEach((name) => {
  assert.ok(!route.includes(name), 'template mode does not discover anything: no ' + name);
});
assert.ok(route.includes('TPL.fitTemplate(layout,flat.width,flat.height,mask)'), 'it fits the chosen layout to the ink');
assert.ok(route.includes('TPL.cellRects(fit,3)'), 'and reads one crop per cell');
assert.ok(route.includes('gdClarityDeepCropCell(flat,cell.rect)'), 'at native resolution through the inverse warp when it can');
assert.ok(route.includes('TPL.assembleRows(fit,reads,labels,'), 'rows come from the pure module');
assert.ok(route.includes('gdClarityDeepScanDirections(flat,scanRows,strips,dataRows,Tesseract,{needsDirection:key=>directionKeys.has(key)'), 'the direction deep scan is borrowed, keyed to the layout\'s own direction columns');
assert.ok(route.includes('gdClarityScanResultToPayload(scanRows,{label:sourceLabel,club:manualClub})'), 'and lands through the single checkpoint');
assert.ok(route.includes('await gdImportLaunchMonitorPayload(payload,sourceLabel)'), 'into the Shot Library');
assert.ok(route.includes('payload.inputType="clarity-template-ocr"'), 'marked as a template scan');
assert.ok(route.includes('gdPracticeStartImportJob("clarity-template-ocr"'), 'inside a durable job');
assert.ok(/finally\{[\s\S]*gdPracticeFailImportJob\(new Error\("Clarity template scan ended without saving"\)/.test(route), 'with the same fail boundary as the old route');
assert.ok(route.includes('gdT("practice.scanFailTemplateRows")'), 'no rows under the header says so in the player\'s words and reopens the pins');

/* the deep scan accepts the decider the template route passes */
const deep = slice(core, 'async function gdClarityDeepScanDirections(flat,scanRows,strips,dataRows,Tesseract,opts){', '\n}\n');
assert.ok(deep.includes('typeof opts.needsDirection==="function"?opts.needsDirection:'), 'gdClarityDeepScanDirections takes needsDirection, defaulting to the old three metrics');
assert.ok(deep.includes('needsDir(s.metricKey)'), 'and filters its strips with it');

/* the quad tool says what template mode wants from the pins */
const quadOpen = slice(core, 'function gdOpenPracticeManualQuadTool(){', '\n}\n');
assert.ok(quadOpen.includes('gdT("practice.framePinsTemplate")'), 'in template mode the pins hint asks for the header along the top edge');

/* a guided-camera photo in template mode puts the pins on the frame */
const frameFn = slice(core, 'function gdPracticeTemplateFrameCheckpoint(){', '\n}\n');
assert.ok(frameFn.includes('gdPracticePhotoTemplateFrame') && frameFn.includes('gdPracticeScanTemplateKey()'), 'only with a camera frame and a template selected');
assert.ok(frameFn.includes('startsWith("perspective-warp")'), 'and not when the normaliser moved the pixels');
const handler = slice(core, 'async function gdHandleLaunchMonitorPhoto(file){', '\n}\n');
assert.ok(handler.includes('gdPracticePhotoTemplateFrame=file.__gdTemplateFrame'), 'the photo handler reads the frame off the file');
assert.ok(handler.includes('const checkpoint=frameCheckpoint||await gdBuildPracticeClusterCheckpoint();'), 'and prefers it to the value-shape finder');

/* ---- the camera hands over frame + layout ---- */
assert.ok(camera.includes('file.__gdTemplateFrame = { x: edge, y: edge, w: frameFrac, h: frameFrac'), 'the camera tags the photo with where the frame is');
assert.ok(camera.includes("win.gdPracticeSetScanTemplate(layout ? layout.key : '')"), 'and selects the layout it was framed with');

/* ---- words exist ---- */
{
  const ctx = { window: null };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('scripts/gd-i18n.js'), ctx);
  vm.runInContext(read('scripts/i18n/en.js'), ctx);
  ['dataPage.scanTemplate', 'dataPage.scanTemplateNone', 'practice.framePinsTemplate', 'shots.templateScanning', 'practice.scanFailTemplateRows'].forEach((key) => {
    assert.notStrictEqual(ctx.GDI18n.t(key), key, key + ' has English');
  });
  assert.ok(/\{layout\}/.test(ctx.GDI18n.t('shots.templateScanning')), 'the scanning line names the template');
}

console.log('ok - template mode: select, dispatcher, template route, borrowed deep scan, camera hand-off');

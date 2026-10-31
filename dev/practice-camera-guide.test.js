/*
 * The guided camera (scripts/gd-practice-camera-guide.js) sits between the
 * Take photo button and the scanner. What is pinned here:
 *
 *   - the page loads the layouts before the camera module, and the button
 *     opens the guided camera with the old capture input kept as fallback;
 *   - with no getUserMedia the module hands straight off to the phone
 *     camera and never touches the DOM;
 *   - with a camera it builds the overlay, remembers the chosen layout, and
 *     draws one template per layout; on a portrait page a wide table turns
 *     the stage sideways, a portrait table does not;
 *   - the shutter freezes the picture and brings up the adjust stage: the
 *     lines drag (in order, with a minimum gap), Reset puts them back, Retake
 *     goes live again;
 *   - Scan hands gdHandleLaunchMonitorPhoto a file cut to the frame plus
 *     margin, upright (turned back when the stage was turned), tagged with
 *     the frame, the column lines and the header line, and selects the
 *     layout as the template (or no template for a layout without columns);
 *   - a failed scan can bring the adjust stage back on the same still;
 *   - its words go through the translation layer and the stylesheet exists.
 *
 * Run: node dev/practice-camera-guide.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const markup = read('index.html');
const moduleSrc = read('scripts/gd-practice-camera-guide.js');
const layoutsSrc = read('scripts/gd-launch-monitor-layouts.js');
const i18nSrc = read('scripts/gd-i18n.js');
const enSrc = read('scripts/i18n/en.js');

/* ---- wiring in the page ---- */
const layoutsTag = markup.indexOf('scripts/gd-launch-monitor-layouts.js');
const cameraTag = markup.indexOf('scripts/gd-practice-camera-guide.js');
const coreTag = markup.indexOf('scripts/gd-app-core.js');
assert.ok(layoutsTag > 0 && cameraTag > 0, 'both scripts are on the page');
assert.ok(layoutsTag < cameraTag, 'layouts load before the camera that draws them');
assert.ok(cameraTag < coreTag, 'the camera is ready before the app core wires the practice panel');
assert.ok(markup.includes('styles/inline/gd-practice-camera-guide.css'), 'the stylesheet is linked');
const css = read('styles/inline/gd-practice-camera-guide.css');
assert.ok(css.includes('.gdPracticeCameraStage.turned{transform:rotate(90deg)'), 'the stylesheet turns the stage a quarter turn');
assert.ok(css.includes('.gdPracticeCameraStage.adjust .gdPracticeCameraOverlay{pointer-events:auto;touch-action:none'), 'and lets the lines take the finger on the adjust stage');

const button = markup.match(/<label[^>]*id="gdPracticeCameraLabel"[^>]*>/);
assert.ok(button, 'the Take photo button is still there');
assert.ok(/gdOpenPracticeCameraGuide\(event\)/.test(button[0]), 'it opens the guided camera');
assert.ok(/gdPickPracticePhotoFile\(event,'camera'\)/.test(button[0]), 'and keeps the phone camera when the module is missing');
assert.ok(/<input[^>]*id="gdPracticeCameraInput"[^>]*capture="environment"/.test(markup), 'the capture input stays as the fallback');

/* ---- a tiny DOM, enough for the module ---- */
function makeContext(log) {
  return {
    drawImage: (...args) => log.push({ op: 'drawImage', args }),
    translate: (...args) => log.push({ op: 'translate', args }),
    rotate: (...args) => log.push({ op: 'rotate', args })
  };
}

function makeDocument() {
  const nodes = [];
  function node(tag, ns) {
    const n = {
      tag, ns, attrs: {}, children: [], listeners: {}, style: {}, hidden: false, textContent: '', innerHTML: '',
      classList: {
        set: new Set(),
        add(...c) { c.forEach((x) => this.set.add(x)); },
        remove(...c) { c.forEach((x) => this.set.delete(x)); },
        toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
        contains(c) { return this.set.has(c); }
      },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'hidden') this.hidden = true; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      get firstChild() { return this.children[0] || null; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      fire(type, event) { (this.listeners[type] || []).forEach((fn) => fn(event)); },
      getBoundingClientRect() { return { left: 0, top: 0, width: this.rectW || 0, height: this.rectH || 0 }; },
      focus() {},
      scrollIntoView() {},
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const byId = sel.startsWith('#') ? sel.slice(1) : null;
        const byClass = sel.startsWith('.') ? sel.slice(1) : null;
        const byAttr = sel.startsWith('[') ? sel.slice(1, -1) : null;
        (function walk(n) {
          n.children.forEach((c) => {
            if (byId && c.attrs.id === byId) out.push(c);
            else if (byClass && c.classList.contains(byClass)) out.push(c);
            else if (byAttr && byAttr in c.attrs) out.push(c);
            walk(c);
          });
        }(this));
        return out;
      }
    };
    if (tag === 'canvas') {
      n.ctxLog = [];
      n.getContext = () => makeContext(n.ctxLog);
      n.toBlob = (cb, type) => cb(new doc.Blob(['jpeg'], { type }));
    }
    Object.defineProperty(n, 'className', {
      get() { return [...this.classList.set].join(' '); },
      set(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    });
    nodes.push(n);
    return n;
  }
  const body = node('body');
  body.classList.add('page');
  const doc = {
    body,
    documentElement: node('html'),
    nodes,
    canvases: () => nodes.filter((n) => n.tag === 'canvas'),
    createElement: (tag) => node(tag),
    createElementNS: (ns, tag) => node(tag, ns),
    querySelectorAll: (sel) => body.querySelectorAll(sel)
  };
  return doc;
}

function boot({ camera = true, viewport = [390, 844], stored = {} } = {}) {
  const calls = { photos: [], picks: [], feedback: [], tracks: [], templates: [], streams: 0 };
  const storage = Object.assign({}, stored);
  const win = {
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    console: Object.assign({}, console, { warn() {} }),
    Math,
    Date,
    JSON,
    Number,
    Object,
    Array,
    String,
    Uint8Array,
    Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    File: class File { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts && opts.type; } },
    setTimeout: (fn) => fn(),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); }
    },
    addEventListener() {},
    navigator: {
      languages: ['en'],
      mediaDevices: camera ? {
        getUserMedia: () => {
          calls.streams += 1;
          return Promise.resolve({ getTracks: () => [{ stop: () => calls.tracks.push('stopped') }] });
        }
      } : undefined
    },
    gdHandleLaunchMonitorPhoto: (file) => calls.photos.push(file),
    gdPickPracticePhotoFile: (event, mode) => { calls.picks.push(mode); return false; },
    gdPracticeFeedback: (message) => calls.feedback.push(message),
    gdPracticeSetScanTemplate: (key) => calls.templates.push(key)
  };
  win.window = win;
  win.globalThis = win;
  win.document = makeDocument();
  win.document.Blob = win.Blob;
  win.document.body.classList = win.document.body.classList;
  const ctx = vm.createContext(win);
  vm.runInContext(i18nSrc, ctx, { filename: 'gd-i18n.js' });
  vm.runInContext(enSrc, ctx, { filename: 'en.js' });
  vm.runInContext(layoutsSrc, ctx, { filename: 'layouts.js' });
  vm.runInContext(moduleSrc, ctx, { filename: 'camera.js' });
  return { win, calls, storage };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
/* Arrays born inside the vm context have their own Array prototype, which
   deepStrictEqual minds; compare plain copies. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ---- no camera: straight to the phone camera, no DOM built ---- */
{
  const { win, calls } = boot({ camera: false });
  assert.strictEqual(win.GolfDaddyPracticeCameraGuide.supported(), false);
  win.gdOpenPracticeCameraGuide({ preventDefault() {} });
  assert.deepStrictEqual(calls.picks, ['camera'], 'falls back to the capture input');
  assert.strictEqual(win.document.body.children.length, 0, 'nothing was added to the page');
  assert.strictEqual(calls.photos.length, 0);
}

/* ---- the camera refuses: hand off, and go native next time without asking ---- */
{
  const { win, calls } = boot();
  win.navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  win.gdOpenPracticeCameraGuide({ preventDefault() {}, stopPropagation() {} });
  const root = win.document.body.children.find((c) => c.attrs.id === 'gdPracticeCameraGuide');
  assert.strictEqual(root.hidden, false, 'the viewfinder opens while the permission is asked');
  tick().then(() => {
    assert.strictEqual(root.hidden, true, 'a refusal closes it');
    assert.deepStrictEqual(calls.picks, ['camera'], 'and hands off to the phone camera');
    assert.ok(calls.feedback.some((m) => m === win.GDI18n.t('dataPage.cameraGuideDenied')), 'saying so');
    win.gdOpenPracticeCameraGuide({ preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(root.hidden, true, 'the next tap does not reopen the viewfinder');
    assert.deepStrictEqual(calls.picks, ['camera', 'camera'], 'it goes straight to the phone camera, inside the tap');
  });
}

/* ---- portrait phone: the overlay, the layouts, the turned stage, the adjust stage, the scan ---- */
async function portraitPhone() {
  const { win, calls, storage } = boot({ stored: { gd_practice_camera_layout_v1: 'garmin-r10' } });
  const api = win.GolfDaddyPracticeCameraGuide;
  const LAY = win.GolfDaddyLaunchMonitorLayouts;
  assert.strictEqual(api.supported(), true);
  assert.strictEqual(api.layoutKey(), 'garmin-r10', 'the last layout used is remembered');

  const opened = api.open({ preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(opened, false, 'the click is consumed');
  const root = win.document.body.children.find((c) => c.attrs.id === 'gdPracticeCameraGuide');
  assert.ok(root, 'the overlay is on the page');
  assert.strictEqual(root.hidden, false);
  assert.ok(root.classList.contains('open'));
  assert.ok(win.document.body.classList.contains('gdPracticeCameraOpen'), 'the page behind it is marked');
  const stage = root.querySelector('#gdPracticeCameraStage');
  assert.ok(stage, 'the template and the controls live on a stage of their own');
  const video = root.querySelector('#gdPracticeCameraVideo');
  const still = root.querySelector('#gdPracticeCameraStill');
  assert.ok(video.parent === root && still.parent === root, 'the picture stays in page coordinates, outside the stage');
  assert.strictEqual(video.attrs.playsinline, '', 'inline video so iOS does not go full screen');
  assert.strictEqual(video.muted, true);
  assert.strictEqual(still.hidden, true, 'no still until the shutter');

  const chips = root.querySelectorAll('.gdPracticeCameraChip');
  const layouts = LAY.list();
  assert.strictEqual(chips.length, layouts.length, 'one chip per layout');
  assert.strictEqual(chips.find((c) => c.attrs['aria-checked'] === 'true').attrs['data-layout'], 'garmin-r10');

  /* Words come from the translation layer, not hard-coded English. */
  const title = root.querySelector('.gdPracticeCameraTitle').children[0];
  assert.strictEqual(title.attrs['data-i18n'], 'dataPage.cameraGuideTitle');
  assert.strictEqual(title.textContent, win.GDI18n.t('dataPage.cameraGuideTitle'));
  assert.notStrictEqual(title.textContent, 'dataPage.cameraGuideTitle', 'and English has the word');
  assert.strictEqual(root.querySelector('#gdPracticeCameraShutterBtn').attrs['aria-label'], win.GDI18n.t('dataPage.takePhoto'));
  ['gdPracticeCameraScanBtn', 'gdPracticeCameraRetakeBtn', 'gdPracticeCameraResetBtn'].forEach((id) => {
    const btn = root.querySelector('#' + id);
    assert.ok(btn && btn.textContent && btn.textContent !== btn.attrs['data-i18n'], id + ' has its words');
    assert.strictEqual(btn.hidden, true, id + ' waits for the shutter');
  });

  /* Every layout draws a template with a frame, header band and row guides.
     A wide table turns the stage on this portrait page; a portrait table
     keeps it upright. */
  root.rectW = 390; root.rectH = 844;
  layouts.forEach((layout) => {
    api.setLayout(layout.key);
    assert.strictEqual(storage.gd_practice_camera_layout_v1, layout.key, 'choice is saved: ' + layout.key);
    assert.strictEqual(win.__gdPracticeCameraLayout, layout.key, 'and exposed for the scanner');
    const turned = LAY.wantsTurn(layout, 390, 844);
    assert.strictEqual(api.turned(), turned, layout.key + ' turns only for a wide table');
    assert.strictEqual(stage.classList.contains('turned'), turned, layout.key + ' stage class follows');
    assert.strictEqual(stage.classList.contains('wide'), turned, layout.key + ' a turned stage is a wide stage here');
    assert.strictEqual(stage.style.width, (turned ? 844 : 390) + 'px', layout.key + ' stage takes the page\'s long side when turned');
    const geo = api.geometry();
    if (turned) assert.ok(geo.frame.w > 390, layout.key + ' frame is wider than the portrait page could hold');
    const svg = root.querySelector('.gdPracticeCameraOverlay');
    const tags = svg.children.map((c) => c.attrs.class || c.tag);
    assert.ok(tags.includes('gdCamMask') && tags.includes('gdCamFrame') && tags.includes('gdCamHeader'), layout.key + ' draws mask, frame and header');
    assert.ok(svg.children.filter((c) => c.attrs.class === 'gdCamRow').length >= 1, layout.key + ' draws row guides');
    assert.strictEqual(svg.children.some((c) => c.attrs.class === 'gdCamSummary'), layout.summaryRows.length > 0, layout.key + ' summary band only when the brand prints one');
    const ribbon = root.querySelector('#gdPracticeCameraRibbon');
    if (layout.columns.length) {
      assert.strictEqual(ribbon.hidden, false, layout.key + ' shows the column order');
      assert.ok(ribbon.textContent.includes(layout.columns[0].label) && ribbon.textContent.includes(layout.columns[layout.columns.length - 1].label));
    } else {
      assert.strictEqual(ribbon.hidden, true, layout.key + ' has no ribbon without columns');
    }
    const note = root.querySelector('#gdPracticeCameraNote');
    if (layout.device === 'phone') assert.ok(note.textContent.includes(win.GDI18n.t('dataPage.cameraGuideScreenshot')), layout.key + ' says to screenshot a same-phone app');
    assert.strictEqual(note.textContent.includes(win.GDI18n.t('dataPage.cameraGuideRotate')), turned, layout.key + ' says to turn the phone exactly when the stage is turned');
  });

  /* Capture before the stream is up does nothing. */
  api.setLayout('foresight-fsx-ball');
  assert.strictEqual(api.capture(), false, 'no frame yet, no capture');
  assert.strictEqual(calls.photos.length, 0);
  await tick();
  assert.strictEqual(video.srcObject && typeof video.srcObject.getTracks, 'function', 'the stream is on the video');
  assert.strictEqual(calls.streams, 1);

  /* The phone is on its side with the page locked portrait: the sensor
     frame comes portrait too. */
  video.videoWidth = 1080; video.videoHeight = 1920;

  /* ---- the shutter: freeze, lines up ---- */
  assert.strictEqual(api.capture(), true);
  assert.strictEqual(api.mode(), 'adjust');
  assert.strictEqual(calls.photos.length, 0, 'nothing is handed over yet');
  assert.strictEqual(root.hidden, false, 'the overlay stays up');
  assert.ok(stage.classList.contains('adjust'));
  assert.strictEqual(still.hidden, false, 'the still shows');
  assert.strictEqual(video.hidden, true, 'in place of the video');
  assert.deepStrictEqual([still.width, still.height], [1080, 1920], 'at the camera\'s full size');
  assert.strictEqual(still.ctxLog[0].op, 'drawImage', 'with the frame drawn into it');
  assert.ok(calls.tracks.includes('stopped'), 'and the camera light goes off');
  assert.strictEqual(root.querySelector('#gdPracticeCameraShutterBtn').hidden, true, 'shutter away');
  assert.strictEqual(root.querySelector('#gdPracticeCameraScanBtn').hidden, false, 'Scan in its place');
  assert.strictEqual(root.querySelector('#gdPracticeCameraChips').hidden, true, 'the layout is settled');
  assert.strictEqual(root.querySelector('#gdPracticeCameraStatus').textContent, win.GDI18n.t('dataPage.cameraGuideAdjust'), 'the status says what to do');

  const layout = LAY.get('foresight-fsx-ball');
  const first = plain(api.lines());
  const geo = api.geometry();
  assert.strictEqual(first.bounds.length, layout.columns.length, 'one line per column');
  assert.deepStrictEqual([first.left, first.top, first.right, first.bottom], [geo.frame.x, geo.frame.y, geo.frame.x + geo.frame.w, geo.frame.y + geo.frame.h], 'the lines start on the template frame');
  assert.strictEqual(first.headerBottom, geo.header.y + geo.header.h, 'and the header line on the template\'s header band');
  const svg = root.querySelector('.gdPracticeCameraOverlay');
  assert.strictEqual(svg.children.filter((c) => c.attrs.class === 'gdCamLine').length, layout.columns.length, 'every column line is drawn (the label edge too)');
  assert.ok(svg.children.filter((c) => (c.attrs.class || '').startsWith('gdCamHandle')).length >= layout.columns.length + 5, 'with handles, plus the four edges and the header');

  /* ---- Retake goes live again ---- */
  assert.strictEqual(api.retake(), true);
  assert.strictEqual(api.mode(), 'live');
  assert.strictEqual(still.hidden, true);
  assert.strictEqual(calls.streams, 2, 'the camera is asked for again');
  await tick();
  video.videoWidth = 1080; video.videoHeight = 1920;
  assert.strictEqual(api.capture(), true);

  /* ---- dragging a column line: the finger is a page point, the stage is turned ---- */
  const H = 390;
  const toPage = (lx, ly) => ({ clientX: H - ly, clientY: lx, pointerId: 1, preventDefault() {} });
  const lines = api.lines();
  const i = 3;
  const grabY = (lines.top + lines.headerBottom) / 2;
  svg.fire('pointerdown', toPage(lines.bounds[i] + 3, grabY));
  svg.fire('pointermove', toPage(lines.bounds[i] + 12, grabY));
  assert.strictEqual(Math.round(api.lines().bounds[i]), Math.round(first.bounds[i] + 12), 'the line follows the finger');
  svg.fire('pointermove', toPage(lines.bounds[i + 1] + 200, grabY));
  assert.strictEqual(api.lines().bounds[i], first.bounds[i + 1] - 12, 'but stops a gap short of the next line');
  svg.fire('pointerup', toPage(0, 0));
  assert.ok(api.lines().bounds[i] > first.bounds[i], 'and stays where it was left');
  assert.strictEqual(api.lines().bounds[i + 1], first.bounds[i + 1], 'the neighbour did not move');

  /* the header line, grabbed by its handle in the label column */
  const l2 = api.lines();
  svg.fire('pointerdown', toPage((l2.left + l2.bounds[0]) / 2, l2.headerBottom));
  svg.fire('pointermove', toPage((l2.left + l2.bounds[0]) / 2, l2.headerBottom + 9));
  svg.fire('pointerup', toPage(0, 0));
  assert.strictEqual(Math.round(api.lines().headerBottom), Math.round(first.headerBottom + 9), 'the header line moves too');

  /* a finger far from any line does nothing */
  svg.fire('pointerdown', toPage(5, 5));
  svg.fire('pointermove', toPage(50, 50));
  svg.fire('pointerup', toPage(0, 0));
  assert.deepStrictEqual(plain(api.lines().bounds).slice(0, i), first.bounds.slice(0, i), 'nothing else moved');

  /* ---- Reset ---- */
  api.resetLines();
  assert.deepStrictEqual(plain(api.lines()), first, 'Reset puts the lines back on the template');

  /* move one line a known amount and scan with it */
  svg.fire('pointerdown', toPage(first.bounds[5], grabY));
  svg.fire('pointermove', toPage(first.bounds[5] + 6, grabY));
  svg.fire('pointerup', toPage(0, 0));
  const used = plain(api.lines());

  /* ---- Scan: cut, turned upright, tagged ---- */
  assert.strictEqual(api.scan(), true);
  assert.strictEqual(calls.photos.length, 1, 'one photo handed to the scanner');
  const file = calls.photos[0];
  assert.ok(/^clarity-camera-foresight-fsx-ball-\d{8}T\d{6}\.jpg$/.test(file.name), 'file carries the layout name: ' + file.name);
  assert.strictEqual(file.type, 'image/jpeg');
  const out = win.document.canvases().find((c) => c !== still && c.ctxLog.some((e) => e.op === 'drawImage'));
  assert.ok(out, 'the shot is drawn into a fresh canvas');
  const localFrame = { x: used.left, y: used.top, w: used.right - used.left, h: used.bottom - used.top };
  const pageFrame = LAY.turnedToPage(localFrame, H);
  const crop = LAY.coverCrop(1080, 1920, 390, 844, pageFrame, 0.08);
  const drawn = out.ctxLog.find((e) => e.op === 'drawImage').args;
  assert.deepStrictEqual(drawn.slice(1, 5), [crop.sx, crop.sy, crop.sw, crop.sh], 'the saved picture is the framed table plus margin, from the still');
  assert.deepStrictEqual([out.width, out.height], [crop.sh, crop.sw], 'turned back upright: the long side is the width');
  assert.deepStrictEqual(out.ctxLog.find((e) => e.op === 'rotate').args, [-Math.PI / 2], 'a quarter turn anticlockwise');
  assert.ok(out.width >= 520 && out.height >= 180, 'and big enough for the scanner\'s small-image gate');

  const tag = file.__gdTemplateFrame;
  assert.ok(tag, 'the file says where the frame is');
  assert.strictEqual(tag.layout, 'foresight-fsx-ball');
  const src = LAY.coverRect(1080, 1920, 390, 844, pageFrame);
  const expect = { x: (src.y - crop.sy) / crop.sh, y: (crop.sx + crop.sw - src.x - src.w) / crop.sw, w: src.h / crop.sh, h: src.w / crop.sw };
  ['x', 'y', 'w', 'h'].forEach((k) => assert.ok(Math.abs(tag[k] - expect[k]) < 1e-9 && tag[k] >= 0 && tag[k] <= 1, 'frame.' + k + ' is the frame inside the upright picture'));
  assert.ok(tag.w > 0.8 && tag.h > 0.8, 'the frame is most of the picture');
  assert.strictEqual(tag.columns.length, layout.columns.length, 'one column line per column');
  tag.columns.forEach((c, k) => {
    assert.ok(c >= 0 && c <= 1, 'column line ' + k + ' is a fraction of the frame');
    if (k) assert.ok(c > tag.columns[k - 1], 'in order');
    assert.ok(Math.abs(c - (used.bounds[k] - used.left) / localFrame.w) < 1e-9, 'column line ' + k + ' is where it was dragged');
  });
  assert.ok(Math.abs(tag.columns[5] - tag.columns[4] - (first.bounds[5] + 6 - first.bounds[4]) / localFrame.w) < 1e-9, 'including the one moved by 6px');
  assert.ok(Math.abs(tag.headerBottom - (used.headerBottom - used.top) / localFrame.h) < 1e-9, 'and the header line as a fraction of the frame height');

  assert.strictEqual(root.hidden, true, 'the camera closes after the scan');
  assert.ok(!win.document.body.classList.contains('gdPracticeCameraOpen'));
  assert.deepStrictEqual(calls.templates, ['foresight-fsx-ball'], 'the layout the photo was framed with is the template');
  assert.deepStrictEqual(calls.picks, [], 'the phone camera was never needed');

  /* ---- a failed scan brings the lines back on the same still ---- */
  const streamsBefore = calls.streams;
  assert.strictEqual(api.reopenAdjust('nothing found'), true);
  assert.strictEqual(root.hidden, false);
  assert.strictEqual(api.mode(), 'adjust');
  assert.deepStrictEqual(plain(api.lines()), used, 'with the lines where the player left them');
  assert.strictEqual(root.querySelector('#gdPracticeCameraStatus').textContent, 'nothing found', 'and the reason in the status line');
  assert.strictEqual(calls.streams, streamsBefore, 'without asking for the camera');
  api.close();

  /* The fallback button hands off and closes. */
  api.open({ preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(api.mode(), 'live', 'a fresh open is live again');
  root.querySelector('#gdPracticeCameraFallbackBtn').listeners.click[0]({ preventDefault() {} });
  assert.deepStrictEqual(calls.picks, ['camera']);
  assert.strictEqual(root.hidden, true);
}

/* ---- landscape page: nothing turns, no rotation on the way out ---- */
async function landscapePage() {
  const { win, calls } = boot({ viewport: [844, 390], stored: { gd_practice_camera_layout_v1: 'foresight-fsx-ball' } });
  const api = win.GolfDaddyPracticeCameraGuide;
  const LAY = win.GolfDaddyLaunchMonitorLayouts;
  api.open({ preventDefault() {}, stopPropagation() {} });
  const root = win.document.body.children.find((c) => c.attrs.id === 'gdPracticeCameraGuide');
  const stage = root.querySelector('#gdPracticeCameraStage');
  const video = root.querySelector('#gdPracticeCameraVideo');
  assert.strictEqual(api.turned(), false, 'a landscape page is not turned');
  assert.ok(stage.classList.contains('wide') && !stage.classList.contains('turned'), 'but the stage is wide: rail on the right');
  await tick();
  video.videoWidth = 1920; video.videoHeight = 1080;
  assert.strictEqual(api.capture(), true);
  const used = plain(api.lines());
  assert.strictEqual(api.scan(), true);
  const still = root.querySelector('#gdPracticeCameraStill');
  const out = win.document.canvases().find((c) => c !== still && c.ctxLog.some((e) => e.op === 'drawImage'));
  const frame = { x: used.left, y: used.top, w: used.right - used.left, h: used.bottom - used.top };
  const crop = LAY.coverCrop(1920, 1080, 844, 390, frame, 0.08);
  assert.deepStrictEqual([out.width, out.height], [crop.sw, crop.sh], 'the crop is saved as it is');
  assert.ok(!out.ctxLog.some((e) => e.op === 'rotate'), 'no rotation');
  const tag = calls.photos[0].__gdTemplateFrame;
  const src = LAY.coverRect(1920, 1080, 844, 390, frame);
  assert.ok(Math.abs(tag.x - (src.x - crop.sx) / crop.sw) < 1e-9 && Math.abs(tag.w - src.w / crop.sw) < 1e-9, 'the frame fraction allows for a margin cut short by the picture edge');
  assert.ok(crop.sx === 0 && tag.x < 0.08 / 1.16, 'which it was here, on the left');
  assert.strictEqual(tag.columns.length, LAY.get('foresight-fsx-ball').columns.length);
  assert.deepStrictEqual(calls.templates, ['foresight-fsx-ball']);

  /* A layout with no columns has nothing to template: the scanner reads the header itself. */
  api.open({ preventDefault() {}, stopPropagation() {} });
  api.setLayout('generic');
  await tick();
  video.videoWidth = 1920; video.videoHeight = 1080;
  assert.strictEqual(api.capture(), true);
  assert.deepStrictEqual(plain(api.lines().bounds), [], 'no column lines');
  assert.strictEqual(api.scan(), true);
  assert.deepStrictEqual(calls.templates, ['foresight-fsx-ball', ''], 'no template for the generic layout');
  assert.deepStrictEqual(plain(calls.photos[1].__gdTemplateFrame.columns), [], 'and no column lines on the file');
  assert.ok(calls.photos[1].__gdTemplateFrame.headerBottom > 0, 'but the header line is still there');
}

portraitPhone()
  .then(landscapePage)
  .then(() => console.log('ok - guided camera: wiring, fallback, template per layout, turned stage, adjust stage, upright cropped capture'))
  .catch((e) => { console.error(e); process.exit(1); });

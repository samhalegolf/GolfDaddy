/*
 * The guided camera (scripts/gd-practice-camera-guide.js) sits between the
 * Take photo button and the scanner. What is pinned here:
 *
 *   - the page loads the layouts before the camera module, and the button
 *     opens the guided camera with the old capture input kept as fallback;
 *   - with no getUserMedia the module hands straight off to the phone
 *     camera and never touches the DOM;
 *   - with a camera it builds the overlay, remembers the chosen layout,
 *     draws one template per layout, and a captured frame reaches
 *     gdHandleLaunchMonitorPhoto cropped to the frame with the layout's name
 *     on the file;
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
assert.ok(fs.existsSync(path.join(ROOT, 'styles/inline/gd-practice-camera-guide.css')), 'and exists');

const button = markup.match(/<label[^>]*id="gdPracticeCameraLabel"[^>]*>/);
assert.ok(button, 'the Take photo button is still there');
assert.ok(/gdOpenPracticeCameraGuide\(event\)/.test(button[0]), 'it opens the guided camera');
assert.ok(/gdPickPracticePhotoFile\(event,'camera'\)/.test(button[0]), 'and keeps the phone camera when the module is missing');
assert.ok(/<input[^>]*id="gdPracticeCameraInput"[^>]*capture="environment"/.test(markup), 'the capture input stays as the fallback');

/* ---- a tiny DOM, enough for the module ---- */
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
      getBoundingClientRect() { return { width: this.rectW || 0, height: this.rectH || 0 }; },
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
    createElement: (tag) => node(tag),
    createElementNS: (ns, tag) => node(tag, ns),
    querySelectorAll: (sel) => body.querySelectorAll(sel)
  };
  return doc;
}

function boot({ camera = true, viewport = [390, 844], stored = {} } = {}) {
  const calls = { photos: [], picks: [], feedback: [], tracks: [] };
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
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ stop: () => calls.tracks.push('stopped') }]
        })
      } : undefined
    },
    gdHandleLaunchMonitorPhoto: (file) => calls.photos.push(file),
    gdPickPracticePhotoFile: (event, mode) => { calls.picks.push(mode); return false; },
    gdPracticeFeedback: (message) => calls.feedback.push(message)
  };
  win.window = win;
  win.globalThis = win;
  win.document = makeDocument();
  win.document.body.classList = win.document.body.classList;
  const ctx = vm.createContext(win);
  vm.runInContext(i18nSrc, ctx, { filename: 'gd-i18n.js' });
  vm.runInContext(enSrc, ctx, { filename: 'en.js' });
  vm.runInContext(layoutsSrc, ctx, { filename: 'layouts.js' });
  vm.runInContext(moduleSrc, ctx, { filename: 'camera.js' });
  return { win, calls, storage };
}

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
  new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.strictEqual(root.hidden, true, 'a refusal closes it');
    assert.deepStrictEqual(calls.picks, ['camera'], 'and hands off to the phone camera');
    assert.ok(calls.feedback.some((m) => m === win.GDI18n.t('dataPage.cameraGuideDenied')), 'saying so');
    win.gdOpenPracticeCameraGuide({ preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(root.hidden, true, 'the next tap does not reopen the viewfinder');
    assert.deepStrictEqual(calls.picks, ['camera', 'camera'], 'it goes straight to the phone camera, inside the tap');
  });
}

/* ---- with a camera: the overlay, the layouts, the capture ---- */
{
  const { win, calls, storage } = boot({ stored: { gd_practice_camera_layout_v1: 'garmin-r10' } });
  const api = win.GolfDaddyPracticeCameraGuide;
  assert.strictEqual(api.supported(), true);
  assert.strictEqual(api.layoutKey(), 'garmin-r10', 'the last layout used is remembered');

  const opened = api.open({ preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(opened, false, 'the click is consumed');
  const root = win.document.body.children.find((c) => c.attrs.id === 'gdPracticeCameraGuide');
  assert.ok(root, 'the overlay is on the page');
  assert.strictEqual(root.hidden, false);
  assert.ok(root.classList.contains('open'));
  assert.ok(win.document.body.classList.contains('gdPracticeCameraOpen'), 'the page behind it is marked');

  const chips = root.querySelectorAll('.gdPracticeCameraChip');
  const layouts = win.GolfDaddyLaunchMonitorLayouts.list();
  assert.strictEqual(chips.length, layouts.length, 'one chip per layout');
  assert.strictEqual(chips.find((c) => c.attrs['aria-checked'] === 'true').attrs['data-layout'], 'garmin-r10');

  const video = root.querySelector('#gdPracticeCameraVideo');
  assert.strictEqual(video.attrs.playsinline, '', 'inline video so iOS does not go full screen');
  assert.strictEqual(video.muted, true);

  /* Words come from the translation layer, not hard-coded English. */
  const title = root.querySelector('.gdPracticeCameraTitle').children[0];
  assert.strictEqual(title.attrs['data-i18n'], 'dataPage.cameraGuideTitle');
  assert.strictEqual(title.textContent, win.GDI18n.t('dataPage.cameraGuideTitle'));
  assert.notStrictEqual(title.textContent, 'dataPage.cameraGuideTitle', 'and English has the word');
  assert.strictEqual(root.querySelector('#gdPracticeCameraShutterBtn').attrs['aria-label'], win.GDI18n.t('dataPage.takePhoto'));

  /* Every layout draws a template with a frame, header band and row guides. */
  root.rectW = 390; root.rectH = 844;
  layouts.forEach((layout) => {
    api.setLayout(layout.key);
    assert.strictEqual(storage.gd_practice_camera_layout_v1, layout.key, 'choice is saved: ' + layout.key);
    assert.strictEqual(win.__gdPracticeCameraLayout, layout.key, 'and exposed for the scanner');
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
    if (layout.tableAspect >= 1.6) assert.ok(note.textContent.includes(win.GDI18n.t('dataPage.cameraGuideRotate')), layout.key + ' says to turn the phone for a wide table');
  });

  /* Capture before the stream is up does nothing. */
  api.setLayout('foresight-fsx-ball');
  assert.strictEqual(api.capture(), false, 'no frame yet, no capture');
  assert.strictEqual(calls.photos.length, 0);

  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.strictEqual(video.srcObject && typeof video.srcObject.getTracks, 'function', 'the stream is on the video');

    /* Pretend the camera delivered 1080p and the frame fills the screen. */
    video.videoWidth = 1920; video.videoHeight = 1080;
    let drawn = null;
    const canvasProto = { getContext: () => ({ drawImage: (...args) => { drawn = args; } }), toBlob: (cb, type) => cb(new win.Blob(['jpeg'], { type })) };
    const realCreate = win.document.createElement;
    win.document.createElement = (tag) => (tag === 'canvas' ? Object.create(canvasProto) : realCreate(tag));

    assert.strictEqual(api.capture(), true);
    assert.strictEqual(calls.photos.length, 1, 'one photo handed to the scanner');
    const file = calls.photos[0];
    assert.ok(/^clarity-camera-foresight-fsx-ball-\d{8}T\d{6}\.jpg$/.test(file.name), 'file carries the layout name: ' + file.name);
    assert.strictEqual(file.type, 'image/jpeg');
    const geo = api.geometry();
    assert.ok(geo && geo.frame.w > 0, 'the template that was on screen is the one the shot is cut to');
    const crop = win.GolfDaddyLaunchMonitorLayouts.coverCrop(1920, 1080, geo.viewport.width, geo.viewport.height, geo.frame, 0.08);
    assert.deepStrictEqual(drawn.slice(1, 5), [crop.sx, crop.sy, crop.sw, crop.sh], 'the saved picture is the framed table plus margin');
    assert.ok(crop.sw >= 520 && crop.sh >= 180, 'and big enough for the scanner\'s small-image gate');

    assert.strictEqual(root.hidden, true, 'the camera closes after the shot');
    assert.ok(calls.tracks.includes('stopped'), 'and the camera light goes off');
    assert.ok(!win.document.body.classList.contains('gdPracticeCameraOpen'));
    assert.deepStrictEqual(calls.picks, [], 'the phone camera was never needed');

    /* The fallback button hands off and closes. */
    api.open({ preventDefault() {}, stopPropagation() {} });
    root.querySelector('#gdPracticeCameraFallbackBtn').listeners.click[0]({ preventDefault() {} });
    assert.deepStrictEqual(calls.picks, ['camera']);
    assert.strictEqual(root.hidden, true);
    console.log('ok - guided camera: wiring, fallback, template per layout, cropped capture');
  });
}

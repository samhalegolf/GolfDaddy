/* Guided camera for the practice photo scanner.
 *
 * "Take photo" used to hand off to the phone's own camera app, which cannot
 * show anything of ours on top of the viewfinder. This opens the camera inside
 * the app instead (getUserMedia on the back camera) and draws a template for
 * the chosen launch monitor over the live picture: where the header row goes,
 * where the shots go, where the averages are, and the column order to expect.
 *
 * A shot table is wide, so the viewfinder is landscape first. On a portrait
 * page (orientation lock is the normal case on a phone) the controls and the
 * template turn a quarter turn, so the player holds the phone sideways and
 * the frame gets the long side of the screen. The camera picture itself is
 * not turned: with the phone on its side the sensor already shows the table
 * the way the player sees it. Only a portrait-shaped table (a same-phone app)
 * keeps the upright layout.
 *
 * The shutter does not save a photo straight away. It freezes the picture and
 * the same screen becomes the adjust stage: the template's lines - the frame
 * edges, the bottom of the header, and every column boundary - sit on the
 * frozen shot and each can be dragged a little onto the real edge. Scan then
 * cuts the framed table (plus a small margin) out of the still, tags the file
 * with where the frame and the lines are, and hands it to the same scanner
 * entry point the file picker uses. A photo from here never goes to the
 * 4-corner stretch: the lines are the fit.
 *
 * Where the in-app camera is not available - no getUserMedia, permission
 * refused, or an old webview - it falls back to the phone camera through the
 * existing capture input, so the button never dead-ends.
 *
 * Layouts and the geometry come from scripts/gd-launch-monitor-layouts.js.
 */
(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : globalThis;
  var STORAGE_KEY = 'gd_practice_camera_layout_v1';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  /* The saved photo is the frame plus this much of the frame's size on each
     side, so the scanner has some context to work with. */
  var CAPTURE_MARGIN = 0.08;
  /* How close a finger has to be to a line to pick it up, and the least room
     left between two lines, both in CSS pixels. */
  var GRAB = 22;
  var MIN_GAP = 12;

  var state = {
    root: null,
    stage: null,
    video: null,
    still: null,
    svg: null,
    stream: null,
    layoutKey: null,
    opening: false,
    /* Set once the in-app camera has failed here (permission refused, no
       back camera). The next tap goes straight to the phone camera, inside
       the tap, where a file input is allowed to open. */
    nativeOnly: false,
    /* 'live' is the viewfinder; 'adjust' is the frozen shot with the lines. */
    mode: 'live',
    turned: false,
    page: { w: 0, h: 0 },
    local: { w: 0, h: 0 },
    geometry: null,
    /* Adjust stage, in stage (local) pixels: the frame edges, the bottom of
       the header band, and the left edge of every column (the first one is
       the right edge of the label column). */
    lines: null,
    linesFor: null,
    drag: null
  };

  function layoutsApi() {
    return win.GolfDaddyLaunchMonitorLayouts || null;
  }

  function t(key, vars) {
    try {
      if (win.GDI18n && typeof win.GDI18n.t === 'function') return win.GDI18n.t(key, vars);
    } catch (e) {}
    return key;
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function feedback(message, tone, opts) {
    if (typeof win.gdPracticeFeedback === 'function') {
      safe(function () { win.gdPracticeFeedback(message, tone || '', opts || {}); });
    }
  }

  function supported() {
    return !!(win.navigator && win.navigator.mediaDevices && typeof win.navigator.mediaDevices.getUserMedia === 'function'
      && typeof win.document !== 'undefined' && typeof win.document.createElement === 'function');
  }

  function savedLayoutKey() {
    var api = layoutsApi();
    var key = safe(function () { return win.localStorage.getItem(STORAGE_KEY); }, null);
    if (api && key && api.get(key)) return key;
    return api ? api.DEFAULT_KEY : null;
  }

  function rememberLayoutKey(key) {
    safe(function () { win.localStorage.setItem(STORAGE_KEY, String(key)); });
  }

  function currentLayout() {
    var api = layoutsApi();
    if (!api) return null;
    return api.get(state.layoutKey) || api.get(api.DEFAULT_KEY);
  }

  function hasLabelColumn(layout) {
    return !!(layout && Number(layout.labelColumn) > 0 && Array.isArray(layout.columns) && layout.columns.length);
  }

  /* ---------- DOM ---------- */

  function el(tag, className, attrs) {
    var node = win.document.createElement(tag);
    if (className) node.className = className;
    if (attrs) Object.keys(attrs).forEach(function (name) { node.setAttribute(name, attrs[name]); });
    return node;
  }

  function svgEl(tag, attrs) {
    var node = win.document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (name) { node.setAttribute(name, attrs[name]); });
    return node;
  }

  function button(className, id, i18nKey, aria) {
    var attrs = { type: 'button', id: id };
    attrs[aria ? 'data-i18n-aria-label' : 'data-i18n'] = i18nKey;
    var node = el('button', className, attrs);
    if (aria) node.setAttribute('aria-label', t(i18nKey));
    else node.textContent = t(i18nKey);
    return node;
  }

  function build() {
    if (state.root) return state.root;
    var doc = win.document;
    var root = el('div', 'gdPracticeCameraGuide', { id: 'gdPracticeCameraGuide', role: 'dialog', 'aria-modal': 'true', hidden: '' });
    root.setAttribute('aria-label', t('dataPage.cameraGuideTitle'));
    root.setAttribute('data-i18n-aria-label', 'dataPage.cameraGuideTitle');

    /* The picture: live video, or the frozen shot. Both sit in page
       coordinates and fill the page with object-fit: cover. */
    var video = el('video', 'gdPracticeCameraVideo', { id: 'gdPracticeCameraVideo', autoplay: '', muted: '', playsinline: '' });
    video.muted = true;
    video.setAttribute('webkit-playsinline', '');
    root.appendChild(video);
    var still = el('canvas', 'gdPracticeCameraStill', { id: 'gdPracticeCameraStill', hidden: '' });
    root.appendChild(still);

    /* The stage holds the template and the controls. On a portrait page it is
       turned a quarter turn for a wide table (see measure()). */
    var stage = el('div', 'gdPracticeCameraStage', { id: 'gdPracticeCameraStage' });
    root.appendChild(stage);

    var svg = svgEl('svg', { 'class': 'gdPracticeCameraOverlay', 'aria-hidden': 'true', focusable: 'false' });
    stage.appendChild(svg);

    var title = el('div', 'gdPracticeCameraTitle');
    var titleStrong = el('strong', null, { 'data-i18n': 'dataPage.cameraGuideTitle' });
    titleStrong.textContent = t('dataPage.cameraGuideTitle');
    var titleHint = el('span', null, { id: 'gdPracticeCameraHint', 'data-i18n': 'dataPage.cameraGuideHint' });
    titleHint.textContent = t('dataPage.cameraGuideHint');
    title.appendChild(titleStrong);
    title.appendChild(titleHint);
    stage.appendChild(title);

    var chips = el('div', 'gdPracticeCameraChips', { id: 'gdPracticeCameraChips', role: 'radiogroup' });
    chips.setAttribute('aria-label', t('dataPage.cameraGuideLayout'));
    chips.setAttribute('data-i18n-aria-label', 'dataPage.cameraGuideLayout');
    stage.appendChild(chips);

    var closeBtn = button('gdPracticeCameraClose', 'gdPracticeCameraCloseBtn', 'common.cancel', true);
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener('click', function (event) { event.preventDefault(); close(); });
    stage.appendChild(closeBtn);

    /* An empty grid cell: where the picture area is, so the template can be
       measured off the real layout instead of guessed. */
    stage.appendChild(el('div', 'gdPracticeCameraPic', { 'aria-hidden': 'true' }));

    var ribbon = el('div', 'gdPracticeCameraRibbon', { id: 'gdPracticeCameraRibbon' });
    var note = el('div', 'gdPracticeCameraNote', { id: 'gdPracticeCameraNote' });
    var status = el('div', 'gdPracticeCameraStatus', { id: 'gdPracticeCameraStatus', 'aria-live': 'polite' });
    stage.appendChild(ribbon);
    stage.appendChild(note);
    stage.appendChild(status);

    /* The rail: shutter and phone-camera fallback while live; Scan, Retake
       and Reset on the frozen shot. */
    var actions = el('div', 'gdPracticeCameraActions');
    var fallbackBtn = button('gdPracticeCameraFallback', 'gdPracticeCameraFallbackBtn', 'dataPage.cameraGuideNative');
    fallbackBtn.addEventListener('click', function (event) { fallbackToNativeCamera(event); });
    var shutter = button('gdPracticeCameraShutter', 'gdPracticeCameraShutterBtn', 'dataPage.takePhoto', true);
    shutter.innerHTML = '<span aria-hidden="true"></span>';
    shutter.addEventListener('click', function (event) { event.preventDefault(); capture(); });
    var scanBtn = button('gdPracticeCameraScan', 'gdPracticeCameraScanBtn', 'dataPage.scan');
    scanBtn.addEventListener('click', function (event) { event.preventDefault(); scan(); });
    var retakeBtn = button('gdPracticeCameraRetake', 'gdPracticeCameraRetakeBtn', 'dataPage.cameraGuideRetake');
    retakeBtn.addEventListener('click', function (event) { event.preventDefault(); retake(); });
    var resetBtn = button('gdPracticeCameraReset', 'gdPracticeCameraResetBtn', 'dataPage.cameraGuideReset');
    resetBtn.addEventListener('click', function (event) { event.preventDefault(); resetLines(); });
    actions.appendChild(fallbackBtn);
    actions.appendChild(shutter);
    actions.appendChild(scanBtn);
    actions.appendChild(retakeBtn);
    actions.appendChild(resetBtn);
    stage.appendChild(actions);

    (doc.body || doc.documentElement).appendChild(root);

    state.root = root;
    state.stage = stage;
    state.video = video;
    state.still = still;
    state.svg = svg;

    buildChips();
    bindLines(svg);
    setMode('live');

    win.addEventListener('resize', function () { if (isOpen()) draw(); });
    win.addEventListener('orientationchange', function () { if (isOpen()) setTimeout(draw, 120); });
    root.addEventListener('keydown', function (event) { if (event.key === 'Escape') close(); });
    video.addEventListener('loadedmetadata', function () { draw(); });
    if (win.GDI18n && typeof win.GDI18n.onChange === 'function') {
      win.GDI18n.onChange(function () { if (state.root) { safe(function () { win.GDI18n.apply(state.root); }); draw(); } });
    }
    return root;
  }

  function buildChips() {
    var api = layoutsApi();
    var chips = state.stage && state.stage.querySelector('#gdPracticeCameraChips');
    if (!api || !chips) return;
    chips.innerHTML = '';
    api.list().forEach(function (layout) {
      var chip = el('button', 'gdPracticeCameraChip', { type: 'button', role: 'radio', 'data-layout': layout.key, 'aria-checked': 'false' });
      chip.textContent = layout.label;
      chip.title = layout.screen;
      chip.addEventListener('click', function (event) { event.preventDefault(); setLayout(layout.key); });
      chips.appendChild(chip);
    });
  }

  function isOpen() {
    return !!(state.root && !state.root.hidden);
  }

  function setStatus(text) {
    var node = state.stage && state.stage.querySelector('#gdPracticeCameraStatus');
    if (node) node.textContent = text || '';
  }

  function setHidden(node, hidden) {
    if (!node) return;
    node.hidden = !!hidden;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  function show(id, on) {
    setHidden(state.stage && state.stage.querySelector('#' + id), !on);
  }

  function setMode(mode) {
    state.mode = mode;
    var adjust = mode === 'adjust';
    if (state.stage) state.stage.classList.toggle('adjust', adjust);
    setHidden(state.still, !adjust);
    setHidden(state.video, adjust);
    show('gdPracticeCameraShutterBtn', !adjust);
    show('gdPracticeCameraFallbackBtn', !adjust);
    show('gdPracticeCameraChips', !adjust);
    show('gdPracticeCameraScanBtn', adjust);
    show('gdPracticeCameraRetakeBtn', adjust);
    show('gdPracticeCameraResetBtn', adjust);
  }

  /* ---------- where things are ---------- */

  /* The page is what the picture fills. The stage is the page, or the page
     turned a quarter turn when a wide table is framed on a portrait page. */
  function measure() {
    var api = layoutsApi();
    var layout = currentLayout();
    var box = state.root && state.root.getBoundingClientRect ? state.root.getBoundingClientRect() : null;
    var pageW = Math.max(1, Math.round(Number(win.innerWidth) || (box && box.width) || 1));
    var pageH = Math.max(1, Math.round(Number(win.innerHeight) || (box && box.height) || 1));
    var turned = !!(api && api.wantsTurn(layout, pageW, pageH));
    var localW = turned ? pageH : pageW;
    var localH = turned ? pageW : pageH;
    state.turned = turned;
    state.page = { w: pageW, h: pageH };
    state.local = { w: localW, h: localH };
    if (state.stage) {
      state.stage.classList.toggle('turned', turned);
      state.stage.classList.toggle('wide', localW > localH);
      state.stage.style.width = localW + 'px';
      state.stage.style.height = localH + 'px';
    }
  }

  /* How much of the stage the chrome takes, read off the picture cell of the
     grid. offsetTop and friends are layout values, so the turned stage reads
     the same as an upright one. Without a layout engine, sensible shares. */
  function insets() {
    var lw = state.local.w;
    var lh = state.local.h;
    var pic = state.stage && state.stage.querySelector('.gdPracticeCameraPic');
    if (pic && Number(pic.offsetWidth) > 0 && Number(pic.offsetHeight) > 0) {
      return {
        top: pic.offsetTop,
        bottom: Math.max(0, lh - pic.offsetTop - pic.offsetHeight),
        left: pic.offsetLeft,
        right: Math.max(0, lw - pic.offsetLeft - pic.offsetWidth),
        gutter: 8
      };
    }
    if (lw > lh) return { top: Math.round(lh * 0.13), bottom: Math.round(lh * 0.17), left: 0, right: Math.round(lw * 0.12), gutter: 8 };
    return { top: Math.round(lh * 0.14), bottom: Math.round(lh * 0.30), left: 0, right: 0 };
  }

  /* A pointer event's place on the stage. */
  function localPoint(event) {
    var box = state.root && state.root.getBoundingClientRect ? state.root.getBoundingClientRect() : {};
    var px = (Number(event.clientX) || 0) - (Number(box.left) || 0);
    var py = (Number(event.clientY) || 0) - (Number(box.top) || 0);
    var api = layoutsApi();
    if (state.turned && api) return api.pageToTurnedPoint(px, py, state.local.h);
    return { x: px, y: py };
  }

  /* ---------- the template ---------- */

  function ribbonText(layout) {
    if (!layout || !layout.columns || !layout.columns.length) return '';
    return layout.columns.map(function (column) { return column.label; }).join(' · ');
  }

  function linesFromGeometry(geo) {
    var f = geo.frame;
    return {
      left: f.x,
      top: f.y,
      right: f.x + f.w,
      bottom: f.y + f.h,
      headerBottom: geo.header.y + geo.header.h,
      bounds: geo.columns.map(function (column) { return Math.round(column.x); })
    };
  }

  /* The stage changed size under the lines (the phone was turned with
     auto-rotate on): keep them where they were, proportionally. */
  function rescaleLines(lines, from, to) {
    var sx = to.w / Math.max(1, from.w);
    var sy = to.h / Math.max(1, from.h);
    return {
      left: lines.left * sx,
      right: lines.right * sx,
      top: lines.top * sy,
      bottom: lines.bottom * sy,
      headerBottom: lines.headerBottom * sy,
      bounds: lines.bounds.map(function (x) { return x * sx; })
    };
  }

  function draw() {
    var api = layoutsApi();
    var layout = currentLayout();
    if (!api || !layout || !state.svg || !state.stage) return;
    measure();
    var lw = state.local.w;
    var lh = state.local.h;
    var geo = api.guideGeometry(layout, lw, lh, insets());
    state.geometry = geo;
    if (state.mode === 'adjust') {
      if (!state.lines) state.lines = linesFromGeometry(geo);
      else if (state.linesFor && (state.linesFor.w !== lw || state.linesFor.h !== lh)) state.lines = rescaleLines(state.lines, state.linesFor, { w: lw, h: lh });
    }
    state.linesFor = { w: lw, h: lh };

    var svg = state.svg;
    svg.setAttribute('viewBox', '0 0 ' + lw + ' ' + lh);
    svg.setAttribute('width', lw);
    svg.setAttribute('height', lh);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (state.mode === 'adjust') drawAdjust(svg, layout, lw, lh);
    else drawLive(svg, geo, lw, lh);

    var ribbon = state.stage.querySelector('#gdPracticeCameraRibbon');
    if (ribbon) {
      var text = ribbonText(layout);
      ribbon.textContent = text;
      setHidden(ribbon, !text);
    }
    var note = state.stage.querySelector('#gdPracticeCameraNote');
    if (note) {
      var parts = [];
      if (state.turned) parts.push(t('dataPage.cameraGuideRotate'));
      if (layout.device === 'phone') parts.push(t('dataPage.cameraGuideScreenshot'));
      if (layout.note) parts.push(layout.note);
      note.textContent = parts.join(' ');
      setHidden(note, !parts.length || state.mode === 'adjust');
    }
  }

  function dim(svg, lw, lh, f) {
    svg.appendChild(svgEl('path', {
      d: 'M0 0H' + lw + 'V' + lh + 'H0Z M' + f.x + ' ' + f.y + 'h' + f.w + 'v' + f.h + 'h' + (-f.w) + 'Z',
      'fill-rule': 'evenodd',
      'class': 'gdCamMask'
    }));
  }

  function bandTags(svg, f, summaryRows) {
    var headerTag = svgEl('text', { x: f.x + 8, y: Math.max(12, f.y - 6), 'class': 'gdCamBandText' });
    headerTag.textContent = t('dataPage.cameraGuideHeader');
    svg.appendChild(headerTag);
    var shotsTag = svgEl('text', { x: f.x + f.w - 8, y: Math.max(12, f.y - 6), 'class': 'gdCamBandText', 'text-anchor': 'end' });
    shotsTag.textContent = t('dataPage.cameraGuideShots');
    svg.appendChild(shotsTag);
    if (summaryRows && summaryRows.length) {
      var summaryTag = svgEl('text', { x: f.x + 8, y: f.y + f.h + 14, 'class': 'gdCamBandText' });
      summaryTag.textContent = summaryRows.join(' / ');
      svg.appendChild(summaryTag);
    }
  }

  /* Live: the template over the camera picture. */
  function drawLive(svg, geo, lw, lh) {
    var f = geo.frame;
    dim(svg, lw, lh, f);

    /* Header band, label column, summary band. */
    svg.appendChild(svgEl('rect', { x: geo.header.x, y: geo.header.y, width: geo.header.w, height: geo.header.h, 'class': 'gdCamHeader' }));
    if (geo.label.w > 0) {
      svg.appendChild(svgEl('rect', { x: geo.label.x, y: geo.label.y, width: geo.label.w, height: geo.label.h, 'class': 'gdCamLabelCol' }));
    }
    if (geo.summary) {
      svg.appendChild(svgEl('rect', { x: geo.summary.x, y: geo.summary.y, width: geo.summary.w, height: geo.summary.h, 'class': 'gdCamSummary' }));
    }

    /* Row guides. */
    geo.rows.forEach(function (y) {
      svg.appendChild(svgEl('line', { x1: geo.body.x, y1: y, x2: geo.body.x + geo.body.w, y2: y, 'class': 'gdCamRow' }));
    });

    /* Column ticks and short names when there is room for them. */
    var showShort = geo.columns.length && geo.columns[0].w >= 30;
    geo.columns.forEach(function (column, index) {
      if (index > 0) {
        svg.appendChild(svgEl('line', { x1: column.x, y1: geo.header.y, x2: column.x, y2: geo.header.y + geo.header.h, 'class': 'gdCamTick' }));
      }
      if (showShort) {
        var text = svgEl('text', { x: column.x + column.w / 2, y: geo.header.y + geo.header.h / 2, 'class': 'gdCamColText', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        text.textContent = column.short || column.label;
        svg.appendChild(text);
      }
    });

    /* Frame last so it sits on top. */
    svg.appendChild(svgEl('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: 10, ry: 10, 'class': 'gdCamFrame' }));
    bandTags(svg, f, geo.summary && geo.summary.rows);
  }

  /* Adjust: the lines on the frozen shot, each with a handle. */
  function drawAdjust(svg, layout, lw, lh) {
    var L = state.lines;
    var f = { x: L.left, y: L.top, w: L.right - L.left, h: L.bottom - L.top };
    var active = state.drag ? state.drag.id : '';
    var label = hasLabelColumn(layout);
    dim(svg, lw, lh, f);

    svg.appendChild(svgEl('rect', { x: f.x, y: f.y, width: f.w, height: Math.max(0, L.headerBottom - L.top), 'class': 'gdCamHeader' }));
    if (label && L.bounds.length) {
      svg.appendChild(svgEl('rect', { x: L.left, y: L.headerBottom, width: Math.max(0, L.bounds[0] - L.left), height: Math.max(0, L.bottom - L.headerBottom), 'class': 'gdCamLabelCol' }));
    }

    /* Column lines, with the short name under the header in each slot. */
    var edges = L.bounds.concat([L.right]);
    var cols = Array.isArray(layout.columns) ? layout.columns : [];
    var slotMin = Infinity;
    for (var i = 0; i < L.bounds.length; i += 1) slotMin = Math.min(slotMin, edges[i + 1] - edges[i]);
    L.bounds.forEach(function (x, index) {
      if (index === 0 && !label) return;
      var id = 'b' + index;
      svg.appendChild(svgEl('line', { x1: x, y1: L.top, x2: x, y2: L.bottom, 'class': 'gdCamLine' + (active === id ? ' active' : '') }));
    });
    if (slotMin >= 26) {
      cols.forEach(function (column, index) {
        var text = svgEl('text', { x: (edges[index] + edges[index + 1]) / 2, y: L.headerBottom + 11, 'class': 'gdCamColText', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        text.textContent = column.short || column.label;
        svg.appendChild(text);
      });
    }

    /* Header bottom and the frame. */
    svg.appendChild(svgEl('line', { x1: L.left, y1: L.headerBottom, x2: L.right, y2: L.headerBottom, 'class': 'gdCamLine header' + (active === 'header' ? ' active' : '') }));
    svg.appendChild(svgEl('rect', { x: f.x, y: f.y, width: f.w, height: f.h, 'class': 'gdCamFrame adjust' }));

    /* Handles last so they sit on top. */
    handles(layout).forEach(function (h) {
      svg.appendChild(svgEl('circle', { cx: h.hx, cy: h.hy, r: h.kind === 'edge' ? 9 : 8, 'class': 'gdCamHandle ' + h.kind + (active === h.id ? ' active' : '') }));
    });
    bandTags(svg, f, null);
  }

  /* Every draggable line: its id, which way it runs, where it is, and where
     its handle is drawn. */
  function handles(layout) {
    var L = state.lines;
    if (!L) return [];
    var out = [];
    var label = hasLabelColumn(layout);
    var midX = (L.left + L.right) / 2;
    var midY = (L.top + L.bottom) / 2;
    var headY = (L.top + L.headerBottom) / 2;
    out.push({ id: 'left', axis: 'v', kind: 'edge', at: L.left, hx: L.left, hy: midY });
    out.push({ id: 'right', axis: 'v', kind: 'edge', at: L.right, hx: L.right, hy: midY });
    out.push({ id: 'top', axis: 'h', kind: 'edge', at: L.top, hx: midX, hy: L.top });
    out.push({ id: 'bottom', axis: 'h', kind: 'edge', at: L.bottom, hx: midX, hy: L.bottom });
    /* The header handle sits in the label column, clear of the column lines. */
    var headerHandleX = label && L.bounds.length ? (L.left + L.bounds[0]) / 2 : L.left + 18;
    out.push({ id: 'header', axis: 'h', kind: 'header', at: L.headerBottom, hx: headerHandleX, hy: L.headerBottom });
    L.bounds.forEach(function (x, index) {
      if (index === 0 && !label) return;
      out.push({ id: 'b' + index, axis: 'v', kind: 'column', index: index, at: x, hx: x, hy: headY });
    });
    return out;
  }

  /* The line under a finger: its handle first, then the line itself. */
  function pick(point, layout) {
    var L = state.lines;
    var list = handles(layout);
    var best = null;
    var bestD = GRAB;
    list.forEach(function (h) {
      var d = Math.hypot(h.hx - point.x, h.hy - point.y);
      if (d <= bestD) { best = h; bestD = d; }
    });
    if (best) return best;
    bestD = GRAB;
    list.forEach(function (h) {
      var d;
      if (h.axis === 'v') d = (point.y >= L.top - GRAB && point.y <= L.bottom + GRAB) ? Math.abs(h.at - point.x) : Infinity;
      else d = (point.x >= L.left - GRAB && point.x <= L.right + GRAB) ? Math.abs(h.at - point.y) : Infinity;
      if (d <= bestD) { best = h; bestD = d; }
    });
    return best;
  }

  /* Move one line, kept in order with its neighbours. */
  function moveLine(handle, point, layout) {
    var L = state.lines;
    var label = hasLabelColumn(layout);
    var n = L.bounds.length;
    var lastInner = n ? L.bounds[n - 1] : L.left;
    switch (handle.id) {
      case 'left': {
        var firstInner = n ? (label ? L.bounds[0] : (n > 1 ? L.bounds[1] : L.right)) : L.right;
        L.left = clamp(point.x, 0, firstInner - MIN_GAP);
        if (n && !label) L.bounds[0] = L.left;
        break;
      }
      case 'right':
        L.right = clamp(point.x, lastInner + MIN_GAP, state.local.w);
        break;
      case 'top':
        L.top = clamp(point.y, 0, L.headerBottom - MIN_GAP);
        break;
      case 'bottom':
        L.bottom = clamp(point.y, L.headerBottom + MIN_GAP, state.local.h);
        break;
      case 'header':
        L.headerBottom = clamp(point.y, L.top + MIN_GAP, L.bottom - MIN_GAP);
        break;
      default: {
        var i = handle.index;
        var lo = (i === 0 ? L.left : L.bounds[i - 1]) + MIN_GAP;
        var hi = (i + 1 < n ? L.bounds[i + 1] : L.right) - MIN_GAP;
        L.bounds[i] = clamp(point.x, lo, hi);
      }
    }
  }

  function bindLines(svg) {
    svg.addEventListener('pointerdown', function (event) {
      if (state.mode !== 'adjust' || !state.lines) return;
      var handle = pick(localPoint(event), currentLayout());
      if (!handle) return;
      state.drag = handle;
      safe(function () { svg.setPointerCapture(event.pointerId); });
      if (event.preventDefault) event.preventDefault();
      draw();
    });
    svg.addEventListener('pointermove', function (event) {
      if (!state.drag || !state.lines) return;
      moveLine(state.drag, localPoint(event), currentLayout());
      if (event.preventDefault) event.preventDefault();
      draw();
    });
    var end = function (event) {
      if (!state.drag) return;
      state.drag = null;
      safe(function () { svg.releasePointerCapture(event.pointerId); });
      draw();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  function resetLines() {
    if (state.mode !== 'adjust' || !state.geometry) return;
    state.lines = linesFromGeometry(state.geometry);
    draw();
  }

  function setLayout(key) {
    var api = layoutsApi();
    if (!api) return;
    var layout = api.get(key) || api.get(api.DEFAULT_KEY);
    if (!layout) return;
    state.layoutKey = layout.key;
    rememberLayoutKey(layout.key);
    win.__gdPracticeCameraLayout = layout.key;
    if (state.stage) {
      var chips = state.stage.querySelectorAll('.gdPracticeCameraChip');
      for (var i = 0; i < chips.length; i += 1) {
        var on = chips[i].getAttribute('data-layout') === layout.key;
        chips[i].classList.toggle('on', on);
        chips[i].setAttribute('aria-checked', on ? 'true' : 'false');
        if (on && typeof chips[i].scrollIntoView === 'function') {
          safe(function () { chips[i].scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); });
        }
      }
    }
    draw();
  }

  /* ---------- camera ---------- */

  function stopStream() {
    var stream = state.stream;
    state.stream = null;
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach(function (track) { safe(function () { track.stop(); }); });
    }
    if (state.video) {
      safe(function () { state.video.pause(); });
      safe(function () { state.video.srcObject = null; });
    }
  }

  function constraints() {
    return {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 }
      }
    };
  }

  function startStream() {
    state.opening = true;
    setStatus(t('dataPage.cameraGuideStarting'));
    win.navigator.mediaDevices.getUserMedia(constraints()).then(function (stream) {
      state.opening = false;
      if (!isOpen() || state.mode !== 'live') {
        stream.getTracks().forEach(function (track) { safe(function () { track.stop(); }); });
        return;
      }
      state.stream = stream;
      state.video.srcObject = stream;
      var playing = safe(function () { return state.video.play(); }, null);
      if (playing && typeof playing.catch === 'function') playing.catch(function () {});
      setStatus('');
      safe(function () { state.stage.querySelector('#gdPracticeCameraShutterBtn').focus({ preventScroll: true }); });
      draw();
    }).catch(function (error) {
      state.opening = false;
      state.nativeOnly = true;
      console.warn('[GolfDaddy] guided camera unavailable, using the phone camera', error);
      fallbackToNativeCamera(null, error && error.name ? error.name : 'error');
    });
  }

  function showOverlay() {
    setHidden(state.root, false);
    state.root.classList.add('open');
    safe(function () { win.document.body.classList.add('gdPracticeCameraOpen'); });
  }

  function open(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
    }
    if (state.nativeOnly || !supported() || !layoutsApi()) {
      return fallbackToNativeCamera(null, state.nativeOnly ? '' : 'unsupported');
    }
    if (state.opening) return false;
    build();
    if (!state.layoutKey) state.layoutKey = savedLayoutKey();
    state.lines = null;
    state.drag = null;
    setMode('live');
    showOverlay();
    setLayout(state.layoutKey);
    feedback(t('practice.openingCamera'), '', { state: 'idle' });
    startStream();
    return false;
  }

  function close() {
    stopStream();
    state.opening = false;
    state.drag = null;
    if (state.root) {
      state.root.classList.remove('open');
      setHidden(state.root, true);
    }
    safe(function () { win.document.body.classList.remove('gdPracticeCameraOpen'); });
  }

  function fallbackToNativeCamera(event, reason) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    var wasOpen = isOpen();
    close();
    if (wasOpen || reason) feedback(t('dataPage.cameraGuideDenied'), '', { state: 'idle' });
    if (typeof win.gdPickPracticePhotoFile === 'function') {
      return win.gdPickPracticePhotoFile(null, 'camera');
    }
    return false;
  }

  /* ---------- shutter, adjust, scan ---------- */

  /* The shutter: freeze the picture and bring the lines up on it. */
  function capture() {
    var video = state.video;
    var still = state.still;
    if (state.mode !== 'live' || !video || !still || !state.stream || !video.videoWidth || !video.videoHeight) {
      setStatus(t('dataPage.cameraGuideStarting'));
      return false;
    }
    var ctx = safe(function () { return still.getContext('2d'); }, null);
    if (!ctx) {
      setStatus(t('dataPage.cameraGuideDenied'));
      return false;
    }
    still.width = video.videoWidth;
    still.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, still.width, still.height);
    stopStream();
    state.lines = null;
    state.drag = null;
    setMode('adjust');
    draw();
    setStatus(t('dataPage.cameraGuideAdjust'));
    safe(function () { state.stage.querySelector('#gdPracticeCameraScanBtn').focus({ preventScroll: true }); });
    return true;
  }

  /* Back to the live picture. */
  function retake() {
    if (!state.root) return false;
    state.lines = null;
    state.drag = null;
    setMode('live');
    draw();
    if (!state.stream && !state.opening) startStream();
    return true;
  }

  /* A scan that found nothing brings the lines back on the same shot. */
  function reopenAdjust(message) {
    if (!state.root || !state.still || !state.still.width || !state.lines || !currentLayout()) return false;
    stopStream();
    state.drag = null;
    setMode('adjust');
    showOverlay();
    draw();
    setStatus(message || t('dataPage.cameraGuideAdjust'));
    return true;
  }

  function fileName(layout) {
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    return 'clarity-camera-' + (layout ? layout.key : 'table') + '-' + stamp + '.jpg';
  }

  /* Where the framed table sits in the still, in page pixels. */
  function pageFrame() {
    var L = state.lines;
    var api = layoutsApi();
    var local = { x: L.left, y: L.top, w: L.right - L.left, h: L.bottom - L.top };
    return state.turned && api ? api.turnedToPage(local, state.local.h) : local;
  }

  /* Cut the framed table (plus margin) out of the still, upright, and say
     where the frame and the lines are inside the saved picture. */
  function scan() {
    var api = layoutsApi();
    var layout = currentLayout();
    var still = state.still;
    var L = state.lines;
    if (state.mode !== 'adjust' || !api || !layout || !still || !still.width || !still.height || !L) return false;
    var frame = pageFrame();
    var crop = api.coverCrop(still.width, still.height, state.page.w, state.page.h, frame, CAPTURE_MARGIN);
    var src = api.coverRect(still.width, still.height, state.page.w, state.page.h, frame);
    var canvas = win.document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var turned = state.turned;
    if (turned) {
      /* The still holds the table on its side (the page is portrait, the
         phone is not). A quarter turn the other way stands it up. */
      canvas.width = crop.sh;
      canvas.height = crop.sw;
      ctx.translate(0, crop.sw);
      ctx.rotate(-Math.PI / 2);
    } else {
      canvas.width = crop.sw;
      canvas.height = crop.sh;
    }
    ctx.drawImage(still, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);

    var inSaved = turned
      ? { x: (src.y - crop.sy) / crop.sh, y: (crop.sx + crop.sw - src.x - src.w) / crop.sw, w: src.h / crop.sh, h: src.w / crop.sw }
      : { x: (src.x - crop.sx) / crop.sw, y: (src.y - crop.sy) / crop.sh, w: src.w / crop.sw, h: src.h / crop.sh };
    var fw = Math.max(1, L.right - L.left);
    var fh = Math.max(1, L.bottom - L.top);
    var templateFrame = {
      x: clamp(inSaved.x, 0, 1),
      y: clamp(inSaved.y, 0, 1),
      w: clamp(inSaved.w, 0, 1),
      h: clamp(inSaved.h, 0, 1),
      layout: layout.key,
      columns: L.bounds.map(function (x) { return clamp((x - L.left) / fw, 0, 1); }),
      headerBottom: clamp((L.headerBottom - L.top) / fh, 0, 1)
    };
    var name = fileName(layout);
    var finish = function (blob) {
      if (!blob) {
        setStatus(t('dataPage.cameraGuideDenied'));
        return;
      }
      var file;
      try {
        file = new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
      } catch (e) {
        file = blob;
        try { file.name = name; } catch (err) {}
      }
      try { file.__gdTemplateFrame = templateFrame; } catch (e) {}
      close();
      /* The photo was framed with this layout, so scan it with the same
         template. A layout that promises no columns has nothing to template:
         the scanner reads the header itself. */
      if (typeof win.gdPracticeSetScanTemplate === 'function') {
        safe(function () { win.gdPracticeSetScanTemplate(layout.columns && layout.columns.length ? layout.key : ''); });
      }
      if (typeof win.gdHandleLaunchMonitorPhoto === 'function') win.gdHandleLaunchMonitorPhoto(file);
    };
    if (typeof canvas.toBlob === 'function') canvas.toBlob(finish, 'image/jpeg', 0.92);
    else {
      var dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      var bytes = win.atob(dataUrl.split(',')[1]);
      var buffer = new Uint8Array(bytes.length);
      for (var i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
      finish(new Blob([buffer], { type: 'image/jpeg' }));
    }
    return true;
  }

  var api = {
    version: '2026-10-31',
    STORAGE_KEY: STORAGE_KEY,
    supported: supported,
    open: open,
    close: close,
    setLayout: setLayout,
    capture: capture,
    retake: retake,
    resetLines: resetLines,
    scan: scan,
    reopenAdjust: reopenAdjust,
    layoutKey: function () { return state.layoutKey || savedLayoutKey(); },
    geometry: function () { return state.geometry || null; },
    lines: function () { return state.lines || null; },
    mode: function () { return state.mode; },
    turned: function () { return state.turned; },
    ribbonText: ribbonText,
    isOpen: isOpen
  };

  win.GolfDaddyPracticeCameraGuide = api;
  win.gdOpenPracticeCameraGuide = open;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

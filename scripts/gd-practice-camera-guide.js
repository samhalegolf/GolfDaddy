/* Guided camera for the practice photo scanner.
 *
 * "Take photo" used to hand off to the phone's own camera app, which cannot
 * show anything of ours on top of the viewfinder. This opens the camera inside
 * the app instead (getUserMedia on the back camera) and draws a template for
 * the chosen launch monitor over the live picture: where the header row goes,
 * where the shots go, where the averages are, and the column order to expect.
 * The shutter saves just the framed table (plus a small margin) and hands it
 * to the same scanner entry point the file picker uses, so nothing downstream
 * changes.
 *
 * Where the in-app camera is not available - no getUserMedia, permission
 * refused, or an old webview - it falls back to the phone camera through the
 * existing capture input, so the button never dead-ends.
 *
 * Layouts come from scripts/gd-launch-monitor-layouts.js.
 */
(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : globalThis;
  var STORAGE_KEY = 'gd_practice_camera_layout_v1';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var state = {
    root: null,
    video: null,
    svg: null,
    stream: null,
    layoutKey: null,
    opening: false,
    /* Set once the in-app camera has failed here (permission refused, no
       back camera). The next tap goes straight to the phone camera, inside
       the tap, where a file input is allowed to open. */
    nativeOnly: false
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

  function build() {
    if (state.root) return state.root;
    var doc = win.document;
    var root = el('div', 'gdPracticeCameraGuide', { id: 'gdPracticeCameraGuide', role: 'dialog', 'aria-modal': 'true', hidden: '' });
    root.setAttribute('aria-label', t('dataPage.cameraGuideTitle'));
    root.setAttribute('data-i18n-aria-label', 'dataPage.cameraGuideTitle');

    var video = el('video', 'gdPracticeCameraVideo', { id: 'gdPracticeCameraVideo', autoplay: '', muted: '', playsinline: '' });
    video.muted = true;
    video.setAttribute('webkit-playsinline', '');
    root.appendChild(video);

    var svg = svgEl('svg', { 'class': 'gdPracticeCameraOverlay', 'aria-hidden': 'true', focusable: 'false' });
    root.appendChild(svg);

    var top = el('div', 'gdPracticeCameraTop');
    var title = el('div', 'gdPracticeCameraTitle');
    var titleStrong = el('strong', null, { 'data-i18n': 'dataPage.cameraGuideTitle' });
    titleStrong.textContent = t('dataPage.cameraGuideTitle');
    var titleHint = el('span', null, { id: 'gdPracticeCameraHint', 'data-i18n': 'dataPage.cameraGuideHint' });
    titleHint.textContent = t('dataPage.cameraGuideHint');
    title.appendChild(titleStrong);
    title.appendChild(titleHint);
    var closeBtn = el('button', 'gdPracticeCameraClose', { type: 'button', id: 'gdPracticeCameraCloseBtn', 'data-i18n-aria-label': 'common.cancel' });
    closeBtn.setAttribute('aria-label', t('common.cancel'));
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener('click', function (event) { event.preventDefault(); close(); });
    top.appendChild(title);
    top.appendChild(closeBtn);
    root.appendChild(top);

    var bottom = el('div', 'gdPracticeCameraBottom');
    var chipsLabel = el('div', 'gdPracticeCameraChipsLabel', { 'data-i18n': 'dataPage.cameraGuideLayout' });
    chipsLabel.textContent = t('dataPage.cameraGuideLayout');
    var chips = el('div', 'gdPracticeCameraChips', { id: 'gdPracticeCameraChips', role: 'radiogroup' });
    chips.setAttribute('aria-label', t('dataPage.cameraGuideLayout'));
    chips.setAttribute('data-i18n-aria-label', 'dataPage.cameraGuideLayout');
    var ribbon = el('div', 'gdPracticeCameraRibbon', { id: 'gdPracticeCameraRibbon' });
    var note = el('div', 'gdPracticeCameraNote', { id: 'gdPracticeCameraNote' });
    var status = el('div', 'gdPracticeCameraStatus', { id: 'gdPracticeCameraStatus', 'aria-live': 'polite' });
    var actions = el('div', 'gdPracticeCameraActions');
    var fallbackBtn = el('button', 'gdPracticeCameraFallback', { type: 'button', id: 'gdPracticeCameraFallbackBtn', 'data-i18n': 'dataPage.cameraGuideNative' });
    fallbackBtn.textContent = t('dataPage.cameraGuideNative');
    fallbackBtn.addEventListener('click', function (event) { fallbackToNativeCamera(event); });
    var shutter = el('button', 'gdPracticeCameraShutter', { type: 'button', id: 'gdPracticeCameraShutterBtn', 'data-i18n-aria-label': 'dataPage.takePhoto' });
    shutter.setAttribute('aria-label', t('dataPage.takePhoto'));
    shutter.innerHTML = '<span aria-hidden="true"></span>';
    shutter.addEventListener('click', function (event) { event.preventDefault(); capture(); });
    var spacer = el('div', 'gdPracticeCameraActionsSpacer');
    actions.appendChild(fallbackBtn);
    actions.appendChild(shutter);
    actions.appendChild(spacer);
    bottom.appendChild(chipsLabel);
    bottom.appendChild(chips);
    bottom.appendChild(ribbon);
    bottom.appendChild(note);
    bottom.appendChild(status);
    bottom.appendChild(actions);
    root.appendChild(bottom);

    (doc.body || doc.documentElement).appendChild(root);

    state.root = root;
    state.video = video;
    state.svg = svg;

    buildChips();

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
    var chips = state.root && state.root.querySelector('#gdPracticeCameraChips');
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
    var node = state.root && state.root.querySelector('#gdPracticeCameraStatus');
    if (node) node.textContent = text || '';
  }

  /* ---------- the template ---------- */

  function ribbonText(layout) {
    if (!layout || !layout.columns || !layout.columns.length) return '';
    return layout.columns.map(function (column) { return column.label; }).join(' · ');
  }

  function draw() {
    var api = layoutsApi();
    var layout = currentLayout();
    if (!api || !layout || !state.svg || !state.root) return;
    var box = state.root.getBoundingClientRect ? state.root.getBoundingClientRect() : { width: win.innerWidth, height: win.innerHeight };
    var vw = Math.max(1, Math.round(box.width || win.innerWidth || 1));
    var vh = Math.max(1, Math.round(box.height || win.innerHeight || 1));
    var top = state.root.querySelector('.gdPracticeCameraTop');
    var bottom = state.root.querySelector('.gdPracticeCameraBottom');
    var topH = top ? Math.round(top.getBoundingClientRect().height) + 8 : Math.round(vh * 0.14);
    var bottomH = bottom ? Math.round(bottom.getBoundingClientRect().height) + 8 : Math.round(vh * 0.3);
    var geo = api.guideGeometry(layout, vw, vh, { top: topH, bottom: bottomH });
    state.geometry = geo;

    var svg = state.svg;
    svg.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh);
    svg.setAttribute('width', vw);
    svg.setAttribute('height', vh);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var f = geo.frame;
    var r = 10;
    /* Dim everything that is not the table. */
    var mask = svgEl('path', {
      d: 'M0 0H' + vw + 'V' + vh + 'H0Z M' + f.x + ' ' + f.y + 'h' + f.w + 'v' + f.h + 'h' + (-f.w) + 'Z',
      'fill-rule': 'evenodd',
      'class': 'gdCamMask'
    });
    svg.appendChild(mask);

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
    svg.appendChild(svgEl('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: r, ry: r, 'class': 'gdCamFrame' }));

    /* Band names. */
    var headerTag = svgEl('text', { x: f.x + 8, y: Math.max(12, f.y - 6), 'class': 'gdCamBandText' });
    headerTag.textContent = t('dataPage.cameraGuideHeader');
    svg.appendChild(headerTag);
    var shotsTag = svgEl('text', { x: f.x + f.w - 8, y: Math.max(12, f.y - 6), 'class': 'gdCamBandText', 'text-anchor': 'end' });
    shotsTag.textContent = t('dataPage.cameraGuideShots');
    svg.appendChild(shotsTag);
    if (geo.summary) {
      var summaryTag = svgEl('text', { x: f.x + 8, y: f.y + f.h + 14, 'class': 'gdCamBandText' });
      summaryTag.textContent = geo.summary.rows.join(' / ');
      svg.appendChild(summaryTag);
    }

    var ribbon = state.root.querySelector('#gdPracticeCameraRibbon');
    if (ribbon) {
      var text = ribbonText(layout);
      ribbon.textContent = text;
      ribbon.hidden = !text;
    }
    var note = state.root.querySelector('#gdPracticeCameraNote');
    if (note) {
      var parts = [];
      if (geo.rotateHint) parts.push(t('dataPage.cameraGuideRotate'));
      if (layout.device === 'phone') parts.push(t('dataPage.cameraGuideScreenshot'));
      if (layout.note) parts.push(layout.note);
      note.textContent = parts.join(' ');
      note.hidden = !parts.length;
    }
  }

  function setLayout(key) {
    var api = layoutsApi();
    if (!api) return;
    var layout = api.get(key) || api.get(api.DEFAULT_KEY);
    if (!layout) return;
    state.layoutKey = layout.key;
    rememberLayoutKey(layout.key);
    win.__gdPracticeCameraLayout = layout.key;
    if (state.root) {
      var chips = state.root.querySelectorAll('.gdPracticeCameraChip');
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

  function open(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
    }
    if (state.nativeOnly || !supported() || !layoutsApi()) {
      return fallbackToNativeCamera(null, state.nativeOnly ? '' : 'unsupported');
    }
    if (state.opening) return false;
    state.opening = true;
    var root = build();
    if (!state.layoutKey) state.layoutKey = savedLayoutKey();
    root.hidden = false;
    root.classList.add('open');
    safe(function () { win.document.body.classList.add('gdPracticeCameraOpen'); });
    setStatus(t('dataPage.cameraGuideStarting'));
    setLayout(state.layoutKey);
    feedback(t('practice.openingCamera'), '', { state: 'idle' });

    win.navigator.mediaDevices.getUserMedia(constraints()).then(function (stream) {
      state.opening = false;
      if (!isOpen()) {
        stream.getTracks().forEach(function (track) { safe(function () { track.stop(); }); });
        return;
      }
      state.stream = stream;
      state.video.srcObject = stream;
      var playing = safe(function () { return state.video.play(); }, null);
      if (playing && typeof playing.catch === 'function') playing.catch(function () {});
      setStatus('');
      safe(function () { state.root.querySelector('#gdPracticeCameraShutterBtn').focus({ preventScroll: true }); });
      draw();
    }).catch(function (error) {
      state.opening = false;
      state.nativeOnly = true;
      console.warn('[GolfDaddy] guided camera unavailable, using the phone camera', error);
      fallbackToNativeCamera(null, error && error.name ? error.name : 'error');
    });
    return false;
  }

  function close() {
    stopStream();
    state.opening = false;
    if (state.root) {
      state.root.classList.remove('open');
      state.root.hidden = true;
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

  function fileName(layout) {
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    return 'clarity-camera-' + (layout ? layout.key : 'table') + '-' + stamp + '.jpg';
  }

  function capture() {
    var api = layoutsApi();
    var video = state.video;
    var layout = currentLayout();
    if (!api || !video || !state.stream || !video.videoWidth || !video.videoHeight) {
      setStatus(t('dataPage.cameraGuideStarting'));
      return false;
    }
    var geo = state.geometry || api.guideGeometry(layout, win.innerWidth, win.innerHeight);
    var crop = api.coverCrop(video.videoWidth, video.videoHeight, geo.viewport.width, geo.viewport.height, geo.frame, 0.08);
    var canvas = win.document.createElement('canvas');
    canvas.width = crop.sw;
    canvas.height = crop.sh;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
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
      close();
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
    version: '2026-10-19',
    STORAGE_KEY: STORAGE_KEY,
    supported: supported,
    open: open,
    close: close,
    setLayout: setLayout,
    capture: capture,
    layoutKey: function () { return state.layoutKey || savedLayoutKey(); },
    geometry: function () { return state.geometry || null; },
    ribbonText: ribbonText,
    isOpen: isOpen
  };

  win.GolfDaddyPracticeCameraGuide = api;
  win.gdOpenPracticeCameraGuide = open;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

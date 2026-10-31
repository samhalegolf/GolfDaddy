/* Launch monitor screen layouts - what a shot table looks like on each brand's
 * screen, so the guided camera can draw a template for it.
 *
 * The photo scanner (scripts/clarity-table-ocr.js) reads one shape: a header
 * row of metric names across the top, one shot per row underneath, and
 * sometimes AVERAGE / STD DEV rows at the bottom. Every brand prints that
 * shape a little differently - which columns, in what order, how wide, and
 * whether left/right is a suffix ("3.2 L") or a sign. This file is the list.
 *
 * Column `key`s are metric keys from gd-launch-monitor-alias-registry.js; a
 * null key is a column the scanner does not import (shot type, impact spot).
 * `confidence` says where the order came from: "documented" means the brand's
 * own manual, export or an in-repo fixture; "typical" means the brand's
 * published metric set in the order its app normally shows, which the player
 * may have re-ordered. The ribbon under the camera frame shows the order so a
 * player can tell at a glance whether their screen matches.
 *
 * Pure data plus pure geometry (guideGeometry, the cover-crop mapping and the
 * turned-viewport mapping). No DOM. Loaded by index.html and by
 * dev/launch-monitor-layouts.test.js under Node.
 */
(function () {
  'use strict';

  var target = typeof window !== 'undefined' ? window : globalThis;

  /* direction: the brand prints this column with a left/right marker (an L or
     R after the number, or a sign), so template mode reads it as a direction
     column and the scanner's deep scan looks for the marker. */
  function col(label, short, key, direction) {
    return { label: label, short: short, key: key === undefined ? null : key, direction: !!direction };
  }

  var layouts = [
    {
      key: 'foresight-fsx-ball',
      brand: 'Foresight',
      label: 'Foresight FSX - ball data',
      screen: 'FSX 2020 / FSX Play table view (GCQuad, GC3, Launch Pro, QuadMAX)',
      device: 'sim',
      orientation: 'landscape',
      theme: 'dark',
      tableAspect: 2.4,
      headerBand: 0.12,
      labelColumn: 0.08,
      previewRows: 8,
      summaryRows: ['AVERAGE', 'STD DEV'],
      directionStyle: 'suffix',
      confidence: 'documented',
      note: 'Shots are grouped by club; the club name sits above its block. Left/right is an L or R after the number on Side Angle, Sidespin and Offline.',
      columns: [
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Side Angle', 'SIDE', 'sideAngle', true),
        col('Backspin', 'BACK', 'backspin'),
        col('Sidespin', 'SSPIN', 'sideSpin', true),
        col('Descent Angle', 'DESC', 'descent'),
        col('Offline', 'OFF', 'offline', true),
        col('Peak', 'PEAK', 'peakHeight'),
        col('Carry', 'CARRY', 'carry'),
        col('Total', 'TOTAL', 'total'),
        col('To Pin', 'PIN', 'toPin')
      ]
    },
    {
      key: 'foresight-fsx-club',
      brand: 'Foresight',
      label: 'Foresight FSX - club data',
      screen: 'FSX 2020 / FSX Play table view, club data tab',
      device: 'sim',
      orientation: 'landscape',
      theme: 'dark',
      tableAspect: 2.4,
      headerBand: 0.12,
      labelColumn: 0.08,
      previewRows: 8,
      summaryRows: ['AVERAGE', 'STD DEV'],
      directionStyle: 'suffix',
      confidence: 'documented',
      note: 'Efficiency is smash factor. Lie, loft, impact and closure rate are read but not imported.',
      columns: [
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Efficiency', 'EFF', 'smashFactor'),
        col('Angle of Attack', 'AOA', 'attackAngle'),
        col('Club Path', 'PATH', 'clubPath', true),
        col('Face to Target', 'FACE', 'faceAngle', true),
        col('Lie', 'LIE'),
        col('Loft', 'LOFT', 'dynamicLoft'),
        col('Face Impact', 'IMPACT'),
        col('Closure Rate', 'CLOSE')
      ]
    },
    {
      key: 'trackman-tps',
      brand: 'Trackman',
      label: 'Trackman TPS / report',
      screen: 'Trackman Performance Studio shot analysis table and emailed session reports',
      device: 'sim',
      orientation: 'landscape',
      theme: 'light',
      tableAspect: 2.8,
      headerBand: 0.14,
      labelColumn: 0.07,
      previewRows: 8,
      summaryRows: ['AVERAGE', 'STD DEV'],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'Club data first, then ball, then flight - the standard Trackman parameter order. Left/right is an L or R after the number. Reports are often white; shade the screen so it does not glare.',
      columns: [
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Attack Ang.', 'AOA', 'attackAngle'),
        col('Club Path', 'PATH', 'clubPath', true),
        col('Face Ang.', 'FACE', 'faceAngle', true),
        col('Face to Path', 'FTP', 'faceToPath', true),
        col('Dyn. Loft', 'DLOFT', 'dynamicLoft'),
        col('Spin Loft', 'SLOFT'),
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Smash Fac.', 'SMASH', 'smashFactor'),
        col('Launch Ang.', 'LAUNCH', 'launch'),
        col('Launch Dir.', 'LDIR', 'launchDirection', true),
        col('Spin Rate', 'SPIN', 'totalSpin'),
        col('Spin Axis', 'AXIS', 'spinAxis', true),
        col('Height', 'HGT', 'peakHeight'),
        col('Carry', 'CARRY', 'carry'),
        col('Side', 'SIDE', 'offline', true),
        col('Total', 'TOTAL', 'total'),
        col('Side Tot.', 'STOT', null, true),
        col('Land. Ang.', 'LAND', 'descent'),
        col('Hang Time', 'HANG')
      ]
    },
    {
      key: 'trackman-golf-app',
      brand: 'Trackman',
      label: 'Trackman Golf app',
      screen: 'Trackman Golf app shot table (Range, iO, TM4) - turn the phone sideways in the app for the wide table',
      device: 'phone',
      orientation: 'landscape',
      theme: 'dark',
      tableAspect: 2.0,
      headerBand: 0.12,
      labelColumn: 0.1,
      previewRows: 8,
      summaryRows: ['AVERAGE'],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'If the session is on this phone, take a screenshot of the table and use Upload instead. The columns are the player\'s chosen data points, so the order can differ from this.',
      columns: [
        col('Carry', 'CARRY', 'carry'),
        col('Total', 'TOTAL', 'total'),
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Smash Factor', 'SMASH', 'smashFactor'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Launch Dir.', 'LDIR', 'launchDirection', true),
        col('Spin Rate', 'SPIN', 'totalSpin'),
        col('Spin Axis', 'AXIS', 'spinAxis', true),
        col('Height', 'HGT', 'peakHeight'),
        col('Side', 'SIDE', 'offline', true),
        col('Land. Ang.', 'LAND', 'descent')
      ]
    },
    {
      key: 'garmin-r10',
      brand: 'Garmin',
      label: 'Garmin Golf app (R10 / R50)',
      screen: 'Garmin Golf app range session, shot table under Session Stats',
      device: 'phone',
      orientation: 'portrait',
      theme: 'dark',
      tableAspect: 0.62,
      headerBand: 0.07,
      labelColumn: 0.16,
      previewRows: 12,
      summaryRows: [],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'The table scrolls sideways and the header scrolls away with it - photograph it from the top so the header row is in. Columns can be re-ordered in the app, so check the order against the ribbon. If the session is on this phone, screenshot it and use Upload.',
      columns: [
        col('Carry Distance', 'CARRY', 'carry'),
        col('Total Distance', 'TOTAL', 'total'),
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Club Head Speed', 'CLUB', 'clubSpeed'),
        col('Smash Factor', 'SMASH', 'smashFactor'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Launch Direction', 'LDIR', 'launchDirection', true),
        col('Spin Rate', 'SPIN', 'totalSpin'),
        col('Spin Axis', 'AXIS', 'spinAxis', true),
        col('Apex Height', 'APEX', 'peakHeight'),
        col('Deviation Dist.', 'DEV', 'offline', true),
        col('Attack Angle', 'AOA', 'attackAngle'),
        col('Club Path', 'PATH', 'clubPath', true),
        col('Face Angle', 'FACE', 'faceAngle', true),
        col('Face to Path', 'FTP', 'faceToPath', true),
        col('Backspin', 'BACK', 'backspin'),
        col('Sidespin', 'SSPIN', 'sideSpin', true)
      ]
    },
    {
      key: 'rapsodo-mlm2pro',
      brand: 'Rapsodo',
      label: 'Rapsodo MLM2PRO app',
      screen: 'Rapsodo MLM2PRO / Rapsodo Golf app session shot list',
      device: 'phone',
      orientation: 'portrait',
      theme: 'dark',
      tableAspect: 0.62,
      headerBand: 0.07,
      labelColumn: 0.14,
      previewRows: 12,
      summaryRows: [],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'Shot number down the left, metrics across, more columns off to the right. If the session is on this phone, screenshot it and use Upload.',
      columns: [
        col('Total Distance', 'TOTAL', 'total'),
        col('Carry Distance', 'CARRY', 'carry'),
        col('Side Carry', 'SIDE', 'offline', true),
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Launch Direction', 'LDIR', 'launchDirection', true),
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Smash Factor', 'SMASH', 'smashFactor'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Descent Angle', 'DESC', 'descent'),
        col('Shot Apex', 'APEX', 'peakHeight'),
        col('Shot Type', 'TYPE'),
        col('Spin Rate', 'SPIN', 'totalSpin'),
        col('Spin Axis', 'AXIS', 'spinAxis', true),
        col('Club Path', 'PATH', 'clubPath', true),
        col('Angle of Attack', 'AOA', 'attackAngle')
      ]
    },
    {
      key: 'flightscope-fs-golf',
      brand: 'FlightScope',
      label: 'FlightScope FS Golf table',
      screen: 'FS Golf app table view (Mevo, Mevo+, X3) on a tablet or PC',
      device: 'tablet',
      orientation: 'landscape',
      theme: 'dark',
      tableAspect: 1.9,
      headerBand: 0.12,
      labelColumn: 0.08,
      previewRows: 8,
      summaryRows: ['AVERAGE', 'STD DEV'],
      directionStyle: 'signed',
      confidence: 'typical',
      note: 'Averages and standard deviations sit under the shots. Left is usually a minus sign rather than an L. Roll, flight time and the Pro Package club numbers may or may not be present.',
      columns: [
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Smash Factor', 'SMASH', 'smashFactor'),
        col('Carry', 'CARRY', 'carry'),
        col('Total', 'TOTAL', 'total'),
        col('Roll', 'ROLL'),
        col('Lateral', 'LAT', 'offline', true),
        col('Apex', 'APEX', 'peakHeight'),
        col('Flight Time', 'TIME'),
        col('V. Launch', 'VLA', 'launch'),
        col('H. Launch', 'HLA', 'launchDirection', true),
        col('Spin Rate', 'SPIN', 'totalSpin'),
        col('Spin Axis', 'AXIS', 'spinAxis', true),
        col('AOA', 'AOA', 'attackAngle')
      ]
    },
    {
      key: 'skytrak',
      brand: 'SkyTrak',
      label: 'SkyTrak / SkyTrak+ shot history',
      screen: 'SKYTRAK app shot history table, usually on an iPad',
      device: 'tablet',
      orientation: 'landscape',
      theme: 'dark',
      tableAspect: 1.9,
      headerBand: 0.12,
      labelColumn: 0.1,
      previewRows: 8,
      summaryRows: ['AVERAGE'],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'Shot number and club on the left. Left/right is an L or R after Side Angle, Side Spin and Offline. SkyTrak+ adds club speed, path and face at the right-hand end.',
      columns: [
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Back Spin', 'BACK', 'backspin'),
        col('Side Spin', 'SSPIN', 'sideSpin', true),
        col('Side Angle', 'SIDE', 'sideAngle', true),
        col('Descent Angle', 'DESC', 'descent'),
        col('Max Height', 'HGT', 'peakHeight'),
        col('Carry', 'CARRY', 'carry'),
        col('Total', 'TOTAL', 'total'),
        col('Offline', 'OFF', 'offline', true),
        col('Smash Factor', 'SMASH', 'smashFactor'),
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Club Path', 'PATH', 'clubPath', true),
        col('Face to Target', 'FACE', 'faceAngle', true)
      ]
    },
    {
      key: 'uneekor-view',
      brand: 'Uneekor',
      label: 'Uneekor View / Refine',
      screen: 'Uneekor View, Refine or View Air shot data table (EYE XO, EYE MINI, QED)',
      device: 'sim',
      orientation: 'landscape',
      theme: 'dark',
      tableAspect: 2.6,
      headerBand: 0.12,
      labelColumn: 0.07,
      previewRows: 8,
      summaryRows: ['AVERAGE'],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'Ball data first, club data after it. Side Distance is offline. Left/right is an L or R after the number.',
      columns: [
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Side Angle', 'SIDE', 'sideAngle', true),
        col('Back Spin', 'BACK', 'backspin'),
        col('Side Spin', 'SSPIN', 'sideSpin', true),
        col('Carry', 'CARRY', 'carry'),
        col('Total', 'TOTAL', 'total'),
        col('Side Distance', 'SDIST', 'offline', true),
        col('Flight Time', 'TIME'),
        col('Apex', 'APEX', 'peakHeight'),
        col('Descent Angle', 'DESC', 'descent'),
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Smash Factor', 'SMASH', 'smashFactor'),
        col('Club Path', 'PATH', 'clubPath', true),
        col('Face Angle', 'FACE', 'faceAngle', true),
        col('Attack Angle', 'AOA', 'attackAngle'),
        col('Dynamic Loft', 'DLOFT', 'dynamicLoft')
      ]
    },
    {
      key: 'fullswing-kit',
      brand: 'Full Swing',
      label: 'Full Swing KIT app',
      screen: 'Full Swing app session shot list (KIT)',
      device: 'phone',
      orientation: 'portrait',
      theme: 'dark',
      tableAspect: 0.62,
      headerBand: 0.07,
      labelColumn: 0.14,
      previewRows: 12,
      summaryRows: [],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'Up to 16 data points in the order the player sorted them, so check the ribbon. If the session is on this phone, screenshot it and use Upload.',
      columns: [
        col('Carry Distance', 'CARRY', 'carry'),
        col('Total Distance', 'TOTAL', 'total'),
        col('Club Speed', 'CLUB', 'clubSpeed'),
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Smash Factor', 'SMASH', 'smashFactor'),
        col('Spin Rate', 'SPIN', 'totalSpin'),
        col('Spin Axis', 'AXIS', 'spinAxis', true),
        col('Apex', 'APEX', 'peakHeight'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Attack Angle', 'AOA', 'attackAngle'),
        col('Horizontal Angle', 'HLA', 'launchDirection', true),
        col('Club Path', 'PATH', 'clubPath', true),
        col('Club Face', 'FACE', 'faceAngle', true),
        col('Face to Path', 'FTP', 'faceToPath', true),
        col('Side Carry', 'SIDE', 'offline', true),
        col('Side Total', 'STOT', null, true)
      ]
    },
    {
      key: 'range-bay',
      brand: 'Range bay',
      label: 'Range bay screen (Toptracer, Trackman Range, Inrange)',
      screen: 'The shot list on a driving range bay monitor',
      device: 'range',
      orientation: 'landscape',
      theme: 'light',
      tableAspect: 1.8,
      headerBand: 0.13,
      labelColumn: 0.1,
      previewRows: 8,
      summaryRows: [],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'Bay screens vary by range. Carry, total, ball speed, launch and height are nearly always there; curve and side are read as offline. Stand square to the screen - they are big and photographed from an angle.',
      columns: [
        col('Carry', 'CARRY', 'carry'),
        col('Total', 'TOTAL', 'total'),
        col('Ball Speed', 'BALL', 'ballSpeed'),
        col('Launch Angle', 'LAUNCH', 'launch'),
        col('Height', 'HGT', 'peakHeight'),
        col('Side', 'SIDE', 'offline', true),
        col('Curve', 'CURVE', null, true),
        col('Hang Time', 'HANG')
      ]
    },
    {
      key: 'generic',
      brand: 'Other',
      label: 'Any other shot table',
      screen: 'A table with metric names across the top and one shot per row',
      device: 'sim',
      orientation: 'landscape',
      theme: 'dark',
      tableAspect: 1.8,
      headerBand: 0.12,
      labelColumn: 0.08,
      previewRows: 8,
      summaryRows: [],
      directionStyle: 'suffix',
      confidence: 'typical',
      note: 'Header row in the top band, shots below. The scanner reads the metric names itself, so keep the whole header in and sharp.',
      columns: []
    }
  ];

  var DEFAULT_KEY = 'foresight-fsx-ball';

  function list() {
    return layouts.slice();
  }

  function get(key) {
    var wanted = String(key || '').trim().toLowerCase();
    for (var i = 0; i < layouts.length; i += 1) {
      if (layouts[i].key === wanted) return layouts[i];
    }
    return null;
  }

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  /* A wide table wants a wide viewfinder. On a portrait page the camera turns
   * its controls sideways for any table at least as wide as it is tall, so
   * the player holds the phone the way the screen is shaped. */
  function wantsTurn(layout, width, height) {
    var lay = layout || get(DEFAULT_KEY) || {};
    var aspect = clamp(Number(lay.tableAspect) || 1.8, 0.3, 6);
    return aspect >= 1 && Number(width) < Number(height);
  }

  /* Where the template sits on a viewport of width x height, in CSS pixels.
   *
   * The frame is the biggest rectangle of the layout's table aspect that fits
   * inside the chrome (top strip, bottom strip, and the left and right rails
   * when the controls sit beside the picture), with a side gutter. The header
   * band, label column and summary band are fractions of it. rotateHint is
   * true when the viewport is portrait and the table is wide: the camera then
   * turns its controls sideways and asks the player to hold the phone that way.
   */
  function guideGeometry(layout, width, height, opts) {
    var o = opts || {};
    var lay = layout || get(DEFAULT_KEY);
    var vw = Math.max(1, Number(width) || 0);
    var vh = Math.max(1, Number(height) || 0);
    var top = Number.isFinite(o.top) ? o.top : Math.round(vh * 0.14);
    var bottom = Number.isFinite(o.bottom) ? o.bottom : Math.round(vh * 0.30);
    var left = Number.isFinite(o.left) ? o.left : 0;
    var right = Number.isFinite(o.right) ? o.right : 0;
    var gutter = Number.isFinite(o.gutter) ? o.gutter : Math.round(Math.min(vw, vh) * 0.05);
    var availW = Math.max(40, vw - left - right - gutter * 2);
    var availH = Math.max(40, vh - top - bottom);
    var aspect = clamp(Number(lay.tableAspect) || 1.8, 0.3, 6);

    var w = availW;
    var h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    w = Math.round(w);
    h = Math.round(h);
    var x = Math.round(left + gutter + (availW - w) / 2);
    var y = Math.round(top + (availH - h) / 2);

    var headerH = Math.round(h * clamp(Number(lay.headerBand) || 0.12, 0.04, 0.3));
    var labelW = Math.round(w * clamp(Number(lay.labelColumn) || 0.08, 0, 0.3));
    var summaryRows = Array.isArray(lay.summaryRows) ? lay.summaryRows : [];
    var summaryH = summaryRows.length ? Math.round(h * clamp(0.07 * summaryRows.length, 0.05, 0.25)) : 0;

    var bodyY = y + headerH;
    var bodyH = h - headerH - summaryH;
    var previewRows = clamp(Math.round(Number(lay.previewRows) || 8), 2, 20);
    var rows = [];
    for (var r = 1; r < previewRows; r += 1) {
      rows.push(Math.round(bodyY + (bodyH * r) / previewRows));
    }

    var columns = [];
    var cols = Array.isArray(lay.columns) ? lay.columns : [];
    if (cols.length) {
      var colX = x + labelW;
      var colW = (w - labelW) / cols.length;
      for (var c = 0; c < cols.length; c += 1) {
        columns.push({
          x: colX + colW * c,
          w: colW,
          label: cols[c].label,
          short: cols[c].short,
          key: cols[c].key
        });
      }
    }

    return {
      viewport: { width: vw, height: vh },
      frame: { x: x, y: y, w: w, h: h },
      header: { x: x, y: y, w: w, h: headerH },
      label: { x: x, y: bodyY, w: labelW, h: bodyH },
      body: { x: x + labelW, y: bodyY, w: w - labelW, h: bodyH },
      summary: summaryH ? { x: x, y: y + h - summaryH, w: w, h: summaryH, rows: summaryRows.slice() } : null,
      rows: rows,
      columns: columns,
      rotateHint: wantsTurn(lay, vw, vh)
    };
  }

  /* The video fills the viewport with object-fit: cover. This maps a viewport
   * rectangle to source pixels, unclamped: a rectangle that runs past the
   * picture comes back with coordinates outside 0..videoW. */
  function coverRect(videoW, videoH, viewW, viewH, rect) {
    var sw = Math.max(1, Number(videoW) || 0);
    var sh = Math.max(1, Number(videoH) || 0);
    var vw = Math.max(1, Number(viewW) || 0);
    var vh = Math.max(1, Number(viewH) || 0);
    var scale = Math.max(vw / sw, vh / sh);
    var offX = (vw - sw * scale) / 2;
    var offY = (vh - sh * scale) / 2;
    var r = rect || { x: 0, y: 0, w: vw, h: vh };
    return {
      x: (r.x - offX) / scale,
      y: (r.y - offY) / scale,
      w: r.w / scale,
      h: r.h / scale
    };
  }

  /* The same mapping grown by `margin` (a fraction of the rectangle) on each
   * side and clamped to the picture, so the saved photo is the table plus a
   * little context around it. */
  function coverCrop(videoW, videoH, viewW, viewH, rect, margin) {
    var sw = Math.max(1, Number(videoW) || 0);
    var sh = Math.max(1, Number(videoH) || 0);
    var vw = Math.max(1, Number(viewW) || 0);
    var vh = Math.max(1, Number(viewH) || 0);
    var m = Number.isFinite(margin) ? margin : 0.08;
    var r = rect || { x: 0, y: 0, w: vw, h: vh };
    var grown = { x: r.x - r.w * m, y: r.y - r.h * m, w: r.w * (1 + 2 * m), h: r.h * (1 + 2 * m) };
    var src = coverRect(sw, sh, vw, vh, grown);
    var x0 = clamp(src.x, 0, sw);
    var y0 = clamp(src.y, 0, sh);
    var x1 = clamp(src.x + src.w, 0, sw);
    var y1 = clamp(src.y + src.h, 0, sh);
    return {
      sx: Math.round(x0),
      sy: Math.round(y0),
      sw: Math.max(1, Math.round(x1 - x0)),
      sh: Math.max(1, Math.round(y1 - y0))
    };
  }

  /* When the camera's controls are turned a quarter turn clockwise on a
   * portrait page, a rectangle drawn in that turned space sits elsewhere on
   * the page: the turned space's top edge runs down the page's right side.
   * `turnedH` is the turned space's height, which is the page's width. */
  function turnedToPage(rect, turnedH) {
    var r = rect || { x: 0, y: 0, w: 0, h: 0 };
    var hh = Number(turnedH) || 0;
    return { x: hh - r.y - r.h, y: r.x, w: r.h, h: r.w };
  }

  /* And back: a page point into the turned space. */
  function pageToTurnedPoint(x, y, turnedH) {
    return { x: Number(y) || 0, y: (Number(turnedH) || 0) - (Number(x) || 0) };
  }

  var api = {
    version: '2026-10-31',
    DEFAULT_KEY: DEFAULT_KEY,
    layouts: layouts,
    list: list,
    get: get,
    wantsTurn: wantsTurn,
    guideGeometry: guideGeometry,
    coverRect: coverRect,
    coverCrop: coverCrop,
    turnedToPage: turnedToPage,
    pageToTurnedPoint: pageToTurnedPoint
  };

  target.GolfDaddyLaunchMonitorLayouts = api;
  target.ClarityCaddieLaunchMonitorLayouts = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

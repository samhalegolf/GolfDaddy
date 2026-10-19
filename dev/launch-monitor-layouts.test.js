/*
 * The launch monitor layout registry (scripts/gd-launch-monitor-layouts.js)
 * is data the guided camera draws from, so the data has to be sound:
 *
 *   - every layout is complete, its key unique, its geometry fractions sane;
 *   - every column key is a metric the alias registry knows, or null;
 *   - every column name a brand prints resolves to that same metric through
 *     the alias registry - otherwise the template promises a column the
 *     scanner cannot read;
 *   - guideGeometry keeps the frame inside the viewport, stacks header, body
 *     and summary without overlap, and asks for a sideways phone only when
 *     a wide table is framed on a portrait screen;
 *   - coverCrop maps the frame back to source pixels under object-fit: cover.
 *
 * Run: node dev/launch-monitor-layouts.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const layouts = require(path.join(ROOT, 'scripts', 'gd-launch-monitor-layouts.js'));
global.window = global;
require(path.join(ROOT, 'scripts', 'gd-launch-monitor-alias-registry.js'));
const registry = global.GolfDaddyLaunchMonitorAliasRegistry;

const known = new Set(registry.entries.map((entry) => entry.key));

/* ---- the list ---- */
const list = layouts.list();
assert.ok(list.length >= 8, 'a handful of brands at least, got ' + list.length);
assert.strictEqual(new Set(list.map((l) => l.key)).size, list.length, 'layout keys are unique');
assert.ok(layouts.get(layouts.DEFAULT_KEY), 'the default layout exists');
assert.strictEqual(layouts.get('no-such-layout'), null);
assert.strictEqual(layouts.get(' Foresight-FSX-Ball ').key, 'foresight-fsx-ball', 'lookup is case and space tolerant');

const brands = new Set(list.map((l) => l.brand.toLowerCase()));
['foresight', 'trackman', 'garmin', 'rapsodo', 'flightscope', 'skytrak', 'uneekor', 'full swing'].forEach((brand) => {
  assert.ok(brands.has(brand), 'covers ' + brand);
});
assert.ok(layouts.get('generic'), 'and has a fallback for any other table');

list.forEach((layout) => {
  const where = 'layout ' + layout.key;
  ['key', 'brand', 'label', 'screen', 'device', 'orientation', 'theme', 'note', 'confidence'].forEach((field) => {
    assert.strictEqual(typeof layout[field], 'string', where + ' has ' + field);
    assert.ok(layout[field].trim(), where + ' ' + field + ' is not blank');
  });
  assert.ok(['sim', 'phone', 'tablet', 'range'].includes(layout.device), where + ' device');
  assert.ok(['landscape', 'portrait'].includes(layout.orientation), where + ' orientation');
  assert.ok(['documented', 'typical'].includes(layout.confidence), where + ' confidence');
  assert.ok(['suffix', 'signed'].includes(layout.directionStyle), where + ' direction style');
  assert.ok(layout.tableAspect > 0.3 && layout.tableAspect < 6, where + ' table aspect');
  assert.ok(layout.headerBand >= 0.04 && layout.headerBand <= 0.3, where + ' header band');
  assert.ok(layout.labelColumn >= 0 && layout.labelColumn <= 0.3, where + ' label column');
  assert.ok(Array.isArray(layout.summaryRows), where + ' summary rows');
  assert.ok(Array.isArray(layout.columns), where + ' columns');
  if (layout.orientation === 'portrait') assert.ok(layout.tableAspect < 1, where + ' portrait tables are taller than wide');
  else assert.ok(layout.tableAspect > 1, where + ' landscape tables are wider than tall');

  const seen = new Set();
  layout.columns.forEach((column) => {
    const label = where + ' column ' + column.label;
    assert.ok(column.label && column.short, label + ' has a label and a short name');
    assert.ok(column.short.length <= 6, label + ' short name fits a narrow column');
    assert.strictEqual(typeof column.direction, 'boolean', label + ' says whether it carries a left/right marker');
    if (['sideAngle', 'sideSpin', 'offline'].includes(column.key)) assert.ok(column.direction, label + ' is a direction column');
    assert.ok(!seen.has(column.label), label + ' is listed once');
    seen.add(column.label);
    if (column.key === null) return;
    assert.ok(known.has(column.key), label + ' key ' + column.key + ' is in the alias registry');
    const resolved = registry.canonicalKey(column.label);
    assert.strictEqual(resolved, column.key, label + ' resolves through the alias registry to ' + column.key + ' (got ' + resolved + ')');
  });
});

/* The in-repo ground truth is a Foresight ball-data table; the layout must
   match it column for column (minus the direction side-columns). */
{
  const truth = require(path.join(ROOT, 'dev', 'fixtures', 'launch-monitor-7i.groundtruth.json'));
  const expected = truth.columns.filter((c) => !/Dir$/.test(c));
  const got = layouts.get('foresight-fsx-ball').columns.map((c) => registry.canonicalKey(c.label));
  const asFixture = got.map((k) => ({ launch: 'launchAngle', peakHeight: 'peak', descent: 'descentAngle' }[k] || k));
  assert.deepStrictEqual(asFixture, expected, 'Foresight ball data matches the ground-truth fixture');
}

/* ---- geometry ---- */
function inside(inner, outer) {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
    && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
}

list.forEach((layout) => {
  [[390, 844], [844, 390], [768, 1024], [1024, 768], [320, 568]].forEach(([w, h]) => {
    const geo = layouts.guideGeometry(layout, w, h, { top: 90, bottom: 220 });
    const where = layout.key + ' @ ' + w + 'x' + h;
    const view = { x: 0, y: 0, w, h };
    assert.ok(inside(geo.frame, view), where + ' frame stays on screen');
    assert.ok(geo.frame.y >= 90 - 0.5 && geo.frame.y + geo.frame.h <= h - 220 + 0.5, where + ' frame clears the chrome');
    assert.ok(Math.abs(geo.frame.w / geo.frame.h - layout.tableAspect) < 0.08 * layout.tableAspect || geo.frame.w < 60 || geo.frame.h < 60,
      where + ' frame keeps the table aspect');
    assert.ok(inside(geo.header, geo.frame) && inside(geo.body, geo.frame), where + ' bands sit inside the frame');
    assert.strictEqual(geo.body.y, geo.header.y + geo.header.h, where + ' body starts under the header');
    if (layout.summaryRows.length) {
      assert.ok(geo.summary && inside(geo.summary, geo.frame), where + ' summary band inside the frame');
      assert.strictEqual(geo.summary.y, geo.body.y + geo.body.h, where + ' summary starts under the body');
      assert.deepStrictEqual(geo.summary.rows, layout.summaryRows);
    } else {
      assert.strictEqual(geo.summary, null, where + ' no summary band when the brand prints none');
    }
    geo.rows.forEach((y) => assert.ok(y > geo.body.y && y < geo.body.y + geo.body.h, where + ' row guides are inside the body'));
    assert.strictEqual(geo.columns.length, layout.columns.length, where + ' one column slot per column');
    if (geo.columns.length) {
      assert.ok(Math.abs(geo.columns[0].x - geo.body.x) < 0.5, where + ' columns start after the label column');
      const last = geo.columns[geo.columns.length - 1];
      assert.ok(Math.abs(last.x + last.w - (geo.frame.x + geo.frame.w)) < 1, where + ' columns end at the frame edge');
    }
    assert.strictEqual(geo.rotateHint, layout.tableAspect >= 1.6 && w < h, where + ' rotate hint');
  });
});

assert.ok(layouts.guideGeometry(null, 390, 844).frame.w > 0, 'no layout means the default layout');
assert.ok(layouts.guideGeometry(layouts.get('generic'), 0, 0).frame.w > 0, 'a zero viewport does not blow up');

/* ---- coverCrop ---- */
{
  /* 16:9 video shown on a portrait 390x844 view: scale is set by height,
     the picture overflows sideways and is centred. */
  const crop = layouts.coverCrop(1920, 1080, 390, 844, { x: 0, y: 0, w: 390, h: 844 }, 0);
  const scale = 844 / 1080;
  const shownW = 1920 * scale;
  const offX = (390 - shownW) / 2;
  assert.strictEqual(crop.sy, 0);
  assert.strictEqual(crop.sh, 1080);
  assert.strictEqual(crop.sx, Math.round(-offX / scale));
  assert.strictEqual(crop.sw, Math.round(390 / scale));
}
{
  /* A frame in the middle maps to the middle, with the margin around it. */
  const crop = layouts.coverCrop(1000, 1000, 500, 500, { x: 100, y: 200, w: 300, h: 100 }, 0.1);
  assert.deepStrictEqual(crop, { sx: 140, sy: 380, sw: 720, sh: 240 });
}
{
  /* Clamped to the source, never outside it. */
  const crop = layouts.coverCrop(640, 480, 640, 480, { x: -50, y: -50, w: 800, h: 600 }, 0.5);
  assert.deepStrictEqual(crop, { sx: 0, sy: 0, sw: 640, sh: 480 });
}
{
  /* Letterboxed the other way: a portrait video on a landscape view. */
  const crop = layouts.coverCrop(1080, 1920, 800, 400, { x: 0, y: 0, w: 800, h: 400 }, 0);
  assert.strictEqual(crop.sx, 0);
  assert.strictEqual(crop.sw, 1080);
  assert.strictEqual(crop.sh, Math.round(400 / (800 / 1080)));
}

console.log('ok - launch monitor layouts: ' + list.length + ' layouts, columns resolve, geometry and crop hold');

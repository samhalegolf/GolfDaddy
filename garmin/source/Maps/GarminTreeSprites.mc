using Toybox.Graphics;
using Toybox.Lang;
using Toybox.System;
using Toybox.WatchUi;

// Stamps a hole's trees (scripts/gd-watch-map-core.js buildHoleTrees) as
// sprites (garmin/tools/tree-sprites.js) over the drawn map or the picture.
//
// Each tree is one packed Number: x + y*2048 + r*2^22 + type*2^29, x/y/r in
// image px. The sprite is the stored size nearest the crown's diameter on
// screen, drawn 1:1 - a scaled bitmap draw needs a transform and a buffered
// copy per draw on this platform, which a hundred trees cannot afford inside
// the watchdog. Trees off the glass are skipped before anything is loaded,
// and they arrive sorted back to front, so drawing in order overlaps right.
//
// AMOLED screens get the soft-shadowed set; every other screen the 64-colour
// set, by the same rule GarminSessionManager.mapPalette uses.
class GarminTreeSprites {
    hidden var ids;
    hidden var loaded = {};

    function initialize() {
        var settings = System.getDeviceSettings();
        var amoled = (settings has :requiresBurnInProtection) && settings.requiresBurnInProtection;
        ids = amoled ? GarminTreeSpriteIds.amoled() : GarminTreeSpriteIds.mip();
    }

    // trees: packed Numbers; f the camera's image->screen affine
    // (GarminMapCamera.frame), sc its scale. A sprite is stamped upright at
    // the crown's turned position - a crown has no way up.
    function draw(dc, trees, f, sc, viewWidth, viewHeight) {
        var sizes = GarminTreeSpriteIds.SIZES;
        var margin = sizes[sizes.size() - 1];
        for (var i = 0; i < trees.size(); i += 1) {
            var v = trees[i];
            var x = v % 2048;
            var y = (v / 2048) % 2048;
            var cx = f[0] + x * f[2] - y * f[3];
            var cy = f[1] + x * f[3] + y * f[2];
            if (cx < -margin || cy < -margin || cx > viewWidth + margin || cy > viewHeight + margin) { continue; }
            var s = sizeIndex(2.0 * ((v / 4194304) % 128) * sc);
            var half = sizes[s] / 2;
            dc.drawBitmap((cx - half).toNumber(), (cy - half).toNumber(), bitmap((v / 536870912) % 4, s));
        }
    }

    // The stored size nearest a crown diameter in screen px.
    hidden function sizeIndex(diameter) {
        var sizes = GarminTreeSpriteIds.SIZES;
        var best = 0;
        for (var i = 1; i < sizes.size(); i += 1) {
            if ((sizes[i] - diameter).abs() < (sizes[best] - diameter).abs()) { best = i; }
        }
        return best;
    }

    // Loaded once, on first use: a hole at one zoom touches two or three sizes.
    hidden function bitmap(type, s) {
        var key = type * 8 + s;
        if (!loaded.hasKey(key)) { loaded[key] = WatchUi.loadResource(ids[type][s]); }
        return loaded[key];
    }
}

#!/usr/bin/env node
/* app/js/bubble-visual.js buildBubbleParts with `hazards`: the /app/ shell's bubble
   hazard reveal. The geometry (which surfaces qualify) is dev/bubble-hazard-core.test.js;
   this pins the drawing: water and bunker fills clipped to the outline, under the fill,
   and the off-fairway tint - and nothing at all when there is nothing to reveal.

   Run: npm run test:bubble-reveal */
"use strict";
const assert = require("assert");
const path = require("path");
const visual = require(path.join(__dirname, "..", "app", "js", "bubble-visual.js"));

/* A flat projector: 1e-5 deg ≈ 1 px, so rings can be reasoned about in pixels. */
const O = { lat: -45.0, lng: 169.0 };
function project(p) { return p ? { left: 400 + (p.lng - O.lng) * 1e5, top: 400 - (p.lat - O.lat) * 1e5 } : null; }
function ll(x, y) { return { lat: O.lat + y / 1e5, lng: O.lng + x / 1e5 }; }
function circle(cx, cy, r, n = 36) { return Array.from({ length: n }, (_, i) => ll(cx + r * Math.cos(2 * Math.PI * i / n), cy + r * Math.sin(2 * Math.PI * i / n))); }
function rect(x0, y0, x1, y1) { return [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)]; }

const model = { center: ll(0, 150), rings: { main: circle(0, 150, 30), outer: [], inner: [] } };
const base = { project, model, start: ll(0, 0), target: ll(0, 150), carryM: 140, idPrefix: "t" };

const plain = visual.buildBubbleParts(base);
assert.ok(plain && plain.parts.length, "the bubble builds without hazards");
assert.ok(!/bubbleHazard|bubbleOffFairway|-reveal/.test(plain.defs + plain.parts.join("")), "no hazard markup without hazards");

const none = visual.buildBubbleParts(Object.assign({}, base, { hazards: { water: [], bunkers: [], offFairway: false } }));
assert.strictEqual(none.parts.join(""), plain.parts.join(""), "empty hazards draw exactly what no hazards draws");

const withHazards = visual.buildBubbleParts(Object.assign({}, base, {
  hazards: { water: [rect(-40, 140, -10, 170)], bunkers: [rect(10, 130, 50, 160)], offFairway: true }
}));
const all = withHazards.parts.join("");
assert.ok(withHazards.defs.includes('<clipPath id="t-reveal">'), "the outline becomes the clip");
assert.ok(/class="bubbleHazardWater"[^>]*fill="#ff2f2f"[^>]*clip-path="url\(#t-reveal\)"/.test(all), "water: red, clipped");
assert.ok(/class="bubbleHazardBunker"[^>]*fill="#f7d64a"[^>]*clip-path="url\(#t-reveal\)"/.test(all), "bunker: yellow, clipped");
assert.ok(/class="bubbleOffFairway"[^>]*fill="#ff5a5a"/.test(all), "off-fairway tint");
const order = ["bubbleOffFairway", "bubbleHazardWater", "bubbleHazardBunker", "bubbleFill", "bubbleEdge"].map(c => all.indexOf('class="' + c + '"'));
assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "reveal sits UNDER the fill and edge: " + order.join(","));
assert.ok(/class="bubbleHazardWater"[^>]*mask="url\(#t-carry\)"/.test(all), "the carry knockout applies to the reveal too");
assert.strictEqual((all.match(/class="bubbleFill"/g) || []).length, 1, "still one fill");
assert.strictEqual((all.match(/class="bubbleEdge"/g) || []).length, 1, "still one edge");

/* A ring the projector cannot place (off the published picture) is simply not drawn. */
const offPicture = visual.buildBubbleParts(Object.assign({}, base, {
  project: (p) => (p && p.lng > O.lng + 1 ? null : project(p)),
  hazards: { water: [], bunkers: [rect(200000, 0, 200010, 10)], offFairway: false }
}));
assert.ok(!/bubbleHazardBunker|-reveal/.test(offPicture.defs + offPicture.parts.join("")), "unprojectable ring: no part, no clip def");

console.log("bubble-hazard-reveal: ok");

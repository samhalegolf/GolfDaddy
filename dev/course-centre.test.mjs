/* A missing coordinate must never become 0,0. Number(null) is 0, which is how a Studio remap
   (it passes null coordinates on purpose) wrote Umdoni's centre as 0,0. */
import assert from "node:assert/strict";
import { courseCentre } from "../functions/lib/gd-course-centre.mjs";

assert.equal(courseCentre(null, null), null, "null coords are no centre");
assert.equal(courseCentre(undefined, undefined), null, "missing coords are no centre");
assert.equal(courseCentre("", ""), null, "empty query params are no centre");
assert.equal(courseCentre(-30.39, null), null, "half a coordinate is no centre");
assert.equal(courseCentre(0, 0), null, "0,0 is a placeholder, not a course");
assert.equal(courseCentre("abc", 1), null);
assert.equal(courseCentre(91, 10), null);
assert.equal(courseCentre(10, 181), null);
assert.deepEqual(courseCentre(-30.394079, 30.6849518), { lat: -30.394079, lng: 30.6849518 });
assert.deepEqual(courseCentre("-36.9", "174.7"), { lat: -36.9, lng: 174.7 });
assert.deepEqual(courseCentre(0, 174.7), { lat: 0, lng: 174.7 }, "on the equator is still a real place");
console.log("course-centre: ok");

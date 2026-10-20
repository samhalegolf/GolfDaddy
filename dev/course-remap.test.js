/* Remap: clear a course's geometry without deleting the course.

   This exists because of a real incident. Deleting the course_maps row looked like "reset the
   map" and was in fact "remove the course": that row is also the course's entry in the
   picker's list and the centre both the pin gate and the Overpass query read, so the picker
   stopped offering the course, the pin dialog fired instead of a package request, and not one
   mapper job was ever enqueued. The assertion that matters here is check 1's course_lat - if
   remap ever starts clearing the location too, it has become the delete it replaced.

   Checks 4-6 cover the other half of the same theme: a job that cannot possibly succeed
   should be refused where there is a caller to tell, not queued to die in a worker log three
   minutes later. kelvin-heights-road did exactly that - a road out of a geocode, no
   coordinates, one failed row and no way to act on it.
*/

/* The remap kind, on a stubbed Supabase. No network, no keys. */
import assert from 'node:assert/strict';
process.env.SUPABASE_URL='https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY='stub';

const state = { maps:[{course_id:'jacks-point',published:true,geometry_version:'v1',
                       objects_json:{a:1},holes_json:{'1':{}},course_lat:-45.07,course_lng:168.74}],
                jobs:[], patched:[], workerPings:0 };

globalThis.fetch = async (url, opts={}) => {
  const u=String(url), m=opts.method||'GET';
  const body=opts.body?JSON.parse(opts.body):null;
  const ok=(j)=>({ok:true,status:200,text:async()=>JSON.stringify(j),json:async()=>j});
  if (u.includes('/auth/v1/user')) return ok({id:'u1',email:'samhalegolf@gmail.com'});
  if (u.includes('course-mapper-worker-background')) { state.workerPings++; return ok({}); }
  if (u.includes('/rest/v1/course_maps')) {
    if (m==='PATCH') {
      const hit=state.maps.filter(r=>u.includes('course_id=eq.'+r.course_id));
      hit.forEach(r=>Object.assign(r,body));
      state.patched.push({url:u,body});
      return ok(hit);
    }
    if (m==='POST') return ok([]);
    return ok(state.maps.filter(r=>u.includes('course_id=eq.'+r.course_id)));
  }
  if (u.includes('/rest/v1/course_mapper_jobs')) {
    if (m==='POST'){ const row=Object.assign({id:'j'+(state.jobs.length+1)},Array.isArray(body)?body[0]:body); state.jobs.push(row); return ok([row]); }
    if (m==='PATCH') return ok([]);
    return ok(state.jobs.filter(j=>u.includes('course_id=eq.'+j.course_id)));
  }
  return ok([]);
};

const { default: handler } = await import("../functions/course-mapper-jobs.mjs");

const post = (body, method='POST') => handler(new Request('https://x/api/course-mapper-jobs',
  { method, headers:{'Content-Type':'application/json',Authorization:'Bearer tok'}, body: JSON.stringify(body) }));

// 1. remap clears geometry but keeps identity + location
let res = await post({courseId:'jacks-point', kind:'remap'});
const row = state.maps[0];
assert.ok([200,202].includes(res.status), 'remap should be accepted, got '+res.status+' '+await res.clone().text());
assert.deepEqual(row.objects_json, {}, 'geometry cleared');
assert.deepEqual(row.holes_json, {}, 'holes cleared');
assert.equal(row.geometry_version, null, 'version cleared');
assert.equal(row.course_lat, -45.07, 'LOCATION KEPT — this is the whole point');
assert.equal(row.published, true, 'still published, so it stays in the picker');
assert.equal(state.jobs.length, 1, 'a mapping job was enqueued');
console.log('1. remap cleared geometry, kept centre + published, enqueued 1 job');

// 2. a course with no row is refused with a reason, not silently enqueued
state.maps.length = 0;
res = await post({courseId:'ghost-course', kind:'remap'});
assert.equal(res.status, 404, 'expected 404, got '+res.status);
const body = await res.json();
assert.match(body.error, /no course_maps row/);
assert.equal(state.jobs.length, 1, 'and nothing was enqueued for it');
console.log('2. remap on a missing course -> 404 "%s"', body.error);

// 3. remap is admin-only
const realFetch = globalThis.fetch;
globalThis.fetch = async (u,o) => String(u).includes('/auth/v1/user')
  ? ({ok:true,status:200,json:async()=>({id:'u2',email:'someone@else.com'}),text:async()=>'{}'})
  : realFetch(u,o);
res = await post({courseId:'jacks-point', kind:'remap'});
assert.equal(res.status, 403, 'non-admin remap must be refused, got '+res.status);
console.log('3. non-admin remap -> 403');
globalThis.fetch = realFetch;

// 4. A course with no coordinates anywhere must be refused, not queued to fail later.
//    kelvin-heights-road is the real case: a road out of a geocode, no course_maps row, a
//    job that could only ever die on "has no known location".
state.maps.length = 0; state.jobs.length = 0;
res = await post({courseId:'kelvin-heights-road', kind:'automap'});
assert.equal(res.status, 422, 'expected 422, got '+res.status);
const b4 = await res.json();
assert.match(b4.error, /no location for kelvin-heights-road/);
assert.equal(state.jobs.length, 0, 'and no job was queued to fail three minutes later');
console.log('4. unlocatable course -> 422, zero jobs queued');

// 5. Coordinates in the request are enough — the centre row gets created on the way through.
state.maps.length = 0; state.jobs.length = 0;
res = await post({courseId:'new-course', kind:'automap', courseLat:-45.07, courseLng:168.74, courseName:'New Course'});
assert.ok([200,202].includes(res.status), 'expected accept, got '+res.status);
assert.equal(state.jobs.length, 1, 'job queued');
console.log('5. a request carrying lat/lng creates the centre and queues normally');

// 6. An existing row with coordinates is enough on its own, with none in the request.
state.maps.length = 0; state.jobs.length = 0;
state.maps.push({course_id:'has-centre',published:true,geometry_version:null,
                 objects_json:{},holes_json:{},course_lat:-36.75,course_lng:174.75});
res = await post({courseId:'has-centre', kind:'automap'});
assert.ok([200,202].includes(res.status), 'expected accept, got '+res.status);
assert.equal(state.jobs.length, 1, 'job queued from the stored centre alone');
console.log('6. a stored centre is enough with no coordinates in the request');

// 7. Studio's "Move course pin": a remap carrying coordinates moves the pin in the same write
//    that clears the geometry, and keeps the course's name. Miyoshi Country Club is the case -
//    pinned 1.2 km off on a driving range, so the 1400 m query reached only 15 of its holes.
state.maps.length = 0; state.jobs.length = 0; state.patched.length = 0;
state.maps.push({course_id:'miyoshi-country-club',course_name:'三好カントリー倶楽部',published:true,geometry_version:'v2',
                 objects_json:{a:1},holes_json:{'1':{}},course_lat:35.1533,course_lng:137.0965});
res = await post({courseId:'miyoshi-country-club', kind:'remap', courseLat:35.14, courseLng:137.0985, courseName:'miyoshi-country-club'});
assert.ok([200,202].includes(res.status), 'expected accept, got '+res.status);
assert.equal(state.maps[0].course_lat, 35.14, 'pin moved (lat)');
assert.equal(state.maps[0].course_lng, 137.0985, 'pin moved (lng)');
assert.deepEqual(state.maps[0].objects_json, {}, 'geometry cleared with it');
assert.equal(state.patched.length, 1, 'one write: pin and clear together');
assert.equal(state.maps[0].course_name, '三好カントリー倶楽部', 'name untouched');
assert.equal(state.jobs.length, 1, 'a mapping job was enqueued');
console.log('7. remap with coordinates moved the pin, cleared geometry, kept the name');

// 8. A half or garbled pin is no pin: the course stays where it was.
for (const bad of [{courseLat:35.2}, {courseLat:'x', courseLng:137}, {courseLat:95, courseLng:137}]) {
  state.maps[0].objects_json = {a:1}; state.jobs.length = 0;
  res = await post(Object.assign({courseId:'miyoshi-country-club', kind:'remap'}, bad));
  assert.ok([200,202].includes(res.status), 'expected accept, got '+res.status);
  assert.equal(state.maps[0].course_lat, 35.14, 'location kept for '+JSON.stringify(bad));
}
console.log('8. a half or garbled pin leaves the location alone');

console.log('\ncourse-remap passed: 26 checks');

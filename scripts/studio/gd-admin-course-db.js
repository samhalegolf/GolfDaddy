/* Clarity Caddy admin Course Database + visual-engine tuning dock.
   STUDIO ONLY - index.html loads this with data-gd-surface="studio", so the
   phone build never parses it. See docs/APP_STUDIO_SPLIT.md.

   Moved verbatim (app/studio split phase 2) from gd-app-core.js lines 347-2473
   plus its window.* exports from 2763-2770. Not wrapped in an IIFE on purpose:
   these are called by inline onclick/oninput handlers in the Database panel and
   by other top-level code, so they have to stay in the shared global scope that
   every other classic script in this page shares. Loading after core is fine -
   nothing here runs during core's own top-level pass, and the only statement
   that executes on load is the delegated listener binding below, which the app
   build is better off without (three document-level capture listeners that only
   ever served admin controls). */
let gdAdminCourseDatabaseSelected="";
let gdAdminCourseDatabaseTab="overview";
const gdAdminCoursePreviewHoleByCourse={};
function gdAdminCourseDbMetric(label,value){
  return `<div class="gdAdminDatabaseMetric"><span>${gdEscapeHTML(label)}</span><strong>${gdEscapeHTML(value ?? "")}</strong></div>`;
}
function gdAdminCourseLocationPayload(selected,payload={}){
  const course=selected&&selected.course||{};
  return Object.assign({},payload&&payload.course||payload||{},course,{
    courseId:course.courseId||selected&&selected.id||payload&&payload.courseId,
    courseName:course.courseName||course.name||selected&&selected.name||payload&&payload.courseName,
    name:course.courseName||course.name||selected&&selected.name||payload&&payload.name
  });
}
function gdAdminCourseLocationSummary(selected,payload={}){
  const course=gdAdminCourseLocationPayload(selected,payload);
  const owner=window.GDCourseLocation;
  const resolved=owner&&typeof owner.resolve==="function"?owner.resolve(course,{requireConfirmed:false}):null;
  const centre=resolved&&resolved.centre;
  const point=centre?`${Number(centre.lat).toFixed(5)}, ${Number(centre.lng).toFixed(5)}`:"Not set";
  const source=resolved&&resolved.source||"unresolved";
  const confirmed=resolved&&resolved.confirmed?"confirmed":"proposal";
  const updated=resolved&&resolved.updatedAt?gdCoursePlayDebugTime(resolved.updatedAt):"";
  return {course,resolved,point,source,confirmed,updated};
}
function gdAdminCourseLocationMarkup(selected,payload={}){
  const info=gdAdminCourseLocationSummary(selected,payload);
  const id=gdAdminJsArg(selected&&selected.id||info.course.courseId||"");
  return `<details class="gdAdminCourseSettings" open><summary>Course location</summary><div class="gdAdminCourseSettingsBody"><div class="gdAdminDatabaseSummary">${[
    gdAdminCourseDbMetric("Centre",info.point),
    gdAdminCourseDbMetric("Source",info.source),
    gdAdminCourseDbMetric("Status",info.resolved?info.confirmed:"missing"),
    gdAdminCourseDbMetric("Updated",info.updated||"")
  ].join("")}</div><div class="gdAdminCourseVisualActions"><button type="button" onclick="return gdAdminCourseLocationEdit(${id})">Edit location</button><button class="danger" type="button" onclick="return gdAdminCourseLocationRemove(${id})">Remove</button></div></div></details>`;
}
function gdAdminCourseDbBadge(label,tone=""){
  return `<span class="gdAdminCourseBadge ${gdEscapeHTML(tone)}">${gdEscapeHTML(label)}</span>`;
}
function gdAdminCourseDbFlag(value){
  return `<span class="gdCoursePlayDebugFlag ${value?'ok':'bad'}">${value?'Yes':'No'}</span>`;
}
/* The admin Course Database screen is a LIVE view of Supabase (/api/course-maps),
   not the local Course Play Pipeline. It fetches once on first render and on
   explicit Refresh, caches the result, and only falls back to the local pipeline
   when Supabase is unreachable - and even then the status banner says so, so the
   source is never ambiguous. */
let gdAdminCourseDbCloud=null;            // transformed {courses:{}} store from Supabase
let gdAdminCourseDbCloudAt=0;             // Date.now() of the last successful load
let gdAdminCourseDbCloudUpdatedAt="";     // the DB's own updatedAt
let gdAdminCourseDbCloudState="idle";     // idle | loading | ready | error
let gdAdminCourseDbCloudError="";
let gdAdminCourseDbCloudInflight=null;
/* Mapping state for every course, from /api/course-mapper-jobs with no
   courseId. Loaded once alongside the course list rather than per row - asking
   per row is why the screen never showed a failure reason at all. Absent data
   is not an error: the list still renders, it just cannot explain a course
   with no geometry until this lands. */
let gdAdminCourseDbJobs={};
let gdAdminCourseDbJobsAt=0;
let gdAdminCourseDbJobsInflight=null;
function gdAdminCourseDbJobState(courseId){
  return gdAdminCourseDbJobs[String(courseId||"")]||null;
}
function gdLoadAdminCourseDbJobs(opts){
  opts=opts||{};
  if(typeof fetch!=="function")return Promise.resolve(null);
  if(gdAdminCourseDbJobsInflight&&!opts.force)return gdAdminCourseDbJobsInflight;
  if(!opts.force&&gdAdminCourseDbJobsAt&&Date.now()-gdAdminCourseDbJobsAt<20000)return Promise.resolve(gdAdminCourseDbJobs);
  gdAdminCourseDbJobsInflight=fetch("/api/course-mapper-jobs",{headers:{Accept:"application/json"},cache:"no-store"})
    .then(res=>res.ok?res.json():null)
    .then(data=>{
      gdAdminCourseDbJobs=data&&data.courses||{};
      gdAdminCourseDbJobsAt=Date.now();
      return gdAdminCourseDbJobs;
    })
    .catch(()=>gdAdminCourseDbJobs)
    .finally(()=>{gdAdminCourseDbJobsInflight=null;});
  return gdAdminCourseDbJobsInflight;
}
/* What the course itself proves, before the queue is consulted. Geometry is the
   only evidence a course is playable, so it is the only thing that earns
   "published". */
function gdAdminCourseDbBaseStatus(course){
  const holes=Object.keys(course&&course.holes||{}).length;
  const objects=Object.keys(course&&course.objects||{}).length;
  return holes>0?"published":objects>0?"partial":"empty";
}
/* The status a row displays. Geometry wins; the mapper queue only gets to
   speak for a course that has none, which is exactly the case the old default
   was hiding. Vocabulary matches functions/course-mapper-jobs.mjs so this
   screen and that endpoint can never disagree. */
function gdAdminCourseDbStatusFor(item){
  const base=item&&item.status||"unknown";
  if(base==="published"||base==="partial")return base;
  const job=gdAdminCourseDbJobState(item&&item.id);
  if(!job)return base;
  if(job.state==="running"||job.state==="queued")return "mapping";
  if(job.state==="failed")return "failed";
  return base;
}
/* One plain sentence for why a course is not playable. "" when it is. */
function gdAdminCourseDbStatusWhy(item){
  const status=gdAdminCourseDbStatusFor(item);
  const job=gdAdminCourseDbJobState(item&&item.id);
  if(status==="published")return "";
  if(status==="partial")return "Some geometry landed but no complete holes were built.";
  if(status==="mapping")return "A mapping run is in flight. This course has no geometry yet.";
  if(status==="failed")return job&&job.lastError?job.lastError:"The last mapping run failed and gave no reason.";
  if(status==="empty")return job?"No geometry, and no mapping run has been recorded for this course.":"No geometry yet. Mapping state has not loaded.";
  return "";
}

function gdMapCloudMapsToAdminStore(maps){
  const store={courses:{},updatedAt:maps&&maps.updatedAt||"",storage:maps&&maps.storage||"supabase"};
  const courses=maps&&maps.courses||{};
  Object.keys(courses).forEach(key=>{
    const c=courses[key]||{};
    const courseId=c.courseId||c.id||key;
    store.courses[courseId]=Object.assign({},c,{
      courseId:courseId,
      courseKey:courseId,
      courseName:c.courseName||c.name||courseId,
      /* NOT a default of "published". Every cloud row used to be labelled
         published on arrival, so a course with zero holes and a failed mapping
         run displayed exactly like a fully mapped one - which is how North
         Shore showed "published 0/0". The row carries no status column; what a
         course actually is has to be read off its geometry, and off the mapper
         queue for the courses that have none. gdAdminCourseDbStatusFor does
         both. */
      status:c.status||gdAdminCourseDbBaseStatus(c),
      syncStatus:"cloud",
      source:"supabase",
      holes:c.holes||{},
      updatedAt:c.updatedAt||c.publishedAt||store.updatedAt||""
    });
  });
  return store;
}
function gdLoadAdminCourseDbCloud(opts){
  opts=opts||{};
  if(gdAdminCourseDbCloudInflight&&!opts.force)return gdAdminCourseDbCloudInflight;
  if(typeof fetch!=="function"){gdAdminCourseDbCloudState="error";gdAdminCourseDbCloudError="fetch unavailable";return Promise.resolve(null);}
  gdAdminCourseDbCloudState="loading";
  gdAdminCourseDbCloudInflight=fetch("/api/course-maps",{headers:{Accept:"application/json"},cache:"no-store"})
    .then(res=>{if(!res.ok)throw new Error("HTTP "+res.status);return res.json();})
    .then(maps=>{
      if(maps&&maps.unavailable){
        gdAdminCourseDbCloudState="error";
        gdAdminCourseDbCloudError=(maps.warnings&&maps.warnings[0]&&maps.warnings[0].message)||"Supabase unavailable";
        return null;
      }
      gdAdminCourseDbCloud=gdMapCloudMapsToAdminStore(maps);
      gdAdminCourseDbCloudAt=Date.now();
      gdAdminCourseDbCloudUpdatedAt=(maps&&maps.updatedAt)||"";
      gdAdminCourseDbCloudState="ready";
      gdAdminCourseDbCloudError="";
      return gdAdminCourseDbCloud;
    })
    .catch(err=>{
      gdAdminCourseDbCloudState="error";
      gdAdminCourseDbCloudError=err&&err.message||String(err);
      return null;
    })
    .finally(()=>{gdAdminCourseDbCloudInflight=null;gdRenderAdminCourseDatabase();});
  return gdAdminCourseDbCloudInflight;
}
function gdRefreshAdminCourseDbCloud(){gdLoadAdminCourseDbCloud({force:true});return false;}
function gdAdminCourseDbCloudStatusMarkup(){
  const state=gdAdminCourseDbCloudState;
  const count=gdAdminCourseDbCloud?Object.keys(gdAdminCourseDbCloud.courses||{}).length:0;
  const dbTime=gdAdminCourseDbCloudUpdatedAt?gdCoursePlayDebugTime(gdAdminCourseDbCloudUpdatedAt):"";
  let tone="warn",label="Connecting to Supabase…";
  if(state==="loading")label="Loading from Supabase…";
  else if(state==="ready"){tone="ready";label=`🟢 Live from Supabase · ${count} course${count===1?"":"s"}${dbTime?" · DB updated "+dbTime:""}`;}
  else if(state==="error")label=`⚠ Supabase unreachable — showing local cache (${gdEscapeHTML(gdAdminCourseDbCloudError||"unknown")})`;
  const busy=state==="loading"||!!gdAdminCourseDbCloudInflight;
  return `<div class="gdAdminDatabaseLive"><span class="gdAdminCourseStatusDot ${tone}">${label}</span><button type="button" onclick="return gdRefreshAdminCourseDbCloud()"${busy?" disabled":""}>${busy?"Refreshing…":"Refresh from database"}</button></div>`;
}
function gdAdminCourseDbStore(){
  if(gdAdminCourseDbCloud&&gdAdminCourseDbCloudState==="ready")return gdAdminCourseDbCloud;
  /* Only reached while the first load is in flight or after a Supabase failure -
     the banner labels this as local cache so it is never mistaken for the DB. */
  const api=window.GDCoursePlayPipeline;
  if(api&&typeof api.loadCoursePlayPipeline==="function")return api.loadCoursePlayPipeline();
  try{return JSON.parse(localStorage.getItem("gd_course_play_pipeline_v1")||"null")||{courses:{}};}catch(e){return {courses:{}};}
}
function gdAdminCourseDbFrameRows(courseId){
  const api=window.GDCoursePlayPipeline;
  if(api&&typeof api.getCoursePlayFrameIndex==="function"){
    const rows=api.getCoursePlayFrameIndex(courseId);
    return Array.isArray(rows)?rows:[];
  }
  try{
    const raw=JSON.parse(localStorage.getItem("gd_course_play_frame_index_v1")||"null")||{frames:{}};
    const prefix=String(courseId||"")+":h";
    return Object.keys(raw.frames||{}).filter(key=>key.indexOf(prefix)===0).map(key=>raw.frames[key]);
  }catch(e){return [];}
}
function gdAdminCourseDbPayload(courseId){
  if(gdAdminCourseDbCloud&&gdAdminCourseDbCloudState==="ready"){
    const cloudCourse=gdAdminCourseDbCloud.courses[String(courseId||"")];
    if(cloudCourse)return cloudCourse;
  }
  try{
    if(typeof window.__gdExportCoursePlayPayload==="function")return window.__gdExportCoursePlayPayload(courseId);
    if(window.GDCoursePlayPipeline&&typeof window.GDCoursePlayPipeline.buildCoursePlayDbPayload==="function")return window.GDCoursePlayPipeline.buildCoursePlayDbPayload(courseId);
  }catch(e){return {error:e&&e.message?e.message:String(e)};}
  return null;
}
/* Hole rows are judged from the published package (objects_json/holes_json) -
   the same data GPS consumes. Play ready = a green plus at least one more
   point (tee or fairway), mirroring the pipeline's own viability test. The
   pipeline-schema fields (teePoint/greenCentre/fairwayPoints) are read as a
   fallback so the local-cache view still works when Supabase is unreachable. */
function gdAdminCourseDbHoleRows(course){
  const objectsByHole={};
  Object.keys(course.objects||{}).forEach(key=>{
    const object=course.objects[key]||{};
    const number=Number(object.holeNumber)||0;
    if(!number)return;
    const slot=objectsByHole[number]=objectsByHole[number]||{tee:null,green:null,fairways:0,sources:[]};
    if(object.type==="tee")slot.tee=slot.tee||object;
    else if(object.type==="green")slot.green=slot.green||object;
    else if(object.type==="fairway")slot.fairways+=1;
    if(object.source&&slot.sources.indexOf(object.source)<0)slot.sources.push(object.source);
  });
  const seen={};
  Object.keys(course.holes||{}).forEach(key=>{seen[String(Number(key)||Number(course.holes[key]?.holeNumber)||0)]=true;});
  Object.keys(objectsByHole).forEach(number=>{seen[String(number)]=true;});
  return Object.keys(seen).map(Number).filter(Boolean).sort((a,b)=>a-b).map(number=>{
    const hole=course.holes&&course.holes[String(number)]||{};
    const slot=objectsByHole[number]||{tee:null,green:null,fairways:0,sources:[]};
    const hasTee=!!(slot.tee||hole.teePoint);
    const hasGreen=!!(slot.green||hole.greenCenter||hole.greenCentre||(hole.greenShape&&hole.greenShape.length));
    const greenShape=slot.green&&(slot.green.greenShape||slot.green.shape)||hole.greenShape;
    const hasGreenShape=!!(greenShape&&greenShape.length>=3);
    const fairways=slot.fairways||(hole.fairwayPoints&&hole.fairwayPoints.length)||0;
    const playReady=hasGreen&&(hasTee||fairways>0||(hole.routePoints&&hole.routePoints.length>=2));
    const state=playReady?"play ready":(hasTee||hasGreen||fairways)?"incomplete":"empty";
    const source=slot.sources.length?gdAdminCourseDbSourceLabel(slot.sources):hole.greenSource||hole.source||"unknown";
    return {
      holeNumber:number,
      state:state,
      playReady:playReady,
      hasTee:hasTee,
      hasGreen:hasGreen,
      hasGreenShape:hasGreenShape,
      fairways:fairways,
      source:source
    };
  });
}
function gdAdminCourseDbSourceLabel(sources){
  /* "osm_auto_tee, osm_auto_green_polygon, ..." collapses to "osm_auto". */
  const stems=sources.map(source=>String(source).replace(/_(tee|green|fairway).*$/,""));
  return stems.filter((stem,index)=>stems.indexOf(stem)===index).join(" / ");
}
function gdAdminCourseDbObjectTotals(course){
  const totals={tees:0,greens:0,fairways:0};
  Object.keys(course.objects||{}).forEach(key=>{
    const type=course.objects[key]&&course.objects[key].type;
    if(type==="tee")totals.tees+=1;
    else if(type==="green")totals.greens+=1;
    else if(type==="fairway")totals.fairways+=1;
  });
  return totals;
}
function gdAdminCourseDbSummaries(){
  const store=gdAdminCourseDbStore();
  return Object.keys(store.courses||{}).map(key=>{
    const course=store.courses[key]||{};
    course.courseId=course.courseId||key;
    course.courseKey=course.courseKey||course.courseId;
    const rows=gdAdminCourseDbHoleRows(course);
    return {
      course:course,
      id:course.courseId,
      name:course.courseName||course.name||course.courseKey||course.courseId||"Course",
      key:course.courseKey||course.courseId||key,
      status:course.status||"unknown",
      syncStatus:course.syncStatus||"local",
      schemaVersion:course.schemaVersion||store.schemaVersion||"",
      dataVersion:course.dataVersion||"",
      updatedAt:course.updatedAt||"",
      source:course.source||"local",
      holeCount:rows.length,
      geometryReadyCount:rows.filter(row=>row.hasTee&&row.hasGreen).length,
      playReadyCount:rows.filter(row=>row.playReady).length,
      objectTotals:gdAdminCourseDbObjectTotals(course),
      rows:rows
    };
  }).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));
}
function gdAdminCourseDbOpen(courseId){
  const next=String(courseId||"");
  const nextTab=arguments.length>1?String(arguments[1]||"overview"):gdAdminCourseDatabaseTab;
  if(next&&next===gdAdminCourseDatabaseSelected&&nextTab==="overview"&&gdAdminCourseDatabaseTab==="overview"){
    gdAdminCourseDatabaseSelected="";
    gdAdminCourseDatabaseTab="overview";
  }else{
    gdAdminCourseDatabaseSelected=next;
    gdAdminCourseDatabaseTab=nextTab;
  }
  gdRenderAdminCourseDatabase();
  return false;
}
function gdAdminCourseLocationSelected(courseId){
  const id=String(courseId||gdAdminCourseDatabaseSelected||"");
  const selected=gdAdminCourseDbSummaries().find(item=>item.id===id);
  if(!selected)return null;
  const payload=gdAdminCourseDbPayload(selected.id)||{};
  return gdAdminCourseLocationPayload(selected,payload);
}
function gdAdminCourseLocationEdit(courseId){
  const course=gdAdminCourseLocationSelected(courseId);
  if(!course)return false;
  if(typeof window.gdShowCoursePinScreen==="function")return window.gdShowCoursePinScreen(course);
  if(window.GDCoursePicker&&typeof window.GDCoursePicker.open==="function")return window.GDCoursePicker.open({source:"admin-course-location",returnTarget:"gps"});
  return false;
}
function gdAdminCourseLocationRemove(courseId){
  const course=gdAdminCourseLocationSelected(courseId);
  if(!course||!window.GDCourseLocation||typeof window.GDCourseLocation.remove!=="function")return false;
  window.GDCourseLocation.remove(course,{source:"admin-course-location-remove"});
  gdRenderAdminCourseDatabase();
  try{if(typeof renderCourseLibraryPanel==="function")renderCourseLibraryPanel();}catch(e){}
  try{if(typeof toast==="function")toast("Course location removed");}catch(e){}
  return false;
}
function gdToggleAdminCourseDbPayload(){
  const el=document.getElementById("gdAdminCourseDbPayload");
  if(el)el.classList.toggle("open");
  return false;
}
function gdAdminCourseDbSetTab(tab){
  gdAdminCourseDatabaseTab=String(tab||"overview");
  gdRenderAdminCourseDatabase();
  return false;
}
function gdAdminJsArg(value){
  return gdEscapeHTML(JSON.stringify(String(value||"")));
}
function gdAdminCourseDbStatusTone(value,okValues){
  value=String(value||"").toLowerCase();
  if((okValues||[]).some(ok=>value===String(ok).toLowerCase()))return "ok";
  if(/fail|error|unavailable|missing|delete/i.test(value))return "bad";
  return "warn";
}
/* Visual engine lifecycle: live map (no engine record - GPS uses the live
   basemap, a valid state, not an error) -> working -> preview -> published.
   Red is reserved for an actual engine failure. */
/* "Published" is a fact about the DATABASE - one frame per hole, however many holes the course
   has - and the cloud build state answers it directly. It is not something to infer from what
   this particular browser happens to have in its local store. (This used to say "a course is 18
   hole images"; North Shore is 27 and Balgove is 9. The visual planner never assumed 18 - it
   iterates whatever holes the package carries - but the comment implied a rule that does not
   exist.)

   That inference is what put Jacks Point on "preview" while the database held 18 published
   frames at version 5: a local scan in this browser had left a previewVisual behind, and no
   cloud publish ever overwrites local artifacts, so the label described the browser rather
   than the course. Any other machine would have said something different about the same course.

   The local record is still consulted, but only BELOW the cloud answer and only for states the
   cloud has no opinion on - a local sandbox bake that has not been published anywhere. */
/* The visual worker's own words when it refuses for want of licensed imagery:
   `imagery-source-unavailable: <reason>`. Matched on the prefix rather than the
   full sentence, because the reason half varies - no coverage at all, a draft
   entry, ShareAlike, a missing API key - and every one of them means the same
   thing to a player: no Clarity map, live tiles instead. */
function gdAdminVisualUnlicensed(lastError){
  return /^imagery-source-unavailable/.test(String(lastError||"").trim());
}
function gdAdminVisualUnlicensedTitle(lastError){
  const reason=String(lastError||"").replace(/^imagery-source-unavailable:\s*/,"").trim();
  return "No Clarity map here - "+(reason||"no licensed imagery source covers this course")+". Geometry is published and the course plays on live tiles.";
}
function gdAdminCourseDbVisualState(courseId){
  const cloud=gdAdminCourseBuildState(courseId);
  if(cloud){
    if(cloud.framesReady)return {label:"published",tone:"ok"};
    if(cloud.building)return {label:cloud.activeKind==="export"?"baking":"scanning",tone:"warn"};
    if(cloud.state==="captures-ready")return {label:"capture ready",tone:"warn"};
    /* An unlicensed region is not a failure. There is no imagery source covering
       Great Britain, so every St Andrews course lands here - with working
       geometry that plays on live tiles, which is exactly what "live map"
       means. Red is reserved for a build that could have worked and did not. */
    if(cloud.state==="failed"&&gdAdminVisualUnlicensed(cloud.lastError))return {label:"live map",tone:"",title:gdAdminVisualUnlicensedTitle(cloud.lastError)};
    if(cloud.state==="failed"&&cloud.failedStage==="export")return {label:"visual treatment failed",tone:"bad"};
    if(cloud.state==="failed")return {label:"capture failed",tone:"bad"};
  }
  const record=gdAdminCourseVisualRecord(courseId);
  if(!record)return {label:"live map",tone:""};
  if(record.publishedVisual)return {label:"published",tone:"ok"};
  if(record.previewVisual)return {label:"local preview",tone:"ok"};
  if(record.rawMaster||record.basicVisual)return {label:"working",tone:"warn"};
  if(record.lastError||record.status==="failed")return {label:"error",tone:"bad"};
  return {label:"live map",tone:""};
}
function gdAdminCourseDbActionRail(selected){
  const id=gdAdminJsArg(selected&&selected.id||"");
  const active=tab=>gdAdminCourseDatabaseTab===tab?" active":"";
  return `<div class="gdAdminCourseActionRail">
    <button type="button" class="${active("geometry")}" onclick="return gdAdminCourseDbShowGeometry(${id})">Geometry</button>
    <button type="button" class="${active("preview")}" onclick="return gdAdminCourseDbShowPreview(${id})">Visual Engine</button>
    <button type="button" class="${active("scorecard")}" onclick="return gdAdminCourseDbShowScorecard(${id})">Score Card</button>
    <button type="button" class="${active("debug")}" onclick="return gdAdminCourseDbShowDebug(${id})">Debug</button>
    <button type="button" class="danger" onclick="return gdAdminCourseDbDelete(${id})">Delete</button>
    <button type="button" class="primary" onclick="return gdAdminCourseDbUpdate(${id})">Update</button>
  </div>`;
}
function gdAdminCourseDbLoadVisual(courseId){
  return gdAdminCourseDbOpen(courseId,"visuals");
}
function gdAdminCourseDbShowGeometry(courseId){
  return gdAdminCourseDbOpen(courseId,"geometry");
}
function gdAdminCourseDbShowScorecard(courseId){
  return gdAdminCourseDbOpen(courseId,"scorecard");
}
function gdAdminCourseDbShowPreview(courseId){
  return gdAdminCourseDbOpen(courseId,"preview");
}
function gdAdminCourseDbShowDebug(courseId){
  return gdAdminCourseDbOpen(courseId,"debug");
}
/* Mirrors ADMIN_EMAILS in functions/course-maps.mjs - the server is the real
   gate (it 403s a non-admin actor); this only decides whether we bother asking. */
const GD_ADMIN_DB_EMAILS=["samhalegolf@gmail.com","admin@clarity.local"];
function gdAdminCourseDbActor(){
  let account=null;
  try{account=window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"?window.GolfDaddyAccounts.current():null;}catch(e){}
  let profile=null;
  try{profile=typeof activePlayerProfile==="function"?activePlayerProfile():null;}catch(e){}
  let role="player";
  try{role=typeof gdGetAccountPermission==="function"?gdGetAccountPermission():((account&&account.role)||(profile&&profile.permission)||"player");}catch(e){}
  return {
    name:(account&&account.name)||(profile&&profile.name)||"Admin",
    email:String((account&&account.email)||(profile&&profile.email)||"").trim().toLowerCase(),
    role:String((account&&account.role)||role||"player").trim().toLowerCase(),
    accountId:(account&&account.accountId)||(profile&&profile.accountId)||""
  };
}
function gdAdminCourseDbIsAdmin(){
  const actor=gdAdminCourseDbActor();
  return actor.role==="admin"&&GD_ADMIN_DB_EMAILS.indexOf(actor.email)>=0;
}
/* The server proves admin from this token against Supabase Auth - the actor
   below is only descriptive metadata and grants nothing on its own. */
async function gdAdminCourseDbAccessToken(){
  try{
    const auth=window.ClaritySupabaseAuth;
    if(auth&&typeof auth.freshAccessToken==="function"){
      const token=await auth.freshAccessToken();
      if(token)return String(token);
    }
    const session=auth&&typeof auth.session==="function"?auth.session():null;
    return String(session&&(session.access_token||session.accessToken)||"");
  }catch(error){return "";}
}
async function gdAdminCourseDbDeleteFromCloud(courseId,courseName){
  const token=await gdAdminCourseDbAccessToken();
  if(!token)throw new Error("No signed-in Supabase session — sign in again to delete from the database");
  const res=await fetch("/api/course-maps",{
    method:"POST",
    headers:{"Content-Type":"application/json",Accept:"application/json",Authorization:"Bearer "+token},
    body:JSON.stringify({action:"delete",courseId:courseId,courseName:courseName||"",actor:gdAdminCourseDbActor()})
  });
  let data=null;
  try{data=await res.json();}catch(e){}
  if(!res.ok)throw new Error((data&&data.error)||("HTTP "+res.status));
  return data||{};
}
/* Deletes the published course from Supabase first, and only clears the local
   remnants once the database confirms - a failed/refused delete must not leave
   the device wiped while the course is still live for everyone else. */
async function gdAdminCourseDbDelete(courseId){
  courseId=String(courseId||"");
  if(!courseId)return false;
  const summary=gdAdminCourseDbSummaries().find(item=>item.id===courseId);
  const label=(summary&&summary.name)||courseId;
  if(!gdAdminCourseDbIsAdmin()){
    gdAdminCourseVisualToast("Admin only — sign in as an admin to delete from the database");
    return false;
  }
  // window.confirm is silently suppressed in the embedded webview (returns false
  // instantly, no dialog), so this delete could never run there. In-app dialog
  // instead; the confirm fallback only applies if the dialog owner has not loaded.
  const confirmedDbDelete=typeof window.gdConfirmDialog==="function"
    ? await window.gdConfirmDialog({
        title:`Permanently delete "${label}"?`,
        message:"This removes the published course map from the database for every user and cannot be undone.",
        confirmLabel:"Delete forever"
      })
    : window.confirm(`Permanently delete "${label}" from the Supabase course database?\n\nThis removes the published course map for every user and cannot be undone.`);
  if(!confirmedDbDelete)return false;
  let result=null;
  try{
    gdAdminCourseVisualToast(`Deleting ${label} from the database…`);
    result=await gdAdminCourseDbDeleteFromCloud(courseId,label);
  }catch(error){
    gdAdminCourseVisualToast(`Database delete failed: ${error&&error.message||error}`);
    return false;
  }
  try{
    const api=window.GDCoursePlayPipeline;
    const key=api&&api.storageKey||"gd_course_play_pipeline_v1";
    const store=api&&typeof api.loadCoursePlayPipeline==="function"?api.loadCoursePlayPipeline():JSON.parse(localStorage.getItem(key)||"null")||{courses:{}};
    if(store&&store.courses)delete store.courses[courseId];
    store.updatedAt=new Date().toISOString();
    gdSafeLocalSet(key,JSON.stringify(store));
  }catch(error){console.warn("[GolfDaddy] course delete pipeline cleanup failed",error);}
  try{
    const api=window.GDCoursePlayPipeline;
    const key=api&&api.frameIndexStorageKey||"gd_course_play_frame_index_v1";
    const index=api&&typeof api.loadCoursePlayFrameIndex==="function"?api.loadCoursePlayFrameIndex():JSON.parse(localStorage.getItem(key)||"null")||{frames:{}};
    Object.keys(index.frames||{}).forEach(frameKey=>{if(String(frameKey).indexOf(courseId+":h")===0)delete index.frames[frameKey];});
    index.updatedAt=new Date().toISOString();
    gdSafeLocalSet(key,JSON.stringify(index));
  }catch(error){console.warn("[GolfDaddy] course delete frame cleanup failed",error);}
  try{
    const engine=window.GDCourseVisualEngine;
    if(engine&&typeof engine.loadStore==="function"&&typeof engine.saveStore==="function"){
      const store=engine.loadStore();
      if(store&&store.records)delete store.records[courseId];
      engine.saveStore(store);
    }
  }catch(error){console.warn("[GolfDaddy] course delete visual cleanup failed",error);}
  gdAdminCourseDatabaseSelected="";
  gdAdminCourseDatabaseTab="overview";
  /* Auto-sync: refetch so the dashboard reflects the database, not our assumption
     about what the delete did. gdLoadAdminCourseDbCloud re-renders on completion. */
  await gdLoadAdminCourseDbCloud({force:true});
  const removed=Number(result&&result.deleted&&result.deleted.supabase)||0;
  gdAdminCourseVisualToast(removed?`${label} deleted from the database`:`${label} was not in the database — local data cleared`);
  return false;
}
async function gdAdminCourseDbUpdate(courseId){
  courseId=String(courseId||"");
  if(!courseId)return false;
  gdAdminCourseDatabaseSelected=courseId;
  try{
    window.GDCoursePlayPipeline?.markCoursePlaySyncPending?.(courseId,null,"admin-update");
  }catch(error){console.warn("[GolfDaddy] course update sync marker failed",error);}
  try{
    const engine=window.GDCourseVisualEngine;
    const record=gdAdminCourseVisualRecord(courseId)||engine?.getRecord?.(courseId);
    const presetId=String(record&&record.presetId||engine?.defaultPreset?.().id||"");
    const overrides=record&&record.courseOverrides||{};
    gdAdminCourseVisualToast("Updating course admin data");
    if(engine&&typeof engine.buildFromCourseDatabase==="function")await engine.buildFromCourseDatabase(courseId,{forceFresh:false});
    if(engine&&typeof engine.buildCourseVisualPreview==="function")await engine.buildCourseVisualPreview(courseId,presetId,overrides);
    gdAdminCourseVisualToast("Course admin data updated");
  }catch(error){
    console.warn("[GolfDaddy] course update failed",error);
    gdAdminCourseVisualToast(error&&error.message?error.message:"Course update failed");
  }finally{
    gdRenderAdminCourseDatabase();
  }
  return false;
}
function gdAdminCourseScorecardRows(selected){
  const course=selected&&selected.course||{};
  const payload=gdAdminCourseDbPayload(selected&&selected.id||"")||{};
  const scorecardSources=[
    course.scorecard&&course.scorecard.holes,
    course.scorecardHoles,
    payload.scorecard&&payload.scorecard.holes,
    payload.scorecardHoles,
    window.scorecard&&window.scorecard.holes
  ].filter(Array.isArray);
  const sourceRows=scorecardSources[0]||[];
  const byHole={};
  sourceRows.forEach((hole,index)=>{
    const n=Number(hole&&(hole.holeNumber||hole.hole||hole.number))||index+1;
    byHole[n]=hole||{};
  });
  const count=Math.max(selected&&selected.holeCount||0,sourceRows.length||0,18);
  return Array.from({length:count},(_,index)=>{
    const number=index+1;
    const hole=course.holes&&course.holes[String(number)]||{};
    const score=byHole[number]||{};
    const row=(selected&&selected.rows||[]).find(item=>Number(item.holeNumber)===number)||{};
    return {
      holeNumber:number,
      par:score.par||hole.par||hole.scorecardPar||"",
      distance:score.distanceM||score.lengthM||score.metres||hole.distanceM||hole.lengthM||"",
      yards:score.distanceYards||score.yards||hole.distanceYards||hole.yards||"",
      status:row.status||hole.status||"unknown",
      source:score.source||hole.source||row.source||"",
      confidence:hole.confidence||row.confidence||""
    };
  });
}
function gdAdminCourseScorecardMarkup(selected){
  const rows=gdAdminCourseScorecardRows(selected);
  return `<div class="gdAdminCourseWorkspace"><div class="gdAdminCourseStageLine"><span class="ready">${gdEscapeHTML(rows.length)} holes</span><span>${gdEscapeHTML(selected.syncStatus||"local")}</span><span>${gdEscapeHTML(selected.source||"course db")}</span></div><div class="gdAdminCourseHoleScroll"><table class="gdAdminScorecardTable"><thead><tr><th>Hole</th><th>Par</th><th>Metres</th><th>Yards</th><th>State</th><th>Source</th><th>Confidence</th></tr></thead><tbody>${rows.map(row=>`<tr><td>H${gdEscapeHTML(row.holeNumber)}</td><td>${gdEscapeHTML(row.par||"")}</td><td>${gdEscapeHTML(row.distance||"")}</td><td>${gdEscapeHTML(row.yards||"")}</td><td>${gdEscapeHTML(row.status)}</td><td>${gdEscapeHTML(row.source||"")}</td><td>${gdEscapeHTML(row.confidence||"")}</td></tr>`).join("")}</tbody></table></div></div>`;
}
function gdAdminCoursePreviewHoleCount(selected,record){
  const visualCount=Math.max(...[
    record&&record.holeFramePublishedVisuals&&record.holeFramePublishedVisuals.length||0,
    record&&record.holeFramePreviewVisuals&&record.holeFramePreviewVisuals.length||0,
    record&&record.holeFrameVisuals&&record.holeFrameVisuals.length||0
  ]);
  return Math.max(selected&&selected.holeCount||0,visualCount||0,18);
}
function gdAdminCoursePreviewAsset(record,holeNumber){
  // Sandbox source: always the FRESHEST bake of the recipe, so every control (terrain included)
  // shows its real effect. The recipe is re-baked when a control is released, and nothing is
  // layered on top of it in CSS — layering double-applied the look and made settings look stuck.
  const lists=[
    record&&record.holeFramePreviewVisuals,
    record&&record.holeFramePublishedVisuals,
    record&&record.holeFrameVisuals
  ];
  for(const list of lists){
    const match=(Array.isArray(list)?list:[]).find(asset=>Number(asset&&asset.holeNumber)===Number(holeNumber)&&asset.dataUrl);
    if(match)return match;
  }
  return record&&record.exampleHoleVisual||record&&record.singleHolePublishedVisual||record&&record.singleHolePreviewVisual||null;
}
/* Frames exported by the server worker live in the course-visuals bucket behind
   /api/course-visual-assets. The index is fetched once per course per session; when it
   arrives the preview re-renders so cloud frames appear without local captures at all. */
const gdAdminCourseCloudFramesCache={};
function gdAdminCourseCloudFrames(courseId){
  courseId=String(courseId||"");
  if(!courseId)return null;
  const cached=gdAdminCourseCloudFramesCache[courseId];
  if(cached)return cached.index||null;
  gdAdminCourseCloudFramesCache[courseId]={index:null};
  fetch("/api/course-visual-assets?path="+encodeURIComponent(courseId+"/frames/index.json"),{headers:{Accept:"application/json"}})
    .then(res=>res.ok?res.json():null)
    .then(index=>{
      gdAdminCourseCloudFramesCache[courseId]={index:index&&Array.isArray(index.holes)&&index.holes.length?index:null};
      if(index&&gdAdminCourseDatabaseSelected===courseId&&gdAdminCourseDatabaseTab==="preview")gdRenderAdminCourseDatabase();
    })
    .catch(()=>{});
  return null;
}
function gdAdminCourseCloudFrameFor(courseId,holeNumber){
  const index=gdAdminCourseCloudFrames(courseId);
  if(!index)return null;
  return index.holes.find(hole=>Number(hole&&hole.holeNumber)===Number(holeNumber))||null;
}
/* Holes that have a native capture baked by the engine, or a cloud frame exported by the
   server worker - the preview walks the union, so a fresh browser can browse a course it
   never scanned locally. */
function gdAdminCoursePreviewCapturedHoles(record,courseId){
  const seen={};
  [record&&record.holeFramePreviewVisuals,record&&record.holeFramePublishedVisuals,record&&record.holeFrameVisuals].forEach(list=>{
    (Array.isArray(list)?list:[]).forEach(asset=>{const n=Number(asset&&asset.holeNumber);if(n)seen[n]=true;});
  });
  const cloud=courseId?gdAdminCourseCloudFrames(courseId):null;
  if(cloud)cloud.holes.forEach(hole=>{const n=Number(hole&&hole.holeNumber);if(n)seen[n]=true;});
  return Object.keys(seen).map(Number).sort((a,b)=>a-b);
}
function gdAdminCoursePreviewSetHole(courseId,holeNumber){
  courseId=String(courseId||gdAdminCourseDatabaseSelected||"");
  const selected=gdAdminCourseDbSummaries().find(item=>item.id===courseId);
  const record=gdAdminCourseVisualRecord(courseId);
  const count=gdAdminCoursePreviewHoleCount(selected,record);
  let target=Math.min(count,Math.max(1,Number(holeNumber)||1));
  const captured=gdAdminCoursePreviewCapturedHoles(record,courseId);
  if(captured.length&&captured.indexOf(target)<0){
    const current=Number(gdAdminCoursePreviewHoleByCourse[courseId])||1;
    const forward=target>=current;
    const snapped=forward?captured.find(n=>n>=target):captured.slice().reverse().find(n=>n<=target);
    target=snapped!=null?snapped:(forward?captured[captured.length-1]:captured[0]);
  }
  gdAdminCoursePreviewHoleByCourse[courseId]=target;
  gdAdminCourseDatabaseSelected=courseId;
  gdAdminCourseDatabaseTab="preview";
  gdRenderAdminCourseDatabase();
  setTimeout(()=>gdAdminCoursePreviewEnsureHoleBake(courseId,target),0);
  return false;
}
/* Bake the visible hole's styled frame on demand - the base frame shows immediately and the
   styled bake replaces it when ready. This is how per-hole previews appear now that the
   automatic pipeline no longer bakes all 18 frames up front. */
function gdAdminCoursePreviewEnsureHoleBake(courseId,holeNumber){
  const engine=window.GDCourseVisualEngine;
  if(!engine||typeof engine.buildCourseVisualPreview!=="function")return;
  const record=gdAdminCourseVisualRecord(courseId);
  if(!record)return;
  const hole=Number(holeNumber)||0;
  if(!hole)return;
  const baked=(record.holeFramePreviewVisuals||[]).some(asset=>Number(asset&&asset.holeNumber)===hole);
  const hasBase=(record.holeFrameVisuals||[]).some(asset=>Number(asset&&asset.holeNumber)===hole);
  if(baked||!hasBase)return;
  if(gdAdminCourseVisualBakePending[courseId])return;
  gdAdminCourseVisualBakePending[courseId]=true;
  engine.buildCourseVisualPreview(courseId,record.presetId,undefined,{holeNumber:hole})
    .then(()=>{if(gdAdminCourseDatabaseSelected===courseId&&gdAdminCourseDatabaseTab==="preview")gdRenderAdminCourseDatabase();})
    .catch(error=>{console.warn("[GolfDaddy] hole preview bake failed",error);})
    .finally(()=>{delete gdAdminCourseVisualBakePending[courseId];});
}
function gdAdminCoursePreviewStep(courseId,delta){
  courseId=String(courseId||gdAdminCourseDatabaseSelected||"");
  const current=Number(gdAdminCoursePreviewHoleByCourse[courseId])||1;
  return gdAdminCoursePreviewSetHole(courseId,current+(Number(delta)||0));
}
function gdAdminCoursePreviewSvgInfo(src){
  const svg=gdAdminCourseVisualSvgText(src);
  if(!svg)return null;
  try{
    const doc=new DOMParser().parseFromString(svg,"image/svg+xml");
    const root=doc&&doc.documentElement;
    if(!root||String(root.nodeName||"").toLowerCase()!=="svg")return null;
    const viewBox=String(root.getAttribute("viewBox")||"").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    const width=viewBox.length===4?viewBox[2]:Number(String(root.getAttribute("width")||"").replace(/[^\d.+-]/g,""));
    const height=viewBox.length===4?viewBox[3]:Number(String(root.getAttribute("height")||"").replace(/[^\d.+-]/g,""));
    return {doc,root,width:Math.max(1,width||1),height:Math.max(1,height||1),minX:viewBox.length===4?viewBox[0]:0,minY:viewBox.length===4?viewBox[1]:0};
  }catch(e){return null;}
}
function gdAdminCoursePreviewMatrixIdentity(){
  return {a:1,b:0,c:0,d:1,e:0,f:0};
}
function gdAdminCoursePreviewMatrixMultiply(m,n){
  return {
    a:m.a*n.a+m.c*n.b,
    b:m.b*n.a+m.d*n.b,
    c:m.a*n.c+m.c*n.d,
    d:m.b*n.c+m.d*n.d,
    e:m.a*n.e+m.c*n.f+m.e,
    f:m.b*n.e+m.d*n.f+m.f
  };
}
function gdAdminCoursePreviewParseTransform(value){
  let matrix=gdAdminCoursePreviewMatrixIdentity();
  const text=String(value||"");
  text.replace(/([a-z]+)\(([^)]*)\)/ig,(_all,kind,args)=>{
    const nums=String(args||"").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    let next=null;
    kind=String(kind||"").toLowerCase();
    if(kind==="matrix"&&nums.length>=6)next={a:nums[0],b:nums[1],c:nums[2],d:nums[3],e:nums[4],f:nums[5]};
    if(kind==="translate")next={a:1,b:0,c:0,d:1,e:nums[0]||0,f:nums.length>1?nums[1]||0:0};
    if(kind==="scale"){
      const sx=nums[0]==null?1:nums[0];
      const sy=nums.length>1?nums[1]:sx;
      next={a:sx,b:0,c:0,d:sy,e:0,f:0};
    }
    if(kind==="rotate"&&nums.length){
      const rad=nums[0]*Math.PI/180;
      const cos=Math.cos(rad),sin=Math.sin(rad);
      next={a:cos,b:sin,c:-sin,d:cos,e:0,f:0};
      if(nums.length>=3){
        const cx=nums[1]||0,cy=nums[2]||0;
        next=gdAdminCoursePreviewMatrixMultiply(
          gdAdminCoursePreviewMatrixMultiply({a:1,b:0,c:0,d:1,e:cx,f:cy},next),
          {a:1,b:0,c:0,d:1,e:-cx,f:-cy}
        );
      }
    }
    if(next)matrix=gdAdminCoursePreviewMatrixMultiply(matrix,next);
    return "";
  });
  return matrix;
}
function gdAdminCoursePreviewElementMatrix(node,root){
  const chain=[];
  for(let item=node;item&&item.nodeType===1;item=item.parentElement){
    chain.unshift(item);
    if(item===root)break;
  }
  return chain.reduce((matrix,item)=>{
    const transform=item.getAttribute&&item.getAttribute("transform");
    return transform?gdAdminCoursePreviewMatrixMultiply(matrix,gdAdminCoursePreviewParseTransform(transform)):matrix;
  },gdAdminCoursePreviewMatrixIdentity());
}
function gdAdminCoursePreviewTransformPoint(matrix,x,y){
  return {x:matrix.a*x+matrix.c*y+matrix.e,y:matrix.b*x+matrix.d*y+matrix.f};
}
function gdAdminCoursePreviewObjectBounds(info){
  if(!info||!info.root)return null;
  const nodes=Array.from(info.root.querySelectorAll('[data-role="play-route-axis"],[data-role="play-green-bound"],[data-role="play-tee-anchor"],[data-role="play-green-anchor"]'));
  if(!nodes.length)return null;
  const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity,count:0};
  const add=(node,x,y,pad=0)=>{
    const matrix=gdAdminCoursePreviewElementMatrix(node,info.root);
    const p=gdAdminCoursePreviewTransformPoint(matrix,Number(x)||0,Number(y)||0);
    bounds.minX=Math.min(bounds.minX,p.x-pad);
    bounds.minY=Math.min(bounds.minY,p.y-pad);
    bounds.maxX=Math.max(bounds.maxX,p.x+pad);
    bounds.maxY=Math.max(bounds.maxY,p.y+pad);
    bounds.count+=1;
  };
  nodes.forEach(node=>{
    const points=String(node.getAttribute("points")||"").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    for(let i=0;i+1<points.length;i+=2)add(node,points[i],points[i+1]);
    if(node.tagName&&String(node.tagName).toLowerCase()==="circle"){
      add(node,Number(node.getAttribute("cx"))||0,Number(node.getAttribute("cy"))||0,Number(node.getAttribute("r"))||0);
    }
  });
  if(!bounds.count||!Number.isFinite(bounds.minX)||!Number.isFinite(bounds.minY)||!Number.isFinite(bounds.maxX)||!Number.isFinite(bounds.maxY))return null;
  return bounds;
}
function gdAdminCoursePreviewClampFrame(frame,sourceWidth,sourceHeight,source){
  if(!frame)return null;
  let width=Math.max(1,Number(frame.width)||0);
  let height=Math.max(1,Number(frame.height)||0);
  let x=Number(frame.x)||0;
  let y=Number(frame.y)||0;
  if(width>sourceWidth)width=sourceWidth;
  if(height>sourceHeight)height=sourceHeight;
  x=Math.max(0,Math.min(sourceWidth-width,x));
  y=Math.max(0,Math.min(sourceHeight-height,y));
  return {x,y,width,height,sourceWidth,sourceHeight,source:source||frame.source||"gps-play-frame"};
}
function gdAdminCoursePreviewPlayViewportRatios(info){
  const width=Math.max(1,Number(info&&info.width)||1);
  const height=Math.max(1,Number(info&&info.height)||1);
  const targetAspect=9/16;
  let frameH=Math.min(height*.82,Math.max(height*.62,width*.92/targetAspect));
  let frameW=frameH*targetAspect;
  if(frameW>width*.84){
    frameW=width*.84;
    frameH=frameW/targetAspect;
  }
  const frameX=(width-frameW)/2;
  const frameY=(height-frameH)/2;
  return {
    left:frameX/width,
    top:frameY/height,
    width:frameW/width*.78,
    height:frameH/height*.80,
    centerX:(frameX+frameW/2)/width,
    centerY:(frameY+frameH*.52)/height
  };
}
function gdAdminCoursePreviewFrameFromObjects(info,bounds){
  if(!info||!bounds)return null;
  const ratios=gdAdminCoursePreviewPlayViewportRatios(info);
  const sourceWidth=info.width,sourceHeight=info.height;
  const phoneAspect=9/16;
  const objectWidth=Math.max(1,bounds.maxX-bounds.minX);
  const objectHeight=Math.max(1,bounds.maxY-bounds.minY);
  const routeDiag=Math.sqrt(objectWidth*objectWidth+objectHeight*objectHeight);
  const padX=Math.max(sourceWidth*.025,objectWidth*.16,routeDiag*.075);
  const padY=Math.max(sourceHeight*.015,objectHeight*.08,routeDiag*.045);
  const minX=Math.max(0,bounds.minX-padX);
  const maxX=Math.min(sourceWidth,bounds.maxX+padX);
  const minY=Math.max(0,bounds.minY-padY);
  const maxY=Math.min(sourceHeight,bounds.maxY+padY);
  const fitWidth=Math.max(1,maxX-minX);
  const fitHeight=Math.max(1,maxY-minY);
  const targetWidth=Math.max(.08,Number(ratios.width)||1-Number(ratios.left||0)-Number(ratios.right||0));
  const targetHeight=Math.max(.08,Number(ratios.height)||1-Number(ratios.top||0)-Number(ratios.bottom||0));
  let cropWidth=Math.max(fitWidth/targetWidth,fitHeight*phoneAspect/targetHeight)*1.04;
  let cropHeight=cropWidth/phoneAspect;
  if(cropHeight>sourceHeight){
    cropHeight=sourceHeight;
    cropWidth=cropHeight*phoneAspect;
  }
  if(cropWidth>sourceWidth){
    cropWidth=sourceWidth;
    cropHeight=cropWidth/phoneAspect;
  }
  const targetCenterX=Number(ratios.centerX)||((Number(ratios.left)||0)+targetWidth/2);
  const targetCenterY=Number(ratios.centerY)||((Number(ratios.top)||0)+targetHeight/2);
  const focusX=(minX+maxX)/2;
  const focusY=(minY+maxY)/2;
  return gdAdminCoursePreviewClampFrame({
    x:focusX-targetCenterX*cropWidth,
    y:focusY-targetCenterY*cropHeight,
    width:cropWidth,
    height:cropHeight
  },sourceWidth,sourceHeight,"gps-play-viewport-frame");
}
function gdAdminCoursePreviewFrameBox(src){
  const info=gdAdminCoursePreviewSvgInfo(src);
  if(!info)return null;
  const viewport=info.root.querySelector('rect[data-role="gps-play-frame"]');
  if(viewport){
    const box=gdAdminCoursePreviewClampFrame({
      x:Number(viewport.getAttribute("x"))||0,
      y:Number(viewport.getAttribute("y"))||0,
      width:Number(viewport.getAttribute("width"))||0,
      height:Number(viewport.getAttribute("height"))||0
    },info.width,info.height,"stored-gps-play-frame");
    if(box)return box;
  }
  return gdAdminCoursePreviewFrameFromObjects(info,gdAdminCoursePreviewObjectBounds(info));
}
function gdAdminCoursePreviewPhoneFrameMarkup(markup,frameBox){
  if(!markup||!frameBox)return markup||"";
  const left=-(frameBox.x/frameBox.width)*100;
  const top=-(frameBox.y/frameBox.height)*100;
  const width=(frameBox.sourceWidth/frameBox.width)*100;
  const height=(frameBox.sourceHeight/frameBox.height)*100;
  const style=[
    `--gd-phone-frame-left:${gdAdminCourseVisualSvgNum(left)}%`,
    `--gd-phone-frame-top:${gdAdminCourseVisualSvgNum(top)}%`,
    `--gd-phone-frame-width:${gdAdminCourseVisualSvgNum(width)}%`,
    `--gd-phone-frame-height:${gdAdminCourseVisualSvgNum(height)}%`
  ].join(";");
  return `<div class="gdAdminPhoneFrameCrop" data-frame-source="${gdEscapeHTML(frameBox.source||"gps-play-frame")}" style="${style}">${markup}</div>`;
}
function gdAdminCoursePreviewMarkup(selected){
  const engine=window.GDCourseVisualEngine;
  const record=gdAdminCourseVisualRecord(selected.id)||engine?.getRecord?.(selected.id)||null;
  const cloudState=gdAdminCourseBuildState(selected.id);
  gdAdminCourseVisualScheduleHydration(selected.id,record);
  /* The preview IS the visual engine's home screen: opening it schedules the
     same auto-build the old Visuals tab ran, so a fresh course starts baking
     without a detour through the debug internals. */
  const sourceStatus=gdAdminCourseVisualSourceStatus(selected);
  const autoBuildNeeded=gdAdminCourseVisualNeedsAutoBuild(record,sourceStatus);
  gdAdminCourseVisualScheduleAutoBuild(selected.id,record,sourceStatus);
  if(!autoBuildNeeded)gdAdminCourseVisualSchedulePipeline(selected.id,record,sourceStatus);
  const scanId=gdAdminJsArg(selected.id);
  const buildLabel=cloudState&&(cloudState.state==="captures-ready"||cloudState.failedStage==="export")
    ?"Retry visual treatment"
    :cloudState&&cloudState.framesReady
      ?"Rebuild course visual"
      :"Build course visual";
  const scanButton=`<button type="button" class="primary" onclick="return gdAdminCourseVisualBuild(${scanId})">${gdEscapeHTML(buildLabel)}</button>`;
  const captured=gdAdminCoursePreviewCapturedHoles(record,selected.id);
  if(!captured.length){
    return `<div class="gdAdminPhonePreviewShell"><div class="gdAdminPhoneInfo"><strong>${gdEscapeHTML(selected.name)}</strong><span>No captured holes yet. Build course visual runs capture first, then the server automatically applies the Natural treatment and publishes the frames.</span><div class="gdAdminPhoneControls">${scanButton}</div></div></div>`;
  }
  const count=gdAdminCoursePreviewHoleCount(selected,record);
  let current=Math.min(count,Math.max(1,Number(gdAdminCoursePreviewHoleByCourse[selected.id])||1));
  if(captured.indexOf(current)<0)current=captured.find(n=>n>=current)??captured[captured.length-1];
  gdAdminCoursePreviewHoleByCourse[selected.id]=current;
  setTimeout(()=>gdAdminCoursePreviewEnsureHoleBake(selected.id,current),0);
  /* Frame preference: a fresh local styled bake wins (that's the sandbox showing your
     current recipe), then the server-exported cloud frame, then the local base capture.
     Never the course-wide mosaic - that made empty holes look captured. */
  const styledLists=[record&&record.holeFramePreviewVisuals];
  const baseLists=[record&&record.holeFramePublishedVisuals,record&&record.holeFrameVisuals];
  let asset=null,assetKind="";
  for(const list of styledLists){
    const match=(Array.isArray(list)?list:[]).find(item=>Number(item&&item.holeNumber)===current&&item.dataUrl);
    if(match){asset=match;assetKind="local-styled";break;}
  }
  const cloudFrame=asset||gdAdminCourseCloudFramesSuppressed[selected.id]?null:gdAdminCourseCloudFrameFor(selected.id,current);
  if(!asset&&!cloudFrame)for(const list of styledLists.concat(baseLists)){
    const match=(Array.isArray(list)?list:[]).find(item=>Number(item&&item.holeNumber)===current);
    if(match){asset=match;assetKind=match.dataUrl?"local-base":"hydrating";break;}
  }
  const src=asset&&asset.dataUrl||"";
  const inline=gdAdminCourseVisualInlineSvg(src,`Hole ${current} play preview`,{preserveImages:true});
  const id=gdAdminJsArg(selected.id);
  const cloudSrc=cloudFrame?"/api/course-visual-assets?path="+encodeURIComponent(cloudFrame.path):"";
  const imageMarkup=cloudSrc?`<img src="${gdEscapeHTML(cloudSrc)}" alt="Hole ${gdEscapeHTML(current)} cloud frame" loading="eager" decoding="async" style="width:100%;height:100%;object-fit:cover">`:(inline||src?inline||`<img src="${gdEscapeHTML(src)}" alt="Hole ${gdEscapeHTML(current)} play preview" loading="lazy" decoding="async">`:"");
  const frame=imageMarkup?gdAdminCoursePreviewPhoneFrameMarkup(imageMarkup,cloudSrc?null:gdAdminCoursePreviewFrameBox(src)):`<div class="gdAdminPhoneEmpty">Hydrating hole capture…</div>`;
  if(cloudFrame)assetKind="cloud-frame";
  // No CSS recipe is layered on the phone: the surface below is already the baked recipe, so
  // painting it again on top double-applied the look.
  const effects=gdAdminCourseVisualActiveEffects(record);
  const dock=window.GDCourseVisualEngine?gdAdminCourseVisualControls(record,selected.id):"";
  return `<div class="gdAdminPhonePreviewShell gdAdminPhonePreviewTuned"><div class="gdAdminPhoneInfo"><strong>${gdEscapeHTML(selected.name)} · Hole ${gdEscapeHTML(current)}</strong><span>Sandbox: dial a setting and release it — the recipe re-bakes for this hole so you see the real result, terrain and all. Build course visual re-captures the course and the server automatically applies the normal recipe; Publish recipe is the advanced export-only action for the settings you have locked in here.</span><div class="gdAdminPhoneControls"><button type="button" onclick="return gdAdminCoursePreviewStep(${id},-1)">Prev hole</button><button type="button" onclick="return gdAdminCoursePreviewStep(${id},1)">Next hole</button>${scanButton}<button type="button" onclick="return gdAdminCourseVisualResetRecipe(${id})">Reset recipe</button><button type="button" onclick="return gdAdminCourseVisualSaveRecipe(${id})">Save recipe</button><button type="button" class="primary" onclick="return gdAdminCourseVisualPublish(${id})">Publish recipe</button></div><div class="gdAdminCourseStageLine"><span class="${assetKind==="local-styled"||assetKind==="cloud-frame"?"ready":"warn"}">${gdEscapeHTML(assetKind==="local-styled"?"surface ready":assetKind==="cloud-frame"?"cloud frame":assetKind==="local-base"?"original capture":"hydrating")}</span><span>H${gdEscapeHTML(current)} · ${gdEscapeHTML(captured.length)}/${gdEscapeHTML(count)} captured</span><span>${gdEscapeHTML(cloudFrame?String(cloudFrame.path).split("/").slice(-3).join("/"):asset&&asset.path?String(asset.path).split("/").slice(-3).join("/"):"")}</span>${gdAdminCourseCloudJobChip(selected.id)}</div><div class="gdAdminCourseStageLine">${(assetKind==="local-base"?["Original capture - no effects"]:(effects.length?effects:["No effects active"])).map(label=>`<span class="${assetKind==="local-base"?"":"ready"}">${gdEscapeHTML(label)}</span>`).join("")}</div></div><div class="gdAdminPhoneStage"><div class="gdAdminPhone"><div class="gdAdminPhoneScreen"><div class="gdAdminPhoneHud"><span>Clarity Play</span><b>H${gdEscapeHTML(current)}</b></div>${frame}<div class="gdAdminPhoneNav"><button type="button" onclick="return gdAdminCoursePreviewStep(${id},-1)">Prev</button><button type="button" onclick="return gdAdminCoursePreviewStep(${id},1)">Next</button></div></div></div>${dock}</div></div>`;
}
function gdAdminCourseDebugMarkup(selected){
  return `<div class="gdAdminCourseDebugWindow"><div class="gdCoursePlayDebug" id="gdCoursePlayDebugPanel"><div class="gdCoursePlayDebugHead"><div><h3>Live scan feedback</h3><p>Local scan, frame-cache, sync, and runtime events on this browser. This is browser state, not the database.</p></div><div class="gdCoursePlayDebugActions"><button type="button" onclick="return gdAdminCourseDebugRefresh()">Refresh</button><button type="button" onclick="gdClearCoursePlayPipelineDebug();return gdAdminCourseDebugRefresh()">Clear log</button></div></div><div id="gdCoursePlayDebugSummary" class="gdCoursePlayDebugSummary"></div><div id="gdCoursePlayDebugTable"></div><div id="gdCoursePlayDebugTimeline" class="gdCoursePlayDebugTimeline"></div></div><div class="gdCoursePlayDebug gdCourseMappingDebug" id="gdCourseMappingDebugPanel"></div><details class="gdAdminCourseSettings"><summary>Visual engine internals</summary><div class="gdAdminCourseSettingsBody">${gdAdminCourseVisualMarkup(selected)}</div></details></div>`;
}
function gdAdminCourseDebugRefresh(){
  try{gdRenderCoursePlayPipelineDebug();}catch(e){}
  try{window.GDCourseMappingDebug?.renderAdminPanel?.();}catch(e){}
  return false;
}
function gdAdminCourseVisualRecord(courseId){
  try{return window.GDCourseVisualEngine&&window.GDCourseVisualEngine.getRecord(courseId)||null;}catch(e){return null;}
}
const gdAdminCourseVisualHydrationPending={};
const gdAdminCourseVisualHydrationAttempted={};
function gdAdminCourseVisualAssets(record){
  const list=value=>Array.isArray(value)?value:[];
  const assets=[
    record&&record.rawMaster,
    record&&record.basicVisual,
    record&&record.exampleHoleVisual,
    list(record&&record.holeFrameVisuals),
    record&&record.previewVisual,
    record&&record.singleHolePreviewVisual,
    list(record&&record.holeFramePreviewVisuals),
    record&&record.publishedVisual,
    record&&record.singleHolePublishedVisual,
    list(record&&record.holeFramePublishedVisuals)
  ];
  return assets.reduce((out,item)=>{
    if(Array.isArray(item))item.forEach(asset=>{if(asset)out.push(asset);});
    else if(item)out.push(item);
    return out;
  },[]);
}
function gdAdminCourseVisualNeedsHydration(record){
  return gdAdminCourseVisualAssets(record).some(asset=>asset&&asset.path&&!asset.dataUrl);
}
function gdAdminCourseVisualScheduleHydration(courseId,record){
  const engine=window.GDCourseVisualEngine;
  if(!engine||typeof engine.hydrateCourseVisualAssets!=="function"||!gdAdminCourseVisualNeedsHydration(record))return;
  const key=[courseId,record&&record.updatedAt||"",gdAdminCourseVisualAssets(record).map(asset=>`${asset.path}:${asset.dataUrl?1:0}`).join("|")].join("::");
  if(gdAdminCourseVisualHydrationPending[key]||gdAdminCourseVisualHydrationAttempted[key])return;
  gdAdminCourseVisualHydrationPending[key]=true;
  gdAdminCourseVisualHydrationAttempted[key]=true;
  engine.hydrateCourseVisualAssets(courseId).then(result=>{
    delete gdAdminCourseVisualHydrationPending[key];
    if(result&&result.hydratedCount&&gdAdminCourseDatabaseSelected===courseId&&(gdAdminCourseDatabaseTab==="visuals"||gdAdminCourseDatabaseTab==="preview"))gdRenderAdminCourseDatabase();
  }).catch(()=>{delete gdAdminCourseVisualHydrationPending[key];});
}
function gdAdminCourseVisualSourceStatus(selected){
  const rows=gdAdminCourseDbFrameRows(selected&&selected.id||selected&&selected.key||"");
  const details=rows.map(row=>{
    const key=row&&row.manifestKey||row&&row.capturedManifestKey||null;
    let manifest=null;
    try{manifest=key?JSON.parse(localStorage.getItem(String(key))||"null"):null;}catch(e){manifest=null;}
    const pins=manifest&&manifest.anchorPins||manifest&&manifest.pins||{};
    const origin=manifest&&manifest.originPx||{};
    const hasOriginBounds=!!(manifest&&Number.isFinite(Number(origin.x))&&Number.isFinite(Number(origin.y))&&Number(manifest.imageWidth||manifest.width)>0&&Number(manifest.imageHeight||manifest.height)>0&&Number.isFinite(Number(manifest.captureZoom??manifest.zoom??manifest.tiles?.[0]?.z)));
    const hasBounds=!!(manifest&&manifest.bounds)||hasOriginBounds||!!(pins&&((pins.tee&&pins.green)||(Array.isArray(pins.route)&&pins.route.length)||(Array.isArray(pins.greenShape)&&pins.greenShape.length)));
    return {
      holeNumber:row&&row.holeNumber||"",
      manifestKey:key,
      hasManifest:!!manifest,
      tiles:manifest&&Array.isArray(manifest.tiles)?manifest.tiles.length:0,
      width:Number(manifest&&manifest.imageWidth||manifest&&manifest.width||0)||0,
      height:Number(manifest&&manifest.imageHeight||manifest&&manifest.height||0)||0,
      hasBounds:hasBounds
    };
  });
  const manifestCount=details.filter(row=>row.hasManifest).length;
  const renderableCount=details.filter(row=>row.hasManifest&&row.tiles&&row.width&&row.height&&row.hasBounds).length;
  return {frameCount:rows.length,manifestCount,renderableCount,details};
}
const gdAdminCourseVisualAutoBuildPending={};
const gdAdminCourseVisualAutoBuildAttempted={};
function gdAdminCourseVisualAutoBuildSignal(record,sourceStatus){
  const count=Number(sourceStatus&&sourceStatus.frameCount)||Number(sourceStatus&&sourceStatus.renderableCount)||Number(record&&record.input&&record.input.objectCount)||0;
  return count>0;
}
function gdAdminCourseVisualNeedsAutoBuild(record,sourceStatus){
  if(record&&String(record.status||"")==="rendering")return false;
  if(!gdAdminCourseVisualAutoBuildSignal(record,sourceStatus)&&!(record&&record.rawMaster))return false;
  const plan=record&&record.diagnostics&&record.diagnostics.capturePlanSummary||null;
  if(!record||!record.rawMaster||!record.basicVisual)return true;
  if(window.GDCourseVisualEngine&&record.rawMaster&&record.rawMaster.metadata&&String(record.rawMaster.metadata.rendererVersion||"")!==String(window.GDCourseVisualEngine.rendererVersion||""))return true;
  if(!plan||String(plan.stitchModel||"")!=="geo-rectangle-table-over-live-map")return true;
  if(record.rawMaster&&record.rawMaster.metadata&&String(record.rawMaster.metadata.stitchModel||"")!=="geo-rectangle-table-over-live-map")return true;
  if(Number(plan.planned)>0&&Number(plan.captured)<Number(plan.planned))return true;
  return false;
}
function gdAdminCourseVisualAutoBuildKey(courseId,record,sourceStatus){
  /* courseId only - see gdAdminCourseVisualPipelineKey for why updatedAt must stay out. */
  return String(courseId||"");
}
function gdAdminCourseVisualScheduleAutoBuild(courseId,record,sourceStatus){
  const engine=window.GDCourseVisualEngine;
  if(!engine||typeof engine.buildFromCourseDatabase!=="function"||!gdAdminCourseVisualNeedsAutoBuild(record,sourceStatus))return "";
  const key=gdAdminCourseVisualAutoBuildKey(courseId,record,sourceStatus);
  if(gdAdminCourseVisualAutoBuildPending[key]||gdAdminCourseVisualAutoBuildAttempted[key])return key;
  gdAdminCourseVisualAutoBuildPending[key]=true;
  gdAdminCourseVisualAutoBuildAttempted[key]=true;
  setTimeout(async()=>{
    try{
      gdAdminCourseVisualEnsurePipelineCourse(courseId);
      const fresh=gdAdminCourseVisualRecord(courseId)||engine.getRecord(courseId);
      const overrides=fresh&&fresh.courseOverrides||{};
      gdAdminCourseVisualToast("Building course visual stitch");
      await engine.buildFromCourseDatabase(courseId);
    }catch(error){
      console.warn("[GolfDaddy] course visual auto-build failed",error);
    }finally{
      delete gdAdminCourseVisualAutoBuildPending[key];
      if(gdAdminCourseDatabaseSelected===courseId&&(gdAdminCourseDatabaseTab==="visuals"||gdAdminCourseDatabaseTab==="preview"))gdRenderAdminCourseDatabase();
    }
  },0);
  return key;
}
const gdAdminCourseVisualPipelinePending={};
const gdAdminCourseVisualPipelineAttempted={};
function gdAdminCourseVisualStageReady(asset,stage,inputStage){
  if(!asset||!(asset.dataUrl||asset.path))return false;
  const meta=asset.metadata||{};
  if(stage&&String(meta.stage||"")!==stage)return false;
  if(inputStage&&String(meta.inputStage||"")!==inputStage)return false;
  return true;
}
function gdAdminCourseVisualNeedsPipeline(record){
  if(!record||String(record.status||"")==="rendering"||String(record.status||"")==="stitching")return false;
  if(!record.rawMaster||!record.basicVisual)return false;
  const renderer=String(window.GDCourseVisualEngine&&window.GDCourseVisualEngine.rendererVersion||"");
  let activePresetVersion=0;
  try{
    const engine=window.GDCourseVisualEngine;
    const activePreset=engine&&typeof engine.getPreset==="function"?engine.getPreset(record.presetId||"clarity-course-natural-v1"):null;
    activePresetVersion=Number(activePreset&&activePreset.version)||0;
  }catch(e){activePresetVersion=0;}
  if(record.settingsDirty)return true;
  if(activePresetVersion&&Number(record.presetVersion||0)!==activePresetVersion)return true;
  if(activePresetVersion&&record.previewVisual&&Number(record.previewVisual.presetVersion||0)!==activePresetVersion)return true;
  if(!gdAdminCourseVisualStageReady(record.previewVisual,"native-visuals"))return true;
  if(!gdAdminCourseVisualStageReady(record.singleHolePreviewVisual,"native-visuals"))return true;
  /* Per-hole preview frames are deliberately NOT required here: they bake on demand per
     visited hole (and in full on Publish). Requiring all of them made the auto pipeline
     re-run the 18-frame bake that freezes the tab. */
  const holeNative=Array.isArray(record.holeFramePreviewVisuals)?record.holeFramePreviewVisuals:[];
  const nativeRenderer=String(record.previewVisual&&record.previewVisual.metadata&&record.previewVisual.metadata.rendererVersion||"");
  const holeRenderer=String(record.singleHolePreviewVisual&&record.singleHolePreviewVisual.metadata&&record.singleHolePreviewVisual.metadata.rendererVersion||"");
  const frameRenderer=String(holeNative[0]&&holeNative[0].metadata&&holeNative[0].metadata.rendererVersion||"");
  return !!(renderer&&(nativeRenderer&&nativeRenderer!==renderer||holeRenderer&&holeRenderer!==renderer||frameRenderer&&frameRenderer!==renderer));
}
/* One automatic attempt per course per page load. The key deliberately excludes
   record.updatedAt: a failed build bumps updatedAt, which minted a fresh key on the next
   render tick and retried the multi-minute build in an endless loop until the tab died.
   After a failure, recovery is the explicit Scan button. */
function gdAdminCourseVisualPipelineKey(courseId,record){
  return String(courseId||"");
}
function gdAdminCourseVisualSchedulePipeline(courseId,record,sourceStatus){
  const engine=window.GDCourseVisualEngine;
  if(!engine||typeof engine.buildCourseVisualPreview!=="function")return "";
  if(gdAdminCourseVisualNeedsAutoBuild(record,sourceStatus)||!gdAdminCourseVisualNeedsPipeline(record))return "";
  const key=gdAdminCourseVisualPipelineKey(courseId,record);
  if(gdAdminCourseVisualPipelinePending[key]||gdAdminCourseVisualPipelineAttempted[key])return key;
  gdAdminCourseVisualPipelinePending[key]=true;
  gdAdminCourseVisualPipelineAttempted[key]=true;
  setTimeout(async()=>{
    try{
      const fresh=gdAdminCourseVisualRecord(courseId)||engine.getRecord(courseId);
      const presetId=String(fresh&&fresh.presetId||engine.defaultPreset?.().id||"");
      const overrides=fresh&&fresh.courseOverrides||{};
      gdAdminCourseVisualToast("Applying native visuals");
      /* The automatic pipeline bakes only the light products (overview + single hole).
         Hole frames bake on demand as each hole is viewed, and in full on Publish - baking
         all 18 owned-pixel frames here froze the tab for minutes. */
      await engine.buildCourseVisualPreview(courseId,presetId,overrides,{skipHoleFrames:true});
    }catch(error){
      console.warn("[GolfDaddy] course visual pipeline failed",error);
    }finally{
      delete gdAdminCourseVisualPipelinePending[key];
      if(gdAdminCourseDatabaseSelected===courseId&&(gdAdminCourseDatabaseTab==="visuals"||gdAdminCourseDatabaseTab==="preview"))gdRenderAdminCourseDatabase();
    }
  },0);
  return key;
}
function gdAdminCourseVisualSvgText(src){
  src=String(src||"");
  if(!/^data:image\/svg\+xml/i.test(src))return "";
  let svg="";
  try{
    const comma=src.indexOf(",");
    if(comma<0)return "";
    const body=src.slice(comma+1);
    svg=src.includes(";base64,")?atob(body):decodeURIComponent(body);
  }catch(e){return "";}
  if(!/<svg[\s>]/i.test(svg))return "";
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi,"")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi,"")
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi,"");
}
function gdAdminCourseVisualInlineSvg(src,label,opts){
  opts=opts||{};
  let svg=gdAdminCourseVisualSvgText(src);
  if(!svg)return "";
  svg=svg
    .replace(/<script[\s\S]*?<\/script>/gi,"")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi,"")
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi,"");
  try{
    const doc=new DOMParser().parseFromString(svg,"image/svg+xml");
    const root=doc&&doc.documentElement;
    if(root&&String(root.nodeName||"").toLowerCase()==="svg"){
      const images=Array.from(root.querySelectorAll("image"));
      const sourceImageCount=images.length;
      const preserveImages=!!opts.preserveImages;
      const productPreview=preserveImages||/course overview|single hole|3d view beta/i.test(String(label||""));
      if(sourceImageCount>700&&!productPreview){
        images.forEach(img=>{
          const role=img.closest("[data-role]")?.getAttribute("data-role")||"";
          if(role&&role!=="course-backdrop")img.remove();
        });
      }
      let previewImages=Array.from(root.querySelectorAll("image"));
      const maxPreviewImages=260;
      if(!productPreview&&previewImages.length>maxPreviewImages){
        const stride=Math.max(1,Math.ceil(previewImages.length/maxPreviewImages));
        previewImages.forEach((img,index)=>{if(index%stride)img.remove();});
        previewImages=Array.from(root.querySelectorAll("image"));
      }
      if(sourceImageCount!==previewImages.length){
        root.setAttribute("data-admin-preview-source-images",String(sourceImageCount));
        root.setAttribute("data-admin-preview-rendered-images",String(previewImages.length));
      }
      svg=new XMLSerializer().serializeToString(root);
    }
  }catch(e){}
  const aria=gdEscapeHTML(label||"Course visual");
  svg=svg.replace(/<svg\b/i,`<svg class="gdAdminCourseVisualSvg" role="img" aria-label="${aria}"`);
  return `<div class="gdAdminCourseVisualInline">${svg}</div>`;
}
function gdAdminCourseVisualSvgNum(value){
  const n=Number(value);
  return Number.isFinite(n)?Number(n.toFixed(2)).toString():"0";
}
function gdAdminCourseVisualParseTransform(value){
  value=String(value||"");
  const matrix=value.match(/matrix\(\s*([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)\s*\)/i);
  if(matrix)return {x:Number(matrix[5])||0,y:Number(matrix[6])||0,sx:Number(matrix[1])||1,sy:Number(matrix[4])||1};
  const translate=value.match(/translate\(\s*([-+0-9.eE]+)(?:[\s,]+([-+0-9.eE]+))?\s*\)/i);
  const scale=value.match(/scale\(\s*([-+0-9.eE]+)(?:[\s,]+([-+0-9.eE]+))?\s*\)/i);
  return {
    x:translate?Number(translate[1])||0:0,
    y:translate?Number(translate[2])||0:0,
    sx:scale?Number(scale[1])||1:1,
    sy:scale?Number(scale[2]||scale[1])||1:1
  };
}
function gdAdminCourseVisualHoleFromCaptureId(value){
  const match=String(value||"").match(/(?:^|:)h(\d+)(?::|$)/i);
  return match?Number(match[1])||0:0;
}
function gdAdminCourseVisualStitchRoleStyle(role){
  role=String(role||"");
  if(role==="course-backdrop")return {fill:"rgba(76,201,240,.04)",stroke:"#4cc9f0",label:"LIVE",order:0,opacity:.62};
  if(role==="play-corridor")return {fill:"rgba(255,209,102,.045)",stroke:"#ffd166",label:"HD",order:1,opacity:.88};
  if(role==="green-surround")return {fill:"rgba(100,242,138,.10)",stroke:"#64f28a",label:"S-HD",order:2,opacity:.95};
  return null;
}
function gdAdminCourseVisualStitchRectFromGroup(group){
  const role=String(group&&group.getAttribute("data-role")||"");
  const style=gdAdminCourseVisualStitchRoleStyle(role);
  if(!style)return null;
  const attrX=Number(group.getAttribute("data-stitch-x"));
  const attrY=Number(group.getAttribute("data-stitch-y"));
  const attrW=Number(group.getAttribute("data-stitch-width"));
  const attrH=Number(group.getAttribute("data-stitch-height"));
  const t=gdAdminCourseVisualParseTransform(group.getAttribute("transform")||"");
  let x=attrX,y=attrY,width=attrW,height=attrH;
  if(!Number.isFinite(x)||!Number.isFinite(y)||!(Number.isFinite(width)&&width>0)||!(Number.isFinite(height)&&height>0)){
    const border=group.querySelector("rect[vector-effect],rect[stroke]");
    if(!border)return null;
    x=(Number(border.getAttribute("x"))||0)*t.sx+t.x;
    y=(Number(border.getAttribute("y"))||0)*t.sy+t.y;
    width=Math.max(1,(Number(border.getAttribute("width"))||0)*Math.abs(t.sx));
    height=Math.max(1,(Number(border.getAttribute("height"))||0)*Math.abs(t.sy));
  }
  const captureId=String(group.getAttribute("data-capture-id")||"");
  return {
    role,
    style,
    captureId,
    lens:String(group.getAttribute("data-capture-lens")||""),
    holeNumber:gdAdminCourseVisualHoleFromCaptureId(captureId),
    segmentIndex:Number(group.getAttribute("data-segment-index"))||0,
    segmentCount:Number(group.getAttribute("data-segment-count"))||0,
    x,
    y,
    width,
    height
  };
}
function gdAdminCourseVisualStitchLabel(item){
  const hole=item.holeNumber?`H${item.holeNumber}`:"";
  if(item.role==="course-backdrop")return "live map";
  if(item.role==="green-surround")return `${hole} green`.trim();
  if(item.role==="play-corridor"){
    const segment=item.segmentCount>1?`${item.segmentIndex}/${item.segmentCount}`:"";
    return `${hole} fairway ${segment}`.trim();
  }
  return item.style.label;
}
function gdAdminCourseVisualStitchFocusHole(items,record){
  const nonUnderlay=(Array.isArray(items)?items:[]).filter(item=>item&&item.role!=="course-backdrop"&&Number(item.holeNumber)>0);
  if(!nonUnderlay.length)return 0;
  const preferred=Number(record&&record.exampleHoleVisual&&record.exampleHoleVisual.holeNumber)||Number(nonUnderlay[0].holeNumber)||0;
  const holes={};
  nonUnderlay.forEach(item=>{
    const hole=Number(item.holeNumber)||0;
    if(!hole)return;
    holes[hole]=holes[hole]||{hole,green:0,corridor:0,count:0};
    holes[hole].count+=1;
    if(item.role==="green-surround")holes[hole].green+=1;
    if(item.role==="play-corridor")holes[hole].corridor+=1;
  });
  if(holes[preferred])return preferred;
  const complete=Object.values(holes).filter(entry=>entry.green&&entry.corridor).sort((a,b)=>a.hole-b.hole)[0];
  return complete&&complete.hole||Object.values(holes).sort((a,b)=>b.count-a.count||a.hole-b.hole)[0].hole;
}
function gdAdminCourseVisualImageHref(node){
  if(!node)return "";
  try{return node.getAttribute("href")||node.getAttribute("xlink:href")||node.getAttributeNS("http://www.w3.org/1999/xlink","href")||"";}catch(e){return node.getAttribute("href")||node.getAttribute("xlink:href")||"";}
}
function gdAdminCourseVisualRectIntersects(a,b){
  return !!(a&&b&&a.x+a.width>=b.x&&b.x+b.width>=a.x&&a.y+a.height>=b.y&&b.y+b.height>=a.y);
}
function gdAdminCourseVisualLimitEvenly(list,maxCount){
  if(!Array.isArray(list)||list.length<=maxCount)return list||[];
  const stride=Math.max(1,Math.ceil(list.length/Math.max(1,maxCount)));
  return list.filter((item,index)=>index%stride===0).slice(0,maxCount);
}
function gdAdminCourseVisualStitchImageEntries(group,item,viewBounds,groupIndex){
  const transform=String(group&&group.getAttribute("transform")||"");
  const t=gdAdminCourseVisualParseTransform(transform);
  const opacity=item.role==="course-backdrop"?.82:item.role==="green-surround"?.96:.88;
  const clip=item.role==="course-backdrop"?"":` clip-path="url(#gdCourseVisualStitchClip${groupIndex})" mask="url(#gdCourseVisualStitchMask${groupIndex})"`;
  return Array.from(group.querySelectorAll("image")).map(image=>{
    const href=gdAdminCourseVisualImageHref(image);
    if(!href)return null;
    const x=Number(image.getAttribute("x"))||0;
    const y=Number(image.getAttribute("y"))||0;
    const width=Math.max(1,Number(image.getAttribute("width"))||256);
    const height=Math.max(1,Number(image.getAttribute("height"))||256);
    const projected={x:t.x+x*t.sx,y:t.y+y*t.sy,width:Math.abs(width*t.sx),height:Math.abs(height*t.sy)};
    if(!gdAdminCourseVisualRectIntersects(projected,viewBounds))return null;
    const preserve=String(image.getAttribute("preserveAspectRatio")||"none");
    const svg=`<g data-role="${gdEscapeHTML(item.role)}" opacity="${gdAdminCourseVisualSvgNum(opacity)}"${clip} transform="${gdEscapeHTML(transform)}"><image href="${gdEscapeHTML(href)}" x="${gdAdminCourseVisualSvgNum(x)}" y="${gdAdminCourseVisualSvgNum(y)}" width="${gdAdminCourseVisualSvgNum(width)}" height="${gdAdminCourseVisualSvgNum(height)}" preserveAspectRatio="${gdEscapeHTML(preserve)}"/></g>`;
    return {role:item.role,order:item.style.order,groupIndex,svg};
  }).filter(Boolean);
}
function gdAdminCourseVisualStitchView(record,planSummary){
  const src=record&&record.rawMaster&&record.rawMaster.dataUrl||record&&record.basicVisual&&record.basicVisual.dataUrl||"";
  const svgText=gdAdminCourseVisualSvgText(src);
  const empty=`<div class="gdAdminCourseVisualSlot wide"><div class="gdAdminCourseVisualSlotHead"><strong>Stitch table</strong><small>${gdEscapeHTML(planSummary&&planSummary.stitchModel||"working map")}</small></div><div class="gdAdminCourseVisualFrame stitch"><div class="gdAdminCourseVisualEmpty">Awaiting stitch</div></div></div>`;
  if(!svgText)return empty;
  let root=null;
  try{
    const doc=new DOMParser().parseFromString(svgText,"image/svg+xml");
    root=doc&&doc.documentElement;
  }catch(e){root=null;}
  if(!root||String(root.nodeName||"").toLowerCase()!=="svg")return empty;
  const viewParts=String(root.getAttribute("viewBox")||"").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const attrWidth=parseFloat(root.getAttribute("width")||"");
  const attrHeight=parseFloat(root.getAttribute("height")||"");
  const fullMinX=viewParts.length===4?viewParts[0]:0;
  const fullMinY=viewParts.length===4?viewParts[1]:0;
  const fullWidth=Math.max(1,viewParts.length===4?viewParts[2]:(Number.isFinite(attrWidth)?attrWidth:1200));
  const fullHeight=Math.max(1,viewParts.length===4?viewParts[3]:(Number.isFinite(attrHeight)?attrHeight:800));
  const groupItems=Array.from(root.querySelectorAll("g[data-role]")).map(group=>({group,item:gdAdminCourseVisualStitchRectFromGroup(group)})).filter(entry=>entry.item).sort((a,b)=>a.item.style.order-b.item.style.order||a.item.y-b.item.y||a.item.x-b.item.x);
  const items=groupItems.map(entry=>entry.item);
  if(!items.length)return empty;
  const underlayCount=items.filter(item=>item.role==="course-backdrop").length;
  const corridorCount=items.filter(item=>item.role==="play-corridor").length;
  const greenCount=items.filter(item=>item.role==="green-surround").length;
  const segmentedCount=items.filter(item=>item.role==="play-corridor"&&item.segmentCount>1).length;
  const denseOverview=items.length>24;
  const focusHole=denseOverview?gdAdminCourseVisualStitchFocusHole(items,record):0;
  const focusItems=items.filter(item=>item.role!=="course-backdrop"&&(!focusHole||Number(item.holeNumber)===Number(focusHole)));
  const cropItems=focusItems.length?focusItems:items.filter(item=>item.role!=="course-backdrop");
  let viewMinX=fullMinX,viewMinY=fullMinY,viewWidth=fullWidth,viewHeight=fullHeight;
  if(denseOverview&&cropItems.length){
    const focusMinX=Math.min(...cropItems.map(item=>item.x));
    const focusMinY=Math.min(...cropItems.map(item=>item.y));
    const focusMaxX=Math.max(...cropItems.map(item=>item.x+item.width));
    const focusMaxY=Math.max(...cropItems.map(item=>item.y+item.height));
    const focusWidth=Math.max(1,focusMaxX-focusMinX);
    const focusHeight=Math.max(1,focusMaxY-focusMinY);
    const pad=Math.max(280,Math.min(Math.max(fullWidth,fullHeight)*.10,Math.max(focusWidth,focusHeight)*.18));
    viewMinX=Math.max(fullMinX,focusMinX-pad);
    viewMinY=Math.max(fullMinY,focusMinY-pad);
    const viewMaxX=Math.min(fullMinX+fullWidth,focusMaxX+pad);
    const viewMaxY=Math.min(fullMinY+fullHeight,focusMaxY+pad);
    viewWidth=Math.max(1,viewMaxX-viewMinX);
    viewHeight=Math.max(1,viewMaxY-viewMinY);
  }
  const viewBounds={x:viewMinX,y:viewMinY,width:viewWidth,height:viewHeight};
  const imageEntries=groupItems.flatMap((entry,index)=>gdAdminCourseVisualStitchImageEntries(entry.group,entry.item,viewBounds,index));
  const backdropImages=gdAdminCourseVisualLimitEvenly(imageEntries.filter(entry=>entry.role==="course-backdrop"),denseOverview?520:900);
  const corridorImages=gdAdminCourseVisualLimitEvenly(imageEntries.filter(entry=>entry.role==="play-corridor"),denseOverview?820:1200);
  const greenImages=gdAdminCourseVisualLimitEvenly(imageEntries.filter(entry=>entry.role==="green-surround"),denseOverview?620:900);
  const selectedImages=backdropImages.concat(corridorImages,greenImages).sort((a,b)=>a.order-b.order);
  const selectedMaskIds=new Set(selectedImages.filter(entry=>entry.role!=="course-backdrop").map(entry=>entry.groupIndex));
  const maskDefs=groupItems.map((entry,index)=>{
    if(!selectedMaskIds.has(index))return "";
    const item=entry.item;
    const feather=Math.max(20,Math.min(90,Math.min(item.width,item.height)*.08));
    const maskX=item.x-feather*2;
    const maskY=item.y-feather*2;
    const maskW=item.width+feather*4;
    const maskH=item.height+feather*4;
    const innerX=item.x+feather*.8;
    const innerY=item.y+feather*.8;
    const innerW=Math.max(1,item.width-feather*1.6);
    const innerH=Math.max(1,item.height-feather*1.6);
    const radius=Math.min(36,Math.max(10,feather*.55));
    return `<clipPath id="gdCourseVisualStitchClip${index}"><rect x="${gdAdminCourseVisualSvgNum(item.x)}" y="${gdAdminCourseVisualSvgNum(item.y)}" width="${gdAdminCourseVisualSvgNum(item.width)}" height="${gdAdminCourseVisualSvgNum(item.height)}" rx="${gdAdminCourseVisualSvgNum(radius)}"/></clipPath><mask id="gdCourseVisualStitchMask${index}" maskUnits="userSpaceOnUse" x="${gdAdminCourseVisualSvgNum(maskX)}" y="${gdAdminCourseVisualSvgNum(maskY)}" width="${gdAdminCourseVisualSvgNum(maskW)}" height="${gdAdminCourseVisualSvgNum(maskH)}"><rect x="${gdAdminCourseVisualSvgNum(maskX)}" y="${gdAdminCourseVisualSvgNum(maskY)}" width="${gdAdminCourseVisualSvgNum(maskW)}" height="${gdAdminCourseVisualSvgNum(maskH)}" fill="black"/><rect x="${gdAdminCourseVisualSvgNum(item.x)}" y="${gdAdminCourseVisualSvgNum(item.y)}" width="${gdAdminCourseVisualSvgNum(item.width)}" height="${gdAdminCourseVisualSvgNum(item.height)}" rx="${gdAdminCourseVisualSvgNum(radius)}" fill="white" filter="url(#gdCourseVisualStitchFeather)"/><rect x="${gdAdminCourseVisualSvgNum(innerX)}" y="${gdAdminCourseVisualSvgNum(innerY)}" width="${gdAdminCourseVisualSvgNum(innerW)}" height="${gdAdminCourseVisualSvgNum(innerH)}" rx="${gdAdminCourseVisualSvgNum(radius*.65)}" fill="white"/></mask>`;
  }).join("");
  const renderedImages=selectedImages.map(entry=>entry.svg).join("");
  const renderedImageCount=backdropImages.length+corridorImages.length+greenImages.length;
  const stroke=Math.max(2,Math.min(10,viewWidth/360));
  const fontSize=Math.max(12,Math.min(34,viewWidth/86));
  const rects=items.map(item=>{
    const label=gdAdminCourseVisualStitchLabel(item);
    const labelX=item.x+Math.max(8,stroke*2);
    const labelY=item.y+fontSize+Math.max(8,stroke*2);
    const dash=item.role==="course-backdrop"?' stroke-dasharray="18 12"':"";
    const visibleLabel=denseOverview&&item.role!=="course-backdrop"?"":`<text x="${gdAdminCourseVisualSvgNum(labelX)}" y="${gdAdminCourseVisualSvgNum(labelY)}" fill="#fff" stroke="#000" stroke-width="${gdAdminCourseVisualSvgNum(Math.max(3,stroke*.55))}" paint-order="stroke" font-family="system-ui, sans-serif" font-size="${gdAdminCourseVisualSvgNum(fontSize)}" font-weight="950">${gdEscapeHTML(label)}</text>`;
    return `<g opacity="${gdAdminCourseVisualSvgNum(item.style.opacity)}"><title>${gdEscapeHTML(label)}</title><rect x="${gdAdminCourseVisualSvgNum(item.x)}" y="${gdAdminCourseVisualSvgNum(item.y)}" width="${gdAdminCourseVisualSvgNum(item.width)}" height="${gdAdminCourseVisualSvgNum(item.height)}" rx="${gdAdminCourseVisualSvgNum(Math.min(12,stroke*1.6))}" fill="${item.style.fill}" stroke="${item.style.stroke}" stroke-width="${gdAdminCourseVisualSvgNum(stroke)}"${dash} vector-effect="non-scaling-stroke"/>${visibleLabel}</g>`;
  }).join("");
  const coverageFallback=renderedImageCount?"":rects;
  const svg=`<svg viewBox="${gdAdminCourseVisualSvgNum(viewMinX)} ${gdAdminCourseVisualSvgNum(viewMinY)} ${gdAdminCourseVisualSvgNum(viewWidth)} ${gdAdminCourseVisualSvgNum(viewHeight)}" role="img" aria-label="Course visual stitch table"><defs><filter id="gdCourseVisualStitchFeather" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="28"/></filter><pattern id="gdCourseVisualStitchGrid" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M42 0H0V42" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1"/></pattern>${maskDefs}</defs><rect x="${gdAdminCourseVisualSvgNum(viewMinX)}" y="${gdAdminCourseVisualSvgNum(viewMinY)}" width="${gdAdminCourseVisualSvgNum(viewWidth)}" height="${gdAdminCourseVisualSvgNum(viewHeight)}" fill="#0b100e"/>${renderedImages}<rect x="${gdAdminCourseVisualSvgNum(viewMinX)}" y="${gdAdminCourseVisualSvgNum(viewMinY)}" width="${gdAdminCourseVisualSvgNum(viewWidth)}" height="${gdAdminCourseVisualSvgNum(viewHeight)}" fill="url(#gdCourseVisualStitchGrid)" opacity=".08"/>${coverageFallback}</svg>`;
  const meta=[
    `underlay ${underlayCount}`,
    `corridors ${corridorCount}`,
    `green squares ${greenCount}`,
    focusHole?`H${focusHole} focus`:denseOverview?"focused crop":"",
    imageEntries.length?`image tiles ${renderedImageCount}/${imageEntries.length}`:"no image tiles",
    segmentedCount?`split segments ${segmentedCount}`:"",
    planSummary&&planSummary.stitchModel?String(planSummary.stitchModel):"geo table"
  ].filter(Boolean);
  const dims=denseOverview?`${Math.round(viewWidth)}×${Math.round(viewHeight)} ${focusHole?`H${focusHole} `:""}crop / ${Math.round(fullWidth)}×${Math.round(fullHeight)} raw`:`${Math.round(fullWidth)}×${Math.round(fullHeight)}`;
  return `<div class="gdAdminCourseVisualSlot wide"><div class="gdAdminCourseVisualSlotHead"><strong>${focusHole?`Stitch table · H${focusHole}`:"Stitch table"}</strong><small>${gdEscapeHTML(dims)}</small></div><div class="gdAdminCourseVisualFrame stitch"><div class="gdAdminCourseVisualStitch">${svg}</div></div><div class="gdAdminCourseVisualMeta">${meta.map(item=>`<span>${gdEscapeHTML(item)}</span>`).join("")}</div></div>`;
}
function gdAdminCourseVisualImage(label,visual,fallback){
  const src=visual&&visual.dataUrl||fallback&&fallback.dataUrl||"";
  const width=Number(visual&&visual.width||fallback&&fallback.width||visual&&visual.metadata&&visual.metadata.outputDimensions&&visual.metadata.outputDimensions.width||fallback&&fallback.metadata&&fallback.metadata.outputDimensions&&fallback.metadata.outputDimensions.width||0)||0;
  const height=Number(visual&&visual.height||fallback&&fallback.height||visual&&visual.metadata&&visual.metadata.outputDimensions&&visual.metadata.outputDimensions.height||fallback&&fallback.metadata&&fallback.metadata.outputDimensions&&fallback.metadata.outputDimensions.height||0)||0;
  const aspect=width&&height?width/height:0;
  const scrollClass=aspect&&(aspect<.35||aspect>3.25)?" scroll":"";
  const dims=width&&height?`${Math.round(width)}×${Math.round(height)}`:"";
  const meta=[
    visual&&visual.holeNumber?`H${visual.holeNumber}`:"",
    visual&&visual.captureId?String(visual.captureId):"",
    visual&&visual.path?String(visual.path).split("/").slice(-2).join("/"):""
  ].filter(Boolean);
  const empty=visual&&visual.path||fallback&&fallback.path?"Saved path only":"Unavailable";
  const inline=gdAdminCourseVisualInlineSvg(src,label);
  return `<div class="gdAdminCourseVisualSlot"><div class="gdAdminCourseVisualSlotHead"><strong>${gdEscapeHTML(label)}</strong>${dims?`<small>${gdEscapeHTML(dims)}</small>`:""}</div><div class="gdAdminCourseVisualFrame${scrollClass}">${(inline||src)?(inline||`<img src="${gdEscapeHTML(src)}" alt="${gdEscapeHTML(label)}" loading="lazy" decoding="async">`):`<div class="gdAdminCourseVisualEmpty">${gdEscapeHTML(empty)}</div>`}</div>${meta.length?`<div class="gdAdminCourseVisualMeta">${meta.map(item=>`<span>${gdEscapeHTML(item)}</span>`).join("")}</div>`:""}</div>`;
}
function gdAdminCourseVisualProductBase(record){
  if(record&&record.basicVisual){
    return Object.assign({},record.basicVisual,{width:record.rawMaster&&record.rawMaster.width,height:record.rawMaster&&record.rawMaster.height,bounds:record.rawMaster&&record.rawMaster.bounds,metadata:Object.assign({},record.basicVisual.metadata||{},{stage:"base-capture",role:"basic"})});
  }
  return record&&record.rawMaster||null;
}
function gdAdminCourseVisualSuppressPublishedFallback(record){
  if(!record||!(record.diagnostics&&record.diagnostics.recaptureRequestedAt))return false;
  const hasWorking=!!(record.rawMaster||record.basicVisual||record.exampleHoleVisual||record.previewVisual||record.singleHolePreviewVisual);
  if(hasWorking)return false;
  return ["stitching","rendering","failed","unavailable"].includes(String(record.status||""))||record.settingsDirty===true;
}
function gdAdminCourseVisualProducts(record){
  const overviewNative=gdAdminCourseVisualStageReady(record&&record.previewVisual,"native-visuals")?record.previewVisual:null;
  const holeNative=gdAdminCourseVisualStageReady(record&&record.singleHolePreviewVisual,"native-visuals")?record.singleHolePreviewVisual:null;
  const suppressPublishedFallback=gdAdminCourseVisualSuppressPublishedFallback(record);
  const products=[
    {key:"course-overview",label:"Course overview",base:gdAdminCourseVisualProductBase(record),native:overviewNative,published:record&&record.publishedVisual||null,suppressPublishedFallback:suppressPublishedFallback},
    {key:"single-hole",label:"Single hole",base:record&&record.exampleHoleVisual||null,native:holeNative,published:record&&record.singleHolePublishedVisual||null,suppressPublishedFallback:suppressPublishedFallback,holeNumber:record&&record.exampleHoleVisual&&record.exampleHoleVisual.holeNumber||null}
  ];
  return products;
}
function gdAdminCourseVisualClampedNumber(value,min,max,fallback){
  const n=Number(value);
  if(!Number.isFinite(n))return fallback;
  return Math.min(max,Math.max(min,n));
}
function gdAdminCourseVisualMergedSettings(presetId,overrides){
  const engine=window.GDCourseVisualEngine;
  let preset=null;
  try{preset=engine&&typeof engine.getPreset==="function"?engine.getPreset(presetId):null;}catch(e){preset=null;}
  let settings=preset||{};
  try{settings=engine&&typeof engine.mergePreset==="function"?engine.mergePreset(settings,overrides||{}):Object.assign({},settings,overrides||{});}catch(e){settings=Object.assign({},settings,overrides||{});}
  return settings||{};
}
// The visuals tab shows the real baked products - never layer a recipe on top of them.
function gdAdminCourseVisualProductFilterAttrs(record){
  return `class="gdAdminCourseVisualProducts"`;
}
// While a control is still moving: touch NOTHING heavy. Saving to the engine per input tick
// meant two full JSON clones of a record carrying every baked frame's pixels - hundreds of MB
// of string copying per tick once captures became owned rasters, which froze the sliders.
// The recipe is read from the form and saved ONCE on release (Committed below).
/* Live relief preview.

   Points an <img> at /api/relief-preview with the current knobs. Every parameter is in the
   URL, so the browser caches each combination and dragging a slider back is instant, and a
   URL can be pasted to someone else and show the same picture.

   Debounced because a range input fires per pixel of travel and each request shades a hole
   server-side. 180ms is under the threshold where dragging stops feeling attached to the
   picture, and it collapses a drag into one or two renders instead of forty. */
let gdAdminReliefTimer=null;
let gdAdminReliefSeq=0;
function gdAdminCourseVisualReliefSrc(courseId){
  const val=(id,fb)=>{const el=document.getElementById(id);const n=el?Number(el.value):NaN;return Number.isFinite(n)?n:fb;};
  const hole=Math.max(1,Number(gdAdminCoursePreviewHoleByCourse[courseId])||1);
  const shadeOnly=!!(document.getElementById("gdReliefShadeOnly")||{}).checked;
  const q=new URLSearchParams({
    courseId:String(courseId), hole:String(hole), size:"768",
    strength:String(val("gdCourseVisualTerrainStrength",.9)),
    exaggeration:String(val("gdReliefExaggeration",5)),
    altitude:String(val("gdReliefAltitude",42)),
    ambient:String(val("gdReliefAmbient",.18))
  });
  /* Left to the server unless overridden. The bake aims the light off each hole's play axis
     so it lands upper-left once Play has rotated the frame; sending a fixed bearing from
     here would preview a hole lit differently from the one that ships. */
  const auto=(document.getElementById("gdReliefAutoAzimuth")||{checked:true}).checked;
  if(!auto)q.set("azimuth",String(val("gdReliefAzimuth",315)));
  if(shadeOnly)q.set("mode","shade");
  return {url:"/api/relief-preview?"+q.toString(),hole:hole};
}
function gdAdminCourseVisualReliefRefresh(courseId){
  const img=document.getElementById("gdReliefPreviewImg");
  const status=document.getElementById("gdReliefPreviewStatus");
  if(!img)return false;
  if(gdAdminReliefTimer)clearTimeout(gdAdminReliefTimer);
  gdAdminReliefTimer=setTimeout(()=>{
    const seq=++gdAdminReliefSeq;
    const req=gdAdminCourseVisualReliefSrc(courseId);
    if(status)status.textContent="Shading hole "+req.hole+"\u2026";
    fetch(req.url).then(async r=>{
      /* Out-of-order responses would otherwise leave the picture showing an older setting
         than the sliders claim. */
      if(seq!==gdAdminReliefSeq)return;
      if(!r.ok){
        let detail="";
        try{const j=await r.json();detail=j.detail||j.error||"";}catch(e){}
        if(status)status.textContent="Hole "+req.hole+": "+(detail||("relief unavailable ("+r.status+")"));
        img.removeAttribute("src");
        return;
      }
      const blob=await r.blob();
      if(seq!==gdAdminReliefSeq)return;
      const old=img.getAttribute("src");
      img.src=URL.createObjectURL(blob);
      if(old&&old.startsWith("blob:"))URL.revokeObjectURL(old);
      if(status)status.textContent="Hole "+req.hole+" \u00b7 "+(r.headers.get("X-Relief-Elevation")||"")+" \u00b7 "+(r.headers.get("X-Relief-Shade")||"");
    }).catch(()=>{
      if(seq!==gdAdminReliefSeq)return;
      if(status)status.textContent="Relief preview failed to load";
    });
  },180);
  return false;
}
function gdAdminCourseVisualControlChanged(courseId){
  return false;
}
/* After a recipe reset the preview must show the RAW captures - without this the cloud
   frames (baked with the old recipe) would immediately cover them back up. Cleared by the
   next slider commit or publish. */
const gdAdminCourseCloudFramesSuppressed={};
/* The reset baseline: every effect explicitly OFF, overriding whatever strengths the preset
   carries. Reset = raw capture; the recipe is then built up one layer at a time. */
const GD_VISUAL_OFF_OVERRIDES={
  turf:{greenStrength:0,greenTone:0},
  lighting:{brightnessTarget:52,contrastTarget:1},
  readability:{sharpness:0,fairwaySeparation:0},
  mowingVisibility:0,
  visualTools:{holeTerrainStrength:0,courseTerrainStrength:0,fairwayAirbrush:false},
  floodlight:{enabled:false}
};
function gdAdminCourseVisualResetRecipe(courseId){
  const engine=window.GDCourseVisualEngine;
  if(!engine||typeof engine.resetCourseVisualRecipe!=="function"){gdAdminCourseVisualToast("Reset unavailable");return false;}
  try{
    engine.resetCourseVisualRecipe(courseId,null,GD_VISUAL_OFF_OVERRIDES);
    gdAdminCourseCloudFramesSuppressed[String(courseId||"")]=true;
    const select=document.getElementById("gdCourseVisualPreset");
    if(select&&engine.defaultPreset)select.value=String(engine.defaultPreset().id||"");
    gdAdminCourseVisualToast("Recipe reset — all effects off, showing original capture");
    gdRenderAdminCourseDatabase();
  }catch(error){
    gdAdminCourseVisualToast(error&&error.message?error.message:"Recipe reset failed");
  }
  return false;
}
/* Named recipe library (local, per browser). Save the current stack under a name, apply a
   saved stack to any course. Longer term the export worker takes one of these by name so
   automation can run "from natural" (off baseline) or from a chosen recipe. */
const GD_VISUAL_RECIPES_KEY="gd_course_visual_recipes_v1";
function gdVisualRecipesLoad(){
  try{const parsed=JSON.parse(localStorage.getItem(GD_VISUAL_RECIPES_KEY)||"null");return parsed&&Array.isArray(parsed.recipes)?parsed:{version:1,recipes:[]};}catch(e){return {version:1,recipes:[]};}
}
function gdVisualRecipesSave(store){
  try{localStorage.setItem(GD_VISUAL_RECIPES_KEY,JSON.stringify({version:1,recipes:(store.recipes||[]).slice(0,48)}));}catch(e){}
}
function gdAdminCourseVisualSaveRecipe(courseId){
  const name=String(window.prompt&&window.prompt("Recipe name","")||"").trim().slice(0,60);
  if(!name)return false;
  const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
  const overrides=gdAdminCourseVisualOverridesFromForm();
  const store=gdVisualRecipesLoad();
  store.recipes=store.recipes.filter(recipe=>recipe&&recipe.name!==name);
  store.recipes.unshift({id:"recipe-"+Date.now().toString(36),name:name,presetId:presetId,overrides:overrides,createdAt:new Date().toISOString()});
  gdVisualRecipesSave(store);
  gdAdminCourseVisualToast('Recipe "'+name+'" saved');
  gdRenderAdminCourseDatabase();
  return false;
}
function gdAdminCourseVisualApplyRecipe(courseId){
  const select=document.getElementById("gdCourseVisualRecipeSelect");
  const id=String(select&&select.value||"");
  if(!id)return false;
  const recipe=gdVisualRecipesLoad().recipes.find(item=>item&&item.id===id);
  if(!recipe){gdAdminCourseVisualToast("Recipe not found");return false;}
  const engine=window.GDCourseVisualEngine;
  if(!engine)return false;
  try{
    engine.saveCourseVisualSettings(courseId,recipe.overrides||{},{presetId:recipe.presetId||""});
    gdAdminCourseVisualToast('Recipe "'+recipe.name+'" applied');
    gdRenderAdminCourseDatabase();
    const hole=Number(gdAdminCoursePreviewHoleByCourse[courseId])||0;
    if(hole&&typeof engine.buildCourseVisualPreview==="function"){
      engine.buildCourseVisualPreview(courseId,recipe.presetId||"",recipe.overrides||{},{holeNumber:hole})
        .then(()=>{if(gdAdminCourseDatabaseSelected===courseId&&gdAdminCourseDatabaseTab==="preview")gdRenderAdminCourseDatabase();})
        .catch(()=>{});
    }
  }catch(error){
    gdAdminCourseVisualToast(error&&error.message?error.message:"Recipe apply failed");
  }
  return false;
}
/* Latest cloud job per course, throttled to one fetch per 20s (the panel re-renders often).
   Feeds the status chip on the preview so queued/running/failed publishes are visible instead
   of silently dying, and refreshes the cloud frames cache when an export completes. */
const gdAdminCourseCloudJobCache={};
function gdAdminCourseCloudLatestJob(courseId){
  courseId=String(courseId||"");
  if(!courseId)return null;
  const entry=gdAdminCourseCloudJobCache[courseId];
  const nowMs=Date.now();
  if(entry&&nowMs-entry.fetchedAt<20000)return entry.job;
  gdAdminCourseCloudJobCache[courseId]={fetchedAt:nowMs,job:entry&&entry.job||null};
  fetch("/api/course-visual-jobs?courseId="+encodeURIComponent(courseId),{headers:{Accept:"application/json"}})
    .then(res=>res.ok?res.json():null)
    .then(data=>{
      const job=data&&Array.isArray(data.jobs)&&data.jobs.length?data.jobs[0]:null;
      const previous=gdAdminCourseCloudJobCache[courseId]&&gdAdminCourseCloudJobCache[courseId].job;
      gdAdminCourseCloudJobCache[courseId]={fetchedAt:Date.now(),job:job};
      const changed=!!job&&(!previous||previous.id!==job.id||previous.status!==job.status);
      if(job&&job.kind==="export"&&job.status==="done"&&changed){
        delete gdAdminCourseCloudFramesCache[courseId];
        delete gdAdminCourseCloudFramesSuppressed[courseId];
      }
      if(changed&&gdAdminCourseDatabaseSelected===courseId&&gdAdminCourseDatabaseTab==="preview")gdRenderAdminCourseDatabase();
    })
    .catch(()=>{});
  return entry&&entry.job||null;
}
/* Build state for the progress bar, polled from /api/course-visual-jobs. Separate from the
   job-list cache above because it refreshes far more often while a build is live: a bar that
   updates once every 20 seconds is a bar you cannot tell is stuck. */
const gdAdminCourseBuildStateCache={};
let gdAdminCourseBuildTimer=null;
function gdAdminCourseBuildState(courseId){
  courseId=String(courseId||"");
  if(!courseId)return null;
  const entry=gdAdminCourseBuildStateCache[courseId];
  const nowMs=Date.now();
  /* Poll hard while something is moving, back off to a heartbeat when it is not - an idle
     course database should not be talking to the server every five seconds. */
  const live=entry&&entry.state&&(entry.state.building||entry.state.state==="queued");
  const maxAge=live?5000:30000;
  if(entry&&nowMs-entry.fetchedAt<maxAge)return entry.state||null;
  gdAdminCourseBuildStateCache[courseId]={fetchedAt:nowMs,state:entry&&entry.state||null};
  fetch("/api/course-visual-jobs?courseId="+encodeURIComponent(courseId),{headers:{Accept:"application/json"},cache:"no-store"})
    .then(res=>res.ok?res.json():null)
    .then(state=>{
      if(!state)return;
      const previous=gdAdminCourseBuildStateCache[courseId]&&gdAdminCourseBuildStateCache[courseId].state;
      gdAdminCourseBuildStateCache[courseId]={fetchedAt:Date.now(),state};
      /* Frames just landed - drop the frame cache so the preview shows the new bake. */
      if(state.framesReady&&(!previous||!previous.framesReady)){
        delete gdAdminCourseCloudFramesCache[courseId];
        delete gdAdminCourseCloudFramesSuppressed[courseId];
      }
      if(gdAdminCourseDatabaseSelected===courseId)gdRenderAdminCourseDatabase();
    })
    .catch(()=>{});
  return entry&&entry.state||null;
}
/* Keeps the bar moving while a build runs. Re-rendering is what re-reads the state, so without
   a tick the bar only advances when the admin happens to click something. */
function gdAdminCourseBuildWatch(courseId,live){
  if(gdAdminCourseBuildTimer){clearTimeout(gdAdminCourseBuildTimer);gdAdminCourseBuildTimer=null;}
  if(!live)return;
  gdAdminCourseBuildTimer=setTimeout(()=>{
    gdAdminCourseBuildTimer=null;
    if(gdAdminCourseDatabaseSelected===courseId)gdRenderAdminCourseDatabase();
  },5000);
}
function gdAdminCourseBuildProgress(state){
  const p=state&&state.progress||null;
  if(!p)return null;
  const done=Number(p.capturesDone!=null?p.capturesDone:p.holesDone);
  const total=Number(p.capturesTotal!=null?p.capturesTotal:p.holesTotal);
  if(!Number.isFinite(done)||!Number.isFinite(total)||total<=0)return null;
  return {done,total,pct:Math.max(0,Math.min(100,Math.round(done/total*100))),stage:String(p.stage||""),rssMb:Number(p.rssMb)||0};
}
function gdAdminCourseBuildCheckpointLines(state){
  const progress=gdAdminCourseBuildProgress(state);
  const captureLine=state&&state.activeKind==="snapshot"
    ? `Checkpoint 1 - Capture imagery & terrain: ${progress?`${progress.done}/${progress.total}`:"running"}`
    : state&&state.failedStage==="capture"
      ? "Checkpoint 1 - Capture imagery & terrain: failed"
      : state&&(state.snapshotReady||state.framesReady||state.activeKind==="export")
        ? "Checkpoint 1 - Capture imagery & terrain: complete"
        : "Checkpoint 1 - Capture imagery & terrain: waiting";
  const exportLine=state&&state.activeKind==="export"
    ? `Checkpoint 2 - Apply visual treatment: ${progress&&progress.stage?progress.stage:(progress?`${progress.done}/${progress.total}`:"running")}`
    : state&&state.failedStage==="export"
      ? `Checkpoint 2 - Apply visual treatment: failed${state.lastError?` (${String(state.lastError).slice(0,80)})`:""}`
      : state&&state.framesReady
        ? "Checkpoint 2 - Apply visual treatment: complete"
        : state&&state.state==="captures-ready"
          ? "Checkpoint 2 - Apply visual treatment: queued"
          : state&&state.snapshotReady
            ? "Checkpoint 2 - Apply visual treatment: waiting"
            : "Checkpoint 2 - Apply visual treatment: waiting for capture";
  return [captureLine,exportLine];
}
/* The build bar. One line that answers: is this course built, is it building, how far, and has
   it stopped moving. Rendered wherever the published/live area is shown. */
function gdAdminCourseCloudJobChip(courseId){
  const state=gdAdminCourseBuildState(courseId);
  if(!state)return "";
  const live=!!state.building||state.state==="queued";
  gdAdminCourseBuildWatch(courseId,live);
  const progress=gdAdminCourseBuildProgress(state);
  const kind=state.activeKind==="export"?"baking frames":state.activeKind==="snapshot"?"scanning":"";
  const stalled=!!state.stalled;
  const nudge=`<button type="button" class="gdAdminBuildNudge" onclick="return gdAdminCourseBuildNudge('${gdEscapeHTML(courseId)}')" title="Hand a dead job back to the queue and wake a worker">Nudge</button>`;

  if(live){
    /* An explicit percentage as well as the bar: "47%" is checkable against the last time you
       looked, which is the whole point of putting this on screen. */
    const pct=progress?progress.pct:0;
    const detail=progress?`${progress.done}/${progress.total}`:"starting";
    const stall=stalled?` · <span class="warn">stalled ${Math.round((state.stalledSeconds||0)/60)}m</span>`:"";
    const checkpoints=gdAdminCourseBuildCheckpointLines(state).map(line=>`<span style="display:block">${gdEscapeHTML(line)}</span>`).join("");
    return `<span class="gdAdminBuildBar${stalled?" gdAdminBuildBarStalled":""}" title="${gdEscapeHTML(progress&&progress.stage||"")}">`
      +`<span class="gdAdminBuildBarFill" style="width:${pct}%"></span>`
      +`<span class="gdAdminBuildBarText">${gdEscapeHTML(kind||"building")} ${gdEscapeHTML(detail)} · ${pct}%${stall}</span>`
      +`</span><span style="display:block;margin-top:4px">${checkpoints}</span>${stalled?nudge:""}`;
  }
  if(state.state==="frames-ready")return `<span class="ready">cloud frames v${gdEscapeHTML(state.framesVersion||1)}</span>`;
  if(state.state==="captures-ready")return `<span class="warn" title="Capture completed. Visual treatment is queued or waiting to be retried.">capture complete - waiting for visual treatment</span>${nudge}`;
  if(state.state==="failed"&&gdAdminVisualUnlicensed(state.lastError))return `<span title="${gdEscapeHTML(gdAdminVisualUnlicensedTitle(state.lastError))}">live map only</span>`;
  if(state.state==="failed"&&state.failedStage==="export")return `<span class="warn" title="${gdEscapeHTML(String(state.lastError||"").slice(0,180))}">visual treatment failed</span>${nudge}`;
  if(state.state==="failed")return `<span class="warn" title="${gdEscapeHTML(String(state.lastError||"").slice(0,180))}">capture failed</span>${nudge}`;
  return `<span>not built</span>`;
}
async function gdAdminCourseBuildNudge(courseId){
  courseId=String(courseId||"");
  if(!courseId)return false;
  try{
    const token=await gdAdminCourseDbAccessToken();
    if(!token){gdAdminCourseVisualToast("Sign in to nudge");return false;}
    const res=await fetch("/api/course-visual-jobs",{
      method:"POST",
      headers:{"Content-Type":"application/json",Accept:"application/json",Authorization:"Bearer "+token},
      body:JSON.stringify({courseId,kind:"nudge"})
    });
    const data=await res.json().catch(()=>null);
    if(data&&data.nudged){
      gdAdminCourseVisualToast(data.requeued?`Requeued ${data.requeued} stuck job`:"Worker woken");
      gdAdminCourseBuildStateCache[courseId]={fetchedAt:0,state:data};
      if(gdAdminCourseDatabaseSelected===courseId)gdRenderAdminCourseDatabase();
    }else{
      gdAdminCourseVisualToast("Nudge failed");
    }
  }catch(e){gdAdminCourseVisualToast("Nudge failed");}
  return false;
}
/* Human-readable feedback of what the current recipe actually has switched on. */
function gdAdminCourseVisualActiveEffects(record){
  const settings=gdAdminCourseVisualMergedSettings(record&&record.presetId,record&&record.courseOverrides)||{};
  const turf=settings.turf||{},lighting=settings.lighting||{},tools=settings.visualTools||{};
  const chips=[];
  const terrain=tools.holeTerrainStrength!=null?Number(tools.holeTerrainStrength):.9;
  /* Relief is baked by the cloud export from LINZ elevation, not by the local sandbox bake,
     so the chip has to say where it will show up. It used to just say "Terrain relief" at any
     strength above zero, which read as "this is on in front of you" while the effect was in
     fact wired to nothing at all. */
  if(terrain>.02)chips.push("Terrain relief (on publish)");
  if(settings.floodlight&&settings.floodlight.enabled===true)chips.push("Floodlight");
  const greenStrength=turf.greenStrength!=null?Number(turf.greenStrength):.35;
  if(greenStrength>.05)chips.push("Turf tone");
  const contrast=lighting.contrastTarget!=null?Number(lighting.contrastTarget):1;
  if(Math.abs(contrast-1)>.03)chips.push("Contrast");
  const brightness=lighting.brightnessTarget!=null?Number(lighting.brightnessTarget):52;
  if(Math.abs(brightness-52)>2)chips.push("Brightness");
  if(Number(settings.mowingVisibility||0)>.02)chips.push("Mow lines");
  return chips;
}
function gdAdminCourseVisualSaveRecipeFromForm(courseId){
  const engine=window.GDCourseVisualEngine;
  if(!engine||typeof engine.saveCourseVisualSettings!=="function")return;
  try{
    const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
    engine.saveCourseVisualSettings(courseId,gdAdminCourseVisualOverridesFromForm(),{presetId});
  }catch(e){}
}
// On release (change): bake the recipe once so every control - terrain included - shows its real
// effect. This only re-renders the recipe from captures already on disk; it never re-captures
// tiles, which was the genuinely heavy part of the old per-keystroke rebuild.
const gdAdminCourseVisualBakePending={};
function gdAdminCourseVisualControlCommitted(courseId){
  gdAdminCourseVisualControlChanged(courseId);
  gdAdminCourseVisualSaveRecipeFromForm(courseId);
  const engine=window.GDCourseVisualEngine;
  if(!engine||typeof engine.buildCourseVisualPreview!=="function")return false;
  if(gdAdminCourseVisualBakePending[courseId])return false;
  gdAdminCourseVisualBakePending[courseId]=true;
  const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
  const overrides=gdAdminCourseVisualOverridesFromForm();
  /* Slider releases on the preview bake only the visible hole - a full-course bake over
     owned-pixel frames freezes the page for minutes. Apply preset / Publish still bake all. */
  const scopedHole=gdAdminCourseDatabaseTab==="preview"?Number(gdAdminCoursePreviewHoleByCourse[courseId])||0:0;
  Promise.resolve()
    .then(()=>engine.buildCourseVisualPreview(courseId,presetId,overrides,scopedHole?{holeNumber:scopedHole}:undefined))
    .then(()=>{
      if(gdAdminCourseDatabaseSelected===courseId&&(gdAdminCourseDatabaseTab==="preview"||gdAdminCourseDatabaseTab==="visuals"))gdRenderAdminCourseDatabase();
    })
    .catch(error=>{
      console.warn("[GolfDaddy] course visual recipe bake failed",error);
      gdAdminCourseVisualToast(error&&error.message?error.message:"Course visual recipe bake failed");
    })
    .finally(()=>{delete gdAdminCourseVisualBakePending[courseId];});
  return false;
}
function gdAdminCourseVisualPresetChanged(courseId){
  const engine=window.GDCourseVisualEngine;
  const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
  gdAdminCourseVisualSyncPresetButtons(presetId);
  let preset=null;
  try{preset=engine&&typeof engine.getPreset==="function"?engine.getPreset(presetId):null;}catch(e){preset=null;}
  if(preset){
    // Every control resets to the incoming preset. Anything missed here carries across presets
    // and reads as a setting that "sticks", so this list must stay in step with the tool tabs.
    const set=(id,value,fallback)=>{
      const el=document.getElementById(id);
      if(el)el.value=Number.isFinite(Number(value))?Number(value):fallback;
    };
    const turf=preset.turf||{},lighting=preset.lighting||{},tools=preset.visualTools||{};
    set("gdCourseVisualHueMin",turf.hueMin,86);
    set("gdCourseVisualHueMax",turf.hueMax,142);
    set("gdCourseVisualSatMin",turf.saturationMin,28);
    set("gdCourseVisualSatMax",turf.saturationMax,66);
    set("gdCourseVisualLumMin",turf.brightnessMin,30);
    set("gdCourseVisualLumMax",turf.brightnessMax,72);
    set("gdCourseVisualTargetPull",turf.targetPull,1);
    set("gdCourseVisualBrightness",lighting.brightnessTarget,52);
    set("gdCourseVisualShadowFloor",lighting.shadowFloor,14);
    set("gdCourseVisualHighlightCeiling",lighting.highlightCeiling,92);
    set("gdCourseVisualContrast",lighting.contrastTarget,1.04);
    set("gdCourseVisualTerrainStrength",tools.holeTerrainStrength,.9);
    const floodP=preset.floodlight||{};
    set("gdCourseVisualFloodAmbient",floodP.ambientLevel,24);
    set("gdCourseVisualFloodLit",floodP.litLevel,64);
    set("gdCourseVisualFloodThrow",floodP.throwOff,.35);
    set("gdCourseVisualFloodSpread",floodP.spread,.45);
    set("gdCourseVisualFloodGreenPool",floodP.greenPool,.8);
    set("gdCourseVisualFloodGreenRadius",floodP.greenPoolRadius,.22);
    const floodOnEl=document.getElementById("gdCourseVisualFloodOn");
    if(floodOnEl)floodOnEl.checked=floodP.enabled===true;
    const floodMaskEl=document.getElementById("gdCourseVisualFloodMask");
    if(floodMaskEl)floodMaskEl.checked=floodP.useObjectMask===true;

    const mowing=document.getElementById("gdCourseVisualMowing");
    if(mowing)mowing.value=String(preset.mowingVisibility||"Unknown");
  }
  return gdAdminCourseVisualControlCommitted(courseId);
}
function gdAdminCourseVisualSyncPresetButtons(presetId){
  document.querySelectorAll(".gdAdminCourseVisualPresetRail button[data-preset-id]").forEach(button=>{
    button.classList.toggle("active",String(button.getAttribute("data-preset-id")||"")===String(presetId||""));
  });
}
function gdAdminCourseVisualPresetButtonChanged(courseId,presetId){
  const select=document.getElementById("gdCourseVisualPreset");
  if(select)select.value=String(presetId||"");
  return gdAdminCourseVisualPresetChanged(courseId);
}
function gdAdminCourseVisualPresetButtonEvent(event){
  const target=event&&event.target;
  const button=target&&target.closest&&target.closest(".gdAdminCourseVisualPresetRail button[data-preset-id]");
  if(!button)return;
  event.preventDefault();
  event.stopPropagation();
  if(typeof event.stopImmediatePropagation==="function")event.stopImmediatePropagation();
  const controls=button.closest(".gdAdminCourseVisualControls");
  const courseId=controls&&controls.getAttribute("data-course-id")||gdAdminCourseDatabaseSelected||"";
  gdAdminCourseVisualPresetButtonChanged(courseId,button.getAttribute("data-preset-id")||"");
}
function gdAdminCourseVisualControlEvent(event){
  const target=event&&event.target;
  if(!target||!target.id)return;
  const controls=target.closest&&target.closest(".gdAdminCourseVisualControls");
  if(!controls)return;
  const courseId=controls.getAttribute("data-course-id")||gdAdminCourseDatabaseSelected||"";
  if(target.id==="gdCourseVisualPreset"){
    gdAdminCourseVisualPresetChanged(courseId);
    return;
  }
  if(["gdCourseVisualHueMin","gdCourseVisualHueMax","gdCourseVisualSatMin","gdCourseVisualSatMax","gdCourseVisualLumMin","gdCourseVisualLumMax","gdCourseVisualTargetPull","gdCourseVisualBrightness","gdCourseVisualShadowFloor","gdCourseVisualHighlightCeiling","gdCourseVisualContrast","gdCourseVisualTerrainStrength","gdCourseVisualFloodOn","gdCourseVisualFloodAmbient","gdCourseVisualFloodLit","gdCourseVisualFloodThrow","gdCourseVisualFloodSpread","gdCourseVisualFloodGreenPool","gdCourseVisualFloodGreenRadius","gdCourseVisualFloodMask","gdCourseVisualMowing"].includes(target.id)){
    // "input" fires while the control is still moving; "change" fires on release - bake then.
    if(String(event.type)==="change")gdAdminCourseVisualControlCommitted(courseId);
    else gdAdminCourseVisualControlChanged(courseId);
  }
}
if(!window.__gdAdminCourseVisualControlsBound){
  window.__gdAdminCourseVisualControlsBound=true;
  document.addEventListener("click",gdAdminCourseVisualPresetButtonEvent,true);
  document.addEventListener("input",gdAdminCourseVisualControlEvent,true);
  document.addEventListener("change",gdAdminCourseVisualControlEvent,true);
}
function gdAdminCourseVisualProductCard(product){
  const visual=product.native||(!product.suppressPublishedFallback?product.published:null)||product.base||null;
  const src=visual&&visual.dataUrl||"";
  const width=Number(visual&&visual.width||visual&&visual.metadata&&visual.metadata.outputDimensions&&visual.metadata.outputDimensions.width||0)||0;
  const height=Number(visual&&visual.height||visual&&visual.metadata&&visual.metadata.outputDimensions&&visual.metadata.outputDimensions.height||0)||0;
  const dims=width&&height?`${Math.round(width)}×${Math.round(height)}`:"";
  const activeStage=product.native?"Native visuals":!product.suppressPublishedFallback&&product.published?"Published":product.base?"Base capture":product.suppressPublishedFallback?"Fresh run needed":"Waiting";
  const aspect=width&&height?width/height:0;
  const scrollClass=aspect&&(aspect<.35||aspect>3.25)?" scroll":"";
  const inline=gdAdminCourseVisualInlineSvg(src,product.label);
  const frame=(inline||src)?(inline||`<img src="${gdEscapeHTML(src)}" alt="${gdEscapeHTML(product.label)}" loading="lazy" decoding="async">`):`<div class="gdAdminCourseVisualEmpty">Awaiting ${gdEscapeHTML(product.label.toLowerCase())}</div>`;
  return `<div class="gdAdminCourseVisualSlot product" data-product="${gdEscapeHTML(product.key||"")}"><div class="gdAdminCourseVisualSlotHead"><strong>${gdEscapeHTML(product.label)}</strong><small>${gdEscapeHTML([activeStage,dims].filter(Boolean).join(" · "))}</small></div><div class="gdAdminCourseVisualFrame${scrollClass}">${frame}</div></div>`;
}
function gdAdminCourseVisualPresetList(){
  const engine=window.GDCourseVisualEngine;
  try{
    if(engine&&typeof engine.courseVisualPresetList==="function"){
      const list=engine.courseVisualPresetList();
      if(Array.isArray(list)&&list.length)return list;
    }
  }catch(e){}
  return ["Natural","Fresh","Rich","Strong"].map(mode=>engine&&typeof engine.presetForMode==="function"?engine.presetForMode(mode):{id:mode,name:mode,mode:mode});
}
let gdAdminCourseVisualActiveTool="turf";
function gdAdminCourseVisualSelectTool(group){
  group=String(group||"");
  gdAdminCourseVisualActiveTool=(gdAdminCourseVisualActiveTool===group)?"":group;
  document.querySelectorAll(".gdAdminPhoneToolDock").forEach(dock=>{
    dock.querySelectorAll(".gdAdminPhoneTool").forEach(btn=>{
      const on=btn.getAttribute("data-tool-group")===gdAdminCourseVisualActiveTool;
      btn.classList.toggle("active",on);
      btn.setAttribute("aria-selected",on?"true":"false");
    });
    dock.querySelectorAll(".gdAdminPhoneToolPanel").forEach(panel=>{
      const on=panel.getAttribute("data-tool-group")===gdAdminCourseVisualActiveTool;
      panel.classList.toggle("active",on);
      panel.hidden=!on;
    });
    dock.classList.toggle("gdAdminPhoneToolDockOpen",!!gdAdminCourseVisualActiveTool);
  });
  /* The relief panel renders with no picture in it - opening the tab is what asks for one.
     Fired after the toggle above, and only when Terrain ended up open, so closing the tab
     or switching to Turf never spends a shade request. */
  if(gdAdminCourseVisualActiveTool==="terrain"&&gdAdminCourseDatabaseSelected){
    setTimeout(()=>gdAdminCourseVisualReliefRefresh(gdAdminCourseDatabaseSelected),0);
  }
  return false;
}
function gdAdminCourseVisualControls(record,courseId){
  const preset=(record&&record.presetId)||"clarity-course-natural-v1";
  const presets=gdAdminCourseVisualPresetList();
  const overrides=record&&record.courseOverrides||{};
  const settings=gdAdminCourseVisualMergedSettings(preset,overrides);
  const mowing=String(settings.mowingVisibility||"Unknown");
  // Targets the normaliser drags the pixels onto - these are the fields the presets were authored
  // with, not relative nudges.
  const hueMin=gdAdminCourseVisualClampedNumber(settings.turf&&settings.turf.hueMin,40,200,86);
  const hueMax=gdAdminCourseVisualClampedNumber(settings.turf&&settings.turf.hueMax,40,200,142);
  const satMin=gdAdminCourseVisualClampedNumber(settings.turf&&settings.turf.saturationMin,0,100,28);
  const satMax=gdAdminCourseVisualClampedNumber(settings.turf&&settings.turf.saturationMax,0,100,66);
  const lumMin=gdAdminCourseVisualClampedNumber(settings.turf&&settings.turf.brightnessMin,0,100,30);
  const lumMax=gdAdminCourseVisualClampedNumber(settings.turf&&settings.turf.brightnessMax,0,100,72);
  const targetPull=gdAdminCourseVisualClampedNumber(settings.turf&&settings.turf.targetPull,0,1,1);
  const flood=settings.floodlight||{};
  const floodOn=flood.enabled===true;
  const floodAmbient=gdAdminCourseVisualClampedNumber(flood.ambientLevel,0,100,24);
  const floodLit=gdAdminCourseVisualClampedNumber(flood.litLevel,0,100,64);
  const floodThrow=gdAdminCourseVisualClampedNumber(flood.throwOff,0,1,.35);
  const floodSpread=gdAdminCourseVisualClampedNumber(flood.spread,.05,1,.45);
  const floodGreenPool=gdAdminCourseVisualClampedNumber(flood.greenPool,0,1,.8);
  const floodGreenRadius=gdAdminCourseVisualClampedNumber(flood.greenPoolRadius,.05,1,.22);
  const floodMask=flood.useObjectMask===true;
  const shadowFloor=gdAdminCourseVisualClampedNumber(settings.lighting&&settings.lighting.shadowFloor,0,60,14);
  const highlightCeiling=gdAdminCourseVisualClampedNumber(settings.lighting&&settings.lighting.highlightCeiling,40,100,92);
  const terrain=gdAdminCourseVisualClampedNumber(settings.visualTools&&settings.visualTools.holeTerrainStrength,0,1.6,.9);
  const brightness=gdAdminCourseVisualClampedNumber(settings.lighting&&settings.lighting.brightnessTarget,0,100,52);
  const contrast=gdAdminCourseVisualClampedNumber(settings.lighting&&settings.lighting.contrastTarget,.55,2.2,1.04);
  const key=gdEscapeHTML(courseId||record&&record.courseId||"");
  const presetField=`<label>Preset<select id="gdCourseVisualPreset" oninput="return gdAdminCourseVisualPresetChanged('${key}')" onchange="return gdAdminCourseVisualPresetChanged('${key}')">${presets.map(p=>`<option value="${gdEscapeHTML(p&&p.id||p&&p.mode||p&&p.name||"")}" ${preset===(p&&p.id)?"selected":""}>${gdEscapeHTML(p&&p.name||p&&p.mode||p&&p.id||"Preset")}</option>`).join("")}</select></label>`;
  const presetRail=`<div class="gdAdminCourseVisualPresetRail">${presets.map(p=>{const id=p&&p.id||p&&p.mode||p&&p.name||"";return `<button type="button" data-preset-id="${gdEscapeHTML(id)}" class="${preset===id?"active":""}" onclick="return gdAdminCourseVisualPresetButtonChanged('${key}','${gdEscapeHTML(id)}')">${gdEscapeHTML(p&&p.name||p&&p.mode||id||"Preset")}</button>`;}).join("")}</div>`;
  const savedRecipes=gdVisualRecipesLoad().recipes;
  const recipeField=`<label>Saved recipes<select id="gdCourseVisualRecipeSelect">${savedRecipes.length?savedRecipes.map(recipe=>`<option value="${gdEscapeHTML(recipe.id)}">${gdEscapeHTML(recipe.name)}</option>`).join(""):'<option value="">No saved recipes yet</option>'}</select></label><div class="gdAdminCourseVisualActions"><button type="button" onclick="return gdAdminCourseVisualApplyRecipe('${key}')"${savedRecipes.length?"":" disabled"}>Apply recipe</button><button type="button" onclick="return gdAdminCourseVisualSaveRecipe('${key}')">Save current as recipe</button></div>`;
  function rangeField(id,label,hint,value,min,max,step){
    return `<label>${label}${hint?` <small>${hint}</small>`:""}<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" oninput="return gdAdminCourseVisualControlChanged('${key}')" onchange="return gdAdminCourseVisualControlCommitted('${key}')"></label>`;
  }
  const turfFields=
    rangeField("gdCourseVisualHueMin","Turf hue min","green band",hueMin,40,200,1)+
    rangeField("gdCourseVisualHueMax","Turf hue max","",hueMax,40,200,1)+
    rangeField("gdCourseVisualSatMin","Saturation min","",satMin,0,100,1)+
    rangeField("gdCourseVisualSatMax","Saturation max","",satMax,0,100,1)+
    rangeField("gdCourseVisualLumMin","Turf brightness min","",lumMin,0,100,1)+
    rangeField("gdCourseVisualLumMax","Turf brightness max","",lumMax,0,100,1)+
    rangeField("gdCourseVisualTargetPull","Hold to range","how firmly out-of-range turf is pulled in",targetPull,0,1,.05)+
    `<span class="gdAdminPhoneTiltNote">Turf already inside these ranges is left untouched — only out-of-range pixels are pulled in.</span>`;
  const terrainField=`<label>Hole terrain<input id="gdCourseVisualTerrainStrength" type="range" min="0" max="1.6" step="0.05" value="${Number.isFinite(terrain)?terrain:.9}" oninput="return gdAdminCourseVisualReliefRefresh('${key}')" onchange="return gdAdminCourseVisualControlCommitted('${key}')"></label>`;
  /* Relief is computed from elevation by /api/relief-preview, live, for one hole. The knobs
     below it are NOT saved: they exist to find the numbers, and the numbers that win get
     written into RELIEF_DEFAULTS in functions/lib/gd-relief-core.mjs and baked. Only "Hole
     terrain" is part of the recipe, because only it is applied at bake time. */
  const reliefKnob=(id,label,hint,value,min,max,step)=>
    `<label>${label}<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" oninput="return gdAdminCourseVisualReliefRefresh('${key}')">`+
    (hint?`<small>${hint}</small>`:"")+`</label>`;
  const terrainBody=terrainField+
    `<div class="gdAdminReliefPanel" style="margin-top:10px">`+
      `<div style="position:relative;background:#10130f;border-radius:8px;overflow:hidden;aspect-ratio:1/1">`+
        `<img id="gdReliefPreviewImg" alt="Relief preview" style="width:100%;height:100%;object-fit:cover;display:block">`+
        `<div id="gdReliefPreviewStatus" style="position:absolute;left:0;right:0;bottom:0;padding:4px 8px;font:11px/1.5 system-ui;background:rgba(0,0,0,.62);color:#cfe3cf"></div>`+
      `</div>`+
      reliefKnob("gdReliefExaggeration","Exaggeration","how far the ground is stretched before it is lit",5,1,12,.5)+
      `<label class="gdAdminCourseVisualCheck"><input id="gdReliefAutoAzimuth" type="checkbox" checked onchange="return gdAdminCourseVisualReliefRefresh('${key}')"><span>Light follows the play axis</span></label>`+
    reliefKnob("gdReliefAzimuth","Light direction","world bearing, only used when the box above is off",315,0,360,5)+
      reliefKnob("gdReliefAltitude","Light height","a lower sun digs deeper shadows",42,10,80,1)+
      reliefKnob("gdReliefAmbient","Hollow shading","fills dents so they read as dents, not grey patches",.18,0,1,.02)+
      `<label class="gdAdminCourseVisualCheck"><input id="gdReliefShadeOnly" type="checkbox" onchange="return gdAdminCourseVisualReliefRefresh('${key}')"><span>Show shading only</span></label>`+
      `<span class="gdAdminPhoneTiltNote">Live from LINZ elevation for the hole selected in the preview \u2014 no bake needed. Only <b>Hole terrain</b> is saved with the recipe; the rest are for finding the numbers to bake in.</span>`+
    `</div>`;
  const floodlightFields=
    `<label class="gdAdminCourseVisualCheck"><input id="gdCourseVisualFloodOn" type="checkbox" ${floodOn?"checked":""} onchange="return gdAdminCourseVisualControlCommitted('${key}')"><span>Floodlight</span></label>`+
    rangeField("gdCourseVisualFloodAmbient","Ambient level","everything off the line drops to here",floodAmbient,0,100,1)+
    rangeField("gdCourseVisualFloodLit","Lit level","the playing line is brought back to here",floodLit,0,100,1)+
    rangeField("gdCourseVisualFloodThrow","Edge falloff","how softly the light dies at the corridor edge",floodThrow,0,1,.05)+
    rangeField("gdCourseVisualFloodSpread","Beam spread","width of the lit corridor",floodSpread,.05,1,.05)+
    rangeField("gdCourseVisualFloodGreenPool","Green pool","own light at the green so falloff can't lose it",floodGreenPool,0,1,.05)+
    rangeField("gdCourseVisualFloodGreenRadius","Green pool size","",floodGreenRadius,.05,1,.01)+
    `<label class="gdAdminCourseVisualCheck"><input id="gdCourseVisualFloodMask" type="checkbox" ${floodMask?"checked":""} onchange="return gdAdminCourseVisualControlCommitted('${key}')"><span>Use object mask</span></label>`+
    `<span class="gdAdminPhoneTiltNote">Aimed down the play axis, so it works on every hole. Levels are absolute because the image is normalised first. Object mask refines the beam to mapped fairway/green geometry \u2014 off for now.</span>`;
  const lightingFields=
    rangeField("gdCourseVisualBrightness","Brightness target","image mean is driven here",brightness,0,100,1)+
    rangeField("gdCourseVisualShadowFloor","Shadow floor","darkest point",shadowFloor,0,60,1)+
    rangeField("gdCourseVisualHighlightCeiling","Highlight ceiling","brightest point",highlightCeiling,40,100,1)+
    rangeField("gdCourseVisualContrast","Contrast","",contrast,.55,2.2,.01)+
    `<span class="gdAdminPhoneTiltNote">Exposure is normalised: whatever the capture's real range is, it's mapped between floor and ceiling and its mean driven to the target.</span>`;
  const mowingField=`<label>Mowing visibility<select id="gdCourseVisualMowing" onchange="return gdAdminCourseVisualControlCommitted('${key}')">${["Unknown","Low","Clear","Prominent"].map(value=>`<option value="${value}" ${mowing===value?"selected":""}>${value}</option>`).join("")}</select></label>`;
  const actionsField=`<div class="gdAdminCourseVisualActions"><button type="button" onclick="return gdAdminCourseRemap('${key}')">Remap from OSM</button><button type="button" onclick="return gdAdminCourseVisualBuildBasic('${key}')">Build base</button><button type="button" onclick="return gdAdminCourseVisualBuildPreview('${key}')">Apply preset</button><button type="button" onclick="return gdAdminCourseVisualRecapture('${key}')">Re-run captures</button><button class="primary" type="button" onclick="return gdAdminCourseVisualPublish('${key}')">Publish Clarity map</button></div>`;
  const groups=[
    {id:"preset",icon:"🎨",label:"Preset",body:presetField+presetRail+recipeField},
    {id:"turf",icon:"🌱",label:"Turf & green",body:turfFields},
    {id:"light",icon:"💡",label:"Lighting",body:lightingFields},
    {id:"flood",icon:"🔦",label:"Floodlight",body:floodlightFields},
    {id:"terrain",icon:"⛰️",label:"Terrain",body:terrainBody},
    {id:"lines",icon:"🌾",label:"Mow lines",body:mowingField},
    {id:"actions",icon:"⚙️",label:"Actions",body:actionsField}
  ];
  const active=gdAdminCourseVisualActiveTool;
  const rail=`<div class="gdAdminPhoneToolRail" role="tablist" aria-label="Visual tuning tools">${groups.map(g=>`<button type="button" role="tab" aria-selected="${g.id===active?"true":"false"}" class="gdAdminPhoneTool${g.id===active?" active":""}" data-tool-group="${g.id}" title="${gdEscapeHTML(g.label)}" aria-label="${gdEscapeHTML(g.label)}" onclick="return gdAdminCourseVisualSelectTool('${g.id}')"><span aria-hidden="true">${g.icon}</span></button>`).join("")}</div>`;
  const flyout=`<div class="gdAdminPhoneToolFlyout">${groups.map(g=>`<div class="gdAdminPhoneToolPanel${g.id===active?" active":""}" data-tool-group="${g.id}"${g.id===active?"":" hidden"}><h4>${gdEscapeHTML(g.label)}</h4>${g.body}</div>`).join("")}</div>`;
  return `<div class="gdAdminCourseVisualControls gdAdminPhoneToolDock${active?" gdAdminPhoneToolDockOpen":""}" data-course-id="${key}">${rail}${flyout}</div>`;
}
function gdAdminCourseVisualOverridesFromForm(){
  const num=(id,min,max,fallback)=>gdAdminCourseVisualClampedNumber(document.getElementById(id)?.value,min,max,fallback);
  const hueMin=num("gdCourseVisualHueMin",40,200,86);
  const hueMax=num("gdCourseVisualHueMax",40,200,142);
  const satMin=num("gdCourseVisualSatMin",0,100,28);
  const satMax=num("gdCourseVisualSatMax",0,100,66);
  const lumMin=num("gdCourseVisualLumMin",0,100,30);
  const lumMax=num("gdCourseVisualLumMax",0,100,72);
  return {
    // Ranges the normaliser holds turf inside; min/max are ordered so a dragged pair can't invert.
    turf:{
      hueMin:Math.min(hueMin,hueMax),hueMax:Math.max(hueMin,hueMax),
      saturationMin:Math.min(satMin,satMax),saturationMax:Math.max(satMin,satMax),
      brightnessMin:Math.min(lumMin,lumMax),brightnessMax:Math.max(lumMin,lumMax),
      targetPull:num("gdCourseVisualTargetPull",0,1,1)
    },
    lighting:{
      brightnessTarget:num("gdCourseVisualBrightness",0,100,52),
      shadowFloor:num("gdCourseVisualShadowFloor",0,60,14),
      highlightCeiling:num("gdCourseVisualHighlightCeiling",40,100,92),
      contrastTarget:num("gdCourseVisualContrast",.55,2.2,1.04)
    },
    floodlight:{
      enabled:document.getElementById("gdCourseVisualFloodOn")?.checked===true,
      ambientLevel:num("gdCourseVisualFloodAmbient",0,100,24),
      litLevel:num("gdCourseVisualFloodLit",0,100,64),
      throwOff:num("gdCourseVisualFloodThrow",0,1,.35),
      spread:num("gdCourseVisualFloodSpread",.05,1,.45),
      greenPool:num("gdCourseVisualFloodGreenPool",0,1,.8),
      greenPoolRadius:num("gdCourseVisualFloodGreenRadius",.05,1,.22),
      useObjectMask:document.getElementById("gdCourseVisualFloodMask")?.checked===true
    },
    visualTools:{holeTerrainStrength:num("gdCourseVisualTerrainStrength",0,1.6,.9)},
    mowingVisibility:String(document.getElementById("gdCourseVisualMowing")?.value||"Unknown")
  };
}
function gdAdminCourseVisualToast(text){
  try{toast(text);}catch(e){console.log(text);}
}
function gdAdminCourseVisualDelay(ms){
  return new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(ms)||0)));
}
async function gdAdminCourseVisualBuildBasic(courseId){
  const engine=window.GDCourseVisualEngine;
  if(!engine){gdAdminCourseVisualToast("Course Visual Engine not loaded");return false;}
  const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
  const overrides=gdAdminCourseVisualOverridesFromForm();
  engine.saveCourseVisualSettings(courseId,overrides,{presetId});
  gdAdminCourseVisualToast("Building visual captures");
  await engine.buildFromCourseDatabase(courseId);
  gdRenderAdminCourseDatabase();
  return false;
}
async function gdAdminCourseVisualBuildPreview(courseId){
  const engine=window.GDCourseVisualEngine;
  if(!engine){gdAdminCourseVisualToast("Course Visual Engine not loaded");return false;}
  const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
  const overrides=gdAdminCourseVisualOverridesFromForm();
  engine.saveCourseVisualSettings(courseId,overrides,{presetId});
  await engine.buildCourseVisualPreview(courseId,presetId,overrides);
  gdRenderAdminCourseDatabase();
  return false;
}
/* The engine builds from the LOCAL Course Play Pipeline. In a browser that never mapped the
   course (fresh Chrome, new device) that pipeline is empty even though the course is in
   Supabase - so Scan died with "No renderable tile captures found". Hydrate the pipeline from
   the cloud package first; a browser that already has the holes skips this. */
function gdAdminCourseVisualEnsurePipelineCourse(courseId){
  const pipeline=window.GDCoursePlayPipeline;
  if(!pipeline||typeof pipeline.ingestCourseLibraryCourse!=="function")return false;
  try{
    const summaries=gdAdminCourseDbSummaries().find(item=>item.id===String(courseId||""));
    const local=typeof pipeline.loadCoursePlayPipeline==="function"?pipeline.loadCoursePlayPipeline():null;
    const localCourse=local&&local.courses&&local.courses[String(courseId||"")];
    const localHoles=localCourse&&localCourse.holes?Object.keys(localCourse.holes).length:0;
    if(localHoles>0)return false;
    const cloudCourse=summaries&&summaries.course||gdAdminCourseDbPayload(courseId);
    if(!cloudCourse||!cloudCourse.objects)return false;
    pipeline.ingestCourseLibraryCourse(cloudCourse,{source:"admin-visual-scan"});
    return true;
  }catch(e){return false;}
}
/* Phase 1 of the server worker (dev/VISUAL_ENGINE_SERVER_WORKER_PLAN.md): every Scan also
   queues a server-side snapshot job, which bakes owned captures into Supabase Storage.
   Fire-and-forget - the local scan proceeds regardless, and the cloud job is deduped
   server-side if one is already queued or running. */
/* Remap a course from OSM without deleting it.

   The only way to force a fresh map used to be deleting the course_maps row, which is not
   "reset the map" - that row is also the course's entry in the picker's list and the centre
   that both the pin gate and the Overpass query read. Delete it and the course disappears
   from the picker, the pin dialog fires instead of a package request, and nothing is ever
   enqueued. This clears the geometry and leaves the identity and the location alone. */
async function gdAdminCourseRemap(courseId){
  courseId=String(courseId||"");
  if(!courseId)return false;
  if(!window.confirm("Remap "+courseId+" from OpenStreetMap?\n\nClears the mapped tees, greens and holes and queues a fresh run. The course, its name and its location are kept, so it stays in the picker while it remaps."))return false;
  try{
    const token=await gdAdminCourseDbAccessToken();
    if(!token){gdAdminCourseVisualToast("Sign in again to remap");return false;}
    const res=await fetch("/api/course-mapper-jobs",{
      method:"POST",
      headers:{"Content-Type":"application/json",Accept:"application/json",Authorization:"Bearer "+token},
      body:JSON.stringify({courseId:courseId,kind:"remap"})
    });
    const data=await res.json().catch(()=>null);
    if(res.status===404){gdAdminCourseVisualToast((data&&data.detail)||"No map row for this course");return false;}
    if(res.status===403){gdAdminCourseVisualToast("Admin only");return false;}
    if(res.status===429){gdAdminCourseVisualToast("Too many mapping runs started recently");return false;}
    if(!res.ok){gdAdminCourseVisualToast("Remap failed ("+res.status+")");return false;}
    gdAdminCourseVisualToast(data&&data.deduped?"A mapping run is already in progress":"Remapping "+courseId+" - the worker picks it up within ~3 minutes");
    return true;
  }catch(error){
    gdAdminCourseVisualToast("Remap failed to send");
    return false;
  }
}

async function gdAdminCourseVisualEnqueueCloudJob(courseId,kind,recipe){
  try{
    const token=await gdAdminCourseDbAccessToken();
    if(!token)return null;
    const res=await fetch("/api/course-visual-jobs",{
      method:"POST",
      headers:{"Content-Type":"application/json",Accept:"application/json",Authorization:"Bearer "+token},
      body:JSON.stringify({courseId:courseId,kind:kind||"snapshot",recipe:recipe||null})
    });
    const data=await res.json().catch(()=>null);
    if(res.ok&&data&&data.job){
      const label=kind==="export"?"Cloud frame export":"Cloud snapshot";
      gdAdminCourseVisualToast(data.deduped?label+" already in progress":label+" queued");
      /* When the export lands, the frames index changes - drop the cache so the preview
         picks up the new frames on its next render. */
      if(kind==="export")delete gdAdminCourseCloudFramesCache[String(courseId||"")];
    }
    return data;
  }catch(error){return null;}
}
function gdAdminCourseVisualEnqueueCloudSnapshot(courseId){
  return gdAdminCourseVisualEnqueueCloudJob(courseId,"snapshot",null);
}
function gdAdminCourseVisualRetryExport(courseId){
  return gdAdminCourseVisualEnqueueCloudJob(courseId,"export",null);
}
async function gdAdminCourseVisualBuild(courseId){
  const cloudState=gdAdminCourseBuildState(courseId);
  if(cloudState&&(cloudState.state==="captures-ready"||cloudState.failedStage==="export")) {
    const data=await gdAdminCourseVisualRetryExport(courseId);
    gdAdminCourseVisualToast(data&&data.job?"Retrying visual treatment":"Could not queue visual treatment retry");
    gdRenderAdminCourseDatabase();
    return false;
  }
  return gdAdminCourseVisualRecapture(courseId);
}
async function gdAdminCourseVisualRecapture(courseId){
  const engine=window.GDCourseVisualEngine;
  if(!engine){gdAdminCourseVisualToast("Course Visual Engine not loaded");return false;}
  try{
    gdAdminCourseVisualEnsurePipelineCourse(courseId);
    gdAdminCourseVisualEnqueueCloudSnapshot(courseId);
    const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
    const overrides=gdAdminCourseVisualOverridesFromForm();
    if(typeof engine.deleteCloudCourseVisual==="function")await engine.deleteCloudCourseVisual(courseId,{silent:true});
    if(typeof engine.resetCourseVisualWorkingState==="function")engine.resetCourseVisualWorkingState(courseId,{keepPublished:false});
    engine.saveCourseVisualSettings(courseId,overrides,{presetId});
    gdAdminCourseVisualToast("Recapturing course visuals");
    const buildOpts={forceFresh:true,requireFreshCaptures:true};
    let record=null;
    let lastMessage="";
    for(let attempt=1;attempt<=2;attempt+=1){
      await engine.buildFromCourseDatabase(courseId,buildOpts);
      record=gdAdminCourseVisualRecord(courseId)||engine.getRecord(courseId);
      if(record&&record.rawMaster&&record.basicVisual)break;
      lastMessage=record&&record.lastError&&record.lastError.message||record&&record.diagnostics&&record.diagnostics.stitchFailure&&record.diagnostics.stitchFailure.message||"Fresh capture did not produce a stitch.";
      if(attempt<2&&/renderable tile captures|fresh capture|stitch/i.test(String(lastMessage||""))){
        gdAdminCourseVisualToast("Warming capture view, retrying");
        await gdAdminCourseVisualDelay(900);
      }
    }
    if(!record||!record.rawMaster||!record.basicVisual){
      throw new Error(lastMessage||"Fresh capture did not produce a stitch.");
    }
    await engine.buildCourseVisualPreview(courseId,presetId,overrides);
    record=gdAdminCourseVisualRecord(courseId)||engine.getRecord(courseId);
    if(!record.previewVisual||!record.singleHolePreviewVisual){
      const message=record&&record.lastError&&record.lastError.message||"Fresh capture did not produce course and single-hole previews.";
      throw new Error(message);
    }
    gdAdminCourseVisualToast("Fresh course visual preview ready");
  }catch(error){
    console.warn("[GolfDaddy] course visual recapture failed",error);
    gdAdminCourseVisualToast(error&&error.message?error.message:"Course visual recapture failed");
  }finally{
    gdRenderAdminCourseDatabase();
  }
  return false;
}
function gdAdminCourseVisualPublish(courseId){
  const engine=window.GDCourseVisualEngine;
  if(!engine){gdAdminCourseVisualToast("Course Visual Engine not loaded");return false;}
  (async()=>{
    try{
      const presetId=String(document.getElementById("gdCourseVisualPreset")?.value||"");
      const overrides=gdAdminCourseVisualOverridesFromForm();
      engine.saveCourseVisualSettings(courseId,overrides,{presetId});
      /* Publish = lock the recipe and hand it to the WORKER - the only publish path. The
         worker bakes all frames server-side from the cloud captures and writes the
         course_visuals row itself. The old in-browser path (full 18-hole local bake + one
         giant asset POST) died the day captures became owned pixels: the payload is tens of
         MB against a ~6MB function body limit, and the local bake freezes the tab. */
      const data=await gdAdminCourseVisualEnqueueCloudJob(courseId,"export",{presetId:presetId,overrides:overrides});
      if(!data||!data.job)throw new Error("Could not queue the cloud publish — check you are signed in as admin");
      delete gdAdminCourseCloudFramesSuppressed[String(courseId||"")];
      gdAdminCourseVisualToast(data.deduped?"Cloud publish already in progress":"Recipe locked — cloud publish queued");
    }catch(error){
      console.warn("[GolfDaddy] course visual publish failed",error);
      gdAdminCourseVisualToast(error&&error.message?error.message:"Course visual publish failed");
    }finally{
      gdRenderAdminCourseDatabase();
    }
  })();
  return false;
}
function gdAdminCourseVisualResetPublished(courseId){
  window.GDCourseVisualEngine?.resetToPublished?.(courseId);
  gdRenderAdminCourseDatabase();
  return false;
}
function gdAdminCourseVisualResetPreset(courseId){
  window.GDCourseVisualEngine?.resetToGlobalPreset?.(courseId);
  gdRenderAdminCourseDatabase();
  return false;
}
function gdAdminCourseVisualRevert(courseId){
  window.GDCourseVisualEngine?.revertToPublishedVersion?.(courseId);
  gdRenderAdminCourseDatabase();
  return false;
}
function gdAdminCourseVisualMarkup(selected){
  const engine=window.GDCourseVisualEngine;
  if(!engine)return '<div class="gdCoursePlayDebugEmpty">Course Visual Engine is not loaded.</div>';
  const record=gdAdminCourseVisualRecord(selected.id)||engine.getRecord(selected.id);
  gdAdminCourseVisualScheduleHydration(selected.id,record);
  const resolved=engine.resolveCourseVisual(selected.id);
  const sourceStatus=gdAdminCourseVisualSourceStatus(selected);
  const autoBuildNeeded=gdAdminCourseVisualNeedsAutoBuild(record,sourceStatus);
  const autoBuildKey=gdAdminCourseVisualScheduleAutoBuild(selected.id,record,sourceStatus);
  const pipelineKey=autoBuildNeeded?"":gdAdminCourseVisualSchedulePipeline(selected.id,record,sourceStatus);
  const autoBuildStatus=autoBuildKey&&gdAdminCourseVisualAutoBuildPending[autoBuildKey]?"building":autoBuildNeeded?(autoBuildKey&&gdAdminCourseVisualAutoBuildAttempted[autoBuildKey]?"check diagnostics":"queued"):"ready";
  const pipelineNeeded=!autoBuildNeeded&&gdAdminCourseVisualNeedsPipeline(record);
  const pipelineStatus=pipelineKey&&gdAdminCourseVisualPipelinePending[pipelineKey]?"native visuals":pipelineNeeded?(pipelineKey&&gdAdminCourseVisualPipelineAttempted[pipelineKey]?"check diagnostics":"queued"):"ready";
  const planSummary=record&&record.diagnostics&&record.diagnostics.capturePlanSummary||null;
  const products=gdAdminCourseVisualProducts(record);
  const diagnostics={
    status:record&&record.status,
    inputStatus:record&&record.input||null,
    sourceStatus:sourceStatus,
    preset:{id:record&&record.presetId,version:record&&record.presetVersion},
    rendererVersion:engine.rendererVersion,
    resolvedPlayAsset:resolved&&resolved.publishedVisual?resolved.publishedVisual.path:null,
    lastError:record&&record.lastError||null,
    diagnostics:record&&record.diagnostics||{},
    versions:(record&&record.versions||[]).slice(-6)
  };
  /* Lifecycle: geometry (course package in) -> scan -> bake -> published.
     Read from the cloud build state, because that is where a course actually lives - the local
     record only decides the stage for a course the server has never touched. Naming the stages
     after the server jobs (scan, bake) rather than after browser artifacts (build, preview)
     keeps the studio describing the same pipeline the app and the worker do. */
  const cloudState=gdAdminCourseBuildState(selected.id);
  const lifecycleStage=cloudState&&cloudState.framesReady?"published"
    :cloudState&&cloudState.activeKind==="export"?"bake"
    :cloudState&&(cloudState.state==="captures-ready"||cloudState.failedStage==="export")?"bake"
    :cloudState&&cloudState.building?"scan"
    :record&&record.publishedVisual?"published"
    :record&&record.previewVisual?"bake"
    :record&&(record.rawMaster||record.basicVisual)?"scan":"geometry";
  /* Frame count follows the same rule: what the database serves, then what this browser baked. */
  const cloudFrameIndex=gdAdminCourseCloudFrames(selected.id);
  const holeFrames=(cloudState&&cloudState.framesReady&&cloudFrameIndex&&Array.isArray(cloudFrameIndex.holes)?cloudFrameIndex.holes.length:0)
    ||(record&&(Array.isArray(record.holeFramePublishedVisuals)&&record.holeFramePublishedVisuals.length?record.holeFramePublishedVisuals:record.holeFrameVisuals)||[]).length;
  const lifecycle=`<div class="gdAdminCourseStageLine gdAdminCourseVisualLifecycle">${["geometry","scan","bake","published"].map(stage=>`<span class="${stage===lifecycleStage?"ready":""}">${gdEscapeHTML(stage)}</span>`).join("<b>→</b>")}${holeFrames?`<span class="ready">${gdEscapeHTML(holeFrames)}/${gdEscapeHTML(selected.holeCount||0)} hole frames</span>`:""}${cloudState&&cloudState.framesReady?`<span class="ready">cloud v${gdEscapeHTML(cloudState.framesVersion||1)}</span>`:""}</div>`;
  return [
    `<div class="gdAdminCourseWorkspace">${lifecycle}<div class="gdAdminCourseStageLine">${[
      `<span class="${cloudState&&cloudState.framesReady?"ready":record&&["preview-ready","published","basic-ready"].includes(record.status)?"ready":"warn"}">${gdEscapeHTML(cloudState&&cloudState.framesReady?"published":cloudState&&cloudState.building?cloudState.state:record&&record.status||"unavailable")}</span>`,
      `<span class="${autoBuildStatus==="ready"&&pipelineStatus==="ready"?"ready":"warn"}">${gdEscapeHTML(autoBuildStatus==="ready"?pipelineStatus:autoBuildStatus)}</span>`,
      `<span class="${selected.playReadyCount===selected.holeCount&&selected.holeCount?"ready":"warn"}">${gdEscapeHTML(selected.playReadyCount||0)}/${gdEscapeHTML(selected.holeCount||0)} geometry in</span>`
    ].join("")}</div>`,
    `<div ${gdAdminCourseVisualProductFilterAttrs(record)}>${products.map(gdAdminCourseVisualProductCard).join("")}</div>`,
    record.lastError?`<div class="gdAdminCourseVisualNotice">${gdEscapeHTML(record.lastError.message||record.lastError.code||"Course visual pipeline needs attention.")}</div>`:"",
    `<div class="gdAdminCourseVisualNotice gdAdminCourseVisualTuningHint">These blocks are engine internals for debugging. Day-to-day work — scanning, tuning, publishing — lives on the <button type="button" class="gdAdminInlineLink" onclick="return gdAdminCoursePreviewSetHole('${gdEscapeHTML(selected.id)}',${Number(gdAdminCoursePreviewHoleByCourse[selected.id])||1})">Visual Engine</button> preview screen, the only place the visual effect variables appear.</div>`,
    `<details class="gdAdminCourseSettings"><summary>Diagnostics</summary><div class="gdAdminCourseSettingsBody"><div class="gdAdminDatabaseSummary">${[
      gdAdminCourseDbMetric("Current version",record.currentVersion||0),
      gdAdminCourseDbMetric("Published",record.publishedVersion||0),
      gdAdminCourseDbMetric("Layer model",planSummary?"live underlay + HD overlays":"live map fallback")
    ].join("")}</div><pre class="gdAdminCourseVisualDiag">${gdEscapeHTML(JSON.stringify(diagnostics,null,2))}</pre></div></details></div>`
  ].join("");
}
/* The panel re-renders on a 2.2s interval while the developer panel is open.
   Swapping innerHTML unconditionally destroyed every button and slider mid-tap,
   so writes are skipped when the markup hasn't changed - the DOM (and any
   in-flight tap, drag, or scroll) survives idle re-renders. */
function gdAdminCourseDbSetHTML(el,html){
  if(el.__gdLastHTML===html)return;
  el.__gdLastHTML=html;
  el.innerHTML=html;
}
let gdAdminCourseDbExpanded="";
/* Click a row to open it in place. The full tabbed panel is still one click
   further in - this answers "what happened to this course" without leaving the
   list, which is the question the list itself was raising and not answering. */
function gdAdminCourseDbToggleRow(courseId){
  const next=String(courseId||"");
  gdAdminCourseDbExpanded=gdAdminCourseDbExpanded===next?"":next;
  if(gdAdminCourseDbExpanded)gdLoadAdminCourseDbJobs().then(()=>gdRenderAdminCourseDatabase());
  gdRenderAdminCourseDatabase();
  return false;
}
function gdAdminCourseDbDiagRow(label,value){
  return `<div class="gdAdminCourseDiagRow"><span>${gdEscapeHTML(label)}</span><strong>${gdEscapeHTML(value==null||value===""?"—":String(value))}</strong></div>`;
}
function gdAdminCourseDbExpandedRow(item){
  const status=gdAdminCourseDbStatusFor(item);
  const why=gdAdminCourseDbStatusWhy(item);
  const job=gdAdminCourseDbJobState(item.id);
  const course=item.course||{};
  const lat=course.courseLat,lng=course.courseLng;
  const place=[course.region,course.country].filter(Boolean).join(", ");
  const totals=item.objectTotals||{tees:0,greens:0,fairways:0};
  /* A failure gets the reason first and in full. Everything else is the same
     block so a working course and a broken one are read the same way. */
  const banner=why?`<div class="gdAdminCourseDiagWhy ${status==="failed"?"bad":"warn"}">${gdEscapeHTML(why)}</div>`:"";
  const diag=[
    gdAdminCourseDbDiagRow("Status",status),
    gdAdminCourseDbDiagRow("Course key",item.key),
    gdAdminCourseDbDiagRow("Holes built",item.holeCount),
    gdAdminCourseDbDiagRow("Play ready",item.playReadyCount+"/"+(item.holeCount||0)),
    gdAdminCourseDbDiagRow("Geometry objects",(totals.tees||0)+" tees, "+(totals.greens||0)+" greens, "+(totals.fairways||0)+" fairways"),
    gdAdminCourseDbDiagRow("Location",Number.isFinite(Number(lat))&&Number.isFinite(Number(lng))?Number(lat).toFixed(5)+", "+Number(lng).toFixed(5)+(place?"  ("+place+")":""):"not set"),
    gdAdminCourseDbDiagRow("Last mapping run",job?(job.lastJobStatus||job.state)+(job.lastJobKind?" ("+job.lastJobKind+")":""):"none recorded"),
    gdAdminCourseDbDiagRow("Run finished",job&&job.lastJobAt?gdCoursePlayDebugTime(job.lastJobAt):"—"),
    gdAdminCourseDbDiagRow("Mapper version",job&&job.mapperVersion),
    gdAdminCourseDbDiagRow("Updated",gdCoursePlayDebugTime(item.updatedAt)||"unknown")
  ].join("");
  return `<tr class="gdAdminCourseDiagRowHost"><td colspan="7"><div class="gdAdminCourseDiag">${banner}<div class="gdAdminCourseDiagGrid">${diag}</div>${gdAdminCourseDbActionRail(item)}</div></td></tr>`;
}

function gdRenderAdminCourseDatabase(){
  const summary=document.getElementById("gdAdminCourseDbSummary");
  const list=document.getElementById("gdAdminCourseDbList");
  const detail=document.getElementById("gdAdminCourseDbDetail");
  if(!summary||!list||!detail)return;
  if(gdAdminCourseDbCloudState==="idle")gdLoadAdminCourseDbCloud();
  /* Cheap and cached for 20s. Without it a course with no geometry can only be
     described as "empty" - the queue is the only thing that knows it failed. */
  if(!gdAdminCourseDbJobsAt&&!gdAdminCourseDbJobsInflight)gdLoadAdminCourseDbJobs().then(()=>gdRenderAdminCourseDatabase());
  gdAdminCourseDbSetHTML(summary,gdAdminCourseDbCloudStatusMarkup());
  const all=gdAdminCourseDbSummaries();
  const search=String(document.getElementById("gdAdminCourseDbSearch")?.value||"").trim().toLowerCase();
  const filtered=all.filter(item=>{
    const hay=[item.name,item.key,item.status,item.syncStatus,item.source].join(" ").toLowerCase();
    return !search||hay.indexOf(search)>=0;
  });
  if(gdAdminCourseDatabaseSelected&&!filtered.some(item=>item.id===gdAdminCourseDatabaseSelected)){
    gdAdminCourseDatabaseSelected="";
    gdAdminCourseDatabaseTab="overview";
  }
  if(!all.length){
    gdAdminCourseDbSetHTML(list,gdAdminCourseDbCloudState==="loading"?'<div class="gdCoursePlayDebugEmpty">Loading courses from Supabase…</div>':gdAdminCourseDbCloudState==="ready"?'<div class="gdCoursePlayDebugEmpty">No courses published to the database yet.</div>':'<div class="gdCoursePlayDebugEmpty">No course records available. Supabase is unreachable and no local cache exists.</div>');
    gdAdminCourseDbSetHTML(detail,"");
    return;
  }
  gdAdminCourseDbSetHTML(list,filtered.length?`<div class="gdAdminCourseTableWrap"><table class="gdAdminCourseTable"><thead><tr><th>Course</th><th>Status</th><th>Sync</th><th>Holes</th><th>Play</th><th>Visual Engine</th><th>Updated</th></tr></thead><tbody>${filtered.map(item=>{
    const visual=gdAdminCourseDbVisualState(item.id);
    /* The displayed status, not the stored one - see gdAdminCourseDbStatusFor. */
    const status=gdAdminCourseDbStatusFor(item);
    const statusTone=gdAdminCourseDbStatusTone(status,["published","ready","play_data_ready","mapped_geometry_ready"]);
    const syncTone=gdAdminCourseDbStatusTone(item.syncStatus,["synced","cloud","ready"]);
    const active=item.id===gdAdminCourseDatabaseSelected?" active":"";
    const open=item.id===gdAdminCourseDbExpanded;
    const caret=open?"▾":"▸";
    const row=`<tr class="${active}${open?" expanded":""}" onclick="return gdAdminCourseDbToggleRow(${gdAdminJsArg(item.id)})"><td class="gdAdminCourseNameCell" title="${gdEscapeHTML(item.key)}"><span class="gdAdminCourseCaret">${caret}</span> ${gdEscapeHTML(item.name)}</td><td><span class="gdAdminCourseStatusDot ${statusTone}">${gdEscapeHTML(status)}</span></td><td><span class="gdAdminCourseStatusDot ${syncTone}">${gdEscapeHTML(item.syncStatus)}</span></td><td>${gdEscapeHTML(item.holeCount)}</td><td>${gdEscapeHTML(item.playReadyCount)}/${gdEscapeHTML(item.holeCount||0)}</td><td><span class="gdAdminCourseStatusDot ${visual.tone}">${gdEscapeHTML(visual.label)}</span></td><td>${gdEscapeHTML(gdCoursePlayDebugTime(item.updatedAt)||"unknown")}</td></tr>`;
    return open?row+gdAdminCourseDbExpandedRow(item):row;
  }).join("")}</tbody></table></div>`:'<div class="gdCoursePlayDebugEmpty">No course records match the current search.</div>');
  const selected=filtered.find(item=>item.id===gdAdminCourseDatabaseSelected);
  if(!selected){gdAdminCourseDbSetHTML(detail,"");return;}
  const rows=selected.rows||[];
  const payload=gdAdminCourseDbPayload(selected.id);
  const header=`<div class="gdAdminCourseActionHead"><div><h4>${gdEscapeHTML(selected.name)}</h4><span>${gdEscapeHTML(selected.key)} · ${gdEscapeHTML(gdAdminCourseDbStatusFor(selected))} · ${gdEscapeHTML(selected.syncStatus)} · ${gdEscapeHTML(selected.source)}</span></div>${gdAdminCourseDbActionRail(selected)}</div>`;
  if(gdAdminCourseDatabaseTab==="visuals"){
    gdAdminCourseDbSetHTML(detail,`<div class="gdAdminCourseActionPanel">${header}${gdAdminCourseVisualMarkup(selected)}</div>`);
    return;
  }
  if(gdAdminCourseDatabaseTab==="scorecard"){
    gdAdminCourseDbSetHTML(detail,`<div class="gdAdminCourseActionPanel">${header}${gdAdminCourseScorecardMarkup(selected)}</div>`);
    return;
  }
  if(gdAdminCourseDatabaseTab==="preview"){
    gdAdminCourseDbSetHTML(detail,`<div class="gdAdminCourseActionPanel">${header}${gdAdminCoursePreviewMarkup(selected)}</div>`);
    return;
  }
  if(gdAdminCourseDatabaseTab==="debug"){
    gdAdminCourseDbSetHTML(detail,`<div class="gdAdminCourseActionPanel">${header}${gdAdminCourseDebugMarkup(selected)}</div>`);
    gdAdminCourseDebugRefresh();
    return;
  }
  const visual=gdAdminCourseDbVisualState(selected.id);
  const stageLine=`<div class="gdAdminCourseStageLine">${[
    `<span class="${selected.geometryReadyCount===selected.holeCount&&selected.holeCount?"ready":"warn"}">${gdEscapeHTML(selected.geometryReadyCount)}/${gdEscapeHTML(selected.holeCount)} geometry</span>`,
    `<span class="${selected.playReadyCount===selected.holeCount&&selected.holeCount?"ready":"warn"}">${gdEscapeHTML(selected.playReadyCount)}/${gdEscapeHTML(selected.holeCount)} play ready</span>`,
    `<span class="${visual.tone==="bad"?"warn":visual.tone==="ok"?"ready":""}">visual engine: ${gdEscapeHTML(visual.label)}</span>`,
    `<span>${gdEscapeHTML(gdCoursePlayDebugTime(selected.updatedAt)||"unknown")} updated</span>`
  ].join("")}</div>`;
  if(gdAdminCourseDatabaseTab==="geometry"){
    const totals=selected.objectTotals||{tees:0,greens:0,fairways:0};
    const geometryRows=rows.length?`<div class="gdAdminCourseHoleScroll"><table class="gdAdminCourseHoleTable"><thead><tr><th>Hole</th><th>State</th><th>Tee</th><th>Green</th><th>Fairways</th><th>Source</th></tr></thead><tbody>${rows.map(row=>`<tr><td>H${gdEscapeHTML(row.holeNumber)}</td><td>${gdEscapeHTML(row.state)}</td><td>${gdAdminCourseDbFlag(row.hasTee)}</td><td>${gdAdminCourseDbFlag(row.hasGreen)}${row.hasGreen?` <span class="gdAdminCourseHoleNote">${row.hasGreenShape?"polygon":"point"}</span>`:""}</td><td>${gdEscapeHTML(row.fairways)}</td><td>${gdEscapeHTML(row.source)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="gdCoursePlayDebugEmpty">No geometry in the database for this course yet.</div>';
    gdAdminCourseDbSetHTML(detail,`<div class="gdAdminCourseActionPanel">${header}<div class="gdAdminCourseWorkspace"><div class="gdAdminCourseStageLine">${[
      `<span>${gdEscapeHTML(totals.tees)} tees</span>`,
      `<span>${gdEscapeHTML(totals.greens)} greens</span>`,
      `<span>${gdEscapeHTML(totals.fairways)} fairways</span>`,
      `<span class="${selected.playReadyCount===selected.holeCount&&selected.holeCount?"ready":"warn"}">${gdEscapeHTML(selected.playReadyCount)}/${gdEscapeHTML(selected.holeCount)} play ready</span>`
    ].join("")}</div>${geometryRows}</div></div>`);
    return;
  }
  gdAdminCourseDbSetHTML(detail,`<div class="gdAdminCourseActionPanel">${header}<div class="gdAdminCourseWorkspace">${stageLine}${gdAdminCourseLocationMarkup(selected,payload)}<details class="gdAdminCourseSettings"><summary>Database payload</summary><div class="gdAdminCourseSettingsBody"><pre class="gdAdminCourseVisualDiag">${gdEscapeHTML(JSON.stringify(payload,null,2))}</pre></div></details></div></div>`);
}

window.gdRenderAdminCourseDatabase=gdRenderAdminCourseDatabase;
window.gdAdminCourseDbToggleRow=gdAdminCourseDbToggleRow;
window.gdAdminCourseDbOpen=gdAdminCourseDbOpen;
window.gdAdminCourseDbShowGeometry=gdAdminCourseDbShowGeometry;
window.gdAdminCourseDbShowDebug=gdAdminCourseDbShowDebug;
window.gdAdminCourseLocationEdit=gdAdminCourseLocationEdit;
window.gdAdminCourseLocationRemove=gdAdminCourseLocationRemove;
window.gdAdminCourseDebugRefresh=gdAdminCourseDebugRefresh;
window.gdToggleAdminCourseDbPayload=gdToggleAdminCourseDbPayload;

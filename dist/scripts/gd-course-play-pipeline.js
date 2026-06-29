(function(){
  if(window.GDCoursePlayPipeline&&window.GDCoursePlayPipeline.version)return;

  var VERSION=1;
  var SCHEMA_VERSION=2;
  var STORE_KEY="gd_course_play_pipeline_v1";
  var FRAME_INDEX_KEY="gd_course_play_frame_index_v1";
  var SYNC_QUEUE_KEY="gd_course_play_sync_queue_v1";
  var DEBUG_LOG_KEY="gd_course_play_debug_timeline_v1";
  var DEBUG_LOG_LIMIT=50;
  var COURSE_STATES={
    not_prepared:"not_prepared",
    mapping:"mapping",
    mapped_geometry_ready:"mapped_geometry_ready",
    partially_ready:"partially_ready",
    ready:"ready",
    error:"error"
  };
  var HOLE_STATES={
    unknown:"unknown",
    mapping:"mapping",
    mapped_geometry_ready:"mapped_geometry_ready",
    play_data_preparing:"play_data_preparing",
    play_data_ready:"play_data_ready",
    play_data_unavailable:"play_data_unavailable",
    needs_remap:"needs_remap"
  };
  var VALID_COURSE_STATES=Object.keys(COURSE_STATES).reduce(function(out,key){out[COURSE_STATES[key]]=true;return out;},{});
  var VALID_HOLE_STATES=Object.keys(HOLE_STATES).reduce(function(out,key){out[HOLE_STATES[key]]=true;return out;},{});
  var PREPARING_TIMEOUT_MS=7000;
  var preparingSince={};
  var debugLogMemory=[];
  var lastDebugEventSig="";
  var lastDebugEventAt=0;
  var lastSyncStatusByKey={};
  var framePrebuildQueues={};
  var FRAME_PREBUILD_DELAY_MS=90;
  var FRAME_PREBUILD_RETRY_DELAYS_MS=[400,1000,2000];
  var FRAME_PREBUILD_TRANSIENT_REASONS={
    "prebuild-adapter-unavailable":true,
    "map-unavailable":true,
    "map_engine_unavailable":true,
    "tile-layer-unavailable":true,
    "tile_layer_unavailable":true,
    "tile-urls-empty":true,
    "tile_urls_empty":true,
    "projection-rect-missing":true,
    "projection_rect_missing":true,
    "manifest-build-returned-null":true,
    "manifest_build_returned_null":true,
    "manifest-storage-write-failed":true,
    "manifest_storage_write_failed":true,
    "frame-index-missing":true,
    "frame_index_missing":true,
    "frame-index-registration-failed":true,
    "frame_index_registration_failed":true,
    "captured-manifest-missing":true,
    "captured_manifest_missing":true
  };

  function now(){return new Date().toISOString();}
  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function clone(value){return safe(function(){return JSON.parse(JSON.stringify(value));},value);}
  function slug(value){return String(value||"course").replace(/[^a-z0-9:_-]+/gi,"_").slice(0,120)||"course";}
  function stableId(){
    return "cph_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);
  }
  function nextVersion(existing){
    return Math.max(1,Number(existing&&existing.dataVersion||existing&&existing.versionId||0)||0)+1;
  }
  function point(value){
    if(!value)return null;
    var lat=Number(value.lat!==undefined?value.lat:value.latitude);
    var lng=Number(value.lng!==undefined?value.lng:(value.lon!==undefined?value.lon:value.longitude));
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
    return {lat:lat,lng:lng};
  }
  function points(list){
    return (Array.isArray(list)?list:[]).map(point).filter(Boolean);
  }
  function objectPoint(object){
    return point(object&&(object.position||object.center||object.centre||object.pin||object.greenCenter||object.greenCentre||object));
  }
  function courseIdFrom(courseOrId){
    if(typeof courseOrId==="string"||typeof courseOrId==="number")return slug(courseOrId);
    return slug(courseOrId&&(courseOrId.courseId||courseOrId.courseKey||courseOrId.key||courseOrId.id||courseOrId.savedCourseId||courseOrId.canonicalKey||courseOrId.name||courseOrId.courseName)||"course");
  }
  function courseIdCandidates(courseOrId){
    if(typeof courseOrId==="string"||typeof courseOrId==="number")return [slug(courseOrId)];
    var raw=[
      courseOrId&&courseOrId.courseId,
      courseOrId&&courseOrId.courseKey,
      courseOrId&&courseOrId.key,
      courseOrId&&courseOrId.id,
      courseOrId&&courseOrId.savedCourseId,
      courseOrId&&courseOrId.canonicalKey,
      courseOrId&&courseOrId.name,
      courseOrId&&courseOrId.courseName
    ].map(slug).filter(Boolean);
    return raw.filter(function(value,index){return raw.indexOf(value)===index;});
  }
  function courseNameFrom(courseOrId,courseId){
    if(typeof courseOrId==="string"||typeof courseOrId==="number")return String(courseOrId||courseId||"Course");
    return String(courseOrId&&(courseOrId.name||courseOrId.title||courseOrId.courseName||courseOrId.key||courseOrId.id)||courseId||"Course");
  }
  function emptyStore(){
    return {schema:"gd.course_play_pipeline.store",version:VERSION,schemaVersion:SCHEMA_VERSION,updatedAt:null,courses:{},sync:{status:"local",pendingCount:0,lastQueuedAt:null}};
  }
  function loadDebugLog(){
    var raw=safe(function(){return JSON.parse(localStorage.getItem(DEBUG_LOG_KEY)||"[]");},null);
    if(Array.isArray(raw))debugLogMemory=raw.slice(-DEBUG_LOG_LIMIT);
    return debugLogMemory.slice(-DEBUG_LOG_LIMIT);
  }
  function saveDebugLog(rows){
    debugLogMemory=(Array.isArray(rows)?rows:[]).slice(-DEBUG_LOG_LIMIT);
    safe(function(){localStorage.setItem(DEBUG_LOG_KEY,JSON.stringify(debugLogMemory));});
    return debugLogMemory.slice();
  }
  function recordDebugEvent(type,detail){
    var stamp=now();
    var payload=clone(detail||{})||{};
    var sig=String(type||"event")+"|"+String(payload.courseId||payload.courseKey||"")+"|"+String(payload.holeNumber||payload.hole||"")+"|"+String(payload.status||payload.reason||payload.source||"");
    var at=Date.now();
    if(sig===lastDebugEventSig&&at-lastDebugEventAt<250)return null;
    lastDebugEventSig=sig;
    lastDebugEventAt=at;
    var rows=loadDebugLog();
    var entry=Object.assign({at:stamp,type:String(type||"event")},payload);
    rows.push(entry);
    saveDebugLog(rows);
    try{window.dispatchEvent(new CustomEvent("gd-course-play-debug-event",{detail:clone(entry)}));}catch(e){}
    return clone(entry);
  }
  function clearDebugLog(){
    saveDebugLog([]);
    recordDebugEvent("debug-log-cleared",{source:"admin"});
    return loadDebugLog();
  }
  function normalizeStore(raw){
    var store=raw&&typeof raw==="object"?raw:emptyStore();
    store.schema="gd.course_play_pipeline.store";
    store.version=VERSION;
    store.schemaVersion=SCHEMA_VERSION;
    if(!store.courses||typeof store.courses!=="object")store.courses={};
    if(!store.sync||typeof store.sync!=="object")store.sync={status:"local",pendingCount:0,lastQueuedAt:null};
    return store;
  }
  function loadStore(){
    return normalizeStore(safe(function(){return JSON.parse(localStorage.getItem(STORE_KEY)||"null");},null));
  }
  function saveStore(store){
    store=normalizeStore(store);
    store.updatedAt=now();
    safe(function(){localStorage.setItem(STORE_KEY,JSON.stringify(store));});
    return clone(store);
  }
  function emptyFrameIndex(){
    return {schema:"gd.course_play_pipeline.frame_index",version:VERSION,schemaVersion:SCHEMA_VERSION,updatedAt:null,frames:{}};
  }
  function normalizeFrameIndex(raw){
    var index=raw&&typeof raw==="object"?raw:emptyFrameIndex();
    index.schema="gd.course_play_pipeline.frame_index";
    index.version=VERSION;
    index.schemaVersion=SCHEMA_VERSION;
    if(!index.frames||typeof index.frames!=="object")index.frames={};
    return index;
  }
  function loadFrameIndex(){
    return normalizeFrameIndex(safe(function(){return JSON.parse(localStorage.getItem(FRAME_INDEX_KEY)||"null");},null));
  }
  function saveFrameIndex(index){
    index=normalizeFrameIndex(index);
    index.updatedAt=now();
    safe(function(){localStorage.setItem(FRAME_INDEX_KEY,JSON.stringify(index));});
    return clone(index);
  }
  function emptySyncQueue(){
    return {schema:"gd.course_play_pipeline.sync_queue",version:VERSION,schemaVersion:SCHEMA_VERSION,updatedAt:null,items:[]};
  }
  function normalizeSyncQueue(raw){
    var queue=raw&&typeof raw==="object"?raw:emptySyncQueue();
    queue.schema="gd.course_play_pipeline.sync_queue";
    queue.version=VERSION;
    queue.schemaVersion=SCHEMA_VERSION;
    if(!Array.isArray(queue.items))queue.items=[];
    return queue;
  }
  function loadSyncQueue(){
    return normalizeSyncQueue(safe(function(){return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY)||"null");},null));
  }
  function capturedManifestPresent(key){
    if(!key)return false;
    return !!safe(function(){return localStorage.getItem(String(key));},null);
  }
  function readCapturedManifest(key){
    if(!key)return null;
    var manifest=safe(function(){return JSON.parse(localStorage.getItem(String(key))||"null");},null);
    return manifest&&Array.isArray(manifest.tiles)&&manifest.originPx?manifest:null;
  }
  function capturedManifestStorageKey(courseKey,holeNumber){
    return "gd_captured_hole_frame_v19_"+String(String(courseKey||"course")+":h"+String(normalizeHoleNumber(holeNumber))).replace(/[^a-z0-9:_-]+/gi,"_");
  }
  function captureRegistryKey(courseKey,holeNumber){
    return "gd_captured_surface_active_v1_"+slug(courseKey)+":h"+String(normalizeHoleNumber(holeNumber));
  }
  function courseKeyMatch(course,candidate){
    if(candidate===undefined||candidate===null)return false;
    var wanted=courseIdCandidates(course);
    var key=slug(candidate);
    return wanted.indexOf(key)!==-1;
  }
  function manifestMatchesHole(course,holeNumber,manifest){
    if(!manifest)return false;
    if(Number(manifest.holeNumber||0)&&normalizeHoleNumber(manifest.holeNumber)!==normalizeHoleNumber(holeNumber))return false;
    var manifestCourse=manifest.courseKey||manifest.courseId||manifest.courseName||manifest.name||"";
    return !manifestCourse||courseKeyMatch(course,manifestCourse);
  }
  function saveSyncQueue(queue){
    queue=normalizeSyncQueue(queue);
    queue.updatedAt=now();
    safe(function(){localStorage.setItem(SYNC_QUEUE_KEY,JSON.stringify(queue));});
    var store=loadStore();
    store.sync={status:queue.items.length?"pending":"local",pendingCount:queue.items.filter(function(item){return item&&item.status!=="synced";}).length,lastQueuedAt:queue.updatedAt};
    saveStore(store);
    return clone(queue);
  }
  function frameIndexKey(courseOrId,holeNumber){
    return courseIdFrom(courseOrId)+":h"+String(normalizeHoleNumber(holeNumber));
  }
  function courseRecord(courseOrId,store){
    store=store||loadStore();
    var courseId=courseIdFrom(courseOrId);
    var existing=store.courses[courseId]||{};
    var stamp=now();
    var record=Object.assign({
      schema:"gd.course_play_pipeline.course",
      version:VERSION,
      schemaVersion:SCHEMA_VERSION,
      courseId:courseId,
      courseKey:courseId,
      courseName:courseNameFrom(courseOrId,courseId),
      status:COURSE_STATES.not_prepared,
      holes:{},
      source:"local",
      confidence:"unknown",
      createdAt:stamp,
      updatedAt:stamp,
      syncStatus:"local",
      remoteId:null,
      lastError:null,
      recordId:"course:"+courseId,
      dataVersion:1,
      invalidatedAt:null,
      invalidationReason:null,
      dbReady:true
    },existing);
    record.courseId=courseId;
    record.courseKey=record.courseKey||courseId;
    record.courseName=courseNameFrom(courseOrId,record.courseName||courseId);
    record.recordId=record.recordId||("course:"+record.courseId);
    record.dataVersion=Math.max(1,Number(record.dataVersion||1));
    record.syncStatus=record.syncStatus||"local";
    record.status=VALID_COURSE_STATES[record.status]?record.status:COURSE_STATES.not_prepared;
    if(!record.holes||typeof record.holes!=="object")record.holes={};
    return record;
  }
  function normalizeHoleNumber(hole){
    var n=Number(hole);
    return Number.isFinite(n)&&n>0?Math.round(n):1;
  }
  function emptyHoleRecord(course,holeNumber,status){
    var stamp=now();
    return {
      schema:"gd.course_play_pipeline.hole",
      version:VERSION,
      schemaVersion:SCHEMA_VERSION,
      courseId:course.courseId,
      courseKey:course.courseKey||course.courseId,
      courseName:course.courseName,
      holeNumber:holeNumber,
      status:status||HOLE_STATES.unknown,
      teePoint:null,
      greenCentre:null,
      greenShape:[],
      greenBounds:null,
      fairwayPoints:[],
      routePoints:[],
      frameAnchors:{tee:null,green:null,route:[],greenShape:[]},
      presentation:{capturedManifestKey:null,capturedSurfaceReady:false,owner:"gps-play",frameStatus:"not_generated",frameIndexKey:null},
      source:"local",
      confidence:"unknown",
      unavailableReason:null,
      createdAt:stamp,
      updatedAt:stamp,
      syncStatus:"local",
      remoteId:null,
      recordId:"hole:"+course.courseId+":h"+holeNumber,
      dataVersion:1,
      invalidatedAt:null,
      invalidationReason:null,
      dbReady:true,
      schemaNotes:"geometry-durable-frame-cache-separate"
    };
  }
  function normalizeHoleRecord(course,holeNumber,hole){
    var record=Object.assign(emptyHoleRecord(course,holeNumber),hole||{});
    record.schema="gd.course_play_pipeline.hole";
    record.version=VERSION;
    record.schemaVersion=SCHEMA_VERSION;
    record.courseId=course.courseId;
    record.courseKey=course.courseKey||course.courseId;
    record.courseName=course.courseName;
    record.holeNumber=normalizeHoleNumber(record.holeNumber||holeNumber);
    record.status=VALID_HOLE_STATES[record.status]?record.status:HOLE_STATES.unknown;
    record.teePoint=point(record.teePoint);
    record.greenCentre=point(record.greenCentre);
    record.greenShape=points(record.greenShape);
    record.fairwayPoints=points(record.fairwayPoints);
    record.routePoints=points(record.routePoints);
    record.greenBounds=record.greenBounds||deriveBounds(record.greenShape,record.greenCentre);
    record.frameAnchors=Object.assign({tee:null,green:null,route:[],greenShape:[]},record.frameAnchors||{});
    record.frameAnchors.tee=point(record.frameAnchors.tee)||record.teePoint;
    record.frameAnchors.green=point(record.frameAnchors.green)||record.greenCentre;
    record.frameAnchors.route=points(record.frameAnchors.route&&record.frameAnchors.route.length?record.frameAnchors.route:record.routePoints);
    record.frameAnchors.greenShape=points(record.frameAnchors.greenShape&&record.frameAnchors.greenShape.length?record.frameAnchors.greenShape:record.greenShape);
    record.presentation=Object.assign({capturedManifestKey:null,capturedSurfaceReady:false,owner:"gps-play",frameStatus:"not_generated",frameIndexKey:null},record.presentation||{});
    record.source=record.source||"local";
    record.confidence=record.confidence||"unknown";
    record.syncStatus=record.syncStatus||"local";
    record.recordId=record.recordId||("hole:"+course.courseId+":h"+record.holeNumber);
    record.dataVersion=Math.max(1,Number(record.dataVersion||1));
    record.dbReady=record.dbReady!==false;
    record.updatedAt=record.updatedAt||now();
    record.createdAt=record.createdAt||record.updatedAt;
    return record;
  }
  function deriveBounds(shape,centre){
    var pts=points(shape);
    var c=point(centre);
    if(c)pts.push(c);
    if(!pts.length)return null;
    var lats=pts.map(function(p){return p.lat;});
    var lngs=pts.map(function(p){return p.lng;});
    return {
      south:Math.min.apply(null,lats),
      west:Math.min.apply(null,lngs),
      north:Math.max.apply(null,lats),
      east:Math.max.apply(null,lngs)
    };
  }
  function normalizeMappedHoleData(course,holeNumber,mappedData,source){
    mappedData=mappedData||{};
    var route=points(mappedData.route);
    var tee=objectPoint(mappedData.tee)||point(route[0]);
    var green=objectPoint(mappedData.green)||point(route[route.length-1]);
    var greenShape=points(mappedData.green&&(mappedData.green.greenShape||mappedData.green.shape||mappedData.green.polygon||mappedData.green.outline));
    var fairwayPoints=points((mappedData.fairways||[]).map(function(fairway){return fairway&&fairway.position||fairway;}));
    if(!route.length)route=[tee].concat(fairwayPoints,[green]).filter(Boolean);
    var playable=route.length>=2&&green;
    var record=emptyHoleRecord(course,holeNumber,playable?HOLE_STATES.play_data_ready:HOLE_STATES.mapping);
    record.teePoint=tee||null;
    record.greenCentre=green||null;
    record.greenShape=greenShape;
    record.greenBounds=deriveBounds(greenShape,green);
    record.fairwayPoints=fairwayPoints;
    record.routePoints=route;
    record.frameAnchors={tee:tee||null,green:green||null,route:route,greenShape:greenShape};
    record.presentation={capturedManifestKey:null,capturedSurfaceReady:!!playable,owner:"gps-play",frameStatus:playable?"renderable":"not_generated",frameIndexKey:null};
    record.source=source||mappedData.source||"automap";
    record.confidence=playable?"mapped_geometry_ready_for_play":"incomplete";
    record.updatedAt=now();
    return record;
  }
  function summarizeCourseStatus(course){
    var holes=Object.keys(course.holes||{}).map(function(key){return course.holes[key];});
    if(!holes.length)return COURSE_STATES.not_prepared;
    if(holes.some(function(h){return h&&h.status===HOLE_STATES.play_data_ready;})){
      return holes.every(function(h){return h&&h.status===HOLE_STATES.play_data_ready;})?COURSE_STATES.ready:COURSE_STATES.partially_ready;
    }
    if(holes.some(function(h){return h&&h.status===HOLE_STATES.mapped_geometry_ready;})){
      return holes.every(function(h){return h&&h.status===HOLE_STATES.mapped_geometry_ready;})?COURSE_STATES.mapped_geometry_ready:COURSE_STATES.partially_ready;
    }
    if(holes.some(function(h){return h&&h.status===HOLE_STATES.play_data_unavailable||h.status===HOLE_STATES.needs_remap;}))return COURSE_STATES.error;
    return COURSE_STATES.mapping;
  }
  function writeCourse(course,store){
    store=store||loadStore();
    course=Object.assign(courseRecord(course,store),course||{});
    course.recordId=course.recordId||("course:"+course.courseId);
    course.dataVersion=Math.max(1,Number(course.dataVersion||1));
    course.syncStatus=course.syncStatus||"local";
    Object.keys(course.holes||{}).forEach(function(key){
      course.holes[key]=normalizeHoleRecord(course,key,course.holes[key]);
    });
    course.updatedAt=now();
    course.status=summarizeCourseStatus(course);
    store.courses[course.courseId]=course;
    saveStore(store);
    return clone(course);
  }
  function prepareCourseForPlay(courseOrId){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    if(course.status===COURSE_STATES.not_prepared)course.status=COURSE_STATES.mapping;
    store.courses[course.courseId]=course;
    saveStore(store);
    recordDebugEvent("course-opened",{courseId:course.courseId,courseName:course.courseName,status:course.status,source:"prepare-course-for-play"});
    return clone(course);
  }
  function ingestMappedHole(courseOrId,holeNumber,mappedData,source){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    holeNumber=normalizeHoleNumber(holeNumber);
    var existing=course.holes[String(holeNumber)]||{};
    var normalized=normalizeMappedHoleData(course,holeNumber,mappedData,source);
    var record=Object.assign(emptyHoleRecord(course,holeNumber),existing,normalized);
    record.createdAt=existing.createdAt||record.createdAt;
    record.updatedAt=now();
    record.dataVersion=nextVersion(existing);
    record.syncStatus="pending";
    record.dbReady=true;
    course.holes[String(holeNumber)]=record;
    delete preparingSince[String(course.courseId)+":h"+String(holeNumber)];
    var saved=writeCourse(course,store).holes[String(holeNumber)];
    recordDebugEvent("course-library-ingested-hole",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:saved.status,source:source||"automap",hasTee:!!saved.teePoint,hasGreen:!!saved.greenCentre,routePoints:(saved.routePoints||[]).length});
    recordDebugEvent("pipeline-record-saved",{courseId:course.courseId,holeNumber:holeNumber,status:saved.status,source:saved.source,syncStatus:saved.syncStatus,updatedAt:saved.updatedAt});
    return saved;
  }
  function ingestMappedCourse(courseOrId,mappedCourseData,source){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    var holes=Array.isArray(mappedCourseData)?mappedCourseData:(mappedCourseData&&mappedCourseData.holes)||[];
    holes.forEach(function(item,index){
      var holeNumber=normalizeHoleNumber(item&&item.hole||item&&item.holeNumber||index+1);
      var existing=course.holes[String(holeNumber)]||{};
      course.holes[String(holeNumber)]=Object.assign(emptyHoleRecord(course,holeNumber),existing,normalizeMappedHoleData(course,holeNumber,item,source),{dataVersion:nextVersion(existing),syncStatus:"pending",dbReady:true});
    });
    var saved=writeCourse(course,store);
    recordDebugEvent("pipeline-course-ingested",{courseId:saved.courseId,courseName:saved.courseName,status:saved.status,source:source||"automap",holesProcessed:holes.length,holesKnown:Object.keys(saved.holes||{}).length});
    setTimeout(function(){safe(function(){queueFramePrebuild(saved.courseId,{source:source||"automap",reason:"bulk-ingest"});});},0);
    return saved;
  }
  function getCoursePlayState(courseOrId){
    var store=loadStore();
    var candidates=courseIdCandidates(courseOrId);
    var course=store.courses[courseIdFrom(courseOrId)]||null;
    if(!course){
      for(var i=0;i<candidates.length;i++){
        course=store.courses[candidates[i]];
        if(course)break;
      }
    }
    if(!course&&candidates.length){
      var wanted={};
      candidates.forEach(function(key){wanted[key]=true;});
      course=Object.keys(store.courses||{}).map(function(key){return store.courses[key];}).filter(function(record){
        var recordKeys=courseIdCandidates(record);
        return recordKeys.some(function(key){return wanted[key];});
      }).sort(function(a,b){return String(b.updatedAt||"").localeCompare(String(a.updatedAt||""));})[0]||null;
    }
    return course?clone(course):clone(courseRecord(courseOrId,store));
  }
  function getHolePlayState(courseOrId,holeNumber){
    var course=getCoursePlayState(courseOrId);
    var hole=course.holes&&course.holes[String(normalizeHoleNumber(holeNumber))];
    return hole?clone(hole):emptyHoleRecord(course,normalizeHoleNumber(holeNumber));
  }
  function markHolePlayDataReady(courseOrId,holeNumber,data){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    holeNumber=normalizeHoleNumber(holeNumber);
    var existing=course.holes[String(holeNumber)]||emptyHoleRecord(course,holeNumber);
    var record=Object.assign(existing,clone(data||{}),{status:HOLE_STATES.play_data_ready,updatedAt:now(),unavailableReason:null,dataVersion:nextVersion(existing),syncStatus:"pending",dbReady:true});
    course.holes[String(holeNumber)]=record;
    delete preparingSince[String(course.courseId)+":h"+String(holeNumber)];
    var saved=writeCourse(course,store).holes[String(holeNumber)];
    recordDebugEvent("pipeline-record-saved",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:saved.status,source:saved.source,syncStatus:saved.syncStatus,updatedAt:saved.updatedAt});
    return saved;
  }
  function markHolePlayDataUnavailable(courseOrId,holeNumber,reason){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    holeNumber=normalizeHoleNumber(holeNumber);
    var existing=course.holes[String(holeNumber)]||emptyHoleRecord(course,holeNumber);
    existing.status=HOLE_STATES.play_data_unavailable;
    existing.unavailableReason=String(reason||"unavailable");
    existing.updatedAt=now();
    existing.dataVersion=nextVersion(existing);
    existing.syncStatus="pending";
    course.holes[String(holeNumber)]=existing;
    delete preparingSince[String(course.courseId)+":h"+String(holeNumber)];
    var saved=writeCourse(course,store).holes[String(holeNumber)];
    recordDebugEvent("pipeline-record-saved",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:saved.status,source:saved.source,syncStatus:saved.syncStatus,reason:saved.unavailableReason,updatedAt:saved.updatedAt});
    return saved;
  }
  function ensureHolePlayData(courseOrId,holeNumber,opts){
    opts=opts||{};
    var hole=getHolePlayState(courseOrId,holeNumber);
    if(hole.status===HOLE_STATES.play_data_ready||hole.status===HOLE_STATES.mapped_geometry_ready)return Promise.resolve(hole);
    if(opts.mappedData)return Promise.resolve(ingestMappedHole(courseOrId,holeNumber,opts.mappedData,opts.source||"automap"));
    return Promise.resolve(hole);
  }
  function saveCoursePlayPipeline(courseOrId){
    var store=loadStore();
    if(courseOrId){
      var course=store.courses[courseIdFrom(courseOrId)];
      if(course)writeCourse(course,store);
      return course?clone(course):null;
    }
    return saveStore(store);
  }
  function loadCoursePlayPipeline(courseOrId){
    return courseOrId?getCoursePlayState(courseOrId):loadStore();
  }
  function markCoursePlaySyncPending(courseOrId,holeNumber,reason){
    var store=loadStore();
    var course=courseRecord(courseOrId||activeCourseFromApp()||"course",store);
    var stamp=now();
    if(holeNumber){
      var key=String(normalizeHoleNumber(holeNumber));
      var hole=normalizeHoleRecord(course,key,course.holes[key]||emptyHoleRecord(course,normalizeHoleNumber(holeNumber)));
      hole.syncStatus="pending";
      hole.updatedAt=stamp;
      hole.syncReason=String(reason||"manual");
      course.holes[key]=hole;
    }else{
      course.syncStatus="pending";
      course.syncReason=String(reason||"manual");
      course.updatedAt=stamp;
    }
    store.courses[course.courseId]=course;
    saveStore(store);
    return holeNumber?clone(course.holes[String(normalizeHoleNumber(holeNumber))]):clone(course);
  }
  function registerCoursePlayFrame(courseOrId,holeNumber,manifest,opts){
    opts=opts||{};
    var course=getCoursePlayState(courseOrId||activeCourseFromApp()||"course");
    holeNumber=normalizeHoleNumber(holeNumber||activeHoleFromApp());
    var hole=normalizeHoleRecord(course,holeNumber,getHolePlayState(course,holeNumber));
    var index=loadFrameIndex();
    var key=frameIndexKey(course,holeNumber);
    var stamp=now();
    var manifestKey=String(opts.manifestKey||manifest&&manifest.key||manifest&&manifest.storageKey||manifest&&manifest.scanId||key);
    var record={
      schema:"gd.course_play_pipeline.frame",
      schemaVersion:SCHEMA_VERSION,
      frameIndexKey:key,
      courseId:course.courseId,
      courseKey:course.courseKey,
      courseName:course.courseName,
      holeNumber:holeNumber,
      pipelineRecordId:hole.recordId,
      pipelineDataVersion:hole.dataVersion,
      manifestKey:manifestKey,
      capturedManifestKey:manifestKey,
      generatedFrom:opts.generatedFrom||"v19-captured-surface",
      frameStatus:opts.status||"generated",
      cacheStatus:opts.cacheStatus||"local-cache",
      presentationOwner:"v19-captured-surface",
      originPx:manifest&&manifest.originPx||null,
      imageWidth:manifest&&manifest.imageWidth||null,
      imageHeight:manifest&&manifest.imageHeight||null,
      captureZoom:manifest&&manifest.captureZoom||null,
      tileCount:Array.isArray(manifest&&manifest.tiles)?manifest.tiles.length:0,
      anchorPins:clone(manifest&&manifest.anchorPins||{}),
      tileMetadata:Array.isArray(manifest&&manifest.tiles)?manifest.tiles.map(function(tile){return {x:tile.x,y:tile.y,z:tile.z,tileX:tile.tileX,tileY:tile.tileY,url:tile.url};}):[],
      createdAt:index.frames[key]&&index.frames[key].createdAt||stamp,
      updatedAt:stamp,
      dbShareable:false,
      notes:"Local render cache. Durable DB sync should prefer course/hole geometry plus frame parameters."
    };
    index.frames[key]=record;
    saveFrameIndex(index);
    recordDebugEvent("frame-index-saved",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,frameIndexKey:key,manifestKey:manifestKey,frameStatus:record.frameStatus,generatedFrom:record.generatedFrom,tileCount:record.tileCount});
    var store=loadStore();
    var writable=courseRecord(course,store);
    writable.holes=Object.assign({},course.holes||{});
    var nextPresentation=Object.assign({},hole.presentation||{},{
        capturedManifestKey:manifestKey,
        capturedSurfaceReady:true,
        owner:"gps-play",
        frameStatus:record.frameStatus,
        frameIndexKey:key,
        frameCacheStatus:record.cacheStatus,
        generatedFrom:record.generatedFrom,
        framePrebuildStatus:"complete",
        framePrebuildLastStep:/prebuild/i.test(String(record.generatedFrom||""))?"frame_index_registered":"lazy_frame_registered",
        framePrebuildLastAt:stamp,
        framePrebuildUpdatedAt:stamp,
        framePrebuildManifestKey:manifestKey,
        framePrebuildFrameIndexKey:key
      });
    delete nextPresentation.framePrebuildLastError;
    writable.holes[String(holeNumber)]=Object.assign(hole,{
      presentation:nextPresentation,
      updatedAt:stamp
    });
    store.courses[writable.courseId]=writable;
    writeCourse(writable,store);
    recordDebugEvent("captured-manifest-registered",{courseId:writable.courseId,courseName:writable.courseName,holeNumber:holeNumber,manifestKey:manifestKey,manifestPresent:capturedManifestPresent(manifestKey),frameIndexKey:key,source:record.generatedFrom});
    return clone(record);
  }
  function getCoursePlayFrameIndex(courseOrId,holeNumber){
    var index=loadFrameIndex();
    if(courseOrId&&holeNumber)return clone(index.frames[frameIndexKey(courseOrId,holeNumber)]||null);
    if(courseOrId){
      var courseKey=courseIdFrom(courseOrId)+":h";
      return Object.keys(index.frames||{}).filter(function(key){return key.indexOf(courseKey)===0;}).map(function(key){return clone(index.frames[key]);});
    }
    return clone(index);
  }
  function buildHolePlayDbPayload(courseOrId,holeNumber){
    var course=getCoursePlayState(courseOrId);
    var hole=normalizeHoleRecord(course,holeNumber,getHolePlayState(course,holeNumber));
    return {
      schema:"gd.course_play_pipeline.db.hole",
      schemaVersion:SCHEMA_VERSION,
      recordId:hole.recordId,
      courseId:course.courseId,
      courseKey:course.courseKey,
      courseName:course.courseName,
      holeNumber:hole.holeNumber,
      status:hole.status,
      source:hole.source,
      confidence:hole.confidence,
      teePoint:hole.teePoint,
      greenCentre:hole.greenCentre,
      greenShape:hole.greenShape,
      greenBounds:hole.greenBounds,
      fairwayPoints:hole.fairwayPoints,
      routePoints:hole.routePoints,
      frameAnchors:hole.frameAnchors,
      presentation:{
        owner:hole.presentation&&hole.presentation.owner||"gps-play",
        capturedSurfaceReady:!!(hole.presentation&&hole.presentation.capturedSurfaceReady),
        frameStatus:hole.presentation&&hole.presentation.frameStatus||"unknown",
        frameIndexKey:hole.presentation&&hole.presentation.frameIndexKey||null,
        capturedManifestKey:hole.presentation&&hole.presentation.capturedManifestKey||null
      },
      dataVersion:hole.dataVersion,
      invalidatedAt:hole.invalidatedAt||null,
      invalidationReason:hole.invalidationReason||null,
      syncStatus:hole.syncStatus||"local",
      remoteId:hole.remoteId||null,
      createdAt:hole.createdAt,
      updatedAt:hole.updatedAt
    };
  }
  function buildCoursePlayDbPayload(courseOrId){
    var course=getCoursePlayState(courseOrId);
    var holes=Object.keys(course.holes||{}).map(function(key){return buildHolePlayDbPayload(course,key);}).sort(function(a,b){return a.holeNumber-b.holeNumber;});
    return {
      schema:"gd.course_play_pipeline.db.course",
      schemaVersion:SCHEMA_VERSION,
      recordId:course.recordId,
      courseId:course.courseId,
      courseKey:course.courseKey,
      courseName:course.courseName,
      status:course.status,
      source:course.source,
      confidence:course.confidence,
      dataVersion:course.dataVersion,
      syncStatus:course.syncStatus||"local",
      remoteId:course.remoteId||null,
      invalidatedAt:course.invalidatedAt||null,
      invalidationReason:course.invalidationReason||null,
      createdAt:course.createdAt,
      updatedAt:course.updatedAt,
      holes:holes
    };
  }
  function exportCoursePlayPayload(courseOrId){
    var payload=buildCoursePlayDbPayload(courseOrId||activeCourseFromApp()||"course");
    return {
      schema:"gd.course_play_pipeline.export",
      schemaVersion:SCHEMA_VERSION,
      exportedAt:now(),
      storageKey:STORE_KEY,
      payload:payload
    };
  }
  function importCoursePlayPayload(payload,opts){
    opts=opts||{};
    var source=payload&&payload.payload||payload;
    if(!source||!source.courseId)return null;
    var store=loadStore();
    var course=courseRecord(source,store);
    course=Object.assign(course,source,{holes:{}});
    (source.holes||[]).forEach(function(hole){
      var h=normalizeHoleNumber(hole&&hole.holeNumber);
      course.holes[String(h)]=normalizeHoleRecord(course,h,Object.assign({},hole,{syncStatus:opts.markPending?"pending":hole.syncStatus||"imported"}));
    });
    store.courses[course.courseId]=course;
    saveStore(store);
    return getCoursePlayState(course);
  }
  function buildCoursePlaySyncEnvelope(courseOrId){
    var payload=buildCoursePlayDbPayload(courseOrId||activeCourseFromApp()||"course");
    return {
      schema:"gd.course_play_pipeline.sync_envelope",
      schemaVersion:SCHEMA_VERSION,
      queueType:"course-play-upsert",
      localOnly:true,
      createdAt:now(),
      courseId:payload.courseId,
      dataVersion:payload.dataVersion,
      payload:payload
    };
  }
  function enqueueCoursePlaySync(courseOrId,opts){
    opts=opts||{};
    var envelope=buildCoursePlaySyncEnvelope(courseOrId||activeCourseFromApp()||"course");
    var queue=loadSyncQueue();
    var existing=queue.items.filter(function(item){return item&&item.courseId===envelope.courseId&&item.status!=="synced";})[0];
    var item=Object.assign(existing||{},{
      queueId:existing&&existing.queueId||stableId(),
      status:"pending",
      reason:String(opts.reason||"local-change"),
      attempts:existing&&Number(existing.attempts)||0,
      createdAt:existing&&existing.createdAt||now(),
      updatedAt:now(),
      courseId:envelope.courseId,
      dataVersion:envelope.dataVersion,
      envelope:envelope,
      network:"not-configured",
      localOnly:true
    });
    if(existing)queue.items=queue.items.map(function(row){return row&&row.queueId===item.queueId?item:row;});
    else queue.items.push(item);
    saveSyncQueue(queue);
    markCoursePlaySyncPending(envelope.courseId,null,opts.reason||"queued");
    return clone(item);
  }
  function markCoursePlaySyncQueueItem(queueId,status,detail){
    var queue=loadSyncQueue();
    queue.items=queue.items.map(function(item){
      if(!item||item.queueId!==queueId)return item;
      item.status=String(status||item.status||"pending");
      item.updatedAt=now();
      item.detail=detail||item.detail||null;
      if(item.status==="synced")item.syncedAt=item.updatedAt;
      return item;
    });
    return saveSyncQueue(queue);
  }
  function getCoursePlaySyncQueue(){
    return loadSyncQueue();
  }
  function futureSyncSnapshot(courseOrId){
    var course=getCoursePlayState(courseOrId);
    course.syncStatus=course.syncStatus||"local";
    course.remoteId=course.remoteId||null;
    course.schemaVersion=SCHEMA_VERSION;
    return course;
  }
  function courseLibraryApi(){
    return window.GolfDaddyCourseLibrary||window.ClarityCaddieCourseLibrary||{};
  }
  function resolveCourseFromLibrary(courseOrId){
    if(courseOrId&&typeof courseOrId==="object")return courseOrId;
    var api=courseLibraryApi();
    return safe(function(){return typeof api.loadUserCourseData==="function"?api.loadUserCourseData():null;},null)||
      safe(function(){return typeof window.loadUserCourseData==="function"?window.loadUserCourseData():null;},null)||
      null;
  }
  function courseIdentityMatches(left,right){
    var leftKeys=courseIdCandidates(left);
    var rightKeys=courseIdCandidates(right);
    if(!leftKeys.length||!rightKeys.length)return false;
    return leftKeys.some(function(key){return rightKeys.indexOf(key)!==-1;});
  }
  function resolveFreshCourseForIngest(seed){
    var fresh=resolveCourseFromLibrary(null);
    if(fresh&&(!seed||courseIdentityMatches(seed,fresh)))return fresh;
    return seed||fresh||null;
  }
  function holeNumbersForCourse(course){
    var found={};
    if(course&&course.objects&&typeof course.objects==="object"){
      Object.keys(course.objects).forEach(function(key){
        var object=course.objects[key];
        var h=Number(object&&object.holeNumber);
        if(Number.isFinite(h)&&h>0)found[Math.round(h)]=true;
      });
    }
    if(course&&course.holes&&typeof course.holes==="object"){
      Object.keys(course.holes).forEach(function(key){
        var row=course.holes[key];
        var h=Number(row&&row.holeNumber||row&&row.hole||key);
        if(Number.isFinite(h)&&h>0)found[Math.round(h)]=true;
      });
    }
    var holes=Object.keys(found).map(function(key){return Number(key);}).filter(Boolean).sort(function(a,b){return a-b;});
    if(!holes.length)holes=Array.from({length:18},function(_,index){return index+1;});
    return holes;
  }
  function mappedHoleFromCourseLibrary(course,holeNumber){
    var api=courseLibraryApi();
    return safe(function(){return typeof api.mappedHolePlayData==="function"?api.mappedHolePlayData(course,holeNumber):null;},null)||
      safe(function(){return typeof window.gdMappedHolePlayData==="function"?window.gdMappedHolePlayData(course,holeNumber):null;},null);
  }
  function ingestCourseLibraryCourse(courseOrId,opts){
    opts=opts||{};
    var course=resolveCourseFromLibrary(courseOrId);
    if(!course)return prepareCourseForPlay(courseOrId||"course");
    prepareCourseForPlay(course);
    var holes=holeNumbersForCourse(course);
    var ingested=0;
    holes.forEach(function(holeNumber){
      var mapped=mappedHoleFromCourseLibrary(course,holeNumber);
      if(mapped&&(Array.isArray(mapped.route)&&mapped.route.length||mapped.green||mapped.tee)){
        ingestMappedHole(course,holeNumber,mapped,opts.source||"course-library");
        ingested+=1;
      }
    });
    var state=getCoursePlayState(course);
    state.adapter={source:opts.source||"course-library",holesChecked:holes.length,holesIngested:ingested,updatedAt:now()};
    var store=loadStore();
    store.courses[state.courseId]=state;
    saveStore(store);
    if(opts.queueFramePrebuild!==false)setTimeout(function(){safe(function(){queueFramePrebuild(state.courseId,{source:opts.source||"course-library",reason:"post-ingest"});});},0);
    return getCoursePlayState(course);
  }
  function prepareCourseFromCourseLibrary(courseOrId,opts){
    opts=opts||{};
    var course=resolveCourseFromLibrary(courseOrId);
    var prepared=prepareCourseForPlay(course||courseOrId||"course");
    if(opts.ingest!==false)return ingestCourseLibraryCourse(course||courseOrId,{source:opts.source||"course-library-prepare"});
    return prepared;
  }
  function holeRecordToMappedData(record){
    if(!record)return null;
    var route=points(record.routePoints);
    var greenShape=points(record.greenShape);
    var tee=point(record.teePoint)||point(route[0]);
    var green=point(record.greenCentre)||point(route[route.length-1]);
    var fairways=points(record.fairwayPoints).map(function(position,index){
      return {type:"fairway",position:position,holeNumber:record.holeNumber,confirmed:true,source:"course-play-pipeline",index:index};
    });
    return {
      hole:record.holeNumber,
      pipelineStatus:record.status,
      source:"course-play-pipeline",
      tee:tee?{type:"tee",position:tee,holeNumber:record.holeNumber,confirmed:true}:null,
      green:green?{type:"green",position:green,greenShape:greenShape,shape:greenShape,holeNumber:record.holeNumber,confirmed:true}:null,
      fairways:fairways,
      route:route,
      complete:!!(green&&route.length>=2),
      frameAnchors:clone(record.frameAnchors||{})
    };
  }
  function coursePlayFrameReady(courseOrId,holeNumber){
    var frame=getCoursePlayFrameIndex(courseOrId,holeNumber);
    var key=frame&&frame.manifestKey||frame&&frame.capturedManifestKey||null;
    return !!(frame&&capturedManifestPresent(key));
  }
  function playablePrebuildHoles(course){
    return Object.keys(course&&course.holes||{}).map(function(key){
      return normalizeHoleRecord(course,key,course.holes[key]);
    }).filter(function(hole){
      return hole&&hole.status===HOLE_STATES.play_data_ready;
    }).sort(function(a,b){
      return a.holeNumber-b.holeNumber;
    });
  }
  function markFramePrebuildStatus(courseOrId,holeNumber,status,detail){
    detail=detail||{};
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    holeNumber=normalizeHoleNumber(holeNumber);
    var key=String(holeNumber);
    var hole=normalizeHoleRecord(course,holeNumber,course.holes[key]||emptyHoleRecord(course,holeNumber));
    var presentation=Object.assign({},hole.presentation||{});
    var attempts=Number(presentation.framePrebuildAttempts||0)||0;
    var stamp=now();
    if(status==="building_manifest")attempts=Math.max(attempts,Number(detail.attempt||0)+1);
    presentation.framePrebuildStatus=String(status||"unknown");
    presentation.framePrebuildAttempts=attempts;
    presentation.framePrebuildRetryCount=Number(detail.retryCount!==undefined?detail.retryCount:presentation.framePrebuildRetryCount||0)||0;
    presentation.framePrebuildLastAt=stamp;
    presentation.framePrebuildUpdatedAt=stamp;
    presentation.framePrebuildLastStep=String(detail.step||status||"unknown");
    if(detail.frameIndexKey){
      presentation.frameIndexKey=detail.frameIndexKey;
      presentation.framePrebuildFrameIndexKey=detail.frameIndexKey;
    }
    if(detail.manifestKey){
      presentation.capturedManifestKey=detail.manifestKey;
      presentation.framePrebuildManifestKey=detail.manifestKey;
    }
    if(detail.manifestCourseKey)presentation.framePrebuildManifestCourseKey=detail.manifestCourseKey;
    if(detail.manifestHoleNumber)presentation.framePrebuildManifestHoleNumber=normalizeHoleNumber(detail.manifestHoleNumber);
    if(status==="queued"&&!presentation.frameStatus)presentation.frameStatus="prebuild_queued";
    if(status==="queued")presentation.frameStatus=presentation.frameStatus||"prebuild_queued";
    if(status==="building_manifest")presentation.frameStatus="prebuilding_manifest";
    if(status==="manifest_written")presentation.frameStatus="manifest_written";
    if(status==="frame_index_registered")presentation.frameStatus="frame_index_registered";
    if(status==="complete"){
      presentation.frameStatus=detail.frameStatus||"generated";
      presentation.capturedSurfaceReady=true;
      presentation.frameCacheStatus=detail.cacheStatus||presentation.frameCacheStatus||"local-cache";
      presentation.generatedFrom=detail.generatedFrom||presentation.generatedFrom||"v19-prebuild";
      presentation.framePrebuildCompletedAt=stamp;
      delete presentation.framePrebuildLastError;
    }
    if(status==="retry_pending"){
      presentation.frameStatus="prebuild_retry_pending";
      presentation.framePrebuildLastError=String(detail.error||detail.reason||"transient frame prebuild failure");
      presentation.framePrebuildNextRetryAt=detail.nextRetryAt||null;
    }
    if(status==="failed"){
      presentation.frameStatus="prebuild_failed";
      presentation.capturedSurfaceReady=false;
      presentation.framePrebuildLastError=String(detail.error||detail.reason||"frame prebuild failed");
    }
    if(status!=="retry_pending"&&status!=="failed")delete presentation.framePrebuildNextRetryAt;
    if(status==="skipped"&&detail.reason)presentation.framePrebuildSkipReason=String(detail.reason);
    hole.presentation=presentation;
    hole.updatedAt=stamp;
    course.holes[key]=hole;
    store.courses[course.courseId]=course;
    writeCourse(course,store);
    return getHolePlayState(course,holeNumber);
  }
  function uniqueStrings(values){
    var found={};
    return (values||[]).map(function(value){return value===undefined||value===null?"":String(value);}).filter(Boolean).filter(function(value){
      if(found[value])return false;
      found[value]=true;
      return true;
    });
  }
  function prebuildManifestFromResult(result){
    if(result&&result.manifest&&Array.isArray(result.manifest.tiles)&&result.manifest.originPx)return result.manifest;
    if(result&&Array.isArray(result.tiles)&&result.originPx)return result;
    return null;
  }
  function frameManifestKey(frame){
    return frame&&(frame.manifestKey||frame.capturedManifestKey)||null;
  }
  function manifestKeyCandidates(course,holeNumber,result,hole){
    var presentation=hole&&hole.presentation||{};
    var manifest=prebuildManifestFromResult(result)||result||{};
    var courseKeys=courseIdCandidates(course);
    var raw=[
      result&&result.manifestKey,
      result&&result.capturedManifestKey,
      result&&result.key,
      result&&result.storageKey,
      result&&result.scanId,
      result&&result.activeScanId,
      manifest&&manifest.manifestKey,
      manifest&&manifest.capturedManifestKey,
      manifest&&manifest.key,
      manifest&&manifest.storageKey,
      manifest&&manifest.scanId,
      manifest&&manifest.activeScanId,
      presentation.capturedManifestKey,
      presentation.framePrebuildManifestKey
    ];
    courseKeys.forEach(function(courseKey){
      raw.push(capturedManifestStorageKey(courseKey,holeNumber));
      raw.push(capturedManifestStorageKey(String(courseKey).replace(/_/g," "),holeNumber));
    });
    return uniqueStrings(raw);
  }
  function scanManifestMatchesCourseHole(course,holeNumber,scan){
    if(!scan)return false;
    var scanHole=normalizeHoleNumber(scan.holeNumber||scan.manifest&&scan.manifest.holeNumber);
    if(scanHole!==normalizeHoleNumber(holeNumber))return false;
    return courseKeyMatch(course,scan.courseKey||scan.manifest&&scan.manifest.courseKey||scan.courseName||scan.manifest&&scan.manifest.courseName);
  }
  function findExistingManifestForHole(course,holeNumber,result,hole){
    var manifest=prebuildManifestFromResult(result);
    var key=prebuildResultManifestKey(result,null);
    if(manifest&&manifestMatchesHole(course,holeNumber,manifest)){
      return {manifest:manifest,key:key||manifest.key||manifest.storageKey||manifest.scanId||manifest.activeScanId||capturedManifestStorageKey(course.courseId,holeNumber),source:"adapter-result",courseKey:manifest.courseKey||course.courseId,holeNumber:normalizeHoleNumber(manifest.holeNumber||holeNumber)};
    }
    var keys=manifestKeyCandidates(course,holeNumber,result,hole);
    for(var i=0;i<keys.length;i++){
      var stored=readCapturedManifest(keys[i]);
      if(stored&&manifestMatchesHole(course,holeNumber,stored)){
        return {manifest:stored,key:keys[i],source:"manifest-key",courseKey:stored.courseKey||course.courseId,holeNumber:normalizeHoleNumber(stored.holeNumber||holeNumber)};
      }
    }
    var registry=safe(function(){return JSON.parse(localStorage.getItem("gd_captured_surface_scans_v1")||"null");},null);
    var scans=registry&&Array.isArray(registry.scans)?registry.scans:[];
    var courseKeys=courseIdCandidates(course);
    for(var s=0;s<scans.length;s++){
      var scan=scans[s];
      if(scanManifestMatchesCourseHole(course,holeNumber,scan)&&scan.manifest&&Array.isArray(scan.manifest.tiles)&&scan.manifest.originPx){
        return {manifest:scan.manifest,key:scan.storage&&scan.storage.legacyManifestKey||scan.manifest.key||scan.manifest.storageKey||scan.id,source:"captured-surface-registry",courseKey:scan.courseKey||scan.manifest.courseKey||course.courseId,holeNumber:normalizeHoleNumber(scan.holeNumber||holeNumber),scanId:scan.id};
      }
    }
    for(var c=0;c<courseKeys.length;c++){
      var activeId=safe(function(courseKey){return localStorage.getItem(captureRegistryKey(courseKey,holeNumber));}.bind(null,courseKeys[c]),null);
      if(!activeId)continue;
      var active=scans.filter(function(scan){return scan&&scan.id===activeId;})[0]||null;
      if(active&&active.manifest&&Array.isArray(active.manifest.tiles)&&active.manifest.originPx){
        return {manifest:active.manifest,key:active.storage&&active.storage.legacyManifestKey||active.manifest.key||active.manifest.storageKey||active.id,source:"captured-surface-active-key",courseKey:active.courseKey||active.manifest.courseKey||course.courseId,holeNumber:normalizeHoleNumber(active.holeNumber||holeNumber),scanId:active.id};
      }
    }
    return null;
  }
  function framePrebuildAdapter(){
    return safe(function(){
      if(typeof window.gdPrebuildCoursePlayFrameManifest==="function")return window.gdPrebuildCoursePlayFrameManifest;
      if(typeof window.gdPrebuildCoursePlayFrameFromData==="function")return window.gdPrebuildCoursePlayFrameFromData;
      return null;
    },null);
  }
  function prebuildResultManifestKey(result,frame){
    var manifest=prebuildManifestFromResult(result);
    return result&&(
      result.manifestKey||
      result.capturedManifestKey||
      result.key||
      result.storageKey||
      result.scanId||
      result.activeScanId
    )||manifest&&(
      manifest.manifestKey||
      manifest.capturedManifestKey||
      manifest.key||
      manifest.storageKey||
      manifest.scanId||
      manifest.activeScanId
    )||frame&&(
      frame.manifestKey||
      frame.capturedManifestKey
    )||null;
  }
  function normalizeFailureReason(result,fb){
    return String(result&&(
      result.reason||
      result.error||
      result.message||
      result.step
    )||fb||"frame prebuild failed").replace(/\s+/g,"_").toLowerCase();
  }
  function isTransientPrebuildFailure(detail){
    var reason=normalizeFailureReason(detail,"");
    if(detail&&detail.transient===false)return false;
    if(detail&&detail.transient===true)return true;
    if(FRAME_PREBUILD_TRANSIENT_REASONS[reason])return true;
    return /adapter|map|engine|tile|projection|manifest.*null|storage.*write|frame.*index.*missing|registration.*failed|captured.*manifest.*missing|timeout|not.*ready/i.test(String(reason));
  }
  function retryDelayFor(attempt){
    var index=Math.max(0,Math.min(FRAME_PREBUILD_RETRY_DELAYS_MS.length-1,Number(attempt||1)-1));
    return FRAME_PREBUILD_RETRY_DELAYS_MS[index]||FRAME_PREBUILD_RETRY_DELAYS_MS[FRAME_PREBUILD_RETRY_DELAYS_MS.length-1]||400;
  }
  function recoverFrameIndexFromManifest(course,holeNumber,manifestInfo,opts){
    if(!manifestInfo||!manifestInfo.manifest)return null;
    var manifestKey=manifestInfo.key||manifestInfo.manifest.key||manifestInfo.manifest.storageKey||manifestInfo.manifest.scanId||manifestInfo.manifest.activeScanId||capturedManifestStorageKey(course.courseId,holeNumber);
    markFramePrebuildStatus(course,holeNumber,"manifest_written",{step:"existing_manifest_found",manifestKey:manifestKey,manifestCourseKey:manifestInfo.courseKey,manifestHoleNumber:manifestInfo.holeNumber||holeNumber,retryCount:opts&&opts.retryCount||0});
    var frame=registerCoursePlayFrame(course,holeNumber,manifestInfo.manifest,{generatedFrom:"v19-captured-surface-prebuild-recovered",manifestKey:manifestKey,status:"recovered",cacheStatus:"local-prebuilt-recovered"});
    var verified=getCoursePlayFrameIndex(course,holeNumber)||frame;
    if(verified&&capturedManifestPresent(frameManifestKey(verified)||manifestKey)){
      recordDebugEvent("recovered-frame-index-from-manifest",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"complete",manifestKey:manifestKey,frameIndexKey:verified.frameIndexKey,manifestSource:manifestInfo.source,source:opts&&opts.source||"frame-prebuild"});
      return verified;
    }
    return null;
  }
  function failOrRetryPrebuild(course,holeNumber,detail,opts){
    opts=opts||{};
    detail=detail||{};
    var attempt=Number(opts.attempt||0)||0;
    var maxRetries=Number(opts.maxRetries!==undefined?opts.maxRetries:FRAME_PREBUILD_RETRY_DELAYS_MS.length);
    var transient=isTransientPrebuildFailure(detail);
    var reason=String(detail.reason||detail.error||detail.message||detail.step||"frame prebuild failed");
    var step=String(detail.step||reason||"frame_prebuild_failed");
    var manifestKey=detail.manifestKey||null;
    var frameIndexKey=detail.frameIndexKey||null;
    if(transient&&attempt<maxRetries){
      var retryCount=attempt+1;
      var delay=retryDelayFor(retryCount);
      var nextRetryAt=new Date(Date.now()+delay).toISOString();
      markFramePrebuildStatus(course,holeNumber,"retry_pending",{step:step,reason:reason,error:reason,retryCount:retryCount,nextRetryAt:nextRetryAt,manifestKey:manifestKey,frameIndexKey:frameIndexKey,manifestCourseKey:detail.manifestCourseKey,manifestHoleNumber:detail.manifestHoleNumber});
      recordDebugEvent("frame-prebuild-retry-pending",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"retry_pending",step:step,reason:reason,retryCount:retryCount,nextRetryAt:nextRetryAt,retryAfterMs:delay,manifestKey:manifestKey,frameIndexKey:frameIndexKey,source:opts.source||"frame-prebuild"});
      return {status:"retry_pending",courseId:course.courseId,holeNumber:holeNumber,step:step,reason:reason,transient:true,retryCount:retryCount,retryAfterMs:delay,manifestKey:manifestKey,frameIndexKey:frameIndexKey};
    }
    markFramePrebuildStatus(course,holeNumber,"failed",{step:step,reason:reason,error:reason,retryCount:attempt,manifestKey:manifestKey,frameIndexKey:frameIndexKey,manifestCourseKey:detail.manifestCourseKey,manifestHoleNumber:detail.manifestHoleNumber});
    recordDebugEvent("frame-prebuild-hole-failed",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"failed",step:step,reason:reason,retryCount:attempt,transient:transient,manifestKey:manifestKey,frameIndexKey:frameIndexKey,source:opts.source||"frame-prebuild"});
    return {status:"failed",courseId:course.courseId,holeNumber:holeNumber,step:step,reason:reason,transient:transient,retryCount:attempt,manifestKey:manifestKey,frameIndexKey:frameIndexKey};
  }
  function gdPrebuildCoursePlayFrame(courseOrId,holeNumber,opts){
    opts=opts||{};
    var attempt=Number(opts.attempt||0)||0;
    var source=opts.source||"frame-prebuild";
    var course=getCoursePlayState(courseOrId||activeCourseFromApp()||"course");
    holeNumber=normalizeHoleNumber(holeNumber);
    var hole=normalizeHoleRecord(course,holeNumber,course.holes&&course.holes[String(holeNumber)]||emptyHoleRecord(course,holeNumber));
    if(hole.status!==HOLE_STATES.play_data_ready){
      markFramePrebuildStatus(course,holeNumber,"skipped",{step:"hole_play_data_missing",reason:"hole-not-play-data-ready",retryCount:attempt});
      recordDebugEvent("frame-prebuild-skipped",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:hole.status,step:"hole_play_data_missing",reason:"hole-not-play-data-ready",source:source});
      return Promise.resolve({status:"skipped",reason:"hole-not-play-data-ready",holeNumber:holeNumber});
    }
    if(!opts.force&&coursePlayFrameReady(course,holeNumber)){
      var readyFrame=getCoursePlayFrameIndex(course,holeNumber);
      markFramePrebuildStatus(course,holeNumber,"complete",{step:"already_indexed",reason:"already-indexed",frameIndexKey:readyFrame&&readyFrame.frameIndexKey,manifestKey:frameManifestKey(readyFrame),frameStatus:readyFrame&&readyFrame.frameStatus,cacheStatus:readyFrame&&readyFrame.cacheStatus,generatedFrom:readyFrame&&readyFrame.generatedFrom,retryCount:attempt});
      recordDebugEvent("frame-prebuild-skipped",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"complete",step:"already_indexed",reason:"already-indexed",source:source});
      return Promise.resolve({status:"skipped",reason:"already-indexed",holeNumber:holeNumber});
    }
    var mapped=holeRecordToMappedData(hole);
    if(!mapped||!Array.isArray(mapped.route)||mapped.route.length<2||!mapped.green){
      return Promise.resolve(failOrRetryPrebuild(course,holeNumber,{step:"route_green_invalid",reason:"missing-explicit-hole-data",transient:false},Object.assign({},opts,{attempt:attempt,source:source})));
    }
    var existingFrame=getCoursePlayFrameIndex(course,holeNumber);
    var existingManifest=findExistingManifestForHole(course,holeNumber,null,hole);
    if(existingFrame&&capturedManifestPresent(frameManifestKey(existingFrame))){
      markFramePrebuildStatus(course,holeNumber,"complete",{step:"existing_frame_ready",frameIndexKey:existingFrame.frameIndexKey,manifestKey:frameManifestKey(existingFrame),frameStatus:existingFrame.frameStatus,cacheStatus:existingFrame.cacheStatus,generatedFrom:existingFrame.generatedFrom,retryCount:attempt});
      recordDebugEvent("frame-prebuild-hole-complete",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"complete",step:"existing_frame_ready",frameIndexKey:existingFrame.frameIndexKey,manifestKey:frameManifestKey(existingFrame),manifestPresent:true,source:source});
      return Promise.resolve({status:"complete",courseId:course.courseId,holeNumber:holeNumber,frameIndexKey:existingFrame.frameIndexKey,manifestKey:frameManifestKey(existingFrame),manifestPresent:true});
    }
    if(!existingFrame&&existingManifest){
      var recovered=recoverFrameIndexFromManifest(course,holeNumber,existingManifest,{source:source,retryCount:attempt});
      if(recovered){
        markFramePrebuildStatus(course,holeNumber,"complete",{step:"recovered_frame_index_from_manifest",frameIndexKey:recovered.frameIndexKey,manifestKey:frameManifestKey(recovered)||existingManifest.key,manifestCourseKey:existingManifest.courseKey,manifestHoleNumber:existingManifest.holeNumber,frameStatus:recovered.frameStatus,cacheStatus:recovered.cacheStatus,generatedFrom:recovered.generatedFrom,retryCount:attempt});
        recordDebugEvent("frame-prebuild-hole-complete",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"complete",step:"recovered_frame_index_from_manifest",frameIndexKey:recovered.frameIndexKey,manifestKey:frameManifestKey(recovered)||existingManifest.key,manifestPresent:true,source:source});
        return Promise.resolve({status:"complete",courseId:course.courseId,holeNumber:holeNumber,frameIndexKey:recovered.frameIndexKey,manifestKey:frameManifestKey(recovered)||existingManifest.key,manifestPresent:true,recovered:true});
      }
    }
    var adapter=framePrebuildAdapter();
    if(typeof adapter!=="function"){
      return Promise.resolve(failOrRetryPrebuild(course,holeNumber,{step:"adapter_unavailable",reason:"prebuild-adapter-unavailable",transient:true},Object.assign({},opts,{attempt:attempt,source:source})));
    }
    markFramePrebuildStatus(course,holeNumber,"building_manifest",{step:"building_manifest",attempt:attempt,retryCount:attempt});
    recordDebugEvent("frame-prebuild-started",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"building_manifest",step:"building_manifest",attempt:attempt,source:source});
    return Promise.resolve().then(function(){
      return adapter(course,holeNumber,mapped,Object.assign({},opts,{source:source,reason:opts.reason||"course-play-frame-prebuild",attempt:attempt}));
    }).then(function(result){
      if(!result)return failOrRetryPrebuild(course,holeNumber,{step:"manifest_build_returned_null",reason:"prebuild adapter returned no manifest",transient:true},Object.assign({},opts,{attempt:attempt,source:source}));
      if(result&&result.ok===false)return failOrRetryPrebuild(course,holeNumber,{step:result.step||"manifest_build_failed",reason:result.reason||result.error||"manifest build failed",transient:result.transient,manifestKey:result.manifestKey,frameIndexKey:result.frameIndexKey,manifestCourseKey:result.courseKey,manifestHoleNumber:result.holeNumber},Object.assign({},opts,{attempt:attempt,source:source}));
      var resultManifest=prebuildManifestFromResult(result);
      var manifestInfo=findExistingManifestForHole(course,holeNumber,result,hole);
      if(!manifestInfo&&resultManifest){
        var resultKey=prebuildResultManifestKey(result,null)||capturedManifestStorageKey(course.courseId,holeNumber);
        manifestInfo={manifest:resultManifest,key:resultKey,source:"adapter-result-unverified",courseKey:resultManifest.courseKey||course.courseId,holeNumber:normalizeHoleNumber(resultManifest.holeNumber||holeNumber)};
      }
      if(!manifestInfo)return failOrRetryPrebuild(course,holeNumber,{step:"manifest_build_returned_null",reason:"manifest build returned no stored manifest",transient:true},Object.assign({},opts,{attempt:attempt,source:source}));
      var manifestKey=manifestInfo.key||prebuildResultManifestKey(result,null)||manifestInfo.manifest.key||manifestInfo.manifest.storageKey||manifestInfo.manifest.scanId||manifestInfo.manifest.activeScanId;
      markFramePrebuildStatus(course,holeNumber,"manifest_written",{step:"manifest_written",manifestKey:manifestKey,manifestCourseKey:manifestInfo.courseKey,manifestHoleNumber:manifestInfo.holeNumber,retryCount:attempt});
      recordDebugEvent("frame-prebuild-manifest-written",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"manifest_written",manifestKey:manifestKey,manifestSource:manifestInfo.source,tileCount:(manifestInfo.manifest.tiles||[]).length,source:source});
      var frame=getCoursePlayFrameIndex(course,holeNumber);
      if(!frame){
        frame=recoverFrameIndexFromManifest(course,holeNumber,manifestInfo,{source:source,retryCount:attempt});
      }
      if(frame)recordDebugEvent("frame-prebuild-frame-index-registered",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"frame_index_registered",frameIndexKey:frame.frameIndexKey,manifestKey:frameManifestKey(frame)||manifestKey,source:source});
      var finalManifestKey=frameManifestKey(frame)||manifestKey;
      var present=capturedManifestPresent(finalManifestKey);
      if(!frame)return failOrRetryPrebuild(course,holeNumber,{step:"frame_index_registration_failed",reason:"frame index missing",transient:true,manifestKey:manifestKey,manifestCourseKey:manifestInfo.courseKey,manifestHoleNumber:manifestInfo.holeNumber},Object.assign({},opts,{attempt:attempt,source:source}));
      if(!present)return failOrRetryPrebuild(course,holeNumber,{step:"manifest_storage_write_failed",reason:"captured manifest missing",transient:true,manifestKey:finalManifestKey,frameIndexKey:frame.frameIndexKey,manifestCourseKey:manifestInfo.courseKey,manifestHoleNumber:manifestInfo.holeNumber},Object.assign({},opts,{attempt:attempt,source:source}));
      markFramePrebuildStatus(course,holeNumber,"frame_index_registered",{step:"frame_index_registered",frameIndexKey:frame.frameIndexKey,manifestKey:finalManifestKey,manifestCourseKey:manifestInfo.courseKey,manifestHoleNumber:manifestInfo.holeNumber,retryCount:attempt});
      markFramePrebuildStatus(course,holeNumber,"complete",{step:"complete",frameIndexKey:frame.frameIndexKey,manifestKey:finalManifestKey,manifestCourseKey:manifestInfo.courseKey,manifestHoleNumber:manifestInfo.holeNumber,frameStatus:frame.frameStatus,cacheStatus:frame.cacheStatus,generatedFrom:frame.generatedFrom,retryCount:attempt});
      recordDebugEvent("frame-prebuild-hole-complete",{courseId:course.courseId,courseName:course.courseName,holeNumber:holeNumber,status:"complete",step:"complete",frameIndexKey:frame.frameIndexKey,manifestKey:finalManifestKey,manifestPresent:present,source:source});
      return {status:"complete",courseId:course.courseId,holeNumber:holeNumber,frameIndexKey:frame.frameIndexKey,manifestKey:finalManifestKey,manifestPresent:present};
    }).then(null,function(error){
      var message=String(error&&error.message||error||"frame prebuild failed");
      return failOrRetryPrebuild(course,holeNumber,{step:"unexpected_prebuild_error",reason:message,error:message,transient:isTransientPrebuildFailure({reason:message})},Object.assign({},opts,{attempt:attempt,source:source}));
    });
  }
  function processFramePrebuildQueue(courseId){
    var queue=framePrebuildQueues[courseId];
    if(!queue||queue.running)return;
    if(!queue.holes.length){
      var status=(queue.failed||0)>0?"complete_with_failures":"complete";
      recordDebugEvent("frame-prebuild-complete",{courseId:queue.courseId,courseName:queue.courseName,status:status,holesQueued:0,holesCompleted:queue.completed||0,holesSkipped:queue.skipped||0,holesFailed:queue.failed||0,holesRetried:queue.retried||0,source:queue.source||"frame-prebuild"});
      delete framePrebuildQueues[courseId];
      return;
    }
    var item=queue.holes.shift();
    if(typeof item==="number"||typeof item==="string")item={holeNumber:normalizeHoleNumber(item),attempt:0};
    item=item||{};
    var holeNumber=normalizeHoleNumber(item.holeNumber);
    var attempt=Number(item.attempt||0)||0;
    queue.running=true;
    queue.runningHole=holeNumber;
    queue.runningAttempt=attempt;
    var nextDelay=FRAME_PREBUILD_DELAY_MS;
    gdPrebuildCoursePlayFrame(courseId,holeNumber,{source:queue.source||"frame-prebuild",reason:queue.reason||"post-scan-frame-prebuild",attempt:attempt,maxRetries:FRAME_PREBUILD_RETRY_DELAYS_MS.length}).then(function(result){
      if(result&&result.status==="complete")queue.completed=(queue.completed||0)+1;
      else if(result&&result.status==="skipped")queue.skipped=(queue.skipped||0)+1;
      else if(result&&result.status==="retry_pending"){
        queue.retried=(queue.retried||0)+1;
        queue.holes.unshift({holeNumber:holeNumber,attempt:attempt+1});
        nextDelay=Number(result.retryAfterMs||retryDelayFor(attempt+1))||FRAME_PREBUILD_DELAY_MS;
      }
      else queue.failed=(queue.failed||0)+1;
    },function(){
      queue.failed=(queue.failed||0)+1;
    }).then(function(){
      queue.running=false;
      queue.runningHole=null;
      queue.runningAttempt=0;
      queue.timer=setTimeout(function(){queue.timer=null;processFramePrebuildQueue(courseId);},nextDelay);
    });
  }
  function framePrebuildQueueHasHole(queue,holeNumber){
    holeNumber=normalizeHoleNumber(holeNumber);
    if(queue.runningHole===holeNumber)return true;
    return (queue.holes||[]).some(function(item){
      var h=typeof item==="number"||typeof item==="string"?item:item&&item.holeNumber;
      return normalizeHoleNumber(h)===holeNumber;
    });
  }
  function queueFramePrebuild(courseOrId,opts){
    opts=opts||{};
    var course=getCoursePlayState(courseOrId||activeCourseFromApp()||"course");
    var readyHoles=playablePrebuildHoles(course);
    var missing=readyHoles.filter(function(hole){return opts.force||!coursePlayFrameReady(course,hole.holeNumber);});
    if(!missing.length){
      recordDebugEvent("frame-prebuild-complete",{courseId:course.courseId,courseName:course.courseName,status:"complete",holesQueued:0,holesReady:readyHoles.length,source:opts.source||"frame-prebuild",reason:"nothing-missing"});
      return {status:"complete",courseId:course.courseId,holesReady:readyHoles.length,holesQueued:0};
    }
    var queue=framePrebuildQueues[course.courseId]||{queueId:stableId(),courseId:course.courseId,courseName:course.courseName,holes:[],running:false,completed:0,failed:0,skipped:0,retried:0,source:opts.source||"frame-prebuild",reason:opts.reason||"post-scan-frame-prebuild"};
    missing.forEach(function(hole){
      var h=normalizeHoleNumber(hole.holeNumber);
      if(!framePrebuildQueueHasHole(queue,h)){
        queue.holes.push({holeNumber:h,attempt:0});
        markFramePrebuildStatus(course,h,"queued",{step:"queued",retryCount:0});
      }
    });
    framePrebuildQueues[course.courseId]=queue;
    recordDebugEvent("frame-prebuild-queued",{courseId:course.courseId,courseName:course.courseName,status:"queued",holesQueued:queue.holes.length,holesReady:readyHoles.length,holesMissing:missing.length,source:queue.source});
    if(!queue.running&&!queue.timer)queue.timer=setTimeout(function(){queue.timer=null;processFramePrebuildQueue(course.courseId);},FRAME_PREBUILD_DELAY_MS);
    return {status:"queued",courseId:course.courseId,holesReady:readyHoles.length,holesQueued:queue.holes.length,holes:queue.holes.map(function(item){return normalizeHoleNumber(item&&item.holeNumber||item);})};
  }
  function activeCourseFromApp(){
    return resolveCourseFromLibrary(null)||safe(function(){return window.gdActiveCourse||window.currentCourse||currentCourse||null;},null);
  }
  function activeHoleFromApp(fallback){
    return normalizeHoleNumber(safe(function(){
      return window.currentPlayingHole||window.selectedHole||currentPlayingHole||selectedHole||
        sessionStorage.getItem("gd_active_playing_hole")||
        sessionStorage.getItem("gd_mapper_active_hole")||
        fallback||1;
    },fallback||1));
  }
  function ensureActiveHolePlayData(holeNumber,opts){
    opts=opts||{};
    var course=activeCourseFromApp();
    holeNumber=normalizeHoleNumber(holeNumber||activeHoleFromApp());
    var state=getHolePlayState(course||"course",holeNumber);
    recordDebugEvent("gps-play-requested-hole",{courseId:state.courseId,courseName:state.courseName,holeNumber:holeNumber,status:state.status,source:opts.source||"gps-play"});
    if(state.status===HOLE_STATES.unknown||state.status===HOLE_STATES.mapping){
      var mapped=mappedHoleFromCourseLibrary(course,holeNumber);
      if(mapped)state=ingestMappedHole(course||"course",holeNumber,mapped,opts.source||"gps-play-read");
      else prepareCourseForPlay(course||"course");
    }
    return Promise.resolve(getHolePlayState(course||"course",holeNumber));
  }
  function getActiveHolePlayState(holeNumber){
    var course=activeCourseFromApp();
    holeNumber=normalizeHoleNumber(holeNumber||activeHoleFromApp());
    return getHolePlayState(course||"course",holeNumber);
  }
  function getActiveHoleMappedData(holeNumber){
    var state=getActiveHolePlayState(holeNumber);
    if(state.status===HOLE_STATES.unknown||state.status===HOLE_STATES.mapping){
      var course=activeCourseFromApp();
      var mapped=mappedHoleFromCourseLibrary(course,normalizeHoleNumber(holeNumber||activeHoleFromApp()));
      if(mapped)state=ingestMappedHole(course||"course",normalizeHoleNumber(holeNumber||activeHoleFromApp()),mapped,"gps-play-read");
    }
    return holeRecordToMappedData(state);
  }
  function gpsActive(){
    return !!(document.body&&(
      document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active")
    ));
  }
  function pipelineStatusElement(){
    var el=document.getElementById("gdCoursePlayPipelineStatus");
    if(!el&&document.body){
      el=document.createElement("div");
      el.id="gdCoursePlayPipelineStatus";
      el.setAttribute("role","status");
      el.setAttribute("aria-live","polite");
      document.body.appendChild(el);
    }
    return el;
  }
  function preparingStatus(status){
    return status===HOLE_STATES.unknown||status===HOLE_STATES.mapping||status===HOLE_STATES.play_data_preparing;
  }
  function unavailableStatus(status){
    return status===HOLE_STATES.play_data_unavailable||status===HOLE_STATES.needs_remap;
  }
  function syncGpsPipelineState(reason,holeNumber){
    if(!document.body)return null;
    var hole=normalizeHoleNumber(holeNumber||activeHoleFromApp());
    var course=activeCourseFromApp();
    var state=getActiveHolePlayState(hole);
    var status=String(state&&state.status||HOLE_STATES.unknown);
    if(preparingStatus(status)){
      var mapped=mappedHoleFromCourseLibrary(course,hole);
      if(mapped&&(Array.isArray(mapped.route)&&mapped.route.length>=2||mapped.green&&mapped.tee)){
        state=ingestMappedHole(course||"course",hole,mapped,reason||"pipeline-sync");
        status=String(state&&state.status||HOLE_STATES.unknown);
      }
    }
    var key=String(state&&state.courseId||courseIdFrom(course||"course"))+":h"+String(hole);
    var syncSig=key+"|"+status+"|"+String(reason||"sync");
    if(gpsActive()&&reason!=="interval"&&lastSyncStatusByKey[key]!==syncSig){
      recordDebugEvent("gps-play-requested-hole",{courseId:state&&state.courseId||courseIdFrom(course||"course"),courseName:state&&state.courseName||courseNameFrom(course,"Course"),holeNumber:hole,status:status,source:reason||"sync"});
    }
    if(preparingStatus(status)){
      if(!preparingSince[key])preparingSince[key]=Date.now();
      if(Date.now()-preparingSince[key]>=PREPARING_TIMEOUT_MS){
        state=markHolePlayDataUnavailable(state&&state.courseId||course||"course",hole,"mapped geometry unavailable after pipeline timeout");
        status=String(state&&state.status||HOLE_STATES.play_data_unavailable);
      }
    }else{
      delete preparingSince[key];
    }
    var preparing=gpsActive()&&preparingStatus(status);
    var unavailable=gpsActive()&&unavailableStatus(status);
    document.body.classList.toggle("gdCoursePlayPipelinePreparing",!!preparing);
    document.body.classList.toggle("gdCoursePlayPipelineUnavailable",!!unavailable);
    if(preparing)document.body.classList.add("gdGpsFramePreparing");
    document.body.dataset.gdCoursePlayPipelineStatus=status;
    document.body.dataset.gdCoursePlayPipelineHole=String(hole);
    document.body.dataset.gdCoursePlayPipelineReason=String(reason||"sync");
    var el=pipelineStatusElement();
    if(el)el.textContent=preparing?"Preparing Hole "+hole+"...":unavailable?"Frame unavailable - remap this hole":"";
    if(gpsActive()){
      var transitionKey=key+"|"+status+"|"+String(!!preparing)+"|"+String(!!unavailable);
      if(lastSyncStatusByKey[key]!==transitionKey){
        if(preparing)recordDebugEvent("gps-play-showed-loading",{courseId:state&&state.courseId||courseIdFrom(course||"course"),courseName:state&&state.courseName||courseNameFrom(course,"Course"),holeNumber:hole,status:status,reason:reason||"sync"});
        else if(unavailable)recordDebugEvent("gps-play-fell-to-unavailable",{courseId:state&&state.courseId||courseIdFrom(course||"course"),courseName:state&&state.courseName||courseNameFrom(course,"Course"),holeNumber:hole,status:status,reason:state&&state.unavailableReason||reason||"unavailable"});
        else if(status===HOLE_STATES.play_data_ready){
          var frame=getCoursePlayFrameIndex(state&&state.courseId||course||"course",hole);
          var manifestKey=frame&&frame.manifestKey||state&&state.presentation&&state.presentation.capturedManifestKey||null;
          recordDebugEvent(frame&&capturedManifestPresent(manifestKey)?"gps-play-loaded-existing-frame":"gps-play-data-ready-no-manifest",{courseId:state&&state.courseId||courseIdFrom(course||"course"),courseName:state&&state.courseName||courseNameFrom(course,"Course"),holeNumber:hole,status:status,frameIndexKey:frame&&frame.frameIndexKey||null,manifestKey:manifestKey,manifestPresent:capturedManifestPresent(manifestKey),reason:reason||"sync"});
        }
        lastSyncStatusByKey[key]=transitionKey;
      }
    }
    safe(function(){if(typeof window.gdApplyGpsMapVisibilityOwner==="function")window.gdApplyGpsMapVisibilityOwner("course-play-pipeline-"+(reason||"sync"));});
    return state;
  }
  function installGpsPlayAdapter(){
    if(window.__gdCoursePlayPipelineGpsAdapterLocked)return;
    var wrappedAny=false;
    function wrap(name){
      var original=window[name];
      if(typeof original!=="function"||original.__gdCoursePlayPipelineWrapped)return;
      var wrapped=function(holeOrDelta,opts){
        var hole=normalizeHoleNumber(name==="gdPlayPreviousHole"||name==="gdPlayNextHole"?activeHoleFromApp():holeOrDelta||activeHoleFromApp());
        if(name==="gdPlayNextHole")hole=normalizeHoleNumber(activeHoleFromApp()+1);
        if(name==="gdPlayPreviousHole")hole=Math.max(1,normalizeHoleNumber(activeHoleFromApp()-1));
        ensureActiveHolePlayData(hole,{source:name});
        syncGpsPipelineState(name,hole);
        return original.apply(this,arguments);
      };
      wrapped.__gdCoursePlayPipelineWrapped=true;
      window[name]=wrapped;
      wrappedAny=true;
    }
    wrap("gdPlayHoleFromScorecard");
    wrap("gdPlayNextHole");
    wrap("gdPlayPreviousHole");
    if(wrappedAny)window.__gdCoursePlayPipelineGpsAdapterLocked=true;
  }
  function installCourseLibraryAdapter(){
    if(window.__gdCoursePlayPipelineCourseLibraryAdapter)return;
    window.__gdCoursePlayPipelineCourseLibraryAdapter=true;
    var originalAutoMap=window.gdAutoMapOsmCourse;
    if(typeof originalAutoMap==="function"&&!originalAutoMap.__gdCoursePlayPipelineWrapped){
      window.gdAutoMapOsmCourse=function(){
        var args=arguments;
        var opts=args&&args[0]||{};
        var course=opts&&opts.course;
        recordDebugEvent("automapper-started",{source:"automap"});
        var result=originalAutoMap.apply(this,args);
        var ingest=function(){safe(function(){
          recordDebugEvent("automapper-ingest-started",{source:"automap"});
          var state=ingestCourseLibraryCourse(resolveFreshCourseForIngest(course),{source:"automap"});
          recordDebugEvent("automapper-completed",{courseId:state&&state.courseId,courseName:state&&state.courseName,status:state&&state.status,holesScanned:state&&state.adapter&&state.adapter.holesChecked,holesSaved:state&&state.adapter&&state.adapter.holesIngested,source:"automap"});
        });};
        if(result&&typeof result.then==="function")return result.finally(ingest);
        setTimeout(ingest,0);
        return result;
      };
      window.gdAutoMapOsmCourse.__gdCoursePlayPipelineWrapped=true;
    }
    var originalOpenCourseToFirstHole=window.gdOpenCourseToFirstHole;
    if(typeof originalOpenCourseToFirstHole==="function"&&!originalOpenCourseToFirstHole.__gdCoursePlayPipelineWrapped){
      window.gdOpenCourseToFirstHole=function(course){
        safe(function(){prepareCourseForPlay(course||resolveCourseFromLibrary(null));});
        syncGpsPipelineState("open-course-to-first-hole",1);
        var result=originalOpenCourseToFirstHole.apply(this,arguments);
        setTimeout(function(){safe(function(){ingestCourseLibraryCourse(resolveFreshCourseForIngest(course),{source:"course-selection"});syncGpsPipelineState("course-selection-ingested",1);});},350);
        return result;
      };
      window.gdOpenCourseToFirstHole.__gdCoursePlayPipelineWrapped=true;
    }
    var originalPickerCourse=window.gdOpenCoursePickerCourse;
    if(typeof originalPickerCourse==="function"&&!originalPickerCourse.__gdCoursePlayPipelineWrapped){
      window.gdOpenCoursePickerCourse=function(course){
        safe(function(){prepareCourseForPlay(course||resolveCourseFromLibrary(null));});
        syncGpsPipelineState("course-picker",1);
        var result=originalPickerCourse.apply(this,arguments);
        setTimeout(function(){safe(function(){ingestCourseLibraryCourse(resolveFreshCourseForIngest(course),{source:"course-picker"});syncGpsPipelineState("course-picker-ingested",1);});},450);
        return result;
      };
      window.gdOpenCoursePickerCourse.__gdCoursePlayPipelineWrapped=true;
    }
  }
  function knownHoleNumbers(course,frames){
    var found={};
    Object.keys(course&&course.holes||{}).forEach(function(key){var n=normalizeHoleNumber(key);if(n)found[n]=true;});
    (frames||[]).forEach(function(frame){var n=normalizeHoleNumber(frame&&frame.holeNumber);if(n)found[n]=true;});
    return Object.keys(found).map(function(key){return Number(key);}).filter(Boolean).sort(function(a,b){return a-b;});
  }
  function buildDebugSnapshot(courseOrId){
    var active=courseOrId||activeCourseFromApp()||"course";
    var course=getCoursePlayState(active);
    var frames=getCoursePlayFrameIndex(course)||[];
    var frameByHole={};
    frames.forEach(function(frame){frameByHole[String(normalizeHoleNumber(frame&&frame.holeNumber))]=frame;});
    var holes=knownHoleNumbers(course,frames);
    var rows=holes.map(function(holeNumber){
      var hole=normalizeHoleRecord(course,holeNumber,course.holes&&course.holes[String(holeNumber)]||emptyHoleRecord(course,holeNumber));
      var frame=frameByHole[String(holeNumber)]||null;
      var presentation=hole.presentation||{};
      var manifestKey=frame&&frame.manifestKey||presentation.capturedManifestKey||presentation.framePrebuildManifestKey||null;
      var manifestPresent=capturedManifestPresent(manifestKey);
      var anchor=hole.frameAnchors||{};
      return {
        holeNumber:holeNumber,
        pipelineState:hole.status,
        hasTee:!!hole.teePoint,
        hasGreen:!!hole.greenCentre,
        hasRoute:!!(hole.routePoints&&hole.routePoints.length>=2),
        hasFrameAnchors:!!(anchor.tee&&anchor.green&&(anchor.route&&anchor.route.length>=2||hole.routePoints&&hole.routePoints.length>=2)),
        hasFrameIndexEntry:!!frame,
        frameIndexKey:frame&&frame.frameIndexKey||presentation.frameIndexKey||presentation.framePrebuildFrameIndexKey||null,
        capturedManifestKey:manifestKey,
        capturedManifestPresent:manifestPresent,
        lastGeneratedAt:frame&&frame.updatedAt||hole.updatedAt||null,
        lastRenderedAt:safe(function(){return document.body&&document.body.dataset.gdCoursePlayFrameRenderedHole===String(holeNumber)?document.body.dataset.gdCoursePlayFrameRenderedAt:null;},null),
        framePrebuildStatus:presentation.framePrebuildStatus||"not_started",
        framePrebuildStep:presentation.framePrebuildLastStep||"",
        framePrebuildError:presentation.framePrebuildLastError||"",
        framePrebuildRetryCount:Number(presentation.framePrebuildRetryCount||0)||0,
        framePrebuildAttempts:Number(presentation.framePrebuildAttempts||0)||0,
        framePrebuildLastAt:presentation.framePrebuildLastAt||presentation.framePrebuildUpdatedAt||null,
        framePrebuildNextRetryAt:presentation.framePrebuildNextRetryAt||null,
        framePrebuildManifestKey:presentation.framePrebuildManifestKey||presentation.capturedManifestKey||null,
        framePrebuildFrameIndexKey:presentation.framePrebuildFrameIndexKey||presentation.frameIndexKey||null,
        source:hole.source||frame&&frame.generatedFrom||"unknown",
        syncStatus:hole.syncStatus||"local",
        updatedAt:hole.updatedAt||null,
        lastError:presentation.framePrebuildLastError||hole.unavailableReason||hole.invalidationReason||course.lastError||null
      };
    });
    var syncQueue=getCoursePlaySyncQueue();
    var timeline=loadDebugLog();
    var adapter=course.adapter||{};
    var frameQueue=framePrebuildQueues[course.courseId]||null;
    var completeRows=rows.filter(function(row){return row.framePrebuildStatus==="complete"||(row.hasFrameIndexEntry&&row.capturedManifestPresent);});
    var retryRows=rows.filter(function(row){return row.framePrebuildStatus==="retry_pending";});
    var failedRows=rows.filter(function(row){return row.framePrebuildStatus==="failed";});
    var buildingRows=rows.filter(function(row){return ["queued","building_manifest","manifest_written","frame_index_registered"].indexOf(row.framePrebuildStatus)!==-1;});
    var missingRows=rows.filter(function(row){return row.pipelineState===HOLE_STATES.play_data_ready&&!(row.hasFrameIndexEntry&&row.capturedManifestPresent)&&["queued","building_manifest","manifest_written","frame_index_registered","retry_pending","failed"].indexOf(row.framePrebuildStatus)===-1;});
    var prebuildSummary=failedRows.length&&failedRows.length===1&&!retryRows.length&&!buildingRows.length?
      "complete except H"+failedRows[0].holeNumber+" - "+(failedRows[0].framePrebuildStep||"prebuild failed")+": "+(failedRows[0].framePrebuildError||failedRows[0].lastError||"unknown"):
      [
        completeRows.length?(completeRows.length+" complete"):"",
        retryRows.length?(retryRows.length+" retrying"):"",
        failedRows.length?(failedRows.length+" failed"):"",
        buildingRows.length?(buildingRows.length+" building"):"",
        missingRows.length?(missingRows.length+" missing"):""
      ].filter(Boolean).join(", ");
    if(!prebuildSummary)prebuildSummary=frameQueue?frameQueue.running?"running":"queued":"idle";
    var lastAutoEvent=timeline.slice().reverse().filter(function(event){return /^automapper/.test(String(event&&event.type||""));})[0]||null;
    var automapperStatus=adapter.holesChecked?"complete":lastAutoEvent&&lastAutoEvent.type==="automapper-started"?"running":lastAutoEvent&&lastAutoEvent.type==="automapper-ingest-started"?"running":lastAutoEvent&&lastAutoEvent.type==="automapper-completed"?"complete":"unknown";
    return {
      generatedAt:now(),
      storageKeys:{pipeline:STORE_KEY,frameIndex:FRAME_INDEX_KEY,syncQueue:SYNC_QUEUE_KEY,debugLog:DEBUG_LOG_KEY},
      activeCourseKey:course.courseKey||course.courseId,
      activeCourseName:course.courseName,
      activeHole:activeHoleFromApp(),
      automapperStatus:automapperStatus,
      holesScanned:Number(adapter.holesChecked||0)||rows.length,
      holesSaved:Number(adapter.holesIngested||0)||rows.filter(function(row){return row.hasTee||row.hasGreen||row.hasRoute;}).length,
      pipelineCourseStatus:course.status,
      totalHolesKnown:rows.length,
      holesWithPlayDataReady:rows.filter(function(row){return row.pipelineState===HOLE_STATES.play_data_ready;}).length,
      holesWithFrameIndexEntries:rows.filter(function(row){return row.hasFrameIndexEntry;}).length,
      holesWithCapturedManifestsPresent:rows.filter(function(row){return row.capturedManifestPresent;}).length,
      holesWithFramePrebuildComplete:completeRows.length,
      holesWithFramePrebuildRetryPending:retryRows.length,
      holesWithFramePrebuildFailed:failedRows.length,
      holesWithFramePrebuildBuilding:buildingRows.length,
      holesWithFramePrebuildMissing:missingRows.length,
      framePrebuildSummary:prebuildSummary,
      framePrebuildStatus:frameQueue?frameQueue.running?"running":"queued":"idle",
      framePrebuildQueued:frameQueue&&frameQueue.holes?frameQueue.holes.length:0,
      framePrebuildRunningHole:frameQueue&&frameQueue.runningHole||null,
      framePrebuildRunningAttempt:frameQueue&&frameQueue.runningAttempt||0,
      framePrebuildCompleted:frameQueue&&frameQueue.completed||0,
      framePrebuildFailed:frameQueue&&frameQueue.failed||0,
      framePrebuildRetried:frameQueue&&frameQueue.retried||0,
      syncQueueItemCount:(syncQueue.items||[]).length,
      rows:rows,
      timeline:timeline
    };
  }

  window.GDCoursePlayPipeline={
    version:VERSION,
    schemaVersion:SCHEMA_VERSION,
    storageKey:STORE_KEY,
    frameIndexStorageKey:FRAME_INDEX_KEY,
    syncQueueStorageKey:SYNC_QUEUE_KEY,
    courseStates:COURSE_STATES,
    holeStates:HOLE_STATES,
    prepareCourseForPlay:prepareCourseForPlay,
    ingestMappedHole:ingestMappedHole,
    ingestMappedCourse:ingestMappedCourse,
    getCoursePlayState:getCoursePlayState,
    getHolePlayState:getHolePlayState,
    ensureHolePlayData:ensureHolePlayData,
    saveCoursePlayPipeline:saveCoursePlayPipeline,
    loadCoursePlayPipeline:loadCoursePlayPipeline,
    markHolePlayDataReady:markHolePlayDataReady,
    markHolePlayDataUnavailable:markHolePlayDataUnavailable,
    markCoursePlaySyncPending:markCoursePlaySyncPending,
    registerCoursePlayFrame:registerCoursePlayFrame,
    getCoursePlayFrameIndex:getCoursePlayFrameIndex,
    loadCoursePlayFrameIndex:loadFrameIndex,
    prebuildCoursePlayFrame:gdPrebuildCoursePlayFrame,
    gdPrebuildCoursePlayFrame:gdPrebuildCoursePlayFrame,
    queueFramePrebuild:queueFramePrebuild,
    gdQueueCoursePlayFramePrebuild:queueFramePrebuild,
    buildHolePlayDbPayload:buildHolePlayDbPayload,
    buildCoursePlayDbPayload:buildCoursePlayDbPayload,
    buildCoursePlaySyncEnvelope:buildCoursePlaySyncEnvelope,
    enqueueCoursePlaySync:enqueueCoursePlaySync,
    getCoursePlaySyncQueue:getCoursePlaySyncQueue,
    markCoursePlaySyncQueueItem:markCoursePlaySyncQueueItem,
    exportCoursePlayPayload:exportCoursePlayPayload,
    importCoursePlayPayload:importCoursePlayPayload,
    futureSyncSnapshot:futureSyncSnapshot,
    normalizeMappedHoleData:normalizeMappedHoleData,
    ingestCourseLibraryCourse:ingestCourseLibraryCourse,
    prepareCourseFromCourseLibrary:prepareCourseFromCourseLibrary,
    installCourseLibraryAdapter:installCourseLibraryAdapter,
    holeRecordToMappedData:holeRecordToMappedData,
    ensureActiveHolePlayData:ensureActiveHolePlayData,
    getActiveHolePlayState:getActiveHolePlayState,
    getActiveHoleMappedData:getActiveHoleMappedData,
    installGpsPlayAdapter:installGpsPlayAdapter,
    syncGpsPipelineState:syncGpsPipelineState,
    recordDebugEvent:recordDebugEvent,
    getDebugTimeline:loadDebugLog,
    clearDebugTimeline:clearDebugLog,
    buildDebugSnapshot:buildDebugSnapshot
  };
  window.__gdDumpCoursePlayPersistence=function(courseId){
    var course=courseId||activeCourseFromApp()||"course";
    return {
      storageKey:STORE_KEY,
      frameIndexStorageKey:FRAME_INDEX_KEY,
      syncQueueStorageKey:SYNC_QUEUE_KEY,
      course:loadCoursePlayPipeline(course),
      dbPayload:buildCoursePlayDbPayload(course),
      frameIndex:getCoursePlayFrameIndex(course),
      syncQueue:getCoursePlaySyncQueue(),
      debugSnapshot:buildDebugSnapshot(course)
    };
  };
  window.__gdExportCoursePlayPayload=function(courseId){
    return exportCoursePlayPayload(courseId||activeCourseFromApp()||"course");
  };
  window.__gdDumpCoursePlayFrameIndex=function(courseId,holeNumber){
    return getCoursePlayFrameIndex(courseId,holeNumber);
  };
  window.__gdQueueCoursePlayFramePrebuild=function(courseId,opts){
    return queueFramePrebuild(courseId||activeCourseFromApp()||"course",opts||{source:"manual-debug"});
  };
  window.__gdPrebuildCoursePlayFrame=function(courseId,holeNumber,opts){
    return gdPrebuildCoursePlayFrame(courseId||activeCourseFromApp()||"course",holeNumber||activeHoleFromApp(),opts||{source:"manual-debug",force:true});
  };
  window.__gdDumpCoursePlayTimeline=function(){
    return loadDebugLog();
  };
  window.__gdClearCoursePlayDebugLog=function(){
    return clearDebugLog();
  };
  setTimeout(installCourseLibraryAdapter,0);
  setTimeout(installCourseLibraryAdapter,800);
  setTimeout(installGpsPlayAdapter,1200);
  setTimeout(installGpsPlayAdapter,2600);
  setTimeout(installGpsPlayAdapter,5200);
  setInterval(function(){syncGpsPipelineState("interval");},1500);
})();

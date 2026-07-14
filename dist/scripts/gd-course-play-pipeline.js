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
  var interactiveFallbackStartedByKey={};
  var pipelineMappingRunByKey={};
  var lastPipelineIdentityCorrectionByKey={};

  function now(){return new Date().toISOString();}
  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function clone(value){return safe(function(){return JSON.parse(JSON.stringify(value));},value);}
  function slug(value){return String(value||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,120)||"course";}
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
    writable.holes[String(holeNumber)]=Object.assign(hole,{
      presentation:Object.assign({},hole.presentation||{},{
        capturedManifestKey:manifestKey,
        capturedSurfaceReady:true,
        owner:"gps-play",
        frameStatus:record.frameStatus,
        frameIndexKey:key,
        frameCacheStatus:record.cacheStatus,
        generatedFrom:record.generatedFrom
      }),
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
  function mappingDebugApi(){
    return safe(function(){return window.GDCourseMappingDebug&&typeof window.GDCourseMappingDebug.recordEvent==="function"?window.GDCourseMappingDebug:null;},null);
  }
  function mappingCourseSnapshot(course,state){
    var api=courseLibraryApi();
    var seed=course||state||activeCourseFromGlobals()||null;
    var snapshot=safe(function(){return typeof api.mappingCourseSnapshot==="function"?api.mappingCourseSnapshot(seed):null;},null);
    if(snapshot)return snapshot;
    var id=state&&state.courseId||courseIdFrom(seed||"course");
    var name=state&&state.courseName||courseNameFrom(seed,id);
    return Object.assign({}, seed&&typeof seed==="object"?seed:{}, {courseId:id, courseName:name, name:name});
  }
  function snapshotCourseId(snapshot,course,state){
    return courseIdFrom(snapshot||course||state||"course");
  }
  function pipelineResolutionKey(snapshot,hole){
    return snapshotCourseId(snapshot,null,null)+":h"+String(normalizeHoleNumber(hole));
  }
  function publishPipelineMappingAttempt(entry){
    if(!entry||!entry.debugRunId)return entry;
    pipelineMappingRunByKey[entry.resolutionKey]=entry;
    if(entry.key&&entry.key!==entry.resolutionKey)pipelineMappingRunByKey[entry.key]=entry;
    try{
      var api=courseLibraryApi();
      if(api&&typeof api.activateMappingAttempt==="function")api.activateMappingAttempt(entry);
      else window.__gdCourseMappingDebugActiveAttempt=entry;
    }catch(e){try{window.__gdCourseMappingDebugActiveAttempt=entry;}catch(ignore){}}
    return entry;
  }
  function pipelineMappingAttemptForKey(key){
    var entry=pipelineMappingRunByKey[key];
    if(!entry)return null;
    if(typeof entry==="string")return {debugRunId:entry,runId:entry,resolutionKey:key,key:key};
    return entry;
  }
  function clearPipelineMappingAttempt(key){
    var entry=pipelineMappingAttemptForKey(key);
    delete pipelineMappingRunByKey[key];
    if(entry&&entry.resolutionKey)delete pipelineMappingRunByKey[entry.resolutionKey];
    if(entry&&entry.key)delete pipelineMappingRunByKey[entry.key];
    try{
      var active=window.__gdCourseMappingDebugActiveAttempt;
      if(active&&entry&&active.debugRunId===entry.debugRunId)delete window.__gdCourseMappingDebugActiveAttempt;
    }catch(e){}
  }
  function activeCourseFromGlobals(){
    return safe(function(){return window.gdActiveCourse||window.currentCourse||currentCourse||null;},null);
  }
  function activeResolverForHole(hole){
    var active=window.__gdCoursePlayResolverActive;
    if(!active)return null;
    var activeHole=normalizeHoleNumber(active.hole||hole);
    return activeHole===normalizeHoleNumber(hole)?active:null;
  }
  function recordMappingDebug(runId,event){
    var api=mappingDebugApi();
    if(!api||!runId)return null;
    return safe(function(){return api.recordEvent(runId,event);},null);
  }
  function pipelineMappingAttempt(key,course,state,hole,reason){
    var active=activeResolverForHole(hole);
    if(active&&active.debugRunId){
      return publishPipelineMappingAttempt({
        debugRunId:active.debugRunId,
        runId:active.debugRunId,
        source:"course-play-resolver",
        course:active.course||course||null,
        courseId:active.courseId||courseIdFrom(active.course||course||state||"course"),
        courseName:active.courseName||courseNameFrom(active.course||course||state,"Course"),
        courseCentre:active.courseCentre||null,
        hole:normalizeHoleNumber(hole),
        selectedAt:active.selectedAt||null,
        attemptToken:active.attemptToken||"",
        resolutionKey:active.key||key,
        key:key,
        at:active.at||Date.now()
      });
    }
    var existing=pipelineMappingAttemptForKey(key);
    if(existing)return publishPipelineMappingAttempt(existing);
    var api=mappingDebugApi();
    if(!api||typeof api.startRun!=="function")return null;
    var snapshot=mappingCourseSnapshot(course,state);
    var selectedAt=now();
    var attemptToken="pipeline:"+key+":"+Date.now();
    var runId=safe(function(){return api.startRun({
      course:snapshot,
      courseId:snapshot.courseId||courseIdFrom(snapshot),
      courseName:snapshot.courseName||snapshot.name||courseNameFrom(snapshot,"Course"),
      courseCentre:snapshot.courseCentre||snapshot.center||snapshot.centre||null,
      selectedAt:selectedAt,
      attemptToken:attemptToken,
      invokedBy:reason||"course-play-pipeline"
    });},"");
    if(runId){
      var entry={
        debugRunId:runId,
        runId:runId,
        source:"course-play-pipeline",
        course:snapshot,
        courseId:snapshot.courseId||courseIdFrom(snapshot),
        courseName:snapshot.courseName||snapshot.name||courseNameFrom(snapshot,"Course"),
        courseCentre:snapshot.courseCentre||null,
        hole:normalizeHoleNumber(hole),
        selectedAt:selectedAt,
        attemptToken:attemptToken,
        resolutionKey:key,
        key:key,
        at:Date.now()
      };
      publishPipelineMappingAttempt(entry);
      recordMappingDebug(runId,{source:"course-loader",phase:"started",event:"pipeline-wait-started",summary:"Pipeline wait started",details:{
        courseId:snapshot.courseId||courseIdFrom(snapshot),
        courseName:snapshot.courseName||snapshot.name||courseNameFrom(snapshot,"Course"),
        courseCentre:snapshot.courseCentre||null,
        hole:hole,
        selectedAt:selectedAt,
        attemptToken:attemptToken,
        invokedBy:reason||"course-play-pipeline",
          requestedNextTool:"automapper"
      }});
      return entry;
    }
    return null;
  }
  function pipelineMappingRun(key,course,state,hole,reason){
    var entry=pipelineMappingAttempt(key,course,state,hole,reason);
    return entry&&entry.debugRunId||"";
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
  function activeCourseFromApp(){
    var live=activeCourseFromGlobals();
    var seed=live||resolveCourseFromLibrary(null);
    return seed?(mappingCourseSnapshot(seed,null)||seed):null;
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
  function interactiveGreenFallbackActive(){
    return !!(window.__gdCoursePlayInteractiveFallbackActive||(document.body&&document.body.classList.contains("gdGpsInteractiveGreenFallbackActive")));
  }
  function coursePlayResolverActive(hole){
    var active=window.__gdCoursePlayResolverActive;
    if(!active)return false;
    var activeHole=normalizeHoleNumber(active.hole||hole);
    return activeHole===normalizeHoleNumber(hole);
  }
  function courseResolutionOwnerActive(hole){
    return coursePlayResolverActive(hole)||interactiveGreenFallbackActive();
  }
  function triggerInteractiveGreenFallback(course,hole,reason,state){
    var snapshot=mappingCourseSnapshot(course,state);
    var key=pipelineResolutionKey(snapshot,hole);
    if(interactiveGreenFallbackActive())return true;
    if(interactiveFallbackStartedByKey[key]&&Date.now()-interactiveFallbackStartedByKey[key]<60000)return true;
    if(typeof window.gdBeginInteractiveGreenFallback!=="function")return false;
    var active=activeResolverForHole(hole);
    var attempt=pipelineMappingAttempt(key,snapshot,state,hole,reason||"pipeline-timeout");
    var debugRunId=active&&active.debugRunId||attempt&&attempt.debugRunId||"";
    var attemptToken=active&&active.attemptToken||attempt&&attempt.attemptToken||"pipeline:"+key;
    var resolutionKey=active&&active.key||attempt&&attempt.resolutionKey||key;
    recordMappingDebug(debugRunId,{source:"course-loader",phase:"progress",event:"pipeline-timeout",summary:"Pipeline timeout requested manual fallback",details:{
      courseId:snapshot.courseId||state&&state.courseId||courseIdFrom(snapshot||course||"course"),
      courseName:snapshot.courseName||snapshot.name||state&&state.courseName||courseNameFrom(snapshot||course,"Course"),
      courseCentre:snapshot.courseCentre||null,
      hole:hole,
      status:state&&state.status||HOLE_STATES.mapping,
      reason:reason||"pipeline-timeout",
      resolutionKey:resolutionKey,
      attemptToken:attemptToken,
      requestedNextTool:"manual-fallback"
    }});
    interactiveFallbackStartedByKey[key]=Date.now();
    recordDebugEvent("gps-play-pipeline-timeout-fallback",{
      courseId:snapshot.courseId||state&&state.courseId||courseIdFrom(course||"course"),
      courseName:snapshot.courseName||snapshot.name||state&&state.courseName||courseNameFrom(course,"Course"),
      holeNumber:hole,
      status:state&&state.status||HOLE_STATES.mapping,
      reason:reason||"pipeline-timeout"
    });
    safe(function(){window.gdBeginInteractiveGreenFallback(snapshot||course||state||"course",hole,reason||"pipeline-timeout",{debugRunId:debugRunId,resolutionKey:resolutionKey,attemptToken:attemptToken,selectedAt:active&&active.selectedAt||attempt&&attempt.selectedAt||null,reason:"course-play-pipeline-timeout"});});
    return interactiveGreenFallbackActive();
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
    var initialState=getActiveHolePlayState(hole);
    var snapshot=mappingCourseSnapshot(course,initialState);
    var snapshotId=snapshotCourseId(snapshot,course,initialState);
    var initialId=initialState&&initialState.courseId||"";
    var identityCorrected=!!(initialId&&snapshotId&&initialId!==snapshotId);
    var state=identityCorrected?getHolePlayState(snapshot,hole):initialState;
    var status=String(state&&state.status||HOLE_STATES.unknown);
    var fallbackActive=interactiveGreenFallbackActive();
    if(preparingStatus(status)){
      var mapped=mappedHoleFromCourseLibrary(snapshot||course,hole);
      if(mapped&&(Array.isArray(mapped.route)&&mapped.route.length>=2||mapped.green&&mapped.tee)){
        state=ingestMappedHole(snapshot||course||"course",hole,mapped,reason||"pipeline-sync");
        status=String(state&&state.status||HOLE_STATES.unknown);
        fallbackActive=false;
      }
    }
    var key=pipelineResolutionKey(snapshot,hole);
    if(identityCorrected&&lastPipelineIdentityCorrectionByKey[key]!==initialId+"->"+snapshotId){
      lastPipelineIdentityCorrectionByKey[key]=initialId+"->"+snapshotId;
      recordDebugEvent("gps-play-pipeline-course-identity-corrected",{staleCourseId:initialId,correctedCourseId:snapshotId,courseName:snapshot&&snapshot.courseName||courseNameFrom(snapshot||course,"Course"),holeNumber:hole,source:reason||"sync"});
    }
    var syncSig=key+"|"+status+"|"+String(reason||"sync");
    if(gpsActive()&&reason!=="interval"&&lastSyncStatusByKey[key]!==syncSig){
      recordDebugEvent("gps-play-requested-hole",{courseId:snapshotId,courseName:snapshot&&snapshot.courseName||state&&state.courseName||courseNameFrom(snapshot||course,"Course"),holeNumber:hole,status:status,source:reason||"sync"});
    }
    if(preparingStatus(status)){
      if(!preparingSince[key]){
        preparingSince[key]=Date.now();
        var attempt=pipelineMappingAttempt(key,snapshot,state,hole,reason||"pipeline-sync");
        if(identityCorrected&&attempt&&attempt.debugRunId){
          recordMappingDebug(attempt.debugRunId,{source:"course-loader",phase:"progress",event:"pipeline-identity-corrected",summary:"Pipeline request identity corrected",details:{
            staleCourseId:initialId,
            correctedCourseId:snapshotId,
            courseName:snapshot&&snapshot.courseName||"",
            hole:hole,
            resolutionKey:key,
            attemptToken:attempt.attemptToken||"",
            invokedBy:reason||"pipeline-sync"
          }});
        }
      }
      if(courseResolutionOwnerActive(hole)){
        preparingSince[key]=Date.now();
      }else if(Date.now()-preparingSince[key]>=PREPARING_TIMEOUT_MS){
        if(triggerInteractiveGreenFallback(course,hole,"mapped geometry unavailable after pipeline timeout",state)){
          delete preparingSince[key];
          fallbackActive=true;
        }else{
          preparingSince[key]=Date.now();
          recordDebugEvent("gps-play-pipeline-timeout-no-fallback",{
            courseId:snapshotId,
            courseName:snapshot&&snapshot.courseName||state&&state.courseName||courseNameFrom(snapshot||course,"Course"),
            holeNumber:hole,
            status:status,
            reason:"interactive fallback unavailable"
          });
        }
      }
    }else{
      delete preparingSince[key];
      clearPipelineMappingAttempt(key);
    }
    if(fallbackActive)delete preparingSince[key];
    var preparing=gpsActive()&&!fallbackActive&&preparingStatus(status);
    var unavailable=gpsActive()&&!fallbackActive&&unavailableStatus(status);
    document.body.classList.toggle("gdCoursePlayPipelinePreparing",!!preparing);
    document.body.classList.toggle("gdCoursePlayPipelineUnavailable",!!unavailable);
    if(preparing)document.body.classList.add("gdGpsFramePreparing");
    else if(fallbackActive)document.body.classList.remove("gdGpsFramePreparing");
    document.body.dataset.gdCoursePlayPipelineStatus=fallbackActive?"interactive_green_fallback":status;
    document.body.dataset.gdCoursePlayPipelineHole=String(hole);
    document.body.dataset.gdCoursePlayPipelineReason=String(reason||"sync");
    var el=pipelineStatusElement();
    if(el)el.textContent=preparing?"Preparing Hole "+hole+"...":unavailable?"Frame unavailable - remap this hole":"";
    if(gpsActive()){
      var transitionKey=key+"|"+status+"|"+String(!!preparing)+"|"+String(!!unavailable);
      if(lastSyncStatusByKey[key]!==transitionKey){
        if(preparing)recordDebugEvent("gps-play-showed-loading",{courseId:snapshotId,courseName:snapshot&&snapshot.courseName||state&&state.courseName||courseNameFrom(snapshot||course,"Course"),holeNumber:hole,status:status,reason:reason||"sync"});
        else if(unavailable)recordDebugEvent("gps-play-fell-to-unavailable",{courseId:snapshotId,courseName:snapshot&&snapshot.courseName||state&&state.courseName||courseNameFrom(snapshot||course,"Course"),holeNumber:hole,status:status,reason:state&&state.unavailableReason||reason||"unavailable"});
        else if(status===HOLE_STATES.play_data_ready){
          var frame=getCoursePlayFrameIndex(snapshot||state&&state.courseId||course||"course",hole);
          var manifestKey=frame&&frame.manifestKey||state&&state.presentation&&state.presentation.capturedManifestKey||null;
          recordDebugEvent(frame&&capturedManifestPresent(manifestKey)?"gps-play-loaded-existing-frame":"gps-play-data-ready-no-manifest",{courseId:snapshotId,courseName:snapshot&&snapshot.courseName||state&&state.courseName||courseNameFrom(snapshot||course,"Course"),holeNumber:hole,status:status,frameIndexKey:frame&&frame.frameIndexKey||null,manifestKey:manifestKey,manifestPresent:capturedManifestPresent(manifestKey),reason:reason||"sync"});
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
        var library=courseLibraryApi();
        var attempt=opts&&opts.debugAttemptContext||safe(function(){return typeof library.activeMappingDebugAttempt==="function"?library.activeMappingDebugAttempt(course,{hole:opts&&opts.hole||1}):null;},null)||{
          runId:opts&&opts.debugRunId||"",
          debugRunId:opts&&opts.debugRunId||"",
          courseId:courseIdFrom(course||"course"),
          courseName:courseNameFrom(course,"Course"),
          hole:normalizeHoleNumber(opts&&opts.hole||1),
          resolutionKey:opts&&opts.activeResolutionKey||opts&&opts.resolutionKey||"",
          attemptToken:opts&&opts.attemptToken||"",
          source:opts&&opts.reason||opts&&opts.source||"automapper",
          callerFunction:"GDCoursePlayPipeline.gdAutoMapOsmCourse"
        };
	        recordDebugEvent("automapper-started",{source:"automap"});
	        var result=originalAutoMap.apply(this,args);
	        var ingest=function(){safe(function(){
          if(attempt&&typeof library.isCurrentMappingAttempt==="function"&&!library.isCurrentMappingAttempt(attempt)){
            if(window.GDCourseMappingDebug&&typeof window.GDCourseMappingDebug.recordStaleActivity==="function"){
              window.GDCourseMappingDebug.recordStaleActivity({
                staleRunId:attempt.runId||attempt.debugRunId||"",
                stale:{courseId:attempt.courseId,courseName:attempt.courseName,resolutionKey:attempt.resolutionKey,attemptToken:attempt.attemptToken},
                active:window.__gdCourseMappingDebugActiveAttempt||{},
                attemptedAction:"ingest-automapper-output",
                rejectionReason:"active mapping attempt changed",
                callerFunction:"GDCoursePlayPipeline.gdAutoMapOsmCourse.finally",
                source:"automapper",
                event:"automapper-stale-result-rejected",
                summary:"AutoMapper stale result rejected"
              });
            }
            recordDebugEvent("automapper-stale-ingest-rejected",{courseId:attempt.courseId,courseName:attempt.courseName,holeNumber:attempt.hole,source:"automap"});
            return;
          }
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
        if(result&&typeof result.then==="function"){
          Promise.resolve(result).then(function(){
            safe(function(){syncGpsPipelineState("course-selection-resolver-settled",1);});
          },function(){
            safe(function(){syncGpsPipelineState("course-selection-resolver-settled",1);});
          });
        }else{
          setTimeout(function(){safe(function(){
            if(courseResolutionOwnerActive(1))return;
            ingestCourseLibraryCourse(resolveFreshCourseForIngest(course),{source:"course-selection"});
            syncGpsPipelineState("course-selection-ingested",1);
          });},350);
        }
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
        var resolverPromise=null;
        safe(function(){
          if(typeof window.gdResolveCoursePlayHole==="function"){
            var resolvedCourse=resolveFreshCourseForIngest(course)||course;
            resolverPromise=window.gdResolveCoursePlayHole(resolvedCourse,{hole:1,wholeCourse:true,showLoading:true,fresh:true,reason:"course-picker"});
          }
        });
        if(resolverPromise&&typeof resolverPromise.then==="function"){
          Promise.resolve(resolverPromise).then(function(){
            safe(function(){syncGpsPipelineState("course-picker-resolver-settled",1);});
          },function(){
            safe(function(){syncGpsPipelineState("course-picker-resolver-settled",1);});
          });
        }else{
          setTimeout(function(){safe(function(){
            if(courseResolutionOwnerActive(1))return;
            ingestCourseLibraryCourse(resolveFreshCourseForIngest(course),{source:"course-picker"});
            syncGpsPipelineState("course-picker-ingested",1);
          });},450);
        }
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
      var manifestKey=frame&&frame.manifestKey||hole.presentation&&hole.presentation.capturedManifestKey||null;
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
        frameIndexKey:frame&&frame.frameIndexKey||hole.presentation&&hole.presentation.frameIndexKey||null,
        capturedManifestKey:manifestKey,
        capturedManifestPresent:manifestPresent,
        lastGeneratedAt:frame&&frame.updatedAt||hole.updatedAt||null,
        lastRenderedAt:safe(function(){return document.body&&document.body.dataset.gdCoursePlayFrameRenderedHole===String(holeNumber)?document.body.dataset.gdCoursePlayFrameRenderedAt:null;},null),
        source:hole.source||frame&&frame.generatedFrom||"unknown",
        syncStatus:hole.syncStatus||"local",
        updatedAt:hole.updatedAt||null,
        lastError:hole.unavailableReason||hole.invalidationReason||course.lastError||null
      };
    });
    var syncQueue=getCoursePlaySyncQueue();
    var timeline=loadDebugLog();
    var adapter=course.adapter||{};
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

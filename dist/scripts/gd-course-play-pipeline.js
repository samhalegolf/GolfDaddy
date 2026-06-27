(function(){
  if(window.GDCoursePlayPipeline&&window.GDCoursePlayPipeline.version)return;

  var VERSION=1;
  var SCHEMA_VERSION=1;
  var STORE_KEY="gd_course_play_pipeline_v1";
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

  function now(){return new Date().toISOString();}
  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function clone(value){return safe(function(){return JSON.parse(JSON.stringify(value));},value);}
  function slug(value){return String(value||"course").replace(/[^a-z0-9:_-]+/gi,"_").slice(0,120)||"course";}
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
    return slug(courseOrId&&(courseOrId.key||courseOrId.id||courseOrId.name||courseOrId.courseName||courseOrId.courseId)||"course");
  }
  function courseIdCandidates(courseOrId){
    if(typeof courseOrId==="string"||typeof courseOrId==="number")return [slug(courseOrId)];
    var raw=[
      courseOrId&&courseOrId.key,
      courseOrId&&courseOrId.id,
      courseOrId&&courseOrId.courseId,
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
    return {schema:"gd.course_play_pipeline.store",version:VERSION,schemaVersion:SCHEMA_VERSION,updatedAt:null,courses:{}};
  }
  function normalizeStore(raw){
    var store=raw&&typeof raw==="object"?raw:emptyStore();
    store.schema="gd.course_play_pipeline.store";
    store.version=VERSION;
    store.schemaVersion=SCHEMA_VERSION;
    if(!store.courses||typeof store.courses!=="object")store.courses={};
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
      lastError:null
    },existing);
    record.courseId=courseId;
    record.courseKey=record.courseKey||courseId;
    record.courseName=courseNameFrom(courseOrId,record.courseName||courseId);
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
      presentation:{capturedManifestKey:null,capturedSurfaceReady:false,owner:"gps-play"},
      source:"local",
      confidence:"unknown",
      unavailableReason:null,
      createdAt:stamp,
      updatedAt:stamp,
      syncStatus:"local",
      remoteId:null
    };
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
    record.presentation={capturedManifestKey:null,capturedSurfaceReady:!!playable,owner:"gps-play"};
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
    return clone(course);
  }
  function ingestMappedHole(courseOrId,holeNumber,mappedData,source){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    holeNumber=normalizeHoleNumber(holeNumber);
    var existing=course.holes[String(holeNumber)]||{};
    var record=Object.assign(emptyHoleRecord(course,holeNumber),existing,normalizeMappedHoleData(course,holeNumber,mappedData,source));
    record.createdAt=existing.createdAt||record.createdAt;
    record.updatedAt=now();
    course.holes[String(holeNumber)]=record;
    delete preparingSince[String(course.courseId)+":h"+String(holeNumber)];
    return writeCourse(course,store).holes[String(holeNumber)];
  }
  function ingestMappedCourse(courseOrId,mappedCourseData,source){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    var holes=Array.isArray(mappedCourseData)?mappedCourseData:(mappedCourseData&&mappedCourseData.holes)||[];
    holes.forEach(function(item,index){
      var holeNumber=normalizeHoleNumber(item&&item.hole||item&&item.holeNumber||index+1);
      course.holes[String(holeNumber)]=Object.assign(emptyHoleRecord(course,holeNumber),normalizeMappedHoleData(course,holeNumber,item,source));
    });
    return writeCourse(course,store);
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
    var record=Object.assign(existing,clone(data||{}),{status:HOLE_STATES.play_data_ready,updatedAt:now(),unavailableReason:null});
    course.holes[String(holeNumber)]=record;
    delete preparingSince[String(course.courseId)+":h"+String(holeNumber)];
    return writeCourse(course,store).holes[String(holeNumber)];
  }
  function markHolePlayDataUnavailable(courseOrId,holeNumber,reason){
    var store=loadStore();
    var course=courseRecord(courseOrId,store);
    holeNumber=normalizeHoleNumber(holeNumber);
    var existing=course.holes[String(holeNumber)]||emptyHoleRecord(course,holeNumber);
    existing.status=HOLE_STATES.play_data_unavailable;
    existing.unavailableReason=String(reason||"unavailable");
    existing.updatedAt=now();
    course.holes[String(holeNumber)]=existing;
    delete preparingSince[String(course.courseId)+":h"+String(holeNumber)];
    return writeCourse(course,store).holes[String(holeNumber)];
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
        var result=originalAutoMap.apply(this,args);
        var ingest=function(){safe(function(){ingestCourseLibraryCourse(course||resolveCourseFromLibrary(null),{source:"automap"});});};
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
        setTimeout(function(){safe(function(){ingestCourseLibraryCourse(course||resolveCourseFromLibrary(null),{source:"course-selection"});syncGpsPipelineState("course-selection-ingested",1);});},350);
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
        setTimeout(function(){safe(function(){ingestCourseLibraryCourse(course||resolveCourseFromLibrary(null),{source:"course-picker"});syncGpsPipelineState("course-picker-ingested",1);});},450);
        return result;
      };
      window.gdOpenCoursePickerCourse.__gdCoursePlayPipelineWrapped=true;
    }
  }

  window.GDCoursePlayPipeline={
    version:VERSION,
    schemaVersion:SCHEMA_VERSION,
    storageKey:STORE_KEY,
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
    syncGpsPipelineState:syncGpsPipelineState
  };
  setTimeout(installCourseLibraryAdapter,0);
  setTimeout(installCourseLibraryAdapter,800);
  setTimeout(installGpsPlayAdapter,1200);
  setTimeout(installGpsPlayAdapter,2600);
  setTimeout(installGpsPlayAdapter,5200);
  setInterval(function(){syncGpsPipelineState("interval");},1500);
})();

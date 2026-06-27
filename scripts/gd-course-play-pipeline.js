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
    var record=emptyHoleRecord(course,holeNumber,route.length>=2&&green?HOLE_STATES.mapped_geometry_ready:HOLE_STATES.mapping);
    record.teePoint=tee||null;
    record.greenCentre=green||null;
    record.greenShape=greenShape;
    record.greenBounds=deriveBounds(greenShape,green);
    record.fairwayPoints=fairwayPoints;
    record.routePoints=route;
    record.frameAnchors={tee:tee||null,green:green||null,route:route,greenShape:greenShape};
    record.presentation={capturedManifestKey:null,capturedSurfaceReady:false,owner:"gps-play"};
    record.source=source||mappedData.source||"automap";
    record.confidence=route.length>=2&&green?"mapped_geometry":"incomplete";
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
    var course=store.courses[courseIdFrom(courseOrId)];
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
        var result=originalOpenCourseToFirstHole.apply(this,arguments);
        setTimeout(function(){safe(function(){ingestCourseLibraryCourse(course||resolveCourseFromLibrary(null),{source:"course-selection"});});},350);
        return result;
      };
      window.gdOpenCourseToFirstHole.__gdCoursePlayPipelineWrapped=true;
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
    installCourseLibraryAdapter:installCourseLibraryAdapter
  };
  setTimeout(installCourseLibraryAdapter,0);
  setTimeout(installCourseLibraryAdapter,800);
})();

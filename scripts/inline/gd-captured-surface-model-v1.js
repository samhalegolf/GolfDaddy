/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  if(window.__gdCapturedSurfaceModelV1)return;
  window.__gdCapturedSurfaceModelV1=true;
  var VERSION=1;
  var STORE_KEY="gd_captured_surface_scans_v1";
  var OUTBOX_KEY="gd_captured_surface_supabase_outbox_v1";
  var MAX_SCANS=48;
  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function clone(value){return safe(function(){return JSON.parse(JSON.stringify(value));},value);}
  function slug(value){return String(value||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,90)||"course";}
  function point(value){
    if(!value)return null;
    var lat=Number(value.lat!==undefined?value.lat:value.latitude);
    var lng=Number(value.lng!==undefined?value.lng:(value.lon!==undefined?value.lon:value.longitude));
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat:lat,lng:lng}:null;
  }
  function cleanPins(pins){
    pins=pins||{};
    function points(list){return (Array.isArray(list)?list:[]).map(point).filter(Boolean);}
    return {
      tee:point(pins.tee),
      green:point(pins.green),
      route:points(pins.route),
      greenShape:points(pins.greenShape)
    };
  }
  function currentCourseKey(fallback){
    return slug(safe(function(){return (currentCourse&&(currentCourse.key||currentCourse.id||currentCourse.name))||document.body.dataset.gdActiveCourseName;},null)||fallback||"course");
  }
  function currentHoleNumber(fallback){
    return Number(safe(function(){return currentPlayingHole||selectedHole||gdMappedStartHoleNumber&&gdMappedStartHoleNumber();},null)||fallback||1)||1;
  }
  function activeKey(courseKey,holeNumber){
    return "gd_captured_surface_active_v1_"+slug(courseKey)+":h"+(Number(holeNumber)||1);
  }
  function readRegistry(){
    var parsed=safe(function(){return JSON.parse(localStorage.getItem(STORE_KEY)||"null");},null);
    if(!parsed||typeof parsed!=="object")parsed={version:VERSION,updatedAt:null,scans:[]};
    if(!Array.isArray(parsed.scans))parsed.scans=[];
    return parsed;
  }
  function writeRegistry(registry){
    registry.version=VERSION;
    registry.updatedAt=new Date().toISOString();
    registry.scans=(Array.isArray(registry.scans)?registry.scans:[]).slice(0,MAX_SCANS);
    safe(function(){localStorage.setItem(STORE_KEY,JSON.stringify(registry));});
    return registry;
  }
  function stableId(manifest,courseKey,holeNumber){
    var origin=manifest&&manifest.originPx||{};
    var z=Number(manifest&&manifest.captureZoom)||0;
    var w=Number(manifest&&manifest.imageWidth)||0;
    var h=Number(manifest&&manifest.imageHeight)||0;
    return slug(courseKey)+":h"+(Number(holeNumber)||1)+":z"+z+":"+Math.round(Number(origin.x)||0)+"_"+Math.round(Number(origin.y)||0)+":"+Math.round(w)+"x"+Math.round(h);
  }
  function manifestKey(courseKey,holeNumber){
    return "gd_captured_hole_frame_v19_"+slug(String(courseKey||"course")+":h"+(Number(holeNumber)||1));
  }
  function normalizeManifest(manifest,opts){
    manifest=clone(manifest||{});
    opts=opts||{};
    var courseKey=slug(manifest.courseKey||opts.courseKey||currentCourseKey());
    var holeNumber=Number(manifest.holeNumber||opts.holeNumber||currentHoleNumber())||1;
    var legacyKey=manifest.key||opts.storageKey||manifestKey(courseKey,holeNumber);
    var pins=cleanPins(manifest.anchorPins);
    manifest.surfaceModel="captured-surface-v1";
    manifest.interactionOwner="captured-surface";
    manifest.liveMapRole="capture-source-diagnostic-reference";
    manifest.courseKey=courseKey;
    manifest.courseName=manifest.courseName||safe(function(){return currentCourse&&(currentCourse.name||currentCourse.title||currentCourse.key||currentCourse.id);},"Course")||"Course";
    manifest.holeNumber=holeNumber;
    manifest.key=legacyKey;
    manifest.anchorPins=pins;
    manifest.includeTee=!!pins.tee;
    manifest.teeLatLng=pins.tee||null;
    manifest.updatedAt=new Date().toISOString();
    if(!manifest.createdAt)manifest.createdAt=manifest.updatedAt;
    return manifest;
  }
  function compactStoredManifest(manifest){
    var compact=clone(manifest||{});
    compact.tileCount=Array.isArray(compact.tiles)?compact.tiles.length:Number(compact.tileCount)||0;
    compact.tiles=[];
    return compact;
  }
  function normalizeScan(manifest,opts){
    manifest=normalizeManifest(manifest,opts);
    var courseKey=manifest.courseKey;
    var holeNumber=manifest.holeNumber;
    var id=stableId(manifest,courseKey,holeNumber);
    return {
      schema:"gd.captured_surface.scan",
      version:VERSION,
      id:id,
      courseKey:courseKey,
      courseName:manifest.courseName,
      holeNumber:holeNumber,
      createdAt:manifest.createdAt,
      updatedAt:manifest.updatedAt,
      reason:opts&&opts.reason||manifest.reason||"capture",
      status:{latest:true,confidence:"local-scan",trusted:false},
      interaction:{owner:"captured-surface",liveMapRole:"capture-source-diagnostic-reference"},
      source:{type:"leaflet-tile-capture",captureZoom:manifest.captureZoom,tileCount:Array.isArray(manifest.tiles)?manifest.tiles.length:0},
      projection:{type:"leaflet-pixel-origin",captureZoom:manifest.captureZoom,originPx:manifest.originPx||null,imageWidth:manifest.imageWidth||0,imageHeight:manifest.imageHeight||0},
      pins:cleanPins(manifest.anchorPins),
      storage:{registryKey:STORE_KEY,activeKey:activeKey(courseKey,holeNumber),legacyManifestKey:manifest.key},
      manifest:compactStoredManifest(manifest)
    };
  }
  function writeScan(manifest,opts){
    if(!manifest||!Array.isArray(manifest.tiles)||!manifest.originPx)return manifest;
    var scan=normalizeScan(manifest,opts||{});
    scan.manifest.scanId=scan.id;
    scan.manifest.activeScanId=scan.id;
    var legacyManifest=normalizeManifest(manifest,opts||{});
    legacyManifest.scanId=scan.id;
    legacyManifest.activeScanId=scan.id;
    var registry=readRegistry();
    registry.scans=registry.scans.filter(function(item){
      return item&&item.id!==scan.id&&!(item.courseKey===scan.courseKey&&Number(item.holeNumber)===Number(scan.holeNumber)&&item.status&&item.status.latest===true);
    });
    registry.scans.unshift(scan);
    writeRegistry(registry);
    safe(function(){localStorage.setItem(activeKey(scan.courseKey,scan.holeNumber),scan.id);});
    safe(function(){localStorage.setItem(scan.storage.legacyManifestKey,JSON.stringify(legacyManifest));});
    window.gdCapturedSurfaceActiveScan=scan;
    window.gdCapturedSurfaceActiveManifest=legacyManifest;
    safe(function(){
      if(document.body){
        document.body.dataset.gdCapturedSurfaceOwner="captured-surface";
        document.body.dataset.gdLiveMapRole="capture-source-diagnostic-reference";
        document.body.dataset.gdCapturedSurfaceScanId=scan.id;
        document.body.dataset.gdCapturedSurfaceHole=String(scan.holeNumber);
        document.body.dataset.gdCapturedSurfaceRoutePins=String((scan.pins.route||[]).length);
      }
    });
    return legacyManifest;
  }
  function findScan(courseKey,holeNumber){
    courseKey=currentCourseKey(courseKey);
    holeNumber=currentHoleNumber(holeNumber);
    var registry=readRegistry();
    var wanted=safe(function(){return localStorage.getItem(activeKey(courseKey,holeNumber));},null);
    return registry.scans.find(function(scan){return scan&&scan.id===wanted;})||
      registry.scans.find(function(scan){return scan&&scan.courseKey===courseKey&&Number(scan.holeNumber)===Number(holeNumber);})||
      null;
  }
  function readManifest(courseKey,holeNumber){
    var scan=findScan(courseKey,holeNumber);
    var key=manifestKey(currentCourseKey(courseKey),currentHoleNumber(holeNumber));
    var legacy=safe(function(){return JSON.parse(localStorage.getItem(key)||"null");},null);
    if(legacy&&Array.isArray(legacy.tiles)&&legacy.originPx)return legacy;
    var scanKey=scan&&scan.storage&&scan.storage.legacyManifestKey;
    if(scanKey&&scanKey!==key){
      legacy=safe(function(){return JSON.parse(localStorage.getItem(scanKey)||"null");},null);
      if(legacy&&Array.isArray(legacy.tiles)&&legacy.originPx)return legacy;
    }
    if(scan&&scan.manifest&&Array.isArray(scan.manifest.tiles)&&scan.manifest.tiles.length&&scan.manifest.originPx)return clone(scan.manifest);
    return null;
  }
  function supabasePayload(scan){
    scan=scan||window.gdCapturedSurfaceActiveScan||findScan();
    if(!scan)return null;
    return {
      client_scan_id:scan.id,
      course_key:scan.courseKey,
      course_name:scan.courseName,
      hole_number:scan.holeNumber,
      source_type:scan.source.type,
      status:scan.status,
      interaction:scan.interaction,
      projection:scan.projection,
      pins:scan.pins,
      manifest:scan.manifest,
      created_at:scan.createdAt,
      updated_at:new Date().toISOString()
    };
  }
  function queueSupabasePayload(scan){
    var payload=supabasePayload(scan);
    if(!payload)return false;
    var rows=safe(function(){return JSON.parse(localStorage.getItem(OUTBOX_KEY)||"[]");},[]);
    if(!Array.isArray(rows))rows=[];
    rows=rows.filter(function(row){return row&&row.client_scan_id!==payload.client_scan_id;});
    rows.unshift(payload);
    safe(function(){localStorage.setItem(OUTBOX_KEY,JSON.stringify(rows.slice(0,36)));});
    return true;
  }
  function clearScan(courseKey,holeNumber){
    courseKey=currentCourseKey(courseKey);
    holeNumber=currentHoleNumber(holeNumber);
    var key=activeKey(courseKey,holeNumber);
    var wanted=safe(function(){return localStorage.getItem(key);},null);
    var registry=readRegistry();
    registry.scans=registry.scans.filter(function(scan){
      return !(scan&&(scan.id===wanted||(scan.courseKey===courseKey&&Number(scan.holeNumber)===Number(holeNumber))));
    });
    writeRegistry(registry);
    safe(function(){localStorage.removeItem(key);});
    safe(function(){localStorage.removeItem(manifestKey(courseKey,holeNumber));});
    if(window.gdCapturedSurfaceActiveScan&&window.gdCapturedSurfaceActiveScan.courseKey===courseKey&&Number(window.gdCapturedSurfaceActiveScan.holeNumber)===Number(holeNumber)){
      delete window.gdCapturedSurfaceActiveScan;
      delete window.gdCapturedSurfaceActiveManifest;
    }
    return true;
  }
  window.gdCapturedSurfaceWriteScan=writeScan;
  window.gdCapturedSurfaceReadScan=findScan;
  window.gdCapturedSurfaceReadManifest=readManifest;
  window.gdCapturedSurfaceSupabasePayload=supabasePayload;
  window.gdQueueCapturedSurfaceSupabasePayload=queueSupabasePayload;
  window.gdCapturedSurfaceClearScan=clearScan;
  window.gdCapturedSurfacePolicy={owner:"captured-surface",liveMapRole:"capture-source-diagnostic-reference",cloudTarget:"supabase"};
})();

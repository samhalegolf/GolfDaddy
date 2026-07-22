/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  if(window.__gdCapturedHoleFrameCameraV19)return;
  window.__gdCapturedHoleFrameCameraV19=true;
  var VERSION="V19_CAPTURED_HOLE_FRAME_CAMERA";
  var nativeFit=null;
  var nativeShowHome=null;
  var nativeOpenChangeCourse=null;
  var captureManifest=null;
  var renderSurfaceOverride=null;
  var lastShotOverlayPayload=null;
	  var lastShotOverlayCenter=null;
	  var lockCameraFrozen=false;
	  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
	  function num(v,fb){v=Number(v);return Number.isFinite(v)?v:fb;}
	  function surfaceIdentity(value){return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"");}
	  function hasMap(){return typeof map!=="undefined"&&map&&typeof L!=="undefined";}
  function asLL(p){
    if(!p||!hasMap())return null;
    if(p.lat!==undefined&&p.lng!==undefined)return L.latLng(num(p.lat,NaN),num(p.lng,NaN));
    if(p.latitude!==undefined&&(p.longitude!==undefined||p.lon!==undefined))return L.latLng(num(p.latitude,NaN),num(p.longitude!==undefined?p.longitude:p.lon,NaN));
    if(Array.isArray(p)&&p.length>=2)return L.latLng(num(p[0],NaN),num(p[1],NaN));
    return null;
  }
  function validLL(p){return !!(p&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng)));}
  function validBounds(b){return !!(b&&typeof b.isValid==="function"&&b.isValid()&&b.getCenter&&b.getSouthWest&&b.getNorthEast);}
  function coerceBounds(b){
    if(validBounds(b))return b;
    if(!b||!hasMap())return null;
    var south=num(b.south!==undefined?b.south:b.minLat,NaN);
    var west=num(b.west!==undefined?b.west:b.minLng,NaN);
    var north=num(b.north!==undefined?b.north:b.maxLat,NaN);
    var east=num(b.east!==undefined?b.east:b.maxLng,NaN);
    if(!Number.isFinite(south)||!Number.isFinite(west)||!Number.isFinite(north)||!Number.isFinite(east))return null;
    return safe(function(){return L.latLngBounds([[south,west],[north,east]]);},null);
  }
  function boundsFromPoints(points){
    if(!hasMap())return null;
    var arr=(Array.isArray(points)?points:[]).map(asLL).filter(validLL);
    return arr.length?L.latLngBounds(arr):null;
  }
  function pointBounds(point,radiusM){
    var c=asLL(point); if(!validLL(c)||!hasMap())return null;
    var r=Math.max(5,num(radiusM,22));
    var latRad=c.lat*Math.PI/180, dLat=r/111320, dLng=r/(111320*Math.max(.18,Math.cos(latRad)));
    return L.latLngBounds([[c.lat-dLat,c.lng-dLng],[c.lat+dLat,c.lng+dLng]]);
  }
  function boundsCorners(b){
    if(!validBounds(b))return [];
    var sw=b.getSouthWest(), ne=b.getNorthEast();
    return [sw,ne,L.latLng(ne.lat,sw.lng),L.latLng(sw.lat,ne.lng)];
  }
  function boundsSizeM(b){
    if(!validBounds(b)||!hasMap())return {w:0,h:0,diag:0};
    var sw=b.getSouthWest(), ne=b.getNorthEast(), nw=L.latLng(ne.lat,sw.lng);
    var w=safe(function(){return map.distance(nw,ne);},0);
    var h=safe(function(){return map.distance(nw,sw);},0);
    return {w:w,h:h,diag:Math.sqrt(w*w+h*h)};
  }
  function mappedPoint(point){return safe(function(){return typeof gdMappedPointToLatLng==="function"?gdMappedPointToLatLng(point):asLL(point);},null)||asLL(point);}
  function mappedPayload(){
    if(renderSurfaceOverride&&renderSurfaceOverride.data&&Array.isArray(renderSurfaceOverride.data.route)&&renderSurfaceOverride.data.route.length>=2){
      return {course:renderSurfaceOverride.course||renderSurfaceOverride.courseKey||null,hole:surfaceHoleNumber(),data:renderSurfaceOverride.data,source:renderSurfaceOverride.source||"course-play-frame-warmup"};
    }
    var payload=safe(function(){return typeof gdActiveMappedHolePlayData==="function"&&gdActiveMappedHolePlayData();},null)||null;
    if(payload&&payload.data&&Array.isArray(payload.data.route)&&payload.data.route.length>=2)return payload;
    var data=safe(function(){return typeof activeMappedHoleData==="function"?activeMappedHoleData():null;},null);
    if(data&&Array.isArray(data.route)&&data.route.length>=2)return {course:activeMappedCourse(),hole:surfaceHoleNumber(),data:data,source:"course-play-pipeline"};
    return payload||null;
  }
  function mappedShape(data){
    var shape=safe(function(){return typeof gdMappedGreenShapeLatLngs==="function"?gdMappedGreenShapeLatLngs(data):null;},null);
    if(Array.isArray(shape)&&shape.length)return shape.map(asLL).filter(validLL);
    var raw=data&&data.green&&(data.green.greenShape||data.green.shape||data.green.polygon||data.green.outline);
    return (Array.isArray(raw)?raw:[]).map(mappedPoint).filter(validLL);
  }
  function mappedRoute(data){
    var route=safe(function(){return typeof gdMappedRouteLatLngs==="function"?gdMappedRouteLatLngs(data):null;},null);
    if(Array.isArray(route)&&route.length)return route.map(asLL).filter(validLL);
    return (Array.isArray(data&&data.route)?data.route:[]).map(mappedPoint).filter(validLL);
  }
  function bearingRad(a,b){
    a=asLL(a); b=asLL(b);
    if(!validLL(a)||!validLL(b))return NaN;
    return safe(function(){return typeof bearing==="function"?bearing(a,b):Math.atan2(b.lng-a.lng,b.lat-a.lat);},NaN);
  }
  function capturedOrientationAxis(bounds,frame){
    var shotAxis=safe(function(){return typeof window.gdShotUpAxis==="function"?window.gdShotUpAxis():null;},null);
    if(shotAxis&&Number.isFinite(Number(shotAxis.bearingRad)))return {source:shotAxis.source||"shot-axis",bearingRad:Number(shotAxis.bearingRad)};
    var payload=mappedPayload()||{};
    var data=payload.data||{};
    var route=mappedRoute(data);
    if(route.length>=2){
      var routeBearing=bearingRad(route[0],route[route.length-1]);
      if(Number.isFinite(routeBearing))return {source:"mapped-hole-route",bearingRad:routeBearing,routePoints:route.length};
    }
    var center=validBounds(bounds)?bounds.getCenter():currentGreenPoint();
    var tee=safe(function(){return typeof gdActiveMappedTeeStartPoint==="function"?gdActiveMappedTeeStartPoint():null;},null);
    if(validLL(tee)&&validLL(center)){
      var teeBearing=bearingRad(tee,center);
      if(Number.isFinite(teeBearing))return {source:"mapped-tee-green",bearingRad:teeBearing};
    }
    var s=asLL(safe(function(){return start;},null)), t=asLL(safe(function(){return target;},null))||center;
    var direct=bearingRad(s,t);
    if(Number.isFinite(direct))return {source:"direct-shot",bearingRad:direct};
    return null;
  }
  function currentGreenPoint(){
    return asLL(safe(function(){return target;},null))||
      asLL(safe(function(){return window.target;},null))||
      asLL(safe(function(){return greenCentre;},null))||
      asLL(safe(function(){return window.greenCentre;},null))||
      asLL(safe(function(){var m=targetMarker;return m&&m.getLatLng&&m.getLatLng();},null))||
      asLL(safe(function(){var m=greenMarker;return m&&m.getLatLng&&m.getLatLng();},null))||
      mappedPoint(safe(function(){var d=mappedPayload().data||{};var g=d.green||{};return g.center||g.centre||g.position||g.pin||d.greenCenter||d.greenCentre;},null));
  }
  function greenBounds(kind){
    var current=currentGreenPoint();
    var poly=safe(function(){return Array.isArray(greenPolygon)&&greenPolygon.length>=3?greenPolygon:null;},null);
    var b=boundsFromPoints(poly)||safe(function(){return greenOutline&&greenOutline.getBounds&&greenOutline.getBounds();},null);
    if(validBounds(b)&&(!current||safe(function(){return map.distance(current,b.getCenter());},999)<45))return b;
    var data=mappedPayload().data||{};
    var mapped=mappedShape(data);
    b=boundsFromPoints(mapped);
    if(validBounds(b))return b;
    return pointBounds(current,kind==="hole"?22:18);
  }
  function activeBounds(kind){
    kind=kind||"lock";
    if(kind==="hole")return greenBounds("hole");
    var b=safe(function(){return window.gdGetActiveShotObjectBounds&&window.gdGetActiveShotObjectBounds();},null);
    if(validBounds(b)){
      var s=boundsSizeM(b);
      if(s.diag>=4&&s.diag<=210)return b;
    }
    return greenBounds(kind);
  }
  function frameRect(kind){
    if(typeof window.gdScreenTargetFrameRect==="function"){
      var r=safe(function(){return window.gdScreenTargetFrameRect(kind||"lock");},null);
      if(r&&Number.isFinite(r.left)&&Number.isFinite(r.width))return r;
    }
    var w=innerWidth||390,h=innerHeight||760;
	    var spec={hole:{x:.308,y:.203,w:.375,h:.160},lock:{x:.247,y:.203,w:.497,h:.222},zoom:{x:.152,y:.203,w:.687,h:.316},tee:{x:.308,y:.881,w:.375,h:.037}}[kind]||{x:.247,y:.203,w:.497,h:.222};
    return {left:w*spec.x,top:h*spec.y,right:w*(spec.x+spec.w),bottom:h*(spec.y+spec.h),width:w*spec.w,height:h*spec.h};
  }
	  function tileLayer(){
	    var found=null;
	    safe(function(){map.eachLayer(function(layer){if(!found&&layer&&layer.getTileUrl&&layer.options&&(layer._url||layer.options.urlTemplate))found=layer;});});
	    return found||safe(function(){return baseLayer;},null);
	  }
	  function templateTileUrl(layer,tx,ty,z){
	    if(!layer)return "";
	    var tmpl=String(safe(function(){return layer._url||layer.options&&layer.options.urlTemplate||layer.options&&layer.options.url||"";},""));
	    if(tmpl){
	      var subs=safe(function(){return layer.options&&layer.options.subdomains;},null);
	      var s="";
	      if(Array.isArray(subs)&&subs.length)s=String(subs[Math.abs(tx+ty)%subs.length]);
	      else if(typeof subs==="string"&&subs.length)s=subs.charAt(Math.abs(tx+ty)%subs.length);
	      return tmpl.replace(/\{ *([\w_-]+) *\}/g,function(all,key){
	        if(key==="x")return tx;
	        if(key==="y")return ty;
	        if(key==="z")return z;
	        if(key==="s")return s;
	        if(key==="r")return "";
	        return all;
	      });
	    }
	    return safe(function(){return layer.getTileUrl({x:tx,y:ty,z:z});},"");
	  }
	  function captureZoom(){
	    var z=Math.floor(num(safe(function(){return map.getZoom();},17),17));
	    return Math.max(15,Math.min(17,z));
	  }
	  function storageKey(){
	    if(renderSurfaceOverride){
	      if(renderSurfaceOverride.captureKey)return "gd_captured_hole_frame_v19_"+String(renderSurfaceOverride.captureKey).replace(/[^a-z0-9:_-]+/gi,"_");
	      var overrideCourse=renderSurfaceOverride.courseKey||renderSurfaceOverride.courseName||"course";
	      var overrideHole=renderSurfaceOverride.holeNumber||1;
	      return "gd_captured_hole_frame_v19_"+String(overrideCourse+":h"+overrideHole).replace(/[^a-z0-9:_-]+/gi,"_");
	    }
	    var course=safe(function(){return (currentCourse&&(currentCourse.key||currentCourse.name||currentCourse.id))||document.body.dataset.gdActiveCourseName||"course";},"course");
	    var hole=safe(function(){return currentPlayingHole||selectedHole||gdMappedStartHoleNumber&&gdMappedStartHoleNumber()||1;},1);
	    return "gd_captured_hole_frame_v19_"+String(course+":h"+hole).replace(/[^a-z0-9:_-]+/gi,"_");
	  }
	  function surfaceCourseKey(){
	    if(renderSurfaceOverride&&renderSurfaceOverride.courseKey)return renderSurfaceOverride.courseKey;
	    /* courseId first: on a stored library record .id is the composite storage
	       key `${userId}::${courseId}`, which is a location in the store, not a
	       course identity. Preferring .id leaked keys like
	       "user-<playerid>::akarana-golf-club" into captured_surfaces, splitting a
	       course's scans across a per-user key nobody else can read back. */
	    return safe(function(){return (currentCourse&&(currentCourse.courseId||currentCourse.key||currentCourse.id||currentCourse.name))||document.body.dataset.gdActiveCourseName||"course";},"course");
	  }
	  function surfaceCourseName(){
	    if(renderSurfaceOverride&&renderSurfaceOverride.courseName)return renderSurfaceOverride.courseName;
	    /* Same reasoning as surfaceCourseKey: .key and .id on a stored library
	       record are the composite `${userId}::${courseId}` storage key, not a
	       display name. Falling through to them wrote course names like
	       "user-<playerid>::pupuke" into captured_surfaces. courseName is the
	       record's real name; the composite fields are dropped entirely. */
	    return safe(function(){return (currentCourse&&(currentCourse.name||currentCourse.courseName||currentCourse.title))||document.body.dataset.gdActiveCourseName||"Course";},"Course");
	  }
	  function surfaceHoleNumber(){
	    if(renderSurfaceOverride&&Number(renderSurfaceOverride.holeNumber))return Number(renderSurfaceOverride.holeNumber)||1;
	    return safe(function(){return Number(currentPlayingHole||selectedHole||gdMappedStartHoleNumber&&gdMappedStartHoleNumber()||1)||1;},1);
	  }
	  function manifestMatchesActive(manifest){
	    if(!manifest||!Array.isArray(manifest.tiles)||!manifest.originPx)return false;
	    var manifestHole=Number(manifest.holeNumber);
	    var activeHole=surfaceHoleNumber();
	    if(Number.isFinite(manifestHole)&&Number.isFinite(activeHole)&&Math.round(manifestHole)!==Math.round(activeHole))return false;
	    var manifestCourse=surfaceIdentity(manifest.courseKey||manifest.courseName);
	    var activeCourse=surfaceIdentity(surfaceCourseKey()||surfaceCourseName());
	    if(manifestCourse&&activeCourse&&manifestCourse!==activeCourse)return false;
	    return true;
	  }
	  function publishCaptureManifest(manifest){
	    if(!manifest)return manifest;
	    window.gdHoleImageCaptureManifest=manifest;
	    window.__gdLastHoleImageCaptureManifest=manifest;
	    window.__gdV19CapturedHoleFrameManifest=manifest;
	    return manifest;
	  }
  function courseVisualRecord(){
    var engine=safe(function(){return window.GDCourseVisualEngine;},null);
    if(!engine)return null;
    var ids=[surfaceCourseKey(),surfaceCourseName()].filter(Boolean);
    for(var i=0;i<ids.length;i++){
      var id=ids[i];
      var record=safe(function(){return typeof engine.resolveCourseVisual==="function"?engine.resolveCourseVisual(id):null;},null)||
        safe(function(){return typeof engine.getRecord==="function"?engine.getRecord(id):null;},null);
      if(record&&record.publishedVisual)return record;
    }
    return null;
  }
  function courseVisualHoleAsset(record){
    var hole=surfaceHoleNumber();
    var frames=(Array.isArray(record&&record.holeFramePublishedVisuals)&&record.holeFramePublishedVisuals.length?record.holeFramePublishedVisuals:Array.isArray(record&&record.holeFrameTerrainViews)&&record.holeFrameTerrainViews.length?record.holeFrameTerrainViews:[]);
    var match=frames.filter(function(asset){return asset&&Math.round(Number(asset.holeNumber)||0)===Math.round(Number(hole)||0);})[0]||null;
    if(match)return match;
    var single=record&&record.singleHolePublishedVisual||record&&record.singleHoleTerrainView||null;
    var singleHole=Math.round(Number(single&&single.holeNumber)||0);
    if(single&&(!frames.length||singleHole===Math.round(Number(hole)||0)||singleHole<1&&Math.round(Number(hole)||0)===1))return single;
    return null;
  }
  function courseVisualManifestZoom(bounds,width,height){
    if(!validBounds(bounds)||!hasMap())return 19;
    var sw=bounds.getSouthWest(),ne=bounds.getNorthEast(),nw=L.latLng(ne.lat,sw.lng);
    var best={zoom:19,score:Infinity};
    for(var z=14;z<=22;z++){
      var a=map.project(nw,z),b=map.project(ne,z),c=map.project(sw,z);
      var spanW=Math.max(1,Math.abs(b.x-a.x));
      var spanH=Math.max(1,Math.abs(c.y-a.y));
      var score=Math.abs(Math.log(spanW/Math.max(1,width)))+Math.abs(Math.log(spanH/Math.max(1,height)));
      if(score<best.score)best={zoom:z,score:score};
    }
    return best.zoom;
  }
  function courseVisualManifestFromAsset(asset,record){
    var src=String(asset&&asset.dataUrl||asset&&asset.url||asset&&asset.publicUrl||"");
    if(!src)return null;
    var meta=asset&&asset.metadata||{};
    var playSurface=meta.playSurface||{};
    if(playSurface.useGpsPlayFraming===false)return null;
    var bounds=coerceBounds(asset&&asset.bounds||playSurface.sourceBounds);
    if(!validBounds(bounds)||!hasMap())return null;
    var width=Math.max(1,Math.round(Number(asset&&asset.width||playSurface.outputDimensions&&playSurface.outputDimensions.width||meta.outputDimensions&&meta.outputDimensions.width)||1200));
    var height=Math.max(1,Math.round(Number(asset&&asset.height||playSurface.outputDimensions&&playSurface.outputDimensions.height||meta.outputDimensions&&meta.outputDimensions.height)||1800));
    var zoom=courseVisualManifestZoom(bounds,width,height);
    var sw=bounds.getSouthWest(),ne=bounds.getNorthEast(),nw=L.latLng(ne.lat,sw.lng);
    var origin=map.project(nw,zoom);
    var pins=playSurface.anchorPins||meta.anchorPins||captureAnchorPins();
    return {
      version:VERSION,
      key:"gd_course_visual_hole_surface_v1_"+String((record&&record.courseId||surfaceCourseKey())+":h"+surfaceHoleNumber()).replace(/[^a-z0-9:_-]+/gi,"_"),
      reason:"published-course-visual",
      surfaceModel:"clarity-course-visual-hole-surface-v1",
      interactionOwner:"course-visual",
      liveMapRole:"live-gps-fallback",
      fallbackUnderlay:"live-gps",
      fallbackPolicy:"live-gps-only",
      courseKey:surfaceCourseKey(),
      courseName:surfaceCourseName(),
      visualCourseId:record&&record.courseId||"",
      holeNumber:surfaceHoleNumber(),
      captureZoom:zoom,
      imageWidth:width,
      imageHeight:height,
      originPx:{x:origin.x,y:origin.y},
      tiles:[{x:0,y:0,z:zoom,tileX:0,tileY:0,url:src,width:width,height:height}],
      includeTee:!!(pins&&pins.tee),
      teeLatLng:pins&&pins.tee||null,
      anchorPins:pins||{},
      bounds:{south:sw.lat,west:sw.lng,north:ne.lat,east:ne.lng},
      courseVisualPath:asset.path||"",
      createdAt:new Date().toISOString()
    };
  }
  function loadPublishedCourseVisualManifest(){
    var record=courseVisualRecord();
    var asset=courseVisualHoleAsset(record);
    var manifest=courseVisualManifestFromAsset(asset,record);
    if(!manifest||!manifestMatchesActive(manifest))return null;
    captureManifest=manifest;
    gdRegisterCoursePlayFrameManifest(manifest,{generatedFrom:"course-visual-published-hole-surface",manifestKey:manifest.key,status:"loaded"});
    safe(function(){if(capturedGpsPlayActive())gdCoursePlayDebugEvent("gps-play-loaded-course-visual-surface",{manifestKey:manifest.key,path:manifest.courseVisualPath,captureZoom:manifest.captureZoom,imageWidth:manifest.imageWidth,imageHeight:manifest.imageHeight});});
    return publishCaptureManifest(manifest);
  }
	  function cleanCapturePinSet(planned){
	    planned=planned||{};
	    function pack(p){p=asLL(p);return validLL(p)?{lat:+p.lat,lng:+p.lng}:null;}
	    var plannedRoute=Array.isArray(planned.route)?planned.route.map(pack).filter(Boolean):[];
	    var plannedShape=Array.isArray(planned.greenShape||planned.shape)?(planned.greenShape||planned.shape).map(pack).filter(Boolean):[];
	    var plannedTee=pack(planned.tee||planned.start);
	    var plannedGreen=pack(planned.green||planned.target||planned.pin);
	    return {
	      tee:plannedTee||plannedRoute[0]||null,
	      green:plannedGreen||plannedRoute[plannedRoute.length-1]||null,
	      route:plannedRoute,
	      greenShape:plannedShape
	    };
	  }
	  function hasCapturePinSet(pins){
	    return !!(pins&&(validLL(pins.tee)||validLL(pins.green)||(Array.isArray(pins.route)&&pins.route.length)||(Array.isArray(pins.greenShape)&&pins.greenShape.length)));
	  }
	  function captureAnchorPins(captureOpts){
	    captureOpts=captureOpts||{};
	    var planned=captureOpts.anchorPins||captureOpts.pins||{};
	    var plannedPins=cleanCapturePinSet(planned);
	    if(hasCapturePinSet(plannedPins))return plannedPins;
	    var data=safe(function(){return (mappedPayload()||{}).data||{};},{})||{};
	    var route=mappedRoute(data).filter(validLL);
	    var shape=mappedShape(data).filter(validLL);
	    var tee=safe(function(){return typeof gdActiveMappedTeeStartPoint==="function"?gdActiveMappedTeeStartPoint():null;},null);
	    var green=currentGreenPoint();
	    return cleanCapturePinSet({tee:tee,green:green,route:route,greenShape:shape});
	  }
	  function captureWorkingPins(captureOpts){
	    captureOpts=captureOpts||{};
	    var planned=captureOpts.captureAnchorPins||captureOpts.capturePins||null;
	    var plannedPins=cleanCapturePinSet(planned);
	    return hasCapturePinSet(plannedPins)?plannedPins:captureAnchorPins(captureOpts);
	  }
	  function captureSurfacePoints(objectBounds,reason,captureOpts){
	    var points=validBounds(objectBounds)?boundsCorners(objectBounds):[];
	    var plannedPins=captureWorkingPins(captureOpts);
	    var hasPlannedPins=!!(captureOpts&&(captureOpts.captureAnchorPins||captureOpts.capturePins||captureOpts.anchorPins||captureOpts.pins)&&hasCapturePinSet(plannedPins));
	    var includeWholeHole=captureOpts&&captureOpts.includeAnchorPins===true||(!(captureOpts&&captureOpts.lockBounds===true)&&!/lock|zoom/i.test(String(reason||"")));
	    if(hasPlannedPins){
	      if(includeWholeHole){
	        points=points.concat(plannedPins.route||[],plannedPins.greenShape||[]);
	        if(validLL(plannedPins.tee))points.push(plannedPins.tee);
	        if(validLL(plannedPins.green))points.push(plannedPins.green);
	      }
	      return points.map(asLL).filter(validLL);
	    }
	    var data=safe(function(){return (mappedPayload()||{}).data||{};},{})||{};
	    var route=mappedRoute(data);
	    var shape=mappedShape(data);
	    if(includeWholeHole&&route.length)points=points.concat(route);
	    if(includeWholeHole&&shape.length)points=points.concat(shape);
	    var tee=safe(function(){return typeof gdActiveMappedTeeStartPoint==="function"?gdActiveMappedTeeStartPoint():null;},null);
	    if(includeWholeHole&&validLL(tee))points.push(tee);
	    var holeB=greenBounds("hole");
	    if(includeWholeHole&&validBounds(holeB))points=points.concat(boundsCorners(holeB));
	    return points.map(asLL).filter(validLL);
	  }
	  function preferredCaptureZoom(){
	    var layer=tileLayer();
	    var native=num(safe(function(){return layer&&layer.options&&layer.options.maxNativeZoom;},NaN),NaN);
	    var max=num(safe(function(){return layer&&layer.options&&layer.options.maxZoom;},NaN),NaN);
	    var source=String(safe(function(){return (layer&&layer._url)||"";},""));
	    if(!Number.isFinite(native)||native<19)native=/arcgisonline|World_Imagery/i.test(source)?20:max;
	    if(!Number.isFinite(native)||native<18)native=19;
	    return Math.max(18,Math.min(20,Math.floor(native)));
	  }
	  function pixelRectFor(points,z,bleed){
	    var projected=points.map(function(p){return map.project(asLL(p),z);}).filter(Boolean);
	    if(!projected.length)return null;
	    var minX=Math.min.apply(null,projected.map(function(p){return p.x;}));
	    var maxX=Math.max.apply(null,projected.map(function(p){return p.x;}));
	    var minY=Math.min.apply(null,projected.map(function(p){return p.y;}));
	    var maxY=Math.max.apply(null,projected.map(function(p){return p.y;}));
	    return {minX:Math.floor(minX-bleed),minY:Math.floor(minY-bleed),maxX:Math.ceil(maxX+bleed),maxY:Math.ceil(maxY+bleed)};
	  }
	  function captureLensAspect(captureOpts){
	    captureOpts=captureOpts||{};
	    var shape=String(captureOpts.captureLens||captureOpts.lensShape||"").toLowerCase();
	    var aspect=num(captureOpts.lensAspectRatio,num(captureOpts.lensAspect,NaN));
	    if(!Number.isFinite(aspect)&&/mobile.*hole|hole.*mobile|mobile-hole/.test(shape))aspect=9/16;
	    return Number.isFinite(aspect)&&aspect>0?Math.max(.28,Math.min(2.4,aspect)):0;
	  }
	  function applyCaptureLensRect(rect,captureOpts){
	    var aspect=captureLensAspect(captureOpts);
	    if(!rect||!aspect)return rect;
	    var orientation=String(captureOpts&&captureOpts.lensOrientation||"").toLowerCase();
	    var pins=captureWorkingPins(captureOpts);
	    var route=Array.isArray(pins&&pins.route)?pins.route:[];
	    var routeStart=asLL(route[0]||pins&&pins.tee);
	    var routeEnd=asLL(route[route.length-1]||pins&&pins.green);
	    if(orientation==="play-axis"&&validLL(routeStart)&&validLL(routeEnd)&&hasMap()){
	      var a=map.project(routeStart,captureOpts&&captureOpts.__captureZoom||preferredCaptureZoom());
	      var b=map.project(routeEnd,captureOpts&&captureOpts.__captureZoom||preferredCaptureZoom());
	      var dx=b.x-a.x,dy=b.y-a.y;
	      var len=Math.sqrt(dx*dx+dy*dy);
	      if(len>1){
	        var ux=dx/len,uy=dy/len;
	        var px=-uy,py=ux;
	        var corners=[{x:rect.minX,y:rect.minY},{x:rect.maxX,y:rect.minY},{x:rect.maxX,y:rect.maxY},{x:rect.minX,y:rect.maxY}];
	        var center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
	        var extents=corners.map(function(p){return {along:(p.x-center.x)*ux+(p.y-center.y)*uy,cross:(p.x-center.x)*px+(p.y-center.y)*py};});
	        var along=Math.max(len/2,Math.max.apply(null,extents.map(function(p){return Math.abs(p.along);})));
	        var cross=Math.max(1,Math.max.apply(null,extents.map(function(p){return Math.abs(p.cross);})));
	        var current=(cross*2)/(along*2);
	        if(current>aspect)along=cross/aspect;
	        else cross=along*aspect;
	        var lens=[
	          {x:center.x-ux*along-px*cross,y:center.y-uy*along-py*cross},
	          {x:center.x+ux*along-px*cross,y:center.y+uy*along-py*cross},
	          {x:center.x+ux*along+px*cross,y:center.y+uy*along+py*cross},
	          {x:center.x-ux*along+px*cross,y:center.y-uy*along+py*cross}
	        ];
		        return {
		          minX:Math.floor(Math.min.apply(null,lens.map(function(p){return p.x;}))),
		          minY:Math.floor(Math.min.apply(null,lens.map(function(p){return p.y;}))),
		          maxX:Math.ceil(Math.max.apply(null,lens.map(function(p){return p.x;}))),
		          maxY:Math.ceil(Math.max.apply(null,lens.map(function(p){return p.y;}))),
		          lensCornersPx:lens.map(function(p){return {x:Math.round(p.x),y:Math.round(p.y)};}),
		          lensOrientation:"play-axis"
		        };
		      }
		    }
	    var width=Math.max(1,rect.maxX-rect.minX);
	    var height=Math.max(1,rect.maxY-rect.minY);
	    var current=width/height;
		    if(Math.abs(current-aspect)<.01)return rect;
		    var cx=(rect.minX+rect.maxX)/2;
		    var cy=(rect.minY+rect.maxY)/2;
	    if(current>aspect){
	      height=width/aspect;
	    }else{
	      width=height*aspect;
	    }
		    var adjusted={minX:Math.floor(cx-width/2),minY:Math.floor(cy-height/2),maxX:Math.ceil(cx+width/2),maxY:Math.ceil(cy+height/2)};
		    adjusted.lensCornersPx=[
		      {x:adjusted.minX,y:adjusted.minY},
		      {x:adjusted.maxX,y:adjusted.minY},
		      {x:adjusted.maxX,y:adjusted.maxY},
		      {x:adjusted.minX,y:adjusted.maxY}
		    ];
		    adjusted.lensOrientation="map-axis";
		    return adjusted;
		  }
	  function tileCountFor(rect){
	    if(!rect)return 0;
	    var minTx=Math.floor(rect.minX/256),maxTx=Math.floor((rect.maxX-1)/256),minTy=Math.floor(rect.minY/256),maxTy=Math.floor((rect.maxY-1)/256);
	    return Math.max(0,maxTx-minTx+1)*Math.max(0,maxTy-minTy+1);
	  }
	  function leafletCameraCapability(){
	    var proto=safe(function(){return window.L&&window.L.Map&&window.L.Map.prototype;},null);
	    var nativePitch=!!(proto&&(typeof proto.setPitch==="function"||typeof proto.getPitch==="function"));
	    var nativeBearing=!!(proto&&(typeof proto.setBearing==="function"||typeof proto.getBearing==="function"||typeof proto.setRotation==="function"||typeof proto.getRotation==="function"));
	    var runtimePitch=nativePitch||safe(function(){return !!(map&&(typeof map.setPitch==="function"||typeof map.getPitch==="function"));},false);
	    var runtimeBearing=nativeBearing||safe(function(){return !!(map&&(typeof map.setBearing==="function"||typeof map.getBearing==="function"||typeof map.setRotation==="function"||typeof map.getRotation==="function"));},false);
	    return {
	      provider:"leaflet",
	      library:"leaflet",
	      nativePitchAvailable:!!runtimePitch,
	      nativeBearingAvailable:!!runtimeBearing,
	      pitchStrategy:runtimePitch?"native-pitch":"faux-tilt-svg",
	      reason:runtimePitch?"leaflet-pitch-api-detected":"plain-leaflet-no-native-pitch"
	    };
	  }
	  function buildCaptureManifest(objectBounds,reason,captureOpts){
	    captureOpts=captureOpts||{};
	    objectBounds=coerceBounds(objectBounds);
	    if(!hasMap()||!validBounds(objectBounds))return null;
	    reason=reason||"capture";
	    var preferred=preferredCaptureZoom();
	    var minZoom=Math.max(15,Math.min(20,Math.floor(num(captureOpts.minZoom,18))));
	    var maxZoom=Math.max(minZoom,Math.min(20,Math.floor(num(captureOpts.maxZoom,preferred))));
	    var z=Math.max(minZoom,Math.min(maxZoom,Math.floor(num(captureOpts.targetZoom,preferred))));
	    var maxTiles=Math.max(16,Math.round(num(captureOpts.maxTiles,320)));
	    var points=captureSurfacePoints(objectBounds,reason,captureOpts);
		    var pins=captureAnchorPins(captureOpts);
		    var bleed=Math.max(0,Math.round(num(captureOpts.bleedPx,/lock|zoom/i.test(String(reason))?2100:2800)));
		    captureOpts.__captureZoom=z;
		    var rect=applyCaptureLensRect(pixelRectFor(points,z,bleed),captureOpts);
		    if(!rect)return null;
		    while(z>minZoom&&tileCountFor(rect)>maxTiles){
		      z-=1;
		      captureOpts.__captureZoom=z;
		      rect=applyCaptureLensRect(pixelRectFor(points,z,bleed),captureOpts);
		    }
	    var origin={x:rect.minX,y:rect.minY};
	    var width=Math.max(256,rect.maxX-rect.minX),height=Math.max(256,rect.maxY-rect.minY);
    var layer=captureOpts.tileTemplate?{_url:String(captureOpts.tileTemplate),options:{urlTemplate:String(captureOpts.tileTemplate),subdomains:captureOpts.tileSubdomains||captureOpts.subdomains||[]}}:tileLayer(),tiles=[];
    if(layer&&(typeof layer.getTileUrl==="function"||captureOpts.tileTemplate)){
      var minTx=Math.floor(rect.minX/256),maxTx=Math.floor((rect.maxX-1)/256),minTy=Math.floor(rect.minY/256),maxTy=Math.floor((rect.maxY-1)/256);
      for(var ty=minTy;ty<=maxTy;ty++){
        for(var tx=minTx;tx<=maxTx;tx++){
	          var url=templateTileUrl(layer,tx,ty,z);
          if(url)tiles.push({x:tx*256-origin.x,y:ty*256-origin.y,z:z,tileX:tx,tileY:ty,url:url});
        }
      }
		    }
					    var capturePins=captureWorkingPins(captureOpts);
					    var lensCornersPx=Array.isArray(rect.lensCornersPx)?rect.lensCornersPx.map(function(p){return {x:Math.round(num(p&&p.x,0)),y:Math.round(num(p&&p.y,0))};}).filter(function(p){return Number.isFinite(p.x)&&Number.isFinite(p.y);}):[];
					    var lensLocalCorners=lensCornersPx.length>=4?lensCornersPx.map(function(p){return {x:p.x-origin.x,y:p.y-origin.y};}):[];
					    var manifest={version:VERSION,key:storageKey(),reason:reason,surfaceModel:"captured-surface-v1",interactionOwner:"captured-surface",liveMapRole:"capture-source-diagnostic-reference",courseKey:captureOpts.courseId||captureOpts.courseKey||surfaceCourseKey(),courseName:captureOpts.courseName||surfaceCourseName(),holeNumber:captureOpts.holeNumber||surfaceHoleNumber(),captureZoom:z,imageWidth:width,imageHeight:height,originPx:origin,tiles:tiles,includeTee:!!pins.tee,teeLatLng:pins.tee||null,anchorPins:pins,captureAnchorPins:capturePins,createdAt:new Date().toISOString()};
					    if(lensLocalCorners.length>=4){
					      manifest.lensCornersPx=lensCornersPx;
					      manifest.lensLocalCorners=lensLocalCorners;
					      manifest.lensOrientation=rect.lensOrientation||captureOpts.lensOrientation||"";
					    }
			    if(captureOpts.role||captureOpts.quality||captureOpts.planId){
			      manifest.visualRole=String(captureOpts.role||"");
			      manifest.visualQuality=String(captureOpts.quality||"");
			      manifest.visualPlanId=String(captureOpts.planId||captureOpts.id||"");
			      manifest.stitchLayer=Number.isFinite(Number(captureOpts.stitchLayer))?Number(captureOpts.stitchLayer):0;
			      manifest.debugUnderlay=!!captureOpts.debugUnderlay;
			      manifest.debugTerrain=!!captureOpts.debugTerrain;
			      manifest.terrainStageOnly=!!captureOpts.terrainStageOnly;
			      manifest.beta3dStageOnly=!!captureOpts.beta3dStageOnly;
			      manifest.cameraMode=String(captureOpts.cameraMode||"");
			      manifest.cameraTiltDeg=Number.isFinite(Number(captureOpts.cameraTiltDeg))?Number(captureOpts.cameraTiltDeg):null;
			      manifest.captureTiltDeg=Number.isFinite(Number(captureOpts.captureTiltDeg))?Number(captureOpts.captureTiltDeg):null;
			      manifest.playTiltDeg=Number.isFinite(Number(captureOpts.playTiltDeg))?Number(captureOpts.playTiltDeg):null;
			      var cameraCapability=leafletCameraCapability();
			      manifest.mapCameraCapability=cameraCapability;
			      manifest.nativePitchAvailable=!!cameraCapability.nativePitchAvailable;
			      manifest.nativeBearingAvailable=!!cameraCapability.nativeBearingAvailable;
			      manifest.cameraFallback=captureOpts.beta3dStageOnly&&!cameraCapability.nativePitchAvailable?"leaflet-flat-capture-faux-tilt-stage":"";
			      manifest.tileSourceLabel=String(captureOpts.tileSourceLabel||"");
			      manifest.captureLens=String(captureOpts.captureLens||captureOpts.lensShape||"");
			      manifest.lensShape=String(captureOpts.lensShape||captureOpts.captureLens||"");
			      manifest.lensAspectRatio=captureLensAspect(captureOpts)||null;
			      manifest.lensOrientation=String(captureOpts.lensOrientation||"");
			      manifest.lensFit=String(captureOpts.lensFit||"");
			      manifest.segmentIndex=Number.isFinite(Number(captureOpts.segmentIndex))?Number(captureOpts.segmentIndex):null;
			      manifest.segmentCount=Number.isFinite(Number(captureOpts.segmentCount))?Number(captureOpts.segmentCount):null;
			      manifest.segmentStartMeters=Number.isFinite(Number(captureOpts.segmentStartMeters))?Number(captureOpts.segmentStartMeters):null;
			      manifest.segmentEndMeters=Number.isFinite(Number(captureOpts.segmentEndMeters))?Number(captureOpts.segmentEndMeters):null;
			      manifest.routeLengthMeters=Number.isFinite(Number(captureOpts.routeLengthMeters))?Number(captureOpts.routeLengthMeters):null;
				      manifest.visualCapturePolicy={role:manifest.visualRole,quality:manifest.visualQuality,targetZoom:z,requestedTargetZoom:captureOpts.targetZoom||null,minZoom:minZoom,maxZoom:maxZoom,maxTiles:maxTiles,bleedPx:bleed,lockBounds:captureOpts.lockBounds===true,includeAnchorPins:captureOpts.includeAnchorPins===true,tileSourceLabel:manifest.tileSourceLabel,captureLens:manifest.captureLens,lensShape:manifest.lensShape,lensAspectRatio:manifest.lensAspectRatio,lensOrientation:manifest.lensOrientation,lensFit:manifest.lensFit,segmentIndex:manifest.segmentIndex,segmentCount:manifest.segmentCount,segmentStartMeters:manifest.segmentStartMeters,segmentEndMeters:manifest.segmentEndMeters,routeLengthMeters:manifest.routeLengthMeters,cameraCapability:cameraCapability};
			    }
			    /* A re-capture of an unchanged frame (same zoom, origin, dimensions) reuses the pixels
	       already flattened for it - the tile lattice is identical, so refetching ~300 tiles to
	       rebuild the exact same JPEG would be pure waste. Carrying the pointer forward also
	       means scheduleCaptureFlatten skips, and the build below can stitch from owned pixels
	       immediately instead of waiting on a flatten. */
	    safe(function(){
	      var stored=JSON.parse(localStorage.getItem(storageKey())||"null");
	      if(stored&&stored.imagePath&&Number(stored.captureZoom)===z&&stored.originPx&&
	         Math.round(Number(stored.originPx.x))===Math.round(origin.x)&&Math.round(Number(stored.originPx.y))===Math.round(origin.y)&&
	         Math.round(Number(stored.imageWidth))===Math.round(width)&&Math.round(Number(stored.imageHeight))===Math.round(height)){
	        manifest.imagePath=stored.imagePath;
	        manifest.flattenedAt=stored.flattenedAt||stored.updatedAt||null;
	        manifest.surfaceOwnership="clarity-owned-raster";
	        manifest.flattenedFrom=stored.flattenedFrom||{tileCount:tiles.length};
	      }
	    });
	    manifest=safe(function(){return typeof window.gdCapturedSurfaceWriteScan==="function"?window.gdCapturedSurfaceWriteScan(manifest,{reason:reason,storageKey:storageKey()}):manifest;},manifest)||manifest;
    if(captureOpts.backgroundCapture){
      window.__gdLastCourseVisualCaptureManifest=manifest;
    }else{
      captureManifest=manifest;
      window.gdHoleImageCaptureManifest=manifest;
	    window.__gdLastHoleImageCaptureManifest=manifest;
	    window.__gdV19CapturedHoleFrameManifest=manifest;
    }
	    safe(function(){
	      // Once pixels are owned the tile list is dead weight in localStorage (~130KB/hole).
	      var stored=manifest;
	      if(manifest.imagePath){stored=Object.assign({},manifest);delete stored.tiles;}
	      localStorage.setItem(storageKey(),JSON.stringify(stored));
	    });
	    if(!captureOpts.skipCoursePlayFrameRegister)gdRegisterCoursePlayFrameManifest(manifest,{generatedFrom:"v19-captured-surface",manifestKey:storageKey(),status:"generated"});
	    // Turn the tile references into our own pixels, alongside rather than in the way.
	    safe(function(){scheduleCaptureFlatten(manifest,captureOpts);});
	    safe(function(){if(capturedGpsPlayActive())gdCoursePlayDebugEvent("gps-play-generated-new-frame",{reason:reason,manifestKey:storageKey(),tileCount:tiles.length,captureZoom:z,imageWidth:width,imageHeight:height});});
	    return manifest;
	  }
	  /* ---------------------------------------------------------------------------
	     Flatten a capture into our own image.

	     A manifest records WHERE the tiles are, not what they look like - so every render
	     re-fetches third-party tiles, nothing works offline, a failed tile leaves a hole in the
	     lattice, and there is no owned raster to derive basic/HD/lite from. This composites the
	     tiles once and hands back a single JPEG that is ours from that point on.

	     Deliberately standalone and async: it runs per-shot after a capture, and equally as a
	     consolidate pass over courses already captured, without re-shooting them.

	     JPEG, not WebP: they are within 2% on size for aerial imagery, but WebP canvas encoding
	     only landed in Safari 16/17 and older iOS webviews silently hand back PNG instead - which
	     is ~7x larger and would breach the storage bucket's per-file limit without erroring.

	     Coverage is enforced. Unlike a tile reference - which simply retries on the next view - a
	     flattened image bakes its failures in permanently, so a partial composite is refused
	     rather than quietly shipping a hole.
	     --------------------------------------------------------------------------- */
	  function flattenCaptureManifest(manifest,opts){
	    opts=opts||{};
	    return new Promise(function(resolve){
	      if(!manifest)return resolve({ok:false,reason:"no-manifest"});
	      if(manifest.imageData)return resolve({ok:true,reason:"already-flattened",manifest:manifest});
	      var tiles=Array.isArray(manifest.tiles)?manifest.tiles.filter(function(t){return t&&t.url;}):[];
	      if(!tiles.length)return resolve({ok:false,reason:"no-tiles"});
	      var width=Math.max(1,Math.round(Number(manifest.imageWidth)||0));
	      var height=Math.max(1,Math.round(Number(manifest.imageHeight)||0));
	      if(width<2||height<2)return resolve({ok:false,reason:"no-capture-dimensions"});
	      var minCoverage=Number.isFinite(Number(opts.minCoverage))?Number(opts.minCoverage):1;
	      var quality=Number.isFinite(Number(opts.quality))?Number(opts.quality):.85;
	      var canvas=document.createElement("canvas");
	      canvas.width=width;canvas.height=height;
	      var ctx=canvas.getContext("2d");
	      if(!ctx)return resolve({ok:false,reason:"no-canvas-context"});
	      var pending=tiles.length,loaded=0,failed=0,settled=false;
	      var timer=setTimeout(function(){finish(true);},Math.max(4000,Number(opts.timeoutMs)||20000));
	      tiles.forEach(function(tile){
	        var img=new Image();
	        img.crossOrigin="anonymous";
	        img.onload=function(){
	          try{ctx.drawImage(img,Number(tile.x)||0,Number(tile.y)||0,Number(tile.width)||256,Number(tile.height)||256);loaded++;}
	          catch(err){failed++;}
	          step();
	        };
	        img.onerror=function(){failed++;step();};
	        img.src=tile.url;
	      });
	      function step(){if(--pending<=0)finish(false);}
	      function finish(timedOut){
	        if(settled)return;
	        settled=true;
	        clearTimeout(timer);
	        var coverage=tiles.length?loaded/tiles.length:0;
	        if(coverage<minCoverage){
	          return resolve({ok:false,reason:timedOut?"tile-load-timeout":"incomplete-coverage",coverage:+coverage.toFixed(3),loaded:loaded,failed:failed,expected:tiles.length});
	        }
	        var dataUrl;
	        try{dataUrl=canvas.toDataURL("image/jpeg",quality);}
	        catch(err){canvas.width=canvas.height=1;return resolve({ok:false,reason:"canvas-tainted",error:String(err&&err.name||err)});}
	        // Release the backing store immediately - queued flattens must not stack canvases.
	        canvas.width=canvas.height=1;
	        if(!dataUrl||dataUrl.indexOf("data:image/jpeg")!==0)return resolve({ok:false,reason:"jpeg-encode-unavailable"});
	        var flattened=Object.assign({},manifest,{
	          imageData:dataUrl,
	          imageFormat:"image/jpeg",
	          imageBytes:Math.round(dataUrl.length*0.75),
	          surfaceOwnership:"clarity-owned-raster",
	          flattenedAt:new Date().toISOString(),
	          flattenedFrom:{tileCount:tiles.length,tileSourceLabel:manifest.tileSourceLabel||"",captureZoom:manifest.captureZoom||null}
	        });
	        var result={ok:true,manifest:flattened,dataUrl:dataUrl,coverage:+coverage.toFixed(3),loaded:loaded,failed:failed,bytes:flattened.imageBytes,width:width,height:height};
	        var engine=window.GDCourseVisualEngine;
	        if(opts.persist===false||!engine||typeof engine.saveCaptureImage!=="function"){
	          result.persisted=false;
	          return resolve(result);
	        }
	        /* The pixels go to the IndexedDB asset store and the manifest keeps only the pointer.
	           A ~1.4MB base64 JPEG per hole would exhaust localStorage within a couple of holes and
	           take every other manifest down with it. */
	        var path=engine.captureImagePath(flattened);
	        flattened.imagePath=path;
	        Promise.resolve(engine.saveCaptureImage(path,dataUrl)).then(function(saved){
	          result.persisted=saved===true;
	          result.imagePath=path;
	          if(saved===true&&opts.updateStoredManifest!==false){
	            // Persist the pointer, never the pixels.
	            var lean=Object.assign({},flattened);
	            delete lean.imageData;
	            /* Drop the tile list too. Once we own the pixels those URLs are dead weight, and
	               they are the single biggest consumer of the localStorage quota: ~155 bytes per
	               tile, up to 320 tiles per capture, roughly 130KB per hole and ~2.3MB across 18
	               holes - most of a 5MB budget. flattenedFrom keeps the provenance (tile count,
	               source, zoom) in a few dozen bytes. */
	            delete lean.tiles;
	            safe(function(){localStorage.setItem(manifest.key||storageKey(),JSON.stringify(lean));});
	            result.storedManifestBytes=JSON.stringify(lean).length;
	          }
	          resolve(result);
	        }).catch(function(){result.persisted=false;resolve(result);});
	      }
	    });
	  }
	  /* Kick the flatten off after a capture without making the capture itself async.

	     buildCaptureManifest stays synchronous and its return value is unchanged, so every existing
	     caller behaves exactly as before. The flatten runs alongside: on success the manifest in
	     storage gains an imagePath pointing at our own pixels in the asset store; on failure -
	     offline, a tile 404, a tainted canvas - nothing is written and the capture keeps its tiles,
	     degrading to precisely the behaviour we have today rather than breaking the capture.

	     De-duped by manifest key so repeated captures of the same frame don't refetch every tile. */
	  var captureFlattenPending={};
	  /* Flattens run ONE at a time. A full-course scan schedules ~60 captures in one burst;
	     letting every flatten start at once meant ~60 full-size canvases and up to 20k tile
	     fetches held in memory together, which killed the tab. The queue keeps peak memory to a
	     single capture's canvas + tiles; each flatten still has its own internal timeout, so a
	     hung one releases the queue. */
	  var captureFlattenQueue=Promise.resolve();
	  function scheduleCaptureFlatten(manifest,captureOpts){
	    captureOpts=captureOpts||{};
	    if(!manifest||captureOpts.skipFlatten===true)return null;
	    if(manifest.imageData||manifest.imagePath)return null;
	    var key=manifest.key||storageKey();
	    if(captureFlattenPending[key])return captureFlattenPending[key];
	    var runFlatten=function(){return flattenCaptureManifest(manifest,{quality:captureOpts.flattenQuality});};
	    var job=(captureFlattenQueue=captureFlattenQueue.then(runFlatten,runFlatten))
	      .then(function(result){
	        safe(function(){
	          gdCoursePlayDebugEvent(result&&result.ok?"capture-flattened":"capture-flatten-skipped",{
	            manifestKey:key,
	            reason:result&&result.reason||"",
	            coverage:result&&result.coverage,
	            kb:result&&result.bytes?Math.round(result.bytes/1024):null,
	            imagePath:result&&result.imagePath||""
	          });
	        });
	        if(result&&result.ok&&result.manifest){
	          // Keep the live manifest objects pointing at our pixels for this session.
	          if(captureManifest&&captureManifest.key===key)captureManifest.imagePath=result.imagePath||captureManifest.imagePath;
	          safe(function(){if(window.gdHoleImageCaptureManifest&&window.gdHoleImageCaptureManifest.key===key)window.gdHoleImageCaptureManifest.imagePath=result.imagePath;});
	        }
	        return result;
	      })
	      .catch(function(error){return {ok:false,reason:"flatten-threw",error:String(error&&error.message||error)};})
	      .then(function(result){delete captureFlattenPending[key];return result;});
	    captureFlattenPending[key]=job;
	    return job;
	  }
	  /* Lets the visual engine hold its stitch until the flattens for a set of captures have
	     settled, then reports which manifests now own their pixels. Resolves on a timeout too,
	     so an offline browser degrades to tile stitching instead of hanging the build. */
	  function awaitCaptureFlattens(keys,timeoutMs){
	    keys=(Array.isArray(keys)?keys:[]).map(String).filter(Boolean);
	    var jobs=keys.map(function(key){return captureFlattenPending[key]||null;}).filter(Boolean);
	    var settled=Promise.all(jobs.map(function(job){return job.catch(function(){return null;});}));
	    var timer=new Promise(function(resolve){setTimeout(resolve,Math.max(1000,num(timeoutMs,25000)));});
	    return Promise.race([settled,timer]).then(function(){
	      var out={};
	      keys.forEach(function(key){
	        var stored=safe(function(){return JSON.parse(localStorage.getItem(key)||"null");},null);
	        if(stored&&stored.imagePath)out[key]={imagePath:stored.imagePath,flattenedAt:stored.flattenedAt||null};
	      });
	      return out;
	    });
	  }
	  window.gdAwaitCaptureFlattens=awaitCaptureFlattens;
	  function loadCaptureManifest(){
	    if(captureManifest&&manifestMatchesActive(captureManifest))return publishCaptureManifest(captureManifest);
	    if(captureManifest&&!manifestMatchesActive(captureManifest))captureManifest=null;
	    var visualManifest=loadPublishedCourseVisualManifest();
	    if(visualManifest)return visualManifest;
	    var m=safe(function(){return JSON.parse(localStorage.getItem(storageKey())||"null");},null);
	    if(!m&&typeof window.gdCapturedSurfaceReadManifest==="function")m=safe(function(){return window.gdCapturedSurfaceReadManifest(surfaceCourseKey(),surfaceHoleNumber());},null);
	    if(m&&Array.isArray(m.tiles)&&m.originPx&&m.surfaceModel!=="captured-surface-v1")m=null;
	    if(m&&!manifestMatchesActive(m))m=null;
	    if(m&&Array.isArray(m.tiles)&&m.originPx){
	      captureManifest=safe(function(){return typeof window.gdCapturedSurfaceWriteScan==="function"?window.gdCapturedSurfaceWriteScan(m,{reason:m.reason||"load",storageKey:storageKey()}):m;},m)||m;
	      gdRegisterCoursePlayFrameManifest(captureManifest,{generatedFrom:"v19-captured-surface-cache",manifestKey:storageKey(),status:"loaded"});
	      safe(function(){if(capturedGpsPlayActive())gdCoursePlayDebugEvent("gps-play-loaded-from-existing-frame",{reason:m.reason||"load",manifestKey:storageKey(),tileCount:(m.tiles||[]).length});});
	      return publishCaptureManifest(captureManifest);
	    }
	    return null;
	  }
		  function ensureCurrentCaptureManifest(reason){
		    var manifest=loadCaptureManifest();
		    if(manifest&&manifestMatchesActive(manifest))return manifest;
		    captureManifest=null;
		    manifest=loadCaptureManifest();
		    if(manifest&&manifestMatchesActive(manifest))return manifest;
		    if(capturedGpsPlayActive())return missingCapturedManifest(reason||"ensure-current",{stage:"ensure-current"});
		    var bounds=activeBounds("hole")||greenBounds("hole");
		    manifest=buildCaptureManifest(bounds,reason||"ensure-current");
		    if(manifest&&manifestMatchesActive(manifest))renderCaptureManifest(manifest);
		    return manifest&&manifestMatchesActive(manifest)?manifest:null;
		  }
	  function renderCaptureManifest(manifest){
	    manifest=manifest||loadCaptureManifest();
	    if(!manifest||!manifestMatchesActive(manifest))return false;
	    var el=document.getElementById("gdHoleImageCameraLayer");
	    if(!el){el=document.createElement("div");el.id="gdHoleImageCameraLayer";el.setAttribute("aria-hidden","true");document.body.appendChild(el);}
	    var manifestKey=String(manifest.key||manifest.storageKey||manifest.scanId||manifest.activeScanId||storageKey()||"");
	    var existingGroup=el.querySelector(".gdHoleImageTiles");
	    var sameRenderedSurface=!!(existingGroup&&
	      String(el.dataset.gdCapturedSurfaceManifestKey||"")===manifestKey&&
	      String(el.dataset.gdCapturedSurfaceHole||"")===String(manifest.holeNumber||"")&&
	      String(el.dataset.gdCapturedSurfaceCourse||"")===String(manifest.courseKey||manifest.courseName||"")&&
	      existingGroup.querySelectorAll(".gdHoleImageTile").length===(manifest.tiles||[]).length);
	    if(sameRenderedSurface){
	      clearTerminalCapturedUnavailable("render-capture-manifest");
	      clearHoleFrameLoading();
	      clearCapturedFrameUnavailable();
	      return true;
	    }
		    var tiles=(manifest.tiles||[]).map(function(t){
		      var w=Math.max(1,Math.round(Number(t.width)||258));
		      var h=Math.max(1,Math.round(Number(t.height)||258));
		      return '<img class="gdHoleImageTile" src="'+String(t.url).replace(/"/g,"&quot;")+'" style="left:'+Math.round(t.x)+'px;top:'+Math.round(t.y)+'px;width:'+w+'px!important;height:'+h+'px!important"/>';
		    }).join("");
		    el.innerHTML='<div class="gdHoleImageTiles" style="position:absolute;left:0;top:0;width:'+manifest.imageWidth+'px;height:'+manifest.imageHeight+'px;transform-origin:0 0">'+tiles+'<div class="gdHoleImageOverlay"></div></div>';
		    el.dataset.gdCapturedSurfaceHole=String(manifest.holeNumber||"");
			    el.dataset.gdCapturedSurfaceCourse=String(manifest.courseKey||manifest.courseName||"");
			    el.dataset.gdCapturedSurfaceScanId=String(manifest.scanId||manifest.activeScanId||"");
			    el.dataset.gdCapturedSurfaceManifestKey=manifestKey;
			    el.dataset.gdIncludeTee=manifest.includeTee?"1":"0";
		    if(manifest.teeLatLng){el.dataset.gdTeeLat=String(manifest.teeLatLng.lat);el.dataset.gdTeeLng=String(manifest.teeLatLng.lng);}
		    else{delete el.dataset.gdTeeLat;delete el.dataset.gdTeeLng;}
		    clearTerminalCapturedUnavailable("render-capture-manifest");
		    clearHoleFrameLoading();
		    clearCapturedFrameUnavailable();
		    return true;
		  }
	  function boundsPx(manifest,bounds){
    if(!manifest||!validBounds(bounds)||!hasMap())return null;
    var pts=boundsCorners(bounds).map(function(p){var q=map.project(asLL(p),manifest.captureZoom);return {x:q.x-manifest.originPx.x,y:q.y-manifest.originPx.y};});
	    var xs=pts.map(function(p){return p.x;}),ys=pts.map(function(p){return p.y;});
	    return {minX:Math.min.apply(null,xs),maxX:Math.max.apply(null,xs),minY:Math.min.apply(null,ys),maxY:Math.max.apply(null,ys),center:{x:(Math.min.apply(null,xs)+Math.max.apply(null,xs))/2,y:(Math.min.apply(null,ys)+Math.max.apply(null,ys))/2}};
	  }
	  function pointPx(manifest,point){
	    var ll=asLL(point);
	    if(!manifest||!validLL(ll)||!hasMap())return null;
	    var q=safe(function(){return map.project(ll,manifest.captureZoom);},null);
	    if(!q)return null;
	    return {x:q.x-manifest.originPx.x,y:q.y-manifest.originPx.y};
	  }
	  function rotatePx(p,angle){
	    var c=Math.cos(angle),s=Math.sin(angle);
	    return {x:p.x*c-p.y*s,y:p.x*s+p.y*c};
	  }
	  function rotatedBoundsPx(px,angle){
	    var pts=[
	      {x:px.minX,y:px.minY},
	      {x:px.maxX,y:px.minY},
	      {x:px.maxX,y:px.maxY},
	      {x:px.minX,y:px.maxY}
	    ].map(function(p){return rotatePx(p,angle);});
	    var xs=pts.map(function(p){return p.x;}),ys=pts.map(function(p){return p.y;});
	    return {
	      minX:Math.min.apply(null,xs),
	      maxX:Math.max.apply(null,xs),
	      minY:Math.min.apply(null,ys),
	      maxY:Math.max.apply(null,ys),
	      center:rotatePx(px.center,angle)
	    };
	  }
	  function centerOfRect(rect){
	    return rect?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:null;
	  }
	  function anchorPoint(manifest,name){
	    var pins=manifest&&manifest.anchorPins||{};
	    if(name==="tee")return asLL(pins.tee||manifest.teeLatLng);
	    if(name==="green")return asLL(pins.green)||currentGreenPoint();
	    return null;
	  }
	  function holeDualAnchorFit(manifest,px,angle,fr,baseScale,fitRatio,opts){
	    var tee=pointPx(manifest,anchorPoint(manifest,"tee"));
	    var green=pointPx(manifest,anchorPoint(manifest,"green"))||px.center;
	    if(!tee||!green)return null;
	    var rTee=rotatePx(tee,angle);
	    var rGreen=rotatePx(green,angle);
	    var sourceDx=rGreen.x-rTee.x;
	    var sourceDy=rGreen.y-rTee.y;
	    var sourceLen=Math.sqrt(sourceDx*sourceDx+sourceDy*sourceDy);
	    var desiredGreen=centerOfRect(fr);
	    var desiredTee=centerOfRect(frameRect("tee"));
	    if(!desiredGreen||!desiredTee||sourceLen<10)return null;
	    var desiredDx=desiredGreen.x-desiredTee.x;
	    var desiredDy=desiredGreen.y-desiredTee.y;
	    var desiredLen=Math.sqrt(desiredDx*desiredDx+desiredDy*desiredDy);
	    if(desiredLen<10)return null;
		    var singleScale=baseScale*fitRatio;
		    var axisScale=desiredLen/sourceLen;
		    var scale=Math.max(.08,Math.min(num(opts.maxScale,4),singleScale,axisScale));
	    var tx=desiredGreen.x-rGreen.x*scale;
	    var ty=desiredGreen.y-rGreen.y*scale;
	    var teeScreen={x:tx+rTee.x*scale,y:ty+rTee.y*scale};
	    var errX=teeScreen.x-desiredTee.x;
	    var errY=teeScreen.y-desiredTee.y;
	    return {
	      scale:scale,
	      tx:tx,
	      ty:ty,
	      source:"tee-green",
	      teeErrorPx:Math.sqrt(errX*errX+errY*errY),
	      greenAnchor:"box-1",
	      teeAnchor:"tee"
	    };
	  }
	  function hideWaiting(){
	    safe(function(){document.body.classList.remove("gdWaitingForConfirmedGreen","gdFrameCameraWaiting");});
	  }
	  function capturedGpsPlayActive(){
	    return safe(function(){
	      if(!document.body||window.gdFullMappingMode||document.body.classList.contains("gdFullMappingMode"))return false;
	      if(window.__gdMapperObjectCaptureActive)return false;
	      if(document.body.classList.contains("gdCourseOpening"))return false;
	      if(document.getElementById("courseScreen")&&!document.getElementById("courseScreen").classList.contains("hidden"))return false;
	      return document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active")||document.body.dataset.clarityRoute==="gps";
	    },false);
	  }
	  function unavailableMessage(){
	    return "Frame unavailable - remap this hole";
	  }
	  var HOLE_FRAME_LOADING_TIMEOUT_MS=1700;
	  var holeFrameLoadingTimer=null;
	  var holeFrameLoadingKey="";
	  var terminalCapturedFrameUnavailableByKey={};
	  function holeSwitchMessage(hole){
	    return "Loading Hole "+String(hole||surfaceHoleNumber()||1)+" frame...";
	  }
	  function ensureHoleSwitchMask(hole){
	    var el=document.getElementById("gdCoursePlayHoleTransitionMask");
	    if(!el&&document.body){el=document.createElement("div");el.id="gdCoursePlayHoleTransitionMask";el.setAttribute("role","status");el.setAttribute("aria-live","polite");el.innerHTML="<span></span>";document.body.appendChild(el);}
	    var label=el&&el.querySelector("span");
	    if(label)label.textContent=holeSwitchMessage(hole);
	    return el;
	  }
	  function gdBeginGpsHoleSwitchTransition(hole,reason,token){
	    safe(function(){
	      hole=Number(hole)||surfaceHoleNumber()||1;
	      if(typeof window.gdClearManualStartRuntime==="function")window.gdClearManualStartRuntime((reason||"hole-switch")+"-transition",{preserveMappedPrompt:false});
	      ensureHoleSwitchMask(hole);
	      var loading=document.getElementById("gdHoleFrameLoading");
	      if(!loading&&document.body){loading=document.createElement("div");loading.id="gdHoleFrameLoading";loading.setAttribute("role","status");loading.setAttribute("aria-live","polite");document.body.appendChild(loading);}
	      if(loading)loading.textContent=holeSwitchMessage(hole);
		      document.body.classList.add("gdGpsHoleTransitioning","gdHoleFrameLoading","gdGpsFramePreparing","gdGpsLiveMapSuppressed");
		      document.body.classList.remove("gdCapturedFrameUnavailable","gdGpsPresentationReady","gdGpsLiveMapAllowed");
		      document.body.dataset.gdGpsHoleTransitionTarget=String(hole);
	      document.body.dataset.gdGpsHoleTransitionToken=String(token||"");
	      document.body.dataset.gdGpsHoleTransitionReason=String(reason||"hole-switch");
	      document.body.dataset.gdGpsHoleTransitionAt=String(Date.now());
		      window.__gdGpsHoleTransitioning={hole:hole,reason:reason||"hole-switch",token:token||"",at:Date.now()};
		      delete window.__gdGpsCapturedPresentationStamp;
		      gdCoursePlayDebugEvent("gps-play-hole-transition-start",{reason:reason||"hole-switch",targetHole:hole,token:token||"",visibleOwner:visiblePreparingOwner()});
	      if(typeof window.gdApplyGpsMapVisibilityOwner==="function")window.gdApplyGpsMapVisibilityOwner("hole-switch-start");
	    });
	    return true;
	  }
	  function gdEndGpsHoleSwitchTransition(reason){
	    return safe(function(){
	      if(!window.__gdGpsHoleTransitioning&&!(document.body&&document.body.classList.contains("gdGpsHoleTransitioning")))return false;
	      var state=window.__gdGpsHoleTransitioning||{};
	      var active=surfaceHoleNumber();
	      var target=Number(state.hole||document.body.dataset.gdGpsHoleTransitionTarget||active)||active;
	      if(Math.round(target)!==Math.round(active))return false;
	      var layer=document.getElementById("gdHoleImageCameraLayer");
	      var layerHole=Number(layer&&layer.dataset&&layer.dataset.gdCapturedSurfaceHole);
	      if(Number.isFinite(layerHole)&&Math.round(layerHole)!==Math.round(active))return false;
	      var last=window.__gdV19LastCapturedFit||{};
	      var lastHole=Number(last.hole);
	      if(Number.isFinite(lastHole)&&Math.round(lastHole)!==Math.round(active))return false;
		      var manifest=loadCaptureManifest();
		      if(!manifest||!manifestMatchesActive(manifest))return false;
		      var stamp=window.__gdGpsCapturedPresentationStamp||{};
		      var stampHole=Number(stamp.hole);
		      if(Number.isFinite(stampHole)&&Math.round(stampHole)!==Math.round(active))return false;
		      if(state.token&&String(stamp.transitionToken||"")!==String(state.token))return false;
		      document.body.classList.remove("gdGpsHoleTransitioning","gdHoleFrameLoading","gdGpsFramePreparing");
	      delete window.__gdGpsHoleTransitioning;
	      delete document.body.dataset.gdGpsHoleTransitionTarget;
	      delete document.body.dataset.gdGpsHoleTransitionToken;
	      document.body.dataset.gdGpsHoleTransitionClearedBy=String(reason||"captured-frame-ready");
	      gdCoursePlayDebugEvent("gps-play-hole-transition-ready",{reason:reason||"captured-frame-ready",targetHole:active,manifestKey:manifest.key||manifest.storageKey||"",visibleOwner:visiblePreparingOwner()});
	      if(typeof window.gdApplyGpsMapVisibilityOwner==="function")window.gdApplyGpsMapVisibilityOwner(reason||"hole-switch-ready");
	      return true;
	    },false);
	  }
	  function holeFrameKey(){
	    return String(surfaceCourseKey()||"course")+":h"+String(surfaceHoleNumber()||1);
	  }
	  function loadingMessage(){
	    return "Loading Hole "+String(surfaceHoleNumber()||1)+" frame...";
	  }
	  function activeMappedCourse(){
	    if(renderSurfaceOverride&&renderSurfaceOverride.course)return renderSurfaceOverride.course;
	    return safe(function(){
	      var course=null;
	      if(typeof loadUserCourseData==="function")course=loadUserCourseData();
	      if(!course&&typeof window.loadUserCourseData==="function")course=window.loadUserCourseData();
	      if(!course&&typeof currentCourse!=="undefined")course=currentCourse;
	      return course||null;
	    },null);
	  }
	  function activePipelineHoleState(){
	    return safe(function(){
	      var pipeline=window.GDCoursePlayPipeline;
	      if(!pipeline||typeof pipeline.getActiveHolePlayState!=="function")return null;
	      var state=pipeline.getActiveHolePlayState(surfaceHoleNumber());
	      if(document.body&&state){
	        document.body.dataset.gdCoursePlayPipelineStatus=String(state.status||"unknown");
	        document.body.dataset.gdCoursePlayPipelineHole=String(state.holeNumber||surfaceHoleNumber());
	      }
	      return state||null;
	    },null);
	  }
	  function activeMappedHoleData(){
	    return safe(function(){
	      var pipeline=window.GDCoursePlayPipeline;
	      var h=surfaceHoleNumber();
	      var data=pipeline&&typeof pipeline.getActiveHoleMappedData==="function"?pipeline.getActiveHoleMappedData(h):null;
	      if(data&&Array.isArray(data.route)&&data.route.length>=2)return data;
	      var course=activeMappedCourse();
	      data=null;
	      if(course&&typeof window.gdMappedHolePlayData==="function")data=window.gdMappedHolePlayData(course,h);
	      else if(course&&typeof gdMappedHolePlayData==="function")data=gdMappedHolePlayData(course,h);
	      if(data&&pipeline&&typeof pipeline.ingestMappedHole==="function")safe(function(){pipeline.ingestMappedHole(course,h,data,"gps-play-read-fallback");});
	      return data||null;
	    },null);
	  }
	  function mappedGeometryExistsForActiveHole(){
	    var data=activeMappedHoleData();
	    return !!(data&&Array.isArray(data.route)&&data.route.length>=2);
	  }
	  function coursePlayPoint(value){
	    return mappedPoint(value&&(value.position||value.center||value.centre||value.pin||value.greenCenter||value.greenCentre||value));
	  }
	  function coursePlayFrameData(){
	    var state=activePipelineHoleState();
	    if(String(state&&state.status||"")!=="play_data_ready")return null;
	    var data=activeMappedHoleData();
	    var route=mappedRoute(data);
	    var green=coursePlayPoint(data&&data.green)||asLL(route[route.length-1]);
	    if(route.length<2||!validLL(green))return null;
	    return data;
	  }
	  function coursePlayGreenBounds(data){
	    var shape=mappedShape(data);
	    var green=coursePlayPoint(data&&data.green)||asLL((mappedRoute(data)||[]).slice(-1)[0]);
	    var b=boundsFromPoints(shape);
	    if(validBounds(b))return b;
	    return pointBounds(green,22);
	  }
	  function gdCoursePlayDebugEvent(type,detail){
	    safe(function(){
	      if(window.GDCoursePlayPipeline&&typeof window.GDCoursePlayPipeline.recordDebugEvent==="function"){
	        window.GDCoursePlayPipeline.recordDebugEvent(type,Object.assign({
	          courseId:surfaceCourseKey(),
	          courseName:surfaceCourseName(),
	          holeNumber:surfaceHoleNumber()
	        },detail||{}));
	      }
	    });
	  }
	  function gdCoursePlayFrameCourseRef(){
	    return safe(function(){
	      if(renderSurfaceOverride&&(renderSurfaceOverride.course||renderSurfaceOverride.courseKey))return renderSurfaceOverride.course||renderSurfaceOverride.courseKey;
	      var state=activePipelineHoleState();
	      if(state&&(state.courseId||state.courseKey))return state.courseId||state.courseKey;
	      return activeMappedCourse()||surfaceCourseKey();
	    },surfaceCourseKey());
	  }
	  function gdRegisterCoursePlayFrameManifest(manifest,opts){
	    return safe(function(){
	      if(!window.GDCoursePlayPipeline||typeof window.GDCoursePlayPipeline.registerCoursePlayFrame!=="function")return null;
	      return window.GDCoursePlayPipeline.registerCoursePlayFrame(gdCoursePlayFrameCourseRef(),surfaceHoleNumber(),manifest,opts||{});
	    },null);
	  }
	  /* Builds a v19 manifest from a worker-exported cloud surface. The export is a north-up
	     mercator JPEG on an (originPx, captureZoom) grid - exactly the captured-surface model -
	     so it enters the pipeline as a manifest whose tile list is ONE image covering the whole
	     surface. Everything downstream (render, fit, shot projection, registration) is unchanged. */
	  function cloudPublishedSurfaceManifest(reason){
	    return safe(function(){
	      var engine=window.GDCourseVisualEngine;
	      if(!engine||typeof engine.getRecord!=="function")return null;
	      var hole=Number(surfaceHoleNumber())||0;
	      if(!hole)return null;
	      /* Already built this hole's cloud manifest? Reuse the stored copy instead of
	         re-registering on every render. */
	      var stored=safe(function(){return JSON.parse(localStorage.getItem(storageKey())||"null");},null);
	      if(stored&&stored.cloudPublishedSurface&&Number(stored.holeNumber)===hole&&manifestMatchesActive(stored))return stored;
	      var record=engine.getRecord(surfaceCourseKey());
	      if(!record)return null;
	      var lists=[record.holeFramePublishedVisuals,record.holeFrameVisuals];
	      var asset=null;
	      for(var i=0;i<lists.length&&!asset;i++){
	        asset=(Array.isArray(lists[i])?lists[i]:[]).find(function(item){
	          var ps=item&&item.metadata&&item.metadata.playSurface;
	          return item&&Number(item.holeNumber)===hole&&(item.url||item.publicUrl)&&ps&&ps.model==="mercator-image"&&ps.originPx&&Number.isFinite(Number(ps.captureZoom));
	        })||null;
	      }
	      if(!asset){
	        /* Record not pulled yet (fresh device, or entered play before the pull finished).
	           Pull once, then re-render the hole - the cloud surface swaps in seconds later
	           instead of the device being stuck on whatever it shuttered first. */
	        var pullFlag="__gdCloudSurfacePullAt_"+surfaceCourseKey();
	        if(typeof engine.pullCourseVisual==="function"&&(!window[pullFlag]||Date.now()-window[pullFlag]>60000)){
	          window[pullFlag]=Date.now();
	          safe(function(){
	            engine.pullCourseVisual(surfaceCourseKey()).then(function(){
	              safe(function(){if(typeof window.gdEnsureCoursePlayFrameRendered==="function")window.gdEnsureCoursePlayFrameRendered();});
	            }).catch(function(){});
	          });
	        }
	        return null;
	      }
	      var ps=asset.metadata.playSurface;
	      var width=Math.round(Number(ps.outputDimensions&&ps.outputDimensions.width||asset.width)||0);
	      var height=Math.round(Number(ps.outputDimensions&&ps.outputDimensions.height||asset.height)||0);
	      if(!width||!height)return null;
	      var pins=ps.anchorPins||{};
	      var manifest={
	        version:VERSION,
	        key:storageKey(),
	        reason:reason||"cloud-published-surface",
	        surfaceModel:"captured-surface-v1",
	        interactionOwner:"captured-surface",
	        liveMapRole:"capture-source-diagnostic-reference",
	        courseKey:surfaceCourseKey(),
	        courseName:surfaceCourseName(),
	        holeNumber:hole,
	        captureZoom:Number(ps.captureZoom),
	        originPx:{x:Number(ps.originPx.x),y:Number(ps.originPx.y)},
	        imageWidth:width,
	        imageHeight:height,
	        anchorPins:pins,
	        includeTee:!!pins.tee,
	        teeLatLng:pins.tee||null,
	        cloudPublishedSurface:true,
	        tiles:[{x:0,y:0,width:width,height:height,z:null,url:String(asset.url||asset.publicUrl)}],
	        createdAt:new Date().toISOString()
	      };
	      manifest=safe(function(){return typeof window.gdCapturedSurfaceWriteScan==="function"?window.gdCapturedSurfaceWriteScan(manifest,{reason:manifest.reason,storageKey:storageKey()}):manifest;},manifest)||manifest;
	      captureManifest=manifest;
	      window.gdHoleImageCaptureManifest=manifest;
	      window.__gdLastHoleImageCaptureManifest=manifest;
	      window.__gdV19CapturedHoleFrameManifest=manifest;
	      safe(function(){localStorage.setItem(storageKey(),JSON.stringify(manifest));});
	      gdRegisterCoursePlayFrameManifest(manifest,{generatedFrom:"cloud-published-surface",manifestKey:storageKey(),status:"generated"});
	      gdCoursePlayDebugEvent("gps-play-loaded-cloud-surface",{manifestKey:storageKey(),holeNumber:hole,url:String(asset.url||asset.publicUrl).slice(0,140)});
	      return manifest;
	    },null);
	  }
	  function gdRenderCoursePlayHoleFrame(courseId,holeNumber,holePlayData,opts){
	    opts=opts||{};
	    if(window.gdFullMappingMode||document.body&&document.body.classList.contains("gdFullMappingMode"))return false;
	    var previousOverride=renderSurfaceOverride;
	    if(courseId||holeNumber||holePlayData){
	      var courseObject=courseId&&typeof courseId==="object"?courseId:null;
	      renderSurfaceOverride={
	        course:courseObject||courseId||null,
	        courseKey:String(courseObject&&(courseObject.courseId||courseObject.key||courseObject.id)||courseId||surfaceCourseKey()||"course"),
	        courseName:String(courseObject&&(courseObject.courseName||courseObject.name||courseObject.title)||surfaceCourseName()||"Course"),
	        holeNumber:Number(holeNumber)||surfaceHoleNumber(),
	        data:holePlayData||null,
	        source:opts.reason||"course-play-pipeline"
	      };
	    }
	    try{
	      var data=holePlayData||coursePlayFrameData();
	      if(!data)return false;
	      var bounds=coursePlayGreenBounds(data);
	      if(!validBounds(bounds))return false;
	      /* Priority: published cloud surface (styled, current recipe, owned pixels) beats any
	         auto-shuttered local capture; local remains the fallback, the live shutter last.
	         If the cloud record hasn't arrived yet, cloudPublishedSurfaceManifest pulls it and
	         re-renders, so a fresh device self-upgrades seconds after first paint. */
	      var cloudManifest=cloudPublishedSurfaceManifest(opts.reason||"course-play-pipeline");
	      var manifest=cloudManifest||loadCaptureManifest();
	      var loadedExisting=!cloudManifest&&!!(manifest&&manifestMatchesActive(manifest));
	      if(!manifest||!manifestMatchesActive(manifest)){
	        captureManifest=null;
	        manifest=buildCaptureManifest(bounds,opts.reason||"course-play-pipeline");
	      }
	      if(!manifest||!manifestMatchesActive(manifest))return false;
	      if(opts.cacheOnly)return true;
	      if(!renderCaptureManifest(manifest))return false;
	      var ok=fitCaptured(bounds,"hole",.025,{objectName:"coursePlayPipelineHoleFrame",reason:opts.reason||"course-play-pipeline",maxScale:7.2,fitRatio:.94});
	      if(ok){
	        clearTerminalCapturedUnavailable("course-play-pipeline-rendered");
	        clearStalePreparingOwners("course-play-pipeline-rendered");
	        safe(function(){
	          document.body.dataset.gdCoursePlayFrameRendered="1";
	          document.body.dataset.gdCoursePlayFrameRenderedHole=String(holeNumber||surfaceHoleNumber());
	          document.body.dataset.gdCoursePlayFrameRenderedAt=String(Date.now());
	        });
	        gdCoursePlayDebugEvent("gps-play-rendered-frame",{reason:opts.reason||"course-play-pipeline",manifestKey:manifest.key||manifest.storageKey||"",loadedExisting:loadedExisting,frameIndexKey:String(surfaceCourseKey()||"course")+":h"+String(surfaceHoleNumber()||1)});
	      }
	      return !!ok;
	    }finally{
	      renderSurfaceOverride=previousOverride;
	    }
	  }
	  function gdEnsureCoursePlayFrameRendered(courseId,holeNumber){
	    return gdRenderCoursePlayHoleFrame(courseId,holeNumber,null,{reason:"course-play-pipeline"});
	  }
	  function gdBuildCourseVisualCaptureManifest(request){
	    request=request||{};
	    if(window.gdFullMappingMode||document.body&&document.body.classList.contains("gdFullMappingMode"))return null;
	    var bounds=coerceBounds(request.bounds);
	    if(!validBounds(bounds))return null;
	    var previousOverride=renderSurfaceOverride;
	    var role=String(request.role||"course-backdrop");
	    var holeNumber=Number(request.holeNumber)||1;
	    var courseKey=String(request.courseKey||request.courseId||surfaceCourseKey()||"course");
	    renderSurfaceOverride={
	      course:request.course||request.courseId||courseKey,
	      courseKey:courseKey,
	      courseName:String(request.courseName||request.courseLabel||surfaceCourseName()||courseKey),
	      holeNumber:holeNumber,
	      data:request.holeData||null,
	      source:request.reason||"course-visual-capture",
	      captureRole:role,
	      captureKey:String(request.captureKey||request.planId||[courseKey,"h"+holeNumber,role].join(":"))
	    };
	    try{
	      return buildCaptureManifest(bounds,request.reason||("course-visual-"+role+"-visual-lock"),{
	        role:role,
	        quality:request.quality||"",
	        planId:request.planId||request.id||"",
	        stitchLayer:request.stitchLayer,
	        targetZoom:request.targetZoom,
	        minZoom:request.minZoom,
	        maxZoom:request.maxZoom,
	        maxTiles:request.maxTiles,
	        bleedPx:request.bleedPx,
	        captureLens:request.captureLens||request.lensShape,
	        lensShape:request.lensShape||request.captureLens,
	        lensAspectRatio:request.lensAspectRatio||request.lensAspect,
		        lensOrientation:request.lensOrientation,
		        lensFit:request.lensFit,
		        anchorPins:request.anchorPins,
		        captureAnchorPins:request.captureAnchorPins,
		        includeAnchorPins:request.includeAnchorPins,
		        segmentIndex:request.segmentIndex,
	        segmentCount:request.segmentCount,
	        segmentStartMeters:request.segmentStartMeters,
	        segmentEndMeters:request.segmentEndMeters,
	        routeLengthMeters:request.routeLengthMeters,
	        tileTemplate:request.tileTemplate,
	        tileSourceLabel:request.tileSourceLabel,
		        lockBounds:request.lockBounds===true,
	        debugUnderlay:!!request.debugUnderlay,
	        debugTerrain:!!request.debugTerrain,
	        terrainStageOnly:!!request.terrainStageOnly,
	        beta3dStageOnly:!!request.beta3dStageOnly,
	        cameraMode:request.cameraMode,
	        cameraTiltDeg:request.cameraTiltDeg,
	        captureTiltDeg:request.captureTiltDeg,
	        playTiltDeg:request.playTiltDeg,
	        backgroundCapture:true,
	        skipCoursePlayFrameRegister:true
	      });
	    }finally{
	      renderSurfaceOverride=previousOverride;
	    }
	  }
	  window.gdRenderCoursePlayHoleFrame=gdRenderCoursePlayHoleFrame;
	  window.gdEnsureCoursePlayFrameRendered=gdEnsureCoursePlayFrameRendered;
	  window.gdBuildCourseVisualCaptureManifest=gdBuildCourseVisualCaptureManifest;
	  function activePipelineStatus(){
	    var state=activePipelineHoleState();
	    return String(state&&state.status||"");
	  }
	  function pipelineReadyForActiveHole(){
	    return activePipelineStatus()==="play_data_ready";
	  }
	  function hideCourseOpeningOverlay(reason){
	    safe(function(){
	      var el=document.getElementById("gdCourseLoadingOverlay");
	      if(el)el.classList.add("hidden");
	      if(document.body){
	        document.body.classList.remove("gdCourseOpening");
	        document.body.dataset.gdCourseOpeningClearedBy=String(reason||"v19-handoff");
	      }
	    });
	  }
	  function visiblePreparingOwner(){
	    return safe(function(){
	      var overlay=document.getElementById("gdCourseLoadingOverlay");
	      if(overlay&&!overlay.classList.contains("hidden")&&getComputedStyle(overlay).display!=="none")return "course-opening-overlay";
	      if(document.body&&document.body.classList.contains("gdCoursePlayPipelinePreparing"))return "course-play-pipeline-pill";
	      if(document.body&&document.body.classList.contains("gdHoleFrameLoading"))return "v19-hole-frame-loading";
	      return "none";
	    },"unknown");
	  }
	  function clearStalePreparingOwners(reason){
	    hideCourseOpeningOverlay(reason);
	    safe(function(){
	      var status=activePipelineStatus();
	      if(status&&status!=="unknown"&&status!=="mapping"&&status!=="play_data_preparing"){
	        document.body.classList.remove("gdCoursePlayPipelinePreparing");
	        var el=document.getElementById("gdCoursePlayPipelineStatus");
	        if(el&&status==="play_data_ready")el.textContent="";
	      }
	    });
	  }
	  function terminalCapturedUnavailableActive(){
	    var entry=terminalCapturedFrameUnavailableByKey[holeFrameKey()];
	    return !!(entry&&pipelineReadyForActiveHole());
	  }
	  function markTerminalCapturedUnavailable(reason,context){
	    var key=holeFrameKey();
	    terminalCapturedFrameUnavailableByKey[key]={reason:reason||"pipeline-ready-captured-presentation-timeout",context:context||{},at:Date.now(),hole:surfaceHoleNumber(),course:surfaceCourseKey(),visibleOwner:visiblePreparingOwner()};
	    window.__gdTerminalCapturedFrameUnavailable=terminalCapturedFrameUnavailableByKey[key];
	    safe(function(){
	      document.body.dataset.gdTerminalCapturedFrameUnavailableKey=key;
	      document.body.dataset.gdTerminalCapturedFrameUnavailableReason=String(reason||"pipeline-ready-captured-presentation-timeout");
	    });
	    return gdCapturedFrameUnavailable(reason||"pipeline-ready-captured-presentation-timeout",Object.assign({stage:"terminal-v19-handoff",visibleOwner:visiblePreparingOwner()},context||{}));
	  }
	  function clearTerminalCapturedUnavailable(reason){
	    safe(function(){
	      delete terminalCapturedFrameUnavailableByKey[holeFrameKey()];
	      delete window.__gdTerminalCapturedFrameUnavailable;
	      delete document.body.dataset.gdTerminalCapturedFrameUnavailableKey;
	      document.body.dataset.gdTerminalCapturedFrameUnavailableClearedBy=String(reason||"captured-presentation-ready");
	    });
	  }
	  function clearHoleFrameLoading(){
	    safe(function(){
	      if(holeFrameLoadingTimer){clearTimeout(holeFrameLoadingTimer);holeFrameLoadingTimer=null;}
	      if(document.body)document.body.classList.remove("gdHoleFrameLoading");
	      delete window.__gdHoleFrameLoading;
	    });
	  }
	  function clearCapturedFrameUnavailable(){
	    safe(function(){document.body.classList.remove("gdCapturedFrameUnavailable");});
	  }
	  function gdHoleFrameLoading(reason,context){
	    if(capturedGpsPlayActive()&&terminalCapturedUnavailableActive())return !!gdCapturedFrameUnavailable("terminal-v19-handoff",Object.assign({stage:"terminal-v19-handoff-repeat",visibleOwner:visiblePreparingOwner()},context||{}));
	    safe(function(){
	      var key=holeFrameKey();
	      var el=document.getElementById("gdHoleFrameLoading");
	      if(!el&&document.body){el=document.createElement("div");el.id="gdHoleFrameLoading";el.setAttribute("role","status");el.setAttribute("aria-live","polite");document.body.appendChild(el);}
	      if(el)el.textContent=loadingMessage();
	      if(document.body){
	        document.body.classList.add("gdHoleFrameLoading","gdGpsFramePreparing");
	        document.body.classList.remove("gdCapturedFrameUnavailable","gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn");
	        document.body.dataset.gdHoleFrameLoadingReason=String(reason||"frame-loading");
	        document.body.dataset.gdHoleFrameLoadingAt=String(Date.now());
	      }
	      if(typeof setState==="function")setState(loadingMessage());
	      window.__gdHoleFrameLoading={reason:reason||"frame-loading",context:context||{},hole:surfaceHoleNumber(),course:surfaceCourseKey(),at:Date.now()};
	      gdCoursePlayDebugEvent("gps-play-showed-loading",{reason:reason||"frame-loading",status:activePipelineStatus(),visibleOwner:visiblePreparingOwner()});
	      if(holeFrameLoadingKey!==key&&holeFrameLoadingTimer){clearTimeout(holeFrameLoadingTimer);holeFrameLoadingTimer=null;}
	      holeFrameLoadingKey=key;
	      if(!holeFrameLoadingTimer){
	        holeFrameLoadingTimer=setTimeout(function(){
	          holeFrameLoadingTimer=null;
	          if(holeFrameKey()!==key||!document.body||!document.body.classList.contains("gdHoleFrameLoading"))return;
	          var b=greenBounds("hole");
	          var manifest=loadCaptureManifest();
	          if(manifest&&validBounds(b)&&fitCaptured(b,"hole",.025,{objectName:"capturedGreenHoleFrame",reason:"loading-ready",maxScale:7.2,fitRatio:.94}))return;
	          if(pipelineReadyForActiveHole()&&gdEnsureCoursePlayFrameRendered(surfaceCourseKey(),surfaceHoleNumber()))return;
	          if(pipelineReadyForActiveHole())return markTerminalCapturedUnavailable("pipeline-ready-captured-presentation-timeout",Object.assign({stage:"loading-timeout"},context||{}));
	          gdCapturedFrameUnavailable("frame-loading-timeout",Object.assign({stage:"loading-timeout"},context||{}));
	        },HOLE_FRAME_LOADING_TIMEOUT_MS);
	      }
	      if(typeof window.gdApplyGpsMapVisibilityOwner==="function")window.gdApplyGpsMapVisibilityOwner("hole-frame-loading");
	    });
	    readout("frame loading | "+(reason||"frame-loading"));
	    return true;
	  }
	  function missingCapturedManifest(reason,context){
	    var pipelineState=activePipelineHoleState();
	    var pipelineStatus=String(pipelineState&&pipelineState.status||"");
	    if(capturedGpsPlayActive()&&terminalCapturedUnavailableActive())return !!gdCapturedFrameUnavailable(reason||"terminal-v19-handoff",Object.assign({stage:"terminal-v19-handoff",pipelineStatus:pipelineStatus},context||{}));
	    if(capturedGpsPlayActive()&&pipelineStatus){
	      if(pipelineStatus==="play_data_unavailable"||pipelineStatus==="needs_remap")return !!gdCapturedFrameUnavailable(reason||"pipeline-unavailable",Object.assign({stage:"pipeline",pipelineStatus:pipelineStatus},context||{}));
	      if(pipelineStatus==="unknown"||pipelineStatus==="mapping"||pipelineStatus==="play_data_preparing")return gdHoleFrameLoading(reason||"pipeline-loading",Object.assign({stage:"pipeline",pipelineStatus:pipelineStatus},context||{}));
	      if(pipelineStatus==="play_data_ready"){
	        if(gdEnsureCoursePlayFrameRendered(surfaceCourseKey(),surfaceHoleNumber()))return true;
	        return !!markTerminalCapturedUnavailable(reason||"pipeline-ready-render-adapter-failed",Object.assign({stage:"pipeline-render-adapter",pipelineStatus:pipelineStatus},context||{}));
	      }
	    }
	    if(capturedGpsPlayActive()&&mappedGeometryExistsForActiveHole())return gdHoleFrameLoading(reason||"frame-loading",context||{});
	    return !!gdCapturedFrameUnavailable(reason||"missing-frame",context||{});
	  }
	  function gdCapturedFrameUnavailable(reason,context){
	    safe(function(){
	      clearHoleFrameLoading();
	      clearStalePreparingOwners(reason||"captured-frame-unavailable");
	      var el=document.getElementById("gdCapturedFrameUnavailable");
	      if(!el&&document.body){el=document.createElement("div");el.id="gdCapturedFrameUnavailable";el.setAttribute("role","status");el.setAttribute("aria-live","polite");document.body.appendChild(el);}
	      if(el)el.textContent=unavailableMessage();
	      if(document.body){
	        document.body.classList.add("gdCapturedFrameUnavailable");
	        document.body.classList.remove("gdGpsHoleTransitioning","gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn","gdFrameCameraWaiting","gdWaitingForConfirmedGreen","gdGpsPresentationReady","gdGpsLiveMapAllowed");
	        document.body.dataset.gdCapturedFrameUnavailableReason=String(reason||"missing-frame");
	        document.body.dataset.gdCapturedFrameUnavailableAt=String(Date.now());
	      }
	      delete window.__gdGpsHoleTransitioning;
	      delete window.__gdGpsCapturedPresentationStamp;
	      if(typeof setState==="function")setState("Frame unavailable");
	      if(typeof toast==="function"&&(!window.__gdCapturedFrameUnavailableToastAt||Date.now()-Number(window.__gdCapturedFrameUnavailableToastAt||0)>1800)){
	        window.__gdCapturedFrameUnavailableToastAt=Date.now();
	        toast(unavailableMessage());
	      }
	      window.__gdCapturedFrameUnavailable={reason:reason||"missing-frame",context:context||{},hole:surfaceHoleNumber(),course:surfaceCourseKey(),at:Date.now()};
	      gdCoursePlayDebugEvent("gps-play-fell-to-unavailable",{reason:reason||"missing-frame",status:activePipelineStatus(),visibleOwner:visiblePreparingOwner()});
	      if(typeof window.gdApplyGpsMapVisibilityOwner==="function")window.gdApplyGpsMapVisibilityOwner("captured-frame-unavailable");
	    });
	    readout("frame unavailable | "+(reason||"missing-frame"));
	    return null;
	  }
	  window.__gdDumpGpsPlayReadiness=function(){
	    return safe(function(){
	      var manifest=loadCaptureManifest();
	      return {
	        courseKey:surfaceCourseKey(),
	        hole:surfaceHoleNumber(),
	        pipelineStatus:activePipelineStatus(),
	        coursePlayFrameDataReady:!!coursePlayFrameData(),
	        visiblePreparingOwner:visiblePreparingOwner(),
	        holeFrameLoading:!!(document.body&&document.body.classList.contains("gdHoleFrameLoading")),
	        capturedFrameUnavailable:!!(document.body&&document.body.classList.contains("gdCapturedFrameUnavailable")),
	        gpsPresentationReady:!!(typeof window.gdGpsPresentationReady==="function"&&window.gdGpsPresentationReady()),
	        capturedManifestKey:manifest&&(manifest.key||manifest.storageKey||manifest.scanId||manifest.activeScanId)||"",
	        terminalUnavailable:!!terminalCapturedFrameUnavailableByKey[holeFrameKey()],
	        bodyClasses:String(document.body&&document.body.className||"")
	      };
	    },null);
	  };
		  function hideCapturedCamera(){
			    safe(function(){document.body.classList.remove("gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn","gdHeadToTeeFrameActive","gdLockStateFrameActive");});
			    clearHoleFrameLoading();
			    clearCapturedFrameUnavailable();
			    safe(function(){delete window.__gdGpsCapturedPresentationStamp;});
			    var group=document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles");
		    if(group)group.style.transform="";
	    lockCameraFrozen=false;
	    safe(function(){delete window.__gdV19LockCameraFrozen;});
	    clearShotOverlay();
	  }
  function readout(text){
    var el=document.getElementById("gdCapturedHoleFrameReadout");
    if(!el&&document.body){el=document.createElement("div");el.id="gdCapturedHoleFrameReadout";document.body.appendChild(el);}
    if(el)el.textContent="v19 captured hole frame | "+(text||"");
  }
			  function fitCaptured(bounds,frame,padding,opts){
	    opts=opts||{};
	    hideWaiting();
	    if(!hasMap()||!validBounds(bounds))return false;
	    var manifest=opts.refreshCapture?null:loadCaptureManifest();
	    if(!manifest&&capturedGpsPlayActive())return missingCapturedManifest(opts.reason||frame,{stage:"fitCaptured",frame:frame||"hole",objectName:opts.objectName||""});
	    if(!manifest)manifest=buildCaptureManifest(bounds,opts.reason||frame)||loadCaptureManifest();
	    if(!manifest||!renderCaptureManifest(manifest)){
	      if(capturedGpsPlayActive())return !!gdCapturedFrameUnavailable(opts.reason||frame,{stage:"render",frame:frame||"hole",objectName:opts.objectName||""});
	      return false;
	    }
    var px=boundsPx(manifest,bounds);
    if(!px)return false;
    var fr=frameRect(frame||"hole");
    padding=Math.max(0,Math.min(.28,num(padding,.025)));
		    var orientation=capturedOrientationAxis(bounds,frame||"hole");
		    var angle=orientation&&Number.isFinite(orientation.bearingRad)?-Number(orientation.bearingRad):0;
		    var rpx=rotatedBoundsPx(px,angle);
    var usableW=Math.max(30,fr.width*(1-padding*2)),usableH=Math.max(30,fr.height*(1-padding*2));
    var objW=Math.max(2,rpx.maxX-rpx.minX),objH=Math.max(2,rpx.maxY-rpx.minY);
	    var baseScale=Math.min(usableW/objW,usableH/objH);
	    var fitRatio={hole:.94,lock:.94,zoom:.96,tee:.94}[frame||"hole"]||.94;
	    fitRatio=Math.max(.18,Math.min(1,num(opts.fitRatio,fitRatio)));
	    var scale=baseScale*fitRatio;
	    scale=Math.max(.08,Math.min(num(opts.maxScale,4),scale));
		    var desiredGreen={x:fr.left+fr.width/2,y:fr.top+fr.height/2};
		    var anchorMode=frame==="lock"?"bubble-lock":"object-frame";
		    var frameName=frame||"hole";
		    if(frameName==="hole")anchorMode="hole-frame";
	    var rotatedCenter=rpx.center;
	    var tx=desiredGreen.x-rotatedCenter.x*scale;
	    var ty=desiredGreen.y-rotatedCenter.y*scale;
	    var dualAnchor=null;
	    if(frameName==="hole"){
	      dualAnchor=holeDualAnchorFit(manifest,px,angle,fr,baseScale,fitRatio,opts);
	      if(dualAnchor){
	        scale=dualAnchor.scale;
	        tx=dualAnchor.tx;
	        ty=dualAnchor.ty;
	        anchorMode="hole-dual-anchor";
	      }
	    }
	    var group=document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles");
	    if(!group)return false;
	    group.style.transform="translate("+tx.toFixed(2)+"px,"+ty.toFixed(2)+"px) rotate("+angle.toFixed(6)+"rad) scale("+scale.toFixed(4)+")";
		    safe(function(){document.body.classList.add("gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn");document.body.classList.remove("gdWaitingForConfirmedGreen","gdFrameCameraWaiting");});
		    clearCapturedFrameUnavailable();
		    var layer=document.getElementById("gdHoleImageCameraLayer");
	    var manifestKey=String(manifest.key||manifest.storageKey||manifest.scanId||manifest.activeScanId||storageKey()||"");
		    if(layer){layer.dataset.gdAnchorMode=anchorMode;layer.dataset.gdOrientationSource=orientation&&orientation.source||"none";layer.dataset.gdAxisBearingDeg=orientation&&Number.isFinite(orientation.bearingRad)?(orientation.bearingRad*180/Math.PI).toFixed(2):"";layer.dataset.gdRotationDeg=(angle*180/Math.PI).toFixed(2);layer.dataset.gdCameraFrozen=lockCameraFrozen?"1":"0";layer.dataset.gdDualAnchor=dualAnchor?"1":"0";layer.dataset.gdTeeAnchorErrorPx=dualAnchor?dualAnchor.teeErrorPx.toFixed(1):"";layer.dataset.gdCapturedSurfaceReadyHole=String(surfaceHoleNumber());layer.dataset.gdCapturedSurfaceReadyCourse=String(surfaceCourseKey());layer.dataset.gdCapturedSurfaceReadyAt=String(Date.now());layer.dataset.gdCapturedSurfaceManifestKey=manifestKey;}
					    var info={version:VERSION,frame:frame||"hole",object:opts.objectName||"activeObject",hole:surfaceHoleNumber(),manifestHole:manifest.holeNumber||surfaceHoleNumber(),course:surfaceCourseKey(),manifestCourse:manifest.courseKey||manifest.courseName||"",manifestKey:manifestKey,scanId:manifest.scanId||manifest.activeScanId||"",transitionToken:safe(function(){return document.body&&document.body.dataset&&document.body.dataset.gdGpsHoleTransitionToken||"";},""),scale:+scale.toFixed(4),fitRatio:+fitRatio.toFixed(2),captureZoom:manifest.captureZoom,tiles:(manifest.tiles||[]).length,anchor:anchorMode,dualAnchor:dualAnchor?{source:dualAnchor.source,teeErrorPx:+dualAnchor.teeErrorPx.toFixed(1),greenAnchor:dualAnchor.greenAnchor,teeAnchor:dualAnchor.teeAnchor}:null,orientation:orientation&&orientation.source||"none",axisBearingDeg:orientation&&Number.isFinite(orientation.bearingRad)?+(orientation.bearingRad*180/Math.PI).toFixed(2):null,rotationDeg:+(angle*180/Math.PI).toFixed(2),objectMeters:boundsSizeM(bounds),at:Date.now()};
					    window.__gdV19LastCapturedFit=info;
					    window.__gdGpsCapturedPresentationStamp={course:info.course,hole:info.hole,manifestHole:info.manifestHole,manifestCourse:info.manifestCourse,manifestKey:manifestKey,scanId:info.scanId,tiles:info.tiles,fitAt:info.at,renderedAt:Date.now(),transitionToken:info.transitionToken,frame:info.frame,object:info.object};
					    safe(function(){if(document.body&&document.body.dataset){document.body.dataset.gdGpsPresentationReadyHole=String(info.hole);document.body.dataset.gdGpsPresentationReadyCourse=String(info.course||"");document.body.dataset.gdGpsPresentationReadyManifestKey=manifestKey;document.body.dataset.gdGpsPresentationReadyAt=String(info.at);}});
				    clearTerminalCapturedUnavailable("fit-captured-ready");
				    clearStalePreparingOwners("fit-captured-ready");
				    var transitionCleared=gdEndGpsHoleSwitchTransition("fitCaptured");
				    safe(function(){if(!transitionCleared&&typeof window.gdApplyGpsMapVisibilityOwner==="function")window.gdApplyGpsMapVisibilityOwner("fitCaptured");});
		    if(lastShotOverlayPayload&&lastShotOverlayCenter)renderShotOverlay(lastShotOverlayPayload,lastShotOverlayCenter,{remember:false});
			    readout(info.frame+" | "+info.object+" | "+info.anchor+" | rot "+info.rotationDeg+" | z"+info.captureZoom+" | scale "+info.scale+" | fit "+info.fitRatio+" | tiles "+info.tiles);
	    return true;
	  }
	  function clearShotOverlay(){
	    var overlay=document.querySelector("#gdHoleImageCameraLayer .gdHoleImageOverlay");
	    if(overlay)overlay.innerHTML="";
	    hideCapturedDragHit();
	  }
	  function pathFromPoints(points){
	    var pts=(Array.isArray(points)?points:[]).map(function(p){return pointPx(captureManifest,p);}).filter(function(p){return p&&Number.isFinite(p.x)&&Number.isFinite(p.y);});
	    if(pts.length<3)return "";
	    return "M "+pts.map(function(p){return p.x.toFixed(1)+" "+p.y.toFixed(1);}).join(" L ")+" Z";
	  }
	  function localPointsFromLatLngs(points){
	    return (Array.isArray(points)?points:[]).map(function(p){return pointPx(captureManifest,p);}).filter(function(p){return p&&Number.isFinite(p.x)&&Number.isFinite(p.y);});
	  }
	  function elementTransformMatrix(el){
	    if(!el)return null;
	    var style=safe(function(){return getComputedStyle(el);},null);
	    if(!style)return null;
	    var transform=String(style.transform||"none");
	    var matrix=safe(function(){return transform&&transform!=="none"?new DOMMatrix(transform):new DOMMatrix();},null);
	    if(!matrix)return null;
	    var origin=String(style.transformOrigin||"0 0 0").split(/\s+/);
	    var ox=num(origin[0],0),oy=num(origin[1],0),oz=num(origin[2],0);
	    return new DOMMatrix().translate(ox,oy,oz).multiply(matrix).translate(-ox,-oy,-oz);
	  }
	  function capturedGroupMatrix(){
	    var layer=document.getElementById("gdHoleImageCameraLayer");
	    var group=document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles");
	    if(!group)return null;
	    var groupMatrix=elementTransformMatrix(group);
	    if(!groupMatrix)return null;
	    var layerMatrix=elementTransformMatrix(layer)||new DOMMatrix();
	    return layerMatrix.multiply(groupMatrix);
	  }
	  function matrixPointToXY(p){
	    if(!p)return null;
	    var w=Number(p.w);
	    if(Number.isFinite(w)&&Math.abs(w)>0.0001&&Math.abs(w-1)>0.0001)return {x:p.x/w,y:p.y/w};
	    return {x:p.x,y:p.y};
	  }
	  function capturedLocalToScreenPoint(point){
	    var matrix=capturedGroupMatrix();
	    if(!matrix||!point)return null;
	    try{
	      return matrixPointToXY(new DOMPoint(point.x,point.y,0,1).matrixTransform(matrix));
	    }catch(e){return null;}
	  }
	  function capturedScreenToLocalPoint(clientX,clientY){
	    var matrix=capturedGroupMatrix();
	    if(!matrix)return null;
	    try{
	      return matrixPointToXY(new DOMPoint(clientX,clientY,0,1).matrixTransform(matrix.inverse()));
	    }catch(e){return null;}
	  }
	  function capturedLocalPointToLatLng(point){
	    if(!point||!captureManifest||!hasMap())return null;
	    return safe(function(){return map.unproject(L.point(point.x+captureManifest.originPx.x,point.y+captureManifest.originPx.y),captureManifest.captureZoom);},null);
	  }
	  function ensureCapturedDragHit(){
	    if(!document.body)return null;
	    var hit=document.getElementById("gdCapturedBubbleDragHit");
	    if(!hit){
	      hit=document.createElement("div");
	      hit.id="gdCapturedBubbleDragHit";
	      hit.setAttribute("aria-hidden","true");
	      document.body.appendChild(hit);
	    }
	    installCapturedDragHit(hit);
	    return hit;
	  }
	  function hideCapturedDragHit(){
	    var hit=document.getElementById("gdCapturedBubbleDragHit");
	    if(hit){
	      hit.style.display="none";
	      hit.style.left="-9999px";
	      hit.style.top="-9999px";
	    }
	  }
	  function positionCapturedDragHit(centerPx,localPts,scale){
	    var hit=ensureCapturedDragHit();
	    var screen=capturedLocalToScreenPoint(centerPx);
	    if(!hit||!screen||!document.body||document.body.classList.contains("gdMappedStartPromptActive")){hideCapturedDragHit();return false;}
	    var xs=localPts.map(function(p){return p.x;}),ys=localPts.map(function(p){return p.y;});
	    var localW=xs.length?Math.max.apply(null,xs)-Math.min.apply(null,xs):70;
	    var localH=ys.length?Math.max.apply(null,ys)-Math.min.apply(null,ys):70;
	    var size=Math.max(54,Math.min(260,Math.max(localW,localH)*Math.max(.05,num(scale,1))+28));
	    hit.style.display="block";
	    hit.style.width=size.toFixed(1)+"px";
	    hit.style.height=size.toFixed(1)+"px";
	    hit.style.left=(screen.x-size/2).toFixed(1)+"px";
	    hit.style.top=(screen.y-size/2).toFixed(1)+"px";
	    return true;
	  }
	  function setCapturedBubbleZoomActive(on){
	    safe(function(){
	      if(!document.body)return;
	      document.body.classList.toggle("gdBubbleLongPressZoomActive",!!on);
	      document.body.classList.toggle("gd-green-zoom-active",!!on);
	      var btn=document.getElementById("gdGreenZoomBtn");
	      if(btn)btn.classList.toggle("softActive",!!on);
	    });
	  }
	  function beginCapturedBubbleZoom(state){
	    if(!state||state.longPressZoomActive||state.movedBeforeLongPress)return false;
	    if(!safe(function(){return !!lockedFrame;},false)||!lastShotOverlayCenter||!validLL(lastShotOverlayCenter))return false;
	    state.longPressZoomActive=true;
	    setCapturedBubbleZoomActive(true);
	    var b=activeBounds("zoom");
	    lockCameraFrozen=false;
	    if(document.body)document.body.classList.remove("gdWaitingForConfirmedGreen","gdFrameCameraWaiting");
	    var ok=fitCaptured(b,"zoom",.018,{objectName:"capturedBubbleLongPressZoom",reason:"bubble-long-press-zoom",maxScale:7.2,fitRatio:.96})||fallbackNative(b,"zoom",.018,{animate:true});
	    if(lastShotOverlayPayload&&lastShotOverlayCenter)renderShotOverlay(lastShotOverlayPayload,lastShotOverlayCenter,{remember:false});
	    return ok;
	  }
	  function finishCapturedBubbleZoom(state){
	    if(!state||!state.longPressZoomActive)return false;
	    state.longPressZoomActive=false;
	    setCapturedBubbleZoomActive(false);
	    requestAnimationFrame(function(){
	      setTimeout(function(){
	        safe(function(){renderShot();});
	        lockState({force:true,objectName:"capturedBubblePlacedLockFrame",reason:"bubble-long-press-lock-return"});
	        safe(function(){if(typeof setBubbleOnlyLock==="function")setBubbleOnlyLock(true);});
	      },35);
	    });
	    return true;
	  }
	  function installCapturedDragHit(hit){
	    if(!hit||hit.__gdCapturedDragInstalled)return;
	    hit.__gdCapturedDragInstalled=true;
	    hit.addEventListener("pointerdown",function(ev){
	      if(ev.button!=null&&ev.button!==0)return;
	      if(!document.body||document.body.classList.contains("gdMappedStartPromptActive"))return;
	      if(!captureManifest||!lastShotOverlayCenter||!validLL(lastShotOverlayCenter))return;
	      ev.preventDefault();
	      ev.stopPropagation();
	      if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();
	      safe(function(){if(typeof window.gdConsumeNextMapClick==="function")window.gdConsumeNextMapClick("captured-bubble-pointerdown",1400);});
	      var centerPx=pointPx(captureManifest,lastShotOverlayCenter);
	      var downLocal=capturedScreenToLocalPoint(ev.clientX,ev.clientY);
	      if(!centerPx||!downLocal)return;
	      var state={
	        id:ev.pointerId,
	        offset:{x:downLocal.x-centerPx.x,y:downLocal.y-centerPx.y},
	        moved:false,
	        movedBeforeLongPress:false,
	        longPressTimer:null,
	        longPressZoomActive:false,
	        startX:ev.clientX||0,
	        startY:ev.clientY||0,
	        raf:null,
	        pending:null
	      };
	      safe(function(){targetDragging=true;});
	      safe(function(){if(target)undoStack.push({type:"target",value:L.latLng(target.lat,target.lng)});});
	      if(document.body)document.body.classList.add("gdCapturedBubbleDragging");
	      hit.style.cursor="grabbing";
	      safe(function(){hit.setPointerCapture(ev.pointerId);});
	      state.longPressTimer=setTimeout(function(){
	        state.longPressTimer=null;
	        beginCapturedBubbleZoom(state);
	      },460);
	      function clearLongPress(){
	        if(state.longPressTimer){clearTimeout(state.longPressTimer);state.longPressTimer=null;}
	      }
	      function applyLocal(localPoint,final){
	        if(!localPoint)return;
	        var ll=capturedLocalPointToLatLng({x:localPoint.x-state.offset.x,y:localPoint.y-state.offset.y});
	        if(!validLL(ll))return;
	        state.pending=ll;
	        if(state.raf&&!final)return;
	        if(state.raf&&final){cancelAnimationFrame(state.raf);state.raf=null;}
	        var run=function(){
	          state.raf=null;
	          var next=state.pending;
	          if(!validLL(next))return;
	          safe(function(){gdSetTargetFromDisplayedLanding(next);});
	          safe(function(){targetWasMoved=true;});
	          safe(function(){if(typeof gdMarkCurrentPlanDirty==="function")gdMarkCurrentPlanDirty();});
	          safe(function(){if(targetMarker)targetMarker.setLatLng((typeof gdShotDisplayTarget==="function"&&(gdShotDisplayTarget()||null))||target);});
	          safe(function(){if(typeof renderShot==="function")renderShot();});
	          safe(function(){if(typeof updatePinLine==="function")updatePinLine();});
	        };
	        if(final)run();
	        else state.raf=requestAnimationFrame(run);
	      }
	      function move(moveEv){
	        if(moveEv.pointerId!==state.id)return;
	        moveEv.preventDefault();
	        moveEv.stopPropagation();
	        var dx=Math.abs((moveEv.clientX||0)-state.startX),dy=Math.abs((moveEv.clientY||0)-state.startY);
	        if(!state.longPressZoomActive&&(dx>9||dy>9)){state.movedBeforeLongPress=true;clearLongPress();}
	        var local=capturedScreenToLocalPoint(moveEv.clientX,moveEv.clientY);
	        if(local){state.moved=true;applyLocal(local,false);}
	      }
	      function end(endEv){
	        if(endEv.pointerId!==state.id)return;
	        endEv.preventDefault();
	        endEv.stopPropagation();
	        if(endEv.stopImmediatePropagation)endEv.stopImmediatePropagation();
	        safe(function(){if(typeof window.gdConsumeNextMapClick==="function")window.gdConsumeNextMapClick("captured-bubble-pointerup",1400);});
	        clearLongPress();
	        document.removeEventListener("pointermove",move);
	        document.removeEventListener("pointerup",end);
	        document.removeEventListener("pointercancel",end);
	        var local=capturedScreenToLocalPoint(endEv.clientX,endEv.clientY);
	        if(local)applyLocal(local,true);
	        safe(function(){targetDragging=false;});
	        if(document.body)document.body.classList.remove("gdCapturedBubbleDragging");
	        hit.style.cursor="grab";
	        if(!finishCapturedBubbleZoom(state))safe(function(){if(lockedFrame&&typeof setBubbleOnlyLock==="function")setBubbleOnlyLock(true);});
	        safe(function(){hit.releasePointerCapture(endEv.pointerId);});
	      }
	      document.addEventListener("pointermove",move,{passive:false});
	      document.addEventListener("pointerup",end,{passive:false});
	      document.addEventListener("pointercancel",end,{passive:false});
	    },{passive:false});
	  }
	  function capturedAimLineMarkup(center,payload,scale){
	    if(safe(function(){return showAim===false;},false))return "";
	    var s=asLL(safe(function(){return start;},null));
	    var c=asLL(center);
	    if(!validLL(s)||!validLL(c)||!captureManifest)return "";
	    var distance=safe(function(){return map.distance(s,c);},0);
	    var end=asLL(safe(function(){return typeof gdAimLineEndPoint==="function"?gdAimLineEndPoint(distance,payload):null;},null));
	    if(!validLL(end)){
	      var display=asLL(safe(function(){return typeof gdShotDisplayTarget==="function"&&(gdShotDisplayTarget()||null);},null))||c;
	      var brg=bearingRad(s,display);
	      end=Number.isFinite(brg)?asLL(safe(function(){return typeof project==="function"?project(display,brg,Math.max(180,distance*1.25)):null;},null)):display;
	    }
	    if(!validLL(end))return "";
	    var p0=pointPx(captureManifest,s),p1=pointPx(captureManifest,end);
	    if(!p0||!p1)return "";
	    scale=Math.max(.05,num(scale,1));
	    var stroke=Math.max(.8,Math.min(28,3.25/scale));
	    var dashA=Math.max(2,8/scale),dashB=Math.max(2,10/scale);
	    return '<line class="gdCapturedAimLine" x1="'+p0.x.toFixed(1)+'" y1="'+p0.y.toFixed(1)+'" x2="'+p1.x.toFixed(1)+'" y2="'+p1.y.toFixed(1)+'" stroke-width="'+stroke.toFixed(2)+'" stroke-dasharray="'+dashA.toFixed(1)+' '+dashB.toFixed(1)+'"/>';
	  }
		  function renderShotOverlay(payload,center,opts){
	    opts=opts||{};
	    if(opts.remember!==false){lastShotOverlayPayload=payload||null;lastShotOverlayCenter=asLL(center)||null;}
	    var overlay=document.querySelector("#gdHoleImageCameraLayer .gdHoleImageOverlay");
	    if(!overlay||!captureManifest||!document.body||!document.body.classList.contains("gdCapturedHoleFrameCameraOn"))return false;
	    if(!safe(function(){return !!lockedFrame;},false)){clearShotOverlay();return false;}
	    var c=asLL(center)||currentGreenPoint();
	    if(!validLL(c)){clearShotOverlay();return false;}
	    var shape=safe(function(){return typeof buildBubbleShape==="function"&&buildBubbleShape(c,payload,1);},null);
	    if(!Array.isArray(shape)||shape.length<3){
	      var radius=num(payload&&payload.radius,24);
	      shape=[];
	      for(var i=0;i<48;i++){
	        var a=(Math.PI*2*i)/48;
	        shape.push(safe(function(){return typeof projectOffset==="function"?projectOffset(c,0,Math.cos(a)*radius,Math.sin(a)*radius):null;},null));
	      }
	    }
	    var localPts=localPointsFromLatLngs(shape);
	    var bubblePath=localPts.length>=3?"M "+localPts.map(function(p){return p.x.toFixed(1)+" "+p.y.toFixed(1);}).join(" L ")+" Z":pathFromPoints(shape);
	    var centerPx=pointPx(captureManifest,c);
	    if(!bubblePath||!centerPx){clearShotOverlay();return false;}
	    var fit=window.__gdV19LastCapturedFit||{};
	    var scale=Math.max(.05,num(fit.scale,1));
	    var stroke=Math.max(.6,Math.min(24,2.8/scale));
	    var core=Math.max(2.2,Math.min(34,5.2/scale));
	    var aimLine=capturedAimLineMarkup(c,payload,scale);
	    overlay.innerHTML='<svg class="gdCapturedShotSvg" width="'+captureManifest.imageWidth+'" height="'+captureManifest.imageHeight+'" viewBox="0 0 '+captureManifest.imageWidth+' '+captureManifest.imageHeight+'">'+aimLine+'<path class="gdCapturedShotBubble" d="'+bubblePath+'" stroke-width="'+stroke.toFixed(2)+'"/><circle class="gdCapturedShotCore" cx="'+centerPx.x.toFixed(1)+'" cy="'+centerPx.y.toFixed(1)+'" r="'+core.toFixed(2)+'" stroke-width="'+Math.max(.45,stroke*.62).toFixed(2)+'"/></svg>';
	    positionCapturedDragHit(centerPx,localPts,scale);
	    return true;
	  }
	  function frozenLockCameraReady(){
	    return !!(lockCameraFrozen&&document.body&&document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles"));
	  }
	  function tiltedCapturedSurfaceReady(){
	    return !!(document.body&&document.body.classList.contains("gdGpsPlayCameraTiltOn")&&document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles"));
	  }
	  function freezeLockCamera(){
	    lockCameraFrozen=true;
	    window.__gdV19LockCameraFrozen=true;
	    var layer=document.getElementById("gdHoleImageCameraLayer");
	    if(layer)layer.dataset.gdCameraFrozen="1";
	  }
	  function fallbackNative(bounds,frame,padding,opts){
	    if(capturedGpsPlayActive())return !!gdCapturedFrameUnavailable(opts&&opts.reason||frame,{stage:"native-fallback",frame:frame||"hole",objectName:opts&&opts.objectName||""});
	    if(typeof nativeFit!=="function"||!validBounds(bounds))return false;
	    return nativeFit(bounds,frame,padding,Object.assign({animate:false,duration:.05,ownerMs:1900,maxZoom:frame==="zoom"?21.85:frame==="lock"?21.65:20.85,objectName:"v19NativeFallback"},opts||{}));
	  }
	  function setup(opts){
	    opts=opts||{};
	    lockCameraFrozen=false;
	    safe(function(){lockedFrame=false;});
	    safe(function(){if(typeof setMapGestures==="function")setMapGestures(true);});
	    safe(function(){var appEl=document.getElementById("app");if(appEl)appEl.classList.remove("framed");});
	    lastShotOverlayPayload=null;
	    lastShotOverlayCenter=null;
	    clearShotOverlay();
	    safe(function(){if(typeof clearShot==="function")clearShot();});
	    safe(function(){if(typeof gdResetShotDistanceDisplay==="function")gdResetShotDistanceDisplay();});
	    safe(function(){var tile=document.getElementById("shotTile");if(tile)tile.classList.remove("visible");});
	    var b=greenBounds("hole");
	    if(document.body){document.body.classList.add("gdMappedStartPromptActive");document.body.classList.remove("gdHeadToTeeFrameActive","gdLockStateFrameActive","gdGreenArrivalMode","gd-green-zoom-active","gdWaitingForConfirmedGreen","gdFrameCameraWaiting","gd-frame-hard-locked");}
			    return fitCaptured(b,"hole",num(opts.padding,.025),{objectName:"capturedGreenHoleFrame",reason:"setup",maxScale:7.2,fitRatio:.94})||fallbackNative(b,"hole",num(opts.padding,.025),opts);
	  }
		  function headToTee(opts){
		    opts=opts||{};
		    lockCameraFrozen=false;
		    var b=greenBounds("hole");
	    if(document.body){
	      document.body.classList.add("gdHeadToTeeFrameActive");
	      document.body.classList.remove("gdMappedStartPromptActive","gdGreenArrivalMode","gd-green-zoom-active","gdWaitingForConfirmedGreen","gdFrameCameraWaiting");
	    }
	    return fitCaptured(b,"hole",num(opts.padding,.025),{objectName:"capturedHeadToTeeHoleFrame",reason:"head-to-tee",maxScale:7.2,fitRatio:.94})||fallbackNative(b,"hole",num(opts.padding,.025),opts);
	  }
		  function lockState(opts){
		    opts=opts||{};
		    if(document.body){
		      document.body.classList.add("gdLockStateFrameActive");
		      if(opts.fromHeadToTee)document.body.classList.add("gdHeadToTeeFrameActive");
		      document.body.classList.remove("gdMappedStartPromptActive","gdGreenArrivalMode","gd-green-zoom-active","gdWaitingForConfirmedGreen","gdFrameCameraWaiting");
		    }
		    safe(function(){if(typeof window.gdSyncGpsPlayCameraTilt==="function")window.gdSyncGpsPlayCameraTilt(opts.reason||"captured-lock-state");});
		    if(!opts.force&&tiltedCapturedSurfaceReady()){
		      var tightBounds=activeBounds("lock");
		      if(validBounds(tightBounds)&&fitCaptured(tightBounds,"lock",num(opts.padding,.018),{objectName:opts.objectName||"capturedTiltedTightLock",reason:opts.reason||"tilted-tight-lock",maxScale:7.2,fitRatio:.94})){
		        freezeLockCamera();
		        if(lastShotOverlayPayload&&lastShotOverlayCenter)renderShotOverlay(lastShotOverlayPayload,lastShotOverlayCenter,{remember:false});
		        readout("tilted lock | tight frame then tilt");
		        return true;
		      }
		      freezeLockCamera();
		      if(lastShotOverlayPayload&&lastShotOverlayCenter)renderShotOverlay(lastShotOverlayPayload,lastShotOverlayCenter,{remember:false});
		      readout("tilted lock frozen | preserved captured surface");
		      return true;
		    }
		    if(!opts.force&&frozenLockCameraReady()){
		      if(lastShotOverlayPayload&&lastShotOverlayCenter)renderShotOverlay(lastShotOverlayPayload,lastShotOverlayCenter,{remember:false});
		      readout("lock frozen | bubble can move without camera follow");
		      return true;
		    }
		    var b=activeBounds("lock");
		    var ok=fitCaptured(b,"lock",num(opts.padding,.018),{objectName:opts.objectName||"capturedLockState",reason:opts.reason||"lock-state",maxScale:7.2,fitRatio:.94})||fallbackNative(b,"lock",num(opts.padding,.018),opts);
		    if(ok)freezeLockCamera();
		    return ok;
		  }
	  function lock(opts){
	    opts=opts||{};
	    return lockState(Object.assign({objectName:"capturedActiveShot",reason:"lock"},opts));
	  }
	function zoom(ev){
	    if(ev){ev.preventDefault();ev.stopPropagation();if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();}
	    var b=activeBounds("zoom");
	    lockCameraFrozen=false;
	    if(document.body){document.body.classList.add("gd-green-zoom-active");document.body.classList.remove("gdWaitingForConfirmedGreen","gdFrameCameraWaiting");}
	    safe(function(){var btn=document.getElementById("gdGreenZoomBtn");if(btn)btn.classList.add("softActive");});
	    return fitCaptured(b,"zoom",.018,{objectName:"capturedTargetZoom",reason:"zoom",maxScale:7.2,fitRatio:.96})||fallbackNative(b,"zoom",.018,{animate:true});
	  }
	  function clearRuntime(reason){
	    captureManifest=null;
	    lockCameraFrozen=false;
	    safe(function(){delete window.__gdV19LockCameraFrozen;});
	    safe(function(){delete window.gdHoleImageCaptureManifest;delete window.__gdLastHoleImageCaptureManifest;delete window.__gdV19CapturedHoleFrameManifest;delete window.__gdV19LastCapturedFit;});
	    hideWaiting();
	    hideCapturedCamera();
	    readout(reason||"runtime clear");
    return true;
	  }
	  function reset(){
	    clearRuntime("fresh reset");
	    safe(function(){localStorage.removeItem(storageKey());});
	    safe(function(){if(typeof window.gdCapturedSurfaceClearScan==="function")window.gdCapturedSurfaceClearScan(surfaceCourseKey(),surfaceHoleNumber());});
	    readout("fresh reset");
    return true;
  }
  function removeLayer(layer){
    safe(function(){if(layer&&map&&typeof map.removeLayer==="function")map.removeLayer(layer);});
  }
  function showMappedPromptChrome(){
    safe(function(){
      var hint=document.getElementById("hint");
      if(!hint)return;
      if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(hint);
      else{
        hint.classList.add("gdMappedStartPill");
        hint.innerHTML='<button class="gdMappedStartAction" type="button" data-gd-mapped-start-action="manual">Set Start Point</button><button class="gdMappedStartAction gdHeadToTee" type="button" data-gd-mapped-start-action="tee">Head To the Tee</button>';
      }
      hint.classList.add("visible");
    });
  }
  function clearLiveShotForPrompt(){
    lockCameraFrozen=false;
    lastShotOverlayPayload=null;
    lastShotOverlayCenter=null;
    clearShotOverlay();
    safe(function(){lockedFrame=false;});
    safe(function(){if(typeof setBubbleOnlyLock==="function")setBubbleOnlyLock(false);});
    safe(function(){if(typeof clearShot==="function")clearShot();});
    safe(function(){if(typeof gdResetShotDistanceDisplay==="function")gdResetShotDistanceDisplay();});
    safe(function(){[targetMarker,greenMarker,pinMarker,pinDirectionLine,greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(removeLayer);});
    safe(function(){targetMarker=greenMarker=pinMarker=pinDirectionLine=greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;});
    safe(function(){start=target=greenCentre=pin=null;});
    safe(function(){greenPolygon=null;gdWindLandingTarget=null;targetWasMoved=false;currentShotLogged=false;gdCurrentPlannedShotId=null;targetDragging=false;});
    safe(function(){mode="start";});
    safe(function(){var tile=document.getElementById("shotTile");if(tile){tile.classList.remove("visible");tile.hidden=false;}});
    safe(function(){var appEl=document.getElementById("app");if(appEl){appEl.classList.remove("framed");appEl.classList.add("gdPreLockFrame");}});
  }
  function returnToMappedPreLockPrompt(reason){
    clearLiveShotForPrompt();
    if(document.body){
      document.body.classList.add("gdMappedCourseMode","gdMappedStartPromptActive");
      document.body.classList.remove("gdHeadToTeeFrameActive","gdLockStateFrameActive","gdGreenArrivalMode","gd-green-zoom-active","gdWaitingForConfirmedGreen","gdFrameCameraWaiting","gd-frame-hard-locked");
    }
    safe(function(){if(typeof window.gdSyncGpsPlayCameraTilt==="function")window.gdSyncGpsPlayCameraTilt("captured-unlock-prelock");});
    showMappedPromptChrome();
    safe(function(){if(typeof setState==="function")setState("Mapped: set position");});
    var ok=setup({animate:false,reason:reason||"unlock-prelock"});
    safe(function(){if(typeof gdRenderMappedPreLockHoleFrame==="function")gdRenderMappedPreLockHoleFrame();});
    return ok;
  }
	  function installUnlockBridge(){
	    if(window.__gdV19CapturedUnlockBridge)return;
	    window.__gdV19CapturedUnlockBridge=true;
	    document.addEventListener("click",function(event){
	      var targetEl=event.target&&event.target.closest&&event.target.closest("#gdV62NewShotBtn");
	      if(!targetEl||!document.body||!document.body.classList.contains("gdGpsActive"))return;
	      if(!document.body.classList.contains("gdMappedCourseMode")&&!document.body.classList.contains("gdCapturedHoleFrameCameraOn"))return;
	      if(targetEl.dataset&&targetEl.dataset.gdShotFrameAction==="lock")return;
	      event.preventDefault();
	      event.stopPropagation();
	      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
	      returnToMappedPreLockPrompt("unlock-bridge");
      return false;
    },true);
  }
  function install(){
    safe(function(){window.gdSimpleFrameFreshCamera=false;});
    hideWaiting();
    if(!nativeFit&&typeof window.gdFitObjectToFrame==="function")nativeFit=window.gdFitObjectToFrame;
		  window.gdBuildHoleImageCaptureManifest=function(reason){if(capturedGpsPlayActive())return gdCapturedFrameUnavailable(reason||"manual",{stage:"build"});var b=activeBounds("hole")||greenBounds("hole");return buildCaptureManifest(b,reason||"manual");};
		  window.gdLoadHoleImageCaptureManifest=function(){return loadCaptureManifest();};
		  window.gdEnsureCurrentCapturedSurfaceManifest=function(reason){return ensureCurrentCaptureManifest(reason||"ensure-current");};
		  window.gdCapturedFrameUnavailable=gdCapturedFrameUnavailable;
		  window.gdCaptureFlattenPending=function(key){return captureFlattenPending[key]||null;};
		  window.gdFlattenCaptureManifest=function(manifest,opts){return flattenCaptureManifest(manifest,opts);};
		  window.gdCapturedSurfaceManifestMatchesActive=function(manifest){return manifestMatchesActive(manifest||captureManifest||window.gdHoleImageCaptureManifest||window.__gdLastHoleImageCaptureManifest||window.__gdV19CapturedHoleFrameManifest);};
		  window.gdRenderHoleImageCamera=function(manifest){return renderCaptureManifest(manifest||loadCaptureManifest());};
		  window.gdBeginGpsHoleSwitchTransition=gdBeginGpsHoleSwitchTransition;
		  window.gdEndGpsHoleSwitchTransition=gdEndGpsHoleSwitchTransition;
	    window.gdShowHoleImageCamera=function(on){if(on){var m=loadCaptureManifest();if(!m&&capturedGpsPlayActive())return missingCapturedManifest("show",{stage:"show"});if(!m)m=window.gdBuildHoleImageCaptureManifest("show");if(m)renderCaptureManifest(m);}document.body.classList.toggle("gdCapturedHoleFrameCameraOn",!!on);document.body.classList.toggle("gdHoleImageCameraOn",!!on);if(on)clearCapturedFrameUnavailable();return !!on;};
		    window.gdFitCapturedHoleFrameToBoxV19=fitCaptured;
		    window.gdFitHeadToTeeHoleFrameV19=headToTee;
		    window.gdFitLockStateFrameV19=lockState;
		    window.gdRenderCapturedHoleFrameShotOverlay=renderShotOverlay;
		    window.gdRepaintCapturedHoleFrameShotOverlay=function(reason){
		      safe(function(){if(typeof renderShot==="function")renderShot();});
		      if(lastShotOverlayPayload&&lastShotOverlayCenter){
		        renderShotOverlay(lastShotOverlayPayload,lastShotOverlayCenter,{remember:false});
		        return true;
		      }
		      return false;
		    };
		    window.gdClearCapturedHoleFrameShotOverlay=function(){lastShotOverlayPayload=null;lastShotOverlayCenter=null;clearShotOverlay();return true;};
		    window.gdReturnCapturedHoleFrameToPreLock=returnToMappedPreLockPrompt;
		    window.gdClearHoleImageRuntime=clearRuntime;
		    window.gdResetHoleImageFresh=reset;
    window.gdResetConfirmedGreenFresh=reset;
    window.gdSimpleFrameSetup=setup;
    window.gdFrameMappedPreLockPreset=function(index,opts){return setup(opts||{});};
    window.gdFrameMappedPreLockHoleView=function(opts){return setup(opts||{});};
    window.gdQueueMappedPreLockHoleFrame=function(opts){setTimeout(function(){setup(opts||{});},30);return true;};
    window.gdFocusMappedPreLockHole=function(hole,opts){return setup(opts||{});};
    window.gdSimpleFrameLock=lock;
	    window.gdHeadToTeeShotFrame=function(){safe(function(){lockedFrame=true;});return lockState({animate:false,fromHeadToTee:true,objectName:"capturedHeadToTeeLockFrame",reason:"head-to-tee-lock"});};
    window.frameShotView=function(){return lock({animate:true});};
    window.lockFrame=function(refit){safe(function(){lockedFrame=true;});if(refit!==false&&tiltedCapturedSurfaceReady()){safe(function(){setBubbleOnlyLock(true);});safe(function(){renderShot();});lock({animate:true});}else if(refit!==false)lock({animate:true});safe(function(){setBubbleOnlyLock(true);});safe(function(){renderShot();});return true;};
    window.gdToggleTargetZoom=zoom;
    window.gdToggleSimpleGreenZoom=zoom;
    safe(function(){lockFrame=window.lockFrame;frameShotView=window.frameShotView;gdHeadToTeeShotFrame=window.gdHeadToTeeShotFrame;});
    if(!nativeShowHome&&typeof window.showShellHome==="function")nativeShowHome=window.showShellHome;
    if(nativeShowHome&&!window.showShellHome.__gdV19Wrapped){window.showShellHome=function(){hideWaiting();hideCapturedCamera();return nativeShowHome.apply(this,arguments);};window.showShellHome.__gdV19Wrapped=true;}
    if(!nativeOpenChangeCourse&&typeof window.gdOpenChangeCourse==="function")nativeOpenChangeCourse=window.gdOpenChangeCourse;
    if(nativeOpenChangeCourse&&!window.gdOpenChangeCourse.__gdV19Wrapped){window.gdOpenChangeCourse=function(){hideWaiting();hideCapturedCamera();return nativeOpenChangeCourse.apply(this,arguments);};window.gdOpenChangeCourse.__gdV19Wrapped=true;}
    window.__gdV19Installed={version:VERSION,at:Date.now()};
    installUnlockBridge();
    readout("installed");
    safe(function(){if(document.body&&document.body.classList.contains("gdMappedStartPromptActive"))setTimeout(function(){setup({animate:false,reason:"active-prompt-install"});},60);});
    return true;
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){setTimeout(install,80);});else setTimeout(install,40);
  [900,1750,2850,4350,6200].forEach(function(ms){setTimeout(install,ms);});
  safe(function(){window.addEventListener("resize",function(){setTimeout(function(){if(document.body&&document.body.classList.contains("gdCapturedHoleFrameCameraOn")){var last=window.__gdV19LastCapturedFit||{};if(lockCameraFrozen&&last.frame==="lock"){if(lastShotOverlayPayload&&lastShotOverlayCenter)renderShotOverlay(lastShotOverlayPayload,lastShotOverlayCenter,{remember:false});return;}var b=activeBounds(last.frame||"hole");fitCaptured(b,last.frame||"hole",last.frame==="zoom" ? .018 : .025,{objectName:last.object||"resize",reason:"resize"});}},120);},true);});
})();

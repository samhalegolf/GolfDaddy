(function(root,factory){
  if(typeof module==="object"&&module.exports)module.exports=factory();
  else root.GDCourseVisualEngine=factory(root);
})(typeof window!=="undefined"?window:globalThis,function(root){
  "use strict";
  root=root||typeof window!=="undefined"&&window||typeof globalThis!=="undefined"&&globalThis||{};

  var VERSION=1;
  var PRESET_VERSION=2;
  var RENDERER_VERSION="clarity-course-visual-renderer-v3";
  var STORE_KEY="gd_course_visual_engine_v1";
  var PRESET_KEY="gd_course_visual_presets_v1";
  var API_ENDPOINT="/api/course-visuals";
  var ASSET_DB_NAME="gd_course_visual_assets_v1";
  var ASSET_STORE_NAME="assets";
  var VALID_STATUSES={unavailable:1,"input-ready":1,stitching:1,"basic-ready":1,rendering:1,"preview-ready":1,published:1,failed:1};
  var inFlightBuilds={};
  var transientCapturesByCourse={};
  var transientAssetDataByPath={};
  var assetDbPromise=null;

  function now(){return new Date().toISOString();}
  function safe(fn,fb){try{return fn();}catch(_error){return fb;}}
  function clone(value){return safe(function(){return JSON.parse(JSON.stringify(value));},value);}
  function slug(value){return String(value||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,140)||"course";}
  function stableId(prefix){return String(prefix||"cv")+"_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);}
  function text(value,limit){var out=String(value||"").trim();return limit&&out.length>limit?out.slice(0,limit):out;}
  function finite(value){var n=Number(value);return Number.isFinite(n)?n:null;}
  function point(value){
    if(!value)return null;
    var lat=finite(value.lat!==undefined?value.lat:value.latitude);
    var lng=finite(value.lng!==undefined?value.lng:(value.lon!==undefined?value.lon:value.longitude));
    return lat==null||lng==null?null:{lat:lat,lng:lng};
  }
  function points(list){return (Array.isArray(list)?list:[]).map(point).filter(Boolean);}
  function boundsFromPoints(list){
    var pts=points(list);
    if(!pts.length)return null;
    var lats=pts.map(function(p){return p.lat;});
    var lngs=pts.map(function(p){return p.lng;});
    return {south:Math.min.apply(null,lats),west:Math.min.apply(null,lngs),north:Math.max.apply(null,lats),east:Math.max.apply(null,lngs)};
  }
  function mergeBounds(list){
    var bounds=(Array.isArray(list)?list:[]).filter(validBounds);
    if(!bounds.length)return null;
    return {
      south:Math.min.apply(null,bounds.map(function(b){return b.south;})),
      west:Math.min.apply(null,bounds.map(function(b){return b.west;})),
      north:Math.max.apply(null,bounds.map(function(b){return b.north;})),
      east:Math.max.apply(null,bounds.map(function(b){return b.east;}))
    };
  }
  function validBounds(bounds){
    return !!(bounds&&Number.isFinite(Number(bounds.south))&&Number.isFinite(Number(bounds.west))&&Number.isFinite(Number(bounds.north))&&Number.isFinite(Number(bounds.east))&&Number(bounds.north)>=Number(bounds.south)&&Number(bounds.east)>=Number(bounds.west));
  }
  function clamp(value,min,max){value=Number(value);return Math.min(max,Math.max(min,Number.isFinite(value)?value:min));}
  function svgNum(value){var n=Number(value);return Number.isFinite(n)?Number(n.toFixed(3)).toString():"0";}
  function median(list){
    var values=(Array.isArray(list)?list:[]).map(Number).filter(function(value){return Number.isFinite(value)&&value>0;}).sort(function(a,b){return a-b;});
    if(!values.length)return null;
    var mid=Math.floor(values.length/2);
    return values.length%2?values[mid]:(values[mid-1]+values[mid])/2;
  }
  function projectLatLng(lat,lng){
    lat=clamp(lat,-85.05112878,85.05112878);
    lng=Number(lng);
    var sin=Math.sin(lat*Math.PI/180);
    return {x:(lng+180)/360,y:.5-Math.log((1+sin)/(1-sin))/(4*Math.PI)};
  }
  function unprojectWorldPixel(x,y,z){
    var scale=256*Math.pow(2,Number(z)||0);
    var lng=Number(x)/scale*360-180;
    var n=Math.PI-2*Math.PI*Number(y)/scale;
    var lat=180/Math.PI*Math.atan(.5*(Math.exp(n)-Math.exp(-n)));
    return {lat:lat,lng:lng};
  }
  function projectedBounds(bounds){
    if(!validBounds(bounds))return null;
    var corners=[
      projectLatLng(bounds.south,bounds.west),
      projectLatLng(bounds.south,bounds.east),
      projectLatLng(bounds.north,bounds.west),
      projectLatLng(bounds.north,bounds.east)
    ];
    var xs=corners.map(function(p){return p.x;});
    var ys=corners.map(function(p){return p.y;});
    var out={left:Math.min.apply(null,xs),right:Math.max.apply(null,xs),top:Math.min.apply(null,ys),bottom:Math.max.apply(null,ys)};
    var minSpan=1e-9;
    if(out.right-out.left<minSpan){var cx=(out.left+out.right)/2;out.left=cx-minSpan/2;out.right=cx+minSpan/2;}
    if(out.bottom-out.top<minSpan){var cy=(out.top+out.bottom)/2;out.top=cy-minSpan/2;out.bottom=cy+minSpan/2;}
    return out;
  }
  function mergeProjectedBounds(list){
    var values=(Array.isArray(list)?list:[]).filter(Boolean);
    if(!values.length)return null;
    return {
      left:Math.min.apply(null,values.map(function(b){return b.left;})),
      right:Math.max.apply(null,values.map(function(b){return b.right;})),
      top:Math.min.apply(null,values.map(function(b){return b.top;})),
      bottom:Math.max.apply(null,values.map(function(b){return b.bottom;}))
    };
  }
  function boundsIntersects(a,b){
    return validBounds(a)&&validBounds(b)&&!(Number(a.east)<Number(b.west)||Number(a.west)>Number(b.east)||Number(a.north)<Number(b.south)||Number(a.south)>Number(b.north));
  }
  function boundsCenter(bounds){
    return validBounds(bounds)?{lat:(Number(bounds.south)+Number(bounds.north))/2,lng:(Number(bounds.west)+Number(bounds.east))/2}:null;
  }
  function padBounds(bounds,meters){
    if(!validBounds(bounds))return null;
    var pad=Math.max(0,Number(meters)||0);
    var center=boundsCenter(bounds)||{lat:(Number(bounds.south)+Number(bounds.north))/2,lng:(Number(bounds.west)+Number(bounds.east))/2};
    var latPad=pad/111320;
    var lngPad=pad/(111320*Math.max(.18,Math.cos(Number(center.lat||0)*Math.PI/180)));
    return {
      south:Number(bounds.south)-latPad,
      west:Number(bounds.west)-lngPad,
      north:Number(bounds.north)+latPad,
      east:Number(bounds.east)+lngPad
    };
  }
  function boundsSpanM(bounds){
    if(!validBounds(bounds))return {width:0,height:0,diag:0};
    var centerLat=((Number(bounds.south)+Number(bounds.north))/2)*Math.PI/180;
    var width=Math.abs(Number(bounds.east)-Number(bounds.west))*111320*Math.max(.18,Math.cos(centerLat));
    var height=Math.abs(Number(bounds.north)-Number(bounds.south))*111320;
    return {width:width,height:height,diag:Math.sqrt(width*width+height*height)};
  }
  function distanceMeters(a,b){
    a=point(a);b=point(b);
    if(!a||!b)return 0;
    var lat=(a.lat+b.lat)/2*Math.PI/180;
    var dx=(b.lng-a.lng)*111320*Math.max(.18,Math.cos(lat));
    var dy=(b.lat-a.lat)*111320;
    return Math.sqrt(dx*dx+dy*dy);
  }
  function routeLengthMeters(route){
    route=points(route);
    var total=0;
    for(var i=1;i<route.length;i++)total+=distanceMeters(route[i-1],route[i]);
    return total;
  }
  function dedupeRoutePoints(list){
    var out=[];
    points(list).forEach(function(p){
      var last=out[out.length-1];
      if(!last||distanceMeters(last,p)>.75)out.push(p);
    });
    return out;
  }
  function pointAtRouteDistance(route,meters){
    route=points(route);
    if(!route.length)return null;
    var target=Math.max(0,Number(meters)||0);
    var walked=0;
    for(var i=1;i<route.length;i++){
      var a=route[i-1],b=route[i],seg=distanceMeters(a,b);
      if(seg<=0)continue;
      if(walked+seg>=target){
        var t=clamp((target-walked)/seg,0,1);
        return {lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
      }
      walked+=seg;
    }
    return route[route.length-1];
  }
  function routeSegmentPoints(route,startM,endM){
    route=points(route);
    var out=[];
    var total=0;
    var start=Math.max(0,Number(startM)||0),end=Math.max(start,Number(endM)||start);
    var startPoint=pointAtRouteDistance(route,start);
    var endPoint=pointAtRouteDistance(route,end);
    if(startPoint)out.push(startPoint);
    for(var i=1;i<route.length-1;i++){
      total+=distanceMeters(route[i-1],route[i]);
      if(total>start&&total<end)out.push(route[i]);
    }
    if(endPoint)out.push(endPoint);
    return dedupeRoutePoints(out);
  }
  function holeDataRoutePoints(holeData){
    if(!holeData)return [];
    var route=[];
    var tee=point(holeData.tee&&holeData.tee.position||holeData.tee);
    var green=point(holeData.green&&holeData.green.position||holeData.green&&holeData.green.center||holeData.green);
    if(tee)route.push(tee);
    route=route.concat(points(holeData.route));
    if(green)route.push(green);
    return dedupeRoutePoints(route);
  }
  function splitBoundsAlongRoute(bounds,holeData,policy){
    if(!validBounds(bounds))return [];
    var route=holeDataRoutePoints(holeData);
    var length=routeLengthMeters(route);
    var maxSegment=Number(policy&&policy.maxSegmentMeters)||0;
    if(route.length<2||!maxSegment||length<=maxSegment)return [{bounds:bounds,segmentIndex:1,segmentCount:1,routeLengthMeters:length||boundsSpanM(bounds).diag}];
    var maxSegments=Math.max(1,Math.round(Number(policy&&policy.maxSegments)||6));
    var count=Math.max(1,Math.min(maxSegments,Math.ceil(length/maxSegment)));
    var overlap=Math.max(0,Number(policy&&policy.segmentOverlapMeters)||0);
    var out=[];
    for(var i=0;i<count;i++){
      var start=length*i/count;
      var end=length*(i+1)/count;
      var segmentStart=Math.max(0,start-overlap);
      var segmentEnd=Math.min(length,end+overlap);
      var segmentBounds=boundsFromPoints(routeSegmentPoints(route,segmentStart,segmentEnd));
      if(segmentBounds)out.push({bounds:segmentBounds,segmentIndex:i+1,segmentCount:count,routeLengthMeters:length,segmentStartMeters:segmentStart,segmentEndMeters:segmentEnd});
    }
    return out.length?out:[{bounds:bounds,segmentIndex:1,segmentCount:1,routeLengthMeters:length}];
  }
  function pointsFromGeometry(geometry){
    var out=[];
    function walk(value){
      if(!value)return;
      var p=point(value);
      if(p){out.push(p);return;}
      if(Array.isArray(value)){
        if(value.length>=2&&Number.isFinite(Number(value[0]))&&Number.isFinite(Number(value[1]))){out.push({lat:Number(value[1]),lng:Number(value[0])});return;}
        value.forEach(walk);
      }else if(typeof value==="object"){
        if(Array.isArray(value.points))value.points.forEach(walk);
        if(Array.isArray(value.coordinates))value.coordinates.forEach(walk);
        if(value.point)walk(value.point);
        if(value.position)walk(value.position);
        if(value.center)walk(value.center);
        if(value.centre)walk(value.centre);
      }
    }
    walk(geometry);
    return out;
  }
  function objectBounds(object){
    if(validBounds(object&&object.bounds))return object.bounds;
    return boundsFromPoints(pointsFromGeometry(object&&object.geometry));
  }
  function capturePolicy(role){
    role=String(role||"");
    var mobileHoleLens={captureLens:"mobile-hole",lensShape:"mobile-hole",lensAspectRatio:9/16,lensOrientation:"map-axis",lensFit:"expand-bounds"};
    var greenSquareLens={captureLens:"green-square",lensShape:"green-square",lensAspectRatio:1,lensOrientation:"map-axis",lensFit:"expand-bounds"};
    if(role==="green-surround")return Object.assign({role:role,label:"Super HD green surrounds",quality:"super-hd",targetZoom:20,minZoom:20,maxZoom:20,maxTiles:220,bleedMeters:26,bleedPx:220,stitchLayer:30,fixedZoom:true},greenSquareLens);
    if(role==="play-corridor")return Object.assign({role:role,label:"HD play corridor",quality:"hd",targetZoom:19,minZoom:19,maxZoom:19,maxTiles:320,bleedMeters:32,bleedPx:220,stitchLayer:20,fixedZoom:true,maxSegmentMeters:320,segmentOverlapMeters:42,maxSegments:6},mobileHoleLens);
    if(role==="terrain-reference")return {role:role,label:"Terrain view reference",quality:"terrain-map",targetZoom:16,minZoom:14,maxZoom:17,maxTiles:260,bleedMeters:130,bleedPx:380,stitchLayer:5,terrainStageOnly:true,debugTerrain:true,tileSourceLabel:"Esri World Topographic Map",tileTemplate:"https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"};
    if(role==="three-d-hole-beta")return Object.assign({role:role,label:"3D view beta hole camera",quality:"3d-beta",targetZoom:18,minZoom:18,maxZoom:18,maxTiles:320,bleedMeters:64,bleedPx:620,stitchLayer:40,beta3dStageOnly:true,cameraMode:"3d-beta-toggle",captureTiltDeg:8,playTiltDeg:14,cameraTiltDeg:8,cameraBearingMode:"play-axis",enabledByDefault:false,fixedZoom:true,maxSegmentMeters:320,segmentOverlapMeters:42,maxSegments:6},mobileHoleLens);
    return {role:"course-backdrop",label:"Live map underlay",quality:"live-map-base",targetZoom:17,minZoom:16,maxZoom:18,maxTiles:260,bleedMeters:120,bleedPx:420,stitchLayer:0,debugUnderlay:true};
  }
  function planItem(courseId,courseName,role,bounds,holeNumber,holeData,extra){
    extra=extra||{};
    var policy=capturePolicy(role);
    var padded=padBounds(bounds,policy.bleedMeters);
    if(!validBounds(padded))return null;
    var segmentSuffix=extra.segmentCount>1?"s"+extra.segmentIndex+"of"+extra.segmentCount:"";
    var id=["cv-plan",slug(courseId),policy.role,holeNumber?"h"+holeNumber:"course",segmentSuffix,hashString(padded)].filter(Boolean).join(":");
    return Object.assign({},policy,{
      id:id,
      planId:id,
      courseId:slug(courseId),
      courseName:text(courseName,180),
      holeNumber:holeNumber||null,
      segmentIndex:extra.segmentIndex||null,
      segmentCount:extra.segmentCount||null,
      segmentStartMeters:Number.isFinite(Number(extra.segmentStartMeters))?Number(extra.segmentStartMeters):null,
      segmentEndMeters:Number.isFinite(Number(extra.segmentEndMeters))?Number(extra.segmentEndMeters):null,
      routeLengthMeters:Number.isFinite(Number(extra.routeLengthMeters))?Number(extra.routeLengthMeters):null,
      bounds:padded,
      sourceBounds:bounds,
      holeData:holeData||null,
      captureKey:[slug(courseId),holeNumber?"h"+holeNumber:"course",policy.role,segmentSuffix].filter(Boolean).join(":"),
      reason:"course-visual-"+policy.role+"-visual-lock"
    });
  }
  function holeRecordToPlayData(hole){
    if(!hole)return null;
    var route=points(hole.routePoints||hole.route||hole.frameAnchors&&hole.frameAnchors.route);
    var green=point(hole.greenCentre||hole.greenCenter||hole.green||hole.frameAnchors&&hole.frameAnchors.green)||route[route.length-1]||null;
    var tee=point(hole.teePoint||hole.tee||hole.frameAnchors&&hole.frameAnchors.tee)||route[0]||null;
    var shape=points(hole.greenShape||hole.shape||hole.frameAnchors&&hole.frameAnchors.greenShape);
    return {route:route,tee:tee?{position:tee}:null,green:green?{position:green,center:green,centre:green,greenShape:shape,shape:shape,holeNumber:hole.holeNumber}:null};
  }
  function planSummary(plan,captures){
    var out={version:1,stitchModel:"geo-rectangle-table-over-live-map",planned:Array.isArray(plan)?plan.length:0,captured:Array.isArray(captures)?captures.length:0,roles:{}};
    (Array.isArray(plan)?plan:[]).forEach(function(item){
      var role=String(item&&item.role||"capture");
      out.roles[role]=out.roles[role]||{planned:0,captured:0,quality:item&&item.quality||"",layer:item&&item.stitchLayer||0};
      out.roles[role].planned+=1;
      if(item&&item.captureLens)out.roles[role].captureLens=item.captureLens;
      if(item&&item.lensAspectRatio)out.roles[role].lensAspectRatio=item.lensAspectRatio;
      if(item&&item.segmentCount)out.roles[role].segmentCount=Math.max(Number(out.roles[role].segmentCount)||0,Number(item.segmentCount)||0);
    });
    (Array.isArray(captures)?captures:[]).forEach(function(capture){
      var role=String(capture&&capture.role||"capture");
      out.roles[role]=out.roles[role]||{planned:0,captured:0,quality:capture&&capture.quality||"",layer:capture&&capture.stitchLayer||0};
      out.roles[role].captured+=1;
      if(capture&&capture.captureLens)out.roles[role].captureLens=capture.captureLens;
      if(capture&&capture.lensAspectRatio)out.roles[role].lensAspectRatio=capture.lensAspectRatio;
      if(capture&&capture.segmentCount)out.roles[role].segmentCount=Math.max(Number(out.roles[role].segmentCount)||0,Number(capture.segmentCount)||0);
    });
    return out;
  }
  function boundsCompatible(imageBounds,anchorBounds){
    if(!validBounds(imageBounds)||!validBounds(anchorBounds))return true;
    if(boundsIntersects(imageBounds,anchorBounds))return true;
    var imageCenter=boundsCenter(imageBounds);
    var anchorCenter=boundsCenter(anchorBounds);
    if(!imageCenter||!anchorCenter)return true;
    var latTol=Math.max(.0005,(Number(imageBounds.north)-Number(imageBounds.south)+Number(anchorBounds.north)-Number(anchorBounds.south))*2);
    var lngTol=Math.max(.0005,(Number(imageBounds.east)-Number(imageBounds.west)+Number(anchorBounds.east)-Number(anchorBounds.west))*2);
    return Math.abs(imageCenter.lat-anchorCenter.lat)<=latTol&&Math.abs(imageCenter.lng-anchorCenter.lng)<=lngTol;
  }
  function manifestImageBounds(manifest){
    if(!manifest)return null;
    var width=Math.max(1,Math.round(Number(manifest.imageWidth||manifest.width)||0));
    var height=Math.max(1,Math.round(Number(manifest.imageHeight||manifest.height)||0));
    var origin=manifest.originPx||manifest.pixelOrigin||manifest.origin||{};
    var x=finite(origin.x!==undefined?origin.x:origin.left);
    var y=finite(origin.y!==undefined?origin.y:origin.top);
    var zoom=finite(manifest.captureZoom!==undefined?manifest.captureZoom:manifest.zoom);
    if(zoom==null&&Array.isArray(manifest.tiles)&&manifest.tiles[0])zoom=finite(manifest.tiles[0].z);
    if(!width||!height||x==null||y==null||zoom==null)return null;
    return boundsFromPoints([unprojectWorldPixel(x,y,zoom),unprojectWorldPixel(x+width,y+height,zoom)]);
  }
  function escapeXml(value){
    return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function dataUrl(mime,body){return "data:"+mime+";charset=utf-8,"+encodeURIComponent(body);}
  function hashString(value){
    var str=typeof value==="string"?value:JSON.stringify(value||"");
    var hash=2166136261;
    for(var i=0;i<str.length;i++){hash^=str.charCodeAt(i);hash+=(hash<<1)+(hash<<4)+(hash<<7)+(hash<<8)+(hash<<24);}
    return ("00000000"+(hash>>>0).toString(16)).slice(-8);
  }
  function readJson(key,fb){
    if(!root||!root.localStorage)return clone(fb);
    return safe(function(){var raw=root.localStorage.getItem(key);return raw?JSON.parse(raw):clone(fb);},clone(fb));
  }
  function writeJson(key,value){
    if(root&&root.localStorage)safe(function(){root.localStorage.setItem(key,JSON.stringify(value));});
    return value;
  }
  function visualAssets(record){
    return [
      record&&record.rawMaster,
      record&&record.basicVisual,
      record&&record.exampleHoleVisual,
      record&&record.previewVisual,
      record&&record.terrainView,
      record&&record.singleHolePreviewVisual,
      record&&record.singleHoleTerrainView,
      record&&record.beta3dView,
      record&&record.publishedVisual,
      record&&record.singleHolePublishedVisual
    ].filter(Boolean);
  }
  function openAssetDb(){
    if(!root||!root.indexedDB)return Promise.resolve(null);
    if(assetDbPromise)return assetDbPromise;
    assetDbPromise=new Promise(function(resolve){
      var req=safe(function(){return root.indexedDB.open(ASSET_DB_NAME,1);},null);
      if(!req){resolve(null);return;}
      req.onupgradeneeded=function(){
        var db=req.result;
        if(db&&!db.objectStoreNames.contains(ASSET_STORE_NAME))db.createObjectStore(ASSET_STORE_NAME,{keyPath:"path"});
      };
      req.onsuccess=function(){resolve(req.result||null);};
      req.onerror=function(){resolve(null);};
      req.onblocked=function(){resolve(null);};
    });
    return assetDbPromise;
  }
  function saveAssetData(path,dataUrl){
    if(!path||!dataUrl)return Promise.resolve(false);
    transientAssetDataByPath[path]=dataUrl;
    return openAssetDb().then(function(db){
      if(!db)return false;
      return new Promise(function(resolve){
        var tx=safe(function(){return db.transaction(ASSET_STORE_NAME,"readwrite");},null);
        if(!tx){resolve(false);return;}
        safe(function(){tx.objectStore(ASSET_STORE_NAME).put({path:path,dataUrl:dataUrl,updatedAt:now()});});
        tx.oncomplete=function(){resolve(true);};
        tx.onerror=function(){resolve(false);};
        tx.onabort=function(){resolve(false);};
      });
    }).catch(function(){return false;});
  }
  function loadAssetData(path){
    if(!path)return Promise.resolve(null);
    if(transientAssetDataByPath[path])return Promise.resolve(transientAssetDataByPath[path]);
    return openAssetDb().then(function(db){
      if(!db)return null;
      return new Promise(function(resolve){
        var tx=safe(function(){return db.transaction(ASSET_STORE_NAME,"readonly");},null);
        if(!tx){resolve(null);return;}
        var req=safe(function(){return tx.objectStore(ASSET_STORE_NAME).get(path);},null);
        if(!req){resolve(null);return;}
        req.onsuccess=function(){
          var data=req.result&&req.result.dataUrl||null;
          if(data)transientAssetDataByPath[path]=data;
          resolve(data);
        };
        req.onerror=function(){resolve(null);};
      });
    }).catch(function(){return null;});
  }
  function hydrateRecordAssets(record){
    record=record&&typeof record==="object"?record:null;
    if(!record)return Promise.resolve({record:record,hydratedCount:0});
    var count=0;
    return Promise.all(visualAssets(record).map(function(asset){
      if(!asset||!asset.path||asset.dataUrl)return Promise.resolve(false);
      return loadAssetData(asset.path).then(function(data){
        if(!data)return false;
        asset.dataUrl=data;
        count+=1;
        return true;
      });
    })).then(function(){return {record:attachTransientAssets(record),hydratedCount:count};});
  }
  function hydrateCourseVisualAssets(courseId){
    var record=getRecord(courseId);
    return hydrateRecordAssets(record).then(function(result){
      captureTransientAssets(result.record);
      return result;
    });
  }
  function emptyStore(){
    return {schema:"gd.course_visual_engine.store",version:VERSION,rendererVersion:RENDERER_VERSION,updatedAt:null,records:{}};
  }
  function loadStore(){
    var store=readJson(STORE_KEY,emptyStore());
    store.schema="gd.course_visual_engine.store";
    store.version=VERSION;
    store.rendererVersion=RENDERER_VERSION;
    store.records=store.records&&typeof store.records==="object"?store.records:{};
    return store;
  }
  function saveStore(store){
    store=store&&typeof store==="object"?store:emptyStore();
    store.updatedAt=now();
    return writeJson(STORE_KEY,store);
  }
  function baseCourseVisualPreset(){
    var stamp="2026-07-15T00:00:00.000Z";
    return {
      id:"clarity-course-natural-v1",
      name:"Natural",
      version:PRESET_VERSION,
      mode:"Natural",
      description:"Balanced aerial map tone for general course overviews.",
      turf:{hueMin:86,hueMax:142,saturationMin:28,saturationMax:66,brightnessMin:30,brightnessMax:72,greenStrength:.35},
      lighting:{brightnessTarget:52,shadowFloor:14,highlightCeiling:92,contrastTarget:1.04},
      readability:{fairwaySeparation:.18,greenSeparation:.16,bunkerBrightness:.08,localContrast:.08,sharpness:.1},
      mowingVisibility:"Unknown",
      createdAt:stamp,
      updatedAt:stamp
    };
  }
  function defaultPreset(){
    return clone(baseCourseVisualPreset());
  }
  function presetSpec(id,name,mode,description,patch){
    return {id:id,name:name,mode:mode||name,description:description||"",patch:patch||{}};
  }
  function builtInPresetSpecs(){
    return [
      presetSpec("clarity-course-natural-v1","Natural","Natural","Balanced aerial map tone for general course overviews.",{}),
      presetSpec("clarity-course-fresh-v1","Fresh Fairway","Fresh","A brighter, cleaner course map that keeps grass lively without looking cartoonish.",{
        turf:{greenStrength:.48,saturationMin:34},
        lighting:{brightnessTarget:56,contrastTarget:1.05},
        readability:{fairwaySeparation:.2,greenSeparation:.18,localContrast:.12,sharpness:.12},
        mowingVisibility:"Low"
      }),
      presetSpec("clarity-course-rich-v1","Rich Aerial","Rich","Deeper greens and slightly stronger contrast for premium course thumbnails.",{
        turf:{greenStrength:.62,saturationMin:40},
        lighting:{brightnessTarget:53,contrastTarget:1.08},
        readability:{fairwaySeparation:.23,greenSeparation:.22,localContrast:.13,sharpness:.14},
        mowingVisibility:"Low"
      }),
      presetSpec("clarity-course-strong-v1","Strong Clarity","Strong","A more readable decision-map style for small screens and busy imagery.",{
        turf:{greenStrength:.78,saturationMin:46},
        lighting:{brightnessTarget:55,contrastTarget:1.12},
        readability:{fairwaySeparation:.28,greenSeparation:.26,localContrast:.16,sharpness:.18},
        mowingVisibility:"Clear"
      }),
      presetSpec("clarity-course-green-detail-v1","Green Detail","Green Detail","Emphasises greens and surrounds while keeping fairways natural.",{
        turf:{greenStrength:.72,saturationMin:44,brightnessMin:34,brightnessMax:74},
        lighting:{brightnessTarget:54,contrastTarget:1.09},
        readability:{fairwaySeparation:.2,greenSeparation:.32,bunkerBrightness:.1,localContrast:.15,sharpness:.18},
        mowingVisibility:"Clear"
      }),
      presetSpec("clarity-course-fairway-corridor-v1","Fairway Corridor","Fairway Corridor","Best for play-corridor inspection where fairways, hazards and landing areas need separation.",{
        turf:{greenStrength:.56,saturationMin:36},
        lighting:{brightnessTarget:57,shadowFloor:18,contrastTarget:1.1},
        readability:{fairwaySeparation:.34,greenSeparation:.2,bunkerBrightness:.12,localContrast:.17,sharpness:.2},
        mowingVisibility:"Low"
      }),
      presetSpec("clarity-course-terrain-relief-v1","Terrain Relief","Terrain Relief","Designed to carry terrain shading without losing the live imagery beneath it.",{
        turf:{greenStrength:.44,saturationMin:32},
        lighting:{brightnessTarget:50,shadowFloor:16,contrastTarget:1.13},
        readability:{fairwaySeparation:.22,greenSeparation:.2,bunkerBrightness:.06,localContrast:.19,sharpness:.16},
        mowingVisibility:"Clear"
      }),
      presetSpec("clarity-course-shade-rescue-v1","Shade Rescue","Shade Rescue","Lifts dark captures and tree-shadowed holes while avoiding a washed-out fairway.",{
        turf:{greenStrength:.52,saturationMin:36,brightnessMin:34},
        lighting:{brightnessTarget:62,shadowFloor:24,highlightCeiling:94,contrastTarget:1.02},
        readability:{fairwaySeparation:.2,greenSeparation:.2,bunkerBrightness:.14,localContrast:.11,sharpness:.1},
        mowingVisibility:"Low"
      }),
      presetSpec("clarity-course-broadcast-pop-v1","Broadcast Pop","Broadcast Pop","A bold preview look for demos and quick visual checks.",{
        turf:{greenStrength:.86,saturationMin:48,saturationMax:72},
        lighting:{brightnessTarget:58,shadowFloor:18,contrastTarget:1.16},
        readability:{fairwaySeparation:.3,greenSeparation:.3,bunkerBrightness:.14,localContrast:.2,sharpness:.22},
        mowingVisibility:"Prominent"
      })
    ];
  }
  function presetFromSpec(spec){
    var preset=mergePreset(baseCourseVisualPreset(),spec&&spec.patch||{});
    preset.id=spec&&spec.id||("clarity-course-"+slug(spec&&spec.name||"preset")+"-v1");
    preset.name=spec&&spec.name||preset.name;
    preset.mode=spec&&spec.mode||preset.name;
    preset.description=spec&&spec.description||preset.description||"";
    preset.version=PRESET_VERSION;
    preset.updatedAt="2026-07-15T00:00:00.000Z";
    return preset;
  }
  function courseVisualPresetList(){
    return builtInPresetSpecs().map(presetFromSpec);
  }
  function builtInPresetMap(){
    var presets={};
    courseVisualPresetList().forEach(function(preset){presets[preset.id]=preset;});
    return presets;
  }
  function presetForMode(mode){
    var key=slug(mode||"Natural");
    var list=courseVisualPresetList();
    var match=list.filter(function(preset){return slug(preset.id)===key||slug(preset.mode)===key||slug(preset.name)===key;})[0];
    return clone(match||list[0]||defaultPreset());
  }
  function loadPresets(){
    var saved=readJson(PRESET_KEY,null);
    var builtIns=builtInPresetMap();
    var presets=Object.assign({},saved&&saved.presets||{});
    Object.keys(builtIns).forEach(function(id){presets[id]=builtIns[id];});
    var store={schema:"gd.course_visual_engine.presets",version:PRESET_VERSION,defaultPresetId:defaultPreset().id,presets:presets,updatedAt:saved&&saved.updatedAt||now()};
    var changed=!saved||saved.version!==PRESET_VERSION||!saved.presets;
    Object.keys(builtIns).forEach(function(id){
      if(!saved||!saved.presets||!saved.presets[id]||saved.presets[id].version!==PRESET_VERSION)changed=true;
    });
    if(changed){store.updatedAt=now();return writeJson(PRESET_KEY,store);}
    return store;
  }
  function getPreset(presetId){
    var presets=loadPresets();
    return clone(presets.presets[presetId]||presets.presets[presets.defaultPresetId]||defaultPreset());
  }
  function mergePreset(preset,overrides){
    var out=clone(preset||defaultPreset());
    function walk(target,patch){
      Object.keys(patch||{}).forEach(function(key){
        if(patch[key]&&typeof patch[key]==="object"&&!Array.isArray(patch[key])){target[key]=target[key]&&typeof target[key]==="object"?target[key]:{};walk(target[key],patch[key]);}
        else target[key]=patch[key];
      });
    }
    walk(out,overrides||{});
    return out;
  }
  function captureBounds(capture){
    if(validBounds(capture&&capture.bounds))return capture.bounds;
    var pins=capture&&capture.anchorPins||capture&&capture.pins||{};
    return boundsFromPoints([pins.tee,pins.green].concat(points(pins.route),points(pins.greenShape)));
  }
  function manifestToCapture(manifest,opts){
    if(!manifest||!Array.isArray(manifest.tiles)||!manifest.tiles.length)return null;
    var courseId=slug(manifest.courseKey||manifest.courseName||opts&&opts.courseId);
    var holeNumber=Math.max(1,Math.round(Number(manifest.holeNumber)||Number(opts&&opts.holeNumber)||1));
    var anchorBounds=captureBounds(manifest);
    var imageBounds=manifestImageBounds(manifest);
    var useImageBounds=imageBounds&&boundsCompatible(imageBounds,anchorBounds);
    var bounds=useImageBounds?imageBounds:(anchorBounds||imageBounds);
    var role=text(manifest.visualRole||manifest.captureRole||opts&&opts.role,60)||"source-frame";
    var quality=text(manifest.visualQuality||manifest.quality||opts&&opts.quality,60)||"source";
    var layer=finite(manifest.stitchLayer!==undefined?manifest.stitchLayer:opts&&opts.stitchLayer);
    if(layer==null)layer=role==="course-backdrop"?0:role==="play-corridor"?20:role==="green-surround"?30:10;
    return {
      id:text(manifest.scanId||manifest.activeScanId||manifest.key||("capture-"+courseId+"-h"+holeNumber),180),
      imageUrl:null,
      imageData:null,
      storagePath:text(manifest.key||manifest.storageKey||"",220),
      bounds:bounds,
      boundsSource:useImageBounds?"manifest-image":anchorBounds?"anchor-pins":imageBounds?"manifest-image-unverified":"unknown",
      width:Math.max(1,Math.round(Number(manifest.imageWidth)||0)),
      height:Math.max(1,Math.round(Number(manifest.imageHeight)||0)),
      devicePixelRatio:finite(manifest.devicePixelRatio)||1,
      zoom:finite(manifest.captureZoom),
      capturedAt:text(manifest.createdAt||manifest.updatedAt,80),
      holeNumber:holeNumber,
      role:role,
      quality:quality,
      stitchLayer:layer,
      planId:text(manifest.visualPlanId||manifest.capturePlanId||opts&&opts.planId||opts&&opts.id,180),
      debugUnderlay:!!(manifest.debugUnderlay||opts&&opts.debugUnderlay),
      debugTerrain:!!(manifest.debugTerrain||opts&&opts.debugTerrain),
      terrainStageOnly:!!(manifest.terrainStageOnly||opts&&opts.terrainStageOnly),
      beta3dStageOnly:!!(manifest.beta3dStageOnly||opts&&opts.beta3dStageOnly),
      cameraMode:text(manifest.cameraMode||opts&&opts.cameraMode,80),
      cameraTiltDeg:finite(manifest.cameraTiltDeg!==undefined?manifest.cameraTiltDeg:opts&&opts.cameraTiltDeg),
      captureTiltDeg:finite(manifest.captureTiltDeg!==undefined?manifest.captureTiltDeg:opts&&opts.captureTiltDeg),
      playTiltDeg:finite(manifest.playTiltDeg!==undefined?manifest.playTiltDeg:opts&&opts.playTiltDeg),
      cameraFallback:text(manifest.cameraFallback||opts&&opts.cameraFallback,140),
      tileSourceLabel:text(manifest.tileSourceLabel||opts&&opts.tileSourceLabel,120),
      captureLens:text(manifest.captureLens||manifest.lensShape||opts&&opts.captureLens||opts&&opts.lensShape,80),
      lensShape:text(manifest.lensShape||manifest.captureLens||opts&&opts.lensShape||opts&&opts.captureLens,80),
      lensAspectRatio:finite(manifest.lensAspectRatio!==undefined?manifest.lensAspectRatio:manifest.lensAspect!==undefined?manifest.lensAspect:opts&&opts.lensAspectRatio!==undefined?opts.lensAspectRatio:opts&&opts.lensAspect),
      lensOrientation:text(manifest.lensOrientation||opts&&opts.lensOrientation,80),
      lensFit:text(manifest.lensFit||opts&&opts.lensFit,80),
      segmentIndex:finite(manifest.segmentIndex!==undefined?manifest.segmentIndex:opts&&opts.segmentIndex),
      segmentCount:finite(manifest.segmentCount!==undefined?manifest.segmentCount:opts&&opts.segmentCount),
      segmentStartMeters:finite(manifest.segmentStartMeters!==undefined?manifest.segmentStartMeters:opts&&opts.segmentStartMeters),
      segmentEndMeters:finite(manifest.segmentEndMeters!==undefined?manifest.segmentEndMeters:opts&&opts.segmentEndMeters),
      routeLengthMeters:finite(manifest.routeLengthMeters!==undefined?manifest.routeLengthMeters:opts&&opts.routeLengthMeters),
      sourceType:"leaflet-tile-manifest",
      originPx:manifest.originPx||null,
      tiles:manifest.tiles.map(function(tile){
        return {
          x:Math.round(Number(tile.x)||0),
          y:Math.round(Number(tile.y)||0),
          width:Math.round(Number(tile.width)||256)||256,
          height:Math.round(Number(tile.height)||256)||256,
          z:finite(tile.z),
          tileX:finite(tile.tileX),
          tileY:finite(tile.tileY),
          url:text(tile.url,900)
        };
      }).filter(function(tile){return !!tile.url;})
    };
  }
  function objectFromHole(hole,type,position,shape){
    if(!position&&!shape)return null;
    var holeNumber=Math.max(1,Math.round(Number(hole&&hole.holeNumber)||1));
    var id=[type,hole&&hole.courseId||hole&&hole.courseKey||"course","h"+holeNumber,hashString(position||shape)].join(":");
    return {id:id,type:type,holeNumber:holeNumber,geometry:shape&&shape.length?{type:"LineString",points:shape}:{type:"Point",point:position},bounds:boundsFromPoints(shape&&shape.length?shape:[position])};
  }
  function planCourseVisualCaptures(input,opts){
    opts=opts||{};
    var normalized=normalizeInput(input||{});
    var rawHoles=Array.isArray(input&&input.sourceHoles)?input.sourceHoles:[];
    var holeDataByNumber={};
    rawHoles.forEach(function(hole){
      var holeNumber=Math.max(1,Math.round(Number(hole&&hole.holeNumber)||1));
      holeDataByNumber[holeNumber]=holeRecordToPlayData(hole);
    });
    var byHole={};
    normalized.objects.forEach(function(object){
      var holeNumber=Math.max(1,Math.round(Number(object&&object.holeNumber)||1));
      byHole[holeNumber]=byHole[holeNumber]||[];
      byHole[holeNumber].push(object);
    });
    var plan=[];
    var backdropBounds=validBounds(normalized.courseBounds)?normalized.courseBounds:mergeBounds(normalized.objects.map(objectBounds).concat(normalized.captures.map(captureBounds)));
    var backdrop=planItem(normalized.courseId,normalized.courseName,"course-backdrop",backdropBounds,null,null);
    if(backdrop)plan.push(backdrop);
    var terrain=planItem(normalized.courseId,normalized.courseName,"terrain-reference",backdropBounds,null,null);
    if(terrain)plan.push(terrain);
    Object.keys(byHole).map(Number).filter(function(hole){return hole>0;}).sort(function(a,b){return a-b;}).forEach(function(holeNumber){
      var objects=byHole[holeNumber]||[];
      var greens=objects.filter(function(object){return /green|pin/i.test(String(object&&object.type||""));});
      var corridors=objects.filter(function(object){return /fairway|tee|green|pin/i.test(String(object&&object.type||""));});
      var greenBounds=mergeBounds(greens.map(objectBounds));
      var corridorBounds=mergeBounds(corridors.map(objectBounds));
      if(validBounds(greenBounds)){
        var greenSpan=boundsSpanM(greenBounds);
        if(greenSpan.diag<8)greenBounds=padBounds(greenBounds,16);
        var greenItem=planItem(normalized.courseId,normalized.courseName,"green-surround",greenBounds,holeNumber,holeDataByNumber[holeNumber]);
        if(greenItem)plan.push(greenItem);
      }
      if(validBounds(corridorBounds)){
        var corridorSpan=boundsSpanM(corridorBounds);
        if(corridorSpan.diag<35)corridorBounds=padBounds(corridorBounds,32);
        var corridorPolicy=capturePolicy("play-corridor");
        splitBoundsAlongRoute(corridorBounds,holeDataByNumber[holeNumber],corridorPolicy).forEach(function(segment){
          var corridorItem=planItem(normalized.courseId,normalized.courseName,"play-corridor",segment.bounds,holeNumber,holeDataByNumber[holeNumber],segment);
          if(corridorItem)plan.push(corridorItem);
        });
        if(opts.enable3dBeta===true){
          var betaPolicy=capturePolicy("three-d-hole-beta");
          splitBoundsAlongRoute(corridorBounds,holeDataByNumber[holeNumber],betaPolicy).forEach(function(segment){
            var betaItem=planItem(normalized.courseId,normalized.courseName,"three-d-hole-beta",segment.bounds,holeNumber,holeDataByNumber[holeNumber],segment);
            if(betaItem)plan.push(betaItem);
          });
        }
      }
    });
    var limit=Math.max(0,Math.round(Number(opts.limit)||0));
    return limit?plan.slice(0,limit):plan;
  }
  function adaptCoursePlayPayloadToVisualInput(payload,opts){
    opts=opts||{};
    var source=payload&&payload.payload||payload||{};
    var courseId=slug(source.courseId||source.courseKey||opts.courseId);
    var holes=Array.isArray(source.holes)?source.holes:Object.keys(source.holes||{}).map(function(key){return source.holes[key];});
    var objects=[];
    holes.forEach(function(hole){
      var green=point(hole&&hole.greenCentre||hole&&hole.greenCenter);
      var tee=point(hole&&hole.teePoint);
      var route=points(hole&&hole.routePoints);
      var shape=points(hole&&hole.greenShape);
      [objectFromHole(hole,"green",green,shape),objectFromHole(hole,"tee",tee,null),objectFromHole(hole,"fairway",route.length?route[Math.floor(route.length/2)]:null,route)].forEach(function(object){if(object)objects.push(object);});
    });
    var manifests=[];
    if(Array.isArray(opts.captures))manifests=opts.captures;
    else if(Array.isArray(opts.frameRows)&&typeof opts.readManifest==="function"){
      opts.frameRows.forEach(function(frame){
        var key=frame&&(frame.manifestKey||frame.capturedManifestKey);
        var manifest=key?opts.readManifest(key):null;
        if(manifest)manifests.push(manifest);
      });
    }
    var captures=manifests.map(function(item){return item&&item.tiles?manifestToCapture(item,{courseId:courseId}):item;}).filter(function(capture){return capture&&capture.width&&capture.height&&captureBounds(capture)&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData);});
    return {
      courseId:courseId,
      courseName:text(source.courseName||source.name||opts.courseName,180),
      courseBounds:mergeBounds(captures.map(captureBounds).concat(objects.map(function(object){return object.bounds;}))),
      objects:objects,
      captures:captures,
      sourceHoles:holes.map(function(hole){return clone(hole);}),
      currentVisual:opts.currentVisual||null
    };
  }
  function normalizeInput(input){
    input=input&&typeof input==="object"?input:{};
    var courseId=slug(input.courseId||input.courseKey||input.courseName);
    return {
      courseId:courseId,
      courseName:text(input.courseName||input.name,180),
      courseBounds:validBounds(input.courseBounds)?input.courseBounds:mergeBounds((input.captures||[]).map(captureBounds).concat((input.objects||[]).map(function(o){return o&&o.bounds;}))),
      capturePlan:(Array.isArray(input.capturePlan)?input.capturePlan:[]).map(function(item){
        return {id:text(item&&item.id||item&&item.planId,180),role:text(item&&item.role,60),quality:text(item&&item.quality,60),holeNumber:finite(item&&item.holeNumber),targetZoom:finite(item&&item.targetZoom),minZoom:finite(item&&item.minZoom),maxTiles:finite(item&&item.maxTiles),stitchLayer:finite(item&&item.stitchLayer),bounds:validBounds(item&&item.bounds)?item.bounds:null,label:text(item&&item.label,120),terrainStageOnly:!!(item&&item.terrainStageOnly),beta3dStageOnly:!!(item&&item.beta3dStageOnly),cameraMode:text(item&&item.cameraMode,80),cameraTiltDeg:finite(item&&item.cameraTiltDeg),captureTiltDeg:finite(item&&item.captureTiltDeg),playTiltDeg:finite(item&&item.playTiltDeg),tileSourceLabel:text(item&&item.tileSourceLabel,120),captureLens:text(item&&item.captureLens||item&&item.lensShape,80),lensShape:text(item&&item.lensShape||item&&item.captureLens,80),lensAspectRatio:finite(item&&item.lensAspectRatio!==undefined?item.lensAspectRatio:item&&item.lensAspect),lensOrientation:text(item&&item.lensOrientation,80),lensFit:text(item&&item.lensFit,80),segmentIndex:finite(item&&item.segmentIndex),segmentCount:finite(item&&item.segmentCount),segmentStartMeters:finite(item&&item.segmentStartMeters),segmentEndMeters:finite(item&&item.segmentEndMeters),routeLengthMeters:finite(item&&item.routeLengthMeters)};
      }),
      sourceHoles:Array.isArray(input.sourceHoles)?input.sourceHoles.map(function(hole){return clone(hole);}):[],
      objects:(Array.isArray(input.objects)?input.objects:[]).map(function(object,index){
        return {id:text(object&&object.id,180)||"object-"+index,type:text(object&&object.type,40)||"other",holeNumber:finite(object&&object.holeNumber),geometry:object&&object.geometry,bounds:validBounds(object&&object.bounds)?object.bounds:null};
      }),
      captures:(Array.isArray(input.captures)?input.captures:[]).map(function(capture,index){
        var isNormalizedCapture=!!(capture&&capture.width&&capture.height&&(capture.storagePath||capture.bounds));
        var looksLikeManifest=capture&&capture.tiles&&!isNormalizedCapture&&(capture.imageWidth||capture.imageHeight||capture.originPx||capture.key||capture.storageKey);
        var c=looksLikeManifest?manifestToCapture(capture,{courseId:courseId}):(capture&&capture.tiles?capture:manifestToCapture(capture,{courseId:courseId}));
        c=c&&typeof c==="object"?c:{};
        return Object.assign({},c,{id:text(c.id,180)||"capture-"+index,bounds:captureBounds(c),width:Math.max(0,Math.round(Number(c.width)||0)),height:Math.max(0,Math.round(Number(c.height)||0))});
      }).filter(function(capture){return capture.bounds&&capture.width&&capture.height&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData);}),
      currentVisual:input.currentVisual||null
    };
  }
  function recordEvent(record,type,detail){
    record.events=Array.isArray(record.events)?record.events:[];
    record.events.push(Object.assign({at:now(),type:type},clone(detail||{})));
    record.events=record.events.slice(-80);
    if(root&&typeof root.dispatchEvent==="function")safe(function(){root.dispatchEvent(new CustomEvent("gd-course-visual-event",{detail:Object.assign({courseId:record.courseId},clone(record.events[record.events.length-1]))}));});
    return record;
  }
  function emptyRecord(courseId){
    var stamp=now();
    return {
      schema:"gd.course_visual.record",
      version:VERSION,
      id:"visual::"+slug(courseId),
      courseId:slug(courseId),
      status:"unavailable",
      rawMaster:null,
      basicVisual:null,
      exampleHoleVisual:null,
      previewVisual:null,
      terrainView:null,
      singleHolePreviewVisual:null,
      singleHoleTerrainView:null,
      beta3dView:null,
      publishedVisual:null,
      singleHolePublishedVisual:null,
      versions:[],
      presetId:defaultPreset().id,
      presetVersion:1,
      courseOverrides:{},
      currentVersion:0,
      publishedVersion:0,
      lastError:null,
      diagnostics:{},
      events:[],
      createdAt:stamp,
      updatedAt:stamp
    };
  }
  function getRecord(courseId){
    var store=loadStore();
    return attachTransientAssets(clone(store.records[slug(courseId)]||emptyRecord(courseId)));
  }
  function putRecord(record){
    var store=loadStore();
    record.updatedAt=now();
    record.status=VALID_STATUSES[record.status]?record.status:"failed";
    captureTransientAssets(record);
    store.records[record.courseId]=persistableRecord(record);
    saveStore(store);
    queueCloudSync(record,"metadata");
    return attachTransientAssets(clone(record));
  }
  function captureTransientAssets(record){
    visualAssets(record).forEach(function(asset){
      if(asset&&asset.path&&asset.dataUrl)saveAssetData(asset.path,asset.dataUrl);
    });
  }
  function attachTransientAssets(record){
    visualAssets(record).forEach(function(asset){
      if(asset&&asset.path&&!asset.dataUrl&&transientAssetDataByPath[asset.path])asset.dataUrl=transientAssetDataByPath[asset.path];
    });
    return record;
  }
  function persistableRecord(record){
    var out=clone(record);
    delete out.captures;
    visualAssets(out).forEach(function(asset){
      if(asset)delete asset.dataUrl;
    });
    return out;
  }
  function ingestCourseVisualInput(input){
    var normalized=normalizeInput(input);
    transientCapturesByCourse[normalized.courseId]=normalized.captures;
    var record=getRecord(normalized.courseId);
    record.courseName=normalized.courseName||record.courseName||normalized.courseId;
    record.input={courseId:normalized.courseId,courseName:normalized.courseName,courseBounds:normalized.courseBounds,objectCount:normalized.objects.length,captureCount:normalized.captures.length,sourceCaptureIds:normalized.captures.map(function(capture){return capture.id;})};
    record.objects=normalized.objects;
    record.captureRefs=normalized.captures.map(function(capture){
      return {id:capture.id,storagePath:capture.storagePath||"",holeNumber:capture.holeNumber||null,role:capture.role||"",quality:capture.quality||"",stitchLayer:capture.stitchLayer||0,planId:capture.planId||"",width:capture.width,height:capture.height,tileCount:Array.isArray(capture.tiles)?capture.tiles.length:0,bounds:capture.bounds||null};
    });
    record.status=normalized.captures.length?"input-ready":"unavailable";
    record.lastError=normalized.captures.length?null:{code:"missing-captures",message:"No captured frames are available for this course visual."};
    record.diagnostics=Object.assign({},record.diagnostics||{},{capturePlan:normalized.capturePlan,capturePlanSummary:planSummary(normalized.capturePlan,normalized.captures),captureBounds:normalized.captures.map(captureBounds),sourceDimensions:normalized.captures.map(function(c){return {id:c.id,role:c.role||"",quality:c.quality||"",stitchLayer:c.stitchLayer||0,width:c.width,height:c.height,tiles:Array.isArray(c.tiles)?c.tiles.length:0};}),missingCaptures:normalized.captures.length?[]:["course-visual-captures"]});
    recordEvent(record,"course-visual-input-received",{captureCount:normalized.captures.length,objectCount:normalized.objects.length});
    return putRecord(record);
  }
  function captureSignature(captures){
    return hashString((captures||[]).map(function(capture){return [capture.id,capture.role||"",capture.quality||"",capture.stitchLayer||0,capture.width,capture.height,capture.boundsSource||"",JSON.stringify(capture.bounds),Array.isArray(capture.tiles)?capture.tiles.length:0].join("|");}).join("\n"));
  }
  function capturesFromRecordRefs(record){
    return (Array.isArray(record&&record.captureRefs)?record.captureRefs:[]).map(function(ref){
      var manifest=ref&&ref.storagePath?readJson(ref.storagePath,null):null;
      return manifest?manifestToCapture(manifest,{courseId:record.courseId,role:ref&&ref.role,quality:ref&&ref.quality,stitchLayer:ref&&ref.stitchLayer,planId:ref&&ref.planId}):null;
    }).filter(function(capture){return capture&&capture.width&&capture.height&&captureBounds(capture)&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData);});
  }
  function renderableCapture(capture){
    return !!(capture&&capture.width&&capture.height&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData));
  }
  function captureContentSvg(capture){
    if(Array.isArray(capture&&capture.tiles)&&capture.tiles.length){
      return capture.tiles.map(function(tile){
        var tw=Number(tile.width)||256,th=Number(tile.height)||256;
        return '<image href="'+escapeXml(tile.url)+'" x="'+svgNum(Number(tile.x)||0)+'" y="'+svgNum(Number(tile.y)||0)+'" width="'+svgNum(tw)+'" height="'+svgNum(th)+'" preserveAspectRatio="none"/>';
      }).join("");
    }
    var href=capture&&capture.imageData||capture&&capture.imageUrl||"";
    return href?'<image href="'+escapeXml(href)+'" x="0" y="0" width="'+svgNum(capture.width)+'" height="'+svgNum(capture.height)+'" preserveAspectRatio="none"/>':"";
  }
  function chooseExampleCapture(captures){
    function rank(capture){
      var role=String(capture&&capture.role||"");
      if(role==="green-surround")return 0;
      if(role==="play-corridor")return 1;
      if(role==="source-frame")return 2;
      if(role==="course-backdrop")return 9;
      return 4;
    }
    var valid=(Array.isArray(captures)?captures:[]).filter(renderableCapture).sort(function(a,b){
      var ar=rank(a),br=rank(b);
      if(ar!==br)return ar-br;
      var ah=Number(a.holeNumber)||999,bh=Number(b.holeNumber)||999;
      if(ah!==bh)return ah-bh;
      return String(a.id||"").localeCompare(String(b.id||""));
    });
    return valid[0]||null;
  }
  function exampleHoleSvg(captures,meta){
    var capture=chooseExampleCapture(captures);
    if(!capture)return null;
    var width=Math.max(1,Math.round(Number(capture.width)||1));
    var height=Math.max(1,Math.round(Number(capture.height)||1));
    var content=captureContentSvg(capture);
    if(!content)return null;
    var title=(capture.role==="green-surround"?"Super HD green":capture.role==="play-corridor"?"HD corridor":"Example hole")+" "+(capture.holeNumber||"?");
    var label='<g transform="translate(12 12)"><rect x="0" y="0" width="220" height="30" rx="6" fill="rgba(0,0,0,.58)"/><text x="10" y="20" font-size="14" fill="#fff" font-family="system-ui, sans-serif" font-weight="800">'+escapeXml(title)+'</text></g>';
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="example-hole"><rect width="100%" height="100%" fill="#10130f"/>'+content+'<rect x="0" y="0" width="100%" height="100%" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="2"/>'+label+'</svg>';
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,bounds:captureBounds(capture),captureId:capture.id,holeNumber:capture.holeNumber||null,sourceCaptureIds:[capture.id],metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:"example-hole"},meta||{})};
  }
  function stitchSvg(captures,meta){
    var valid=(Array.isArray(captures)?captures:[]).filter(renderableCapture);
    if(!valid.length)throw Object.assign(new Error("No renderable tile captures found"),{code:"missing-renderable-captures"});
    var positioned=valid.map(function(capture){
      var bounds=captureBounds(capture);
      var projected=projectedBounds(bounds);
      return projected?{capture:capture,bounds:bounds,projected:projected}:null;
    }).filter(Boolean);
    if(!positioned.length)throw Object.assign(new Error("No geographic capture bounds found"),{code:"missing-geographic-bounds"});
    positioned.sort(function(a,b){
      var al=Number(a.capture&&a.capture.stitchLayer)||0,bl=Number(b.capture&&b.capture.stitchLayer)||0;
      if(al!==bl)return al-bl;
      var ah=Number(a.capture&&a.capture.holeNumber)||0,bh=Number(b.capture&&b.capture.holeNumber)||0;
      if(ah!==bh)return ah-bh;
      return String(a.capture&&a.capture.id||"").localeCompare(String(b.capture&&b.capture.id||""));
    });
    var overall=mergeProjectedBounds(positioned.map(function(item){return item.projected;}));
    var spanX=Math.max(1e-9,overall.right-overall.left);
    var spanY=Math.max(1e-9,overall.bottom-overall.top);
    var scales=[];
    positioned.forEach(function(item){
      var pw=Math.max(1e-9,item.projected.right-item.projected.left);
      var ph=Math.max(1e-9,item.projected.bottom-item.projected.top);
      scales.push((Number(item.capture.width)||1)/pw);
      scales.push((Number(item.capture.height)||1)/ph);
    });
    var usefulScale=median(scales)||4096/Math.max(spanX,spanY);
    var usefulMax=Math.max(spanX*usefulScale,spanY*usefulScale);
    var maxDim=clamp(Math.round(usefulMax),1024,8192);
    var aspect=spanX/spanY||1;
    var width,height;
    if(aspect>=1){width=maxDim;height=Math.round(maxDim/aspect);}
    else{height=maxDim;width=Math.round(maxDim*aspect);}
    width=Math.round(clamp(width,256,8192));
    height=Math.round(clamp(height,256,8192));
    var missingAreas=[];
    function roleStyle(capture){
      var role=String(capture&&capture.role||"source-frame");
      if(role==="course-backdrop")return {opacity:1,label:"LIVE MAP UNDERLAY"};
      if(role==="play-corridor")return {opacity:.92,label:"HD PLAY CORRIDOR"};
      if(role==="green-surround")return {opacity:.98,label:"SUPER HD GREEN"};
      return {opacity:1,label:"CAPTURE"};
    }
    var defs=[];
    var groups=positioned.map(function(item,index){
      var capture=item.capture;
      var p=item.projected;
      var x=(p.left-overall.left)/spanX*width;
      var y=(p.top-overall.top)/spanY*height;
      var w=Math.max(1,(p.right-p.left)/spanX*width);
      var h=Math.max(1,(p.bottom-p.top)/spanY*height);
      if(capture.boundsSource&&capture.boundsSource!=="manifest-image")missingAreas.push({captureId:capture.id,reason:"low-confidence-bounds",boundsSource:capture.boundsSource});
      var style=roleStyle(capture);
      var role=String(capture&&capture.role||"source-frame");
      var clipMask="";
      if(role!=="course-backdrop"){
        var feather=Math.max(16,Math.min(80,Math.min(w,h)*.08));
        var maskX=x-feather*2,maskY=y-feather*2,maskW=w+feather*4,maskH=h+feather*4;
        var innerX=x+feather*.8,innerY=y+feather*.8,innerW=Math.max(1,w-feather*1.6),innerH=Math.max(1,h-feather*1.6);
        var radius=Math.min(36,Math.max(8,feather*.55));
        defs.push('<clipPath id="cvStitchClip'+index+'"><rect x="'+svgNum(x)+'" y="'+svgNum(y)+'" width="'+svgNum(w)+'" height="'+svgNum(h)+'" rx="'+svgNum(radius)+'"/></clipPath><mask id="cvStitchMask'+index+'" maskUnits="userSpaceOnUse" x="'+svgNum(maskX)+'" y="'+svgNum(maskY)+'" width="'+svgNum(maskW)+'" height="'+svgNum(maskH)+'"><rect x="'+svgNum(maskX)+'" y="'+svgNum(maskY)+'" width="'+svgNum(maskW)+'" height="'+svgNum(maskH)+'" fill="black"/><rect x="'+svgNum(x)+'" y="'+svgNum(y)+'" width="'+svgNum(w)+'" height="'+svgNum(h)+'" rx="'+svgNum(radius)+'" fill="white" filter="url(#cvStitchFeather)"/><rect x="'+svgNum(innerX)+'" y="'+svgNum(innerY)+'" width="'+svgNum(innerW)+'" height="'+svgNum(innerH)+'" rx="'+svgNum(radius*.65)+'" fill="white"/></mask>');
        clipMask=' clip-path="url(#cvStitchClip'+index+')" mask="url(#cvStitchMask'+index+')"';
      }
      return '<g data-capture-id="'+escapeXml(capture.id)+'" data-role="'+escapeXml(role)+'" data-quality="'+escapeXml(capture.quality||"source")+'" data-capture-lens="'+escapeXml(capture.captureLens||"")+'" data-segment-index="'+escapeXml(capture.segmentIndex||"")+'" data-segment-count="'+escapeXml(capture.segmentCount||"")+'" data-stitch-layer="'+escapeXml(capture.stitchLayer||0)+'" data-stitch-x="'+svgNum(x)+'" data-stitch-y="'+svgNum(y)+'" data-stitch-width="'+svgNum(w)+'" data-stitch-height="'+svgNum(h)+'" opacity="'+svgNum(style.opacity)+'"'+clipMask+' transform="translate('+svgNum(x)+" "+svgNum(y)+') scale('+svgNum(w/(Number(capture.width)||1))+" "+svgNum(h/(Number(capture.height)||1))+')">'+captureContentSvg(capture)+'</g>';
    }).join("");
    var defsMarkup=defs.length?'<defs><filter id="cvStitchFeather" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="24"/></filter>'+defs.join("")+'</defs>':"";
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-layout="geographic-mercator" data-stitch-model="geo-rectangle-table-over-live-map"><rect width="100%" height="100%" fill="#10130f"/>'+defsMarkup+groups+'</svg>';
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,missingAreas:missingAreas,bounds:mergeBounds(positioned.map(function(item){return item.bounds;})),sourceCaptureIds:positioned.map(function(item){return item.capture.id;}),metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",layout:"geographic-mercator",stitchModel:"geo-rectangle-table-over-live-map",visualLayerModel:"live-underlay-plus-feathered-captures",outputDimensions:{width:width,height:height}},meta||{})};
  }
  function splitVisualCaptures(captures){
    var all=(Array.isArray(captures)?captures:[]).filter(renderableCapture);
    var terrain=all.filter(function(capture){return String(capture&&capture.role||"")==="terrain-reference"||capture&&capture.terrainStageOnly;});
    var beta3d=all.filter(function(capture){return String(capture&&capture.role||"")==="three-d-hole-beta"||capture&&capture.beta3dStageOnly;});
    var imagery=all.filter(function(capture){return terrain.indexOf(capture)<0&&beta3d.indexOf(capture)<0;});
    return {all:all,imagery:imagery,terrain:terrain,beta3d:beta3d};
  }
  function dataUrlText(src){
    src=String(src||"");
    var comma=src.indexOf(",");
    if(comma<0)return "";
    var body=src.slice(comma+1);
    if(src.slice(0,comma).toLowerCase().indexOf(";base64")>=0){
      try{if(root&&typeof root.atob==="function")return root.atob(body);}catch(e){}
      try{if(typeof Buffer!=="undefined")return Buffer.from(body,"base64").toString("utf8");}catch(e){}
      return "";
    }
    try{return decodeURIComponent(body);}catch(e){return body;}
  }
  function svgInnerFromDataUrl(src){
    if(!/^data:image\/svg\+xml/i.test(String(src||"")))return "";
    var svg=dataUrlText(src);
    if(!/<svg[\s>]/i.test(svg))return "";
    var open=svg.indexOf(">");
    var close=svg.lastIndexOf("</svg>");
    if(open<0||close<=open)return "";
    return svg.slice(open+1,close);
  }
  function visualAssetDimensions(asset,fallbackWidth,fallbackHeight){
    var meta=asset&&asset.metadata||{};
    var dims=meta.outputDimensions||{};
    return {
      width:Math.max(1,Math.round(Number(asset&&asset.width||dims.width||fallbackWidth||1200)||1200)),
      height:Math.max(1,Math.round(Number(asset&&asset.height||dims.height||fallbackHeight||800)||800))
    };
  }
  function visualAssetBounds(asset,fallback){
    return asset&&asset.bounds||asset&&asset.metadata&&asset.metadata.bounds||fallback||null;
  }
  function visualAssetSourceMarkup(asset,width,height){
    var base=asset&&asset.dataUrl||"";
    var inner=svgInnerFromDataUrl(base);
    if(inner)return inner;
    return base?'<image href="'+escapeXml(base)+'" x="0" y="0" width="'+svgNum(width)+'" height="'+svgNum(height)+'" preserveAspectRatio="none"/>':"";
  }
  function mowingOpacity(value){
    value=String(value||"Unknown");
    if(value==="Low")return .08;
    if(value==="Clear")return .16;
    if(value==="Prominent")return .28;
    return 0;
  }
  function nativeReadabilityOverlay(settings){
    var readability=settings&&settings.readability||{};
    var local=clamp(Number(readability.localContrast)||.08,0,.25);
    var top=clamp(.025+local*.22,.02,.09);
    var bottom=clamp(.05+local*.28,.05,.13);
    var opacity=clamp(.58+local*1.8,.58,.98);
    return {top:+top.toFixed(3),bottom:+bottom.toFixed(3),opacity:+opacity.toFixed(3)};
  }
  function nativeVisualAsset(asset,settings,meta){
    meta=meta||{};
    var dims=visualAssetDimensions(asset,meta.width,meta.height);
    var source=visualAssetSourceMarkup(asset,dims.width,dims.height);
    if(!source)throw Object.assign(new Error("Base visual is not available"),{code:"base-visual-missing"});
    var f=filterForSettings(settings);
    var overlay=nativeReadabilityOverlay(settings);
    var mow=mowingOpacity(settings&&settings.mowingVisibility);
    var role=text(meta.role,80)||"native-visuals";
    var stage=text(meta.stage,80)||"native-visuals";
    var version=meta.version!=null?String(meta.version):"";
    var mowingPattern=mow?'<pattern id="cvMowingStripe" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(108)"><path d="M0 0 L0 24" stroke="rgba(255,255,255,.20)" stroke-width="1"/></pattern>':"";
    var mowingLayer=mow?'<rect width="100%" height="100%" fill="url(#cvMowingStripe)" opacity="'+mow+'"/>':"";
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+dims.width+'" height="'+dims.height+'" viewBox="0 0 '+dims.width+" "+dims.height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="'+escapeXml(role)+'" data-stage="'+escapeXml(stage)+'"'+(version?' data-version="'+escapeXml(version)+'"':"")+'><defs><filter id="cvNative"><feColorMatrix type="saturate" values="'+f.saturation+'"/><feComponentTransfer><feFuncR type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/><feFuncG type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/><feFuncB type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/></feComponentTransfer></filter><linearGradient id="cvNativeReadability" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,'+overlay.top+')"/><stop offset=".55" stop-color="rgba(255,255,255,0)"/><stop offset="1" stop-color="rgba(0,0,0,'+overlay.bottom+')"/></linearGradient>'+mowingPattern+'</defs><rect width="100%" height="100%" fill="#10130f"/><g filter="url(#cvNative)">'+source+'</g><rect width="100%" height="100%" fill="url(#cvNativeReadability)" opacity="'+overlay.opacity+'"/>'+mowingLayer+'</svg>';
    return {dataUrl:dataUrl("image/svg+xml",svg),width:dims.width,height:dims.height,bounds:visualAssetBounds(asset,meta.bounds),sourceCaptureIds:asset&&asset.sourceCaptureIds||[],metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:role,stage:stage,inputRole:asset&&asset.metadata&&asset.metadata.role||"",inputStage:asset&&asset.metadata&&asset.metadata.stage||"",outputDimensions:dims},meta)};
  }
  function terrainShadeAsset(asset,terrainCaptures,meta){
    meta=meta||{};
    var dims=visualAssetDimensions(asset,meta.width,meta.height);
    var source=visualAssetSourceMarkup(asset,dims.width,dims.height);
    if(!source)return null;
    var bounds=visualAssetBounds(asset,meta.bounds);
    var overall=projectedBounds(bounds);
    var terrain=(Array.isArray(terrainCaptures)?terrainCaptures:[]).filter(renderableCapture).map(function(capture){
      var captureBoundsValue=captureBounds(capture);
      var projected=projectedBounds(captureBoundsValue);
      return projected?{capture:capture,bounds:captureBoundsValue,projected:projected}:null;
    }).filter(Boolean);
    var sourceCaptureIds=terrain.map(function(item){return item.capture.id;});
    var terrainGroups="";
    if(overall&&terrain.length){
      var spanX=Math.max(1e-9,overall.right-overall.left);
      var spanY=Math.max(1e-9,overall.bottom-overall.top);
      terrainGroups=terrain.map(function(item){
        var capture=item.capture;
        var p=item.projected;
        var x=(p.left-overall.left)/spanX*dims.width;
        var y=(p.top-overall.top)/spanY*dims.height;
        var w=Math.max(1,(p.right-p.left)/spanX*dims.width);
        var h=Math.max(1,(p.bottom-p.top)/spanY*dims.height);
        return '<g data-capture-id="'+escapeXml(capture.id)+'" data-role="terrain-reference" opacity=".34" style="mix-blend-mode:multiply" filter="url(#terrainTone)" transform="translate('+svgNum(x)+" "+svgNum(y)+') scale('+svgNum(w/(Number(capture.width)||1))+" "+svgNum(h/(Number(capture.height)||1))+')">'+captureContentSvg(capture)+'</g>';
      }).join("");
    }
    var role=text(meta.role,80)||"terrain-view";
    var stage=text(meta.stage,80)||"terrain-shading";
    var terrainSource=terrain.length?"tile-reference-overlay":"deterministic-shading";
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+dims.width+'" height="'+dims.height+'" viewBox="0 0 '+dims.width+" "+dims.height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="'+escapeXml(role)+'" data-stage="'+escapeXml(stage)+'"><defs><filter id="terrainTone"><feColorMatrix type="matrix" values=".32 .32 .32 0 0 .30 .30 .30 0 0 .26 .26 .26 0 0 0 0 0 .85 0"/><feComponentTransfer><feFuncR type="linear" slope="1.08" intercept="-.03"/><feFuncG type="linear" slope="1.08" intercept="-.03"/><feFuncB type="linear" slope="1.08" intercept="-.03"/></feComponentTransfer></filter><linearGradient id="terrainRelief" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.16)"/><stop offset=".42" stop-color="rgba(255,255,255,0)"/><stop offset=".68" stop-color="rgba(20,42,26,.12)"/><stop offset="1" stop-color="rgba(0,0,0,.22)"/></linearGradient><pattern id="terrainHatch" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)"><path d="M0 0 L0 18" stroke="rgba(255,255,255,.10)" stroke-width="1"/></pattern></defs><rect width="100%" height="100%" fill="#10130f"/><g>'+source+'</g><rect width="100%" height="100%" fill="url(#terrainRelief)" opacity=".42"/>'+terrainGroups+'<rect width="100%" height="100%" fill="rgba(44,67,42,.10)"/><rect width="100%" height="100%" fill="url(#terrainHatch)" opacity=".18"/></svg>';
    return {dataUrl:dataUrl("image/svg+xml",svg),width:dims.width,height:dims.height,bounds:bounds,sourceCaptureIds:sourceCaptureIds,metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:role,stage:stage,terrainSource:terrainSource,inputRole:asset&&asset.metadata&&asset.metadata.role||"",inputStage:asset&&asset.metadata&&asset.metadata.stage||"",outputDimensions:dims},meta)};
  }
  function terrainViewSvg(record,terrainCaptures,meta){
    record=record||{};
    var base=record.previewVisual&&record.previewVisual.dataUrl?record.previewVisual:record.rawMaster&&record.rawMaster.dataUrl?record.rawMaster:record.basicVisual&&record.basicVisual.dataUrl?Object.assign({},record.basicVisual,{width:record.rawMaster&&record.rawMaster.width,height:record.rawMaster&&record.rawMaster.height,bounds:record.rawMaster&&record.rawMaster.bounds,metadata:Object.assign({},record.basicVisual&&record.basicVisual.metadata||{},{role:"basic"})}):null;
    if(!base)return null;
    return terrainShadeAsset(base,terrainCaptures,Object.assign({role:"terrain-view",stage:"terrain-shading",product:"course-overview",bounds:record.rawMaster&&record.rawMaster.bounds||record.input&&record.input.courseBounds||base.bounds||null},meta||{}));
  }
  function beta3dViewSvg(captures,meta){
    var valid=(Array.isArray(captures)?captures:[]).filter(renderableCapture).sort(function(a,b){
      var ah=Number(a.holeNumber)||999,bh=Number(b.holeNumber)||999;
      if(ah!==bh)return ah-bh;
      return String(a.id||"").localeCompare(String(b.id||""));
    });
    if(!valid.length)return null;
    var capture=valid[0];
    var sourceWidth=Math.max(1,Math.round(Number(capture.width)||1));
    var sourceHeight=Math.max(1,Math.round(Number(capture.height)||1));
    var width=Math.max(720,Math.round(sourceWidth*.92));
    var height=Math.max(520,Math.round(sourceHeight*.72));
    var captureTilt=finite(capture.captureTiltDeg);
    if(captureTilt==null)captureTilt=8;
    var playTilt=finite(capture.playTiltDeg);
    if(playTilt==null)playTilt=14;
    var topY=Math.round(height*.11);
    var bottomY=Math.round(height*.90);
    var topInset=Math.round(width*(.18+Math.min(20,Math.max(0,captureTilt))*.0035));
    var bottomInset=Math.round(width*.045);
    var imgX=bottomInset;
    var imgY=topY;
    var imgW=width-bottomInset*2;
    var imgH=bottomY-topY;
    var content=captureContentSvg(capture);
    var labelText="3D view beta H"+(capture.holeNumber||"?")+" · capture tilt "+captureTilt+" · play tilt "+playTilt;
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="3d-view-beta"><defs><clipPath id="tiltClip"><polygon points="'+topInset+','+topY+' '+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+bottomInset+','+bottomY+'"/></clipPath><linearGradient id="depthShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.16)"/><stop offset=".56" stop-color="rgba(255,255,255,0)"/><stop offset="1" stop-color="rgba(0,0,0,.24)"/></linearGradient></defs><rect width="100%" height="100%" fill="#10130f"/><polygon points="'+topInset+','+topY+' '+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+bottomInset+','+bottomY+'" fill="#182016" stroke="rgba(255,255,255,.28)" stroke-width="2"/><g clip-path="url(#tiltClip)"><g transform="translate('+imgX+" "+imgY+') scale('+svgNum(imgW/sourceWidth)+" "+svgNum(imgH/sourceHeight)+')">'+content+'</g><rect x="'+imgX+'" y="'+imgY+'" width="'+imgW+'" height="'+imgH+'" fill="url(#depthShade)"/></g><g transform="translate(14 14)"><rect x="0" y="0" width="'+svgNum(Math.max(350,labelText.length*7.2))+'" height="31" rx="6" fill="rgba(0,0,0,.64)"/><text x="10" y="21" font-size="14" fill="#fff" font-family="system-ui, sans-serif" font-weight="900">'+escapeXml(labelText)+'</text></g><text x="16" y="'+(height-18)+'" font-size="12" fill="rgba(255,255,255,.72)" font-family="system-ui, sans-serif" font-weight="850">Beta faux-tilt preview until native pitch/tilt capture is enabled</text></svg>';
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,bounds:captureBounds(capture),sourceCaptureIds:[capture.id],metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:"3d-view-beta",stage:"3d-view-beta",captureTiltDeg:captureTilt,playTiltDeg:playTilt,nativePitchAvailable:false,outputDimensions:{width:width,height:height}},meta||{})};
  }
  function buildCourseVisualMaster(courseId,opts){
    opts=opts||{};
    courseId=slug(courseId);
    if(inFlightBuilds[courseId])return inFlightBuilds[courseId];
    var promise=Promise.resolve().then(function(){
      var record=getRecord(courseId);
      var allCaptures=(Array.isArray(opts.captures)&&opts.captures.length?opts.captures:null)||transientCapturesByCourse[courseId]||capturesFromRecordRefs(record);
      var split=splitVisualCaptures(allCaptures);
      var captures=split.imagery;
      var capturePlan=Array.isArray(opts.capturePlan)?opts.capturePlan:(record.diagnostics&&record.diagnostics.capturePlan||[]);
      var capturePlanMeta=planSummary(capturePlan,split.all||[]);
      var beta3dExpected=!!split.beta3d.length;
      record.status="stitching";
      recordEvent(record,"course-visual-stitch-started",{captureCount:(captures||[]).length,terrainReferenceCount:split.terrain.length,beta3dCaptureCount:split.beta3d.length});
      putRecord(record);
      var signature=captureSignature(captures||[]);
      var existingRenderer=record.rawMaster&&record.rawMaster.metadata&&record.rawMaster.metadata.rendererVersion;
      var existingAssetReady=!!(record.basicVisual&&(record.basicVisual.dataUrl||transientAssetDataByPath[record.basicVisual.path])||record.rawMaster&&(record.rawMaster.dataUrl||transientAssetDataByPath[record.rawMaster.path]));
      var existingExampleReady=!!(record.exampleHoleVisual&&(record.exampleHoleVisual.dataUrl||transientAssetDataByPath[record.exampleHoleVisual.path]));
      var terrainExpected=!!split.terrain.length;
      var existingTerrainReady=!terrainExpected||!!(record.terrainView&&(record.terrainView.dataUrl||transientAssetDataByPath[record.terrainView.path]));
      var existingBeta3dReady=!beta3dExpected||!!(record.beta3dView&&(record.beta3dView.dataUrl||transientAssetDataByPath[record.beta3dView.path]));
      if(record.rawMaster&&record.rawMaster.captureSignature===signature&&existingRenderer===RENDERER_VERSION&&record.basicVisual&&existingAssetReady&&existingExampleReady&&existingTerrainReady&&existingBeta3dReady){
        record.status=record.publishedVisual?"published":"basic-ready";
        recordEvent(record,"course-visual-basic-ready",{idempotent:true,version:record.currentVersion});
        return putRecord(record);
      }
      var example=exampleHoleSvg(captures||[],{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
      if(example){
        record.exampleHoleVisual={path:"course-visuals/"+courseId+"/example/"+(example.captureId||"hole")+".svg",dataUrl:example.dataUrl,width:example.width,height:example.height,bounds:example.bounds,captureId:example.captureId,holeNumber:example.holeNumber,metadata:example.metadata};
      }
      try{
        var stitched=stitchSvg(captures||[],{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
        var version=(Number(record.currentVersion)||0)+1;
        var visualId=stableId("visual");
        record.rawMaster={path:"course-visuals/"+courseId+"/raw/"+visualId+".svg",dataUrl:stitched.dataUrl,bounds:stitched.bounds,width:stitched.width,height:stitched.height,captureSignature:signature,metadata:stitched.metadata};
        record.basicVisual={path:"course-visuals/"+courseId+"/basic/"+version+".svg",dataUrl:stitched.dataUrl,version:version};
        record.previewVisual=null;
        record.singleHolePreviewVisual=null;
        record.singleHoleTerrainView=null;
        var terrain=terrainViewSvg(record,split.terrain,{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
        if(terrain){
          record.terrainView={path:"course-visuals/"+courseId+"/terrain/"+version+".svg",dataUrl:terrain.dataUrl,version:version,width:terrain.width,height:terrain.height,bounds:terrain.bounds,sourceCaptureIds:terrain.sourceCaptureIds,metadata:terrain.metadata};
        }
        var beta3d=beta3dViewSvg(split.beta3d,{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
        if(beta3d){
          record.beta3dView={path:"course-visuals/"+courseId+"/3d-beta/"+version+".svg",dataUrl:beta3d.dataUrl,version:version,width:beta3d.width,height:beta3d.height,bounds:beta3d.bounds,sourceCaptureIds:beta3d.sourceCaptureIds,metadata:beta3d.metadata};
        }
        record.currentVersion=version;
        record.status="basic-ready";
        record.lastError=null;
        record.diagnostics=Object.assign({},record.diagnostics||{},{capturePlanSummary:capturePlanMeta,stitchOutputDimensions:{width:stitched.width,height:stitched.height},terrainView:record.terrainView?{path:record.terrainView.path,sourceCaptureIds:record.terrainView.sourceCaptureIds,width:record.terrainView.width,height:record.terrainView.height}:{status:split.terrain.length?"failed":"missing-terrain-reference"},beta3dView:record.beta3dView?{path:record.beta3dView.path,sourceCaptureIds:record.beta3dView.sourceCaptureIds,width:record.beta3dView.width,height:record.beta3dView.height,metadata:record.beta3dView.metadata}:{status:beta3dExpected?"failed":"off"},missingCoverage:stitched.missingAreas,sourceCaptureIds:stitched.sourceCaptureIds,exampleHole:record.exampleHoleVisual?{captureId:record.exampleHoleVisual.captureId,holeNumber:record.exampleHoleVisual.holeNumber,width:record.exampleHoleVisual.width,height:record.exampleHoleVisual.height}:null});
        record.versions=(record.versions||[]).concat([{version:version,type:"basic",rawMasterPath:record.rawMaster.path,basicImagePath:record.basicVisual.path,terrainViewPath:record.terrainView&&record.terrainView.path||null,beta3dViewPath:record.beta3dView&&record.beta3dView.path||null,sourceCaptureIds:stitched.sourceCaptureIds,createdAt:now(),metadata:stitched.metadata}]);
        recordEvent(record,"course-visual-basic-ready",{version:version,width:stitched.width,height:stitched.height,missingAreas:stitched.missingAreas.length,terrainView:!!record.terrainView,beta3dView:!!record.beta3dView});
      }catch(error){
        record.status="failed";
        record.lastError={code:error&&error.code||"stitch-failed",message:error&&error.message||String(error)};
        record.diagnostics=Object.assign({},record.diagnostics||{},{stitchFailure:record.lastError});
        recordEvent(record,"course-visual-build-failed",record.lastError);
      }
      return putRecord(record);
    });
    inFlightBuilds[courseId]=promise.finally(function(){delete inFlightBuilds[courseId];});
    return inFlightBuilds[courseId];
  }
  function filterForSettings(settings){
    var turf=settings&&settings.turf||{};
    var lighting=settings&&settings.lighting||{};
    var readability=settings&&settings.readability||{};
    var saturation=1+(Number(turf.greenStrength)||0)*.22;
    var brightness=1+((Number(lighting.brightnessTarget)||52)-52)/140;
    var contrast=Number(lighting.contrastTarget)||1;
    var sharp=Number(readability.sharpness)||0;
    return {saturation:+saturation.toFixed(3),brightness:+brightness.toFixed(3),contrast:+contrast.toFixed(3),sharpness:+sharp.toFixed(3)};
  }
  function previewSvg(record,settings,version){
    var base=record.rawMaster&&record.rawMaster.dataUrl?record.rawMaster:record.basicVisual&&record.basicVisual.dataUrl?Object.assign({},record.basicVisual,{width:record.rawMaster&&record.rawMaster.width,height:record.rawMaster&&record.rawMaster.height,bounds:record.rawMaster&&record.rawMaster.bounds}):null;
    if(!base)throw Object.assign(new Error("Raw master is not available"),{code:"raw-master-missing"});
    return nativeVisualAsset(base,settings,{role:"overview-native-visuals",stage:"native-visuals",version:version,product:"course-overview"}).dataUrl;
  }
  function saveCourseVisualSettings(courseId,overrides){
    var record=getRecord(courseId);
    record.courseOverrides=clone(overrides||{});
    record.settingsDirty=true;
    recordEvent(record,"course-visual-settings-saved",{published:false,overrideHash:hashString(record.courseOverrides)});
    return putRecord(record);
  }
  function buildCourseVisualPreview(courseId,presetOrId,overrides){
    return Promise.resolve().then(function(){
      var record=getRecord(courseId);
      var preset=typeof presetOrId==="string"?getPreset(presetOrId):(presetOrId||getPreset(record.presetId));
      var courseOverrides=overrides!==undefined?clone(overrides||{}):clone(record.courseOverrides||{});
      var settings=mergePreset(preset,courseOverrides);
      var allCaptures=transientCapturesByCourse[record.courseId]||capturesFromRecordRefs(record);
      var split=splitVisualCaptures(allCaptures);
      record.status="rendering";
      recordEvent(record,"course-visual-preview-started",{presetId:preset.id,presetVersion:preset.version});
      putRecord(record);
      try{
        var version=(Number(record.currentVersion)||0)+1;
        var overrideHash=hashString(courseOverrides);
        var overviewBase=record.rawMaster&&record.rawMaster.dataUrl?record.rawMaster:record.basicVisual&&record.basicVisual.dataUrl?Object.assign({},record.basicVisual,{width:record.rawMaster&&record.rawMaster.width,height:record.rawMaster&&record.rawMaster.height,bounds:record.rawMaster&&record.rawMaster.bounds}):null;
        if(!overviewBase)throw Object.assign(new Error("Raw master is not available"),{code:"raw-master-missing"});
        var overviewNative=nativeVisualAsset(overviewBase,settings,{role:"overview-native-visuals",stage:"native-visuals",version:version,product:"course-overview",presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
        record.previewVisual={path:"course-visuals/"+record.courseId+"/preview/"+version+".svg",dataUrl:overviewNative.dataUrl,version:version,width:overviewNative.width,height:overviewNative.height,bounds:overviewNative.bounds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:overviewNative.metadata};
        var overviewTerrain=terrainShadeAsset(record.previewVisual,split.terrain,{role:"terrain-view",stage:"terrain-shading",version:version,product:"course-overview",bounds:record.previewVisual.bounds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
        if(overviewTerrain){
          record.terrainView={path:"course-visuals/"+record.courseId+"/terrain/"+version+".svg",dataUrl:overviewTerrain.dataUrl,version:version,width:overviewTerrain.width,height:overviewTerrain.height,bounds:overviewTerrain.bounds,sourceCaptureIds:overviewTerrain.sourceCaptureIds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:overviewTerrain.metadata};
        }
        if(record.exampleHoleVisual&&record.exampleHoleVisual.dataUrl){
          var holeNative=nativeVisualAsset(record.exampleHoleVisual,settings,{role:"single-hole-native-visuals",stage:"native-visuals",version:version,product:"single-hole",presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
          record.singleHolePreviewVisual={path:"course-visuals/"+record.courseId+"/single-hole/preview/"+version+".svg",dataUrl:holeNative.dataUrl,version:version,width:holeNative.width,height:holeNative.height,bounds:holeNative.bounds,captureId:record.exampleHoleVisual.captureId,holeNumber:record.exampleHoleVisual.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:holeNative.metadata};
          var holeTerrain=terrainShadeAsset(record.singleHolePreviewVisual,split.terrain,{role:"single-hole-terrain",stage:"terrain-shading",version:version,product:"single-hole",bounds:record.singleHolePreviewVisual.bounds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
          if(holeTerrain){
            record.singleHoleTerrainView={path:"course-visuals/"+record.courseId+"/single-hole/terrain/"+version+".svg",dataUrl:holeTerrain.dataUrl,version:version,width:holeTerrain.width,height:holeTerrain.height,bounds:holeTerrain.bounds,sourceCaptureIds:holeTerrain.sourceCaptureIds,captureId:record.exampleHoleVisual.captureId,holeNumber:record.exampleHoleVisual.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:holeTerrain.metadata};
          }
        }
        record.presetId=preset.id;
        record.presetVersion=preset.version;
        record.courseOverrides=courseOverrides;
        record.currentVersion=version;
        record.status="preview-ready";
        record.settingsDirty=false;
        record.lastError=null;
        record.diagnostics=Object.assign({},record.diagnostics||{},{preview:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml",outputDimensions:{width:record.previewVisual&&record.previewVisual.width,height:record.previewVisual&&record.previewVisual.height},presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,products:{overview:{native:!!record.previewVisual,terrain:!!record.terrainView},singleHole:{base:!!record.exampleHoleVisual,native:!!record.singleHolePreviewVisual,terrain:!!record.singleHoleTerrainView}}}});
        record.versions=(record.versions||[]).concat([{version:version,type:"preview",previewImagePath:record.previewVisual.path,terrainViewPath:record.terrainView&&record.terrainView.path||null,singleHolePreviewPath:record.singleHolePreviewVisual&&record.singleHolePreviewVisual.path||null,singleHoleTerrainPath:record.singleHoleTerrainView&&record.singleHoleTerrainView.path||null,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,createdAt:now(),metadata:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml",products:["course-overview","single-hole"],stages:["native-visuals","terrain-shading"]}}]);
        recordEvent(record,"course-visual-preview-ready",{version:version,presetId:preset.id,presetVersion:preset.version,overviewTerrain:!!record.terrainView,singleHoleTerrain:!!record.singleHoleTerrainView});
      }catch(error){
        record.status="failed";
        record.lastError={code:error&&error.code||"preview-failed",message:error&&error.message||String(error)};
        recordEvent(record,"course-visual-build-failed",record.lastError);
      }
      return putRecord(record);
    });
  }
  function publishCourseVisual(courseId,previewVersion){
    var record=getRecord(courseId);
    var preview=record.previewVisual;
    if(previewVersion&&preview&&Number(preview.version)!==Number(previewVersion)){
      var found=(record.versions||[]).filter(function(version){return version.type==="preview"&&Number(version.version)===Number(previewVersion);})[0];
      if(!found){record.status="failed";record.lastError={code:"preview-version-missing",message:"The requested preview version is not available."};recordEvent(record,"course-visual-publish-failed",record.lastError);return putRecord(record);}
    }
    if(!preview){record.status="failed";record.lastError={code:"preview-missing",message:"Build a preview before publishing a styled course visual."};recordEvent(record,"course-visual-publish-failed",record.lastError);return putRecord(record);}
    var version=Number(preview.version)||((Number(record.currentVersion)||0)+1);
    var overviewFinal=record.terrainView&&Number(record.terrainView.version)===version?record.terrainView:record.terrainView||preview;
    var singleHoleFinal=record.singleHoleTerrainView&&Number(record.singleHoleTerrainView.version)===version?record.singleHoleTerrainView:record.singleHoleTerrainView||record.singleHolePreviewVisual||record.exampleHoleVisual;
    record.publishedVisual={path:"course-visuals/"+record.courseId+"/published/"+version+".svg",dataUrl:overviewFinal.dataUrl,version:version,width:overviewFinal.width,height:overviewFinal.height,bounds:overviewFinal.bounds,presetId:preview.presetId,presetVersion:preview.presetVersion,overrideHash:preview.overrideHash,publishedAt:now(),metadata:Object.assign({},overviewFinal.metadata||{},{role:"published",publishedFrom:overviewFinal.metadata&&overviewFinal.metadata.role||"preview"})};
    if(singleHoleFinal&&singleHoleFinal.dataUrl){
      record.singleHolePublishedVisual={path:"course-visuals/"+record.courseId+"/single-hole/published/"+version+".svg",dataUrl:singleHoleFinal.dataUrl,version:version,width:singleHoleFinal.width,height:singleHoleFinal.height,bounds:singleHoleFinal.bounds,captureId:singleHoleFinal.captureId||record.exampleHoleVisual&&record.exampleHoleVisual.captureId,holeNumber:singleHoleFinal.holeNumber||record.exampleHoleVisual&&record.exampleHoleVisual.holeNumber,presetId:preview.presetId,presetVersion:preview.presetVersion,overrideHash:preview.overrideHash,publishedAt:record.publishedVisual.publishedAt,metadata:Object.assign({},singleHoleFinal.metadata||{},{role:"single-hole-published",publishedFrom:singleHoleFinal.metadata&&singleHoleFinal.metadata.role||"single-hole-preview"})};
    }
    record.publishedVersion=version;
    record.status="published";
    record.lastError=null;
    record.versions=(record.versions||[]).concat([{version:version,type:"published",publishedImagePath:record.publishedVisual.path,singleHolePublishedPath:record.singleHolePublishedVisual&&record.singleHolePublishedVisual.path||null,presetId:preview.presetId,presetVersion:preview.presetVersion,overrideHash:preview.overrideHash,createdAt:record.publishedVisual.publishedAt,metadata:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml",publishedProducts:["course-overview","single-hole"],publishedStages:["terrain-shading","native-visuals"]}}]);
    recordEvent(record,"course-visual-published",{version:version,presetId:preview.presetId,presetVersion:preview.presetVersion,overviewStage:overviewFinal&&overviewFinal.metadata&&overviewFinal.metadata.stage||"",singleHoleStage:singleHoleFinal&&singleHoleFinal.metadata&&singleHoleFinal.metadata.stage||""});
    return putRecord(record);
  }
  function revertToPublishedVersion(courseId,version){
    var record=getRecord(courseId);
    var found=(record.versions||[]).slice().reverse().filter(function(item){return item.type==="published"&&(!version||Number(item.version)===Number(version));})[0];
    if(!found||!record.publishedVisual){record.lastError={code:"published-version-missing",message:"No previous published visual is available."};return putRecord(record);}
    record.status="published";
    record.publishedVersion=found.version;
    recordEvent(record,"course-visual-published",{version:found.version,reverted:true});
    return putRecord(record);
  }
  function resetToPublished(courseId){
    var record=getRecord(courseId);
    record.previewVisual=null;
    record.terrainView=null;
    record.singleHolePreviewVisual=null;
    record.singleHoleTerrainView=null;
    record.settingsDirty=false;
    record.courseOverrides={};
    record.status=record.publishedVisual?"published":record.basicVisual?"basic-ready":"unavailable";
    recordEvent(record,"course-visual-settings-saved",{reset:"published"});
    return putRecord(record);
  }
  function resetToGlobalPreset(courseId,presetId){
    var record=getRecord(courseId);
    var preset=getPreset(presetId||defaultPreset().id);
    record.presetId=preset.id;
    record.presetVersion=preset.version;
    record.courseOverrides={};
    record.settingsDirty=true;
    recordEvent(record,"course-visual-settings-saved",{reset:"global-preset",presetId:preset.id,presetVersion:preset.version});
    return putRecord(record);
  }
  function resolveCourseVisual(courseId){
    var record=getRecord(courseId);
    if(!record.publishedVisual)return null;
    return {
      courseId:record.courseId,
      status:"published",
      rawMaster:record.rawMaster?{path:record.rawMaster.path,bounds:record.rawMaster.bounds,width:record.rawMaster.width,height:record.rawMaster.height}:undefined,
      basicVisual:record.basicVisual?{path:record.basicVisual.path,dataUrl:record.basicVisual.dataUrl,version:record.basicVisual.version}:undefined,
      terrainView:record.terrainView?{path:record.terrainView.path,dataUrl:record.terrainView.dataUrl,version:record.terrainView.version}:undefined,
      exampleHoleVisual:record.exampleHoleVisual?{path:record.exampleHoleVisual.path,dataUrl:record.exampleHoleVisual.dataUrl,holeNumber:record.exampleHoleVisual.holeNumber}:undefined,
      singleHolePreviewVisual:record.singleHolePreviewVisual?{path:record.singleHolePreviewVisual.path,dataUrl:record.singleHolePreviewVisual.dataUrl,version:record.singleHolePreviewVisual.version,presetId:record.singleHolePreviewVisual.presetId,presetVersion:record.singleHolePreviewVisual.presetVersion,holeNumber:record.singleHolePreviewVisual.holeNumber}:undefined,
      singleHoleTerrainView:record.singleHoleTerrainView?{path:record.singleHoleTerrainView.path,dataUrl:record.singleHoleTerrainView.dataUrl,version:record.singleHoleTerrainView.version,presetId:record.singleHoleTerrainView.presetId,presetVersion:record.singleHoleTerrainView.presetVersion,holeNumber:record.singleHoleTerrainView.holeNumber}:undefined,
      previewVisual:record.previewVisual?{path:record.previewVisual.path,dataUrl:record.previewVisual.dataUrl,version:record.previewVisual.version,presetId:record.previewVisual.presetId,presetVersion:record.previewVisual.presetVersion}:undefined,
      publishedVisual:record.publishedVisual?{path:record.publishedVisual.path,dataUrl:record.publishedVisual.dataUrl,version:record.publishedVisual.version,presetId:record.publishedVisual.presetId,presetVersion:record.publishedVisual.presetVersion}:undefined,
      singleHolePublishedVisual:record.singleHolePublishedVisual?{path:record.singleHolePublishedVisual.path,dataUrl:record.singleHolePublishedVisual.dataUrl,version:record.singleHolePublishedVisual.version,presetId:record.singleHolePublishedVisual.presetId,presetVersion:record.singleHolePublishedVisual.presetVersion,holeNumber:record.singleHolePublishedVisual.holeNumber}:undefined,
      error:record.lastError||undefined
    };
  }
  function outputForRecord(record){
    record=record||{};
    return {
      courseId:record.courseId,
      status:record.status==="published"?"published":record.previewVisual?"preview-ready":record.basicVisual?"basic-ready":record.status==="failed"?"failed":"unavailable",
      rawMaster:record.rawMaster?{path:record.rawMaster.path,bounds:record.rawMaster.bounds,width:record.rawMaster.width,height:record.rawMaster.height}:undefined,
      basicVisual:record.basicVisual?{path:record.basicVisual.path,version:record.basicVisual.version}:undefined,
      terrainView:record.terrainView?{path:record.terrainView.path,version:record.terrainView.version}:undefined,
      exampleHoleVisual:record.exampleHoleVisual?{path:record.exampleHoleVisual.path,holeNumber:record.exampleHoleVisual.holeNumber}:undefined,
      singleHolePreviewVisual:record.singleHolePreviewVisual?{path:record.singleHolePreviewVisual.path,version:record.singleHolePreviewVisual.version,presetId:record.singleHolePreviewVisual.presetId,presetVersion:record.singleHolePreviewVisual.presetVersion,holeNumber:record.singleHolePreviewVisual.holeNumber}:undefined,
      singleHoleTerrainView:record.singleHoleTerrainView?{path:record.singleHoleTerrainView.path,version:record.singleHoleTerrainView.version,presetId:record.singleHoleTerrainView.presetId,presetVersion:record.singleHoleTerrainView.presetVersion,holeNumber:record.singleHoleTerrainView.holeNumber}:undefined,
      previewVisual:record.previewVisual?{path:record.previewVisual.path,version:record.previewVisual.version,presetId:record.previewVisual.presetId,presetVersion:record.previewVisual.presetVersion}:undefined,
      publishedVisual:record.publishedVisual?{path:record.publishedVisual.path,version:record.publishedVisual.version,presetId:record.publishedVisual.presetId,presetVersion:record.publishedVisual.presetVersion}:undefined,
      singleHolePublishedVisual:record.singleHolePublishedVisual?{path:record.singleHolePublishedVisual.path,version:record.singleHolePublishedVisual.version,presetId:record.singleHolePublishedVisual.presetId,presetVersion:record.singleHolePublishedVisual.presetVersion,holeNumber:record.singleHolePublishedVisual.holeNumber}:undefined,
      error:record.lastError||undefined
    };
  }
  function queueCloudSync(record,reason){
    if(!root||typeof root.fetch!=="function"||!record||record.__syncing)return;
    var actor=safe(function(){
      var api=root.GolfDaddyAccounts||root.ClarityCaddieAccounts;
      var current=api&&typeof api.current==="function"?api.current():null;
      return {role:current&&current.role||"",email:current&&current.email||"",accountId:current&&current.accountId||""};
    },{});
    if(String(actor.role||"").toLowerCase()!=="admin")return;
    var body={action:"upsert",reason:reason||"local",actor:actor,visual:metadataForCloud(record)};
    setTimeout(function(){
      safe(function(){root.fetch(API_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(body)}).catch(function(){});});
    },20);
  }
  function metadataForCloud(record){
    var assets=[
      record.rawMaster&&record.rawMaster.dataUrl?{path:record.rawMaster.path,dataUrl:record.rawMaster.dataUrl,contentType:"image/svg+xml",role:"raw-master"}:null,
      record.basicVisual&&record.basicVisual.dataUrl?{path:record.basicVisual.path,dataUrl:record.basicVisual.dataUrl,contentType:"image/svg+xml",role:"basic"}:null,
      record.exampleHoleVisual&&record.exampleHoleVisual.dataUrl?{path:record.exampleHoleVisual.path,dataUrl:record.exampleHoleVisual.dataUrl,contentType:"image/svg+xml",role:"example-hole"}:null,
      record.previewVisual&&record.previewVisual.dataUrl?{path:record.previewVisual.path,dataUrl:record.previewVisual.dataUrl,contentType:"image/svg+xml",role:"preview"}:null,
      record.terrainView&&record.terrainView.dataUrl?{path:record.terrainView.path,dataUrl:record.terrainView.dataUrl,contentType:"image/svg+xml",role:"terrain-view"}:null,
      record.singleHolePreviewVisual&&record.singleHolePreviewVisual.dataUrl?{path:record.singleHolePreviewVisual.path,dataUrl:record.singleHolePreviewVisual.dataUrl,contentType:"image/svg+xml",role:"single-hole-preview"}:null,
      record.singleHoleTerrainView&&record.singleHoleTerrainView.dataUrl?{path:record.singleHoleTerrainView.path,dataUrl:record.singleHoleTerrainView.dataUrl,contentType:"image/svg+xml",role:"single-hole-terrain"}:null,
      record.publishedVisual&&record.publishedVisual.dataUrl?{path:record.publishedVisual.path,dataUrl:record.publishedVisual.dataUrl,contentType:"image/svg+xml",role:"published"}:null,
      record.singleHolePublishedVisual&&record.singleHolePublishedVisual.dataUrl?{path:record.singleHolePublishedVisual.path,dataUrl:record.singleHolePublishedVisual.dataUrl,contentType:"image/svg+xml",role:"single-hole-published"}:null
    ].filter(Boolean);
    return {
      id:record.id,
      course_id:record.courseId,
      status:record.status,
      raw_master_path:record.rawMaster&&record.rawMaster.path||null,
      basic_image_path:record.basicVisual&&record.basicVisual.path||null,
      preview_image_path:record.previewVisual&&record.previewVisual.path||null,
      published_image_path:record.publishedVisual&&record.publishedVisual.path||null,
      course_bounds:record.input&&record.input.courseBounds||record.rawMaster&&record.rawMaster.bounds||null,
      source_capture_ids:record.input&&record.input.sourceCaptureIds||[],
      preset_id:record.presetId,
      preset_version:record.presetVersion,
      course_overrides:record.courseOverrides||{},
      current_version:record.currentVersion||0,
      published_version:record.publishedVersion||0,
      last_error:record.lastError||null,
      diagnostics:record.diagnostics||{},
      versions:record.versions||[],
      assets:assets,
      updated_at:record.updatedAt||now()
    };
  }
  function restoreCloudMetadata(row){
    if(!row)return null;
    var record=getRecord(row.course_id||row.courseId);
    record.status=row.status||record.status;
    record.presetId=row.preset_id||record.presetId;
    record.presetVersion=Number(row.preset_version)||record.presetVersion;
    record.courseOverrides=row.course_overrides||record.courseOverrides||{};
    record.currentVersion=Number(row.current_version)||record.currentVersion||0;
    record.publishedVersion=Number(row.published_version)||record.publishedVersion||0;
    record.lastError=row.last_error||record.lastError||null;
    record.diagnostics=row.diagnostics||record.diagnostics||{};
    record.versions=Array.isArray(row.versions)?row.versions:record.versions||[];
    var assets=Array.isArray(row.assets)?row.assets:[];
    function assetForRole(role){return assets.filter(function(asset){return asset&&asset.role===role&&asset.path;})[0]||null;}
    if(row.raw_master_path&&!record.rawMaster)record.rawMaster={path:row.raw_master_path,bounds:row.course_bounds||null,width:0,height:0};
    if(row.basic_image_path&&!record.basicVisual)record.basicVisual={path:row.basic_image_path,version:record.currentVersion||1};
    if(row.preview_image_path&&!record.previewVisual)record.previewVisual={path:row.preview_image_path,version:record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    if(row.published_image_path&&!record.publishedVisual)record.publishedVisual={path:row.published_image_path,version:record.publishedVersion||record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    var exampleAsset=assetForRole("example-hole");
    var terrainAsset=assetForRole("terrain-view");
    var singlePreviewAsset=assetForRole("single-hole-preview");
    var singleTerrainAsset=assetForRole("single-hole-terrain");
    var singlePublishedAsset=assetForRole("single-hole-published");
    if(exampleAsset&&!record.exampleHoleVisual)record.exampleHoleVisual={path:exampleAsset.path,dataUrl:exampleAsset.dataUrl,width:0,height:0};
    if(terrainAsset&&!record.terrainView)record.terrainView={path:terrainAsset.path,dataUrl:terrainAsset.dataUrl,version:record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    if(singlePreviewAsset&&!record.singleHolePreviewVisual)record.singleHolePreviewVisual={path:singlePreviewAsset.path,dataUrl:singlePreviewAsset.dataUrl,version:record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    if(singleTerrainAsset&&!record.singleHoleTerrainView)record.singleHoleTerrainView={path:singleTerrainAsset.path,dataUrl:singleTerrainAsset.dataUrl,version:record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    if(singlePublishedAsset&&!record.singleHolePublishedVisual)record.singleHolePublishedVisual={path:singlePublishedAsset.path,dataUrl:singlePublishedAsset.dataUrl,version:record.publishedVersion||record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    return putRecord(record);
  }
  function pullCourseVisual(courseId){
    if(!root||typeof root.fetch!=="function")return Promise.resolve(getRecord(courseId));
    return root.fetch(API_ENDPOINT+"?courseId="+encodeURIComponent(slug(courseId)),{headers:{Accept:"application/json"},cache:"no-store"}).then(function(res){return res.ok?res.json():null;}).then(function(data){
      var row=data&&data.visual||null;
      return row?restoreCloudMetadata(row):getRecord(courseId);
    }).catch(function(){return getRecord(courseId);});
  }
  function executeVisualCapturePlan(input,plan){
    var executor=root&&root.gdBuildCourseVisualCaptureManifest;
    var errors=[];
    if(typeof executor!=="function"||!Array.isArray(plan)||!plan.length){
      return {executed:false,captures:input.captures||[],errors:errors,fallbackReason:typeof executor==="function"?"empty-plan":"capture-executor-missing"};
    }
    var captures=[];
    plan.forEach(function(item){
      try{
        var manifest=executor(item);
        var capture=manifestToCapture(manifest,item);
        if(capture&&capture.width&&capture.height&&captureBounds(capture)&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData))captures.push(capture);
        else errors.push({planId:item&&item.id,role:item&&item.role,holeNumber:item&&item.holeNumber,code:"capture-empty"});
      }catch(error){
        errors.push({planId:item&&item.id,role:item&&item.role,holeNumber:item&&item.holeNumber,code:"capture-failed",message:error&&error.message||String(error)});
      }
    });
    return {executed:true,captures:captures.length?captures:(input.captures||[]),errors:errors,fallbackReason:captures.length?"":"planned-captures-empty"};
  }
  function buildFromCourseDatabase(courseId,opts){
    opts=opts||{};
    var api=root&&root.GDCoursePlayPipeline;
    var payload=api&&typeof api.buildCoursePlayDbPayload==="function"?api.buildCoursePlayDbPayload(courseId):null;
    var frameRows=api&&typeof api.getCoursePlayFrameIndex==="function"?api.getCoursePlayFrameIndex(courseId):[];
    var input=adaptCoursePlayPayloadToVisualInput(payload,{courseId:courseId,frameRows:frameRows,readManifest:function(key){return readJson(key,null);}});
    var previous=getRecord(input.courseId||courseId);
    var saved3d=!!(previous&&previous.courseOverrides&&previous.courseOverrides.visualEngine&&previous.courseOverrides.visualEngine.enable3dBeta);
    var enable3dBeta=opts.enable3dBeta===true||saved3d;
    var plan=planCourseVisualCaptures(input,{enable3dBeta:enable3dBeta});
    var planned=executeVisualCapturePlan(input,plan);
    input=Object.assign({},input,{captures:planned.captures,capturePlan:plan});
    var record=ingestCourseVisualInput(input);
    record.diagnostics=Object.assign({},record.diagnostics||{},{stageSettings:{enable3dBeta:enable3dBeta},capturePlan:input.capturePlan,capturePlanSummary:planSummary(plan,planned.captures),captureExecution:{attempted:planned.executed,captured:planned.captures.length,errors:planned.errors,fallbackReason:planned.fallbackReason||""}});
    putRecord(record);
    return buildCourseVisualMaster(input.courseId,{captures:input.captures,capturePlan:plan});
  }
  return {
    version:VERSION,
    rendererVersion:RENDERER_VERSION,
    storeKey:STORE_KEY,
    presetKey:PRESET_KEY,
    apiEndpoint:API_ENDPOINT,
    defaultPreset:defaultPreset,
    presetForMode:presetForMode,
    courseVisualPresetList:courseVisualPresetList,
    loadPresets:loadPresets,
    getPreset:getPreset,
    mergePreset:mergePreset,
    adaptCoursePlayPayloadToVisualInput:adaptCoursePlayPayloadToVisualInput,
    planCourseVisualCaptures:planCourseVisualCaptures,
    manifestToCapture:manifestToCapture,
    ingestCourseVisualInput:ingestCourseVisualInput,
    buildCourseVisualMaster:buildCourseVisualMaster,
    buildCourseVisualPreview:buildCourseVisualPreview,
    saveCourseVisualSettings:saveCourseVisualSettings,
    publishCourseVisual:publishCourseVisual,
    revertToPublishedVersion:revertToPublishedVersion,
    resetToPublished:resetToPublished,
    resetToGlobalPreset:resetToGlobalPreset,
    resolveCourseVisual:resolveCourseVisual,
    outputForRecord:outputForRecord,
    getRecord:getRecord,
    loadStore:loadStore,
    saveStore:saveStore,
    pullCourseVisual:pullCourseVisual,
    buildFromCourseDatabase:buildFromCourseDatabase,
    hydrateCourseVisualAssets:hydrateCourseVisualAssets,
    __test:{emptyStore:emptyStore,stitchSvg:stitchSvg,hashString:hashString,captureSignature:captureSignature,metadataForCloud:metadataForCloud,loadAssetData:loadAssetData,saveAssetData:saveAssetData}
  };
});

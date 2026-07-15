(function(root,factory){
  if(typeof module==="object"&&module.exports)module.exports=factory();
  else root.GDCourseVisualEngine=factory(root);
})(typeof window!=="undefined"?window:globalThis,function(root){
  "use strict";
  root=root||typeof window!=="undefined"&&window||typeof globalThis!=="undefined"&&globalThis||{};

  var VERSION=1;
  var PRESET_VERSION=4;
  var RENDERER_VERSION="clarity-course-visual-renderer-v22";
  var STORE_KEY="gd_course_visual_engine_v1";
  var PRESET_KEY="gd_course_visual_presets_v1";
  var API_ENDPOINT="/api/course-visuals";
  var ASSET_DB_NAME="gd_course_visual_assets_v1";
  var ASSET_STORE_NAME="assets";
  var VALID_STATUSES={unavailable:1,"input-ready":1,stitching:1,"basic-ready":1,rendering:1,"preview-ready":1,published:1,failed:1};
  var inFlightBuilds={};
  var transientCapturesByCourse={};
  var transientAssetDataByPath={};
  var volatileStore=null;
  var assetDbPromise=null;

  function now(){return new Date().toISOString();}
  function safe(fn,fb){try{return fn();}catch(_error){return fb;}}
  function clone(value){return safe(function(){return JSON.parse(JSON.stringify(value));},value);}
  function slug(value){return String(value||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,140)||"course";}
  function stableId(prefix){return String(prefix||"cv")+"_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);}
  function stableIdStamp(id){
    var match=String(id||"").match(/_([a-z0-9]+)_/i);
    if(!match)return 0;
    var stamp=parseInt(match[1],36);
    return Number.isFinite(stamp)?stamp:0;
  }
  function text(value,limit){var out=String(value||"").trim();return limit&&out.length>limit?out.slice(0,limit):out;}
  function finite(value){var n=Number(value);return Number.isFinite(n)?n:null;}
  function point(value){
    if(!value)return null;
    var lat=finite(value.lat!==undefined?value.lat:value.latitude);
    var lng=finite(value.lng!==undefined?value.lng:(value.lon!==undefined?value.lon:value.longitude));
    return lat==null||lng==null?null:{lat:lat,lng:lng};
  }
  function points(list){return (Array.isArray(list)?list:[]).map(point).filter(Boolean);}
  function pixelPoints(list){
    return (Array.isArray(list)?list:[]).map(function(value){
      var x=finite(value&&value.x);
      var y=finite(value&&value.y);
      return x==null||y==null?null:{x:x,y:y};
    }).filter(Boolean);
  }
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
  function holeDataAnchorPins(holeData){
    if(!holeData)return {tee:null,green:null,route:[],greenShape:[]};
    var route=holeDataRoutePoints(holeData);
    var tee=point(holeData.tee&&holeData.tee.position||holeData.tee)||route[0]||null;
    var green=point(holeData.green&&holeData.green.position||holeData.green&&holeData.green.center||holeData.green)||route[route.length-1]||null;
    var shape=points(holeData.green&&holeData.green.greenShape||holeData.green&&holeData.green.shape||holeData.greenShape||holeData.shape);
    return {tee:tee,green:green,route:route,greenShape:shape};
  }
  function holeDataCaptureAnchorPins(holeData,role,extra){
    role=String(role||"");
    if(role!=="play-corridor"&&role!=="three-d-hole-beta")return null;
    var anchors=holeDataAnchorPins(holeData);
    var route=points(anchors.route);
    if(!route.length&&anchors.tee&&anchors.green)route=[anchors.tee,anchors.green];
    var segmentRoute=route;
    var start=finite(extra&&extra.segmentStartMeters);
    var end=finite(extra&&extra.segmentEndMeters);
    if(route.length>=2&&start!=null&&end!=null&&end>start)segmentRoute=routeSegmentPoints(route,start,end);
    if(!segmentRoute.length)segmentRoute=route;
    var count=Number(extra&&extra.segmentCount)||0;
    var index=Number(extra&&extra.segmentIndex)||0;
    var isLast=!count||!index||index>=count;
    return {
      tee:segmentRoute[0]||anchors.tee||null,
      green:segmentRoute[segmentRoute.length-1]||anchors.green||null,
      route:segmentRoute,
      greenShape:isLast?anchors.greenShape:[]
    };
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
    var mobileHoleLens={captureLens:"mobile-hole",lensShape:"mobile-hole",lensAspectRatio:9/16,lensOrientation:"play-axis",lensFit:"expand-bounds"};
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
    var anchors=holeDataAnchorPins(holeData);
    var capturePins=holeDataCaptureAnchorPins(holeData,policy.role,extra);
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
      anchorPins:anchors,
      captureAnchorPins:capturePins,
      includeAnchorPins:!!(capturePins&&capturePins.route&&capturePins.route.length),
      captureKey:[slug(courseId),holeNumber?"h"+holeNumber:"course",policy.role,segmentSuffix].filter(Boolean).join(":"),
      reason:"course-visual-"+policy.role+(capturePins?"-hole-axis":"-visual-lock")
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
  function tryWriteJson(key,value){
    if(!root||!root.localStorage)return true;
    try{
      root.localStorage.setItem(key,JSON.stringify(value));
      return true;
    }catch(_error){
      return false;
    }
  }
  function writeJson(key,value){
    tryWriteJson(key,value);
    return value;
  }
  function compactAssetMetadata(meta){
    if(!meta||typeof meta!=="object")return meta||null;
    var out={};
    Object.keys(meta).forEach(function(key){
      var value=meta[key];
      if(value==null||typeof value!=="object")out[key]=value;
    });
    ["outputDimensions","sourceDimensions","viewportFrame","displayTransform","objectProofOverlay","mapCameraCapability","anchorPins"].forEach(function(key){
      if(meta[key]&&typeof meta[key]==="object")out[key]=clone(meta[key]);
    });
    if(meta.playSurface&&typeof meta.playSurface==="object"){
      var play=meta.playSurface;
      out.playSurface={
        useGpsPlayFraming:play.useGpsPlayFraming===true,
        fallbackUnderlay:play.fallbackUnderlay||"",
        fallbackPolicy:play.fallbackPolicy||"",
        publishedOverviewPath:play.publishedOverviewPath||"",
        overflowVisible:play.overflowVisible===true,
        viewportFrame:play.viewportFrame?clone(play.viewportFrame):undefined,
        displayTransform:play.displayTransform?clone(play.displayTransform):undefined,
        objectProofOverlay:play.objectProofOverlay?clone(play.objectProofOverlay):undefined,
        anchorPins:play.anchorPins?clone(play.anchorPins):undefined
      };
    }
    return out;
  }
  function visualAssets(record){
    function list(value){return Array.isArray(value)?value:[];}
    var assets=[
      record&&record.rawMaster,
      record&&record.basicVisual,
      record&&record.exampleHoleVisual,
      list(record&&record.holeFrameVisuals),
      record&&record.previewVisual,
      record&&record.terrainView,
      record&&record.singleHolePreviewVisual,
      record&&record.singleHoleTerrainView,
      list(record&&record.holeFramePreviewVisuals),
      list(record&&record.holeFrameTerrainViews),
      record&&record.beta3dView,
      record&&record.publishedVisual,
      record&&record.singleHolePublishedVisual,
      list(record&&record.holeFramePublishedVisuals)
    ];
    return assets.reduce(function(out,item){
      if(Array.isArray(item))item.forEach(function(asset){if(asset)out.push(asset);});
      else if(item)out.push(item);
      return out;
    },[]);
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
    if(volatileStore&&volatileStore.records&&String(volatileStore.updatedAt||"")>=String(store&&store.updatedAt||"")){
      store=clone(volatileStore);
    }
    store.schema="gd.course_visual_engine.store";
    store.version=VERSION;
    store.rendererVersion=RENDERER_VERSION;
    store.records=store.records&&typeof store.records==="object"?store.records:{};
    return store;
  }
  function saveStore(store){
    store=store&&typeof store==="object"?store:emptyStore();
    store.updatedAt=now();
    volatileStore=clone(store);
    if(tryWriteJson(STORE_KEY,store))return store;
    var compact=clone(store)||emptyStore();
    Object.keys(compact.records||{}).forEach(function(courseId){
      var record=compact.records[courseId];
      if(!record||typeof record!=="object")return;
      record.versions=(Array.isArray(record.versions)?record.versions:[]).slice(-12);
      record.events=(Array.isArray(record.events)?record.events:[]).slice(-16);
      if(Array.isArray(record.captureRefs)&&record.captureRefs.length>84)record.captureRefs=record.captureRefs.slice(-84);
    });
    tryWriteJson(STORE_KEY,compact);
    return store;
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
      visualTools:{fairwayAirbrush:true,fairwayAirbrushStrength:.18,fairwayAirbrushWidthMeters:44,greenSurroundAirbrush:true,greenSurroundAirbrushStrength:.18,greenSurroundAirbrushWidthMeters:24,holeTerrainStrength:.75},
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
      presetSpec("clarity-course-fresh-v1","Fresh Fairway","Fresh","A bright fairway-first look with visibly greener turf and cleaner playing lines.",{
        turf:{greenStrength:.9,saturationMin:42,saturationMax:76},
        lighting:{brightnessTarget:62,contrastTarget:1.18},
        readability:{fairwaySeparation:.32,greenSeparation:.22,localContrast:.2,sharpness:.2},
        visualTools:{fairwayAirbrushStrength:.3,fairwayAirbrushWidthMeters:48,greenSurroundAirbrushStrength:.28,greenSurroundAirbrushWidthMeters:26,holeTerrainStrength:.85},
        mowingVisibility:"Clear"
      }),
      presetSpec("clarity-course-rich-v1","Rich Aerial","Rich","Deeper greens and stronger contrast for premium course thumbnails.",{
        turf:{greenStrength:1.25,saturationMin:50,saturationMax:84},
        lighting:{brightnessTarget:55,contrastTarget:1.28},
        readability:{fairwaySeparation:.34,greenSeparation:.3,localContrast:.24,sharpness:.24},
        visualTools:{fairwayAirbrushStrength:.36,fairwayAirbrushWidthMeters:50,greenSurroundAirbrushStrength:.34,greenSurroundAirbrushWidthMeters:28,holeTerrainStrength:.95},
        mowingVisibility:"Clear"
      }),
      presetSpec("clarity-course-strong-v1","Strong Clarity","Strong","A punchy decision-map style for small screens and busy imagery.",{
        turf:{greenStrength:1.55,saturationMin:56,saturationMax:90},
        lighting:{brightnessTarget:60,contrastTarget:1.45},
        readability:{fairwaySeparation:.44,greenSeparation:.38,localContrast:.34,sharpness:.34},
        visualTools:{fairwayAirbrushStrength:.44,fairwayAirbrushWidthMeters:54,greenSurroundAirbrushStrength:.42,greenSurroundAirbrushWidthMeters:30,holeTerrainStrength:1.05},
        mowingVisibility:"Prominent"
      }),
      presetSpec("clarity-course-green-detail-v1","Green Detail","Green Detail","Pushes greens and surrounds hard enough to expose detail choices.",{
        turf:{greenStrength:1.45,saturationMin:54,brightnessMin:34,brightnessMax:82},
        lighting:{brightnessTarget:58,contrastTarget:1.32},
        readability:{fairwaySeparation:.26,greenSeparation:.5,bunkerBrightness:.14,localContrast:.3,sharpness:.32},
        visualTools:{fairwayAirbrushStrength:.34,fairwayAirbrushWidthMeters:46,greenSurroundAirbrushStrength:.52,greenSurroundAirbrushWidthMeters:32,holeTerrainStrength:1.15},
        mowingVisibility:"Prominent"
      }),
      presetSpec("clarity-course-fairway-corridor-v1","Fairway Corridor","Fairway Corridor","A line-biased inspection look for fairways, hazards and landing areas.",{
        turf:{greenStrength:.95,saturationMin:42},
        lighting:{brightnessTarget:63,shadowFloor:20,contrastTarget:1.5},
        readability:{fairwaySeparation:.58,greenSeparation:.26,bunkerBrightness:.18,localContrast:.42,sharpness:.42},
        visualTools:{fairwayAirbrushStrength:.5,fairwayAirbrushWidthMeters:58,greenSurroundAirbrushStrength:.3,greenSurroundAirbrushWidthMeters:28,holeTerrainStrength:.8},
        mowingVisibility:"Prominent"
      }),
      presetSpec("clarity-course-terrain-relief-v1","Terrain Relief","Terrain Relief","Darker and higher contrast so terrain shading has something to bite into.",{
        turf:{greenStrength:.65,saturationMin:34},
        lighting:{brightnessTarget:45,shadowFloor:12,contrastTarget:1.55},
        readability:{fairwaySeparation:.34,greenSeparation:.24,bunkerBrightness:.06,localContrast:.46,sharpness:.28},
        visualTools:{fairwayAirbrushStrength:.26,fairwayAirbrushWidthMeters:48,greenSurroundAirbrushStrength:.26,greenSurroundAirbrushWidthMeters:28,holeTerrainStrength:1.35},
        mowingVisibility:"Clear"
      }),
      presetSpec("clarity-course-shade-rescue-v1","Shade Rescue","Shade Rescue","Lifts dark captures and tree-shadowed holes without losing line visibility.",{
        turf:{greenStrength:.85,saturationMin:40,brightnessMin:34},
        lighting:{brightnessTarget:78,shadowFloor:30,highlightCeiling:98,contrastTarget:1.15},
        readability:{fairwaySeparation:.3,greenSeparation:.26,bunkerBrightness:.2,localContrast:.2,sharpness:.18},
        visualTools:{fairwayAirbrushStrength:.38,fairwayAirbrushWidthMeters:52,greenSurroundAirbrushStrength:.34,greenSurroundAirbrushWidthMeters:30,holeTerrainStrength:.95},
        mowingVisibility:"Clear"
      }),
      presetSpec("clarity-course-broadcast-pop-v1","Broadcast Pop","Broadcast Pop","A bold demo look with saturated turf, heavy contrast and clear stripes.",{
        turf:{greenStrength:2.2,saturationMin:62,saturationMax:96},
        lighting:{brightnessTarget:68,shadowFloor:20,contrastTarget:1.7},
        readability:{fairwaySeparation:.54,greenSeparation:.48,bunkerBrightness:.2,localContrast:.5,sharpness:.5},
        visualTools:{fairwayAirbrushStrength:.56,fairwayAirbrushWidthMeters:60,greenSurroundAirbrushStrength:.54,greenSurroundAirbrushWidthMeters:34,holeTerrainStrength:1.25},
        mowingVisibility:"Prominent"
      }),
      presetSpec("clarity-course-acid-test-v1","Acid Test","Acid Test","An intentionally overcooked debug look for finding the edge of the visual model.",{
        turf:{greenStrength:3,saturationMin:72,saturationMax:100},
        lighting:{brightnessTarget:82,shadowFloor:28,contrastTarget:1.95},
        readability:{fairwaySeparation:.68,greenSeparation:.62,bunkerBrightness:.26,localContrast:.58,sharpness:.6},
        visualTools:{fairwayAirbrushStrength:.68,fairwayAirbrushWidthMeters:64,greenSurroundAirbrushStrength:.66,greenSurroundAirbrushWidthMeters:36,holeTerrainStrength:1.5},
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
    var cameraCapability=clone(manifest.mapCameraCapability||manifest.visualCapturePolicy&&manifest.visualCapturePolicy.cameraCapability||opts&&opts.mapCameraCapability||null);
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
      mapCameraCapability:cameraCapability,
      nativePitchAvailable:!!(manifest.nativePitchAvailable||cameraCapability&&cameraCapability.nativePitchAvailable),
      nativeBearingAvailable:!!(manifest.nativeBearingAvailable||cameraCapability&&cameraCapability.nativeBearingAvailable),
      anchorPins:clone(manifest.anchorPins||manifest.pins||opts&&opts.anchorPins||{}),
      captureAnchorPins:clone(manifest.captureAnchorPins||manifest.capturePins||opts&&opts.captureAnchorPins||{}),
      tileSourceLabel:text(manifest.tileSourceLabel||opts&&opts.tileSourceLabel,120),
      captureLens:text(manifest.captureLens||manifest.lensShape||opts&&opts.captureLens||opts&&opts.lensShape,80),
      lensShape:text(manifest.lensShape||manifest.captureLens||opts&&opts.lensShape||opts&&opts.captureLens,80),
      lensAspectRatio:finite(manifest.lensAspectRatio!==undefined?manifest.lensAspectRatio:manifest.lensAspect!==undefined?manifest.lensAspect:opts&&opts.lensAspectRatio!==undefined?opts.lensAspectRatio:opts&&opts.lensAspect),
      lensOrientation:text(manifest.lensOrientation||opts&&opts.lensOrientation,80),
      lensFit:text(manifest.lensFit||opts&&opts.lensFit,80),
      lensCornersPx:pixelPoints(manifest.lensCornersPx||opts&&opts.lensCornersPx),
      lensLocalCorners:pixelPoints(manifest.lensLocalCorners||opts&&opts.lensLocalCorners),
      segmentIndex:finite(manifest.segmentIndex!==undefined?manifest.segmentIndex:opts&&opts.segmentIndex),
      segmentCount:finite(manifest.segmentCount!==undefined?manifest.segmentCount:opts&&opts.segmentCount),
      segmentStartMeters:finite(manifest.segmentStartMeters!==undefined?manifest.segmentStartMeters:opts&&opts.segmentStartMeters),
      segmentEndMeters:finite(manifest.segmentEndMeters!==undefined?manifest.segmentEndMeters:opts&&opts.segmentEndMeters),
      routeLengthMeters:finite(manifest.routeLengthMeters!==undefined?manifest.routeLengthMeters:opts&&opts.routeLengthMeters),
      snapshotId:text(manifest.snapshotId||manifest.snapshotKey||manifest.captureSnapshotId||opts&&opts.snapshotId,180),
      snapshotCapturedAt:text(manifest.snapshotCapturedAt||manifest.capturedAt||manifest.createdAt||manifest.updatedAt||opts&&opts.snapshotCapturedAt,80),
      candidateId:text(manifest.candidateId||manifest.snapshotCandidateId||opts&&opts.candidateId,180),
      candidateIndex:finite(opts&&opts.candidateIndex),
      candidateCount:finite(opts&&opts.candidateCount),
      snapshotSelectionScore:finite(opts&&opts.snapshotSelectionScore),
      snapshotBalanceScore:finite(opts&&opts.snapshotBalanceScore),
      greenLushnessScore:finite(opts&&opts.greenLushnessScore),
      fairwayLineScore:finite(opts&&opts.fairwayLineScore),
      snapshotSelectionReason:text(manifest.snapshotSelectionReason||opts&&opts.snapshotSelectionReason,220),
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
        return {id:text(item&&item.id||item&&item.planId,180),role:text(item&&item.role,60),quality:text(item&&item.quality,60),holeNumber:finite(item&&item.holeNumber),targetZoom:finite(item&&item.targetZoom),minZoom:finite(item&&item.minZoom),maxTiles:finite(item&&item.maxTiles),stitchLayer:finite(item&&item.stitchLayer),bounds:validBounds(item&&item.bounds)?item.bounds:null,label:text(item&&item.label,120),terrainStageOnly:!!(item&&item.terrainStageOnly),beta3dStageOnly:!!(item&&item.beta3dStageOnly),cameraMode:text(item&&item.cameraMode,80),cameraTiltDeg:finite(item&&item.cameraTiltDeg),captureTiltDeg:finite(item&&item.captureTiltDeg),playTiltDeg:finite(item&&item.playTiltDeg),tileSourceLabel:text(item&&item.tileSourceLabel,120),captureLens:text(item&&item.captureLens||item&&item.lensShape,80),lensShape:text(item&&item.lensShape||item&&item.captureLens,80),lensAspectRatio:finite(item&&item.lensAspectRatio!==undefined?item.lensAspectRatio:item&&item.lensAspect),lensOrientation:text(item&&item.lensOrientation,80),lensFit:text(item&&item.lensFit,80),segmentIndex:finite(item&&item.segmentIndex),segmentCount:finite(item&&item.segmentCount),segmentStartMeters:finite(item&&item.segmentStartMeters),segmentEndMeters:finite(item&&item.segmentEndMeters),routeLengthMeters:finite(item&&item.routeLengthMeters),anchorPins:clone(item&&item.anchorPins||{}),captureAnchorPins:clone(item&&item.captureAnchorPins||{}),includeAnchorPins:!!(item&&item.includeAnchorPins)};
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
      holeFrameVisuals:[],
      previewVisual:null,
      terrainView:null,
      singleHolePreviewVisual:null,
      singleHoleTerrainView:null,
      holeFramePreviewVisuals:[],
      holeFrameTerrainViews:[],
      beta3dView:null,
      publishedVisual:null,
      singleHolePublishedVisual:null,
      holeFramePublishedVisuals:[],
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
  function putRecord(record,opts){
    opts=opts||{};
    var store=loadStore();
    record.updatedAt=now();
    record.status=VALID_STATUSES[record.status]?record.status:"failed";
    captureTransientAssets(record);
    store.records[record.courseId]=persistableRecord(record);
    saveStore(store);
    if(!opts.skipCloudSync&&record.status==="published"&&record.publishedVisual&&!record.settingsDirty)queueCloudSync(record,"metadata");
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
      if(asset){
        delete asset.dataUrl;
        if(asset.metadata)asset.metadata=compactAssetMetadata(asset.metadata);
        if(Array.isArray(asset.sourceCaptureIds)&&asset.sourceCaptureIds.length>24)asset.sourceCaptureIds=asset.sourceCaptureIds.slice(0,24);
      }
    });
    out.versions=(Array.isArray(out.versions)?out.versions:[]).slice(-24);
    out.events=(Array.isArray(out.events)?out.events:[]).slice(-24);
    if(out.diagnostics&&typeof out.diagnostics==="object"){
      out.diagnostics=clone(out.diagnostics)||{};
      delete out.diagnostics.capturePlan;
      delete out.diagnostics.captureBounds;
      delete out.diagnostics.sourceDimensions;
      if(out.diagnostics.captureExecution){
        out.diagnostics.captureExecution={
          attempted:!!out.diagnostics.captureExecution.attempted,
          captured:Number(out.diagnostics.captureExecution.captured)||0,
          freshRun:out.diagnostics.captureExecution.freshRun===true,
          fallbackReason:out.diagnostics.captureExecution.fallbackReason||"",
          errors:(Array.isArray(out.diagnostics.captureExecution.errors)?out.diagnostics.captureExecution.errors:[]).slice(-12),
          snapshotSelection:(Array.isArray(out.diagnostics.captureExecution.snapshotSelection)?out.diagnostics.captureExecution.snapshotSelection:[]).slice(-12).map(function(item){
            return {planId:item&&item.planId||"",role:item&&item.role||"",holeNumber:item&&item.holeNumber||null,selectedCaptureId:item&&item.selectedCaptureId||"",selectedCandidateId:item&&item.selectedCandidateId||"",candidateCount:item&&item.candidateCount||0,greenLushnessScore:item&&item.greenLushnessScore,fairwayLineScore:item&&item.fairwayLineScore,balanceScore:item&&item.balanceScore,selectionScore:item&&item.selectionScore,selectionReason:item&&item.selectionReason||"",tieBreak:item&&item.tieBreak||""};
          })
        };
      }
    }
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
      return {id:capture.id,storagePath:capture.storagePath||"",holeNumber:capture.holeNumber||null,role:capture.role||"",quality:capture.quality||"",stitchLayer:capture.stitchLayer||0,planId:capture.planId||"",width:capture.width,height:capture.height,tileCount:Array.isArray(capture.tiles)?capture.tiles.length:0,bounds:capture.bounds||null,boundsSource:capture.boundsSource||"",captureLens:capture.captureLens||"",lensOrientation:capture.lensOrientation||"",captureAnchorPins:clone(capture.captureAnchorPins||{})};
    });
    record.status=normalized.captures.length?"input-ready":"unavailable";
    record.lastError=normalized.captures.length?null:{code:"missing-captures",message:"No captured frames are available for this course visual."};
    record.diagnostics=Object.assign({},record.diagnostics||{},{capturePlan:normalized.capturePlan,capturePlanSummary:planSummary(normalized.capturePlan,normalized.captures),captureBounds:normalized.captures.map(captureBounds),sourceDimensions:normalized.captures.map(function(c){return {id:c.id,role:c.role||"",quality:c.quality||"",stitchLayer:c.stitchLayer||0,width:c.width,height:c.height,tiles:Array.isArray(c.tiles)?c.tiles.length:0};}),missingCaptures:normalized.captures.length?[]:["course-visual-captures"]});
    recordEvent(record,"course-visual-input-received",{captureCount:normalized.captures.length,objectCount:normalized.objects.length});
    return putRecord(record,{skipCloudSync:true});
  }
  function captureSignature(captures){
    return hashString((captures||[]).map(function(capture){return [capture.id,capture.role||"",capture.quality||"",capture.stitchLayer||0,capture.width,capture.height,capture.boundsSource||"",JSON.stringify(capture.bounds),JSON.stringify(capture.anchorPins||capture.pins||{}),JSON.stringify(capture.lensLocalCorners||capture.lensCornersPx||[]),Array.isArray(capture.tiles)?capture.tiles.length:0].join("|");}).join("\n"));
  }
  function capturesFromRecordRefs(record){
    return (Array.isArray(record&&record.captureRefs)?record.captureRefs:[]).map(function(ref){
      var manifest=ref&&ref.storagePath?readJson(ref.storagePath,null):null;
      return manifest?manifestToCapture(manifest,{courseId:record.courseId,role:ref&&ref.role,quality:ref&&ref.quality,stitchLayer:ref&&ref.stitchLayer,planId:ref&&ref.planId,captureLens:ref&&ref.captureLens,lensOrientation:ref&&ref.lensOrientation,captureAnchorPins:ref&&ref.captureAnchorPins}):null;
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
      if(role==="play-corridor")return 0;
      if(role==="source-frame")return 1;
      if(role==="green-surround")return 2;
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
  function chooseExampleHoleCaptures(captures){
    var valid=(Array.isArray(captures)?captures:[]).filter(renderableCapture).filter(function(capture){
      var role=String(capture&&capture.role||"");
      return role!=="course-backdrop"&&!capture.terrainStageOnly&&!capture.beta3dStageOnly&&role!=="terrain-reference"&&role!=="three-d-hole-beta";
    });
    if(!valid.length)return [];
    var preferred=valid.filter(function(capture){return String(capture&&capture.role||"")==="play-corridor";}).sort(function(a,b){
      var ah=Number(a.holeNumber)||999,bh=Number(b.holeNumber)||999;
      if(ah!==bh)return ah-bh;
      return String(a.id||"").localeCompare(String(b.id||""));
    })[0]||chooseExampleCapture(valid);
    var holeNumber=Number(preferred&&preferred.holeNumber)||0;
    var holeCaptures=holeNumber?valid.filter(function(capture){return Number(capture&&capture.holeNumber)===holeNumber;}):[preferred];
    holeCaptures.sort(function(a,b){
      var ar=String(a&&a.role||"")==="play-corridor"?0:String(a&&a.role||"")==="green-surround"?1:2;
      var br=String(b&&b.role||"")==="play-corridor"?0:String(b&&b.role||"")==="green-surround"?1:2;
      if(ar!==br)return ar-br;
      var as=Number(a&&a.segmentIndex)||999,bs=Number(b&&b.segmentIndex)||999;
      if(as!==bs)return as-bs;
      return String(a&&a.id||"").localeCompare(String(b&&b.id||""));
    });
    return holeCaptures.length?holeCaptures:[preferred].filter(Boolean);
  }
  function captureAnchors(capture){
    var pins=capture&&capture.anchorPins||capture&&capture.pins||{};
    var tee=point(pins.tee||pins.start||capture&&capture.teeLatLng);
    var green=point(pins.green||pins.target||pins.pin);
    var route=points(pins.route);
    var shape=points(pins.greenShape||pins.shape);
    if(!route.length&&tee&&green)route=[tee,green];
    return {tee:tee||route[0]||null,green:green||route[route.length-1]||null,route:route,greenShape:shape};
  }
  function holeFrameAnchors(captures){
    var best=null;
    (Array.isArray(captures)?captures:[]).forEach(function(capture){
      var anchors=captureAnchors(capture);
      var score=(anchors.route&&anchors.route.length||0)+(anchors.tee?2:0)+(anchors.green?2:0)+(anchors.greenShape&&anchors.greenShape.length?1:0);
      if(!best||score>best.score)best={score:score,anchors:anchors};
    });
    return best&&best.score?best.anchors:{tee:null,green:null,route:[],greenShape:[]};
  }
  function rotateSvgPoint(p,angle){
    var c=Math.cos(angle),s=Math.sin(angle);
    return {x:p.x*c-p.y*s,y:p.x*s+p.y*c};
  }
  function transformedBounds(points,angle,scale,tx,ty){
    var out=(Array.isArray(points)?points:[]).map(function(p){
      var r=rotateSvgPoint(p,angle);
      return {x:tx+r.x*scale,y:ty+r.y*scale};
    });
    if(!out.length)return null;
    return {
      minX:Math.min.apply(null,out.map(function(p){return p.x;})),
      maxX:Math.max.apply(null,out.map(function(p){return p.x;})),
      minY:Math.min.apply(null,out.map(function(p){return p.y;})),
      maxY:Math.max.apply(null,out.map(function(p){return p.y;}))
    };
  }
  function captureLensLocalPolygon(capture){
    var local=pixelPoints(capture&&capture.lensLocalCorners);
    var origin=capture&&capture.originPx||{};
    if(local.length<4&&Array.isArray(capture&&capture.lensCornersPx)&&origin&&Number.isFinite(Number(origin.x))&&Number.isFinite(Number(origin.y))){
      local=pixelPoints(capture.lensCornersPx).map(function(p){return {x:p.x-Number(origin.x),y:p.y-Number(origin.y)};});
    }
    return local.length>=4?local.slice(0,4):null;
  }
  function captureWorldProjector(capture){
    var bounds=captureBounds(capture);
    var projected=projectedBounds(bounds);
    if(!projected)return null;
    var width=Math.max(1,Number(capture&&capture.width)||1);
    var height=Math.max(1,Number(capture&&capture.height)||1);
    var spanX=Math.max(1e-9,projected.right-projected.left);
    var spanY=Math.max(1e-9,projected.bottom-projected.top);
    return function(x,y){
      return {
        x:projected.left+Number(x||0)/width*spanX,
        y:projected.top+Number(y||0)/height*spanY
      };
    };
  }
  function playAxisProjector(axis){
    if(!axis)return null;
    var origin=axis.origin||{};
    var ux=Number(axis.ux),uy=Number(axis.uy),px=Number(axis.px),py=Number(axis.py);
    var centerCross=Number(axis.centerCross),centerAlong=Number(axis.centerAlong),scale=Number(axis.scale);
    var width=Number(axis.width),height=Number(axis.height);
    if(![origin.x,origin.y,ux,uy,px,py,centerCross,centerAlong,scale,width,height].every(function(value){return Number.isFinite(value);}))return null;
    return function(pt){
      pt=point(pt);
      if(!pt)return null;
      var p=projectLatLng(pt.lat,pt.lng);
      var dx=p.x-origin.x,dy=p.y-origin.y;
      var cross=dx*px+dy*py;
      var along=dx*ux+dy*uy;
      return {x:width/2+(cross-centerCross)*scale,y:height/2-(along-centerAlong)*scale};
    };
  }
  function playAxisSurfaceAsset(captures,meta){
    var selected=(Array.isArray(captures)?captures:[]).filter(renderableCapture);
    if(!selected.length)return null;
    var anchors=holeFrameAnchors(selected);
    var tee=point(anchors.tee);
    var green=point(anchors.green);
    if(!tee||!green)return null;
    var teeWorld=projectLatLng(tee.lat,tee.lng);
    var greenWorld=projectLatLng(green.lat,green.lng);
    var dx=greenWorld.x-teeWorld.x,dy=greenWorld.y-teeWorld.y;
    var axisLen=Math.sqrt(dx*dx+dy*dy);
    if(!Number.isFinite(axisLen)||axisLen<=1e-10)return null;
    var ux=dx/axisLen,uy=dy/axisLen,px=-uy,py=ux;
    function axisCoord(world){
      var ax=world.x-teeWorld.x,ay=world.y-teeWorld.y;
      return {cross:ax*px+ay*py,along:ax*ux+ay*uy};
    }
    function latLngAxis(pt){
      pt=point(pt);
      return pt?axisCoord(projectLatLng(pt.lat,pt.lng)):null;
    }
    var axisPoints=[];
    (anchors.route||[]).concat(anchors.greenShape||[]).forEach(function(pt){var a=latLngAxis(pt);if(a)axisPoints.push(a);});
    [tee,green].forEach(function(pt){var a=latLngAxis(pt);if(a)axisPoints.push(a);});
    var positioned=selected.map(function(capture){
      var projector=captureWorldProjector(capture);
      if(!projector)return null;
      var width=Math.max(1,Number(capture.width)||1);
      var height=Math.max(1,Number(capture.height)||1);
      var localLens=captureLensLocalPolygon(capture)||[{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}];
      var worldLens=localLens.map(function(p){return projector(p.x,p.y);}).filter(Boolean);
      worldLens.forEach(function(world){axisPoints.push(axisCoord(world));});
      return {capture:capture,projector:projector,localLens:localLens,bounds:captureBounds(capture),projected:projectedBounds(captureBounds(capture))};
    }).filter(Boolean);
    if(!positioned.length||axisPoints.length<2)return null;
    positioned.sort(function(a,b){
      var al=Number(a.capture&&a.capture.stitchLayer)||0,bl=Number(b.capture&&b.capture.stitchLayer)||0;
      if(al!==bl)return al-bl;
      var ar=String(a.capture&&a.capture.role||"")==="play-corridor"?0:String(a.capture&&a.capture.role||"")==="green-surround"?1:2;
      var br=String(b.capture&&b.capture.role||"")==="play-corridor"?0:String(b.capture&&b.capture.role||"")==="green-surround"?1:2;
      if(ar!==br)return ar-br;
      var as=Number(a.capture&&a.capture.segmentIndex)||999,bs=Number(b.capture&&b.capture.segmentIndex)||999;
      if(as!==bs)return as-bs;
      return String(a.capture&&a.capture.id||"").localeCompare(String(b.capture&&b.capture.id||""));
    });
    var minCross=Math.min.apply(null,axisPoints.map(function(p){return p.cross;}));
    var maxCross=Math.max.apply(null,axisPoints.map(function(p){return p.cross;}));
    var minAlong=Math.min.apply(null,axisPoints.map(function(p){return p.along;}));
    var maxAlong=Math.max.apply(null,axisPoints.map(function(p){return p.along;}));
    var alongSpan=Math.max(axisLen,maxAlong-minAlong,1e-9);
    var crossSpan=Math.max(maxCross-minCross,axisLen*.42,1e-9);
    var crossPad=Math.max(crossSpan*.12,axisLen*.08);
    var alongPad=Math.max(alongSpan*.08,axisLen*.06);
    minCross-=crossPad;maxCross+=crossPad;minAlong-=alongPad;maxAlong+=alongPad;
    crossSpan=Math.max(1e-9,maxCross-minCross);
    alongSpan=Math.max(1e-9,maxAlong-minAlong);
    var targetAspect=9/16;
    var width=4096;
    var height=Math.round(width/targetAspect);
    var marginX=width*.07,marginY=height*.06;
    var scale=Math.min((width-marginX*2)/crossSpan,(height-marginY*2)/alongSpan);
    if(!Number.isFinite(scale)||scale<=0)return null;
    var centerCross=(minCross+maxCross)/2;
    var centerAlong=(minAlong+maxAlong)/2;
    var axis={origin:{x:teeWorld.x,y:teeWorld.y},ux:ux,uy:uy,px:px,py:py,centerCross:centerCross,centerAlong:centerAlong,scale:scale,width:width,height:height};
    var project=playAxisProjector(axis);
    if(!project)return null;
    var defs=[];
    var groups=positioned.map(function(item,index){
      var capture=item.capture;
      var projected=item.projected;
      if(!projected)return "";
      var capW=Math.max(1,Number(capture.width)||1);
      var capH=Math.max(1,Number(capture.height)||1);
      var spanX=Math.max(1e-9,projected.right-projected.left);
      var spanY=Math.max(1e-9,projected.bottom-projected.top);
      var baseCross=(projected.left-teeWorld.x)*px+(projected.top-teeWorld.y)*py;
      var baseAlong=(projected.left-teeWorld.x)*ux+(projected.top-teeWorld.y)*uy;
      var a=spanX/capW*px*scale;
      var b=-spanX/capW*ux*scale;
      var c=spanY/capH*py*scale;
      var d=-spanY/capH*uy*scale;
      var e=width/2+(baseCross-centerCross)*scale;
      var f=height/2-(baseAlong-centerAlong)*scale;
      var localLens=captureLensLocalPolygon(capture);
      var content=captureContentSvg(capture);
      var clipAttr="";
      if(localLens){
        defs.push('<clipPath id="cvPlayAxisLensClip'+index+'"><polygon points="'+localLens.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'"/></clipPath>');
        content='<g clip-path="url(#cvPlayAxisLensClip'+index+')">'+content+'</g>';
        clipAttr=' data-lens-clip="play-axis-mobile-hole"';
      }
      return '<g data-capture-id="'+escapeXml(capture.id)+'" data-role="'+escapeXml(capture.role||"source-frame")+'" data-quality="'+escapeXml(capture.quality||"source")+'" data-capture-lens="'+escapeXml(capture.captureLens||"")+'" data-segment-index="'+escapeXml(capture.segmentIndex||"")+'" data-segment-count="'+escapeXml(capture.segmentCount||"")+'" data-play-axis-surface="true"'+clipAttr+' transform="matrix('+[a,b,c,d,e,f].map(svgNum).join(" ")+')">'+content+'</g>';
    }).join("");
    var routePx=(anchors.route||[]).map(project).filter(Boolean);
    var greenShapePx=(anchors.greenShape||[]).map(project).filter(Boolean);
    var teePx=project(tee);
    var greenPx=project(green);
    var proofParts=[];
    if(greenShapePx.length>=3)proofParts.push('<polygon data-role="play-green-bound" points="'+greenShapePx.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'" fill="rgba(72,255,141,.14)" stroke="rgba(98,255,157,.88)" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>');
    if(routePx.length>=2)proofParts.push('<polyline data-role="play-route-axis" points="'+routePx.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'" fill="none" stroke="rgba(255,247,128,.92)" stroke-width="7" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>');
    if(teePx)proofParts.push('<circle data-role="play-tee-anchor" cx="'+svgNum(teePx.x)+'" cy="'+svgNum(teePx.y)+'" r="12" fill="rgba(255,255,255,.9)" stroke="rgba(0,0,0,.72)" stroke-width="3" vector-effect="non-scaling-stroke"/>');
    if(greenPx)proofParts.push('<circle data-role="play-green-anchor" cx="'+svgNum(greenPx.x)+'" cy="'+svgNum(greenPx.y)+'" r="14" fill="rgba(84,255,144,.9)" stroke="rgba(0,0,0,.76)" stroke-width="3" vector-effect="non-scaling-stroke"/>');
    var defsMarkup=defs.length?'<defs>'+defs.join("")+'</defs>':"";
    var proof=proofParts.length?'<g data-role="play-object-proof-overlay" data-orientation-source="play-axis-surface">'+proofParts.join("")+'</g>':"";
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="hole-axis-source" data-layout="play-axis-hole-surface"><rect width="100%" height="100%" fill="#10130f"/>'+defsMarkup+groups+proof+'</svg>';
    var sourceIds=positioned.map(function(item){return item.capture.id;}).filter(Boolean);
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,bounds:mergeBounds(positioned.map(function(item){return item.bounds;})),captureId:selected[0].id,holeNumber:selected[0].holeNumber||null,sourceCaptureIds:sourceIds,metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",layout:"play-axis-hole-surface",stitchModel:"play-axis-affine-capture-composite",visualLayerModel:"hole-axis-captures-no-underlay",captureLens:"mobile-hole",lensAspectRatio:9/16,framingModel:"gps-play-overcaptured-play-axis-surface",orientationSource:"tee-green-anchor",rotationDeg:0,sourceCaptureCount:sourceIds.length,anchorPins:clone(anchors),playAxis:axis,objectProofOverlay:{enabled:!!proofParts.length,routePoints:routePx.length,greenShapePoints:greenShapePx.length,tee:!!teePx,green:!!greenPx},outputDimensions:{width:width,height:height}},meta||{})};
  }
  function holeWindowAsset(captures,meta,opts){
    opts=opts||{};
    var selected=(Array.isArray(captures)?captures:[]).filter(renderableCapture);
    if(!selected.length)return null;
    var capture=selected[0];
    var sourceAsset=null;
    sourceAsset=safe(function(){return playAxisSurfaceAsset(selected,{inputVisualId:meta&&meta.inputVisualId,courseId:meta&&meta.courseId,role:"hole-window-source",stage:"play-axis-source"});},null);
    if(!sourceAsset&&selected.length>1)sourceAsset=safe(function(){return stitchSvg(selected,{inputVisualId:meta&&meta.inputVisualId,courseId:meta&&meta.courseId,role:"hole-window-source",stage:"play-axis-source"});},null);
    var sourceWidth=Math.max(1,Math.round(Number(sourceAsset&&sourceAsset.width||capture.width)||1));
    var sourceHeight=Math.max(1,Math.round(Number(sourceAsset&&sourceAsset.height||capture.height)||1));
    var sourceBounds=sourceAsset&&sourceAsset.bounds||captureBounds(capture);
    var sourceContent="";
    if(sourceAsset&&sourceAsset.dataUrl){
      var sourceInner=svgInnerFromDataUrl(sourceAsset.dataUrl).replace(/<rect\s+width="100%"\s+height="100%"\s+fill="#10130f"\s*\/>/i,"");
      sourceContent=sourceInner?'<svg x="0" y="0" width="'+svgNum(sourceWidth)+'" height="'+svgNum(sourceHeight)+'" viewBox="0 0 '+svgNum(sourceWidth)+" "+svgNum(sourceHeight)+'" overflow="visible">'+sourceInner+'</svg>':"";
    }else{
      sourceContent=captureContentSvg(capture);
    }
    if(!sourceContent)return null;
    var targetAspect=9/16;
    var width=Math.max(720,Math.min(4096,Math.round(sourceWidth)));
    var height=Math.round(width/targetAspect);
    var anchors=holeFrameAnchors(selected);
    var sourceMeta=sourceAsset&&sourceAsset.metadata||{};
    var project=playAxisProjector(sourceMeta.playAxis)||assetPointProjector(sourceBounds,sourceWidth,sourceHeight);
    var anchorPoints=(anchors.route&&anchors.route.length?anchors.route:[]).concat(anchors.greenShape||[]);
    if(anchors.tee)anchorPoints.push(anchors.tee);
    if(anchors.green)anchorPoints.push(anchors.green);
    var projected=project?anchorPoints.map(project).filter(Boolean):[];
    var teePx=project&&anchors.tee?project(anchors.tee):null;
    var greenPx=project&&anchors.green?project(anchors.green):null;
    var angle=0;
    var orientationSource="none";
    if(sourceMeta.layout==="play-axis-hole-surface"){
      angle=0;
      orientationSource=sourceMeta.orientationSource||"play-axis-surface";
    }else if(teePx&&greenPx&&Math.abs(greenPx.x-teePx.x)+Math.abs(greenPx.y-teePx.y)>1){
      angle=-Math.PI/2-Math.atan2(greenPx.y-teePx.y,greenPx.x-teePx.x);
      orientationSource="tee-green-anchor";
    }else if(projected.length>=2){
      var a=projected[0],b=projected[projected.length-1];
      angle=-Math.PI/2-Math.atan2(b.y-a.y,b.x-a.x);
      orientationSource="route-anchor";
      teePx=a;greenPx=b;
    }
    if(!projected.length){
      projected=[{x:0,y:0},{x:sourceWidth,y:sourceHeight}];
      teePx={x:sourceWidth/2,y:sourceHeight*.86};
      greenPx={x:sourceWidth/2,y:sourceHeight*.18};
    }
    var rotated=projected.map(function(p){return rotateSvgPoint(p,angle);});
    var minX=Math.min.apply(null,rotated.map(function(p){return p.x;}));
    var maxX=Math.max.apply(null,rotated.map(function(p){return p.x;}));
    var minY=Math.min.apply(null,rotated.map(function(p){return p.y;}));
    var maxY=Math.max.apply(null,rotated.map(function(p){return p.y;}));
    var routeLen=teePx&&greenPx?Math.sqrt(Math.pow(greenPx.x-teePx.x,2)+Math.pow(greenPx.y-teePx.y,2)):Math.max(maxY-minY,maxX-minX);
    var xPad=clamp(routeLen*.22,Math.max(110,sourceWidth*.06),Math.max(180,sourceWidth*.36));
    var yPad=clamp(routeLen*.10,Math.max(90,sourceHeight*.035),Math.max(220,sourceHeight*.22));
    minX-=xPad;maxX+=xPad;minY-=yPad;maxY+=yPad;
    var fitW=Math.max(1,maxX-minX),fitH=Math.max(1,maxY-minY);
    var frameW=width*.82;
    var frameH=frameW/targetAspect;
    if(frameH>height*.84){
      frameH=height*.84;
      frameW=frameH*targetAspect;
    }
    var frameX=(width-frameW)/2;
    var frameY=(height-frameH)/2;
    var scale=Math.min(frameW*.84/fitW,frameH*.84/fitH);
    scale=clamp(scale,.05,1.75);
    var teeR=teePx?rotateSvgPoint(teePx,angle):null;
    var greenR=greenPx?rotateSvgPoint(greenPx,angle):null;
    var tx=frameX+frameW/2-((minX+maxX)/2)*scale;
    var ty=frameY+frameH/2-((minY+maxY)/2)*scale;
    if(teeR&&greenR){
      tx=frameX+frameW/2-((teeR.x+greenR.x)/2)*scale;
      ty=frameY+frameH*.53-((teeR.y+greenR.y)/2)*scale;
    }
    var boundsAfter=transformedBounds([{x:minX,y:minY},{x:maxX,y:maxY}],0,scale,tx,ty);
    var marginX=width*.08,marginY=height*.07;
    if(boundsAfter){
      if(boundsAfter.minX>marginX)tx-=boundsAfter.minX-marginX;
      if(boundsAfter.maxX<width-marginX)tx+=(width-marginX)-boundsAfter.maxX;
      if(boundsAfter.minY>marginY)ty-=boundsAfter.minY-marginY;
      if(boundsAfter.maxY<height-marginY)ty+=(height-marginY)-boundsAfter.maxY;
    }
    var radius=Math.max(18,Math.min(52,width*.045));
    var frameRadius=Math.max(14,Math.min(46,frameW*.06));
    var angleDeg=angle*180/Math.PI;
    var title=text(opts.title||"Hole window "+(capture.holeNumber||"?"),80);
    var label='<g transform="translate(14 14)"><rect x="0" y="0" width="'+svgNum(Math.max(230,title.length*8.4))+'" height="31" rx="6" fill="rgba(0,0,0,.58)"/><text x="10" y="21" font-size="14" fill="#fff" font-family="system-ui, sans-serif" font-weight="850">'+escapeXml(title)+'</text></g>';
    function sourcePointList(list){
      return (Array.isArray(list)?list:[]).map(function(item){return project?project(item):null;}).filter(Boolean);
    }
    var routePx=sourcePointList(anchors.route);
    var greenShapePx=sourcePointList(anchors.greenShape);
    var proofParts=[];
    if(greenShapePx.length>=3){
      proofParts.push('<polygon data-role="play-green-bound" points="'+greenShapePx.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'" fill="rgba(72,255,141,.14)" stroke="rgba(98,255,157,.88)" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>');
    }
    if(routePx.length>=2){
      proofParts.push('<polyline data-role="play-route-axis" points="'+routePx.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'" fill="none" stroke="rgba(255,247,128,.92)" stroke-width="7" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>');
    }
    if(teePx)proofParts.push('<circle data-role="play-tee-anchor" cx="'+svgNum(teePx.x)+'" cy="'+svgNum(teePx.y)+'" r="12" fill="rgba(255,255,255,.9)" stroke="rgba(0,0,0,.72)" stroke-width="3" vector-effect="non-scaling-stroke"/>');
    if(greenPx)proofParts.push('<circle data-role="play-green-anchor" cx="'+svgNum(greenPx.x)+'" cy="'+svgNum(greenPx.y)+'" r="14" fill="rgba(84,255,144,.9)" stroke="rgba(0,0,0,.76)" stroke-width="3" vector-effect="non-scaling-stroke"/>');
    var objectOverlay=proofParts.length?'<g data-role="play-object-proof-overlay" data-orientation-source="'+escapeXml(orientationSource)+'">'+proofParts.join("")+'</g>':"";
    var viewportFrame='<rect data-role="gps-play-frame" x="'+svgNum(frameX)+'" y="'+svgNum(frameY)+'" width="'+svgNum(frameW)+'" height="'+svgNum(frameH)+'" rx="'+svgNum(frameRadius)+'" fill="none" stroke="rgba(255,255,255,.88)" stroke-width="'+svgNum(Math.max(3,width*.004))+'"/><rect data-role="capture-overflow-frame" x="'+svgNum(frameX-frameW*.025)+'" y="'+svgNum(frameY-frameW*.025)+'" width="'+svgNum(frameW+frameW*.05)+'" height="'+svgNum(frameH+frameW*.05)+'" rx="'+svgNum(frameRadius+frameW*.025)+'" fill="none" stroke="rgba(102,255,159,.56)" stroke-width="2" stroke-dasharray="18 15"/>';
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="'+escapeXml(opts.role||"example-hole")+'" data-framing-model="gps-play-viewport-over-hole-surface"><defs><clipPath id="cvHoleWindowClip"><rect x="0" y="0" width="'+svgNum(width)+'" height="'+svgNum(height)+'" rx="'+svgNum(radius)+'"/></clipPath><linearGradient id="cvHoleWindowDepth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.08)"/><stop offset=".52" stop-color="rgba(255,255,255,0)"/><stop offset="1" stop-color="rgba(0,0,0,.22)"/></linearGradient></defs><rect width="100%" height="100%" fill="#10130f"/><g clip-path="url(#cvHoleWindowClip)"><g transform="translate('+svgNum(tx)+" "+svgNum(ty)+') scale('+svgNum(scale)+') rotate('+svgNum(angleDeg)+')">'+sourceContent+objectOverlay+'</g><rect width="100%" height="100%" fill="url(#cvHoleWindowDepth)"/>'+viewportFrame+'</g><rect x="0" y="0" width="100%" height="100%" rx="'+svgNum(radius)+'" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="2"/>'+label+'</svg>';
    var sourceIds=sourceAsset&&sourceAsset.sourceCaptureIds||selected.map(function(item){return item.id;}).filter(Boolean);
    var playSurface={
      model:"overcaptured-hole-surface",
      useGpsPlayFraming:true,
      fallbackUnderlay:"live-gps",
      fallbackPolicy:"live-gps-only",
      bleedPct:.22,
      anchorPins:clone(anchors),
      sourceBounds:clone(sourceBounds),
      sourceDimensions:{width:sourceWidth,height:sourceHeight},
      outputDimensions:{width:width,height:height},
      viewportFrame:{x:+frameX.toFixed(2),y:+frameY.toFixed(2),width:+frameW.toFixed(2),height:+frameH.toFixed(2),aspectRatio:targetAspect},
      orientationSource:orientationSource,
      rotationDeg:+angleDeg.toFixed(3),
      scale:+scale.toFixed(4),
      objectProofOverlay:{enabled:!!proofParts.length,routePoints:routePx.length,greenShapePoints:greenShapePx.length,tee:!!teePx,green:!!greenPx},
      overflowVisible:true
    };
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,bounds:sourceBounds,captureId:capture.id,holeNumber:capture.holeNumber||null,sourceCaptureIds:sourceIds,metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:opts.role||"example-hole",stage:opts.stage||"hole-window",captureLens:"mobile-hole",lensAspectRatio:targetAspect,sourceDimensions:{width:sourceWidth,height:sourceHeight},outputDimensions:{width:width,height:height},viewportFrame:{x:+frameX.toFixed(2),y:+frameY.toFixed(2),width:+frameW.toFixed(2),height:+frameH.toFixed(2),aspectRatio:targetAspect},windowShape:"mobile-hole-with-overflow",framingModel:"gps-play-viewport-over-hole-surface",playSurface:playSurface,orientationSource:orientationSource,rotationDeg:+angleDeg.toFixed(3),scale:+scale.toFixed(4),objectProofOverlay:{enabled:!!proofParts.length,routePoints:routePx.length,greenShapePoints:greenShapePx.length,tee:!!teePx,green:!!greenPx},overflowVisible:true,sourceCaptureCount:sourceIds.length},meta||{})};
  }
  function exampleHoleSvg(captures,meta){
    var selected=chooseExampleHoleCaptures(captures);
    return holeWindowAsset(selected.length?selected:[chooseExampleCapture(captures)].filter(Boolean),meta,{role:"example-hole",stage:"hole-window",title:"Hole window "+(selected[0]&&selected[0].holeNumber||"?")});
  }
  function holePlaySurfaceAsset(captures,meta){
    var selected=(Array.isArray(captures)?captures:[]).filter(renderableCapture);
    if(!selected.length)return null;
    var capture=selected[0];
    var anchors=holeFrameAnchors(selected);
    var surface=safe(function(){
      return playAxisSurfaceAsset(selected,Object.assign({role:"hole-frame",stage:"hole-surface",product:"hole-frame"},meta||{}));
    },null);
    if(!surface||!surface.dataUrl){
      surface=safe(function(){
        return stitchSvg(selected,Object.assign({role:"hole-frame",stage:"hole-surface",product:"hole-frame"},meta||{}));
      },null);
    }
    if(!surface||!surface.dataUrl)return null;
    var sourceIds=surface.sourceCaptureIds||selected.map(function(item){return item.id;}).filter(Boolean);
    var playSurface={
      model:"overcaptured-hole-surface",
      projection:surface.metadata&&surface.metadata.layout==="play-axis-hole-surface"?"play-axis-svg":"mercator-svg",
      useGpsPlayFraming:true,
      fallbackUnderlay:"live-gps",
      fallbackPolicy:"live-gps-only",
      bleedPct:.22,
      anchorPins:clone(anchors),
      sourceBounds:clone(surface.bounds),
      outputDimensions:{width:surface.width,height:surface.height},
      stitchModel:surface.metadata&&surface.metadata.stitchModel||"geo-rectangle-table-over-live-map",
      playAxis:surface.metadata&&surface.metadata.playAxis||null
    };
    return {dataUrl:surface.dataUrl,width:surface.width,height:surface.height,bounds:surface.bounds,captureId:capture.id,holeNumber:capture.holeNumber||null,sourceCaptureIds:sourceIds,metadata:Object.assign({},surface.metadata||{},{rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:"hole-frame",stage:"hole-surface",product:"hole-frame",captureLens:"mobile-hole",framingModel:playSurface.projection==="play-axis-svg"?"gps-play-overcaptured-play-axis-surface":"gps-play-overcaptured-mercator-surface",playSurface:playSurface,sourceCaptureCount:sourceIds.length},meta||{})};
  }
  function buildHoleFrameVisuals(captures,meta){
    var byHole={};
    (Array.isArray(captures)?captures:[]).filter(renderableCapture).forEach(function(capture){
      var role=String(capture&&capture.role||"");
      if(role==="course-backdrop"||role==="terrain-reference"||role==="three-d-hole-beta"||capture.terrainStageOnly||capture.beta3dStageOnly)return;
      var hole=Math.max(0,Math.round(Number(capture&&capture.holeNumber)||0));
      if(!hole)return;
      byHole[hole]=byHole[hole]||[];
      byHole[hole].push(capture);
    });
    return Object.keys(byHole).map(Number).sort(function(a,b){return a-b;}).map(function(holeNumber){
      var frame=holePlaySurfaceAsset(byHole[holeNumber],Object.assign({holeNumber:holeNumber},meta||{}));
      if(frame)frame.holeNumber=holeNumber;
      return frame;
    }).filter(Boolean);
  }
  function captureHoleFrameCount(captures){
    var seen={};
    (Array.isArray(captures)?captures:[]).filter(renderableCapture).forEach(function(capture){
      var role=String(capture&&capture.role||"");
      if(role==="course-backdrop"||role==="terrain-reference"||role==="three-d-hole-beta"||capture.terrainStageOnly||capture.beta3dStageOnly)return;
      var hole=Math.max(0,Math.round(Number(capture&&capture.holeNumber)||0));
      if(hole)seen[hole]=true;
    });
    return Object.keys(seen).length;
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
      var lensLocal=role!=="course-backdrop"?captureLensLocalPolygon(capture):null;
      var lensLocalPoints=lensLocal&&lensLocal.map(function(point){return svgNum(point.x)+","+svgNum(point.y);}).join(" ");
      if(lensLocalPoints){
        defs.push('<clipPath id="cvLensClip'+index+'"><polygon points="'+lensLocalPoints+'"/></clipPath>');
        clipMask=' data-lens-clip="oriented-mobile-hole"';
      }else if(role!=="course-backdrop"){
        var feather=Math.max(16,Math.min(80,Math.min(w,h)*.08));
        var maskX=x-feather*2,maskY=y-feather*2,maskW=w+feather*4,maskH=h+feather*4;
        var innerX=x+feather*.8,innerY=y+feather*.8,innerW=Math.max(1,w-feather*1.6),innerH=Math.max(1,h-feather*1.6);
        var radius=Math.min(36,Math.max(8,feather*.55));
        var clipShape='<rect x="'+svgNum(x)+'" y="'+svgNum(y)+'" width="'+svgNum(w)+'" height="'+svgNum(h)+'" rx="'+svgNum(radius)+'"/>';
        var featherShape='<rect x="'+svgNum(x)+'" y="'+svgNum(y)+'" width="'+svgNum(w)+'" height="'+svgNum(h)+'" rx="'+svgNum(radius)+'" fill="white" filter="url(#cvStitchFeather)"/><rect x="'+svgNum(innerX)+'" y="'+svgNum(innerY)+'" width="'+svgNum(innerW)+'" height="'+svgNum(innerH)+'" rx="'+svgNum(radius*.65)+'" fill="white"/>';
        defs.push('<clipPath id="cvStitchClip'+index+'">'+clipShape+'</clipPath><mask id="cvStitchMask'+index+'" maskUnits="userSpaceOnUse" x="'+svgNum(maskX)+'" y="'+svgNum(maskY)+'" width="'+svgNum(maskW)+'" height="'+svgNum(maskH)+'"><rect x="'+svgNum(maskX)+'" y="'+svgNum(maskY)+'" width="'+svgNum(maskW)+'" height="'+svgNum(maskH)+'" fill="black"/>'+featherShape+'</mask>');
        clipMask=' clip-path="url(#cvStitchClip'+index+')" mask="url(#cvStitchMask'+index+')"';
      }
      var content=captureContentSvg(capture);
      if(lensLocalPoints)content='<g clip-path="url(#cvLensClip'+index+')">'+content+'</g>';
      return '<g data-capture-id="'+escapeXml(capture.id)+'" data-role="'+escapeXml(role)+'" data-quality="'+escapeXml(capture.quality||"source")+'" data-capture-lens="'+escapeXml(capture.captureLens||"")+'" data-segment-index="'+escapeXml(capture.segmentIndex||"")+'" data-segment-count="'+escapeXml(capture.segmentCount||"")+'" data-stitch-layer="'+escapeXml(capture.stitchLayer||0)+'" data-stitch-x="'+svgNum(x)+'" data-stitch-y="'+svgNum(y)+'" data-stitch-width="'+svgNum(w)+'" data-stitch-height="'+svgNum(h)+'" opacity="'+svgNum(style.opacity)+'"'+clipMask+' transform="translate('+svgNum(x)+" "+svgNum(y)+') scale('+svgNum(w/(Number(capture.width)||1))+" "+svgNum(h/(Number(capture.height)||1))+')">'+content+'</g>';
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
  function visualAssetSourceMarkup(asset,width,height,opts){
    opts=opts||{};
    var base=asset&&asset.dataUrl||"";
    var inner=svgInnerFromDataUrl(base);
    if(inner&&opts.transparentBackground){
      inner=inner.replace(/<rect\s+width="100%"\s+height="100%"\s+fill="#10130f"\s*\/>/i,"");
    }
    if(inner)return inner;
    return base?'<image href="'+escapeXml(base)+'" x="0" y="0" width="'+svgNum(width)+'" height="'+svgNum(height)+'" preserveAspectRatio="none"/>':"";
  }
  function inheritedSurfaceMetadata(asset){
    var sourceMeta=asset&&asset.metadata||{};
    var out={};
    ["framingModel","captureLens","lensAspectRatio","windowShape","orientationSource","rotationDeg","scale","overflowVisible"].forEach(function(key){
      if(sourceMeta[key]!=null)out[key]=sourceMeta[key];
    });
    ["playSurface","viewportFrame","objectProofOverlay","sourceDimensions"].forEach(function(key){
      if(sourceMeta[key]&&typeof sourceMeta[key]==="object")out[key]=clone(sourceMeta[key]);
    });
    return out;
  }
  function assetPointProjector(bounds,width,height){
    var projected=projectedBounds(bounds);
    if(!projected)return null;
    var spanX=Math.max(1e-9,projected.right-projected.left);
    var spanY=Math.max(1e-9,projected.bottom-projected.top);
    return function(pt){
      pt=point(pt);
      if(!pt)return null;
      var p=projectLatLng(pt.lat,pt.lng);
      return {x:(p.x-projected.left)/spanX*width,y:(p.y-projected.top)/spanY*height};
    };
  }
  function geometryIsPolygon(geometry,pts){
    var type=String(geometry&&geometry.type||"").toLowerCase();
    if(type.indexOf("polygon")>=0)return true;
    if(geometry&&Array.isArray(geometry.polygon))return true;
    if(!/line/.test(type)&&Array.isArray(pts)&&pts.length>=4&&distanceMeters(pts[0],pts[pts.length-1])<6)return true;
    return false;
  }
  function nativeAirbrushAllowed(meta){
    return String(meta&&meta.product||"")!=="course-overview";
  }
  function fairwayAirbrushSettings(settings){
    var tools=settings&&settings.visualTools||{};
    if(tools.fairwayAirbrush===false)return null;
    var readability=settings&&settings.readability||{};
    var strength=finite(tools.fairwayAirbrushStrength);
    if(strength==null)strength=.18+(Number(readability.fairwaySeparation)||.18)*.45;
    var width=finite(tools.fairwayAirbrushWidthMeters);
    if(width==null)width=44;
    return {
      strength:clamp(strength,0,.75),
      widthMeters:clamp(width,18,86),
      hueOpacity:clamp(strength*.86,0,.56),
      saturationOpacity:clamp(strength*.42,0,.32)
    };
  }
  function fairwayAirbrushMarkup(source,dims,bounds,settings,meta){
    if(!nativeAirbrushAllowed(meta))return {defs:"",layer:"",metadata:{enabled:false,reason:"overview-airbrush-disabled"}};
    var airbrush=fairwayAirbrushSettings(settings);
    if(!airbrush||airbrush.strength<=0||!validBounds(bounds))return {defs:"",layer:"",metadata:{enabled:false,reason:"disabled-or-missing-bounds"}};
    var objects=(Array.isArray(meta&&meta.airbrushObjects)?meta.airbrushObjects:Array.isArray(meta&&meta.objects)?meta.objects:[]).filter(function(object){
      var type=String(object&&object.type||"");
      if(!/fairway/i.test(type))return false;
      if(meta&&meta.holeNumber&&object&&object.holeNumber&&Number(object.holeNumber)!==Number(meta.holeNumber))return false;
      var b=objectBounds(object);
      return !b||boundsIntersects(padBounds(b,airbrush.widthMeters*1.3),bounds);
    });
    if(!objects.length)return {defs:"",layer:"",metadata:{enabled:false,reason:"missing-fairway-geometry"}};
    var project=assetPointProjector(bounds,dims.width,dims.height);
    if(!project)return {defs:"",layer:"",metadata:{enabled:false,reason:"missing-projector"}};
    var span=boundsSpanM(bounds);
    var pxPerM=(span.width>0&&span.height>0)?((dims.width/span.width)+(dims.height/span.height))/2:(dims.width/240);
    var strokeWidth=clamp(airbrush.widthMeters*pxPerM,10,Math.max(18,Math.min(dims.width,dims.height)*.18));
    var shapes=[];
    objects.forEach(function(object,index){
      var pts=pointsFromGeometry(object&&object.geometry);
      if(!pts.length&&object&&object.position)pts=points([object.position]);
      if(!pts.length)return;
      var projectedPts=pts.map(project).filter(Boolean);
      if(!projectedPts.length)return;
      var isPolygon=geometryIsPolygon(object&&object.geometry,pts);
      if(isPolygon&&projectedPts.length>=3){
        shapes.push('<path data-fairway-index="'+index+'" d="M '+projectedPts.map(function(p){return svgNum(p.x)+" "+svgNum(p.y);}).join(" L ")+' Z" fill="white"/>');
      }else if(projectedPts.length>=2){
        shapes.push('<polyline data-fairway-index="'+index+'" points="'+projectedPts.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'" fill="none" stroke="white" stroke-width="'+svgNum(strokeWidth)+'" stroke-linecap="round" stroke-linejoin="round"/>');
      }else{
        shapes.push('<circle data-fairway-index="'+index+'" cx="'+svgNum(projectedPts[0].x)+'" cy="'+svgNum(projectedPts[0].y)+'" r="'+svgNum(strokeWidth*.55)+'" fill="white"/>');
      }
    });
    if(!shapes.length)return {defs:"",layer:"",metadata:{enabled:false,reason:"empty-fairway-mask"}};
    var defs='<mask id="cvFairwayAirbrushMask" maskUnits="userSpaceOnUse" x="0" y="0" width="'+svgNum(dims.width)+'" height="'+svgNum(dims.height)+'"><rect width="100%" height="100%" fill="black"/><g filter="url(#cvFairwayAirbrushSoften)">'+shapes.join("")+'</g></mask><filter id="cvFairwayAirbrushSoften" x="-12%" y="-12%" width="124%" height="124%"><feGaussianBlur stdDeviation="'+svgNum(Math.max(2,Math.min(10,strokeWidth*.05)))+'"/></filter>';
    var layer='<g data-role="fairway-airbrush" data-mode="burn-rescue-preserve-luminance" mask="url(#cvFairwayAirbrushMask)" opacity="1"><rect width="100%" height="100%" fill="#2f9d55" opacity="'+svgNum(airbrush.hueOpacity)+'" style="mix-blend-mode:hue"/><rect width="100%" height="100%" fill="#45aa5f" opacity="'+svgNum(airbrush.saturationOpacity)+'" style="mix-blend-mode:saturation"/><rect width="100%" height="100%" fill="rgba(64,142,72,.18)" opacity="'+svgNum(airbrush.strength*.28)+'" style="mix-blend-mode:soft-light"/></g>';
    return {defs:defs,layer:layer,metadata:{enabled:true,mode:"burn-rescue-preserve-luminance",maskObjects:objects.length,strength:+airbrush.strength.toFixed(3),widthMeters:+airbrush.widthMeters.toFixed(1),preserves:"relative-luminance-and-mow-lines"}};
  }
  function greenSurroundAirbrushMarkup(source,dims,bounds,settings,meta){
    return {defs:"",layer:"",metadata:{enabled:false,reason:"removed-green-touch-up"}};
  }
  function mowingOpacity(value){
    value=String(value||"Unknown");
    if(value==="Low")return .12;
    if(value==="Clear")return .28;
    if(value==="Prominent")return .48;
    return 0;
  }
  function nativeReadabilityOverlay(settings){
    var readability=settings&&settings.readability||{};
    var local=clamp(Number(readability.localContrast)||.08,0,.65);
    var top=clamp(.025+local*.22,.02,.16);
    var bottom=clamp(.05+local*.3,.05,.24);
    var opacity=clamp(.58+local*1.3,.58,1);
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
    var assetBounds=visualAssetBounds(asset,meta.bounds);
    var airbrush=fairwayAirbrushMarkup(source,dims,assetBounds,settings,meta);
    var greenAirbrush=greenSurroundAirbrushMarkup(source,dims,assetBounds,settings,meta);
    var greenLayer=f.greenBias?'<g data-role="green-strength" data-strength="'+svgNum(f.greenBias)+'"><rect width="100%" height="100%" fill="#3cae5f" opacity="'+svgNum(f.greenBias)+'" style="mix-blend-mode:hue"/><rect width="100%" height="100%" fill="#5fbe70" opacity="'+svgNum(f.greenBias*.42)+'" style="mix-blend-mode:saturation"/><rect width="100%" height="100%" fill="rgba(52,126,54,.18)" opacity="'+svgNum(f.greenBias*.32)+'" style="mix-blend-mode:soft-light"/></g>':"";
    var mowingPattern=mow?'<pattern id="cvMowingStripe" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(108)"><path d="M0 0 L0 24" stroke="rgba(255,255,255,.20)" stroke-width="1"/></pattern>':"";
    var mowingLayer=mow?'<rect width="100%" height="100%" fill="url(#cvMowingStripe)" opacity="'+mow+'"/>':"";
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+dims.width+'" height="'+dims.height+'" viewBox="0 0 '+dims.width+" "+dims.height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="'+escapeXml(role)+'" data-stage="'+escapeXml(stage)+'"'+(version?' data-version="'+escapeXml(version)+'"':"")+'><defs><filter id="cvNative"><feColorMatrix type="saturate" values="'+f.saturation+'"/><feComponentTransfer><feFuncR type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/><feFuncG type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/><feFuncB type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/></feComponentTransfer></filter><linearGradient id="cvNativeReadability" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,'+overlay.top+')"/><stop offset=".55" stop-color="rgba(255,255,255,0)"/><stop offset="1" stop-color="rgba(0,0,0,'+overlay.bottom+')"/></linearGradient>'+mowingPattern+(airbrush.defs||"")+(greenAirbrush.defs||"")+'</defs><rect width="100%" height="100%" fill="#10130f"/><g filter="url(#cvNative)">'+source+'</g>'+greenLayer+(airbrush.layer||"")+(greenAirbrush.layer||"")+'<rect width="100%" height="100%" fill="url(#cvNativeReadability)" opacity="'+overlay.opacity+'"/>'+mowingLayer+'</svg>';
    var metaOut=Object.assign({},meta);
    delete metaOut.objects;
    delete metaOut.airbrushObjects;
    return {dataUrl:dataUrl("image/svg+xml",svg),width:dims.width,height:dims.height,bounds:assetBounds,sourceCaptureIds:asset&&asset.sourceCaptureIds||[],metadata:Object.assign({},inheritedSurfaceMetadata(asset),{rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:role,stage:stage,inputRole:asset&&asset.metadata&&asset.metadata.role||"",inputStage:asset&&asset.metadata&&asset.metadata.stage||"",outputDimensions:dims,filter:f,fairwayAirbrush:airbrush.metadata,greenSurroundAirbrush:greenAirbrush.metadata},metaOut)};
  }
  function terrainShadeAsset(asset,terrainCaptures,meta){
    meta=meta||{};
    var dims=visualAssetDimensions(asset,meta.width,meta.height);
    var source=visualAssetSourceMarkup(asset,dims.width,dims.height);
    if(!source)return null;
    var bounds=visualAssetBounds(asset,meta.bounds);
    var strength=finite(meta.terrainStrength);
    if(strength==null)strength=String(meta.product||"")==="single-hole"?.9:.42;
    strength=clamp(strength,0,1.6);
    var terrainTileOpacity=clamp(.2+strength*.36,.2,.76);
    var terrainToneAlpha=clamp(.66+strength*.18,.66,.95);
    var terrainToneSlope=clamp(1.02+strength*.12,1.02,1.24);
    var reliefTop=clamp(.11+strength*.12,.1,.33);
    var reliefMid=clamp(.08+strength*.09,.07,.22);
    var reliefBottom=clamp(.14+strength*.12,.12,.36);
    var reliefOpacity=clamp(.28+strength*.34,.28,.82);
    var tintOpacity=clamp(.06+strength*.1,.05,.24);
    var hatchOpacity=clamp(.1+strength*.18,.08,.38);
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
        return '<g data-capture-id="'+escapeXml(capture.id)+'" data-role="terrain-reference" opacity="'+svgNum(terrainTileOpacity)+'" style="mix-blend-mode:multiply" filter="url(#terrainTone)" transform="translate('+svgNum(x)+" "+svgNum(y)+') scale('+svgNum(w/(Number(capture.width)||1))+" "+svgNum(h/(Number(capture.height)||1))+')">'+captureContentSvg(capture)+'</g>';
      }).join("");
    }
    var role=text(meta.role,80)||"terrain-view";
    var stage=text(meta.stage,80)||"terrain-shading";
    var terrainSource=terrain.length?"tile-reference-overlay":"deterministic-shading";
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+dims.width+'" height="'+dims.height+'" viewBox="0 0 '+dims.width+" "+dims.height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="'+escapeXml(role)+'" data-stage="'+escapeXml(stage)+'" data-terrain-strength="'+svgNum(strength)+'"><defs><filter id="terrainTone"><feColorMatrix type="matrix" values=".32 .32 .32 0 0 .30 .30 .30 0 0 .26 .26 .26 0 0 0 0 0 '+svgNum(terrainToneAlpha)+' 0"/><feComponentTransfer><feFuncR type="linear" slope="'+svgNum(terrainToneSlope)+'" intercept="-.03"/><feFuncG type="linear" slope="'+svgNum(terrainToneSlope)+'" intercept="-.03"/><feFuncB type="linear" slope="'+svgNum(terrainToneSlope)+'" intercept="-.03"/></feComponentTransfer></filter><linearGradient id="terrainRelief" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgba(255,255,255,'+svgNum(reliefTop)+')"/><stop offset=".42" stop-color="rgba(255,255,255,0)"/><stop offset=".68" stop-color="rgba(20,42,26,'+svgNum(reliefMid)+')"/><stop offset="1" stop-color="rgba(0,0,0,'+svgNum(reliefBottom)+')"/></linearGradient><pattern id="terrainHatch" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)"><path d="M0 0 L0 18" stroke="rgba(255,255,255,.10)" stroke-width="1"/></pattern></defs><rect width="100%" height="100%" fill="#10130f"/><g>'+source+'</g><rect width="100%" height="100%" fill="url(#terrainRelief)" opacity="'+svgNum(reliefOpacity)+'"/>'+terrainGroups+'<rect width="100%" height="100%" fill="rgba(44,67,42,'+svgNum(tintOpacity)+')"/><rect width="100%" height="100%" fill="url(#terrainHatch)" opacity="'+svgNum(hatchOpacity)+'"/></svg>';
    return {dataUrl:dataUrl("image/svg+xml",svg),width:dims.width,height:dims.height,bounds:bounds,sourceCaptureIds:sourceCaptureIds,metadata:Object.assign({},inheritedSurfaceMetadata(asset),{rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:role,stage:stage,terrainSource:terrainSource,terrainStrength:+strength.toFixed(3),inputRole:asset&&asset.metadata&&asset.metadata.role||"",inputStage:asset&&asset.metadata&&asset.metadata.stage||"",outputDimensions:dims},meta)};
  }
  function terrainViewSvg(record,terrainCaptures,meta){
    record=record||{};
    var base=record.previewVisual&&record.previewVisual.dataUrl?record.previewVisual:record.rawMaster&&record.rawMaster.dataUrl?record.rawMaster:record.basicVisual&&record.basicVisual.dataUrl?Object.assign({},record.basicVisual,{width:record.rawMaster&&record.rawMaster.width,height:record.rawMaster&&record.rawMaster.height,bounds:record.rawMaster&&record.rawMaster.bounds,metadata:Object.assign({},record.basicVisual&&record.basicVisual.metadata||{},{role:"basic"})}):null;
    if(!base)return null;
    return terrainShadeAsset(base,terrainCaptures,Object.assign({role:"terrain-view",stage:"terrain-shading",product:"course-overview",bounds:record.rawMaster&&record.rawMaster.bounds||record.input&&record.input.courseBounds||base.bounds||null},meta||{}));
  }
  function playViewportAsset(asset,meta){
    meta=meta||{};
    if(!asset||!asset.dataUrl)return null;
    var sourceWidth=Math.max(1,Math.round(Number(asset.width)||1));
    var sourceHeight=Math.max(1,Math.round(Number(asset.height)||1));
    var targetAspect=9/16;
    var width=Math.max(720,Math.min(4096,Math.round(sourceWidth)));
    var height=Math.round(width/targetAspect);
    var frameH=Math.min(height*.82,Math.max(height*.62,width*.92/targetAspect));
    var frameW=frameH*targetAspect;
    if(frameW>width*.84){
      frameW=width*.84;
      frameH=frameW/targetAspect;
    }
    var frameX=(width-frameW)/2;
    var frameY=(height-frameH)/2;
    var sourceBounds=visualAssetBounds(asset,meta.bounds);
    var playSurface=asset.metadata&&asset.metadata.playSurface||{};
    var pins=playSurface.anchorPins||asset.metadata&&asset.metadata.anchorPins||{};
    var anchors={
      tee:point(pins.tee||pins.start),
      green:point(pins.green||pins.target||pins.pin),
      route:points(pins.route),
      greenShape:points(pins.greenShape||pins.shape)
    };
    if(!anchors.route.length&&anchors.tee&&anchors.green)anchors.route=[anchors.tee,anchors.green];
    var projector=assetPointProjector(sourceBounds,sourceWidth,sourceHeight);
    var anchorPoints=(anchors.route||[]).concat(anchors.greenShape||[]);
    if(anchors.tee)anchorPoints.push(anchors.tee);
    if(anchors.green)anchorPoints.push(anchors.green);
    var projected=projector?anchorPoints.map(projector).filter(Boolean):[];
    if(!projected.length)projected=[{x:sourceWidth*.18,y:sourceHeight*.82},{x:sourceWidth*.82,y:sourceHeight*.18}];
    var teePx=projector&&anchors.tee?projector(anchors.tee):null;
    var greenPx=projector&&anchors.green?projector(anchors.green):null;
    var angle=0;
    var orientationSource="none";
    if(teePx&&greenPx&&Math.abs(greenPx.x-teePx.x)+Math.abs(greenPx.y-teePx.y)>1){
      angle=-Math.PI/2-Math.atan2(greenPx.y-teePx.y,greenPx.x-teePx.x);
      orientationSource="tee-green-anchor";
    }else if(projected.length>=2){
      var first=projected[0],last=projected[projected.length-1];
      angle=-Math.PI/2-Math.atan2(last.y-first.y,last.x-first.x);
      orientationSource="route-anchor";
      teePx=first;
      greenPx=last;
    }
    var rotated=projected.map(function(p){return rotateSvgPoint(p,angle);});
    var minX=Math.min.apply(null,rotated.map(function(p){return p.x;}));
    var maxX=Math.max.apply(null,rotated.map(function(p){return p.x;}));
    var minY=Math.min.apply(null,rotated.map(function(p){return p.y;}));
    var maxY=Math.max.apply(null,rotated.map(function(p){return p.y;}));
    var teeR=teePx?rotateSvgPoint(teePx,angle):null;
    var greenR=greenPx?rotateSvgPoint(greenPx,angle):null;
    var spanX=Math.max(1,maxX-minX);
    var spanY=Math.max(1,maxY-minY);
    var routeLen=teeR&&greenR?Math.sqrt(Math.pow(greenR.x-teeR.x,2)+Math.pow(greenR.y-teeR.y,2)):Math.sqrt(spanX*spanX+spanY*spanY);
    var padX=clamp(routeLen*.18,sourceWidth*.035,sourceWidth*.20);
    var padY=clamp(routeLen*.10,sourceHeight*.025,sourceHeight*.16);
    minX-=padX;maxX+=padX;minY-=padY;maxY+=padY;
    spanX=Math.max(1,maxX-minX);
    spanY=Math.max(1,maxY-minY);
    var focusScale=Math.min(frameW*.78/spanX,frameH*.80/spanY);
    var scale=clamp(focusScale,.16,3.2);
    var focusX=(minX+maxX)/2;
    var focusY=(minY+maxY)/2;
    if(teeR&&greenR){
      focusX=(teeR.x+greenR.x)/2;
      focusY=(teeR.y+greenR.y)/2;
    }
    var cx=frameX+frameW/2;
    var cy=frameY+frameH*.52;
    var cos=Math.cos(angle),sin=Math.sin(angle);
    var a=scale*cos,b=scale*sin,c=-scale*sin,d=scale*cos;
    var tx=cx-scale*focusX;
    var ty=cy-scale*focusY;
    var radius=Math.max(22,Math.min(58,frameW*.055));
    var matrix="matrix("+[a,b,c,d,tx,ty].map(svgNum).join(" ")+")";
    var angleDeg=angle*180/Math.PI;
    function sourcePointList(list){
      return (Array.isArray(list)?list:[]).map(function(item){return projector?projector(item):null;}).filter(Boolean);
    }
    var routePx=sourcePointList(anchors.route);
    var greenShapePx=sourcePointList(anchors.greenShape);
    var proofParts=[];
    if(greenShapePx.length>=3){
      proofParts.push('<polygon data-role="play-green-bound" points="'+greenShapePx.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'" fill="rgba(72,255,141,.16)" stroke="rgba(98,255,157,.94)" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>');
    }
    if(routePx.length>=2){
      proofParts.push('<polyline data-role="play-route-axis" points="'+routePx.map(function(p){return svgNum(p.x)+","+svgNum(p.y);}).join(" ")+'" fill="none" stroke="rgba(255,247,128,.94)" stroke-width="6" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>');
    }
    if(teePx)proofParts.push('<circle data-role="play-tee-anchor" cx="'+svgNum(teePx.x)+'" cy="'+svgNum(teePx.y)+'" r="12" fill="rgba(255,255,255,.92)" stroke="rgba(0,0,0,.72)" stroke-width="3" vector-effect="non-scaling-stroke"/>');
    if(greenPx)proofParts.push('<circle data-role="play-green-anchor" cx="'+svgNum(greenPx.x)+'" cy="'+svgNum(greenPx.y)+'" r="14" fill="rgba(84,255,144,.9)" stroke="rgba(0,0,0,.76)" stroke-width="3" vector-effect="non-scaling-stroke"/>');
    var objectOverlay=proofParts.length?'<g data-role="play-object-proof-overlay" data-orientation-source="'+escapeXml(orientationSource)+'">'+proofParts.join("")+'</g>':"";
    var source='<g transform="'+matrix+'">'+visualAssetSourceMarkup(asset,sourceWidth,sourceHeight)+objectOverlay+'</g>';
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="'+escapeXml(meta.role||"single-hole-play-viewport")+'" data-stage="'+escapeXml(meta.stage||"play-viewport")+'" data-framing-model="gps-play-viewport-over-hole-surface"><defs><mask id="cvPlayViewportDim"><rect width="100%" height="100%" fill="white"/><rect x="'+svgNum(frameX)+'" y="'+svgNum(frameY)+'" width="'+svgNum(frameW)+'" height="'+svgNum(frameH)+'" rx="'+svgNum(radius)+'" fill="black"/></mask><linearGradient id="cvPlayViewportGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.14)"/><stop offset=".48" stop-color="rgba(255,255,255,0)"/><stop offset="1" stop-color="rgba(0,0,0,.18)"/></linearGradient></defs><rect width="100%" height="100%" fill="#10130f"/>'+source+'<rect width="100%" height="100%" fill="rgba(0,0,0,.42)" mask="url(#cvPlayViewportDim)"/><rect x="'+svgNum(frameX)+'" y="'+svgNum(frameY)+'" width="'+svgNum(frameW)+'" height="'+svgNum(frameH)+'" rx="'+svgNum(radius)+'" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="'+svgNum(Math.max(4,width*.004))+'"/><rect x="'+svgNum(frameX+Math.max(10,frameW*.018))+'" y="'+svgNum(frameY+Math.max(10,frameW*.018))+'" width="'+svgNum(frameW-Math.max(20,frameW*.036))+'" height="'+svgNum(frameH-Math.max(20,frameW*.036))+'" rx="'+svgNum(Math.max(14,radius*.74))+'" fill="url(#cvPlayViewportGlass)" opacity=".78"/><rect x="'+svgNum(frameX-frameW*.018)+'" y="'+svgNum(frameY-frameW*.018)+'" width="'+svgNum(frameW+frameW*.036)+'" height="'+svgNum(frameH+frameW*.036)+'" rx="'+svgNum(radius+frameW*.018)+'" fill="none" stroke="rgba(102,255,159,.54)" stroke-width="2" stroke-dasharray="18 16"/></svg>';
    var sourceMeta=asset.metadata||{};
    var metaOut=Object.assign({},meta);
    delete metaOut.underlayAsset;
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,bounds:sourceBounds,captureId:asset.captureId,holeNumber:asset.holeNumber||sourceMeta.holeNumber||null,sourceCaptureIds:asset.sourceCaptureIds||[],metadata:Object.assign({},sourceMeta,{rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:meta.role||"single-hole-play-viewport",stage:meta.stage||"play-viewport",inputRole:sourceMeta.role||"",inputStage:sourceMeta.stage||"",product:meta.product||sourceMeta.product||"single-hole",captureLens:"mobile-hole",lensAspectRatio:targetAspect,windowShape:"mobile-hole-with-overflow",framingModel:"gps-play-viewport-over-hole-surface",orientationSource:orientationSource,rotationDeg:+angleDeg.toFixed(3),objectProofOverlay:{enabled:!!proofParts.length,routePoints:routePx.length,greenShapePoints:greenShapePx.length,tee:!!teePx,green:!!greenPx},playSurface:Object.assign({},playSurface,{useGpsPlayFraming:true,fallbackUnderlay:"live-gps",fallbackPolicy:"live-gps-only",viewportFrame:{x:+frameX.toFixed(2),y:+frameY.toFixed(2),width:+frameW.toFixed(2),height:+frameH.toFixed(2),aspectRatio:targetAspect},displayTransform:{x:+tx.toFixed(2),y:+ty.toFixed(2),scale:+scale.toFixed(4),rotationDeg:+angleDeg.toFixed(3),matrix:matrix,orientationSource:orientationSource},objectProofOverlay:{enabled:!!proofParts.length,routePoints:routePx.length,greenShapePoints:greenShapePx.length,tee:!!teePx,green:!!greenPx},overflowVisible:true}),sourceDimensions:{width:sourceWidth,height:sourceHeight},outputDimensions:{width:width,height:height},viewportFrame:{x:+frameX.toFixed(2),y:+frameY.toFixed(2),width:+frameW.toFixed(2),height:+frameH.toFixed(2),aspectRatio:targetAspect},overflowVisible:true},metaOut)};
  }
  function primaryHoleAsset(list,holeNumber){
    var assets=(Array.isArray(list)?list:[]).filter(function(asset){return asset&&asset.dataUrl;});
    if(!assets.length)return null;
    var target=Math.max(0,Math.round(Number(holeNumber)||0));
    if(target){
      var match=assets.filter(function(asset){return Math.round(Number(asset.holeNumber)||0)===target;})[0];
      if(match)return match;
    }
    return assets.slice().sort(function(a,b){return (Number(a.holeNumber)||999)-(Number(b.holeNumber)||999);})[0];
  }
  function beta3dVisualAsset(asset,meta){
    meta=meta||{};
    if(!asset||!asset.dataUrl)return null;
    var sourceWidth=Math.max(1,Math.round(Number(asset.width)||1));
    var sourceHeight=Math.max(1,Math.round(Number(asset.height)||1));
    var width=Math.max(720,Math.min(4096,Math.round(sourceWidth*.92)));
    var height=Math.max(520,Math.round(sourceHeight*.72));
    var captureTilt=finite(meta.captureTiltDeg);
    if(captureTilt==null)captureTilt=10;
    var playTilt=finite(meta.playTiltDeg);
    if(playTilt==null)playTilt=16;
    var topY=Math.round(height*.10);
    var bottomY=Math.round(height*.90);
    var topInset=Math.round(width*(.18+Math.min(24,Math.max(0,captureTilt))*.004));
    var bottomInset=Math.round(width*.045);
    var imgX=bottomInset;
    var imgY=topY;
    var imgW=width-bottomInset*2;
    var imgH=bottomY-topY;
    var image=visualAssetSourceMarkup(asset,sourceWidth,sourceHeight);
    var cameraModel="faux-3d-svg-perspective";
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="3d-view-beta" data-camera-model="'+escapeXml(cameraModel)+'"><defs><clipPath id="tiltClip"><polygon points="'+topInset+','+topY+' '+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+bottomInset+','+bottomY+'"/></clipPath><linearGradient id="depthShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.18)"/><stop offset=".50" stop-color="rgba(255,255,255,0)"/><stop offset="1" stop-color="rgba(0,0,0,.34)"/></linearGradient><linearGradient id="sideWall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(0,0,0,.45)"/><stop offset="1" stop-color="rgba(0,0,0,.10)"/></linearGradient></defs><rect width="100%" height="100%" fill="#10130f"/><polygon points="'+topInset+','+topY+' '+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+bottomInset+','+bottomY+'" fill="#182016" stroke="rgba(255,255,255,.30)" stroke-width="2"/><polygon points="'+topInset+','+topY+' '+bottomInset+','+bottomY+' 0,'+height+' 0,'+(bottomY+20)+'" fill="url(#sideWall)" opacity=".74"/><polygon points="'+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+width+','+height+' '+width+','+(bottomY+20)+'" fill="rgba(255,255,255,.06)" opacity=".78"/><g clip-path="url(#tiltClip)"><g transform="translate('+imgX+" "+imgY+') scale('+svgNum(imgW/sourceWidth)+" "+svgNum(imgH/sourceHeight)+')">'+image+'</g><rect x="'+imgX+'" y="'+imgY+'" width="'+imgW+'" height="'+imgH+'" fill="url(#depthShade)"/></g></svg>';
    var sourceMeta=asset.metadata||{};
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,bounds:asset.bounds,sourceCaptureIds:asset.sourceCaptureIds||[],metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:"3d-view-beta",stage:"3d-view-beta",holeNumber:asset.holeNumber||sourceMeta.holeNumber||null,cameraModel:cameraModel,captureTiltDeg:captureTilt,playTiltDeg:playTilt,nativePitchAvailable:false,mapCameraCapability:{provider:"leaflet",library:"leaflet",nativePitchAvailable:false,nativeBearingAvailable:false,pitchStrategy:"faux-tilt-svg",reason:"plain-leaflet-no-native-pitch"},cameraFallback:"leaflet-flat-capture-faux-tilt-stage",inputRole:sourceMeta.role||"",inputStage:sourceMeta.stage||"",sourceVisualPath:asset.path||"",outputDimensions:{width:width,height:height}},meta)};
  }
  function beta3dViewSvg(captures,meta){
    var valid=(Array.isArray(captures)?captures:[]).filter(renderableCapture).sort(function(a,b){
      var ah=Number(a.holeNumber)||999,bh=Number(b.holeNumber)||999;
      if(ah!==bh)return ah-bh;
      var as=Number(a.segmentIndex)||999,bs=Number(b.segmentIndex)||999;
      if(as!==bs)return as-bs;
      return String(a.id||"").localeCompare(String(b.id||""));
    });
    if(!valid.length)return null;
    var capture=valid[0];
    var sourceAsset=null;
    if(valid.length>1){
      sourceAsset=safe(function(){return stitchSvg(valid,{inputVisualId:meta&&meta.inputVisualId,courseId:meta&&meta.courseId,role:"3d-beta-source",stage:"faux-tilt-source"});},null);
    }
    var sourceWidth=Math.max(1,Math.round(Number(sourceAsset&&sourceAsset.width||capture.width)||1));
    var sourceHeight=Math.max(1,Math.round(Number(sourceAsset&&sourceAsset.height||capture.height)||1));
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
    var content=sourceAsset?visualAssetSourceMarkup(sourceAsset,sourceWidth,sourceHeight):captureContentSvg(capture);
    var capability=clone(capture.mapCameraCapability||null)||{};
    var nativePitch=valid.some(function(item){return item&&item.nativePitchAvailable===true||item&&item.mapCameraCapability&&item.mapCameraCapability.nativePitchAvailable===true;});
    var cameraModel=nativePitch?"native-pitch-capture":"faux-3d-svg-perspective";
    var labelText="3D view beta H"+(capture.holeNumber||"?")+" · "+(nativePitch?"native pitch":"faux tilt")+" "+captureTilt+" · play "+playTilt;
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-role="3d-view-beta" data-camera-model="'+escapeXml(cameraModel)+'"><defs><clipPath id="tiltClip"><polygon points="'+topInset+','+topY+' '+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+bottomInset+','+bottomY+'"/></clipPath><linearGradient id="depthShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.18)"/><stop offset=".50" stop-color="rgba(255,255,255,0)"/><stop offset="1" stop-color="rgba(0,0,0,.32)"/></linearGradient><linearGradient id="sideWall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(0,0,0,.42)"/><stop offset="1" stop-color="rgba(0,0,0,.08)"/></linearGradient></defs><rect width="100%" height="100%" fill="#10130f"/><polygon points="'+topInset+','+topY+' '+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+bottomInset+','+bottomY+'" fill="#182016" stroke="rgba(255,255,255,.30)" stroke-width="2"/><polygon points="'+topInset+','+topY+' '+bottomInset+','+bottomY+' 0,'+height+' 0,'+(bottomY+20)+'" fill="url(#sideWall)" opacity=".72"/><polygon points="'+(width-topInset)+','+topY+' '+(width-bottomInset)+','+bottomY+' '+width+','+height+' '+width+','+(bottomY+20)+'" fill="rgba(255,255,255,.055)" opacity=".78"/><g clip-path="url(#tiltClip)"><g transform="translate('+imgX+" "+imgY+') scale('+svgNum(imgW/sourceWidth)+" "+svgNum(imgH/sourceHeight)+')">'+content+'</g><rect x="'+imgX+'" y="'+imgY+'" width="'+imgW+'" height="'+imgH+'" fill="url(#depthShade)"/></g><g transform="translate(14 14)"><rect x="0" y="0" width="'+svgNum(Math.max(390,labelText.length*7.5))+'" height="31" rx="6" fill="rgba(0,0,0,.64)"/><text x="10" y="21" font-size="14" fill="#fff" font-family="system-ui, sans-serif" font-weight="900">'+escapeXml(labelText)+'</text></g><text x="16" y="'+(height-18)+'" font-size="12" fill="rgba(255,255,255,.72)" font-family="system-ui, sans-serif" font-weight="850">'+escapeXml(nativePitch?"Native pitch capture path detected":"Plain Leaflet source: fake perspective from flat captures")+'</text></svg>';
    var sourceIds=sourceAsset&&sourceAsset.sourceCaptureIds||valid.map(function(item){return item.id;}).filter(Boolean);
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,bounds:sourceAsset&&sourceAsset.bounds||captureBounds(capture),sourceCaptureIds:sourceIds,metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml",role:"3d-view-beta",stage:"3d-view-beta",holeNumber:capture.holeNumber||null,cameraModel:cameraModel,captureTiltDeg:captureTilt,playTiltDeg:playTilt,nativePitchAvailable:nativePitch,mapCameraCapability:capability.provider?capability:{provider:"leaflet",nativePitchAvailable:false,pitchStrategy:"faux-tilt-svg",reason:"plain-leaflet-no-native-pitch"},cameraFallback:nativePitch?"":"leaflet-flat-capture-faux-tilt-stage",outputDimensions:{width:width,height:height}},meta||{})};
  }
  function buildCourseVisualMaster(courseId,opts){
    opts=opts||{};
    courseId=slug(courseId);
    if(opts.forceRebuild===true)delete inFlightBuilds[courseId];
    if(inFlightBuilds[courseId])return inFlightBuilds[courseId];
    var buildRunId=text(opts.buildRunId||stableId("cv-run"),120);
    function newerBuildIsActive(latestRun){
      return !!(latestRun&&latestRun!==buildRunId&&stableIdStamp(latestRun)>stableIdStamp(buildRunId));
    }
    function finishBuild(record){
      var latest=getRecord(courseId);
      var latestRun=latest&&latest.diagnostics&&latest.diagnostics.activeBuildRunId||"";
      var latestHasWorking=!!(latest&&(latest.rawMaster||latest.basicVisual||latest.previewVisual||latest.singleHoleTerrainView));
      var recordHasWorking=!!(record&&(record.rawMaster||record.basicVisual||record.previewVisual||record.singleHoleTerrainView));
      if(newerBuildIsActive(latestRun)&&(!recordHasWorking||latestHasWorking))return latest;
      record.diagnostics=Object.assign({},record.diagnostics||{},{activeBuildRunId:null,completedBuildRunId:buildRunId});
      return putRecord(record);
    }
    var promise=Promise.resolve().then(function(){
      var record=getRecord(courseId);
      var latestRun=record&&record.diagnostics&&record.diagnostics.activeBuildRunId||"";
      if(newerBuildIsActive(latestRun))return record;
      var allCaptures=(Array.isArray(opts.captures)&&opts.captures.length?opts.captures:null)||transientCapturesByCourse[courseId]||capturesFromRecordRefs(record);
      var split=splitVisualCaptures(allCaptures);
      var captures=split.imagery;
      var capturePlan=Array.isArray(opts.capturePlan)?opts.capturePlan:(record.diagnostics&&record.diagnostics.capturePlan||[]);
      var capturePlanMeta=planSummary(capturePlan,split.all||[]);
      var beta3dExpected=!!split.beta3d.length;
      record.status="stitching";
      record.diagnostics=Object.assign({},record.diagnostics||{},{activeBuildRunId:buildRunId});
      recordEvent(record,"course-visual-stitch-started",{captureCount:(captures||[]).length,terrainReferenceCount:split.terrain.length,beta3dCaptureCount:split.beta3d.length});
      putRecord(record);
      var signature=captureSignature(captures||[]);
      var existingRenderer=record.rawMaster&&record.rawMaster.metadata&&record.rawMaster.metadata.rendererVersion;
      var existingAssetReady=!!(record.basicVisual&&(record.basicVisual.dataUrl||transientAssetDataByPath[record.basicVisual.path])||record.rawMaster&&(record.rawMaster.dataUrl||transientAssetDataByPath[record.rawMaster.path]));
      var existingExampleReady=!!(record.exampleHoleVisual&&(record.exampleHoleVisual.dataUrl||transientAssetDataByPath[record.exampleHoleVisual.path]));
      var expectedHoleFrameCount=captureHoleFrameCount(captures||[]);
      var existingHoleFramesReady=!expectedHoleFrameCount||Array.isArray(record.holeFrameVisuals)&&record.holeFrameVisuals.length>=expectedHoleFrameCount&&record.holeFrameVisuals.every(function(asset){return asset&&(asset.dataUrl||transientAssetDataByPath[asset.path]);});
      var terrainExpected=!!split.terrain.length;
      var existingTerrainReady=!terrainExpected||!!(record.terrainView&&(record.terrainView.dataUrl||transientAssetDataByPath[record.terrainView.path]));
      var existingBeta3dReady=!beta3dExpected||!!(record.beta3dView&&(record.beta3dView.dataUrl||transientAssetDataByPath[record.beta3dView.path]));
      if(record.rawMaster&&record.rawMaster.captureSignature===signature&&existingRenderer===RENDERER_VERSION&&record.basicVisual&&existingAssetReady&&existingExampleReady&&existingHoleFramesReady&&existingTerrainReady&&existingBeta3dReady){
        record.status=record.publishedVisual?"published":"basic-ready";
        recordEvent(record,"course-visual-basic-ready",{idempotent:true,version:record.currentVersion});
        return finishBuild(record);
      }
      try{
        var stitched=stitchSvg(captures||[],{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
        var version=(Number(record.currentVersion)||0)+1;
        var visualId=stableId("visual");
        var holeFrames=buildHoleFrameVisuals(captures||[],{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta,visualAssemblyUnderlayPath:"course-visuals/"+courseId+"/basic/"+version+".svg"});
        record.rawMaster={path:"course-visuals/"+courseId+"/raw/"+visualId+".svg",dataUrl:stitched.dataUrl,bounds:stitched.bounds,width:stitched.width,height:stitched.height,captureSignature:signature,metadata:stitched.metadata};
        record.basicVisual={path:"course-visuals/"+courseId+"/basic/"+version+".svg",dataUrl:stitched.dataUrl,version:version};
        record.holeFrameVisuals=holeFrames.map(function(frame){
          return {path:"course-visuals/"+courseId+"/holes/h"+(frame.holeNumber||"unknown")+"/base/"+version+".svg",dataUrl:frame.dataUrl,version:version,width:frame.width,height:frame.height,bounds:frame.bounds,captureId:frame.captureId,holeNumber:frame.holeNumber,sourceCaptureIds:frame.sourceCaptureIds,metadata:Object.assign({},frame.metadata||{},{visualAssemblyUnderlayPath:"course-visuals/"+courseId+"/basic/"+version+".svg"})};
        });
        var example=exampleHoleSvg(captures||[],{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
        if(!example)example=playViewportAsset(primaryHoleAsset(record.holeFrameVisuals),{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta,role:"example-hole",stage:"play-viewport",product:"single-hole"});
        if(example){
          record.exampleHoleVisual={path:"course-visuals/"+courseId+"/example/h"+(example.holeNumber||"hole")+"/"+version+".svg",dataUrl:example.dataUrl,width:example.width,height:example.height,bounds:example.bounds,captureId:example.captureId,holeNumber:example.holeNumber,metadata:example.metadata};
        }
        record.previewVisual=null;
        record.singleHolePreviewVisual=null;
        record.singleHoleTerrainView=null;
        record.holeFramePreviewVisuals=[];
        record.holeFrameTerrainViews=[];
        record.holeFramePublishedVisuals=[];
        var terrain=terrainViewSvg(record,split.terrain,{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
        if(terrain){
          record.terrainView={path:"course-visuals/"+courseId+"/terrain/"+version+".svg",dataUrl:terrain.dataUrl,version:version,width:terrain.width,height:terrain.height,bounds:terrain.bounds,sourceCaptureIds:terrain.sourceCaptureIds,metadata:terrain.metadata};
        }
        var beta3d=beta3dExpected?beta3dVisualAsset(record.exampleHoleVisual||primaryHoleAsset(record.holeFrameVisuals),{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta}):null;
        if(!beta3d&&beta3dExpected)beta3d=beta3dViewSvg(split.beta3d,{inputVisualId:record.id,courseId:courseId,captureSignature:signature,capturePlanSummary:capturePlanMeta});
        if(beta3d){
          record.beta3dView={path:"course-visuals/"+courseId+"/3d-beta/"+version+".svg",dataUrl:beta3d.dataUrl,version:version,width:beta3d.width,height:beta3d.height,bounds:beta3d.bounds,sourceCaptureIds:beta3d.sourceCaptureIds,metadata:beta3d.metadata};
        }
        record.currentVersion=version;
        record.status="basic-ready";
        record.lastError=null;
        record.diagnostics=Object.assign({},record.diagnostics||{},{capturePlanSummary:capturePlanMeta,stitchOutputDimensions:{width:stitched.width,height:stitched.height},terrainView:record.terrainView?{path:record.terrainView.path,sourceCaptureIds:record.terrainView.sourceCaptureIds,width:record.terrainView.width,height:record.terrainView.height}:{status:split.terrain.length?"failed":"missing-terrain-reference"},beta3dView:record.beta3dView?{path:record.beta3dView.path,sourceCaptureIds:record.beta3dView.sourceCaptureIds,width:record.beta3dView.width,height:record.beta3dView.height,metadata:record.beta3dView.metadata}:{status:beta3dExpected?"failed":"off"},missingCoverage:stitched.missingAreas,sourceCaptureIds:stitched.sourceCaptureIds,holeFrameCount:record.holeFrameVisuals.length,holeFrames:record.holeFrameVisuals.map(function(asset){return {holeNumber:asset.holeNumber,path:asset.path,width:asset.width,height:asset.height,sourceCaptureIds:asset.sourceCaptureIds};}),exampleHole:record.exampleHoleVisual?{captureId:record.exampleHoleVisual.captureId,holeNumber:record.exampleHoleVisual.holeNumber,width:record.exampleHoleVisual.width,height:record.exampleHoleVisual.height}:null});
        record.versions=(record.versions||[]).concat([{version:version,type:"basic",rawMasterPath:record.rawMaster.path,basicImagePath:record.basicVisual.path,terrainViewPath:record.terrainView&&record.terrainView.path||null,beta3dViewPath:record.beta3dView&&record.beta3dView.path||null,holeFramePaths:record.holeFrameVisuals.map(function(asset){return asset.path;}),sourceCaptureIds:stitched.sourceCaptureIds,createdAt:now(),metadata:Object.assign({},stitched.metadata||{},{holeFrameCount:record.holeFrameVisuals.length})}]);
        recordEvent(record,"course-visual-basic-ready",{version:version,width:stitched.width,height:stitched.height,missingAreas:stitched.missingAreas.length,terrainView:!!record.terrainView,beta3dView:!!record.beta3dView,holeFrameCount:record.holeFrameVisuals.length});
      }catch(error){
        record.status="failed";
        record.lastError={code:error&&error.code||"stitch-failed",message:error&&error.message||String(error)};
        record.diagnostics=Object.assign({},record.diagnostics||{},{stitchFailure:record.lastError});
        recordEvent(record,"course-visual-build-failed",record.lastError);
      }
      return finishBuild(record);
    });
    inFlightBuilds[courseId]=promise.finally(function(){delete inFlightBuilds[courseId];});
    return inFlightBuilds[courseId];
  }
  function filterForSettings(settings){
    var turf=settings&&settings.turf||{};
    var lighting=settings&&settings.lighting||{};
    var readability=settings&&settings.readability||{};
    var green=finite(turf.greenStrength);
    if(green==null)green=.35;
    green=clamp(green,0,3.5);
    var brightnessTarget=finite(lighting.brightnessTarget);
    if(brightnessTarget==null)brightnessTarget=52;
    brightnessTarget=clamp(brightnessTarget,5,115);
    var contrast=finite(lighting.contrastTarget);
    if(contrast==null)contrast=1;
    contrast=clamp(contrast,.55,2.2);
    var saturation=1+green*.55;
    var greenBias=clamp(green*.2,0,.62);
    var brightness=clamp(1+(brightnessTarget-52)/90,.45,1.75);
    var sharp=clamp(Number(readability.sharpness)||0,0,.8);
    return {saturation:+saturation.toFixed(3),brightness:+brightness.toFixed(3),contrast:+contrast.toFixed(3),sharpness:+sharp.toFixed(3),greenBias:+greenBias.toFixed(3)};
  }
  function terrainStrengthForProduct(settings,product){
    var tools=settings&&settings.visualTools||{};
    var strength=finite(String(product||"")==="single-hole"?tools.holeTerrainStrength:tools.courseTerrainStrength);
    if(strength==null)strength=String(product||"")==="single-hole"?.9:.42;
    return clamp(strength,0,1.6);
  }
  function previewSvg(record,settings,version){
    var base=record.rawMaster&&record.rawMaster.dataUrl?record.rawMaster:record.basicVisual&&record.basicVisual.dataUrl?Object.assign({},record.basicVisual,{width:record.rawMaster&&record.rawMaster.width,height:record.rawMaster&&record.rawMaster.height,bounds:record.rawMaster&&record.rawMaster.bounds}):null;
    if(!base)throw Object.assign(new Error("Raw master is not available"),{code:"raw-master-missing"});
    return nativeVisualAsset(base,settings,{role:"overview-native-visuals",stage:"native-visuals",version:version,product:"course-overview",airbrushObjects:Array.isArray(record.objects)?record.objects:[]}).dataUrl;
  }
  function saveCourseVisualSettings(courseId,overrides){
    var record=getRecord(courseId);
    record.courseOverrides=clone(overrides||{});
    record.settingsDirty=true;
    recordEvent(record,"course-visual-settings-saved",{published:false,overrideHash:hashString(record.courseOverrides)});
    return putRecord(record,{skipCloudSync:true});
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
        var airbrushObjects=Array.isArray(record.objects)?record.objects:[];
        var overviewNative=nativeVisualAsset(overviewBase,settings,{role:"overview-native-visuals",stage:"native-visuals",version:version,product:"course-overview",presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,airbrushObjects:airbrushObjects});
        record.previewVisual={path:"course-visuals/"+record.courseId+"/preview/"+version+".svg",dataUrl:overviewNative.dataUrl,version:version,width:overviewNative.width,height:overviewNative.height,bounds:overviewNative.bounds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:overviewNative.metadata};
        var overviewTerrain=terrainShadeAsset(record.previewVisual,split.terrain,{role:"terrain-view",stage:"terrain-shading",version:version,product:"course-overview",terrainStrength:terrainStrengthForProduct(settings,"course-overview"),bounds:record.previewVisual.bounds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
        if(overviewTerrain){
          record.terrainView={path:"course-visuals/"+record.courseId+"/terrain/"+version+".svg",dataUrl:overviewTerrain.dataUrl,version:version,width:overviewTerrain.width,height:overviewTerrain.height,bounds:overviewTerrain.bounds,sourceCaptureIds:overviewTerrain.sourceCaptureIds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:overviewTerrain.metadata};
        }
        if(record.exampleHoleVisual&&record.exampleHoleVisual.dataUrl){
          var holeNative=nativeVisualAsset(record.exampleHoleVisual,settings,{role:"single-hole-native-visuals",stage:"native-visuals",version:version,product:"single-hole",holeNumber:record.exampleHoleVisual.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,airbrushObjects:airbrushObjects});
          record.singleHolePreviewVisual={path:"course-visuals/"+record.courseId+"/single-hole/preview/"+version+".svg",dataUrl:holeNative.dataUrl,version:version,width:holeNative.width,height:holeNative.height,bounds:holeNative.bounds,captureId:record.exampleHoleVisual.captureId,holeNumber:record.exampleHoleVisual.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:holeNative.metadata};
          var holeTerrain=terrainShadeAsset(record.singleHolePreviewVisual,split.terrain,{role:"single-hole-terrain",stage:"terrain-shading",version:version,product:"single-hole",terrainStrength:terrainStrengthForProduct(settings,"single-hole"),bounds:record.singleHolePreviewVisual.bounds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
          if(holeTerrain){
            record.singleHoleTerrainView={path:"course-visuals/"+record.courseId+"/single-hole/terrain/"+version+".svg",dataUrl:holeTerrain.dataUrl,version:version,width:holeTerrain.width,height:holeTerrain.height,bounds:holeTerrain.bounds,sourceCaptureIds:holeTerrain.sourceCaptureIds,captureId:record.exampleHoleVisual.captureId,holeNumber:record.exampleHoleVisual.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:holeTerrain.metadata};
          }
        }
        record.holeFramePreviewVisuals=[];
        record.holeFrameTerrainViews=[];
        (Array.isArray(record.holeFrameVisuals)?record.holeFrameVisuals:[]).forEach(function(frame){
          if(!frame||!frame.dataUrl)return;
          var holeNumber=Math.max(0,Math.round(Number(frame.holeNumber)||0));
          if(!holeNumber)return;
          var frameNative=nativeVisualAsset(frame,settings,{role:"hole-frame-native-visuals",stage:"native-visuals",version:version,product:"hole-frame",holeNumber:holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,airbrushObjects:airbrushObjects,visualAssemblyUnderlayPath:record.basicVisual&&record.basicVisual.path||""});
          var framePreview={path:"course-visuals/"+record.courseId+"/holes/h"+holeNumber+"/preview/"+version+".svg",dataUrl:frameNative.dataUrl,version:version,width:frameNative.width,height:frameNative.height,bounds:frameNative.bounds,captureId:frame.captureId,holeNumber:holeNumber,sourceCaptureIds:frameNative.sourceCaptureIds&&frameNative.sourceCaptureIds.length?frameNative.sourceCaptureIds:frame.sourceCaptureIds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:Object.assign({},frameNative.metadata||{},{playSurface:Object.assign({},frame.metadata&&frame.metadata.playSurface||{},{fallbackUnderlay:"live-gps",fallbackPolicy:"live-gps-only"})})};
          record.holeFramePreviewVisuals.push(framePreview);
          var frameTerrain=terrainShadeAsset(framePreview,split.terrain,{role:"hole-frame-terrain",stage:"terrain-shading",version:version,product:"hole-frame",holeNumber:holeNumber,terrainStrength:terrainStrengthForProduct(settings,"single-hole"),bounds:framePreview.bounds,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,visualAssemblyUnderlayPath:record.basicVisual&&record.basicVisual.path||""});
          if(frameTerrain){
            record.holeFrameTerrainViews.push({path:"course-visuals/"+record.courseId+"/holes/h"+holeNumber+"/terrain/"+version+".svg",dataUrl:frameTerrain.dataUrl,version:version,width:frameTerrain.width,height:frameTerrain.height,bounds:frameTerrain.bounds,sourceCaptureIds:frameTerrain.sourceCaptureIds,captureId:frame.captureId,holeNumber:holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:Object.assign({},frameTerrain.metadata||{},{playSurface:Object.assign({},frame.metadata&&frame.metadata.playSurface||{},{fallbackUnderlay:"live-gps",fallbackPolicy:"live-gps-only"})})});
          }
        });
        var visibleHoleNumber=record.exampleHoleVisual&&record.exampleHoleVisual.holeNumber;
        var holeViewportSource=primaryHoleAsset(record.holeFramePreviewVisuals,visibleHoleNumber);
        var holeTerrainViewportSource=primaryHoleAsset(record.holeFrameTerrainViews,visibleHoleNumber)||holeViewportSource;
        if(!record.singleHolePreviewVisual&&holeViewportSource){
          var holeViewport=playViewportAsset(holeViewportSource,{role:"single-hole-native-visuals",stage:"native-visuals",version:version,product:"single-hole",holeNumber:holeViewportSource.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
          if(holeViewport){
            record.singleHolePreviewVisual={path:"course-visuals/"+record.courseId+"/single-hole/preview/"+version+".svg",dataUrl:holeViewport.dataUrl,version:version,width:holeViewport.width,height:holeViewport.height,bounds:holeViewport.bounds,captureId:holeViewport.captureId||holeViewportSource.captureId,holeNumber:holeViewport.holeNumber||holeViewportSource.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:holeViewport.metadata};
          }
        }
        if(!record.singleHoleTerrainView&&holeTerrainViewportSource){
          var holeTerrainViewport=playViewportAsset(holeTerrainViewportSource,{role:"single-hole-terrain",stage:"terrain-shading",version:version,product:"single-hole",holeNumber:holeTerrainViewportSource.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
          if(holeTerrainViewport){
            record.singleHoleTerrainView={path:"course-visuals/"+record.courseId+"/single-hole/terrain/"+version+".svg",dataUrl:holeTerrainViewport.dataUrl,version:version,width:holeTerrainViewport.width,height:holeTerrainViewport.height,bounds:holeTerrainViewport.bounds,sourceCaptureIds:holeTerrainViewport.sourceCaptureIds,captureId:holeTerrainViewport.captureId||holeTerrainViewportSource.captureId,holeNumber:holeTerrainViewport.holeNumber||holeTerrainViewportSource.holeNumber,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,metadata:holeTerrainViewport.metadata};
          }
        }
        var betaSource=record.singleHoleTerrainView||record.singleHolePreviewVisual||primaryHoleAsset(record.holeFrameTerrainViews,visibleHoleNumber)||primaryHoleAsset(record.holeFramePreviewVisuals,visibleHoleNumber);
        if(record.beta3dView&&betaSource){
          var betaFromSurface=beta3dVisualAsset(betaSource,{inputVisualId:record.id,courseId:record.courseId,version:version,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash});
          if(betaFromSurface){
            record.beta3dView={path:"course-visuals/"+record.courseId+"/3d-beta/"+version+".svg",dataUrl:betaFromSurface.dataUrl,version:version,width:betaFromSurface.width,height:betaFromSurface.height,bounds:betaFromSurface.bounds,sourceCaptureIds:betaFromSurface.sourceCaptureIds,metadata:betaFromSurface.metadata};
          }
        }
        record.presetId=preset.id;
        record.presetVersion=preset.version;
        record.courseOverrides=courseOverrides;
        record.currentVersion=version;
        record.status="preview-ready";
        record.settingsDirty=false;
        record.lastError=null;
        record.diagnostics=Object.assign({},record.diagnostics||{},{preview:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml",outputDimensions:{width:record.previewVisual&&record.previewVisual.width,height:record.previewVisual&&record.previewVisual.height},presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,products:{overview:{native:!!record.previewVisual,terrain:!!record.terrainView},singleHole:{base:!!record.exampleHoleVisual,native:!!record.singleHolePreviewVisual,terrain:!!record.singleHoleTerrainView},holeFrames:{base:(record.holeFrameVisuals||[]).length,native:record.holeFramePreviewVisuals.length,terrain:record.holeFrameTerrainViews.length}}}});
        record.versions=(record.versions||[]).concat([{version:version,type:"preview",previewImagePath:record.previewVisual.path,terrainViewPath:record.terrainView&&record.terrainView.path||null,singleHolePreviewPath:record.singleHolePreviewVisual&&record.singleHolePreviewVisual.path||null,singleHoleTerrainPath:record.singleHoleTerrainView&&record.singleHoleTerrainView.path||null,holeFramePreviewPaths:record.holeFramePreviewVisuals.map(function(asset){return asset.path;}),holeFrameTerrainPaths:record.holeFrameTerrainViews.map(function(asset){return asset.path;}),presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,createdAt:now(),metadata:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml",products:["course-overview","single-hole","hole-frames"],stages:["native-visuals","terrain-shading"]}}]);
        recordEvent(record,"course-visual-preview-ready",{version:version,presetId:preset.id,presetVersion:preset.version,overviewTerrain:!!record.terrainView,singleHoleTerrain:!!record.singleHoleTerrainView,holeFrameTerrainCount:record.holeFrameTerrainViews.length});
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
    var frameSources=(Array.isArray(record.holeFrameTerrainViews)&&record.holeFrameTerrainViews.length?record.holeFrameTerrainViews:Array.isArray(record.holeFramePreviewVisuals)&&record.holeFramePreviewVisuals.length?record.holeFramePreviewVisuals:record.holeFrameVisuals||[]).filter(function(asset){return asset&&asset.dataUrl;});
    record.holeFramePublishedVisuals=frameSources.map(function(asset){
      var holeNumber=Math.max(0,Math.round(Number(asset.holeNumber)||0));
      if(!holeNumber)return null;
      return {path:"course-visuals/"+record.courseId+"/holes/h"+holeNumber+"/published/"+version+".svg",dataUrl:asset.dataUrl,version:version,width:asset.width,height:asset.height,bounds:asset.bounds,captureId:asset.captureId,holeNumber:holeNumber,sourceCaptureIds:asset.sourceCaptureIds,presetId:preview.presetId,presetVersion:preview.presetVersion,overrideHash:preview.overrideHash,publishedAt:record.publishedVisual.publishedAt,metadata:Object.assign({},asset.metadata||{},{role:"hole-frame-published",publishedFrom:asset.metadata&&asset.metadata.role||"hole-frame",publishedOverviewPath:record.publishedVisual.path,playSurface:Object.assign({},asset.metadata&&asset.metadata.playSurface||{},{fallbackUnderlay:"live-gps",fallbackPolicy:"live-gps-only",publishedOverviewPath:record.publishedVisual.path})})};
    }).filter(Boolean).sort(function(a,b){return Number(a.holeNumber)-Number(b.holeNumber);});
    record.publishedVersion=version;
    record.status="published";
    record.lastError=null;
    record.versions=(record.versions||[]).concat([{version:version,type:"published",publishedImagePath:record.publishedVisual.path,singleHolePublishedPath:record.singleHolePublishedVisual&&record.singleHolePublishedVisual.path||null,holeFramePublishedPaths:record.holeFramePublishedVisuals.map(function(asset){return asset.path;}),presetId:preview.presetId,presetVersion:preview.presetVersion,overrideHash:preview.overrideHash,createdAt:record.publishedVisual.publishedAt,metadata:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml",publishedProducts:["course-overview","single-hole","hole-frames"],publishedStages:["terrain-shading","native-visuals"],holeFramePublishedCount:record.holeFramePublishedVisuals.length}}]);
    recordEvent(record,"course-visual-published",{version:version,presetId:preview.presetId,presetVersion:preview.presetVersion,overviewStage:overviewFinal&&overviewFinal.metadata&&overviewFinal.metadata.stage||"",singleHoleStage:singleHoleFinal&&singleHoleFinal.metadata&&singleHoleFinal.metadata.stage||"",holeFramePublishedCount:record.holeFramePublishedVisuals.length});
    return putRecord(record,{skipCloudSync:true});
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
    record.holeFramePreviewVisuals=[];
    record.holeFrameTerrainViews=[];
    record.settingsDirty=false;
    record.courseOverrides={};
    record.status=record.publishedVisual?"published":record.basicVisual?"basic-ready":"unavailable";
    recordEvent(record,"course-visual-settings-saved",{reset:"published"});
    return putRecord(record);
  }
  function resetCourseVisualWorkingState(courseId,opts){
    opts=opts||{};
    var record=getRecord(courseId);
    var keepPublished=opts.keepPublished!==false;
    delete transientCapturesByCourse[record.courseId];
    record.rawMaster=null;
    record.basicVisual=null;
    record.exampleHoleVisual=null;
    record.holeFrameVisuals=[];
    record.previewVisual=null;
    record.terrainView=null;
    record.singleHolePreviewVisual=null;
    record.singleHoleTerrainView=null;
    record.holeFramePreviewVisuals=[];
    record.holeFrameTerrainViews=[];
    record.beta3dView=null;
    record.captureRefs=[];
    record.input=null;
    if(!keepPublished){
      record.publishedVisual=null;
      record.singleHolePublishedVisual=null;
      record.holeFramePublishedVisuals=[];
      record.publishedVersion=0;
    }
    record.status=record.publishedVisual?"published":"unavailable";
    record.lastError=null;
    record.diagnostics=Object.assign({},record.diagnostics||{},{capturePlanSummary:null,captureExecution:null,recaptureRequestedAt:now(),recaptureKeptPublished:keepPublished});
    recordEvent(record,"course-visual-recapture-reset",{keepPublished:keepPublished});
    return putRecord(record,{skipCloudSync:true});
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
  function assetListForOutput(list,includeData){
    return (Array.isArray(list)?list:[]).filter(Boolean).map(function(asset){
      var out={path:asset.path,version:asset.version,presetId:asset.presetId,presetVersion:asset.presetVersion,holeNumber:asset.holeNumber,width:asset.width,height:asset.height,bounds:asset.bounds,sourceCaptureIds:asset.sourceCaptureIds,metadata:asset.metadata};
      if(includeData)out.dataUrl=asset.dataUrl;
      return out;
    });
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
      holeFrameVisuals:assetListForOutput(record.holeFrameVisuals,true),
      holeFramePreviewVisuals:assetListForOutput(record.holeFramePreviewVisuals,true),
      holeFrameTerrainViews:assetListForOutput(record.holeFrameTerrainViews,true),
      previewVisual:record.previewVisual?{path:record.previewVisual.path,dataUrl:record.previewVisual.dataUrl,version:record.previewVisual.version,presetId:record.previewVisual.presetId,presetVersion:record.previewVisual.presetVersion}:undefined,
      publishedVisual:record.publishedVisual?{path:record.publishedVisual.path,dataUrl:record.publishedVisual.dataUrl,version:record.publishedVisual.version,presetId:record.publishedVisual.presetId,presetVersion:record.publishedVisual.presetVersion}:undefined,
      singleHolePublishedVisual:record.singleHolePublishedVisual?{path:record.singleHolePublishedVisual.path,dataUrl:record.singleHolePublishedVisual.dataUrl,version:record.singleHolePublishedVisual.version,presetId:record.singleHolePublishedVisual.presetId,presetVersion:record.singleHolePublishedVisual.presetVersion,holeNumber:record.singleHolePublishedVisual.holeNumber}:undefined,
      holeFramePublishedVisuals:assetListForOutput(record.holeFramePublishedVisuals,true),
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
      holeFrameVisuals:assetListForOutput(record.holeFrameVisuals,false),
      holeFramePreviewVisuals:assetListForOutput(record.holeFramePreviewVisuals,false),
      holeFrameTerrainViews:assetListForOutput(record.holeFrameTerrainViews,false),
      previewVisual:record.previewVisual?{path:record.previewVisual.path,version:record.previewVisual.version,presetId:record.previewVisual.presetId,presetVersion:record.previewVisual.presetVersion}:undefined,
      publishedVisual:record.publishedVisual?{path:record.publishedVisual.path,version:record.publishedVisual.version,presetId:record.publishedVisual.presetId,presetVersion:record.publishedVisual.presetVersion}:undefined,
      singleHolePublishedVisual:record.singleHolePublishedVisual?{path:record.singleHolePublishedVisual.path,version:record.singleHolePublishedVisual.version,presetId:record.singleHolePublishedVisual.presetId,presetVersion:record.singleHolePublishedVisual.presetVersion,holeNumber:record.singleHolePublishedVisual.holeNumber}:undefined,
      holeFramePublishedVisuals:assetListForOutput(record.holeFramePublishedVisuals,false),
      error:record.lastError||undefined
    };
  }
  function cloudActor(){
    return safe(function(){
      var api=root.GolfDaddyAccounts||root.ClarityCaddieAccounts;
      var current=api&&typeof api.current==="function"?api.current():null;
      var body=root.document&&root.document.body;
      return {
        role:current&&current.role||current&&current.permission||body&&body.dataset&&body.dataset.gdPermission||"",
        email:current&&current.email||current&&current.accountEmail||"",
        accountId:current&&current.accountId||current&&current.account_id||""
      };
    },{role:"",email:"",accountId:""});
  }
  function queueCloudSync(record,reason){
    if(!root||typeof root.fetch!=="function"||!record||record.__syncing)return;
    var actor=cloudActor();
    if(String(actor.role||"").toLowerCase()!=="admin")return;
    setTimeout(function(){
      syncPublishedCourseVisual(record,reason||"metadata",{silent:true}).catch(function(){});
    },20);
  }
  function syncPublishedCourseVisual(recordOrCourseId,reason,opts){
    opts=opts||{};
    var record=typeof recordOrCourseId==="string"?getRecord(recordOrCourseId):attachTransientAssets(clone(recordOrCourseId||{}));
    if(!record||!record.courseId)return Promise.reject(Object.assign(new Error("Course visual record is required"),{code:"course-visual-missing"}));
    if(!root||typeof root.fetch!=="function")return Promise.reject(Object.assign(new Error("Cloud publish endpoint is not available"),{code:"course-visual-cloud-unavailable"}));
    var actor=safe(function(){
      return cloudActor();
    },{role:"",email:"",accountId:""});
    if(String(actor.role||"").toLowerCase()!=="admin")return Promise.reject(Object.assign(new Error("Admin account is required to publish course visuals to Clarity Cloud"),{code:"course-visual-admin-required"}));
    if(!record.publishedVisual)return Promise.reject(Object.assign(new Error("Publish a course visual before syncing it to Clarity Cloud"),{code:"course-visual-published-missing"}));
    var body={action:"upsert",reason:reason||"local",actor:actor,visual:metadataForCloud(record)};
    record.__syncing=true;
    return root.fetch(API_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(body)}).then(function(response){
      return response.text().then(function(textBody){
        var data=null;
        if(textBody){try{data=JSON.parse(textBody);}catch(_error){data={error:textBody};}}
        if(!response.ok){
          var message=data&&data.error||("Course visual cloud publish failed with HTTP "+response.status);
          throw Object.assign(new Error(message),{code:"course-visual-cloud-failed",status:response.status,body:data});
        }
        var fresh=getRecord(record.courseId);
        fresh.diagnostics=Object.assign({},fresh.diagnostics||{},{cloudPublish:{storage:data&&data.storage||"unknown",syncedAt:now(),reason:reason||"publish",playPayloadReady:!!(data&&(data.play_payload||data.playPayload)),publishedImagePath:body.visual&&body.visual.published_image_path||""}});
        recordEvent(fresh,"course-visual-cloud-published",{storage:data&&data.storage||"unknown",playPayloadReady:!!(data&&(data.play_payload||data.playPayload)),reason:reason||"publish"});
        putRecord(fresh,{skipCloudSync:true});
        return data||{};
      });
    }).finally(function(){record.__syncing=false;});
  }
  function metadataForCloud(record){
    function assetPayload(asset,role){
      if(!asset||!asset.dataUrl)return null;
      return {path:asset.path,dataUrl:asset.dataUrl,contentType:"image/svg+xml",role:role,holeNumber:asset.holeNumber||asset.metadata&&asset.metadata.holeNumber||null,metadata:asset.metadata||null};
    }
    var assets=[
      assetPayload(record.rawMaster,"raw-master"),
      assetPayload(record.basicVisual,"basic"),
      assetPayload(record.exampleHoleVisual,"example-hole"),
      assetPayload(record.previewVisual,"preview"),
      assetPayload(record.terrainView,"terrain-view"),
      assetPayload(record.singleHolePreviewVisual,"single-hole-preview"),
      assetPayload(record.singleHoleTerrainView,"single-hole-terrain"),
      assetPayload(record.publishedVisual,"published"),
      assetPayload(record.singleHolePublishedVisual,"single-hole-published")
    ].filter(Boolean);
    (Array.isArray(record.holeFrameVisuals)?record.holeFrameVisuals:[]).forEach(function(asset){var payload=assetPayload(asset,"hole-frame");if(payload)assets.push(payload);});
    (Array.isArray(record.holeFramePreviewVisuals)?record.holeFramePreviewVisuals:[]).forEach(function(asset){var payload=assetPayload(asset,"hole-frame-preview");if(payload)assets.push(payload);});
    (Array.isArray(record.holeFrameTerrainViews)?record.holeFrameTerrainViews:[]).forEach(function(asset){var payload=assetPayload(asset,"hole-frame-terrain");if(payload)assets.push(payload);});
    (Array.isArray(record.holeFramePublishedVisuals)?record.holeFramePublishedVisuals:[]).forEach(function(asset){var payload=assetPayload(asset,"hole-frame-published");if(payload)assets.push(payload);});
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
    var assets=Array.isArray(row.assets)?row.assets:Array.isArray(row.uploaded_assets)?row.uploaded_assets:Array.isArray(row.uploadedAssets)?row.uploadedAssets:[];
    function assetForRole(role){return assets.filter(function(asset){return asset&&asset.role===role&&asset.path;})[0]||null;}
    function assetsForRole(role){return assets.filter(function(asset){return asset&&asset.role===role&&asset.path;}).sort(function(a,b){return Number(a.holeNumber||a.hole_number||0)-Number(b.holeNumber||b.hole_number||0);});}
    function restoredFrameAsset(asset,version){
      return {path:asset.path,dataUrl:asset.dataUrl,version:version,presetId:record.presetId,presetVersion:record.presetVersion,holeNumber:asset.holeNumber||asset.hole_number||null,metadata:asset.metadata||{}};
    }
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
    if(!record.holeFrameVisuals||!record.holeFrameVisuals.length)record.holeFrameVisuals=assetsForRole("hole-frame").map(function(asset){return restoredFrameAsset(asset,record.currentVersion||1);});
    if(!record.holeFramePreviewVisuals||!record.holeFramePreviewVisuals.length)record.holeFramePreviewVisuals=assetsForRole("hole-frame-preview").map(function(asset){return restoredFrameAsset(asset,record.currentVersion||1);});
    if(!record.holeFrameTerrainViews||!record.holeFrameTerrainViews.length)record.holeFrameTerrainViews=assetsForRole("hole-frame-terrain").map(function(asset){return restoredFrameAsset(asset,record.currentVersion||1);});
    if(!record.holeFramePublishedVisuals||!record.holeFramePublishedVisuals.length)record.holeFramePublishedVisuals=assetsForRole("hole-frame-published").map(function(asset){return restoredFrameAsset(asset,record.publishedVersion||record.currentVersion||1);});
    return putRecord(record,{skipCloudSync:true});
  }
  function pullCourseVisual(courseId){
    if(!root||typeof root.fetch!=="function")return Promise.resolve(getRecord(courseId));
    return root.fetch(API_ENDPOINT+"?courseId="+encodeURIComponent(slug(courseId)),{headers:{Accept:"application/json"},cache:"no-store"}).then(function(res){return res.ok?res.json():null;}).then(function(data){
      var row=data&&data.visual||null;
      return row?restoreCloudMetadata(row):getRecord(courseId);
    }).catch(function(){return getRecord(courseId);});
  }
  function captureCandidateList(output){
    if(!output)return [];
    if(Array.isArray(output))return output.map(function(item,index){return {manifest:item,raw:item,index:index};});
    var keys=["candidates","snapshotCandidates","captureCandidates","snapshots","olderSnapshots","alternateSnapshots","alternates","manifests"];
    for(var i=0;i<keys.length;i++){
      var list=output&&output[keys[i]];
      if(Array.isArray(list)&&list.length){
        return list.map(function(item,index){
          var manifest=item&&typeof item==="object"&&(item.manifest||item.captureManifest||item.tileManifest||item.snapshotManifest)||item;
          return {manifest:manifest,raw:item,index:index,source:keys[i]};
        });
      }
    }
    return [{manifest:output,raw:output,index:0,source:"single"}];
  }
  function pathValue(source,path){
    var parts=String(path||"").split(".");
    var value=source;
    for(var i=0;i<parts.length;i++){
      if(!value||typeof value!=="object")return undefined;
      value=value[parts[i]];
    }
    return value;
  }
  function normalizedMetric(value){
    var n=finite(value);
    if(n==null)return null;
    if(n>10)n=n/100;
    else if(n>1)n=n/10;
    return clamp(n,0,1);
  }
  function snapshotMetric(sources,names){
    var nested=["","analysis","visualAnalysis","snapshotAnalysis","quality","qualityMetrics","metrics","scores","metadata"];
    for(var s=0;s<sources.length;s++){
      var source=sources[s];
      if(!source||typeof source!=="object")continue;
      for(var n=0;n<nested.length;n++){
        var base=nested[n]?pathValue(source,nested[n]):source;
        if(!base||typeof base!=="object")continue;
        for(var i=0;i<names.length;i++){
          var value=pathValue(base,names[i]);
          var metric=normalizedMetric(value);
          if(metric!=null)return metric;
        }
      }
    }
    return null;
  }
  function scoreSnapshotCandidate(entry,total){
    var manifest=entry&&entry.manifest||{};
    var raw=entry&&entry.raw||{};
    var sources=[raw,manifest];
    var green=snapshotMetric(sources,["greenLushnessScore","greenLushness","lushnessScore","lushness","greenScore","greenCoverage","greenVisibility","turfLushness","grassHealthScore","vegetationScore"]);
    var fairway=snapshotMetric(sources,["fairwayLineScore","fairwayLinesScore","fairwayLines","fairwayLineVisibility","lineVisibility","mowingLineScore","mowingLines","fairwayDefinition","fairwayContrast","corridorLineScore"]);
    var hasGreen=green!=null;
    var hasFairway=fairway!=null;
    var score=0;
    var balance=0;
    if(hasGreen&&hasFairway){
      var avg=(green+fairway)/2;
      var floor=Math.min(green,fairway);
      balance=1-Math.abs(green-fairway);
      score=floor*.55+avg*.32+balance*.13;
    }else if(hasFairway){
      score=fairway*.78+.05;
      balance=fairway*.5;
    }else if(hasGreen){
      score=green*.62;
      balance=green*.45;
    }
    var candidateId=text(raw&&raw.candidateId||raw&&raw.snapshotCandidateId||manifest&&manifest.candidateId||manifest&&manifest.snapshotCandidateId||manifest&&manifest.snapshotId||manifest&&manifest.snapshotKey||manifest&&manifest.key,180);
    return {
      candidateId:candidateId,
      candidateIndex:Number(entry&&entry.index||0)+1,
      candidateCount:Math.max(1,Number(total)||1),
      greenLushnessScore:green,
      fairwayLineScore:fairway,
      snapshotBalanceScore:hasGreen&&hasFairway?balance:null,
      snapshotSelectionScore:score,
      snapshotSelectionReason:hasGreen&&hasFairway?"balanced-lushness-and-fairway-lines":hasFairway?"fairway-line-only-score":hasGreen?"lushness-only-score":"no-snapshot-quality-metrics"
    };
  }
  function compareSnapshotOptions(a,b){
    var scoreDelta=Number(b.score.snapshotSelectionScore||0)-Number(a.score.snapshotSelectionScore||0);
    if(Math.abs(scoreDelta)>.025)return scoreDelta;
    var af=a.score.fairwayLineScore==null?-1:Number(a.score.fairwayLineScore);
    var bf=b.score.fairwayLineScore==null?-1:Number(b.score.fairwayLineScore);
    var fairwayDelta=bf-af;
    if(Math.abs(fairwayDelta)>.001)return fairwayDelta;
    var ag=a.score.greenLushnessScore==null?-1:Number(a.score.greenLushnessScore);
    var bg=b.score.greenLushnessScore==null?-1:Number(b.score.greenLushnessScore);
    var greenDelta=bg-ag;
    if(Math.abs(greenDelta)>.001)return greenDelta;
    return Number(a.score.candidateIndex||0)-Number(b.score.candidateIndex||0);
  }
  function selectCaptureCandidate(output,item){
    var entries=captureCandidateList(output);
    var options=[];
    entries.forEach(function(entry){
      var score=scoreSnapshotCandidate(entry,entries.length);
      var capture=manifestToCapture(entry.manifest,Object.assign({},item||{},score));
      if(capture&&capture.width&&capture.height&&captureBounds(capture)&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData)){
        options.push({capture:capture,score:score});
      }
    });
    if(!options.length)return null;
    options.sort(compareSnapshotOptions);
    var selected=options[0];
    var diagnostic=null;
    if(options.length>1||selected.score.greenLushnessScore!=null||selected.score.fairwayLineScore!=null){
      diagnostic={
        planId:item&&item.id||item&&item.planId||"",
        role:item&&item.role||"",
        holeNumber:item&&item.holeNumber||null,
        selectedCaptureId:selected.capture&&selected.capture.id||"",
        selectedCandidateId:selected.score.candidateId||"",
        selectedCandidateIndex:selected.score.candidateIndex,
        candidateCount:selected.score.candidateCount,
        greenLushnessScore:selected.score.greenLushnessScore,
        fairwayLineScore:selected.score.fairwayLineScore,
        balanceScore:selected.score.snapshotBalanceScore,
        selectionScore:selected.score.snapshotSelectionScore,
        selectionReason:selected.score.snapshotSelectionReason,
        tieBreak:"fairway-lines",
        candidates:options.slice(0,5).map(function(option){
          return {
            captureId:option.capture&&option.capture.id||"",
            candidateId:option.score.candidateId||"",
            candidateIndex:option.score.candidateIndex,
            greenLushnessScore:option.score.greenLushnessScore,
            fairwayLineScore:option.score.fairwayLineScore,
            balanceScore:option.score.snapshotBalanceScore,
            selectionScore:option.score.snapshotSelectionScore
          };
        })
      };
    }
    return {capture:selected.capture,diagnostic:diagnostic};
  }
  function visualCaptureRole(capture){
    var role=String(capture&&capture.role||capture&&capture.visualRole||"");
    return role==="course-backdrop"||role==="terrain-reference"||role==="green-surround"||role==="play-corridor"||role==="three-d-hole-beta";
  }
  function hasVisualCaptureSet(captures){
    return (Array.isArray(captures)?captures:[]).some(visualCaptureRole);
  }
  function executeVisualCapturePlan(input,plan,opts){
    opts=opts||{};
    var executor=root&&root.gdBuildCourseVisualCaptureManifest;
    var fallbackCaptures=opts.requireFresh===true?[]:(input.captures||[]);
    var errors=[];
    if(typeof executor!=="function"||!Array.isArray(plan)||!plan.length){
      return {executed:false,captures:fallbackCaptures,errors:errors,snapshotSelection:[],fallbackReason:typeof executor==="function"?"empty-plan":"capture-executor-missing"};
    }
    var captures=[];
    var snapshotSelection=[];
    plan.forEach(function(item){
      try{
        var manifest=executor(item);
        var selected=selectCaptureCandidate(manifest,item);
        var capture=selected&&selected.capture;
        if(capture&&capture.width&&capture.height&&captureBounds(capture)&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData))captures.push(capture);
        else errors.push({planId:item&&item.id,role:item&&item.role,holeNumber:item&&item.holeNumber,code:"capture-empty"});
        if(selected&&selected.diagnostic)snapshotSelection.push(selected.diagnostic);
      }catch(error){
        errors.push({planId:item&&item.id,role:item&&item.role,holeNumber:item&&item.holeNumber,code:"capture-failed",message:error&&error.message||String(error)});
      }
    });
    return {executed:true,captures:captures.length?captures:fallbackCaptures,errors:errors,snapshotSelection:snapshotSelection,fallbackReason:captures.length?"":"planned-captures-empty"};
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
    if(opts.forceFresh===true)previous=resetCourseVisualWorkingState(input.courseId||courseId,{keepPublished:true});
    var plan=planCourseVisualCaptures(input,{enable3dBeta:enable3dBeta});
    var buildRunId=stableId(opts.forceFresh===true?"fresh-capture":"capture");
    var planned=executeVisualCapturePlan(input,plan,{requireFresh:opts.forceFresh===true||opts.requireFreshCaptures===true});
    var previousCaptures=capturesFromRecordRefs(previous).filter(renderableCapture);
    var previousVisualCaptures=previousCaptures.filter(visualCaptureRole);
    if(opts.forceFresh!==true&&previousVisualCaptures.length&&!hasVisualCaptureSet(planned.captures)){
      planned=Object.assign({},planned,{
        captures:previousVisualCaptures,
        fallbackReason:(planned.fallbackReason?planned.fallbackReason+";":"")+"previous-visual-capture-refs"
      });
    }
    input=Object.assign({},input,{captures:planned.captures,capturePlan:plan});
    var record=ingestCourseVisualInput(input);
    record.diagnostics=Object.assign({},record.diagnostics||{},{stageSettings:{enable3dBeta:enable3dBeta},capturePlan:input.capturePlan,capturePlanSummary:planSummary(plan,planned.captures),captureExecution:{attempted:planned.executed,captured:planned.captures.length,errors:planned.errors,snapshotSelection:planned.snapshotSelection||[],fallbackReason:planned.fallbackReason||"",freshRun:opts.forceFresh===true||opts.requireFreshCaptures===true},activeBuildRunId:buildRunId});
    putRecord(record);
    return buildCourseVisualMaster(input.courseId,{captures:input.captures,capturePlan:plan,forceRebuild:opts.forceFresh===true,buildRunId:buildRunId});
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
    syncPublishedCourseVisual:syncPublishedCourseVisual,
    revertToPublishedVersion:revertToPublishedVersion,
    resetToPublished:resetToPublished,
    resetCourseVisualWorkingState:resetCourseVisualWorkingState,
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

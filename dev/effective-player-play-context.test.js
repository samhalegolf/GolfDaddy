/* Regression contract for effective-player-owned Play state. */
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
function storage(){const rows={};return {getItem:k=>Object.prototype.hasOwnProperty.call(rows,k)?rows[k]:null,setItem:(k,v)=>{rows[k]=String(v);},removeItem:k=>{delete rows[k];}};}
const localStorage=storage(), sessionStorage=storage();
const window={localStorage,sessionStorage,ClaritySession:{get:()=>window.session},GolfDaddyProfiles:{active:()=>window.profile}};
window.window=window;
vm.runInNewContext(fs.readFileSync("scripts/gd-play-context.js","utf8"),{window,localStorage,sessionStorage,JSON,Date,String,RegExp});
function player(id,name){window.session={viewedProfileId:id,ownProfileId:"coach"};window.profile={id,name};}
player("player-a","Alex");
window.GDPlayContext.writeJson("recent-courses",[{name:"Akarana"}]);
window.GDPlayContext.writeJson("resume-round",{courseId:"akarana"});
player("player-b","Blair");
assert.strictEqual(window.GDPlayContext.readJson("recent-courses"),null,"Player B must not inherit Player A recents");
assert.strictEqual(window.GDPlayContext.readJson("resume-round"),null,"Player B must not resume Player A round");
window.GDPlayContext.writeJson("recent-courses",[{name:"Maungakiekie"}]);
player("player-a","Alex");
assert.strictEqual(window.GDPlayContext.readJson("recent-courses")[0].name,"Akarana","Player A state must survive switching back");
window.GDPlayContext.begin({source:"practice-play",returnTarget:"practice"});
assert.strictEqual(JSON.parse(sessionStorage.getItem("clarity:play-context:v1")).returnContext.surface,"practice");
window.GDPlayContext.begin({source:"home-play",returnTarget:"home"});
assert.strictEqual(JSON.parse(sessionStorage.getItem("clarity:play-context:v1")).returnContext.surface,"coach-player");
console.log("effective player Play context tests passed");

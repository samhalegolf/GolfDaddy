(function(){
  var build = {
    appName: "Clarity Caddie",
    packageName: "clarity-caddie-core",
    version: "0.1.0",
    buildId: "2026-05-28-static-001",
    deployedAt: "2026-05-28",
    cacheBust: "support-foundation-v1"
  };

  window.ClarityBuild = Object.assign({}, window.ClarityBuild || {}, build);
  window.GolfDaddy = window.GolfDaddy || {};
  window.GolfDaddy.clarityBuild = window.ClarityBuild;
})();


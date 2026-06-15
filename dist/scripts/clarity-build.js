(function(){
  var build = {
    appName: "Clarity Caddie",
    packageName: "clarity-caddie-core",
    version: "0.1.0-beta.1",
    buildId: "2026-06-09-phase1-beta-report-001",
    deployedAt: "2026-06-09",
    channel: "beta",
    betaLabel: "Beta",
    cacheBust: "phase1-beta-report-001"
  };

  window.ClarityBuild = Object.assign({}, window.ClarityBuild || {}, build);
  window.GolfDaddy = window.GolfDaddy || {};
  window.GolfDaddy.clarityBuild = window.ClarityBuild;
})();


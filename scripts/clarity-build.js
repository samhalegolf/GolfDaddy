(function(){
  var build = {
    appName: "Clarity Caddy",
    packageName: "clarity-caddie-core",
    version: "0.1.0-beta.1",
    buildId: "2026-07-18-membership-cards-002",
    deployedAt: "2026-07-18",
    channel: "beta",
    betaLabel: "Beta",
    cacheBust: "membership-cards-002"
  };

  window.ClarityBuild = Object.assign({}, window.ClarityBuild || {}, build);
  window.GolfDaddy = window.GolfDaddy || {};
  window.GolfDaddy.clarityBuild = window.ClarityBuild;

  function loadMembershipCards(){
    if(document.getElementById("clarityMembershipCardsCss")) return;
    var css=document.createElement("link");
    css.id="clarityMembershipCardsCss";
    css.rel="stylesheet";
    css.href="styles/clarity-membership-cards.css?v=membership-cards-002";
    document.head.appendChild(css);
    var script=document.createElement("script");
    script.id="clarityMembershipCardsJs";
    script.src="scripts/clarity-membership-cards.js?v=membership-cards-002";
    script.defer=true;
    script.onload=function(){
      if(document.getElementById("clarityMembershipProfileBadgeJs")) return;
      var profileScript=document.createElement("script");
      profileScript.id="clarityMembershipProfileBadgeJs";
      profileScript.src="scripts/clarity-membership-profile-badge.js?v=membership-cards-002";
      profileScript.defer=true;
      document.head.appendChild(profileScript);
    };
    document.head.appendChild(script);
  }
  loadMembershipCards();

})();
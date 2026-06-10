(function(){
  "use strict";

  var ACCESS_KEY = "clarity_access_state_v1";
  var PRODUCTS_KEY = "clarity_access_products_v1";
  var ACTIVE_ROUND_KEY = "clarity_active_round_v1";

  var FEATURE_DEFAULTS = {
    gps: true,
    manualGps: true,
    profileSetup: true,
    bagSetup: true,
    courseHistory: true,
    betaReport: true,
    starterBubble: true,
    oneClubPreview: true,
    firstBubbleRound: true,
    roundPassPurchase: true,
    fullBagBubble: false,
    personalBubbleRound: false,
    practiceRawImport: true,
    practiceAnalysis: false,
    shotDataBasic: true,
    shotDataAdvanced: false,
    virtualRoundDemo: true,
    virtualRoundFull: false,
    advancedRoundHistory: false,
    coachDashboard: false,
    managePlayers: false,
    adminTools: false
  };

  var TIER_FEATURES = {
    free: Object.assign({}, FEATURE_DEFAULTS),
    premium: Object.assign({}, FEATURE_DEFAULTS, {
      fullBagBubble: true,
      personalBubbleRound: true,
      practiceAnalysis: true,
      shotDataAdvanced: true,
      virtualRoundFull: true,
      advancedRoundHistory: true
    }),
    coach: Object.assign({}, FEATURE_DEFAULTS, {
      fullBagBubble: true,
      personalBubbleRound: true,
      practiceAnalysis: true,
      shotDataAdvanced: true,
      virtualRoundFull: true,
      advancedRoundHistory: true,
      coachDashboard: true,
      managePlayers: true
    }),
    admin: { all: true }
  };

  var DEFAULT_PRODUCTS = {
    round_pass: {
      productKey: "round_pass",
      label: "Round Pass",
      description: "One intentional Personal Bubble Round.",
      accessSource: "round_pass",
      stripePriceEnv: "STRIPE_PRICE_ROUND_PASS",
      stripePriceId: "",
      priceDisplay: "",
      active: false
    },
    unlimited_monthly: {
      productKey: "unlimited_monthly",
      label: "Unlimited Monthly",
      description: "Unlimited Personal Bubble Rounds and deeper analysis.",
      entitlement: "premium",
      stripePriceEnv: "STRIPE_PRICE_UNLIMITED_MONTHLY",
      stripePriceId: "",
      priceDisplay: "",
      active: false
    },
    unlimited_annual: {
      productKey: "unlimited_annual",
      label: "Unlimited Annual",
      description: "Unlimited Personal Bubble Rounds and deeper analysis.",
      entitlement: "premium",
      stripePriceEnv: "STRIPE_PRICE_UNLIMITED_ANNUAL",
      stripePriceId: "",
      priceDisplay: "",
      active: false
    },
    founder_annual: {
      productKey: "founder_annual",
      label: "Founder Annual",
      description: "Optional beta/founder annual access.",
      entitlement: "premium",
      stripePriceEnv: "STRIPE_PRICE_FOUNDER_ANNUAL",
      stripePriceId: "",
      priceDisplay: "",
      active: false
    },
    coach_monthly: {
      productKey: "coach_monthly",
      label: "Coach Monthly",
      description: "Future coach/player management access.",
      entitlement: "coach",
      stripePriceEnv: "STRIPE_PRICE_COACH_MONTHLY",
      stripePriceId: "",
      priceDisplay: "",
      active: false
    }
  };

  function nowIso(){ return new Date().toISOString(); }

  function clone(value){
    try { return JSON.parse(JSON.stringify(value)); }
    catch(e){ return value; }
  }

  function safeJsonRead(key, fallback){
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : clone(fallback);
    } catch(e) {
      console.warn("[ClarityAccess] read failed", key, e);
      return clone(fallback);
    }
  }

  function safeJsonWrite(key, value){
    try {
      if(window.localStorage) window.localStorage.setItem(key, JSON.stringify(value));
    } catch(e) {
      console.warn("[ClarityAccess] save failed", key, e);
    }
    return value;
  }

  function activeProfile(){
    try {
      var profiles = window.GolfDaddyProfiles || window.ClarityCaddieProfiles;
      if(profiles && typeof profiles.active === "function") return profiles.active();
    } catch(e) {}
    try {
      if(typeof window.activePlayerProfile === "function") return window.activePlayerProfile();
    } catch(e) {}
    return null;
  }

  function currentAccount(){
    try {
      var accounts = window.GolfDaddyAccounts || window.ClarityCaddieAccounts;
      if(accounts && typeof accounts.current === "function") return accounts.current();
    } catch(e) {}
    return null;
  }

  function isAdmin(){
    try {
      var account = currentAccount();
      var profile = activeProfile();
      var permission = String(
        account && (account.permission || account.accountPermission || account.role || account.mode) ||
        profile && (profile.permission || profile.accountPermission || profile.role || profile.mode) ||
        ""
      ).toLowerCase();
      if(permission.indexOf("admin") !== -1) return true;
      if(document.body && document.body.classList.contains("gdAdminMode")) return true;
      if(window.CLARITY_ACCESS_ADMIN === true) return true;
    } catch(e) {}
    return false;
  }

  function defaultState(){
    return {
      schemaVersion: 1,
      entitlement: "free",
      firstBubbleRoundUsed: false,
      roundPassesAvailable: 0,
      bubbleAccessActiveUntil: null,
      bubbleAccessSource: "",
      activeRoundId: null,
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      lastCheckoutProductKey: "",
      updatedAt: nowIso()
    };
  }

  function defaultProducts(){
    return clone(DEFAULT_PRODUCTS);
  }

  function readState(){
    var state = safeJsonRead(ACCESS_KEY, defaultState());
    state.schemaVersion = state.schemaVersion || 1;
    state.entitlement = state.entitlement || "free";
    state.roundPassesAvailable = Number(state.roundPassesAvailable || 0);
    state.firstBubbleRoundUsed = !!state.firstBubbleRoundUsed;
    return state;
  }

  function saveState(state){
    state = Object.assign(defaultState(), state || {});
    state.updatedAt = nowIso();
    safeJsonWrite(ACCESS_KEY, state);
    window.dispatchEvent(new CustomEvent("clarity:access-changed", { detail: clone(state) }));
    refreshLocks();
    return state;
  }

  function readProducts(){
    var saved = safeJsonRead(PRODUCTS_KEY, {});
    return Object.assign(defaultProducts(), saved || {});
  }

  function saveProducts(products){
    safeJsonWrite(PRODUCTS_KEY, products || {});
    window.dispatchEvent(new CustomEvent("clarity:access-products-changed", { detail: readProducts() }));
    return readProducts();
  }

  function activeBubbleAccess(state){
    state = state || readState();
    if(!state.bubbleAccessActiveUntil) return false;
    return Date.now() < Date.parse(state.bubbleAccessActiveUntil);
  }

  function tier(){
    if(isAdmin()) return "admin";
    var state = readState();
    if(state.entitlement === "coach") return "coach";
    if(state.entitlement === "premium") return "premium";
    return "free";
  }

  function featuresForTier(name){
    if(name === "admin") return { all: true };
    return TIER_FEATURES[name] || TIER_FEATURES.free;
  }

  function has(feature){
    if(isAdmin()) return true;
    var state = readState();
    var featureSet = featuresForTier(state.entitlement || "free");
    if(featureSet.all || featureSet[feature]) return true;

    if(feature === "fullBagBubble" || feature === "personalBubbleRound") {
      return activeBubbleAccess(state);
    }

    if(feature === "canStartPersonalBubbleRound") {
      return !state.firstBubbleRoundUsed || state.roundPassesAvailable > 0 || state.entitlement === "premium" || state.entitlement === "coach";
    }

    return false;
  }

  function canUseGps(){ return has("gps"); }
  function canUseStarterBubbles(){ return has("starterBubble"); }
  function canUseFullBagBubble(){ return has("fullBagBubble"); }
  function canStartPersonalBubbleRound(){ return has("canStartPersonalBubbleRound"); }
  function canUsePracticeAnalysis(){ return has("practiceAnalysis"); }
  function canUseAdvancedRoundHistory(){ return has("advancedRoundHistory"); }
  function canUseVirtualRound(){ return has("virtualRoundFull"); }
  function canManagePlayers(){ return has("managePlayers"); }

  function createRoundId(){
    return "round-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function playDayKey(date){
    var d = date ? new Date(date) : new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function endOfGolfDay(){
    var d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }

  function startPersonalBubbleRound(options){
    var state = readState();
    options = options || {};
    var accessSource = "";

    if(isAdmin()) {
      accessSource = "admin";
    } else if(state.entitlement === "premium" || state.entitlement === "coach") {
      accessSource = state.entitlement;
    } else if(!state.firstBubbleRoundUsed) {
      accessSource = "first_free_round";
      state.firstBubbleRoundUsed = true;
    } else if(state.roundPassesAvailable > 0) {
      accessSource = "round_pass";
      state.roundPassesAvailable = Math.max(0, Number(state.roundPassesAvailable || 0) - 1);
    } else {
      return {
        ok: false,
        reason: "no_bubble_access",
        state: state
      };
    }

    var round = {
      roundId: options.roundId || createRoundId(),
      mode: "personal_bubble",
      accessSource: accessSource,
      courseId: options.courseId || "",
      courseName: options.courseName || "",
      startedAt: nowIso(),
      playDay: playDayKey(),
      consumedAfterMeaningfulUse: accessSource === "premium" || accessSource === "coach" || accessSource === "admin"
    };

    state.activeRoundId = round.roundId;
    state.bubbleAccessActiveUntil = endOfGolfDay();
    state.bubbleAccessSource = accessSource;
    saveState(state);
    safeJsonWrite(ACTIVE_ROUND_KEY, round);

    window.dispatchEvent(new CustomEvent("clarity:personal-bubble-round-started", { detail: clone(round) }));
    return {
      ok: true,
      round: round,
      state: readState()
    };
  }

  function markMeaningfulUse(reason){
    var round = safeJsonRead(ACTIVE_ROUND_KEY, null);
    if(!round || !round.roundId) return { ok: false, reason: "no_active_round" };
    round.consumedAfterMeaningfulUse = true;
    round.meaningfulUseReason = reason || "play_entered";
    round.meaningfulUseAt = nowIso();
    safeJsonWrite(ACTIVE_ROUND_KEY, round);
    window.dispatchEvent(new CustomEvent("clarity:personal-bubble-round-meaningful-use", { detail: clone(round) }));
    return { ok: true, round: round };
  }

  function endActiveRound(){
    var state = readState();
    var round = safeJsonRead(ACTIVE_ROUND_KEY, null);
    if(round && round.roundId) {
      round.endedAt = nowIso();
      safeJsonWrite(ACTIVE_ROUND_KEY, round);
    }
    state.activeRoundId = null;
    saveState(state);
    return { ok: true, round: round, state: readState() };
  }

  function grantRoundPasses(count, note){
    var state = readState();
    state.roundPassesAvailable = Math.max(0, Number(state.roundPassesAvailable || 0) + Math.max(0, Number(count || 0)));
    state.lastGrantNote = note || "";
    return saveState(state);
  }

  function setEntitlement(value){
    var state = readState();
    state.entitlement = ["free", "premium", "coach", "admin"].indexOf(value) >= 0 ? value : "free";
    return saveState(state);
  }

  async function createCheckout(productKey, options){
    options = options || {};
    var products = readProducts();
    var product = products[productKey];
    if(!product) throw new Error("Unknown product: " + productKey);

    var state = readState();
    state.lastCheckoutProductKey = productKey;
    saveState(state);

    var payload = {
      productKey: productKey,
      successUrl: options.successUrl || location.origin + location.pathname + "?checkout=success",
      cancelUrl: options.cancelUrl || location.href,
      clientReferenceId: options.clientReferenceId || state.activeRoundId || "",
      metadata: options.metadata || {}
    };

    var response = await fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    var data = await response.json().catch(function(){ return {}; });
    if(!response.ok) throw new Error(data.error || "Checkout is not available yet.");
    if(data.url) location.href = data.url;
    return data;
  }

  function lockedMessage(feature){
    var map = {
      fullBagBubble: "Unlock Personal Bubble Rounds to use your full-bag shot pattern on the course.",
      practiceAnalysis: "Premium turns practice data into player patterns.",
      virtualRoundFull: "Virtual Round uses your real bag and bubble to train decisions.",
      advancedRoundHistory: "Premium turns saved rounds into deeper patterns."
    };
    return map[feature] || "This feature needs Clarity access.";
  }

  function lockPayload(feature){
    return {
      locked: !has(feature),
      feature: feature,
      message: lockedMessage(feature),
      canStartPersonalBubbleRound: canStartPersonalBubbleRound(),
      state: readState()
    };
  }

  function refreshLocks(){
    try {
      document.documentElement.dataset.clarityTier = tier();
      document.documentElement.dataset.clarityBubbleAccess = canUseFullBagBubble() ? "active" : "inactive";
      document.querySelectorAll("[data-clarity-feature]").forEach(function(node){
        var feature = node.getAttribute("data-clarity-feature");
        var allowed = has(feature);
        node.classList.toggle("clarityAccessLocked", !allowed);
        node.setAttribute("aria-disabled", allowed ? "false" : "true");
        if(!allowed && !node.getAttribute("data-clarity-lock-title")) {
          node.setAttribute("data-clarity-lock-title", lockedMessage(feature));
        }
      });
    } catch(e) {}
  }

  function openAdminAccessPanel(){
    var state = readState();
    var products = readProducts();
    console.group("[ClarityAccess] Access structure");
    console.log("State", state);
    console.log("Products", products);
    console.log("Tier", tier());
    console.log("Features", featuresForTier(tier()));
    console.groupEnd();
    return { state: state, products: products, tier: tier() };
  }

  var api = {
    ACCESS_KEY: ACCESS_KEY,
    PRODUCTS_KEY: PRODUCTS_KEY,
    ACTIVE_ROUND_KEY: ACTIVE_ROUND_KEY,
    FEATURE_DEFAULTS: clone(FEATURE_DEFAULTS),
    TIER_FEATURES: clone(TIER_FEATURES),
    DEFAULT_PRODUCTS: clone(DEFAULT_PRODUCTS),
    readState: readState,
    saveState: saveState,
    readProducts: readProducts,
    saveProducts: saveProducts,
    tier: tier,
    has: has,
    lockPayload: lockPayload,
    canUseGps: canUseGps,
    canUseStarterBubbles: canUseStarterBubbles,
    canStartPersonalBubbleRound: canStartPersonalBubbleRound,
    canUseFullBagBubble: canUseFullBagBubble,
    canUsePracticeAnalysis: canUsePracticeAnalysis,
    canUseAdvancedRoundHistory: canUseAdvancedRoundHistory,
    canUseVirtualRound: canUseVirtualRound,
    canManagePlayers: canManagePlayers,
    startPersonalBubbleRound: startPersonalBubbleRound,
    markMeaningfulUse: markMeaningfulUse,
    endActiveRound: endActiveRound,
    grantRoundPasses: grantRoundPasses,
    setEntitlement: setEntitlement,
    createCheckout: createCheckout,
    openAdminAccessPanel: openAdminAccessPanel,
    refreshLocks: refreshLocks
  };

  window.ClarityAccess = api;
  window.ClarityEntitlements = api;

  document.addEventListener("DOMContentLoaded", refreshLocks);
  window.addEventListener("clarity:session-ready", refreshLocks);
  window.addEventListener("storage", function(event){
    if(event && (event.key === ACCESS_KEY || event.key === PRODUCTS_KEY)) refreshLocks();
  });
})();

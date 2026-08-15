/* The player's Bubble model, read into whichever shell is running.
 *
 * One file for both surfaces on purpose. The legacy shell reaches the engine
 * through the global gdSetBubbleMicroGeometry(); the fresh app/ shell reaches
 * the generated mirror through GDBubbleEngine.setMicroGeometry(). Everything
 * either of them needs around that - the cache, the staleness handling, the
 * decision not to block - is identical, and a second copy of it would be the
 * next thing to drift.
 *
 * ---------------------------------------------------------------------------
 * NO LOADING BARS - this file is where that promise is kept
 *
 * apply() runs from the cache SYNCHRONOUSLY at load, before any network call
 * exists. Opening Practice, My Bubble or GPS Play therefore never waits on
 * anything: the last good model is already in the engine. refresh() then goes
 * to the server in the background and, if a newer model came back, replaces it
 * quietly and tells listeners. If the server is unreachable, offline, slow, or
 * has never analysed this player, the cached model keeps rendering and nothing
 * about the screen changes.
 *
 * ---------------------------------------------------------------------------
 * WHAT "NO MODEL" MEANS
 *
 * It means the bubble that shipped before any of this existed. Null geometry,
 * identity factors, zero axis correction. That is the state on a fresh
 * install, on a signed-out device, when the config has every Signal off (which
 * is what is shipped), and whenever anything at all goes wrong here. There is
 * no half-applied model: setMicroGeometry either takes a complete, version-
 * matched payload or it takes null.
 */
(function () {
  'use strict';

  var CACHE_KEY = 'gd_bubble_player_model_v1';
  var ENDPOINT = '/api/bubble-model';
  /* Long enough that opening three screens in a row is one request, short
     enough that a model rebuilt on another device shows up in the same
     session. Nothing here polls. */
  var REFRESH_AFTER_MS = 5 * 60 * 1000;

  var listeners = [];
  var applied = null;
  var lastFetchAt = 0;
  var inFlight = null;

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function core() {
    return window.GDBubbleSignalsCore || null;
  }

  /* ------------------------------------------------------------------
     Cache
     ------------------------------------------------------------------ */

  function readCache() {
    return safe(function () {
      var raw = window.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    }, null);
  }

  function writeCache(entry) {
    safe(function () {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    });
  }

  function clearCache() {
    safe(function () { window.localStorage.removeItem(CACHE_KEY); });
  }

  /* ------------------------------------------------------------------
     Scope
     ------------------------------------------------------------------ */

  function scope() {
    var launch = window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData;
    if (launch && typeof launch.activePlayerScope === 'function') {
      var resolved = safe(function () { return launch.activePlayerScope(); }, null);
      if (resolved && (resolved.playerId || resolved.accountId)) return resolved;
    }
    var session = safe(function () {
      return window.ClaritySession && typeof window.ClaritySession.get === 'function'
        ? window.ClaritySession.get()
        : null;
    }, null) || {};
    return {
      playerId: String(session.viewedProfileId || session.profileId || '').trim(),
      accountId: String(session.accountId || '').trim()
    };
  }

  function scopeKey(current) {
    return String((current && current.playerId) || '') + '|' + String((current && current.accountId) || '');
  }

  /* ------------------------------------------------------------------
     Applying
     ------------------------------------------------------------------ */

  /* The two shells, in the order they can exist. Returns whether anything
     took the model - false is a real answer on a page with no bubble engine
     loaded at all (the studio's info pages, for instance). */
  function pushToEngine(geometry) {
    var took = false;
    if (window.GDBubbleEngine && typeof window.GDBubbleEngine.setMicroGeometry === 'function') {
      safe(function () { window.GDBubbleEngine.setMicroGeometry(geometry); });
      took = true;
    }
    if (typeof window.gdSetBubbleMicroGeometry === 'function') {
      safe(function () { window.gdSetBubbleMicroGeometry(geometry); });
      took = true;
    }
    return took;
  }

  /* A cached model from a build that understood a different payload shape is
     not partially usable. modelIsUsable() is the version gate, and failing it
     means render the plain bubble, not guess at the difference. */
  function usable(model) {
    var api = core();
    if (!api || typeof api.modelIsUsable !== 'function') return false;
    return api.modelIsUsable(model);
  }

  function apply(model, meta) {
    var geometry = usable(model) ? model.geometry : null;
    var key = geometry ? JSON.stringify(geometry) : 'null';
    pushToEngine(geometry);
    if (key === applied) return false;
    applied = key;
    var detail = { model: usable(model) ? model : null, geometry: geometry, meta: meta || {} };
    listeners.forEach(function (fn) { safe(function () { fn(detail); }); });
    safe(function () {
      window.dispatchEvent(new CustomEvent('gd-bubble-model-changed', { detail: detail }));
    });
    return true;
  }

  /* ------------------------------------------------------------------
     Server
     ------------------------------------------------------------------ */

  async function authHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var auth = window.ClaritySupabaseAuth;
    if (auth && typeof auth.freshAccessToken === 'function') {
      var token = '';
      try { token = await auth.freshAccessToken(); } catch (error) { token = ''; }
      if (token) headers.Authorization = 'Bearer ' + token;
    }
    return headers;
  }

  async function requestModel(current) {
    var query = '?playerId=' + encodeURIComponent(current.playerId || '')
      + '&accountId=' + encodeURIComponent(current.accountId || '');
    var response = await fetch(ENDPOINT + query, {
      method: 'GET',
      headers: await authHeaders()
    });
    if (!response.ok) throw new Error('bubble model request failed: ' + response.status);
    return await response.json();
  }

  async function requestAnalyse(current) {
    var response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        action: 'analyse',
        playerId: current.playerId,
        accountId: current.accountId,
        offsetDeg: savedOffsetDeg(),
        handedness: savedHandedness()
      })
    });
    if (!response.ok) throw new Error('bubble model analyse failed: ' + response.status);
    return await response.json();
  }

  /* The aim comes from My Bubble and only Practice Bubble adoption may change
     it (Bubble Bible s1). It is passed UP to the server so the returned model
     is complete; the server never writes it back anywhere. */
  function savedOffsetDeg() {
    var appBubble = window.ClarityApp && window.ClarityApp.myBubble;
    if (appBubble && typeof appBubble.current === 'function') {
      var saved = safe(function () { return appBubble.current(); }, null);
      if (saved && Number.isFinite(Number(saved.offsetDeg))) return Number(saved.offsetDeg);
    }
    return null;
  }

  function savedHandedness() {
    var appBubble = window.ClarityApp && window.ClarityApp.myBubble;
    if (appBubble && typeof appBubble.current === 'function') {
      var saved = safe(function () { return appBubble.current(); }, null);
      if (saved && saved.handedness) return saved.handedness;
    }
    return 'right';
  }

  /* ------------------------------------------------------------------
     Public
     ------------------------------------------------------------------ */

  /* Puts the cached model into the engine. Synchronous, no network, safe to
     call as often as anything likes - this is what every screen open uses. */
  function hydrate() {
    var current = scope();
    var cached = readCache();
    if (!cached || cached.scopeKey !== scopeKey(current)) {
      /* A different player is signed in. Their model is not this player's
         model, and showing it would be worse than showing none. */
      apply(null, { source: 'no-cache' });
      return null;
    }
    apply(cached.model, { source: 'cache', analysedAt: cached.analysedAt, stale: !!cached.stale });
    return cached.model || null;
  }

  /* Goes to the server, quietly. Never throws at the caller, never blocks a
     render, and leaves the cached model in place on any failure.
     `force` skips the freshness window (a save just happened). */
  function refresh(options) {
    var force = !!(options && options.force);
    var current = scope();
    if (!current.playerId && !current.accountId) return Promise.resolve(null);
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastFetchAt < REFRESH_AFTER_MS) return Promise.resolve(null);

    inFlight = (async function () {
      try {
        var body = await requestModel(current);

        /* The server said the library has moved on since this model was
           built, or the geometry config was republished. Rebuild it - and
           still render what we already have while that happens. */
        if (body && (body.stale || body.neverAnalysed) && (force || body.stale)) {
          var rebuilt = await requestAnalyse(current).catch(function () { return null; });
          if (rebuilt && rebuilt.model) {
            body = { model: rebuilt.model, analysedAt: new Date().toISOString(), stale: false };
          }
        }

        if (!body || !body.model) {
          /* Never analysed, or analysed to nothing. Not an error and not a
             reason to discard a model we may still hold - but if the server
             genuinely has none, the cache should not outlive it. */
          if (body && body.neverAnalysed) {
            clearCache();
            apply(null, { source: 'server-none' });
          }
          lastFetchAt = Date.now();
          return null;
        }

        writeCache({
          scopeKey: scopeKey(current),
          model: body.model,
          analysedAt: body.analysedAt || new Date().toISOString(),
          stale: !!body.stale,
          cachedAt: new Date().toISOString()
        });
        apply(body.model, { source: 'server', analysedAt: body.analysedAt, stale: !!body.stale });
        lastFetchAt = Date.now();
        return body.model;
      } catch (error) {
        /* Offline, signed out, endpoint not deployed. The cached model is
           still the best answer available and it is already rendering. */
        lastFetchAt = Date.now();
        return null;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  /* Practice data was just saved. This is the event the whole "analyse when
     data changes" shape hangs off - the screen does not wait for it. */
  function onPracticeDataSaved() {
    var current = scope();
    if (!current.playerId && !current.accountId) return Promise.resolve(null);
    return (async function () {
      try {
        var body = await requestAnalyse(current);
        if (body && body.model) {
          writeCache({
            scopeKey: scopeKey(current),
            model: body.model,
            analysedAt: new Date().toISOString(),
            stale: false,
            cachedAt: new Date().toISOString()
          });
          apply(body.model, { source: 'analysed' });
        }
        return body || null;
      } catch (error) {
        return null;
      }
    })();
  }

  var api = {
    hydrate: hydrate,
    refresh: refresh,
    current: function () {
      var cached = readCache();
      return cached && cached.scopeKey === scopeKey(scope()) ? cached.model || null : null;
    },
    geometry: function () {
      var model = api.current();
      return usable(model) ? model.geometry : null;
    },
    onPracticeDataSaved: onPracticeDataSaved,
    clear: function () { clearCache(); apply(null, { source: 'cleared' }); },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

  window.GDBubbleModelClient = api;
  var app = (window.ClarityApp = window.ClarityApp || {});
  app.bubbleModel = api;

  /* Cache first, at load. Everything after this is background. */
  hydrate();

  /* A model rebuilt in another tab, or an app resumed mid-round, must not keep
     rendering yesterday's geometry until something else happens to ask. */
  window.addEventListener('storage', function (event) {
    if (!event.key || event.key === CACHE_KEY) hydrate();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { hydrate(); refresh(); }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { hydrate(); refresh(); });
  } else {
    refresh();
  }
})();

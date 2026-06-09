(function () {
  'use strict';

  window.ClarityCaddie = window.ClarityCaddie || window.GolfDaddy || {};
  window.GolfDaddy = window.GolfDaddy || window.ClarityCaddie;
  window.ClarityCaddie.brand = window.ClarityCaddie.brand || {
    appName: 'Clarity Caddie',
    platformName: 'Clarity Golf Systems'
  };
  window.GolfDaddy.version = window.GolfDaddy.version || 'clarity-caddie-ui-pass';
  window.GolfDaddy.modules = window.GolfDaddy.modules || {};
  window.GolfDaddy.utils = window.GolfDaddy.utils || {};
  window.ClarityCaddie.modules = window.GolfDaddy.modules;
  window.ClarityCaddie.utils = window.GolfDaddy.utils;
  window.GolfDaddy.utils.safe = window.GolfDaddy.utils.safe || function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      console.warn('[ClarityCaddie]', error);
      return fallback;
    }
  };
})();

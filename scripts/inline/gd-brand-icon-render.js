/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  const GD66_ICONS = window.GDIconAssets.gd66Icons;

	  const CG_GPS_ICON_SRC = 'assets/brand/cg-gps-pin.png?v=clarity-cg-gps-20260601';
	  function icon(key) {
	    const src = key === 'cgGps' ? CG_GPS_ICON_SRC : (GD66_ICONS[key] || '');
	    const cls = key === 'cgGps' ? 'gdBrandIcon gdCgGpsIcon' : 'gdBrandIcon';
	    return src ? '<img class="'+cls+'" src="'+src+'" alt="'+key+'">' : '';
	  }

  function ensureRightRail() {
    let rail = document.querySelector('.rightRail');
    if (!rail) {
      console.warn('[Clarity Caddie] right rail shell is missing');
      return;
    }

    const spec = [
      ['flagTool', 'flag', 'Place flag', function() {
        try {
          if (typeof startPinPlacement === 'function') startPinPlacement();
        } catch(e) {}
      }],
      ['greenToolBtn', 'wand', 'Green Wand', function() {
        try { openGpsWand(); } catch(e) {}
      }],
      ['scorecardRailBtn', 'scorecard', 'Scorecard', function() {
        try { openScorecard(); } catch(e) {}
      }],
      ['bagRailBtn', 'bag', 'Bag', function() {
        try { openBag(); } catch(e) {}
      }],
	      ['gpsRailBtn', 'cgGps', 'GPS locate', function() {
	        try { refreshGPS(); } catch(e) {}
	      }]
    ];

    spec.forEach(([id, key, label, handler]) => {
      let btn = document.getElementById(id);
      if (!btn) {
        console.warn('[Clarity Caddie] final rail button missing:', id);
        return;
      }
      btn.classList.add('railBtn');
      btn.dataset.gdRailButton = 'final';
      if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
      if (btn.title !== label) btn.title = label;
      if (btn.dataset.gdRailIconKey !== key || !btn.childElementCount) {
        btn.innerHTML = icon(key);
        btn.dataset.gdRailIconKey = key;
      }
      if (btn.__gdV66Handler !== handler) {
        btn.__gdV66Handler = handler;
        btn.onclick = function(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          btn.__gdV66Handler();
        };
      }
    });

    ['gdV62ModeSwitch','gdGpsSnapZoomBtn','gdGreenZoomBtn'].forEach(id => {
      const extra = document.getElementById(id);
      if (extra) extra.dataset.gdRailButton = 'final';
    });
  }

	  function positionModeSwitchBelowRail() {
	    const sw = document.getElementById('gdV62ModeSwitch');
	    const rail = document.querySelector('.rightRail');
	    if (!sw || !rail) return;
	    if (sw.parentElement !== rail) rail.appendChild(sw);
	    ['top','right','bottom','left','transform'].forEach(prop => { sw.style[prop] = ''; });
	    delete sw.dataset.gdStableTop;
	  }

  function refreshV66() {
    ensureRightRail();
    positionModeSwitchBelowRail();
  }

  window.gdV66RefreshBrandRail = refreshV66;

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(refreshV66, 80);
    setTimeout(refreshV66, 350);
    setTimeout(refreshV66, 900);
  });
  if (document.readyState !== 'loading') {
    setTimeout(refreshV66, 80);
    setTimeout(refreshV66, 350);
  }
  document.addEventListener('click', () => setTimeout(refreshV66, 100));
  window.addEventListener('resize', () => setTimeout(refreshV66, 100));

  ['enterGpsModule','gdV62Refresh','showShellHome','openScorecard','refreshGPS'].forEach(name => {
    const old = window[name];
    if (typeof old === 'function' && !old.__v66Wrapped) {
      const wrapped = function(...args) {
        const res = old.apply(this, args);
        setTimeout(refreshV66, 80);
        return res;
      };
      wrapped.__v66Wrapped = true;
      window[name] = wrapped;
    }
  });
})();

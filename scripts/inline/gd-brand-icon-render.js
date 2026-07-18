/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  const GD66_ICONS = window.GDIconAssets && window.GDIconAssets.gd66Icons || {};
  const WIND_SVG = '<svg aria-hidden="true" viewBox="0 0 48 48"><path d="M9 17h20c4.4 0 6.6-5.4 3.5-8.5-2.4-2.4-6.5-1.5-7.6 1.7" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M8 25h28c5.2 0 7.8 6.3 4.1 10-2.9 2.9-7.8 1.7-9.1-2.1" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M13 33h11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
  const ZOOM_SVG = '<svg aria-hidden="true" viewBox="0 0 48 48" fill="none"><circle cx="21" cy="21" r="10" stroke="currentColor" stroke-width="4"/><path d="M29 29l9 9" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M21 15v12M15 21h12" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>';
  const SETTINGS_SVG = '<svg aria-hidden="true" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="5.5" stroke="currentColor" stroke-width="3.6"/><path d="M24 8v6M24 34v6M10.1 16l5.2 3M32.7 29l5.2 3M10.1 32l5.2-3M32.7 19l5.2-3" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/></svg>';

	  const CG_GPS_ICON_SRC = 'assets/brand/cg-gps-pin.png?v=clarity-cg-gps-20260601';
	  function icon(key) {
	    const src = key === 'cgGps' ? CG_GPS_ICON_SRC : (GD66_ICONS[key] || '');
	    const cls = key === 'cgGps' ? 'gdBrandIcon gdCgGpsIcon' : 'gdBrandIcon';
	    return src ? '<img class="'+cls+'" src="'+src+'" alt="'+key+'">' : '';
	  }

  function pickerOpen() {
    const screen = document.getElementById('courseScreen');
    if (document.body.classList.contains('gdCoursePickerOpen')) return true;
    if (!screen || screen.classList.contains('hidden')) return false;
    try {
      const style = getComputedStyle(screen);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
    } catch (_error) {
      return true;
    }
  }

  function gpsOpen() {
    return document.body.classList.contains('shell-gps') ||
      document.body.classList.contains('gdGpsActive') ||
      document.body.classList.contains('gps-active');
  }

  function railAllowed() {
    if (!document.body) return false;
    if (!gpsOpen()) return false;
    if (pickerOpen()) return false;
    if (document.body.classList.contains('gdAuthLocked') || document.body.classList.contains('gdProfileOpen')) return false;
    if (document.body.classList.contains('shell-home') || document.body.classList.contains('shell-module')) return false;
    if (document.body.classList.contains('gdCourseOpening')) return false;
    if (document.querySelector('#bagPanel.open,#developerPanel.open,#settingsPanel.open,#profilePanel.open,#statsPanel.open,#dataHubPanel.open,#practiceDataPanel.open,#gdProfileV67:not(.hidden)')) return false;
    return true;
  }

  function removeRightRail() {
    const rail = document.getElementById('gdAppRightRail') || document.querySelector('.rightRail');
    if (rail) rail.remove();
  }

  function ensureShell() {
    let rail = document.getElementById('gdAppRightRail') || document.querySelector('.rightRail');
    if (rail) return rail;
    rail = document.createElement('div');
    rail.className = 'rightRail';
    rail.id = 'gdAppRightRail';
    document.body.appendChild(rail);
    return rail;
  }

  function ensureRailButton(rail, spec) {
    let btn = document.getElementById(spec.id);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = spec.id;
      rail.appendChild(btn);
    } else if (btn.parentElement !== rail) {
      rail.appendChild(btn);
    }
    btn.type = 'button';
    btn.className = spec.className || 'railBtn';
    btn.dataset.gdRailButton = 'final';
    if (spec.icon) btn.dataset.gdRailIcon = spec.icon;
    if (btn.getAttribute('aria-label') !== spec.label) btn.setAttribute('aria-label', spec.label);
    if (spec.ariaHidden) btn.setAttribute('aria-hidden', 'true');
    else btn.removeAttribute('aria-hidden');
    if (btn.title !== spec.label) btn.title = spec.label;
    if (spec.html && btn.dataset.gdRailIconKey !== spec.key) {
      btn.innerHTML = spec.html;
      btn.dataset.gdRailIconKey = spec.key;
    }
    if (btn.__gdV66Handler !== spec.handler) {
      btn.__gdV66Handler = spec.handler;
      btn.onclick = function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        return btn.__gdV66Handler(ev);
      };
    }
    return btn;
  }

  function ensureRightRail() {
    if (!railAllowed()) {
      removeRightRail();
      return null;
    }
    const rail = ensureShell();

    const spec = [
      { id: 'flagTool', key: 'flag', icon: 'flag', label: 'Place flag', className: 'railBtn', html: icon('flag'), handler: function() { try { if (typeof startPinPlacement === 'function') startPinPlacement(); } catch(e) {} } },
      { id: 'greenToolBtn', key: 'wand', icon: 'wand', label: 'Green Wand', className: 'railBtn greenBtn', html: icon('wand'), handler: function() { try { if (typeof openGpsWand === 'function') openGpsWand(); } catch(e) {} } },
      { id: 'windToolBtn', key: 'wind', label: 'Wind', className: 'railBtn gdWindToolBtn', html: WIND_SVG, handler: function(ev) { try { if (typeof gdWindToolPressed === 'function') return gdWindToolPressed(ev); } catch(e) {} return false; } },
      { id: 'gpsRailBtn', key: 'cgGps', icon: 'gps', label: 'GPS locate', className: 'railBtn gdGpsRecenterBtn', html: icon('cgGps'), handler: function() { try { if (typeof refreshGPS === 'function') refreshGPS(); } catch(e) {} } },
      { id: 'gdGreenZoomBtn', key: 'green-zoom', label: 'Frame tightness', className: 'railBtn gdGreenZoomBtn', html: ZOOM_SVG, handler: function(ev) { try { if (typeof gdToggleSimpleGreenZoom === 'function') return gdToggleSimpleGreenZoom(ev); } catch(e) {} return false; } },
      { id: 'gdMapperToolsBtn', key: 'mapper-tools', label: 'Map tools', className: 'railBtn gdMapperToolsBtn', html: 'MAP', handler: function(ev) { try { if (typeof gdOpenMapperTools === 'function') return gdOpenMapperTools(ev); } catch(e) {} return false; } },
      { id: 'gdGpsSettingsRailBtn', key: 'gps-settings', label: 'GPS settings', className: 'railBtn gdGpsSettingsRailBtn', html: SETTINGS_SVG, handler: function(ev) { try { if (typeof gdOpenGpsToolSettings === 'function') return gdOpenGpsToolSettings(ev); } catch(e) {} return false; } },
      { id: 'scorecardRailBtn', key: 'scorecard', icon: 'scorecard', label: 'Scorecard', className: 'railBtn', html: icon('scorecard'), handler: function() { try { if (typeof openScorecard === 'function') openScorecard(); } catch(e) {} } },
      { id: 'bagRailBtn', key: 'bag', icon: 'bag', label: 'Bag', className: 'railBtn', html: icon('bag'), handler: function() { try { if (typeof openBag === 'function') openBag(); } catch(e) {} } }
    ];

    spec.forEach(item => ensureRailButton(rail, item));

    // Rebind gd-app-core's flag drag/pin pointer handlers onto the freshly created #flagTool.
    try { if (typeof window.gdBindFlagPointerHandlers === 'function') window.gdBindFlagPointerHandlers(); } catch (e) {}

    ['gdV62ModeSwitch','gdGpsSnapZoomBtn','gdGreenZoomBtn'].forEach(id => {
      const extra = document.getElementById(id);
      if (extra) extra.dataset.gdRailButton = 'final';
    });

    return rail;
  }

		  function positionModeSwitchBelowRail() {
		    const sw = document.getElementById('gdV62ModeSwitch');
		    const rail = document.getElementById('gdAppRightRail') || document.querySelector('.rightRail');
		    if (!sw || !rail) return;
		    if (sw.parentElement !== rail) rail.appendChild(sw);
	    ['top','right','bottom','left','transform'].forEach(prop => { sw.style[prop] = ''; });
	    delete sw.dataset.gdStableTop;
	  }

	  function refreshV66() {
	    if (ensureRightRail()) positionModeSwitchBelowRail();
	  }

	  window.gdV66RefreshBrandRail = refreshV66;
	  window.gdEnsureAppRightRail = ensureRightRail;

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

/* --- GPS badge hydration v1 ---
   Keeps the GPS player badge populated without rebuilding the route shell. */
(function () {
  'use strict';

  function safe(fn) {
    try {
      return fn();
    } catch (error) {
      console.warn('[GD GPS badge]', error);
    }
  }

  function gpsVisible() {
    return document.body.classList.contains('shell-gps') ||
      document.body.classList.contains('gdGpsActive') ||
      document.body.classList.contains('gps-active') ||
      document.body.dataset.clarityRoute === 'gps' ||
      gpsSurfaceVisible();
  }

  function gpsSurfaceVisible() {
    const selectors = [
      '#gdV62GpsBadge',
      '.gdHoleStepper',
      '.leaflet-container',
      '#gdGpsMap',
      '#gpsMap',
      '#map'
    ];

    return selectors.some((selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function applyShellFrame() {
    const active = gpsVisible();
    const shellTop = document.getElementById('shellTop');
    const shellBackBtn = document.getElementById('shellBackBtn');
    const shellHomeBtn = document.getElementById('shellHomeBtn');

    document.body.classList.toggle('gdGpsShellFrame', active);

    if (!active) {
      if (shellTop) {
        shellTop.style.position = '';
        shellTop.style.display = '';
        shellTop.style.visibility = '';
        shellTop.style.opacity = '';
        shellTop.style.zIndex = '';
        shellTop.style.pointerEvents = '';
      }
      if (shellBackBtn) {
        shellBackBtn.style.display = '';
        shellBackBtn.style.visibility = '';
        shellBackBtn.style.opacity = '';
        shellBackBtn.style.pointerEvents = '';
        shellBackBtn.style.zIndex = '';
      }
      if (shellHomeBtn) {
        shellHomeBtn.style.display = '';
        shellHomeBtn.style.visibility = '';
        shellHomeBtn.style.opacity = '';
        shellHomeBtn.style.pointerEvents = '';
        shellHomeBtn.style.zIndex = '';
      }
      return;
    }

    if (shellTop) {
      shellTop.style.position = 'fixed';
      shellTop.style.display = 'flex';
      shellTop.style.visibility = 'visible';
      shellTop.style.opacity = '1';
      shellTop.style.zIndex = '2147483000';
      shellTop.style.pointerEvents = 'none';
    }
    if (shellBackBtn) {
      shellBackBtn.style.display = 'inline-flex';
      shellBackBtn.style.visibility = 'visible';
      shellBackBtn.style.opacity = '1';
      shellBackBtn.style.pointerEvents = 'auto';
      shellBackBtn.style.zIndex = '2147483001';
    }
    if (shellHomeBtn) {
      shellHomeBtn.style.display = 'inline-flex';
      shellHomeBtn.style.visibility = 'visible';
      shellHomeBtn.style.opacity = '1';
      shellHomeBtn.style.pointerEvents = 'auto';
      shellHomeBtn.style.zIndex = '2147483001';
    }
  }

  function usablePersonName(value) {
    const name = String(value || '').trim();
    if (!name) return '';
    return /^(demo player|player 1|placeholder player)$/i.test(name) ? '' : name;
  }

  function storedProfiles() {
    try {
      const raw = JSON.parse(localStorage.getItem('gd_player_profiles_v27') || '{}');
      const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
      return { profiles, activeId: raw.activeId || '' };
    } catch (error) {
      return { profiles: [], activeId: '' };
    }
  }

  function storedProfileById(profileId) {
    const store = storedProfiles();
    if (profileId) return store.profiles.find((profile) => profile && profile.id === profileId) || null;
    return store.profiles.find((profile) => profile && profile.id === store.activeId) || store.profiles[0] || null;
  }

  function profileById(profileId) {
    if (!profileId) return null;
    return safe(() => typeof window.gdProfileById === 'function' ? window.gdProfileById(profileId) : null) ||
      storedProfileById(profileId);
  }

  function accountsApi() {
    return window.GolfDaddyAccounts || window.ClarityCaddieAccounts || null;
  }

  function accountState() {
    const api = accountsApi();
    return safe(() => api && typeof api.state === 'function' ? api.state() : null) || {};
  }

  function currentAccount() {
    const api = accountsApi();
    return safe(() => api && typeof api.current === 'function' ? api.current() : null) || null;
  }

  function accountForProfile(profileId) {
    const api = accountsApi();
    return safe(() => api && typeof api.accountForProfile === 'function' ? api.accountForProfile(profileId) : null) || null;
  }

  function activeProfile() {
    const account = currentAccount();
    const state = accountState();
    if (account) {
      const ownProfileId = account.profileId || '';
      const viewedProfileId = state.viewingProfileId ||
        (document.body && document.body.dataset && document.body.dataset.clarityViewedProfileId) ||
        ownProfileId;
      const profileId = viewedProfileId || ownProfileId;
      const profile = profileById(profileId) || profileById(ownProfileId);
      const owner = accountForProfile(profileId);
      const viewingOther = !!(profileId && ownProfileId && profileId !== ownProfileId);
      const name = viewingOther
        ? (usablePersonName(owner && owner.name) || usablePersonName(profile && profile.name))
        : (usablePersonName(account.name) || usablePersonName(profile && profile.name) || usablePersonName(owner && owner.name));
      return Object.assign({}, profile || {}, { name });
    }

    return safe(() => typeof activePlayerProfile === 'function' ? activePlayerProfile() : null) ||
      storedProfileById(null) ||
      { name: 'Player' };
  }

  function gpsMode() {
    try {
      const mode = (localStorage.getItem('gd_beta_gps_mode') ||
        localStorage.getItem('gd_gps_play_mode') ||
        localStorage.getItem('gdGpsPlayMode') ||
        'twoTap').toLowerCase();
      return mode === 'live' ? 'live' : 'twoTap';
    } catch (error) {
      return 'twoTap';
    }
  }

  function holeLabel() {
    return safe(() => {
      if (window.gdFullMappingMode) {
        const mapped = Number(window.gdMapperActiveHole || sessionStorage.getItem('gd_mapper_active_hole') || 0);
        if (Number.isFinite(mapped) && mapped > 0) return 'Mapping H' + mapped;
      }
      if (typeof currentPlayingHole !== 'undefined' && currentPlayingHole) {
        const number = Number(currentPlayingHole);
        const hole = (typeof scorecard !== 'undefined' && scorecard && Array.isArray(scorecard.holes))
          ? scorecard.holes[number - 1]
          : null;
        return 'Hole ' + number + (hole && hole.par ? ' · Par ' + hole.par : '');
      }
      const line = document.getElementById('holeLine');
      return line && line.style.display !== 'none' && line.textContent.trim() ? line.textContent.trim() : '';
    }) || '';
  }

  function assumedCourseLabel() {
    return safe(() => {
      const activeName = (document.body && document.body.dataset && document.body.dataset.gdActiveCourseName || '').trim();
      if (activeName) {
        return activeName === 'Manual GPS' ? '' : activeName;
      }
      const active = window.gdActiveCourse;
      if (active && active.name) {
        return active.name === 'Manual GPS' ? '' : active.name;
      }
      if (window.GolfDaddyCourseLibrary &&
          typeof window.GolfDaddyCourseLibrary.currentCourseStorageLabel === 'function') {
        return window.GolfDaddyCourseLibrary.currentCourseStorageLabel();
      }
      return window.gdAssumedCourseName || sessionStorage.getItem('gd_assumed_course_name') || '';
    }) || '';
  }

  function textNode(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function scoreDisplay() {
    return safe(() => typeof window.gdScoreDisplayValue === 'function' ? window.gdScoreDisplayValue() : null) || 'E';
  }

  function scoreTone() {
    return safe(() => typeof window.gdScoreTone === 'function' ? window.gdScoreTone() : null) || 'even';
  }

  function wireScoreOffset(offset) {
    offset.setAttribute('role', 'button');
    offset.setAttribute('aria-label', 'Tap top half for score up, bottom half for score down');
    offset.setAttribute('aria-valuetext', scoreDisplay());
    offset.onclick = function (event) {
      if (typeof window.adjustScore !== 'function') return;
      const rect = offset.getBoundingClientRect();
      window.adjustScore(event.clientY < rect.top + (rect.height / 2) ? 1 : -1);
    };
    offset.onkeydown = function (event) {
      if (typeof window.adjustScore !== 'function') return;
      if (event.key === 'ArrowUp') {
        window.adjustScore(1);
        event.preventDefault();
      }
      if (event.key === 'ArrowDown') {
        window.adjustScore(-1);
        event.preventDefault();
      }
    };
    offset.tabIndex = 0;
  }

  function hydrate(force) {
    applyShellFrame();
    if (!gpsVisible()) return;

    const badge = document.getElementById('gdV62GpsBadge') ||
      document.body.appendChild(Object.assign(document.createElement('div'), { id: 'gdV62GpsBadge' }));
    const profile = activeProfile();
    const name = usablePersonName(profile && profile.name) || 'Player';
    const mode = gpsMode();
    const sub = mode === 'live' ? 'Live' : '';
    const currentHoleLabel = holeLabel();
    const stat = currentHoleLabel || (mode === 'live' ? 'Location mode' : 'Set position');
    const modeLabel = mode === 'live' ? 'Live' : 'Manual';
    const course = assumedCourseLabel();
    const signature = [name, sub, stat, modeLabel, course, scoreDisplay(), scoreTone()].join('|');

    if (!force && badge.dataset.gdBadgeSig === signature && badge.childElementCount) return;

    badge.dataset.gdBadgeSig = signature;
    badge.classList.toggle('hasHole', !!currentHoleLabel);

    const main = document.createElement('div');
    main.className = 'main';
    if (course) {
      const courseTop = textNode('div', 'courseTop', course);
      courseTop.setAttribute('role', 'button');
      courseTop.setAttribute('tabindex', '0');
      courseTop.setAttribute('title', 'Change course');
      courseTop.onclick = function (event) {
        return typeof window.gdOpenChangeCourse === 'function' ? window.gdOpenChangeCourse(event) : false;
      };
      courseTop.onkeydown = function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          return typeof window.gdOpenChangeCourse === 'function' ? window.gdOpenChangeCourse(event) : false;
        }
      };
      main.append(courseTop);
    }
    main.append(textNode('div', 'name', name));
    if (sub) main.append(textNode('div', 'sub', sub));

    const offset = document.createElement('div');
    offset.className = 'offset';
    offset.dataset.scoreTone = scoreTone();
    wireScoreOffset(offset);
    offset.append(
      textNode('span', 'swipeMark top', '+'),
      textNode('span', 'mid', scoreDisplay()),
      textNode('span', 'swipeMark bottom', '-')
    );

    const status = document.createElement('div');
    status.className = 'status';
    const statusText = textNode('span', 'statusText', stat);
    const modeText = document.createElement('span');
    modeText.className = 'modeText';
    modeText.append(textNode('i', 'dot', ''), textNode('b', '', modeLabel));
    status.append(statusText, modeText);

    badge.replaceChildren(main, offset, status);
  }

  let queued = false;

  function schedule(force) {
    if (queued && !force) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      hydrate(!!force);
    });
  }

  window.gdHydrateGpsBadge = hydrate;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => schedule(true));
  } else {
    schedule(true);
  }

  window.addEventListener('load', () => schedule(true));
  window.addEventListener('clarity:session-changed', () => schedule(true));
  document.addEventListener('click', () => {
    schedule(true);
    setTimeout(() => schedule(true), 80);
    setTimeout(() => schedule(true), 240);
  }, true);
  safe(() => new MutationObserver(() => schedule(false)).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-clarity-route'],
    subtree: true,
    childList: true,
  }));

  ['enterGpsModule', 'setGpsPlayMode', 'refreshGPS'].forEach((name) => {
    const old = window[name];
    if (typeof old === 'function' && !old.__gdBadgeHydrate) {
      const wrapped = function wrappedGpsBadgeHydrate(...args) {
        const result = old.apply(this, args);
        setTimeout(() => schedule(true), 40);
        setTimeout(() => schedule(false), 180);
        return result;
      };
      wrapped.__gdBadgeHydrate = true;
      window[name] = wrapped;
    }
  });

  setTimeout(() => schedule(true), 120);
  setTimeout(() => schedule(false), 700);
})();

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
      document.body.classList.contains('gps-active');
  }

  function storedProfile() {
    try {
      const raw = JSON.parse(localStorage.getItem('gd_player_profiles_v27') || '{}');
      if (!Array.isArray(raw.profiles) || !raw.profiles.length) return null;
      return raw.profiles.find((profile) => profile && profile.id === raw.activeId) || raw.profiles[0] || null;
    } catch (error) {
      return null;
    }
  }

  function activeProfile() {
    return safe(() => typeof activePlayerProfile === 'function' ? activePlayerProfile() : null) ||
      storedProfile() ||
      { name: 'Demo Player' };
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
    if (!gpsVisible()) return;

    const badge = document.getElementById('gdV62GpsBadge') ||
      document.body.appendChild(Object.assign(document.createElement('div'), { id: 'gdV62GpsBadge' }));
    const profile = activeProfile();
    const name = (profile && profile.name) || 'Demo Player';
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
  document.addEventListener('click', () => setTimeout(() => schedule(false), 80), true);
  safe(() => new MutationObserver(() => schedule(false)).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
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

(function () {
  'use strict';

  var target = typeof window !== 'undefined' ? window : globalThis;

  function compactToken(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function normalToken(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9/]/g, '');
  }

  function unique(values) {
    var seen = {};
    var out = [];
    (values || []).forEach(function (value) {
      var text = String(value || '').trim();
      if (!text) return;
      var key = text.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(text);
    });
    return out;
  }

  var entries = [
    {
      key: 'club',
      label: 'Club',
      aliases: ['club', 'club label', 'club name'],
      headerAliases: ['club']
    },
    {
      key: 'carry',
      label: 'Carry',
      rawLabel: 'Carry',
      candidateMetric: 'carryDistance',
      unit: 'm',
      confidence: 0.72,
      aliases: ['carry', 'carry distance', 'carry dist', 'distance', 'carrydistance']
    },
    {
      key: 'total',
      label: 'Total',
      rawLabel: 'Total',
      candidateMetric: 'totalDistance',
      unit: 'm',
      confidence: 0.68,
      aliases: ['total', 'total distance', 'total dist', 'totaldistance']
    },
    {
      key: 'offline',
      label: 'Offline',
      rawLabel: 'Offline',
      candidateMetric: 'offline',
      unit: 'm',
      confidence: 0.7,
      aliases: ['offline', 'off', 'side', 'side carry', 'side total', 'lateral', 'dispersion']
    },
    {
      key: 'clubSpeed',
      label: 'ClubSpeed',
      rawLabel: 'ClubSpeed',
      candidateMetric: 'clubSpeed',
      unit: 'm/s',
      confidence: 0.42,
      aliases: ['club speed', 'clubspeed', 'club head speed', 'clubhead speed', 'clubheadspeed', 'swing speed', 'swingspeed', 'chs']
    },
    {
      key: 'attackAngle',
      label: 'AttackAngle',
      rawLabel: 'AttackAngle',
      candidateMetric: 'attackAngle',
      unit: 'deg',
      confidence: 0.42,
      aliases: ['attack', 'attack angle', 'attack ang', 'attackangle', 'attackang', 'angle of attack', 'aoa']
    },
    {
      key: 'sideAngle',
      label: 'SideAngle',
      rawLabel: 'SideAngle',
      candidateMetric: 'sideAngle',
      unit: 'deg',
      confidence: 0.66,
      aliases: ['side angle', 'sideangle', 'side ang', 'sideang', 'offline angle', 'offlineangle', 'lateral angle', 'lateralangle', 'result angle', 'resultangle']
    },
    {
      key: 'launchDirection',
      label: 'LaunchDirection',
      rawLabel: 'LaunchDirection',
      candidateMetric: 'launchDirection',
      unit: 'deg',
      confidence: 0.66,
      aliases: ['launch direction', 'launch dir', 'launchdirection', 'launchdir', 'start direction', 'startdirection', 'start line', 'startline', 'horizontal launch', 'horizontal launch angle', 'horizontallaunch', 'azimuth', 'direction', 'hla']
    },
    {
      key: 'ballSpeed',
      label: 'BallSpeed',
      rawLabel: 'BallSpeed',
      candidateMetric: 'ballSpeed',
      unit: 'mph',
      confidence: 0.58,
      aliases: ['ball speed', 'ballspeed', 'ball speed mph', 'ballspeedmph', 'ball spd', 'ballspd', 'b speed', 'bspeed', 'bspd', 'ball velocity', 'initial velocity', 'bs'],
      headerAliases: ['ball'],
      metricNames: ['speed']
    },
    {
      key: 'smashFactor',
      label: 'Smash',
      rawLabel: 'Smash',
      candidateMetric: 'smashFactor',
      unit: '',
      confidence: 0.58,
      aliases: ['smash', 'smash factor', 'smashfac', 'smashfactor']
    },
    {
      key: 'spinAxis',
      label: 'SpinAxis',
      rawLabel: 'SpinAxis',
      candidateMetric: 'spinAxis',
      unit: 'deg',
      confidence: 0.54,
      aliases: ['spin axis', 'spinaxis', 'axis']
    },
    {
      key: 'sideSpin',
      label: 'SideSpin',
      rawLabel: 'SideSpin',
      candidateMetric: 'sideSpin',
      unit: 'rpm',
      confidence: 0.52,
      aliases: ['side spin', 'sidespin', 'side spin rpm', 'sidespinrpm']
    },
    {
      key: 'totalSpin',
      label: 'TotalSpin',
      rawLabel: 'TotalSpin',
      candidateMetric: 'totalSpin',
      unit: 'rpm',
      confidence: 0.5,
      aliases: ['spin', 'spin rate', 'spinrate', 'spin rpm', 'spinrpm', 'total spin', 'totalspin'],
      metricNames: ['backspin']
    },
    {
      key: 'backspin',
      label: 'Backspin',
      rawLabel: 'Backspin',
      candidateMetric: 'backspin',
      unit: 'rpm',
      confidence: 0.48,
      aliases: ['backspin', 'back spin']
    },
    {
      key: 'faceToPath',
      label: 'FaceToPath',
      rawLabel: 'FaceToPath',
      candidateMetric: 'faceToPath',
      unit: 'deg',
      confidence: 0.74,
      aliases: ['face to path', 'face/path', 'face path', 'facetopath', 'facepath', 'ftp']
    },
    {
      key: 'swingDirection',
      label: 'SwingDirection',
      rawLabel: 'SwingDirection',
      candidateMetric: 'swingDirection',
      unit: 'deg',
      confidence: 0.52,
      aliases: ['swing direction', 'swing dir', 'swingdirection', 'swingdir']
    },
    {
      key: 'clubPath',
      label: 'ClubPath',
      rawLabel: 'ClubPath',
      candidateMetric: 'clubPath',
      unit: 'deg',
      confidence: 0.72,
      aliases: ['club path', 'clubpath', 'path']
    },
    {
      key: 'faceAngle',
      label: 'FaceAngle',
      rawLabel: 'FaceAngle',
      candidateMetric: 'faceAngle',
      unit: 'deg',
      confidence: 0.68,
      aliases: ['face angle', 'face ang', 'faceangle', 'faceang', 'face to target', 'face target']
    },
    {
      key: 'dynamicLoft',
      label: 'DynamicLoft',
      rawLabel: 'DynamicLoft',
      candidateMetric: 'dynamicLoft',
      unit: 'deg',
      confidence: 0.58,
      aliases: ['dynamic loft', 'dynamicloft', 'dyn loft', 'dynloft']
    },
    {
      key: 'launch',
      label: 'Launch',
      rawLabel: 'Launch',
      candidateMetric: 'launchAngle',
      unit: 'deg',
      confidence: 0.48,
      aliases: ['launch', 'launch angle', 'launch ang', 'launchangle', 'launchang', 'vertical launch', 'vertical launch angle', 'vla']
    },
    {
      key: 'peakHeight',
      label: 'PeakHeight',
      rawLabel: 'PeakHeight',
      candidateMetric: 'peakHeight',
      unit: 'ft',
      confidence: 0.42,
      aliases: ['height', 'peak', 'peak height', 'peak ht', 'peakheight', 'peakht', 'apex', 'apex height', 'max height', 'maximum height']
    },
    {
      key: 'descent',
      label: 'Descent',
      rawLabel: 'Descent',
      candidateMetric: 'descentAngle',
      unit: 'deg',
      confidence: 0.42,
      aliases: ['descent', 'desc', 'descent angle', 'descentangle', 'land angle', 'landing angle', 'landangle', 'landingangle']
    },
    {
      key: 'toPin',
      label: 'To Pin',
      aliases: ['to pin', 'topin']
    },
    {
      key: 'lastData',
      label: 'Last Data',
      aliases: ['last data', 'lastdata']
    }
  ];

  var byKey = {};
  var byAlias = {};

  entries.forEach(function (entry) {
    byKey[entry.key] = entry;
    unique([entry.key, entry.label, entry.rawLabel, entry.candidateMetric].concat(entry.aliases || [], entry.headerAliases || [])).forEach(function (alias) {
      byAlias[compactToken(alias)] = entry.key;
    });
  });

  function canonicalKey(value) {
    var token = compactToken(value);
    return token ? byAlias[token] || '' : '';
  }

  function entryFor(keyOrAlias) {
    var raw = String(keyOrAlias || '').trim();
    if (!raw) return null;
    return byKey[raw] || byKey[canonicalKey(raw)] || null;
  }

  function headerLabel(keyOrAlias) {
    var entry = entryFor(keyOrAlias);
    return entry ? entry.label : String(keyOrAlias || '');
  }

  function metricConfig(keyOrAlias) {
    var entry = entryFor(keyOrAlias);
    if (!entry || !entry.candidateMetric) return null;
    return {
      key: entry.key,
      label: entry.rawLabel || entry.label || entry.key,
      candidateMetric: entry.candidateMetric,
      unit: entry.unit || '',
      confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.5
    };
  }

  function headerAliases(keyOrAlias) {
    var entry = entryFor(keyOrAlias);
    if (!entry) return [];
    return unique([entry.key, entry.label, entry.rawLabel, entry.candidateMetric].concat(entry.aliases || [], entry.headerAliases || []));
  }

  function lineAliases(keyOrAlias) {
    var entry = entryFor(keyOrAlias);
    if (!entry) return [];
    return unique([entry.label, entry.rawLabel, entry.candidateMetric, entry.key].concat(entry.lineAliases || [], entry.aliases || []))
      .sort(function (a, b) { return b.length - a.length; });
  }

  function metricNames(keyOrAlias) {
    var entry = entryFor(keyOrAlias);
    if (!entry) return unique([keyOrAlias]);
    return unique([entry.candidateMetric, entry.rawLabel, entry.label, entry.key].concat(entry.metricNames || [], entry.aliases || []));
  }

  function metricKeys() {
    return entries.filter(function (entry) { return !!entry.candidateMetric; }).map(function (entry) { return entry.key; });
  }

  var api = {
    version: '2026-06-12',
    entries: entries,
    compactToken: compactToken,
    normalToken: normalToken,
    canonicalKey: canonicalKey,
    entry: entryFor,
    headerLabel: headerLabel,
    metricConfig: metricConfig,
    headerAliases: headerAliases,
    lineAliases: lineAliases,
    metricNames: metricNames,
    metricKeys: metricKeys
  };

  target.GolfDaddyLaunchMonitorAliasRegistry = api;
  target.ClarityCaddieLaunchMonitorAliasRegistry = api;
  target.LaunchMonitorAliasRegistry = api;
})();

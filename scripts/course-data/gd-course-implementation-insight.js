(function () {
  'use strict';

  /*
    Course implementation insight.

    The only place in Course Data allowed to write a sentence. It reads the
    analysis object from gd-course-transfer-score.js and says what the evidence
    shows -- nothing else. It performs no maths of its own beyond rounding, so a
    figure can never appear on screen that the analysis did not produce.

    THE RULE THIS LAYER EXISTS TO KEEP:

      the bubble placement is the player's recorded intended plan, and is never
      treated as wrong.

    So there is no phrasing here that suggests moving the bubble, re-aiming it,
    or that it was placed badly. A left-heavy result is described as a left-heavy
    result, and then offered as evidence that the player's physical alignment is
    tending right of the direction they chose. That is an implementation
    observation about the human, not a correction to the plan.

    Nor does it diagnose a swing. "Finishing short" is a pattern; whether that is
    strike, club selection, wind reading or decision making is another system's
    question. The copy stops at the pattern.

    And it never manufactures a signal. Balanced data gets told it is balanced.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var SIDE_WORD = {
    left_outcome_bias: 'left',
    right_outcome_bias: 'right',
    short: 'short',
    long: 'long'
  };

  /*
    A left-heavy result points at alignment tending the OTHER way. Stated once,
    here, rather than inverted at each call site where the sign could be got
    backwards without anything failing.
  */
  var ALIGNMENT_TENDENCY = {
    left_outcome_bias: 'right',
    right_outcome_bias: 'left'
  };

  var QUADRANT_WORD = {
    'short-left': 'short-left',
    'short-right': 'short-right',
    'long-left': 'long-left',
    'long-right': 'long-right'
  };

  /*
    The state word on the chip. 'valid' has no word: a full sample is the
    unqualified case, and labelling it would make the ordinary state look like
    a warning.
  */
  var STATE_WORD = {
    insufficient_data: 'Collecting',
    provisional: 'Provisional',
    unreadable: 'Unreadable'
  };

  /*
    THE SCORE'S COLOUR IS A BAND, NOT A SENTENCE. The screen used to be told
    "10/10 (provisional)" and had to colour it green because the copy said so.
    Now the band is named here and the stylesheet holds the hexes, so the colour
    decision is testable in the same place the score is read, and no hex ever
    reaches this layer.
  */
  var TONE_BANDS = [
    { maxScore: 4, tone: 'low' },
    { maxScore: 7, tone: 'mid' }
  ];

  var SCALE_MAX = 10;

  function pct(value) {
    return Math.round(Number(value) || 0) + '%';
  }

  function shotCount(n) {
    return n + (n === 1 ? ' shot' : ' shots');
  }

  function toneFor(score) {
    if (score === null) return 'none';
    for (var i = 0; i < TONE_BANDS.length; i++) {
      if (score <= TONE_BANDS[i].maxScore) return TONE_BANDS[i].tone;
    }
    return 'high';
  }

  /*
    THE RAIL IS THE WHOLE SCALE, NOT A PROGRESS BAR. Each segment carries the
    band IT sits in rather than the band the score landed in, so a 7 shows the
    red stretch it climbed out of and the green it has not reached. Built here
    because the band boundaries are TONE_BANDS: derived on the screen instead,
    the 4 and the 7 would exist twice and a tuning change would recolour the
    number without recolouring the rail underneath it.

    state: 'at' is the reading. 'on' is ground already covered and is dimmed to
    a third, so exactly one segment is ever at full strength.
  */
  function railFor(score) {
    var out = [];
    for (var n = 1; n <= SCALE_MAX; n++) {
      out.push({
        value: n,
        band: toneFor(n),
        state: score === null || n > score ? 'off' : (n === score ? 'at' : 'on')
      });
    }
    return out;
  }

  /*
    'PROVISIONAL · 14 SHOTS'. The sample size travels with the state word
    because the two are the same fact -- the state IS what this many shots has
    earned -- and splitting them lets a screen show one without the other.
  */
  function chipFor(analysis) {
    var word = STATE_WORD[analysis.analysisState];
    var shots = shotCount(Math.max(0, Math.round(Number(analysis.sampleSize) || 0)));
    return word ? word + ' · ' + shots : shots;
  }

  /*
    Absent stays absent. Number(null) is 0 -- a finite value -- so reading the
    score with a plain Number() would turn "there is no score yet" into a hard
    zero: a red 0/10 on the rail for a player who has simply not logged ten
    shots. Same trap the score layer documents at asNumber, same answer.
  */
  function scoreValue(analysis) {
    var raw = analysis.transferScore;
    if (raw === null || raw === undefined || raw === '') return null;
    var n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function scoreSection(analysis) {
    var score = scoreValue(analysis);

    return {
      key: 'score',
      title: 'Course Score',
      // The bare number. '/10' is a fixed denominator the screen draws beside
      // it, not part of the reading, and 'provisional' is the chip's job now.
      headline: score === null ? '—' : String(score),
      body: '',
      score: score,
      outOf: SCALE_MAX,
      tone: toneFor(score),
      rail: railFor(score),
      chip: chipFor(analysis)
    };
  }

  /*
    Everything the score does NOT say on its face, in one place the player opens
    only if they want it: what the number measures, and how much of the pattern
    the bubble actually held. Both are read straight off the analysis.
  */
  function explainSection(analysis) {
    var coverage = analysis.coverageAtMyBubble;
    var held = coverage && coverage.sampleSize
      ? coverage.inside + ' of ' + shotCount(coverage.sampleSize) + ' — ' + pct(coverage.insidePercent)
        + ' — finished inside the bubble.'
      : null;

    return {
      key: 'explain',
      title: 'What this means',
      body: 'Out of 10, how close your course performance was to where you aimed the GPS bubble.',
      note: held
    };
  }

  /*
    RETIRED FROM THE SCREEN, KEPT IN THE LAYER. Alignment, distance and the
    quadrant sentence are no longer rendered -- the quadrant read moved onto the
    graph as four corner percentages, and the other two were removed from the
    Course Data card. The wording stays here, exercised by the copy-safety
    tests, so bringing a section back is a render decision rather than a rewrite
    of language that has already been argued over.
  */
  function alignmentSection(analysis) {
    if (analysis.alignmentConfidence === 'none') {
      return {
        key: 'alignment',
        title: 'Alignment',
        body: 'Alignment looks well matched to your planned bubble.'
      };
    }

    var side = SIDE_WORD[analysis.alignmentBias];
    var tendency = ALIGNMENT_TENDENCY[analysis.alignmentBias];
    var hedge = analysis.alignmentConfidence === 'provisional' ? ' On this many shots that is an early read.' : '';

    return {
      key: 'alignment',
      title: 'Alignment',
      body: pct(analysis.alignmentShare) + ' of your shots finished ' + side
        + ' of your intended pattern. Your physical alignment appears to be tending '
        + tendency + ' of the direction you selected on the phone.' + hedge
    };
  }

  function distanceSection(analysis) {
    if (analysis.distanceConfidence === 'none') {
      return {
        key: 'distance',
        title: 'Distance',
        body: 'Distance outcomes sit evenly around your intended position.'
      };
    }

    var side = SIDE_WORD[analysis.distanceBias];
    var hedge = analysis.distanceConfidence === 'provisional' ? ' On this many shots that is an early read.' : '';

    return {
      key: 'distance',
      title: 'Distance',
      body: pct(analysis.distanceShare) + ' of your shots finished ' + side
        + ' of your intended pattern.' + hedge
    };
  }

  /*
    Quadrant concentration earns a line only when it says something the two
    totals above have not already said. A 47% short-left corner under a
    left-and-short reading is corroboration worth stating; the same corner where
    both sides came back balanced is noise.
  */
  function quadrantSection(analysis) {
    if (!analysis.dominantQuadrant) return null;
    if (analysis.quadrantConfidence !== 'clear' && analysis.quadrantConfidence !== 'dominant') return null;
    if (analysis.alignmentConfidence === 'none' && analysis.distanceConfidence === 'none') return null;

    return {
      key: 'pattern',
      title: 'Pattern',
      body: pct(analysis.dominantQuadrantShare) + ' of your shots are concentrated '
        + QUADRANT_WORD[analysis.dominantQuadrant]
        + ' of the intended bubble, which supports both readings above occurring together.'
    };
  }

  /*
    TWO SECTIONS, AND THE SECOND ONE IS FOLDED AWAY. The screen is a score and
    the evidence behind it; every other reading either moved onto the graph or
    was cut. A shot set below the sample gate still gets both -- the score
    renders as a dash and the chip says Collecting -- because hiding the block
    would leave a player who has logged six shots with nothing to tell them why.
  */
  function buildCourseInsight(analysis) {
    if (!analysis || typeof analysis !== 'object') return null;

    var score = scoreSection(analysis);
    var explain = explainSection(analysis);

    return {
      state: analysis.analysisState,
      headline: score.headline,
      detail: explain.body,
      sections: [score, explain]
    };
  }

  var api = {
    buildCourseInsight: buildCourseInsight,
    // Not used by the Course Data screen. Exported so the retired sections stay
    // reachable and testable rather than becoming quietly dead code.
    retiredSections: {
      alignment: alignmentSection,
      distance: distanceSection,
      quadrant: quadrantSection
    }
  };

  root.modules.courseImplementationInsight = api;
  window.GolfDaddyCourseImplementationInsight = api;
  window.ClarityCaddieCourseImplementationInsight = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();

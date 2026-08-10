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

  function pct(value) {
    return Math.round(Number(value) || 0) + '%';
  }

  function scoreSection(analysis) {
    var target = pct((analysis.targetCoverage || 0) * 100);

    if (analysis.analysisState === 'insufficient_data') {
      var needed = analysis.config ? analysis.config.provisionalMinShots : 10;
      return {
        key: 'score',
        title: 'Course Transfer',
        headline: 'Collecting data',
        body: analysis.sampleSize + ' of ' + needed + ' shots needed before a transfer score means anything.'
      };
    }

    if (analysis.analysisState === 'unreadable') {
      return {
        key: 'score',
        title: 'Course Transfer',
        headline: 'Outside the readable range',
        body: 'Even at ' + pct(analysis.config.maxScalePercent) + ' the bubble does not reach ' + target
          + ' of your shots, so there is no reliable score to give yet.'
      };
    }

    var provisional = analysis.analysisState === 'provisional';
    return {
      key: 'score',
      title: 'Course Transfer',
      headline: analysis.transferScore + '/10' + (provisional ? ' (provisional)' : ''),
      body: '+' + pct(analysis.requiredGrowthPercent) + ' bubble growth captures ' + target + ' of your shots.'
    };
  }

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

  function buildCourseInsight(analysis) {
    if (!analysis || typeof analysis !== 'object') return null;

    var score = scoreSection(analysis);
    var sections = [score];

    // Below the sample gate there is nothing to say about direction, and saying
    // it anyway is how a screen starts inventing coaching.
    if (analysis.analysisState !== 'insufficient_data') {
      sections.push(alignmentSection(analysis));
      sections.push(distanceSection(analysis));
      var pattern = quadrantSection(analysis);
      if (pattern) sections.push(pattern);
    }

    return {
      state: analysis.analysisState,
      headline: score.headline,
      detail: score.body,
      sections: sections
    };
  }

  var api = {
    buildCourseInsight: buildCourseInsight
  };

  root.modules.courseImplementationInsight = api;
  window.GolfDaddyCourseImplementationInsight = api;
  window.ClarityCaddieCourseImplementationInsight = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderHealthAvailability, renderHealthComponents } from '../frontend/health-visuals.js';

test('unavailable verified health exposes provider and weighted input gates at decision precision', () => {
  const coverage = { state: 'partial', ready: false, received: 5_151, traded: 5_162, expected: 5_258,
    ratio: 5_151 / 5_258, completenessThreshold: .98 };
  const coveragePart = (id, observed) => ({ id, value: 42, score: null, weight: .15, reason: 'insufficient_comparable_coverage',
    adequacy: { observed, expected: 5_162, ratio: observed / 5_162, threshold: .98, sufficient: false } });
  const health = { state: 'insufficient_coverage', reason: 'insufficient_coverage', score: null, coverage,
    components: [coveragePart('shortBreadth', 4_965), coveragePart('longBreadth', 4_124), coveragePart('highsLows', 4_053),
      { id: 'industryLeadership', score: null, weight: .1, value: null, denominator: 0, reason: 'input_unavailable' },
      { id: 'priceMomentum', score: null, weight: 0, value: null, reason: 'input_unavailable' }],
    missingComponents: ['shortBreadth', 'longBreadth', 'highsLows', 'industryLeadership'] };
  const { window } = new JSDOM(renderHealthAvailability(health, { datedHealthUrl: '#overview?classification=sec-sic&reference=as-of' }));
  const gate = window.document.querySelector('#health-availability');
  const visible = gate.querySelector('ul').textContent;
  assert.match(gate.querySelector('p').textContent, /score for every positively weighted component/);
  assert.match(visible, /Provider source coverage · 5,151 of 5,258 expected securities \(97\.965%\), below the 98% minimum/);
  assert.match(visible, /Long-term breadth · 4,124 of 5,162 comparable securities \(79\.892%\), below the 98% minimum/);
  assert.match(visible, /New highs versus new lows · 4,053 of 5,162 comparable securities \(78\.516%\)/);
  assert.match(visible, /Four-week relative strength comparison unavailable with the Nasdaq directory/);
  assert.equal(gate.querySelector('a').getAttribute('href'), '#overview?classification=sec-sic&reference=as-of');
  assert.doesNotMatch(gate.textContent, /Price momentum participation/);
  assert.equal(gate.querySelector('details').open, false);
  assert.match(gate.querySelector('details').textContent, /1 more component requirement.*Short-term breadth/s);
  assert.equal(renderHealthAvailability({ ...health, score: 0 }), '');
  window.close();
});

test('observed health distinguishes comparable coverage from a missing calibration', () => {
  const health = { state: 'insufficient_inputs', coverageMode: 'observed', observedThreshold: .8, observedMinimum: 20,
    coverage: { state: 'partial', ready: true, ratio: .9796 }, missingComponents: ['longBreadth', 'highsLows', 'priceMomentum'],
    components: [
      { id: 'longBreadth', value: 55, score: null, weight: .2, reason: 'insufficient_comparable_coverage',
        adequacy: { observed: 4_372, expected: 5_469, ratio: 4_372 / 5_469, threshold: .8, sufficient: false } },
      { id: 'highsLows', value: -2, score: null, weight: .2, reason: 'insufficient_comparable_coverage',
        adequacy: { observed: 4_297, expected: 5_469, ratio: 4_297 / 5_469, threshold: .8, sufficient: false } },
      { id: 'priceMomentum', value: 40, score: null, weight: .2, reason: 'insufficient_calibration_history',
        calibration: { type: 'percentile', observations: 18, minObservations: 60 } },
      { id: 'industryLeadership', value: 50, score: 50, weight: .1, denominator: 68,
        adequacy: { observedIndustries: 68, comparableIndustries: 69, groupRatio: 68 / 69, threshold: .8, sufficient: true } },
    ] };
  const { window } = new JSDOM(renderHealthAvailability(health));
  const reasons = window.document.querySelector('#health-availability').textContent;
  assert.match(reasons, /4,372 of 5,469 comparable securities \(79\.941%\), below the 80% minimum/);
  assert.match(reasons, /4,297 of 5,469 comparable securities \(78\.57%\), below the 80% minimum/);
  assert.match(reasons, /Calibration has 18 prior readings and requires 60/);
  assert.doesNotMatch(reasons, /Provider source coverage|Industry leadership breadth|Use filing-dated SEC groups/);
  window.close();
});

test('observed classified-subset diagnostics use industry comparisons rather than whole-universe classifications', () => {
  const health = { state: 'insufficient_inputs', coverageMode: 'observed', missingComponents: ['industryLeadership'],
    components: [{ id: 'industryLeadership', value: 50, score: null, weight: .1, reason: 'insufficient_comparable_coverage',
      adequacy: { observed: 3_000, expected: 5_500, ratio: 3_000 / 5_500, threshold: .8, sufficient: false,
        comparisonScope: 'observed_classified_subset', minimumClassified: 20,
        observedIndustries: 40, comparableIndustries: 60, groupRatio: 40 / 60 } }] };
  const { window } = new JSDOM(renderHealthAvailability(health));
  const reasons = window.document.querySelector('#health-availability').textContent;
  assert.match(reasons, /40 of 60 comparable industries \(66\.667%\), below the 80% minimum/);
  assert.doesNotMatch(reasons, /3,000|5,500/);
  window.close();
});

test('health graphics retain native units, exact counts, and genuinely published scores', () => {
  const health = { components: [
    { id: 'shortBreadth', value: 55, numerator: 11, denominator: 20, score: null, weight: .2, reason: 'insufficient_comparable_coverage',
      adequacy: { observed: 20, expected: 30 } },
    { id: 'intermediateBreadth', value: 30, score: 0, weight: .2 },
    { id: 'industryLeadership', value: null, score: null, numerator: 0, denominator: 0, weight: .1 },
  ] };
  const snapshot = { aggregates: { upDollar: 500, downDollar: 1500 }, breadth: {
    new_high_252d: { value: 10, numerator: 1, denominator: 10 }, new_low_252d: { value: 40, numerator: 4, denominator: 10 },
  } };
  const { window } = new JSDOM(renderHealthComponents(health, { snapshot, industryUrl: '#industries?classification=sec-sic&amp;date=2026-11-20' }));
  const { document } = window;
  const visible = document.querySelector('.health-component-list').textContent;
  const meters = [...document.querySelectorAll('[role="meter"]')];
  assert.deepEqual(meters.map((node) => [+node.getAttribute('aria-valuemin'), +node.getAttribute('aria-valuenow')]), [[0, 55], [0, 30], [0, 25], [-100, -30]]);
  assert.match(visible, /55\.0%.*Weight 20%/s);
  assert.match(visible, /Score 0\.0 \/ 100/);
  assert.equal(document.querySelectorAll('.health-score').length, 1);
  assert.equal(document.querySelector('.health-component-sparkline'), null);
  assert.match(visible, /Industry leadership breadth\s+Unavailable/);
  assert.doesNotMatch(visible, /Too few comparable/);
  const details = document.querySelector('details');
  assert.equal(details.open, false);
  assert.match(details.textContent, /11 of 20 · 20 observed \/ 30 expected · Too few comparable/);
  assert.match(details.textContent, /\$500\.00 of \$2,000\.00/);
  assert.match(details.textContent, /New highs 1 of 10 · New lows 4 of 10/);
  assert.match(document.querySelector('.text-link').getAttribute('href'), /classification=sec-sic/);
  window.close();
});

test('component mini charts use saved raw values and preserve gaps', () => {
  const history = [
    { date: '2026-11-20', components: [{ id: 'shortBreadth', value: 80, score: 5 }, { id: 'industryLeadership', value: 53 }] },
    { date: '2026-11-13', components: [{ id: 'shortBreadth', value: 20, score: 95 }, { id: 'highsLows', value: -12 }] },
    { date: '2026-11-16', components: [{ id: 'shortBreadth', value: 55 }, { id: 'highsLows', value: -12 }] },
    { date: '2026-11-17', components: [{ id: 'shortBreadth', value: null, score: 40 }] },
    { date: '2026-11-18', components: [{ id: 'shortBreadth', value: 35 }] },
  ];
  const { window } = new JSDOM(renderHealthComponents({ history }));
  const charts = [...window.document.querySelectorAll('.health-component-sparkline svg')];
  assert.equal(charts.length, 2);
  assert.match(charts[0].getAttribute('aria-label'), /Short-term breadth raw history · 20\.0% to 80\.0% · 4 readings · Nov 13, 2026 to Nov 20, 2026/);
  assert.equal(charts[0].querySelectorAll('polyline').length, 1, 'only the Friday-to-Monday pair is connected');
  assert.equal(charts[0].querySelectorAll('circle').length, 2, 'omitted inputs and dates break the series');
  assert.match(charts[1].querySelector('title').textContent, /-12\.0 pp to -12\.0 pp · 2 readings/);
  assert.match(charts[1].querySelector('polyline').getAttribute('points'), /,13\.00 \S+,13\.00$/);
  window.close();
});

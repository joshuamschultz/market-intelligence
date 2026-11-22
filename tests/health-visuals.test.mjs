import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderHealthComponents } from '../frontend/health-visuals.js';

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

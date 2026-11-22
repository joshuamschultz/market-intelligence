import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { chartRanges, rangeLimit } from '../frontend/chart-ranges.js';

test('standard chart ranges use trading-session lookbacks and convert calendar sampling', () => {
  assert.deepEqual(chartRanges, [[21, '1M'], [63, '3M'], [126, '6M'], [252, '1Y'], [1260, '5Y']]);
  assert.deepEqual(chartRanges.map(([value]) => rangeLimit(value, 'weekly')), [5, 13, 26, 52, 260]);
  assert.deepEqual(chartRanges.map(([value]) => rangeLimit(value, 'monthly')), [1, 3, 6, 12, 60]);
  assert.equal(rangeLimit(1260, 'daily'), 1260);
});

test('focus scales both bounded axes in their original units and preserves observations', async (t) => {
  const dom = new JSDOM('<main></main>');
  const prior = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = prior; dom.window.close(); });
  const { chart } = await import('../frontend/charts.js');
  const { percent, rate } = await import('../frontend/ui.js');
  const page = document.querySelector('main');
  const data = [
    { date: '2026-11-18', breadth: 58.21, fraction: .4211 },
    { date: '2026-11-19', breadth: 58.27, fraction: .4213 },
    { date: '2026-11-20', breadth: 58.29, fraction: .4215 },
  ];
  const series = [{ key: 'breadth', label: 'Breadth', format: percent }, { key: 'fraction', label: 'Share', axis: 'right', format: rate }];
  const options = { domain: [0, 100], rightDomain: [0, 1], axisFormat: (value) => percent(value, 0), rightAxisFormat: (value) => rate(value, 0, false) };
  page.innerHTML = chart(data, series, options);
  const ticks = (side) => [...page.querySelectorAll(`[data-y-tick="${side}"]`)].map((node) => parseFloat(node.textContent));
  assert.deepEqual(ticks('left'), [0, 25, 50, 75, 100]);
  assert.deepEqual(ticks('right'), [0, 25, 50, 75, 100]);
  page.querySelector('[data-chart-scale="focus"]').click();
  const left = ticks('left');
  const right = ticks('right');
  assert.ok(left[0] < 58.21 && left.at(-1) > 58.29 && left.at(-1) < 59);
  assert.ok(right[0] < 42.11 && right.at(-1) > 42.15 && right.at(-1) < 43);
  assert.equal(new Set(left).size, 5, 'narrow data are displayed at distinguishable precision');
  assert.equal(new Set(right).size, 5);
  assert.equal(document.activeElement.dataset.chartScale, 'focus');
  page.querySelector('[data-plot]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.match(page.querySelector('.chart-tooltip').textContent, /58\.3%/);
  page.querySelector('[data-chart-scale="full"]').click();
  assert.deepEqual(ticks('left'), [0, 25, 50, 75, 100]);
  assert.deepEqual(ticks('right'), [0, 25, 50, 75, 100]);

  page.innerHTML = chart(data.map((row) => ({ ...row, breadth: 0, fraction: null })), series, options);
  page.querySelector('[data-chart-scale="focus"]').click();
  assert.deepEqual(ticks('right'), [0, 25, 50, 75, 100]);
  assert.equal(ticks('left')[0], 0);
  assert.ok(ticks('left').at(-1) > 0);
  assert.doesNotMatch(page.innerHTML, /NaN|Infinity/);
  page.innerHTML = chart(data.map(({ date }) => ({ date })), series, options);
  assert.match(page.textContent, /No comparable observations/);

  const displayedRange = (dates) => {
    page.innerHTML = chart(dates.map((date) => ({ date, breadth: 55 })), [series[0]]);
    return page.querySelector('.chart-navigation [aria-live]').textContent;
  };
  assert.equal(displayedRange(['2025-11-20', '2026-02-02', '2026-04-02', '2026-07-02', '2026-09-02', '2026-11-20']),
    'Nov 20, 2025 – Nov 20, 2026');
  assert.equal(displayedRange(['2025-12-26', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02', '2026-01-05']),
    'Dec 26, 2025 – Jan 5, 2026');
  assert.equal(displayedRange(['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']),
    'Jan 2 – Jan 9');
});

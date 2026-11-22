import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { expectedSessions } from '../backend/calendar.mjs';
import { replayMarketTiming, TIMING_INSTRUMENTS, TIMING_MODEL_VERSION, TIMING_PROFILE } from '../backend/market-timing.mjs';

const dates = expectedSessions('2025-01-02', '2025-07-31').slice(0, 70);
const warm = Array.from({ length: 60 }, (_, index) => ({ close: 100 + index * .2, volume: 100 }));
const recovery = [{ close: 90, low: 88, volume: 110 }, { close: 89, low: 86, volume: 120 }, { close: 90, low: 87, volume: 90 },
  { close: 90.5, low: 88, volume: 100 }, { close: 92, low: 89, volume: 110 }, { close: 95, low: 92, volume: 130 },
  { close: 105, volume: 140 }, { close: 104, volume: 200 }, { close: 103.5, volume: 210 }, { close: 103.5, volume: 100 }];
const point = { date: dates.at(-1), dataVersion: 91, basis: 'reconstructed' };
const bars = new Map([...warm, ...recovery].map((bar, index) => [dates[index], { low: bar.close * .99, ...bar }]));
const rows = replayMarketTiming(dates, { SPY: bars, QQQ: bars, IXIC: bars });
const timeline = rows.map(({ date, instruments, risk }) => ({ date, risk, instruments: Object.fromEntries(Object.entries(instruments).map(([symbol, row]) => [symbol,
  { close: row.close, phase: row.phase, averages: row.trend?.averages, signals: row.signals, distribution: row.distribution },
])) }));

function fixture(t) {
  const dom = new JSDOM('<head></head><main><div id="summary"></div><div id="review"></div></main>', { url: 'http://localhost' });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
    dom.window.close();
  });
  return dom.window;
}

test('session review pins history and exposes chart, volume markers, searchable expiry, and range retry', async (t) => {
  const window = fixture(t);
  const { document } = window;
  const { createTimingReview } = await import('../frontend/market-timing.js');
  const assertBound = (request, limit) => assert.deepEqual(request, { ...point, limit });
  const calls = [];
  let fail5Y = true;
  const env = { state: {}, isActive: () => true, async api(path, { params, plain }) {
    assert.equal(path, 'market/timing');
    assert.equal(plain, true);
    calls.push(params);
    if (params.limit === 1260 && fail5Y) throw new Error('Offline');
    return { ...point, state: 'ready', modelVersion: TIMING_MODEL_VERSION, profile: TIMING_PROFILE, instruments: TIMING_INSTRUMENTS,
      session: rows.at(-1), history: timeline.slice(-params.limit) };
  } };
  const target = document.querySelector('#review');
  const overview = document.querySelector('#summary');
  const review = createTimingReview(env, point);
  await review.mount(overview, null);
  assertBound(calls[0], 1);
  assert.match(overview.textContent, /Session review.*SPY.*QQQ.*IXIC/s);
  await review.mount(overview, target);
  assertBound(calls[1], 63);
  assert.deepEqual([...target.querySelectorAll('[data-action="timing-range"]')].map((button) => button.textContent), ['1M', '3M', '6M', '1Y', '5Y']);
  assert.match(target.textContent, /Nasdaq Composite index.*Reported index volume/s);
  assert.match(target.textContent, /F · Follow-through.*D · Distribution/s);
  const plot = target.querySelector('[data-plot]');
  assert.ok([...plot.querySelectorAll('text')].some((label) => label.textContent === 'F'));
  assert.ok([...plot.querySelectorAll('text')].some((label) => label.textContent === 'D'));
  plot.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  for (let index = 0; index < 4; index++) plot.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.match(target.querySelector('.chart-tooltip').textContent, /Follow-through.*volume 130 vs 110.*rally day 4/s);
  review.instrument('SPY');
  assert.match(target.textContent, /SPY S&P 500 ETF proxy.*ETF share volume/s);
  assert.equal(document.activeElement.dataset.value, 'SPY');
  review.instrument('QQQ');
  assert.match(target.textContent, /Nasdaq-100 ETF proxy/);
  const audit = target.querySelector('.timing-audit');
  assert.equal(audit.querySelectorAll('[data-timing-audit-row]:not([hidden])').length, 2);
  const active = target.querySelector('[data-timing-audit-active]');
  active.checked = false;
  active.dispatchEvent(new window.Event('change'));
  const search = target.querySelector('[data-timing-audit-search]');
  search.value = 'price recovery';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(audit.querySelectorAll('[data-timing-audit-row]:not([hidden])').length, 2);
  assert.match(audit.querySelector('[data-timing-audit-row]:not([hidden])').textContent, /5% price recovery/);
  assert.doesNotMatch(target.textContent, /\bibd\b|minervini/i);
  assert.match(target.textContent, /Risk posture history.*Moving averages and slopes.*Method and sources/s);
  await review.range('1260');
  assertBound(calls[2], 1260);
  assert.match(target.textContent, /could not be loaded/);
  assert.ok(target.querySelector('[data-action="timing-retry"]'));
  fail5Y = false;
  await review.retry();
  assertBound(calls[3], 1260);
  assert.equal(target.querySelector('[data-action="timing-retry"]'), null);
  assert.equal(target.querySelector('[data-action="timing-range"][aria-pressed="true"]').dataset.value, '1260');
  assert.equal(document.head.querySelectorAll('[data-market-timing-styles]').length, 1);
});

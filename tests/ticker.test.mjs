import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const date = '2025-05-30';
const securityId = 'fixture:ARCT';
const context = {
  universe: 'us-core', universeVersion: 1, model: 'composite', modelVersion: 3,
  date, dataVersion: 19, classification: 'sec-sic', reference: 'as-of', basis: 'known',
};

function setup(t, api) {
  const dom = new JSDOM('<main></main>');
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => {
    globalThis.document = previousDocument;
    dom.window.close();
  });
  const calls = [];
  const env = {
    main: document.querySelector('main'), params: { symbol: securityId }, snapshotContext: context, context,
    signal: new AbortController().signal, config: { models: [{ id: 'composite', version: 3, name: 'Composite RS' }] },
    isActive: () => true, routeUrl: (page, patch) => `#${page}?${new URLSearchParams(patch)}`,
    setActions(actions) { this.actions = actions; },
    async api(path, options) {
      calls.push({ path, params: { ...context, ...options.params } });
      return api(path, options);
    },
    async publishedSeries() { assert.fail('Polled without an existing preparation job'); },
  };
  return { env, calls };
}

function chartBars(length = 130) {
  const bars = [];
  const session = new Date(`${date}T00:00:00Z`);
  while (bars.length < length) {
    if (![0, 6].includes(session.getUTCDay())) {
      bars.push({
        date: session.toISOString().slice(0, 10), source: 'Fixture prices',
        traded: true, open: 30, high: 32, low: 29, close: 31, volume: 1200,
      });
    }
    session.setUTCDate(session.getUTCDate() - 1);
  }
  return bars.reverse();
}

test('ticker dashboard defaults to 126 daily candles and uses the selected historical context', async (t) => {
  const bars = chartBars();
  const { env, calls } = setup(t, (path, options) => {
    if (path.endsWith('/rankings')) return { rows: [{ date, percentile: 96, udv_50d: 1.7 }] };
    if (path.endsWith('/screens')) return { date, evaluated: 0, screens: [] };
    return {
      symbol: 'ARCT', name: 'Arctic Technologies', exchange: 'NASDAQ Global Market', type: 'common',
      date, latestDate: date, referenceDate: date, dataVersion: 19, securityId,
      chartBars: [...(options.params.lookback > 126 ? chartBars(1265) : bars), { ...bars.at(-1), date: '2025-06-02' }],
      close: 31, traded: true, return_1d: 0.04, above_50d: true, rvol_20d: 2.1,
      rsRank: 3, rsPercentile: 96, rsScore: 0.214, velocity1w: 0, velocity4w: 8, velocity12w: null,
      lifecycle: 'Established Leader', topDecileWeeks4w: 4, leadingWeeks: 9, udv_50d: null,
      udv_state_50d: 'infinity', udv_obs_50d: 50, industry: 'Technology',
      sectorRelativeReturn: 0.015, range_since_high_20d: 0, range_age_low_20d: null,
    };
  });
  const { render } = await import('../frontend/ticker.js');
  await render(env);
  const { main } = env;
  assert.deepEqual(calls, [{ path: 'stocks/fixture%3AARCT', params: { ...context, lookback: 126 } }]);
  assert.equal(main.querySelector('h1').textContent, 'ARCT · Arctic Technologies');
  assert.match(main.querySelector('.subtitle').textContent, /May 30, 2025/);
  assert.match(main.querySelector('.inline-stack').textContent, /Fixture prices.*Composite RS/);
  assert.match(main.querySelector('.inline-stack').textContent, /Advancer.*Up at least 4%.*Above 50D SMA.*Top-decile RS/);
  const tradingView = main.querySelector('.tradingview-link');
  assert.equal(tradingView.href, 'https://www.tradingview.com/chart/?symbol=NASDAQ%3AARCT');
  assert.equal(tradingView.target, '_blank');
  const price = main.querySelector('#stock-price-panel');
  const candles = () => price.querySelectorAll('[data-plot] rect[fill="#76e2a7"]').length;
  assert.match(price.querySelector('.muted').textContent, /126 market sessions/);
  assert.match(price.querySelector('[data-plot]').getAttribute('aria-label'), /daily candlestick chart/);
  assert.equal(candles(), 126);
  assert.equal(price.querySelector('[data-action="stock-range-local"][aria-pressed="true"]').textContent, '6M');
  env.actions['stock-range-local']('21');
  assert.equal(candles(), 21);
  env.actions['stock-cadence-local']('weekly');
  assert.ok(candles() > 0 && candles() <= 5);
  const metric = (id) => main.querySelector(`[data-metric="${id}"] strong`).textContent;
  assert.equal(metric('dailyMove'), 'Advancer');
  assert.equal(metric('above_50d'), 'Yes');
  assert.equal(metric('rvol_20d'), '2.10×');
  assert.equal(metric('udv_50d'), '∞');
  assert.equal(metric('rsRank'), '3');
  assert.equal(metric('rsScore'), '0.2140');
  assert.equal(metric('velocity1w'), '0.0');
  assert.equal(metric('velocity12w'), '—');
  assert.equal(metric('lifecycle'), 'Established Leader');
  assert.equal(metric('topDecileWeeks4w'), '4');
  assert.equal(metric('industry'), 'Technology');
  assert.equal(metric('sectorRelativeReturn'), '+1.50%');
  assert.equal(metric('range_since_high_20d'), '0');
  assert.equal(metric('range_age_low_20d'), '—');

  main.querySelector('[data-value="rs"]').click();
  main.querySelector('[data-value="screens"]').click();
  await setImmediate();
  assert.deepEqual(calls.slice(1), [
    { path: 'stocks/fixture%3AARCT/rankings', params: { ...context, cadence: 'weekly', limit: 52 } },
    { path: 'stocks/fixture%3AARCT/screens', params: context },
  ]);
  assert.ok(main.querySelector('#stock-rs-chart [data-plot]'));
  assert.ok(main.querySelector('#stock-rs-chart [data-chart-scale="focus"]'));
  assert.match(main.querySelector('#stock-screens').textContent, /No saved screen matches/);
  main.querySelector('#stock-rs-chart [data-action="stock-rank-range"][data-value="1260"]').click();
  await setImmediate();
  assert.deepEqual(calls.at(-1), { path: 'stocks/fixture%3AARCT/rankings', params: { ...context, cadence: 'weekly', limit: 260 } });

  env.actions['stock-section']('price');
  env.actions['stock-cadence-local']('daily');
  await env.actions['stock-range-local']('1260');
  const longPrice = main.querySelector('#stock-price-panel');
  assert.equal(longPrice.querySelector('[data-action="stock-range-local"][aria-pressed="true"]').textContent, '5Y');
  assert.equal(longPrice.querySelectorAll('[data-plot] rect[fill="#76e2a7"]').length, 1260);
  assert.equal(main.querySelector('[data-action="stock-section"][aria-pressed="true"]').dataset.value, 'price');
  assert.ok(calls.some(({ path, params }) => path === 'stocks/fixture%3AARCT' && params.lookback === 1260 &&
    params.date === date && params.dataVersion === context.dataVersion && params.modelVersion === context.modelVersion));
});

test('ticker sections switch locally and expose prepared values, dated fundamentals, and source links', async (t) => {
  const { env, calls } = setup(t, () => ({ symbol: 'ARCT', name: '<img src=x>', securityId, date, dataVersion: 19,
    chartBars: chartBars(), return_1d: -0.02, close: 31, gap: 0, rvol_20d: 1.5, dailyMove: null, traded: true,
    dollar_volume: 31_900, above_50d: false, up_volume_20d: 0.56, up_frequency_20d: 0.55, upVolumeShareChange4w: 0.04,
    obv_slope_10d: null, obv_slope_20d: 0, obv_slope_50d: -100, obv_slope_100d: null, market_cap: 72_000_000,
    shares: 1_700_000, sharesDate: date, float: null, float_turnover_1d: null, marketCapBucket: null,
    industryId: 'industry:mock', industry: 'Semiconductors', classificationSystem: 'sec-sic', referenceMode: 'as-of',
  }));
  const { render } = await import('../frontend/ticker.js');
  await render(env);
  const { main } = env;
  const panel = (selector) => main.querySelector(selector)?.closest('[data-stock-section]');
  const select = (section) => env.actions['stock-section'](section);
  const selected = () => main.querySelector('[data-action="stock-section"][aria-pressed="true"]').dataset.value;
  assert.equal(selected(), 'session');
  assert.equal(panel('#stock-price-panel').hidden, false);
  assert.equal(panel('[data-metric="dailyMove"]').hidden, false);
  assert.equal(panel('[data-metric="avg_volume_20d"]').hidden, true);
  assert.equal(panel('[data-metric="market_cap"]').hidden, true);
  assert.equal(main.querySelector('h1 img'), null);
  const chart = main.querySelector('#stock-price-panel [data-chart]');
  select('volume');
  assert.equal(selected(), 'volume');
  assert.equal(panel('#stock-price-panel').hidden, true);
  assert.equal(panel('[data-metric="avg_volume_20d"]').hidden, false);
  for (const [field, value] of [['up_volume_20d', '56.00%'], ['up_frequency_20d', '55.00%'],
    ['upVolumeShareChange4w', '+4.00%'], ['obv_slope_20d', '0'], ['obv_slope_50d', '-100']]) {
    assert.equal(main.querySelector(`[data-metric="${field}"] strong`).textContent, value);
  }
  assert.equal(main.querySelector('[data-metric="obv_slope_10d"], [data-metric="obv_slope_100d"]'), null);
  select('liquidity');
  assert.equal(panel('[data-metric="market_cap"]').hidden, false);
  assert.match(panel('[data-metric="market_cap"]').textContent, /Shares effective dateMay 30, 2025/);
  assert.equal(main.querySelector('[data-metric="marketCapBucket"], [data-metric="float_turnover_1d"]'), null);
  const peers = new URLSearchParams(main.querySelector('a[href^="#industries"]').hash.split('?')[1]);
  assert.equal(peers.get('date'), date);
  assert.equal(peers.get('dataVersion'), '19');
  assert.equal(peers.get('modelVersion'), '3');
  assert.equal(peers.get('group'), 'industry:mock');
  select('all');
  assert.equal(main.querySelector('[data-stock-section][hidden]'), null);
  select('price');
  assert.strictEqual(main.querySelector('#stock-price-panel [data-chart]'), chart);
  assert.equal(panel('[data-metric="sma_20d"]').hidden, false);
  assert.equal(panel('[data-metric="avg_volume_20d"]').hidden, true);
  assert.equal(calls.length, 1);
});

test('ticker dashboard shows unavailable historical preparation without re-querying a newer session', async (t) => {
  const { env, calls } = setup(t, () => ({
    pendingOnly: true, date, materialization: { preparationState: 'unregistered' },
  }));
  const { render } = await import('../frontend/ticker.js');
  await render(env);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { ...context, lookback: 126 });
  assert.match(env.main.textContent, /Selected session May 30, 2025/);
  assert.match(env.main.textContent, /has yet to be prepared for the selected context/);
  assert.ok(env.main.querySelector('[data-action="warehouse-jobs"]'));
  assert.equal(env.main.querySelector('[data-chart]'), null);
});

test('ticker dashboard follows an existing preparation job for the selected session', async (t) => {
  const initial = {
    pendingOnly: true, date,
    materialization: { pending: true, jobId: 'prepared-historical', status: 'running', progress: 53 },
  };
  const { env, calls } = setup(t, () => initial);
  env.publishedSeries = async (path, options, onProgress) => {
    assert.equal(path, 'stocks/fixture%3AARCT');
    assert.equal(options.signal, env.signal);
    assert.equal(options.initialResponse, initial);
    onProgress(initial, initial.materialization);
    assert.match(env.main.querySelector('#stock-warming').textContent, /Preparing ticker dashboard · 53%/);
    return { symbol: 'ARCT', securityId, date, chartBars: chartBars() };
  };
  const { render } = await import('../frontend/ticker.js');
  await render(env);
  assert.equal(calls.length, 1);
  assert.match(env.main.querySelector('.subtitle').textContent, /May 30, 2025/);
  assert.ok(env.main.querySelector('#stock-price-panel [data-plot]'));
  assert.equal(env.main.querySelector('#stock-warming').textContent, '');
});

test('a pending price product preserves displayed RS until explicit scoped preparation finishes', async (t) => {
  const initial = { symbol: 'ARCT', securityId, date, dataVersion: 19, close: 31, rsPercentile: 96,
    detailPreparation: { metrics: { state: 'ready' }, weekly: { state: 'ready' }, chart: { state: 'requires-exact-date' },
      risk: { state: 'not-prepared' } } };
  const { env, calls } = setup(t, (path, options) => {
    if (!path.endsWith('/prepare')) return initial;
    assert.equal(options.body.context.date, date);
    assert.equal(options.body.context.dataVersion, 19);
    assert.equal(options.body.lookback, 126);
    assert.equal(options.body.followLatest, false);
    return { id: 'detail-review', status: 'queued' };
  });
  env.publishedSeries = async (_path, options, onProgress) => {
    assert.equal(options.initialResponse.materialization.jobId, 'detail-review');
    onProgress(initial, { id: 'detail-review', status: 'running', progress: 50 });
    assert.match(env.main.querySelector('#stock-price-panel').textContent, /Preparing price history/);
    assert.equal(env.main.querySelector('[data-metric="rsPercentile"] strong').textContent, '96.0');
    return { ...initial, chartBars: chartBars(), risk: { observations: 125 },
      detailPreparation: { ...initial.detailPreparation, chart: { state: 'ready' }, risk: { state: 'ready' } } };
  };
  const { render } = await import('../frontend/ticker.js');
  await render(env);
  assert.equal(calls.length, 1);
  assert.equal(env.main.querySelector('[data-metric="rsPercentile"] strong').textContent, '96.0');
  assert.match(env.main.querySelector('#stock-price-panel').textContent, /requires its own prepared price frame/);
  await env.actions['prepare-ticker-detail']();
  assert.equal(calls.length, 2);
  assert.ok(env.main.querySelector('#stock-price-panel [data-plot]'));
  assert.equal(env.main.querySelector('[data-metric="observations"] strong').textContent, '125');
});

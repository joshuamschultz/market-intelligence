import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import {
  applyPreparedRangeMetrics, calculateRangeMetrics, prepareRangeHistoryBatch, prepareRangeMetrics, rangeWindowsForScreen,
  readPreparedRangeMetrics, validateRangeWindows, verifyPreparedExactRanges, verifyPreparedRangeHistory,
} from '../backend/range-metrics.mjs';
import { screenStocks } from '../backend/screener.mjs';
import { fieldDetails, rangeFieldId } from '../frontend/ui.js';

const dates = expectedSessions('2022-01-03', '2025-01-01');
const bar = (date, { close = 100, open = close, high = 110, low = 90, ...rest } = {}) =>
  ({ date, close, open, high, low, traded: true, ...rest });
const approximately = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} differs from ${expected}`);

test('range distance uses intraday extremes, includes today, and respects inclusive percentages', () => {
  const chart = [bar(dates[0], { close: 92, high: 96 }), bar(dates[1], { close: 95, high: 99 }),
    bar(dates[2], { close: 97.5, high: 100 })];
  const values = calculateRangeMetrics(chart, [2, 3, 4]);
  assert.equal(values.range_distance_high_3d, -0.025);
  const rescaled = chart.map(({ open, high, low, close, ...row }) => ({ ...row, open: open / 3, high: high / 3, low: low / 3, close: close / 3 }));
  assert.equal(calculateRangeMetrics(rescaled, [3]).range_distance_high_3d, -0.025);
  assert.equal(values.range_age_high_3d, 0);
  assert.equal(values.range_age_low_3d, 0);
  assert.equal(values.range_distance_high_4d, null);
  assert.equal(values.range_distance_low_4d, null);
  const low = calculateRangeMetrics([bar(dates[0], { close: 102.5, high: 110, low: 100 })], [1]);
  assert.equal(low.range_distance_low_1d, 0.025);
  const result = screenStocks({ date: dates[2], stocks: [{ traded: true, securityId: 'X', symbol: 'X', ...values }] }, {
    filter: { field: 'range_distance_high_3d', op: 'between', value: [-0.025, 0] },
  });
  assert.equal(result.total, 1);
});

test('strict breakout age can exceed the lookback and ties do not reset it', () => {
  const rows = dates.slice(0, 52).map((date, index) => bar(date, { high: index < 20 ? 110 : index === 20 || index === 21 ? 125 : 115 }));
  assert.equal(calculateRangeMetrics(rows.slice(0, 21), [20]).range_since_high_20d, 0);
  const tied = calculateRangeMetrics(rows.slice(0, 22), [20]);
  assert.equal(tied.range_since_high_20d, 1);
  assert.equal(tied.range_age_high_20d, 0);
  const thirty = calculateRangeMetrics(rows.slice(0, 51), [20]);
  assert.equal(thirty.range_since_high_20d, 30);
  assert.equal(thirty.range_age_high_20d, 0);
  const fiftyTwoWeeks = dates.slice(0, 503).map((date, index) => bar(date, { low: index === 252 ? 80 : 90 }));
  const low = calculateRangeMetrics(fiftyTwoWeeks, [252]);
  assert.equal(low.range_since_low_252d, 250);
  const stocks = [
    { ...thirty, ...low, symbol: 'MATCH', securityId: 'A', traded: true },
    { ...thirty, ...low, range_since_high_20d: 29, symbol: 'YOUNGER', securityId: 'B', traded: true },
    { ...thirty, ...low, range_since_low_252d: null, symbol: 'UNKNOWN', securityId: 'C', traded: true },
  ];
  const screened = screenStocks({ date: dates[502], stocks }, { filter: { operator: 'and', filters: [
    { field: 'range_since_high_20d', op: 'gte', value: 30 },
    { field: 'range_since_low_252d', op: 'gte', value: 250 },
  ] } });
  assert.deepEqual(screened.rows.map(({ symbol }) => symbol), ['MATCH']);
});

test('missing, quarantined and unverified split crossings stop the clock', () => {
  const rows = dates.slice(0, 7).map((date, i) => bar(date, { high: i === 3 ? 120 : 110 }));
  const both = calculateRangeMetrics(rows, [2]);
  assert.equal(both.range_since_high_2d, 3);
  assert.equal(both.range_since_low_2d, null);
  const omitted = rows.filter((_, index) => index !== 4);
  const gap = calculateRangeMetrics(omitted, [2, 3]);
  assert.equal(gap.range_since_high_2d, null);
  assert.equal(gap.range_since_high_3d, null);
  assert.equal(gap.range_distance_high_3d, null);
  assert.ok(gap.range_distance_high_2d < 0);
  const marker = rows.map((row, index) => index === 4 ? { ...row, unverifiedSplit: true } : row);
  assert.equal(calculateRangeMetrics(marker, [3]).range_since_high_3d, null);
  assert.ok(calculateRangeMetrics(marker, [3]).range_distance_high_3d < 0);
  assert.equal(calculateRangeMetrics(marker, [4]).range_distance_high_4d, null);
  const quarantined = rows.map((row, index) => index === 5 ? { ...row, priceQuarantined: true } : row);
  assert.equal(calculateRangeMetrics(quarantined, [2]).range_distance_low_2d, null);
  assert.equal(calculateRangeMetrics(rows.slice(0, -1), [2], { date: dates[6] }).range_distance_low_2d, null);
});

test('sliding extrema agree with a direct comparison for every trailing window', () => {
  const rows = dates.slice(0, 65).map((date, index) => bar(date, { high: 100 + (index * 23 % 17), low: 100 - (index * 47 % 13) }));
  const lookbacks = [1, 2, 3, 7, 11, 16, 32, 65];
  const values = calculateRangeMetrics(rows, lookbacks);
  for (const window of lookbacks) {
    const rolling = rows.slice(-window);
    const high = Math.max(...rolling.map(({ high }) => high));
    const low = Math.min(...rolling.map(({ low }) => low));
    const last = rows.length - 1;
    assert.equal(values[`range_age_high_${window}d`], last - rows.findLastIndex((row) => row.high === high));
    assert.equal(values[`range_age_low_${window}d`], last - rows.findLastIndex((row) => row.low === low));
    for (const side of ['high', 'low']) {
      const event = rows.findLastIndex((row, index) => index >= window && rows.slice(index - window, index)
        .every((prior) => side === 'high' ? row.high > prior.high : row.low < prior.low));
      assert.equal(values[`range_since_${side}_${window}d`], event < 0 ? null : last - event);
    }
  }
});

test('lookbacks are bounded, deduplicated and found in saved, computed, filter and sort fields', () => {
  assert.deepEqual(validateRangeWindows(['252', 20, 252, 37]), [20, 37, 252]);
  assert.throws(() => validateRangeWindows([0]), RangeError);
  assert.throws(() => validateRangeWindows([7561]), RangeError);
  assert.throws(() => validateRangeWindows(Array.from({ length: 17 }, (_, index) => index + 1)), /at most 16/);
  assert.throws(() => validateRangeWindows('20,20.5'), RangeError);
  assert.throws(() => validateRangeWindows([true]), RangeError);
  assert.deepEqual(rangeWindowsForScreen({ definition: {
    context: { rangeWindows: [20] }, columns: ['distance_high_252d', 'range_distance_high_37d'],
    sort: [{ field: 'range_since_low_252d' }],
    filter: { operator: 'and', filters: [{ field: 'range_age_low_50d', op: 'between', value: [4, 8] }] },
    computed: [{ field: 'custom_near', expression: 'range_distance_low_15d * 100' }],
  } }), [15, 20, 37, 50, 252]);
  assert.equal(fieldDetails(rangeFieldId('distance', 'high', 37)).format, 'rate');
  assert.equal(fieldDetails(rangeFieldId('since', 'low', 252)).label, 'Sessions since 252D new low');
  assert.equal(fieldDetails('distance_low_252d').label, 'From 52W low');
});

test('prepared rows use canonical split-adjusted quotes and exact session/version scope', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const sessions = dates.slice(0, 5);
  const [first, second, third, fourth, last] = sessions;
  const security = (symbol) => ({ symbol, type: 'common', exchange: 'NYSE', listingDate: first, knownAt: first });
  const prices = (symbol, date, close, high, low) => ({
    symbol, date, knownAt: date, close, open: close, high, low, adjustedClose: close, volume: 10_000,
  });
  importDataset(db, { provider: 'fixture', securities: [security('SPT'), security('GAP')],
    prices: [
      prices('SPT', first, 100, 110, 90), prices('SPT', second, 100, 110, 90),
      prices('SPT', third, 52, 53, 50), prices('SPT', fourth, 52, 53, 50), prices('SPT', last, 52, 54, 50),
      prices('GAP', second, 100, 110, 90), prices('GAP', last, 100, 105, 95),
    ], corporateActions: [{ symbol: 'SPT', type: 'split', date: third, factor: 2, knownAt: third }],
  });
  const engine = createEngine(db);
  const config = engine.context();
  const snapshot = engine.snapshot(config, { persist: false });
  assert.equal(readPreparedRangeMetrics(db, config, [4]).ready, false);
  assert.throws(() => applyPreparedRangeMetrics(snapshot, readPreparedRangeMetrics(db, config, [4])), /not been prepared/);
  const progress = [];
  const result = prepareRangeMetrics(db, engine, config, [2, 4, 7560], { progress: (step) => progress.push(step) });
  assert.deepEqual([result.written, result.reused, progress.at(-1)], [3, 0, 1]);
  const stored = readPreparedRangeMetrics(db, config, [2, 4, 7560]);
  assert.equal(stored.ready, true);
  const rows = applyPreparedRangeMetrics(snapshot, stored).stocks;
  const stock = rows.find(({ symbol }) => symbol === 'SPT');
  const gap = rows.find(({ symbol }) => symbol === 'GAP');
  approximately(stock.range_distance_high_4d, 52 / 55 - 1);
  assert.equal(stock.range_since_high_2d, 0);
  assert.equal(stock.range_distance_high_7560d, null);
  assert.equal(gap.range_distance_high_4d, null);
  assert.equal(Object.hasOwn(snapshot.stocks[0], 'range_distance_high_4d'), false);
  const sorted = screenStocks({ ...snapshot, stocks: rows }, { sort: [{ field: 'range_distance_high_4d', direction: 'desc' }] });
  assert.deepEqual(sorted.rows.map(({ symbol }) => symbol), ['SPT', 'GAP']);
  assert.deepEqual(readPreparedRangeMetrics(db, engine.context({ model: 'short-momentum' }), [4]).missingWindows, []);
  assert.deepEqual(readPreparedRangeMetrics(db, engine.context({ universe: 'nyse' }), [4]).missingWindows, []);
  assert.deepEqual(readPreparedRangeMetrics(db, engine.context({ basis: 'known' }), [4]).missingWindows, [4]);
  assert.deepEqual(readPreparedRangeMetrics(db, engine.context({ date: fourth }), [4]).missingWindows, [4]);
  assert.equal(prepareRangeMetrics(db, engine, config, [4]).reused, 1);
  importDataset(db, { provider: 'fixture', prices: [prices('SPT', last, 52.5, 54, 50)] });
  assert.equal(readPreparedRangeMetrics(db, engine.context(), [4]).ready, false);
  assert.equal(readPreparedRangeMetrics(db, config, [4]).ready, true);
});

test('bulk range history resumes by security, publishes only complete buckets, and reuses an unaffected append prefix', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const sessions = dates.slice(0, 61);
  const published = sessions.slice(0, -1);
  const splitDate = sessions[25];
  const security = (symbol) => ({ symbol, exchange: 'NYSE', type: 'common', listingDate: sessions[0], knownAt: sessions[0] });
  function price(symbol, date, index) {
    const close = (100 + (index % 13)) / (symbol === 'SPLT' && index >= 25 ? 2 : 1);
    return { symbol, date, knownAt: date, close, open: close, high: close * 1.025, low: close * 0.975, adjustedClose: close, volume: 10_000 };
  }
  const symbols = ['SPLT', 'VAR', 'ZZZ'];
  importDataset(db, { provider: 'bulk-fixture', securities: symbols.map(security),
    prices: published.flatMap((date, index) => symbols.filter((symbol) => symbol !== 'VAR' || index !== 35)
      .map((symbol) => price(symbol, date, index))),
    corporateActions: [{ symbol: 'SPLT', date: splitDate, knownAt: splitDate, type: 'split', factor: 2 }],
  });
  const engine = createEngine(db);
  const config = engine.context({ universe: 'nyse' });
  const inspect = (date, windows = [3, 20], point = config) => readPreparedRangeMetrics(db, { ...point, date }, windows);
  const seen = [];
  const instrumented = { ...engine, *detailSources(...args) {
    for (const detail of engine.detailSources(...args)) {
      seen.push(detail.securityId);
      yield detail;
    }
  }, snapshot() { assert.fail('Historical range preparation should not rebuild a market snapshot'); } };
  const one = prepareRangeHistoryBatch(db, instrumented, config, [3, 20], { bucketSize: 1 });
  assert.deepEqual([one.done, one.processedSecurities, one.totalSecurities], [false, 1, 3]);
  assert.deepEqual(inspect(sessions[23]).missingWindows, [3, 20]);
  const two = prepareRangeHistoryBatch(db, instrumented, config, [3, 20], { bucketSize: 1, cursor: one.cursor });
  const abort = AbortSignal.abort(new Error('stop'));
  assert.throws(() => prepareRangeHistoryBatch(db, instrumented, config, [3, 20], { signal: abort, cursor: two.cursor }), /stop/);
  assert.equal(inspect(sessions[23]).ready, false);
  const last = prepareRangeHistoryBatch(db, instrumented, config, [20, 3], { bucketSize: 1, cursor: one.cursor });
  assert.equal(last.done, true);
  assert.equal(last.processedSecurities, 3);
  assert.deepEqual(seen, ['bulk-fixture:SPLT', 'bulk-fixture:VAR', 'bulk-fixture:ZZZ']);
  assert.ok(inspect(sessions[23]).ready);
  assert.equal(inspect(sessions[36]).values.get(3).has('bulk-fixture:VAR'), false);
  for (const date of [sessions[23], sessions[24], sessions[25], sessions[26], sessions[40]]) {
    const point = { ...config, date };
    const id = 'bulk-fixture:SPLT';
    const exact = calculateRangeMetrics(engine.detail(point, id, 7560, { velocity: false }).chartBars, [3, 20]);
    const historical = applyPreparedRangeMetrics({ stocks: [{ securityId: id }] }, inspect(date)).stocks[0];
    for (const [field, value] of Object.entries(exact)) {
      if (value == null) assert.equal(historical[field], null);
      else approximately(historical[field], value);
    }
  }
  assert.equal(prepareRangeHistoryBatch(db, instrumented, config, [3, 20]).written, last.written);
  assert.equal(seen.length, 3);
  assert.equal(prepareRangeHistoryBatch(db, engine, { ...config, basis: 'known' }, [3]).status, 'unsupported-basis');
  assert.equal(inspect(sessions[23], [3], { ...config, basis: 'known' }).ready, false);

  const nextDate = sessions.at(-1);
  importDataset(db, { provider: 'bulk-fixture', prices: symbols.map((symbol) => price(symbol, nextDate, sessions.length - 1)) });
  const next = engine.context();
  assert.equal(inspect(sessions[23], [3], next).sources[3].dataVersion, config.dataVersion);
  assert.equal(inspect(nextDate, [3], next).ready, false);
  const appended = prepareRangeHistoryBatch(db, instrumented, next, [3, 20], { bucketSize: 3 });
  assert.equal(appended.done, true);
  assert.equal(appended.written, 2);
  assert.deepEqual(JSON.parse(db.prepare('SELECT starts FROM prepared_range_history_runs WHERE data_version=?').get(next.dataVersion).starts),
    [[3, nextDate], [20, nextDate]]);
  assert.equal(inspect(nextDate, [3], next).sources[3].dataVersion, next.dataVersion);
  const correctedDate = sessions[23];
  const correctedQuote = price('SPLT', correctedDate, 55);
  importDataset(db, { provider: 'bulk-fixture', prices: [correctedQuote] });
  const corrected = engine.context();
  assert.equal(inspect(sessions[22], [3], corrected).ready, true);
  assert.equal(inspect(correctedDate, [3], corrected).ready, false);
  assert.equal(inspect(nextDate, [3], corrected).ready, false);
});

test('range verification reconciles every date/window and rejects deleted middle-day data without treating sparse nulls as missing', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const sessions = dates.slice(0, 8);
  importDataset(db, { provider: 'fixture', securities: [{ symbol: 'ONE', type: 'common', exchange: 'NYSE',
    listingDate: sessions[0], knownAt: sessions[0] }], prices: sessions.map((date, index) => ({
    ...bar(date, { close: 100 + index }), symbol: 'ONE', knownAt: date, volume: 10_000,
  })) });
  const engine = createEngine(db);
  const config = engine.context();
  const windows = [3, 100];
  assert.equal(prepareRangeHistoryBatch(db, engine, config, windows, { dates: sessions }).done, true);
  const first = verifyPreparedRangeHistory(db, config, sessions, windows);
  assert.equal(first.pairs, 16);
  assert.ok(first.emptyPairs >= sessions.length && first.blocks > 0);
  assert.throws(() => verifyPreparedExactRanges(db, config, [3]), /exact range windows are missing/);
  prepareRangeMetrics(db, engine, config, [3]);
  assert.equal(verifyPreparedExactRanges(db, config, [3]), 1);
  db.prepare('DELETE FROM prepared_range_history_blocks WHERE date=? AND lookback=3').run(sessions[4]);
  assert.ok(readPreparedRangeMetrics(db, { ...config, date: sessions[4] }, [3]).ready);
  assert.throws(() => verifyPreparedRangeHistory(db, config, sessions, windows), /block count differs/);
});

test('bulk history withholds explicitly ambiguous supplied split bases and prefers exact date preparation', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const [first, second, third, last] = dates;
  const quotes = dates.slice(0, 4).map((date, index) => {
    const close = index < 2 ? 100 : 50;
    return { symbol: 'SPLT', date, knownAt: date, close, open: close, high: close, low: close,
      ...(index === 0 ? { splitClose: 100 } : {}), adjustedClose: close, volume: 1000 };
  });
  importDataset(db, { provider: 'uncertain-basis', securities: [{ symbol: 'SPLT', exchange: 'NYSE', type: 'common', listingDate: first, knownAt: first }],
    prices: quotes, corporateActions: [{ symbol: 'SPLT', type: 'split', factor: 2, date: third, knownAt: third }] });
  const engine = createEngine(db);
  const config = engine.context();
  const done = prepareRangeHistoryBatch(db, engine, config, [2]);
  assert.equal(done.basisExclusions, 1);
  assert.equal(readPreparedRangeMetrics(db, { ...config, date: second }, [2]).values.get(2).size, 0);
  assert.equal(readPreparedRangeMetrics(db, { ...config, date: last }, [2]).values.get(2).size, 1);
  const selected = { ...config, date: second };
  prepareRangeMetrics(db, engine, selected, [2]);
  const restored = readPreparedRangeMetrics(db, selected, [2]);
  assert.deepEqual(restored.sources, {});
  assert.equal(restored.values.get(2).get('uncertain-basis:SPLT')[0], 0);
});

test('bounded historical range products preserve warmup and publish only the selected contiguous output sessions', (t) => {
  const source = openDatabase(':memory:');
  const target = openDatabase(':memory:');
  t.after(() => { source.close(); target.close(); });
  const sessions = dates.slice(0, 60);
  const securityId = 'bounded:SPLT';
  const prices = sessions.map((date, i) => ({ symbol: 'SPLT', date, open: 100 + i, high: 101 + i,
    low: 99 + i, close: 100 + i, volume: 50000, knownAt: date }));
  importDataset(source, { provider: 'bounded', prices, securities: [{ symbol: 'SPLT', exchange: 'NYSE',
    type: 'common', listingDate: sessions[0], knownAt: sessions[0] }] });
  const engine = createEngine(source);
  const config = engine.context();
  const output = sessions.slice(-5);
  const result = prepareRangeHistoryBatch(target, engine, config, [20], { dates: output, sourceDb: source });
  assert.deepEqual([result.done, result.processedSecurities, result.written], [true, 1, output.length]);
  assert.equal(readPreparedRangeMetrics(target, { ...config, date: sessions.at(-6) }, [20]).ready, false);
  const stored = readPreparedRangeMetrics(target, { ...config, date: output[0] }, [20]);
  assert.ok(stored.ready);
  assert.equal(stored.values.get(20).get(securityId)[2], 0);
  assert.throws(() => prepareRangeHistoryBatch(target, engine, config, [20], { dates: [output[0], output.at(-1)], sourceDb: source }),
    /contiguous trading sessions/);
});

test('high/low controls register explicitly and save ordinary range filters and sortable columns', async (t) => {
  const dom = new JSDOM('<main></main><dialog><div></div></dialog>');
  const previousDocument = globalThis.document;
  const previousFormData = globalThis.FormData;
  globalThis.document = dom.window.document;
  globalThis.FormData = dom.window.FormData;
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.FormData = previousFormData;
    dom.window.close();
  });
  const { render } = await import('../frontend/screener.js');
  const latestDate = dates[0];
  const modal = document.querySelector('dialog');
  const target = modal.firstElementChild;
  const network = [];
  let actions;
  const context = { universe: 'us-core', model: 'composite' };
  const result = { date: latestDate, total: 0, universeCount: 0, rows: [], page: 1, perPage: 50 };
  const env = {
    main: document.querySelector('main'), modal, page: 'screener', state: {}, context, params: {},
    signal: new AbortController().signal, config: { models: [{ id: 'composite' }], screens: [], status: { latestDate }, exportFormats: ['csv'] },
    snapshotContext: { ...context, date: latestDate, dataVersion: 8 },
    isActive: () => true, setActions(value) { actions = value; }, routeUrl: () => '#',
    async api(path, options) {
      network.push({ path, body: options.body });
      if (path === 'market/breadth') return { coverage: { state: 'complete' } };
      if (path === 'screens') return { name: options.body.name, id: 'saved-range' };
      return result;
    },
    async publishedSeries(path, options) { network.push({ path, body: options.body }); return result; },
    showDialog(dialog, title, html) { target.innerHTML = html; return target; },
    async reloadConfig() {}, toast() {}, go() {},
  };
  await render(env);
  assert.equal(network.filter(({ path }) => path === 'data/preparation').length, 0);
  actions['range-filters']();
  let form = target.querySelector('form');
  assert.ok(form);
  form.elements.side.value = 'low';
  form.elements.lookback.value = '37';
  form.elements.value.value = '2.5';
  await target.onsubmit({ preventDefault() {} });
  assert.deepEqual(env.state.filter.filters, [{ field: 'range_distance_low_37d', op: 'between', value: [0, 0.025] }]);
  assert.ok(env.state.columns.includes('range_distance_high_37d'));
  assert.ok(env.state.columns.includes('range_distance_low_37d'));
  assert.deepEqual(network.find(({ path }) => path === 'data/preparation').body.context.rangeWindows, [37]);

  actions['range-filters']();
  form = target.querySelector('form');
  form.elements.measure.value = 'since';
  form.elements.measure.dispatchEvent(new dom.window.Event('change'));
  assert.equal(form.elements.condition.value, 'gte');
  assert.equal(form.elements.value.value, '30');
  await target.onsubmit({ preventDefault() {} });
  assert.deepEqual(env.state.filter.filters.at(-1), { field: 'range_since_high_20d', op: 'gte', value: 30 });
  await actions.sort('range_since_high_20d', null, { shiftKey: false });
  assert.deepEqual(env.state.sort, [{ field: 'range_since_high_20d', direction: 'asc' }]);
  actions['save-screen']();
  form = target.querySelector('form');
  form.elements.name.value = 'Price range study';
  await target.onsubmit({ target: form, preventDefault() {} });
  const saved = network.find(({ path }) => path === 'screens').body.definition;
  assert.equal(saved.dateMode, 'latest');
  assert.deepEqual(saved.context.rangeWindows, [20, 37]);
  assert.deepEqual(saved.filter.filters, env.state.filter.filters);
  assert.deepEqual(saved.sort, env.state.sort);
});

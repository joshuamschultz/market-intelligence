import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBreadth, createBreadthFrame } from '../backend/breadth.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine, stockBaseFields } from '../backend/engine.mjs';
import { indexPriceSeries, prepareBars, returnWindow, sharePriceIndex, stockMetrics, volumeRatio } from '../backend/metrics.mjs';
import { annotateGroupVelocity, annotateVelocity, createStockVelocityLayer } from '../backend/ranking.mjs';

function unfoldStock({ base, overrides, baseAfter, additions }) {
  if (!base) return overrides;
  const own = Object.entries(overrides);
  const shared = stockBaseFields(Object.keys(base), additions).map((field) =>
    [field, additions && Object.hasOwn(additions.values, field) ? additions.values[field] : base[field]]);
  return Object.fromEntries([...own.slice(0, baseAfter), ...shared, ...own.slice(baseAfter)]);
}

function equivalent(actual, expected, path = '') {
  if (typeof actual === 'number' && typeof expected === 'number' && Number.isFinite(actual) && Number.isFinite(expected)) {
    const tolerance = 1e-10 * Math.max(1, Math.abs(expected));
    assert.ok(Math.abs(actual - expected) <= tolerance, `${path}: ${actual} differs from ${expected}`);
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
    for (const key of Object.keys(expected)) equivalent(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

function quote(date, position, offset = 0) {
  const close = (42 + offset) * (1 + position / 1700 + 0.02 * Math.sin(position / 4 + offset));
  return { date, open: close * 1.002, high: close * 1.01, low: close * 0.99, close,
    adjusted_close: close, volume: 3000 + (position * 83 + offset * 91) % 40000 };
}

test('indexed rolling metrics match finite canonical windows through shifts, gaps and split and volume boundaries', () => {
  const dates = expectedSessions('2022-01-03', '2026-11-20').slice(-800);
  const bars = prepareBars(dates.map((date, index) => quote(date, index)), [], dates.at(-1));
  bars[141] = null;
  bars[219] = { ...bars[219], traded: false };
  bars[331] = { ...bars[331], unverifiedSplit: true };
  bars[469] = { ...bars[469], volume: null, dollarVolume: null };
  bars[594] = { ...bars[594], volume: 0, dollarVolume: 0, traded: false };
  bars[667] = { ...bars[667], unverifiedSplit: true };
  const marks = prepareBars(dates.map((date, index) => quote(date, index, 150)), [], dates.at(-1));
  for (const bar of bars) if (bar) bar.float = 200000 + bar.close;
  const indexed = indexPriceSeries(bars);
  const benchmark = indexPriceSeries(marks);
  for (const end of [0, 1, 139, 141, 142, 217, 219, 220, 330, 331, 332, 468, 469, 470, 594, 595, 666, 667, 668, 799]) {
    for (const start of [0, Math.max(0, end - 211), end]) {
      const input = bars.slice(start, end + 1);
      const positions = sharePriceIndex(bars.slice(start, end + 1), indexed, start);
      const rawBenchmark = marks.slice(start, end + 1);
      const preparedBenchmark = sharePriceIndex(marks.slice(start, end + 1), benchmark, start);
      const settings = { averages: [1, 10, 20, 50, 100, 200], windows: [1, 21, 252], volumeWindows: [3, 50, 87] };
      equivalent(stockMetrics({ shares: 100 }, positions, { ...settings, benchmarkSeries: preparedBenchmark }),
        stockMetrics({ shares: 100 }, input, { ...settings, benchmarkSeries: rawBenchmark }), `${start}-${end}`);
      for (const period of [1, 5, 20, 50, 253]) {
        equivalent(volumeRatio(positions, positions.length - 1, period), volumeRatio(input, input.length - 1, period));
        assert.equal(returnWindow(positions, positions.length - period - 1, positions.length - 1, 'total'),
          returnWindow(input, input.length - period - 1, input.length - 1, 'total'));
      }
    }
  }
});

test('indexed averages avoid cancellation after old high-price observations', () => {
  const dates = expectedSessions('2023-01-03', '2026-11-20').slice(-720);
  const bars = prepareBars(dates.map((date, index) => {
    const close = index < 400 ? 122_500_023.17 + index : 0.37 + index % 10 / 1000;
    return { date, open: close, high: close, low: close, close, adjusted_close: close, volume: 1000.37 };
  }), [], dates.at(-1));
  const start = 410;
  const view = sharePriceIndex(bars.slice(start), indexPriceSeries(bars), start);
  equivalent(stockMetrics({}, view), stockMetrics({}, bars.slice(start)));
});

test('date-major variants preserve scoped classification, vintage, benchmark, ranks and nulls', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2023-01-03', '2026-11-20').slice(-750);
  const first = dates[0];
  const securities = ['AAA', 'BBB', 'CCC', 'SPY', 'VTI'].map((symbol, i) => ({ symbol, name: symbol,
    exchange: i % 2 ? 'NASDAQ' : 'NYSE', type: i < 3 ? 'common' : 'etf', listingDate: first, knownAt: first }));
  const prices = securities.flatMap(({ symbol }, i) => dates.flatMap((date, index) => {
    if (i !== 0 && i < 3 && index % 97 === 0) return [];
    const item = quote(date, index, i);
    if (i === 0 && index < 710) for (const key of ['open', 'high', 'low', 'close']) item[key] *= 2;
    return [{ ...item, symbol, knownAt: date }];
  }));
  const formulas = ['provider', 'sec-sic'].flatMap((system) => securities.slice(0, 3).map(({ symbol }, i) => ({
    symbol, system, sector: `${system} sector`, industry: `${system} industry ${i}`, knownAt: first, effectiveFrom: first,
  })));
  importDataset(db, { provider: 'fixture', securities, prices, classifications: formulas,
    actions: [{ symbol: 'AAA', type: 'split', date: dates[710], knownAt: dates[710], factor: 2 }],
    fundamentals: [{ symbol: 'AAA', float: 700000, shares: 1000000, knownAt: dates[300], effectiveDate: dates[296] },
      { symbol: 'AAA', float: 830000, shares: 1100000, knownAt: dates[735], effectiveDate: dates[705] }],
    qualityOverrides: [{ id: 'fixture:price-review', securityId: 'fixture:AAA', kind: 'price', from: dates[712], to: dates[712],
      knownAt: dates[714], reason: 'Test price-basis incident', evidenceUrl: 'https://www.sec.gov/test' }] });
  const risk = storeWorkspace(db, 'ranking-model', { name: 'Risk fixture', definition: {
    method: 'risk', priceMode: 'total', windows: [{ kind: 'sessions', length: 21, weight: 1 }],
  } });
  const engine = createEngine(db);
  const configs = [
    { universe: 'us-core', benchmark: 'SPY', reference: 'as-of', includeAllTimeHigh: true },
    { universe: 'us-all', benchmark: 'SPY', reference: 'as-of', classification: 'sec-sic', model: 'short-momentum', includeAllTimeHigh: true },
    { universe: 'nasdaq', benchmark: 'VTI', reference: 'latest', classification: 'provider', model: risk.id, breadthKeys: ['up_13pct_34d'] },
    { universe: 'sample', benchmark: 'VTI', basis: 'known', reference: 'as-of' },
    { universe: 'us-core', benchmark: 'SPY', reference: 'as-of', classification: 'sec-sic', includeAllTimeHigh: true },
    { universe: 'us-core', benchmark: 'SPY', reference: 'as-of', classification: 'sec-sic', includeAllTimeHigh: true,
      breadthKeys: ['down_13pct_34d', 'up_13pct_34d'] },
    { universe: 'us-core', benchmark: 'SPY', reference: 'as-of', classification: 'sec-sic', includeAllTimeHigh: true,
      breadthKeys: ['up_13pct_33d', 'down_13pct_34d', 'up_13pct_34d', 'up_13pct_35d'] },
  ].map((config) => engine.context(config));
  const targets = [dates[706], dates[709], dates[710], dates[711], dates[742], dates.at(-1)];
  for (const tile of engine.batchSnapshots(configs, { dates: targets, tileSize: 3, sparseRows: true })) {
    for (const { config, snapshot, stockRows } of tile.results) {
      const direct = engine.snapshot(config, { persist: false, cache: false });
      const stocks = stockRows.map(unfoldStock);
      equivalent({ ...snapshot, stocks }, direct, `${tile.date}:${config.universe.id}:${config.model.id}`);
      assert.deepEqual(stocks.map(Object.keys), direct.stocks.map(Object.keys));
      assert.deepEqual(snapshot.stocks.map(({ securityId, rsRank, rsPercentile }) => [securityId, rsRank, rsPercentile]),
        direct.stocks.map(({ securityId, rsRank, rsPercentile }) => [securityId, rsRank, rsPercentile]));
    }
    const firstShared = tile.results[0].stockRows.find(({ overrides }) => overrides.securityId === 'fixture:AAA');
    const secondShared = tile.results[1].stockRows.find(({ overrides }) => overrides.securityId === 'fixture:AAA');
    assert.equal(firstShared.base, secondShared.base, 'compatible contexts share identical technical objects');
    const standard = tile.results[4];
    const monitor = tile.results[5];
    assert.equal(monitor.snapshot.groups, standard.snapshot.groups, 'additional breadth does not rebuild groups');
    assert.equal(monitor.snapshot.aggregates, standard.snapshot.aggregates);
    assert.equal(monitor.stockRows[0].overrides, standard.stockRows[0].overrides, 'monitor reuses the resolved stock frame');
    assert.equal(monitor.stockRows[0].base, standard.stockRows[0].base);
    assert.deepEqual(monitor.stockRows[0].additions.order, [['return_252d', 'return_34d']]);
    assert.equal(standard.snapshot.aggregates, tile.results[0].snapshot.aggregates, 'taxonomy can reuse market aggregates');
  }
  const mask = (config, index, date) => index === 5 && date === targets.at(-1);
  const masked = [...engine.batchSnapshots(configs, { dates: targets, shouldBuild: mask })];
  assert.deepEqual(masked.map(({ results }) => results.map(({ contextIndex }) => contextIndex)), [[], [], [], [], [], [5]]);
  equivalent(masked.at(-1).results[0].snapshot, engine.snapshot(configs[5], { persist: false, cache: false }));
  const [custom] = engine.batchSnapshots(configs.slice(5), { dates: targets.slice(-1), sparseRows: true });
  const addition = custom.results[1];
  assert.equal(addition.stockRows[0].base, custom.results[0].stockRows[0].base);
  assert.deepEqual(addition.stockRows[0].additions.order, [['return_252d', 'return_33d'], ['return_34d', 'return_35d']]);
  const customStocks = addition.stockRows.map(unfoldStock);
  const directCustom = engine.snapshot(configs[6], { persist: false, cache: false });
  equivalent(customStocks, directCustom.stocks);
  assert.deepEqual(customStocks.map(Object.keys), directCustom.stocks.map(Object.keys));
  const advanceDates = [...new Set([...targets, ...dates.slice(709, 716)])].sort();
  for (const breadthConfig of [engine.context({ universe: 'nyse', classification: 'sec-sic' }), configs[3]]) {
    const advance = [...engine.batchAdvanceDecline(breadthConfig, { dates: advanceDates })];
    assert.deepEqual(advance, advanceDates.map((date) => {
      const { breadth, coverage } = engine.snapshot({ ...breadthConfig, date }, { persist: false, cache: false });
      return { date, advancers: breadth.advancers.numerator, decliners: breadth.decliners.numerator,
        comparable: breadth.advancers.denominator, traded: coverage.traded };
    }));
  }
  const config = configs[0];
  const [frame] = engine.detailSources(config, { securityIds: ['fixture:AAA'], lookback: 252 });
  const detail = engine.detail(config, 'fixture:AAA', 252, { velocity: false });
  for (const field of ['chartBars', 'bars', 'actions', 'aliases', 'quality', 'allTimeHigh', 'loadedHistoryHigh',
    'volatility_20d', 'atr_14d', 'distance_loaded_history_high']) equivalent(frame[field], detail[field], field);
  assert.equal(frame.chartBars.at(-1).knownAt, dates.at(-1));
});

test('reusing immutable weekly lookups preserves all velocity measurements', () => {
  const baselines = Array.from({ length: 12 }, (_, position) => ({
    stocks: [{ securityId: 'AAA', rsRank: position + 2, rsPercentile: 89 + position / 4, rsScore: 0.4 - position / 100,
      udv_50d: 0.8, up_volume_50d: 0.48 }],
    groups: [{ id: 'industry:AAA', rank: 3, percentile: 60, medianRS: 85, topDecile: 3, above50: 54, relativeReturn: 0.016 }],
  }));
  const current = {
    stocks: [{ securityId: 'AAA', rsRank: 1, rsPercentile: 95, rsScore: 0.45, industryId: 'industry:AAA',
      return_21d: 0.02, return_63d: 0.17, return_252d: 0.58, udv_50d: 1.4, up_volume_50d: 0.59 }],
    groups: [{ id: 'industry:AAA', rank: 2, percentile: 66, medianRS: 88, topDecile: 4, above50: 60, relativeReturn: 0.019 }],
  };
  const reference = structuredClone(current);
  annotateVelocity(reference, baselines);
  const [stock] = reference.stocks;
  assert.deepEqual([stock.velocity1w, stock.velocity4w, stock.velocity12w], [6, 5.25, 3.25]);
  assert.deepEqual([stock.topDecileWeeks4w, stock.topDecileWeeks8w, stock.topDecileWeeks12w], [1, 4, 8]);
  assert.deepEqual([stock.leadingWeekCoverage, stock.leadingWeeks, stock.rsNewHigh], [13, 9, true]);
  assert.equal(reference.groups[0].velocity4w, 6);
  for (let i = 0; i < 2; i++) {
    const next = structuredClone(current);
    annotateVelocity(next, baselines, { memoizeWeeks: true });
    assert.deepEqual(next, reference);
  }
  const layers = createStockVelocityLayer(current.stocks, baselines, { memoizeWeeks: true });
  const independentlyGrouped = structuredClone(current);
  Object.assign(independentlyGrouped.stocks[0], layers.get('AAA'));
  annotateGroupVelocity(independentlyGrouped, baselines, { memoizeWeeks: true });
  assert.deepEqual(independentlyGrouped, reference);
  assert.deepEqual(Object.keys(independentlyGrouped.stocks[0]), Object.keys(reference.stocks[0]));
  assert.equal(Object.hasOwn(layers.get('AAA'), 'industryVelocity'), false);
});

test('breadth masks preserve comparability across word boundaries and overlapping universes', () => {
  const stocks = Array.from({ length: 99 }, (_, index) => ({
    return_1d: index % 7 ? (index % 13 - 6) / 100 : null,
    above_50d: index % 5 ? index % 3 === 0 : null,
    rvol_20d: index % 9 ? 1 + index % 4 / 2 : null,
    return_34d: (index % 19 - 9) / 30,
  }));
  const count = createBreadthFrame(stocks.length);
  for (const universe of [stocks.filter((_, i) => i % 2 === 0), stocks.filter((_, i) => i % 3 !== 0), stocks, []]) {
    const rankedRows = universe.map((stock, index) => Object.assign(Object.create(stock), {
      rsPercentile: index % 11 ? index : null,
      industryRelativeReturn: index % 5 ? (index % 9 - 4) / 100 : null,
    }));
    const keys = ['up_13pct_34d', 'down_13pct_34d'];
    assert.deepEqual(calculateBreadth(rankedRows, keys, count(rankedRows, Object.getPrototypeOf)), calculateBreadth(rankedRows, keys));
  }
});

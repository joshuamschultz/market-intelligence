import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import {
  createPreparedDetailWriter, hasPreparedDetail, prepareDetailsBatch, readPreparedDetail, riskMetrics, writePreparedDetail,
} from '../backend/prepared-details.mjs';
import { prepareRangeMetrics } from '../backend/range-metrics.mjs';

const calendar = expectedSessions('2024-01-02', '2024-10-15');
const stockId = 'fixture:AAA';
const source = 'fixture';
const quote = (symbol, date, close, extra = {}) => ({ symbol, date, knownAt: date, close, open: close,
  high: close * 1.02, low: close * 0.98, adjustedClose: close, volume: 120_000, ...extra });
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);

function fixture(t, { split = false, explicitBasis = false, count = 182 } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = calendar.slice(0, count);
  const first = dates[0];
  const splitDate = dates[151];
  const securities = ['AAA', 'SPY', 'VTI'].map((symbol) => ({ symbol, name: `${symbol} issue`, listingDate: first, knownAt: first,
    exchange: 'NYSE', type: symbol === 'AAA' ? 'common' : 'etf' }));
  const prices = dates.flatMap((date, index) => ['AAA', 'SPY', 'VTI'].flatMap((symbol, offset) => {
    if (symbol === 'AAA' && index === 90) return [];
    const close = (50 + 13 * offset + index * 0.15 + index % 7 * 0.7) / (split && symbol === 'AAA' && date >= splitDate ? 3 : 1);
    const extra = symbol === 'AAA' && index === 130 ? { volume: 0 } : {};
    if (explicitBasis && symbol === 'AAA' && index === 140) extra.splitClose = close;
    return [quote(symbol, date, close, extra)];
  }));
  importDataset(db, { provider: source, securities, prices,
    corporateActions: split ? [{ symbol: 'AAA', type: 'split', date: splitDate, knownAt: splitDate, factor: 3 }] : [],
  });
  return { db, engine: createEngine(db), dates, splitDate };
}

test('lookup without a prepared product performs no writes or market calculation', (t) => {
  const { db, engine } = fixture(t, { count: 30 });
  const config = engine.context();
  const missing = readPreparedDetail(db, config, stockId);
  assert.deepEqual(missing, { state: 'not-prepared', riskState: 'not-prepared', detail: null,
    sourceDataVersion: null, anchorDate: null, projected: false });
  assert.equal(hasPreparedDetail(db, config, stockId), false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_detail_products'").get(), undefined);
});

test('current canonical quotes preserve gaps and zero volume and use prepared risk for the exact window', (t) => {
  const { db, engine, dates } = fixture(t);
  const config = engine.context();
  const lookback = 126;
  const benchmarkBars = engine.studyPrices(config, ['SPY'], dates.at(-lookback), config.date).get('SPY');
  const canonical = engine.detail(config, stockId, lookback, { velocity: false });
  const result = prepareDetailsBatch(db, engine, config, { securityIds: [stockId], riskWindows: [lookback] });
  assert.deepEqual([result.done, result.processedSecurities, result.written], [true, 1, 1]);
  const read = readPreparedDetail(db, config, stockId, { lookback, benchmark: 'SPY' });
  assert.deepEqual([read.state, read.riskState, read.projected], ['ready', 'ready', false]);
  assert.equal(read.detail.chartBars.length, lookback);
  assert.equal(read.detail.chartBars.find(({ date }) => date === dates[90]).missing, true);
  const zero = read.detail.chartBars.find(({ date }) => date === dates[130]);
  assert.equal(zero.volume, 0);
  assert.equal(zero.traded, false);
  const quoteShape = (bar) => [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.traded, bar.missing];
  assert.deepEqual(read.detail.chartBars.map(quoteShape), canonical.chartBars.map(quoteShape));
  assert.deepEqual(read.detail.risk, riskMetrics(canonical, benchmarkBars));
  assert.equal(read.detail.loadedHistoryHigh, canonical.loadedHistoryHigh);
  assert.equal(read.detail.calculationVersion, CALCULATION_VERSION);
  assert.ok(!Object.hasOwn(read.detail, 'rsRank'));
  assert.ok(!Object.hasOwn(read.detail, 'industry'));
  assert.equal(readPreparedDetail(db, config, stockId, { lookback: 63 }).riskState, 'not-prepared');
  assert.equal(readPreparedDetail(db, config, stockId, { lookback, benchmark: 'VTI' }).riskState, 'ready');
  assert.equal(readPreparedDetail(db, config, stockId, { lookback, benchmark: 'QQQ' }).riskState, 'not-prepared');
});

test('risk parity has expected beta, correlation, drawdown and historical VaR', () => {
  const dates = calendar.slice(0, 25);
  const closes = dates.map((_, index) => 100 + index % 2 * 4 + Math.floor(index / 3));
  const bars = dates.map((date, index) => ({ date, close: 2 * closes[index], traded: true }));
  const benchmarks = dates.map((date, index) => ({ date, close: closes[index] }));
  const result = riskMetrics({ bars, volatility_20d: .25, atr_14d: .01 }, benchmarks);
  assert.equal(result.observations, 24);
  assert.equal(result.benchmarkObservations, 24);
  near(result.beta, 1);
  near(result.correlation, 1);
  near(result.maximumDrawdown, 100 / 104 - 1);
  assert.ok(result.dailyHistoricalReturn5pct < 0);
  assert.equal(result.dailyHistoricalVaR95, -result.dailyHistoricalReturn5pct);
  assert.deepEqual([result.annualizedVolatility, result.atr14], [.25, .01]);
});

test('historical reconstructed display projects verified split units and withholds unprepared risk and highs', (t) => {
  const { db, engine, dates, splitDate } = fixture(t, { split: true });
  const latest = engine.context();
  prepareDetailsBatch(db, engine, latest, { securityIds: [stockId], riskWindows: [126] });
  const before = engine.context({ date: dates[150] });
  const result = readPreparedDetail(db, before, stockId, { lookback: 126 });
  assert.deepEqual([result.state, result.riskState, result.projected], ['ready', 'not-prepared', true]);
  assert.equal(result.anchorDate, latest.date);
  assert.equal(result.detail.actions.some((action) => action.date === splitDate), false);
  assert.equal(result.detail.risk, null);
  assert.ok(!Object.hasOwn(result.detail, 'loadedHistoryHigh'));
  const exact = engine.detail(before, stockId, 126, { velocity: false }).chartBars;
  for (let index = 0; index < exact.length; index++) {
    const left = exact[index], right = result.detail.chartBars[index];
    assert.equal(right.date, left.date);
    assert.equal(right.missing, left.missing);
    for (const name of ['open', 'high', 'low', 'close', 'rawClose', 'volume', 'dollarVolume']) {
      if (typeof left[name] === 'number') near(right[name], left[name], Math.max(1e-10, Math.abs(left[name]) * 1e-12));
      else assert.equal(right[name], left[name]);
    }
  }
  assert.equal(hasPreparedDetail(db, before, stockId, { exactOnly: true }), false);
  assert.equal(readPreparedDetail(db, { ...before, basis: 'known' }, stockId).state, 'requires-exact-date');
  assert.equal(readPreparedDetail(db, { ...before, date: '2021-12-31' }, stockId).state, 'not-prepared');
});

test('ambiguous supplied adjustment bases require an exact historical date and known empty windows stay empty', (t) => {
  const { db, engine, dates } = fixture(t, { split: true, explicitBasis: true });
  const latest = engine.context();
  prepareDetailsBatch(db, engine, latest, { securityIds: [stockId], riskWindows: [21] });
  const old = engine.context({ date: dates[145] });
  assert.equal(readPreparedDetail(db, old, stockId, { lookback: 21 }).state, 'requires-exact-date');
  prepareDetailsBatch(db, engine, old, { securityIds: [stockId], riskWindows: [21] });
  assert.equal(readPreparedDetail(db, old, stockId, { lookback: 21 }).riskState, 'ready');
  const first = dates[0];
  importDataset(db, { provider: source, securities: [{ symbol: 'LATE', type: 'common', exchange: 'NYSE',
    listingDate: first, knownAt: latest.date }], prices: [quote('LATE', latest.date, 75)] });
  const known = engine.context({ date: old.date, basis: 'known' });
  const delayed = 'fixture:LATE';
  prepareDetailsBatch(db, engine, known, { securityIds: [delayed], riskWindows: [21] });
  const empty = readPreparedDetail(db, known, delayed, { lookback: 21 });
  assert.equal(empty.state, 'ready');
  assert.equal(empty.riskState, 'ready');
  assert.deepEqual(empty.detail.chartBars, []);
  assert.deepEqual([empty.detail.risk.observations, empty.detail.risk.benchmarkObservations, empty.detail.risk.maximumDrawdown], [0, 0, null]);
  assert.ok(!Object.hasOwn(empty.detail, 'symbol'));
});

test('range callbacks publish exact products and resumable catalog batches skip already prepared work', (t) => {
  const { db, engine, dates } = fixture(t, { count: 30 });
  // Statistical indices are eligible for ticker products, but excluded from the range universe.
  importDataset(db, { provider: source, securities: [{ symbol: 'IDX', type: 'index', exchange: 'INDX',
    listingDate: dates[0], knownAt: dates[0] }], prices: dates.map((date, index) => quote('IDX', date, 250 + index)) });
  const config = engine.context();
  const prepared = createPreparedDetailWriter(db, engine, config, { riskWindows: [21] });
  const callbacks = [];
  prepareRangeMetrics(db, engine, config, [20], { onSecurity(detail, context) {
    callbacks.push(context.securityId);
    prepared(detail);
  } });
  assert.ok(callbacks.includes(stockId));
  assert.equal(readPreparedDetail(db, config, stockId, { lookback: 21 }).state, 'ready');
  const calls = [];
  const tracking = { ...engine, snapshot(...args) { calls.push('snapshot'); return engine.snapshot(...args); },
    studyPrices(...args) { calls.push('benchmark'); return engine.studyPrices(...args); },
    detail(...args) { calls.push(args[1]); return engine.detail(...args); } };
  const first = prepareDetailsBatch(db, tracking, config, { bucketSize: 1, riskWindows: [21] });
  assert.equal(first.done, false);
  assert.equal(first.processedSecurities, 1);
  assert.deepEqual(calls, []);
  const second = prepareDetailsBatch(db, tracking, config, { bucketSize: 1, riskWindows: [21], cursor: first.cursor });
  assert.equal(second.processedSecurities, 2);
  const third = prepareDetailsBatch(db, tracking, config, { bucketSize: 1, riskWindows: [21], cursor: first.cursor });
  assert.equal(third.processedSecurities, 3);
  assert.equal(prepareDetailsBatch(db, tracking, config, { bucketSize: 1, riskWindows: [21], cursor: second.cursor }).done, true);
  assert.deepEqual(calls.filter((item) => item.startsWith('fixture:')), ['fixture:IDX']);
});

test('an ordinary append deduplicates unchanged chart quarters and admits only the safe lineage prefix', (t) => {
  const { db, engine, dates } = fixture(t);
  const current = engine.context();
  prepareDetailsBatch(db, engine, current, { securityIds: [stockId], riskWindows: [21] });
  const blockCount = () => db.prepare('SELECT count(*) AS count FROM prepared_detail_blocks').get().count;
  const before = blockCount();
  const newDate = calendar[dates.length];
  importDataset(db, { provider: source, prices: [quote('AAA', newDate, 95), quote('SPY', newDate, 165)] });
  const next = engine.context();
  assert.equal(readPreparedDetail(db, next, stockId).state, 'not-prepared');
  assert.equal(readPreparedDetail(db, { ...next, date: current.date }, stockId, { lookback: 21 }).sourceDataVersion, current.dataVersion);
  prepareDetailsBatch(db, engine, next, { securityIds: [stockId], riskWindows: [21] });
  assert.equal(blockCount(), before + 1);
  importDataset(db, { provider: source, prices: [quote('AAA', dates[155], 96)] });
  const changed = engine.context();
  assert.equal(readPreparedDetail(db, { ...changed, date: dates[156] }, stockId, { lookback: 21 }).state, 'not-prepared');
  assert.equal(readPreparedDetail(db, { ...changed, date: dates[154] }, stockId, { lookback: 21 }).state, 'ready');
});

test('ambiguous future split flags fail closed and projected metadata keeps only dated aliases and actions', (t) => {
  const { db, engine, dates } = fixture(t, { count: 30 });
  const config = engine.context();
  const initial = engine.detail(config, stockId, 7560, { velocity: false });
  const before = dates[25];
  const marked = { ...initial, chartBars: initial.chartBars.map((bar) => bar.date === dates[28] ? { ...bar, unverifiedSplit: true } : bar) };
  writePreparedDetail(db, config, marked);
  assert.equal(readPreparedDetail(db, { ...config, date: before }, stockId).state, 'requires-exact-date');
  const another = { ...initial, securityId: 'other',
    aliases: [{ symbol: 'OLD', exchange: 'NYSE', valid_from: dates[1], valid_to: dates[26] },
      { symbol: 'LATER', exchange: 'NYSE', valid_from: dates[27] }],
    actions: [{ type: 'dividend', date: dates[26], amount: .5 }], quality: [{ kind: 'volume', effective_from: dates[28] }],
  };
  writePreparedDetail(db, config, another);
  const old = readPreparedDetail(db, { ...config, date: before }, 'other');
  assert.equal(old.detail.symbol, 'OLD');
  assert.equal(old.detail.aliases.length, 1);
  assert.deepEqual(old.detail.actions, []);
  assert.deepEqual(old.detail.quality, []);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { aggregateRows, calculateBreadth } from '../backend/breadth.mjs';
import { expectedSessions, latestFinalizableSession, shiftDate } from '../backend/calendar.mjs';
import { importDataset, openDatabase, warehouseStatus } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { prepareBars, returnWindow, stockMetrics, volumeRatio } from '../backend/metrics.mjs';
import { BENCHMARKS, EodhdProvider, importProviderData } from '../backend/provider.mjs';
import { annotateVelocity, rankBy, scoreRanking, validateModel } from '../backend/ranking.mjs';
import { parseExpression, screenStocks } from '../backend/screener.mjs';
import { createHandler } from '../backend/server.mjs';
import { createService } from '../backend/service.mjs';

const closeTo = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `expected ${actual} close to ${expected}`);
const security = (symbol, extra = {}) => ({
  symbol, name: `${symbol} Corporation`, exchange: 'NASDAQ', type: 'Common Stock',
  listingDate: '2020-01-02', knownAt: '2020-01-02', ...extra,
});
const price = (symbol, date, close, extra = {}) => ({
  symbol, date, knownAt: date, open: close, high: close * 1.01, low: close * 0.99, close,
  adjusted_close: close, volume: 100_000, ...extra,
});

function dbFor(t, disk = false) {
  const folder = disk ? mkdtempSync(join(tmpdir(), 'market-test-')) : null;
  const filename = disk ? join(folder, 'market.sqlite') : ':memory:';
  const db = openDatabase(filename);
  t.after(() => {
    db.close();
    if (folder) rmSync(folder, { recursive: true, force: true });
  });
  return { db, filename };
}

function fixture(t, disk = false) {
  const { db, filename } = dbFor(t, disk);
  const sessions = expectedSessions('2024-01-02', '2025-06-13');
  const symbols = ['ASTR', 'BORE', 'SPY'];
  const prices = sessions.flatMap((date, index) => [
    price('ASTR', date, 100 + index * 0.5, { volume: index % 2 ? 120_000 : 90_000 }),
    price('BORE', date, 200 - index * 0.15, { volume: index % 2 ? 105_000 : 92_000 }),
    price('SPY', date, 250 + index * 0.25),
  ]);
  const first = sessions[0];
  const last = sessions.at(-1);
  const result = importDataset(db, {
    provider: 'fixture', dataset: 'eod', scope: 'full', expected: 2,
    securities: symbols.map((symbol) => security(symbol, symbol === 'SPY' ? { type: 'ETF' } : {})),
    prices,
    classifications: [
      { symbol: 'ASTR', effectiveFrom: first, knownAt: first, sector: 'Technology', industry: 'Systems' },
      { symbol: 'BORE', effectiveFrom: first, knownAt: first, sector: 'Industrials', industry: 'Machinery' },
    ],
    fundamentals: [
      { symbol: 'ASTR', effectiveDate: first, knownAt: first, float: 3_000_000, sharesOutstanding: 4_000_000 },
      { symbol: 'BORE', effectiveDate: first, knownAt: first, sharesOutstanding: 6_000_000 },
    ],
  });
  assert.equal(result.imported, prices.length);
  const service = createService({ db });
  return { db, filename, sessions, first, last, ...service };
}

test('calendar skips market holidays and waits for configured New York publication cutoff', () => {
  assert.deepEqual(expectedSessions('2024-03-27', '2024-04-02'), ['2024-03-27', '2024-03-28', '2024-04-01', '2024-04-02']);
  assert.deepEqual(expectedSessions('2025-01-08', '2025-01-10'), ['2025-01-08', '2025-01-10']);
  assert.equal(latestFinalizableSession(new Date('2025-11-21T23:00:00Z')), '2025-11-20');
  assert.equal(latestFinalizableSession(new Date('2025-11-22T02:00:00Z')), '2025-11-21');
});

test('a replay preserves ticker renames, separates a reused ticker, and excludes a delisted stock after its last eligible date', (t) => {
  const { db } = dbFor(t);
  importDataset(db, {
    provider: 'fixture', securities: [
      security('OLD', { securityId: 'original', isin: 'US1234567890', delistingDate: '2024-01-05', identifiers: [
        { symbol: 'OLD', validFrom: '2020-01-02', validTo: '2024-01-03' },
        { symbol: 'REBR', validFrom: '2024-01-04', validTo: '2024-01-05' },
      ] }),
      security('OLD', { securityId: 'replacement', isin: 'US9876543210', listingDate: '2024-01-08', knownAt: '2024-01-08' }),
    ],
    prices: [
      price('OLD', '2024-01-02', 100), price('OLD', '2024-01-03', 105), price('REBR', '2024-01-04', 110),
      price('REBR', '2024-01-05', 112), price('OLD', '2024-01-08', 50), price('OLD', '2024-01-09', 51),
    ],
  });
  const engine = createEngine(db);
  const previous = engine.snapshot(engine.context({ date: '2024-01-04', basis: 'known' }));
  assert.deepEqual(previous.stocks.map(({ securityId, symbol }) => [securityId, symbol]), [['original', 'REBR']]);
  closeTo(previous.stocks[0].return_1d, 110 / 105 - 1);
  const latest = engine.snapshot(engine.context({ date: '2024-01-09', basis: 'known' }));
  assert.deepEqual(latest.stocks.map(({ securityId, symbol }) => [securityId, symbol]), [['replacement', 'OLD']]);
  closeTo(latest.stocks[0].return_1d, 0.02);
});

test('provider ISIN treats an overlapping reused symbol as ambiguous unless price rows carry stable IDs', (t) => {
  const { db } = dbFor(t);
  const batch = importDataset(db, { provider: 'fixture', securities: [
    security('TST', { isin: 'US1234567890' }), security('TST', { isin: 'US9876543210' }),
  ], prices: [
    price('TST', '2024-01-02', 120),
    price('TST', '2024-01-03', 121, { securityId: 'fixture:TST' }),
    price('TST', '2024-01-03', 20, { securityId: 'fixture:TST:US9876543210' }),
  ] });
  assert.equal(batch.unresolved, 1);
  assert.equal(batch.imported, 2);
  assert.equal(warehouseStatus(db).securities, 2);
});

test('new data versions preserve original prices and strict replay uses verified known dates', (t) => {
  const { db } = dbFor(t);
  const original = { provider: 'fixture', securities: [security('ASTR')], prices: [
    price('ASTR', '2024-01-02', 100), price('ASTR', '2024-01-03', 110),
  ] };
  assert.equal(importDataset(db, original).version, 1);
  assert.equal(importDataset(db, original).duplicate, true);
  importDataset(db, { provider: 'fixture', prices: [
    price('ASTR', '2024-01-03', 130, { knownAt: '2024-01-04' }),
    price('ASTR', '2024-01-04', 135, { knownAt: undefined }),
  ] });
  const engine = createEngine(db);
  const stock = (params) => engine.snapshot(engine.context(params)).stocks[0];
  closeTo(stock({ date: '2024-01-03' }).return_1d, 0.30);
  closeTo(stock({ date: '2024-01-03', dataVersion: 1 }).return_1d, 0.10);
  closeTo(stock({ date: '2024-01-03', basis: 'known' }).return_1d, 0.10);
  assert.equal(stock({ date: '2024-01-04', basis: 'known' }).traded, false);
  assert.equal(warehouseStatus(db).prices, 3);
});

test('transactions reject a wholly invalid import without publishing a new warehouse version', (t) => {
  const { db } = dbFor(t);
  assert.throws(() => importDataset(db, { provider: 'fixture', securities: [security('ASTR')],
    prices: [price('ASTR', '2024-01-02', 100, { low: 200 })] }), /no valid/);
  const status = warehouseStatus(db);
  assert.equal(status.prices, 0);
  assert.equal(status.securities, 0);
  assert.equal(status.dataVersion, 0);
  assert.equal(status.runs[0].status, 'failed');
});

test('a future split undoes provider share normalization without changing economic dollar volume or creating a false historical split', () => {
  const before = '2020-08-28';
  const after = '2020-08-31';
  const split = [{ date: after, type: 'split', factor: 4 }];
  const vendor = [
    { date: before, close: 500, open: 500, high: 500, low: 500, adjusted_close: 125, volume: 160_000, volume_adjusted: 1, volume_basis: after },
    { date: after, close: 130, open: 130, high: 130, low: 130, adjusted_close: 130, volume: 170_000, volume_adjusted: 1, volume_basis: after },
  ];
  const prior = prepareBars(vendor.slice(0, 1), split, before)[0];
  assert.equal(prior.close, 500);
  assert.equal(prior.volume, 40_000);
  assert.equal(prior.dollarVolume, 20_000_000);
  const adjusted = prepareBars(vendor, split, after);
  assert.equal(adjusted[0].close, 125);
  assert.equal(adjusted[0].volume, 160_000);
  assert.equal(adjusted[0].dollarVolume, prior.dollarVolume);
  closeTo(returnWindow(adjusted, 0, 1), 0.04);
  const missing = prepareBars(vendor, [], after);
  assert.equal(returnWindow(missing, 0, 1), null);
  closeTo(returnWindow(missing, 0, 1, 'total'), 0.04);
});

test('rank models use all components, weight returns, and assign endpoint percentiles across ties', () => {
  const definition = validateModel({ method: 'weighted', windows: [{ length: 10, weight: 3 }, { length: 20, weight: 1 }] });
  const rows = [
    { securityId: 'B', traded: true, rsComponents: [0.1, 0.5] },
    { securityId: 'A', traded: true, rsComponents: [0.1, 0.5] },
    { securityId: 'C', traded: true, rsComponents: [0.03, 0.04] },
    { securityId: 'D', traded: true, rsComponents: [0.9, null] },
  ];
  scoreRanking(rows, definition, {});
  closeTo(rows[0].rsScore, 0.2);
  assert.deepEqual(rows.map(({ rsRank, rsPercentile }) => [rsRank, rsPercentile]), [[2, 100], [1, 100], [3, 0], [null, null]]);
  assert.equal(rankBy([rows[0]], (row) => row.rsScore).get('B').percentile, 50);
});

test('U/D volume excludes unchanged days and preserves infinity and insufficient-history states', () => {
  const bars = [10, 12, 12, 11, 13].map((close, index) => ({ close, traded: true, volume: [30, 20, 500, 10, 40][index] }));
  assert.deepEqual(volumeRatio(bars, 4, 4), { value: 6, state: 'available', up: 60, down: 10, upPercent: 6 / 7, observations: 4 });
  assert.equal(volumeRatio(bars, 2, 2).state, 'infinity');
  assert.equal(volumeRatio([bars[0], null, bars[2]], 2, 2).state, 'insufficient');
});

test('stock metrics preserve unavailable float and calculate high proximity from 252 session highs', () => {
  const series = Array.from({ length: 252 }, (_, index) => ({
    date: String(index), close: 100, high: index === 4 ? 125 : 102, low: 99, open: 100,
    rawClose: 100, traded: true, volume: 20, dollarVolume: 2_000,
  }));
  const without = stockMetrics({ securityId: 'A' }, series);
  closeTo(without.distance_high_252d, -0.2);
  assert.equal(without.float_turnover_1d, null);
  const withFloat = stockMetrics({ securityId: 'A', float: 200 }, series.map((row) => ({ ...row, float: 200 })));
  closeTo(withFloat.float_turnover_1d, 0.1);
  closeTo(withFloat.float_turnover_10d, 1);
});

test('EMA starts at the first full simple average and recurses over subsequent sessions', () => {
  const series = [1, 2, 3, 4].map((close, index) => ({
    date: `2024-01-0${index + 2}`, open: close, close, high: close, low: close,
    volume: 1, dollarVolume: close, traded: true,
  }));
  const result = stockMetrics({ securityId: 'A' }, series, { averages: [3] });
  assert.equal(result.ema_3d, 3);
  assert.equal(result.ema_seed_3d, '2024-01-04');
  assert.equal(result.ema_observations_3d, 4);
});

test('EMA slope, exact 2× volume, and selectable OBV measure comparable sessions', () => {
  const bars = Array.from({ length: 40 }, (_, index) => {
    const close = index < 20 ? 100 : index === 20 ? 105 : index === 21 ? 103 : 104;
    const volume = index === 20 ? 210 : index === 21 ? 165 : index === 22 ? 300 : 100;
    return { date: String(index), open: close, high: close, low: close, close, traded: true, volume, dollarVolume: volume * close };
  });
  const result = stockMetrics({}, bars, { averages: [2], volumeWindows: [3, 19] });
  assert.deepEqual([result.high_volume_up_20d, result.high_volume_down_20d, result.accumulation_20d], [2, 1, 1]);
  assert.deepEqual([result.high_volume_up_2x_20d, result.high_volume_down_2x_20d, result.accumulation_2x_20d], [2, 0, 2]);
  assert.deepEqual([result.obv_slope_3d, result.obv_slope_19d, result.obv_slope], [0, 135, 345]);
  const missing = stockMetrics({}, bars.map((bar, index) => index === 7 ? { ...bar, volume: null } : bar));
  assert.equal(missing.high_volume_up_2x_20d, null);
  const linear = stockMetrics({}, bars.slice(0, 10).map((bar, index) => ({ ...bar, close: 10 * (index + 1) })), { averages: [2] });
  closeTo(linear.vs_ema_2d, 100 / 95 - 1);
  closeTo(linear.slope_ema_2d, 95 / 45 - 1);
});

test('ATR contraction compares adjacent 14-session ranges and consolidation does not count through gaps', () => {
  const bars = Array.from({ length: 29 }, (_, index) => ({ date: String(index), close: 100, open: 100,
    low: index < 15 ? 98 : 99, high: index < 15 ? 102 : 101, traded: true, volume: 100, dollarVolume: 10_000 }));
  const result = stockMetrics({}, bars);
  closeTo(result.atr_14d, 0.02);
  closeTo(result.atr_contraction, -0.5);
  assert.equal(result.consolidation_duration, null);
  const tightened = [{ ...bars[0], high: 112 }, ...bars.slice(1)];
  assert.equal(stockMetrics({}, tightened).consolidation_duration, 28);
  tightened[22] = null;
  assert.equal(stockMetrics({}, tightened).consolidation_duration, null);
  assert.equal(stockMetrics({}, Array(63).fill(bars.at(-1))).consolidation_duration, 63);
});

test('listing highs work in screens and detail while preserving a distinct verified loaded-history high', (t) => {
  const { db } = dbFor(t);
  const days = expectedSessions('2024-01-02', '2024-01-10');
  const listing = days[2];
  importDataset(db, { provider: 'fixture', securities: [
    security('SPY', { type: 'etf' }), security('IPO', { listingDate: listing, knownAt: listing }),
    security('GAP', { listingDate: listing, knownAt: listing }), security('OLD'),
  ], prices: [
    ...days.map((day) => price('SPY', day, 100)),
    ...days.slice(2).map((day, offset) => price('IPO', day, offset === 0 ? 110 : 80)),
    price('GAP', listing, 150), ...days.slice(4).map((day) => price('GAP', day, 80)),
    ...days.slice(2).map((day) => price('OLD', day, 80)),
  ] });
  const engine = createEngine(db);
  const ordinary = engine.context({ basis: 'known' });
  const configured = engine.context({ basis: 'known', includeAllTimeHigh: true });
  const enriched = engine.snapshot(configured, { persist: false });
  const rows = new Map(enriched.stocks.map((row) => [row.symbol, row]));
  assert.equal(engine.snapshot(ordinary, { persist: false }).stocks.find(({ symbol }) => symbol === 'IPO').distance_all_time_high, null);
  closeTo(rows.get('IPO').distance_all_time_high, 80 / 111.1 - 1);
  assert.equal(rows.get('GAP').distance_all_time_high, null);
  assert.equal(rows.get('GAP').loadedHistoryHighFrom, listing);
  closeTo(rows.get('GAP').distance_loaded_history_high, 80 / 151.5 - 1);
  assert.equal(rows.get('GAP').loadedHistoryHighObservations, rows.get('GAP').loadedHistoryHighExpected - 1);
  assert.equal(rows.get('OLD').distance_all_time_high, null);
  assert.ok(rows.get('OLD').distance_loaded_history_high < 0);
  const shown = engine.detail(ordinary, 'IPO', 20, { velocity: false });
  assert.equal(shown.distance_all_time_high, rows.get('IPO').distance_all_time_high);
  assert.equal(shown.loadedHistoryHighFrom, listing);
  const filtered = screenStocks(enriched, { filter: { field: 'distance_all_time_high', op: 'lt', value: -0.2 } });
  assert.deepEqual(filtered.rows.map(({ symbol }) => symbol), ['IPO']);
});

test('21-session market cap change uses dated shares and the actual price at both endpoints', (t) => {
  const { db } = dbFor(t);
  const days = expectedSessions('2024-01-02', '2024-02-02');
  importDataset(db, { provider: 'fixture', securities: [security('A')], prices: days.map((day, index) => price('A', day, 100 + index)),
    fundamentals: [
      { symbol: 'A', effectiveDate: days[0], knownAt: days[0], sharesOutstanding: 1000 },
      { symbol: 'A', effectiveDate: days[18], knownAt: days[18], sharesOutstanding: 1100 },
    ] });
  const engine = createEngine(db);
  const config = engine.context({ basis: 'known' });
  const close = 100 + days.length - 1;
  const prior = close - 21;
  const row = engine.snapshot(config).stocks[0];
  closeTo(row.market_cap_change, close * 1100 / (prior * 1000) - 1);
  const outside = engine.detail(engine.context({ basis: 'known', universe: 'nyse' }), 'A', 30, { velocity: false });
  closeTo(outside.market_cap_change, row.market_cap_change);
});

test('leadership persistence, rising demand, and emergence use matching four-week observations', () => {
  const group = { id: 'industry', rank: 2, percentile: 85, medianRS: 75, topDecile: 32, above50: 55, relativeReturn: 0.03 };
  const now = { stocks: [{ securityId: 'A', rsRank: 1, rsPercentile: 95, rsScore: 1, industryId: group.id,
    return_21d: 0.06, udv_50d: 1.6, up_volume_50d: 0.65 }], groups: [group] };
  const previous = Array.from({ length: 12 }, (_, index) => ({
    stocks: index === 10 ? [] : [{ securityId: 'A', rsRank: 3, rsPercentile: index === 5 ? 89 : 92,
      rsScore: 0.7, udv_50d: 1.1, up_volume_50d: 0.5 }],
    groups: [{ id: group.id, rank: 4, percentile: 60, medianRS: 65, topDecile: 30, above50: 48, relativeReturn: 0.01 }],
  }));
  annotateVelocity(now, previous);
  const stock = now.stocks[0];
  assert.deepEqual([stock.topDecileWeeks4w, stock.topDecileWeeks8w, stock.topDecileWeeks12w], [4, 7, null]);
  assert.deepEqual([stock.topDecilePersistence4w, stock.topDecilePersistence8w, stock.topDecilePersistence12w], [true, false, null]);
  closeTo(stock.udvChange4w, 0.5);
  closeTo(stock.upVolumeShareChange4w, 0.15);
  assert.equal(stock.priceAndVolumeStrength, true);
  assert.equal(stock.industryEmerging, true);
  assert.deepEqual([group.medianRSChange4w, group.topDecileChange4w, group.breadthChange], [10, 2, 7]);
  closeTo(group.relativeReturnChange4w, 0.02);
});

test('breadth uses exact metric-specific denominators and market-cap weights use starting capitalization', () => {
  const rows = [
    { return_1d: 1, return_20d: 0.5, market_cap: 200, prior_market_cap: 100, volume: 100, dollar_volume: 100 },
    { return_1d: -0.5, return_20d: -0.25, market_cap: 50, prior_market_cap: 100, volume: 100, dollar_volume: 50 },
    { return_1d: null, return_20d: null, volume: 10 },
  ];
  const breadth = calculateBreadth(rows);
  assert.deepEqual(breadth.up_4pct, { numerator: 1, denominator: 2, value: 50 });
  assert.deepEqual(breadth.down_4pct, { numerator: 1, denominator: 2, value: 50 });
  assert.deepEqual(breadth.up_50pct_20d, { numerator: 1, denominator: 2, value: 50 });
  assert.deepEqual(breadth.down_25pct_20d, { numerator: 1, denominator: 2, value: 50 });
  assert.equal(aggregateRows(rows).capWeightReturn, 0.25);
});

test('screen expressions allow safe cross-sectional and historical calculations without arbitrary execution', () => {
  assert.throws(() => parseExpression('globalThis.process.exit(0)'), /Invalid expression/);
  assert.throws(() => parseExpression('random(1)'), /Unsupported/);
  const stocks = [
    { securityId: 'A', symbol: 'A', traded: true, return_21d: 0.12, rsPercentile: 95, industry: 'Technology' },
    { securityId: 'B', symbol: 'B', traded: true, return_21d: 0.1, rsPercentile: 90, industry: 'Technology' },
    { securityId: 'C', symbol: 'C', traded: true, return_21d: null, rsPercentile: 90, industry: 'Other' },
  ];
  const result = screenStocks({ stocks, date: '2024-01-05' }, { groupBy: 'industry',
    filter: { operator: 'and', filters: [
      { field: 'rsPercentile', op: 'gte', value: 90 },
      { operator: 'or', filters: [
        { expression: 'change(return_21d, 5) > 0.02' }, { field: 'industry', op: 'eq', value: 'Other' },
      ] },
    ] },
    computed: [{ field: 'custom_weight', expression: 'rsPercentile + coalesce(percentile(return_21d), 0)' }],
    sort: [{ field: 'custom_weight', direction: 'desc' }, { field: 'symbol', direction: 'desc' }],
  }, { previous: (field, id) => field === 'return_21d' && id === 'A' ? 0.01 : null });
  assert.deepEqual(result.rows.map(({ securityId, custom_weight, subsetRank }) => [securityId, custom_weight, subsetRank]), [['A', 195, 1], ['C', 90, 2]]);
});

test('overview, screener, industries, health and contributor routes share the same snapshot', async (t) => {
  const { dispatch, last } = fixture(t);
  const overview = (await dispatch({ url: '/api/v1/market/overview' })).body;
  assert.equal(overview.date, last);
  assert.equal(overview.coverage.state, 'complete');
  assert.equal(overview.coverage.traded, 2);
  assert.equal(overview.leaders[0].symbol, 'ASTR');
  assert.equal(Number.isFinite(overview.health.score), true, overview.health.reason);
  const health = (await dispatch({ url: '/api/v1/market/health' })).body;
  assert.equal(overview.health.score, health.score);
  const drilldown = (await dispatch({ url: '/api/v1/market/breadth/above_50d/contributors' })).body;
  assert.deepEqual(drilldown.metric, overview.breadth.above_50d);
  assert.deepEqual(drilldown.rows.map(({ symbol }) => symbol), ['ASTR']);
  const rank = (await dispatch({ url: '/api/v1/rankings' })).body;
  assert.deepEqual(rank.rows.map(({ symbol, rsRank }) => [symbol, rsRank]), [['ASTR', 1], ['BORE', 2]]);
  const industries = (await dispatch({ url: '/api/v1/industries?level=industry' })).body;
  assert.equal(industries.groups[0].name, 'Systems');
  assert.equal(industries.groups[0].medianRS, 100);
  assert.equal(industries.groups[0].upDollar > 0, true);
  const member = (await dispatch({ url: `/api/v1/industries/${encodeURIComponent(industries.groups[0].id)}/members` })).body;
  assert.equal(member.rows[0].securityId, rank.rows[0].securityId);
  const sample = (await dispatch({ url: '/api/v1/market/overview?universe=sample' })).body;
  assert.equal(sample.health.score, null);
});

test('dated universe and theme membership excludes future members, and workspace resources survive reopening', async (t) => {
  const { dispatch, filename, first, last } = fixture(t, true);
  const definition = { members: [{ securityId: 'fixture:ASTR', effectiveFrom: last, knownAt: last }] };
  const universe = (await dispatch({ method: 'POST', url: '/api/v1/universes', body: { name: 'Quarter-end winners', definition } })).body;
  assert.equal(universe.definition.members[0].securityId, 'fixture:ASTR');
  assert.equal((await dispatch({ url: `/api/v1/market/overview?universe=${universe.id}&date=${first}` })).body.coverage.traded, 0);
  assert.equal((await dispatch({ url: `/api/v1/market/overview?universe=${universe.id}&date=${last}` })).body.coverage.traded, 1);
  const saved = (await dispatch({ method: 'POST', url: '/api/v1/screens', body: { name: 'Research candidates',
    definition: { filter: { field: 'symbol', op: 'eq', value: 'ASTR' } },
  } })).body;
  const dynamic = (await dispatch({ method: 'POST', url: '/api/v1/watchlists', body: { name: 'Live candidates',
    definition: { screenId: saved.id },
  } })).body;
  const manual = (await dispatch({ method: 'POST', url: '/api/v1/watchlists', body: { name: 'My list' } })).body;
  assert.equal((await dispatch({ method: 'POST', url: `/api/v1/watchlists/${manual.id}/members`, body: { add: ['fixture:ASTR'] } })).body.version, 2);
  const alternate = openDatabase(filename);
  try {
    const next = createService({ db: alternate });
    for (const id of [manual.id, dynamic.id]) {
      const result = await next.dispatch({ url: `/api/v1/watchlists/${id}/members` });
      assert.equal(result.body.rows[0].securityId, 'fixture:ASTR');
    }
    const result = await next.dispatch({ method: 'POST', url: `/api/v1/screens/${saved.id}/execute`, body: { export: 'csv', columns: ['symbol', 'rsRank'] } });
    assert.match(result.headers['content-type'], /text\/csv/);
    assert.match(result.body, /ASTR,1/);
  } finally { alternate.close(); }
});

test('the HTTP handler serves the live frontend and normal API entrypoints and enforces local auth rules', async (t) => {
  const { dispatch } = fixture(t);
  const handler = createHandler({ service: { dispatch }, token: 'workspace-secret' });
  async function request(url, opts = {}) {
    const { method = 'GET', body, host = '127.0.0.1:4173', origin, token = 'workspace-secret' } = opts;
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { url, method, headers: { host, origin, authorization: token ? `Bearer ${token}` : null } });
    let output;
    await handler(req, { writeHead(status, headers) { output = { status, headers }; }, end(data) { output.body = data?.toString(); } });
    return output;
  }
  assert.match((await request('/')).body, /Market Intelligence/);
  assert.match((await request('/app.js')).headers['Content-Type'], /javascript/);
  assert.equal((await request('/api/v1/config', { token: null })).status, 401);
  assert.equal((await request('/api/v1/config', { host: 'other.example' })).status, 403);
  assert.equal((await request('/api/v1/data/import', { method: 'POST', origin: 'https://other.example', body: {} })).status, 403);
  assert.equal(JSON.parse((await request('/api/v1/market/overview')).body).coverage.traded, 2);
});

test('persisted worker materializes history without adding full-date snapshots', async (t) => {
  const { db, dispatch, last } = fixture(t, true);
  const accepted = await dispatch({ method: 'POST', url: '/api/v1/data/materialize', body: { context: { date: last }, limit: 4 } });
  assert.equal(accepted.status, 202);
  let job;
  for (let attempt = 0; attempt < 200; attempt++) {
    await delay(20);
    job = (await dispatch({ url: `/api/v1/jobs/${accepted.body.id}` })).body;
    if (['complete', 'failed'].includes(job.status)) break;
  }
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.progress, 100);
  assert.equal(job.result.written, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 0);
  const result = await dispatch({ url: '/api/v1/market/breadth?series=1&materializedOnly=1&metrics=above_50d&limit=4' });
  assert.equal(result.body.materialization.complete, true);
  assert.equal(result.body.rows.length, 4);
});

test('versioned rank archive serves daily and weekly history from persisted canonical rows', async (t) => {
  const { db, dispatch } = fixture(t, true);
  const accepted = await dispatch({ method: 'POST', url: '/api/v1/data/materialize', body: { kind: 'rankings', limit: 8 } });
  let result;
  for (let index = 0; index < 200; index++) {
    await delay(20);
    result = (await dispatch({ url: `/api/v1/jobs/${accepted.body.id}` })).body;
    if (['complete', 'failed'].includes(result.status)) break;
  }
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.result.written, 8);
  assert.equal(db.prepare('SELECT count(*) AS n FROM stock_rank_history').get().n, 16);
  const history = await dispatch({ url: '/api/v1/rankings?series=1&cadence=daily&materializedOnly=1&symbol=ASTR&limit=8' });
  assert.equal(history.body.archived, 8);
  assert.equal(history.body.rows.length, 8);
  assert.ok(history.body.rows.every((row) => row.rank === 1 && row.percentile === 100));
});

test('provider credential stays server-side and mock network import is ordinary persistent ingest', async (t) => {
  const { db } = dbFor(t);
  const paths = [];
  const provider = EodhdProvider({ apiKey: 'super-secret-test-key', attempts: 1, fetcher: async (url) => {
    assert.equal(url.searchParams.get('api_token'), 'super-secret-test-key');
    paths.push(url.pathname);
    if (url.pathname.includes('exchange-symbol-list')) return Response.json([{ Code: 'ASTR', Name: 'Astral', Exchange: 'NASDAQ', Type: 'Common Stock' }]);
    if (url.pathname.includes('/eod/')) return Response.json([price('ASTR', '2024-01-02', 100)]);
    return new Response('super-secret-test-key', { status: 403 });
  } });
  const result = await importProviderData({ symbols: ['ASTR'], from: '2024-01-02', to: '2024-01-02' }, {
    provider, write: (batch) => importDataset(db, batch),
  });
  assert.equal(result.imported, 1);
  assert.ok(paths.includes('/api/eod/ASTR.US'));
  assert.doesNotMatch(JSON.stringify(result), /super-secret-test-key/);
  assert.match(result.warnings[0], /HTTP 403/);
});

async function finishedJob(dispatch, accepted) {
  let job;
  assert.equal(accepted.status, 202, accepted.body.error);
  for (let attempt = 0; attempt < 200; attempt++) {
    await delay(20);
    job = (await dispatch({ url: `/api/v1/jobs/${accepted.body.id}` })).body;
    if (['complete', 'failed'].includes(job.status)) return job;
  }
  assert.fail(`Job ${accepted.body.id} did not complete`);
}

test('market monitor calibrates against prior sessions independent of display length', async (t) => {
  const { dispatch, last } = fixture(t);
  const replies = await Promise.all([1, 5].map((limit) => dispatch({ url: `/api/v1/market/monitor?limit=${limit}` })));
  assert.equal(replies[0].body.rows.length, 1);
  assert.equal(replies[1].body.rows.length, 5);
  const latest = replies[0].body.rows[0];
  assert.equal(latest.date, last);
  assert.equal(latest.up_4pct, 0);
  assert.equal(latest.up_4pct_extreme_percentile, 50);
  assert.equal(latest.up_4pct_calibration_observations, 252);
  assert.equal(latest.up_down_4pct_5d_state, 'unavailable');
  assert.equal(latest.up_13pct_34d_denominator, 2);
  const recent = replies[1].body.rows.at(-1);
  for (const key of ['up_4pct_extreme_percentile', 'up_4pct_calibration_observations', 'up_13pct_34d',
    'up_13pct_34d_extreme_percentile', 'up_down_4pct_5d_state', 'up_down_4pct_10d']) assert.equal(latest[key], recent[key]);
});

test('a point-in-time cohort job retains the entry quote published by the event session', async (t) => {
  const { db } = dbFor(t);
  const dates = ['2024-01-02', '2024-01-03', '2024-01-04'];
  importDataset(db, { provider: 'fixture', securities: [security('ASTR')],
    prices: [price('ASTR', dates[0], 100), price('ASTR', dates[1], 110), price('ASTR', dates[2], 115)] });
  importDataset(db, { provider: 'fixture', prices: [price('ASTR', dates[0], 120, { knownAt: dates[2] })] });
  const { dispatch } = createService({ db });
  const job = await finishedJob(dispatch, await dispatch({ method: 'POST', url: '/api/v1/research/cohorts',
    body: { context: { basis: 'known' }, date: dates[0], asOf: dates[2], horizons: [1] },
  }));
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.result.memberCount, 1);
  closeTo(job.result.results[0].summary.mean, 10);
});

test('a partial bulk response retries on eligible-core coverage before publishing analytics', async (t) => {
  const { db } = dbFor(t);
  const date = latestFinalizableSession();
  const securities = [security('ASTR'), security('BORE'), security('SPY', { type: 'ETF' })];
  let first = true;
  const provider = {
    getSecurities: async () => securities,
    getDailyPrices: async () => (first ? ['ASTR', 'SPY'] : ['ASTR', 'BORE', 'SPY']).map((symbol) => price(symbol, date, 100)),
  };
  const { dispatch } = createService({ db, provider, workers: false });
  const refresh = () => dispatch({ method: 'POST', url: '/api/v1/data/refresh', body: { bulk: true, date, actions: false, verifiedOnly: true } });
  const before = await finishedJob(dispatch, await refresh());
  assert.equal(before.status, 'failed');
  assert.match(before.error, /too incomplete/);
  assert.equal(warehouseStatus(db).latestSession.eligibleReceived, 1);
  assert.equal(warehouseStatus(db).latestSession.received, 2);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='rank_archive_dates'").get(), undefined);
  first = false;
  const after = await finishedJob(dispatch, await refresh());
  assert.equal(after.status, 'complete', after.error);
  assert.deepEqual(after.result.published, [date]);
  assert.equal(warehouseStatus(db).latestSession.eligibleReceived, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rank_archive_dates').get().n, 3);
});

test('cold monitor queues one pinned materialization for a large reference catalog and returns aligned rows after completion', async (t) => {
  const { db, dispatch, last } = fixture(t, true);
  importDataset(db, { provider: 'fixture', dataset: 'catalog', securities:
    Array.from({ length: 298 }, (_, index) => security(`REF${index}`, { type: 'preferred' })) });
  const url = '/api/v1/market/monitor?limit=2&metrics=up_4pct,down_13pct_34d';
  const first = await dispatch({ url });
  const second = await dispatch({ url });
  assert.equal(first.status, 200);
  const pending = first.body.materialization;
  assert.equal(pending.pending, true);
  assert.equal(pending.visibleRequested, 2);
  assert.equal(pending.requested, 254);
  assert.equal(pending.missingDates.length, 254);
  assert.equal(first.body.rows.length, 0);
  assert.equal(second.body.materialization.jobId, pending.jobId);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE type='materialize'").get().n, 1);
  const job = await finishedJob(dispatch, { status: 202, body: { id: pending.jobId } });
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.payload.context.dataVersion, 2);
  assert.deepEqual(job.payload.context.breadthKeys, ['down_13pct_34d']);
  assert.equal(job.payload.context.windows.includes(34), true);
  const completed = await dispatch({ url });
  assert.equal(completed.body.materialization.complete, true);
  assert.equal(completed.body.materialization.pending, undefined);
  assert.equal(completed.body.rows.length, 2);
  assert.equal(completed.body.rows.at(-1).date, last);
  assert.equal(completed.body.rows.at(-1).down_13pct_34d_denominator, 2);
  assert.equal(completed.body.rows.at(-1).up_4pct_calibration_observations, 252);
});

test('cold generic history queues materialization with more than one hundred priced securities', async (t) => {
  const { db } = dbFor(t, true);
  const dates = expectedSessions('2024-01-02', '2024-01-05');
  const securities = Array.from({ length: 101 }, (_, index) => security(`ACTIVE${index}`));
  importDataset(db, { provider: 'fixture', securities, prices: securities.flatMap(({ symbol }) =>
    dates.map((date, index) => price(symbol, date, 100 + 5 * index))) });
  const { dispatch } = createService({ db });
  const url = '/api/v1/market/breadth?series=1&limit=2&metrics=up_4pct';
  const response = await dispatch({ url });
  assert.equal(response.body.materialization.pending, true);
  const job = await finishedJob(dispatch, { status: 202, body: { id: response.body.materialization.jobId } });
  assert.equal(job.status, 'complete', job.error);
  const completed = await dispatch({ url });
  assert.equal(completed.body.rows.length, 2);
  assert.equal(completed.body.rows.at(-1).up_4pct, 100);
  assert.equal(completed.body.rows.at(-1).up_4pct_denominator, 101);
});

test('daily publication repairs the entire pipeline after a post-capture failure without requesting the provider again', async (t) => {
  const { db } = dbFor(t, true);
  const date = latestFinalizableSession();
  const symbols = ['ASTR', 'BORE'];
  let networkCalls = 0;
  const provider = {
    async getSecurities() { networkCalls++; return symbols.map((symbol) => security(symbol)); },
    async getDailyPrices() { networkCalls++; return symbols.map((symbol) => price(symbol, date, 100)); },
  };
  db.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON daily_publications BEGIN
    SELECT RAISE(ABORT, 'Injected publication failure'); END`);
  const { dispatch } = createService({ db, provider, workers: false });
  const refresh = () => dispatch({ method: 'POST', url: '/api/v1/data/refresh', body: { bulk: true, date, actions: false, verifiedOnly: true } });
  const failed = await finishedJob(dispatch, await refresh());
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Injected publication failure/);
  assert.equal(networkCalls, 2);
  assert.equal(warehouseStatus(db).latestSession.eligibleReceived, 2);
  assert.equal(warehouseStatus(db).latestPublication, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rank_archive_dates').get().n, 3);
  db.exec('DROP TRIGGER fail_publication');
  const recovered = await finishedJob(dispatch, await refresh());
  assert.equal(recovered.status, 'complete', recovered.error);
  assert.deepEqual(recovered.result.published, [date]);
  assert.equal(recovered.result.imported, 0);
  assert.equal(networkCalls, 2);
  const publication = warehouseStatus(db).latestPublication;
  assert.equal(publication.date, date);
  assert.equal(publication.raw_version, 1);
  assert.equal(publication.data_version, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rank_archive_dates').get().n, 3);
  const again = await finishedJob(dispatch, await refresh());
  assert.deepEqual(again.result.alreadyPublished, [date]);
  assert.equal(networkCalls, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM daily_publications').get().n, 1);
});

test('daily catch-up repairs an available capture while a different session remains blocked upstream', async (t) => {
  const { db } = dbFor(t);
  const date = latestFinalizableSession();
  const previous = expectedSessions(new Date(Date.parse(date) - 7 * 86_400_000).toISOString().slice(0, 10), date).at(-2);
  importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 1,
    securities: [security('ASTR')], prices: [price('ASTR', date, 100)],
  });
  let networkCalls = 0;
  const provider = { async getSecurities() { networkCalls++; throw new Error('Controlled provider outage'); } };
  const { dispatch } = createService({ db, provider, workers: false });
  const job = await finishedJob(dispatch, await dispatch({
    method: 'POST', url: '/api/v1/data/refresh', body: { bulk: true, from: previous, to: date, verifiedOnly: true },
  }));
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(job.result.published, [date]);
  assert.deepEqual(job.result.stillPending, [previous]);
  assert.match(job.result.warnings[0], /Controlled provider outage/);
  assert.equal(warehouseStatus(db).latestPublication.date, date);
  assert.equal(networkCalls, 1);
});

test('EODHD account quota supports timestamp dates and reserves unknown-date usage conservatively', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const base = { apiRequests: 37, dailyRateLimit: 100, extraLimit: 5 };
  const provider = (apiRequestsDate) => EodhdProvider({ apiKey: 'local-test', attempts: 1,
    fetcher: async () => Response.json({ ...base, apiRequestsDate, email: 'privacy@example.invalid' }),
  });
  assert.deepEqual(await provider(`${day} 06:30:21`).getQuota(), { requestDate: day, dailyLimit: 100, extra: 5, used: 37, remaining: 68 });
  assert.equal((await provider('2020-01-01 09:35:00').getQuota()).remaining, 105);
  assert.equal((await provider('unknown').getQuota()).remaining, 68);
  assert.equal((await provider(Date.parse(day) / 1000).getQuota()).requestDate, day);
});

test('stock detail reports saved-screen membership using the selected historical snapshot', async (t) => {
  const { dispatch, first, last } = fixture(t);
  const add = (name, filter) => dispatch({ method: 'POST', url: '/api/v1/screens', body: { name, definition: { filter } } });
  const always = (await add('Technology names', { field: 'industry', op: 'eq', value: 'Systems' })).body;
  const now = (await add('Stocks above $150', { field: 'close', op: 'gt', value: 150 })).body;
  await add('Industrial companies', { field: 'industry', op: 'eq', value: 'Machinery' });
  const historical = (await dispatch({ url: `/api/v1/stocks/ASTR/screens?date=${first}` })).body;
  const current = (await dispatch({ url: `/api/v1/stocks/ASTR/screens?date=${last}` })).body;
  assert.equal(historical.evaluated, 3);
  assert.equal(historical.date, first);
  assert.deepEqual(historical.screens.map(({ id }) => id), [always.id]);
  assert.deepEqual(new Set(current.screens.map(({ id }) => id)), new Set([always.id, now.id]));
});

test('EODHD spaces concurrent requests and honors retry-after beyond fifteen seconds', async () => {
  let clock = 10_000;
  const starts = [];
  const headers = { 'x-ratelimit-limit': '500', 'x-ratelimit-remaining': '15' };
  const client = EodhdProvider({ apiKey: 'local-test', minRequestSpacing: 75, clock: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    fetcher: async (url) => {
      starts.push({ time: clock, path: url.pathname });
      if (starts.length === 1) return new Response(null, { status: 429, headers: { 'retry-after': '32' } });
      return Response.json([], { headers });
    },
  });
  await client.getSecurities();
  const first = starts[0].time;
  assert.equal(starts[1].time - first, 32_000);
  await Promise.all([client.getSecurities(), client.getSecurities(), client.getSecurities()]);
  assert.ok(starts.slice(3).every(({ time }, index) => time - starts[index + 2].time >= 75));
});

test('latest observed reference facts have a separate clock and never reach earlier or known snapshots', async (t) => {
  const { db } = dbFor(t);
  const older = '2025-06-12';
  const latest = '2025-06-13';
  const sourceDate = '2025-06-14';
  importDataset(db, { provider: 'fixture', securities: [security('ASTR')],
    prices: [price('ASTR', older, 100), price('ASTR', latest, 103)] });
  importDataset(db, { provider: 'nasdaq', classifications: [{ securityId: 'fixture:ASTR',
    system: 'nasdaq', effectiveFrom: sourceDate, knownAt: sourceDate, industry: 'Systems' }],
    fundamentals: [{ securityId: 'fixture:ASTR', effectiveDate: sourceDate, knownAt: sourceDate, marketCap: 5_000, float: 40 }] });
  const { dispatch } = createService({ db });
  const url = `/api/v1/stocks/ASTR?classification=nasdaq&observedReferenceDate=${sourceDate}`;
  const current = (await dispatch({ url: url + '&reference=latest' })).body;
  assert.equal(current.date, latest);
  assert.equal(current.referenceDate, sourceDate);
  assert.equal(current.referenceMode, 'latest');
  assert.equal(current.industry, 'Systems');
  assert.equal(current.market_cap, 5_000);
  assert.equal(current.float_turnover_1d, null);
  for (const query of ['', '&basis=known&reference=latest', `&date=${older}&reference=latest`]) {
    const comparable = (await dispatch({ url: url + query })).body;
    assert.equal(comparable.referenceMode, 'as-of');
    assert.equal(comparable.industry, null);
    assert.equal(comparable.market_cap, null);
  }
});

test('workspace precompute stores compact latest velocity plus canonical rank and breadth archives', async (t) => {
  const { db, dispatch, last } = fixture(t, true);
  const accepted = await dispatch({ method: 'POST', url: '/api/v1/data/materialize',
    body: { kind: 'workspace', dailyTail: 2, allModels: true },
  });
  const job = await finishedJob(dispatch, accepted);
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.result.date, last);
  assert.equal(job.result.models.length, 3);
  assert.equal(job.result.models[0].ranked, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM snapshots WHERE kind='market-velocity' AND date=?").get(last).n, 3);
  const response = await dispatch({ url: '/api/v1/rankings' });
  assert.deepEqual(response.body.rows.map(({ symbol, rankChange4w }) => [symbol, rankChange4w]), [['ASTR', 0], ['BORE', 0]]);
});

test('an undated provider refresh does not backdate an identity discovered in a current capture', async (t) => {
  const { db } = dbFor(t);
  const date = '2025-06-12';
  const { reconcileCurrentCapture } = await import('../scripts/reconcile-current.mjs');
  const current = security('FRESH', { listingDate: null, isin: 'US1234567890', knownAt: date });
  const reconciled = reconcileCurrentCapture(db, { catalog: [current], prices: [price('FRESH', date, 120)],
    date, capturedAt: date, catalogHash: 'one', pricesHash: 'two' });
  assert.equal(reconciled.currentOnlyIdentifiers, 1);
  importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 1, securities: [current],
    prices: [price('FRESH', '2025-06-13', 122)] });
  assert.deepEqual(db.prepare('SELECT valid_from FROM identifiers WHERE symbol=?').all('FRESH').map(({ valid_from }) => valid_from), [date]);
  assert.equal(db.prepare('SELECT listing_date FROM securities WHERE isin=?').get(current.isin).listing_date, null);
  const repeated = reconcileCurrentCapture(db, { catalog: [current], prices: [price('FRESH', date, 120)],
    date, capturedAt: date, catalogHash: 'one', pricesHash: 'two' });
  assert.equal(repeated.duplicate, true);
});

test('bulk refresh quarantines a new alias for a closed issue and bounds a verified active rename to the observed session', async (t) => {
  const { db } = dbFor(t);
  const date = latestFinalizableSession();
  const [previous] = expectedSessions(shiftDate(date, -14), date).slice(-2);
  const closed = 'US1234567890';
  const renamed = 'US1234567891';
  importDataset(db, { provider: 'eodhd', securities: [
    security('GONE', { securityId: 'eodhd:closed', isin: closed, status: 'delisted', delistingDate: '2025-06-12' }),
    security('FORMER', { securityId: 'eodhd:continuing', isin: renamed, status: 'active' }),
    security('ASTR', { isin: 'US1234567892' }),
  ], prices: [price('GONE', '2025-06-12', 30), price('FORMER', previous, 110)] });
  const provider = {
    getSecurities: async () => [security('UNBOUND', { isin: closed, listingDate: null }),
      security('RENAMED', { isin: renamed, listingDate: null }), security('ASTR', { isin: 'US1234567892' })],
    getDailyPrices: async ({ date: session }) => [
      price('UNBOUND', session, 900), price('RENAMED', session, 120), price('ASTR', session, 100),
    ],
  };
  // Only the latest session may add a previously unobserved alias.
  const result = await importProviderData({ bulk: true, from: previous, to: date, actions: false }, { db, provider });
  assert.deepEqual(result.dates, [previous, date]);
  assert.deepEqual(db.prepare("SELECT symbol,valid_from FROM identifiers WHERE security_id='eodhd:continuing' ORDER BY valid_from, symbol")
    .all().map(({ symbol, valid_from }) => [symbol, valid_from]), [['FORMER', '2020-01-02'], ['RENAMED', date]]);
  assert.equal(db.prepare("SELECT status FROM securities WHERE id='eodhd:closed'").get().status, 'delisted');
  assert.equal(db.prepare("SELECT 1 FROM identifiers WHERE symbol='UNBOUND'").get(), undefined);
  assert.equal(db.prepare("SELECT close FROM daily_prices WHERE security_id='eodhd:continuing' AND date=?").get(previous).close, 110);
  assert.equal(db.prepare("SELECT close FROM daily_prices WHERE security_id='eodhd:continuing' AND date=?").get(date).close, 120);
  assert.equal(db.prepare("SELECT security_id FROM session_capture_expected WHERE symbol='UNBOUND' AND date=?").get(date).security_id, null);
});

test('bulk refresh quarantines two current ticker quotes for one ISIN and refuses actions on either alias', async (t) => {
  const { db } = dbFor(t);
  const date = latestFinalizableSession();
  const duplicateIsin = 'US1234567890';
  importDataset(db, { provider: 'eodhd', securities: [security('FIRST', { securityId: 'eodhd:existing', isin: duplicateIsin })] });
  const { dispatch } = createService({ db, workers: false, provider: {
    getSecurities: async () => [security('FIRST', { isin: duplicateIsin }), security('SECOND', { isin: duplicateIsin }), security('ASTR')],
    getDailyPrices: async () => [price('FIRST', date, 111), price('SECOND', date, 222), price('ASTR', date, 333)],
    getCorporateActions: async () => [{ symbol: 'FIRST', date, type: 'split', factor: 2 }, { symbol: 'SECOND', date, type: 'dividend', amount: 4 }],
  } });
  const job = await finishedJob(dispatch, await dispatch({
    method: 'POST', url: '/api/v1/data/refresh', body: { bulk: true, date },
  }));
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.result.captures[0].identityExclusions.ambiguousCatalog, 2);
  assert.equal(job.result.captures[0].identityExclusions.unresolvedAction, 2);
  assert.equal(job.result.captures[0].eligibleReceived, 1);
  assert.equal(db.prepare("SELECT 1 FROM identifiers WHERE symbol='SECOND'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM daily_prices WHERE security_id='eodhd:existing'").get(), undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM corporate_actions").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_capture_expected WHERE security_id IS NULL").get().n, 2);
});

test('a verified Core primary listing keeps the sole quote when its alternate ticker is outside Core', async (t) => {
  const { db } = dbFor(t);
  const date = latestFinalizableSession();
  const isin = 'US1234567890';
  const primary = security('PRIM', { isin, securityId: 'eodhd:primary',
    identifiers: [{ symbol: 'PRIM' }, { symbol: 'OTHER', exchange: 'PINK' }] });
  importDataset(db, { provider: 'eodhd', securities: [primary] });
  const provider = {
    getSecurities: async () => [primary, security('OTHER', { isin, exchange: 'PINK' })],
    getDailyPrices: async () => [price('PRIM', date, 100), price('OTHER', date, 200)],
    getCorporateActions: async () => [{ date, symbol: 'OTHER', type: 'split', factor: 10 }],
  };
  const result = await importProviderData({ bulk: true, date }, { db, provider });
  assert.equal(result.captures[0].eligibleReceived, 1);
  assert.equal(result.captures[0].identityExclusions.unresolvedAction, 1);
  assert.deepEqual(db.prepare('SELECT close FROM daily_prices').all().map((row) => row.close), [100]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM corporate_actions').get().n, 0);
});

test('bulk refresh commits all fifteen benchmarks and dated actions with exact core coverage', async (t) => {
  const { db } = dbFor(t);
  const date = latestFinalizableSession();
  const symbols = ['ASTR', ...BENCHMARKS];
  let actionFeedDown = true;
  const { dispatch } = createService({ db, workers: false, provider: {
    getSecurities: async () => [security('ASTR'), ...BENCHMARKS.map((symbol) => security(symbol, { type: 'ETF', exchange: 'NYSE ARCA', listingDate: null }))],
    getDailyPrices: async () => symbols.map((symbol) => price(symbol, date, 120, { exchange: 'US' })),
    getCorporateActions: async () => {
      if (actionFeedDown) throw new Error('Split feed unavailable');
      return [{ symbol: 'ASTR', date, type: 'split', factor: 2 }, { symbol: 'SPY', date, type: 'dividend', amount: 1.5 }];
    },
  } });
  const refresh = () => dispatch({ method: 'POST', url: '/api/v1/data/refresh', body: { bulk: true, date, verifiedOnly: true } });
  const failed = await finishedJob(dispatch, await refresh());
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Split feed unavailable/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_imports').get().n, 0);
  actionFeedDown = false;
  const completed = await finishedJob(dispatch, await refresh());
  assert.equal(completed.status, 'complete', completed.error);
  assert.deepEqual(completed.result.published, [date]);
  assert.equal(completed.result.captures[0].expected, 1);
  assert.equal(completed.result.captures[0].eligibleReceived, 1);
  assert.equal(completed.result.captures[0].received, 16);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM daily_prices p JOIN securities s ON s.id=p.security_id WHERE s.type='etf'").get().n, 15);
  assert.deepEqual(db.prepare(`SELECT i.symbol,a.type,a.factor,a.amount,a.date FROM corporate_actions a
    JOIN identifiers i ON i.security_id=a.security_id ORDER BY i.symbol`).all().map((row) => Object.values(row)),
  [['ASTR', 'split', 2, null, date], ['SPY', 'dividend', null, 1.5, date]]);
});

test('journal API stores settings privately, keeps notes local by default, and exports a generated journal', async (t) => {
  const { db, last } = fixture(t, true);
  const inputs = [];
  const secret = 'sk-ant-private-integration-test';
  const { dispatch } = createService({ db, journalClient: async (request) => {
    inputs.push(request);
    return { title: 'Participation check', markdown: 'Market breadth as observed.', sentiment: 'neutral', sentiment_score: 0,
      market_health: 6, risk_posture: 'selective', confidence: 6.5, factors: [{ key: 'thrust', label: 'Thrust', value: 3 }] };
  } });
  const settings = await dispatch({ method: 'PUT', url: '/api/v1/journal/settings', body: { apiKey: secret } });
  assert.equal(settings.body.configured, true);
  assert.doesNotMatch(JSON.stringify(settings.body), /private-integration/);
  assert.doesNotMatch(db.prepare('SELECT encrypted_key AS key FROM journal_settings').get().key, /private-integration/);
  const prompt = await dispatch({ method: 'POST', url: '/api/v1/journal/prompts',
    body: { prompt: 'Write an observation.', factors: [{ key: 'thrust', label: 'Thrust' }] } });
  assert.equal(prompt.body.active.version, 2);
  const note = await dispatch({ method: 'PUT', url: `/api/v1/journal/entries/${last}`, body: { markdown: 'My local notes' } });
  assert.equal(note.body.version, 1);
  const generated = await finishedJob(dispatch, await dispatch({ method: 'POST', url: '/api/v1/journal/generate', body: { asOfDate: last } }));
  assert.equal(generated.status, 'complete', generated.error);
  assert.equal(inputs[0].apiKey, secret);
  assert.doesNotMatch(inputs[0].user, /My local notes/);
  assert.equal(generated.result.retrospective, true);
  const series = await dispatch({ url: '/api/v1/journal/factors?includeRetrospective=1' });
  assert.equal(series.body.rows[0].factors[0].value, 3);
  assert.equal(series.body.counts.observations, 1);
  const exported = await dispatch({ url: `/api/v1/journal/entries/${last}?export=markdown` });
  assert.match(exported.headers['content-type'], /markdown/);
  assert.match(exported.body, /observed/);
});

test('cash actions bridge a daily dividend append across differing provider adjustment vintages', () => {
  const date1 = '2025-06-12';
  const date2 = '2025-06-13';
  const provider = [
    { date: date1, open: 100, high: 100, low: 100, close: 100, adjusted_close: 100, volume: 50, volume_basis: date1, source: 'eodhd' },
    { date: date2, open: 98, high: 98, low: 98, close: 98, adjusted_close: 98, volume: 60, volume_basis: date2, source: 'eodhd' },
  ];
  const series = prepareBars(provider, [{ date: date2, type: 'dividend', amount: 3 }], date2);
  closeTo(returnWindow(series, 0, 1), -0.02);
  closeTo(returnWindow(series, 0, 1, 'total'), 0.01);
});

test('a verified special dividend is a price decline without a phantom split or total-return loss', () => {
  const date1 = '2025-06-12';
  const date2 = '2025-06-13';
  const provider = [
    { date: date1, open: 100, high: 100, low: 100, close: 100, adjusted_close: 50, volume: 50, volume_basis: date2, source: 'eodhd' },
    { date: date2, open: 50, high: 50, low: 50, close: 50, adjusted_close: 50, volume: 60, volume_basis: date2, source: 'eodhd' },
  ];
  const series = prepareBars(provider, [{ date: date2, type: 'dividend', amount: 50 }], date2);
  assert.equal(series[1].unverifiedSplit, false);
  closeTo(returnWindow(series, 0, 1), -0.5);
  closeTo(returnWindow(series, 0, 1, 'total'), 0);
});

test('an exact custom breadth trend and its historical contributor export reconcile to the same counts', async (t) => {
  const { dispatch } = fixture(t);
  const series = (await dispatch({ url: '/api/v1/market/breadth/up_13pct_34d?series=1&limit=2' })).body;
  assert.deepEqual(series.metrics, ['up_13pct_34d']);
  const row = series.rows[0];
  const base = `/api/v1/market/breadth/up_13pct_34d/contributors?date=${row.date}`;
  const detail = (await dispatch({ url: base })).body;
  assert.equal(detail.metric.numerator, row.up_13pct_34d_numerator);
  assert.equal(detail.metric.denominator, row.up_13pct_34d_denominator);
  const csv = await dispatch({ url: base + '&include=denominator&export=csv&perPage=1' });
  assert.match(csv.body, /ASTR/);
  assert.match(csv.body, /BORE/);
  const signed = (await dispatch({ url: `/api/v1/market/breadth/adSpread/contributors?date=${row.date}` })).body;
  assert.deepEqual(signed.rows.map(({ contribution }) => contribution), [1, -1]);
  assert.equal(signed.metric.numerator, 0);
  assert.equal(signed.metric.denominator, 2);
});

test('dated instrument evidence refines the current Core, keeps historical types and preserves coverage provenance', async (t) => {
  const { db } = dbFor(t);
  const older = '2025-06-12';
  const latest = '2025-06-13';
  const captured = '2025-06-14';
  const symbols = ['CORE', 'ADS', 'TRUST', 'PREF'];
  importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 4,
    securities: symbols.map((symbol) => security(symbol, { status: 'active' })),
    expectedRoster: symbols.map((symbol) => ({ symbol })),
    prices: symbols.flatMap((symbol) => [price(symbol, older, 100), price(symbol, latest, 103)]),
  });
  importDataset(db, { provider: 'nasdaq', dataset: 'reference-capture', catalogDate: captured,
    instrumentTypes: [['ADS', 'adr'], ['TRUST', 'reit'], ['PREF', 'preferred'], ['CORE', null]].map(([symbol, subtype]) => ({
      securityId: `eodhd:${symbol}`, effectiveDate: captured, knownAt: captured, capturedAt: '2025-06-14T15:00:00Z', subtype,
    })) });
  const engine = createEngine(db);
  const input = { reference: 'latest', observedReferenceDate: captured };
  const current = engine.snapshot(engine.context(input));
  assert.deepEqual(current.stocks.map(({ symbol }) => symbol), ['CORE']);
  assert.deepEqual([current.coverage.sourceExpected, current.coverage.sourceReceived, current.coverage.expected, current.coverage.received], [4, 4, 1, 1]);
  assert.equal(current.coverage.ratio, 1);
  assert.equal(current.coverage.subtypeCoverage.excludedBySubtype.adr, 1);
  assert.equal(current.coverage.subtypeCoverage.excludedBySubtype.reit, 1);
  assert.equal(current.coverage.subtypeCoverage.excludedBySubtype.preferred, 1);
  assert.equal(current.coverage.subtypeCoverage.unverifiedProviderCommon, 1);
  for (const extra of [{ basis: 'known' }, { reference: 'as-of' }, { date: older }, { dataVersion: 1 }]) {
    assert.equal(engine.snapshot(engine.context({ ...input, ...extra })).stocks.length, 4);
  }
  const { storeWorkspace } = await import('../backend/database.mjs');
  const { id } = storeWorkspace(db, 'universe', { name: 'Include ADR and REIT',
    definition: { types: ['common', 'adr', 'reit'] } });
  const expanded = engine.snapshot(engine.context({ ...input, universe: id }));
  assert.deepEqual(expanded.stocks.map(({ symbol, type, providerType }) => [symbol, type, providerType]),
    [['CORE', 'common', 'common'], ['ADS', 'adr', 'common'], ['TRUST', 'reit', 'common']]);
  const detail = engine.detail(engine.context(input), 'ADS', 2, { velocity: false });
  assert.equal(detail.type, 'adr');
  assert.equal(detail.providerType, 'common');
  assert.equal(detail.subtypeEffectiveDate, captured);
  assert.equal(detail.subtypeSource, 'nasdaq');
  assert.equal(db.prepare("SELECT type FROM securities WHERE id='eodhd:ADS'").get().type, 'common');
});

test('refined coverage intersects exact raw receipts and fails closed on a counts-only roster', (t) => {
  const { db } = dbFor(t);
  const latest = '2025-06-13';
  const captured = '2025-06-14';
  const symbols = ['A', 'B', 'C', 'D', 'X'];
  importDataset(db, { provider: 'eodhd', securities: symbols.map((symbol) => security(symbol, { status: 'active' })),
    prices: ['D', 'X'].map((symbol) => price(symbol, latest, 104)) });
  const batch = { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 4,
    prices: ['A', 'B'].map((symbol) => price(symbol, latest, 105)) };
  importDataset(db, batch);
  importDataset(db, { provider: 'nasdaq', instrumentTypes: ['B', 'C'].map((symbol, index) => ({
    securityId: `eodhd:${symbol}`, effectiveDate: captured, capturedAt: captured, subtype: index ? 'reit' : 'adr',
  })) });
  const engine = createEngine(db);
  const input = { reference: 'latest', observedReferenceDate: captured };
  const legacy = engine.snapshot(engine.context(input)).coverage;
  assert.deepEqual([legacy.sourceExpected, legacy.sourceReceived, legacy.expected, legacy.received], [4, 2, 4, null]);
  assert.equal(legacy.subtypeCoverage.receivedExact, false);
  assert.equal(legacy.state, 'partial');
  importDataset(db, { ...batch, expectedRoster: ['A', 'B', 'C', 'D'].map((symbol) => ({ symbol })) });
  const coverage = engine.snapshot(engine.context(input)).coverage;
  assert.deepEqual([coverage.sourceExpected, coverage.sourceReceived, coverage.expected, coverage.received, coverage.traded], [4, 2, 2, 1, 3]);
  assert.equal(coverage.subtypeCoverage.receivedExact, true);
  assert.equal(coverage.ratio, 0.5);
  assert.equal(coverage.state, 'partial');
});

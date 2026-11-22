import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { stockMetrics } from '../backend/metrics.mjs';
import { prepareDetailsBatch, readPreparedDetail, riskMetrics } from '../backend/prepared-details.mjs';
import {
  detailRiskWindows, prepareRiskHistoryBatch, readRiskHistory, riskHistoryManifest, rollingRiskMetrics,
} from '../backend/risk-history.mjs';

const securityId = 'risk:STK';
const dates = expectedSessions('2022-01-03', '2025-12-31').slice(0, 825);
const windows = [1, ...detailRiskWindows];
const fromRisk = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) {
    if (value == null || Number.isInteger(value)) {
      assert.equal(actual[key], value, key);
    } else {
      assert.ok(Math.abs(actual[key] - value) <= 1e-10 * Math.max(1, Math.abs(value)), `${key}: ${actual[key]} ≠ ${value}`);
    }
  }
};

function barsFor(offset = 0) {
  return dates.map((date, i) => {
    const close = 100 + i * 0.015 + Math.sin(i * 1.913 + offset) * 12 + Math.sin(i / 19 + offset) * 7;
    return { date, traded: true, close, high: close * 1.04, low: close * 0.98, volume: 50_000 };
  });
}

test('rolling windows match each-date risk with ordinary gaps, quarantines, missing volume, split boundaries and flat benchmarks', () => {
  const bars = barsFor();
  bars[17] = { date: dates[17], missing: true };
  bars[49] = { date: dates[49], close: 20, traded: false, volume: 0 };
  bars[77] = { date: dates[77], priceQuarantined: true };
  bars[179] = { ...bars[179], volume: null, volumeQuarantined: true };
  bars[309] = { ...bars[309], unverifiedSplit: true };
  bars[517] = { date: dates[517], missing: true };
  bars[645] = { date: dates[645], priceQuarantined: true };
  const spy = barsFor(1).filter((_, i) => i !== 211 && i !== 602);
  const flat = barsFor(2).map((bar) => ({ ...bar, close: 100 }));
  const inputs = new Map([['SPY', spy], ['VTI', flat]]);
  const result = rollingRiskMetrics(bars, dates, windows, inputs);
  const bench = new Map([...inputs].map(([symbol, quotes]) => [symbol, new Map(quotes.map(({ date, close }) => [date, close]))]));
  for (let index = 0; index < bars.length; index++) {
    const stock = stockMetrics({}, bars.slice(Math.max(0, index - 20), index + 1), { averages: [], windows: [], volumeWindows: [] });
    for (const window of windows) {
      const chartBars = bars.slice(Math.max(0, index - window + 1), index + 1);
      for (const [symbol, quotes] of bench) {
        const expected = riskMetrics({ ...stock, chartBars }, quotes);
        fromRisk(result(index, symbol, window), expected);
      }
    }
  }
});

function dataset({ explicit = false } = {}) {
  const sessions = dates.slice(0, 300);
  const splitDate = sessions[207];
  const securities = ['STK', 'SPY', 'VTI', 'QQQ'].map((symbol) => ({ symbol, listingDate: sessions[0], knownAt: sessions[0],
    exchange: 'NYSE', type: symbol === 'STK' ? 'common' : 'etf' }));
  const prices = securities.flatMap(({ symbol }, offset) => barsFor(offset).slice(0, sessions.length).map((bar) => {
    const close = bar.close / (symbol === 'STK' && bar.date >= splitDate ? 3 : 1);
    return { symbol, date: bar.date, open: close, high: close * 1.02, low: close * 0.98,
      close, adjustedClose: close, volume: bar.volume, knownAt: bar.date,
      ...(explicit && symbol === 'STK' && bar.date === sessions[170] ? { splitClose: close } : {}) };
  }));
  return { splitDate, sessions, initial: { provider: 'risk', securities, prices,
    corporateActions: [{ symbol: 'STK', type: 'split', date: splitDate, factor: 3, knownAt: splitDate }] } };
}

test('risk history commits bounded resumable buckets and reopens point-in-time risk across a verified split', (t) => {
  const { sessions, initial } = dataset();
  const directory = mkdtempSync(join(tmpdir(), 'market-risk-test-'));
  const path = join(directory, 'risk.sqlite');
  const source = openDatabase(':memory:');
  let target = openDatabase(path);
  t.after(() => {
    source.close();
    target.close();
    rmSync(directory, { recursive: true, force: true });
  });
  importDataset(source, initial);
  const engine = createEngine(source);
  const config = engine.context();
  const output = sessions.slice(150);
  const options = { dates: output, sourceDb: source, bucketSize: 1, benchmarks: ['QQQ'] };
  const partial = prepareRiskHistoryBatch(target, engine, config, options);
  assert.equal(partial.done, false);
  assert.equal(partial.processedSecurities, 1);
  assert.deepEqual(readRiskHistory(target, config, 'risk:SPY', { lookback: 63 }), { state: 'not-prepared', risk: null, sourceDataVersion: null });
  target.close();
  target = openDatabase(path);
  const second = prepareRiskHistoryBatch(target, engine, config, options);
  prepareRiskHistoryBatch(target, engine, config, options);
  const completed = prepareRiskHistoryBatch(target, engine, config, options);
  assert.equal(second.runId, partial.runId);
  assert.equal(second.processedSecurities, 2);
  assert.equal(completed.done, true);
  assert.equal(completed.commits, 4);
  assert.equal(completed.expectedKeys, output.length * detailRiskWindows.length * 4 * 3);
  assert.equal(completed.riskKeys, completed.expectedKeys);
  const exact = prepareDetailsBatch(target, engine, config, { securityIds: [securityId], riskWindows: [], sourceDb: source });
  assert.equal(exact.written, 1);
  target.close();
  target = new DatabaseSync(path, { readOnly: true });
  const manifest = riskHistoryManifest(target, completed.runId);
  assert.equal(manifest.actualBlocks, manifest.expectedBlocks);
  assert.equal(manifest.actualSecurities, 4);
  assert.deepEqual(manifest.benchmarks, ['QQQ', 'SPY', 'VTI']);
  assert.ok(manifest.bytes > 0);
  for (const date of [sessions[162], sessions[206], sessions[207], sessions[299]]) {
    const point = engine.context({ date });
    for (const lookback of detailRiskWindows) {
      const canonical = engine.detail(point, securityId, lookback, { velocity: false });
      const marks = engine.studyPrices(point, manifest.benchmarks, canonical.chartBars[0].date, date);
      for (const benchmark of manifest.benchmarks) {
        const actual = readPreparedDetail(target, point, securityId, { lookback, benchmark });
        assert.equal(actual.riskState, 'ready');
        assert.equal(actual.detail.riskSourceDataVersion, config.dataVersion);
        fromRisk(actual.detail.risk, riskMetrics(canonical, marks.get(benchmark)));
      }
    }
  }
});

test('ambiguous vendor split basis and known dates require exact prep, and later corrections invalidate only affected reads', () => {
  const { sessions, splitDate, initial } = dataset({ explicit: true });
  const db = openDatabase(':memory:');
  try {
    importDataset(db, initial);
    const engine = createEngine(db);
    const config = engine.context();
    const completed = prepareRiskHistoryBatch(db, engine, config, { dates: sessions.slice(170), securityIds: [securityId] });
    assert.equal(completed.done, true);
    assert.ok(completed.basisExclusions > 0);
    assert.equal(completed.basisExclusions + completed.riskKeys, completed.expectedKeys);
    const earlier = engine.context({ date: sessions[206] });
    assert.equal(readRiskHistory(db, earlier, securityId, { lookback: 63 }).state, 'requires-exact-date');
    assert.equal(readRiskHistory(db, engine.context({ date: splitDate }), securityId, { lookback: 63 }).state, 'ready');
    const known = engine.context({ date: splitDate, basis: 'known' });
    assert.equal(prepareRiskHistoryBatch(db, engine, known).status, 'unsupported-basis');
    assert.equal(readRiskHistory(db, known, securityId, { lookback: 63 }).state, 'not-prepared');
    const corrected = sessions[250];
    importDataset(db, { provider: 'risk', prices: [{ symbol: 'STK', date: corrected, open: 40, high: 42, low: 39,
      close: 40, adjustedClose: 40, volume: 50_000, knownAt: corrected }] });
    assert.equal(readRiskHistory(db, engine.context({ date: sessions[249] }), securityId, { lookback: 63 }).sourceDataVersion, config.dataVersion);
    assert.equal(readRiskHistory(db, engine.context({ date: corrected }), securityId, { lookback: 63 }).state, 'not-prepared');
  } finally {
    db.close();
  }
});

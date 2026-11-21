import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { readMaterializedHistory } from '../backend/materialization.mjs';
import { precomputeProduction, precomputeWorkspace } from '../backend/precompute.mjs';
import { readRankArchive } from '../backend/rank-archive.mjs';
import { BUILTIN_MODELS } from '../backend/ranking.mjs';

const sessions = expectedSessions('2024-01-02', '2024-03-12');
const monitorMetrics = ['down_13pct_34d', 'up_13pct_34d'];
const symbolList = ['ABC', 'DEF', 'SPY'];

function bar(symbol, date, index) {
  const close = symbol === 'ABC' ? 100 * 1.01 ** index : symbol === 'DEF' ? 100 * 0.99 ** index : 100 + index;
  return { symbol, date, knownAt: date, close, open: close, low: close, high: close, adjustedClose: close, volume: 100 };
}

function fixture(t, { sec = true } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const securities = symbolList.map((symbol) => ({ symbol, name: symbol, exchange: 'NYSE', type: symbol === 'SPY' ? 'etf' : 'common',
    listingDate: sessions[0], knownAt: sessions[0] }));
  const days = sessions.slice(0, -1);
  importDataset(db, { provider: 'eodhd', securities, prices: days.flatMap((date, index) => symbolList.map((symbol) => bar(symbol, date, index))),
    classifications: [
      { symbol: 'ABC', effectiveFrom: days[0], knownAt: days[0], system: 'nasdaq', industry: 'Provider group' },
      ...(sec ? [{ symbol: 'ABC', effectiveFrom: days[0], knownAt: days[0], system: 'sec-sic', industry: 'Dated SEC group' }] : []),
    ] });
  const saved = storeWorkspace(db, 'ranking-model', { name: 'Operator short lookback', definition: {
    method: 'weighted', priceMode: 'split', windows: [{ kind: 'sessions', length: 5, weight: 1 }],
  } }, 'operator');
  return { db, engine: createEngine(db), days, saved };
}

test('the production preset warms the default and Monitor recipes, all models, and optional dated SEC context', (t) => {
  const { db, engine, days, saved } = fixture(t);
  const input = { classification: 'nasdaq', reference: 'as-of' };
  const config = engine.context(input);
  const original = engine.snapshot(engine.context({ ...input, model: saved.id }), { velocity: true, persist: false, cache: false });
  const steps = [];
  const highScans = [];
  const tracking = { ...engine, snapshot(point, options) {
    if (point.includeAllTimeHigh) highScans.push([point.model.id, point.date]);
    return engine.snapshot(point, options);
  } };
  const report = precomputeProduction(db, tracking, config, { progress: (fraction) => steps.push(fraction) });
  assert.equal(report.standard.requested, days.length);
  assert.equal(report.monitor.requested, days.length);
  assert.deepEqual(report.monitor.breadthKeys, monitorMetrics);
  assert.equal(report.monitor.rankDates, 0);
  assert.equal(report.sec.requested, days.length);
  assert.equal(report.sec.rankDates, 0);
  assert.equal(steps.at(-1), 1);
  assert.deepEqual(steps, steps.toSorted((a, b) => a - b));
  assert.deepEqual(report.workspace.models.map(({ model, version }) => [model, version]),
    [...BUILTIN_MODELS, saved].map(({ id, version }) => [id, version]));
  for (const model of report.workspace.models) {
    assert.ok(engine.snapshotAvailable(engine.context({ ...input, model: model.model, modelVersion: model.version }), { velocity: true }));
  }
  assert.deepEqual(highScans, [[BUILTIN_MODELS[0].id, days.at(-1)]]);
  for (const model of BUILTIN_MODELS) {
    const base = engine.context({ ...input, model: model.id });
    const enriched = engine.context({ ...input, model: model.id, includeAllTimeHigh: true });
    assert.ok(engine.snapshotAvailable(enriched, { velocity: true }));
    assert.ok(engine.snapshotAvailable(enriched));
    const ranks = engine.snapshot(base, { velocity: true }).stocks.map(({ rsRank, velocity4w }) => [rsRank, velocity4w]);
    const enrichedRows = engine.snapshot(enriched, { velocity: true }).stocks;
    assert.deepEqual(enrichedRows.map(({ rsRank, velocity4w }) => [rsRank, velocity4w]), ranks);
    assert.equal(enrichedRows.find(({ symbol }) => symbol === 'ABC').distance_all_time_high, 0);
  }
  const reusedVelocity = engine.snapshot(engine.context({ ...input, model: saved.id }), { velocity: true, persist: false, cache: false });
  assert.deepEqual(reusedVelocity, original);
  const updated = engine.context({ ...input, breadthKeys: monitorMetrics });
  const monitor = readMaterializedHistory(db, engine, updated, { limit: 315 });
  assert.equal(monitor.complete, true);
  assert.equal(monitor.rows.at(-1).breadth.up_13pct_34d.numerator, 1);
  assert.equal(monitor.rows.at(-1).breadth.down_13pct_34d.numerator, 1);
  const historical = readMaterializedHistory(db, engine, engine.context({ ...input, classification: 'sec-sic' }), { limit: 315 });
  assert.ok(historical.rows.at(-1).groups.some(({ name }) => name === 'Dated SEC group'));
  const byRank = (context) => readRankArchive(db, engine, context, { limit: 315, symbol: 'ABC' });
  assert.deepEqual(byRank(updated).rows, byRank(config).rows);
});

test('weekly warmup preserves comparable demand baselines and current group signals', (t) => {
  const { db, engine, days, saved } = fixture(t);
  const more = expectedSessions(sessions.at(-1), '2024-06-05');
  importDataset(db, { provider: 'eodhd', prices: more.flatMap((date, index) => symbolList.map((symbol) => bar(symbol, date, index + days.length))) });
  const config = engine.context({ model: saved.id, classification: 'nasdaq' });
  const direct = engine.snapshot(config, { velocity: true, persist: false, cache: false });
  const before = direct.stocks.find(({ symbol }) => symbol === 'ABC');
  assert.equal(before.upVolumeShareChange4w, 0);
  assert.equal(direct.groups[0].medianRSChange4w, 0);
  precomputeWorkspace(db, engine, config, { reuseWeekly: true });
  const warmed = engine.snapshot(config, { velocity: true, persist: false, cache: false });
  assert.deepEqual(warmed, direct);
});

test('a normal next-session append reuses archived prefixes and weekly velocity inputs for saved and built-in models', (t) => {
  const { db, engine, days, saved } = fixture(t, { sec: false });
  const input = { classification: 'nasdaq', reference: 'as-of' };
  const first = precomputeProduction(db, engine, engine.context(input));
  assert.equal(first.sec, null);
  assert.equal(first.workspace.reusedSnapshots, 0);
  const current = sessions.at(-1);
  importDataset(db, { provider: 'eodhd', prices: symbolList.map((symbol) => bar(symbol, current, days.length)) });
  const config = engine.context(input);
  const rebuilt = [];
  const tracked = { ...engine, snapshot(point, options) {
    rebuilt.push({ date: point.date, model: point.model.id });
    return engine.snapshot(point, options);
  } };
  const second = precomputeProduction(db, tracked, config);
  assert.equal(second.date, current);
  assert.deepEqual(second.workspace.models.map(({ model }) => model), [...BUILTIN_MODELS.map(({ id }) => id), saved.id]);
  assert.equal(second.workspace.reusedSnapshots, (second.workspace.sessions - 1) * second.workspace.models.length);
  assert.ok(rebuilt.length > 0);
  assert.ok(rebuilt.every(({ date }) => date === current));
  const base = readMaterializedHistory(db, engine, config, { limit: 315 });
  const monitor = readMaterializedHistory(db, engine, engine.context({ ...input, breadthKeys: monitorMetrics }), { limit: 315 });
  const selection = readRankArchive(db, engine, config, { limit: 315, symbol: 'ABC' });
  assert.deepEqual(base.rows.map(({ date }) => date), sessions);
  assert.equal(base.reused, days.length);
  assert.equal(monitor.reused, days.length);
  assert.equal(selection.reused, days.length);
  assert.equal(second.monitor.rankDates, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM rank_archive_dates WHERE data_version=?').get(config.dataVersion).count,
    second.workspace.models.length);
});

test('an append moves only the former live session to the dated reference archive while preserving older prefixes', (t) => {
  const { db, engine, days } = fixture(t, { sec: false });
  const current = sessions.at(-1);
  const former = days.at(-1);
  const input = { classification: 'nasdaq', reference: 'latest', observedReferenceDate: current };
  importDataset(db, { provider: 'nasdaq', classifications: [
    { securityId: 'eodhd:ABC', effectiveFrom: current, knownAt: current, system: 'nasdaq', industry: 'Later observation' },
  ] });
  let config = engine.context(input);
  precomputeProduction(db, engine, config);
  assert.ok(readMaterializedHistory(db, engine, config, { limit: 315 }).rows.at(-1).groups.some(({ name }) => name === 'Later observation'));
  importDataset(db, { provider: 'eodhd', prices: symbolList.map((symbol) => bar(symbol, current, days.length)) });
  config = engine.context(input);
  const rebuilt = [];
  const tracked = { ...engine, snapshot(point, options) {
    rebuilt.push(point.date);
    return engine.snapshot(point, options);
  } };
  const result = precomputeProduction(db, tracked, config);
  const materialized = readMaterializedHistory(db, engine, config, { limit: 315 });
  assert.equal(materialized.reused, days.length - 1);
  assert.equal(result.monitor.rankDates, 0);
  assert.ok(rebuilt.includes(former));
  assert.ok(rebuilt.every((date) => date === current || date === former));
  assert.ok(materialized.rows.at(-2).groups.some(({ name }) => name === 'Provider group'));
  assert.ok(materialized.rows.at(-1).groups.some(({ name }) => name === 'Later observation'));
});

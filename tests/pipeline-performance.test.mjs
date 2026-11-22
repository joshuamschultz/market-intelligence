import assert from 'node:assert/strict';
import test from 'node:test';
import { preparationDependencies, preparationSeedKey, prepareBatchedSnapshots } from '../backend/batch-preparation.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { createMaterializedHistoryWriter, materializeHistory, readMaterializedHistory } from '../backend/materialization.mjs';
import { compactWeeklySnapshot, readPreparedRanks, verifyPreparedRankCoverage } from '../backend/preparation.mjs';
import { readPreparedSnapshot, readPreparedSnapshotRankWitnesses } from '../backend/prepared-snapshots.mjs';
import { topDecileIds } from '../backend/ranking.mjs';

const Dates = expectedSessions('2023-12-12', '2025-04-25');
const symbols = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'SPY'];
const securities = symbols.map((symbol, i) => ({ id: `s:${symbol}`, symbol, exchange: i % 2 ? 'NASDAQ' : 'NYSE',
  type: symbol === 'SPY' ? 'etf' : 'common', listingDate: Dates[0], knownAt: Dates[0] }));
const bar = (security, date, close, index) => ({ securityId: security.id, date, open: close - 0.125, high: close + 0.25, low: close - 0.25,
  close, adjustedClose: close, volume: 1_000 + index * 16, knownAt: date });
const quote = (security, position, date, index) => bar(security, date, 18 + position + index / (64 - position * 4), index);

function fixture(t) {
  const db = openDatabase(':memory:');
  const control = openDatabase(':memory:');
  t.after(() => { db.close(); control.close(); });
  const prices = securities.flatMap((security, position) => Dates.slice(0, -1).map((date, index) => quote(security, position, date, index)));
  const classifications = securities.map(({ id }, index) => ({ securityId: id, system: 'sec-sic', sector: 'Sample sectors',
    industry: index < 4 ? 'Manufacturers' : 'Retailers', effectiveFrom: Dates[40], knownAt: Dates[41] }));
  importDataset(db, { provider: 'fixture', securities, prices, classifications });
  importDataset(control, { provider: 'fixture', securities, prices, classifications });
  return { db, control, engine: createEngine(db), canonical: createEngine(control) };
}

function assertStructure(actual, expected, path = '') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path);
    assert.ok(Math.abs(actual - expected) <= 1e-9 + Math.abs(expected) * 1e-12, `${path} ${actual} ≉ ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', path);
    assert.deepEqual(path.endsWith('.stocks') || path.includes('.stocks.') ? Object.keys(actual) : Object.keys(actual).sort(),
      path.endsWith('.stocks') || path.includes('.stocks.') ? Object.keys(expected) : Object.keys(expected).sort(), path);
    for (const field of Object.keys(expected)) assertStructure(actual[field], expected[field], `${path}.${field}`);
  } else assert.equal(actual, expected, path);
}

test('batch records preserve canonical slot order, ranks, weekly velocity and thin leadership', (t) => {
  const { db, control, engine, canonical } = fixture(t);
  const dates = Dates.slice(-7, -1);
  const input = [
    { universe: 'us-all', benchmark: 'SPY', classification: 'sec-sic' },
    { universe: 'nyse', benchmark: 'SPY', classification: 'sec-sic', model: 'short-momentum' },
    { universe: 'us-all', benchmark: 'SPY', breadthKeys: ['up_13pct_34d', 'down_13pct_34d'] },
  ];
  const plans = input.map((point, index) => ({ config: engine.context(point), rank: index !== 2 }));
  const report = prepareBatchedSnapshots(db, engine, plans, { dates, tileSize: 6 });
  assert.equal(report.commits, dates.length);
  assert.equal(report.written.base, dates.length * input.length);
  assert.equal(report.written.velocity, dates.length * 2);
  assert.equal(report.written.rank, dates.length * 2);
  assert.equal(report.written.history, dates.length * input.length);
  for (const [index, args] of input.entries()) {
    const recipe = plans[index].config;
    const legacy = canonical.context(args);
    const span = { from: dates[0], to: dates.at(-1), limit: dates.length };
    materializeHistory(control, canonical, legacy, span);
    for (const date of dates) {
      const config = { ...recipe, date, requestedDate: date };
      const expected = { ...legacy, date, requestedDate: date };
      for (const velocity of [false, ...(plans[index].rank ? [true] : [])]) {
        const direct = canonical.snapshot(expected, { velocity, persist: false, cache: false });
        assertStructure(readPreparedSnapshot(db, engine, config, { velocity }), JSON.parse(JSON.stringify(direct)), `${index}.${date}.${velocity}`);
      }
    }
    const stripTime = ({ materializedAt, ...row }) => row;
    const current = readMaterializedHistory(db, engine, recipe, span);
    assert.equal(current.complete, true);
    assertStructure(current.rows.map(stripTime), readMaterializedHistory(control, canonical, legacy, span).rows.map(stripTime));
    if (plans[index].rank) assert.equal(readPreparedRanks(db, recipe, dates).observed.size, dates.length);
  }
  const repeated = prepareBatchedSnapshots(db, engine, plans, { dates });
  assert.equal(repeated.commits, 0);
  assert.equal(repeated.producedSessions, 0);
  assert.deepEqual(repeated.reused, report.written);
});

test('interrupted date rolls back all context products and a retry reuses only committed dates', (t) => {
  const { db, engine } = fixture(t);
  const configs = [engine.context({ universe: 'us-all' }), engine.context({ universe: 'nyse' })];
  const dates = Dates.slice(-4, -1);
  createMaterializedHistoryWriter(db, engine, configs[0], []);
  db.exec(`CREATE TRIGGER block_last BEFORE INSERT ON market_history WHEN NEW.date='${dates[1]}'
    BEGIN SELECT RAISE(ABORT, 'fixture interrupted'); END`);
  assert.throws(() => prepareBatchedSnapshots(db, engine, configs, { dates }), /fixture interrupted/);
  assert.equal(db.isTransaction, false);
  for (const config of configs) {
    for (const [index, date] of dates.entries()) assert.equal(!!readPreparedSnapshot(db, engine, { ...config, date }), index === 0);
    assert.deepEqual([...readPreparedRanks(db, config, dates).observed], [dates[0]]);
  }
  db.exec('DROP TRIGGER block_last');
  const finished = prepareBatchedSnapshots(db, engine, configs, { dates });
  assert.equal(finished.commits, 2);
  assert.equal(finished.reused.base, 2);
  assert.equal(finished.written.base, 4);
});

test('append reuses prepared lineage and a source correction replaces only the affected suffix', (t) => {
  const { db, engine } = fixture(t);
  const dates = Dates.slice(-7, -1);
  const recipe = { universe: 'us-all', reference: 'as-of' };
  const old = engine.context(recipe);
  prepareBatchedSnapshots(db, engine, [old], { dates });
  const appended = Dates.at(-1);
  importDataset(db, { provider: 'fixture', prices: securities.map((security, i) => quote(security, i, appended, Dates.length - 1)) });
  const next = engine.context(recipe);
  const append = prepareBatchedSnapshots(db, engine, [next], { dates: [...dates, appended] });
  assert.deepEqual(append.written, { base: 1, velocity: 1, rank: 1, history: 1 });
  assert.equal(append.reused.base, dates.length);
  const changed = dates.at(-2);
  importDataset(db, { provider: 'fixture', prices: [bar(securities[0], changed, 40, 350)] });
  const corrected = engine.context(recipe);
  const repair = prepareBatchedSnapshots(db, engine, [corrected], { dates: [...dates, appended] });
  assert.deepEqual(repair.written, { base: 3, velocity: 3, rank: 3, history: 3 });
  const view = readPreparedSnapshot(db, engine, { ...corrected, date: changed });
  assert.equal(view.stocks.find(({ symbol }) => symbol === 'AAA').close, 40);
  assert.equal(readPreparedSnapshot(db, engine, { ...old, date: changed }).stocks.find(({ symbol }) => symbol === 'AAA').close < 40, true);
});

test('two models and taxonomies preserve fields across standard, Monitor, and separate velocity layers', (t) => {
  const { db, engine, canonical } = fixture(t);
  const dates = Dates.slice(-3, -1);
  const inputs = ['composite', 'short-momentum'].flatMap((model) => ['provider', 'sec-sic'].flatMap((classification) =>
    [false, true].map((monitor) => ({ universe: 'us-all', model, classification,
      ...(monitor && { breadthKeys: ['up_13pct_34d', 'down_13pct_34d'] }) }))));
  const configs = inputs.map((input) => engine.context(input));
  const report = prepareBatchedSnapshots(db, engine, configs, { dates });
  assert.equal(report.velocityLayersWritten, 4 * dates.length);
  assert.equal(report.velocityLayersReused, 4 * dates.length);
  for (const [index, input] of inputs.entries()) {
    const date = dates[0];
    const config = { ...configs[index], date, requestedDate: date };
    const direct = canonical.context({ ...input, date });
    for (const velocity of [false, true]) {
      const expected = canonical.snapshot(direct, { velocity, persist: false, cache: false });
      const observed = readPreparedSnapshot(db, engine, config, { velocity });
      assertStructure(observed, JSON.parse(JSON.stringify(expected)), `${index}.${velocity}`);
    }
  }
});

test('sealed cross-window dependency inputs remove redundant calculation and fail closed when missing', (t) => {
  const { db, engine, canonical } = fixture(t);
  const dates = Dates.slice(-4, -1);
  const config = engine.context({ universe: 'us-all', classification: 'sec-sic' });
  const inputs = preparationDependencies([config], dates);
  assert.ok(inputs.some(({ kind }) => kind === 'leaders') && inputs.some(({ kind }) => kind === 'weekly'));
  assert.ok(inputs.every(({ date }) => !dates.includes(date)));
  assert.throws(() => prepareBatchedSnapshots(db, engine, [config], { dates, requireDependencySeeds: true }), /Missing preparation .* seed/);
  assert.equal(readPreparedSnapshot(db, engine, { ...config, date: dates[0] }), null);
  const seeds = new Map(inputs.map(({ config, kind, date }) => {
    const source = canonical.snapshot({ ...config, date, requestedDate: date }, { persist: false, cache: false });
    return [preparationSeedKey(engine, config, kind, date), kind === 'weekly' ? compactWeeklySnapshot(source) : topDecileIds(source)];
  }));
  const report = prepareBatchedSnapshots(db, engine, [config], { dates, requireDependencySeeds: true,
    dependencyProvider: ({ config, kind, date }) => seeds.get(preparationSeedKey(engine, config, kind, date)) });
  assert.equal(report.producedSessions, dates.length);
  assert.equal(report.seededLeaderDays, 1);
  assert.ok(report.seededWeeks >= 12);
  const date = dates[0];
  const point = { ...config, date, requestedDate: date };
  const expected = canonical.snapshot(point, { persist: false, cache: false, velocity: true });
  assertStructure(readPreparedSnapshot(db, engine, point, { velocity: true }), JSON.parse(JSON.stringify(expected)));
});

test('reopened rank verification rejects a missing traded block despite intact rank-date markers', (t) => {
  const { db, engine } = fixture(t);
  const dates = Dates.slice(-3, -1);
  const config = engine.context({ universe: 'us-all' });
  prepareBatchedSnapshots(db, engine, [config], { dates });
  const witnesses = readPreparedSnapshotRankWitnesses(db, engine, config, dates);
  assert.equal(witnesses.size, dates.length);
  const verified = verifyPreparedRankCoverage(db, config, dates, witnesses);
  assert.equal(verified.dates, dates.length);
  assert.ok(verified.tradedIds > 0 && verified.blocks > 0);
  const block = db.prepare('SELECT recipe,data_version,date,bucket FROM prepared_rank_blocks WHERE date=? LIMIT 1').get(dates[0]);
  db.prepare('DELETE FROM prepared_rank_blocks WHERE recipe=? AND data_version=? AND date=? AND bucket=?')
    .run(block.recipe, block.data_version, block.date, block.bucket);
  assert.equal(readPreparedRanks(db, config, dates).observed.size, dates.length);
  assert.throws(() => verifyPreparedRankCoverage(db, config, dates, witnesses), /saved traded-stock roster/);
});

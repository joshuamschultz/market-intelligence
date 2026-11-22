import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { createMaterializedHistoryWriter, materializeHistory, readMaterializedHistory } from '../backend/materialization.mjs';
import { encodeStoredJson } from '../backend/storage-codec.mjs';

const dates = ['2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09'];
const [first, second, third, last] = dates;
const symbols = ['ABC', 'DEF', 'SPY'];
const makeBar = (symbol, date, close, knownAt = date) => ({
  symbol, date, close, open: close, high: close, low: close, adjustedClose: close, volume: 100, knownAt,
});

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const securities = symbols.map((symbol, index) => ({
    symbol, name: symbol, exchange: index === 1 ? 'NASDAQ' : 'NYSE', type: index === 2 ? 'etf' : 'common',
    listingDate: '2023-01-01', knownAt: '2023-01-01',
  }));
  const closes = [[100, 100, 110, 112], [105, 100, 90, 91], [200, 210, 214, 220]];
  const prices = symbols.flatMap((symbol, index) => dates.map((date, day) => makeBar(symbol, date, closes[index][day])));
  importDataset(db, {
    provider: 'fixture', scope: 'full', expected: 2, securities, prices,
    classifications: [
      { symbol: 'ABC', effectiveFrom: first, knownAt: first, sector: 'Technology', industry: 'Software' },
      { symbol: 'DEF', effectiveFrom: first, knownAt: third, sector: 'Industrials', industry: 'Machinery' },
    ],
  });
  return { db, engine: createEngine(db) };
}

test('compact materialization matches canonical breadth and group metrics without storing constituent snapshots', (t) => {
  const { db, engine } = fixture(t);
  const config = engine.context({ basis: 'known' });
  const before = readMaterializedHistory(db, engine, config);
  assert.deepEqual(before.missingDates, dates);
  assert.equal(before.complete, false);
  assert.deepEqual(before.rows, []);
  const results = materializeHistory(db, engine, config);
  assert.equal(results.written, 4);
  assert.equal(results.skipped, 0);
  const persisted = readMaterializedHistory(db, engine, config);
  assert.equal(persisted.complete, true);
  assert.deepEqual(persisted.rows.map((row) => row.date), dates);
  const row = persisted.rows[2];
  assert.deepEqual(row.breadth.up_4pct, { numerator: 1, denominator: 2, value: 50 });
  assert.deepEqual(row.breadth.down_4pct, { numerator: 1, denominator: 2, value: 50 });
  const [canonical] = engine.history(config, { to: third, limit: 1 });
  assert.deepEqual(row.breadth, canonical.breadth);
  assert.deepEqual(row.coverage, canonical.coverage);
  assert.deepEqual(row.aggregates, canonical.aggregates);
  assert.equal(row.groups.find((group) => group.name === 'Software').count, 1);
  assert.equal(Object.hasOwn(row, 'stocks'), false);
  assert.ok(row.groups.every((group) => !Object.hasOwn(group, 'memberIds')));
  assert.equal(db.prepare('SELECT count(*) AS count FROM snapshots').get().count, 0);
  const raw = db.prepare('SELECT value FROM market_history WHERE date=?').get(third).value;
  assert.doesNotMatch(raw, /"(?:stocks|memberIds)":/);
  assert.equal(Object.hasOwn(row, 'topDecileIds'), false);
});

test('matching thin group lists share a block and date publication rolls back if the block cannot be saved', (t) => {
  const { db, engine } = fixture(t);
  const standard = engine.context({ date: third });
  const monitor = engine.context({ date: third, breadthKeys: ['up_13pct_34d'] });
  const groups = Array.from({ length: 45 }, (_, index) => ({ id: `g:${index}`, count: index + 1,
    level: 'industry', name: `Group ${index}`, medianRS: index % 2 ? 72 : null, memberIds: ['excluded-private-id'] }));
  const snapshot = (config) => ({ ...engine.snapshot(config, { persist: false }), groups });
  const first = createMaterializedHistoryWriter(db, engine, standard, [third], { shareGroups: true });
  const second = createMaterializedHistoryWriter(db, engine, monitor, [third], { shareGroups: true });
  db.exec('BEGIN IMMEDIATE');
  db.exec(`CREATE TRIGGER interrupt_shared_group BEFORE INSERT ON market_history_group_blocks
    BEGIN SELECT RAISE(ABORT, 'blocked group list'); END`);
  assert.throws(() => first.write(snapshot(standard), null, []), /blocked group list/);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare('SELECT count(*) AS count FROM market_history').get().count, 0);
  db.exec('DROP TRIGGER interrupt_shared_group');
  assert.equal(first.write(snapshot(standard), null, []), true);
  assert.equal(second.write(snapshot(monitor), null, []), true);
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) AS count FROM market_history_group_blocks').get().count, 1);
  const a = readMaterializedHistory(db, engine, standard, { limit: 1 }).rows[0];
  const b = readMaterializedHistory(db, engine, monitor, { limit: 1 }).rows[0];
  assert.equal(JSON.stringify(a.groups), JSON.stringify(b.groups));
  assert.deepEqual(Object.keys(a.groups[0]), ['id', 'level', 'name', 'count', 'medianRS']);
  const { materializedAt, ...legacy } = a;
  db.prepare('UPDATE market_history SET value=?').run(encodeStoredJson(legacy, 'gzip'));
  assert.deepEqual(readMaterializedHistory(db, engine, standard, { limit: 1 }).rows[0], a);
});

test('thin sessions retain genuine Composite and frozen prior-leader evidence without publishing constituent IDs', (t) => {
  const { db, engine } = fixture(t);
  importDataset(db, {
    provider: 'fixture', securities: [
      { symbol: 'IXIC', type: 'index', exchange: 'INDX', listingDate: first, knownAt: first },
      { symbol: 'QQQ', type: 'etf', exchange: 'NYSE ARCA', listingDate: first, knownAt: first },
    ],
    prices: dates.flatMap((date, index) => [
      { ...makeBar('IXIC', date, 100 + index, date === last ? last : third), volume: date === third ? 9_000_000_000 : 0 },
      makeBar('QQQ', date, 200 - index),
    ]),
  });
  const model = storeWorkspace(db, 'ranking-model', { name: 'One-session leader', definition: { method: 'weighted', windows: [{ length: 1, weight: 1 }] } });
  const config = engine.context({ model: model.id });
  materializeHistory(db, engine, config, { to: second });
  materializeHistory(db, engine, config, { from: third, to: third });
  const latest = readMaterializedHistory(db, engine, config, { to: third, limit: 1 }).rows[0];
  assert.deepEqual([latest.aggregates.nasdaqBenchmark, latest.aggregates.nasdaqBenchmarkProxy], ['IXIC', false]);
  assert.ok(Math.abs(latest.aggregates.nasdaqReturn - (102 / 101 - 1)) < 1e-10);
  assert.ok(Math.abs(latest.aggregates.nasdaqMedianReturn + 0.1) < 1e-10);
  assert.ok(Math.abs(latest.aggregates.leaderReturn - 0.1) < 1e-10);
  assert.deepEqual([latest.aggregates.previousLeaderDate, latest.aggregates.leaderReturnObservations, latest.aggregates.leadershipPersistence],
    [second, 1, 1]);
  const known = engine.snapshot(engine.context({ basis: 'known', model: model.id, date: second }), { persist: false });
  assert.deepEqual([known.aggregates.nasdaqBenchmark, known.aggregates.nasdaqBenchmarkProxy], ['QQQ', true]);
  const broad = engine.snapshot(engine.context({ universe: 'us-all', benchmark: 'IXIC', date: third }), { persist: false });
  assert.ok(Math.abs(broad.aggregates.benchmarkReturn - (102 / 101 - 1)) < 1e-10);
  assert.ok(broad.stocks.every(({ symbol }) => symbol !== 'IXIC'));
  assert.ok(broad.aggregates.upDollar < 100_000);
  assert.equal(Object.hasOwn(latest, 'topDecileIds'), false);
});

test('materialized ranges are idempotent, bounded and reusable across cadences', (t) => {
  const { db, engine } = fixture(t);
  const config = engine.context();
  let calls = 0;
  const tracking = { ...engine, snapshot(config, options) {
    assert.equal(config.currentVersion, false);
    assert.deepEqual(options, { persist: false, cache: false });
    calls++;
    return engine.snapshot(config, options);
  } };
  materializeHistory(db, tracking, config);
  const weekly = readMaterializedHistory(db, tracking, config, { cadence: 'weekly' });
  assert.deepEqual(weekly.rows.map((row) => row.date), [second, last]);
  assert.equal(weekly.requested, 2);
  const bounded = readMaterializedHistory(db, tracking, config, { from: second, to: third, limit: 1 });
  assert.deepEqual(bounded.rows.map((row) => row.date), [third]);
  const namedMetrics = engine.context({ breadthKeys: ['above_50d', 'up_4pct'] });
  assert.equal(readMaterializedHistory(db, tracking, namedMetrics).complete, true);
  assert.equal(materializeHistory(db, tracking, config).skipped, 4);
  assert.equal(calls, 4);
  assert.equal(materializeHistory(db, tracking, config, { cadence: 'weekly', force: true }).written, 2);
  assert.equal(calls, 6);
  assert.throws(() => readMaterializedHistory(db, tracking, config, { limit: 7561 }), /History limit/);
  assert.throws(() => readMaterializedHistory(db, tracking, config, { from: last, to: first }), /History start/);
});

test('cancellation leaves atomic rows that a retry resumes with monotonic progress', (t) => {
  const { db, engine } = fixture(t);
  const config = engine.context();
  const controller = new AbortController();
  const firstProgress = [];
  assert.throws(() => materializeHistory(db, engine, config, {
    signal: controller.signal,
    onProgress: (progress) => {
      firstProgress.push(progress.percent);
      if (progress.completed === 2) controller.abort();
    },
  }), { name: 'AbortError' });
  assert.deepEqual(firstProgress, [0, 25, 50]);
  const partial = readMaterializedHistory(db, engine, config);
  assert.deepEqual(partial.rows.map((row) => row.date), [first, second]);
  assert.deepEqual(partial.missingDates, [third, last]);
  const progress = [];
  const resumed = materializeHistory(db, engine, config, { onProgress: (event) => progress.push(event) });
  assert.equal(resumed.skipped, 2);
  assert.equal(resumed.written, 2);
  assert.deepEqual(progress.map((event) => event.percent), [0, 25, 50, 75, 100]);
  assert.equal(readMaterializedHistory(db, engine, config).complete, true);
});

test('warehouse versions and historical availability bases isolate restatements and classifications', (t) => {
  const { db, engine } = fixture(t);
  const v1 = engine.context({ basis: 'known' });
  materializeHistory(db, engine, v1);
  importDataset(db, {
    provider: 'fixture', prices: [makeBar('ABC', second, 125, '2024-01-10')],
  });
  const known = engine.context({ basis: 'known' });
  const reconstructed = engine.context({ basis: 'reconstructed' });
  assert.equal(known.dataVersion, 2);
  assert.deepEqual(readMaterializedHistory(db, engine, known).missingDates, dates.slice(1));
  materializeHistory(db, engine, known);
  materializeHistory(db, engine, reconstructed);
  const read = (context) => readMaterializedHistory(db, engine, context).rows;
  assert.deepEqual(read(known).map((row) => row.breadth.up_4pct), read(v1).map((row) => row.breadth.up_4pct));
  assert.equal(read(known)[2].breadth.up_4pct.value, 50);
  assert.equal(read(reconstructed)[2].breadth.up_4pct.value, 0);
  assert.equal(read(known)[0].groups.some((group) => group.name === 'Machinery'), false);
  assert.equal(read(known)[2].groups.some((group) => group.name === 'Machinery'), true);
  assert.ok(read(v1).every((row) => row.dataVersion === 1));
  assert.equal(read(known)[0].sourceDataVersion, 1);
  assert.equal(read(known)[0].requestedDataVersion, 2);
  assert.ok(read(known).slice(1).every((row) => row.dataVersion === 2));
});

test('changed theme recipes invalidate the compact series and a run pins its original recipes', (t) => {
  const { db, engine } = fixture(t);
  const config = engine.context({ basis: 'known' });
  const before = materializeHistory(db, engine, config, { onProgress({ completed }) {
    if (completed === 1) storeWorkspace(db, 'theme', { name: 'Computing', definition: {
      members: [{ securityId: 'fixture:ABC', effectiveFrom: first, knownAt: first }],
    } }, 'computing');
  } });
  const oldRows = readMaterializedHistory(db, engine, { ...config, themes: [] });
  assert.equal(oldRows.definitionKey, before.definitionKey);
  assert.ok(oldRows.rows.every((row) => row.groups.every((group) => group.level !== 'theme')));
  const updated = engine.context({ basis: 'known' });
  assert.deepEqual(readMaterializedHistory(db, engine, updated).missingDates, dates);
  const changed = materializeHistory(db, engine, updated);
  assert.notEqual(changed.definitionKey, before.definitionKey);
  assert.ok(readMaterializedHistory(db, engine, updated).rows.every((row) => row.groups.some((group) => group.name === 'Computing')));
});

test('the CLI can inspect an empty warehouse and reports invalid work without a stack trace', () => {
  const options = { encoding: 'utf8' };
  const clean = spawnSync(process.execPath, ['scripts/materialize.mjs', 'status', '--db', ':memory:'], options);
  assert.equal(clean.status, 0, clean.stderr);
  const status = JSON.parse(clean.stdout);
  assert.equal(status.stored, 0);
  assert.equal(status.requested, 0);
  const invalid = spawnSync(process.execPath, ['scripts/materialize.mjs', 'write', '--basis', 'unknown', '--db', ':memory:'], options);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Basis must be known or reconstructed/);
  assert.doesNotMatch(invalid.stderr, /at file:/);
});

test('combined archive writes each session once and resumes independently across breadth and ranks', (t) => {
  const { db, engine } = fixture(t);
  let calls = 0;
  const tracking = { ...engine, snapshot(config, options) {
    calls++;
    return engine.snapshot(config, options);
  } };
  const config = engine.context();
  const initial = materializeHistory(db, tracking, config, { withRanks: true });
  assert.equal(initial.written, 4);
  assert.equal(initial.rankDates, 4);
  assert.equal(initial.rankRows, 8);
  assert.equal(calls, 4);
  const resumed = materializeHistory(db, tracking, config, { withRanks: true });
  assert.equal(resumed.skipped, 4);
  assert.equal(resumed.rankDates, 0);
  assert.equal(calls, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM stock_rank_history').get().n, 8);
});

test('append-only warehouse revisions reuse immutable history and ranks without rewriting the prefix', async (t) => {
  const { db, engine } = fixture(t);
  const { readRankArchive } = await import('../backend/rank-archive.mjs');
  const v1 = engine.context();
  materializeHistory(db, engine, v1, { withRanks: true });
  const append = '2024-01-10';
  importDataset(db, { provider: 'fixture', prices: [makeBar('ABC', append, 121, append), makeBar('DEF', append, 89, append), makeBar('SPY', append, 225, append)] });
  const v2 = engine.context();
  assert.deepEqual(readMaterializedHistory(db, engine, v2).missingDates, [append]);
  assert.equal(readMaterializedHistory(db, engine, v2).reused, 4);
  assert.equal(readRankArchive(db, engine, v2, { symbol: 'ABC' }).reused, 4);
  const built = materializeHistory(db, engine, v2, { withRanks: true });
  assert.deepEqual([built.written, built.rankDates, built.rankRows], [1, 1, 2]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM stock_rank_history').get().n, 10);
  assert.equal(readMaterializedHistory(db, engine, v1).rows.length, 4);
  const later = '2024-01-11';
  importDataset(db, { provider: 'fixture', prices: [makeBar('ABC', later, 123, later), makeBar('DEF', later, 91, later)] });
  const v3 = engine.context();
  db.prepare("UPDATE ingestion_runs SET detail='{}' WHERE version=3").run();
  assert.deepEqual(readMaterializedHistory(db, engine, v3).missingDates, [...dates, append, later]);
});

test('the last date observed-reference archive never becomes an as-of historical record after append', (t) => {
  const { db, engine } = fixture(t);
  const v1 = engine.context({ reference: 'latest', observedReferenceDate: '2024-01-11' });
  materializeHistory(db, engine, v1, { withRanks: true });
  const currentOnlyFacts = '2024-01-10';
  importDataset(db, { provider: 'fixture', classifications: [{ symbol: 'ABC', sector: 'Technology', industry: 'Later filing',
    effectiveFrom: currentOnlyFacts, knownAt: currentOnlyFacts }] });
  const append = '2024-01-10';
  importDataset(db, { provider: 'fixture', prices: [makeBar('ABC', append, 121, append), makeBar('DEF', append, 89, append), makeBar('SPY', append, 225, append)] });
  const v3 = engine.context({ reference: 'latest', observedReferenceDate: '2024-01-11' });
  const status = readMaterializedHistory(db, engine, v3);
  assert.deepEqual(status.missingDates, [last, append]);
  assert.equal(status.reused, 3);
  materializeHistory(db, engine, v3);
  const rows = readMaterializedHistory(db, engine, v3).rows;
  assert.equal(rows.at(-2).groups.some(({ name }) => name === 'Later filing'), false);
  assert.equal(rows.at(-1).groups.some(({ name }) => name === 'Later filing'), true);
});

test('cached batch and uncached snapshots agree across a split, cash dividend, and later filing', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const price = (date, close, adjustedClose, knownAt) => ({
    symbol: 'FIX', date, close, open: close, high: close * 1.01, low: close * 0.99, adjustedClose, volume: 200, knownAt,
  });
  importDataset(db, { provider: 'fixture', scope: 'full', expected: 1, securities: [{
    symbol: 'FIX', type: 'common', exchange: 'NYSE', listingDate: '2020-01-02', knownAt: '2020-01-02',
  }], prices: [price(dates[0], 100, 100, dates[0]), price(dates[1], 110, 110, dates[1]),
    price(dates[2], 52, 52, dates[2]), price(dates[3], 54, 54, dates[3])],
    corporateActions: [{ symbol: 'FIX', date: dates[2], type: 'split', factor: 2, knownAt: dates[1] },
      { symbol: 'FIX', date: dates[3], type: 'dividend', amount: 2, knownAt: dates[2] }],
    classifications: [{ symbol: 'FIX', effectiveFrom: dates[2], knownAt: dates[3], industry: 'New classification' }],
    fundamentals: [{ symbol: 'FIX', effectiveDate: dates[0], knownAt: dates[2], float: 10_000 }],
  });
  const engine = createEngine(db);
  const current = engine.context();
  const cached = engine.historyBatch(current, dates);
  for (const date of dates) {
    const compute = (config) => engine.snapshot({ ...config, date, requestedDate: date }, { persist: false, cache: false });
    const plain = compute({ ...current, currentVersion: false });
    const derived = compute(cached);
    assert.deepEqual(derived.breadth, plain.breadth);
    assert.deepEqual(derived.groups, plain.groups);
    assert.deepEqual(derived.aggregates, plain.aggregates);
    assert.deepEqual(derived.stocks, plain.stocks);
  }
});

test('price-only rank archives share history across classifiers and chart settings without crossing ranking contexts', async (t) => {
  const { db, engine } = fixture(t);
  const { readRankArchive, writeRankArchive } = await import('../backend/rank-archive.mjs');
  const model = storeWorkspace(db, 'ranking-model', { name: 'Daily return', definition: {
    method: 'weighted', priceMode: 'split', windows: [{ kind: 'sessions', length: 1, weight: 1 }],
  } });
  const base = engine.context({ model: model.id, classification: 'sec-sic' });
  const otherView = engine.context({ model: model.id, classification: 'nasdaq', breadthKeys: ['up_13pct_34d'],
    averages: [250], volumeWindows: [84], threshold: 0.9, themes: [{ id: 'theme', version: 1, definition: { members: [] } }] });
  const rankings = (config) => engine.snapshot(config, { persist: false }).stocks
    .map(({ symbol, rsRank, rsPercentile, rsScore }) => ({ symbol, rsRank, rsPercentile, rsScore }));
  assert.deepEqual(rankings(otherView), rankings(base));
  assert.ok(rankings(base).some((row) => row.rsRank === 1));

  writeRankArchive(db, engine, base);
  const read = (config) => readRankArchive(db, engine, config, { symbol: 'ABC' });
  assert.deepEqual(read(otherView).rows, read(base).rows);
  assert.equal(writeRankArchive(db, engine, otherView).written, 0);

  const latest = engine.context({ model: model.id, classification: 'nasdaq', reference: 'latest', observedReferenceDate: '2024-01-10' });
  assert.deepEqual([...read(latest).observed], dates.slice(0, -1));
  assert.equal(writeRankArchive(db, engine, latest).written, 1);
  const newClock = engine.context({ model: model.id, reference: 'latest', observedReferenceDate: '2024-01-11' });
  assert.deepEqual([...read(newClock).observed], dates.slice(0, -1));
  for (const changes of [{ basis: 'known' }, { benchmark: 'QQQ' }, { model: 'short-momentum' }, { universe: 'us-extended' }]) {
    const separate = engine.context({ model: model.id, ...changes });
    assert.equal(read(separate).observed.size, 0);
  }
  const revised = storeWorkspace(db, 'ranking-model', { name: model.name, definition: model.definition }, model.id);
  assert.equal(read(engine.context({ model: model.id, modelVersion: revised.version })).observed.size, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM stock_rank_history').get().n, 10);
});

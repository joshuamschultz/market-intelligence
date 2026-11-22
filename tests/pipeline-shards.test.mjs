import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBatchedSnapshots, preparationDependencies, preparationSeedKey } from '../backend/batch-preparation.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { readMaterializedHistory } from '../backend/materialization.mjs';
import { compactWeeklySnapshot, readPreparedRanks } from '../backend/preparation.mjs';
import { readPreparedSnapshot } from '../backend/prepared-snapshots.mjs';
import { mergePreparationShard, preparationShardInventory, preparationSourcePin, prepareParallelSnapshots, checksumPreparationShard } from '../backend/pipeline-shards.mjs';
import { runPreparationShard } from '../backend/pipeline-shard-worker.mjs';
import { topDecileIds } from '../backend/ranking.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'market-shard-test-'));
  const sourcePath = join(directory, 'source.sqlite');
  const source = openDatabase(sourcePath);
  const dates = expectedSessions('2024-01-02', '2026-11-20').slice(-330);
  const symbols = ['AAA', 'BBB', 'CCC', 'SPY'];
  importDataset(source, {
    provider: 'shard-fixture',
    securities: symbols.map((symbol, index) => ({ symbol, name: symbol, exchange: index ? 'NASDAQ' : 'NYSE',
      type: index === 3 ? 'etf' : 'common', listingDate: dates[0], knownAt: dates[0] })),
    prices: symbols.flatMap((symbol, index) => dates.map((date, session) => {
      const close = (10 + index + 0.07 * Math.sin(session / (index + 1))) * (1 + session / (400 + index * 31));
      return { symbol, date, knownAt: date, open: close, high: close * 1.02, low: close * 0.98, close,
        adjustedClose: close, volume: 20_000 + (session * 123 + index * 812) % 97_000 };
    })),
    classifications: ['provider', 'sec-sic'].flatMap((system) => symbols.map((symbol, index) => ({
      symbol, system, sector: system, industry: `Industry ${index % 2}`, effectiveFrom: dates[0], knownAt: dates[0],
    }))),
  });
  const engine = createEngine(source);
  const configs = [
    { classification: 'provider' },
    { classification: 'sec-sic' },
    { classification: 'provider', breadthKeys: ['down_13pct_34d', 'up_13pct_34d'] },
  ].map((input, i) => ({ config: engine.context({ ...input, universe: 'us-core', benchmark: 'SPY' }), rank: i !== 2 }));
  const databases = [source];
  const output = (name) => {
    const db = openDatabase(join(directory, name));
    databases.push(db);
    return db;
  };
  t.after(() => {
    for (const db of databases.reverse()) if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, sourcePath, source, engine, configurations: configs, dates: dates.slice(-4), output };
}

test('parallel whole-date preparation survives reopen and agrees field-for-field with the serial writer', async (t) => {
  const { directory, sourcePath, source, engine, configurations, dates, output } = fixture(t);
  const serial = output('serial.sqlite');
  let parallel = output('parallel.sqlite');
  const events = [];
  const seeds = new Map();
  for (const chunk of [dates.slice(0, 2), dates.slice(2)]) {
    for (const { config, kind, date } of preparationDependencies(configurations, chunk)) {
      const key = preparationSeedKey(engine, config, kind, date);
      if (seeds.has(key)) continue;
      const snapshot = engine.snapshot({ ...config, date, requestedDate: date }, { cache: false, persist: false });
      seeds.set(key, kind === 'weekly' ? compactWeeklySnapshot(snapshot) : topDecileIds(snapshot));
    }
  }
  prepareBatchedSnapshots(serial, engine, configurations, { dates, codec: 'zstd' });
  const result = await prepareParallelSnapshots({ sourcePath, targetDb: parallel, configurations, dates,
    directory, workers: 2, chunkSize: 2, codec: 'zstd', dependencySeeds: seeds, onProgress: (event) => events.push(event) });
  assert.equal(result.completedDates, dates.length);
  assert.equal(result.workers, 2);
  assert.equal(result.boundaryMode, 'sealed-seeds');
  assert.ok(result.seededWeeks > 0);
  assert.equal(events.filter(({ phase }) => phase === 'merge').length, 2);
  assert.equal(parallel.prepare('SELECT count(*) AS n FROM price_revisions').get().n, 0);
  assert.equal(parallel.prepare('SELECT count(*) AS n FROM accepted_preparation_shard_dates').get().n, 4);
  assert.equal(source.prepare('SELECT count(*) AS n FROM daily_prices').get().n, 1320);
  parallel.close();
  parallel = output('parallel.sqlite');
  for (const { config, rank } of configurations) {
    for (const date of dates) {
      const point = { ...config, date, requestedDate: date };
      for (const velocity of rank ? [false, true] : [false]) {
        const actual = readPreparedSnapshot(parallel, engine, point, { velocity });
        const expected = readPreparedSnapshot(serial, engine, point, { velocity });
        assert.ok(expected);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected));
      }
    }
    const options = { from: dates[0], to: dates.at(-1), limit: dates.length };
    const history = (db) => readMaterializedHistory(db, engine, config, options).rows.map(({ materializedAt, ...row }) => {
      assert.ok(Number.isFinite(Date.parse(materializedAt)));
      return row;
    });
    assert.equal(JSON.stringify(history(parallel)), JSON.stringify(history(serial)));
    if (rank) {
      const options = { securityId: 'shard-fixture:AAA' };
      const ranks = readPreparedRanks(parallel, config, dates, options);
      assert.equal(ranks.rows.length, dates.length);
      assert.deepEqual(ranks, readPreparedRanks(serial, config, dates, options));
    }
  }
  const resumed = await prepareParallelSnapshots({ sourcePath, targetDb: parallel, configurations, dates,
    directory, workers: 1, chunkSize: 3 });
  assert.equal(resumed.resumedDates, 4);
  assert.equal(resumed.commits, 0);
});

test('merge rejects wrong pins, altered files, foreign dates, and conflicts without partial publication', async (t) => {
  const { directory, sourcePath, source, engine, configurations, dates, output } = fixture(t);
  const target = output('target.sqlite');
  const pin = preparationSourcePin(source, sourcePath, configurations);
  const request = { sourcePath, sidecarPath: join(directory, 'owned.sqlite'), configurations, dates: dates.slice(0, 1),
    pin, maxBytes: 8 * 1024 ** 2, codec: 'gzip' };
  const report = await runPreparationShard(request);
  assert.equal(target.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='market_history'").get().n, 0);
  await assert.rejects(mergePreparationShard(target, engine, request, { ...report, pin: { ...pin, contextHash: 'wrong' } }), /does not match/);
  const forged = { ...pin, sourceHash: 'wrong' };
  await assert.rejects(mergePreparationShard(target, engine, { ...request, pin: forged }, { ...report, pin: forged }), /source or resolved recipe pin/);
  await assert.rejects(mergePreparationShard(target, engine, request, { ...report, dates: dates.slice(1, 2) }), /date ownership/);
  await assert.rejects(mergePreparationShard(target, engine, request, { ...report, seal: { ...report.seal, sha256: 'wrong' } }), /checksum/);
  const alteredPath = join(directory, 'altered.sqlite');
  const alteredRequest = { ...request, sidecarPath: alteredPath };
  const altered = await runPreparationShard(alteredRequest);
  const bad = openDatabase(alteredPath);
  bad.prepare('UPDATE market_history SET date=?').run(dates[2]);
  assert.throws(() => preparationShardInventory(bad, request), /out-of-scope/);
  bad.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  bad.close();
  await assert.rejects(mergePreparationShard(target, engine, alteredRequest, {
    ...altered, seal: await checksumPreparationShard(alteredPath),
  }), /out-of-scope/);

  const incompleteRequest = { ...request, sidecarPath: join(directory, 'incomplete.sqlite') };
  const incomplete = await runPreparationShard(incompleteRequest);
  const incompleteDb = openDatabase(incompleteRequest.sidecarPath);
  incompleteDb.exec('DELETE FROM prepared_snapshot_frames');
  const incompleteInventory = preparationShardInventory(incompleteDb, request);
  incompleteDb.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  incompleteDb.close();
  await assert.rejects(mergePreparationShard(target, engine, incompleteRequest, {
    ...incomplete, inventory: incompleteInventory, seal: await checksumPreparationShard(incompleteRequest.sidecarPath),
  }), /missing a referenced prepared stock frame/);

  const date = request.dates[0];
  prepareBatchedSnapshots(target, engine, [configurations[0]], { dates: [date], codec: 'gzip' });
  const before = target.prepare('SELECT count(*) AS n FROM prepared_snapshot_contexts').get().n;
  const layouts = target.prepare('SELECT count(*) AS n FROM prepared_snapshot_layouts').get().n;
  await assert.rejects(mergePreparationShard(target, engine, request, report), /UNIQUE constraint failed/);
  assert.equal(target.prepare('SELECT count(*) AS n FROM prepared_snapshot_contexts').get().n, before);
  assert.equal(target.prepare('SELECT count(*) AS n FROM prepared_snapshot_layouts').get().n, layouts);
  assert.equal(target.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='accepted_preparation_shard_dates'").get().n, 0);
  assert.equal(target.isTransaction, false);
});

test('failed and cancelled children leave no false readiness and a retry publishes all requested dates', async (t) => {
  const { directory, sourcePath, engine, configurations, dates, output } = fixture(t);
  const targetDb = output('failed.sqlite');
  const request = { sourcePath, targetDb, configurations, dates, directory, workers: 2, chunkSize: 2 };
  await assert.rejects(prepareParallelSnapshots({ ...request, dependencySeeds: new Map() }), /Missing preparation/);
  const controller = new AbortController();
  await assert.rejects(prepareParallelSnapshots({ ...request, signal: controller.signal, onProgress(event) {
    if (event.phase === 'compute') controller.abort();
  } }), { name: 'AbortError' });
  assert.equal(readPreparedSnapshot(targetDb, engine, configurations[0].config), null);
  assert.equal(targetDb.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='accepted_preparation_shard_dates'").get().n, 0);
  const completed = await prepareParallelSnapshots(request);
  assert.equal(completed.boundaryMode, 'local-recompute');
  assert.equal(completed.completedDates, 4);
});

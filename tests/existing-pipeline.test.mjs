import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { prepareBatchedSnapshots } from '../backend/batch-preparation.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, dataVersion, importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { preparationShardFormat, preparationSourcePin } from '../backend/pipeline-shards.mjs';
import { createPreparedDetailWriter } from '../backend/prepared-details.mjs';
import { prepareRangeHistoryBatch, prepareRangeMetrics } from '../backend/range-metrics.mjs';
import { createRiskHistoryWriter, prepareRiskHistoryBenchmarks } from '../backend/risk-history.mjs';
import { prepareNyseSummation, prepareStandardHealth, preparationWorkspaceScopes, summationContext } from '../backend/service.mjs';
import { benchmarkContexts, exactRangePlans } from '../scripts/pipeline-verification.mjs';
import { verifyExistingPipeline } from '../scripts/verify-existing-pipeline.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function archiveFixture(t, { includeHighBucket = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'market-recovery-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.sqlite');
  const archivePath = join(directory, 'archive.sqlite');
  const source = openDatabase(sourcePath);
  const archive = openDatabase(archivePath);
  const allSessions = expectedSessions('2026-11-12', '2026-11-20');
  const dates = allSessions.slice(-3);
  const prerequisites = allSessions.slice(0, -3);
  const day = allSessions.at(-1);
  const securities = [
    { id: 'fixture:AAA', symbol: 'AAA', type: 'common', exchange: 'NYSE', listingDate: allSessions[0] },
    { id: 'fixture:SPY', symbol: 'SPY', type: 'etf', exchange: 'NYSE', listingDate: allSessions[0] },
    { id: 'fixture:VTI', symbol: 'VTI', type: 'etf', exchange: 'NYSE', listingDate: allSessions[0] },
  ];
  if (includeHighBucket) securities.push({ id: 'fixture:HI48', symbol: 'HBIT', type: 'common', exchange: 'NYSE', listingDate: allSessions[0] });
  try {
    archive.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
    importDataset(source, { provider: 'recovery-fixture', securities, prices: securities.flatMap((security, stock) =>
      allSessions.map((date, session) => {
        const close = 100 + stock + session;
        return { securityId: security.id, date, close, open: close, high: close + 1, low: close - 1, volume: 10_000, adjustedClose: close };
      })) });
    const engine = createEngine(source);
    const version = dataVersion(source);
    const scopes = preparationWorkspaceScopes(source, engine, { date: day, version });
    const point = engine.context({ ...scopes.base, universe: 'us-all', reference: 'as-of', observedReferenceDate: day });
    const recipes = benchmarkContexts(source, engine, point, scopes, { observedReferenceDate: day });
    const warmConfigs = recipes.configs.map(({ config }) => ({ config, historyOnly: true, rank: false }));
    prepareBatchedSnapshots(archive, engine, warmConfigs, { dates: prerequisites });
    prepareBatchedSnapshots(archive, engine, recipes.configs, { dates });
    archive.exec(`CREATE TABLE accepted_preparation_shard_dates (
      publication TEXT NOT NULL,date TEXT NOT NULL,manifest_hash TEXT NOT NULL,source_hash TEXT NOT NULL,
      calculation_version TEXT NOT NULL,data_version INTEGER NOT NULL,context_hash TEXT NOT NULL,accepted_at TEXT NOT NULL,
      PRIMARY KEY(publication,date)) WITHOUT ROWID;`);
    const accept = archive.prepare('INSERT INTO accepted_preparation_shard_dates VALUES (?,?,?,?,?,?,?,?)');
    for (const [phaseDates, configs] of [[prerequisites, warmConfigs], [dates, recipes.configs]]) {
      const pin = preparationSourcePin(source, sourcePath, configs);
      const key = hash([preparationShardFormat, pin]);
      const seal = hash([pin, phaseDates]);
      for (const date of phaseDates) accept.run(key, date, seal, pin.sourceHash, CALCULATION_VERSION, version, pin.contextHash, `${day}T22:00:00Z`);
    }
    const cfg = { ...point, referenceMode: 'as-of', currentVersion: false };
    const riskArgs = { dates, windows: recipes.riskWindows, benchmarks: recipes.benchmarks, sourceDb: source, bucketSize: 32 };
    const risk = createRiskHistoryWriter(archive, cfg, { ...riskArgs, ...prepareRiskHistoryBenchmarks(source, engine, cfg, riskArgs) });
    const detail = createPreparedDetailWriter(archive, engine, cfg, { sourceDb: source, benchmarks: recipes.benchmarks, riskWindows: [] });
    const rangeResult = prepareRangeHistoryBatch(archive, engine, cfg, recipes.rangeWindows, {
      dates, sourceDb: source, bucketSize: 32, onSecurity: (row) => { risk.writeSecurity(row); detail(row); },
    });
    assert.equal(rangeResult.done, true);
    assert.equal(risk.finish().done, true);
    for (const { config, windows } of exactRangePlans(recipes, point, dates)) prepareRangeMetrics(archive, engine, config, windows);
    for (const { config, rank } of recipes.configs) if (rank) {
      prepareStandardHealth(archive, engine, config, { from: dates[0], limit: dates.length });
    }
    prepareNyseSummation(archive, engine, summationContext(source, engine, point), { batch: true });
    archive.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    source.close();
    archive.close();
  }
  return { sourcePath, archivePath, minimumSessions: 2, originalElapsedMs: 4_355_123, referenceDate: day,
    version: 1, to: day, sessions: dates.length, receiptsDirectory: join(directory, 'receipts'), reportPath: join(directory, 'verified.json') };
}

test('read-only recovery checks all archive families, reseals the same bytes, and resumes checked tiles', async (t) => {
  const options = archiveFixture(t);
  const hashes = [fileHash(options.sourcePath), fileHash(options.archivePath)];
  const report = await verifyExistingPipeline(options);
  assert.deepEqual([fileHash(options.sourcePath), fileHash(options.archivePath)], hashes);
  assert.equal(report.state, 'verified');
  assert.equal(report.archive.sha256, hashes[1]);
  assert.equal(report.verification.products.nyseSummation.verified, 3);
  assert.ok(report.verification.products.monitor.verified > 0);
  assert.ok(report.boundaryOracle.every((part) => part.leaderContexts > 0));
  assert.deepEqual(report.boundaryOracle.map((part) => part.phase), ['core', 'breadth-warmup']);
  assert.equal(report.performance.targetMet, false);
  assert.equal(report.performance.originalPhaseTimings, null);
  assert.equal(report.performance.measuredColdElapsedMs, 4_355_123);
  assert.equal(JSON.parse(readFileSync(options.reportPath, 'utf8')).sourcePin.calculationVersion, CALCULATION_VERSION);
  const events = [];
  const repeated = await verifyExistingPipeline({ ...options, reportPath: options.reportPath + '.resume', onProgress: (event) => events.push(event) });
  assert.deepEqual(repeated.verification, report.verification);
  assert.ok(events.filter((event) => 'reused' in event).every((event) => event.reused));
  const receiptsPath = join(options.receiptsDirectory, 'verification-receipts.json');
  const receipts = JSON.parse(readFileSync(receiptsPath, 'utf8'));
  const coreStep = Object.keys(receipts.completed).find((step) => step.startsWith('core-products:'));
  receipts.completed[coreStep].result.ranks++;
  writeFileSync(receiptsPath, JSON.stringify(receipts));
  await assert.rejects(verifyExistingPipeline({ ...options, reportPath: options.reportPath + '.damaged-receipt' }), /receipt is invalid/);
});

test('incomplete artifacts, pending journal and modified definitions fail closed', async (t) => {
  const options = archiveFixture(t);
  await assert.rejects(verifyExistingPipeline({ ...options, version: 2 }), /Source revision/);
  writeFileSync(options.archivePath + '-wal', 'uncheckpointed');
  await assert.rejects(verifyExistingPipeline(options), /pending journal/);
  rmSync(options.archivePath + '-wal');
  await assert.rejects(verifyExistingPipeline({ ...options, archiveSha256: '0'.repeat(64) }), /SHA-256/);
  const source = new DatabaseSync(options.sourcePath);
  storeWorkspace(source, 'health-model', { name: 'New weights', definition: { weights: { highsLows: 0 } } });
  source.close();
  await assert.rejects(verifyExistingPipeline(options), /workspace definitions/);
  const reopened = new DatabaseSync(options.sourcePath);
  reopened.exec("DELETE FROM workspace WHERE kind='health-model'");
  reopened.close();
  const archive = new DatabaseSync(options.archivePath);
  archive.exec(`DELETE FROM prepared_health WHERE recipe=(SELECT min(recipe) FROM prepared_health); PRAGMA wal_checkpoint(TRUNCATE)`);
  archive.close();
  await assert.rejects(verifyExistingPipeline(options), /Prepared health is missing/);
});

test('missing snapshot data on a nonsampled date cannot pass artifact coverage', async (t) => {
  const options = archiveFixture(t);
  const archive = new DatabaseSync(options.archivePath);
  archive.exec(`DELETE FROM prepared_snapshot_blobs WHERE date='2026-11-19' AND blob=(
    SELECT header FROM prepared_snapshot_contexts WHERE date='2026-11-19' LIMIT 1
  ); PRAGMA wal_checkpoint(TRUNCATE)`);
  archive.close();
  await assert.rejects(verifyExistingPipeline(options), /snapshot header is missing on 2026-11-19/);
});

test('recovery accepts the unsigned high bit for stock frame bucket 31', async (t) => {
  const options = archiveFixture(t, { includeHighBucket: true });
  const archive = new DatabaseSync(options.archivePath, { readOnly: true });
  try {
    assert.ok(archive.prepare('SELECT 1 FROM prepared_snapshot_frames WHERE bucket=31 LIMIT 1').get());
    assert.ok(archive.prepare('SELECT 1 FROM prepared_snapshot_contexts WHERE delta_mask>=2147483648 LIMIT 1').get());
  } finally { archive.close(); }
  assert.equal((await verifyExistingPipeline(options)).state, 'verified');
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { prepareBatchedSnapshots } from '../backend/batch-preparation.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, getWorkspace, importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { getJournalDate, saveJournalNote } from '../backend/journal.mjs';
import { readMaterializedHistory } from '../backend/materialization.mjs';
import { publishPreparation, preparationPublicationFormat } from '../backend/preparation-publication.mjs';
import { readPreparedDetail, writePreparedDetail } from '../backend/prepared-details.mjs';
import { readPreparedSnapshot } from '../backend/prepared-snapshots.mjs';
import { prepareRangeHistoryBatch, readPreparedRangeMetrics } from '../backend/range-metrics.mjs';
import { prepareRiskHistoryBatch, readRiskHistory } from '../backend/risk-history.mjs';
import { prepareSummation, readPreparedSummation } from '../backend/summation.mjs';

const sourceHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const previousCalc = '2-111111111111';

function fixture(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'market-publication-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'derived.sqlite');
  const destinationPath = join(directory, 'warehouse.sqlite');
  const empty = new DatabaseSync(sourcePath);
  empty.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
  empty.close();
  const source = openDatabase(sourcePath);
  const target = openDatabase(destinationPath);
  const dates = expectedSessions('2024-01-02', '2026-11-20').slice(-285);
  const securities = ['AAA', 'BBB', 'SPY'].map((symbol, i) => ({ symbol, name: symbol, listingDate: dates[0],
    exchange: i === 1 ? 'NASDAQ' : 'NYSE', type: i === 2 ? 'etf' : 'common', knownAt: dates[0] }));
  const { version } = importDataset(target, {
    provider: 'fixture', securities,
    prices: securities.flatMap(({ symbol }, j) => dates.map((date, i) => {
      const close = 10 + j + i / 30 + Math.sin(i / (3 + j)) / 10;
      return { symbol, date, knownAt: date, open: close, high: close * 1.02, low: close * 0.99, close, volume: i * 3217 + 1000 };
    })),
  });
  const cols = target.prepare('PRAGMA table_info(ingestion_runs)').all().map(({ name }) => name);
  const copyRun = source.prepare(`INSERT INTO ingestion_runs VALUES (${cols.map(() => '?').join(',')})`);
  for (const row of target.prepare('SELECT * FROM ingestion_runs').all()) copyRun.run(...cols.map((column) => row[column]));
  const screen = storeWorkspace(target, 'screen', { name: 'Saved fixture', definition: { filters: [] } });
  saveJournalNote(target, { asOfDate: dates.at(-1), markdown: 'Keep my dated note.' });
  const engine = createEngine(target);
  const config = engine.context({ universe: 'us-core', benchmark: 'SPY', reference: 'as-of' });
  const measured = dates.slice(-3);
  prepareBatchedSnapshots(source, engine, [{ config, rank: true }], { dates: measured, codec: 'zstd' });
  target.exec(source.prepare("SELECT sql FROM sqlite_schema WHERE name='market_history'").get().sql);
  target.prepare('INSERT INTO market_history VALUES (?,?,?,?,?,?,?,?)').run('legacy@1', 'legacy@1', version, previousCalc,
    'retained', measured[0], 'legacy-content', '2026-11-20T21:00:00Z');
  const [detail] = engine.detailSources(config, { securityIds: ['fixture:AAA'] });
  writePreparedDetail(source, config, detail);
  assert.ok(prepareRangeHistoryBatch(source, engine, config, [20], { dates: measured, sourceDb: target }).done);
  assert.ok(prepareRiskHistoryBatch(source, engine, config, { dates: measured, windows: [21], benchmarks: ['SPY'], sourceDb: target }).done);
  const nyse = engine.context({ universe: 'nyse', reference: 'as-of' });
  prepareSummation(source, nyse, dates, dates.map((date) => ({ date, advancers: 15, decliners: 10, comparable: 25, traded: 25 })));
  const options = { from: measured[0], to: measured.at(-1), limit: measured.length };
  const expected = {
    snapshot: readPreparedSnapshot(source, engine, config, { velocity: true }),
    detail: readPreparedDetail(source, config, 'fixture:AAA', { lookback: 126 }).detail,
    range: readPreparedRangeMetrics(source, config, [20]),
    risk: readRiskHistory(source, config, 'fixture:AAA', { lookback: 21, benchmark: 'SPY' }),
    market: readMaterializedHistory(source, engine, config, options).rows,
    summation: readPreparedSummation(source, nyse, { limit: 3 }).rows,
  };
  source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  source.close();
  target.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  target.close();

  function request() {
    return { sourcePath, destinationPath, dataVersion: version, calculationVersion: CALCULATION_VERSION,
      activeCalculationVersion: previousCalc, reserveBytes: 0, maxPartitionBytes: 12 * 1024,
      manifest: { format: preparationPublicationFormat, accepted: true, dataVersion: version, calculationVersion: CALCULATION_VERSION,
        archive: { bytes: statSync(sourcePath).size, sha256: sourceHash(sourcePath) },
        verification: { sessions: measured.length, contexts: 1 } } };
  }
  return { directory, sourcePath, destinationPath, config, screen, dates, measured, nyse, options, expected, request };
}

test('dry run is read-only; interrupted publication resumes and reclaims source pages without changing raw workspace or notes', async (t) => {
  const f = fixture(t);
  const plan = f.request();
  const destinationHash = sourceHash(f.destinationPath);
  const expectedSource = sourceHash(f.sourcePath);
  const manifestPath = join(f.directory, 'accepted.json');
  writeFileSync(manifestPath, JSON.stringify(plan.manifest));
  const cli = spawnSync(process.execPath, ['scripts/publish-preparation.mjs', '--source', plan.sourcePath, '--destination',
    plan.destinationPath, '--manifest', manifestPath, '--data-version', String(plan.dataVersion),
    '--calculation-version', plan.calculationVersion, '--active-calculation-version', plan.activeCalculationVersion], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).state, 'dry-run');
  assert.equal(sourceHash(f.destinationPath), destinationHash);
  assert.equal(sourceHash(f.sourcePath), expectedSource);

  await assert.rejects(publishPreparation({ ...plan, consume: true, onProgress: ({ phase, table }) => {
    if (phase === 'copied' && table === 'prepared_risk_history_runs') throw new Error('Interrupted after manifest copy');
  } }), /Interrupted after manifest copy/);
  const wait = new DatabaseSync(f.destinationPath, { readOnly: true });
  try {
    assert.equal(wait.prepare('SELECT count(*) AS n FROM prepared_risk_history_runs').get().n, 0);
    assert.equal(wait.prepare("SELECT state FROM preparation_publications").get().state, 'copying');
    assert.ok(wait.prepare("SELECT staged FROM preparation_publication_partitions WHERE table_name='prepared_risk_history_runs'").get().staged);
  } finally { wait.close(); }

  const resumed = await publishPreparation({ ...plan, consume: true });
  assert.equal(resumed.state, 'verified-awaiting-cutover');
  assert.equal(resumed.consumedPartitions, resumed.totalPartitions);
  assert.ok(statSync(f.sourcePath).size < plan.manifest.archive.bytes);
  const target = openDatabase(f.destinationPath);
  const source = openDatabase(f.sourcePath);
  t.after(() => { source.close(); target.close(); });
  const engine = createEngine(target);
  assert.equal(target.prepare('SELECT count(*) AS n FROM daily_prices').get().n, f.dates.length * 3);
  assert.equal(target.prepare('SELECT count(*) AS n FROM price_revisions').get().n, f.dates.length * 3);
  assert.equal(getWorkspace(target, 'screen', f.screen.id).name, 'Saved fixture');
  assert.equal(getJournalDate(target, f.config.date).notes.markdown, 'Keep my dated note.');
  assert.equal(target.prepare('SELECT value FROM market_history WHERE calculation_version=?').get(previousCalc).value, 'legacy-content');
  assert.equal(JSON.stringify(readPreparedSnapshot(target, engine, f.config, { velocity: true })), JSON.stringify(f.expected.snapshot));
  assert.deepEqual(readPreparedDetail(target, f.config, 'fixture:AAA', { lookback: 126 }).detail, f.expected.detail);
  assert.deepEqual(readPreparedRangeMetrics(target, f.config, [20]), f.expected.range);
  assert.deepEqual(readRiskHistory(target, f.config, 'fixture:AAA', { lookback: 21, benchmark: 'SPY' }), f.expected.risk);
  assert.deepEqual(readMaterializedHistory(target, engine, f.config, f.options).rows, f.expected.market);
  assert.deepEqual(readPreparedSummation(target, f.nyse, { limit: 3 }).rows, f.expected.summation);
  assert.equal(source.prepare('SELECT count(*) AS n FROM prepared_detail_blocks').get().n, 0);
});

test('a conflicting destination row rolls back the partition and leaves its source rows intact', async (t) => {
  const f = fixture(t);
  const plan = f.request();
  const source = openDatabase(f.sourcePath);
  const target = openDatabase(f.destinationPath);
  const row = source.prepare('SELECT * FROM prepared_snapshot_contexts ORDER BY date,recipe DESC LIMIT 1').get();
  const schema = source.prepare("SELECT sql FROM sqlite_schema WHERE name='prepared_snapshot_contexts'").get().sql;
  target.exec(schema);
  row.stock_count += 1;
  target.prepare('INSERT INTO prepared_snapshot_contexts VALUES (?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
  const count = source.prepare('SELECT count(*) AS n FROM prepared_snapshot_contexts').get().n;
  source.close();
  target.close();
  const adjusted = f.request();
  await assert.rejects(publishPreparation({ ...adjusted, consume: true }), /Conflicting destination row/);
  const from = new DatabaseSync(f.sourcePath, { readOnly: true });
  const to = new DatabaseSync(f.destinationPath, { readOnly: true });
  try {
    assert.equal(from.prepare('SELECT count(*) AS n FROM prepared_snapshot_contexts').get().n, count);
    assert.equal(to.prepare('SELECT count(*) AS n FROM prepared_snapshot_contexts').get().n, 1);
    assert.equal(to.prepare("SELECT count(*) AS n FROM preparation_publication_partitions WHERE state<>'planned'").get().n, 0);
  } finally { from.close(); to.close(); }
  assert.equal(plan.dataVersion, adjusted.dataVersion);
});

test('rejects active-version publication, symlinks, wrong checksums, and archives containing raw records', async (t) => {
  const f = fixture(t);
  const plan = f.request();
  await assert.rejects(publishPreparation({ ...plan, activeCalculationVersion: plan.calculationVersion }), /active app/);
  const alias = join(f.directory, 'alias.sqlite');
  symlinkSync(f.sourcePath, alias);
  await assert.rejects(publishPreparation({ ...plan, sourcePath: alias }), /non-symlink/);
  await assert.rejects(publishPreparation({ ...plan, manifest: { ...plan.manifest,
    archive: { ...plan.manifest.archive, sha256: '1'.repeat(64) } } }), /SHA-256/);
  const raw = openDatabase(f.sourcePath);
  raw.exec(`INSERT INTO securities (id,name,type,exchange,provider,status) VALUES ('raw','raw','common','NYSE','fixture','active');
    INSERT INTO daily_prices (security_id,date,open,high,low,close,volume,source,known_at,ingested_at,version)
    VALUES ('raw','2026-11-20',1,1,1,1,1,'fixture','2026-11-20','2026-11-20',1); PRAGMA wal_checkpoint(TRUNCATE)`);
  raw.close();
  await assert.rejects(publishPreparation({ ...f.request(), consume: true }), /unsupported or raw table with rows: daily_prices/);
});

test('resume verifies committed destination bytes before a source partition can be deleted', async (t) => {
  const f = fixture(t);
  const plan = f.request();
  await assert.rejects(publishPreparation({ ...plan, consume: true, onProgress: ({ phase, table }) => {
    if (phase === 'copied' && table === 'prepared_snapshot_frames') throw new Error('Stopped after frame commit');
  } }), /Stopped after frame commit/);
  const target = openDatabase(f.destinationPath);
  target.exec("UPDATE prepared_snapshot_frames SET value=X'01'");
  target.close();
  const currentRows = () => {
    const db = new DatabaseSync(f.sourcePath, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS n FROM prepared_snapshot_frames').get().n; }
    finally { db.close(); }
  };
  const before = currentRows();
  assert.ok(before > 0);
  await assert.rejects(publishPreparation({ ...plan, consume: true }), /partition contents differ/);
  assert.equal(currentRows(), before);
});

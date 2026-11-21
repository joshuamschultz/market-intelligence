import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { backupRetention, backupSpaceRequired, createCompressedBackup, verifyCompressedBackup } from '../backend/backup.mjs';
import { createJob, importDataset, openDatabase, recordDailyPublication, updateJob } from '../backend/database.mjs';
import { saveJournalSettings } from '../backend/journal.mjs';
import { createDailyTick } from '../backend/server.mjs';
import { createService, performJob, scheduledJournalReadiness, scheduledPrecomputeKey } from '../backend/service.mjs';

const date = '2024-06-03';
const next = '2024-06-04';
const price = (asOf) => ({ symbol: 'ABC', date: asOf, open: 100, high: 105, low: 95, close: 100, volume: 1000, knownAt: asOf });
const security = { symbol: 'ABC', name: 'Alpha Corp', exchange: 'NASDAQ', type: 'common', status: 'active',
  listingDate: '2020-01-01', knownAt: '2020-01-01' };
const command = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'market-backup-test-'));
  const db = openDatabase(join(root, 'market.sqlite'));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const imported = importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 1, catalogDate: date,
    securities: [security], prices: [price(date)] });
  return { db, root, directory: join(root, 'backups'), version: imported.version };
}

test('compressed backup verifies a consistent SQLite copy and leaves newer source changes outside it', async (t) => {
  const { db, root, directory } = await fixture(t);
  const seen = [];
  const backup = await createCompressedBackup(db, { directory, sourceDate: date, progress: (fraction) => {
    seen.push(fraction);
    if (fraction === 0.6) {
      assert.equal(db.isTransaction, false);
      importDataset(db, { provider: 'eodhd', prices: [price(next)] });
    }
  } });
  assert.equal(seen.at(-1), 1);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(backup.scheduledFor, date);
  assert.equal(backup.latestDate, date);
  assert.equal(backup.quickCheck, 'ok');
  assert.equal(backup.counts.daily_prices, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM daily_prices').get().count, 2);
  assert.equal((await stat(backup.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(backup.filename)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).sort(), [backup.id]);
  const manifest = await verifyCompressedBackup(backup.directory);
  const compressed = await readFile(backup.filename);
  assert.equal(manifest.sha256, createHash('sha256').update(compressed).digest('hex'));
  const restored = join(root, 'restored.sqlite');
  await writeFile(restored, gunzipSync(compressed));
  const isolated = new DatabaseSync(restored, { readOnly: true });
  try {
    assert.equal(isolated.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(isolated.prepare('SELECT close FROM daily_prices WHERE date=?').get(date).close, 100);
  } finally { isolated.close(); }
});

test('retention prunes only its own completed backups and leaves extra user files and unrelated backups', async (t) => {
  const { db, directory } = await fixture(t);
  await mkdir(directory);
  const foreign = join(directory, 'user-market.sqlite');
  await writeFile(foreign, 'unrelated user backup');
  const first = await createCompressedBackup(db, { directory });
  const keep = join(first.directory, 'user-comment.txt');
  await writeFile(keep, 'user data');
  const prior = await createCompressedBackup(db, { directory });
  const current = await createCompressedBackup(db, { directory, retain: 1 });
  assert.deepEqual(current.removed, [prior.id]);
  assert.equal(await readFile(foreign, 'utf8'), 'unrelated user backup');
  assert.equal(await readFile(keep, 'utf8'), 'user data');
  assert.equal((await readdir(directory)).includes(prior.id), false);
  assert.ok((await readdir(directory)).includes(current.id));
});

test('corrupted gzip is rejected and partial staging files are removed on cancellation', async (t) => {
  const { db, directory } = await fixture(t);
  const report = await createCompressedBackup(db, { directory });
  const bytes = await readFile(report.filename);
  bytes[bytes.length - 9] ^= 0xff;
  await writeFile(report.filename, bytes);
  await assert.rejects(verifyCompressedBackup(report.directory));
  const controller = new AbortController();
  await assert.rejects(createCompressedBackup(db, { directory, signal: controller.signal, progress: (fraction) => {
    if (fraction === 0) controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual(await readdir(directory), [report.id]);
});

test('backup pressure calculations, active source guard and interconnection serialization are explicit', async (t) => {
  const { db, directory } = await fixture(t);
  assert.equal(backupSpaceRequired(10_000_000_000), 10_000_000_000n + 1024n ** 3n);
  assert.equal(backupRetention(undefined), null);
  assert.equal(backupRetention('2'), 2);
  assert.throws(() => backupRetention(0), /integer/);
  db.exec('BEGIN');
  await assert.rejects(createCompressedBackup(db, { directory }), /Finish the source transaction/);
  db.exec('ROLLBACK');
  const other = new DatabaseSync(db.location(), { readOnly: true });
  try {
    let concurrent;
    await createCompressedBackup(db, { directory, progress: (fraction) => {
      if (fraction === 0) concurrent = assert.rejects(createCompressedBackup(other, { directory }), { code: 'BACKUP_BUSY' });
    } });
    await concurrent;
  } finally { other.close(); }
});

test('adaptive compression stops on a disk-space drop and preserves the warehouse and existing backups', async (t) => {
  const { db, directory } = await fixture(t);
  const committed = await createCompressedBackup(db, { directory });
  const foreign = join(directory, 'user-market.sqlite');
  await writeFile(foreign, 'preserve this user backup');
  db.exec('CREATE TABLE disk_fixture (body BLOB NOT NULL)');
  db.prepare('INSERT INTO disk_fixture VALUES (?)').run(randomBytes(256 * 1024));
  const pages = BigInt(db.prepare('PRAGMA page_count').get().page_count);
  const pageSize = BigInt(db.prepare('PRAGMA page_size').get().page_size);
  const staging = pages * pageSize;
  const reserve = 1024n ** 3n;
  const headroom = 4n * 1024n ** 2n;
  const readings = [staging + reserve + headroom, reserve + headroom, reserve - 1n];
  let checks = 0;
  await assert.rejects(createCompressedBackup(db, {
    directory, retain: 1, diskCheckBytes: 1,
    spaceAvailable: () => readings[Math.min(checks++, readings.length - 1)],
  }), { code: 'ENOSPC' });
  assert.equal(checks, 3);
  assert.equal(db.prepare('SELECT length(body) AS size FROM disk_fixture').get().size, 256 * 1024);
  assert.deepEqual((await readdir(directory)).sort(), [committed.id, 'user-market.sqlite'].sort());
  assert.equal((await verifyCompressedBackup(committed.directory)).sha256, committed.sha256);
  assert.equal(await readFile(foreign, 'utf8'), 'preserve this user backup');
});

test('compressible backups can fit below a two-copy budget and unchanged disk readings cannot remove the output cap', async (t) => {
  const { db, directory } = await fixture(t);
  db.exec('CREATE TABLE disk_fixture (body BLOB NOT NULL)');
  const size = 2 * 1024 * 1024;
  db.prepare('INSERT INTO disk_fixture VALUES (?)').run(Buffer.alloc(size));
  const reserve = 1024n ** 3n;
  const headroom = 1024n ** 2n + 32n * 1024n;
  let checks = 0;
  const diskMock = () => {
    if (checks++ > 0) return reserve + headroom;
    const staging = BigInt(db.prepare('PRAGMA page_count').get().page_count) * BigInt(db.prepare('PRAGMA page_size').get().page_size);
    assert.ok(headroom < staging);
    return staging + reserve + headroom;
  };
  const accepted = await createCompressedBackup(db, { directory, spaceAvailable: diskMock });
  assert.ok(accepted.bytes <= 32 * 1024);
  db.prepare('UPDATE disk_fixture SET body=?').run(randomBytes(size));
  checks = 0;
  await assert.rejects(createCompressedBackup(db, { directory, spaceAvailable: diskMock }), { code: 'ENOSPC' });
  assert.ok(checks >= 3);
  assert.deepEqual(await readdir(directory), [accepted.id]);
});

test('the existing SQLite backup job returns a verified compressed bundle', async (t) => {
  const { db } = await fixture(t);
  const result = await performJob(db, 'backup', { format: 'sqlite', scheduledFor: date });
  assert.match(result.filename, /\.sqlite\.gz$/);
  assert.equal((await verifyCompressedBackup(result.directory)).scheduledFor, date);
});

test('backup CLI copies a read-only warehouse and scheduled failures stay deduplicated', async (t) => {
  const { db, directory } = await fixture(t);
  const script = new URL('../scripts/backup.mjs', import.meta.url);
  const { stdout } = await command(process.execPath, [script.pathname, '--db', db.location(), '--directory', directory, '--quiet']);
  const result = JSON.parse(stdout);
  const checked = await command(process.execPath, [script.pathname, 'verify', result.directory]);
  assert.equal(JSON.parse(checked.stdout).sha256, result.sha256);
  const request = { format: 'sqlite', scheduledFor: date, retain: null };
  const jobKey = `backup:${date}`;
  const failed = createJob(db, 'backup', { ...request, jobKey });
  updateJob(db, failed.id, 'failed', 0, null, 'fixture disk pressure');
  assert.equal(createService({ db, workers: false }).enqueue('backup', request, jobKey).id, failed.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE type='backup'").get().n, 1);
});

test('scheduled journals wait for verified publication and successful Nasdaq refs, and pin the new warehouse version', async (t) => {
  const { db, version } = await fixture(t);
  const readiness = () => scheduledJournalReadiness(db, { date, nasdaqEnabled: true });
  assert.equal(readiness().state, 'waiting_for_publication');
  recordDailyPublication(db, { date, rawVersion: version, dataRevision: version, models: [] });
  assert.equal(readiness().state, 'waiting_for_nasdaq_refresh');
  const nasdaq = createJob(db, 'nasdaq-refresh', { scheduledFor: date });
  assert.equal(readiness().state, 'waiting_for_reference_jobs');
  updateJob(db, nasdaq.id, 'failed', 0, null, 'fixture failure');
  assert.equal(readiness().state, 'nasdaq_refresh_failed');
  const imported = importDataset(db, { provider: 'nasdaq', dataset: 'current-classification', classifications: [
    { securityId: 'eodhd:ABC', system: 'nasdaq', effectiveFrom: date, knownAt: date, industry: 'Current group' },
  ] });
  const retry = createJob(db, 'nasdaq-refresh', { scheduledFor: date });
  updateJob(db, retry.id, 'complete', 100, { captureDate: date });
  const source = createJob(db, 'provider-reference', {});
  assert.equal(readiness().state, 'waiting_for_reference_jobs');
  updateJob(db, source.id, 'complete', 100, { referenceDate: date });
  assert.deepEqual(readiness(), { state: 'ready', date, dataVersion: imported.version });
  assert.notEqual(readiness().dataVersion, version);
});

test('daily scheduler precomputes each stable revision before its journal and backup', async (t) => {
  const { db, version } = await fixture(t);
  recordDailyPublication(db, { date, rawVersion: version, dataRevision: version, models: [] });
  saveJournalSettings(db, { apiKey: 'sk-ant-scheduler-fixture', schedule: { enabled: true, after: '20:30' } });
  const service = createService({ db, workers: false });
  const attempts = [];
  let clock = new Date('2024-06-04T01:00:00Z');
  const tick = createDailyTick({ ...service, enqueue: (type, payload, key) => {
    const job = createJob(db, type, { ...payload, jobKey: key });
    attempts.push(job);
    return job;
  } }, db, { config: { MARKET_NASDAQ_SYNC: '1', MARKET_PRECOMPUTE: '1', MARKET_BACKUP: '1' }, now: () => clock });

  tick();
  assert.deepEqual(attempts.map((job) => job.type), ['nasdaq-refresh']);
  const reference = importDataset(db, { provider: 'nasdaq', dataset: 'stocks-screener:fixture', catalogDate: date,
    classifications: [{ securityId: 'eodhd:ABC', system: 'nasdaq', effectiveFrom: date, knownAt: date, industry: 'Current group' }] });
  updateJob(db, attempts[0].id, 'complete', 100, { captureDate: date });
  tick();
  tick();
  assert.deepEqual(attempts.map((job) => job.type), ['nasdaq-refresh', 'production-precompute']);
  const originalWarmup = attempts[1];
  assert.equal(originalWarmup.payload.jobKey, scheduledPrecomputeKey(date, reference.version));
  assert.equal(originalWarmup.payload.context.classification, 'nasdaq');
  assert.equal(originalWarmup.payload.context.reference, 'latest');
  const originalResult = await performJob(db, originalWarmup.type, originalWarmup.payload);
  assert.equal(originalResult.dataVersion, reference.version);
  assert.deepEqual(originalResult.monitor.breadthKeys, ['down_13pct_34d', 'up_13pct_34d']);
  updateJob(db, originalWarmup.id, 'complete', 100, originalResult);

  const interveningRevision = importDataset(db, { provider: 'eodhd', fundamentals: [
    { securityId: 'eodhd:ABC', effectiveDate: date, knownAt: date, shares: 1000 },
  ] });
  clock = new Date('2024-06-04T01:31:00Z');
  tick();
  assert.deepEqual(attempts.map((job) => job.type), ['nasdaq-refresh', 'production-precompute', 'production-precompute']);
  const warmup = attempts[2];
  assert.equal(warmup.payload.context.dataVersion, interveningRevision.version);
  const result = await performJob(db, warmup.type, warmup.payload);
  updateJob(db, warmup.id, 'complete', 100, result);

  tick();
  assert.equal(attempts[3].type, 'journal-generate');
  assert.equal(attempts[3].payload.context.dataVersion, interveningRevision.version);
  assert.equal(attempts[3].payload.context.classification, 'nasdaq');
  assert.equal(attempts[3].payload.context.reference, 'latest');
  assert.equal(attempts.length, 4);
  updateJob(db, attempts[3].id, 'complete', 100, { date });
  tick();
  tick();
  assert.equal(attempts[4].type, 'backup');
  assert.equal(attempts.length, 5);
});

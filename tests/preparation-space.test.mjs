import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CALCULATION_VERSION, createJob, jobById, openDatabase, updateJob } from '../backend/database.mjs';
import { enqueuePreparation, preparationType, requirePreparationSpace } from '../backend/preparation.mjs';

function pricedWarehouse(t, count) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'market-preparation-space-')));
  const db = new DatabaseSync(join(directory, 'market.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec('CREATE TABLE securities(first_seen TEXT)');
  db.prepare(`WITH RECURSIVE roster(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM roster WHERE n < ?)
    INSERT INTO securities(first_seen) SELECT '2024-01-01' FROM roster`).run(count);
  db.exec('INSERT INTO securities(first_seen) VALUES (NULL)');
  return { db, directory };
}

test('preparation admits a bounded batch at the reported free space with automatic backups enabled', (t) => {
  const { db, directory } = pricedWarehouse(t, 10007);
  const previous = process.env.MARKET_BACKUP;
  process.env.MARKET_BACKUP = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MARKET_BACKUP;
    else process.env.MARKET_BACKUP = previous;
  });
  requirePreparationSpace(db, 60, { statfs(path, options) {
    assert.equal(path, directory);
    assert.deepEqual(options, { bigint: true });
    return { bavail: 7_561_919n, bsize: 4096n };
  } });
});

test('preparation reserves both batch growth and WAL space for securities with price history', (t) => {
  const { db } = pricedWarehouse(t, 10007);
  const headroom = 2n * 1024n ** 3n;
  const growth = 60n * 10007n * 160n;
  const required = headroom + 2n * growth;
  const space = (bytes) => ({ statfs: () => ({ bavail: bytes, bsize: 1n }) });
  assert.throws(() => requirePreparationSpace(db, 60, space(headroom + growth)),
    { message: `Not enough free disk space to prepare this calculation while preserving warehouse and WAL headroom (need ${required} bytes, available ${headroom + growth} bytes)` });
  assert.doesNotThrow(() => requirePreparationSpace(db, 60, space(required)));
});

const previousDiskFailure = 'Not enough free disk space to prepare this calculation while preserving verified backup staging and warehouse headroom (need 31342491142 bytes)';
const resumedHistory = { completedSessions: 1620, written: 1620, reused: 0, elapsedMs: 1368440 };
const historySpec = {
  context: { date: '2026-11-20', dataVersion: 18914, universe: 'nyse', model: 'composite', basis: 'reconstructed',
    classification: 'sec-sic', reference: 'as-of', observedReferenceDate: undefined },
  calculationVersion: CALCULATION_VERSION, phase: 'history', historySessions: 2990,
  recipes: ['nyse-history', 'nyse-monitor'], monitor: true, followLatest: true, jobKey: 'prepare-context:nyse-history:history',
};

function failedPreparation(db, spec, checkpoint, error) {
  const job = createJob(db, spec.type ?? preparationType, { ...spec, ...checkpoint });
  return updateJob(db, job.id, 'failed', 0, null, error);
}

test('explicit retry after disk admission failure preserves the exact plan and prior batch checkpoint', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const failed = failedPreparation(db, historySpec, resumedHistory, previousDiskFailure);
  const unchanged = enqueuePreparation(db, [historySpec]);
  assert.equal(unchanged.queued, 0);
  assert.equal(unchanged.jobs[0].id, failed.id);
  const { queued, jobs: [retried] } = enqueuePreparation(db, [historySpec], { retry: true });
  assert.equal(queued, 1);
  assert.notEqual(retried.id, failed.id);
  assert.equal(retried.status, 'queued');
  assert.deepEqual(retried.payload, failed.payload);
  assert.equal(jobById(db, failed.id).status, 'failed');
  assert.equal(enqueuePreparation(db, [historySpec], { retry: true }).queued, 0);
});

test('failed disk checkpoints cannot cross a changed revision, calculation, layout, or history length', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const changes = [{ context: { ...historySpec.context, dataVersion: 18915 } }, { calculationVersion: '2-changed' },
    { recipes: [...historySpec.recipes].reverse() }, { historySessions: 1260 }];
  for (const [index, changed] of changes.entries()) {
    const prior = { ...historySpec, jobKey: `${historySpec.jobKey}:${index}` };
    failedPreparation(db, prior, resumedHistory, previousDiskFailure);
    const spec = { ...prior, ...changed };
    const { queued, jobs: [retried] } = enqueuePreparation(db, [spec], { retry: true });
    assert.equal(queued, 1);
    assert.deepEqual(retried.payload, JSON.parse(JSON.stringify(spec)));
  }
});

test('range history retries resume the cursor on a new disk guard error while calculation errors start fresh', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const range = { type: 'prepare-range-history', context: historySpec.context, windows: [20, 252],
    calculationVersion: CALCULATION_VERSION, jobKey: 'prepare-range-history:example:20,252' };
  const blocked = failedPreparation(db, range, { cursor: 'security-0216' },
    'Not enough free disk space to prepare this calculation while preserving warehouse and WAL headroom (need 4000 bytes, available 2000 bytes)');
  assert.deepEqual(enqueuePreparation(db, [range], { retry: true }).jobs[0].payload, blocked.payload);
  failedPreparation(db, historySpec, resumedHistory, 'Invalid preparation checkpoint');
  assert.deepEqual(enqueuePreparation(db, [historySpec], { retry: true }).jobs[0].payload, JSON.parse(JSON.stringify(historySpec)));
});

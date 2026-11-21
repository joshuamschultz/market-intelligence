import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { archiveDerived, countDerivedArchive, restoreDerived, verifyDerivedArchive } from '../scripts/archive-derived.mjs';

const slice = { calculationVersion: '2-target', dataVersion: 18896 };
const counts = { snapshots: 1, market_history: 1, rank_archive_dates: 1, stock_rank_history: 1 };
const raw = Buffer.from([0, 255, 12, 10, 13, 128]);
const manifestPath = 'archive.ndjson.gz';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mi-derived-test-'));
  const filename = join(directory, 'market.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE snapshots (kind TEXT, date TEXT, universe TEXT, model TEXT,
      data_version INTEGER, calculation_version TEXT, definition_key TEXT, value TEXT, created_at TEXT,
      PRIMARY KEY (kind,date,universe,model,data_version,calculation_version,definition_key));
    CREATE TABLE market_history (universe TEXT, model TEXT, data_version INTEGER, calculation_version TEXT,
      definition_key TEXT, date TEXT, value TEXT, created_at TEXT,
      PRIMARY KEY (universe,model,data_version,calculation_version,definition_key,date)) WITHOUT ROWID;
    CREATE TABLE rank_archive_dates (recipe TEXT, date TEXT, data_version INTEGER, calculation_version TEXT,
      observations INTEGER, created_at TEXT, PRIMARY KEY (recipe,data_version,calculation_version,date)) WITHOUT ROWID;
    CREATE TABLE stock_rank_history (recipe TEXT, date TEXT, data_version INTEGER, calculation_version TEXT,
      security_id TEXT, symbol TEXT, rank INTEGER, percentile REAL, score REAL,
      PRIMARY KEY (recipe,data_version,calculation_version,date,security_id)) WITHOUT ROWID;
    CREATE TABLE daily_prices (data_version INTEGER, calculation_version TEXT, value TEXT);
    CREATE TABLE workspace (data_version INTEGER, calculation_version TEXT, value TEXT);
    CREATE TABLE journal_entries (data_version INTEGER, calculation_version TEXT, value TEXT);
    INSERT INTO daily_prices VALUES (18896,'2-target','prices');
    INSERT INTO workspace VALUES (18896,'2-target','workspace');
    INSERT INTO journal_entries VALUES (18896,'2-target','notes');
  `);
  t.after(async () => { db.close(); await rm(directory, { recursive: true }); });
  for (const [version, calculation] of [[18896, '2-target'], [18896, '2-foreign'], [18895, '2-target']]) {
    db.prepare("INSERT INTO snapshots VALUES ('daily','2026-11-20','u','m',?,?,'definition',?,'created')")
      .run(version, calculation, raw);
    db.prepare("INSERT INTO market_history VALUES ('u','m',?,?,'definition','2026-11-20',?,'created')")
      .run(version, calculation, Buffer.alloc(0));
    db.prepare("INSERT INTO rank_archive_dates VALUES ('r','2026-11-20',?,?,?,'created')")
      .run(version, calculation, 9223372036854775807n);
    db.prepare("INSERT INTO stock_rank_history VALUES ('r','2026-11-20',?,?,'id',?,NULL,0.75,12.5)")
      .run(version, calculation, '表🚀\nSYM');
  }
  return { db, filename, directory, output: join(directory, 'bundle') };
}

test('archives and idempotently restores only the explicit slice with exact BLOBs and integers', async (t) => {
  const { db, output, directory } = await fixture(t);
  const unrelated = join(directory, 'existing-backup.gz');
  await appendFile(unrelated, 'existing backup');
  assert.throws(() => countDerivedArchive(db, { dataVersion: 18896 }), /explicit calculation version/);
  assert.deepEqual(countDerivedArchive(db, slice), { ...slice, counts });
  const result = await archiveDerived(db, { ...slice, output });
  assert.deepEqual(result.counts, counts);
  assert.deepEqual((await verifyDerivedArchive(output)).counts, counts);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  for (const name of [manifestPath, 'manifest.json']) {
    assert.equal((await stat(join(output, name))).mode & 0o777, 0o600);
  }
  const content = gunzipSync(await readFile(join(output, manifestPath))).toString();
  assert.match(content, /"blob":"AP8MCg2A"/);
  assert.match(content, /"blob":""/);
  assert.equal(content.trimEnd().split('\n').length, 4);
  assert.deepEqual(countDerivedArchive(db, slice).counts, Object.fromEntries(Object.keys(counts).map((key) => [key, 0])));
  assert.deepEqual(countDerivedArchive(db, { ...slice, calculationVersion: '2-foreign' }).counts, counts);
  assert.deepEqual(countDerivedArchive(db, { ...slice, dataVersion: 18895 }).counts, counts);
  assert.equal(db.prepare('SELECT value FROM daily_prices').get().value, 'prices');
  assert.equal(db.prepare('SELECT value FROM workspace').get().value, 'workspace');
  assert.equal(db.prepare('SELECT value FROM journal_entries').get().value, 'notes');
  assert.equal(await readFile(unrelated, 'utf8'), 'existing backup');
  assert.equal(result.checkpoint.busy, 0);

  const restored = await restoreDerived(db, output);
  assert.deepEqual(restored.inserted, counts);
  assert.deepEqual(countDerivedArchive(db, slice).counts, counts);
  const condition = "data_version=18896 AND calculation_version='2-target'";
  assert.deepEqual(Buffer.from(db.prepare(`SELECT value FROM snapshots WHERE ${condition}`).get().value), raw);
  assert.deepEqual(db.prepare(`SELECT typeof(value) AS kind,length(value) AS size FROM market_history WHERE ${condition}`).get(),
    Object.assign(Object.create(null), { kind: 'blob', size: 0 }));
  const rankDate = db.prepare(`SELECT observations FROM rank_archive_dates WHERE ${condition}`);
  rankDate.setReadBigInts(true);
  assert.equal(rankDate.get().observations, 9223372036854775807n);
  const read = db.prepare(`SELECT symbol,rank,percentile,score FROM stock_rank_history WHERE ${condition}`).get();
  assert.deepEqual({ ...read }, { symbol: '表🚀\nSYM', rank: null, percentile: 0.75, score: 12.5 });
  assert.ok(Object.values((await restoreDerived(db, output)).inserted).every((count) => count === 0));
});

test('failed stream verification leaves every selected row in place', async (t) => {
  const { db, output } = await fixture(t);
  await assert.rejects(archiveDerived(db, {
    ...slice, output,
    async onProgress({ phase, directory }) {
      if (phase === 'exported') await appendFile(join(directory, manifestPath), 'corrupted gzip');
    },
  }), /checksum|incorrect|gzip|header|verification/i);
  assert.deepEqual(countDerivedArchive(db, slice).counts, counts);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('a concurrent append or same-count edit aborts deletion and leaves the verified bundle available', async (t) => {
  for (const concurrent of [
    { sql: "INSERT INTO stock_rank_history VALUES ('r','2026-11-20',18896,'2-target','new','NEW',9,0.8,10)", error: /counts changed/, rows: 2 },
    { sql: "UPDATE stock_rank_history SET score=99 WHERE data_version=18896 AND calculation_version='2-target'", error: /rows changed/, rows: 1 },
  ]) {
    await t.test(concurrent.error.source, async (t) => {
      const { db, filename, output } = await fixture(t);
      await assert.rejects(archiveDerived(db, {
        ...slice, output,
        onProgress({ phase }) {
          if (phase !== 'verified') return;
          const writer = new DatabaseSync(filename);
          try { writer.exec(concurrent.sql); } finally { writer.close(); }
        },
      }), concurrent.error);
      assert.deepEqual(countDerivedArchive(db, slice).counts, { ...counts, stock_rank_history: concurrent.rows });
      assert.deepEqual((await verifyDerivedArchive(output)).counts, counts);
    });
  }
});

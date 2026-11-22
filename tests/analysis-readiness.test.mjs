import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analysisWorkspaceScopeHash, readAnalysisReadiness } from '../backend/analysis-readiness.mjs';
import { PREPARED_QUERY_MODE } from '../backend/prepared-query-screen.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, createJob, openDatabase, storeWorkspace, updateJob } from '../backend/database.mjs';
import { createService } from '../backend/service.mjs';

const point = { date: '2026-11-20', dataVersion: 9, calculationVersion: CALCULATION_VERSION };
const otherCalculation = '2-5c01f3f97a24';
const dateFrom = expectedSessions('2015-01-02', point.date).at(-1260);
const digest = 'f'.repeat(64);
const productTables = ['prepared_snapshot_contexts', 'prepared_rank_dates', 'prepared_rank_blocks', 'market_history',
  'prepared_detail_products', 'prepared_detail_blocks', 'prepared_risk_history_runs', 'prepared_risk_history_blocks',
  'prepared_range_history_runs', 'prepared_range_history_blocks', 'prepared_health', 'prepared_nyse_summation'];

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE preparation_publications(
      id TEXT PRIMARY KEY, source_inode TEXT NOT NULL, manifest TEXT NOT NULL, plan_hash TEXT NOT NULL,
      state TEXT NOT NULL, updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE preparation_publication_partitions(
      publication TEXT NOT NULL, ordinal INTEGER NOT NULL, table_name TEXT NOT NULL, first_key TEXT NOT NULL,
      last_key TEXT NOT NULL, keys BLOB NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, state TEXT NOT NULL, staged BLOB, PRIMARY KEY(publication,ordinal)
    ) WITHOUT ROWID;
  `);
  return db;
}

function fullManifest(db) {
  const products = Object.fromEntries(['base', 'velocity', 'ranks', 'breadth', 'monitor', 'detail', 'risk', 'ranges', 'health', 'nyseSummation']
    .map((name) => [name, { expected: 1260, verified: 1260 }]));
  return {
    format: 'market-preparation-publication-1', accepted: true,
    dataVersion: point.dataVersion, calculationVersion: point.calculationVersion, archive: { bytes: 256, sha256: digest },
    verification: { scope: 'all', coverageTarget: 'five-year', dateFrom, dateTo: point.date, sessions: 1260,
      contexts: 87, availableContexts: 87, workspaceScopeHash: analysisWorkspaceScopeHash(db), recipeDigest: digest,
      calibration: 'full', readback: 'all fields on sampled sessions', products },
  };
}

function publication(db, manifest = fullManifest(db), { state = 'verified-awaiting-cutover', tables = productTables, pending } = {}) {
  const text = JSON.stringify(manifest);
  const id = createHash('sha256').update(text).digest('hex');
  db.prepare('INSERT INTO preparation_publications VALUES (?,?,?,?,?,?)')
    .run(id, 'source', text, digest, state, '2026-11-22T12:00:00Z');
  const part = db.prepare("INSERT INTO preparation_publication_partitions VALUES (?,?,?,'[]','[]',x'ff',1260,256,?,?,NULL)");
  for (const [ordinal, table] of tables.entries()) part.run(id, ordinal, table, digest, table === pending ? 'copied' : 'consumed');
  return id;
}

function job(db, type, status, payload = { ...point }) {
  const { id } = createJob(db, type, payload);
  updateJob(db, id, status, status === 'complete' ? 100 : 50);
  return id;
}

test('only a complete exact five-year publication proves readiness', (t) => {
  const db = fixture(t);
  job(db, 'production-precompute', 'complete');
  assert.equal(readAnalysisReadiness(db, point).state, 'incomplete');
  const id = publication(db);
  assert.deepEqual(readAnalysisReadiness(db, point), { ...point, state: 'ready', publicationId: id,
    publishedAt: '2026-11-22T12:00:00Z', dateFrom, sessions: 1260, contexts: 87 });
  for (const different of [{ date: '2026-11-19' }, { dataVersion: 8 }, { dataVersion: 10 }, { calculationVersion: otherCalculation }]) {
    assert.equal(readAnalysisReadiness(db, { ...point, ...different }).state, 'incomplete');
  }
});

test('partial proofs and unconsumed or missing partition families do not count', (t) => {
  for (const issue of ['missing-product', 'short-archive', 'wrong-session-count', 'incomplete-calibration', 'partial-check',
    'missing-partition', 'unconsumed-partition', 'unverified-publication', 'legacy', 'malformed']) {
    const db = fixture(t);
    const manifest = fullManifest(db);
    const options = {};
    if (issue === 'missing-product') delete manifest.verification.products.monitor;
    if (issue === 'short-archive') manifest.verification.sessions = 1259;
    if (issue === 'wrong-session-count') manifest.verification.sessions = manifest.verification.products.nyseSummation.expected =
      manifest.verification.products.nyseSummation.verified = 1261;
    if (issue === 'incomplete-calibration') manifest.verification.calibration = 'recent';
    if (issue === 'partial-check') manifest.verification.products.risk.verified--;
    if (issue === 'missing-partition') options.tables = productTables.filter((table) => table !== 'prepared_detail_blocks');
    if (issue === 'unconsumed-partition') options.pending = 'prepared_detail_blocks';
    if (issue === 'unverified-publication') options.state = 'publishing';
    if (issue === 'legacy') manifest.verification = { contexts: 87, sessions: 1260 };
    if (issue === 'malformed') {
      db.prepare("INSERT INTO preparation_publications VALUES (?,'source','{',?,'verified-awaiting-cutover','2026-11-22')").run(digest, digest);
    } else publication(db, manifest, options);
    assert.equal(readAnalysisReadiness(db, point).state, 'incomplete', issue);
  }
});

test('retries and external builds respect the source generation and do not accept awaiting publication', (t) => {
  const db = fixture(t);
  const older = { ...point, calculationVersion: otherCalculation };
  job(db, 'prepare-context', 'failed', older);
  job(db, 'optimized-five-year', 'failed', { ...older, dataVersion: point.dataVersion - 1 });
  assert.equal(readAnalysisReadiness(db, point).reason, 'no_matching_verified_publication');
  for (const status of ['waiting_for_space', 'building', 'awaiting_publication']) {
    const id = job(db, 'optimized-five-year', status, older);
    assert.deepEqual(readAnalysisReadiness(db, point).job, { id, type: 'optimized-five-year', status, progress: 50, calculationVersion: otherCalculation });
    assert.equal(readAnalysisReadiness(db, point).state, 'preparing');
  }
  publication(db);
  assert.equal(readAnalysisReadiness(db, point).state, 'ready');
  const context = { context: { date: point.date, dataVersion: point.dataVersion }, calculationVersion: point.calculationVersion, jobKey: 'current-preparation' };
  const failed = job(db, 'prepare-context', 'failed', context);
  assert.equal(readAnalysisReadiness(db, point).job.id, failed);
  assert.equal(readAnalysisReadiness(db, point).state, 'incomplete');
  const queued = job(db, 'prepare-context', 'queued', context);
  assert.equal(readAnalysisReadiness(db, point).job.id, queued);
  assert.equal(readAnalysisReadiness(db, point).state, 'preparing');
  updateJob(db, queued, 'complete', 100);
  assert.equal(readAnalysisReadiness(db, point).state, 'ready');
});

test('math definition versions and registered scopes invalidate the proof but unrelated research content does not', (t) => {
  const db = fixture(t);
  const add = (kind, id, definition = {}) => storeWorkspace(db, kind, { name: id, definition }, id);
  add('ranking-model', 'custom');
  add('alert-rule', 'disabled', { type: 'stocks', active: false });
  publication(db);
  add('chartbook-note', 'note');
  add('chartbook', 'book');
  add('watchlist', 'manual');
  add('alert-rule', 'disabled', { type: 'stocks', active: false, field: 'close' });
  assert.equal(readAnalysisReadiness(db, point).state, 'ready');
  add('ranking-model', 'custom', { weights: [1] });
  assert.equal(readAnalysisReadiness(db, point).state, 'incomplete');
  publication(db);
  assert.equal(readAnalysisReadiness(db, point).state, 'ready');
  db.exec("CREATE TABLE preparation_definitions(id TEXT PRIMARY KEY,context TEXT NOT NULL) WITHOUT ROWID; INSERT INTO preparation_definitions VALUES ('new-scope','{}')");
  assert.equal(readAnalysisReadiness(db, point).state, 'incomplete');
});

test('service reports whole-generation readiness separately on a warehouse status read', async (t) => {
  const db = fixture(t);
  const service = createService({ db, workers: false });
  const before = db.prepare('SELECT total_changes() AS changes').get().changes;
  const { body, status } = await service.dispatch({ url: '/api/v1/data/status' });
  assert.equal(status, 200);
  assert.equal(body.calculationVersion, CALCULATION_VERSION);
  assert.deepEqual(body.analysisReadiness, { date: null, dataVersion: 0, calculationVersion: CALCULATION_VERSION,
    state: 'incomplete', reason: 'no_source_data' });
  assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes, before);
});


test('a prepared-data saved query preserves a verified publication until it gains calculation dependencies', (t) => {
  const db = fixture(t);
  const id = publication(db);
  const definition = { preparationMode: PREPARED_QUERY_MODE, dateMode: 'latest', context: {}, filter: null,
    sort: [{ field: 'rsRank', direction: 'asc' }], columns: ['symbol'], search: '', includeUntraded: false };
  storeWorkspace(db, 'screen', { name: 'Prepared leaders', definition }, 'prepared-leaders');
  assert.equal(readAnalysisReadiness(db, point).publicationId, id);
  storeWorkspace(db, 'screen', { name: 'Advanced leaders', definition: { ...definition, context: { windows: [73] } } }, 'prepared-leaders');
  assert.equal(readAnalysisReadiness(db, point).state, 'incomplete');
});

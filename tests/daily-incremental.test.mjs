import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { analysisWorkspaceScopeHash, dailyAnalysisParent, readAnalysisReadiness } from '../backend/analysis-readiness.mjs';
import { prepareBatchedSnapshots } from '../backend/batch-preparation.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, createJob, dataVersion, importDataset, jobById, openDatabase, recordDailyPublication, storeWorkspace, updateJob } from '../backend/database.mjs';
import { PREPARED_QUERY_MODE } from '../backend/prepared-query-screen.mjs';
import { createEngine } from '../backend/engine.mjs';
import { batchPreparationSpecs, preparationSpecs, registerPreparation } from '../backend/preparation.mjs';
import { createPreparedDetailWriter, readPreparedDetail } from '../backend/prepared-details.mjs';
import { calculateRangeMetrics, prepareRangeHistoryBatch, readPreparedRangeMetrics } from '../backend/range-metrics.mjs';
import { createDailyTick } from '../backend/server.mjs';
import { createService, performJob, preparationWorkspaceScopes, prepareNyseSummation, prepareStandardHealth, rangeContext, runQueuedJob, scheduledPrecomputeKey, summationContext } from '../backend/service.mjs';
import { decodeStoredJson } from '../backend/storage-codec.mjs';

const calendar = expectedSessions('2018-01-02', '2025-04-03');
const anchor = '2025-03-28';
const through = calendar.indexOf(anchor);
const symbols = ['AAA', 'BBB', 'SPY', 'VTI'];
const securityId = 'fixture:AAA';
const signature = 'b'.repeat(64);
const productTables = ['prepared_snapshot_contexts', 'prepared_rank_dates', 'prepared_rank_blocks', 'market_history',
  'prepared_detail_products', 'prepared_detail_blocks', 'prepared_risk_history_runs', 'prepared_risk_history_blocks',
  'prepared_range_history_runs', 'prepared_range_history_blocks', 'prepared_health', 'prepared_nyse_summation'];
const families = ['base', 'velocity', 'ranks', 'breadth', 'monitor', 'detail', 'risk', 'ranges', 'health', 'nyseSummation'];

function quote(date, symbol, index) {
  const close = 100 + symbols.indexOf(symbol) * 2 + (index === through - 300 ? 25 : index % 5);
  return { symbol, date, knownAt: date, close, open: close, high: close + 1, low: close - 1, volume: 10_000 };
}

// This test supplies the acceptance envelope that the separate publication verifier
// normally writes. Only the inherited rows used by this fixture's append are built.
function acceptedFixture(db, dataVersion, contexts) {
  db.exec(`CREATE TABLE preparation_publications (id TEXT PRIMARY KEY, manifest TEXT, plan_hash TEXT, state TEXT, updated_at TEXT);
    CREATE TABLE preparation_publication_partitions (publication TEXT,table_name TEXT,count INTEGER,state TEXT);`);
  const manifest = { format: 'market-preparation-publication-1', accepted: true, dataVersion, calculationVersion: CALCULATION_VERSION,
    archive: { bytes: 256, sha256: signature }, verification: { scope: 'all', coverageTarget: 'five-year', dateFrom: calendar[through - 1259],
      dateTo: anchor, sessions: 1260, contexts, availableContexts: contexts, workspaceScopeHash: analysisWorkspaceScopeHash(db),
      recipeDigest: signature, calibration: 'full', readback: 'all fields on sampled sessions',
      products: Object.fromEntries(families.map((family) => [family, { expected: 1260, verified: 1260 }])) } };
  const serialized = JSON.stringify(manifest);
  const id = createHash('sha256').update(serialized).digest('hex');
  db.prepare("INSERT INTO preparation_publications VALUES (?,?,?,'verified-awaiting-cutover','2025-03-28')").run(id, serialized, signature);
  const complete = db.prepare("INSERT INTO preparation_publication_partitions VALUES (?,?,1260,'consumed')");
  for (const table of productTables) complete.run(id, table);
  return id;
}

function baseline(t, { registerFixed = false, provider = 'fixture' } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const prices = calendar.slice(0, through + 1).flatMap((date, index) => symbols.map((symbol) => quote(date, symbol, index)));
  const { version } = importDataset(db, { provider, securities: symbols.map((symbol) => ({ securityId: `fixture:${symbol}`, symbol, name: symbol,
    type: ['SPY', 'VTI'].includes(symbol) ? 'etf' : 'common', exchange: 'NYSE', listingDate: prices[0].date, knownAt: prices[0].date })), prices });
  const engine = createEngine(db);
  if (registerFixed) {
    const { basePoint } = preparationWorkspaceScopes(db, engine, { date: anchor, version });
    registerPreparation(db, basePoint, { followLatest: false });
  }
  const scopes = preparationWorkspaceScopes(db, engine, { date: anchor, version });
  const contexts = batchPreparationSpecs(engine, preparationSpecs(db, engine, scopes.base, { custom: scopes.custom })
    .filter(({ phase }) => phase === 'history')).flatMap(({ contexts }) => contexts)
    .map(({ context, rank }) => ({ config: engine.context(context), rank }));
  const warmup = calendar.slice(through - 264, through + 1);
  prepareBatchedSnapshots(db, engine, contexts.map(({ config }) => ({ config, historyOnly: true })), { dates: warmup.slice(0, -65) });
  prepareBatchedSnapshots(db, engine, contexts, { dates: warmup.slice(-65) });
  for (const { config, rank } of contexts) if (rank) prepareStandardHealth(db, engine, config, { from: calendar[through - 2], limit: 3 });
  const config = rangeContext(engine, scopes.basePoint);
  const instruments = { ...config, referenceMode: 'as-of' };
  const detail = createPreparedDetailWriter(db, engine, instruments, { riskWindows: [] });
  detail.batch([...engine.detailSources(instruments, { securityIds: symbols.map((symbol) => `fixture:${symbol}`) })]);
  assert.equal(prepareRangeHistoryBatch(db, engine, instruments, [20, 252], { dates: [anchor] }).done, true);
  prepareNyseSummation(db, engine, summationContext(db, engine, scopes.basePoint), { batch: true });
  const publicationId = acceptedFixture(db, version, contexts.length);
  return { db, engine, version, publicationId, contexts: contexts.length };
}

async function scheduled(db, index, extra = {}) {
  const date = calendar[index];
  const context = { date };
  const { version } = importDataset(db, { provider: 'fixture', prices: symbols.map((symbol) => quote(date, symbol, index)), ...extra });
  recordDailyPublication(db, { date, rawVersion: version, dataRevision: version, models: [] });
  const job = createJob(db, 'production-precompute', { context: { ...context, dataVersion: version }, scheduledFor: date,
    jobKey: scheduledPrecomputeKey(date, version), analysisGeneration: { calculationVersion: CALCULATION_VERSION, dataVersion: version } });
  const start = performance.now();
  await runQueuedJob(db, job, { provider: new Proxy({}, { get() { throw new Error('Daily preparation tried a provider'); } }) });
  return { point: { date, dataVersion: version, calculationVersion: CALCULATION_VERSION }, job: jobById(db, job.id), elapsedMs: performance.now() - start };
}

test('config uses a verified baseline as the latest ready pin without daily publication or production jobs', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { version } = importDataset(db, { provider: 'fixture', prices: [quote(anchor, 'AAA', through)] });
  const publicationId = acceptedFixture(db, version, 1);
  const service = createService({ db, workers: false, preparedOnly: true });
  const readConfig = async () => {
    const changes = db.prepare('SELECT total_changes() AS changes').get().changes;
    const response = await service.dispatch({ url: '/api/v1/config' });
    assert.equal(response.status, 200, response.body.error);
    assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes, changes);
    return response.body.status;
  };
  const pin = { date: anchor, dataVersion: version, calculationVersion: CALCULATION_VERSION,
    publishedAt: anchor, stage: 'verified-publication' };
  const baselineStatus = await readConfig();
  assert.equal(baselineStatus.state, 'partial');
  assert.equal(baselineStatus.latestPublication, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  assert.equal(baselineStatus.analysisReadiness.publicationId, publicationId);
  assert.deepEqual(baselineStatus.latestAnalysis, pin);
  assert.deepEqual(baselineStatus.currentReadiness, { state: 'ready', date: anchor, dataVersion: version });

  const date = calendar[through + 1];
  const { version: next } = importDataset(db, { provider: 'fixture', prices: [quote(date, 'AAA', through + 1)] });
  recordDailyPublication(db, { date, rawVersion: next, dataRevision: next, models: [] });
  const job = createJob(db, 'production-precompute', { context: { date, dataVersion: next }, jobKey: scheduledPrecomputeKey(date, next),
    analysisGeneration: { calculationVersion: CALCULATION_VERSION, dataVersion: next } });
  updateJob(db, job.id, 'running', 50);
  const pending = await readConfig();
  assert.equal(pending.analysisReadiness.state, 'preparing');
  assert.deepEqual(pending.latestAnalysis, pin);
  assert.deepEqual(pending.currentReadiness, { state: 'prior-revision', date: anchor, dataVersion: version });
  updateJob(db, job.id, 'failed', 0, null, 'Fixture failure');
  const failed = await readConfig();
  assert.equal(failed.analysisReadiness.reason, 'calculation_failed');
  assert.deepEqual(failed.latestAnalysis, pin);
  assert.equal(failed.currentReadiness.state, 'prior-revision');

  // Even legacy job and raw-publication metadata cannot substitute for a missing verified proof.
  updateJob(db, job.id, 'complete', 100, { date, dataVersion: next, calculationVersion: CALCULATION_VERSION });
  assert.deepEqual((await readConfig()).latestAnalysis, pin);
  storeWorkspace(db, 'ranking-model', { name: 'Changed scope', definition: {} }, 'changed-scope');
  const invalidScope = await readConfig();
  assert.equal(invalidScope.analysisReadiness.state, 'incomplete');
  assert.equal(invalidScope.latestAnalysis, null);
  assert.deepEqual(invalidScope.currentReadiness, { state: 'unavailable', date: null, dataVersion: null });
});

test('latest-reference ChartBook defaults stay on the source capture across Eastern midnight and restarts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2025-03-30T01:00:00Z') });
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = calendar.slice(through - 12, through + 1);
  const prices = dates.map((date, index) => quote(date, 'AAA', index));
  const { version } = importDataset(db, { provider: 'fixture', prices, catalogDate: '2025-03-29', classifications: [{
    symbol: 'AAA', system: 'nasdaq', effectiveFrom: anchor, knownAt: anchor, industry: 'Group',
  }] });
  const request = { reference: 'latest', classification: 'nasdaq' };
  const prepare = (input) => {
    const engine = createEngine(db);
    prepareBatchedSnapshots(db, engine, [{ config: engine.context({ ...request, ...input }), rank: false }], { dates });
  };
  prepare({ observedReferenceDate: '2025-03-29' });
  prepare({ observedReferenceDate: anchor });
  const first = createService({ db, workers: false, preparedOnly: true });
  const read = async (service, input = {}) => {
    const qs = new URLSearchParams({ lookback: '2', ...request, ...input });
    const changed = db.prepare('SELECT total_changes() AS n').get().n;
    const response = await service.dispatch({ url: `/api/v1/chartbooks/market/history?${qs}` });
    assert.equal(response.status, 200, response.body.error);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changed);
    return response.body;
  };
  const readyAt = async (service, expected, input) => {
    const result = await read(service, input);
    assert.equal(result.state, 'ready');
    assert.equal(result.prepared, 2);
    assert.equal(result.context.observedReferenceDate, expected);
  };
  await readyAt(first, '2025-03-29');
  t.mock.timers.setTime(Date.parse('2025-03-30T12:00:00Z'));
  await readyAt(first, '2025-03-29');
  const restarted = createService({ db, workers: false, preparedOnly: true });
  await readyAt(restarted, '2025-03-29');
  const explicitLater = await read(restarted, { observedReferenceDate: '2025-03-30' });
  assert.equal(explicitLater.context.observedReferenceDate, '2025-03-30');
  assert.equal(explicitLater.state, 'partial');
  assert.equal(explicitLater.rows.at(-1).state, 'unprepared');
  await readyAt(restarted, anchor, { observedReferenceDate: anchor });
  assert.equal(restarted.workspaceConfiguration().observedReferenceDate, '2025-03-29');

  // A successful reference-only capture is a new source revision, even without a new price session.
  const { version: advanced } = importDataset(db, { provider: 'fixture', dataset: 'new-reference', catalogDate: '2025-03-30', classifications: [{
    symbol: 'AAA', system: 'nasdaq', effectiveFrom: '2025-03-30', knownAt: '2025-03-30', industry: 'New group',
  }] });
  assert.ok(advanced > version);
  prepare({ observedReferenceDate: '2025-03-30' });
  await readyAt(restarted, '2025-03-30');
  await readyAt(restarted, '2025-03-29', { dataVersion: String(version) });
  assert.equal(restarted.workspaceConfiguration().observedReferenceDate, '2025-03-30');
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('explicit later reference requests retain cutoffs that can change stored inputs', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2025-03-30T01:00:00Z') });
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const prices = [quote(anchor, 'AAA', through)];
  const captured = '2025-03-29';
  const later = '2025-03-30';
  const postdated = '2025-03-31';
  const base = importDataset(db, { provider: 'fixture', prices, classifications: [{ symbol: 'AAA', system: 'nasdaq',
    effectiveFrom: captured, effectiveTo: captured, knownAt: captured, industry: 'Expiring group' }] });
  const future = importDataset(db, { provider: 'fixture', instrumentTypes: [{ securityId, effectiveDate: postdated, knownAt: postdated,
    capturedAt: '2025-03-31T20:00:00Z', subtype: 'adr' }] });
  const financial = importDataset(db, { provider: 'fixture', fundamentals: [{ symbol: 'AAA', effectiveDate: captured,
    knownAt: captured, shares: 1_000, marketCap: 100_000 }] });
  const { engine } = createService({ db, workers: false, preparedOnly: true });
  t.mock.timers.setTime(Date.parse('2025-03-31T22:00:00Z'));
  for (const [version, classification, cutoff] of [[base.version, 'nasdaq', later], [financial.version, 'provider', later],
    [future.version, 'provider', postdated]]) {
    const input = { reference: 'latest', dataVersion: version, classification };
    assert.equal(engine.context(input).observedReferenceDate, captured);
    assert.equal(engine.context({ ...input, observedReferenceDate: cutoff }).observedReferenceDate, cutoff);
    assert.throws(() => engine.context({ ...input, observedReferenceDate: '2025-04-01' }), /nonfuture/);
  }
});

test('scheduled clean append reads prepared inputs, writes only new products, and chains proof', async (t) => {
  const precompute = process.env.MARKET_PRECOMPUTE;
  process.env.MARKET_PRECOMPUTE = '1';
  t.after(() => { if (precompute == null) delete process.env.MARKET_PRECOMPUTE; else process.env.MARKET_PRECOMPUTE = precompute; });
  const { db, engine, version, publicationId } = baseline(t);
  const first = await scheduled(db, through + 1);
  assert.equal(first.job.status, 'complete', first.job.error);
  assert.ok(first.job.result.receiptId, JSON.stringify(first.job.result));
  assert.equal(first.point.date, '2025-03-31');
  assert.equal(first.job.result.core.producedSessions, 2);
  const weekly = first.job.result.core.weeklyArchive;
  assert.ok(weekly.references > weekly.snapshotsLoaded, 'overlapping dated dependencies reuse the compact projection');
  assert.ok(weekly.frameProjections > weekly.frameBuckets, 'shared physical buckets decode once for multiple recipes');
  assert.ok(weekly.readMs > 0 && first.job.result.core.planningMs >= 0);
  assert.equal(first.job.result.instruments.coldSecurities, 0);
  assert.equal(first.job.result.instruments.reusedSecurities, symbols.length);
  assert.equal(first.job.result.instruments.boundedSourceSessions, 23 * symbols.length);
  assert.equal(first.job.result.instruments.coldSourceSessions, 0);
  assert.ok(first.job.result.instruments.retainedChartBlocks > 4 * symbols.length);
  assert.equal(first.job.result.instruments.chartBlocksWritten, symbols.length);
  const stored = db.prepare(`SELECT blocks FROM prepared_detail_products WHERE security_id=? AND data_version=? AND anchor_date=?`);
  const before = decodeStoredJson(stored.get(securityId, version, anchor).blocks);
  const after = decodeStoredJson(stored.get(securityId, first.point.dataVersion, first.point.date).blocks);
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
  const firstConfig = rangeContext(engine, engine.context(first.point));
  const cold = [...engine.detailSources(firstConfig, { securityIds: [securityId] })][0];
  const actual = readPreparedDetail(db, firstConfig, securityId, { lookback: 1260 }).detail;
  assert.equal(actual.allTimeHigh, cold.allTimeHigh);
  assert.equal(actual.loadedHistoryHighExpected, cold.loadedHistoryHighExpected);
  assert.deepEqual(actual.chartBars.map((bar) => [bar.date, bar.close, bar.rawVolume, bar.version]),
    cold.chartBars.slice(-1260).map((bar) => [bar.date, bar.close, bar.rawVolume, bar.version]));
  const expectedRanges = calculateRangeMetrics(cold.chartBars, [20, 252], { date: first.point.date, sessions: cold.chartBars.map(({ date }) => date) });
  const actualRanges = readPreparedRangeMetrics(db, firstConfig, [20, 252]);
  assert.ok(expectedRanges.range_since_high_20d > 252);
  assert.equal(actualRanges.values.get(20).get(securityId)[2], expectedRanges.range_since_high_20d);
  assert.equal(actualRanges.values.get(252).get(securityId)[2], expectedRanges.range_since_high_252d);
  assert.equal(actualRanges.values.get(20).get(securityId)[5], expectedRanges.range_age_low_20d);
  const readiness = readAnalysisReadiness(db, first.point);
  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.publicationId, publicationId);
  assert.equal(readiness.sessions, 1261);
  const savedQueryScope = analysisWorkspaceScopeHash(db);
  storeWorkspace(db, 'screen', { name: 'Daily prepared leaders', definition: {
    preparationMode: PREPARED_QUERY_MODE, dateMode: 'latest', context: {}, filter: null,
    sort: [{ field: 'rsRank', direction: 'asc' }], columns: ['symbol'], search: '', includeUntraded: false,
  } }, 'daily-prepared-leaders');
  assert.equal(analysisWorkspaceScopeHash(db), savedQueryScope);
  assert.deepEqual(readAnalysisReadiness(db, first.point), readiness);
  const oldest = db.prepare('SELECT min(date) AS oldest FROM prepared_snapshot_contexts WHERE data_version=?').get(first.point.dataVersion).oldest;
  assert.equal(oldest, anchor);
  const child = await scheduled(db, through + 2);
  assert.equal(child.job.status, 'complete', child.job.error);
  assert.equal(child.point.date, '2025-04-01');
  assert.equal(child.job.result.core.producedSessions, 1);
  assert.equal(readAnalysisReadiness(db, child.point).sessions, 1262);
  t.diagnostic(`Four-security fixture worker ${first.elapsedMs.toFixed(0)} ms first day and ${child.elapsedMs.toFixed(0)} ms next day`);
  const retry = createJob(db, child.job.type, child.job.payload);
  await runQueuedJob(db, retry, { provider: {} });
  const repeated = jobById(db, retry.id);
  assert.equal(repeated.status, 'complete', repeated.error);
  assert.equal(repeated.result.receiptId, child.job.result.receiptId);
  assert.equal(repeated.result.core.producedSessions, 0);
  assert.equal(repeated.result.instruments.chartBlocksWritten, 0);
  const missing = db.prepare(`DELETE FROM prepared_range_history_blocks WHERE date=? AND lookback=20 RETURNING *`).get(child.point.date);
  assert.ok(missing);
  const verifyAgain = createJob(db, child.job.type, child.job.payload);
  await runQueuedJob(db, verifyAgain, { provider: {} });
  assert.match(jobById(db, verifyAgain.id).error, /block count/);
  assert.equal(readAnalysisReadiness(db, child.point).reason, 'calculation_failed');
  db.prepare('INSERT INTO prepared_range_history_blocks VALUES (?,?,?,?,?)').run(...Object.values(missing));
  updateJob(db, verifyAgain.id, 'complete', 100, child.job.result);
  const service = createService({ db, workers: false, preparedOnly: true });
  assert.equal(service.prepareStandard({ date: child.point.date, version: child.point.dataVersion }).queued, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE type IN ('prepare-context','prepare-range-history','prepare-risk-history')").get().n, 0);
  storeWorkspace(db, 'chartbook-note', { name: 'keep', definition: { text: 'notes are independent' } }, 'keep');
  const changes = db.prepare('SELECT total_changes() AS changes').get().changes;
  const configStatus = async () => (await service.dispatch({ url: '/api/v1/config' })).body.status;
  const ready = await configStatus();
  assert.equal(ready.analysisReadiness.state, 'ready');
  assert.deepEqual(ready.latestAnalysis, { ...child.point, publishedAt: ready.analysisReadiness.publishedAt, stage: 'daily-analysis-receipt' });
  assert.deepEqual(ready.currentReadiness, { state: 'ready', date: child.point.date, dataVersion: child.point.dataVersion });
  assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes, changes);
  const savedReceipt = db.prepare('DELETE FROM analysis_daily_receipts WHERE date=? RETURNING *').get(first.point.date);
  assert.equal(readAnalysisReadiness(db, child.point).state, 'incomplete');
  const missingParent = await configStatus();
  assert.equal(missingParent.latestAnalysis.stage, 'verified-publication');
  assert.deepEqual(missingParent.currentReadiness, { state: 'prior-revision', date: anchor, dataVersion: version });
  db.prepare('INSERT INTO analysis_daily_receipts VALUES (?,?,?,?,?,?)').run(...Object.values(savedReceipt));
  assert.equal(readAnalysisReadiness(db, child.point).state, 'ready');
  const invalid = await scheduled(db, through + 3, { prices: [...symbols.map((symbol) => quote(calendar[through + 3], symbol, through + 3)),
    { ...quote(calendar[through - 3], 'AAA', through - 3), volume: 999_999 }] });
  assert.equal(invalid.job.result.analysisPreparation, 'verified_baseline_required');
  assert.notEqual((await service.dispatch({ url: '/api/v1/data/status' })).body.latestAnalysis?.date, invalid.point.date);
});

test('daily receipts retain the root scope when a registered fixed context separates from its rolling context', async (t) => {
  const { db, engine, version, publicationId, contexts } = baseline(t, { registerFixed: true });
  const first = await scheduled(db, through + 1);
  assert.equal(first.job.status, 'complete', first.job.error);
  assert.ok(first.job.result.receiptId, JSON.stringify(first.job.result));
  assert.equal(first.job.result.physicalContexts, contexts + 1);
  assert.equal(first.job.result.fixedContexts, 1);
  const firstReady = readAnalysisReadiness(db, first.point);
  assert.equal(firstReady.state, 'ready');
  assert.equal(firstReady.publicationId, publicationId);
  assert.equal(firstReady.contexts, contexts);
  const second = await scheduled(db, through + 2);
  assert.equal(second.job.status, 'complete', second.job.error);
  assert.ok(second.job.result.receiptId, JSON.stringify(second.job.result));
  assert.equal(second.job.result.physicalContexts, contexts + 1);
  assert.equal(second.job.result.fixedContexts, 1);
  assert.equal(readAnalysisReadiness(db, second.point).sessions, 1262);
  const receipts = db.prepare('SELECT receipt FROM analysis_daily_receipts ORDER BY date').all().map(({ receipt }) => JSON.parse(receipt));
  assert.equal(receipts[0].recipeHash, receipts[1].recipeHash);
  assert.equal(receipts[1].parent.id, first.job.result.receiptId);
  assert.deepEqual(receipts.map((receipt) => receipt.contexts), [contexts, contexts]);

  const newDate = calendar[through - 1];
  const { basePoint } = preparationWorkspaceScopes(db, engine, { date: newDate, version });
  const added = registerPreparation(db, basePoint, { followLatest: false });
  const rejected = await scheduled(db, through + 3);
  assert.equal(rejected.job.result.analysisPreparation, 'verified_baseline_required');
  assert.equal(readAnalysisReadiness(db, rejected.point).state, 'incomplete');

  db.prepare('DELETE FROM preparation_definitions WHERE id=?').run(added);
  assert.equal(dailyAnalysisParent(db, rejected.point)?.id, second.job.result.receiptId);
  const { changes } = db.prepare('DELETE FROM prepared_snapshot_contexts WHERE date=? AND data_version=?').run(anchor, version);
  assert.ok(changes > 0);
  const retry = createJob(db, rejected.job.type, rejected.job.payload);
  await runQueuedJob(db, retry, { provider: {} });
  const missing = jobById(db, retry.id);
  assert.equal(missing.status, 'complete', missing.error);
  assert.equal(missing.result.analysisPreparation, 'verified_baseline_required');
  assert.equal(readAnalysisReadiness(db, rejected.point).state, 'incomplete');
});

test('a verified build pins direct raw imports and overrides without locking research writes', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const base = importDataset(db, { provider: 'fixture', prices: [quote(anchor, 'AAA', through)] });
  const build = createJob(db, 'optimized-five-year', { dataVersion: base.version });
  updateJob(db, build.id, 'building', 10);
  const service = createService({ db, workers: false });
  const post = (item, body) => service.dispatch({ method: 'POST', url: `/api/v1/${item}`, body });
  const batch = { provider: 'fixture', prices: [quote(calendar[through + 1], 'AAA', through + 1)] };
  assert.equal((await post('data/import', batch)).status, 409);
  assert.equal((await post('data/quality/overrides', { securityId })).status, 409);
  assert.equal(dataVersion(db), base.version);
  assert.equal((await post('chartbooks', { name: 'Private research', definition: { sources: [{ type: 'manual', members: ['AAA'] }] } })).status, 201);
  updateJob(db, build.id, 'awaiting_publication', 97);
  assert.equal((await post('data/import', batch)).status, 409);
  updateJob(db, build.id, 'complete', 100);
  assert.equal((await post('data/import', batch)).status, 201);
  assert.equal(dataVersion(db), base.version + 1);
});

test('scheduled preparation without a verified baseline records a backfill requirement without calculating', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  importDataset(db, { provider: 'fixture', prices: symbols.map((symbol) => quote(anchor, symbol, through)) });
  const result = await scheduled(db, through + 1);
  assert.equal(result.job.status, 'complete', result.job.error);
  assert.equal(result.job.result.analysisPreparation, 'verified_baseline_required');
  assert.equal(readAnalysisReadiness(db, result.point).reason, 'verified_baseline_required');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_snapshot_contexts'").get(), undefined);
});

test('automatic catch-up captures and proves Monday before opening Tuesday', async (t) => {
  const { db, version, publicationId } = baseline(t, { provider: 'eodhd' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2025-04-02T01:00:00Z') });
  const previous = process.env.MARKET_PRECOMPUTE;
  process.env.MARKET_PRECOMPUTE = '1';
  t.after(() => { if (previous == null) delete process.env.MARKET_PRECOMPUTE; else process.env.MARKET_PRECOMPUTE = previous; });
  const monday = calendar[through + 1];
  const tuesday = calendar[through + 2];
  const downloads = [];
  const service = createService({ db, workers: false, preparedOnly: true, provider: {
    getSecurities: async () => symbols.map((symbol) => ({ symbol, name: symbol,
      type: ['SPY', 'VTI'].includes(symbol) ? 'etf' : 'common', exchange: 'NYSE' })),
    getDailyPrices: async ({ date }) => {
      if (date === tuesday) {
        const mondayPoint = { date: monday, dataVersion: dataVersion(db), calculationVersion: CALCULATION_VERSION };
        assert.equal(readAnalysisReadiness(db, mondayPoint).state, 'ready', 'Tuesday may not write before Monday has an exact proof');
      }
      downloads.push(date);
      return symbols.map((symbol) => quote(date, symbol, calendar.indexOf(date)));
    },
    getCorporateActions: async () => [],
  } });
  const config = { MARKET_PRECOMPUTE: '1' };
  const makeTick = () => createDailyTick(service, db, { providerEnabled: true, config });
  let tick = makeTick();
  const jobId = (type, day) => db.prepare(`SELECT id FROM jobs WHERE type=? AND
    coalesce(json_extract(payload,'$.scheduledFor'),json_extract(payload,'$.date'))=?`).get(type, day)?.id;
  const outcome = async (id) => {
    assert.ok(id);
    for (let attempt = 0; attempt < 500; attempt++) {
      const job = jobById(db, id);
      if (job.status !== 'queued' && job.status !== 'running') {
        assert.equal(job.status, 'complete', job.error);
        return job.result;
      }
      await delay(10);
    }
    assert.fail('The fixture job did not finish');
  };
  const tuesdayCapture = { bulk: true, date: tuesday, verifiedOnly: true, skipCaptured: true, orderedDaily: true };
  const postTuesday = () => service.dispatch({ method: 'POST', url: '/api/v1/data/refresh', body: tuesdayCapture });

  const premature = await postTuesday();
  assert.equal(premature.status, 409);
  assert.match(premature.body.error, new RegExp(monday));
  const legacyCapture = { ...tuesdayCapture, orderedDaily: undefined, scheduledFor: tuesday, captureAttempt: 1 };
  for (const payload of [tuesdayCapture, legacyCapture]) {
    await assert.rejects(performJob(db, 'provider-import', payload,
      { provider: new Proxy({}, { get() { assert.fail('stale job touched provider'); } }) }), /Capture and finish verified full analysis/);
  }
  assert.equal(dataVersion(db), version);

  tick();
  tick();
  assert.equal(jobId('provider-import', tuesday), undefined);
  assert.deepEqual((await outcome(jobId('provider-import', monday))).published, [monday]);
  assert.deepEqual(downloads, [monday]);
  tick = makeTick();
  tick();
  assert.equal(jobId('provider-import', tuesday), undefined);
  assert.equal((await postTuesday()).status, 409);
  const mondayResult = await outcome(jobId('production-precompute', monday));
  assert.ok(mondayResult.receiptId, JSON.stringify(mondayResult));

  tick();
  const coalesced = await postTuesday();
  assert.equal(coalesced.status, 202, coalesced.body.error);
  assert.equal(coalesced.body.id, jobId('provider-import', tuesday));
  assert.deepEqual((await outcome(coalesced.body.id)).published, [tuesday]);
  tick();
  const tuesdayResult = await outcome(jobId('production-precompute', tuesday));
  assert.ok(tuesdayResult.receiptId, JSON.stringify(tuesdayResult));
  const ready = (await service.dispatch({ url: '/api/v1/data/status' })).body.analysisReadiness;
  assert.equal(ready.state, 'ready');
  assert.equal(ready.date, tuesday);
  assert.equal(ready.publicationId, publicationId);
  assert.equal(ready.sessions, 1262);
  const mondayProof = await service.dispatch({ url: `/api/v1/data/analysis-proof?date=${monday}` });
  assert.equal(mondayProof.status, 200);
  assert.deepEqual(mondayProof.body.proof, { date: monday, dataVersion: mondayResult.dataVersion,
    calculationVersion: CALCULATION_VERSION, stage: 'daily-analysis-receipt',
    publishedAt: db.prepare('SELECT created_at FROM analysis_daily_receipts WHERE date=?').get(monday).created_at });
  assert.deepEqual(downloads, [monday, tuesday]);
});

test('automatic catch-up stops source changes when later raw dates are already staged without their proofs', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { version } = importDataset(db, { provider: 'eodhd', prices: [quote(anchor, 'AAA', through)],
    securities: [{ symbol: 'AAA', name: 'AAA', exchange: 'NYSE', type: 'common', listingDate: anchor, knownAt: anchor }] });
  acceptedFixture(db, version, 1);
  const later = calendar[through + 2];
  for (let index = through + 1; index <= through + 2; index++) {
    const date = calendar[index];
    const { version } = importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 1,
      expectedRoster: [{ symbol: 'AAA' }], prices: [quote(date, 'AAA', index)] });
    recordDailyPublication(db, { date, rawVersion: version, dataRevision: version, models: [] });
  }
  const service = createService({ db, workers: false, preparedOnly: true });
  const queued = [];
  const tick = createDailyTick({ ...service, enqueue(type, payload, key) {
    queued.push(createJob(db, type, { ...payload, jobKey: key,
      analysisGeneration: { calculationVersion: CALCULATION_VERSION, dataVersion: dataVersion(db) } }));
  } }, db, { providerEnabled: true, now: () => new Date('2025-04-02T22:00:00Z'),
    config: { MARKET_PRECOMPUTE: '1', MARKET_NASDAQ_SYNC: '1', MARKET_REFERENCE_SYNC: '1' } });
  const rawVersion = dataVersion(db);
  await assert.rejects(performJob(db, 'provider-reference', { orderedDaily: true, scheduledFor: later },
    { provider: new Proxy({}, { get() { assert.fail('reference job touched the provider despite a proof gap'); } }) }),
  /no longer owns an eligible analysis session/);
  assert.equal(dataVersion(db), rawVersion);
  tick();
  assert.deepEqual(queued.map(({ type, payload }) => [type, payload.scheduledFor]), [['production-precompute', later]]);
  await runQueuedJob(db, queued[0], { provider: {} });
  const status = (await service.dispatch({ url: '/api/v1/data/status' })).body;
  assert.equal(status.analysisReadiness.reason, 'verified_baseline_required');
  assert.equal(status.latestAnalysis.date, anchor);
  const missing = await service.dispatch({ url: `/api/v1/data/analysis-proof?date=${calendar[through + 1]}` });
  assert.deepEqual(missing.body, { proof: null });
  assert.equal(dataVersion(db), rawVersion);
  tick();
  assert.equal(queued.length, 1, 'a known gap does not trigger a future capture or reference refresh');
});

test('a manually staged price gap without capture receipts reports backfill without pulling a source', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { version } = importDataset(db, { provider: 'fixture', prices: [quote(anchor, 'AAA', through)] });
  acceptedFixture(db, version, 1);
  const latest = calendar[through + 2];
  importDataset(db, { provider: 'fixture', prices: [quote(calendar[through + 1], 'AAA', through + 1), quote(latest, 'AAA', through + 2)] });
  const service = createService({ db, workers: false, preparedOnly: true });
  const tick = createDailyTick({ ...service, enqueue() { assert.fail('a known gap cannot be repaired by a source refresh'); } },
    db, { providerEnabled: true, config: { MARKET_PRECOMPUTE: '1' }, now: () => new Date('2025-04-02T22:00:00Z') });
  tick();
  const outcome = await service.dispatch({ url: '/api/v1/data/status' });
  assert.equal(outcome.body.analysisReadiness.reason, 'verified_baseline_required');
  assert.equal(outcome.body.latestAnalysis.date, anchor);
  const blocked = await service.dispatch({ method: 'POST', url: '/api/v1/data/refresh',
    body: { date: latest, bulk: true, verifiedOnly: true, orderedDaily: true } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /without verified analysis for an intervening session/);
});

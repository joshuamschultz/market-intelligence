import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { analysisWorkspaceScopeHash } from '../backend/analysis-readiness.mjs';
import { createResearchEngine } from '../backend/ai-research.mjs';
import { invokeResearchTool } from '../backend/ai-tools.mjs';
import { prepareBatchedSnapshots } from '../backend/batch-preparation.mjs';
import { calculateGroups } from '../backend/breadth.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, dataVersion, importDataset, openDatabase } from '../backend/database.mjs';
import { attachGroupMembershipVelocity, groupComparisonDates, prepareGroupMembershipVelocity, prepareGroupMemberships,
  readGroupMembershipVelocity } from '../backend/group-velocity.mjs';
import { prepareDailyAnalysis } from '../backend/daily-analysis.mjs';
import { saveJournalSettings } from '../backend/journal.mjs';
import { batchPreparationSpecs, createPreparedRankWriter, preparationSpecs, readPreparedRankPercentiles, verifyPreparedRankCoverage } from '../backend/preparation.mjs';
import { createPreparedDetailWriter } from '../backend/prepared-details.mjs';
import { readPreparedSnapshot, readPreparedSnapshotRankWitnesses, writePreparedSnapshotBatch } from '../backend/prepared-snapshots.mjs';
import { prepareRangeHistoryBatch } from '../backend/range-metrics.mjs';
import { createService, createServiceEngine, performJob, preparationWorkspaceScopes, prepareNyseSummation, prepareStandardHealth,
  rangeContext, summationContext } from '../backend/service.mjs';

const anchor = '2025-05-14';
const capture = '2025-05-15';
const comparisons = groupComparisonDates(anchor);
const sessions = expectedSessions('2018-01-02', anchor).slice(-1260);
const symbols = ['AAA', 'BBB', 'CCC'];
const query = 'classification=nasdaq&reference=latest';
const toolPrincipal = { scopes: ['research:read'] };
const option = { classification: 'nasdaq', reference: 'latest' };

function makeQuote(symbol, date) {
  return { symbol, date, knownAt: date, open: 10, high: 11, low: 9, close: 10, volume: 1000 };
}

function proof(db, config, contexts = 1) {
  const sig = 'c'.repeat(64);
  const tables = ['prepared_snapshot_contexts', 'prepared_rank_dates', 'prepared_rank_blocks', 'market_history',
    'prepared_detail_products','prepared_detail_blocks','prepared_risk_history_runs','prepared_risk_history_blocks',
    'prepared_range_history_runs','prepared_range_history_blocks','prepared_health','prepared_nyse_summation'];
  const names = ['base','velocity','ranks','breadth','monitor','detail','risk','ranges','health','nyseSummation'];
  const record = JSON.stringify({ format: 'market-preparation-publication-1', accepted: true, calculationVersion: CALCULATION_VERSION,
    dataVersion: config.dataVersion, archive: { sha256: sig, bytes: 100 }, verification: { scope: 'all', coverageTarget: 'five-year',
      dateFrom: sessions[0], dateTo: config.date, workspaceScopeHash: analysisWorkspaceScopeHash(db), recipeDigest: sig,
      sessions: 1260, contexts, availableContexts: contexts, calibration: 'full', readback: 'all fields on sampled sessions',
      products: Object.fromEntries(names.map((name) => [name, { expected: 1260, verified: 1260 }])) } });
  const id = createHash('sha256').update(record).digest('hex');
  db.exec('CREATE TABLE preparation_publications (id TEXT, manifest TEXT, plan_hash TEXT, state TEXT, updated_at TEXT);' +
    'CREATE TABLE preparation_publication_partitions (publication TEXT,table_name TEXT,count INTEGER,state TEXT);');
  db.prepare("INSERT INTO preparation_publications VALUES (?,?,?,'verified-awaiting-cutover',?)").run(id, record, sig, config.date);
  for (const table of tables) db.prepare("INSERT INTO preparation_publication_partitions VALUES (?,?,1260,'consumed')").run(id, table);
}

function fixture(t, { missing = null, filepath = ':memory:', dated = false } = {}) {
  const db = openDatabase(filepath);
  t.after(() => db.close());
  const dates = [anchor, ...Object.values(comparisons)];
  const securities = symbols.map((symbol) => ({ symbol, name: symbol, exchange: 'NYSE', listingDate: sessions[0],
    knownAt: sessions[0], type: 'common' }));
  const { version } = importDataset(db, { provider: 'nasdaq', dataset: 'stocks-screener:fixture', catalogDate: capture, securities,
    prices: dates.flatMap((date) => symbols.map((symbol) => makeQuote(symbol, date))),
    classifications: symbols.map((symbol, index) => ({ symbol, system: 'nasdaq', sector: 'Technology', industry: 'Group ' + index,
      effectiveFrom: capture, knownAt: capture })) });
  db.prepare('UPDATE ingestion_runs SET finished_at=? WHERE version=?').run(capture + 'T16:00:00Z', version);
  const engine = createServiceEngine(db);
  const config = engine.context(option);
  assert.equal(config.observedReferenceDate, capture);
  const writeRank = createPreparedRankWriter(db, config, dates);
  const scores = new Map([[anchor, [10, 50, 90]], [comparisons['4w'], [90, 50, 10]], [comparisons['12w'], [50, 90, 10]]]);
  let anchorSnapshot;
  for (const date of dates) {
    const spec = { ...config, date, requestedDate: date, ...(date !== anchor && { referenceMode: 'as-of' }) };
    const stocks = symbols.map((symbol, i) => ({ securityId: 'nasdaq:' + symbol, symbol, traded: true,
      rsPercentile: scores.get(date)[i], rsRank: i + 1, rsScore: scores.get(date)[i] }));
    const groups = calculateGroups(stocks.map((row, i) => ({ ...row, sector: 'Technology', industry: 'Group ' + i })), [], date, 0);
    const snapshot = { date, dataVersion: version, calculationVersion: CALCULATION_VERSION, benchmark: config.benchmark, basis: config.basis,
      universe: config.universe, model: config.model, classificationSystem: 'nasdaq', referenceDate: date === anchor ? capture : date,
      referenceMode: spec.referenceMode, groups, stocks, coverage: { state: 'partial', traded: stocks.length, listed: stocks.length },
      breadth: {}, aggregates: {} };
    if (date === anchor) anchorSnapshot = snapshot;
    if (date === missing) continue;
    const velocity = { ...snapshot, groups: groups.map((group) => ({ ...group, velocity4w: dated ? 5 : null, velocity12w: dated ? 7 : null,
      rankChange4w: null, rankChange12w: null })) };
    writePreparedSnapshotBatch(db, engine, [{ config: spec, snapshot, rankWitness: true },
      { config: spec, snapshot: velocity, velocity: true }]);
    writeRank(snapshot);
  }
  return { db, engine, config, anchorSnapshot, version };
}

test('prepares only exact rank evidence, coalesces repeated scopes, and passive APIs expose one chosen membership basis', async (t) => {
  const { db, engine, config, version } = fixture(t);
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const service = createService({ db, preparedOnly: true, workers: false });
  const read = (path) => service.dispatch({ url: '/api/v1/' + path });
  const before = changes();
  const absent = await read(`industries?${query}&level=industry`);
  assert.equal(absent.body.groupMembershipProjection.state, 'unprepared');
  assert.equal(changes(), before);
  proof(db, config);
  const summary = prepareGroupMemberships(db, engine, [config, { ...config, breadthKeys: ['down_13pct_34d'] }]);
  assert.equal(summary.prepared, 1);
  assert.equal(summary.scopes, 1);
  assert.equal(summary.results[0].classificationCaptureDate, capture);
  assert.ok(Object.values(summary.results[0].rankSources).every((source) => source.blockCount <= 32));
  assert.equal(dataVersion(db), version);

  const prior = changes();
  const list = await read(`industries?${query}&level=industry`);
  assert.equal(list.status, 200);
  assert.equal(list.body.groupMembershipProjection.state, 'ready');
  assert.deepEqual(list.body.groupMembershipProjection.comparisonDates, comparisons);
  const strongest = list.body.groups.find((group) => group.name === 'Group 2');
  assert.equal(strongest.velocity12w, null);
  assert.equal(strongest.currentMembership.velocity12w, 100);
  assert.equal(strongest.currentMembership.horizons['12w'].peerCount, 3);
  const detail = await read(`industries/${encodeURIComponent(strongest.id)}?${query}`);
  assert.deepEqual(detail.body.currentMembership, strongest.currentMembership);
  assert.equal(detail.body.groupMembershipProjection.anchorDate, anchor);
  const overview = await read(`market/overview?${query}`);
  assert.equal(overview.body.groupMembershipProjection.state, 'ready');
  assert.deepEqual(overview.body.groups.find(({ id }) => id === strongest.id).currentMembership, strongest.currentMembership);

  const research = createResearchEngine(db);
  const run = (input) => invokeResearchTool(research, toolPrincipal, 'industry_strength', input);
  const current = await run({});
  assert.equal(current.rows[0].name, strongest.name);
  assert.equal(current.data.membership, 'current-membership');
  assert.equal(current.rows[0].value, 100);
  const historical = await run({ membership: 'dated' });
  assert.equal(historical.data.membership, 'dated-membership');
  assert.ok(historical.rows.every(({ value, currentMembership }) => value === null && currentMembership === undefined));
  assert.equal(changes(), prior);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  assert.equal(readGroupMembershipVelocity(db, { ...config, referenceMode: 'as-of' }), null);
  assert.equal(readGroupMembershipVelocity(db, { ...config, observedReferenceDate: '2025-05-16' }).state, 'unprepared');
  assert.equal(readGroupMembershipVelocity(db, { ...config, dataVersion: version + 1 }).state, 'unprepared');
  assert.equal(prepareGroupMembershipVelocity(db, engine, config).reused, true);
  assert.equal(changes(), prior);
});

test('distinguishes absent exact dates and damaged rank buckets, including evidence cache reuse', (t) => {
  const { db, engine, config } = fixture(t, { missing: comparisons['4w'] });
  const partial = prepareGroupMembershipVelocity(db, engine, config);
  assert.equal(partial.state, 'partial');
  const saved = readGroupMembershipVelocity(db, config);
  assert.ok(saved.groups.every((item) => item.horizons['4w'].reason === 'rank_date_unprepared'));
  assert.ok(saved.groups.some((item) => item.horizons['12w'].state === 'ready'));
  const dates = [anchor, comparisons['12w']];
  const witnesses = readPreparedSnapshotRankWitnesses(db, engine, config, dates);
  const cache = new Map();
  assert.equal(verifyPreparedRankCoverage(db, config, dates, witnesses, cache).dates, 2);
  assert.equal(readPreparedRankPercentiles(db, config, dates, witnesses, cache).get(anchor).percentiles.size, 3);
  const remove = db.prepare('SELECT recipe,data_version,date,bucket FROM prepared_rank_blocks WHERE date=? LIMIT 1').get(comparisons['12w']);
  db.prepare('DELETE FROM prepared_rank_blocks WHERE recipe=? AND data_version=? AND date=? AND bucket=?')
    .run(remove.recipe, remove.data_version, remove.date, remove.bucket);
  assert.throws(() => prepareGroupMembershipVelocity(db, engine, config, { force: true }), /disagree with the saved traded-stock roster/);
  assert.deepEqual(readGroupMembershipVelocity(db, config), saved, 'failed replay cannot replace accepted output');
});

test('readonly storage and the mock journal receive the exact supplemental projection, with canonical fields intact', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'membership-journal-'));
  const filepath = join(directory, 'market.sqlite');
  const { db, engine, config, anchorSnapshot } = fixture(t, { filepath });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  prepareGroupMembershipVelocity(db, engine, config);
  const readonly = new DatabaseSync(filepath, { readOnly: true });
  try {
    const canonical = readPreparedSnapshot(readonly, engine, config, { velocity: true });
    const attached = attachGroupMembershipVelocity(readonly, config, canonical);
    assert.ok(attached.groups.some((group) => group.currentMembership?.velocity12w === 100));
    assert.ok(canonical.groups.every((group) => group.currentMembership === undefined));
  } finally { readonly.close(); }

  db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?)').run('market', anchor, 'us-core@1', 'composite@1', config.dataVersion,
    CALCULATION_VERSION, engine.definitionKey(config), JSON.stringify(anchorSnapshot), new Date().toISOString());
  const oldKeyFile = process.env.MARKET_JOURNAL_KEY_FILE;
  process.env.MARKET_JOURNAL_KEY_FILE = join(directory, '.journal-key');
  t.after(() => {
    if (oldKeyFile == null) delete process.env.MARKET_JOURNAL_KEY_FILE;
    else process.env.MARKET_JOURNAL_KEY_FILE = oldKeyFile;
  });
  saveJournalSettings(db, { apiKey: 'sk-ant-mock-only', enabled: true });
  let selected;
  await performJob(db, 'journal-generate', { asOfDate: anchor, context: { ...option, dataVersion: config.dataVersion } }, {
    journalClient: async ({ user }) => {
      selected = JSON.parse(user).market;
      return { title: 'Fixture', markdown: 'Fixture body', sentiment: 'neutral', sentiment_score: 0, market_health: 5,
        risk_posture: 'selective', confidence: 5, factors: [] };
    },
  });
  assert.equal(selected.date, anchor);
  assert.equal(selected.dataVersion, config.dataVersion);
  assert.equal(selected.groupMembershipProjection.classificationCaptureDate, capture);
  assert.ok(selected.groups.some(({ currentMembership }) => currentMembership?.velocity12w === 100));
});

test('an append reuses only lineage-safe prior ranks and computes its new anchor independently', (t) => {
  const { db, engine, config, anchorSnapshot, version } = fixture(t);
  const old = prepareGroupMembershipVelocity(db, engine, config);
  assert.equal(old.state, 'ready');
  const nextDay = '2025-05-15';
  const { version: childVersion } = importDataset(db, { provider: 'nasdaq', dataset: 'daily-append-fixture',
    prices: symbols.map((symbol) => makeQuote(symbol, nextDay)) });
  db.prepare('UPDATE ingestion_runs SET finished_at=? WHERE version=?').run(capture + 'T17:00:00Z', childVersion);
  const next = engine.context(option);
  const snapshot = { ...anchorSnapshot, date: nextDay, dataVersion: childVersion, referenceDate: nextDay };
  writePreparedSnapshotBatch(db, engine, [{ config: next, snapshot, rankWitness: true }]);
  createPreparedRankWriter(db, next, [nextDay])(snapshot);
  const append = prepareGroupMembershipVelocity(db, engine, next);
  assert.equal(append.state, 'ready');
  assert.equal(append.dataVersion, childVersion);
  assert.equal(append.anchorDate, nextDay);
  assert.equal(append.rankSources[nextDay].dataVersion, childVersion);
  assert.equal(append.rankSources[comparisons['4w']].dataVersion, version);
  assert.equal(append.rankSources[comparisons['12w']].dataVersion, version);
  const scoped = readGroupMembershipVelocity(db, next).groups;
  assert.deepEqual(scoped, readGroupMembershipVelocity(db, config).groups);
  prepareGroupMembershipVelocity(db, engine, next, { force: true });
  assert.deepEqual(readGroupMembershipVelocity(db, next).groups, scoped, 'cold replay and daily inherited rank inputs agree');

  const { version: correctedVersion } = importDataset(db, { provider: 'nasdaq', dataset: 'earlier-correction-fixture',
    prices: [{ ...makeQuote(symbols[0], comparisons['4w']), volume: 912 }] });
  db.prepare('UPDATE ingestion_runs SET finished_at=? WHERE version=?').run(capture + 'T18:00:00Z', correctedVersion);
  const corrected = engine.context(option);
  const correctedAnchor = { ...snapshot, dataVersion: correctedVersion };
  writePreparedSnapshotBatch(db, engine, [{ config: corrected, snapshot: correctedAnchor, rankWitness: true }]);
  createPreparedRankWriter(db, corrected, [nextDay])(correctedAnchor);
  const unavailable = prepareGroupMembershipVelocity(db, engine, corrected);
  assert.equal(unavailable.state, 'partial');
  assert.equal(unavailable.rankSources[comparisons['4w']].reason, 'rank_date_unprepared');
  assert.equal(unavailable.rankSources[comparisons['12w']].dataVersion, version);
  assert.equal(readGroupMembershipVelocity(db, corrected).groups[0].velocity4w, null);
});

test('AI auto keeps the saved native basis when native comparisons already exist', async (t) => {
  const { db, engine, config } = fixture(t, { dated: true });
  proof(db, config);
  prepareGroupMembershipVelocity(db, engine, config);
  const research = createResearchEngine(db);
  const result = await invokeResearchTool(research, toolPrincipal, 'industry_strength', {});
  assert.equal(result.data.membership, 'dated-membership');
  assert.ok(result.rows.every(({ value }) => value === 7));
  const explicit = await invokeResearchTool(research, toolPrincipal, 'industry_strength', { membership: 'current' });
  assert.equal(explicit.data.membership, 'current-membership');
  assert.equal(explicit.rows[0].value, 100);
});

test('scheduled daily verification rejects a missing admitted anchor before writing its daily receipt', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const calendar = expectedSessions('2018-01-02', anchor);
  const sample = ['ONE', 'TWO', 'SPY', 'VTI'];
  const securities = sample.map((symbol, i) => ({ symbol, name: symbol, type: i < 2 ? 'common' : 'etf', exchange: 'NYSE',
    listingDate: calendar[0], knownAt: calendar[0] }));
  const bars = (date, index) => sample.map((symbol, i) => {
    const close = 100 + (index % 5) + i;
    return { ...makeQuote(symbol, date), open: close, close, high: close + 1, low: close - 1 };
  });
  const { version } = importDataset(db, { provider: 'fixture', securities, prices: calendar.flatMap(bars) });
  const engine = createServiceEngine(db);
  const scopes = preparationWorkspaceScopes(db, engine, { date: anchor, version });
  const contexts = batchPreparationSpecs(engine, preparationSpecs(db, engine, scopes.base, { custom: scopes.custom })
    .filter(({ phase }) => phase === 'history')).flatMap(({ contexts }) => contexts)
    .map(({ context, rank }) => ({ config: engine.context(context), rank }));
  const warmup = calendar.slice(-265);
  prepareBatchedSnapshots(db, engine, contexts.map(({ config }) => ({ config, historyOnly: true })), { dates: warmup.slice(0, -65) });
  prepareBatchedSnapshots(db, engine, contexts, { dates: warmup.slice(-65) });
  for (const { config, rank } of contexts) {
    if (rank) prepareStandardHealth(db, engine, config, { from: calendar.at(-3), limit: 3 });
  }
  const range = rangeContext(engine, scopes.basePoint);
  const instruments = { ...range, referenceMode: 'as-of' };
  createPreparedDetailWriter(db, engine, instruments, { riskWindows: [] })
    .batch([...engine.detailSources(instruments, { securityIds: sample.map((symbol) => 'fixture:' + symbol) })]);
  assert.equal(prepareRangeHistoryBatch(db, engine, instruments, [20, 252], { dates: [anchor] }).done, true);
  prepareNyseSummation(db, engine, summationContext(db, engine, scopes.basePoint), { batch: true });
  proof(db, scopes.basePoint, contexts.length);

  const date = '2025-05-15';
  const { version: revision } = importDataset(db, { provider: 'fixture', prices: bars(date, calendar.length) });
  const point = engine.context({ date, dataVersion: revision });
  let called = false;
  assert.throws(() => prepareDailyAnalysis(db, engine, point, {
    workspaceScopes: preparationWorkspaceScopes, rangeContext, summationContext, prepareStandardHealth,
    prepareProxies: () => ({}), progress() {},
    prepareMembership(current, scheduled) {
      assert.equal(current.date, date);
      assert.equal(current.dataVersion, revision);
      assert.ok(scheduled.some(({ rank }) => rank));
      called = true;
      return { results: [{ state: 'unprepared', scope: { universe: 'us-core', model: 'composite' }, reason: 'rank_witness_unprepared' }] };
    },
    finalizeAlerts: () => assert.fail('missing anchor was allowed to pass the group verification stage'),
  }), /Missing prepared current group membership for us-core\/composite: rank_witness_unprepared/);
  assert.equal(called, true);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='analysis_daily_receipts'").get(), undefined);
});

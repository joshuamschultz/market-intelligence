import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analysisWorkspaceScopeHash } from '../backend/analysis-readiness.mjs';
import { createResearchEngine } from '../backend/ai-research.mjs';
import { invokeResearchTool } from '../backend/ai-tools.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, importDataset, marketDay, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { createMaterializedHistoryWriter } from '../backend/materialization.mjs';
import { createPreparedRankWriter } from '../backend/preparation.mjs';
import { createPreparedDetailWriter } from '../backend/prepared-details.mjs';
import { writePreparedSnapshot } from '../backend/prepared-snapshots.mjs';
import { prepareStandardHealth } from '../backend/service.mjs';
import { prepareSummation } from '../backend/summation.mjs';

const archive = expectedSessions('2018-01-02', '2025-03-31').slice(-1260);
const dates = archive.slice(-270);
const anchor = dates.at(-1);
const threshold = 8.123456789;
const metric = 'down_25pct_63d';
const principal = { id: 'fixture', scopes: ['research:read'] };
const families = ['base', 'velocity', 'ranks', 'breadth', 'monitor', 'detail', 'risk', 'ranges', 'health', 'nyseSummation'];
const productTables = ['prepared_snapshot_contexts', 'prepared_rank_dates', 'prepared_rank_blocks', 'market_history', 'prepared_detail_products',
  'prepared_detail_blocks', 'prepared_risk_history_runs', 'prepared_risk_history_blocks', 'prepared_range_history_runs', 'prepared_range_history_blocks',
  'prepared_health', 'prepared_nyse_summation'];

function approve(db, version) {
  // Test only the accepted envelope and independently written fixtures this consumer reads.
  db.exec(`CREATE TABLE preparation_publications (id TEXT PRIMARY KEY, manifest TEXT, plan_hash TEXT, state TEXT, updated_at TEXT);
    CREATE TABLE preparation_publication_partitions (publication TEXT,table_name TEXT,count INTEGER,state TEXT);`);
  const signature = 'a'.repeat(64);
  const manifest = JSON.stringify({ format: 'market-preparation-publication-1', accepted: true, dataVersion: version,
    calculationVersion: CALCULATION_VERSION, archive: { bytes: 400, sha256: signature }, verification: {
      scope: 'all', coverageTarget: 'five-year', dateFrom: archive[0], dateTo: anchor, sessions: archive.length,
      contexts: 1, availableContexts: 1, workspaceScopeHash: analysisWorkspaceScopeHash(db), recipeDigest: signature,
      calibration: 'full', readback: 'all fields on sampled sessions',
      products: Object.fromEntries(families.map((family) => [family, { expected: 1260, verified: 1260 }])),
    } });
  const id = createHash('sha256').update(manifest).digest('hex');
  db.prepare("INSERT INTO preparation_publications VALUES (?,?,?,'verified-awaiting-cutover',?)").run(id, manifest, signature, anchor);
  const partition = db.prepare("INSERT INTO preparation_publication_partitions VALUES (?,?,1260,'consumed')");
  for (const table of productTables) partition.run(id, table);
  return id;
}

const makeBar = (symbol, date, close) => ({ symbol, date, knownAt: date,
  open: close, high: close + 1, low: close - 1, close, volume: 1000 });

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { version } = importDataset(db, { provider: 'fixture', securities: ['SPY', 'ALFA', 'BETA', 'GAMA'].map((symbol) => ({
    symbol, name: `${symbol} Fixture`, exchange: 'NYSE', type: symbol === 'SPY' ? 'etf' : 'common', listingDate: dates[0], knownAt: dates[0],
  })), prices: [...dates.flatMap((date, index) => index === 253 ? [] : [makeBar('SPY', date, 100 + index)]),
    ...['ALFA', 'BETA', 'GAMA'].flatMap((symbol, index) => dates.slice(-2).map((date) => makeBar(symbol, date, 60 + index)))],
  classifications: [{ symbol: 'ALFA', system: 'sec-sic', sector: 'D Manufacturing', industry: 'SIC 28', effectiveFrom: dates[0], knownAt: dates[0] },
    { symbol: 'ALFA', system: 'provider', sector: 'Energy', industry: 'Energy equipment', effectiveFrom: dates[0], knownAt: dates[0] }] });
  const engine = createEngine(db);
  const point = engine.context({ date: anchor, dataVersion: version, benchmark: 'SPY', classification: 'provider', reference: 'latest',
    observedReferenceDate: marketDay() });
  const coverage = { state: 'complete', expected: 100, listed: 100, traded: 100, ratio: 1 };
  const outcomes = new Map([[0, 15], [1, threshold], [5, 10], [6, threshold - 1e-10], [100, 14], [dates.length - 1, threshold]]);
  const breadth = (index) => ({
    [metric]: { value: outcomes.get(index) ?? 2, numerator: 10, denominator: 100 },
    above_50d: { value: 40 + index % 19, denominator: 100 }, positive_21d: { value: 20 + index % 27, denominator: 100 },
  });
  const groups = [
    { id: 'sector:Energy', name: 'Energy', level: 'sector' },
    { id: 'sector:Utilities', name: 'Utilities', level: 'sector' },
    { id: 'sector:Consumer Non-Durables', name: 'Consumer Non-Durables', level: 'sector' },
    { id: 'industry:E', name: 'Energy equipment', parent: 'sector:Energy', level: 'industry', rank: 2, velocity12w: 9, count: 3, dailyReturn: 0.01 },
    { id: 'industry:U', name: 'Electric utilities', parent: 'sector:Utilities', level: 'industry', rank: 1, velocity12w: 29, count: 4 },
    { id: 'industry:A', name: 'Mixed consumer goods', parent: 'sector:Consumer Non-Durables', level: 'industry', rank: 3, velocity12w: 22, count: 5 },
    { id: 'industry:missing', name: 'Unknown sector', level: 'industry', rank: 4, velocity12w: 10, count: 1 },
  ];
  const stocks = ['ALFA', 'BETA', 'GAMA'].map((symbol, index) => ({ securityId: `fixture:${symbol}`, symbol,
    name: `${symbol} Fixture`, exchange: 'NYSE', type: 'common', traded: true, close: 60 + index,
    rsRank: index + 1, rsPercentile: 100 - 25 * index, return_63d: [-0.3, -0.4, 0.25][index],
    sector: 'Energy', industry: 'Energy equipment', sectorId: 'sector:Energy', industryId: 'industry:E' }));
  const snapshot = (date, index) => ({ date, dataVersion: version, calculationVersion: CALCULATION_VERSION, universe: point.universe,
    model: point.model, benchmark: 'SPY', basis: 'reconstructed', classificationSystem: 'provider',
    referenceMode: date === anchor ? 'latest' : 'as-of', referenceDate: date, coverage, breadth: breadth(index), groups, stocks,
    aggregates: { benchmarkReturn: 0.005 } });
  const writer = createMaterializedHistoryWriter(db, engine, point, dates);
  for (const [index, date] of dates.entries()) if (index !== 50) writer.write(snapshot(date, index), null, [], []);
  const last = snapshot(anchor, dates.length - 1);
  const exactConstituents = { ...last, breadth: { ...last.breadth, [metric]: { value: 2 / 3 * 100, numerator: 2, denominator: 3 } } };
  writePreparedSnapshot(db, engine, point, exactConstituents);
  writePreparedSnapshot(db, engine, point, exactConstituents, { velocity: true });
  const sic = engine.context({ ...point, date: anchor, classification: 'sec-sic', reference: 'latest', universe: 'us-core', model: 'composite' });
  writePreparedSnapshot(db, engine, sic, { ...last, classificationSystem: 'sec-sic', groups: [
    { id: 'sector:D', name: 'D Manufacturing', level: 'sector' },
    { id: 'sector:A', name: 'A Agriculture, forestry and fishing', level: 'sector' },
    { id: 'sector:J', name: 'J Public administration', level: 'sector' },
    { id: 'sector:C', name: 'C Construction', level: 'sector' },
    { id: 'industry:28', name: 'SIC 28', parent: 'sector:D', level: 'industry', rank: 1, velocity12w: 25 },
    { id: 'industry:02', name: 'SIC 02', parent: 'sector:A', level: 'industry', rank: 2, velocity12w: 20 },
    { id: 'industry:91', name: 'SIC 91', parent: 'sector:J', level: 'industry', rank: 3, velocity12w: 15 },
    { id: 'industry:17', name: 'SIC 17', parent: 'sector:C', level: 'industry', rank: 4, velocity12w: 10 },
  ] }, { velocity: true });
  const rank = createPreparedRankWriter(db, point, [anchor]);
  rank(last);
  const details = createPreparedDetailWriter(db, engine, point, { riskWindows: [] });
  details.batch([...engine.detailSources(point, { securityIds: ['fixture:SPY'] })]);
  const watchlist = storeWorkspace(db, 'watchlist', { name: 'Fixture watchlist', definition: { members: ['ALFA', 'MISSING'] } });
  const chartbook = storeWorkspace(db, 'chartbook', { name: 'Fixture book', definition: { sources: [{ type: 'manual', id: 'manual', members: ['ALFA'] }] } });
  const proof = approve(db, version);
  const research = createResearchEngine(db);
  return { db, version, proof, watchlist, chartbook, engine, point, run: (name, input, caller = principal) => invokeResearchTool(research, caller, name, input) };
}

test('quarterly downside study uses the exact current reading and retains all matches and outcome states', async (t) => {
  const { db, version, proof, run } = fixture(t);
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const study = await run('benchmark_event_study', { metric, benchmark: 'SPY', start: dates[0], limit: 2 });
  assert.equal(study.context.dataVersion, version);
  assert.equal(study.context.proofId, proof);
  assert.equal(study.data.threshold, threshold);
  assert.equal(study.data.currentSignal.reading.value, threshold);
  assert.equal(study.page.total, 4);
  assert.equal(study.page.nextOffset, 2);
  assert.deepEqual(study.rows.map(({ date }) => date), dates.slice(0, 2), 'inclusive exact threshold retains the tie');
  assert.equal(study.rows[0].horizons[252].status, 'complete');
  assert.equal(study.rows[0].horizons[252].return, (352 / 100 - 1) * 100);
  assert.equal(study.rows[1].horizons[252].status, 'missingExit');
  const stats = study.data.results[0];
  assert.equal(stats.count, 2);
  assert.equal(stats.counts.missingExit, 1);
  assert.equal(stats.counts.rightCensored, 1);
  assert.equal(stats.counts.pathIncomplete, 1);
  assert.equal(stats.winRate, 100);
  assert.deepEqual(study.coverage.missingDates, [dates[50]]);
  const next = await run('benchmark_event_study', { metric, benchmark: 'SPY', start: dates[0], offset: 2, limit: 2,
    context: { dataVersion: study.context.dataVersion, asOf: study.context.date, calculationVersion: CALCULATION_VERSION } });
  assert.deepEqual(next.rows.map(({ date }) => date), [dates[5], dates[100]]);
  assert.equal(next.rows[1].horizons[252].status, 'rightCensored');
  assert.deepEqual(study.data.results, next.data.results, 'page boundaries never change the statistics denominator');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('industry table discloses defensive, unmapped and mixed taxonomy groups with explicit sort units', async (t) => {
  const { run } = fixture(t);
  const data = await run('industry_strength', { excludeDefensive: true });
  assert.deepEqual(data.rows.map(({ id, value }) => [id, value]), [['industry:E', 9]]);
  assert.equal(data.data.unit, 'percentile points');
  assert.deepEqual(data.coverage.sectorDecisions, { eligible: 1, defensive_sector: 1, unmapped_sector: 1, unknown_sector: 1 });
  const omitted = await run('industry_strength', { excludeDefensive: true, view: 'excluded' });
  assert.equal(omitted.page.total, 3);
  const exact = await run('industry_strength', { order: 'current-rank', excludedSectors: ['Energy'], view: 'all' });
  assert.equal(exact.rows.find(({ id }) => id === 'industry:E').sectorDecision, 'explicitly_excluded');
  const sic = await run('industry_strength', { excludeDefensive: true, context: { classification: 'sec-sic' }, view: 'all' });
  assert.deepEqual(sic.rows.map(({ id, sectorDecision, included }) => [id, sectorDecision, included]), [
    ['industry:28', 'mixed_sic_division', false], ['industry:02', 'mixed_sic_division', false],
    ['industry:91', 'unmapped_sector', false], ['industry:17', 'eligible', true],
  ]);
  const eligible = await run('industry_strength', { excludeDefensive: true, context: { classification: 'sec-sic' } });
  assert.deepEqual(eligible.rows.map(({ id }) => id), ['industry:17']);
  const trailing = await run('industry_strength', { order: 'trailing-return', excludeDefensive: true });
  assert.equal(trailing.rows[0].returnSessions, trailing.coverage.expectedSessions);
  assert.ok(trailing.rows[0].value > 0);
});

test('prepared stock, market, saved list and analog reads remain pinned and keep gaps visible', async (t) => {
  const { db, run, watchlist, chartbook, version } = fixture(t);
  const definitions = await run('describe_research', { q: metric });
  assert.equal(definitions.rows[0].key, metric);
  const search = await run('search_stocks', { q: 'ALFA' });
  assert.equal(search.rows[0].securityId, 'fixture:ALFA');
  const chosen = await run('read_stock', { security: 'ALFA', fields: ['close', 'return_63d'] });
  assert.deepEqual(chosen.data.fields, { close: 60, return_63d: -0.3 });
  const ranks = await run('read_stock_history', { series: 'ranks', security: 'ALFA', sessions: 2 });
  assert.equal(ranks.state, 'partial');
  assert.equal(ranks.rows[0].state, 'missing_prepared_observation');
  assert.equal(ranks.rows[1].rank, 1);
  const prices = await run('read_stock_history', { series: 'prices', security: 'SPY', sessions: 2 });
  assert.equal(prices.rows[1].close, 369);
  const screened = await run('screen_stocks', { fields: ['rsRank'], filters: [{ field: 'return_63d', op: 'lt', value: 0 }], limit: 1 });
  assert.equal(screened.page.total, 2);
  assert.equal(screened.rows[0].symbol, 'ALFA');
  const constituents = await run('read_metric_constituents', { metric, mode: 'comparable' });
  assert.equal(constituents.data.numerator, 2);
  assert.equal(constituents.data.denominator, 3);
  const lists = await run('list_workspace_lists', {});
  assert.deepEqual(lists.rows.map(({ kind }) => kind), ['watchlist', 'chartbook']);
  const book = await run('read_workspace_list', { kind: 'chartbook', id: chartbook.id });
  assert.equal(book.rows[0].symbol, 'ALFA');
  const watch = await run('read_workspace_list', { kind: 'watchlist', id: watchlist.id });
  assert.equal(watch.state, 'partial');
  assert.equal(watch.coverage.unresolvedMembers, 1);
  const health = await run('read_market_history', { series: 'health', sessions: 1 });
  assert.equal(health.state, 'unprepared');
  assert.equal(health.rows[0].state, 'missing_prepared_observation');
  const analogs = await run('historical_analogs', { start: dates[0], metrics: ['above_50d', 'positive_21d'], horizon: 5, sampleLimit: 6 });
  assert.equal(analogs.state, 'ready');
  assert.ok(analogs.data.empiricalReturns.length > 0);
  assert.equal(analogs.data.empiricalReturns.length, analogs.coverage.completeOutcomes);
  await assert.rejects(run('read_journals', {}), { status: 403 });
  await assert.rejects(run('read_stock', { security: 'ALFA', fields: ['providerKey'] }), { status: 400 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  importDataset(db, { provider: 'fixture', prices: [makeBar('ALFA', '2025-04-01', 500)] });
  const fallback = await run('describe_research', { limit: 1 });
  assert.equal(fallback.context.date, anchor);
  assert.equal(fallback.context.dataVersion, version);
  await assert.rejects(run('read_stock', { security: 'ALFA', context: { asOf: '2025-04-01' } }), { status: 400 });
});

test('a verified pin without the requested prepared recipe is reported without writes or cold calculations', async (t) => {
  const { db, run } = fixture(t);
  const count = () => db.prepare('SELECT total_changes() AS n').get().n;
  const before = count();
  const result = await run('read_stock', { security: 'ALFA', context: { basis: 'known' } });
  assert.equal(result.state, 'unprepared');
  assert.equal(result.context.basis, 'known');
  assert.match(result.data.reason, /no prepared snapshot/i);
  const timing = await run('market_timing', { sessions: 1 });
  assert.equal(timing.state, 'unprepared');
  assert.equal(timing.data.session, null);
  assert.equal(count(), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('health and NYSE reads return already stored indicators through the exact analysis pin', async (t) => {
  const { db, run, engine, point, version } = fixture(t);
  prepareStandardHealth(db, engine, point, { limit: dates.length });
  const nyse = engine.context({ date: anchor, dataVersion: version, universe: 'nyse', reference: 'as-of', classification: 'sec-sic' });
  prepareSummation(db, nyse, dates, dates.map((date, index) => ({ date, advancers: 90 + index % 11, decliners: 80, comparable: 200, traded: 200 })));
  const count = db.prepare('SELECT total_changes() AS n').get().n;
  const health = await run('read_market_history', { series: 'health', sessions: 1 });
  assert.equal(health.state, 'ready');
  assert.equal(health.rows[0].date, anchor);
  assert.equal(health.rows[0].sourceDataVersion, version);
  const series = await run('read_market_history', { series: 'nyse-summation', sessions: 2 });
  assert.equal(series.state, 'ready');
  assert.equal(series.context.universe.id, 'nyse');
  assert.equal(series.rows.at(-1).state, 'available');
  assert.equal(series.data.metadata.seriesType, 'observed-proxy');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, count);
});

test('private note tool requires explicit scope and never widens the saved-list view', async (t) => {
  const { db, run } = fixture(t);
  const secret = 'Private fixture observation';
  storeWorkspace(db, 'chartbook-note', { name: anchor, definition: { securityId: 'fixture:ALFA', markdown: secret } });
  const args = { subjectType: 'stock', subjectId: 'ALFA', from: anchor, to: anchor };
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(run('read_research_notes', args), { status: 403 });
  const privateScope = { ...principal, scopes: [...principal.scopes, 'research:notes'] };
  const allowed = await run('read_research_notes', args, privateScope);
  assert.equal(allowed.rows[0].markdown, secret);
  await assert.rejects(run('read_research_notes', { subjectType: 'market', subjectId: 'journal' }, privateScope), { status: 403 });
  assert.doesNotMatch(JSON.stringify(await run('list_workspace_lists', {}, privateScope)), /Private fixture observation/);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
});

test('historical journal reads require real New York availability and keep later entries out of the historical view', async (t) => {
  const { db, version } = fixture(t);
  const friday = '2025-03-28';
  db.exec(`CREATE TABLE journal_entries (
    id TEXT PRIMARY KEY, as_of_date TEXT, revision INTEGER, model TEXT, data_version INTEGER,
    calculation_version TEXT, available_at TEXT, tradable_date TEXT, output_json TEXT, generated_at TEXT, retrospective INTEGER
  )`);
  const add = db.prepare('INSERT INTO journal_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const entry = (id, revision, available, generated, retrospective = 0) =>
    add.run(id, friday, revision, 'fixture-model', version, CALCULATION_VERSION, available, anchor, '{}', generated, retrospective);
  entry('friday-evening', 1, '2025-03-29T03:30:00Z', '2025-03-29T03:29:00Z');
  entry('sunday-written-friday-label', 2, '2025-03-30T15:00:00Z', '2025-03-30T14:59:00Z');
  entry('missing-availability', 3, '', '2025-03-28T20:00:00Z');
  entry('missing-generation', 4, '2025-03-28T20:00:00Z', '');
  entry('retro-visible-friday', 5, '2025-03-28T22:00:00Z', '2025-03-28T21:59:00Z', 1);
  entry('past-current-instant', 6, '2025-04-01T22:00:00Z', '2025-04-01T21:59:00Z');
  const reader = createResearchEngine(db, { now: () => new Date('2025-03-31T16:00:00Z') });
  const caller = { ...principal, scopes: [...principal.scopes, 'research:journals'] };
  const run = (input) => invokeResearchTool(reader, caller, 'read_journals', input);
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  const history = await run({ context: { asOf: friday } });
  assert.deepEqual(history.rows.map(({ id }) => id), ['friday-evening']);
  assert.equal(history.rows[0].tradableDate, anchor);
  assert.equal(history.data.availabilityCutoff, friday);
  assert.equal(history.data.availabilityCutoffMode, 'end_of_new_york_session_date');
  assert.equal(history.coverage.missingAvailability, 2);
  assert.equal(history.coverage.unavailableAtCutoff, 2);
  const optedIn = await run({ to: friday, includeRetrospective: true });
  assert.deepEqual(optedIn.rows.map(({ id }) => id), ['retro-visible-friday', 'friday-evening']);
  const current = await run({});
  assert.deepEqual(current.rows.map(({ id }) => id), ['sunday-written-friday-label', 'friday-evening']);
  assert.equal(current.data.availabilityCutoff, '2025-03-31T16:00:00.000Z');
  assert.equal(current.data.availabilityCutoffMode, 'current_instant');
  assert.equal(current.coverage.unavailableAtCutoff, 1);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
});

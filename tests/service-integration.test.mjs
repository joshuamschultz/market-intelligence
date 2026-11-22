import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { expectedSessions, latestFinalizableSession, shiftDate } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, createJob, dataVersion, importDataset, openDatabase, recordDailyPublication, updateJob } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { materializeHistory } from '../backend/materialization.mjs';
import { batchPreparationSpecs, enqueuePreparation, preparationSpecs } from '../backend/preparation.mjs';
import { hasPreparedSnapshot, writePreparedSnapshot } from '../backend/prepared-snapshots.mjs';
import { EodhdProvider, importProviderData } from '../backend/provider.mjs';
import { createDailyTick } from '../backend/server.mjs';
import { createService, dailyCaptureAvailability, performJob, prepareStandardHealth, scheduledPrecomputeKey } from '../backend/service.mjs';
import { savedScreenRoute, tradingViewUrl } from '../frontend/ui.js';

const bar = (symbol, date, close) => ({ symbol, date, open: close, low: close, high: close, close,
  adjusted_close: close, volume: 100, knownAt: date });
const asset = (symbol, listingDate, extra = {}) => ({ symbol, name: `${symbol} Company`, exchange: 'NYSE', type: 'common',
  listingDate, knownAt: listingDate, ...extra });
const post = (dispatch, path, body) => dispatch({ method: 'POST', url: '/api/v1/' + path, body });
const closeTo = (value, target) => assert.ok(Math.abs(value - target) < 1e-8, `${value} ≉ ${target}`);

test('overview daily movers exclude exact ten-percent changes and return dated industries', async (t) => {
  const { db, dispatch } = fixture(t);
  const previous = '2024-01-04';
  const date = '2024-01-05';
  const closes = { BRIGHT: 140, OVERUP: 110.01, EXACTUP: 110, SMALLUP: 109.99, SMALLDOWN: 90.01, EXACTDOWN: 90, OVERDOWN: 89.99, DARK: 80 };
  const symbols = Object.keys(closes);
  importDataset(db, { provider: 'fixture', securities: symbols.map((symbol) => asset(symbol, previous)),
    prices: symbols.flatMap((symbol) => [bar(symbol, previous, 100), bar(symbol, date, closes[symbol])]),
    classifications: symbols.map((symbol) => ({ symbol, sector: 'Fixtures', industry: 'Example industry', effectiveFrom: previous, knownAt: previous })) });
  const response = await dispatch({ url: `/api/v1/market/overview?date=${date}` });
  assert.equal(response.status, 200, response.body.error);
  assert.deepEqual(response.body.movers.gainers.map(({ symbol }) => symbol), ['BRIGHT', 'OVERUP']);
  assert.deepEqual(response.body.movers.losers.map(({ symbol }) => symbol), ['DARK', 'OVERDOWN']);
  assert.deepEqual(response.body.movers.counts, { gainers: 2, losers: 2 });
  assert.ok([...response.body.movers.gainers, ...response.body.movers.losers].every(({ industry }) => industry === 'Example industry'));
});

test('overview counts all daily movers while returning five per side', async (t) => {
  const { db, dispatch } = fixture(t);
  const previous = '2024-01-04';
  const date = '2024-01-05';
  const symbols = Array.from({ length: 15 }, (_, index) => `MOVE${index}`);
  importDataset(db, { provider: 'fixture', securities: symbols.map((symbol) => asset(symbol, previous)),
    prices: symbols.flatMap((symbol, index) => [bar(symbol, previous, 100),
      bar(symbol, date, index < 7 ? 112 + index : 88 - index)]) });
  const response = await dispatch({ url: `/api/v1/market/overview?date=${date}` });
  assert.equal(response.status, 200, response.body.error);
  assert.deepEqual(response.body.movers.counts, { gainers: 7, losers: 8 });
  assert.deepEqual(response.body.movers.gainers.map(({ symbol }) => symbol), ['MOVE6', 'MOVE5', 'MOVE4', 'MOVE3', 'MOVE2']);
  assert.deepEqual(response.body.movers.losers.map(({ symbol }) => symbol), ['MOVE14', 'MOVE13', 'MOVE12', 'MOVE11', 'MOVE10']);
});

test('period lists rank each horizon across the full comparable universe and follow only ready EOD revisions', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2025-08-01', '2026-11-20').slice(-260);
  const date = dates.at(-1);
  const symbols = ['ALPHA', 'BETA', 'LONG', ...Array.from({ length: 48 }, (_, index) => `F${index}`)];
  const securities = [...symbols.map((symbol) => asset(symbol, dates[0])), asset('SHORTIPO', dates.at(-40))];
  const prices = [...symbols.flatMap((symbol) => dates.map((day, index) => {
    const horizon = index < dates.length - 1 ? 100 : ['ALPHA', 'BETA'].includes(symbol) ? 140 : 101;
    const close = symbol === 'LONG' ? 52 + Math.min(index, 230) * 0.8
      : symbol === 'F0' ? index === dates.length - 1 ? 100 : 100 + 2 * index : horizon;
    return bar(symbol, day, close);
  })), ...dates.slice(-40).map((day, index) => bar('SHORTIPO', day, index === 39 ? 190 : 100))];
  const classifications = [['ALPHA', 'Tech'], ['BETA', 'Tech'], ['LONG', 'Retail']].map(([symbol, industry]) => ({
    symbol, industry, sector: 'Fixture', effectiveFrom: dates[0], knownAt: dates[0],
  }));
  const { version } = importDataset(db, { provider: 'fixture', securities, prices, classifications });
  const { status: localStatus, body: local } = await dispatch({ url: '/api/v1/data/status' });
  assert.equal(localStatus, 200);
  assert.equal(local.latestAnalysis, null);
  recordDailyPublication(db, { date, rawVersion: version, dataRevision: version, models: [] });
  const publish = (next) => {
    const job = createJob(db, 'production-precompute', { scheduledFor: date, jobKey: scheduledPrecomputeKey(date, next) });
    return updateJob(db, job.id, 'complete', 100, { date, dataVersion: next, calculationVersion: CALCULATION_VERSION });
  };
  publish(version);
  const ranks = async (period, extra = {}) => {
    const response = await dispatch({ url: '/api/v1/rankings?' + new URLSearchParams({ rankingPeriod: period, ...extra }) });
    assert.equal(response.status, 200, response.body.error);
    return response.body;
  };
  const composite = async () => (await dispatch({ url: '/api/v1/rankings?perPage=250' })).body.rows
    .map(({ securityId, rsRank, rsPercentile }) => [securityId, rsRank, rsPercentile]);
  const originalComposite = await composite();
  const one = await ranks('1m');
  assert.deepEqual(one.rows.map(({ symbol }) => symbol), ['SHORTIPO', 'ALPHA']);
  assert.equal(one.rows[0].rsRank, null);
  assert.deepEqual([one.period.sessions, one.period.comparable, one.period.cutoff, one.period.topPercent], [21, 52, 2, 2]);
  const annual = await ranks('1y');
  assert.deepEqual(annual.rows.map(({ symbol }) => symbol), ['LONG', 'ALPHA']);
  assert.equal(annual.period.comparable, 51);
  assert.equal((await ranks('3m')).period.sessions, 63);
  assert.equal((await ranks('6m')).period.sessions, 126);
  assert.equal((await ranks('1w')).period.sessions, 5);
  const full = (await ranks('1m', { topPercent: 100 })).rows;
  const alpha = full.find(({ symbol }) => symbol === 'ALPHA');
  const beta = full.find(({ symbol }) => symbol === 'BETA');
  assert.equal(alpha.periodPercentile, beta.periodPercentile);
  assert.deepEqual([alpha.periodRank, beta.periodRank], [2, 3]);
  const search = await post(dispatch, 'screens/query', { rankingPeriod: '1m', search: 'ALPHA', sort: [{ field: 'symbol', direction: 'asc' }] });
  assert.equal(search.body.period.comparable, 52);
  assert.equal(search.body.rows[0].periodRank, 2);
  assert.equal((await post(dispatch, 'screens/query', { rankingPeriod: '1m', search: 'BETA' })).body.total, 0);
  assert.equal((await dispatch({ url: '/api/v1/rankings?rankingPeriod=1m&topPercent=0' })).status, 400);
  assert.deepEqual(await composite(), originalComposite, 'period ranking does not reorder or mutate cached Composite scores');
  const signal = async (rankingList) => (await dispatch({ url: `/api/v1/rankings?model=short-momentum&rankingList=${rankingList}` })).body;
  const industry = await signal('industry-leaders');
  assert.deepEqual(industry.rows.map(({ symbol }) => symbol), ['ALPHA', 'LONG']);
  assert.equal(industry.rankingList.unclassified, 48);
  assert.ok((await signal('top-rs')).rows.every(({ rsPercentile }) => rsPercentile >= 90));
  const improvers = (await signal('fast-improvers')).rows;
  assert.ok(improvers.some(({ symbol }) => symbol === 'ALPHA'));
  assert.ok(improvers.every(({ velocity4w }, index) => velocity4w > 0 && (!index || velocity4w <= improvers[index - 1].velocity4w)));
  const entrants = (await signal('new-top-decile')).rows;
  assert.ok(entrants.some(({ symbol }) => symbol === 'ALPHA'));
  assert.ok(entrants.every(({ enteredTop10 }) => enteredTop10 === true));
  assert.ok((await signal('emerging-leaders')).rows.some(({ symbol, lifecycle }) => symbol === 'F1' && lifecycle === 'Emerging'));
  assert.ok((await signal('weakening-leaders')).rows.some(({ symbol, velocity4w }) => symbol === 'F0' && velocity4w < 0));

  const screen = (await post(dispatch, 'screens', { name: 'Live month', definition: {
    rankingPeriod: '1m', topPercent: 2, dateMode: 'latest', context: { universe: 'us-core', date: dates.at(-4), dataVersion: version },
  } })).body;
  assert.deepEqual(screen.definition.context, { universe: 'us-core' });
  assert.deepEqual([screen.definition.rankingPeriod, screen.definition.topPercent, screen.definition.members], ['1m', 2, undefined]);
  const watch = (await post(dispatch, 'watchlists', { name: 'Live monthly leaders', definition: { screenId: screen.id } })).body;
  const fixed = (await post(dispatch, 'screens', { name: 'Fixed month', definition: {
    rankingPeriod: '1m', dateMode: 'fixed', context: { date, dataVersion: version },
  } })).body;
  const fixedWatch = (await post(dispatch, 'watchlists', { name: 'Fixed leaders', definition: { screenId: fixed.id } })).body;
  const updated = importDataset(db, { provider: 'fixture', prices: [bar('BETA', date, 160)] }).version;
  assert.ok(updated > version);
  const names = ({ rows }) => rows.map(({ symbol }) => symbol);
  assert.deepEqual(names(await ranks('1m')), ['SHORTIPO', 'ALPHA']);
  assert.deepEqual(names(await ranks('1m', { date, dataVersion: updated })), ['SHORTIPO', 'BETA']);
  assert.equal((await dispatch({ url: '/api/v1/data/status' })).body.latestAnalysis.dataVersion, version);
  publish(updated);
  const ready = (await dispatch({ url: '/api/v1/data/status' })).body.latestAnalysis;
  assert.deepEqual([ready.date, ready.dataVersion, ready.stage], [date, updated, 'production-precompute']);
  assert.deepEqual(names(await ranks('1m')), ['SHORTIPO', 'BETA']);
  assert.deepEqual(names(await ranks('1m', { date, dataVersion: version })), ['SHORTIPO', 'ALPHA']);
  assert.deepEqual(names((await post(dispatch, `screens/${screen.id}/execute`, {})).body), ['SHORTIPO', 'BETA']);
  assert.deepEqual(names((await dispatch({ url: `/api/v1/watchlists/${watch.id}/members` })).body), ['SHORTIPO', 'BETA']);
  assert.deepEqual(names((await dispatch({ url: `/api/v1/watchlists/${fixedWatch.id}/members?date=${dates.at(-4)}&dataVersion=${updated}` })).body), ['SHORTIPO', 'ALPHA']);
  const next = expectedSessions(date, shiftDate(date, 8))[1];
  const partialNext = importDataset(db, { provider: 'fixture', prices: [bar('ALPHA', next, 130)] }).version;
  publish(partialNext);
  const stillCurrent = await ranks('1m');
  assert.equal(stillCurrent.dataVersion, partialNext);
  assert.equal(stillCurrent.date, date, 'a ready revision may also contain later unpublished prices');
  assert.deepEqual(names(stillCurrent), ['SHORTIPO', 'BETA']);
});

test('saved live routes release old pins and TradingView uses known exchange and share-class conventions', () => {
  const context = { universe: 'us-core', date: '2026-10-01', dataVersion: 24 };
  assert.deepEqual(savedScreenRoute({ dateMode: 'latest', context }), { universe: 'us-core', date: null, dataVersion: null });
  assert.deepEqual(savedScreenRoute({ dateMode: 'fixed', context }), context);
  assert.deepEqual(savedScreenRoute({ context }), context);
  const symbol = (ticker, venue) => new URL(tradingViewUrl(ticker, venue)).searchParams.get('symbol');
  assert.equal(symbol('AAPL', 'NASDAQ'), 'NASDAQ:AAPL');
  assert.equal(symbol('BRK-B', 'NYSE'), 'NYSE:BRK.B');
  assert.equal(symbol('SPY', 'NYSE Arca'), 'AMEX:SPY');
  assert.equal(symbol('XYZ', 'NYSE American'), 'AMEX:XYZ');
  assert.equal(symbol('XYZ', 'OTCID'), 'OTC:XYZ');
  assert.equal(symbol('XYZ', 'unknown'), 'XYZ');
});

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return { db, ...createService({ db, workers: false }) };
}

function fileFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'market-job-queue-'));
  const filename = join(directory, 'market.sqlite');
  const db = openDatabase(filename);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, filename };
}

async function completedJob(dispatch, id) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = (await dispatch({ url: `/api/v1/jobs/${id}` })).body;
    if (['complete', 'failed'].includes(result.status)) return result;
    await delay(20);
  }
  assert.fail('Background job did not finish');
}

test('US All preparation publishes Monitor and historical ranks without GET-triggered work', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2024-01-02', '2024-06-01').slice(-83);
  const symbols = ['CORE', 'AMEXSTOCK', 'SPY'];
  importDataset(db, { provider: 'fixture', securities: [
    asset(symbols[0], dates[0]), asset(symbols[1], dates[0], { exchange: 'NYSE AMERICAN' }),
    asset('SPY', dates[0], { type: 'etf' }),
  ], prices: symbols.flatMap((symbol, index) => dates.map((date, day) => bar(symbol, date, 100 + day * (3 - index)))) });
  const { dispatch, engine } = createService({ db, workers: false, preparedOnly: true });
  const context = { universe: 'us-all', model: 'short-momentum', classification: 'provider', reference: 'latest' };
  const query = new URLSearchParams(context);
  const show = (path) => dispatch({ url: `/api/v1/${path}${path.includes('?') ? '&' : '?'}${query}` });
  const cold = await show('market/monitor');
  assert.equal(cold.status, 200);
  assert.equal(cold.body.materialization.preparationState, 'unregistered');
  assert.deepEqual(cold.body.rows, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  const specs = preparationSpecs(db, engine, { ...context, universe: 'us-core', model: 'composite' })
    .filter(({ context: input }) => input.universe === context.universe && input.model === context.model);
  assert.deepEqual(specs.map(({ phase }) => phase), ['current','recent','history']);
  const installed = enqueuePreparation(db, specs);
  assert.equal(installed.queued, 3);
  assert.equal(enqueuePreparation(db, specs).queued, 0);
  const waiting = await show('market/monitor');
  assert.equal(waiting.body.materialization.status, 'queued');
  assert.equal(waiting.body.materialization.jobId, installed.jobs[1].id);
  const restarted = createService({ db, workers: false, preparedOnly: true });
  const outcome = await completedJob(restarted.dispatch, installed.jobs.at(-1).id);
  assert.equal(outcome.status, 'complete', outcome.error);
  assert.equal(outcome.result.totalSessions, dates.length * 2);
  const jobs = db.prepare('SELECT count(*) AS n FROM jobs').get().n;
  const overview = await show('market/overview');
  const monitor = await show('market/monitor');
  assert.equal(overview.body.coverage.traded, symbols.length);
  assert.equal(monitor.body.materialization.complete, true);
  assert.equal(monitor.body.rows.length, 63);
  assert.equal(monitor.body.date, dates.at(-1));
  const daily = await show('rankings?series=1&cadence=daily&limit=83&symbol=AMEXSTOCK');
  const weekly = await show('rankings?series=1&cadence=weekly&limit=83&symbol=AMEXSTOCK');
  assert.equal(daily.body.archived, dates.length);
  assert.ok(weekly.body.rows.length && weekly.body.rows.every(({ date }) => daily.body.rows.some((row) => row.date === date)));
  assert.ok(db.prepare('SELECT count(*) AS n FROM prepared_rank_blocks').get().n);
  const historicalDate = dates.at(-8);
  const historical = new URLSearchParams({ ...context, reference: 'as-of', date: historicalDate });
  const stockRows = await post(dispatch, 'screens/query', { context: Object.fromEntries(historical), all: true });
  const canonical = engine.snapshot(engine.context(Object.fromEntries(historical)), { velocity: true, persist: false, cache: false });
  const fields = ({ symbol, close, rsRank, rsPercentile, velocity1w }) => [symbol, close, rsRank, rsPercentile, velocity1w];
  assert.deepEqual(stockRows.body.rows.map(fields).sort(), canonical.stocks.filter(({traded}) => traded).map(fields).sort());
  const contributor = await dispatch({ url: '/api/v1/market/breadth/advancers/contributors?' + historical });
  assert.equal(contributor.body.metric.numerator, canonical.breadth.advancers.numerator);
  assert.equal(contributor.body.total, canonical.breadth.advancers.numerator);
  const ticker = await dispatch({ url: '/api/v1/stocks/AMEXSTOCK?' + historical + '&lookback=20' });
  assert.equal(ticker.status, 200, ticker.body.error);
  assert.equal(ticker.body.chartBars.length, 0);
  assert.equal(ticker.body.detailPreparation.chart.state, 'not-prepared');
  assert.equal(ticker.body.date, historicalDate);
  assert.equal(ticker.body.rsRank, canonical.stocks.find(({symbol})=>symbol==='AMEXSTOCK').rsRank);
  const status = (await dispatch({ url: '/api/v1/data/status' })).body.preparation;
  assert.deepEqual(status.universes[0].stages, { current: { complete: 1, total: 1 }, recent: { complete: 1, total: 1 }, history: { complete: 1, total: 1 } });
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, jobs, 'prepared views do not enqueue jobs');
  const unknown = await show('market/monitor?metrics=up_17pct_37d,down_17pct_37d');
  assert.equal(unknown.body.materialization.preparationState, 'unregistered');
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, jobs, 'unregistered reads do not enqueue jobs');
  const rangeQuery = { context, columns: ['symbol','range_distance_high_5d','range_since_high_5d'] };
  const coldRange = await post(dispatch, 'screens/query', rangeQuery);
  assert.equal(coldRange.body.materialization.prepareAction, 'range');
  assert.equal(coldRange.body.materialization.preparationState, 'unregistered');
  const registered = await post(dispatch, 'data/preparation', { context: { ...context, rangeWindows: [5], followLatest: true } });
  assert.equal(registered.status, 202, registered.body.error);
  assert.deepEqual(registered.body.jobs.map(({ type }) => type), ['prepare-range','prepare-range-history']);
  const rangeResult = await completedJob(dispatch, registered.body.jobs.at(-1).id);
  assert.equal(rangeResult.status, 'complete', rangeResult.error);
  assert.equal(rangeResult.result.done, true);
  const matched = await post(dispatch, 'screens/query', rangeQuery);
  assert.ok(matched.body.rows.some((row) => row.symbol === 'AMEXSTOCK' && row.range_distance_high_5d === 0 && row.range_since_high_5d === 0));
});

test('ticker GET reads prepared rows and chart products without running price or risk analytics', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2024-01-02', '2024-05-20');
  const [first, date] = [dates[0], dates.at(-1)];
  const context = { universe: 'sample', date, basis: 'reconstructed', reference: 'as-of', benchmark: 'SPY' };
  importDataset(db, { provider: 'fixture', securities: [asset('AAA', first), asset('SPY', first, { type: 'etf' })],
    prices: dates.flatMap((day, index) => [bar('AAA', day, 100 + index + index % 3), bar('SPY', day, 400 + 2 * index + index % 4)]) });
  const { dispatch, engine } = createService({ db, workers: false, preparedOnly: true });
  const config = engine.context(context);
  const prior = { ...config, date: dates.at(-2), requestedDate: dates.at(-2) };
  writePreparedSnapshot(db, engine, config, engine.snapshot(config));
  writePreparedSnapshot(db, engine, prior, engine.snapshot(prior));
  materializeHistory(db, engine, config, { limit: 2, withRanks: true });
  const expected = engine.detail(config, 'AAA', 63, { velocity: false });
  engine.detail = () => assert.fail('Ticker GET called engine.detail');
  engine.studyPrices = () => assert.fail('Ticker GET called engine.studyPrices');
  const get = (action = '', extra = {}) => dispatch({
    url: '/api/v1/stocks/AAA' + action + '?' + new URLSearchParams({ ...context, lookback: 63, ...extra }),
  });
  const cold = await get();
  assert.equal(cold.status, 200, cold.body.error);
  assert.equal(cold.body.symbol, 'AAA');
  assert.equal(cold.body.close, expected.close);
  assert.equal(cold.body.detailPreparation.metrics.state, 'ready');
  assert.equal(cold.body.detailPreparation.chart.state, 'not-prepared');
  assert.equal(cold.body.risk, null);
  assert.equal((await get('', { export: 'csv' })).status, 202);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  const ranks = await get('/rankings', { cadence: 'daily', limit: 2 });
  assert.equal(ranks.status, 200, ranks.body.error);
  assert.equal(ranks.body.supplyDemand.state, 'ready');
  assert.deepEqual(ranks.body.rows.map(({ udv_50d, udv_state_50d }) => [udv_50d, udv_state_50d]),
    [prior, config].map((point) => {
      const row = engine.snapshot(point).stocks.find(({ securityId }) => securityId === 'fixture:AAA');
      return [row.udv_50d, row.udv_state_50d];
    }));
  const job = await post(dispatch, 'stocks/AAA/prepare', { context, lookback: 63 });
  assert.equal(job.status, 202, job.body.error);
  assert.equal((await completedJob(dispatch, job.body.id)).status, 'complete');
  const ready = await get();
  assert.equal(ready.status, 200, ready.body.error);
  assert.deepEqual(['chart', 'risk', 'metrics', 'weekly'].map((key) => ready.body.detailPreparation[key].state),
    ['ready', 'ready', 'ready', 'unprepared']);
  assert.equal(ready.body.detailPreparation.state, 'partial');
  assert.equal(ready.body.chartBars.length, 63);
  assert.equal(ready.body.chartBars.at(-1).close, expected.close);
  assert.ok(ready.body.risk.observations >= 20);
  assert.equal((await get('', { export: 'csv' })).status, 200);
  const weekly = engine.snapshot(config, { velocity: true, persist: false });
  writePreparedSnapshot(db, engine, config, weekly, { velocity: true });
  assert.equal((await get()).body.detailPreparation.state, 'ready');
});

test('imports and saved definitions register durable preparation before their views are read', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { dispatch } = createService({ db, workers: false, preparedOnly: true });
  const date = '2024-01-05';
  const receipt = await post(dispatch, 'data/import', { provider: 'fixture',
    securities: [asset('READY', date)], prices: [bar('READY', date, 100)] });
  assert.equal(receipt.status, 201);
  const before = (await dispatch({ url: '/api/v1/data/preparation' })).body;
  assert.ok(before.total > 0);
  assert.ok(before.universes.some(({ universe }) => universe === 'us-all'));
  assert.ok(before.universes.every(({ universe }) => universe !== 'sample'));
  assert.equal((await post(dispatch, 'data/preparation', {})).body.queued, 0);
  const model = await post(dispatch, 'ranking-models', { name: 'Durable fixture', definition: { windows: [{ length: 5, weight: 1 }] } });
  assert.equal(model.status, 201);
  const after = (await dispatch({ url: '/api/v1/data/preparation' })).body;
  assert.ok(after.total > before.total);
  assert.ok(after.contexts.some((point) => point.universe === 'us-all' && point.model === model.body.id));
  assert.equal((await post(dispatch, 'data/preparation', { retry: true })).body.queued, 0);
  for (let pass = 0; pass < 250 && db.prepare("SELECT 1 FROM jobs WHERE status IN ('running','queued') LIMIT 1").get(); pass++) await delay(20);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE status<>'complete'").get().n, 0);
});

test('a calculation upgrade supersedes outdated queued jobs and serves exact batched preparation', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const from = '2024-01-03';
  const to = '2024-01-09';
  const dates = expectedSessions(from, to);
  importDataset(db, { provider: 'fixture', securities: [asset('FRESH', from)], prices: dates.map((date, index) => bar('FRESH', date, 100 + index)) });
  const engine = createEngine(db);
  const contexts = [{ universe: 'us-core' }, { universe: 'us-all' }];
  const requested = contexts.flatMap((context) => preparationSpecs(db, engine, context,
    { requested: context, historySessions: 3 }).filter(({ phase }) => phase === 'history'));
  const [batched] = batchPreparationSpecs(engine, requested);
  assert.equal(batched.members.length, 2);
  const old = createJob(db, 'prepare-context', { ...batched, calculationVersion: 'older-calculation', jobKey: 'old-batch' });
  const { dispatch } = createService({ db, workers: false, preparedOnly: true });
  for (let pass = 0; pass < 100 && db.prepare("SELECT 1 FROM jobs WHERE status IN ('running','queued')").get(); pass++) await delay(10);
  const stale = await dispatch({ url: `/api/v1/jobs/${old.id}` });
  assert.equal(stale.body.status, 'superseded');
  const available = await dispatch({ url: '/api/v1/data/preparation' });
  assert.equal(available.body.contexts.filter(({ stages }) => stages.history === 'complete').length, 0);
  for (const context of contexts) {
    assert.equal(hasPreparedSnapshot(db, engine, engine.context(context), { velocity: true }), true);
  }
  const done = db.prepare("SELECT payload FROM jobs WHERE status='complete' AND type='prepare-context'").all().map(({ payload }) => JSON.parse(payload));
  assert.equal(done.length, 1);
  assert.equal(done[0].calculationVersion, CALCULATION_VERSION);
  assert.equal(done[0].members.length, 2);
});

test('long daily chart requests read prepared rows beyond a year without starting jobs', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2023-01-03', '2025-01-03').slice(-305);
  const point = { date: dates.at(-1), universe: 'us-all', reference: 'as-of' };
  importDataset(db, { provider: 'fixture', securities: [asset('LONGCHART', dates[0])],
    prices: dates.map((date, index) => bar('LONGCHART', date, 100 + index)) });
  const engine = createEngine(db);
  const config = engine.context(point);
  materializeHistory(db, engine, config, { limit: dates.length, withRanks: true });
  prepareStandardHealth(db, engine, config, { limit: dates.length });
  const { dispatch } = createService({ db, workers: false, preparedOnly: true });
  const query = new URLSearchParams({ ...point, cadence: 'daily', limit: '1260' });
  for (const [path, responseField] of [['market/breadth?series=1', 'rows'], ['market/monitor?metrics=above_50d', 'rows'],
    ['market/health?series=1', 'history'], ['stocks/LONGCHART/rankings?series=1', 'rows'], ['industries/compare?ids=', 'rows']]) {
    const response = await dispatch({ url: `/api/v1/${path}&${query}` });
    assert.equal(response.status, 200, response.body.error);
    assert.equal(response.body[responseField].length, dates.length, path);
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
});

test('a refresh retains an already published session while retrying incomplete older coverage without duplicate imports', async (t) => {
  const { db } = fixture(t);
  const latest = latestFinalizableSession();
  const older = expectedSessions(shiftDate(latest, -14), latest).at(-2);
  const securities = ['FIRST', 'SECOND'].map((symbol) => asset(symbol, '2020-01-02'));
  importDataset(db, { provider: 'eodhd', securities, prices: [bar('FIRST', older, 100)] });
  const capture = importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 2,
    expectedRoster: securities.map(({ symbol }) => ({ symbol })), prices: securities.map(({ symbol }) => bar(symbol, latest, 110)) });
  recordDailyPublication(db, { date: latest, rawVersion: capture.version, dataRevision: capture.version, models: [] });
  const requested = [];
  let outage = false;
  const provider = {
    getSecurities: async () => securities,
    async getDailyPrices({ date }) {
      requested.push(date);
      if (outage) throw new Error('Older session unavailable upstream');
      return [{ ...bar('FIRST', date, 100), adjusted_close: 90 }];
    },
  };
  const { dispatch } = createService({ db, provider, workers: false });
  const refresh = async () => completedJob(dispatch, (await post(dispatch, 'data/refresh', {
    bulk: true, from: older, to: latest, verifiedOnly: true, actions: false,
  })).body.id);
  const first = await refresh();
  assert.equal(first.status, 'complete', first.error);
  assert.equal(first.result.imported, 1);
  assert.deepEqual(first.result.published, []);
  assert.deepEqual(first.result.alreadyPublished, [latest]);
  assert.deepEqual(first.result.stillPending, [older]);
  assert.match(first.result.warnings[0], /pending.*incomplete coverage/);
  const version = dataVersion(db);
  const retried = await refresh();
  assert.equal(retried.status, 'complete', retried.error);
  assert.equal(retried.result.imported, 0);
  assert.deepEqual(retried.result.stillPending, [older]);
  assert.deepEqual(retried.result.alreadyPublished, [latest]);
  assert.equal(dataVersion(db), version);
  outage = true;
  const degraded = await refresh();
  assert.equal(degraded.status, 'complete', degraded.error);
  assert.deepEqual(degraded.result.alreadyPublished, [latest]);
  assert.deepEqual(degraded.result.stillPending, [older]);
  assert.match(degraded.result.warnings[0], /Older session unavailable upstream/);
  assert.deepEqual(requested, [older, older, older]);
  assert.equal(db.prepare('SELECT count(*) AS count FROM daily_publications').get().count, 1);
});

test('scheduled capture does not refetch already received partial sessions', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const clock = new Date('2024-01-10T02:00:00Z');
  const date = latestFinalizableSession(clock);
  const days = expectedSessions(shiftDate(date, -5), date).slice(-3);
  const securities = ['FIRST','SECOND'].map((symbol) => asset(symbol, '2020-01-02'));
  for (const [index, day] of days.entries()) {
    const receipt = importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 2,
      expectedRoster: securities.map(({symbol}) => ({symbol})), securities,
      prices: securities.slice(0, index ? 2 : 1).map(({symbol}) => bar(symbol, day, 100)) });
    if (index) recordDailyPublication(db, { date: day, rawVersion: receipt.version, dataRevision: receipt.version, models: [] });
  }
  const requests = [];
  const { dispatch, ...service } = createService({ db, workers: false, provider: {
    getSecurities: async () => securities,
    getDailyPrices: async (query) => { requests.push(query.date); throw new Error('No automatic duplicate capture'); },
  } });
  const tick = createDailyTick(service, db, { providerEnabled: true, now: () => clock, config: {} });
  tick();
  tick();
  assert.equal(db.prepare('SELECT count(*) AS total FROM jobs').get().total, 0);
  const job = await post(dispatch, 'data/refresh', { bulk: true, from: days[0], to: date, verifiedOnly: true, skipCaptured: true });
  const outcome = await completedJob(dispatch, job.body.id);
  assert.equal(outcome.status, 'complete', outcome.error);
  assert.equal(outcome.result.downloadSkipped, true);
  assert.deepEqual(outcome.result.stillPending, days.slice(0, 1));
  assert.deepEqual(requests, []);
});

test('daily capture uses 16:30 New York time and only retries the latest partial session with a durable cap', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = ['2024-03-08', '2024-03-11'];
  const securities = ['FIRST', 'SECOND'].map((symbol) => asset(symbol, '2020-01-02'));
  const seed = (date, complete) => importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 2,
    expectedRoster: securities.map(({ symbol }) => ({ symbol })), securities,
    prices: securities.slice(0, complete ? 2 : 1).map(({ symbol }) => bar(symbol, date, 100)) });
  const prior = seed('2024-03-07', true);
  recordDailyPublication(db, { date: '2024-03-07', rawVersion: prior.version, dataRevision: prior.version, models: [] });
  let clock = new Date('2024-03-08T21:29:00Z');
  const jobs = [];
  const makeTick = () => createDailyTick({ journalConfiguration: () => null, enqueue(type, payload, key) {
    jobs.push({ type, payload, key, id: createJob(db, type, { ...payload, jobKey: key }).id });
  } }, db, { providerEnabled: true, now: () => clock, config: {} });
  const at = (stamp) => { clock = new Date(stamp); makeTick()(); };
  const finish = (stamp) => {
    const { id } = jobs.at(-1);
    updateJob(db, id, 'complete', 100, {});
    db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(stamp, id);
  };
  makeTick()();
  assert.equal(jobs.length, 0);
  at('2024-03-08T21:30:00Z');
  assert.equal(jobs[0].payload.date, dates[0]);
  assert.equal(jobs[0].payload.captureAttempt, 1);
  const friday = seed(dates[0], true);
  recordDailyPublication(db, { date: dates[0], rawVersion: friday.version, dataRevision: friday.version, models: [] });
  finish('2024-03-08T21:30:00Z');
  at('2024-03-11T20:29:00Z');
  assert.equal(jobs.length, 1);
  at('2024-03-11T20:30:00Z');
  assert.equal(jobs[1].payload.date, dates[1]);
  seed(dates[1], false);
  finish('2024-03-11T20:32:00Z');
  at('2024-03-11T20:40:00Z');
  assert.equal(jobs.length, 2);
  at('2024-03-11T20:42:00Z');
  assert.equal(jobs[2].payload.force, true);
  finish('2024-03-11T20:42:00Z');
  at('2024-03-11T20:57:00Z');
  finish('2024-03-11T20:57:00Z');
  at('2024-03-11T21:22:00Z');
  finish('2024-03-11T21:22:00Z');
  at('2024-03-11T21:59:00Z');
  at('2024-03-12T19:59:00Z');
  assert.deepEqual(jobs.slice(1).map(({ payload }) => [payload.date, payload.captureAttempt]),
    dates.slice(1).flatMap((date) => [1, 2, 3, 4].map((attempt) => [date, attempt])));
  assert.equal(dailyCaptureAvailability(db, dates[1], clock).state, 'exhausted');
});

test('a queued automatic capture retires without using the provider after the next session closes', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let requests = 0;
  const outcome = await performJob(db, 'provider-import', {
    bulk: true, date: '2024-03-11', scheduledFor: '2024-03-11', captureAttempt: 3, force: true,
  }, { now: () => new Date('2024-03-12T21:00:00Z'), provider: { getSecurities() { requests++; return []; } } });
  assert.equal(requests, 0);
  assert.equal(outcome.downloadSkipped, true);
  assert.equal(outcome.sourceAvailability, 'superseded');
});

test('same-session backup failures retry after thirty minutes and stop after three attempts', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const date = '2024-04-17';
  const source = importDataset(db, { provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', expected: 1,
    expectedRoster: [{ symbol: 'AAA' }], securities: [asset('AAA', '2020-01-02')], prices: [bar('AAA', date, 100)] });
  recordDailyPublication(db, { date, rawVersion: source.version, dataRevision: source.version, models: [] });
  let clock;
  const attempts = [];
  const tick = createDailyTick({ journalConfiguration: () => null, enqueue(type, payload, key) {
    attempts.push(createJob(db, type, { ...payload, jobKey: key }));
  } }, db, { now: () => clock, config: { MARKET_BACKUP: '1' } });
  const at = (time) => { clock = new Date(`${date}T${time}:00Z`); tick(); };
  const fail = (time) => {
    updateJob(db, attempts.at(-1).id, 'failed', 0, null, 'Synthetic backup failure');
    db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(`${date}T${time}:00Z`, attempts.at(-1).id);
  };
  at('21:00');
  fail('21:00');
  at('21:29');
  assert.equal(attempts.length, 1);
  at('21:30');
  fail('21:31');
  at('22:00');
  assert.equal(attempts.length, 2);
  at('22:01');
  fail('22:01');
  at('23:01');
  assert.deepEqual(attempts.map(({ type, payload }) => [type, payload.backupAttempt, payload.jobKey]),
    [['backup', 1, `backup:${date}`], ['backup', 2, `backup:${date}:2`], ['backup', 3, `backup:${date}:3`]]);
});

test('search finds date-valid catalog identities without preparing analytics', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { dispatch } = createService({ db, workers: false, preparedOnly: true });
  importDataset(db, { provider: 'fixture', securities: [asset('AAA', '2024-03-07'), asset('BBB', '2024-03-08')],
    prices: [bar('AAA', '2024-03-07', 100), bar('BBB', '2024-03-08', 101)] });
  const response = await dispatch({ url: '/api/v1/stocks/search?q=company&date=2024-03-07&limit=5' });
  assert.equal(response.status, 200, response.body.error);
  assert.deepEqual(response.body.rows.map(({ symbol }) => symbol), ['AAA']);
  assert.equal(db.prepare('SELECT count(*) AS total FROM jobs').get().total, 0);
});

test('queued legacy recent preparations start with the newest standard and Monitor dates', async (t) => {
  const { db } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-07-14').slice(-125);
  importDataset(db, { provider: 'fixture', securities: [asset('AAA', dates[0])],
    prices: dates.map((date, index) => bar('AAA', date, 100 + index)) });
  const engine = createEngine(db);
  const { recentOrder, ...legacy } = preparationSpecs(db, engine, { universe: 'us-core', model: 'composite' })
    .find(({ phase, context }) => phase === 'recent' && context.universe === 'us-core' && context.model === 'composite');
  assert.equal(recentOrder, 'newest-interleaved');
  const first = await performJob(db, 'prepare-context', legacy);
  assert.deepEqual(first.batch, { from: dates.at(-60), to: dates.at(-1), sessions: 60, standard: true, baseComplete: false });
  assert.equal(first.continuation.recentOrder, 'newest-interleaved');
  const second = await performJob(db, 'prepare-context', { ...legacy, ...first.continuation });
  assert.deepEqual(second.batch, { ...first.batch, standard: false });
});

test('prepared-only screens with missing weekly or historical inputs withhold totals and exports', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2024-01-02', '2024-01-31');
  const context = { universe: 'sample', date: dates.at(-1) };
  importDataset(db, { provider: 'fixture', securities: [asset('AAA', dates[0])], prices: dates.map((date) => bar('AAA', date, 100)) });
  const { dispatch, engine } = createService({ db, workers: false, preparedOnly: true });
  engine.snapshot(engine.context(context));
  const velocity = await post(dispatch, 'screens/query', { context, computed: [{ field: 'custom_weekly', expression: 'velocity4w+1' }] });
  assert.equal(velocity.status, 202);
  assert.equal(velocity.body.total, null);
  assert.equal(velocity.body.pendingReason, 'Weekly RS signals');
  const lag = await post(dispatch, 'screens/query', { context, export: 'csv', filter: { expression: 'previous(close,1)>0' } });
  assert.equal(lag.status, 202);
  assert.equal(lag.body.total, null);
  assert.equal(lag.body.materialization.requiredDate, dates.at(-2));
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('historical range expressions require and use the prepared values from the comparison date', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2024-01-02', '2024-01-31');
  const prior = dates.at(-6);
  const date = dates.at(-1);
  const context = { universe: 'sample', date };
  importDataset(db, { provider: 'fixture', securities: [asset('AAA', dates[0])], prices: dates.map((session) =>
    bar('AAA', session, session === prior ? 90 : session === date ? 110 : 100)) });
  const { dispatch, engine } = createService({ db, workers: false, preparedOnly: true });
  for (const session of [date, prior]) engine.snapshot(engine.context({ ...context, date: session }));
  const prepare = (session) => performJob(db, 'prepare-range', { context: { universe: 'us-all', date: session }, windows: [5] });
  await prepare(date);
  const query = { context, computed: [
    { field: 'custom_prior', expression: 'previous(range_distance_high_5d,5)' },
    { field: 'custom_change', expression: 'change(range_distance_high_5d,5)' },
  ], filter: { expression: 'change(range_distance_high_5d,5)>0.09' }, all: true };
  const cold = await post(dispatch, 'screens/query', { ...query, export: 'csv' });
  assert.equal(cold.status, 202);
  assert.equal(cold.body.materialization.prepareAction, 'range');
  assert.equal(cold.body.materialization.requiredDate, prior);
  assert.deepEqual(cold.body.materialization.missingWindows, [5]);
  await prepare(prior);
  const ready = await post(dispatch, 'screens/query', query);
  assert.equal(ready.status, 200, ready.body.error);
  assert.equal(ready.body.total, 1);
  closeTo(ready.body.rows[0].custom_prior, -0.1);
  closeTo(ready.body.rows[0].custom_change, 0.1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('range alerts disclose deferred rules and compare both prepared values before a crossing', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2024-03-01', '2024-03-15');
  const latest = dates.at(-1);
  importDataset(db, { provider: 'fixture', securities: [asset('AAA', dates[0])],
    prices: dates.map((date, index) => bar('AAA', date, index === dates.length - 1 ? 110 : index === dates.length - 2 ? 90 : 100)) });
  const rule = await post(dispatch, 'alert-rules', { name: 'Return near rolling high', definition: {
    type: 'stocks', direction: 'enters', context: { universe: 'sample' },
    filter: { field: 'range_distance_high_5d', op: 'gte', value: -0.05 },
  } });
  const cold = await post(dispatch, 'alerts/evaluate', { context: { date: latest } });
  assert.equal(cold.body.evaluated, 0);
  assert.deepEqual(cold.body.deferred.map(({ ruleId, windows }) => [ruleId, windows]), [[rule.body.id, [5]]]);
  for (const date of dates.slice(-2)) {
    const prepared = await performJob(db, 'prepare-range', { context: { universe: 'us-all', date }, windows: [5] });
    assert.deepEqual(prepared.windows, [5]);
  }
  const events = await dispatch({ url: '/api/v1/alerts' });
  assert.deepEqual(events.body.map(({ action, symbol, date }) => [action, symbol, date]), [['enters', 'AAA', latest]]);
  assert.equal((await post(dispatch, 'alerts/evaluate', { context: { date: latest } })).body.fired, 0);
});

test('custom contributor reads reuse their prepared paired legacy breakout without creating work', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2024-01-02', '2024-03-20');
  const securities = ['UP', 'DOWN'].map((symbol) => asset(symbol, dates[0]));
  importDataset(db, { provider: 'fixture', securities, prices: dates.flatMap((date, index) => [
    bar('UP', date, index < 20 ? 100 : 140), bar('DOWN', date, index < 20 ? 100 : 70),
  ]) });
  const { dispatch, engine } = createService({ db, workers: false, preparedOnly: true });
  const context = { universe: 'sample', reference: 'as-of' };
  const paired = engine.context({ ...context, breadthKeys: ['up_17pct_37d', 'down_17pct_37d'] });
  const canonical = engine.snapshot(paired);
  materializeHistory(db, engine, paired, { limit: 2 });
  assert.equal(canonical.breadth.down_17pct_37d.numerator, 1);
  assert.equal(canonical.breadth.down_17pct_37d.denominator, 2);
  assert.equal(engine.snapshotAvailable(engine.context({ ...context, breadthKeys: ['down_17pct_37d'] })), false);
  const outcome = await dispatch({ url: '/api/v1/market/breadth/down_17pct_37d/contributors?universe=sample&reference=as-of' });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.total, 1);
  assert.deepEqual(outcome.body.rows.map(({ symbol }) => symbol), ['DOWN']);
  assert.deepEqual(outcome.body.metric, canonical.breadth.down_17pct_37d);
  const trend = await dispatch({ url: '/api/v1/market/breadth/down_17pct_37d?series=1&materializedOnly=1&limit=2&universe=sample&reference=as-of' });
  assert.equal(trend.body.materialization.complete, true);
  assert.equal(trend.body.rows.length, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('a named cohort freezes membership at submission revision and reports outcomes without rescreening', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2024-03-04', '2024-03-08');
  const securities = ['AAA', 'BBB'].map((symbol) => asset(symbol, dates[0]));
  importDataset(db, { provider: 'fixture', securities, prices: dates.flatMap((date) => [bar('AAA', date, 100), bar('BBB', date, 50)]) });
  const entry = dates[1];
  const queued = await post(dispatch, 'research/cohorts', { name: 'Frozen higher prices', date: entry, horizons: [1],
    context: { basis: 'reconstructed', universe: 'sample' }, screen: { filter: { field: 'close', op: 'gt', value: 75 } } });
  assert.equal(queued.status, 202);
  assert.deepEqual((await dispatch({ url: '/api/v1/cohorts' })).body, []);
  importDataset(db, { provider: 'fixture', prices: [bar('AAA', entry, 40), bar('BBB', entry, 110)] });
  const created = await completedJob(dispatch, queued.body.id);
  assert.equal(created.status, 'complete', created.error);
  assert.equal(created.result.selectionContext.dataVersion, 1);
  const [saved] = (await dispatch({ url: '/api/v1/cohorts' })).body;
  assert.deepEqual(saved.definition.frozen.members.map(({ symbol }) => symbol), ['AAA']);
  const rerun = await post(dispatch, `cohorts/${saved.id}/execute`, { screen: { filter: { field: 'symbol', value: 'BBB' } } });
  const replay = await completedJob(dispatch, rerun.body.id);
  assert.equal(replay.status, 'complete', replay.error);
  assert.equal(replay.result.selectionContext.dataVersion, 1);
  assert.equal(replay.result.dataVersion, 2);
  assert.equal(replay.result.memberCount, 1);
  assert.deepEqual(replay.result.results[0].members.map(({ securityId }) => securityId), ['fixture:AAA']);
});

test('the persisted queue runs one provider task across workspace connections and advances after failure', async (t) => {
  const { db, filename } = fileFixture(t);
  const another = openDatabase(filename);
  t.after(() => another.close());
  const date = '2024-01-02';
  const entered = Promise.withResolvers();
  const held = Promise.withResolvers();
  t.after(() => held.resolve());
  let running = 0;
  let maximum = 0;
  const order = [];
  const provider = {
    getSecurities: async () => [asset('FIRST', date), asset('SECOND', date)],
    async getDailyPrices({ symbol }) {
      running++;
      maximum = Math.max(maximum, running);
      order.push(symbol);
      try {
        if (symbol === 'FIRST.US') {
          entered.resolve();
          await held.promise;
          throw new Error('Fixture price feed failure');
        }
        return [bar('SECOND', date, 110)];
      } finally { running--; }
    },
  };
  const firstService = createService({ db, provider });
  const secondService = createService({ db: another, provider });
  const refresh = (service, symbol) => post(service.dispatch, 'data/refresh', { symbols: [symbol], from: date, to: date, actions: false });
  const first = await refresh(firstService, 'FIRST');
  assert.equal(first.body.status, 'queued');
  await entered.promise;
  const second = await refresh(secondService, 'SECOND');
  await delay(40);
  assert.deepEqual(order, ['FIRST.US']);
  assert.equal((await secondService.dispatch({ url: `/api/v1/jobs/${second.body.id}` })).body.status, 'queued');
  held.resolve();
  const failed = await completedJob(firstService.dispatch, first.body.id);
  const complete = await completedJob(secondService.dispatch, second.body.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Fixture price feed failure/);
  assert.equal(complete.status, 'complete', complete.error);
  assert.equal(complete.result.imported, 1);
  assert.deepEqual(order, ['FIRST.US', 'SECOND.US']);
  assert.equal(maximum, 1);
});

test('the worker prioritizes publication, selected ticker jobs, and primary preparation over the wider matrix', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE test_dispatch_order (id TEXT);
    CREATE TRIGGER test_record_dispatch AFTER UPDATE OF status ON jobs WHEN NEW.status='running' BEGIN
      INSERT INTO test_dispatch_order VALUES (NEW.id);
    END`);
  const core = { universe: 'us-core', model: 'composite', basis: 'reconstructed', reference: 'latest' };
  const context = (phase, config) => ['prepare-context', { phase, context: { ...core, ...config }, historySessions: 1 }];
  const preferences = [
    ['backup', {}],
    ['prepare-stock-details', { securityIds: ['fixture:AAA'], context: core }],
    context('current', core),
    ['prepare-stock-details', { context: core }],
    ['prepare-range', { context: core, windows: [20] }],
    context('recent', { universe: 'us-all' }),
    context('history', { universe: 'nyse', reference: 'as-of' }),
    context('current', { universe: 'nyse', model: 'short-momentum' }),
    context('recent', { universe: 'nyse' }),
    context('history', { universe: 'us-all' }),
  ];
  // Within the shared current products priority, the longer waiting task gets the slot.
  const queued = preferences.map(([type, payload], index) => ({ type, payload, priority: index === 4 ? 3 : index }));
  const inserted = [...queued].reverse().map(({ type, payload, priority }) => ({ ...createJob(db, type, payload), priority }));
  const { dispatch } = createService({ db, workers: false });
  await completedJob(dispatch, inserted[0].id);
  const actual = db.prepare('SELECT id FROM test_dispatch_order ORDER BY rowid').all().map(({ id }) => id);
  assert.deepEqual(actual, inserted.toSorted((a, b) => a.priority - b.priority).map(({ id }) => id));
});

test('persisted queued jobs resume through real worker threads and checkpoint contention leaves completion intact', async (t) => {
  const { db, filename } = fileFixture(t);
  const date = '2024-01-02';
  importDataset(db, { provider: 'fixture', securities: [asset('HOLD', date)], prices: [bar('HOLD', date, 100)] });
  const bad = createJob(db, 'fixture-unknown-job', {});
  const next = createJob(db, 'materialize', { limit: 1 });
  const reader = openDatabase(filename);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM jobs').get();
  try {
    const { dispatch } = createService({ db });
    const failed = await completedJob(dispatch, bad.id);
    const complete = await completedJob(dispatch, next.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Unknown background job/);
    assert.equal(complete.status, 'complete', complete.error);
    assert.equal(complete.result.written, 1);
    assert.equal(reader.prepare("SELECT count(*) AS n FROM jobs WHERE status='queued'").get().n, 2);
  } finally { reader.exec('ROLLBACK'); reader.close(); }
});

test('saved-screen alerts, execution, stock membership and dynamic lists share their saved model, market and lookbacks', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-03-08');
  const last = dates.at(-1);
  importDataset(db, { provider: 'fixture', securities: [asset('EXT', dates[0], { exchange: 'NYSE AMERICAN' }), asset('CORE', dates[0])],
    prices: dates.flatMap((date) => [bar('EXT', date, date === last ? 120 : 100), bar('CORE', date, 100)]) });
  const model = (await post(dispatch, 'ranking-models', { name: 'Fixture short model',
    definition: { method: 'weighted', windows: [{ kind: 'sessions', length: 3, weight: 1 }] } })).body;
  const screen = (await post(dispatch, 'screens', { name: 'Extended 37D movers',
    definition: { context: { universe: 'us-extended', model: model.id }, filter: { field: 'return_37d', op: 'gt', value: 0.1 } } })).body;
  const rule = (await post(dispatch, 'alert-rules', { name: 'Extended membership',
    definition: { type: 'screen', screenId: screen.id, direction: 'enters', context: { universe: 'us-core', model: 'composite' } } })).body;
  const execute = await post(dispatch, `screens/${screen.id}/execute`, {});
  assert.deepEqual(execute.body.rows.map((stock) => stock.symbol), ['EXT']);
  const evaluated = await post(dispatch, 'alerts/evaluate', { context: { date: last, universe: 'us-core', dataVersion: 1 } });
  assert.equal(evaluated.body.fired, 1);
  assert.equal((await post(dispatch, 'alerts/evaluate', { context: { date: last } })).body.fired, 0);
  const events = await dispatch({ url: '/api/v1/alerts' });
  assert.deepEqual(events.body.map(({ ruleId, symbol, universe, model: scored }) => [ruleId, symbol, universe, scored]),
    [[rule.id, 'EXT', 'us-extended', model.id]]);
  const watch = (await post(dispatch, 'watchlists', { name: 'Dynamic', definition: { screenId: screen.id } })).body;
  const members = await dispatch({ url: `/api/v1/watchlists/${watch.id}/members?universe=us-core&model=composite` });
  assert.deepEqual(members.body.rows.map(({ symbol }) => symbol), ['EXT']);
  const detail = await dispatch({ url: '/api/v1/stocks/EXT/screens?universe=us-core&model=composite' });
  assert.equal(detail.body.screens[0].id, screen.id);
});

test('breadth surge uses the requested session lag and direct stock crossings ignore unavailable prior metrics', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-01-11');
  const last = dates.at(-1);
  importDataset(db, { provider: 'fixture', securities: [asset('UP', dates[0]), asset('MISSING', dates[0])],
    prices: [...dates.map((date) => bar('UP', date, date === last ? 120 : 100)), bar('MISSING', last, 200)] });
  await post(dispatch, 'alert-rules', { name: 'Participation jump', definition: { type: 'breadth', metric: 'up_13pct_2d',
    trigger: 'surge', direction: 'above', lookback: 2, threshold: 60, context: { universe: 'sample' } } });
  await post(dispatch, 'alert-rules', { name: 'Confirmed price crossing', definition: { type: 'stocks',
    filter: { expression: 'close > 150' }, direction: 'enters', context: { universe: 'sample' } } });
  const evaluation = await post(dispatch, 'alerts/evaluate', { context: { date: last } });
  assert.equal(evaluation.body.fired, 1);
  const { body: events } = await dispatch({ url: '/api/v1/alerts' });
  assert.deepEqual(events.map(({ trigger, previous, value, change, comparisonDate }) => [trigger, previous, value, change, comparisonDate]),
    [['surge', 0, 100, 100, dates.at(-3)]]);
});

test('weekly Explorer and group comparisons start at 100 and compound all intervening session returns', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2024-03-04', '2024-03-15');
  importDataset(db, { provider: 'fixture', securities: [asset('SERIES', dates[0])],
    prices: dates.map((date, index) => bar('SERIES', date, 100 * 1.01 ** index)),
    fundamentals: [{ symbol: 'SERIES', effectiveDate: dates[0], knownAt: dates[0], sharesOutstanding: 1000 }],
    classifications: [{ symbol: 'SERIES', effectiveFrom: dates[0], knownAt: dates[0], sector: 'Sector A', industry: 'Industry A' }] });
  const { body: groups } = await dispatch({ url: '/api/v1/industries' });
  const id = groups.groups.find((group) => group.level === 'industry').id;
  const query = 'from=2024-03-04&to=2024-03-15&cadence=weekly&limit=2';
  const { body: market } = await dispatch({ url: '/api/v1/market/breadth?series=1&metrics=capWeightIndex&' + query });
  const { body: industry } = await dispatch({ url: `/api/v1/industries/compare?ids=${encodeURIComponent(id)}&${query}` });
  assert.equal(market.rows[0].equalWeightIndex, 100);
  assert.equal(market.rows[0].capWeightIndex, 100);
  closeTo(market.rows[1].capWeightIndex, 100 * 1.01 ** 5);
  assert.equal(industry.rows[0].groups[0].index, 100);
  closeTo(industry.rows[1].groups[0].index, 100 * 1.01 ** 5);
  closeTo(industry.rows[1].groups[0].capWeightIndex, 100 * 1.01 ** 5);
  closeTo(industry.rows[1].groups[0].dailyReturn, 1.01 ** 5 - 1);
});

test('history exposes stored top-decile leadership persistence and turnover with their actual denominator', async (t) => {
  const { db, dispatch, engine } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-07-01').slice(-80);
  const date = dates.at(-1);
  const names = ['LEADER', 'SECOND', 'UNCHANGED'];
  importDataset(db, { provider: 'fixture', securities: names.map((symbol) => asset(symbol, dates[0])),
    prices: names.flatMap((symbol, rank) => dates.map((day, index) => {
      const close = rank === 0 && day === date ? 90 : 100 + (2 - rank) * index;
      return bar(symbol, day, close);
    })) });
  const context = engine.context({ model: 'short-momentum' });
  materializeHistory(db, engine, context, { limit: 3 });
  const queries = '/api/v1/market/breadth?series=1&model=short-momentum&metrics=leadershipPersistence,leadershipTurnover';
  const { body } = await dispatch({ url: queries + '&limit=3&materializedOnly=1' });
  assert.deepEqual(body.metrics, ['leadershipPersistence', 'leadershipTurnover']);
  assert.deepEqual([body.rows.at(-2).leadershipPersistence, body.rows.at(-2).leadershipTurnover], [100, 0]);
  const row = body.rows.at(-1);
  assert.deepEqual([row.leadershipPersistence, row.leadershipTurnover, row.leadershipRankObservations, row.leaderReturnExpected, row.previousLeaderDate],
    [0, 100, 1, 1, dates.at(-2)]);
  const unavailable = (await dispatch({ url: queries + `&date=${dates[1]}&limit=1` })).body.rows[0];
  assert.deepEqual([unavailable.leadershipPersistence, unavailable.leadershipTurnover, unavailable.leadershipRankObservations], [null, null, 0]);
  const csv = await dispatch({ url: queries + '&limit=3&materializedOnly=1&export=csv' });
  assert.match(csv.body.split('\r\n')[0], /leadershipPersistence,leadershipTurnover,leadershipRankObservations,leaderReturnExpected,previousLeaderDate/);
});

test('observed historical event research reuses materialized inputs and leaves verified coverage withheld', async (t) => {
  const { db, engine, dispatch } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-04-15');
  const names = Array.from({ length: 21 }, (_, index) => `ACT${index}`);
  importDataset(db, { provider: 'fixture', scope: 'sample',
    securities: [...names.map((symbol) => asset(symbol, dates[0])), asset('SPY', dates[0], { type: 'etf' })],
    prices: dates.flatMap((date, index) => [...names.map((symbol) => bar(symbol, date, index === 55 ? 180 : 100 + index)), bar('SPY', date, 300 + index)]) });
  const context = { basis: 'reconstructed', classification: 'provider', reference: 'as-of', benchmark: 'SPY' };
  materializeHistory(db, engine, engine.context(context), { limit: dates.length });
  const payload = { context, start: dates[55], end: dates[58], asOf: dates.at(-1), horizons: [5],
    condition: { metric: 'above_50d', op: 'gt', value: 75 }, benchmarks: ['SPY'] };
  const verified = await performJob(db, 'event-study', payload);
  const observed = await performJob(db, 'event-study', { ...payload, coverageMode: 'observed' });
  assert.equal(verified.matchedCount, 0);
  assert.equal(observed.descriptive, true);
  assert.equal(observed.matchedCount, 4);
  assert.equal(observed.events[0].coverageEvidence.observedTraded, 21);
  assert.equal(observed.results[0].benchmarks.SPY.count, 1);
  assert.ok(observed.results[0].benchmarks.SPY.mean > 0);
  assert.deepEqual(observed.observationSources, { archived: 4, computed: 0 });
  const crossing = await performJob(db, 'event-study', { ...payload, coverageMode: 'observed',
    condition: { metric: 'up_4pct', op: 'crossesAbove', value: 50 } });
  assert.deepEqual(crossing.events.map(({ date }) => date), [dates[55]]);
  assert.equal(crossing.observationSources.supportingSessions, 1);
  const restricted = await performJob(db, 'event-study', { ...payload, coverageMode: 'observed', observedMinimum: '22', observedThreshold: '0.75' });
  assert.equal(restricted.observedMinimum, 22);
  assert.equal(restricted.observedThreshold, 0.75);
  assert.equal(restricted.matchedCount, 0);
  const invalid = await post(dispatch, 'research/event-studies', { ...payload, coverageMode: 'observed', observedMinimum: 3.5 });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /whole number/);
});

test('observed divergences persist their dated evidence without appearing in the verified ledger', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-04-15');
  const names = Array.from({ length: 21 }, (_, index) => `ROW${index}`);
  const last = dates.at(-1);
  importDataset(db, { provider: 'fixture', scope: 'sample',
    securities: [...names.map((symbol) => asset(symbol, dates[0])), asset('SPY', dates[0], { type: 'etf' })],
    prices: dates.flatMap((date, index) => [...names.map((symbol) => bar(symbol, date, date === last ? 80 : 100 + index)),
      bar('SPY', date, 300 + index)]) });
  const url = '/api/v1/market/events?limit=63&coverageMode=';
  assert.deepEqual((await dispatch({ url: url + 'observed' })).body.events, []);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='divergence_events'").get(), undefined);
  const prepare = async (options) => {
    const queued = await post(dispatch, 'market/health/prepare', options);
    assert.equal(queued.status, 202);
    const result = await completedJob(dispatch, queued.body.id);
    assert.equal(result.status, 'complete', result.error);
  };
  await prepare({ coverageMode: 'observed' });
  const observed = await dispatch({ url: url + 'observed' });
  assert.equal(observed.status, 200, observed.body.error);
  const event = observed.body.events.find(({ id }) => id === 'benchmark_high_breadth_falls');
  assert.equal(event.date, last);
  assert.equal(event.dataVersion, 1);
  assert.ok(event.observedAt);
  const persisted = db.prepare('SELECT count(*) AS count FROM divergence_events').get().count;
  assert.deepEqual((await dispatch({ url: url + 'observed' })).body.events, observed.body.events);
  assert.equal(db.prepare('SELECT count(*) AS count FROM divergence_events').get().count, persisted);
  await prepare({ coverageMode: 'observed', observedMinimum: 15, observedThreshold: 0.75 });
  const adjusted = await dispatch({ url: url + 'observed&observedMinimum=15&observedThreshold=0.75' });
  assert.equal(adjusted.body.observedMinimum, 15);
  assert.equal(adjusted.body.observedThreshold, 0.75);
  assert.ok(adjusted.body.events.some(({ id }) => id === 'benchmark_high_breadth_falls'));
  assert.equal(db.prepare('SELECT count(DISTINCT recipe) AS count FROM divergence_events').get().count, 2);
  assert.deepEqual((await dispatch({ url: url + 'verified' })).body.events, []);
});

test('prepared health is read-only and reuses earlier sessions across an append-only price revision', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2024-01-02', '2024-04-15');
  const last = dates.at(-1);
  const { dispatch, engine } = createService({ db, workers: false, preparedOnly: true });
  const first = importDataset(db, { provider: 'fixture', securities: [asset('AAA', dates[0])],
    prices: dates.slice(0, -1).map((date) => bar('AAA', date, 100)) });
  const context = { universe: 'sample', reference: 'as-of' };
  const get = () => dispatch({ url: '/api/v1/market/health?universe=sample&reference=as-of&series=1&limit=2' });
  const unprepared = await get();
  assert.equal(unprepared.body.state, 'unprepared');
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  const recent = preparationSpecs(db, engine, context, { requested: context }).find(({ phase }) => phase === 'recent');
  const prerequisite = createJob(db, 'prepare-context', recent);
  const breadthQueued = await get();
  assert.equal(breadthQueued.body.materialization.prepareAction, 'health');
  assert.equal(breadthQueued.body.materialization.pending, undefined);
  assert.equal(breadthQueued.body.contextPreparation.jobId, prerequisite.id);
  assert.equal(breadthQueued.body.contextPreparation.status, 'queued');
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  updateJob(db, prerequisite.id, 'complete', 100, {});
  materializeHistory(db, engine, engine.context(context), { limit: dates.length });
  const firstJob = await post(dispatch, 'market/health/prepare', { context });
  const firstResult = await completedJob(dispatch, firstJob.body.id);
  assert.equal(firstResult.status, 'complete', firstResult.error);
  const second = importDataset(db, { provider: 'fixture', prices: [bar('AAA', last, 101)] });
  materializeHistory(db, engine, engine.context(context), { limit: dates.length });
  const secondJob = await post(dispatch, 'market/health/prepare', { context });
  const secondResult = await completedJob(dispatch, secondJob.body.id);
  assert.equal(secondResult.status, 'complete', secondResult.error);
  assert.equal(secondResult.result.reused, dates.length - 1);
  const history = await get();
  assert.deepEqual(history.body.history.map(({ date, dataVersion }) => [date, dataVersion]),
    [[dates.at(-2), first.version], [last, second.version]]);
  assert.equal(history.body.materialization, undefined);
});

test('an explicit observed comparable fraction changes health eligibility while verified coverage stays withheld', async (t) => {
  const { db, dispatch } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-04-15');
  const names = Array.from({ length: 21 }, (_, index) => `MIN${index}`);
  importDataset(db, { provider: 'fixture', scope: 'sample',
    securities: [...names.map((symbol) => asset(symbol, dates[0])), asset('SPY', dates[0], { type: 'etf' })],
    prices: dates.flatMap((date, index) => [
      ...(date === dates.at(-1) ? names.slice(0, 16) : names).map((symbol) => bar(symbol, date, 100 + index)),
      bar('SPY', date, 300 + index),
    ]) });
  const context = 'series=1&limit=1&observedMinimum=15';
  const ordinary = await dispatch({ url: '/api/v1/market/health?coverageMode=observed&' + context });
  const looser = await dispatch({ url: '/api/v1/market/health?coverageMode=observed&observedThreshold=.75&' + context });
  const strict = await dispatch({ url: '/api/v1/market/health?observedThreshold=.75&' + context });
  assert.equal(ordinary.body.coverage.ready, false);
  assert.equal(looser.body.coverage.ready, true);
  assert.equal(looser.body.coverage.observed.threshold, 0.75);
  assert.equal(looser.body.coverage.observed.minimum, 15);
  assert.equal(looser.body.coverage.observed.ratio, 16 / 21);
  assert.equal(strict.body.coverage.ready, false);
  assert.equal(strict.body.descriptive, false);
  const invalidAnalog = await dispatch({ url: '/api/v1/market/analogs?coverageMode=observed&observedThreshold=1.5' });
  assert.equal(invalidAnalog.status, 400);
  assert.match(invalidAnalog.body.error, /fraction/);
});

test('index symbols use the official EODHD suffix and daily index outages leave Core capture intact', async (t) => {
  const date = latestFinalizableSession();
  const requests = [];
  const adapter = EodhdProvider({ apiKey: 'fixture-api-key', fetcher: async (address) => {
    requests.push(new URL(address).pathname);
    return new Response(JSON.stringify([{ ...bar('IGNORED', date, 20_000), symbol: undefined }]));
  } });
  assert.equal((await adapter.getDailyPrices({ symbol: 'IXIC', from: date, to: date }))[0].symbol, 'IXIC');
  assert.deepEqual(await adapter.getCorporateActions({ symbol: 'IXIC' }), []);
  await adapter.getDailyPrices({ symbol: 'IXIC.US', from: date, to: date });
  assert.deepEqual(requests, ['/api/eod/IXIC.INDX','/api/eod/IXIC.INDX']);
  const { db } = fixture(t);
  const provider = { getSecurities: async () => [asset('CORE', '2020-01-02')],
    getDailyPrices: async () => [bar('CORE', date, 100)], getIndexDailyPrices: async () => [bar('IXIC', date, 20_000)] };
  const full = await importProviderData({ bulk: true, date, actions: false }, { db, provider });
  assert.equal(full.captures[0].indexReceived, true);
  assert.equal(full.captures[0].eligibleReceived, 1);
  assert.equal(full.captures[0].expected, 1);
  const repeat = await importProviderData({ bulk: true, date, actions: false, force: true }, { db, provider });
  assert.equal(repeat.imported, 0);
  assert.deepEqual(repeat.captures, full.captures);
  const stored = createEngine(db).snapshot(createEngine(db).context({ benchmark: 'IXIC' }));
  assert.equal(stored.aggregates.benchmarkClose, 20_000);
  provider.getIndexDailyPrices = async () => { throw new Error('Fixture index outage'); };
  provider.getDailyPrices = async () => [bar('CORE', date, 102), bar('IXIC', date, 2)];
  const degraded = await importProviderData({ bulk: true, date, actions: false, force: true }, { db, provider });
  assert.equal(degraded.captures[0].indexReceived, false);
  assert.equal(degraded.captures[0].eligibleReceived, 1);
  assert.ok(degraded.warnings.some((warning) => /Fixture index outage/.test(warning)));
  assert.equal(db.prepare("SELECT close FROM daily_prices WHERE security_id LIKE 'eodhd:IXIC:%' AND date=?").get(date).close, 20_000);
});

test('cold high-history screens return a pending job before computing any enriched result on the request thread', async (t) => {
  const { db, dispatch, engine } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-01-10');
  importDataset(db, { provider: 'fixture', securities: [
    asset('HIGH', dates[0]), ...Array.from({ length: 300 }, (_, i) => asset(`REF${i}`, dates[0], { type: 'preferred' })),
  ], prices: dates.map((date, i) => bar('HIGH', date, 100 + i)) });
  const snapshot = engine.snapshot;
  let inlineSnapshots = 0;
  engine.snapshot = (...args) => { inlineSnapshots++; return snapshot(...args); };
  const fields = { columns: ['symbol', 'distance_all_time_high'], filter: { field: 'distance_all_time_high', op: 'gte', value: -0.1 } };
  const pending = await post(dispatch, 'screens/query', fields);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.pendingOnly, true);
  assert.equal(pending.body.total, null);
  assert.equal(inlineSnapshots, 0);
  const path = `/api/v1/jobs/${pending.body.materialization.jobId}`;
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await dispatch({ url: path })).body;
    if (['complete', 'failed'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.payload.context.includeAllTimeHigh, true);
  const enriched = await post(dispatch, 'screens/query', fields);
  assert.equal(enriched.status, 200);
  assert.equal(enriched.body.rows[0].distance_all_time_high, 0);
});

test('percentile health calibration uses the model lookback independently of displayed range', async (t) => {
  const { db, engine, dispatch } = fixture(t);
  const dates = expectedSessions('2024-01-02', '2024-07-12');
  const names = Array.from({ length: 12 }, (_, index) => `HL${index}`);
  importDataset(db, { provider: 'fixture', scope: 'full', expected: names.length,
    securities: [...names.map((symbol) => asset(symbol, dates[0])), asset('SPY', dates[0], { type: 'etf' })],
    prices: dates.flatMap((date,index) => [...names.map((symbol, member) => bar(symbol,date,100+index+20*Math.sin((index+member)/5))),
      bar('SPY',date,300+index)]) });
  materializeHistory(db, engine, engine.context(), { limit: dates.length });
  const saved = await post(dispatch, 'health-models', { name: 'Breadth percentile', definition: {
    weights: { shortBreadth: 1, intermediateBreadth: 0, longBreadth: 0, priceMomentum: 0,
      volumeParticipation: 0, industryLeadership: 0, highsLows: 0 },
    calibration: { shortBreadth: { type: 'percentile', lookback: 80, minObservations: 60 } },
  } });
  assert.equal(saved.status, 201, saved.body.error);
  const query = `healthModel=${saved.body.id}`;
  const first = await dispatch({ url: '/api/v1/market/overview?' + query });
  const one = await dispatch({ url: '/api/v1/market/health?series=1&limit=1&' + query });
  const two = await dispatch({ url: '/api/v1/market/health?series=1&limit=10&' + query });
  assert.ok(Number.isFinite(first.body.health.score), JSON.stringify(first.body.health.missingComponents));
  assert.equal(one.body.score, first.body.health.score);
  assert.equal(two.body.score, first.body.health.score);
  assert.equal(one.body.history.length, 1);
  assert.equal(two.body.history.length, 10);
  assert.equal(one.body.history[0].score, two.body.history.at(-1).score);
  assert.equal(one.body.history[0].components[0].calibration.observations, 80);
});

test('an ordered historical capture reuses bounded retry offsets inside the current-roster window', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const date = '2024-03-11';
  const status = (stamp, ordered = true) => dailyCaptureAvailability(db, date, new Date(stamp), undefined, { ordered });
  const fail = (stamp, captureAttempt) => {
    const { id } = createJob(db, 'provider-import', { scheduledFor: date, captureAttempt });
    updateJob(db, id, 'failed', 0, null, 'Mock provider outage');
    db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(stamp, id);
  };
  assert.equal(status('2024-03-12T15:30:00Z').due, true);
  fail('2024-03-12T15:30:00Z', 1);
  assert.equal(status('2024-03-12T15:39:59Z').state, 'waiting');
  assert.equal(status('2024-03-12T15:40:00Z').due, true);
  assert.equal(status('2024-03-12T15:40:00Z', false).state, 'exhausted');
  fail('2024-03-12T15:40:00Z', 2);
  assert.equal(status('2024-03-12T15:55:00Z').due, true);
  fail('2024-03-12T15:55:00Z', 3);
  assert.equal(status('2024-03-12T16:20:00Z').due, true);
  fail('2024-03-12T16:20:00Z', 4);
  assert.equal(status('2024-03-12T17:00:00Z').state, 'exhausted');
  assert.equal(status('2024-03-19T15:40:00Z').state, 'outside_verification_window');
});

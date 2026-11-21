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
import { EodhdProvider, importProviderData } from '../backend/provider.mjs';
import { createService, performJob, scheduledPrecomputeKey } from '../backend/service.mjs';
import { savedScreenRoute, tradingViewUrl } from '../frontend/ui.js';

const bar = (symbol, date, close) => ({ symbol, date, open: close, low: close, high: close, close,
  adjusted_close: close, volume: 100, knownAt: date });
const asset = (symbol, listingDate, extra = {}) => ({ symbol, name: `${symbol} Company`, exchange: 'NYSE', type: 'common',
  listingDate, knownAt: listingDate, ...extra });
const post = (dispatch, path, body) => dispatch({ method: 'POST', url: '/api/v1/' + path, body });
const closeTo = (value, target) => assert.ok(Math.abs(value - target) < 1e-8, `${value} ≉ ${target}`);

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
  const observed = await dispatch({ url: url + 'observed' });
  assert.equal(observed.status, 200, observed.body.error);
  const event = observed.body.events.find(({ id }) => id === 'benchmark_high_breadth_falls');
  assert.equal(event.date, last);
  assert.equal(event.dataVersion, 1);
  assert.ok(event.observedAt);
  const persisted = db.prepare('SELECT count(*) AS count FROM divergence_events').get().count;
  assert.deepEqual((await dispatch({ url: url + 'observed' })).body.events, observed.body.events);
  assert.equal(db.prepare('SELECT count(*) AS count FROM divergence_events').get().count, persisted);
  const adjusted = await dispatch({ url: url + 'observed&observedMinimum=15&observedThreshold=0.75' });
  assert.equal(adjusted.body.observedMinimum, 15);
  assert.equal(adjusted.body.observedThreshold, 0.75);
  assert.ok(adjusted.body.events.some(({ id }) => id === 'benchmark_high_breadth_falls'));
  assert.equal(db.prepare('SELECT count(DISTINCT recipe) AS count FROM divergence_events').get().count, 2);
  assert.deepEqual((await dispatch({ url: url + 'verified' })).body.events, []);
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

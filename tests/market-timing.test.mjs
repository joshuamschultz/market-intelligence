import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase, CALCULATION_VERSION, dataVersion } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { materializeHistory } from '../backend/materialization.mjs';
import { prepareDailyMarketTiming, prepareMarketTiming, readPreparedMarketTiming, replayMarketTiming, TIMING_MODEL_VERSION } from '../backend/market-timing.mjs';
import { createService, performJob } from '../backend/service.mjs';

const sessions = expectedSessions('2025-01-02', '2026-05-29');
const warm = Array.from({ length: 60 }, (_, index) => ({ close: 100 + index * .2, volume: 100 }));
const signals = (row) => row.signals.map(({ type }) => type);

function replay(prices, symbol = 'SPY', breadth = new Map()) {
  const dates = sessions.slice(0, prices.length);
  return replayMarketTiming(dates, { [symbol]: new Map(prices.flatMap((bar, index) => bar ? [[dates[index], {
    low: bar.close * .99, volume: 100, ...bar,
  }]] : [])) }, breadth).map((row) => row.instruments[symbol]);
}

const recovery = [
  { close: 90, low: 88, volume: 110 }, { close: 89, low: 86, volume: 120 },
  { close: 90, low: 87, volume: 90 }, { close: 90.5, low: 88, volume: 100 },
  { close: 92, low: 89, volume: 110 }, { close: 92 * 1.0125, low: 92, volume: 120 },
  { close: 95, low: 93, volume: 130 }, { close: 94, low: 90, volume: 90 },
];

test('rally day 3 cannot confirm, day 4 qualifies at the boundary, and the first confirmation low protects the attempt', () => {
  const rows = replay([...warm, ...recovery]);
  assert.equal(rows[0].phase, 'unknown');
  assert.equal(rows[0].warmup, true);
  assert.equal(rows[19].trend.averages.ema21, null);
  assert.equal(rows[20].trend.averages.ema21, 102);
  assert.equal(rows[59].phase, 'baseline');
  assert.equal(rows[61].phase, 'correction');
  assert.equal(rows[62].rally.day, 1);
  assert.equal(rows[62].rally.low, 86);
  assert.equal(rows[64].candidate.day, 3);
  assert.equal(rows[64].candidate.priceQualified, false);
  assert.ok(!signals(rows[64]).includes('follow-through'));
  assert.equal(rows[65].candidate.day, 4);
  assert.equal(rows[65].phase, 'confirmed');
  assert.equal(rows[65].confirmation.low, 92);
  assert.ok(signals(rows[65]).includes('follow-through'));
  assert.ok(signals(rows[66]).includes('subsequent-follow-through'));
  assert.equal(rows[67].phase, 'correction');
  assert.ok(signals(rows[67]).includes('follow-through-low-break'));
  assert.ok(!signals(rows[67]).includes('rally-low-break'));
});

test('rally undercut resets the clock and volume gaps distinguish a candidate from confirmation', () => {
  const undercut = replay([...warm, ...recovery.slice(0, 5), { close: 95, low: 85, volume: 200 }, { close: 96, low: 85, volume: 210 }]);
  assert.equal(undercut[65].phase, 'correction');
  assert.ok(signals(undercut[65]).includes('rally-low-break'));
  assert.equal(undercut[66].rally.day, 1);
  for (const volume of [0, null, 110]) {
    const row = replay([...warm, ...recovery.slice(0, 5), { ...recovery[5], volume }]).at(-1);
    assert.equal(row.phase, 'rally');
    assert.equal(row.candidate.priceQualified, true);
    assert.equal(row.signals.find(({ type }) => type === 'follow-through-candidate').reason, volume === 110 ? 'volume-not-higher' : 'volume-unavailable');
  }
  const interrupted = replay([...warm, ...recovery.slice(0, 4), null, { close: 100, low: 95, volume: 130 }]);
  assert.ok(signals(interrupted.at(-2)).includes('rally-continuity-unknown'));
  assert.equal(interrupted.at(-1).phase, 'unknown');
  assert.equal(interrupted.at(-1).evidence.dayReturn, null);
});

test('distribution uses the preceding session and expires at exact age 25 or exact 5% recovery', () => {
  const start = [{ close: 100, volume: 100 }, { close: 99.8, volume: 101 }];
  const rows = replay([...start, ...Array.from({ length: 25 }, () => ({ close: 99.8, volume: 104 }))]);
  assert.deepEqual(signals(rows[1]), ['distribution']);
  assert.equal(rows[1].distribution.active[0].previousVolume, 100);
  assert.equal(rows[25].distribution.active[0].age, 24);
  assert.equal(rows[26].distribution.count, 0);
  assert.equal(rows[26].distribution.expired[0].expiryReason, 'session-window');
  const recoveryClose = 99.8 * 1.05;
  const repaired = replay([...start, { close: recoveryClose - .001 }, { close: recoveryClose }]);
  assert.equal(repaired[2].distribution.count, 1);
  assert.equal(repaired[3].distribution.expired[0].expiryReason, 'price-recovery');
  for (const comparison of [
    { close: 99.799, volume: 100 }, { close: 99.799, volume: 0 }, { close: 99.799, volumeQuarantined: true },
    { priceQuarantined: true, close: 99.799 }, { unverifiedSplit: true, close: 99.799 }, null,
  ]) {
    const series = replay([{ close: 100, volume: 100 }, comparison, { close: 99, volume: 1_000 }]);
    assert.equal(series[1].distribution.count, 0);
    if (!comparison || comparison.volume === 0 || comparison.volumeQuarantined || comparison.priceQuarantined || comparison.unverifiedSplit) {
      assert.equal(series[2].distribution.count, 0);
    }
  }
});

test('benchmark states stay separate, price-only trends survive absent volume, and later bars cannot rewrite earlier output', () => {
  const slowlyRising = Array.from({ length: 215 }, (_, index) => ({ close: 100 + index, low: 99 + index, volume: null }));
  const prefix = replay(slowlyRising);
  const full = replay([...slowlyRising, ...recovery]);
  assert.deepEqual(prefix, full.slice(0, prefix.length));
  assert.equal(prefix.at(-1).trend.state, 'rising');
  assert.equal(prefix.at(-1).trend.strongTrend.active, true);
  assert.equal(prefix.at(-1).trend.averages.sma200, 214.5);
  assert.equal(prefix.at(-1).distribution.comparableSessions, 0);
  const rows = replayMarketTiming(sessions.slice(0, 2), {
    SPY: new Map([[sessions[0], { close: 100, low: 99, volume: 100 }], [sessions[1], { close: 99, low: 98, volume: 110 }]]),
    IXIC: new Map([[sessions[0], { close: 100, low: 99, volume: 100 }], [sessions[1], { close: 99, low: 98, volume: 90 }]]),
  });
  assert.deepEqual(Object.values(rows[1].instruments).map((row) => row.distribution.count), [1, 0, 0]);
});

test('leader response uses archived lagged cohorts and leaves unobserved sessions unknown', () => {
  const dates = sessions.slice(0, 8);
  const cohortValue = (date, index) => ({ date, aggregates: { previousLeaderDate: dates[index - 1], leaderReturnExpected: 10,
    leaderReturnObservations: index === 7 ? 7 : 8, leaderReturn: .01, leadershipPersistence: .5 } });
  const rows = replayMarketTiming(dates, {}, new Map(dates.map((date, index) => [date, cohortValue(date, index)])));
  assert.equal(rows[4].leadership.return5d, null);
  assert.ok(Math.abs(rows[5].leadership.return5d - (1.01 ** 5 - 1)) < 1e-12);
  assert.equal(rows[7].leadership.return5d, null);
  assert.equal(rows[7].risk.personalTradeFeedback, 'unknown');
});

const metric = (numerator, denominator = 100) => ({ numerator, denominator, value: 100 * numerator / denominator });
const breadthInputs = (date, previousLeaderDate) => ({ date, coverage: { traded: 100 }, breadth: {
  above_20d: metric(76), above_50d: metric(70), above_200d: metric(65), new_high_20d: metric(33), new_low_20d: metric(10),
}, aggregates: { volumeObservations: 95, upVolume: 5000, downVolume: 3000,
  previousLeaderDate, leaderReturnExpected: 10, leaderReturnObservations: 10, leaderReturn: .01 } });

test('breadth branches require their own comparable observations and supportive breadth requires observed volume', () => {
  const dates = sessions.slice(0, 3);
  const weak = breadthInputs(dates[0]);
  Object.assign(weak.breadth, { above_20d: metric(14), above_50d: metric(22), above_200d: metric(20, 79), new_low_20d: metric(40) });
  const unobservedVolume = breadthInputs(dates[1]);
  unobservedVolume.aggregates.volumeObservations = 0;
  const rows = replayMarketTiming(dates, {}, new Map([[dates[0], weak], [dates[1], unobservedVolume], [dates[2], breadthInputs(dates[2])]]));
  assert.equal(rows[0].breadth.state, 'weak');
  assert.equal(rows[0].breadth.comparability.above_200d.usable, false);
  assert.equal(rows[0].breadth.comparability.above_200d.share, .79);
  assert.equal(rows[0].breadth.comparability.above_50d.usable, true);
  assert.equal(rows[1].breadth.state, 'mixed');
  assert.equal(rows[1].breadth.volume.balance, 'unavailable');
  assert.equal(rows[2].breadth.state, 'supportive');
});

test('missing benchmark volume leaves the price trend available and prevents constructive posture', () => {
  const rising = Array.from({ length: 50 }, (_, index) => ({ close: 96 + index, volume: index < 24 ? 151 : 0 }));
  const prices = [...warm, ...recovery.slice(0, 7), ...rising];
  const dates = sessions.slice(0, prices.length);
  const bars = new Map(prices.map(({ close, low = close - 1, volume }, index) => [dates[index], { close, low, volume }]));
  const rows = replayMarketTiming(dates, { SPY: bars, IXIC: bars }, new Map(dates.map((date, index) => [date, breadthInputs(date, dates[index - 1])])));
  assert.equal(rows[90].risk.stage, 'constructive');
  assert.equal(rows[91].risk.stage, 'test');
  assert.equal(rows[91].risk.evidence.benchmarks.SPY.currentVolumeComparable, false);
  assert.equal(rows.at(-1).risk.evidence.benchmarks.SPY.distributionComparisons, 0);
  assert.equal(rows.at(-1).instruments.SPY.phase, 'confirmed');
  assert.equal(rows.at(-1).instruments.SPY.trend.support.sma50.side, 'above');
});

function timingFixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = sessions.slice(0, 69);
  const symbols = ['SPY', 'QQQ', 'IXIC', 'ACME'];
  const values = [...warm, ...recovery, { close: 98, volume: 220 }];
  const types = { SPY: 'etf', QQQ: 'etf', IXIC: 'index', ACME: 'common' };
  const securities = symbols.map((symbol) => ({ symbol, securityId: `eodhd:${symbol}`, type: types[symbol], name: symbol,
    exchange: symbol === 'IXIC' ? 'INDX' : symbol === 'SPY' ? 'NYSEARCA' : 'NASDAQ', listingDate: dates[0], knownAt: dates[0] }));
  const prices = (part) => part.flatMap((date) => symbols.map((symbol) => {
    const { close, low = close * .99, volume } = values[dates.indexOf(date)];
    return { symbol, date, knownAt: date, open: close, high: close * 1.01, low, close, volume };
  }));
  const ingest = (part, initial = false) => importDataset(db, { provider: 'eodhd', scope: 'full', expected: 1,
    securities: initial ? securities : [], prices: prices(part) });
  return { db, dates, ingest, engine: createEngine(db) };
}

test('passive timing GET preserves raw/calculation versions and returns exact prepared revision only', async (t) => {
  const { db, dates, ingest, engine } = timingFixture(t);
  ingest(dates.slice(0, 66), true);
  const service = createService({ db, provider: new Proxy({}, { get() { throw new Error('provider access'); } }), workers: false });
  const dbChanges = () => db.prepare('SELECT total_changes() AS count').get().count;
  const point = engine.context({ date: dates[65] });
  const url = (date, version = point.dataVersion, extra = '') => `/api/v1/market/timing?date=${date}&dataVersion=${version}&limit=5${extra}`;
  const changes = dbChanges();
  const absent = await service.dispatch({ url: url(point.date) });
  assert.equal(absent.status, 200);
  assert.equal(absent.body.state, 'unprepared');
  assert.match(absent.body.action, /prepare/);
  assert.equal(dbChanges(), changes);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='market_timing_manifests'").get(), undefined);
  materializeHistory(db, engine, point, { limit: 7 });
  const prepared = prepareMarketTiming(db, engine, point);
  assert.equal(prepared.written, 66);
  assert.equal(dataVersion(db), point.dataVersion);
  assert.match(CALCULATION_VERSION, /^2-/);
  const justPrepared = dbChanges();
  const reading = await service.dispatch({ url: url(point.date) });
  assert.equal(dbChanges(), justPrepared);
  assert.equal(reading.body.modelVersion, TIMING_MODEL_VERSION);
  assert.equal(reading.body.history.length, 5);
  assert.equal(reading.body.session.instruments.SPY.phase, 'confirmed');
  assert.equal(reading.body.session.breadth.date, point.date);
  assert.equal(reading.body.session.breadth.metrics.above_50d.denominator, 1);
  assert.equal(reading.body.instruments.SPY.label, 'S&P 500 ETF proxy');
  assert.equal(reading.body.instruments.QQQ.volume, 'ETF share volume');
  assert.equal(reading.body.instruments.IXIC.volume, 'Reported index volume');
  const known = await service.dispatch({ url: url(point.date, point.dataVersion, '&basis=known') });
  assert.equal(known.body.reason, 'unsupported-basis');
  ingest(dates.slice(66));
  const latest = engine.context();
  assert.equal((await service.dispatch({ url: url(latest.date, latest.dataVersion) })).body.state, 'unprepared');
  const appended = prepareMarketTiming(db, engine, latest);
  assert.equal(appended.written + appended.reusedSessions, dates.length);
  assert.deepEqual((await service.dispatch({ url: url(point.date) })).body, reading.body);
  const appendedHistory = readPreparedMarketTiming(db, latest, { limit: 80 });
  assert.equal(appendedHistory.history.length, dates.length);
  prepareMarketTiming(db, engine, latest, { force: true });
  assert.deepEqual(readPreparedMarketTiming(db, latest, { limit: 80 }), appendedHistory);
  db.prepare('DELETE FROM market_timing_sessions WHERE model_version=? AND data_version=? AND date=?')
    .run(TIMING_MODEL_VERSION, latest.dataVersion, latest.date);
  assert.equal(readPreparedMarketTiming(db, latest, { limit: 0 }).state, 'unprepared');
  assert.equal(prepareDailyMarketTiming(db, engine, latest).verified, true);
  assert.deepEqual(readPreparedMarketTiming(db, latest, { limit: 80 }), appendedHistory);
});

test('a registered benchmark without in-scope data cannot pass daily session review verification', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const [first, latest] = sessions;
  importDataset(db, { provider: 'eodhd', securities: [{ symbol: 'SPY', securityId: 'eodhd:SPY', type: 'etf', exchange: 'NYSEARCA', listingDate: first }],
    prices: [{ symbol: 'ACME', date: latest, open: 100, high: 100, low: 100, close: 100, volume: 100 }] });
  const engine = createEngine(db);
  assert.throws(() => prepareDailyMarketTiming(db, engine, engine.context()), /Missing exact prepared session review/);
});

test('a full production preparation publishes timing once for its canonical session and revision', async (t) => {
  const { db, dates, ingest, engine } = timingFixture(t);
  ingest(dates, true);
  const config = engine.context();
  const result = await performJob(db, 'production-precompute', { context: { date: config.date, dataVersion: config.dataVersion },
    historySessions: 2, warmSec: false, warmHighs: false }, { provider: new Proxy({}, { get() { throw new Error('provider access'); } }) });
  assert.equal(result.sessionReview.state, 'ready');
  assert.equal(result.sessionReview.verified, true);
  assert.equal(result.sessionReview.date, config.date);
  assert.equal(result.sessionReview.dataVersion, config.dataVersion);
  assert.equal(readPreparedMarketTiming(db, config).session.date, config.date);
});

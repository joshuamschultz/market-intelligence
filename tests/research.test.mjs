import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import {
  analyzeCohort, calculateMarketHealth, DEFAULT_HEALTH_MODEL, findHistoricalAnalogs, leadershipTransitionMatrix, marketHealthHistory, runEventStudy,
} from '../backend/research.mjs';

const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

function tradingDates(count) {
  const dates = [];
  const date = new Date('2024-02-05T00:00:00.000Z');
  while (dates.length < count) {
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

const dates = tradingDates(30);
const breadth = (value, denominator = 100) => ({ value, denominator, numerator: value == null ? 0 : value * denominator / 100 });
const bars = (prices, sessions = dates) => prices.flatMap((close, index) => close == null ? [] : [{ date: sessions[index], close }]);
const observations = (values, sessions = dates) => values.flatMap((value, index) => value == null ? [] : [
  { date: sessions[index], metrics: { above_50d: value } },
]);

function snapshot(date, { short = 70, intermediate = 60, long = 50, momentum = 40, velocities = [5, -3], ...rest } = {}) {
  return {
    date, universe: { id: 'us-core', version: 1 }, model: { id: 'rs', version: 1 }, benchmark: 'SPY',
    coverage: { ratio: 1, expected: 100, traded: 100, state: 'ready', completenessThreshold: 0.9 },
    breadth: {
      above_20d: breadth(short), above_50d: breadth(intermediate), above_200d: breadth(long), positive_21d: breadth(momentum),
      new_high_252d: breadth(20), new_low_252d: breadth(10),
    },
    aggregates: { upDollar: 300, downDollar: 100, benchmarkReturn: 0.01 },
    groups: [...velocities.map((velocity4w) => ({ level: 'industry', velocity4w })), { level: 'sector', velocity4w: 90 }],
    ...rest,
  };
}

test('market health is the documented seven-component weighted composite', () => {
  const health = calculateMarketHealth(snapshot(dates[0], { velocities: [5, -3, null] }));
  assert.equal(health.state, 'ready');
  approx(health.score, 58.5);
  assert.deepEqual(health.components.map((item) => item.score), [70, 60, 50, 40, 75, 50, 55]);
  assert.deepEqual(health.components.map((item) => item.weight), Object.values(DEFAULT_HEALTH_MODEL.weights).map((value) => value / 100));
  assert.deepEqual(health.components[4].denominator, 400);
  assert.deepEqual(health.components[5].denominator, 2);
  assert.deepEqual(health.components[5].totalIndustries, 3);
  assert.deepEqual(health.components[6].readings, { highs: breadth(20), lows: breadth(10) });
});

test('missing weighted components and incomplete coverage suppress the composite with separate explanations', () => {
  const missing = snapshot(dates[0], { velocities: [null] });
  const first = calculateMarketHealth(missing);
  assert.equal(first.score, null);
  assert.equal(first.state, 'insufficient_inputs');
  assert.deepEqual(first.missingComponents, ['industryLeadership']);
  const optional = calculateMarketHealth(missing, { model: { weights: { industryLeadership: 0 } } });
  approx(optional.score, 53.5 / 0.9);
  assert.equal(optional.components[5].contribution, 0);

  const limited = calculateMarketHealth(snapshot(dates[0], { coverage: { expected: 100, traded: 89 } }));
  assert.equal(limited.score, null);
  assert.equal(limited.coverage.ratio, 0.89);
  assert.equal(limited.regime.id, 'unavailable');
  assert.equal(limited.regime.since, null);
  assert.equal(limited.regime.sessions, 0);
  assert.equal(calculateMarketHealth(null).state, 'insufficient_coverage');
  assert.throws(() => calculateMarketHealth(missing, { model: { weights: { shortBreadth: -1 } } }), /nonnegative/);
  assert.throws(() => calculateMarketHealth(missing, { model: { weights: { unrelated: 1 } } }), /known components/);
});

test('full daily trading coverage alone cannot publish a score from one comparable security', () => {
  const same = breadth(100, 1);
  const current = snapshot(dates[0], {
    coverage: { ratio: 1, expected: 5_000, traded: 5_000, classifications: 1, state: 'complete', completenessThreshold: 0.98,
      comparableExpected: { above_20d: 5_000, above_50d: 5_000, above_200d: 4_700, positive_21d: 5_000,
        volumeParticipation: 5_000, classification: 5_000, new_high_252d: 4_700 } },
    breadth: { above_20d: same, above_50d: same, above_200d: same, positive_21d: same, new_high_252d: same, new_low_252d: breadth(0, 1) },
    aggregates: { upDollar: 100, downDollar: 0, dailyObservations: 1 },
  });
  const health = calculateMarketHealth(current);
  assert.equal(health.state, 'insufficient_inputs');
  assert.equal(health.score, null);
  assert.equal(health.regime.id, 'unavailable');
  assert.equal(health.components[0].value, 100);
  assert.equal(health.components[0].score, null);
  assert.equal(health.components[0].reason, 'insufficient_comparable_coverage');
  assert.deepEqual(health.components[0].adequacy, { expected: 5_000, observed: 1, ratio: 0.0002, threshold: 0.98, sufficient: false });
});

test('price coverage cannot substitute for quarantined dollar-volume observations in market health', () => {
  const current = snapshot(dates[0], {
    coverage: { ratio: 1, expected: 5_000, traded: 5_000, state: 'complete',
      completenessThreshold: 0.98, comparableExpected: { volumeParticipation: 5_000 } },
    aggregates: { upDollar: 100, downDollar: 0, dailyObservations: 5_000, dollarVolumeObservations: 1 },
  });
  const health = calculateMarketHealth(current);
  const volume = health.components.find(({ id }) => id === 'volumeParticipation');
  assert.equal(health.state, 'insufficient_inputs');
  assert.equal(health.score, null);
  assert.deepEqual(health.missingComponents, ['volumeParticipation']);
  assert.equal(volume.value, 100);
  assert.equal(volume.reason, 'insufficient_comparable_coverage');
  assert.deepEqual(volume.adequacy, { expected: 5_000, observed: 1, ratio: 0.0002, threshold: 0.98, sufficient: false });

  current.aggregates.dollarVolumeObservations = 0;
  const absent = calculateMarketHealth(current).components.find(({ id }) => id === 'volumeParticipation');
  assert.equal(absent.adequacy.observed, 0);
  assert.equal(absent.adequacy.sufficient, false);
});

test('calibration uses prior same-context observations with midpoint ranks for ties', () => {
  const now = snapshot(dates[3], { short: 40 });
  const history = [
    snapshot(dates[0], { short: 20 }), snapshot(dates[1], { short: 40 }), snapshot(dates[2], { short: 15, benchmark: 'QQQ' }),
    snapshot(dates[4], { short: 2 }),
  ];
  const model = {
    calibration: { shortBreadth: { type: 'percentile', lookback: 3, minObservations: 2 }, longBreadth: { min: 20, max: 60 } },
  };
  const health = calculateMarketHealth(now, { model, history });
  assert.equal(health.components[0].score, 75);
  assert.equal(health.components[0].calibration.observations, 2);
  assert.equal(health.components[2].score, 75);
  assert.equal(calculateMarketHealth(now, { model }).components[0].reason, 'insufficient_calibration_history');
});

test('regime evaluation reports triggers, exact change date and trading-session persistence', () => {
  const snapshots = dates.slice(0, 23).map((date, index) => snapshot(date, {
    intermediate: index >= 20 ? 65 : 50, momentum: 65, velocities: [2, 1],
  }));
  const history = marketHealthHistory(snapshots);
  assert.equal(history[19].regime.id, 'transitional');
  assert.equal(history[20].regime.id, 'broad_expansion');
  assert.ok(history[20].regime.conditions.every((condition) => condition.met === true));
  assert.equal(history[22].regime.since, dates[20]);
  assert.equal(history[22].regime.sessions, 3);
  approx(history[22].regime.features.benchmarkMomentum, ((1.01 ** 20) - 1) * 100);

  const sparse = marketHealthHistory(snapshots.filter((_, index) => index !== 21), { sessions: dates.slice(0, 23) });
  assert.equal(sparse[21].regime.id, 'unavailable');
  assert.equal(sparse[22].regime.id, 'transitional');
  const custom = calculateMarketHealth(snapshots[22], { model: { regimeRules: [
    { id: 'deterioration', conditions: [{ metric: 'shortBreadth', op: 'gte', value: 69 }] },
  ] } });
  assert.equal(custom.regime.id, 'deterioration');
});

test('historical snapshot revisions remain invisible before their availability date', () => {
  const revised = snapshot(dates[0], { short: 99, knownAt: `${dates[1]}T21:30:00Z` });
  const original = snapshot(dates[0], { short: 40, knownAt: `${dates[0]}T21:30:00Z` });
  assert.equal(marketHealthHistory([revised, original])[0].components[0].value, 40);
  assert.equal(calculateMarketHealth(revised).score, null);
});

test('base snapshot groups compare to their canonical weekly percentile and exclude new industries', () => {
  const baseline = snapshot(dates[4], { groups: [
    { id: 'moving', level: 'industry', percentile: 10 }, { id: 'slipping', level: 'industry', percentile: 90 },
  ] });
  const current = snapshot(dates[21], { groups: [
    { id: 'moving', level: 'industry', percentile: 60 }, { id: 'slipping', level: 'industry', percentile: 30 },
    { id: 'new', level: 'industry', percentile: 100 },
  ] });
  const health = calculateMarketHealth(current, { history: [baseline], sessions: dates });
  const leadership = health.components.find(({ id }) => id === 'industryLeadership');
  assert.equal(leadership.comparisonDate, dates[4]);
  assert.equal(leadership.denominator, 2);
  assert.equal(leadership.value, 50);
});

test('breadth divergences require contemporaneous readings and record their evidence', () => {
  const snapshots = dates.slice(0, 22).map((date) => snapshot(date));
  snapshots[21].breadth.above_50d = breadth(54);
  snapshots[21].breadth.new_low_252d = breadth(11);
  const health = calculateMarketHealth(snapshots[21], { history: snapshots.slice(0, -1) });
  assert.deepEqual(health.divergences.map((event) => event.id), ['benchmark_high_breadth_falls', 'benchmark_rises_lows_expand']);
  assert.equal(health.divergences[0].comparisonDate, dates[20]);
  assert.equal(health.divergences[0].evidence.oldIntermediate, 60);
});

test('observed health keeps official coverage unavailable and scores dated comparable industries', () => {
  const sessions = expectedSessions('2024-02-12', '2024-03-15');
  const baselineDate = '2024-02-16';
  const currentDate = sessions.at(-1);
  const coverage = { state: 'partial', ratio: null, listed: 120, traded: 110, classifications: 70, completenessThreshold: 0.98,
    comparableExpected: { above_20d: 105, above_50d: 105, above_200d: 105, positive_21d: 105, new_high_252d: 105,
      volumeParticipation: 110, classification: 110 } };
  const point = (date, advancing) => snapshot(date, { coverage,
    groups: Array.from({ length: 8 }, (_, index) => ({ id: String(index), level: 'industry',
      percentile: advancing ? (index < 4 ? 55 : 20) : 40 })),
    aggregates: { upDollar: 300, downDollar: 100, dollarVolumeObservations: 100, benchmarkReturn: 0.01 },
  });
  const history = [point(baselineDate, false)];
  assert.equal(calculateMarketHealth(point(currentDate, true), { history, sessions }).score, null);
  const observed = calculateMarketHealth(point(currentDate, true), { history, sessions, coverageMode: 'observed' });
  assert.equal(observed.state, 'ready');
  assert.equal(observed.descriptive, true);
  assert.match(observed.coverageWarning, /unreconciled/);
  assert.equal(observed.coverage.ratio, null);
  assert.equal(observed.coverage.state, 'partial');
  approx(observed.coverage.observed.ratio, 110 / 120);
  approx(observed.score, 58.5);
  const industry = observed.components.find(({ id }) => id === 'industryLeadership');
  assert.equal(industry.comparisonDate, baselineDate);
  assert.equal(industry.adequacy.comparisonScope, 'observed_classified_subset');
  approx(industry.adequacy.ratio, 70 / 110);
  const tiny = { ...point(currentDate, true), coverage: { ...coverage, listed: 5, traded: 5 } };
  assert.equal(calculateMarketHealth(tiny, { history, sessions, coverageMode: 'observed' }).state, 'insufficient_coverage');
});

test('thin divergence signals distinguish Composite from QQQ and require the previous leader cohort', () => {
  const previous = snapshot(dates[4], { velocities: [6, 5] });
  const latest = snapshot(dates[5], { velocities: [5, -1], aggregates: {
    upDollar: 300, downDollar: 100, benchmarkReturn: 0.01,
    nasdaqReturn: 0.02, nasdaqMedianReturn: -0.01, nasdaqBenchmark: 'QQQ', nasdaqBenchmarkProxy: true,
    nasdaqObservations: 100, nasdaqExpected: 105,
    previousLeaderDate: previous.date, leaderReturn: 0.03, leaderReturnObservations: 10, leaderReturnExpected: 10,
  } });
  const options = { history: [previous] };
  const signals = calculateMarketHealth(latest, options).divergences;
  assert.deepEqual(signals.map(({ id }) => id), ['qqq_rises_nasdaq_median_falls', 'leaders_rise_industry_participation_falls']);
  assert.equal(signals[0].evidence.nasdaqBenchmarkProxy, true);
  const composite = { ...latest, aggregates: { ...latest.aggregates, nasdaqBenchmark: 'IXIC', nasdaqBenchmarkProxy: false, previousLeaderDate: dates[2] } };
  assert.deepEqual(calculateMarketHealth(composite, options).divergences.map(({ id }) => id), ['nasdaq_rises_median_falls']);
  const noisy = { ...composite, aggregates: { ...composite.aggregates, nasdaqObservations: 55 } };
  assert.deepEqual(calculateMarketHealth(noisy, options).divergences, []);
});

test('observed studies require sufficient comparable members, preserve event evidence, and do not cross a gap', () => {
  const sessions = dates.slice(0, 8);
  const coverage = { state: 'partial', ratio: null, listed: 120, traded: 100, comparableExpected: { above_50d: 100 } };
  const observations = [20, 50, 20, null, 50, 20, 55, 50].flatMap((value, index) => value == null ? [] : [{
    date: sessions[index], coverage, breadth: { above_50d: breadth(value, index === 6 ? 5 : 90) },
  }]);
  const input = { sessions, observations, condition: { metric: 'above_50d', op: 'crossesAbove', value: 35 }, horizons: [1] };
  assert.equal(runEventStudy(input).eventCount, 0);
  const result = runEventStudy({ ...input, coverageMode: 'observed' });
  assert.equal(result.eventCount, 1);
  assert.equal(result.descriptive, true);
  assert.equal(result.events[0].date, sessions[1]);
  assert.deepEqual(result.events[0].coverageEvidence.metrics.above_50d, { comparable: 90, expected: 100, ratio: 0.9 });
  assert.equal(result.events[0].coverageEvidence.sourceRatio, null);
  assert.equal(result.events[0].coverageEvidence.observedListed, 120);
});

test('historical analogs fit only prior profiles and retain censored or missing forward outcomes', () => {
  const sessions = expectedSessions('2024-03-01', '2024-03-20');
  const cutoff = sessions[8];
  const snapshots = sessions.map((date, index) => {
    const profile = index === 8 ? 7 : index;
    const point = snapshot(date, { intermediate: 40 + profile, momentum: 30 + 2 * profile });
    point.breadth.top_decile = breadth(10);
    if (index === 3) point.aggregates.benchmarkReturn = null;
    return point;
  });
  const options = { snapshots, sessions, asOf: cutoff, horizon: 2, minimumHistory: 4, overlap: 'allow', limit: 8 };
  const result = findHistoricalAnalogs(options);
  assert.equal(result.state, 'ready');
  assert.equal(result.sampleCount, 8);
  assert.deepEqual(result.informativeMetrics, ['breadth.above_50d.value', 'breadth.positive_21d.value']);
  assert.equal(result.matches[0].date, sessions[7]);
  assert.equal(result.matches[0].status, 'rightCensored');
  assert.equal(result.matches[0].distance, 0);
  assert.equal(result.matches.find(({ date }) => date === sessions[2]).status, 'missingBenchmark');
  approx(result.matches.find(({ date }) => date === sessions[4]).forwardReturn, 2.01);
  assert.deepEqual(result, findHistoricalAnalogs({ ...options, snapshots: snapshots.slice(0, 9) }));
  const disjoint = findHistoricalAnalogs({ ...options, overlap: 'nonoverlapping' });
  assert.ok(disjoint.overlapSkipped > 0);
  assert.ok(disjoint.matches.every((row, index, rows) => rows.slice(index + 1).every((other) =>
    Math.abs(sessions.indexOf(row.date) - sessions.indexOf(other.date)) >= 2)));
});

test('weekly leadership matrices retain eligibility and ranking entries and exits across complete adjacent weeks', () => {
  const rows = (date, values) => ({ date, universe: 'u', model: 'r', stocks: Object.entries(values)
    .map(([securityId, rsPercentile]) => ({ securityId, rsPercentile })) });
  const result = leadershipTransitionMatrix([
    rows('2024-03-01', { A: 40, B: 92, C: null, E: 98, F: 70, H: null }),
    rows('2024-03-08', { A: 92, C: 85, D: 92, E: 100, F: null, G: null }),
    rows('2024-03-22', { A: 90 }),
    rows('2024-03-26', { A: 95 }),
  ], { detail: true });
  assert.deepEqual([result.pairs, result.skippedIncomplete, result.skippedGaps], [1, 1, 1]);
  assert.deepEqual([result.comparable, result.enteredEligibility, result.leftEligibility, result.newlyRanked, result.lostRank], [2, 2, 2, 1, 1]);
  assert.equal(result.from.at(-1), 'NEW');
  assert.equal(result.to.at(-1), 'EXIT');
  for (const [row, column] of [[0, 3], [4, 4], [3, 5], [5, 2], [5, 3], [1, 5]]) assert.equal(result.matrix[row][column], 1);
  assert.deepEqual(result.weeks[0].matrix, result.matrix);
});

test('threshold recovery studies use exact sessions, per-horizon overlap and explicit right censoring', () => {
  const sessions = dates.slice(0, 10);
  const benchmarks = { SPY: bars([10, 10, 10, 8, 12, 11, 14, 12, 16, 18]) };
  const study = runEventStudy({
    sessions, observations: observations([10, 20, 36, 15, 36, 34, 36, 35, 36, 60]), benchmarks, horizons: [2, 4],
    condition: { metric: 'above_50d', op: 'crossesAbove', value: 35, after: { op: 'lt', value: 20, within: 3 } },
  });
  assert.equal(study.eventCount, 3);
  assert.deepEqual(study.events.map(({ date }) => date), [dates[2], dates[4], dates[6]]);
  assert.deepEqual(study.results.map(({ eventCount, suppressedCount }) => [eventCount, suppressedCount]), [[3, 0], [2, 1]]);
  const first = study.results[0].benchmarks.SPY;
  assert.equal(first.count, 3);
  approx(first.winRate, 100);
  approx(first.mean, (20 + 100 / 6 + 100 / 7) / 3);
  approx(first.median, 100 / 6);
  approx(first.maximumAdverseExcursion, -20);
  approx(first.distribution.p25, (100 / 6 + 100 / 7) / 2);
  const longer = study.results[1].benchmarks.SPY;
  assert.equal(longer.observations, 2);
  assert.equal(longer.counts.rightCensored, 1);
  approx(longer.mean, 40);
});

test('event rules neither cross missing sessions nor use revisions or metrics known later', () => {
  const sessions = dates.slice(0, 7);
  const data = observations([10, null, 45, 20, 40, 35, 45]);
  data.push({ date: dates[1], knownAt: `${dates[3]}T21:30:00Z`, metrics: { above_50d: 20 } });
  data.find((row) => row.date === dates[4]).metrics.above_50d = { value: 40, knownAt: dates[5] };
  const study = runEventStudy({
    sessions, observations: data, benchmarks: { SPY: bars([100, 100, 100, 100, 100, 100, 100]) },
    condition: { metric: 'above_50d', op: 'crossesAbove', value: 35 }, horizons: [1],
  });
  assert.deepEqual(study.events, [{ date: dates[6], value: 45 }]);
  assert.equal(study.unknownCount, 3);
  assert.equal(study.results[0].benchmarks.SPY.counts.rightCensored, 1);
});

test('coverage-limited market breadth cannot qualify a historical event', () => {
  const study = runEventStudy({
    sessions: dates.slice(0, 2), horizons: [1], observations: [
      snapshot(dates[0], { coverage: { state: 'partial', ratio: 0.5, completenessThreshold: 0.98 } }),
      snapshot(dates[1]),
    ], condition: { metric: 'above_50d', op: 'gte', value: 60 },
  });
  assert.equal(study.unknownCount, 1);
  assert.deepEqual(study.events, [{ date: dates[1], value: 60 }]);
});

test('nested event rules use explicit unknown logic and permit a precise cutoff in New York time', () => {
  const sessions = dates.slice(0, 3);
  const late = `${dates[2]}T23:30:00-05:00`;
  const values = [
    { date: dates[0], metrics: { first: 0 } },
    { date: dates[1], metrics: { first: 1 } },
    { date: dates[2], knownAt: late, metrics: { first: 1, second: 1 } },
  ];
  const study = runEventStudy({
    sessions, observations: values, asOf: `${dates[2]}T23:00:00-05:00`, horizons: [1],
    condition: { all: [{ metric: 'first', op: 'eq', value: 1 }, { any: [
      { metric: 'second', op: 'eq', value: 1 }, { metric: 'first', op: 'gte', value: 1 },
    ] }] },
  });
  assert.deepEqual(study.events, [{ date: dates[1], value: null }]);
  assert.equal(study.evaluatedCount, 2);
  assert.equal(study.unknownCount, 1);
});

test('cohorts freeze effective and known membership and retain both successful and censored delistings', () => {
  const sessions = dates.slice(0, 5);
  const members = [
    { securityId: 'A', industry: 'Machinery', prices: bars([100, 105, 110, 120]) },
    { securityId: 'B', industry: 'Energy', prices: bars([100, 80]), delistingDate: dates[2], delistingReturn: -0.5 },
    { securityId: 'C', prices: bars([100, 60]), delistingDate: dates[2] },
    { securityId: 'D', prices: bars([100, null, 90, 90]) },
    { securityId: 'E', prices: bars([10, 20, 25, 30]), knownAt: dates[1] },
    { securityId: 'F', prices: bars([10, 20, 25, 30]), effectiveDate: dates[1] },
  ];
  const study = analyzeCohort({ sessions, date: dates[0], members, horizons: [3, 5] });
  assert.equal(study.memberCount, 4);
  assert.equal(study.excludedCount, 2);
  assert.deepEqual(study.industries, [{ industry: null, count: 2 }, { industry: 'Energy', count: 1 }, { industry: 'Machinery', count: 1 }]);
  const [first, immature] = study.results;
  assert.equal(first.targetDate, dates[3]);
  assert.equal(first.summary.count, 3);
  assert.equal(first.summary.observations, 4);
  assert.equal(first.summary.counts.delisted, 1);
  assert.equal(first.summary.counts.delistedMissingReturn, 1);
  assert.equal(first.summary.counts.pathIncomplete, 1);
  approx(first.summary.median, -10);
  approx(first.summary.mean, -50 / 3);
  approx(first.summary.winRate, 100 / 3);
  approx(first.summary.maximumDrawdown, -60);
  assert.deepEqual(first.members.map((row) => row.status), ['complete', 'delisted', 'delistedMissingReturn', 'complete']);
  assert.equal(first.members[1].exitDate, dates[2]);
  approx(first.members[1].return, -60);
  assert.equal(first.members[3].maximumAdverseExcursion, null);
  approx(first.members[3].observedAdverseExcursion, -10);
  assert.equal(immature.summary.counts.rightCensored, 4);
});

test('an explicit complete loss is reported while a later-known terminal return is unavailable at an earlier cutoff', () => {
  const sessions = dates.slice(0, 5);
  const member = {
    securityId: 'C', prices: bars([100, 60]), delistingDate: dates[2], delistingReturn: -1, delistingKnownAt: dates[4],
  };
  const known = analyzeCohort({ sessions, date: dates[0], members: [member], horizons: [3] }).results[0];
  const unknown = analyzeCohort({ sessions, date: dates[0], members: [member], horizons: [3], asOf: dates[3] }).results[0];
  approx(known.members[0].return, -100);
  approx(known.summary.maximumAdverseExcursion, -100);
  assert.equal(unknown.members[0].status, 'missingExit');
  assert.equal(unknown.members[0].return, null);
  const terminalAnnounced = { ...member, delistingKnownAt: dates[2], delistingReturnKnownAt: dates[4] };
  const pending = analyzeCohort({ sessions, date: dates[0], members: [terminalAnnounced], horizons: [3], asOf: dates[3] }).results[0];
  assert.equal(pending.members[0].status, 'delistedMissingReturn');
  assert.equal(pending.summary.knownDelistings, 1);
});

test('median-stock event statistics use historical membership and expose constituent return coverage', () => {
  const sessions = dates.slice(0, 4);
  const data = observations([10, 40, 50, 60]);
  data[1].stocks = [{ securityId: '41' }, { securityId: '42' }, { securityId: '43' }, { securityId: '99', knownAt: dates[2] }];
  const securityPrices = new Map([
    ['41', bars([100, 100, 110, 130])], ['42', bars([100, 100, 50, 90])],
    ['43', bars([100, 100, 50])], ['99', bars([100, 100, 100, 1000])],
  ]);
  const study = runEventStudy({
    sessions, securityPrices, observations: data, horizons: [2],
    condition: { metric: 'above_50d', op: 'crossesAbove', value: 35 },
  });
  const result = study.results[0];
  assert.equal(result.events[0].excludedCohortMembers, 1);
  assert.equal(result.events[0].medianStock.memberCount, 3);
  assert.equal(result.events[0].medianStock.returnCount, 2);
  assert.equal(result.events[0].medianStock.counts.missingExit, 1);
  approx(result.events[0].medianStock.returnCoverage, 2 / 3);
  assert.equal(result.events[0].medianStock.potentialSurvivorshipBias, true);
  approx(result.medianStock.median, 10);
  approx(result.medianStock.maximumAdverseExcursion, -25);
});

test('unverified splits and nontrading endpoint marks do not become observations', () => {
  const sessions = dates.slice(0, 3);
  const study = analyzeCohort({ sessions, date: dates[0], horizons: [2], members: [
    { securityId: 'split', prices: [{ date: dates[0], close: 100 },
      { date: dates[1], close: 50, unverifiedSplit: true }, { date: dates[2], close: 52 }] },
    { securityId: 'halted', prices: [{ date: dates[0], close: 100, traded: false }, { date: dates[2], close: 52 }] },
  ] });
  assert.equal(study.results[0].summary.count, 0);
  assert.equal(study.results[0].summary.counts.unverifiedAdjustment, 1);
  assert.equal(study.results[0].summary.counts.missingEntry, 1);
});

test('MAE provides a separate complete-path count and supports adjusted intraday lows', () => {
  const sessions = dates.slice(0, 3);
  const benchmarks = {
    SPY: [{ date: dates[0], close: 100 }, { date: dates[1], close: 120, low: 90 }, { date: dates[2], close: 110, low: 100 }],
    QQQ: bars([100, null, 110]),
  };
  const study = runEventStudy({
    sessions, benchmarks, observations: observations([50]), horizons: [2], maePrice: 'low',
    condition: { metric: 'above_50d', op: 'gte', value: 50 },
  });
  const { SPY, QQQ } = study.results[0].benchmarks;
  approx(SPY.maximumAdverseExcursion, -10);
  approx(SPY.maximumDrawdown, -100 / 6);
  assert.equal(QQQ.count, 1);
  assert.equal(QQQ.adverseExcursionCount, 0);
  assert.equal(QQQ.maximumAdverseExcursion, null);
  assert.equal(QQQ.counts.pathIncomplete, 1);
});

test('an entry revision published after the event is excluded even when known by study run date', () => {
  const sessions = dates.slice(0, 3);
  const study = analyzeCohort({ sessions, asOf: dates[2], date: dates[0], horizons: [2], members: [{ securityId: 1, prices: [
    { date: dates[0], close: 200, knownAt: dates[1] }, { date: dates[0], close: 100, knownAt: `${dates[0]}T21:30:00Z` },
    { date: dates[1], close: 110 }, { date: dates[2], close: 120 },
  ] }] });
  approx(study.results[0].summary.mean, 20);
});

test('empty observations and invalid configuration surface predictable states', () => {
  const condition = { metric: 'above_50d', op: 'gt', value: 35 };
  const result = runEventStudy({ sessions: [], condition, benchmarks: { QQQ: [] } });
  assert.equal(result.asOf, null);
  assert.deepEqual(result.results.map(({ horizon }) => horizon), [5, 10, 20, 60]);
  assert.equal(result.results[0].benchmarks.QQQ.winRate, null);
  assert.equal(result.results[0].benchmarks.QQQ.distribution.p90, null);
  assert.throws(() => runEventStudy({ sessions: dates, condition, horizons: [0] }), /Horizon/);
  assert.throws(() => runEventStudy({ sessions: ['2024-02-30'], condition }), /valid YYYY-MM-DD/);
  assert.throws(() => analyzeCohort({ sessions: dates, date: dates[0], members: [{ securityId: 'x' }, { securityId: 'x' }] }), /Duplicate/);
});

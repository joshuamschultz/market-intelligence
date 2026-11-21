import { expectedSessions, shiftDate, weekEnd } from './calendar.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const marketDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const finite = Number.isFinite;
const percent = (value) => (value - 1) * 100;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sortedNumbers = (values) => [...values].sort((a, b) => a - b);
const positive = (value) => finite(value) && value > 0;
const median = (values) => quantile(sortedNumbers(values), 0.5);
const lookup = (data, key) => data instanceof Map ? data.get(key) : data && Object.hasOwn(data, key) ? data[key] : undefined;
const pathValue = (object, path) => path.split('.').reduce((value, key) => lookup(value, key), object);

function quantile(ordered, fraction) {
  if (!ordered.length) return null;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  return ordered[lower] + (ordered[Math.ceil(position)] - ordered[lower]) * (position - lower);
}

function validateDate(date, label) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date) ||
      !finite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new TypeError(`${label} must be a valid YYYY-MM-DD trading date`);
  }
  return date;
}

function marketDate(value, label) {
  if (typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && finite(Date.parse(value))) {
    validateDate(value.slice(0, 10), label);
    return marketDateFormat.format(new Date(value));
  }
  return validateDate(value, label);
}

function knownBy(knownAt, cutoff, effectiveDate) {
  const timestamp = knownAt ?? effectiveDate;
  const day = marketDate(timestamp, 'knownAt');
  if (DATE_PATTERN.test(cutoff)) return day <= cutoff;
  // Date-only records attest to session-level availability, so a precise same-day cutoff cannot use them.
  if (DATE_PATTERN.test(timestamp)) return day < marketDate(cutoff, 'asOf');
  return Date.parse(timestamp) <= Date.parse(cutoff);
}

function calendar(sessions) {
  if (!Array.isArray(sessions)) throw new TypeError('sessions must be an array of trading dates');
  const dates = [...new Set(sessions.map((date) => validateDate(date, 'Session date')))].sort();
  return { dates, index: new Map(dates.map((date, i) => [date, i])) };
}

function indexDatedRecords(records, dateLabel) {
  const byDate = new Map();
  for (const record of records) {
    const date = validateDate(record.date, dateLabel);
    if (record.effectiveDate != null) validateDate(record.effectiveDate, 'Effective date');
    if (record.knownAt != null) marketDate(record.knownAt, 'knownAt');
    const revisions = byDate.get(date) ?? [];
    revisions.push(record);
    byDate.set(date, revisions);
  }
  for (const [date, revisions] of byDate) {
    const order = (record) => {
      const value = record.knownAt ?? date;
      const day = marketDate(value, 'knownAt');
      return { day, time: DATE_PATTERN.test(value) ? Infinity : Date.parse(value), version: record.version ?? 0 };
    };
    if (revisions.length > 1) revisions.sort((a, b) => {
      const left = order(a);
      const right = order(b);
      return right.day.localeCompare(left.day) || right.time - left.time || right.version - left.version;
    });
  }
  return byDate;
}

function recordOn(byDate, date, cutoff) {
  return byDate.get(date)?.find((record) =>
    (record.effectiveDate ?? date) <= date && knownBy(record.knownAt, cutoff, date));
}

const conditionOps = Object.freeze({
  gt: (left, right) => left > right,
  gte: (left, right) => left >= right,
  lt: (left, right) => left < right,
  lte: (left, right) => left <= right,
  eq: (left, right) => left === right,
  ne: (left, right) => left !== right,
});

const rule = (metric, op, value) => ({ metric, op, value });

export const DEFAULT_HEALTH_MODEL = Object.freeze({
  id: 'default',
  version: 1,
  weights: Object.freeze({
    shortBreadth: 20, intermediateBreadth: 20, longBreadth: 15, priceMomentum: 15,
    volumeParticipation: 15, industryLeadership: 10, highsLows: 5,
  }),
  changeLookback: 5,
  benchmarkLookback: 20,
  weaknessLookback: 10,
  weaknessThreshold: 35,
  regimeRules: Object.freeze([
    { id: 'broad_contraction', label: 'Broad contraction', conditions: [
      rule('benchmarkMomentum', 'lt', 0), rule('intermediateBreadth', 'lte', 35),
      rule('longBreadth', 'lte', 40), rule('priceMomentum', 'lte', 40), rule('industryLeadership', 'lte', 40),
    ] },
    { id: 'early_recovery', label: 'Early recovery', conditions: [
      rule('priorWeakSessions', 'gte', 3), rule('shortChange', 'gte', 10),
      rule('shortBreadth', 'gte', 35), rule('benchmarkMomentum', 'gte', -3),
    ] },
    { id: 'broad_expansion', label: 'Broad expansion', conditions: [
      rule('benchmarkMomentum', 'gt', 0), rule('intermediateBreadth', 'gte', 60),
      rule('intermediateChange', 'gte', 0), rule('priceMomentum', 'gte', 55),
      rule('industryLeadership', 'gte', 55),
    ] },
    { id: 'narrow_expansion', label: 'Narrow expansion', conditions: [
      rule('benchmarkMomentum', 'gt', 0), rule('intermediateBreadth', 'lt', 55),
      [rule('intermediateChange', 'lt', 0), rule('industryLeadership', 'lt', 45)],
    ] },
    { id: 'deterioration', label: 'Deterioration', conditions: [
      rule('intermediateChange', 'lte', -5), rule('benchmarkMomentum', 'gte', -3),
      rule('benchmarkMomentum', 'lte', 3),
    ] },
  ].map((item) => Object.freeze({ ...item, conditions: Object.freeze(item.conditions.map((condition) =>
    Array.isArray(condition) ? Object.freeze(condition.map(Object.freeze)) : Object.freeze(condition))) }))),
});

const breadthComponent = (snapshot, key) => {
  const row = snapshot?.breadth?.[key];
  const value = finite(row?.value) && row.value >= 0 && row.value <= 100 && row.denominator !== 0 ? row.value : null;
  return { value, numerator: row?.numerator ?? null, denominator: row?.denominator ?? null };
};

const COMPONENTS = {
  shortBreadth: {
    label: 'Short-term breadth', range: [0, 100],
    definition: 'Percentage of comparable traded members above the 20-session SMA.',
    get: (snapshot) => breadthComponent(snapshot, 'above_20d'),
  },
  intermediateBreadth: {
    label: 'Intermediate-term breadth', range: [0, 100],
    definition: 'Percentage of comparable traded members above the 50-session SMA.',
    get: (snapshot) => breadthComponent(snapshot, 'above_50d'),
  },
  longBreadth: {
    label: 'Long-term breadth', range: [0, 100],
    definition: 'Percentage of comparable traded members above the 200-session SMA.',
    get: (snapshot) => breadthComponent(snapshot, 'above_200d'),
  },
  priceMomentum: {
    label: 'Price momentum participation', range: [0, 100],
    definition: 'Percentage of comparable traded members with a positive 21-session return.',
    get: (snapshot) => breadthComponent(snapshot, 'positive_21d'),
  },
  volumeParticipation: {
    label: 'Volume participation', range: [0, 100],
    definition: 'Advancing dollar volume as a percentage of advancing plus declining dollar volume. Unchanged names are excluded.',
    get: (snapshot) => {
      const { upDollar, downDollar } = snapshot?.aggregates ?? {};
      const valid = finite(upDollar) && finite(downDollar) && upDollar >= 0 && downDollar >= 0;
      const denominator = valid ? upDollar + downDollar : null;
      return { value: positive(denominator) ? 100 * upDollar / denominator : null, numerator: valid ? upDollar : null, denominator };
    },
  },
  industryLeadership: {
    label: 'Industry leadership breadth', range: [0, 100],
    definition: 'Percentage of comparable industries with positive four-week relative strength percentile velocity.',
    get: (snapshot, prior) => {
      const industries = (snapshot?.groups ?? []).filter((group) => group.level === 'industry');
      const baseline = new Map((prior?.groups ?? []).filter((group) => group.level === 'industry').map((group) => [group.id, group.percentile]));
      const velocities = industries.map((group) => {
        if (Object.hasOwn(group, 'velocity4w')) return group.velocity4w;
        const earlier = baseline.get(group.id);
        return group.id != null && finite(group.percentile) && finite(earlier) ? group.percentile - earlier : null;
      }).filter(finite);
      const numerator = velocities.filter((velocity) => velocity > 0).length;
      return {
        value: velocities.length ? 100 * numerator / velocities.length : null,
        numerator, denominator: velocities.length, totalIndustries: industries.length, comparisonDate: prior?.date ?? null,
        expectedComparableIndustries: baseline.size ? industries.filter((group) => baseline.has(group.id)).length : null,
      };
    },
  },
  highsLows: {
    label: 'New highs versus new lows', range: [-100, 100],
    definition: 'Percentage reaching a new 252-session high minus percentage reaching a new 252-session low.',
    get: (snapshot) => {
      const highs = breadthComponent(snapshot, 'new_high_252d');
      const lows = breadthComponent(snapshot, 'new_low_252d');
      const countsComparable = highs.denominator === lows.denominator && highs.denominator > 0 &&
        finite(highs.numerator) && finite(lows.numerator);
      return {
        value: highs.value == null || lows.value == null ? null : highs.value - lows.value,
        numerator: countsComparable ? highs.numerator - lows.numerator : null,
        denominator: countsComparable ? highs.denominator : null,
        readings: { highs, lows },
      };
    },
  },
};

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function threshold(condition, label) {
  if (!condition || typeof condition.metric !== 'string' || !condition.metric.length ||
      !Object.hasOwn(conditionOps, condition.op) || !finite(condition.value)) {
    throw new TypeError(`${label} must specify a metric, a comparison operator and a finite numeric threshold`);
  }
  return { metric: condition.metric, op: condition.op, value: condition.value };
}

function healthModel(input = {}) {
  const defaults = DEFAULT_HEALTH_MODEL;
  const weights = { ...defaults.weights, ...input.weights };
  if (Object.keys(weights).some((key) => !Object.hasOwn(COMPONENTS, key)) ||
      Object.values(weights).some((weight) => !finite(weight) || weight < 0) || !positive(mean(Object.values(weights)))) {
    throw new RangeError('Health weights must reference known components, be finite and nonnegative, and have a positive total');
  }
  const weightTotal = Object.values(weights).reduce((total, weight) => total + weight, 0);
  if (!finite(weightTotal)) throw new RangeError('Health weights must have a finite total');
  const calibration = {};
  for (const [id, item] of Object.entries(input.calibration ?? {})) {
    if (!Object.hasOwn(COMPONENTS, id)) throw new RangeError(`Unknown health component ${id}`);
    if (item?.type === 'percentile') {
      const lookback = boundedInteger(item.lookback ?? 252, `${id} calibration lookback`, 1, 5040);
      calibration[id] = { type: 'percentile', lookback, minObservations: boundedInteger(
        item.minObservations ?? Math.min(60, lookback), `${id} calibration observations`, 1, lookback,
      ) };
    } else {
      const min = item?.min;
      const max = item?.max;
      if ((item?.type != null && item.type !== 'linear') || !finite(min) || !finite(max) || min >= max) {
        throw new RangeError(`${id} linear calibration needs finite min and max with min < max`);
      }
      calibration[id] = { type: 'linear', min, max };
    }
  }
  const regimeRules = input.regimeRules ?? defaults.regimeRules;
  if (!Array.isArray(regimeRules)) throw new TypeError('regimeRules must be an ordered array');
  const ruleIds = new Set();
  const rules = regimeRules.map((item) => {
    if (typeof item?.id !== 'string' || !item.id || item.id === 'transitional' || ruleIds.has(item.id) ||
        !Array.isArray(item.conditions) || !item.conditions.length) throw new TypeError('Each regime needs a unique ID and conditions');
    ruleIds.add(item.id);
    const conditions = item.conditions.map((condition) => {
      if (!Array.isArray(condition)) return threshold(condition, 'Regime condition');
      if (!condition.length) throw new TypeError('Regime condition groups must be nonempty');
      return condition.map((option) => threshold(option, 'Regime condition'));
    });
    return { id: item.id, label: item.label ?? item.id, conditions };
  });
  const weaknessThreshold = input.weaknessThreshold ?? defaults.weaknessThreshold;
  if (!finite(weaknessThreshold) || weaknessThreshold < 0 || weaknessThreshold > 100) {
    throw new RangeError('weaknessThreshold must be a percentage from 0 to 100');
  }
  return {
    id: input.id ?? defaults.id, version: input.version ?? defaults.version, weights, weightTotal, calibration,
    changeLookback: boundedInteger(input.changeLookback ?? defaults.changeLookback, 'changeLookback', 1, 252),
    benchmarkLookback: boundedInteger(input.benchmarkLookback ?? defaults.benchmarkLookback, 'benchmarkLookback', 1, 252),
    weaknessLookback: boundedInteger(input.weaknessLookback ?? defaults.weaknessLookback, 'weaknessLookback', 1, 252),
    weaknessThreshold, regimeRules: rules,
  };
}

const observedCaveat = 'Descriptive results for the selected observed universe. Historical membership and full market coverage are unreconciled.';

function coveragePolicy({ coverageMode = 'verified', observedMinimum = 20, observedThreshold = 0.8 } = {}) {
  if (!['verified', 'observed'].includes(coverageMode)) throw new RangeError('Coverage mode must be verified or observed');
  const descriptive = coverageMode === 'observed';
  if (!descriptive) return { coverageMode, descriptive };
  const minimum = boundedInteger(observedMinimum, 'Observed minimum', 1, 100_000);
  const threshold = Number(observedThreshold);
  if (!(threshold > 0 && threshold <= 1)) throw new RangeError('Observed completeness threshold must be greater than zero and at most one');
  return { coverageMode, descriptive, observedMinimum: minimum, observedThreshold: threshold, coverageWarning: observedCaveat };
}

function healthCoverage(snapshot, policy) {
  const coverage = snapshot?.coverage ?? {};
  const ratio = finite(coverage.ratio) ? coverage.ratio
    : positive(coverage.expected) && finite(coverage.traded) ? coverage.traded / coverage.expected : null;
  const threshold = finite(coverage.completenessThreshold) && coverage.completenessThreshold >= 0 && coverage.completenessThreshold <= 1
    ? coverage.completenessThreshold : 0.9;
  const blockedStates = ['empty', 'incomplete', 'insufficient', 'unavailable', 'partial', 'invalid', 'unknown'];
  const verifiedReady = positive(ratio) && ratio <= 1 && ratio >= threshold && !blockedStates.includes(coverage.state);
  if (!policy?.descriptive) return { ...coverage, ratio, completenessThreshold: threshold, ready: verifiedReady };
  const listed = coverage.listed;
  const traded = coverage.traded;
  const observedRatio = positive(listed) && finite(traded) ? traded / listed : null;
  const ready = positive(observedRatio) && observedRatio <= 1 && observedRatio >= policy.observedThreshold &&
    traded >= policy.observedMinimum && !['invalid', 'unavailable', 'empty'].includes(coverage.state);
  return { ...coverage, ratio: coverage.ratio ?? null, completenessThreshold: threshold, ready, verifiedReady,
    observed: { listed: listed ?? null, traded: traded ?? null, ratio: observedRatio, minimum: policy.observedMinimum,
      threshold: policy.observedThreshold, comparableUniverse: 'observed_eligible_members' } };
}

const expectedMetric = {
  shortBreadth: 'above_20d', intermediateBreadth: 'above_50d', longBreadth: 'above_200d',
  priceMomentum: 'positive_21d', highsLows: 'new_high_252d', volumeParticipation: 'volumeParticipation',
  industryLeadership: 'classification',
};

function usableComponent(snapshot, id, data, policy) {
  const expected = snapshot?.coverage?.comparableExpected?.[expectedMetric[id]] ??
    (policy?.descriptive ? snapshot?.coverage?.traded : null);
  if (!finite(expected)) return { ...data, adequacy: null };
  const observed = id === 'industryLeadership' ? snapshot.coverage.classifications
    : id === 'volumeParticipation' ? (snapshot.aggregates?.dollarVolumeObservations ?? snapshot.aggregates?.dailyObservations) : data.denominator;
  const ratio = expected > 0 && finite(observed) ? observed / expected : null;
  const threshold = policy?.descriptive ? policy.observedThreshold : healthCoverage(snapshot).completenessThreshold;
  const groupCount = id === 'industryLeadership' ? data.expectedComparableIndustries : null;
  const groupRatio = groupCount > 0 && finite(data.denominator) ? data.denominator / groupCount : null;
  const classifiedSubset = policy?.descriptive && id === 'industryLeadership';
  const sufficient = classifiedSubset
    ? finite(observed) && observed >= policy.observedMinimum && data.denominator >= Math.min(5, policy.observedMinimum)
      && (groupRatio == null || groupRatio >= threshold)
    : ratio != null && ratio >= threshold && (!policy?.descriptive || observed >= policy.observedMinimum)
      && (groupRatio == null || groupRatio >= threshold);
  return { ...data, adequacy: { expected, observed: observed ?? null, ratio, threshold, sufficient,
    ...(classifiedSubset ? { comparisonScope: 'observed_classified_subset', minimumClassified: policy.observedMinimum } : {}),
    ...(groupRatio != null ? { comparableIndustries: groupCount, observedIndustries: data.denominator, groupRatio } : {}) } };
}

function normalizeComponent(value, calibration, priorValues) {
  if (value == null) return { score: null, reason: 'input_unavailable' };
  if (calibration.type === 'linear') {
    const score = Math.max(0, Math.min(100, 100 * (value - calibration.min) / (calibration.max - calibration.min)));
    return { score, reason: null };
  }
  if (priorValues.length < calibration.minObservations) return { score: null, reason: 'insufficient_calibration_history' };
  const below = priorValues.filter((prior) => prior < value).length;
  const equal = priorValues.filter((prior) => prior === value).length;
  return { score: 100 * (below + equal / 2) / priorValues.length, reason: null };
}

function snapshotTimeline(snapshots, sessionDates) {
  const dates = calendar(sessionDates ?? snapshots.map((snapshot) => snapshot.date));
  const byDate = indexDatedRecords(snapshots, 'Snapshot date');
  const contextKeys = (snapshot) => ['universe', 'model', 'benchmark', 'basis', 'classificationSystem'].map((key) => {
    const value = snapshot?.[key];
    return typeof value === 'object' && value !== null ? [value.id, value.version] : value;
  });
  const sameContext = (left, right) => JSON.stringify(contextKeys(left)) === JSON.stringify(contextKeys(right));
  const at = (index) => {
    const date = dates.dates[index];
    return date ? recordOn(byDate, date, date) : undefined;
  };
  return { ...dates, at, sameContext };
}

function rollingBenchmark(prior, length) {
  let product = 1;
  let isNewHigh = true;
  for (let offset = 0; offset < length; offset++) {
    const value = prior(offset)?.aggregates?.benchmarkReturn;
    if (!finite(value) || value <= -1) return { momentum: null, isNewHigh: null };
    product *= 1 + value;
    isNewHigh &&= product > 1;
  }
  return { momentum: percent(product), isNewHigh };
}

function evaluateRule(condition, features) {
  if (Array.isArray(condition)) {
    const any = condition.map((option) => evaluateRule(option, features));
    const met = any.some((option) => option.met === true) ? true : any.some((option) => option.met === null) ? null : false;
    return { any, met };
  }
  const actual = features[condition.metric] ?? null;
  return { ...condition, actual, met: finite(actual) ? conditionOps[condition.op](actual, condition.value) : null };
}

function classifyRegime(features, model, coverage) {
  if (!coverage.ready) {
    return { id: 'unavailable', label: 'Unavailable', reason: 'insufficient_coverage', conditions: [], features };
  }
  const rules = model.regimeRules.map((item) => ({
    id: item.id, label: item.label, conditions: item.conditions.map((condition) => evaluateRule(condition, features)),
  }));
  const matched = rules.find((item) => item.conditions.every((condition) => condition.met === true));
  if (matched) return { ...matched, reason: 'rule_matched', features };
  const inconclusive = rules.some((item) => item.conditions.every((condition) => condition.met !== false));
  return {
    id: 'transitional', label: 'Transitional', reason: inconclusive ? 'insufficient_regime_inputs' : 'no_regime_rule_matched',
    conditions: [], rules, features,
  };
}

function adequateMetric(observation, metric, raw, policy) {
  if (!policy.descriptive) return true;
  const comparable = raw?.denominator;
  const expected = observation?.coverage?.comparableExpected?.[metric] ?? observation?.coverage?.traded;
  return positive(expected) && finite(comparable) && comparable >= policy.observedMinimum && comparable / expected >= policy.observedThreshold;
}

function breadthDivergences(snapshot, previous, benchmarkHigh, leadership, oldLeadership, policy) {
  if (!previous) return [];
  const reading = (day, key) => {
    const data = breadthComponent(day, key);
    return adequateMetric(day, key, data, policy) ? data.value : null;
  };
  const before = (key) => reading(previous, key);
  const current = (key) => reading(snapshot, key);
  const signals = [];
  const record = (id, label, evidence) => signals.push({ id, label, date: snapshot.date, comparisonDate: previous.date, evidence, ...policy });
  const benchmark = snapshot.aggregates?.benchmarkReturn;
  const intermediate = current('above_50d');
  const oldIntermediate = before('above_50d');
  if (benchmarkHigh && finite(intermediate) && finite(oldIntermediate) && intermediate < oldIntermediate) {
    record('benchmark_high_breadth_falls', 'Benchmark reaches a 20-session high while 50-session breadth falls', {
      benchmark: snapshot.benchmark ?? null, benchmarkHigh, intermediate, oldIntermediate,
    });
  }
  const lows = current('new_low_252d');
  const oldLows = before('new_low_252d');
  if (positive(benchmark) && finite(lows) && finite(oldLows) && lows > oldLows) {
    record('benchmark_rises_lows_expand', 'Benchmark rises while new lows expand', { benchmarkReturn: benchmark, lows, oldLows });
  }
  const momentum = current('positive_21d');
  const oldMomentum = before('positive_21d');
  if (finite(benchmark) && benchmark < 0 && finite(momentum) && finite(oldMomentum) && momentum > oldMomentum) {
    record('benchmark_falls_breadth_improves', 'Benchmark falls while positive momentum participation improves', {
      benchmarkReturn: benchmark, momentum, oldMomentum,
    });
  }
  const { nasdaqReturn, nasdaqMedianReturn, nasdaqBenchmark, nasdaqBenchmarkProxy, nasdaqObservations, nasdaqExpected } = snapshot.aggregates ?? {};
  const threshold = policy.descriptive ? policy.observedThreshold : healthCoverage(snapshot).completenessThreshold;
  const observationsMinimum = policy.descriptive ? policy.observedMinimum : 1;
  const adequatelyObserved = (observed, expected) => expected == null
    ? !policy.descriptive : positive(expected) && observed >= observationsMinimum && observed / expected >= threshold;
  if (positive(nasdaqReturn) && finite(nasdaqMedianReturn) && nasdaqMedianReturn < 0 &&
      adequatelyObserved(nasdaqObservations, nasdaqExpected)) {
    record(nasdaqBenchmarkProxy ? 'qqq_rises_nasdaq_median_falls' : 'nasdaq_rises_median_falls',
      nasdaqBenchmarkProxy ? 'QQQ (Nasdaq-100 ETF) rises while the median Nasdaq-listed common stock falls'
        : 'Nasdaq Composite rises while the median Nasdaq-listed common stock falls',
      { nasdaqReturn, nasdaqMedianReturn, nasdaqBenchmark, nasdaqBenchmarkProxy, nasdaqObservations, nasdaqExpected });
  }
  const previousLeaders = new Set((previous.stocks ?? []).filter((stock) => stock.rsPercentile >= 90).map((stock) => stock.securityId));
  const comparableLeaderReturns = (snapshot.stocks ?? [])
    .filter((stock) => previousLeaders.has(stock.securityId) && finite(stock.return_1d)).map((stock) => stock.return_1d);
  const leadershipArchive = snapshot.aggregates?.previousLeaderDate === previous.date ? snapshot.aggregates : null;
  const leaderReturn = leadershipArchive?.leaderReturn ?? mean(comparableLeaderReturns);
  const leaderCount = leadershipArchive?.leaderReturnObservations ?? comparableLeaderReturns.length;
  const leaderExpected = leadershipArchive?.leaderReturnExpected ?? previousLeaders.size;
  if (positive(leaderReturn) && adequatelyObserved(leaderCount, leaderExpected) &&
      finite(leadership) && finite(oldLeadership) && leadership < oldLeadership) {
    record('leaders_rise_industry_participation_falls', 'Prior top-decile RS stocks rise while industry participation falls',
      { leaderReturn, leaderCount, leaderExpected, leadership, oldLeadership });
  }
  return signals;
}

function computeHealth(snapshot, index, timeline, model, policy) {
  const date = timeline.dates[index];
  const coverage = healthCoverage(snapshot, policy);
  const usableSnapshot = coverage.ready ? snapshot : undefined;
  const prior = (offset) => {
    if (offset === 0) return usableSnapshot;
    const candidate = timeline.at(index - offset);
    return candidate && snapshot && timeline.sameContext(candidate, snapshot) && healthCoverage(candidate, policy).ready ? candidate : undefined;
  };
  const readComponent = (id, offset) => {
    const source = offset === 0 ? snapshot : prior(offset);
    if (id !== 'industryLeadership' || !source) return usableComponent(source, id, COMPONENTS[id].get(source), policy);
    const end = shiftDate(weekEnd(source.date), -28);
    const comparison = expectedSessions(shiftDate(end, -4), end).at(-1);
    const baselineIndex = timeline.index?.get(comparison);
    const baseline = baselineIndex != null ? prior(index - baselineIndex) : undefined;
    return usableComponent(source, id, COMPONENTS[id].get(source, baseline), policy);
  };
  const components = Object.entries(COMPONENTS).map(([id, component]) => {
    const data = readComponent(id, 0);
    const calibration = model.calibration[id] ?? { type: 'linear', min: component.range[0], max: component.range[1] };
    const values = [];
    if (calibration.type === 'percentile') {
      for (let offset = 1; offset <= calibration.lookback && offset <= index; offset++) {
        const historical = readComponent(id, offset);
        if (historical.adequacy?.sufficient !== false && historical.value != null) values.push(historical.value);
      }
    }
    const { score, reason } = data.adequacy?.sufficient === false
      ? { score: null, reason: 'insufficient_comparable_coverage' }
      : normalizeComponent(data.value, calibration, values);
    const weight = model.weights[id] / model.weightTotal;
    return {
      id, label: component.label, ...data, weight, score, reason,
      contribution: weight === 0 ? 0 : score == null ? null : weight * score, definition: component.definition,
      calibration: calibration.type === 'percentile' ? { ...calibration, observations: values.length } : calibration,
    };
  });
  const missing = components.filter((item) => item.weight > 0 && item.score == null).map((item) => item.id);
  const state = !coverage.ready ? 'insufficient_coverage' : missing.length ? 'insufficient_inputs' : 'ready';
  const features = Object.fromEntries(components.map(({ id, value, adequacy }) => [id, adequacy?.sufficient === false ? null : value]));
  const priorChange = prior(model.changeLookback);
  for (const [key, id] of [['shortChange', 'shortBreadth'], ['intermediateChange', 'intermediateBreadth']]) {
    const previous = usableComponent(priorChange, id, COMPONENTS[id].get(priorChange), policy);
    const before = previous.adequacy?.sufficient === false ? null : previous.value;
    const current = features[id];
    features[key] = before == null || current == null ? null : current - before;
  }
  const benchmark = rollingBenchmark(prior, model.benchmarkLookback);
  const exactBenchmarkReturn = usableSnapshot?.aggregates?.[`benchmarkReturn${model.benchmarkLookback}d`];
  features.benchmarkMomentum = finite(exactBenchmarkReturn) ? exactBenchmarkReturn * 100 : benchmark.momentum;
  const weaknessPeriod = Array.from({ length: model.weaknessLookback }, (_, i) => COMPONENTS.shortBreadth.get(prior(i + 1)).value);
  features.priorWeakSessions = weaknessPeriod.every(finite) ? weaknessPeriod.filter((value) => value < model.weaknessThreshold).length : null;
  const benchmarkHigh = usableSnapshot?.aggregates?.benchmarkHigh20d ??
    (model.benchmarkLookback === 20 ? benchmark.isNewHigh : rollingBenchmark(prior, 20).isNewHigh);
  const oldIndustry = readComponent('industryLeadership', 1);
  const reason = state === 'ready' ? null : state;
  return {
    date, score: reason ? null : components.reduce((sum, item) => sum + item.contribution, 0),
    state, reason, model, coverage, components, missingComponents: missing,
    regime: classifyRegime(features, model, { ...coverage, ready: state === 'ready' }),
    divergences: coverage.ready ? breadthDivergences(usableSnapshot, prior(1), benchmarkHigh,
      features.industryLeadership, oldIndustry.adequacy?.sufficient === false ? null : oldIndustry.value, policy) : [],
    ...policy,
    knownAt: snapshot?.knownAt ?? null, universe: snapshot?.universe ?? null, benchmark: snapshot?.benchmark ?? null,
  };
}

export function marketHealthHistory(snapshots, { model, sessions, ...coverage } = {}) {
  const definition = healthModel(model);
  const policy = coveragePolicy(coverage);
  const dates = !sessions && policy.descriptive ? snapshots.map(({ date }) => date).sort() : [];
  const timeline = snapshotTimeline(snapshots, sessions ?? (dates.length ? expectedSessions(dates[0], dates.at(-1)) : undefined));
  const output = [];
  let previousSnapshot;
  for (const [index, date] of timeline.dates.entries()) {
    const snapshot = timeline.at(index);
    const health = computeHealth(snapshot, index, timeline, definition, policy);
    const previous = output.at(-1)?.regime;
    const persists = health.regime.id !== 'unavailable' && previous?.id === health.regime.id &&
      timeline.sameContext(snapshot, previousSnapshot);
    health.regime.since = health.regime.id === 'unavailable' ? null : persists ? previous.since : date;
    health.regime.sessions = health.regime.id === 'unavailable' ? 0 : persists ? previous.sessions + 1 : 1;
    output.push(health);
    previousSnapshot = snapshot;
  }
  return output;
}

export function calculateMarketHealth(snapshot, { model, history = [], sessions, ...coverage } = {}) {
  if (!snapshot?.date) {
    const definition = healthModel(model);
    const health = computeHealth(undefined, 0, { dates: [null], at: () => undefined }, definition, coveragePolicy(coverage));
    return { ...health, regime: { ...health.regime, since: null, sessions: 0 } };
  }
  const previous = history.filter((item) => item.date < snapshot.date);
  const upToDate = sessions?.filter((date) => date <= snapshot.date);
  if (upToDate && !upToDate.includes(snapshot.date)) upToDate.push(snapshot.date);
  return marketHealthHistory([...previous, snapshot], { model, sessions: upToDate, ...coverage }).at(-1);
}

const DEFAULT_HORIZONS = Object.freeze([5, 10, 20, 60]);
const MAX_HORIZON = 5040;
const CROSSING_OPS = new Set(['crossesAbove', 'crossesBelow']);

function researchHorizons(values) {
  if (!Array.isArray(values) || !values.length) throw new TypeError('horizons must be a nonempty array of trading-session counts');
  return [...new Set(values.map((value) => boundedInteger(value, 'Horizon', 1, MAX_HORIZON)))];
}

function eventCondition(input, depth = 0) {
  if (!input || depth > 8) throw new TypeError('Each event condition must be specified, with up to eight levels of nested conditions');
  if (Object.hasOwn(input, 'all') || Object.hasOwn(input, 'any')) {
    if (Object.hasOwn(input, 'all') && Object.hasOwn(input, 'any')) throw new TypeError('A condition group must use either all or any');
    const key = Object.hasOwn(input, 'all') ? 'all' : 'any';
    if (!Array.isArray(input[key]) || !input[key].length) throw new TypeError('Event condition groups must be nonempty');
    return { [key]: input[key].map((condition) => eventCondition(condition, depth + 1)) };
  }
  const crossing = CROSSING_OPS.has(input.op);
  const condition = threshold(crossing ? { ...input, op: 'gt' } : input, 'Event condition');
  if (crossing) condition.op = input.op;
  if (input.after != null) {
    condition.after = {
      ...threshold({ ...input.after, metric: input.after.metric ?? input.metric }, 'Prior event condition'),
      within: boundedInteger(input.after.within, 'Prior condition lookback', 1, MAX_HORIZON),
    };
  }
  return condition;
}

function rawEventMetric(observation, metric) {
  return lookup(observation.metrics, metric) ?? lookup(observation.breadth, metric) ?? pathValue(observation, metric);
}

function eventMetric(observation, metric, cutoff, policy) {
  if (!observation || ((observation.coverage || policy.descriptive) && !healthCoverage(observation, policy).ready)) return null;
  const raw = rawEventMetric(observation, metric);
  const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
  if (!finite(value) || raw?.denominator === 0 || !adequateMetric(observation, metric, raw, policy) ||
      (raw?.effectiveDate != null && validateDate(raw.effectiveDate, 'Metric effective date') > observation.date) ||
      (raw?.knownAt != null && !knownBy(raw.knownAt, cutoff, observation.date))) return null;
  return value;
}

function comparedMetrics(condition) {
  const group = condition.all ?? condition.any;
  return group ? group.flatMap(comparedMetrics) : [condition.metric, ...(condition.after ? [condition.after.metric] : [])];
}

function observedEventEvidence(observation, metrics) {
  const { coverage } = observation;
  return {
    sourceState: coverage.state ?? null, sourceRatio: coverage.ratio ?? null,
    observedListed: coverage.listed, observedTraded: coverage.traded,
    metrics: Object.fromEntries(metrics.map((metric) => {
      const comparable = rawEventMetric(observation, metric)?.denominator ?? null;
      const expected = coverage.comparableExpected?.[metric] ?? coverage.traded;
      return [metric, { comparable, expected, ratio: positive(expected) && finite(comparable) ? comparable / expected : null }];
    })),
  };
}

function conditionResult(condition, index, metricAt) {
  const group = condition.all ?? condition.any;
  if (group) {
    const values = group.map((item) => conditionResult(item, index, metricAt));
    const result = condition.all ? false : true;
    if (values.includes(result)) return result;
    return values.includes(null) ? null : !result;
  }
  const value = metricAt(index, condition.metric);
  if (value == null) return null;
  let match;
  if (CROSSING_OPS.has(condition.op)) {
    const rises = condition.op === 'crossesAbove';
    if (rises ? value <= condition.value : value >= condition.value) return false;
    const previous = metricAt(index - 1, condition.metric);
    if (previous == null) return null;
    match = rises ? previous <= condition.value : previous >= condition.value;
  } else {
    match = conditionOps[condition.op](value, condition.value);
  }
  if (!match || !condition.after) return match;
  const { metric, op, value: target, within } = condition.after;
  let incomplete = false;
  for (let offset = 1; offset <= within; offset++) {
    const earlier = metricAt(index - offset, metric);
    incomplete ||= earlier == null;
    if (earlier != null && conditionOps[op](earlier, target)) return true;
  }
  return incomplete ? null : false;
}

function studyContext(sessions, asOf, maePrice) {
  if (maePrice !== 'close' && maePrice !== 'low') throw new RangeError('maePrice must be close or low');
  const trading = calendar(sessions);
  const cutoff = asOf ?? trading.dates.at(-1) ?? null;
  const cutoffDate = cutoff === null ? null : marketDate(cutoff, 'asOf');
  const observationCutoff = (date) => date === cutoffDate ? cutoff : date;
  const datePosition = (date) => {
    let low = 0;
    let high = trading.dates.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (trading.dates[mid] < date) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const indexedPrices = new WeakMap();
  const noPrices = new Map();
  const prices = (series) => {
    if (series == null) return noPrices;
    if (!Array.isArray(series)) throw new TypeError('Each price series must be an array of dated bars');
    if (!indexedPrices.has(series)) indexedPrices.set(series, indexDatedRecords(series, 'Price date'));
    return indexedPrices.get(series);
  };
  return { ...trading, cutoff, cutoffDate, observationCutoff, datePosition, prices, maePrice };
}

function cohortMembers(members, date, ctx) {
  if (!Array.isArray(members)) throw new TypeError('Cohort members must be an array');
  const byId = new Map();
  const eligible = members.filter((member) => {
    if (member?.securityId == null || !['number', 'string'].includes(typeof member.securityId) ||
        member.securityId === '' || (typeof member.securityId === 'number' && !finite(member.securityId))) {
      throw new TypeError('Every cohort member needs a permanent securityId');
    }
    if (member.delistingDate != null) validateDate(member.delistingDate, 'Delisting date');
    if (member.delistingKnownAt != null) marketDate(member.delistingKnownAt, 'delistingKnownAt');
    if (member.delistingReturnKnownAt != null) marketDate(member.delistingReturnKnownAt, 'delistingReturnKnownAt');
    const effective = member.effectiveDate ?? date;
    return validateDate(effective, 'Member effective date') <= date && knownBy(member.knownAt, ctx.observationCutoff(date), effective) &&
      !(member.delistingDate && member.delistingDate < date && knownBy(member.delistingKnownAt, date, member.delistingDate));
  });
  for (const member of eligible) {
    const key = String(member.securityId);
    if (byId.has(key)) throw new RangeError(`Duplicate securityId in cohort: ${key}`);
    const industryEffective = member.industryEffectiveDate ?? date;
    const industryAvailable = validateDate(industryEffective, 'Industry effective date') <= date &&
      knownBy(member.industryKnownAt, ctx.observationCutoff(date), industryEffective);
    byId.set(key, industryAvailable ? member : { ...member, industry: null });
  }
  return { members: [...byId.values()], excludedCount: members.length - eligible.length };
}

function outcome(status, fields = {}) {
  return {
    status, return: null, targetDate: null, exitDate: null, pathComplete: false, pathObservations: 0,
    pathExpected: 0, maximumAdverseExcursion: null, observedAdverseExcursion: null, maximumDrawdown: null,
    ...fields,
  };
}

function validClose(bar) {
  return bar?.traded !== false && positive(bar?.close) ? bar.close : null;
}

function forwardOutcome(series, entryIndex, horizon, ctx, member = {}) {
  const date = ctx.dates[entryIndex];
  const targetIndex = entryIndex + horizon;
  const targetDate = ctx.dates[targetIndex] ?? null;
  if (!targetDate || targetDate > ctx.cutoffDate) return outcome('rightCensored', { targetDate, pathExpected: horizon });
  const prices = ctx.prices(series);
  const entryBar = recordOn(prices, date, ctx.observationCutoff(date));
  const entry = validClose(entryBar);
  const delisted = member.delistingDate > date && member.delistingDate <= targetDate &&
    knownBy(member.delistingKnownAt, ctx.cutoff, member.delistingDate);
  if (!positive(entry)) return outcome(entryBar?.priceQuarantined ? 'quarantinedPrice' : 'missingEntry',
    { targetDate, pathExpected: horizon, delisted });

  let exitIndex = targetIndex;
  let exitDate = targetDate;
  let exit = validClose(recordOn(prices, targetDate, ctx.cutoff));
  let status = positive(exit) ? 'complete' : 'missingExit';
  if (status === 'missingExit' && !delisted && targetDate === ctx.cutoffDate && !DATE_PATTERN.test(ctx.cutoff)) {
    status = 'rightCensored';
  }
  if (delisted) {
    exitDate = member.delistingDate;
    exitIndex = ctx.datePosition(exitDate);
    const reference = member.delistingReferenceDate == null
      ? ctx.dates[exitIndex - 1] : validateDate(member.delistingReferenceDate, 'Delisting reference date');
    const referencePrice = reference && reference >= date && reference < exitDate
      ? reference === date ? entry : validClose(recordOn(prices, reference, ctx.cutoff)) : null;
    const terminalReturn = knownBy(member.delistingReturnKnownAt ?? member.delistingKnownAt, ctx.cutoff, exitDate)
      ? member.delistingReturn : null;
    exit = positive(referencePrice) && finite(terminalReturn) && terminalReturn >= -1 ? referencePrice * (1 + terminalReturn) : null;
    status = finite(exit) ? 'delisted' : 'delistedMissingReturn';
  }

  let worst = entry;
  let peak = entry;
  let drawdown = 0;
  let pathObservations = 0;
  let pathIssue = null;
  for (let index = entryIndex + 1; index <= exitIndex; index++) {
    const terminal = delisted && index === exitIndex;
    const bar = terminal ? undefined : recordOn(prices, ctx.dates[index], ctx.cutoff);
    if (bar?.priceQuarantined || bar?.unverifiedSplit) {
      pathIssue = bar.priceQuarantined ? 'quarantinedPrice' : 'unverifiedAdjustment';
      break;
    }
    const close = terminal ? exit : validClose(bar);
    const low = ctx.maePrice === 'low' && !terminal ? bar?.low : close;
    if (!finite(low) || low < 0 || (!terminal && !positive(low)) || !finite(close) || close < low) continue;
    pathObservations++;
    worst = Math.min(worst, low);
    drawdown = Math.min(drawdown, percent(low / peak));
    peak = Math.max(peak, close);
  }
  const pathExpected = exitIndex - entryIndex;
  const pathComplete = pathObservations === pathExpected;
  const observedAdverseExcursion = pathObservations ? percent(worst / entry) : null;
  if (pathIssue) status = pathIssue;
  return outcome(status, {
    targetDate, exitDate: ['complete', 'delisted'].includes(status) ? exitDate : null,
    return: ['complete', 'delisted'].includes(status) ? percent(exit / entry) : null, delisted,
    pathComplete, pathObservations, pathExpected, observedAdverseExcursion,
    maximumAdverseExcursion: pathComplete ? observedAdverseExcursion : null,
    maximumDrawdown: pathComplete ? drawdown : null,
  });
}

function summarize(outcomes) {
  const values = sortedNumbers(outcomes.map((item) => item.return).filter(finite));
  const adverse = outcomes.map((item) => item.maximumAdverseExcursion).filter(finite);
  const observedAdverse = sortedNumbers(outcomes.map((item) => item.observedAdverseExcursion).filter(finite));
  const drawdowns = sortedNumbers(outcomes.map((item) => item.maximumDrawdown).filter(finite));
  const counts = {
    complete: 0, delisted: 0, delistedMissingReturn: 0, missingEntry: 0, missingExit: 0, unverifiedAdjustment: 0,
    rightCensored: 0, unavailable: 0, pathIncomplete: 0, quarantinedPrice: 0,
  };
  for (const item of outcomes) {
    counts[item.status]++;
    if (finite(item.return) && !item.pathComplete) counts.pathIncomplete++;
  }
  const wins = values.filter((value) => value > 0).length;
  const average = mean(values);
  return {
    count: values.length, observations: outcomes.length, counts, wins, mean: average, median: quantile(values, 0.5),
    returnCoverage: outcomes.length ? values.length / outcomes.length : null,
    knownDelistings: outcomes.filter((item) => item.delisted).length,
    winRate: values.length ? wins / values.length * 100 : null,
    adverseExcursionCount: adverse.length, maximumAdverseExcursion: sortedNumbers(adverse)[0] ?? null,
    meanMaximumAdverseExcursion: mean(adverse), worstObservedAdverseExcursion: observedAdverse[0] ?? null,
    drawdownCount: drawdowns.length, maximumDrawdown: drawdowns[0] ?? null,
    distribution: {
      values, min: values[0] ?? null, p10: quantile(values, 0.1), p25: quantile(values, 0.25),
      p50: quantile(values, 0.5), p75: quantile(values, 0.75), p90: quantile(values, 0.9), max: values.at(-1) ?? null,
      standardDeviation: values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : null,
    },
  };
}

function memberOutcomes(members, securityPrices, entryIndex, horizon, ctx) {
  return members.map((member) => ({
    securityId: member.securityId, industry: member.industry ?? null,
    ...forwardOutcome(member.prices ?? lookup(securityPrices, member.securityId), entryIndex, horizon, ctx, member),
  }));
}

const RESEARCH_DEFINITIONS = Object.freeze({
  interpretation: 'Descriptive historical study.',
  availability: 'Signals, membership and entry bars use information known by the signal-session cutoff. Unstamped dated records are assumed available on their recorded session.',
  forwardReturn: 'Percentage change from signal-session adjusted close to the exact horizon close. Returns that cross an unverified split are unavailable. Known terminal delisting proceeds replace the horizon price when applicable. Delisting returns are fractional and applied to the specified reference close or the preceding session close.',
  adverseExcursion: 'The worst percentage change from entry to a subsequent observation, floored at zero for a wholly favorable path. Strict excursion and drawdown require a complete path. Observed excursion can understate a missing path.',
  maximumDrawdown: 'Worst decline from the running closing peak. Series priced with intraday lows use the previous closing peak and the current session low.',
  winRate: 'Percentage of finite forward returns strictly above zero.',
  medianStock: 'Per-event median of observable frozen-cohort returns. Excursion and drawdown are medians of strictly observable constituent measures. Missing and delisted member counts accompany every event.',
});

export function analyzeCohort({ sessions, date, members = [], securityPrices, horizons = DEFAULT_HORIZONS, asOf, maePrice = 'close' }) {
  const ctx = studyContext(sessions, asOf, maePrice);
  const index = ctx.index.get(validateDate(date, 'Cohort date'));
  const windows = researchHorizons(horizons);
  if (index === undefined || date > ctx.cutoffDate) throw new RangeError('Cohort date must be a trading session on or before asOf');
  const frozen = cohortMembers(members, date, ctx);
  const industries = new Map();
  for (const { industry = null } of frozen.members) industries.set(industry, (industries.get(industry) ?? 0) + 1);
  return {
    date, asOf: ctx.cutoff, maePrice, definitions: RESEARCH_DEFINITIONS, memberCount: frozen.members.length,
    excludedCount: frozen.excludedCount,
    industries: [...industries].map(([industry, count]) => ({ industry, count })).sort((a, b) =>
      b.count - a.count || String(a.industry).localeCompare(String(b.industry))),
    results: windows.map((horizon) => {
      const results = memberOutcomes(frozen.members, securityPrices, index, horizon, ctx);
      return { horizon, targetDate: ctx.dates[index + horizon] ?? null, summary: summarize(results), members: results };
    }),
  };
}

function medianStockOutcome(members, prices, index, horizon, ctx) {
  const targetDate = ctx.dates[index + horizon] ?? null;
  const outcomes = memberOutcomes(members, prices, index, horizon, ctx);
  const data = summarize(outcomes);
  const selected = (key) => median(outcomes.map((item) => item[key]).filter(finite));
  const status = data.count > 0 ? 'complete' : !targetDate || targetDate > ctx.cutoffDate ? 'rightCensored' : 'unavailable';
  return outcome(status, {
    targetDate, return: data.median, medianConstituentReturn: data.median,
    memberCount: data.observations, returnCount: data.count, returnCoverage: data.returnCoverage, counts: data.counts,
    knownDelistings: data.knownDelistings,
    potentialSurvivorshipBias: data.count < data.observations && status !== 'rightCensored',
    pathComplete: data.count > 0 && data.count === data.adverseExcursionCount,
    maximumAdverseExcursion: selected('maximumAdverseExcursion'), observedAdverseExcursion: selected('observedAdverseExcursion'),
    maximumDrawdown: selected('maximumDrawdown'), adverseExcursionCount: data.adverseExcursionCount,
  });
}

export function runEventStudy({
  sessions, observations = [], condition, benchmarks = {}, cohorts, securityPrices, horizons = DEFAULT_HORIZONS,
  asOf, start, end, overlap = 'perHorizon', minEventGap = 0, maePrice = 'close', coverageMode, observedMinimum, observedThreshold,
}) {
  const ctx = studyContext(sessions, asOf, maePrice);
  const windows = researchHorizons(horizons);
  const criteria = eventCondition(condition);
  const policy = coveragePolicy({ coverageMode, observedMinimum, observedThreshold });
  const assessedMetrics = policy.descriptive ? [...new Set(comparedMetrics(criteria))] : [];
  const gap = boundedInteger(minEventGap, 'minEventGap', 0, MAX_HORIZON);
  if (!['perHorizon', 'longest', 'none'].includes(overlap)) throw new RangeError('Invalid event overlap policy');
  if (start != null) validateDate(start, 'Study start date');
  if (end != null) validateDate(end, 'Study end date');
  if (start != null && end != null && start > end) throw new RangeError('Study start date must be on or before end date');
  const input = indexDatedRecords(observations, 'Observation date');
  const referenceSeries = benchmarks instanceof Map ? [...benchmarks] : Object.entries(benchmarks);
  const observationOn = (date) => date ? recordOn(input, date, ctx.observationCutoff(date)) : undefined;
  const metricAt = (index, metric) => {
    const date = ctx.dates[index];
    return date ? eventMetric(observationOn(date), metric, ctx.observationCutoff(date), policy) : null;
  };
  const matches = [];
  let unknownCount = 0;
  let evaluatedCount = 0;
  for (const [index, date] of ctx.dates.entries()) {
    if ((start && date < start) || (end && date > end) || date > ctx.cutoffDate) continue;
    const match = conditionResult(criteria, index, metricAt);
    if (match === null) unknownCount++;
    else evaluatedCount++;
    if (!match) continue;
    const observation = observationOn(date);
    const members = lookup(cohorts, date) ?? (securityPrices ? observation.stocks : undefined) ?? [];
    matches.push({
      index, date, value: criteria.metric ? metricAt(index, criteria.metric) : null,
      ...(policy.descriptive ? { coverageEvidence: observedEventEvidence(observation, assessedMetrics) } : {}),
      ...cohortMembers(members, date, ctx),
    });
  }
  const results = windows.map((horizon) => {
    const overlapGap = overlap === 'perHorizon' ? horizon : overlap === 'longest' ? Math.max(...windows) : 0;
    const separation = Math.max(gap, overlapGap);
    const events = [];
    let lastIndex = -Infinity;
    for (const event of matches) {
      if (event.index - lastIndex < separation) continue;
      lastIndex = event.index;
      const targetDate = ctx.dates[event.index + horizon] ?? null;
      events.push({
        date: event.date, value: event.value, targetDate, excludedCohortMembers: event.excludedCount,
        ...(event.coverageEvidence ? { coverageEvidence: event.coverageEvidence } : {}),
        benchmarks: Object.fromEntries(referenceSeries.map(([name, prices]) =>
          [name, forwardOutcome(prices, event.index, horizon, ctx)])),
        medianStock: medianStockOutcome(event.members, securityPrices, event.index, horizon, ctx),
      });
    }
    return {
      horizon, eventCount: events.length, suppressedCount: matches.length - events.length,
      benchmarks: Object.fromEntries(referenceSeries.map(([name]) => [name, summarize(events.map((event) => event.benchmarks[name]))])),
      medianStock: summarize(events.map((event) => event.medianStock)), events,
    };
  });
  return {
    condition: criteria, asOf: ctx.cutoff, start: start ?? null, end: end ?? null, maePrice, overlap, minEventGap: gap,
    ...policy, definitions: RESEARCH_DEFINITIONS, eventCount: matches.length, matchedCount: matches.length, unknownCount, evaluatedCount,
    events: matches.map(({ date, value, coverageEvidence }) => ({ date, value, ...(coverageEvidence ? { coverageEvidence } : {}) })), results,
  };
}

const analogFeatures = ['breadth.above_50d.value', 'breadth.positive_21d.value', 'breadth.top_decile.value'];

export function findHistoricalAnalogs({
  snapshots = [], sessions, asOf, horizon = 20, limit = 10, minimumHistory = 30, minimumFactors = 2,
  metrics = analogFeatures, overlap = 'nonoverlapping', ...coverage
} = {}) {
  const policy = coveragePolicy(coverage);
  const period = boundedInteger(horizon, 'Analog horizon', 1, 252);
  const maximum = boundedInteger(limit, 'Analog limit', 1, 100);
  const required = boundedInteger(minimumHistory, 'Analog minimum history', 2, 7560);
  const featuresRequired = boundedInteger(minimumFactors, 'Analog minimum factors', 1, 12);
  if (!Array.isArray(metrics) || metrics.length > 12 || metrics.some((metric) => typeof metric !== 'string' || !/^breadth\.[\w.]+\.value$/.test(metric))) {
    throw new TypeError('Analog metrics must be breadth value paths');
  }
  const features = [...new Set(metrics)];
  if (features.length < featuresRequired) throw new RangeError('Too few distinct analog metrics');
  if (!['nonoverlapping', 'allow'].includes(overlap)) throw new RangeError('Invalid analog overlap policy');
  const dates = snapshots.map(({ date }) => validateDate(date, 'Analog snapshot date')).sort();
  const cutoff = asOf == null ? dates.at(-1) ?? null : validateDate(asOf, 'Analog as-of date');
  const calendarDates = sessions ?? (dates.length && cutoff ? expectedSessions(dates[0], cutoff) : []);
  const timeline = snapshotTimeline(snapshots, calendarDates);
  const target = timeline.at(timeline.index.get(cutoff));
  const output = { asOf: cutoff, horizon: period, overlap, metrics: features, minimumHistory: required, minimumFactors: featuresRequired,
    sampleCount: 0, outcomeCount: 0, rightCensored: 0, missingOutcomes: 0, overlapSkipped: 0, matches: [], ...policy };
  const profile = (point) => {
    if (!point || !healthCoverage(point, policy).ready) return null;
    const values = features.map((path) => {
      const metric = path.slice(8, -6);
      return eventMetric(point, metric, point.date, policy);
    });
    return values.every(finite) ? values : null;
  };
  const current = profile(target);
  if (!current) return { ...output, state: 'current_profile_unavailable' };
  const cutoffIndex = timeline.index.get(cutoff);
  const candidates = [];
  for (let index = 0; index < cutoffIndex; index++) {
    const point = timeline.at(index);
    if (!timeline.sameContext(point, target)) continue;
    const readings = profile(point);
    if (readings) candidates.push({ index, date: point.date, readings });
  }
  output.sampleCount = candidates.length;
  if (candidates.length < required) return { ...output, state: 'insufficient_history' };
  const spreads = features.map((_, feature) => {
    const values = candidates.map(({ readings }) => readings[feature]);
    const center = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
  });
  const informative = spreads.flatMap((spread, feature) => spread > 0 ? [feature] : []);
  output.informativeMetrics = informative.map((feature) => features[feature]);
  if (informative.length < featuresRequired) return { ...output, state: 'insufficient_varying_factors' };
  const distance = ({ readings }) => Math.sqrt(mean(informative.map((feature) => ((readings[feature] - current[feature]) / spreads[feature]) ** 2)));
  const nearest = candidates.map((candidate) => ({ ...candidate, distance: distance(candidate) }))
    .sort((left, right) => left.distance - right.distance || right.date.localeCompare(left.date));
  const accepted = [];
  for (const candidate of nearest) {
    if (accepted.length === maximum) break;
    if (overlap === 'nonoverlapping' && accepted.some((other) => Math.abs(candidate.index - other.index) < period)) {
      output.overlapSkipped++;
      continue;
    }
    accepted.push(candidate);
    const end = candidate.index + period;
    let gross = 1;
    let status = end > cutoffIndex ? 'rightCensored' : 'complete';
    if (status === 'complete') {
      for (let index = candidate.index + 1; index <= end; index++) {
        const point = timeline.at(index);
        const value = point?.aggregates?.benchmarkReturn;
        if (!timeline.sameContext(point, target) || !finite(value) || value <= -1) { status = 'missingBenchmark'; break; }
        gross *= 1 + value;
      }
    }
    const forwardReturn = status === 'complete' ? percent(gross) : null;
    if (status === 'rightCensored') output.rightCensored++;
    if (status === 'missingBenchmark') output.missingOutcomes++;
    output.matches.push({ date: candidate.date, targetDate: end <= cutoffIndex ? timeline.dates[end] : null,
      distance: candidate.distance, forwardReturn, status, readings: Object.fromEntries(features.map((name, index) => [name, candidate.readings[index]])) });
  }
  const observed = output.matches.map(({ forwardReturn }) => forwardReturn).filter(finite);
  output.outcomeCount = observed.length;
  return { ...output, state: 'ready', benchmark: target.benchmark, returnUnit: 'percent',
    benchmarkSummary: { mean: mean(observed), median: median(observed),
      winRate: observed.length ? observed.filter(positive).length / observed.length : null },
    definitions: {
      distance: 'Root mean square across standardized breadth differences, using the dispersion in prior eligible sessions only.',
      overlap: 'With nonoverlapping enabled, closer matches take priority and forward windows do not share return sessions.',
      forwardReturn: 'Compounded benchmark daily returns over the selected number of sessions after the analog, through the as-of date.',
    } };
}

export function leadershipTransitionMatrix(snapshots = [], { bands = [0, 50, 80, 90, 95], detail = false } = {}) {
  if (!Array.isArray(bands) || !bands.length || bands.length > 12 || bands[0] !== 0 ||
      bands.some((value, index) => !finite(value) || value < 0 || value > 100 || index > 0 && value <= bands[index - 1])) {
    throw new RangeError('Rank band bounds must begin at 0 and strictly increase through 100');
  }
  const labels = bands.map((value, i) => i + 1 < bands.length ? `${value}–<${bands[i + 1]}` : `${value}–100`);
  const from = [...labels, 'NEW'];
  const to = [...labels, 'EXIT'];
  const counts = () => Array.from({ length: from.length }, () => Array(to.length).fill(0));
  const totals = counts();
  const weeks = [];
  const totalsFor = () => ({ comparable: 0, enteredEligibility: 0, leftEligibility: 0, newlyRanked: 0, lostRank: 0 });
  const participants = totalsFor();
  const last = bands.length;
  const band = (value) => finite(value) && value >= 0 && value <= 100 ? bands.findLastIndex((floor) => value >= floor) : -1;
  const points = snapshots.map((point) => ({ ...point, date: validateDate(point.date, 'Weekly ranking date') }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const timeline = snapshotTimeline(points);
  let prior = null;
  let pairs = 0;
  let skippedIncomplete = 0;
  let skippedGaps = 0;
  for (const [index, date] of timeline.dates.entries()) {
    const end = weekEnd(date);
    const close = expectedSessions(shiftDate(end, -4), end).at(-1);
    if (date !== close) { skippedIncomplete++; continue; }
    const current = timeline.at(index);
    if (!current) continue;
    if (prior) {
      if (shiftDate(weekEnd(prior.date), 7) !== end || !timeline.sameContext(prior, current)) skippedGaps++;
      else {
        pairs++;
        const old = new Map((prior.stocks ?? []).map((stock) => [stock.securityId, band(stock.rsPercentile)]));
        const next = new Map((current.stocks ?? []).map((stock) => [stock.securityId, band(stock.rsPercentile)]));
        const changes = totalsFor();
        const matrix = detail ? counts() : null;
        for (const id of new Set([...old.keys(), ...next.keys()])) {
          const before = old.get(id);
          const after = next.get(id);
          if (before == null) changes.enteredEligibility++;
          if (after == null) changes.leftEligibility++;
          if (before === -1 && after >= 0) changes.newlyRanked++;
          if (before >= 0 && after === -1) changes.lostRank++;
          if (before >= 0 && after >= 0) changes.comparable++;
          if (!(before >= 0) && !(after >= 0)) continue;
          const x = before >= 0 ? before : last;
          const y = after >= 0 ? after : last;
          totals[x][y]++;
          if (matrix) matrix[x][y]++;
        }
        for (const key of Object.keys(changes)) participants[key] += changes[key];
        if (detail) weeks.push({ previousDate: prior.date, date, matrix, ...changes });
      }
    }
    prior = current;
  }
  return { bands, from, to, matrix: totals, pairs, skippedIncomplete, skippedGaps, ...participants, weeks,
    definitions: {
      comparable: 'Permanent IDs with a percentile in both consecutive completed weeks.',
      new: 'Ranked this week with no preceding rank. Eligibility entrants and previously unranked stocks are counted separately.',
      exit: 'Ranked in the preceding week with no current rank. Eligibility exits and still-eligible unranked stocks are counted separately.',
    } };
}

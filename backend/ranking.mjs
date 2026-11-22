import { isoDate } from './database.mjs';
import { deviation, finite, mean, returnWindow } from './metrics.mjs';

const delta = (current, prior) => finite(current) && finite(prior) ? current - prior : null;

const momentumWindows = [
  { kind: 'sessions', length: 252, weight: 0.4 },
  { kind: 'sessions', length: 126, weight: 0.3 },
  { kind: 'sessions', length: 63, weight: 0.2 },
  { kind: 'sessions', length: 21, weight: 0.1 },
];
export const RANKING_METHODS = ['weighted', 'percentile', 'zscore', 'benchmark', 'risk', 'nonoverlapping'];
export const BUILTIN_MODELS = [
  { id: 'composite', name: 'Composite RS', version: 1, definition: { method: 'weighted', priceMode: 'split', windows: momentumWindows } },
  { id: 'short-momentum', name: 'Short-term Momentum', version: 1, definition: { method: 'weighted', priceMode: 'split', windows: [{ kind: 'sessions', length: 63, weight: 0.45 }, { kind: 'sessions', length: 21, weight: 0.35 }, { kind: 'sessions', length: 5, weight: 0.2 }] } },
  { id: 'benchmark-relative', name: 'Benchmark Relative', version: 1, definition: { method: 'benchmark', priceMode: 'split', windows: momentumWindows } },
];

export function validateModel(input = {}) {
  const method = input.method || 'weighted';
  const priceMode = input.priceMode || 'split';
  if (!RANKING_METHODS.includes(method)) throw new Error('Unknown ranking method');
  if (!['split', 'total'].includes(priceMode)) throw new Error('Unknown price mode');
  if (!Array.isArray(input.windows) || !input.windows.length || input.windows.length > 50) {
    throw new Error('Add 1–50 return windows');
  }
  const windows = input.windows.map((window) => {
    const kind = window.kind || 'sessions';
    const length = Number(window.length);
    const offset = Number(window.offset || 0);
    const weight = Number(window.weight);
    if (!finite(weight) || weight < 0) throw new Error('Ranking weights must be nonnegative numbers');
    if (!['sessions', 'months', 'quarters', 'years', 'ytd', 'fixed'].includes(kind)) throw new Error('Unknown return window');
    if (['sessions', 'months', 'quarters', 'years'].includes(kind)) {
      const limit = { sessions: 7560, months: 360, quarters: 120, years: 30 }[kind];
      if (!Number.isInteger(length) || length < 1 || !Number.isInteger(offset) || offset < 0 || length + offset > limit) {
        throw new Error('Return-window duration and lag must fit within 30 years');
      }
    }
    if (kind === 'fixed' && (!isoDate(window.start) || !isoDate(window.end) || window.start >= window.end)) {
      throw new Error('Fixed windows require an ordered start and end date');
    }
    return { kind, length: finite(length) ? length : null, offset, weight, start: window.start || null, end: window.end || null };
  });
  const total = windows.reduce((sum, window) => sum + window.weight, 0);
  if (!(total > 0) || !finite(total)) throw new Error('At least one ranking weight must be positive');
  return { method, priceMode, windows: windows.filter(({ weight }) => weight > 0).map((window) => ({ ...window, weight: window.weight / total })) };
}

function priorMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function onOrBefore(sessions, date) {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sessions[mid] <= date) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

export function modelWindowBounds(definition, sessions, endDate) {
  const index = onOrBefore(sessions, endDate);
  const bounds = definition.windows.map((window) => {
    if (window.kind === 'sessions') return [index - window.offset - window.length, index - window.offset];
    if (window.kind === 'ytd') return [onOrBefore(sessions, `${endDate.slice(0, 4)}-01-01`), index];
    if (window.kind === 'fixed') return [onOrBefore(sessions, window.start), window.end > endDate ? -1 : onOrBefore(sessions, window.end)];
    const factor = window.kind === 'months' ? 1 : window.kind === 'quarters' ? 3 : 12;
    return [
      onOrBefore(sessions, priorMonths(endDate, factor * (window.length + window.offset))),
      onOrBefore(sessions, priorMonths(endDate, factor * window.offset)),
    ];
  });
  if (definition.method === 'nonoverlapping') {
    const valid = bounds.filter(([start, end]) => start >= 0 && end > start).toSorted(([start], [other]) => start - other);
    if (valid.some(([start], position) => position > 0 && start < valid[position - 1][1])) {
      throw new Error('Nonoverlapping momentum requires disjoint date windows. Use a lag to place each period.');
    }
  }
  return bounds;
}

export function rankBy(rows, score, id = (row) => row.securityId) {
  const candidates = rows.filter((row) => finite(score(row))).toSorted((a, b) => {
    return score(b) - score(a) || String(id(a)).localeCompare(String(id(b)), 'en');
  });
  const byId = new Map();
  if (!candidates.length) return byId;
  const strongest = score(candidates[0]);
  const weakest = score(candidates.at(-1));
  const firstDifferent = candidates.findIndex((item) => score(item) !== strongest);
  const topMidpoint = (firstDifferent - 1) / 2;
  const bottomMidpoint = (candidates.findIndex((item) => score(item) === weakest) + candidates.length - 1) / 2;
  for (let start = 0; start < candidates.length;) {
    let end = start;
    while (end + 1 < candidates.length && score(candidates[start]) === score(candidates[end + 1])) end++;
    const ordinal = (start + end) / 2;
    const percentile = strongest === weakest ? 50 : 100 * (bottomMidpoint - ordinal) / (bottomMidpoint - topMidpoint);
    for (let position = start; position <= end; position++) {
      byId.set(id(candidates[position]), { rank: position + 1, percentile });
    }
    start = end + 1;
  }
  return byId;
}

export function modelInputs(series, bounds, definition) {
  const components = bounds.map(([start, end]) => returnWindow(series, start, end, definition.priceMode));
  if (definition.method !== 'risk') return { components, risk: null };
  const risk = bounds.map(([start, end], index) => {
    if (components[index] == null || end - start < 2) return null;
    const values = [];
    for (let position = start + 1; position <= end; position++) {
      const value = returnWindow(series, position - 1, position, definition.priceMode);
      if (value == null) return null;
      values.push(value);
    }
    const volatility = deviation(values);
    return volatility > 0 ? volatility * Math.sqrt(values.length) : null;
  });
  return { components, risk };
}

export function scoreRanking(rows, definition, benchmarkInputs, risks = null) {
  const candidates = rows.filter((row) => row.traded && row.rsComponents.every(finite));
  const columns = definition.method === 'zscore' ? definition.windows.map((_, index) => candidates.map((row) => row.rsComponents[index])) : null;
  const percentiles = definition.method === 'percentile'
    ? definition.windows.map((_, index) => rankBy(candidates, (row) => row.rsComponents[index])) : null;
  const stats = columns?.map((column) => [mean(column), deviation(column)]) ?? null;
  for (const row of candidates) {
    const risk = risks?.get(row) ?? row.rsRisk;
    const values = row.rsComponents.map((value, index) => {
      if (definition.method === 'benchmark') return finite(benchmarkInputs.components[index]) ? value - benchmarkInputs.components[index] : null;
      if (definition.method === 'risk') return risk[index] > 0 ? value / risk[index] : null;
      if (percentiles) return percentiles[index].get(row.securityId).percentile / 100;
      if (stats) return stats[index][1] > 0 ? (value - stats[index][0]) / stats[index][1] : 0;
      return value;
    });
    row.rsScore = values.every(finite) ? values.reduce((sum, value, index) => sum + value * definition.windows[index].weight, 0) : null;
  }
  const ranking = rankBy(candidates, (row) => row.rsScore);
  for (const row of rows) {
    const item = ranking.get(row.securityId);
    row.rsRank = item?.rank ?? null;
    row.rsPercentile = item?.percentile ?? null;
    row.rsScore ??= null;
  }
}

const weeklyLookups = new WeakMap();
function lookupWeek(snapshot, memoize) {
  const prior = memoize ? weeklyLookups.get(snapshot) : null;
  if (prior) return prior;
  const stocks = new Map(snapshot.stocks.map((row) => [row.securityId, row]));
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  const view = { stocks, groups };
  if (memoize) weeklyLookups.set(snapshot, view);
  return view;
}

function writeStockVelocity(target, item, past) {
  let recent, second, fourth, twelfth;
  let highest = -Infinity;
  const ranked = finite(item.rsPercentile);
  let comparableWeeks = Number(ranked);
  let leaderWeeks = Number(ranked && item.rsPercentile >= 90);
  const persistence = [null, null, null];
  for (let index = 0; index < past.length; index++) {
    const prior = past[index].get(item.securityId);
    if (index === 0) recent = prior;
    else if (index === 1) second = prior;
    else if (index === 3) fourth = prior;
    else if (index === 11) twelfth = prior;
    if (finite(prior?.rsScore)) highest = Math.max(highest, prior.rsScore);
    if (finite(prior?.rsPercentile)) {
      comparableWeeks++;
      if (prior.rsPercentile >= 90) leaderWeeks++;
    }
    if ((index === 2 || index === 6 || index === 10) && comparableWeeks === index + 2) {
      persistence[(index - 2) / 4] = leaderWeeks;
    }
  }
  target.rsStatus = item.rsRank == null ? 'INSUFFICIENT' : !recent || recent.rsRank == null ? 'NEW' : 'RANKED';
  target.rankChange1w = recent?.rsRank != null && item.rsRank != null ? recent.rsRank - item.rsRank : null;
  target.velocity1w = recent?.rsPercentile != null && item.rsPercentile != null ? item.rsPercentile - recent.rsPercentile : null;
  target.rankChange4w = fourth?.rsRank != null && item.rsRank != null ? fourth.rsRank - item.rsRank : null;
  target.velocity4w = fourth?.rsPercentile != null && item.rsPercentile != null ? item.rsPercentile - fourth.rsPercentile : null;
  target.rankChange12w = twelfth?.rsRank != null && item.rsRank != null ? twelfth.rsRank - item.rsRank : null;
  target.velocity12w = twelfth?.rsPercentile != null && item.rsPercentile != null ? item.rsPercentile - twelfth.rsPercentile : null;
  target.rsScoreChange = finite(recent?.rsScore) && finite(item.rsScore) ? item.rsScore - recent.rsScore : null;
  target.rsAcceleration = finite(target.velocity1w) && finite(second?.rsPercentile)
    ? target.velocity1w - (recent.rsPercentile - second.rsPercentile) : null;
  target.rsNewHigh = highest !== -Infinity && finite(item.rsScore) ? item.rsScore > highest : null;
  target.leadingWeeks = ranked ? leaderWeeks : null;
  target.leadingWeekCoverage = comparableWeeks;
  for (const [index, weeks] of persistence.entries()) {
    const period = 4 * (index + 1);
    target[`topDecileWeeks${period}w`] = weeks;
    target[`topDecilePersistence${period}w`] = weeks != null ? weeks === period : null;
  }
  for (const limit of [1, 5, 10, 20]) {
    target[`enteredTop${limit}`] = recent?.rsPercentile != null && item.rsPercentile != null
      ? item.rsPercentile >= 100 - limit && recent.rsPercentile < 100 - limit : null;
  }
  target.rsHighBeforePrice = target.rsNewHigh == null || item.new_high_252d == null ? null : target.rsNewHigh && !item.new_high_252d;
  target.deterioratingOnPriceStrength = target.velocity4w == null || item.return_21d == null ? null : target.velocity4w < 0 && item.return_21d > 0;
  target.momentumImproving = item.return_63d == null || item.return_252d == null ? null : item.return_63d * 4 > item.return_252d;
  target.udvChange4w = delta(item.udv_50d, fourth?.udv_50d);
  target.upVolumeShareChange4w = delta(item.up_volume_50d, fourth?.up_volume_50d);
  target.volumeDemandImproving = target.upVolumeShareChange4w == null ? null : target.upVolumeShareChange4w > 0;
  const strongVolume = item.udv_state_50d === 'infinity' || finite(item.udv_50d) && item.udv_50d > 1.2;
  target.priceAndVolumeStrength = !finite(item.return_21d) || target.volumeDemandImproving == null
    ? null : item.return_21d > 0 && strongVolume && target.volumeDemandImproving;
  target.lifecycle = item.rsPercentile == null ? null
    : item.rsPercentile >= 90 && target.leadingWeeks >= 5 ? 'Established Leader'
    : target.velocity4w > 10 ? (item.rsPercentile >= 75 ? 'Strengthening' : 'Emerging')
    : target.velocity4w < -10 ? 'Deteriorating' : 'Lagging';
}

export function createStockVelocityLayer(stocks, weekly, { memoizeWeeks = false } = {}) {
  const past = weekly.map((snapshot) => lookupWeek(snapshot, memoizeWeeks).stocks);
  const layers = new Map();
  for (const stock of stocks) {
    const fields = {};
    writeStockVelocity(fields, stock, past);
    layers.set(stock.securityId, fields);
  }
  return layers;
}

export function annotateVelocity(current, weekly, { memoizeWeeks = false } = {}) {
  const lookups = weekly.map((snapshot) => lookupWeek(snapshot, memoizeWeeks));
  const past = lookups.map(({ stocks }) => stocks);
  for (const item of current.stocks) writeStockVelocity(item, item, past);
  writeGroupVelocity(current, lookups.map(({ groups }) => groups));
}

export function annotateGroupVelocity(current, weekly, { memoizeWeeks = false } = {}) {
  writeGroupVelocity(current, weekly.map((snapshot) => lookupWeek(snapshot, memoizeWeeks).groups));
}

function writeGroupVelocity(current, groupHistory) {
  for (const group of current.groups) {
    for (const period of [4, 12]) {
      const before = groupHistory[period - 1]?.get(group.id);
      group[`velocity${period}w`] = finite(group.percentile) && finite(before?.percentile) ? group.percentile - before.percentile : null;
      group[`rankChange${period}w`] = finite(group.rank) && finite(before?.rank) ? before.rank - group.rank : null;
    }
    const old = groupHistory[3]?.get(group.id);
    group.medianRSChange4w = delta(group.medianRS, old?.medianRS);
    group.topDecileChange4w = delta(group.topDecile, old?.topDecile);
    group.breadthChange = delta(group.above50, old?.above50);
    group.relativeReturnChange4w = delta(group.relativeReturn, old?.relativeReturn);
    const emergenceInputs = [group.medianRSChange4w, group.topDecileChange4w, group.breadthChange, group.relativeReturnChange4w];
    group.emerging = emergenceInputs.every(finite) ? emergenceInputs.every((value) => value > 0) : null;
  }
  const industry = new Map(current.groups.map((group) => [group.id, group]));
  for (const row of current.stocks) {
    const group = industry.get(row.industryId);
    row.industryVelocity = group?.velocity4w ?? null;
    row.industryImproving = group?.velocity4w == null ? null : group.velocity4w > 0;
    row.industryEmerging = group?.emerging ?? null;
  }
}

export function topDecileIds(snapshot) {
  return (snapshot.stocks ?? []).filter((row) => finite(row.rsPercentile) && row.rsPercentile >= 90)
    .map(({ securityId }) => securityId);
}

export function leadershipStatistics(snapshot, previousDate, previousIds) {
  const cohort = new Set(previousIds ?? []);
  let returns = 0;
  let totalReturn = 0;
  let comparableRanks = 0;
  let retained = 0;
  for (const row of snapshot.stocks ?? []) {
    if (!cohort.has(row.securityId)) continue;
    if (finite(row.return_1d)) {
      totalReturn += row.return_1d;
      returns++;
    }
    if (finite(row.rsPercentile)) {
      comparableRanks++;
      if (row.rsPercentile >= 90) retained++;
    }
  }
  return {
    previousLeaderDate: previousIds == null ? null : previousDate,
    leaderReturn: returns ? totalReturn / returns : null,
    leaderReturnExpected: previousIds == null ? null : cohort.size,
    leaderReturnObservations: returns,
    leadershipRankObservations: comparableRanks,
    leadershipPersistence: comparableRanks ? retained / comparableRanks : null,
    leadershipTurnover: comparableRanks ? (comparableRanks - retained) / comparableRanks : null,
  };
}

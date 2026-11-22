import { AVERAGES, deviation, finite, mean, quantile, ratio, sortedQuantile } from './metrics.mjs';
import { rankBy } from './ranking.mjs';

export function binaryMetric(rows, evaluate) {
  let denominator = 0;
  let numerator = 0;
  for (const row of rows) {
    const matched = evaluate(row);
    if (matched == null) continue;
    denominator++;
    if (matched) numerator++;
  }
  return { numerator, denominator, value: denominator ? 100 * numerator / denominator : null };
}

const compare = (field, predicate) => (row) => finite(row[field]) ? predicate(row[field]) : null;
const truth = (field) => (row) => row[field] ?? null;
const entries = [];
const add = (key, label, family, definition, test) => entries.push({ key, label, family, definition, test });

for (const threshold of [1, 2, 4]) {
  add(`up_${threshold}pct`, `Up ≥ ${threshold}%`, 'Daily momentum', `Split-adjusted close ≥ ${threshold}% above the preceding market session.`, compare('return_1d', (v) => v >= threshold / 100 - 1e-12));
  add(`down_${threshold}pct`, `Down ≥ ${threshold}%`, 'Daily momentum', `Split-adjusted close ≥ ${threshold}% below the preceding market session.`, compare('return_1d', (v) => v <= -threshold / 100 + 1e-12));
}
add('advancers', 'Advancers', 'Advance / decline', 'Positive one-session split-adjusted return.', compare('return_1d', (v) => v > 0));
add('decliners', 'Decliners', 'Advance / decline', 'Negative one-session split-adjusted return.', compare('return_1d', (v) => v < 0));
add('unchanged', 'Unchanged', 'Advance / decline', 'Zero one-session split-adjusted return.', compare('return_1d', (v) => v === 0));
for (const n of AVERAGES) {
  add(`above_${n}d`, `Above ${n}D SMA`, 'Moving averages', `Close strictly above the ${n}-session simple moving average.`, truth(`above_${n}d`));
}
for (const n of [20, 50, 100, 252]) {
  add(`new_high_${n}d`, `New ${n}D high`, 'Highs and lows', `Session high exceeds the preceding ${n} highs.`, truth(`new_high_${n}d`));
  add(`new_low_${n}d`, `New ${n}D low`, 'Highs and lows', `Session low undercuts the preceding ${n} lows.`, truth(`new_low_${n}d`));
  add(`breakout_${n}d`, `${n}D breakout on volume`, 'Highs and lows', 'New rolling high and volume at least 1.5× prior 20-session average.', (row) => {
    const high = row[`new_high_${n}d`];
    return high == null || row.rvol_20d == null ? null : high && row.rvol_20d >= 1.5;
  });
}
for (const n of [21, 63, 126, 252]) {
  add(`positive_${n}d`, `Positive ${n}D return`, 'Multi-session momentum', 'Split-adjusted return over consecutive market sessions is positive.', compare(`return_${n}d`, (v) => v > 0));
}
for (const n of [5, 10, 20, 42, 63, 126, 252]) {
  for (const threshold of [25, 50]) {
    add(`up_${threshold}pct_${n}d`, `Up ≥ ${threshold}% · ${n}D`, 'Multi-session momentum', `Return over ${n} sessions at least +${threshold}%.`, compare(`return_${n}d`, (v) => v >= threshold / 100 - 1e-12));
    add(`down_${threshold}pct_${n}d`, `Down ≥ ${threshold}% · ${n}D`, 'Multi-session momentum', `Return over ${n} sessions at most −${threshold}%.`, compare(`return_${n}d`, (v) => v <= -threshold / 100 + 1e-12));
  }
}
add('near_high', 'Within 10% of 52W high', 'Highs and lows', 'Close at least 90% of the highest daily high over 252 sessions.', compare('distance_high_252d', (v) => v >= -0.1));
add('far_below_high', 'Over 30% below 52W high', 'Highs and lows', 'Close below 70% of the highest daily high over 252 sessions.', compare('distance_high_252d', (v) => v < -0.3));
add('ma_50_above_200', '50D SMA above 200D', 'Moving averages', '50-session simple moving average above 200-session average.', truth('ma_50_above_200'));
add('ma_rising_50', 'Rising 50D SMA', 'Moving averages', '50-session SMA higher than five sessions ago.', truth('ma_rising_50'));
add('ma_rising_200', 'Rising 200D SMA', 'Moving averages', '200-session SMA higher than five sessions ago.', truth('ma_rising_200'));
add('ma_aligned', 'Bullish 20/50/200D alignment', 'Moving averages', '20-day SMA > 50-day SMA > 200-day SMA.', truth('ma_aligned'));
add('high_volume_up', 'High-volume advancers', 'Volume', 'Advanced with volume ≥ 1.5× prior 20-session average.', (row) => row.return_1d == null || row.rvol_20d == null ? null : row.return_1d > 0 && row.rvol_20d >= 1.5);
add('high_volume_down', 'High-volume decliners', 'Volume', 'Declined with volume ≥ 1.5× prior 20-session average.', (row) => row.return_1d == null || row.rvol_20d == null ? null : row.return_1d < 0 && row.rvol_20d >= 1.5);
add('high_volume_up_2x', 'High-volume advancers (2×)', 'Volume', 'Advanced with volume ≥ 2× prior 20-session average.', (row) =>
  finite(row.return_1d) && finite(row.rvol_20d) ? row.return_1d > 0 && row.rvol_20d >= 2 : null);
add('high_volume_down_2x', 'High-volume decliners (2×)', 'Volume', 'Declined with volume ≥ 2× prior 20-session average.', (row) =>
  finite(row.return_1d) && finite(row.rvol_20d) ? row.return_1d < 0 && row.rvol_20d >= 2 : null);
add('relative_volume_15', 'Relative volume ≥ 1.5×', 'Volume', 'Today’s volume ≥ 1.5× prior 20-session average.', compare('rvol_20d', (v) => v >= 1.5));
add('relative_volume_20', 'Relative volume ≥ 2×', 'Volume', 'Today’s volume ≥ 2× prior 20-session average.', compare('rvol_20d', (v) => v >= 2));
add('positive_obv', 'Positive OBV trend', 'Volume', 'Signed share-volume trend over 20 sessions is positive.', compare('obv_slope', (v) => v > 0));
for (const multiple of [1, 1.2, 1.5]) {
  add(`udv_above_${multiple}`, `U/D volume above ${multiple}×`, 'Volume', '50-session up-day volume divided by down-day volume exceeds threshold.', (row) => {
    if (row.udv_state_50d === 'infinity') return true;
    return finite(row.udv_50d) ? row.udv_50d > multiple : null;
  });
}
add('outperform_benchmark', 'Outperforming benchmark', 'Leadership', '21-session split-adjusted return above selected benchmark.', compare('relative_return_21d', (v) => v > 0));
add('outperform_industry', 'Outperforming industry', 'Leadership', '21-session return above industry equal-weight return.', compare('industryRelativeReturn', (v) => v > 0));
add('top_decile', 'Top-decile RS', 'Leadership', 'Relative-strength percentile ≥ 90.', compare('rsPercentile', (v) => v >= 90));

const definitions = new Map(entries.map((item) => [item.key, item]));
const contextualBreadth = new Set(['outperform_industry', 'top_decile']);
const stockBreadth = entries.filter(({ key }) => !contextualBreadth.has(key));
export const BREADTH_METRICS = entries.map(({ test, ...item }) => item);
export function breadthMetric(key) {
  if (definitions.has(key)) return definitions.get(key);
  const custom = /^(up|down)_([0-9]+(?:\.[0-9]+)?)pct(?:_([1-9][0-9]*)d)?$/.exec(key);
  if (!custom) return null;
  const [, direction, threshold, rawWindow] = custom;
  const window = Number(rawWindow || 1);
  const number = Number(threshold);
  if (window > 7560 || !(number > 0 && number <= 1000)) return null;
  return {
    key, label: `${direction === 'up' ? 'Up' : 'Down'} ≥ ${number}% · ${window}D`,
    family: 'Custom momentum',
    definition: `${window}-session split-adjusted return ${direction === 'up' ? 'at least +' : 'at most −'}${threshold}%.`,
    test: compare(`return_${window}d`, (value) => direction === 'up' ? value >= number / 100 - 1e-12 : value <= -number / 100 + 1e-12),
  };
}

export function aggregateRows(rows, { distribution = true } = {}) {
  const result = {
    upVolume: 0, downVolume: 0, upDollar: 0, downDollar: 0, advancingVolume: 0,
    positiveDollarObservations: 0, dollarVolumeObservations: 0, volumeObservations: 0,
    dailyObservations: 0, capWeightObservations: 0,
  };
  const comparable = rows.filter((row) => finite(row.return_1d));
  const returns = comparable.map((row) => row.return_1d);
  const capWeighted = comparable.filter((row) => row.prior_market_cap > 0);
  const cap = capWeighted.reduce((sum, row) => sum + row.prior_market_cap, 0);
  for (const row of comparable) {
    if (finite(row.volume)) result.volumeObservations++;
    if (finite(row.dollar_volume)) result.dollarVolumeObservations++;
    if (row.return_1d > 0) {
      result.upVolume += row.volume || 0;
      result.upDollar += row.dollar_volume || 0;
      if (finite(row.dollar_volume)) result.positiveDollarObservations++;
    }
    if (row.return_1d < 0) {
      result.downVolume += row.volume || 0;
      result.downDollar += row.dollar_volume || 0;
    }
  }
  result.dailyObservations = comparable.length;
  result.capWeightObservations = capWeighted.length;
  result.upVolumeShare = ratio(result.upVolume, result.upVolume + result.downVolume);
  result.upDollarShare = ratio(result.upDollar, result.upDollar + result.downDollar);
  result.upDownVolume = ratio(result.upVolume, result.downVolume);
  result.upDownDollar = ratio(result.upDollar, result.downDollar);
  result.upDownVolumeState = result.upDownVolume != null ? 'available' : result.upVolume > 0 ? 'infinity' : 'unavailable';
  result.netDollar = result.dollarVolumeObservations ? result.upDollar - result.downDollar : null;
  result.equalWeightReturn = mean(returns);
  result.capWeightReturn = cap > 0 ? capWeighted.reduce((sum, row) => sum + row.prior_market_cap * row.return_1d, 0) / cap : null;
  if (distribution) {
    const sortedReturns = returns.toSorted((a, b) => a - b);
    result.medianReturn = sortedQuantile(sortedReturns, 0.5);
    result.distribution = Object.fromEntries([10, 25, 50, 75, 90].map((p) => [`p${p}`, sortedQuantile(sortedReturns, p / 100)]));
    result.returnDispersion = deviation(returns);
    result.returnSkewness = result.returnDispersion > 0
      ? mean(returns.map((value) => ((value - result.equalWeightReturn) / result.returnDispersion) ** 3)) : null;
  }
  const largest = capWeighted.toSorted((a, b) => b.prior_market_cap - a.prior_market_cap).slice(0, Math.ceil(capWeighted.length * 0.1));
  result.largestCapCohortCount = largest.length;
  result.largestPositiveDollarShare = largest.length ? ratio(largest.filter((row) => row.return_1d > 0 && finite(row.dollar_volume))
    .reduce((sum, row) => sum + row.dollar_volume, 0), result.upDollar) : null;
  if (!result.volumeObservations) result.upVolume = result.downVolume = null;
  if (!result.dollarVolumeObservations) result.upDollar = result.downDollar = null;
  return result;
}

function popcount(word) {
  word -= (word >>> 1) & 0x55555555;
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
  return (((word + (word >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// A dated stock occupies one bit per comparable/qualifying metric. Multiple
// universe memberships reduce the same stock observations without retesting them.
export function createBreadthFrame(capacity) {
  const words = Math.ceil(capacity / 32);
  const metrics = stockBreadth.map(({ key, test }) => ({ key, test, compared: new Uint32Array(words), matched: new Uint32Array(words) }));
  const ordinals = new WeakMap();
  let size = 0;
  return function count(traded, baseFor) {
    const membership = new Uint32Array(words);
    for (const row of traded) {
      const base = baseFor(row);
      let ordinal = ordinals.get(base);
      if (ordinal == null) {
        ordinal = size++;
        if (ordinal >= capacity) throw new RangeError('Breadth frame exceeded its dated stock roster');
        ordinals.set(base, ordinal);
        const word = ordinal >>> 5;
        const bit = 1 << (ordinal & 31);
        for (const { test, compared, matched } of metrics) {
          const included = test(base);
          if (included == null) continue;
          compared[word] |= bit;
          if (included) matched[word] |= bit;
        }
      }
      membership[ordinal >>> 5] |= 1 << (ordinal & 31);
    }
    const counts = {};
    const populated = Math.ceil(size / 32);
    for (const { key, compared, matched } of metrics) {
      let numerator = 0;
      let denominator = 0;
      for (let word = 0; word < populated; word++) {
        numerator += popcount(matched[word] & membership[word]);
        denominator += popcount(compared[word] & membership[word]);
      }
      counts[key] = { numerator, denominator, value: denominator ? 100 * numerator / denominator : null };
    }
    return counts;
  };
}

export function calculateBreadth(traded, extraKeys = [], stockCounts = {}) {
  const data = {};
  for (const item of [...entries, ...extraKeys.filter((key) => !definitions.has(key)).map(breadthMetric).filter(Boolean)]) {
    data[item.key] = stockCounts[item.key] ?? binaryMetric(traded, item.test);
  }
  const { advancers, decliners } = data;
  const denominator = advancers.denominator;
  const numerator = advancers.numerator - decliners.numerator;
  data.adSpread = { numerator, denominator, value: denominator ? 100 * numerator / denominator : null };
  data.adRatio = { numerator: advancers.numerator, denominator: decliners.numerator, value: ratio(advancers.numerator, decliners.numerator),
    state: decliners.numerator ? 'available' : advancers.numerator ? 'infinity' : 'unavailable' };
  return data;
}

export function projectBreadth(base, traded, extraKeys, { regrouped = false, reranked = false } = {}) {
  const data = {};
  for (const item of entries) {
    const recompute = regrouped && item.key === 'outperform_industry' || reranked && item.key === 'top_decile';
    data[item.key] = recompute ? binaryMetric(traded, item.test) : base[item.key];
  }
  for (const key of extraKeys) data[key] = base[key] ?? binaryMetric(traded, breadthMetric(key).test);
  data.adSpread = base.adSpread;
  data.adRatio = base.adRatio;
  return data;
}

function currentThemeMembership(theme, asOf) {
  return (theme.definition.members || []).filter((item) => typeof item !== 'string'
    && (!item.effectiveFrom || item.effectiveFrom <= asOf) && (!item.effectiveTo || item.effectiveTo >= asOf)
    && (!item.knownAt || item.knownAt <= asOf));
}

export function createGroupFrame(traded, themes, date) {
  const byGroup = new Map();
  function addToGroup(level, name, position, parent = null, themeId = null) {
    if (!name) return null;
    const id = `${level}:${themeId || `${parent ? `${parent}/` : ''}${name}`}`;
    if (!byGroup.has(id)) byGroup.set(id, { id, level, name, parent, positions: [] });
    byGroup.get(id).positions.push(position);
    return id;
  }
  const byId = new Map(traded.map((row, position) => [row.securityId, position]));
  const memberships = traded.map((row, position) => {
    const sector = addToGroup('sector', row.sector, position);
    const industry = addToGroup('industry', row.industry, position, sector);
    return [sector, industry, addToGroup('subindustry', row.subindustry, position, industry)];
  });
  for (const theme of themes) {
    const unique = new Set(currentThemeMembership(theme, date).map((member) => member.securityId));
    for (const id of unique) {
      const position = byId.get(id);
      if (position != null) addToGroup('theme', theme.name, position, null, theme.id);
    }
  }
  const groups = [...byGroup.values()].map(({ positions, ...group }) => {
    const members = positions.map((position) => traded[position]);
    return {
      group, positions, memberIds: members.map((row) => row.securityId),
      equalWeight: mean(members.map((row) => row.return_21d).filter(finite)),
      volumes: aggregateRows(members, { distribution: false }),
      above50: binaryMetric(members, truth('above_50d')), above200: binaryMetric(members, truth('above_200d')),
      positiveMomentum: binaryMetric(members, compare('return_21d', (value) => value > 0)).value,
      newHighBreadth: binaryMetric(members, truth('new_high_252d')).value,
      marketCap: members.some((row) => row.market_cap > 0) ? members.reduce((sum, row) => sum + (row.market_cap || 0), 0) : null,
    };
  });
  return { memberships, groups };
}

export function calculateGroups(traded, themes, date, benchmarkReturn, scope = createGroupFrame(traded, themes, date)) {
  const groups = scope.groups.map(({ group, positions, memberIds, equalWeight, volumes, above50, above200,
    positiveMomentum, newHighBreadth, marketCap }) => {
    const ranked = [];
    let topDecileCount = 0;
    let emergingLeaderCount = 0;
    let emergingObservations = 0;
    let first = -Infinity, second = -Infinity, third = -Infinity;
    for (const position of positions) {
      const row = traded[position];
      const percentile = row.rsPercentile;
      if (!finite(percentile)) continue;
      ranked.push(percentile);
      if (percentile >= 90) topDecileCount++;
      if (percentile > first) { third = second; second = first; first = percentile; }
      else if (percentile > second) { third = second; second = percentile; }
      else if (percentile > third) third = percentile;
      if (finite(row.return_21d) && finite(row.return_63d) && finite(row.return_252d) && row.above_50d != null) {
        emergingObservations++;
        if (percentile >= 75 && percentile < 90 && row.above_50d && row.return_21d > 0 && 4 * row.return_63d > row.return_252d) emergingLeaderCount++;
      }
    }
    const topDecile = { numerator: topDecileCount, denominator: ranked.length, value: ranked.length ? 100 * topDecileCount / ranked.length : null };
    return {
      ...group, count: positions.length, memberIds,
      rankedCount: ranked.length, medianRS: quantile(ranked, 0.5), meanRS: mean(ranked),
      equalWeight, dailyReturn: volumes.equalWeightReturn, capWeightedDaily: volumes.capWeightReturn,
      relativeReturn: finite(equalWeight) && finite(benchmarkReturn) ? equalWeight - benchmarkReturn : null,
      topDecile: topDecile.value, above50: above50.value, above200: above200.value,
      positiveMomentum, newHighBreadth,
      upDownDollar: volumes.upDownDollar, upDollar: volumes.upDollar, downDollar: volumes.downDollar,
      leadingConcentration: ratio((finite(first) ? first : 0) + (finite(second) ? second : 0) + (finite(third) ? third : 0),
        ranked.reduce((sum, value) => sum + value, 0)),
      largestPositiveDollarShare: volumes.largestPositiveDollarShare,
      emergingLeaderCount: emergingObservations ? emergingLeaderCount : null,
      emergingLeaderObservations: emergingObservations, marketCap,
      counts: { topDecile, above50, above200 },
    };
  });
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  for (const [position, row] of traded.entries()) {
    const [sectorId, industryId, subindustryId] = scope.memberships[position];
    row.sectorId = sectorId;
    row.industryId = industryId;
    row.subindustryId = subindustryId;
    const industry = groupMap.get(industryId);
    const sector = groupMap.get(sectorId);
    row.industryRS = industry?.medianRS ?? null;
    row.industryBreadth = industry?.above50 ?? null;
    row.industryRelativeRS = finite(row.rsPercentile) && finite(industry?.medianRS) ? row.rsPercentile - industry.medianRS : null;
    row.sectorRelativeRS = finite(row.rsPercentile) && finite(sector?.medianRS) ? row.rsPercentile - sector.medianRS : null;
    row.industryRelativeReturn = finite(row.return_21d) && finite(industry?.equalWeight) ? row.return_21d - industry.equalWeight : null;
    row.sectorRelativeReturn = finite(row.return_21d) && finite(sector?.equalWeight) ? row.return_21d - sector.equalWeight : null;
  }
  for (const level of ['sector', 'industry', 'subindustry', 'theme']) {
    const selected = groups.filter((group) => group.level === level);
    const ranking = rankBy(selected, (group) => group.medianRS, (group) => group.id);
    for (const group of selected) {
      group.rank = ranking.get(group.id)?.rank ?? null;
      group.percentile = ranking.get(group.id)?.percentile ?? null;
      const parent = groupMap.get(group.parent);
      group.parentRelativeRS = finite(group.medianRS) && finite(parent?.medianRS) ? group.medianRS - parent.medianRS : null;
      group.parentRelativeReturn = finite(group.equalWeight) && finite(parent?.equalWeight) ? group.equalWeight - parent.equalWeight : null;
    }
  }
  return groups.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
}

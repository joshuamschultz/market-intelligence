export const DEFAULT_WINDOWS = [1, 5, 10, 20, 21, 42, 50, 63, 100, 126, 150, 200, 252];
export const AVERAGES = [10, 20, 50, 100, 150, 200];
const VOLUME_WINDOWS = [10, 20, 50, 100];
export const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export function quantile(values, portion) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const position = (sorted.length - 1) * portion;
  const index = Math.floor(position);
  return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * (position - index);
}

export function deviation(values) {
  const average = mean(values);
  return average == null ? null : Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export function ratio(left, right) {
  return finite(left) && right > 0 ? left / right : null;
}

export function change(left, right) {
  const value = ratio(left, right);
  return value == null ? null : value - 1;
}

export function splitFactorBetween(actions, start, end) {
  let factor = 1;
  for (const action of actions) {
    if (action.type === 'split' && action.date > start && action.date <= end && action.factor > 0) factor *= action.factor;
  }
  return factor;
}

export function prepareBars(prices, actions, asOf, { provenance = true, overrides = [] } = {}) {
  const splits = actions.filter((action) => action.type === 'split' && action.factor > 0);
  const cashActions = new Map();
  for (const action of actions) {
    if (action.type === 'dividend' && action.date <= asOf && action.amount > 0) {
      cashActions.set(action.date, (cashActions.get(action.date) || 0) + action.amount);
    }
  }
  const bars = [];
  let previous;
  let previousBasis;
  let previousVendorTotal;
  let previousSource;
  for (const bar of prices) {
    const quality = overrides.length ? overrides.filter((row) => row.effective_from <= bar.date && bar.date <= row.effective_to
      && ['price', 'volume', 'adjusted-close'].includes(row.kind)) : [];
    if (quality.some((row) => row.kind === 'price')) {
      bars.push({ date: bar.date, open: null, high: null, low: null, rawClose: null, close: null,
        volume: null, dollarVolume: null, traded: false, priceQuarantined: true, quality });
      previous = null;
      continue;
    }
    const volumeQuarantined = quality.some((row) => row.kind === 'volume');
    const vendorClose = quality.some((row) => row.kind === 'adjusted-close') ? null : bar.adjusted_close;
    const splitFactor = splitFactorBetween(splits, bar.date, asOf);
    const sourceBasis = bar.volume_basis || bar.known_at || asOf;
    const sourceFactor = bar.volume_adjusted ? splitFactorBetween(splits, bar.date, sourceBasis) : 1;
    const rawVolume = volumeQuarantined ? null : bar.volume / sourceFactor;
    const basisAfter = splitFactorBetween(splits, asOf, sourceBasis);
    const priceFactor = bar.split_close > 0 ? (bar.split_close * basisAfter) / bar.close : 1 / splitFactor;
    const item = {
      date: bar.date, rawClose: bar.close, open: bar.open * priceFactor, high: bar.high * priceFactor, low: bar.low * priceFactor,
      close: bar.close * priceFactor, volume: rawVolume == null ? null : rawVolume * splitFactor,
      dollarVolume: rawVolume == null ? null : rawVolume * bar.close, traded: bar.volume > 0, unverifiedSplit: false,
      totalClose: vendorClose > 0 ? vendorClose : bar.close * priceFactor,
      totalGross: null,
    };
    if (quality.length) Object.assign(item, { volumeQuarantined, quality });
    if (provenance) Object.assign(item, { rawVolume, vendorAdjustedClose: bar.adjusted_close,
      knownAt: bar.known_at, ingestedAt: bar.ingested_at, source: bar.source, version: bar.version,
      volumeBasis: volumeQuarantined ? null : bar.volume_adjusted ? sourceBasis : bar.date });
    if (previous) {
      const cash = (cashActions.get(bar.date) || 0) / splitFactor;
      const economic = ratio(item.close + cash, previous.close);
      const sameVintage = sourceBasis === previousBasis && bar.source === previousSource;
      const vendorGross = sameVintage ? ratio(vendorClose, previousVendorTotal) : null;
      const rawReturn = ratio(item.rawClose, previous.rawClose);
      if (rawReturn > 0 && vendorGross > 0 && economic > 0
        && Math.abs(Math.log(rawReturn / vendorGross)) > Math.log(1.4)
        && Math.abs(Math.log(economic / vendorGross)) > Math.log(1.4)) item.unverifiedSplit = true;
      const gross = (!cash || item.unverifiedSplit) && vendorGross > 0 ? vendorGross : economic;
      item.totalGross = gross > 0 ? gross : null;
      if (item.totalGross != null) item.totalClose = previous.totalClose * item.totalGross;
    }
    bars.push(item);
    previous = item;
    previousBasis = sourceBasis;
    previousVendorTotal = vendorClose;
    previousSource = bar.source;
  }
  return bars;
}

export function alignSeries(bars, sessions) {
  const byDate = new Map(bars.map((bar) => [bar.date, bar]));
  return sessions.map((date) => byDate.get(date) || null);
}

function windowBars(series, start, stop, allowUnverifiedSplits = false) {
  if (start < 0 || stop >= series.length || start > stop) return null;
  const bars = series.slice(start, stop + 1);
  return bars.every((bar, index) => bar?.traded && (index === 0 || allowUnverifiedSplits || !bar.unverifiedSplit)) ? bars : null;
}

export function returnWindow(series, start, stop, priceMode = 'split') {
  const bars = windowBars(series, start, stop, priceMode === 'total');
  if (!bars) return null;
  if (priceMode === 'total') {
    let gross = 1;
    for (let index = 1; index < bars.length; index++) {
      const value = Object.hasOwn(bars[index], 'totalGross') ? bars[index].totalGross : ratio(bars[index].totalClose, bars[index - 1].totalClose);
      if (!(value > 0)) return null;
      gross *= value;
    }
    return finite(gross) ? gross - 1 : null;
  }
  return change(bars.at(-1).close, bars[0].close);
}

function movingAverage(bars) {
  return bars?.length ? mean(bars.map((bar) => bar.close)) : null;
}

function emaFromCloses(continuous, lookback) {
  if (continuous.length < lookback) return { value: null, prior: null, seedDate: null, observations: continuous.length };
  const alpha = 2 / (lookback + 1);
  let value = movingAverage(continuous.slice(0, lookback));
  const priorIndex = continuous.length - 6;
  let prior = priorIndex === lookback - 1 ? value : null;
  for (let index = lookback; index < continuous.length; index++) {
    value = alpha * continuous[index].close + (1 - alpha) * value;
    if (index === priorIndex) prior = value;
  }
  return { value, prior, seedDate: continuous[lookback - 1].date, observations: continuous.length };
}

function continuousSuffix(series) {
  let first = series.length;
  while (first > 0 && series[first - 1]?.traded) {
    first--;
    if (series[first].unverifiedSplit) break;
  }
  return series.slice(first);
}

export function volumeRatio(series, last, lookback) {
  const bars = windowBars(series, last - lookback, last);
  if (!bars) return { value: null, state: 'insufficient', up: null, down: null, upPercent: null, observations: series.slice(Math.max(1, last - lookback + 1), last + 1).filter((bar, index) => bar?.traded && series[Math.max(1, last - lookback + 1) + index - 1]?.traded && !bar.unverifiedSplit).length };
  let up = 0;
  let down = 0;
  if (bars.slice(1).some((bar) => !finite(bar.volume))) return { value: null, state: 'insufficient',
    up: null, down: null, upPercent: null, observations: bars.slice(1).filter((bar) => finite(bar.volume)).length };
  for (let index = 1; index < bars.length; index++) {
    const direction = Math.sign(bars[index].close - bars[index - 1].close);
    if (direction > 0) up += bars[index].volume;
    if (direction < 0) down += bars[index].volume;
  }
  const value = ratio(up, down);
  const state = value != null ? 'available' : up > 0 ? 'infinity' : 'unchanged';
  return { value, state, up, down, upPercent: ratio(up, up + down), observations: lookback };
}

function technicalExtremes(bars, last, size) {
  const window = windowBars(bars, last - size + 1, last);
  const prior = windowBars(bars, last - size, last - 1);
  if (!window) return { high: null, low: null, newHigh: null, newLow: null };
  const high = Math.max(...window.map((bar) => bar.high));
  const low = Math.min(...window.map((bar) => bar.low));
  return {
    high, low,
    newHigh: prior ? window.at(-1).high > Math.max(...prior.map((bar) => bar.high)) : null,
    newLow: prior ? window.at(-1).low < Math.min(...prior.map((bar) => bar.low)) : null,
  };
}

function atrPercentage(series, index) {
  const bars = windowBars(series, index - 14, index);
  if (!bars) return null;
  let total = 0;
  for (let offset = 1; offset < bars.length; offset++) {
    const { high, low } = bars[offset];
    const previous = bars[offset - 1].close;
    total += Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
  }
  return ratio(total / 14, bars.at(-1).close);
}

function consolidationDuration(series, index) {
  // Report the number of trailing sessions contained in a 10% range, up to one quarter.
  let high = 0;
  let low = Infinity;
  for (let count = 0; count < 63; count++) {
    const bar = series[index - count];
    if (!bar?.traded) return null;
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    if (high / low > 1.1 + 1e-12) return count;
    if (bar.unverifiedSplit && count < 62) return null;
  }
  return 63;
}

function highVolumeCounts(series, index, row) {
  const bars = windowBars(series, index - 39, index);
  const complete = bars?.every((bar) => finite(bar.volume));
  let up = 0;
  let down = 0;
  let up2x = 0;
  let down2x = 0;
  if (complete) {
    let total = bars.slice(0, 20).reduce((sum, bar) => sum + bar.volume, 0);
    for (let step = 20; step < bars.length; step++) {
      const current = bars[step];
      const direction = Math.sign(current.close - bars[step - 1].close);
      const baseline = total / 20;
      if (baseline > 0 && current.volume >= 1.5 * baseline) {
        if (direction > 0) {
          up++;
          if (current.volume >= 2 * baseline) up2x++;
        } else if (direction < 0) {
          down++;
          if (current.volume >= 2 * baseline) down2x++;
        }
      }
      total += current.volume - bars[step - 20].volume;
    }
  }
  row.high_volume_up_20d = complete ? up : null;
  row.high_volume_down_20d = complete ? down : null;
  row.accumulation_20d = complete ? up - down : null;
  row.high_volume_up_2x_20d = complete ? up2x : null;
  row.high_volume_down_2x_20d = complete ? down2x : null;
  row.accumulation_2x_20d = complete ? up2x - down2x : null;
}

function priceVolumeFeatures(series, index, row, volumeWindows) {
  let obv = 0;
  let gap = 0;
  let streak = 0;
  let obvComplete = true;
  let prev;
  const recent = series;
  const obvSeries = [];
  for (const bar of recent) {
    if (!bar?.traded || bar.unverifiedSplit) {
      obvSeries.push(null);
      prev = null;
      streak = 0;
      continue;
    }
    const direction = prev ? Math.sign(bar.close - prev.close) : 0;
    const observedVolume = finite(bar.volume);
    if (observedVolume) obv += direction * bar.volume;
    else if (direction) obvComplete = false;
    obvSeries.push(observedVolume ? obv : null);
    streak = direction === 0 ? 0 : Math.sign(streak) === direction ? streak + direction : direction;
    gap = prev ? change(bar.open, prev.close) : null;
    prev = bar;
  }
  row.obv = row.traded && obvComplete && finite(series[index]?.volume) ? obv : null;
  row.obv_start = recent.find((bar) => bar?.traded)?.date ?? null;
  for (const n of new Set([20, ...volumeWindows])) {
    const comparable = row.traded && obvSeries.length > n && obvSeries.slice(-n - 1).every(finite);
    row[`obv_slope_${n}d`] = comparable ? obv - obvSeries.at(-n - 1) : null;
  }
  row.obv_slope = row.obv_slope_20d;
  row.streak = row.traded ? streak : null;
  row.gap = row.traded ? gap : null;
  row.gap_up = finite(gap) ? gap > 0.02 : null;
  row.gap_down = finite(gap) ? gap < -0.02 : null;
  const data = windowBars(series, index - 20, index);
  row.atr_14d = atrPercentage(series, index);
  row.atr_contraction = change(row.atr_14d, atrPercentage(series, index - 14));
  row.cmf_20d = null;
  row.mfi_14d = null;
  row.clv = row.traded && prev ? (prev.high === prev.low ? 0 : (2 * prev.close - prev.high - prev.low) / (prev.high - prev.low)) : null;
  row.up_frequency_20d = null;
  highVolumeCounts(series, index, row);
  if (!data) return;
  const flows = { positive: 0, negative: 0, moneyFlow: 0, up: 0, volume: 0 };
  for (let step = 1; step < data.length; step++) {
    const current = data[step];
    const previous = data[step - 1];
    const typical = (current.high + current.low + current.close) / 3;
    const lastTypical = (previous.high + previous.low + previous.close) / 3;
    if (step > data.length - 15) {
      if (typical > lastTypical) flows.positive += typical * current.volume;
      if (typical < lastTypical) flows.negative += typical * current.volume;
    }
    if (current.close > previous.close) flows.up++;
    if (current.high !== current.low) flows.moneyFlow += current.volume * ((2 * current.close - current.high - current.low) / (current.high - current.low));
    flows.volume += current.volume;
  }
  row.cmf_20d = data.slice(1).every((bar) => finite(bar.volume)) ? ratio(flows.moneyFlow, flows.volume) : null;
  row.mfi_14d = data.slice(-14).every((bar) => finite(bar.volume)) ? 100 * (ratio(flows.positive, flows.positive + flows.negative) ?? 0.5) : null;
  row.up_frequency_20d = flows.up / 20;
}

export function stockMetrics(identity, series, { averages = AVERAGES, windows = DEFAULT_WINDOWS, volumeWindows = VOLUME_WINDOWS, benchmarkSeries = [], allTimeHigh = null } = {}) {
  const index = series.length - 1;
  const bar = series[index];
  const row = {
    ...identity,
    traded: !!bar?.traded,
    close: bar?.close ?? null, raw_close: bar?.rawClose ?? null, volume: bar?.volume ?? null,
    dollar_volume: bar?.dollarVolume ?? null, rejected_split: !!bar?.unverifiedSplit,
    ...(bar?.quality ? { quality: bar.quality } : {}),
    market_cap: Object.hasOwn(identity, 'calculatedMarketCap') ? identity.calculatedMarketCap
      : identity.marketCap ?? (bar?.rawClose != null && identity.shares > 0 ? bar.rawClose * identity.shares : null),
    prior_market_cap: identity.priorMarketCap ?? null,
  };
  const continuous = continuousSuffix(series);
  for (const n of windows) row[`return_${n}d`] = returnWindow(series, index - n, index);
  for (const n of averages) {
    const current = windowBars(series, index - n + 1, index);
    const previous = windowBars(series, index - n - 4, index - 5);
    const sma = movingAverage(current);
    row[`sma_${n}d`] = sma;
    const ema = emaFromCloses(continuous, n);
    row[`ema_${n}d`] = ema.value;
    row[`ema_seed_${n}d`] = ema.seedDate;
    row[`ema_observations_${n}d`] = ema.observations;
    row[`vs_ema_${n}d`] = change(row.close, ema.value);
    row[`slope_ema_${n}d`] = change(ema.value, ema.prior);
    row[`vs_sma_${n}d`] = change(row.close, sma);
    row[`above_${n}d`] = sma == null ? null : row.close > sma;
    row[`slope_sma_${n}d`] = change(sma, movingAverage(previous));
  }
  for (const n of new Set([10, 20, 50, 100, ...volumeWindows])) {
    const volumeBars = windowBars(series, index - n + 1, index);
    const priorBars = windowBars(series, index - n, index - 1);
    const bars = volumeBars?.every((item) => finite(item.volume) && finite(item.dollarVolume)) ? volumeBars : null;
    const priorVolume = priorBars?.every((item) => finite(item.volume)) ? priorBars : null;
    const ud = volumeRatio(series, index, n);
    row[`avg_volume_${n}d`] = bars ? mean(bars.map((item) => item.volume)) : null;
    row[`adv_${n}d`] = bars ? mean(bars.map((item) => item.dollarVolume)) : null;
    row[`rvol_${n}d`] = priorVolume ? ratio(row.volume, mean(priorVolume.map((item) => item.volume))) : null;
    row[`udv_${n}d`] = ud.value;
    row[`udv_state_${n}d`] = ud.state;
    row[`udv_obs_${n}d`] = ud.observations;
    row[`up_volume_${n}d`] = ud.upPercent;
    row[`float_turnover_${n}d`] = bars && bars.every((b) => b.float > 0) ? bars.reduce((sum, item) => sum + item.volume / item.float, 0) : null;
  }
  const tradeFloat = identity.floatDate && identity.floatDate > bar?.date ? null : identity.float;
  row.float_turnover_1d = ratio(row.volume, bar?.float ?? tradeFloat);
  row.volume_trend = change(row.avg_volume_20d, row.avg_volume_50d);
  row.volume_contraction = change(row.avg_volume_10d, row.avg_volume_50d);
  row.breakout_volume = row.rvol_20d;
  for (const n of [20, 50, 100, 252]) {
    const extremes = technicalExtremes(series, index, n);
    row[`new_high_${n}d`] = extremes.newHigh;
    row[`new_low_${n}d`] = extremes.newLow;
    if (n === 252) {
      row.high_252d = extremes.high;
      row.low_252d = extremes.low;
      row.distance_high_252d = change(row.close, extremes.high);
      row.distance_low_252d = change(row.close, extremes.low);
    }
  }
  row.distance_all_time_high = change(row.close, allTimeHigh);
  row.drawdown = row.distance_high_252d;
  row.ma_aligned = row.sma_200d == null ? null : row.sma_20d > row.sma_50d && row.sma_50d > row.sma_200d;
  row.ma_50_above_200 = row.sma_200d == null ? null : row.sma_50d > row.sma_200d;
  row.ma_rising_50 = row.slope_sma_50d == null ? null : row.slope_sma_50d > 0;
  row.ma_rising_200 = row.slope_sma_200d == null ? null : row.slope_sma_200d > 0;
  row.market_cap_change = change(row.market_cap, identity.priorMarketCap21d);
  row.relative_strength_line = ratio(row.close, benchmarkSeries.at(-1)?.close);
  const rel = series.slice(-21).map((item, offset) => ratio(item?.close, benchmarkSeries.at(-21 + offset)?.close));
  row.rs_line_new_high = rel.length === 21 && rel.every(finite) ? rel.at(-1) > Math.max(...rel.slice(0, -1)) : null;
  row.relative_return_21d = finite(row.return_21d)
    ? row.return_21d - (returnWindow(benchmarkSeries, index - 21, index) ?? Number.NaN) : null;
  if (!finite(row.relative_return_21d)) row.relative_return_21d = null;
  const daily = windowBars(series, index - 20, index);
  row.volatility_20d = daily ? deviation(daily.slice(1).map((item, step) => change(item.close, daily[step].close))) * Math.sqrt(252) : null;
  const prior = windowBars(series, index - 40, index - 20);
  const priorVolatility = prior ? deviation(prior.slice(1).map((item, step) => change(item.close, prior[step].close))) * Math.sqrt(252) : null;
  row.volatility_compression = change(row.volatility_20d, priorVolatility);
  row.consolidation_range_20d = daily ? change(Math.max(...daily.slice(1).map((item) => item.high)), Math.min(...daily.slice(1).map((item) => item.low))) : null;
  row.consolidation_duration = consolidationDuration(series, index);
  priceVolumeFeatures(series, index, row, volumeWindows);
  return row;
}

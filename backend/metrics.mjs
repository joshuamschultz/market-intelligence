export const DEFAULT_WINDOWS = [1, 5, 10, 20, 21, 42, 50, 63, 100, 126, 150, 200, 252];
export const AVERAGES = [10, 20, 50, 100, 150, 200];
const VOLUME_WINDOWS = [10, 20, 50, 100];
export const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export function sortedQuantile(sorted, portion) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * portion;
  const index = Math.floor(position);
  return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * (position - index);
}

export function quantile(values, portion) {
  return sortedQuantile(values.toSorted((a, b) => a - b), portion);
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

const seriesViews = new WeakMap();
const prefixRange = (values, start, end) => values[end + 1] - values[start];

const readClose = (bar) => bar.close;
const readVolume = (bar) => bar.volume;
const readDollars = (bar) => bar.dollarVolume;
const readTurnover = (bar) => bar.volume / bar.float;
const readUpVolume = (bar, previous) => bar.close > previous.close ? bar.volume : 0;
const readDownVolume = (bar, previous) => bar.close < previous.close ? bar.volume : 0;

function indexedSum(index, key, start, end, read, meanWindow = false) {
  const values = index[key];
  const sum = prefixRange(values, start, end);
  const scale = Math.max(Math.abs(values[start]), Math.abs(values[end + 1]));
  if (index.integralVolume && (key === 'volume' || key === 'upVolume' || key === 'downVolume')
    && scale <= Number.MAX_SAFE_INTEGER) return sum;
  // A penny-price suffix can follow a much larger historical quote after a basis break.
  // In that case summing only the requested window avoids subtracting rounded large totals.
  const floor = meanWindow ? end - start + 1 : 1;
  if (Number.isFinite(sum) && scale * Number.EPSILON * (end + 1) <= 1e-11 * Math.max(floor, Math.abs(sum))) return sum;
  let exact = 0;
  for (let indexAt = start; indexAt <= end; indexAt++) exact += read(index.bars[indexAt], index.bars[indexAt - 1]);
  return exact;
}

export function indexPriceSeries(bars) {
  const size = bars.length;
  const lastMissing = new Int32Array(size);
  const lastSplit = new Int32Array(size);
  const validVolumes = new Int32Array(size + 1);
  const validDollars = new Int32Array(size + 1);
  const validFloats = new Int32Array(size + 1);
  const validEdges = new Int32Array(size + 1);
  const obvObserved = new Int32Array(size + 1);
  const obvMissing = new Int32Array(size + 1);
  const obv = new Float64Array(size + 1);
  const streak = new Int32Array(size);
  const lastValid = new Int32Array(size);
  const nextTraded = new Int32Array(size);
  const close = new Float64Array(size + 1);
  const volume = new Float64Array(size + 1);
  const dollars = new Float64Array(size + 1);
  const turnover = new Float64Array(size + 1);
  const upVolume = new Float64Array(size + 1);
  const downVolume = new Float64Array(size + 1);
  let missing = -1;
  let split = -1;
  let last = -1;
  let integralVolume = true;
  for (let index = 0; index < size; index++) {
    const bar = bars[index];
    const prior = bars[index - 1];
    if (!bar?.traded) missing = index;
    if (bar?.unverifiedSplit) split = index;
    lastMissing[index] = missing;
    lastSplit[index] = split;
    const volumeValid = finite(bar?.volume);
    if (volumeValid && !Number.isInteger(bar.volume)) integralVolume = false;
    const dollarValid = finite(bar?.dollarVolume);
    const floatValid = bar?.float > 0;
    const edgeValid = bar?.traded && prior?.traded && !bar.unverifiedSplit;
    const direction = edgeValid ? Math.sign(bar.close - prior.close) : 0;
    const valid = bar?.traded && !bar.unverifiedSplit;
    const obvDirection = valid && direction && !prior.unverifiedSplit ? direction : 0;
    if (valid) last = index;
    lastValid[index] = last;
    obvObserved[index + 1] = obvObserved[index] + Number(!!valid && volumeValid);
    obvMissing[index + 1] = obvMissing[index] + Number(!!obvDirection && !volumeValid);
    obv[index + 1] = obv[index] + (volumeValid ? obvDirection * bar.volume : 0);
    const precedingStreak = streak[index - 1] || 0;
    streak[index] = Math.sign(precedingStreak) === obvDirection ? precedingStreak + obvDirection : obvDirection;
    validVolumes[index + 1] = validVolumes[index] + Number(volumeValid);
    validDollars[index + 1] = validDollars[index] + Number(dollarValid);
    validFloats[index + 1] = validFloats[index] + Number(floatValid);
    validEdges[index + 1] = validEdges[index] + Number(!!edgeValid);
    close[index + 1] = close[index] + (finite(bar?.close) ? bar.close : 0);
    volume[index + 1] = volume[index] + (volumeValid ? bar.volume : 0);
    dollars[index + 1] = dollars[index] + (dollarValid ? bar.dollarVolume : 0);
    turnover[index + 1] = turnover[index] + (floatValid && volumeValid ? bar.volume / bar.float : 0);
    upVolume[index + 1] = upVolume[index] + (volumeValid && direction > 0 ? bar.volume : 0);
    downVolume[index + 1] = downVolume[index] + (volumeValid && direction < 0 ? bar.volume : 0);
  }
  let next = size;
  for (let index = size - 1; index >= 0; index--) {
    if (bars[index]?.traded) next = index;
    nextTraded[index] = next;
  }
  return { bars, lastMissing, lastSplit, validVolumes, validDollars, validFloats, validEdges,
    close, volume, dollars, turnover, upVolume, downVolume, integralVolume,
    obv, obvObserved, obvMissing, streak, lastValid, nextTraded, ema: new Map() };
}

export function sharePriceIndex(view, index, offset) {
  seriesViews.set(view, { index, offset });
  return view;
}

function comparableWindow(series, start, stop, allowUnverifiedSplits = false) {
  if (start < 0 || stop >= series.length || start > stop) return false;
  const prepared = seriesViews.get(series);
  if (prepared) {
    const { index, offset } = prepared;
    return index.lastMissing[stop + offset] < start + offset
      && (allowUnverifiedSplits || index.lastSplit[stop + offset] <= start + offset);
  }
  for (let position = start; position <= stop; position++) {
    const bar = series[position];
    if (!bar?.traded || position !== start && !allowUnverifiedSplits && bar.unverifiedSplit) return false;
  }
  return true;
}

function windowBars(series, start, stop, allowUnverifiedSplits = false) {
  return comparableWindow(series, start, stop, allowUnverifiedSplits) ? series.slice(start, stop + 1) : null;
}

export function returnWindow(series, start, stop, priceMode = 'split') {
  if (!comparableWindow(series, start, stop, priceMode === 'total')) return null;
  if (priceMode === 'total') {
    let gross = 1;
    for (let index = start + 1; index <= stop; index++) {
      const value = Object.hasOwn(series[index], 'totalGross') ? series[index].totalGross : ratio(series[index].totalClose, series[index - 1].totalClose);
      if (!(value > 0)) return null;
      gross *= value;
    }
    return finite(gross) ? gross - 1 : null;
  }
  return change(series[stop].close, series[start].close);
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

function indexedEma(series, prepared, lookback) {
  const { index, offset } = prepared;
  const end = offset + series.length - 1;
  const start = Math.max(offset, index.lastMissing[end] + 1, index.lastSplit[end]);
  const seed = start + lookback - 1;
  const observations = end - start + 1;
  if (seed > end) return { value: null, prior: null, seedDate: null, observations };
  let base = index.ema.get(lookback);
  const alpha = 2 / (lookback + 1);
  const decay = 1 - alpha;
  if (!base) {
    base = new Float64Array(index.bars.length);
    base.fill(NaN);
    let value = NaN;
    for (let position = 0; position < base.length; position++) {
      const beginning = Math.max(index.lastMissing[position] + 1, index.lastSplit[position]);
      const length = position - beginning + 1;
      if (length < lookback) value = NaN;
      else {
        value = length === lookback ? indexedSum(index, 'close', beginning, position, readClose, true) / lookback
          : alpha * index.bars[position].close + decay * value;
        base[position] = value;
      }
    }
    index.ema.set(lookback, base);
  }
  // Match the SMA seed of the requested finite suffix, even when the cache begins earlier.
  const correction = indexedSum(index, 'close', start, seed, readClose, true) / lookback - base[seed];
  let unstable = false;
  const at = (position) => {
    if (position < seed) return null;
    const adjustment = correction * decay ** (position - seed);
    const value = base[position] + adjustment;
    if (!finite(value) || Math.abs(base[position]) + Math.abs(adjustment) > 4096 * Math.max(1, Math.abs(value))) unstable = true;
    return value;
  };
  const value = at(end);
  const prior = at(end - 5);
  if (unstable) return emaFromCloses(series.slice(start - offset), lookback);
  return { value, prior, seedDate: index.bars[seed].date, observations };
}

function windowAverage(series, start, end, indexed) {
  if (!comparableWindow(series, start, end)) return null;
  if (indexed) return indexedSum(indexed.index, 'close', start + indexed.offset, end + indexed.offset, readClose, true) / (end - start + 1);
  let total = 0;
  for (let index = start; index <= end; index++) total += series[index].close;
  return total / (end - start + 1);
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
  const prepared = seriesViews.get(series);
  if (prepared && last >= 0 && last < series.length) {
    const { index, offset } = prepared;
    const end = last + offset;
    const first = Math.max(1, last - lookback + 1) + offset;
    if (!comparableWindow(series, last - lookback, last)) return { value: null, state: 'insufficient',
      up: null, down: null, upPercent: null, observations: prefixRange(index.validEdges, first, end) };
    const observations = prefixRange(index.validVolumes, first, end);
    if (observations !== lookback) return { value: null, state: 'insufficient', up: null, down: null, upPercent: null, observations };
    let up = indexedSum(index, 'upVolume', first, end, readUpVolume);
    let down = indexedSum(index, 'downVolume', first, end, readDownVolume);
    let value = ratio(up, down);
    if (!index.integralVolume && value != null && (Math.abs(value - 1) < 1e-10
      || Math.abs(value - 1.2) < 1e-10 || Math.abs(value - 1.5) < 1e-10)) {
      up = 0;
      down = 0;
      for (let position = first; position <= end; position++) {
        up += readUpVolume(index.bars[position], index.bars[position - 1]);
        down += readDownVolume(index.bars[position], index.bars[position - 1]);
      }
      value = ratio(up, down);
    }
    return { value, state: value != null ? 'available' : up > 0 ? 'infinity' : 'unchanged', up, down, upPercent: ratio(up, up + down), observations };
  }
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
  const start = last - size + 1;
  if (!comparableWindow(bars, start, last)) return { high: null, low: null, newHigh: null, newLow: null };
  const prior = comparableWindow(bars, start - 1, last - 1);
  let high = -Infinity;
  let low = Infinity;
  for (let index = start; index < last; index++) {
    high = Math.max(high, bars[index].high);
    low = Math.min(low, bars[index].low);
  }
  const today = bars[last];
  return {
    high: Math.max(high, today.high), low: Math.min(low, today.low),
    newHigh: prior ? today.high > Math.max(high, bars[start - 1].high) : null,
    newLow: prior ? today.low < Math.min(low, bars[start - 1].low) : null,
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

function averageVolatility(bars) {
  return bars ? deviation(bars.slice(1).map((item, step) => change(item.close, bars[step].close))) * Math.sqrt(252) : null;
}

export function detailRiskInputs(series) {
  const end = series.length - 1;
  return { volatility_20d: averageVolatility(windowBars(series, end - 20, end)), atr_14d: atrPercentage(series, end) };
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

function indexedPriceVolume(series, position, row, volumeWindows, { index, offset }) {
  const end = position + offset;
  const last = index.lastValid[end];
  const previous = series[position];
  const gap = last < offset ? 0 : last > offset && index.lastValid[last - 1] === last - 1
    ? change(index.bars[last].open, index.bars[last - 1].close) : null;
  // The first bar of a finite view has no predecessor in its OBV path.
  const obv = prefixRange(index.obv, offset + 1, end);
  const complete = prefixRange(index.obvMissing, offset + 1, end) === 0;
  row.obv = row.traded && complete && finite(previous?.volume) ? obv : null;
  const start = index.nextTraded[offset];
  row.obv_start = start <= end ? index.bars[start].date : null;
  for (const n of new Set([20, ...volumeWindows])) {
    const comparable = row.traded && position >= n && prefixRange(index.obvObserved, end - n, end) === n + 1;
    row[`obv_slope_${n}d`] = comparable ? prefixRange(index.obv, end - n + 1, end) : null;
  }
  row.obv_slope = row.obv_slope_20d;
  const streak = index.streak[end];
  row.streak = row.traded ? Math.sign(streak) * Math.min(Math.abs(streak), position) || 0 : null;
  return { gap, previous: last === end ? previous : null };
}

function priceVolumeFeatures(series, index, row, volumeWindows) {
  let gap = 0;
  let prev;
  const prepared = seriesViews.get(series);
  if (prepared) {
    ({ gap, previous: prev } = indexedPriceVolume(series, index, row, volumeWindows, prepared));
  } else {
    let obv = 0;
    let streak = 0;
    let obvComplete = true;
    const obvSeries = [];
    for (const bar of series) {
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
    row.obv_start = series.find((bar) => bar?.traded)?.date ?? null;
    for (const n of new Set([20, ...volumeWindows])) {
      const comparable = row.traded && obvSeries.length > n && obvSeries.slice(-n - 1).every(finite);
      row[`obv_slope_${n}d`] = comparable ? obv - obvSeries.at(-n - 1) : null;
    }
    row.obv_slope = row.obv_slope_20d;
    row.streak = row.traded ? streak : null;
  }
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

export function stockTechnicals(series, { averages = AVERAGES, windows = DEFAULT_WINDOWS, volumeWindows = VOLUME_WINDOWS, benchmarkSeries = [] } = {}, row = {}) {
  const index = series.length - 1;
  const bar = series[index];
  Object.assign(row, {
    traded: !!bar?.traded,
    close: bar?.close ?? null, raw_close: bar?.rawClose ?? null, volume: bar?.volume ?? null,
    dollar_volume: bar?.dollarVolume ?? null, rejected_split: !!bar?.unverifiedSplit,
    ...(bar?.quality ? { quality: bar.quality } : {}),
    market_cap: null, prior_market_cap: null,
  });
  const indexed = seriesViews.get(series);
  const continuous = indexed ? null : continuousSuffix(series);
  for (const n of windows) row[`return_${n}d`] = returnWindow(series, index - n, index);
  for (const n of averages) {
    const start = index - n + 1;
    let sma = windowAverage(series, start, index, indexed);
    let prior = windowAverage(series, start - 5, index - 5, indexed);
    // Preserve strict comparison decisions where prefix-sum roundoff could change a tie.
    if (indexed && sma != null && (Math.abs(row.close - sma) <= Math.abs(sma) * 1e-10
      || prior != null && Math.abs(sma - prior) <= Math.abs(sma) * 1e-10)) {
      sma = windowAverage(series, start, index, null);
      prior = windowAverage(series, start - 5, index - 5, null);
    }
    row[`sma_${n}d`] = sma;
    const ema = indexed ? indexedEma(series, indexed, n) : emaFromCloses(continuous, n);
    row[`ema_${n}d`] = ema.value;
    row[`ema_seed_${n}d`] = ema.seedDate;
    row[`ema_observations_${n}d`] = ema.observations;
    row[`vs_ema_${n}d`] = change(row.close, ema.value);
    row[`slope_ema_${n}d`] = change(ema.value, ema.prior);
    row[`vs_sma_${n}d`] = change(row.close, sma);
    row[`above_${n}d`] = sma == null ? null : row.close > sma;
    row[`slope_sma_${n}d`] = change(sma, prior);
  }
  for (const n of new Set([10, 20, 50, 100, ...volumeWindows])) {
    const ud = volumeRatio(series, index, n);
    let average, dollar, relative, turnover;
    if (indexed) {
      const { offset, index: sums } = indexed;
      const end = index + offset;
      const start = end - n + 1;
      const valid = comparableWindow(series, index - n + 1, index) && prefixRange(sums.validVolumes, start, end) === n
        && prefixRange(sums.validDollars, start, end) === n;
      const prior = comparableWindow(series, index - n, index - 1) && prefixRange(sums.validVolumes, start - 1, end - 1) === n;
      average = valid ? indexedSum(sums, 'volume', start, end, readVolume, true) / n : null;
      dollar = valid ? indexedSum(sums, 'dollars', start, end, readDollars, true) / n : null;
      relative = prior ? ratio(row.volume, indexedSum(sums, 'volume', start - 1, end - 1, readVolume, true) / n) : null;
      if (relative != null && (Math.abs(relative - 1.5) < 1e-10 || Math.abs(relative - 2) < 1e-10)) {
        relative = ratio(row.volume, mean(series.slice(index - n, index).map((item) => item.volume)));
      }
      turnover = valid && prefixRange(sums.validFloats, start, end) === n
        ? indexedSum(sums, 'turnover', start, end, readTurnover) : null;
    } else {
      const volumeBars = windowBars(series, index - n + 1, index);
      const priorBars = windowBars(series, index - n, index - 1);
      const bars = volumeBars?.every((item) => finite(item.volume) && finite(item.dollarVolume)) ? volumeBars : null;
      const priorVolume = priorBars?.every((item) => finite(item.volume)) ? priorBars : null;
      average = bars ? mean(bars.map((item) => item.volume)) : null;
      dollar = bars ? mean(bars.map((item) => item.dollarVolume)) : null;
      relative = priorVolume ? ratio(row.volume, mean(priorVolume.map((item) => item.volume))) : null;
      turnover = bars && bars.every((b) => b.float > 0) ? bars.reduce((sum, item) => sum + item.volume / item.float, 0) : null;
    }
    row[`avg_volume_${n}d`] = average;
    row[`adv_${n}d`] = dollar;
    row[`rvol_${n}d`] = relative;
    row[`udv_${n}d`] = ud.value;
    row[`udv_state_${n}d`] = ud.state;
    row[`udv_obs_${n}d`] = ud.observations;
    row[`up_volume_${n}d`] = ud.upPercent;
    row[`float_turnover_${n}d`] = turnover;
  }
  row.float_turnover_1d = null;
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
  row.distance_all_time_high = null;
  row.drawdown = row.distance_high_252d;
  const above = (first, second) => {
    const a = row[`sma_${first}d`];
    const b = row[`sma_${second}d`];
    return indexed && a != null && b != null && Math.abs(a - b) <= Math.abs(b) * 1e-10
      ? windowAverage(series, index - first + 1, index, null) > windowAverage(series, index - second + 1, index, null)
      : a > b;
  };
  row.ma_aligned = row.sma_200d == null ? null : above(20, 50) && above(50, 200);
  row.ma_50_above_200 = row.sma_200d == null ? null : above(50, 200);
  row.ma_rising_50 = row.slope_sma_50d == null ? null : row.slope_sma_50d > 0;
  row.ma_rising_200 = row.slope_sma_200d == null ? null : row.slope_sma_200d > 0;
  row.market_cap_change = null;
  row.relative_strength_line = ratio(row.close, benchmarkSeries.at(-1)?.close);
  const rel = series.slice(-21).map((item, offset) => ratio(item?.close, benchmarkSeries.at(-21 + offset)?.close));
  row.rs_line_new_high = rel.length === 21 && rel.every(finite) ? rel.at(-1) > Math.max(...rel.slice(0, -1)) : null;
  row.relative_return_21d = finite(row.return_21d)
    ? row.return_21d - (returnWindow(benchmarkSeries, index - 21, index) ?? Number.NaN) : null;
  if (!finite(row.relative_return_21d)) row.relative_return_21d = null;
  const daily = windowBars(series, index - 20, index);
  row.volatility_20d = averageVolatility(daily);
  const prior = windowBars(series, index - 40, index - 20);
  const priorVolatility = averageVolatility(prior);
  row.volatility_compression = change(row.volatility_20d, priorVolatility);
  row.consolidation_range_20d = daily ? change(Math.max(...daily.slice(1).map((item) => item.high)), Math.min(...daily.slice(1).map((item) => item.low))) : null;
  row.consolidation_duration = consolidationDuration(series, index);
  priceVolumeFeatures(series, index, row, volumeWindows);
  return row;
}

export function stockMetrics(identity, series, options = {}) {
  const { technicals, allTimeHigh = null, sparseRows } = options;
  const bar = series.at(-1);
  const row = !technicals ? stockTechnicals(series, options, { ...identity })
    : sparseRows ? Object.assign(Object.create(technicals), identity) : { ...identity, ...technicals };
  row.market_cap = Object.hasOwn(identity, 'calculatedMarketCap') ? identity.calculatedMarketCap
    : identity.marketCap ?? (bar?.rawClose != null && identity.shares > 0 ? bar.rawClose * identity.shares : null);
  row.prior_market_cap = identity.priorMarketCap ?? null;
  row.market_cap_change = change(row.market_cap, identity.priorMarketCap21d);
  const tradeFloat = identity.floatDate && identity.floatDate > bar?.date ? null : identity.float;
  row.float_turnover_1d = ratio(row.volume, bar?.float ?? tradeFloat);
  row.distance_all_time_high = change(row.close, allTimeHigh);
  return row;
}

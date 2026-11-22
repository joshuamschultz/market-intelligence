import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { expectedSessions } from './calendar.mjs';
import { CALCULATION_VERSION, normalizeSymbol } from './database.mjs';
import { change } from './metrics.mjs';
import { compressStoredBytes, decompressStoredBytes } from './storage-codec.mjs';

export const detailRiskWindows = Object.freeze([21, 63, 126, 252, 504, 704, 1260]);
const maximumSessions = 7560;
const sharedColumns = 4;
const pairedColumns = 3;
const annualizer = Math.sqrt(252);
const format = 'risk-history-1-le';
const schema = `
  CREATE TABLE IF NOT EXISTS prepared_risk_history_runs (
    id TEXT PRIMARY KEY, format TEXT NOT NULL, calculation_version TEXT NOT NULL, basis TEXT NOT NULL, data_version INTEGER NOT NULL,
    anchor_date TEXT NOT NULL, first_date TEXT NOT NULL, last_date TEXT NOT NULL, dates TEXT NOT NULL,
    windows TEXT NOT NULL, benchmarks TEXT NOT NULL, total INTEGER NOT NULL, cursor TEXT,
    processed INTEGER NOT NULL DEFAULT 0, blocks INTEGER NOT NULL DEFAULT 0, risk_keys INTEGER NOT NULL DEFAULT 0,
    basis_exclusions INTEGER NOT NULL DEFAULT 0, commits INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS prepared_risk_history_scope
    ON prepared_risk_history_runs (format,calculation_version,basis,complete,data_version,first_date,last_date);
  CREATE TABLE IF NOT EXISTS prepared_risk_history_blocks (
    run_id TEXT NOT NULL, security_id TEXT NOT NULL, benchmark TEXT NOT NULL, safe_from TEXT, value BLOB NOT NULL,
    PRIMARY KEY (run_id,security_id,benchmark)
  ) WITHOUT ROWID
`;
const roster = `FROM securities WHERE EXISTS
  (SELECT 1 FROM price_revisions WHERE security_id=securities.id AND version<=? AND date<=? LIMIT 1)`;
const unavailable = Object.freeze({ state: 'not-prepared', risk: null, sourceDataVersion: null });

export function normalizeRiskWindows(values = detailRiskWindows) {
  if (!Array.isArray(values) || values.length > 24 || values.some((value) => !Number.isInteger(value) || value < 1 || value > maximumSessions)) {
    throw new RangeError('Risk lookbacks must be whole trading-session counts from 1 to 7,560');
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function normalizeRiskBenchmarks(values = [], preferred) {
  if (!Array.isArray(values) || values.length > 24) throw new RangeError('Choose up to 24 prepared risk benchmarks');
  const result = [...new Set(['SPY', 'VTI', preferred, ...values].filter(Boolean).map(normalizeSymbol))].sort();
  if (result.length > 24) throw new RangeError('Choose up to 24 prepared risk benchmarks including SPY and VTI');
  if (result.some((value) => !value || value.length > 30)) throw new RangeError('Invalid prepared risk benchmark');
  return result;
}

function alignedQuotes(bars, sessions) {
  if (bars.length === sessions.length && bars[0]?.date === sessions[0] && bars.at(-1)?.date === sessions.at(-1)) return bars;
  let offset = 0;
  return sessions.map((date) => {
    while (offset < bars.length && bars[offset].date < date) offset++;
    return bars[offset]?.date === date ? bars[offset++] : null;
  });
}

function priceInput(bars) {
  const close = new Float64Array(bars.length);
  const returns = new Float64Array(bars.length).fill(NaN);
  const tradedPrefix = new Int32Array(bars.length + 1);
  const resets = new Uint8Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar?.traded && bar.close > 0 && !bar.unverifiedSplit) {
      close[i] = bar.close;
      if (close[i - 1] > 0) returns[i] = close[i] / close[i - 1] - 1;
    } else if (bar?.unverifiedSplit || bar?.priceQuarantined) {
      resets[i] = 1;
    }
    tradedPrefix[i + 1] = tradedPrefix[i] + Number(close[i] > 0);
  }
  return { close, returns, resets, tradedPrefix };
}

function sortedIndex(sorted, size, value) {
  let low = 0;
  let high = size;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function rollingReturns(values, window, firstOutput) {
  const sorted = new Float64Array(window);
  const warmup = values.subarray(Math.max(0, firstOutput - window + 1) + 1, firstOutput + 1).filter(Number.isFinite).sort();
  sorted.set(warmup);
  let size = warmup.length;
  return {
    advance(index) {
      if (window < 2) return;
      const leaving = index - window + 1 > 0 ? values[index - window + 1] : NaN;
      if (Number.isFinite(leaving)) {
        const at = sortedIndex(sorted, size, leaving);
        sorted.copyWithin(at, at + 1, size--);
      }
      const entering = values[index];
      if (Number.isFinite(entering)) {
        const at = sortedIndex(sorted, size, entering);
        sorted.copyWithin(at + 1, at, size++);
        sorted[at] = entering;
      }
    },
    get count() { return size; },
    fifthPercentile() {
      if (size < 20) return NaN;
      const position = (size - 1) * 0.05;
      const index = Math.floor(position);
      return sorted[index] + (sorted[Math.min(index + 1, size - 1)] - sorted[index]) * (position - index);
    },
  };
}

function drawdownLookup({ close, resets, tradedPrefix }) {
  const n = close.length;
  const levels = n > 1 ? 32 - Math.clz32(n - 1) : 0;
  const prefixMin = new Float64Array(n * levels);
  const suffixPeak = new Float64Array(n * levels);
  const drawdown = new Float64Array(n * levels);
  // A node needs its lowest price before any reset and its peak after its last reset.
  // The only cross-node drawdown is the right prefix minimum versus the left suffix peak.
  for (let level = 0; level < levels; level++) {
    const width = 2 ** level;
    const base = level * n;
    for (let start = 0; start + width < n; start += 2 * width) {
      const mid = start + width;
      const end = Math.min(mid + width, n);
      let min = Infinity;
      let peak = 0;
      let worst = 0;
      let reset = false;
      for (let i = mid - 1; i >= start; i--) {
        const price = close[i];
        if (resets[i]) {
          min = Infinity;
          reset = true;
        } else if (price) {
          worst = Math.min(worst, min / price - 1);
          min = Math.min(min, price);
          if (!reset) peak = Math.max(peak, price);
        }
        prefixMin[base + i] = min;
        suffixPeak[base + i] = peak;
        drawdown[base + i] = worst;
      }
      min = Infinity;
      peak = 0;
      worst = 0;
      reset = false;
      for (let i = mid; i < end; i++) {
        const price = close[i];
        if (resets[i]) {
          peak = 0;
          reset = true;
        } else if (price) {
          if (!reset) min = Math.min(min, price);
          peak = Math.max(peak, price);
          worst = Math.min(worst, price / peak - 1);
        }
        prefixMin[base + i] = min;
        suffixPeak[base + i] = peak;
        drawdown[base + i] = worst;
      }
    }
  }
  return (first, last) => {
    if (tradedPrefix[last + 1] === tradedPrefix[first]) return NaN;
    if (first === last) return 0;
    const base = (31 - Math.clz32(first ^ last)) * n;
    const left = base + first;
    const right = base + last;
    const cross = suffixPeak[left] ? prefixMin[right] / suffixPeak[left] - 1 : 0;
    return Math.min(drawdown[left], drawdown[right], cross);
  };
}

function benchmarkInput(sessions, quotes) {
  const out = new Float64Array(sessions.length).fill(NaN);
  const close = quotes instanceof Map ? quotes : new Map((quotes ?? []).map((bar) => [bar.date, bar.close]));
  let previous;
  for (let i = 0; i < sessions.length; i++) {
    const current = close.get(sessions[i]);
    if (current > 0 && previous > 0) out[i] = current / previous - 1;
    previous = current;
  }
  return out;
}

function stablePair(values, benchmark, first, last, count) {
  let xx = 0;
  let yy = 0;
  let xy = 0;
  // Preserve the canonical two-pass behavior for low-variance and cancellation-sensitive windows.
  let sx = 0;
  let sy = 0;
  for (let i = first + 1; i <= last; i++) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(benchmark[i])) continue;
    sx += values[i];
    sy += benchmark[i];
  }
  const x = sx / count;
  const y = sy / count;
  for (let i = first + 1; i <= last; i++) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(benchmark[i])) continue;
    const a = values[i] - x;
    const b = benchmark[i] - y;
    xx += a ** 2;
    yy += b ** 2;
    xy += a * b;
  }
  return [xx / count, yy / count, xy / count];
}

function pairLookup(values, benchmark) {
  const n = values.length + 1;
  const counts = new Int32Array(n);
  const sums = Array.from({ length: 5 }, () => new Float64Array(n));
  const [x, y, xx, yy, xy] = sums;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = values[i];
    const b = benchmark[i];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      count++;
      sumX += a;
      sumY += b;
      sumXX += a * a;
      sumYY += b * b;
      sumXY += a * b;
    }
    counts[i + 1] = count;
    x[i + 1] = sumX;
    y[i + 1] = sumY;
    xx[i + 1] = sumXX;
    yy[i + 1] = sumYY;
    xy[i + 1] = sumXY;
  }
  return (first, last, output, offset, stride) => {
    const begin = first + 1;
    const end = last + 1;
    const count = counts[end] - counts[begin];
    output[offset] = count;
    if (count < 20) return;
    const xMean = (x[end] - x[begin]) / count;
    const yMean = (y[end] - y[begin]) / count;
    let varX = (xx[end] - xx[begin]) / count - xMean * xMean;
    let varY = (yy[end] - yy[begin]) / count - yMean * yMean;
    let covariance = (xy[end] - xy[begin]) / count - xMean * yMean;
    if (varX <= xx[end] * 1e-10 || varY <= yy[end] * 1e-10) {
      [varX, varY, covariance] = stablePair(values, benchmark, first, last, count);
    }
    if (varY > 0) output[offset + stride] = covariance / varY;
    if (varX > 0 && varY > 0) output[offset + 2 * stride] = covariance / Math.sqrt(varX * varY);
  };
}

function currentRisk(bars, index) {
  let oldest = index;
  for (let i = index; i >= Math.max(0, index - 20) && bars[i]?.traded; i--) {
    oldest = i;
    if (bars[i].unverifiedSplit) break;
  }
  let volatility = NaN;
  let atr = NaN;
  if (index - oldest >= 14) {
    let sum = 0;
    for (let i = index - 13; i <= index; i++) {
      const { high, low } = bars[i];
      const previous = bars[i - 1].close;
      sum += Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
    }
    atr = bars[index].close > 0 ? sum / 14 / bars[index].close : NaN;
  }
  if (index - oldest === 20) {
    let total = 0;
    for (let i = index - 19; i <= index; i++) total += change(bars[i].close, bars[i - 1].close);
    const mean = total / 20;
    let centered = 0;
    for (let i = index - 19; i <= index; i++) centered += (change(bars[i].close, bars[i - 1].close) - mean) ** 2;
    volatility = Math.sqrt(centered / 20) * annualizer;
  }
  return [volatility, atr];
}

function outputPositions(sessions, dates) {
  const indexes = new Map(sessions.map((date, index) => [date, index]));
  return dates.map((date) => {
    const index = indexes.get(date);
    if (index == null) throw new RangeError(`Risk output ${date} is outside the selected session calendar`);
    return index;
  });
}

function computeRisk(bars, positions, windows, benchmarks, anchorMetrics) {
  const input = priceInput(bars);
  const drawdown = drawdownLookup(input);
  const size = positions.length;
  const stock = new Float64Array(size * (2 + windows.length * sharedColumns)).fill(NaN);
  const pairs = new Map([...benchmarks].map(([ticker]) => [ticker, new Float64Array(size * windows.length * pairedColumns).fill(NaN)]));
  const lookups = [...benchmarks].map(([ticker, values]) => [pairs.get(ticker), pairLookup(input.returns, values)]);
  for (let j = 0; j < size; j++) {
    const index = positions[j];
    const [volatility, atr] = currentRisk(bars, index);
    stock[j] = index === bars.length - 1 && Object.hasOwn(anchorMetrics, 'volatility_20d') ? anchorMetrics.volatility_20d ?? NaN : volatility;
    stock[size + j] = index === bars.length - 1 && Object.hasOwn(anchorMetrics, 'atr_14d') ? anchorMetrics.atr_14d ?? NaN : atr;
  }
  for (const [w, window] of windows.entries()) {
    const rolling = rollingReturns(input.returns, window, positions[0]);
    const stockOffset = size * (2 + w * sharedColumns);
    const pairOffset = size * w * pairedColumns;
    let last = positions[0];
    for (let j = 0; j < size; j++) {
      const index = positions[j];
      while (last < index) rolling.advance(++last);
      const first = Math.max(0, index - window + 1);
      const percentile = rolling.fifthPercentile();
      const offset = stockOffset + j;
      stock[offset] = rolling.count;
      stock[offset + size] = drawdown(first, index);
      stock[offset + 2 * size] = percentile;
      stock[offset + 3 * size] = Math.max(0, -percentile);
      for (const [out, lookup] of lookups) lookup(first, index, out, pairOffset + j, size);
    }
  }
  return { stock, pairs, dates: size, windows };
}

const numberOrNull = (value) => Number.isFinite(value) ? value : null;

function unpackReadings(stock, pairs, index, size, w) {
  const s = size * (2 + w * sharedColumns) + index;
  const p = size * w * pairedColumns + index;
  return {
    observations: stock[s], benchmarkObservations: pairs[p],
    maximumDrawdown: numberOrNull(stock[s + size]), beta: numberOrNull(pairs[p + size]),
    correlation: numberOrNull(pairs[p + 2 * size]),
    dailyHistoricalReturn5pct: numberOrNull(stock[s + 2 * size]), dailyHistoricalVaR95: numberOrNull(stock[s + 3 * size]),
    annualizedVolatility: numberOrNull(stock[index]), atr14: numberOrNull(stock[size + index]),
  };
}

export function rollingRiskMetrics(chartBars, dates, windows, benchmarkBars, { sessions = chartBars.map(({ date }) => date), anchorMetrics = {} } = {}) {
  const numeric = computeRisk(alignedQuotes(chartBars, sessions), outputPositions(sessions, dates), windows,
    new Map([...benchmarkBars].map(([ticker, quotes]) => [ticker, benchmarkInput(sessions, quotes)])), anchorMetrics);
  return (dateIndex, ticker, lookback) => unpackReadings(numeric.stock, numeric.pairs.get(ticker), dateIndex, dates.length, windows.indexOf(lookback));
}

const littleEndian = endianness() === 'LE';

function encodeVector(values) {
  const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  return compressStoredBytes(littleEndian ? bytes : Buffer.from(bytes).swap64());
}

function decodeVector(value, expected) {
  let bytes = decompressStoredBytes(value);
  if (bytes.byteLength !== expected * 8) throw new Error('Prepared risk history block length does not match its manifest');
  if (!littleEndian) bytes = Buffer.from(bytes).swap64();
  if (bytes.byteOffset % 8) bytes = Uint8Array.from(bytes);
  return new Float64Array(bytes.buffer, bytes.byteOffset, expected);
}

function orderedDates(config, dates) {
  if (!config.date || !config.earliestDate) throw new Error('Load prices before preparing risk history');
  const sessions = expectedSessions(config.earliestDate, config.date).slice(-maximumSessions);
  const requested = dates == null ? sessions : [...dates];
  if (!requested.length || requested.length > maximumSessions ||
      requested.some((date, index) => index && date <= requested[index - 1])) {
    throw new RangeError('Risk output dates must be distinct ordered trading sessions');
  }
  const positions = outputPositions(sessions, requested);
  return { sessions, requested, positions };
}

function latestDate(...dates) {
  return dates.filter(Boolean).reduce((newest, date) => date > newest ? date : newest, '') || null;
}

function safeSplitFrom(detail) {
  if (!detail.explicitSplitPriceBasis) return null;
  // Explicit vendor scales can differ across a historical split. Raw split-normalized
  // returns, drawdown, paired moments, and percentage ATR share the same positive scale.
  return detail.actions?.findLast(({ type, factor }) => type === 'split' && factor > 0)?.date ?? null;
}

function stateSummary(run) {
  const dates = JSON.parse(run.dates);
  const windows = JSON.parse(run.windows);
  const benchmarks = JSON.parse(run.benchmarks);
  const expectedKeys = run.total * dates.length * windows.length * benchmarks.length;
  return { runId: run.id, format: run.format, calculationVersion: run.calculation_version, basis: run.basis,
    status: run.complete ? 'complete' : 'running', done: Boolean(run.complete),
    cursor: run.cursor, date: run.anchor_date, dataVersion: run.data_version, dates, windows, benchmarks,
    totalSecurities: run.total, processedSecurities: run.processed, riskBlocks: run.blocks, riskKeys: run.risk_keys,
    expectedBlocks: run.total * (1 + benchmarks.length), expectedKeys, basisExclusions: run.basis_exclusions, commits: run.commits };
}

export function createRiskHistoryWriter(db, config, {
  dates, windows, benchmarks, benchmarkBars, benchmarkSafeFrom = new Map(), securityIds, batchSize = 32, signal, sourceDb = db,
} = {}) {
  if (config.basis !== 'reconstructed') throw new Error('Historical risk requires reconstructed prices or separately prepared exact vintages');
  if (!(benchmarkBars instanceof Map)) throw new TypeError('Risk history requires benchmark quotes keyed by symbol');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new RangeError('Risk history batch size must be 1–256');
  const selectedWindows = normalizeRiskWindows(windows);
  const tickers = normalizeRiskBenchmarks(benchmarks, config.benchmark);
  const calendar = orderedDates(config, dates);
  const { requested } = calendar;
  const start = Math.max(0, calendar.positions[0] - Math.max(21, ...selectedWindows) + 1);
  const sessions = calendar.sessions.slice(start);
  const positions = calendar.positions.map((index) => index - start);
  const ids = securityIds == null ? null : [...new Set(securityIds)].sort();
  if (ids?.some((id) => typeof id !== 'string' || !id)) throw new TypeError('Risk history requires permanent security IDs');
  const total = ids?.length ?? sourceDb.prepare(`SELECT count(*) AS total ${roster}`).get(config.dataVersion, config.date).total;
  const runId = createHash('sha256').update(JSON.stringify([format, CALCULATION_VERSION, config.basis, config.dataVersion,
    config.date, requested, selectedWindows, tickers, ids])).digest('hex');
  db.exec(schema);
  const read = db.prepare('SELECT * FROM prepared_risk_history_runs WHERE id=?');
  db.prepare(`INSERT OR IGNORE INTO prepared_risk_history_runs
    (id,format,calculation_version,basis,data_version,anchor_date,first_date,last_date,dates,windows,benchmarks,total,complete)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, format, CALCULATION_VERSION, config.basis, config.dataVersion, config.date, requested[0],
    requested.at(-1), JSON.stringify(requested), JSON.stringify(selectedWindows), JSON.stringify(tickers), total, Number(total === 0));
  let state = read.get(runId);
  const pairInputs = new Map(tickers.map((ticker) => [ticker, benchmarkInput(sessions, benchmarkBars?.get(ticker))]));
  const insert = db.prepare('INSERT INTO prepared_risk_history_blocks VALUES (?,?,?,?,?)');
  const update = db.prepare(`UPDATE prepared_risk_history_runs
    SET cursor=?,processed=?,blocks=blocks+?,risk_keys=risk_keys+?,basis_exclusions=basis_exclusions+?,commits=commits+1,complete=? WHERE id=?`);
  const pending = [];
  let last = state.cursor;

  function flush() {
    signal?.throwIfAborted();
    if (!pending.length) return stateSummary(state);
    db.exec('BEGIN IMMEDIATE');
    try {
      const live = read.get(runId);
      if (live.cursor !== state.cursor || live.complete) throw new Error('Risk history writer advanced concurrently; reopen it at the saved cursor');
      let rows = 0;
      let ready = 0;
      let excluded = 0;
      for (const { securityId, blocks, riskKeys, basisExclusions } of pending) {
        for (const [ticker, safeFrom, value] of blocks) insert.run(runId, securityId, ticker, safeFrom, value);
        rows += blocks.length;
        ready += riskKeys;
        excluded += basisExclusions;
      }
      const processed = live.processed + pending.length;
      update.run(last, processed, rows, ready, excluded, Number(processed === total), runId);
      db.exec('COMMIT');
      pending.length = 0;
      state = read.get(runId);
      return stateSummary(state);
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    get runId() { return runId; },
    get status() { return stateSummary(state); },
    writeSecurity(detail) {
      signal?.throwIfAborted();
      const { securityId, chartBars } = detail;
      if (!securityId || detail.date != null && detail.date !== config.date ||
          detail.dataVersion != null && detail.dataVersion !== config.dataVersion || !Array.isArray(chartBars) ||
          chartBars.at(-1)?.date > config.date) throw new Error('Risk history input does not match the pinned warehouse scope');
      if (state.complete || state.cursor && securityId <= state.cursor) return;
      if (last && securityId <= last || ids && ids[state.processed + pending.length] !== securityId ||
          state.processed + pending.length >= total) throw new Error('Risk history securities must follow the pinned roster order');
      const bars = alignedQuotes(chartBars, sessions);
      const outputs = computeRisk(bars, positions, selectedWindows, pairInputs, detail);
      const stockSafeFrom = safeSplitFrom(detail);
      const blocks = [['', stockSafeFrom, encodeVector(outputs.stock)]];
      let riskKeys = 0;
      for (const [ticker, values] of outputs.pairs) {
        const benchmarkStart = benchmarkSafeFrom.get(ticker) ?? null;
        const safeFrom = latestDate(stockSafeFrom, benchmarkStart);
        riskKeys += requested.filter((date) => !safeFrom || date >= safeFrom).length * selectedWindows.length;
        blocks.push([ticker, benchmarkStart, encodeVector(values)]);
      }
      pending.push({ securityId, blocks, riskKeys, basisExclusions: requested.length * tickers.length * selectedWindows.length - riskKeys });
      last = securityId;
      if (pending.length >= batchSize) flush();
    },
    flush,
    finish() {
      const result = flush();
      if (!result.done) throw new Error(`Risk history is incomplete: ${result.processedSecurities} of ${result.totalSecurities} securities saved`);
      return result;
    },
  };
}

function archiveExists(db) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepared_risk_history_runs'").get();
}

export function riskHistoryManifest(db, runId) {
  if (!archiveExists(db)) return null;
  const row = db.prepare('SELECT * FROM prepared_risk_history_runs WHERE id=?').get(runId);
  if (!row) return null;
  const counts = db.prepare(`SELECT count(*) AS blocks,count(DISTINCT security_id) AS securities,
    coalesce(sum(length(value)),0) AS bytes FROM prepared_risk_history_blocks WHERE run_id=?`).get(runId);
  return { ...stateSummary(row), actualBlocks: counts.blocks, actualSecurities: counts.securities, bytes: counts.bytes };
}

export function readRiskHistory(db, config, securityId, { lookback, benchmark = config.benchmark } = {}) {
  if (!config?.date || !securityId || !benchmark || !archiveExists(db)) return unavailable;
  const ticker = normalizeSymbol(benchmark);
  const runs = db.prepare(`SELECT id,data_version,dates,windows,benchmarks FROM prepared_risk_history_runs
    WHERE complete=1 AND format=? AND calculation_version=? AND basis=? AND data_version<=? AND first_date<=? AND last_date>=?
    ORDER BY data_version DESC,anchor_date,id`).all(format, CALCULATION_VERSION, config.basis, config.dataVersion, config.date, config.date);
  const bounds = reusableArchiveVersions(db, { ...config, referenceMode: 'as-of' }, runs.map((row) => row.data_version));
  const query = db.prepare('SELECT safe_from,value FROM prepared_risk_history_blocks WHERE run_id=? AND security_id=? AND benchmark=?');
  let unsafe;
  for (const run of runs) {
    if (!usableArchiveRow(bounds, { date: config.date, data_version: run.data_version }) || !JSON.parse(run.benchmarks).includes(ticker)) continue;
    const dates = JSON.parse(run.dates);
    const windows = JSON.parse(run.windows);
    const index = dates.indexOf(config.date);
    const window = windows.indexOf(lookback);
    if (index < 0 || window < 0) continue;
    const stock = query.get(run.id, securityId, '');
    const pair = query.get(run.id, securityId, ticker);
    if (!stock || !pair) continue;
    if (stock.safe_from > config.date || pair.safe_from > config.date) {
      unsafe ??= { state: 'requires-exact-date', risk: null, sourceDataVersion: run.data_version };
      continue;
    }
    return { state: 'ready', sourceDataVersion: run.data_version,
      risk: unpackReadings(decodeVector(stock.value, dates.length * (2 + windows.length * sharedColumns)),
        decodeVector(pair.value, dates.length * windows.length * pairedColumns), index, dates.length, window) };
  }
  return unsafe ?? unavailable;
}

const benchmarkCache = new WeakMap();

export function prepareRiskHistoryBenchmarks(db, engine, config, { dates, windows, benchmarks } = {}) {
  const tickers = normalizeRiskBenchmarks(benchmarks, config.benchmark);
  const selected = normalizeRiskWindows(windows);
  const { sessions, positions } = orderedDates(config, dates);
  const from = sessions[Math.max(0, positions[0] - Math.max(21, ...selected) + 1)];
  const context = { ...config, referenceMode: 'as-of', currentVersion: false };
  const key = JSON.stringify([config.basis, config.dataVersion, config.date, from, tickers]);
  let cache = benchmarkCache.get(engine);
  if (!cache) benchmarkCache.set(engine, cache = new Map());
  if (cache.has(key)) return cache.get(key);
  const benchmarkBars = engine.studyPrices(context, tickers, from, config.date);
  const benchmarkSafeFrom = new Map();
  const split = db.prepare(`SELECT max(date) AS date FROM corporate_actions
    WHERE security_id=? AND version<=? AND date<=? AND type='split' AND factor>0`);
  const explicit = db.prepare(`SELECT 1 FROM price_revisions WHERE security_id=? AND version<=? AND date<=? AND split_close>0 LIMIT 1`);
  for (const ticker of tickers) {
    const security = engine.findSecurity(context, ticker);
    if (!security) continue;
    const alias = security.identifiers?.filter(({ symbol, valid_from, valid_to }) =>
      symbol === ticker && valid_from <= config.date && (!valid_to || valid_to >= config.date))
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
    const splitDate = explicit.get(security.id, config.dataVersion, config.date) && split.get(security.id, config.dataVersion, config.date)?.date;
    benchmarkSafeFrom.set(ticker, latestDate(alias?.valid_from, splitDate));
  }
  const prepared = { benchmarkBars, benchmarkSafeFrom };
  cache.set(key, prepared);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return prepared;
}

export function prepareRiskHistoryBatch(db, engine, config, {
  dates, windows, benchmarks, securityIds, bucketSize = 32, onSecurity, signal, progress = () => {}, sourceDb = db,
} = {}) {
  signal?.throwIfAborted();
  if (config.basis !== 'reconstructed') {
    progress(1);
    return { status: 'unsupported-basis', done: true, riskBlocks: 0, riskKeys: 0,
      reason: 'Known-at-the-time risk requires separately prepared exact vintage dates.' };
  }
  const ids = securityIds == null ? null : [...new Set(securityIds)].sort();
  const prepared = prepareRiskHistoryBenchmarks(sourceDb, engine, config, { dates, windows, benchmarks });
  const writer = createRiskHistoryWriter(db, config, {
    ...prepared, dates, windows, benchmarks, securityIds: ids, batchSize: bucketSize, signal, sourceDb,
  });
  const before = writer.status;
  if (before.done) {
    progress(1);
    return before;
  }
  const cursor = before.cursor ?? '';
  const selected = ids ? ids.slice(before.processedSecurities, before.processedSecurities + bucketSize)
    : sourceDb.prepare(`SELECT id ${roster} AND id>? ORDER BY id LIMIT ?`).all(config.dataVersion, config.date, cursor, bucketSize).map(({ id }) => id);
  const context = { ...config, referenceMode: 'as-of', currentVersion: false };
  const direct = engine.detailSources?.(context, { securityIds: selected, lookback: maximumSessions, signal });
  const previous = direct ? null : sourceDb.prepare(`SELECT 1 FROM price_revisions WHERE security_id=? AND version<=? AND date<=?
    AND split_close>0 LIMIT 1`);
  const source = direct ? direct[Symbol.iterator]() : null;
  let next = source?.next().value;
  for (const securityId of selected) {
    signal?.throwIfAborted();
    const result = (source ? (next?.securityId === securityId ? next : null)
      : engine.detail(context, securityId, maximumSessions, { velocity: false })) ?? { securityId, chartBars: [] };
    if (source && result === next) next = source.next().value;
    const detail = previous ? { ...result, explicitSplitPriceBasis: Boolean(previous.get(securityId, config.dataVersion, config.date)) } : result;
    onSecurity?.(detail);
    writer.writeSecurity(detail);
  }
  const after = writer.flush();
  progress(after.done ? 1 : after.processedSecurities / after.totalSecurities);
  return after;
}

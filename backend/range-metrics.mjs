import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { expectedSessions } from './calendar.mjs';
import { CALCULATION_VERSION } from './database.mjs';
import { UNIVERSES } from './engine.mjs';

const maxLookback = 7560;
const maxWindows = 16;
const metricNames = ['distance_high', 'distance_low', 'since_high', 'since_low', 'age_high', 'age_low'];
const fieldPattern = /\brange_(?:distance|since|age)_(?:high|low)_(\d+)d\b/g;
const wholeCatalog = UNIVERSES.find(({ id }) => id === 'us-all');
const schema = `
  CREATE TABLE IF NOT EXISTS prepared_range_metrics (
    recipe TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    date TEXT NOT NULL,
    lookback INTEGER NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (recipe,data_version,date,lookback)
  ) WITHOUT ROWID
`;
const historySchema = `
  CREATE TABLE IF NOT EXISTS prepared_range_history_runs (
    id TEXT PRIMARY KEY,
    recipe TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    end_date TEXT NOT NULL,
    starts TEXT NOT NULL,
    cursor TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    written INTEGER NOT NULL DEFAULT 0,
    basis_exclusions INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS prepared_range_history_lookup
    ON prepared_range_history_runs(recipe,complete,data_version,end_date);
  CREATE TABLE IF NOT EXISTS prepared_range_history_blocks (
    run_id TEXT NOT NULL,
    date TEXT NOT NULL,
    lookback INTEGER NOT NULL,
    bucket INTEGER NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY(run_id,date,lookback,bucket)
  ) WITHOUT ROWID
`;

export function validateRangeWindows(input = []) {
  if (typeof input === 'string') input = input.trim() ? input.split(',').map((value) => value.trim()) : [];
  if (!Array.isArray(input)) throw new TypeError('Range lookbacks must be a list of trading-session counts');
  const windows = new Set();
  for (const entry of input) {
    const value = typeof entry === 'string' && /^\d+$/.test(entry) ? Number(entry) : entry;
    if (!Number.isInteger(value) || value < 1 || value > maxLookback) {
      throw new RangeError(`Range lookbacks must be whole trading-session counts from 1 to ${maxLookback.toLocaleString('en-US')}`);
    }
    windows.add(value);
    if (windows.size > maxWindows) throw new RangeError(`Use at most ${maxWindows} distinct range lookbacks`);
  }
  return [...windows].sort((a, b) => a - b);
}

export function rangeWindowsForScreen(screen = {}) {
  const definition = screen.definition ?? screen;
  const configured = validateRangeWindows(definition.context?.rangeWindows ?? definition.rangeWindows ?? []);
  const expressions = Array.isArray(definition.computed) ? definition.computed.map((item) => item?.expression) : [];
  const fields = JSON.stringify([definition.filter, definition.sort, definition.columns, expressions]);
  const used = [...fields.matchAll(fieldPattern)].map(([, window]) => Number(window));
  return validateRangeWindows([...configured, ...used]);
}

function usableBar(bar, date) {
  return bar?.date === date && bar.traded === true && !bar.priceQuarantined &&
    [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
    bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close);
}

function comparableSuffix(chartBars, sessions, date) {
  if (sessions.at(-1) !== date || chartBars.at(-1)?.date !== date) return [];
  const comparable = [];
  const length = Math.min(sessions.length, chartBars.length);
  for (let offset = 1; offset <= length; offset++) {
    const bar = chartBars.at(-offset);
    if (!usableBar(bar, sessions.at(-offset))) break;
    comparable.push(bar);
    // The flagged bar can start a new price segment. Its crossing into the preceding segment is unavailable.
    if (bar.unverifiedSplit) break;
  }
  return comparable.reverse();
}

function relativeDistance(close, extreme) {
  const result = (close - extreme) / extreme;
  // Remove floating-point noise from a common split rescaling at exact filter boundaries.
  return Number.isFinite(result) ? Number(result.toPrecision(14)) : null;
}

function scanWindow(bars, window, highs, lows, visit, firstDate = '') {
  const last = bars.length - 1;
  let highStart = 0;
  let highEnd = 0;
  let lowStart = 0;
  let lowEnd = 0;
  let lastHigh = null;
  let lastLow = null;
  for (let index = 0; index <= last; index++) {
    const bar = bars[index];
    const earliestPrior = index - window;
    while (highStart < highEnd && highs[highStart] < earliestPrior) highStart++;
    while (lowStart < lowEnd && lows[lowStart] < earliestPrior) lowStart++;
    if (index >= window) {
      if (bar.high > bars[highs[highStart]].high) lastHigh = index;
      if (bar.low < bars[lows[lowStart]].low) lastLow = index;
    }
    // Keep the newest equal extreme so its age within the current window has a defined tie rule.
    while (highStart < highEnd && bar.high >= bars[highs[highEnd - 1]].high) highEnd--;
    while (lowStart < lowEnd && bar.low <= bars[lows[lowEnd - 1]].low) lowEnd--;
    highs[highEnd++] = index;
    lows[lowEnd++] = index;
    if (index < window - 1 || bar.date < firstDate || !visit && index !== last) continue;
    const first = index - window + 1;
    while (highs[highStart] < first) highStart++;
    while (lows[lowStart] < first) lowStart++;
    const highIndex = highs[highStart];
    const lowIndex = lows[lowStart];
    const high = bars[highIndex].high;
    const low = bars[lowIndex].low;
    const close = bar.close;
    const values = [relativeDistance(close, high), relativeDistance(close, low),
      lastHigh == null ? null : index - lastHigh, lastLow == null ? null : index - lastLow, index - highIndex, index - lowIndex];
    if (visit) visit(bar.date, window, values);
    else return values;
  }
}

function valuesForWindows(chartBars, windows, date, sessions) {
  const bars = comparableSuffix(chartBars, sessions, date);
  const highs = new Int32Array(bars.length);
  const lows = new Int32Array(bars.length);
  return new Map(windows.filter((window) => window <= bars.length).map((window) =>
    [window, scanWindow(bars, window, highs, lows)]));
}

function scanHistory(chartBars, sessions, starts, visit, splitSafeFrom) {
  let offset = 0;
  let segment = [];
  function flush() {
    if (!segment.length) return;
    const highs = new Int32Array(segment.length);
    const lows = new Int32Array(segment.length);
    for (const [window, start] of starts) if (window <= segment.length) {
      scanWindow(segment, window, highs, lows, visit, splitSafeFrom > start ? splitSafeFrom : start);
    }
    segment = [];
  }
  for (const date of sessions) {
    while (chartBars[offset]?.date < date) offset++;
    const bar = chartBars[offset];
    if (bar?.date === date) offset++;
    if (!usableBar(bar, date)) { flush(); continue; }
    if (bar.unverifiedSplit) flush();
    segment.push(bar);
  }
  flush();
}

function stockRangeFields(windows, get) {
  const fields = {};
  for (const window of windows) {
    const values = get(window);
    for (const [index, name] of metricNames.entries()) fields[`range_${name}_${window}d`] = values?.[index] ?? null;
  }
  return fields;
}

export function calculateRangeMetrics(chartBars, windows, { date = chartBars.at(-1)?.date, sessions } = {}) {
  const requested = validateRangeWindows(windows);
  const calendar = sessions ?? (chartBars.length && date ? expectedSessions(chartBars[0].date, date) : []);
  const values = valuesForWindows(chartBars, requested, date, calendar);
  return stockRangeFields(requested, (window) => values.get(window));
}

function recipeFor(config) {
  const reference = config.date === config.latestDate && config.referenceMode === 'latest' &&
    config.observedReferenceDate > config.date ? config.observedReferenceDate : null;
  return createHash('sha256').update(JSON.stringify([
    'range-metrics-1', CALCULATION_VERSION, config.basis, reference,
  ])).digest('hex');
}

function hasArchive(db) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepared_range_metrics'").get();
}

function hasHistory(db) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepared_range_history_runs'").get();
}

function historicalRuns(db, config, since) {
  if (config.basis !== 'reconstructed' || !hasHistory(db)) return [];
  const context = { ...config, referenceMode: 'as-of' };
  const rows = db.prepare(`SELECT id,data_version,end_date,starts FROM prepared_range_history_runs
    WHERE recipe=? AND complete=1 AND data_version<=? AND end_date>=?
    ORDER BY data_version DESC,end_date DESC,id`).all(recipeFor(context), config.dataVersion, since);
  const bounds = reusableArchiveVersions(db, context, rows.map((row) => row.data_version));
  return rows.filter((row) => bounds.has(row.data_version)).map((row) => ({
    ...row, bounds, starts: new Map(JSON.parse(row.starts)),
  }));
}

function coveringRun(runs, window, date) {
  return runs.find((run) => run.end_date >= date && run.starts.has(window) && run.starts.get(window) <= date &&
    usableArchiveRow(run.bounds, { date, data_version: run.data_version }));
}

export function readPreparedRangeMetrics(db, config, windows) {
  const requested = validateRangeWindows(windows);
  const values = new Map();
  if (requested.length && config.date && hasArchive(db)) {
    const stored = db.prepare(`SELECT lookback,value FROM prepared_range_metrics
      WHERE recipe=? AND data_version=? AND date=? AND lookback IN (SELECT value FROM json_each(?))`)
      .iterate(recipeFor(config), config.dataVersion, config.date, JSON.stringify(requested));
    for (const row of stored) {
      values.set(row.lookback, new Map(JSON.parse(gunzipSync(row.value)).map(([securityId, ...reading]) => [securityId, reading])));
    }
  }
  const sources = {};
  if (config.date && requested.some((window) => !values.has(window))) {
    const runs = historicalRuns(db, config, config.date);
    if (runs.length) {
      const blocks = db.prepare(`SELECT value FROM prepared_range_history_blocks
        WHERE run_id=? AND date=? AND lookback=? ORDER BY bucket`);
      for (const window of requested) {
        if (values.has(window)) continue;
        const run = coveringRun(runs, window, config.date);
        if (!run) continue;
        const records = new Map();
        for (const { value } of blocks.iterate(run.id, config.date, window)) {
          for (const [id, ...reading] of JSON.parse(gunzipSync(value))) records.set(id, reading);
        }
        values.set(window, records);
        sources[window] = { mode: 'reconstructed-history', dataVersion: run.data_version };
      }
    }
  }
  const missingWindows = requested.filter((window) => !values.has(window));
  return { ready: missingWindows.length === 0, windows: requested, missingWindows, values, sources };
}

export function applyPreparedRangeMetrics(snapshot, prepared) {
  if (!prepared.windows.length) return snapshot;
  if (!prepared.ready) throw new Error('Requested range metrics have not been prepared');
  return {
    ...snapshot,
    stocks: snapshot.stocks.map((stock) => ({ ...stock, ...stockRangeFields(prepared.windows,
      (window) => prepared.values.get(window).get(stock.securityId)) })),
  };
}

function pinnedRangeContext(config) {
  // These references and actions are shared only across this one pinned date and knowledge basis.
  // An empty session index leaves canonical detail responsible for each instrument's full price history.
  return { ...config, universe: wholeCatalog, currentVersion: false, includeAllTimeHigh: false,
    historySource: { end: config.date, indices: new Map(), actions: new Map() } };
}

export function prepareRangeMetrics(db, engine, config, windows, { progress = () => {}, signal, onSecurity } = {}) {
  signal?.throwIfAborted();
  const requested = validateRangeWindows(windows);
  if (!requested.length) { progress(1); return { windows: [], written: 0, reused: 0 }; }
  if (!config.date || !config.earliestDate) throw new Error('Load a price session before preparing range metrics');
  const recipe = recipeFor(config);
  const scope = [recipe, config.dataVersion, config.date];
  const exists = hasArchive(db) ? db.prepare(`SELECT 1 FROM prepared_range_metrics WHERE recipe=? AND data_version=? AND date=? AND lookback=?`) : null;
  const missing = requested.filter((window) => !exists?.get(...scope, window));
  const summary = { date: config.date, dataVersion: config.dataVersion, windows: requested };
  if (!missing.length) { progress(1); return { ...summary, written: 0, reused: requested.length }; }
  const collected = new Map(missing.map((window) => [window, []]));
  const pinned = pinnedRangeContext(config);
  const dates = expectedSessions(config.earliestDate, config.date).slice(-maxLookback);
  const snapshot = engine.snapshot(pinned, { persist: false, cache: true, velocity: false });
  const securities = snapshot.stocks.filter(({ traded }) => traded);
  for (const [index, { securityId }] of securities.entries()) {
    signal?.throwIfAborted();
    const detail = engine.detail(pinned, securityId, maxLookback, { velocity: false });
    if (detail) onSecurity?.(detail, { securityId, config: pinned });
    for (const [window, row] of valuesForWindows(detail?.chartBars ?? [], missing, config.date, dates)) {
      collected.get(window).push([securityId, ...row]);
    }
    if (index % 16 === 0) progress(0.95 * (index + 1) / securities.length);
  }
  signal?.throwIfAborted();
  const encoded = missing.map((window) => [window, gzipSync(JSON.stringify(collected.get(window)), { level: 3 })]);
  db.exec(schema);
  const write = db.prepare('INSERT OR IGNORE INTO prepared_range_metrics VALUES (?,?,?,?,?)');
  let written = 0;
  db.exec('SAVEPOINT write_prepared_ranges');
  try {
    for (const [window, value] of encoded) written += write.run(...scope, window, value).changes;
    db.exec('RELEASE write_prepared_ranges');
  } catch (error) {
    db.exec('ROLLBACK TO write_prepared_ranges');
    db.exec('RELEASE write_prepared_ranges');
    throw error;
  }
  progress(1);
  return { ...summary, written, reused: requested.length - written, securities: securities.length };
}

const rosterQuery = `FROM securities WHERE first_seen IS NOT NULL AND EXISTS (
  SELECT 1 FROM price_revisions WHERE security_id=securities.id AND version<=? AND date<=? LIMIT 1)`;

function historyStatus(summary, state, progress) {
  const done = Boolean(state.complete);
  progress(done ? 1 : state.total ? state.processed / state.total : 0);
  return { ...summary, status: done ? 'complete' : 'running', done, cursor: done ? null : state.cursor,
    processedSecurities: state.processed, totalSecurities: state.total, written: state.written, basisExclusions: state.basis_exclusions };
}

export function prepareRangeHistoryBatch(db, engine, config, windows, { cursor = null, progress = () => {}, signal, bucketSize, onSecurity } = {}) {
  signal?.throwIfAborted();
  const requested = validateRangeWindows(windows);
  const summary = { date: config.date, dataVersion: config.dataVersion, windows: requested };
  if (config.basis !== 'reconstructed') {
    progress(1);
    return { ...summary, status: 'unsupported-basis', done: true, cursor: null, written: 0,
      reason: 'Known-at-the-time prices require separately prepared exact vintage dates.' };
  }
  if (!config.date || !config.earliestDate) throw new Error('Load a price session before preparing range history');
  if (cursor != null && typeof cursor !== 'string') throw new TypeError('Range history cursor must be a security ID');
  const size = bucketSize ?? Math.max(8, Math.floor(128 / Math.max(1, requested.length)));
  if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError('Range history bucket size must be 1–256 securities');
  const sessions = expectedSessions(config.earliestDate, config.date).slice(-maxLookback);
  const [first] = sessions;
  const recipe = recipeFor({ ...config, referenceMode: 'as-of' });
  const id = createHash('sha256').update(JSON.stringify([recipe, config.dataVersion, first, config.date, requested])).digest('hex');
  db.exec(historySchema);
  const select = db.prepare('SELECT * FROM prepared_range_history_runs WHERE id=?');
  let state = select.get(id);
  if (!state) {
    const runs = historicalRuns(db, config, first);
    const starts = requested.flatMap((window) => {
      const date = sessions.find((session) => !coveringRun(runs, window, session));
      return date ? [[window, date]] : [];
    });
    const total = starts.length ? db.prepare(`SELECT count(*) AS total ${rosterQuery}`).get(config.dataVersion, config.date).total : 0;
    db.prepare(`INSERT OR IGNORE INTO prepared_range_history_runs(id,recipe,data_version,end_date,starts,total,complete)
      VALUES (?,?,?,?,?,?,?)`).run(id, recipe, config.dataVersion, config.date, JSON.stringify(starts), total, Number(total === 0));
    state = select.get(id);
  }
  if (state.complete) return historyStatus(summary, state, progress);
  const ids = db.prepare(`SELECT id ${rosterQuery} AND id>? ORDER BY id LIMIT ?`)
    .all(config.dataVersion, config.date, state.cursor ?? '', size);
  const starts = JSON.parse(state.starts);
  const anchored = pinnedRangeContext({ ...config, referenceMode: 'as-of' });
  engine.snapshot(anchored, { cache: true, velocity: false });
  const explicitPriceBasis = db.prepare(`SELECT 1 FROM price_revisions WHERE security_id=? AND version<=? AND date<=?
    AND split_close>0 LIMIT 1`);
  const byWindow = new Map(starts.map(([window]) => [window, new Map()]));
  let excluded = 0;
  for (const { id: securityId } of ids) {
    signal?.throwIfAborted();
    const detail = engine.detail(anchored, securityId, maxLookback, { velocity: false });
    if (detail) onSecurity?.(detail, { securityId, config: anchored });
    if (!detail?.chartBars?.length) continue;
    // Explicit vendor-adjusted levels can use a different future split scale from raw OHLC.
    // Keep ambiguous earlier spans unavailable unless they are separately prepared at their own dates.
    const lastSplit = (detail.actions ?? []).findLast((action) => action.type === 'split' && action.factor > 0 && action.date <= config.date)?.date;
    const splitSafeFrom = lastSplit && explicitPriceBasis.get(securityId, config.dataVersion, lastSplit) ? lastSplit : '';
    if (splitSafeFrom) excluded++;
    scanHistory(detail.chartBars, sessions, starts, (date, window, values) => {
      const output = byWindow.get(window);
      if (!output.has(date)) output.set(date, []);
      output.get(date).push([securityId, ...values]);
    }, splitSafeFrom);
  }
  signal?.throwIfAborted();

  const blocks = [];
  for (const [window, readings] of byWindow) {
    for (const [date, rows] of readings) blocks.push([date, window, gzipSync(JSON.stringify(rows), { level: 3 })]);
  }
  const write = db.prepare('INSERT INTO prepared_range_history_blocks VALUES (?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const live = select.get(id);
    if (!live.complete && live.cursor === state.cursor) {
      for (const [date, window, value] of blocks) write.run(id, date, window, live.processed, value);
      const count = live.processed + ids.length;
      const done = count >= live.total || ids.length < size;
      db.prepare(`UPDATE prepared_range_history_runs
        SET cursor=?,processed=?,complete=?,written=written+?,basis_exclusions=basis_exclusions+? WHERE id=?`)
        .run(ids.at(-1)?.id ?? live.cursor, count, Number(done), blocks.length, excluded, id);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return historyStatus(summary, select.get(id), progress);
}

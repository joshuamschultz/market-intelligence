import { createHash } from 'node:crypto';
import { reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { expectedSessions } from './calendar.mjs';
import { CALCULATION_VERSION, isoDate, normalizeSymbol } from './database.mjs';
import { UNIVERSES } from './engine.mjs';
import { mean, quantile } from './metrics.mjs';
import { detailRiskWindows, normalizeRiskBenchmarks, normalizeRiskWindows, readRiskHistory } from './risk-history.mjs';
import { decodeStoredJson, encodeStoredJson } from './storage-codec.mjs';

const format = 'prepared-details-1';
const maximumSessions = 7560;
const wholeCatalog = UNIVERSES.find(({ id }) => id === 'us-all');
const pinnedScope = Symbol('prepared detail scope');
export { detailRiskWindows };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const barFields = [
  'open', 'high', 'low', 'close', 'rawClose', 'volume', 'rawVolume', 'dollarVolume', 'traded',
  'missing', 'unverifiedSplit', 'priceQuarantined', 'volumeQuarantined', 'quality',
  'knownAt', 'ingestedAt', 'source', 'version', 'volumeBasis',
];
const identityFields = ['symbol', 'name', 'exchange', 'type', 'isin', 'listingDate', 'delistingDate'];
const highFields = ['allTimeHigh', 'loadedHistoryHigh', 'loadedHistoryHighFrom', 'loadedHistoryHighThrough',
  'loadedHistoryHighObservations', 'loadedHistoryHighExpected', 'loadedHistoryHighBoundary',
  'distance_all_time_high', 'distance_loaded_history_high'];
const keyWhere = 'calculation_version=? AND basis=? AND security_id=? AND data_version=? AND anchor_date=?';
const schema = `
  CREATE TABLE IF NOT EXISTS prepared_detail_blocks (
    hash TEXT PRIMARY KEY, value BLOB NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_detail_products (
    calculation_version TEXT NOT NULL, basis TEXT NOT NULL, security_id TEXT NOT NULL,
    data_version INTEGER NOT NULL, anchor_date TEXT NOT NULL, header BLOB NOT NULL, blocks BLOB NOT NULL,
    PRIMARY KEY(calculation_version,basis,security_id,data_version,anchor_date)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_detail_risk (
    calculation_version TEXT NOT NULL, basis TEXT NOT NULL, security_id TEXT NOT NULL,
    data_version INTEGER NOT NULL, anchor_date TEXT NOT NULL, benchmark TEXT NOT NULL, value BLOB NOT NULL,
    PRIMARY KEY(calculation_version,basis,security_id,data_version,anchor_date,benchmark)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_detail_batches (
    id TEXT PRIMARY KEY, cursor TEXT, processed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
    written INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID
`;

const keyFor = (config, id, dataVersion = config.dataVersion, date = config.date) =>
  [CALCULATION_VERSION, config.basis, id, dataVersion, date];
const pick = (source, names) => Object.fromEntries(names.filter((name) => Object.hasOwn(source, name)).map((name) => [name, source[name]]));
const present = (db) => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepared_detail_products'").get();

function stockRisk(detail) {
  const bars = detail.chartBars || detail.bars;
  const returns = [];
  const edges = [];
  let peak = 0;
  let drawdown = 0;
  let previous;
  let priced = 0;
  for (const bar of bars) {
    if (!bar.traded || !(bar.close > 0) || bar.unverifiedSplit) {
      previous = null;
      if (bar.unverifiedSplit || bar.priceQuarantined) peak = 0;
      continue;
    }
    priced++;
    peak = Math.max(peak, bar.close);
    drawdown = Math.min(drawdown, bar.close / peak - 1);
    if (previous) {
      const value = bar.close / previous.close - 1;
      returns.push(value);
      edges.push([previous.date, bar.date, value]);
    }
    previous = bar;
  }
  const percentile = returns.length >= 20 ? quantile(returns, 0.05) : null;
  return { edges, values: { observations: returns.length, maximumDrawdown: priced ? drawdown : null,
    dailyHistoricalReturn5pct: percentile, dailyHistoricalVaR95: percentile == null ? null : Math.max(0, -percentile),
    annualizedVolatility: detail.volatility_20d, atr14: detail.atr_14d } };
}

function pairedRisk(edges, benchmarkDates) {
  const pairing = [];
  for (const [previous, date, value] of edges) {
    const start = benchmarkDates.get(previous);
    const end = benchmarkDates.get(date);
    if (start > 0 && end > 0) pairing.push([value, end / start - 1]);
  }
  const x = mean(pairing.map((item) => item[0]));
  const y = mean(pairing.map((item) => item[1]));
  const covariance = mean(pairing.map(([a, b]) => (a - x) * (b - y)));
  const stockVariance = mean(pairing.map(([a]) => (a - x) ** 2));
  const benchmarkVariance = mean(pairing.map(([, b]) => (b - y) ** 2));
  return {
    benchmarkObservations: pairing.length,
    beta: pairing.length >= 20 && benchmarkVariance > 0 ? covariance / benchmarkVariance : null,
    correlation: pairing.length >= 20 && stockVariance > 0 && benchmarkVariance > 0 ? covariance / Math.sqrt(stockVariance * benchmarkVariance) : null,
  };
}

export function riskMetrics(detail, benchmark) {
  const benchmarkDates = benchmark instanceof Map ? benchmark : new Map(benchmark?.map((row) => [row.date, row.close]) || []);
  const { edges, values } = stockRisk(detail);
  return { ...values, ...pairedRisk(edges, benchmarkDates) };
}

function canonicalContext(config) {
  if (config[pinnedScope]) return config;
  // Only identity/action caches are shared, at this single anchor and knowledge cutoff.
  return { ...config, universe: wholeCatalog, currentVersion: false, includeAllTimeHigh: false, referenceMode: 'as-of',
    historySource: { end: config.date, indices: new Map(), actions: new Map() }, [pinnedScope]: true };
}

function quarter(date) {
  return `${date.slice(0, 4)}-${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

function packedBar(bar) {
  let mask = 0;
  const values = [];
  for (const [index, name] of barFields.entries()) {
    if (!Object.hasOwn(bar, name) || bar[name] === undefined) continue;
    mask |= 1 << index;
    values.push(bar[name]);
  }
  return [bar.date, mask, ...values];
}

function unpackedBar([date, mask, ...values]) {
  const bar = { date };
  let cursor = 0;
  for (const [index, name] of barFields.entries()) if (mask & (1 << index)) bar[name] = values[cursor++];
  return bar;
}

function chartBlocks(chartBars) {
  const groups = new Map();
  for (const bar of chartBars) {
    const key = quarter(bar.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(packedBar(bar));
  }
  return [...groups.values()].map((bars) => {
    const blob = encodeStoredJson(bars);
    return { first: bars[0][0], last: bars.at(-1)[0], count: bars.length, hash: digest(blob), blob };
  });
}

function productHeader(detail, explicitSplitPriceBasis) {
  const actions = (detail.actions ?? []).filter((action) => action.date <= detail.date);
  const quality = (detail.quality ?? []).filter((issue) => !issue.effective_from || issue.effective_from <= detail.date);
  const splitDates = actions.filter((action) => action.type === 'split' && Number.isFinite(action.factor) && action.factor > 0).map(({ date }) => date);
  const basisGuards = [
    ...(explicitSplitPriceBasis ? splitDates : []),
    ...detail.chartBars.filter((bar) => bar.unverifiedSplit || bar.priceQuarantined).map(({ date }) => date),
    ...quality.filter((issue) => issue.kind === 'split').map((issue) => issue.effective_from).filter(Boolean),
  ];
  return {
    format, ...pick(detail, identityFields), ...pick(detail, highFields),
    ...pick(detail, ['referenceDate', 'referenceMode', 'earliestDate', 'latestDate']),
    calendarFrom: detail.chartBars[0]?.date ?? null, calendarThrough: detail.chartBars.at(-1)?.date ?? null,
    aliases: detail.aliases ?? [], actions, quality,
    unsafeBefore: basisGuards.sort().at(-1) ?? null,
    warnings: (detail.warnings ?? []).filter((message) => !message.startsWith('Security falls outside')),
  };
}

function validDetail(config, detail) {
  if (!config.date || !detail || detail.date !== config.date || !detail.securityId || !Array.isArray(detail.chartBars) ||
      detail.dataVersion != null && detail.dataVersion !== config.dataVersion ||
      detail.calculationVersion != null && detail.calculationVersion !== CALCULATION_VERSION) {
    throw new Error('Prepared stock detail does not match the pinned source date and version');
  }
  if (detail.chartBars.length && (detail.chartBars.at(-1).date !== config.date ||
      detail.chartBars.some((bar, index) => !isoDate(bar?.date) || index && bar.date <= detail.chartBars[index - 1].date))) {
    throw new Error('Prepared stock bars must be ordered through the pinned trading session');
  }
}

const productWriters = new WeakMap();

function productWriter(db) {
  if (productWriters.has(db)) return productWriters.get(db);
  db.exec(schema);
  const check = db.prepare(`SELECT 1 FROM prepared_detail_products WHERE ${keyWhere}`);
  const getRisk = db.prepare(`SELECT value FROM prepared_detail_risk WHERE ${keyWhere} AND benchmark=?`);
  const putRisk = db.prepare(`INSERT INTO prepared_detail_risk VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(calculation_version,basis,security_id,data_version,anchor_date,benchmark) DO UPDATE SET value=excluded.value`);
  const block = db.prepare('INSERT OR IGNORE INTO prepared_detail_blocks VALUES (?,?)');
  const put = db.prepare('INSERT OR IGNORE INTO prepared_detail_products VALUES (?,?,?,?,?,?,?)');
  const writer = {
    has(key) { return Boolean(check.get(...key)); },
    risk(key, ticker) {
      const saved = getRisk.get(...key, ticker)?.value;
      return saved ? decodeStoredJson(saved) : {};
    },
    encode(key, detail, riskByBenchmark, explicitSplitPriceBasis) {
      const existing = writer.has(key);
      const chart = existing ? [] : chartBlocks(detail.chartBars);
      const manifest = chart.map(({ first, last, count, hash }) => ({ first, last, count, hash }));
      return { key, securityId: detail.securityId, chart, riskByBenchmark,
        header: existing ? null : encodeStoredJson(productHeader(detail, explicitSplitPriceBasis)),
        blocks: existing ? null : encodeStoredJson(manifest) };
    },
    commit(records, checkpoint) {
      if (!records.length && !checkpoint) return [];
      const nested = db.isTransaction;
      db.exec(nested ? 'SAVEPOINT prepare_detail' : 'BEGIN IMMEDIATE');
      try {
        const results = records.map(({ key, securityId, chart, header, blocks, riskByBenchmark }) => {
          let written = false;
          let risksWritten = 0;
          let blocksWritten = 0;
          if (header && !writer.has(key)) {
            for (const item of chart) blocksWritten += block.run(item.hash, item.blob).changes;
            written = Boolean(put.run(...key, header, blocks).changes);
          }
          for (const [benchmark, risks] of Object.entries(riskByBenchmark)) {
            const ticker = normalizeSymbol(benchmark);
            const saved = writer.risk(key, ticker);
            const additions = Object.entries(risks).filter(([window]) => !Object.hasOwn(saved, window));
            if (!additions.length) continue;
            for (const [window, value] of additions) saved[window] = value;
            putRisk.run(...key, ticker, encodeStoredJson(saved));
            risksWritten += additions.length;
          }
          return { written, risksWritten, blocksWritten, securityId, date: key[4], dataVersion: key[3] };
        });
        checkpoint?.(results);
        db.exec(nested ? 'RELEASE prepare_detail' : 'COMMIT');
        return results;
      } catch (error) {
        if (nested) db.exec('ROLLBACK TO prepare_detail; RELEASE prepare_detail');
        else if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  productWriters.set(db, writer);
  return writer;
}

export function writePreparedDetail(db, config, detail, { riskByBenchmark = {}, explicitSplitPriceBasis = false } = {}) {
  validDetail(config, detail);
  const writer = productWriter(db);
  return writer.commit([writer.encode(keyFor(config, detail.securityId), detail, riskByBenchmark, explicitSplitPriceBasis)])[0];
}

function findProduct(db, config, securityId, { exactOnly = false } = {}) {
  if (!config.date || !securityId || !present(db)) return { state: 'not-prepared' };
  const exact = exactOnly || config.basis === 'known';
  const comparison = exact ? '=' : '>=';
  const rows = db.prepare(`SELECT data_version,anchor_date FROM prepared_detail_products
    WHERE calculation_version=? AND basis=? AND security_id=? AND data_version<=? AND anchor_date${comparison}?
    ORDER BY (anchor_date=?) DESC,data_version DESC,anchor_date`)
    .all(...keyFor(config, securityId), config.date);
  if (!rows.length) return { state: exact ? 'requires-exact-date' : 'not-prepared' };
  // Chart inputs do not use an observed reference clock, even when the consuming screen does.
  const bounds = reusableArchiveVersions(db, { ...config, referenceMode: 'as-of' }, rows.map(({ data_version }) => data_version));
  const get = db.prepare(`SELECT header,blocks FROM prepared_detail_products WHERE ${keyWhere}`);
  let rejected = false;
  for (const row of rows) {
    if (!usableArchiveRow(bounds, { date: config.date, data_version: row.data_version })) continue;
    const product = get.get(...keyFor(config, securityId, row.data_version, row.anchor_date));
    if (!product) continue;
    const header = decodeStoredJson(product.header);
    if (header.format !== format) continue;
    if (row.anchor_date !== config.date && header.unsafeBefore > config.date) {
      rejected = true;
      continue;
    }
    if (row.anchor_date !== config.date && (!header.calendarFrom || header.calendarFrom > config.date || header.calendarThrough < config.date)) continue;
    return { state: 'ready', header, anchorDate: row.anchor_date, sourceDataVersion: row.data_version, blocks: product.blocks };
  }
  return { state: rejected || exact ? 'requires-exact-date' : 'not-prepared' };
}

export function hasPreparedDetail(db, config, securityId, { exactOnly = false } = {}) {
  return findProduct(db, config, securityId, { exactOnly }).state === 'ready';
}

function readBars(db, manifest, date, lookback) {
  const read = db.prepare('SELECT value FROM prepared_detail_blocks WHERE hash=?');
  const collected = [];
  let remaining = lookback;
  for (let position = manifest.length - 1; position >= 0 && remaining > 0; position--) {
    const block = manifest[position];
    if (block.first > date) continue;
    const payload = read.get(block.hash)?.value;
    if (!payload) throw new Error('Prepared stock chart block is missing');
    const rows = decodeStoredJson(payload).filter(([rowDate]) => rowDate <= date).slice(-remaining);
    collected.push(rows);
    remaining -= rows.length;
  }
  return collected.reverse().flatMap((rows) => rows.map(unpackedBar));
}

function splitProjection(bars, actions, date, anchorDate) {
  const factor = actions.filter((action) => action.type === 'split' && action.date > date && action.date <= anchorDate && action.factor > 0)
    .reduce((value, action) => value * action.factor, 1);
  if (!(factor > 0) || !Number.isFinite(factor)) return null;
  if (factor === 1) return bars;
  const output = [];
  for (const bar of bars) {
    const projected = { ...bar };
    for (const name of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[name])) continue;
      const value = name === 'volume' ? bar[name] / factor : bar[name] * factor;
      if (!Number.isFinite(value)) return null;
      projected[name] = value;
    }
    output.push(projected);
  }
  return output;
}

export function readPreparedChart(db, config, securityId, lookback = 63) {
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 126) throw new RangeError('Invalid stock chart lookback');
  const product = findProduct(db, config, securityId);
  if (product.state !== 'ready') return { state: product.state, bars: [], sourceDataVersion: null };
  const { header, anchorDate, sourceDataVersion } = product;
  const chart = readBars(db, decodeStoredJson(product.blocks), config.date, lookback);
  const bars = anchorDate === config.date ? chart : splitProjection(chart, header.actions, config.date, anchorDate);
  return { state: bars ? 'ready' : 'requires-exact-date', bars: bars ?? [], sourceDataVersion };
}

export function readPreparedDetail(db, config, securityId, { lookback = 252, benchmark = config.benchmark } = {}) {
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > maximumSessions) throw new RangeError('Invalid stock detail lookback');
  const product = findProduct(db, config, securityId);
  const historical = () => readRiskHistory(db, config, securityId, { lookback, benchmark });
  if (product.state !== 'ready') {
    const archived = historical();
    return { state: product.state, riskState: archived.state, detail: archived.risk ? { risk: archived.risk,
      riskSourceDataVersion: archived.sourceDataVersion } : null, sourceDataVersion: null, anchorDate: null, projected: false };
  }
  const { header, anchorDate, sourceDataVersion } = product;
  const projected = anchorDate !== config.date;
  const { actions, quality, aliases, ...metadata } = header;
  const visibleAliases = aliases.filter((alias) => !alias.valid_from || alias.valid_from <= config.date);
  const identity = projected ? visibleAliases.filter((alias) => !alias.valid_to || alias.valid_to >= config.date)
    .toSorted((left, right) => (right.valid_from || '').localeCompare(left.valid_from || '') || left.symbol.localeCompare(right.symbol))[0] : null;
  const chartBars = readBars(db, decodeStoredJson(product.blocks), config.date, lookback);
  const bars = projected ? splitProjection(chartBars, actions, config.date, anchorDate) : chartBars;
  if (!bars) {
    const archived = historical();
    return { state: 'requires-exact-date', riskState: archived.state, detail: archived.risk ? { risk: archived.risk,
      riskSourceDataVersion: archived.sourceDataVersion } : null, sourceDataVersion, anchorDate, projected: false };
  }
  const quotes = bars.filter((bar) => !bar.missing);
  const current = bars.at(-1)?.date === config.date ? bars.at(-1) : null;
  const storedRisk = projected ? null : db.prepare(`SELECT value FROM prepared_detail_risk WHERE ${keyWhere} AND benchmark=?`)
    .get(...keyFor(config, securityId, sourceDataVersion, anchorDate), normalizeSymbol(benchmark))?.value;
  const exactRisk = storedRisk ? decodeStoredJson(storedRisk)[lookback] ?? null : null;
  const archived = exactRisk ? null : historical();
  const risk = exactRisk ?? archived?.risk ?? null;
  const visibleQuality = quality.filter((issue) => !issue.effective_from || issue.effective_from <= config.date);
  const rawMetadata = projected ? {
    symbol: identity?.symbol ?? null, exchange: identity?.exchange ?? null,
    earliestDate: metadata.earliestDate <= config.date ? metadata.earliestDate : null,
    latestDate: quotes.at(-1)?.date ?? null,
    warnings: ['Chart prices project the prepared reconstructed split basis. Historical highs require their exact session.',
      ...(risk ? [] : ['Historical risk has not been prepared for this session.'])],
  } : pick(metadata, [...identityFields, ...highFields, 'earliestDate', 'latestDate', 'warnings']);
  return {
    state: 'ready', riskState: risk ? 'ready' : archived?.state ?? 'not-prepared', sourceDataVersion, anchorDate, projected,
    detail: {
      ...rawMetadata, securityId, date: config.date, dataVersion: config.dataVersion, sourceDataVersion,
      calculationVersion: CALCULATION_VERSION, basis: config.basis, referenceDate: config.date, referenceMode: 'as-of',
      close: current?.close ?? null, traded: current?.traded ?? false,
      aliases: visibleAliases, actions: actions.filter((action) => action.date <= config.date), quality: visibleQuality,
      chartBars: bars, bars: quotes, risk, ...(archived?.risk && { riskSourceDataVersion: archived.sourceDataVersion }),
    },
  };
}

export function createPreparedDetailWriter(db, engine, config, { benchmarks, riskWindows, sourceDb = db } = {}) {
  const tickers = normalizeRiskBenchmarks(benchmarks, config.benchmark);
  const windows = normalizeRiskWindows(riskWindows);
  const prepared = canonicalContext(config);
  if (!config.date || !config.earliestDate) throw new Error('Load prices before preparing stock detail');
  const product = productWriter(db);
  const explicitPriceBasis = sourceDb.prepare(`SELECT 1 FROM price_revisions WHERE security_id=? AND version<=? AND date<=?
    AND split_close>0 LIMIT 1`);
  let maps;
  function benchmarkMaps() {
    if (maps) return maps;
    const from = windows.length ? expectedSessions(config.earliestDate, config.date).slice(-windows.at(-1))[0] : null;
    const benchmarkBars = from ? engine.studyPrices(prepared, tickers, from, config.date) : new Map();
    maps = new Map(tickers.map((ticker) => [ticker, new Map((benchmarkBars.get(ticker) ?? []).map((bar) => [bar.date, bar.close]))]));
    return maps;
  }
  const encode = (detail) => {
    validDetail(config, detail);
    const key = keyFor(config, detail.securityId);
    const saved = windows.length ? tickers.map((ticker) => [ticker, product.risk(key, ticker)]) : [];
    const riskByBenchmark = {};
    for (const window of windows) {
      const missing = saved.filter(([, values]) => !Object.hasOwn(values, window));
      if (!missing.length) continue;
      const { edges, values } = stockRisk({ ...detail, chartBars: detail.chartBars.slice(-window) });
      for (const [ticker] of missing) {
        const risks = riskByBenchmark[ticker] ||= {};
        risks[window] = { ...values, ...pairedRisk(edges, benchmarkMaps().get(ticker)) };
      }
    }
    const hasSplit = detail.actions?.some((action) => action.type === 'split' && action.factor > 0 && action.date <= config.date);
    const explicit = hasSplit && (detail.explicitSplitPriceBasis ?? Boolean(explicitPriceBasis.get(detail.securityId, config.dataVersion, config.date)));
    return product.encode(key, detail, riskByBenchmark, explicit);
  };
  const write = (detail) => product.commit([encode(detail)])[0];
  write.batch = (details, checkpoint) => product.commit(details.map(encode), checkpoint);
  write.ready = (securityId) => {
    const key = keyFor(config, securityId);
    return product.has(key) && (!windows.length || tickers.every((ticker) => {
      const saved = product.risk(key, ticker);
      return windows.every((window) => Object.hasOwn(saved, window));
    }));
  };
  return write;
}

const roster = `FROM securities WHERE EXISTS
  (SELECT 1 FROM price_revisions WHERE security_id=securities.id AND version<=? AND date<=? LIMIT 1)`;

function batchResult(config, row, progress) {
  const done = Boolean(row.complete);
  progress(done ? 1 : row.total ? row.processed / row.total : 0);
  return { status: done ? 'complete' : 'running', done, cursor: done ? null : row.cursor,
    processedSecurities: row.processed, totalSecurities: row.total, written: row.written, date: config.date, dataVersion: config.dataVersion };
}

export function prepareDetailsBatch(db, engine, config, {
  cursor = null, bucketSize = 64, securityIds, benchmarks, riskWindows, progress = () => {}, signal, sourceDb = db,
} = {}) {
  signal?.throwIfAborted();
  if (!config.date || !config.earliestDate) throw new Error('Load prices before preparing stock detail');
  if (!Number.isInteger(bucketSize) || bucketSize < 1 || bucketSize > 256) throw new RangeError('Stock detail bucket size must be 1–256');
  if (cursor != null && typeof cursor !== 'string') throw new TypeError('Stock detail cursor must be a permanent security ID');
  if (securityIds != null && (!Array.isArray(securityIds) || securityIds.length > 256 ||
      securityIds.some((id) => typeof id !== 'string' || !id))) throw new TypeError('Choose up to 256 permanent security IDs');
  const ids = securityIds == null ? null : [...new Set(securityIds)].sort();
  const tickers = normalizeRiskBenchmarks(benchmarks, config.benchmark);
  const windows = normalizeRiskWindows(riskWindows);
  const hash = digest(JSON.stringify([format, CALCULATION_VERSION, config.basis, config.date, config.dataVersion, tickers, windows, ids]));
  db.exec(schema);
  const read = db.prepare('SELECT * FROM prepared_detail_batches WHERE id=?');
  let state = read.get(hash);
  if (!state) {
    const total = ids?.length ?? sourceDb.prepare(`SELECT count(*) AS count ${roster}`).get(config.dataVersion, config.date).count;
    db.prepare('INSERT OR IGNORE INTO prepared_detail_batches(id,total,complete) VALUES (?,?,?)').run(hash, total, Number(total === 0));
    state = read.get(hash);
  }
  if (state.complete) return batchResult(config, state, progress);
  const previous = state.cursor ?? '';
  const requested = ids ? ids.filter((id) => id > previous).slice(0, bucketSize)
    : sourceDb.prepare(`SELECT id ${roster} AND id>? ORDER BY id LIMIT ?`).all(config.dataVersion, config.date, previous, bucketSize).map(({ id }) => id);
  const point = canonicalContext(config);
  const write = createPreparedDetailWriter(db, engine, point, { benchmarks: tickers, riskWindows: windows, sourceDb });
  const exists = ids ? sourceDb.prepare('SELECT 1 FROM securities WHERE id=?') : null;
  const missing = requested.filter((id) => !write.ready(id));
  const sources = engine.detailSources?.(point, { securityIds: missing, lookback: maximumSessions, signal });
  if (missing.length && !sources) engine.snapshot(point, { cache: true, velocity: false });
  const outputs = [];
  const iterator = sources?.[Symbol.iterator]();
  let next = iterator?.next().value;
  for (const id of missing) {
    signal?.throwIfAborted();
    let detail = iterator ? (next?.securityId === id ? next : null) : engine.detail(point, id, maximumSessions, { velocity: false });
    if (iterator && detail) next = iterator.next().value;
    if (!detail && point.basis === 'known' && exists?.get(id)) {
      detail = { securityId: id, date: point.date, dataVersion: point.dataVersion, chartBars: [],
        volatility_20d: null, atr_14d: null, warnings: ['No security identity or quotes were available at the selected session.'] };
    }
    if (detail) outputs.push(detail);
  }
  signal?.throwIfAborted();
  const processed = state.processed + requested.length;
  const done = processed >= state.total || requested.length < bucketSize;
  const advance = db.prepare(`UPDATE prepared_detail_batches SET cursor=?,processed=?,complete=?,written=written+? WHERE id=? AND cursor IS ?`);
  write.batch(outputs, (results) => {
    signal?.throwIfAborted();
    const stored = results.filter(({ written }) => written).length;
    if (!advance.run(requested.at(-1) ?? state.cursor, processed, Number(done), stored, hash, state.cursor).changes) {
      throw new Error('Prepared detail roster advanced concurrently');
    }
  });
  return batchResult(config, read.get(hash), progress);
}

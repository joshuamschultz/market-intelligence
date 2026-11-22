import { gzipSync, gunzipSync } from 'node:zlib';
import { getHeapStatistics } from 'node:v8';
import { createHash } from 'node:crypto';
import { CALCULATION_VERSION, dataVersion, getWorkspace, isoDate, listWorkspace, marketDay, normalizeSymbol, qualityOverrides } from './database.mjs';
import { expectedSessions, isMarketSession, shiftDate, weekEnd } from './calendar.mjs';
import { AVERAGES, DEFAULT_WINDOWS, alignSeries, change, detailRiskInputs, finite, indexPriceSeries, prepareBars, quantile, returnWindow,
  sharePriceIndex, splitFactorBetween, stockMetrics, stockTechnicals } from './metrics.mjs';
import { BUILTIN_MODELS, annotateVelocity, leadershipStatistics, modelInputs, modelWindowBounds, onOrBefore, scoreRanking, topDecileIds, validateModel } from './ranking.mjs';
import { aggregateRows, BREADTH_METRICS, breadthMetric, calculateBreadth, calculateGroups, createBreadthFrame, createGroupFrame, projectBreadth } from './breadth.mjs';

const coreExchanges = ['NYSE', 'NASDAQ'];
const nasdaqCompositeSymbols = ['IXIC', '^IXIC', 'IXIC.INDX'];
const refinements = ['adr', 'reit', 'preferred', 'warrant', 'right', 'unit', 'etf'];
const builtinBreadthKeys = new Set(BREADTH_METRICS.map(({ key }) => key));
const noFacts = Object.freeze([]);
export const UNIVERSES = [
  { id: 'us-core', name: 'US Core', version: 1, definition: { exchanges: coreExchanges, types: ['common'] } },
  { id: 'us-extended', name: 'US Extended', version: 1, definition: { exchanges: [...coreExchanges, 'NYSE AMERICAN'], types: ['common'] } },
  { id: 'us-all', name: 'US All Listed', version: 1, definition: {} },
  { id: 'liquid-us', name: 'Liquid US', version: 1, definition: { exchanges: coreExchanges, types: ['common'], minPrice: 5, minAdv20: 10_000_000 } },
  { id: 'small-cap', name: 'Small Caps', version: 1, definition: { exchanges: coreExchanges, types: ['common'], minCap: 300_000_000, maxCap: 2_000_000_000 } },
  { id: 'nyse', name: 'NYSE Common', version: 1, definition: { exchanges: ['NYSE'], types: ['common'] } },
  { id: 'nasdaq', name: 'Nasdaq Common', version: 1, definition: { exchanges: ['NASDAQ'], types: ['common'] } },
  { id: 'sample', name: 'Research Coverage', version: 1, definition: { includeUnclassified: true, observedOnly: true } },
];
const objectKey = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const viewVersion = (item) => `${item.id}@${item.version}`;
const returnField = (window) => `return_${window}d`;
const numericList = (value, min = 1, max = 7560) => [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(Number)
  .filter((item) => Number.isInteger(item) && item >= min && item <= max))].slice(0, 16).sort((a, b) => a - b);
const textList = (value) => [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).filter(Boolean).map(String))].slice(0, 30);

export function validateUniverse(definition = {}) {
  const limit = (key) => {
    if (definition[key] == null || definition[key] === '') return null;
    const value = Number(definition[key]);
    if (!finite(value) || value < 0) throw new Error(`${key} must be nonnegative`);
    return value;
  };
  const membership = Array.isArray(definition.members) ? definition.members.slice(0, 20_000).map((member) => {
    const item = typeof member === 'string' ? { securityId: member } : member;
    if (!item || typeof item.securityId !== 'string' || !item.securityId) throw new Error('Custom universes require security IDs');
    for (const value of [item.effectiveFrom, item.effectiveTo, item.knownAt]) {
      if (value != null && !isoDate(value)) throw new Error('Universe membership dates must be YYYY-MM-DD');
    }
    if (item.effectiveTo && item.effectiveFrom && item.effectiveTo < item.effectiveFrom) throw new Error('Universe membership has an invalid interval');
    return { securityId: item.securityId, effectiveFrom: item.effectiveFrom || null, effectiveTo: item.effectiveTo || null, knownAt: item.knownAt || null };
  }) : [];
  const exchanges = textList(definition.exchanges).map((value) => value.toUpperCase());
  const types = textList(definition.types).map((value) => value.toLowerCase());
  const minCap = limit('minCap');
  const maxCap = limit('maxCap');
  if (minCap != null && maxCap != null && minCap > maxCap) throw new Error('Minimum market cap must be at most the maximum');
  return { exchanges, types, members: membership, minPrice: limit('minPrice'), minAdv20: limit('minAdv20'), minCap, maxCap,
    includeUnclassified: !!definition.includeUnclassified, observedOnly: !!definition.observedOnly };
}

export function stockBaseFields(fields, additions) {
  if (!additions?.order.length) return fields;
  const ordered = fields.slice();
  for (const [after, field] of additions.order) {
    const position = ordered.indexOf(after);
    if (position < 0) throw new Error(`Stock field ${field} has an unavailable insertion point ${after}`);
    ordered.splice(position + 1, 0, field);
  }
  return ordered;
}

function byLatestEffective(records, date, key, field = null) {
  return records.find((item) => item[key] <= date && item.known_at <= date
    && (!item.effective_to || item.effective_to >= date) && (!field || item[field] > 0));
}

function marketCapAt(facts, actions, bar, date, basis) {
  if (!date || !bar?.traded) return null;
  const cap = byLatestEffective(facts, date, 'effective_date', 'market_cap');
  if (cap?.effective_date === date) return cap.market_cap;
  const shares = byLatestEffective(facts, date, 'effective_date', 'shares');
  if (!shares) return null;
  const comparableActions = basis === 'known' ? actions.filter((action) => action.known_at <= date) : actions;
  return shares.shares * splitFactorBetween(comparableActions, shares.effective_date, date) * bar.rawClose;
}

function snapshotValue(snapshot) {
  const payload = JSON.stringify(snapshot);
  return payload.length < 65536 ? payload : gzipSync(payload, { level: 1 });
}

function parseSnapshot(value) {
  return JSON.parse(typeof value === 'string' ? value : gunzipSync(value));
}

function referenceCutoff(config) {
  if (config.referenceMode === 'latest' && config.basis === 'reconstructed' && config.date === config.latestDate) {
    return config.observedReferenceDate > config.date ? config.observedReferenceDate : config.date;
  }
  return config.date;
}

function basicEligibility(security, definition, date, basis, identifier, type = security.type) {
  if (!identifier || type === 'index' || identifier.exchange === 'INDX') return false;
  const listing = security.listing_date || (basis === 'reconstructed' ? security.first_seen : null);
  if (!listing || listing > date || (security.delisting_date && security.delisting_date < date)) return false;
  if (security.status === 'delisted' && !security.delisting_date && (basis === 'known' || !security.last_seen || security.last_seen < date)) return false;
  if (basis === 'known' && (!security.reference_known || security.reference_known > date || security.reference_inferred || security.listing_inferred)) return false;
  if (definition.members?.length && !definition.members.some((member) => member.securityId === security.id
    && (!member.effectiveFrom || member.effectiveFrom <= date) && (!member.effectiveTo || member.effectiveTo >= date)
    && (!member.knownAt || member.knownAt <= date))) return false;
  if (definition.exchanges?.length && !definition.exchanges.includes(identifier.exchange)) return false;
  if (definition.types?.length && !definition.types.includes(type)) return false;
  if (definition.observedOnly && (!security.first_seen || !security.last_seen || security.last_seen < date)) return false;
  return true;
}

function metricEligibility(stock, rule) {
  return !(rule.minPrice != null && (!finite(stock.close) || stock.close < rule.minPrice))
    && !(rule.minAdv20 != null && (!finite(stock.adv_20d) || stock.adv_20d < rule.minAdv20))
    && !(rule.minCap != null && (!finite(stock.market_cap) || stock.market_cap < rule.minCap))
    && !(rule.maxCap != null && (!finite(stock.market_cap) || stock.market_cap > rule.maxCap));
}

const priceStatements = new WeakMap();

function seriesHistory(db, context, id, start, end) {
  let statements = priceStatements.get(db);
  if (!statements) {
    statements = {
      latest: db.prepare('SELECT * FROM daily_prices WHERE security_id=? AND date>=? AND date<=? ORDER BY date'),
      pinned: db.prepare(`
        SELECT * FROM price_revisions WHERE security_id=? AND date>=? AND date<=? AND version<=? AND known_at<=?
        ORDER BY date DESC, version DESC
      `),
    };
    priceStatements.set(db, statements);
  }
  if (context.currentVersion && context.basis === 'reconstructed') return statements.latest.all(id, start, end);
  // Both keys run in index order. Keep the first available revision per date
  // and restore chronology after selection, without a SQL sort or JS Set.
  const rows = statements.pinned.all(id, start, end, context.dataVersion, context.basis === 'known' ? context.date : '9999-12-31');
  let count = 0;
  let date;
  for (const row of rows) {
    if (row.date === date) continue;
    rows[count++] = row;
    date = row.date;
  }
  rows.length = count;
  return rows.reverse();
}

const compactPriceFields = ['open', 'high', 'low', 'close', 'volume', 'adjusted_close', 'split_close'];
const compactPriceTags = ['date', 'known_at', 'volume_basis', 'source'];

function packPrices(rows, tape) {
  const count = rows.length;
  const values = new Float64Array(count * compactPriceFields.length);
  const tags = new Uint32Array(count * (compactPriceTags.length + 1));
  for (let index = 0; index < count; index++) {
    const row = rows[index];
    for (const [field, key] of compactPriceFields.entries()) {
      values[index * compactPriceFields.length + field] = row[key] ?? NaN;
    }
    for (const [field, key] of compactPriceTags.entries()) {
      const tag = row[key] ?? null;
      if (!tape.tagIds.has(tag)) {
        tape.tagIds.set(tag, tape.tags.length);
        tape.tags.push(tag);
      }
      tags[index * (compactPriceTags.length + 1) + field] = tape.tagIds.get(tag);
    }
    tags[index * (compactPriceTags.length + 1) + compactPriceTags.length] = row.volume_adjusted ? 1 : 0;
  }
  return { count, values, tags };
}

function compactPriceRange(block, tape, start, end) {
  const stride = compactPriceTags.length + 1;
  let first = 0;
  let past = block.count;
  while (first < past) {
    const middle = (first + past) >>> 1;
    if (tape.tags[block.tags[middle * stride]] < start) first = middle + 1;
    else past = middle;
  }
  return {
    *[Symbol.iterator]() {
      for (let index = first; index < block.count; index++) {
        const tagOffset = index * stride;
        const date = tape.tags[block.tags[tagOffset]];
        if (date > end) break;
        const valueOffset = index * compactPriceFields.length;
        yield { date, known_at: tape.tags[block.tags[tagOffset + 1]], volume_basis: tape.tags[block.tags[tagOffset + 2]],
          source: tape.tags[block.tags[tagOffset + 3]], volume_adjusted: block.tags[tagOffset + 4],
          open: block.values[valueOffset], high: block.values[valueOffset + 1], low: block.values[valueOffset + 2],
          close: block.values[valueOffset + 3], volume: block.values[valueOffset + 4],
          adjusted_close: block.values[valueOffset + 5], split_close: block.values[valueOffset + 6] };
      }
    },
  };
}

function beforeOrAtPrice(rows, date) {
  let first = 0;
  let past = rows.length;
  while (first < past) {
    const middle = (first + past) >>> 1;
    if (rows[middle].date <= date) first = middle + 1;
    else past = middle;
  }
  return first - 1;
}

function actionHistory(db, context, id, overrides = []) {
  const cache = context.historySource?.actions;
  if (cache?.has(id)) return cache.get(id);
  const rows = db.prepare(`
    SELECT * FROM corporate_actions WHERE security_id=? AND version<=? AND known_at<=?
    ORDER BY date, type, version DESC
  `).all(id, context.dataVersion, context.basis === 'known' ? context.date : '9999-12-31');
  const seen = new Set();
  const selected = rows.filter((row) => {
    const key = `${row.date}:${row.type}`;
    return !seen.has(key) && seen.add(key) && !(row.type === 'split'
      && overrides.some((item) => item.kind === 'split' && item.effective_from <= row.date && row.date <= item.effective_to));
  });
  cache?.set(id, selected);
  return selected;
}

function historyHighs(record, sessions, series) {
  const listing = !record.listing_inferred && record.listing_date;
  const firstSession = listing && expectedSessions(listing, shiftDate(listing, 14))[0];
  let high = 0;
  let firstIndex = null;
  let through = null;
  let observations = 0;
  let boundary = 'loaded_start';
  for (let index = series.length - 1; index >= 0; index--) {
    const bar = series[index];
    if (firstSession && sessions[index] < firstSession) break;
    if (bar?.priceQuarantined) { boundary = 'price_quarantine'; break; }
    if (bar?.traded && finite(bar.high)) {
      high = Math.max(high, bar.high);
      through ??= bar.date;
      firstIndex = index;
      observations++;
    }
    if (bar?.unverifiedSplit && bar.date !== firstSession) { boundary = 'unverified_split'; break; }
    if (sessions[index] === firstSession) { boundary = 'verified_listing'; break; }
  }
  const from = firstIndex == null ? null : sessions[firstIndex];
  const expected = firstIndex == null ? 0 : sessions.length - firstIndex;
  const complete = firstSession && firstSession === from && observations === expected;
  return { allTimeHigh: complete ? high : null, loadedHistoryHigh: high || null,
    loadedHistoryHighFrom: from, loadedHistoryHighThrough: through,
    loadedHistoryHighObservations: observations, loadedHistoryHighExpected: expected, loadedHistoryHighBoundary: boundary };
}

export function createEngine(db) {
  const cache = new Map();
  const qualityCache = new Map();
  const observedRanges = new Map();
  const stockRowShapes = new WeakMap();
  const detailInputScopes = new Map();
  const floatFacts = new WeakMap();
  const observedById = db.prepare('SELECT date FROM price_revisions WHERE security_id=? AND version<=? ORDER BY date LIMIT 1');
  const recentById = db.prepare('SELECT date FROM price_revisions WHERE security_id=? AND version<=? ORDER BY date DESC LIMIT 1');
  const currentReference = db.prepare("SELECT definition FROM reference_revisions WHERE security_id=? AND version<=? ORDER BY version DESC LIMIT 1");
  const datedReference = db.prepare("SELECT definition FROM reference_revisions WHERE security_id=? AND version<=? AND known_at<=? ORDER BY version DESC LIMIT 1");

  function securityQuality(config, id) {
    const knownThrough = config.basis === 'known' ? config.date : '9999-12-31';
    const key = `${config.dataVersion}:${knownThrough}`;
    if (!qualityCache.has(key)) {
      const grouped = new Map();
      for (const row of qualityOverrides(db, { version: config.dataVersion, knownThrough })) {
        if (!grouped.has(row.security_id)) grouped.set(row.security_id, []);
        grouped.get(row.security_id).push(row);
      }
      qualityCache.set(key, grouped);
      if (qualityCache.size > 12) qualityCache.delete(qualityCache.keys().next().value);
    }
    return qualityCache.get(key).get(id) || [];
  }
  function resolveItem(kind, builtins, id, version) {
    const builtin = builtins.find((item) => item.id === id && (!version || item.version === version));
    return builtin || getWorkspace(db, kind, id, version);
  }
  function context(input = {}) {
    const latestVersion = dataVersion(db);
    const requestedVersion = input.dataVersion == null || input.dataVersion === '' ? latestVersion : Number(input.dataVersion);
    if (!Number.isInteger(requestedVersion) || requestedVersion < 0 || requestedVersion > latestVersion) {
      throw new Error('Data version is outside the warehouse range');
    }
    const version = (value) => value == null || value === '' ? null : Number(value);
    const universe = resolveItem('universe', UNIVERSES, input.universe || 'us-core', version(input.universeVersion));
    const model = resolveItem('ranking-model', BUILTIN_MODELS, input.model || 'composite', version(input.modelVersion));
    if (!universe || !model) throw new Error('Unknown universe or ranking model version');
    const basis = input.basis === 'known' ? 'known' : 'reconstructed';
    const benchmark = normalizeSymbol(input.benchmark || 'SPY');
    if (!benchmark || benchmark.length > 30) throw new Error('Invalid benchmark ticker');
    const currentVersion = requestedVersion === latestVersion;
    const latest = (currentVersion
      ? db.prepare('SELECT date FROM daily_prices ORDER BY date DESC LIMIT 1').get()
      : db.prepare('SELECT max(date) AS date FROM price_revisions WHERE version<=?').get(requestedVersion))?.date ?? null;
    const earliest = (currentVersion
      ? db.prepare('SELECT date FROM daily_prices ORDER BY date LIMIT 1').get()
      : db.prepare('SELECT min(date) AS date FROM price_revisions WHERE version<=?').get(requestedVersion))?.date ?? null;
    const requestedDate = input.date || latest;
    if (requestedDate && !isoDate(requestedDate)) throw new Error('As-of date must be YYYY-MM-DD');
    let date = requestedDate;
    if (date && date < '1900-01-01') throw new Error('Market dates start in 1900');
    if (date && latest && date > latest) date = latest;
    while (date && !isMarketSession(date)) date = shiftDate(date, -1);
    const definition = validateModel(model.definition);
    const currentMarketDay = marketDay();
    const referenceMode = input.reference === 'latest' && basis === 'reconstructed' ? 'latest' : 'as-of';
    if (input.observedReferenceDate != null && (!isoDate(input.observedReferenceDate) || input.observedReferenceDate > currentMarketDay)) {
      throw new Error('Observed reference date must be a valid, nonfuture date');
    }
    const observedReferenceDate = input.observedReferenceDate || currentMarketDay;
    const breadthKeys = textList(input.breadthKeys).filter((key) => !builtinBreadthKeys.has(key) && breadthMetric(key)).sort();
    const extraFromBreadth = breadthKeys.map((key) => key.match(/_(\d+)d$/)?.[1]).filter(Boolean);
    const config = {
      date, requestedDate, latestDate: latest, earliestDate: earliest, basis, benchmark, referenceMode, observedReferenceDate,
      universe: { ...universe, definition: validateUniverse(universe.definition) },
      model: { ...model, definition },
      classification: input.classification || 'provider', currentVersion, dataVersion: requestedVersion,
      themes: input.themes ?? listWorkspace(db, 'theme'),
      includeAllTimeHigh: [true, 'true', '1', 1].includes(input.includeAllTimeHigh),
      averages: [...new Set([...AVERAGES, ...numericList(input.averages)])],
      windows: [...new Set([...DEFAULT_WINDOWS, ...numericList([...numericList(input.windows), ...extraFromBreadth])])],
      volumeWindows: numericList(input.volumeWindows),
      breadthKeys, threshold: input.threshold == null ? 0.98 : Number(input.threshold),
    };
    if (!(config.threshold > 0 && config.threshold <= 1)) throw new Error('Coverage threshold must be greater than zero and at most one');
    return config;
  }

  function calendarStart(config) {
    const fixed = config.model.definition.windows.filter((item) => item.kind === 'fixed').map((item) => item.start).sort()[0];
    const lookbacks = config.model.definition.windows.map((item) => {
      const unit = { sessions: 2, months: 32, quarters: 94, years: 367, ytd: 367, fixed: 0 }[item.kind];
      return unit * ((item.length || 1) + item.offset);
    });
    let start = shiftDate(config.date, -Math.max(420, ...lookbacks, ...config.windows.map((n) => n * 2 + 15),
      ...config.averages.map((n) => n * 5 + 15), ...config.volumeWindows.map((n) => n * 2 + 15)));
    if (fixed && fixed < start) start = shiftDate(fixed, -14);
    if (start < '1900-01-01') start = '1900-01-01';
    return start;
  }

  function sessionsFor(config) {
    const start = calendarStart(config);
    const source = config.historySource;
    const end = source?.indices.get(config.date);
    if (!source?.dateWindows || source.start > start || end == null) return expectedSessions(start, config.date);
    const key = `${start}:${config.date}`;
    let sessions = source.dateWindows.get(key);
    if (!sessions) {
      const from = onOrBefore(source.sessions, shiftDate(start, -1)) + 1;
      sessions = source.sessions.slice(from, end + 1);
      source.dateWindows.set(key, sessions);
    }
    return sessions;
  }

  function references(config) {
    const source = config.historySource?.retained ?? config.historySource;
    if (source?.references) return source.references;
    const latest = db.prepare('SELECT * FROM securities').all();
    const records = new Map();
    if (!config.currentVersion && !observedRanges.has(config.dataVersion)) {
      const ranges = new Map();
      for (const row of latest) ranges.set(row.id, {
        first_seen: observedById.get(row.id, config.dataVersion)?.date,
        last_seen: recentById.get(row.id, config.dataVersion)?.date,
      });
      observedRanges.set(config.dataVersion, ranges);
      if (observedRanges.size > 3) observedRanges.delete(observedRanges.keys().next().value);
    }
    const ranges = observedRanges.get(config.dataVersion);
    for (const row of latest) {
      const stored = config.basis === 'known' ? datedReference.get(row.id, config.dataVersion, config.date)
        : currentReference.get(row.id, config.dataVersion);
      if (stored) {
        const facts = JSON.parse(stored.definition);
        const observed = config.currentVersion ? row : ranges.get(row.id);
        records.set(row.id, { ...facts, first_seen: observed?.first_seen, last_seen: observed?.last_seen });
      } else if (config.currentVersion && config.basis === 'reconstructed') {
        const identifiers = db.prepare('SELECT * FROM identifiers WHERE security_id=? ORDER BY valid_from, symbol').all(row.id);
        records.set(row.id, { ...row, identifiers });
      }
    }
    if (source) source.references = records;
    return records;
  }

  function identifierAt(reference, date) {
    let best = null;
    for (const item of reference.identifiers ?? []) {
      if (item.valid_from > date || (item.valid_to && item.valid_to < date)) continue;
      if (!best || item.valid_from > best.valid_from || (item.valid_from === best.valid_from && item.symbol.localeCompare(best.symbol) < 0)) best = item;
    }
    return best;
  }

  function readFundamentals(config, securityId = null) {
    const source = !securityId ? config.historySource?.retained ?? config.historySource : null;
    if (source?.fundamentals) return source.fundamentals;
    const cutoff = source?.referenceThrough ?? referenceCutoff(source ? { ...config, date: source.end } : config);
    const filter = securityId ? 'AND security_id=?' : '';
    const records = groupedQuery(`
      SELECT * FROM fundamentals WHERE version<=? AND effective_date<=? AND known_at<=? ${filter}
      ORDER BY security_id, effective_date DESC, known_at DESC, version DESC
    `, config.dataVersion, cutoff, cutoff, ...(securityId ? [securityId] : []));
    if (source) source.fundamentals = records;
    return records;
  }

  function readClassifications(config) {
    const source = config.historySource?.retained ?? config.historySource;
    if (source?.classifications?.has(config.classification)) return source.classifications.get(config.classification);
    const cutoff = source?.referenceThrough ?? referenceCutoff(source ? { ...config, date: source.end } : config);
    const records = groupedQuery(`
      SELECT * FROM classifications WHERE version<=? AND effective_from<=? AND known_at<=? AND system=?
      ORDER BY security_id, effective_from DESC, known_at DESC, version DESC
    `, config.dataVersion, cutoff, cutoff, config.classification);
    if (source?.classifications) source.classifications.set(config.classification, records);
    return records;
  }

  function readSubtypes(config, securityId = null) {
    const source = !securityId ? config.historySource?.retained ?? config.historySource : null;
    if (source?.subtypes) return source.subtypes;
    const cutoff = source?.referenceThrough ?? referenceCutoff(source ? { ...config, date: source.end } : config);
    const filter = securityId ? 'AND security_id=?' : '';
    const records = groupedQuery(`
      SELECT * FROM instrument_type_observations WHERE version<=? AND effective_date<=? AND known_at<=? ${filter}
      ORDER BY security_id,effective_date DESC,captured_at DESC,version DESC
    `, config.dataVersion, cutoff, cutoff, ...(securityId ? [securityId] : []));
    if (source) source.subtypes = records;
    return records;
  }

  function instrumentType(record, observations, cutoff) {
    const latest = observations?.find((row) => row.known_at <= cutoff && row.effective_date <= cutoff);
    const subtype = record.type === 'common' && refinements.includes(latest?.subtype) ? latest.subtype : null;
    return { type: subtype || record.type, providerType: record.type, subtype,
      subtypeSource: subtype ? latest.source : null, subtypeEffectiveDate: subtype ? latest.effective_date : null,
      subtypeKnownAt: subtype ? latest.captured_at : null };
  }

  function dailyReferenceFrame(config, refs) {
    const source = config.historySource;
    if (source?.dailyFrame?.date === config.date) return source.dailyFrame;
    const identifiers = new Map();
    const benchmarks = new Map();
    for (const record of refs.values()) {
      const identifier = identifierAt(record, config.date);
      if (!identifier) continue;
      identifiers.set(record.id, identifier);
      const { symbol } = identifier;
      if (!benchmarks.has(symbol) && (!nasdaqCompositeSymbols.includes(symbol) || record.type === 'index' || identifier.exchange === 'INDX')) {
        benchmarks.set(symbol, record);
      }
    }
    const frame = { date: config.date, identifiers, benchmarks, cutoffs: new Map(), classifications: new Map(),
      stockFrames: new Map(), marketFrames: new Map(), baseRows: new Map(), breadthFrames: new Map(), groupFrames: new Map(),
      financialFacts: new Map(), views: new Map() };
    if (source) source.dailyFrame = frame;
    return frame;
  }

  function referenceMembership(config, refs, frame, referenceDate) {
    if (!frame.cutoffs.has(referenceDate)) frame.cutoffs.set(referenceDate, { instruments: new Map(), members: new Map() });
    const cutoff = frame.cutoffs.get(referenceDate);
    const key = JSON.stringify([config.universe.id, config.universe.definition]);
    if (cutoff.members.has(key)) return cutoff.members.get(key);
    const subtypeExclusions = new Map();
    const candidates = [];
    const subtypes = readSubtypes(config);
    for (const record of refs.values()) {
      const identifier = frame.identifiers.get(record.id);
      if (!identifier) continue;
      let instrument = cutoff.instruments.get(record.id);
      if (!instrument) {
        instrument = instrumentType(record, subtypes.get(record.id), referenceDate);
        cutoff.instruments.set(record.id, instrument);
      }
      if (basicEligibility(record, config.universe.definition, config.date, config.basis, identifier, instrument.type)) {
        candidates.push({ record, identifier, instrument });
      } else if (config.universe.id === 'us-core' && instrument.subtype && record.provider === 'eodhd' && record.status === 'active'
        && basicEligibility(record, config.universe.definition, config.date, config.basis, identifier)) {
        subtypeExclusions.set(record.id, instrument.subtype);
      }
    }
    const membership = { candidates, subtypeExclusions };
    cutoff.members.set(key, membership);
    return membership;
  }

  function groupedMarket(config, frame, traded, benchmarkReturn) {
    const themes = config.themes ?? listWorkspace(db, 'theme');
    if (!config.historySource) return calculateGroups(traded, themes, config.date, benchmarkReturn);
    const key = JSON.stringify([config.universe, referenceCutoff(config), calendarStart(config), config.classification,
      config.benchmark, config.averages, config.volumeWindows, config.windows, themes]);
    let scope = frame.groupFrames.get(key);
    if (!scope) {
      scope = createGroupFrame(traded, themes, config.date);
      frame.groupFrames.set(key, scope);
    }
    return calculateGroups(traded, themes, config.date, benchmarkReturn, scope);
  }

  function groupedQuery(sql, ...values) {
    const items = new Map();
    for (const row of db.prepare(sql).iterate(...values)) {
      if (!items.has(row.security_id)) items.set(row.security_id, []);
      items.get(row.security_id).push(row);
    }
    return items;
  }

  function newHistorySource(configs, dates, shareFeatures = false, retained = null) {
    const start = configs.map((config) => calendarStart({ ...config, date: dates[0] })).sort()[0];
    const end = dates.at(-1);
    const sessions = expectedSessions(start, end);
    const referenceThrough = configs.map((config) => referenceCutoff({ ...config, date: end })).sort().at(-1);
    return { start, end, referenceThrough, sessions, requestedDates: dates, retained, indices: new Map(sessions.map((date, index) => [date, index])),
      series: new Map(), actions: retained?.actions ?? new Map(), references: null, fundamentals: null, classifications: new Map(), bars: 0,
      dateWindows: new Map(), features: shareFeatures && configs.length > 1 ? new Map() : null, featureDate: null,
      rankInputs: shareFeatures ? new Map() : null, rankings: shareFeatures ? new Map() : null,
      highs: configs.some(({ includeAllTimeHigh }) => includeAllTimeHigh) ? new Map() : null,
      highFacts: new Map(),
      viewDate: null, views: shareFeatures ? new Map() : null,
      maxBars: Math.max(10_000, Math.floor(getHeapStatistics().heap_size_limit * 0.42 / 300)) };
  }

  function historyBatch(config, dates) {
    if (config.basis !== 'reconstructed' || !dates.length) return { ...config, currentVersion: false };
    return { ...config, currentVersion: false, historySource: newHistorySource([config], dates) };
  }

  function retainHistoryInputs(configs, dates, maxPriceBytes) {
    const end = dates.at(-1);
    const needsHighs = configs.some(({ includeAllTimeHigh }) => includeAllTimeHigh);
    const start = configs.flatMap((config) => [calendarStart({ ...config, date: dates[0] }), needsHighs && config.earliestDate])
      .filter(Boolean).sort()[0];
    const referenceThrough = configs.map((config) => referenceCutoff({ ...config, date: end })).sort().at(-1);
    return { start, end, referenceThrough, requestedDates: dates, actions: new Map(), classifications: new Map(),
      highs: new Map(), highBytes: 0, maxHighBytes: Math.floor(maxPriceBytes * 0.24),
      tape: { blocks: new Map(), tagIds: new Map(), tags: [], bytes: 0, maxBytes: maxPriceBytes } };
  }

  function batchPriceHistory(config, securityId, start, end) {
    const retained = config.historySource?.retained;
    if (!retained || start < retained.start || end > retained.end) return seriesHistory(db, config, securityId, start, end);
    const { tape } = retained;
    let block = tape.blocks.get(securityId);
    if (!block) {
      if (tape.bytes >= tape.maxBytes) return seriesHistory(db, config, securityId, start, end);
      const rows = seriesHistory(db, config, securityId, retained.start, retained.end);
      const bytes = rows.length * (compactPriceFields.length * 8 + (compactPriceTags.length + 1) * 4);
      if (tape.bytes + bytes > tape.maxBytes) {
        return rows.filter((row) => row.date >= start && row.date <= end);
      }
      block = packPrices(rows, tape);
      tape.bytes += bytes;
      tape.blocks.set(securityId, block);
    }
    return compactPriceRange(block, tape, start, end);
  }

  function* batchSnapshots(configurations, { dates, signal, tileSize = 60, sparseRows = false, shouldBuild } = {}) {
    if (!Array.isArray(configurations) || !configurations.length || !Array.isArray(dates)) {
      throw new TypeError('Batch snapshots need configurations and session dates');
    }
    if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > 120
      || dates.some((date, index) => !isoDate(date) || !isMarketSession(date) || index > 0 && date <= dates[index - 1])) {
      throw new RangeError('Provide ascending unique exchange sessions and a tile size from 1 to 120');
    }
    const revisions = new Map();
    for (const config of configurations) {
      if (config.basis !== 'reconstructed') continue;
      if (!revisions.has(config.dataVersion)) revisions.set(config.dataVersion, []);
      revisions.get(config.dataVersion).push(config);
    }
    const maxPriceBytes = Math.floor(getHeapStatistics().heap_size_limit * 0.35 / Math.max(1, revisions.size));
    const retained = new Map(dates.length > tileSize ? [...revisions].map(([version, configs]) =>
      [version, retainHistoryInputs(configs, dates, maxPriceBytes)]) : []);
    for (let start = 0; start < dates.length; start += tileSize) {
      signal?.throwIfAborted();
      const tile = dates.slice(start, start + tileSize);
      const sources = new Map([...revisions].map(([version, configs]) => [version, newHistorySource(configs, tile, true, retained.get(version))]));
      for (const date of tile) {
        signal?.throwIfAborted();
        const eligible = configurations.map((input, contextIndex) => ({ input, contextIndex }))
          .filter(({ input, contextIndex }) => !shouldBuild || shouldBuild(input, contextIndex, date));
        const results = eligible.toSorted((a, b) => a.input.windows.length - b.input.windows.length).map(({ input, contextIndex }) => {
          const config = { ...input, date, requestedDate: date, currentVersion: false };
          const source = input.basis === 'reconstructed' ? sources.get(input.dataVersion) : null;
          const point = source ? { ...config, historySource: source, sparseRows } : config;
          const result = source ? projectBatchSnapshot(point) : snapshot(point, { persist: false, cache: false });
          // The bulk writer consumes parts without copying every shared field into each context.
          const stockRows = sparseRows ? result.stocks.map((stock) => {
            return stockRowShapes.get(stock) ?? { base: null, overrides: stock, baseAfter: 0 };
          }) : null;
          return { item: { config, snapshot: result, ...(stockRows && { stockRows }), ...(shouldBuild && { contextIndex }) }, contextIndex };
        });
        yield { date, results: results.sort((a, b) => a.contextIndex - b.contextIndex).map(({ item }) => item) };
      }
    }
  }

  function* batchAdvanceDecline(config, { dates, signal } = {}) {
    if (!dates?.length) return;
    if (!Array.isArray(dates) || dates.some((date, index) => !isoDate(date) || !isMarketSession(date) || index > 0 && date <= dates[index - 1])) {
      throw new RangeError('Provide ascending unique exchange sessions');
    }
    const definition = config.universe.definition;
    if (config.basis !== 'reconstructed' || ['minPrice', 'minAdv20', 'minCap', 'maxCap'].some((key) => definition[key] != null)) {
      for (const { date, results: [{ snapshot: result }] } of batchSnapshots([config], { dates, signal })) {
        yield { date, advancers: result.breadth.advancers.numerator, decliners: result.breadth.decliners.numerator,
          comparable: result.breadth.advancers.denominator, traded: result.coverage.traded };
      }
      return;
    }
    const first = expectedSessions(shiftDate(dates[0], -14), shiftDate(dates[0], -1)).at(-1);
    const last = dates.at(-1);
    const sessions = expectedSessions(first, last);
    const indices = new Map(sessions.map((date, index) => [date, index]));
    const rows = dates.map((date) => ({ date, advancers: 0, decliners: 0, comparable: 0, traded: 0 }));
    const source = { start: first, end: last, referenceThrough: referenceCutoff({ ...config, date: last }), actions: new Map() };
    const pinned = { ...config, date: last, currentVersion: false, historySource: source };
    const subtypes = readSubtypes(pinned);
    for (const record of references(pinned).values()) {
      signal?.throwIfAborted();
      if (!record.first_seen || record.first_seen > last || record.delisting_date && record.delisting_date < dates[0]) continue;
      // Exclude a known never-matching venue before reading its full price history.
      if (definition.exchanges?.length && !record.identifiers?.some((alias) => definition.exchanges.includes(alias.exchange)
        && alias.valid_from <= last && (!alias.valid_to || alias.valid_to >= dates[0]))) continue;
      const quality = securityQuality(pinned, record.id);
      const actions = actionHistory(db, pinned, record.id, quality);
      const boundaries = actions.filter(({ type, date }) => type === 'split' && date > dates[0] && date <= last).map(({ date }) => date);
      const prices = seriesHistory(db, pinned, record.id, first, last);
      let targetStart = 0;
      for (const nextSplit of [...boundaries, null]) {
        const anchor = nextSplit ? shiftDate(nextSplit, -1) : last;
        const end = onOrBefore(dates, anchor) + 1;
        if (end <= targetStart) continue;
        const start = sessions[indices.get(dates[targetStart]) - 1];
        const priceStart = beforeOrAtPrice(prices, shiftDate(start, -1)) + 1;
        const priceEnd = beforeOrAtPrice(prices, anchor) + 1;
        const bars = prepareBars(prices.slice(priceStart, priceEnd), actions, anchor, { provenance: false, overrides: quality });
        const byDate = new Map(bars.map((bar) => [bar.date, bar]));
        for (let index = targetStart; index < end; index++) {
          const date = dates[index];
          const bar = byDate.get(date);
          if (!bar?.traded || date < config.earliestDate) continue;
          const identifier = identifierAt(record, date);
          const cutoff = referenceCutoff({ ...config, date });
          const { type } = instrumentType(record, subtypes.get(record.id), cutoff);
          if (!basicEligibility(record, definition, date, config.basis, identifier, type)) continue;
          const result = rows[index];
          result.traded++;
          const before = byDate.get(sessions[indices.get(date) - 1]);
          const value = before?.traded && !bar.unverifiedSplit ? change(bar.close, before.close) : null;
          if (value == null) continue;
          result.comparable++;
          if (value > 0) result.advancers++;
          else if (value < 0) result.decliners++;
        }
        targetStart = end;
      }
    }
    yield* rows;
  }

  function projectBatchSnapshot(config) {
    if (!config.earliestDate || config.date < config.earliestDate) return empty(config);
    const frame = dailyReferenceFrame(config, references(config));
    const key = JSON.stringify([config.universe, config.model, config.benchmark, referenceCutoff(config), calendarStart(config),
      config.averages, config.volumeWindows, config.includeAllTimeHigh, config.threshold, config.themes]);
    const candidates = frame.stockFrames.get(key) ?? [];
    const market = candidates.find(({ config: base }) => base.classification === config.classification
      && base.windows.every((window) => config.windows.includes(window)))
      ?? candidates.find(({ config: base }) => base.windows.every((window) => config.windows.includes(window)));
    if (!market) {
      const result = snapshot(config, { persist: false, cache: false });
      candidates.push({ config, result });
      frame.stockFrames.set(key, candidates);
      return result;
    }
    const regrouped = market.config.classification !== config.classification;
    const extraWindows = config.windows.filter((window) => !market.config.windows.includes(window));
    const classifications = regrouped ? readClassifications(config) : null;
    const cutoff = referenceCutoff(config);
    const dates = extraWindows.length ? sessionsFor(config) : null;
    // A Monitor variant contributes only extra return values. Keep the original
    // base identity and carry their insertion order separately to the writer.
    const windowKey = config.windows.join(',');
    if (!frame.views.has(windowKey)) frame.views.set(windowKey, new WeakMap());
    const technicals = frame.views.get(windowKey);
    let insertionOrder;
    function extendReturns(base, row) {
      if (technicals.has(base)) return technicals.get(base);
      insertionOrder ??= config.windows.flatMap((window, index) => Object.hasOwn(base, returnField(window)) ? []
        : [[returnField(config.windows[index - 1]), returnField(window)]]);
      const series = securitySeries(config, row.securityId, dates);
      const values = {};
      for (const [, field] of insertionOrder) {
        const window = Number(field.slice(7, -1));
        values[field] = market.config.windows.includes(window) ? row[field]
          : returnWindow(series, series.length - 1 - window, series.length - 1);
      }
      const additions = { order: insertionOrder, values };
      technicals.set(base, additions);
      return additions;
    }
    const stocks = regrouped || extraWindows.length ? market.result.stocks.map((row) => {
      const shape = stockRowShapes.get(row);
      const base = shape?.base;
      const additions = extraWindows.length ? extendReturns(base ?? row, row) : shape?.additions;
      if (base && !regrouped) {
        const projected = Object.assign(Object.create(row), additions.values);
        stockRowShapes.set(projected, { ...shape, additions });
        return projected;
      }
      const prototype = base && additions ? Object.assign(Object.create(base), additions.values) : base;
      const projected = base ? Object.create(prototype) : extraWindows.length
        ? Object.fromEntries(stockBaseFields(Object.keys(row), additions).map((field) => [field, Object.hasOwn(additions.values, field) ? additions.values[field] : row[field]]))
        : { ...row };
      if (regrouped) {
        const facts = byLatestEffective(classifications.get(row.securityId) || [], cutoff, 'effective_from');
        projected.sector = facts?.sector ?? null;
        projected.industry = facts?.industry ?? null;
        projected.subindustry = facts?.subindustry ?? null;
        projected.classificationKnownAt = facts?.known_at ?? null;
      }
      if (base) {
        projected.rsComponents = row.rsComponents;
        if (row.traded && row.rsComponents.every(finite)) projected.rsScore = row.rsScore;
        projected.rsRank = row.rsRank;
        projected.rsPercentile = row.rsPercentile;
        projected.rsScore ??= null;
        stockRowShapes.set(projected, { base, overrides: projected, baseAfter: 0, ...(additions && { additions }) });
      }
      return projected;
    }) : market.result.stocks;
    const traded = stocks.filter((stock) => stock.traded);
    const { groups, aggregates, coverage, breadth } = market.result;
    const result = { ...market.result, classificationSystem: config.classification, stocks,
      groups: regrouped ? groupedMarket(config, frame, traded, aggregates.benchmarkReturn21d) : groups,
      coverage: regrouped ? { ...coverage, classifications: traded.filter((stock) => stock.industry != null).length } : coverage,
      breadth: projectBreadth(breadth, traded, config.breadthKeys, { regrouped }) };
    // Prefer an existing narrower frame of this taxonomy for the next superset.
    candidates.push({ config, result });
    return result;
  }

  function hasFloat(fundamentals) {
    if (!fundamentals.length) return false;
    let available = floatFacts.get(fundamentals);
    if (available === undefined) {
      available = fundamentals.some(({ float }) => float > 0);
      floatFacts.set(fundamentals, available);
    }
    return available;
  }

  function floatAdjusted(bars, fundamentals, actions, date) {
    if (!hasFloat(fundamentals)) return bars;
    return bars.map((bar) => {
      if (!bar) return bar;
      const fact = byLatestEffective(fundamentals, bar.date, 'effective_date', 'float');
      return fact ? { ...bar, float: fact.float * splitFactorBetween(actions, fact.effective_date, date) } : bar;
    });
  }

  function cachedSeries(config, id, sessions, fundamentals) {
    const source = config.historySource;
    if (!source || !sessions.length) return null;
    const from = source.indices.get(sessions[0]);
    const to = source.indices.get(sessions.at(-1));
    if (from == null || to == null) return null;
    const floats = hasFloat(fundamentals);
    let views = null;
    if (source.views) {
      if (source.viewDate !== config.date) {
        source.viewDate = config.date;
        source.views.clear();
      }
      const key = `${from}:${to}:${Number(floats)}`;
      if (!source.views.has(key) && source.views.size < 5) source.views.set(key, new Map());
      views = source.views.get(key);
      if (views?.has(id)) return views.get(id);
    }
    function load(anchor, actions) {
      if (source.bars + source.sessions.length > source.maxBars) return null;
      const prices = batchPriceHistory(config, id, source.start, anchor);
      const overrides = securityQuality(config, id);
      const bars = prepareBars(prices, actions, anchor, { provenance: false, overrides });
      const prepared = bars.length ? alignSeries(bars, source.sessions) : [];
      source.bars += prepared.length;
      return { prepared, actions, anchor };
    }
    function localSeries(actions) {
      const overrides = securityQuality(config, id);
      const prices = batchPriceHistory(config, id, sessions[0], sessions.at(-1));
      const bars = prepareBars(prices, actions, config.date, { provenance: false, overrides });
      const aligned = bars.length ? alignSeries(bars, sessions) : [];
      const result = floats ? floatAdjusted(aligned, fundamentals, actions, config.date) : aligned;
      views?.set(id, result);
      return result;
    }
    let cache = source.series.get(id);
    if (!cache) {
      const overrides = securityQuality(config, id);
      const actions = actionHistory(db, config, id, overrides);
      cache = load(source.end, actions);
      if (!cache) return localSeries(actions);
      cache.splits = actions.filter((action) => action.type === 'split' && action.date <= source.end && action.date > source.start)
        .map(({ date }) => date);
      source.series.set(id, cache);
    }
    const nextSplit = cache.splits.find((date) => date > config.date);
    if (nextSplit) {
      cache.vintages ??= new Map();
      let vintage = cache.vintages.get(nextSplit);
      if (!vintage) {
        vintage = load(shiftDate(nextSplit, -1), cache.actions);
        if (!vintage) return localSeries(cache.actions);
        cache.vintages.set(nextSplit, vintage);
      }
      cache = vintage;
    }
    if (!cache.prepared.length) return [];
    if (floats && !cache.floated) cache.floated = floatAdjusted(cache.prepared, fundamentals, cache.actions, cache.anchor);
    const prices = floats ? cache.floated : cache.prepared;
    const indexName = floats ? 'floatedIndex' : 'index';
    cache[indexName] ??= indexPriceSeries(prices);
    const aligned = prices.slice(from, to + 1);
    if (!cache.nextObserved) {
      cache.nextObserved = new Int32Array(prices.length);
      let next = prices.length;
      for (let position = prices.length - 1; position >= 0; position--) {
        if (prices[position]) next = position;
        cache.nextObserved[position] = next;
      }
    }
    const first = cache.nextObserved[from] - from;
    if (aligned[first]?.unverifiedSplit) {
      aligned[first] = { ...aligned[first], unverifiedSplit: false };
      // The local view has a different break boundary from the shared index.
      views?.set(id, aligned);
      return aligned;
    }
    sharePriceIndex(aligned, cache[indexName], from);
    views?.set(id, aligned);
    return aligned;
  }

  function preparedHighs(config, record, dates, priceSeries) {
    const source = config.historySource;
    const start = record.first_seen < dates[0] ? record.first_seen : dates[0];
    if (!source?.highs) {
      if (start === dates[0]) return historyHighs(record, dates, priceSeries);
      const allDates = expectedSessions(start, config.date);
      return historyHighs(record, allDates, securitySeries(config, record.id, allDates));
    }
    if (source.highDate !== config.date) {
      source.highFacts.clear();
      source.highDate = config.date;
    }
    const key = `${record.id}:${start}`;
    if (source.highFacts.has(key)) return source.highFacts.get(key);
    const window = source.retained ?? source;
    let cache = window.highs.get(record.id);
    if (!cache) {
      const overrides = securityQuality(config, record.id);
      const actions = actionHistory(db, config, record.id, overrides);
      cache = { anchors: new Map(), actions, overrides,
        splits: actions.filter(({ type, date }) => type === 'split' && date <= window.end).map(({ date }) => date) };
      window.highs.set(record.id, cache);
    }
    const splitIndex = cache.splits.findIndex((date) => date > config.date);
    const anchor = splitIndex >= 0 ? shiftDate(cache.splits[splitIndex], -1) : window.end;
    let timeline = cache.anchors.get(anchor);
    if (!timeline) {
      const end = onOrBefore(window.requestedDates, anchor) + 1;
      const previousSplit = splitIndex === 0 ? null : cache.splits.at(splitIndex < 0 ? -1 : splitIndex - 1);
      const from = previousSplit ? onOrBefore(window.requestedDates, shiftDate(previousSplit, -1)) + 1 : 0;
      const count = end - from;
      const bytes = 29 * count;
      if (window.maxHighBytes && window.highBytes + bytes > window.maxHighBytes) {
        return preparedHighs({ ...config, historySource: { ...source, retained: null } }, record, dates, priceSeries);
      }
      const listing = !record.listing_inferred && record.listing_date;
      const firstSession = listing && expectedSessions(listing, shiftDate(listing, 14))[0];
      const earliest = [window.start, record.first_seen].filter(Boolean).sort()[0];
      if (!window.highSessions) {
        const calendarStart = config.earliestDate < window.start ? config.earliestDate : window.start;
        window.highSessions = expectedSessions(calendarStart, window.end);
      }
      const sessions = window.highSessions;
      const firstIndex = onOrBefore(sessions, shiftDate(earliest, -1)) + 1;
      const finalIndex = onOrBefore(sessions, anchor);
      const quotes = batchPriceHistory(config, record.id, earliest, anchor);
      const bars = prepareBars(quotes, cache.actions, anchor, { provenance: false, overrides: cache.overrides });
      timeline = { from, end, firstSession, high: new Float64Array(count), dates: new Int32Array(count * 5), boundary: new Uint8Array(count) };
      let high = 0, first = -1, through = -1, observations = 0, boundary = 0;
      let barIndex = 0;
      let output = from;
      for (let index = firstIndex; index <= finalIndex; index++) {
        const date = sessions[index];
        while (bars[barIndex] && bars[barIndex].date < date) barIndex++;
        while (output < end && window.requestedDates[output] < date) output++;
        if (firstSession && date < firstSession) continue;
        const bar = bars[barIndex]?.date === date ? bars[barIndex] : null;
        if (bar?.priceQuarantined || (bar?.unverifiedSplit && date !== firstSession)) {
          high = 0;
          first = -1;
          through = -1;
          observations = 0;
          boundary = bar.priceQuarantined ? 2 : 3;
        } else if (date === firstSession) boundary = 1;
        if (bar?.traded && finite(bar.high) && !bar.priceQuarantined) {
          if (first < 0) first = index;
          through = index;
          observations++;
          high = Math.max(high, bar.high);
        }
        if (window.requestedDates[output] !== date || output >= end) continue;
        const position = output - from;
        const expected = first < 0 ? 0 : index - first + 1;
        timeline.high[position] = high;
        timeline.dates.set([first + 1, through + 1, observations, expected,
          firstSession && sessions[first] === firstSession && observations === expected ? 1 : 0], position * 5);
        timeline.boundary[position] = boundary;
      }
      cache.anchors.set(anchor, timeline);
      if (window.maxHighBytes) window.highBytes += bytes;
    }
    const target = onOrBefore(window.requestedDates, config.date) - timeline.from;
    let result;
    if (target >= 0 && target < timeline.high.length && window.requestedDates[target + timeline.from] === config.date) {
      const { high, dates: values, boundary, firstSession } = timeline;
      const offset = target * 5;
      const state = boundary[target] === 1 && firstSession < start ? 0 : boundary[target];
      result = { allTimeHigh: values[offset + 4] ? high[target] : null, loadedHistoryHigh: high[target] || null,
        loadedHistoryHighFrom: window.highSessions[values[offset] - 1] ?? null,
        loadedHistoryHighThrough: window.highSessions[values[offset + 1] - 1] ?? null,
        loadedHistoryHighObservations: values[offset + 2], loadedHistoryHighExpected: values[offset + 3],
        loadedHistoryHighBoundary: ['loaded_start', 'verified_listing', 'price_quarantine', 'unverified_split'][state] };
    } else {
      const allDates = start === dates[0] ? dates : expectedSessions(start, config.date);
      result = historyHighs(record, allDates, start === dates[0] ? priceSeries : securitySeries(config, record.id, allDates));
    }
    source.highFacts.set(key, result);
    return result;
  }

  function securitySeries(config, id, sessions, fundamentals = []) {
    const cached = cachedSeries(config, id, sessions, fundamentals);
    if (cached) return cached;
    const prices = seriesHistory(db, config, id, sessions[0], sessions.at(-1));
    if (!prices.length) return [];
    const overrides = securityQuality(config, id);
    const actions = actionHistory(db, config, id, overrides);
    const aligned = alignSeries(prepareBars(prices, actions, config.date, {
      provenance: !config.historySource || config.historySource.provenance === true, overrides,
    }), sessions);
    return floatAdjusted(aligned, fundamentals, actions, config.date);
  }

  function empty(config) {
    return {
      date: config.date, requestedDate: config.requestedDate, universe: config.universe,
      model: config.model, benchmark: config.benchmark, basis: config.basis,
      referenceMode: referenceCutoff(config) !== config.date ? 'latest' : 'as-of', referenceDate: referenceCutoff(config),
      classificationSystem: config.classification, dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION,
      coverage: { state: 'empty', ratio: null, expected: null, listed: 0, traded: 0, completenessThreshold: config.threshold },
      stocks: [], groups: [], breadth: calculateBreadth([], config.breadthKeys), aggregates: aggregateRows([]),
    };
  }

  function build(config) {
    const result = empty(config);
    if (!config.earliestDate || !config.date || config.date < config.earliestDate) return result;
    const dates = sessionsFor(config);
    const modelBounds = modelWindowBounds(config.model.definition, dates, config.date);
    const refs = references(config);
    const fundamentals = readFundamentals(config);
    const classifications = readClassifications(config);
    const referenceDate = referenceCutoff(config);
    const frame = dailyReferenceFrame(config, refs);
    const { benchmarks } = frame;
    const { candidates, subtypeExclusions } = referenceMembership(config, refs, frame, referenceDate);
    const benchmarkRef = benchmarks.get(config.benchmark);
    const marks = benchmarkRef ? securitySeries(config, benchmarkRef.id, dates) : [];
    const benchmarkSeries = benchmarkRef?.type === 'index' ? marks.map((bar) =>
      bar?.close > 0 && !bar.traded ? { ...bar, traded: true } : bar) : marks;
    const benchmarkInputs = modelInputs(benchmarkSeries, modelBounds, config.model.definition);
    const featureOptions = { averages: config.averages, windows: config.windows, volumeWindows: config.volumeWindows, benchmarkSeries };
    let features = null;
    let inputsById = null;
    let rankingKey = null;
    const source = config.historySource;
    const featureRecipe = JSON.stringify([dates[0], benchmarkRef?.id ?? null, config.averages, config.windows, config.volumeWindows]);
    if (source?.features) {
      if (source.featureDate !== config.date) {
        source.features.clear();
        source.rankInputs.clear();
        source.rankings.clear();
        source.featureDate = config.date;
      }
      if (!source.features.has(featureRecipe) && source.features.size < 4) source.features.set(featureRecipe, new Map());
      features = source.features.get(featureRecipe);
      const rankInputsKey = JSON.stringify([dates[0], benchmarkRef?.id ?? null, config.model.definition]);
      if (!source.rankInputs.has(rankInputsKey) && source.rankInputs.size < 16) source.rankInputs.set(rankInputsKey, new Map());
      inputsById = source.rankInputs.get(rankInputsKey);
      rankingKey = JSON.stringify([rankInputsKey, referenceDate, config.universe.id, config.universe.definition,
        config.volumeWindows, config.averages, config.windows]);
    }
    const risks = config.model.definition.method === 'risk' ? new WeakMap() : null;
    const financialKey = `${referenceDate}:${dates[0] ?? ''}`;
    if (source && !frame.financialFacts.has(financialKey)) frame.financialFacts.set(financialKey, new Map());
    const financialFacts = frame.financialFacts.get(financialKey);
    const classificationKey = `${referenceDate}:${config.classification}`;
    if (source && !frame.classifications.has(classificationKey)) frame.classifications.set(classificationKey, new Map());
    const datedClassifications = frame.classifications.get(classificationKey);
    const baseKey = JSON.stringify([financialKey, featureRecipe, config.includeAllTimeHigh]);
    if (config.sparseRows && !frame.baseRows.has(baseKey)) frame.baseRows.set(baseKey, new Map());
    const stockBases = frame.baseRows.get(baseKey);
    for (const { record, identifier, instrument } of candidates) {
      const facts = fundamentals.get(record.id) || noFacts;
      let classification = datedClassifications?.get(record.id);
      if (classification === undefined) {
        classification = byLatestEffective(classifications.get(record.id) || noFacts, referenceDate, 'effective_from') ?? null;
        datedClassifications?.set(record.id, classification);
      }
      let stock = stockBases?.get(record.id);
      let priceSeries;
      if (!stock) {
        priceSeries = record.first_seen && record.first_seen <= config.date ? securitySeries(config, record.id, dates, facts) : noFacts;
        const dated = stockBases ? null : classification;
        let financial = financialFacts?.get(record.id);
        if (!financial) {
          const currentFacts = byLatestEffective(facts, referenceDate, 'effective_date');
          const floatFact = byLatestEffective(facts, referenceDate, 'effective_date', 'float');
          const sharesFact = byLatestEffective(facts, referenceDate, 'effective_date', 'shares');
          const capFact = byLatestEffective(facts, referenceDate, 'effective_date', 'market_cap');
          financial = {
            float: floatFact?.float ?? null, shares: sharesFact?.shares ?? null, marketCap: capFact?.market_cap ?? null,
            fundamentalsDate: currentFacts?.effective_date ?? null, fundamentalsKnownAt: currentFacts?.known_at ?? null,
            floatDate: floatFact?.effective_date ?? null, floatKnownAt: floatFact?.known_at ?? null,
            sharesDate: sharesFact?.effective_date ?? null, sharesKnownAt: sharesFact?.known_at ?? null,
            fundamentalsAgeDays: currentFacts ? Math.round((Date.parse(referenceDate) - Date.parse(currentFacts.effective_date)) / 86_400_000) : null,
            calculatedMarketCap: capFact?.effective_date === referenceDate ? capFact.market_cap : null,
            marketCapDate: capFact?.effective_date === referenceDate ? capFact.effective_date : null,
          };
          if (currentFacts && priceSeries.length) {
            const actions = actionHistory(db, config, record.id, securityQuality(config, record.id));
            const tradeCap = marketCapAt(facts, actions, priceSeries.at(-1), config.date, config.basis);
            if (tradeCap != null) {
              financial.calculatedMarketCap = tradeCap;
              financial.marketCapDate = config.date;
            }
            financial.priorMarketCap = marketCapAt(facts, actions, priceSeries.at(-2), dates.at(-2), config.basis);
            financial.priorMarketCap21d = marketCapAt(facts, actions, priceSeries.at(-22), dates.at(-22), config.basis);
          }
          financialFacts?.set(record.id, financial);
        }
        const { priorMarketCap, priorMarketCap21d, ...metadataFacts } = financial;
        const metadata = {
          securityId: record.id, symbol: identifier.symbol, name: record.name, exchange: identifier.exchange,
          ...instrument, tradingStatus: record.status || 'unknown', isin: record.isin ?? null,
          listingDate: record.listing_date, observedFrom: record.first_seen ?? null, delistingDate: record.delisting_date,
          referenceKnown: record.reference_known, referenceVerified: !!record.listing_date && !record.listing_inferred && !record.reference_inferred && record.reference_known <= config.date,
          ...metadataFacts,
          sector: dated?.sector ?? null, industry: dated?.industry ?? null,
          subindustry: dated?.subindustry ?? null, classificationKnownAt: dated?.known_at ?? null,
        };
        if (Object.hasOwn(financial, 'priorMarketCap')) {
          metadata.priorMarketCap = priorMarketCap;
          metadata.priorMarketCap21d = priorMarketCap21d;
        }
        let highs;
        if (config.includeAllTimeHigh && priceSeries.at(-1)?.traded) {
          highs = preparedHighs(config, record, dates, priceSeries);
        }
        let technicals = features?.get(record.id);
        if ((features || config.sparseRows) && !technicals) {
          technicals = stockTechnicals(priceSeries, featureOptions);
          features?.set(record.id, technicals);
        }
        const identity = highs ? { ...metadata, ...highs } : metadata;
        stock = stockMetrics(identity, priceSeries, { ...featureOptions, technicals, allTimeHigh: highs?.allTimeHigh });
        if (config.includeAllTimeHigh) stock.distance_loaded_history_high = change(stock.close, highs?.loadedHistoryHigh);
        stockBases?.set(record.id, stock);
      }
      if (!metricEligibility(stock, config.universe.definition)) continue;
      if (stockBases) {
        const base = stock;
        stock = Object.create(base);
        stock.sector = classification?.sector ?? null;
        stock.industry = classification?.industry ?? null;
        stock.subindustry = classification?.subindustry ?? null;
        stock.classificationKnownAt = classification?.known_at ?? null;
        stockRowShapes.set(stock, { base, overrides: stock, baseAfter: 0 });
      }
      let inputs = inputsById?.get(record.id);
      if (!inputs) {
        priceSeries ??= record.first_seen && record.first_seen <= config.date ? securitySeries(config, record.id, dates, facts) : noFacts;
        inputs = modelInputs(priceSeries, modelBounds, config.model.definition);
        inputsById?.set(record.id, inputs);
      }
      stock.rsComponents = inputs.components;
      if (risks) risks.set(stock, inputs.risk);
      result.stocks.push(stock);
    }
    const previousRanks = rankingKey && source.rankings.get(rankingKey);
    if (previousRanks && previousRanks.length === result.stocks.length
      && previousRanks.every((row, index) => row.securityId === result.stocks[index].securityId)) {
      for (const [index, stock] of result.stocks.entries()) {
        const prior = previousRanks[index];
        if (stock.traded && stock.rsComponents.every(finite)) stock.rsScore = prior.rsScore;
        stock.rsRank = prior.rsRank;
        stock.rsPercentile = prior.rsPercentile;
        stock.rsScore ??= null;
      }
    } else {
      scoreRanking(result.stocks, config.model.definition, benchmarkInputs, risks);
      if (rankingKey && source.rankings.size < 72) source.rankings.set(rankingKey, result.stocks);
    }
    const traded = result.stocks.filter((stock) => stock.traded);
    const intervalReturn = returnWindow(benchmarkSeries, dates.length - 22, dates.length - 1);
    const marketKey = source ? JSON.stringify([config.universe, referenceDate, dates[0], config.benchmark,
      config.averages, config.windows, config.volumeWindows]) : null;
    const marketFrame = marketKey ? frame.marketFrames.get(marketKey) : null;
    const priorTwenty = benchmarkSeries.slice(-21);
    const benchmarkHigh20d = priorTwenty.length === 21 && priorTwenty.every((bar, index) => bar?.traded && (index === 0 || !bar.unverifiedSplit))
      ? priorTwenty.at(-1).close > Math.max(...priorTwenty.slice(0, -1).map((bar) => bar.close)) : null;
    result.groups = groupedMarket(config, frame, traded, intervalReturn);
    let stockCounts;
    if (!marketFrame && stockBases) {
      if (!frame.breadthFrames.has(baseKey)) frame.breadthFrames.set(baseKey, createBreadthFrame(refs.size));
      stockCounts = frame.breadthFrames.get(baseKey)(traded, (row) => stockRowShapes.get(row).base);
    }
    result.breadth = marketFrame ? projectBreadth(marketFrame.result.breadth, traded, config.breadthKeys, {
      regrouped: marketFrame.classification !== config.classification, reranked: true,
    }) : calculateBreadth(traded, config.breadthKeys, stockCounts);
    if (marketFrame) result.aggregates = marketFrame.result.aggregates;
    else {
      const nasdaqStocks = result.stocks.filter((row) => row.exchange === 'NASDAQ' && row.type === 'common'
        && (!row.listingDate || row.listingDate <= dates.at(-2)));
      const nasdaqReturns = nasdaqStocks.map((row) => row.return_1d).filter(finite);
      const nasdaqDates = dates.slice(-2);
      let nasdaqBenchmark = null;
      let nasdaqReturn = null;
      for (const symbol of [...nasdaqCompositeSymbols, 'QQQ']) {
        const reference = benchmarks.get(symbol);
        if (!reference) continue;
        const bars = symbol === config.benchmark ? benchmarkSeries : securitySeries(config, reference.id, nasdaqDates);
        const last = bars.at(-1);
        const value = symbol === 'QQQ' ? returnWindow(bars, bars.length - 2, bars.length - 1)
          : last?.unverifiedSplit ? null : change(last?.close, bars.at(-2)?.close);
        if (!finite(value)) continue;
        nasdaqBenchmark = symbol;
        nasdaqReturn = value;
        break;
      }
      const benchmarkReturn = returnWindow(benchmarkSeries, dates.length - 2, dates.length - 1);
      const benchmarkComparable = finite(benchmarkReturn) ? traded.filter((row) => finite(row.return_1d)) : [];
      result.aggregates = {
        ...aggregateRows(traded),
        benchmarkReturn, benchmarkHigh20d,
        benchmarkReturn20d: returnWindow(benchmarkSeries, dates.length - 21, dates.length - 1),
        benchmarkReturn21d: intervalReturn, benchmarkClose: benchmarkSeries.at(-1)?.close ?? null,
        nasdaqBenchmark, nasdaqReturn, nasdaqBenchmarkProxy: nasdaqBenchmark === 'QQQ',
        nasdaqMedianReturn: quantile(nasdaqReturns, 0.5), nasdaqObservations: nasdaqReturns.length, nasdaqExpected: nasdaqStocks.length,
        outperformBenchmarkShare: benchmarkComparable.length
          ? benchmarkComparable.filter((row) => row.return_1d > benchmarkReturn).length / benchmarkComparable.length : null,
        outperformBenchmarkObservations: benchmarkComparable.length,
      };
      if (marketKey) frame.marketFrames.set(marketKey, { result, classification: config.classification });
    }
    if (!Object.hasOwn(frame, 'ledger')) {
      frame.ledger = db.prepare(`SELECT session_imports.*, ingestion_runs.provider FROM session_imports
        JOIN ingestion_runs ON ingestion_runs.id=session_imports.run_id
        WHERE date=? AND session_imports.version<=? AND session_imports.scope='full' ORDER BY session_imports.version DESC LIMIT 1`)
        .get(config.date, config.dataVersion);
    }
    const { ledger } = frame;
    const core = config.universe.id === 'us-core';
    const sourceExpected = core ? ledger?.expected ?? null : null;
    const sourceReceived = ledger?.eligible_received ?? null;
    const excludedBySubtype = Object.fromEntries(refinements.map((type) => [type, 0]));
    for (const subtype of subtypeExclusions.values()) excludedBySubtype[subtype]++;
    let excludedExpected = 0;
    let excludedReceived = 0;
    let receivedExact = null;
    let expected = sourceExpected;
    let received = sourceReceived;
    if (subtypeExclusions.size && sourceExpected != null && ledger?.provider === 'eodhd') {
      const roster = db.prepare('SELECT security_id FROM session_capture_expected WHERE run_id=? AND date=?')
        .all(ledger.run_id, config.date);
      const capturedIds = db.prepare('SELECT security_id FROM session_capture_received WHERE run_id=? AND date=?')
        .all(ledger.run_id, config.date);
      if (roster.length === sourceExpected && capturedIds.length === sourceReceived) {
        const rosterIds = new Set(roster.map(({ security_id }) => security_id));
        const retainedIds = new Set(traded.map((stock) => stock.securityId));
        excludedExpected = roster.filter(({ security_id }) => subtypeExclusions.has(security_id)).length;
        excludedReceived = capturedIds.filter(({ security_id }) => rosterIds.has(security_id) && subtypeExclusions.has(security_id)).length;
        expected -= excludedExpected;
        received = capturedIds.filter(({ security_id }) => rosterIds.has(security_id) && retainedIds.has(security_id)).length;
        receivedExact = true;
      } else {
        // A legacy counts-only ledger cannot show which refined instruments it counted.
        received = null;
        excludedReceived = null;
        receivedExact = false;
      }
    }
    const count = received == null ? null : Math.min(received, traded.length);
    const ratio = expected > 0 && count != null ? count / expected : null;
    const missingPrices = result.stocks.length - traded.length;
    const state = !traded.length ? (result.stocks.length ? 'partial' : 'empty')
      : ratio != null && ratio >= config.threshold && ratio <= 1 && traded.length <= expected && !config.universe.definition.observedOnly
        ? 'complete' : 'partial';
    const priorCoverage = marketFrame?.result.coverage;
    let ranked = 0, classified = 0, knownReference = 0, splitAnomalies = 0, float = 0;
    const requirements = [20, 50, 200, 22, 253, 2].map((lookback) => dates.at(-lookback));
    const comparable = new Int32Array(requirements.length);
    for (const stock of traded) {
      if (stock.rsRank != null) ranked++;
      if (stock.industry != null) classified++;
      if (priorCoverage) continue;
      if (stock.float != null) float++;
      if (stock.referenceVerified) knownReference++;
      if (stock.rejected_split) splitAnomalies++;
      for (let index = 0; index < requirements.length; index++) {
        if (requirements[index] && (!stock.listingDate || stock.listingDate <= requirements[index])) comparable[index]++;
      }
    }
    let unverifiedProviderCommon = 0, delisted = 0;
    if (!priorCoverage) {
      for (const stock of result.stocks) {
        if (stock.providerType === 'common' && !stock.subtype) unverifiedProviderCommon++;
        if (stock.delistingDate != null || stock.tradingStatus === 'delisted') delisted++;
      }
    }
    result.coverage = {
      state, ratio, expected, listed: result.stocks.length, traded: traded.length, received, sourceExpected, sourceReceived,
      subtypeCoverage: { excluded: subtypeExclusions.size, excludedBySubtype, excludedExpected, excludedReceived, receivedExact,
        unverifiedProviderCommon: priorCoverage?.subtypeCoverage.unverifiedProviderCommon ?? unverifiedProviderCommon },
      missingPrices, completenessThreshold: config.threshold,
      comparableExpected: priorCoverage?.comparableExpected ?? {
        above_20d: comparable[0], above_50d: comparable[1], above_200d: comparable[2],
        positive_21d: comparable[3], new_high_252d: comparable[4], new_low_252d: comparable[4],
        volumeParticipation: comparable[5], classification: traded.length,
      },
      ranked,
      float: priorCoverage?.float ?? float,
      classifications: classified,
      knownReference: priorCoverage?.knownReference ?? knownReference,
      splitAnomalies: priorCoverage?.splitAnomalies ?? splitAnomalies,
      delisted: priorCoverage?.delisted ?? delisted,
      sessionRun: ledger?.run_id ?? null,
      message: state === 'complete' ? null : 'Available data does not establish complete coverage of this universe.',
    };
    return result;
  }

  function definitionKey(config) {
    return objectKey({
      benchmark: config.benchmark, basis: config.basis, classification: config.classification,
      referenceDate: config.referenceMode === 'latest' ? config.observedReferenceDate : null,
      averages: config.averages, windows: config.windows, volume: config.volumeWindows, breadth: config.breadthKeys,
      allTimeHigh: config.includeAllTimeHigh,
      threshold: config.threshold, themes: (config.themes ?? listWorkspace(db, 'theme')).map(viewVersion),
    });
  }

  function pinnedBuild(config) {
    if (!config.currentVersion) return build(config);
    const withinTransaction = db.isTransaction;
    if (!withinTransaction) db.exec('BEGIN');
    try {
      const currentVersion = config.currentVersion && config.dataVersion === dataVersion(db);
      const result = build({ ...config, currentVersion });
      if (!withinTransaction) db.exec('COMMIT');
      return result;
    } catch (error) {
      if (!withinTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function snapshotAvailable(config, { velocity = false } = {}) {
    if (!config.date) return false;
    return !!db.prepare(`SELECT 1 FROM snapshots WHERE kind=? AND date=? AND universe=? AND model=? AND data_version=?
      AND calculation_version=? AND definition_key=?`).get(velocity ? 'market-velocity' : 'market', config.date,
        viewVersion(config.universe), viewVersion(config.model), config.dataVersion, CALCULATION_VERSION, definitionKey(config));
  }

  function snapshot(config, { velocity = false, persist = true, cache: useCache = persist, persistVelocity = false } = {}) {
    if (!config.date) return empty(config);
    const args = [config.date, viewVersion(config.universe), viewVersion(config.model),
      config.dataVersion, CALCULATION_VERSION, definitionKey(config)];
    const select = db.prepare(`
      SELECT value FROM snapshots WHERE kind=? AND date=? AND universe=? AND model=? AND data_version=?
      AND calculation_version=? AND definition_key=?
    `);
    const write = db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const enrichedKey = ['market-velocity', ...args].join('/');
    if (velocity) {
      const cached = useCache ? cache.get(enrichedKey) : null;
      if (cached) return { ...cached, requestedDate: config.requestedDate };
      const stored = select.get('market-velocity', ...args);
      if (stored) {
        const ranked = parseSnapshot(stored.value);
        if (useCache) remember(enrichedKey, ranked);
        return { ...ranked, requestedDate: config.requestedDate };
      }
    }
    const keys = ['market', ...args];
    const cacheKey = keys.join('/');
    function remember(key, value) {
      cache.set(key, value);
      if (cache.size > 10) cache.delete(cache.keys().next().value);
    }
    let base = useCache ? cache.get(cacheKey) : null;
    if (!base) {
      const stored = select.get(...keys);
      base = stored ? parseSnapshot(stored.value) : pinnedBuild(config);
      if (persist && !stored && config.earliestDate && config.date >= config.earliestDate) {
        write.run(...keys, snapshotValue(base), new Date().toISOString());
      }
      if (useCache) remember(cacheKey, base);
    }
    const selected = { ...base, requestedDate: config.requestedDate };
    if (!velocity) return selected;
    const weekly = [];
    const end = weekEnd(config.date);
    for (let i = 1; i <= 12; i++) {
      const date = expectedSessions(shiftDate(end, -7 * i - 4), shiftDate(end, -7 * i)).at(-1);
      weekly.push(date >= config.earliestDate ? snapshot({ ...config, date, requestedDate: date }, { persist, cache: useCache }) : { stocks: [], groups: [] });
    }
    const result = { ...selected, stocks: selected.stocks.map((row) => ({ ...row })), groups: selected.groups.map((row) => ({ ...row })) };
    annotateVelocity(result, weekly);
    if (persistVelocity && config.earliestDate && config.date >= config.earliestDate) {
      write.run('market-velocity', ...args, snapshotValue(result), new Date().toISOString());
      if (useCache) remember(enrichedKey, result);
    }
    return result;
  }

  function history(config, { from, to, limit = 120, cadence = 'daily', project = (row) => row, persist = false, velocity = false } = {}) {
    if (!config.date || !config.earliestDate) return [];
    for (const date of [from, to]) if (date && !isoDate(date)) throw new Error('History dates must be YYYY-MM-DD');
    const end = to && to < config.date ? to : config.date;
    const start = from && from > config.earliestDate ? from : config.earliestDate;
    const dates = expectedSessions(start, end);
    const list = cadence === 'weekly' ? dates.filter((date, index) => !dates[index + 1] || weekEnd(date) !== weekEnd(dates[index + 1])) : dates;
    let prior = null;
    return list.slice(-Math.max(1, Math.min(2600, Number(limit) || 120))).map((date) => {
      const current = snapshot({ ...config, date, requestedDate: date }, { persist, velocity });
      const previousDate = expectedSessions(shiftDate(date, -12), shiftDate(date, -1)).at(-1);
      const previousIds = prior?.date === previousDate ? prior.ids : previousDate >= config.earliestDate
        ? topDecileIds(snapshot({ ...config, date: previousDate, requestedDate: previousDate }, { persist })) : null;
      prior = { date, ids: topDecileIds(current) };
      return project({ ...current, aggregates: { ...current.aggregates, ...leadershipStatistics(current, previousDate, previousIds) } });
    });
  }

  function findSecurity(config, id) {
    if (!config.date) return null;
    const refs = references(config);
    if (refs.has(id)) return refs.get(id);
    const symbol = normalizeSymbol(id);
    const matches = [...refs.values()].filter((record) => identifierAt(record, config.date)?.symbol === symbol);
    return matches.length === 1 ? matches[0] : null;
  }

  function detailFrame(config, record, dates, facts, lookback) {
    const prices = securitySeries(config, record.id, dates, facts);
    const bars = prices.filter(Boolean);
    const quality = securityQuality(config, record.id).filter((row) => row.effective_from <= config.date);
    const actions = actionHistory(db, config, record.id, quality);
    const highs = historyHighs(record, dates, prices);
    return { prices, highs, frame: {
      ...highs, bars: bars.slice(-lookback), chartBars: dates.slice(-lookback).map((date, index, sessions) =>
        prices[dates.length - sessions.length + index] || { date, close: null, volume: null, traded: false, missing: true }),
      actions, quality, dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION,
      aliases: record.identifiers, earliestDate: bars[0]?.date || null, latestDate: bars.at(-1)?.date || null,
    } };
  }

  function detail(config, id, lookback = 252, { velocity = true } = {}) {
    const record = findSecurity(config, id);
    if (!record) return null;
    const identifier = identifierAt(record, config.date);
    const dates = expectedSessions(config.earliestDate, config.date);
    const facts = readFundamentals(config, record.id).get(record.id) || [];
    const referenceDate = referenceCutoff(config);
    const instrument = instrumentType(record, readSubtypes(config, record.id).get(record.id), referenceDate);
    const { prices, highs, frame } = detailFrame(config, record, dates, facts, lookback);
    const { actions, quality } = frame;
    const selected = snapshot(config, { velocity }).stocks.find((row) => row.securityId === record.id);
    const float = byLatestEffective(facts, referenceDate, 'effective_date', 'float');
    const shares = byLatestEffective(facts, referenceDate, 'effective_date', 'shares');
    const cap = byLatestEffective(facts, referenceDate, 'effective_date', 'market_cap');
    const currentCap = cap?.effective_date === referenceDate ? cap.market_cap
      : marketCapAt(facts, actions, prices.at(-1), config.date, config.basis);
    const stock = selected ? { ...selected } : stockMetrics({
      securityId: record.id, symbol: identifier?.symbol || id, name: record.name, exchange: identifier?.exchange || record.exchange,
      ...instrument, float: float?.float ?? null, shares: shares?.shares ?? null, calculatedMarketCap: currentCap,
      priorMarketCap: marketCapAt(facts, actions, prices.at(-2), dates.at(-2), config.basis),
      priorMarketCap21d: marketCapAt(facts, actions, prices.at(-22), dates.at(-22), config.basis),
      fundamentalsDate: facts[0]?.effective_date ?? null, fundamentalsKnownAt: facts[0]?.known_at ?? null,
      floatDate: float?.effective_date ?? null, floatKnownAt: float?.known_at ?? null,
      sharesDate: shares?.effective_date ?? null, sharesKnownAt: shares?.known_at ?? null,
    }, prices, { allTimeHigh: highs.allTimeHigh, averages: config.averages, windows: config.windows, volumeWindows: config.volumeWindows });
    stock.distance_all_time_high = change(stock.close, highs.allTimeHigh);
    stock.distance_loaded_history_high = change(stock.close, highs.loadedHistoryHigh);
    return { ...stock, date: config.date, referenceDate, referenceMode: referenceDate !== config.date ? 'latest' : 'as-of',
      classificationSystem: config.classification, ...frame,
      warnings: [!selected && 'Security falls outside the selected analysis universe.', !facts.length && 'Dated float and shares outstanding are unavailable.', stock.fundamentalsAgeDays > 90 && 'The most recent dated fundamentals are more than 90 calendar days old.', config.basis === 'reconstructed' && 'Price history uses the selected ingested data version.', !highs.allTimeHigh && 'Full history since listing is unavailable.',
        ...quality.map((row) => row.reason)].filter(Boolean),
    };
  }

  function* detailSources(config, { securityIds, lookback = 7560, signal } = {}) {
    if (!config.date || !config.earliestDate) return;
    if (!Number.isInteger(lookback) || lookback < 1 || lookback > 7560) throw new RangeError('Invalid stock detail lookback');
    const referenceDate = referenceCutoff(config);
    const key = JSON.stringify([config.dataVersion, config.basis, config.earliestDate, config.date, referenceDate]);
    let scope = detailInputScopes.get(key);
    if (!scope) {
      scope = { dates: expectedSessions(config.earliestDate, config.date),
        source: { end: config.date, referenceThrough: referenceDate, indices: new Map(), actions: new Map(), provenance: true } };
      detailInputScopes.set(key, scope);
      if (detailInputScopes.size > 3) detailInputScopes.delete(detailInputScopes.keys().next().value);
    }
    const { dates } = scope;
    const pinned = { ...config, currentVersion: false, historySource: scope.source };
    const refs = references(pinned);
    const fundamentals = readFundamentals(pinned);
    const subtypes = readSubtypes(pinned);
    const explicitBasis = db.prepare(`SELECT 1 FROM price_revisions WHERE security_id=? AND version<=? AND date<=?
      AND split_close>0 LIMIT 1`);
    for (const id of securityIds ?? refs.keys()) {
      signal?.throwIfAborted();
      const record = refs.get(id);
      if (!record) continue;
      const identifier = identifierAt(record, config.date);
      const instrument = instrumentType(record, subtypes.get(id), referenceDate);
      const facts = fundamentals.get(id) || [];
      const { prices, highs, frame } = detailFrame(pinned, record, dates, facts, lookback);
      const bar = prices.at(-1);
      const explicitSplitPriceBasis = frame.actions.some((action) => action.type === 'split' && action.date <= config.date && action.factor > 0)
        && Boolean(explicitBasis.get(id, config.dataVersion, config.date));
      yield {
        securityId: id, symbol: identifier?.symbol ?? null, name: record.name, exchange: identifier?.exchange || record.exchange,
        ...instrument, isin: record.isin ?? null, listingDate: record.listing_date, delistingDate: record.delisting_date,
        date: config.date, referenceDate, referenceMode: referenceDate !== config.date ? 'latest' : 'as-of',
        classificationSystem: config.classification, close: bar?.close ?? null, traded: !!bar?.traded,
        ...frame, ...detailRiskInputs(prices), explicitSplitPriceBasis,
        distance_all_time_high: change(bar?.close, highs.allTimeHigh),
        distance_loaded_history_high: change(bar?.close, highs.loadedHistoryHigh),
        warnings: [!facts.length && 'Dated float and shares outstanding are unavailable.',
          config.basis === 'reconstructed' && 'Price history uses the selected ingested data version.',
          !highs.allTimeHigh && 'Full history since listing is unavailable.', ...frame.quality.map((row) => row.reason)].filter(Boolean),
      };
    }
  }

  function studyPrices(config, ids, from, to) {
    const study = { ...config, date: to };
    const sessions = expectedSessions(from, to);
    const result = new Map();
    for (const raw of ids) {
      const security = findSecurity(study, raw);
      if (!security) continue;
      let bars = securitySeries(study, security.id, sessions).filter(Boolean);
      if (config.basis === 'known') {
        const anomalyByDate = new Map(bars.map((row) => [row.date, row.unverifiedSplit]));
        const overrides = securityQuality(study, security.id);
        const actions = actionHistory(db, study, security.id, overrides);
        const rows = db.prepare(`
          SELECT * FROM price_revisions WHERE security_id=? AND date>=? AND date<=? AND version<=? AND known_at<=?
          ORDER BY date, version
        `).all(security.id, from, to, config.dataVersion, to);
        bars = rows.map((row) => {
          const [adjusted] = prepareBars([row], actions, to, { overrides });
          return { ...adjusted, unverifiedSplit: anomalyByDate.get(row.date) || false };
        });
      }
      result.set(raw, bars.map((row) => ({ ...row, securityId: security.id })));
    }
    return result;
  }

  return { context, snapshot, history, detail, detailSources, studyPrices, findSecurity, sessionsFor, definitionKey,
    historyBatch, batchSnapshots, batchAdvanceDecline, snapshotAvailable };
}

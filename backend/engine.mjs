import { gzipSync, gunzipSync } from 'node:zlib';
import { getHeapStatistics } from 'node:v8';
import { createHash } from 'node:crypto';
import { CALCULATION_VERSION, dataVersion, getWorkspace, isoDate, listWorkspace, marketDay, normalizeSymbol, qualityOverrides } from './database.mjs';
import { expectedSessions, isMarketSession, shiftDate, weekEnd } from './calendar.mjs';
import { AVERAGES, DEFAULT_WINDOWS, alignSeries, finite, prepareBars, returnWindow, splitFactorBetween, stockMetrics } from './metrics.mjs';
import { BUILTIN_MODELS, annotateVelocity, modelInputs, modelWindowBounds, onOrBefore, scoreRanking, validateModel } from './ranking.mjs';
import { aggregateRows, BREADTH_METRICS, breadthMetric, calculateBreadth, calculateGroups } from './breadth.mjs';

const coreExchanges = ['NYSE', 'NASDAQ'];
const refinements = ['adr', 'reit', 'preferred', 'warrant', 'right', 'unit', 'etf'];
const builtinBreadthKeys = new Set(BREADTH_METRICS.map(({ key }) => key));
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

function byLatestEffective(records, date, key, field = null) {
  return records.find((item) => item[key] <= date && item.known_at <= date
    && (!item.effective_to || item.effective_to >= date) && (!field || item[field] > 0));
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
  if (!identifier) return false;
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

function seriesHistory(db, context, id, start, end) {
  if (context.currentVersion && context.basis === 'reconstructed') {
    return db.prepare('SELECT * FROM daily_prices WHERE security_id=? AND date>=? AND date<=? ORDER BY date')
      .all(id, start, end);
  }
  const rows = db.prepare(`
    SELECT * FROM price_revisions WHERE security_id=? AND date>=? AND date<=? AND version<=? AND known_at<=?
    ORDER BY date, version DESC
  `).all(id, start, end, context.dataVersion, context.basis === 'known' ? context.date : '9999-12-31');
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.date) && seen.add(row.date));
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

function strippedStock(row) {
  const { rsRisk, ...value } = row;
  return value;
}

export function createEngine(db) {
  const cache = new Map();
  const qualityCache = new Map();
  const observedRanges = new Map();
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
      averages: [...new Set([...AVERAGES, ...numericList(input.averages)])],
      windows: [...new Set([...DEFAULT_WINDOWS, ...numericList([...numericList(input.windows), ...extraFromBreadth])])],
      volumeWindows: numericList(input.volumeWindows),
      breadthKeys, threshold: input.threshold == null ? 0.98 : Number(input.threshold),
    };
    if (!(config.threshold > 0 && config.threshold <= 1)) throw new Error('Coverage threshold must be greater than zero and at most one');
    return config;
  }

  function sessionsFor(config) {
    const fixed = config.model.definition.windows.filter((item) => item.kind === 'fixed').map((item) => item.start).sort()[0];
    const lookbacks = config.model.definition.windows.map((item) => {
      const unit = { sessions: 2, months: 32, quarters: 94, years: 367, ytd: 367, fixed: 0 }[item.kind];
      return unit * ((item.length || 1) + item.offset);
    });
    let start = shiftDate(config.date, -Math.max(420, ...lookbacks, ...config.windows.map((n) => n * 2 + 15),
      ...config.averages.map((n) => n * 5 + 15), ...config.volumeWindows.map((n) => n * 2 + 15)));
    if (fixed && fixed < start) start = shiftDate(fixed, -14);
    if (start < '1900-01-01') start = '1900-01-01';
    return expectedSessions(start, config.date);
  }

  function references(config) {
    if (config.historySource?.references) return config.historySource.references;
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
    if (config.historySource) config.historySource.references = records;
    return records;
  }

  function identifierAt(reference, date) {
    const candidates = reference.identifiers?.filter((item) => item.valid_from <= date && (!item.valid_to || item.valid_to >= date));
    return candidates?.sort((a, b) => b.valid_from.localeCompare(a.valid_from) || a.symbol.localeCompare(b.symbol))[0] || null;
  }

  function readFundamentals(config, securityId = null) {
    const source = !securityId ? config.historySource : null;
    if (source?.fundamentals) return source.fundamentals;
    const cutoff = referenceCutoff(source ? { ...config, date: source.end } : config);
    const filter = securityId ? 'AND security_id=?' : '';
    const records = groupedQuery(`
      SELECT * FROM fundamentals WHERE version<=? AND effective_date<=? AND known_at<=? ${filter}
      ORDER BY security_id, effective_date DESC, known_at DESC, version DESC
    `, config.dataVersion, cutoff, cutoff, ...(securityId ? [securityId] : []));
    if (source) source.fundamentals = records;
    return records;
  }

  function readClassifications(config) {
    const source = config.historySource;
    if (source?.classifications) return source.classifications;
    const cutoff = referenceCutoff(source ? { ...config, date: source.end } : config);
    const records = groupedQuery(`
      SELECT * FROM classifications WHERE version<=? AND effective_from<=? AND known_at<=? AND system=?
      ORDER BY security_id, effective_from DESC, known_at DESC, version DESC
    `, config.dataVersion, cutoff, cutoff, config.classification);
    if (source) source.classifications = records;
    return records;
  }

  function readSubtypes(config, securityId = null) {
    const source = !securityId ? config.historySource : null;
    if (source?.subtypes) return source.subtypes;
    const cutoff = referenceCutoff(source ? { ...config, date: source.end } : config);
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

  function groupedQuery(sql, ...values) {
    const items = new Map();
    for (const row of db.prepare(sql).iterate(...values)) {
      if (!items.has(row.security_id)) items.set(row.security_id, []);
      items.get(row.security_id).push(row);
    }
    return items;
  }

  function historyBatch(config, dates) {
    if (config.basis !== 'reconstructed' || !dates.length) return { ...config, currentVersion: false };
    const start = sessionsFor({ ...config, date: dates[0] })[0];
    const end = dates.at(-1);
    const sessions = expectedSessions(start, end);
    const historySource = {
      start, end, sessions, indices: new Map(sessions.map((date, index) => [date, index])),
      series: new Map(), actions: new Map(), references: null, fundamentals: null, classifications: null, bars: 0,
      maxBars: Math.max(10_000, Math.floor(getHeapStatistics().heap_size_limit * 0.32 / 200)),
    };
    return { ...config, currentVersion: false, historySource };
  }

  function cachedSeries(config, id, sessions) {
    const source = config.historySource;
    if (!source || !sessions.length) return null;
    const from = source.indices.get(sessions[0]);
    const to = source.indices.get(sessions.at(-1));
    if (from == null || to == null) return null;
    let cache = source.series.get(id);
    if (!cache) {
      if (source.bars >= source.maxBars) return null;
      const prices = seriesHistory(db, config, id, source.start, source.end);
      const overrides = securityQuality(config, id);
      const actions = actionHistory(db, config, id, overrides);
      if (source.bars + prices.length > source.maxBars) return null;
      const prepared = alignSeries(prepareBars(prices, actions, source.end, { provenance: false, overrides }), source.sessions);
      cache = { prepared, actions, lastSplit: actions.reduce((latest, action) =>
        action.type === 'split' && action.date <= source.end && action.date > latest ? action.date : latest, '') };
      source.bars += prices.length;
      source.series.set(id, cache);
    }
    if (cache.lastSplit > config.date) return null;
    const aligned = cache.prepared.slice(from, to + 1);
    const first = aligned.findIndex(Boolean);
    if (aligned[first]?.unverifiedSplit) {
      aligned[first] = { ...aligned[first], unverifiedSplit: false };
    }
    return { aligned, actions: cache.actions };
  }

  function securitySeries(config, id, sessions, fundamentals = []) {
    const cached = cachedSeries(config, id, sessions);
    let aligned;
    let actions;
    if (cached) ({ aligned, actions } = cached);
    else {
      const prices = seriesHistory(db, config, id, sessions[0], sessions.at(-1));
      if (!prices.length) return [];
      const overrides = securityQuality(config, id);
      actions = actionHistory(db, config, id, overrides);
      aligned = alignSeries(prepareBars(prices, actions, config.date, { provenance: !config.historySource, overrides }), sessions);
    }
    if (fundamentals.some(({ float }) => float > 0)) {
      for (const [index, bar] of aligned.entries()) {
        if (!bar) continue;
        const fact = byLatestEffective(fundamentals, bar.date, 'effective_date', 'float');
        if (fact) aligned[index] = { ...bar, float: fact.float * splitFactorBetween(actions, fact.effective_date, config.date) };
      }
    }
    return aligned;
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
    const subtypes = readSubtypes(config);
    const referenceDate = referenceCutoff(config);
    const benchmarkRef = [...refs.values()].find((item) => identifierAt(item, config.date)?.symbol === config.benchmark);
    const benchmarkSeries = benchmarkRef ? securitySeries(config, benchmarkRef.id, dates) : [];
    const benchmarkInputs = modelInputs(benchmarkSeries, modelBounds, config.model.definition);
    const groups = config.themes ?? listWorkspace(db, 'theme');
    const subtypeExclusions = new Map();
    for (const record of refs.values()) {
      const identifier = identifierAt(record, config.date);
      const instrument = instrumentType(record, subtypes.get(record.id), referenceDate);
      if (!basicEligibility(record, config.universe.definition, config.date, config.basis, identifier, instrument.type)) {
        if (config.universe.id === 'us-core' && instrument.subtype && record.provider === 'eodhd' && record.status === 'active'
            && basicEligibility(record, config.universe.definition, config.date, config.basis, identifier)) {
          subtypeExclusions.set(record.id, instrument.subtype);
        }
        continue;
      }
      const facts = fundamentals.get(record.id) || [];
      const currentFacts = byLatestEffective(facts, referenceDate, 'effective_date');
      const floatFact = byLatestEffective(facts, referenceDate, 'effective_date', 'float');
      const sharesFact = byLatestEffective(facts, referenceDate, 'effective_date', 'shares');
      const capFact = byLatestEffective(facts, referenceDate, 'effective_date', 'market_cap');
      const classification = byLatestEffective(classifications.get(record.id) || [], referenceDate, 'effective_from');
      const priceSeries = record.first_seen && record.first_seen <= config.date ? securitySeries(config, record.id, dates, facts) : [];
      const metadata = {
        securityId: record.id, symbol: identifier.symbol, name: record.name, exchange: identifier.exchange,
        ...instrument, tradingStatus: record.status || 'unknown', isin: record.isin ?? null,
        listingDate: record.listing_date, observedFrom: record.first_seen ?? null, delistingDate: record.delisting_date,
        referenceKnown: record.reference_known, referenceVerified: !!record.listing_date && !record.listing_inferred && !record.reference_inferred && record.reference_known <= config.date,
        float: floatFact?.float ?? null, shares: sharesFact?.shares ?? null, marketCap: capFact?.market_cap ?? null,
        fundamentalsDate: currentFacts?.effective_date ?? null, fundamentalsKnownAt: currentFacts?.known_at ?? null,
        floatDate: floatFact?.effective_date ?? null, floatKnownAt: floatFact?.known_at ?? null,
        sharesDate: sharesFact?.effective_date ?? null, sharesKnownAt: sharesFact?.known_at ?? null,
        fundamentalsAgeDays: currentFacts ? Math.round((Date.parse(referenceDate) - Date.parse(currentFacts.effective_date)) / 86_400_000) : null,
        calculatedMarketCap: capFact?.effective_date === referenceDate ? capFact.market_cap : null,
        marketCapDate: capFact?.effective_date === referenceDate ? capFact.effective_date : null,
        sector: classification?.sector ?? null, industry: classification?.industry ?? null,
        subindustry: classification?.subindustry ?? null, classificationKnownAt: classification?.known_at ?? null,
      };
      if (currentFacts && priceSeries.length) {
        const actions = actionHistory(db, config, record.id, securityQuality(config, record.id));
        function marketCapAt(bar, date) {
          if (!date || !bar?.traded) return null;
          const cap = byLatestEffective(facts, date, 'effective_date', 'market_cap');
          if (cap?.effective_date === date) return cap.market_cap;
          const shares = byLatestEffective(facts, date, 'effective_date', 'shares');
          return shares ? shares.shares * splitFactorBetween(actions, shares.effective_date, date) * bar.rawClose : null;
        }
        const tradeCap = marketCapAt(priceSeries.at(-1), config.date);
        if (tradeCap != null) {
          metadata.calculatedMarketCap = tradeCap;
          metadata.marketCapDate = config.date;
        }
        metadata.priorMarketCap = marketCapAt(priceSeries.at(-2), dates.at(-2));
      }
      const stock = stockMetrics(metadata, priceSeries, {
        averages: config.averages, windows: config.windows, volumeWindows: config.volumeWindows, benchmarkSeries,
        priorFundamentals: byLatestEffective(facts, dates.at(-22) || config.date, 'effective_date'),
      });
      if (!metricEligibility(stock, config.universe.definition)) continue;
      const inputs = modelInputs(priceSeries, modelBounds, config.model.definition);
      stock.rsComponents = inputs.components;
      stock.rsRisk = inputs.risk;
      result.stocks.push(stock);
    }
    scoreRanking(result.stocks, config.model.definition, benchmarkInputs);
    const traded = result.stocks.filter((stock) => stock.traded);
    const intervalReturn = returnWindow(benchmarkSeries, dates.length - 22, dates.length - 1);
    result.groups = calculateGroups(traded, groups, config.date, intervalReturn);
    result.breadth = calculateBreadth(traded, config.breadthKeys);
    result.aggregates = {
      ...aggregateRows(traded),
      benchmarkReturn: returnWindow(benchmarkSeries, dates.length - 2, dates.length - 1),
      benchmarkReturn20d: returnWindow(benchmarkSeries, dates.length - 21, dates.length - 1),
      benchmarkReturn21d: intervalReturn, benchmarkClose: benchmarkSeries.at(-1)?.close ?? null,
    };
    const ledger = db.prepare(`SELECT session_imports.*, ingestion_runs.provider FROM session_imports
      JOIN ingestion_runs ON ingestion_runs.id=session_imports.run_id
      WHERE date=? AND session_imports.version<=? AND session_imports.scope='full' ORDER BY session_imports.version DESC LIMIT 1`)
      .get(config.date, config.dataVersion);
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
    const expectedComparable = (lookback) => {
      const earliestRequired = dates.at(-lookback);
      if (!earliestRequired) return 0;
      return traded.filter((row) => !row.listingDate || row.listingDate <= earliestRequired).length;
    };
    const missingPrices = result.stocks.length - traded.length;
    const state = !traded.length ? (result.stocks.length ? 'partial' : 'empty')
      : ratio != null && ratio >= config.threshold && ratio <= 1 && traded.length <= expected && !config.universe.definition.observedOnly
        ? 'complete' : 'partial';
    result.coverage = {
      state, ratio, expected, listed: result.stocks.length, traded: traded.length, received, sourceExpected, sourceReceived,
      subtypeCoverage: { excluded: subtypeExclusions.size, excludedBySubtype, excludedExpected, excludedReceived, receivedExact,
        unverifiedProviderCommon: result.stocks.filter((stock) => stock.providerType === 'common' && !stock.subtype).length },
      missingPrices, completenessThreshold: config.threshold,
      comparableExpected: {
        above_20d: expectedComparable(20), above_50d: expectedComparable(50), above_200d: expectedComparable(200),
        positive_21d: expectedComparable(22), new_high_252d: expectedComparable(253), new_low_252d: expectedComparable(253),
        volumeParticipation: expectedComparable(2), classification: traded.length,
      },
      ranked: traded.filter((stock) => stock.rsRank != null).length,
      float: traded.filter((stock) => stock.float != null).length,
      classifications: traded.filter((stock) => stock.industry != null).length,
      knownReference: traded.filter((stock) => stock.referenceVerified).length,
      splitAnomalies: traded.filter((stock) => stock.rejected_split).length,
      delisted: result.stocks.filter((stock) => stock.delistingDate != null || stock.tradingStatus === 'delisted').length,
      sessionRun: ledger?.run_id ?? null,
      message: state === 'complete' ? null : 'Available data does not establish complete coverage of this universe.',
    };
    result.stocks = result.stocks.map(strippedStock);
    return result;
  }

  function definitionKey(config) {
    return objectKey({
      benchmark: config.benchmark, basis: config.basis, classification: config.classification,
      referenceDate: config.referenceMode === 'latest' ? config.observedReferenceDate : null,
      averages: config.averages, windows: config.windows, volume: config.volumeWindows, breadth: config.breadthKeys,
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
    return list.slice(-Math.max(1, Math.min(2600, Number(limit) || 120))).map((date) =>
      project(snapshot({ ...config, date, requestedDate: date }, { persist, velocity })));
  }

  function findSecurity(config, id) {
    if (!config.date) return null;
    const refs = references(config);
    if (refs.has(id)) return refs.get(id);
    const symbol = normalizeSymbol(id);
    const matches = [...refs.values()].filter((record) => identifierAt(record, config.date)?.symbol === symbol);
    return matches.length === 1 ? matches[0] : null;
  }

  function detail(config, id, lookback = 252, { velocity = true } = {}) {
    const record = findSecurity(config, id);
    if (!record) return null;
    const identifier = identifierAt(record, config.date);
    const dates = expectedSessions(config.earliestDate, config.date);
    const facts = readFundamentals(config, record.id).get(record.id) || [];
    const referenceDate = referenceCutoff(config);
    const instrument = instrumentType(record, readSubtypes(config, record.id).get(record.id), referenceDate);
    const prices = securitySeries(config, record.id, dates, facts);
    const bars = prices.filter(Boolean);
    const quality = securityQuality(config, record.id).filter((row) => row.effective_from <= config.date);
    const actions = actionHistory(db, config, record.id, quality);
    const loadedHistoryHigh = bars.reduce((maximum, bar) => Math.max(maximum, bar.high), 0);
    const listingFirstSession = record.listing_date ? expectedSessions(record.listing_date, shiftDate(record.listing_date, 12))[0] : null;
    const allTimeHigh = listingFirstSession && bars[0]?.date === listingFirstSession && prices.every((bar) => bar?.traded && !bar.unverifiedSplit)
      ? loadedHistoryHigh : null;
    const selected = snapshot(config, { velocity }).stocks.find((row) => row.securityId === record.id);
    const lastTrade = bars.at(-1);
    const float = byLatestEffective(facts, referenceDate, 'effective_date', 'float');
    const shares = byLatestEffective(facts, referenceDate, 'effective_date', 'shares');
    const datedShares = byLatestEffective(facts, config.date, 'effective_date', 'shares');
    const cap = byLatestEffective(facts, referenceDate, 'effective_date', 'market_cap');
    const currentCap = cap?.effective_date === referenceDate ? cap.market_cap
      : lastTrade?.date === config.date && datedShares
        ? lastTrade.rawClose * datedShares.shares * splitFactorBetween(actions, datedShares.effective_date, config.date) : null;
    const stock = selected || stockMetrics({
      securityId: record.id, symbol: identifier?.symbol || id, name: record.name, exchange: identifier?.exchange || record.exchange,
      ...instrument, float: float?.float ?? null, shares: shares?.shares ?? null, calculatedMarketCap: currentCap,
      fundamentalsDate: facts[0]?.effective_date ?? null, fundamentalsKnownAt: facts[0]?.known_at ?? null,
      floatDate: float?.effective_date ?? null, floatKnownAt: float?.known_at ?? null,
      sharesDate: shares?.effective_date ?? null, sharesKnownAt: shares?.known_at ?? null,
    }, prices, { allTimeHigh, averages: config.averages, windows: config.windows, volumeWindows: config.volumeWindows });
    stock.distance_all_time_high = stock.close > 0 && allTimeHigh > 0 ? stock.close / allTimeHigh - 1 : null;
    return { ...stock, date: config.date, referenceDate, referenceMode: referenceDate !== config.date ? 'latest' : 'as-of',
      classificationSystem: config.classification, allTimeHigh, loadedHistoryHigh: loadedHistoryHigh || null,
      distance_loaded_history_high: stock.close > 0 && loadedHistoryHigh > 0 ? stock.close / loadedHistoryHigh - 1 : null,
      bars: bars.slice(-lookback), chartBars: dates.slice(-lookback).map((date, index, sessions) =>
        prices[dates.length - sessions.length + index] || { date, close: null, volume: null, traded: false, missing: true }),
      actions, quality, dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION,
      aliases: record.identifiers, earliestDate: bars[0]?.date || null, latestDate: bars.at(-1)?.date || null,
      warnings: [!selected && 'Security falls outside the selected analysis universe.', !facts.length && 'Dated float and shares outstanding are unavailable.', stock.fundamentalsAgeDays > 90 && 'The most recent dated fundamentals are more than 90 calendar days old.', config.basis === 'reconstructed' && 'Price history uses the selected ingested data version.', !allTimeHigh && 'Full history since listing is unavailable.',
        ...quality.map((row) => row.reason)].filter(Boolean),
    };
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

  return { context, snapshot, history, detail, studyPrices, findSecurity, sessionsFor, definitionKey, historyBatch, snapshotAvailable };
}

import { createHash } from 'node:crypto';
import { analysisWorkspaceScopeHash, readAnalysisReadiness } from './analysis-readiness.mjs';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { BREADTH_METRICS, breadthMetric } from './breadth.mjs';
import { expectedSessions, isMarketSession, shiftDate, weekEnd } from './calendar.mjs';
import { createChartBook } from './chartbook.mjs';
import { CALCULATION_VERSION, dataVersion, getWorkspace, isoDate, listWorkspace, marketDay } from './database.mjs';
import { createEngine, UNIVERSES } from './engine.mjs';
import { attachGroupMembershipVelocity, groupMembershipBasis, isCurrentGroupMembership } from './group-velocity.mjs';
import { readMaterializedHistory } from './materialization.mjs';
import { readPreparedMarketTiming } from './market-timing.mjs';
import { readPreparedRanks, preparationInput } from './preparation.mjs';
import { readPreparedChart, readPreparedDetail } from './prepared-details.mjs';
import { readPreparedSnapshot } from './prepared-snapshots.mjs';
import { BUILTIN_MODELS } from './ranking.mjs';
import { readRankArchive } from './rank-archive.mjs';
import { DEFAULT_HEALTH_MODEL, findHistoricalAnalogs, runEventStudy } from './research.mjs';
import { createResearchNotes } from './research-notes.mjs';
import { screenStocks } from './screener.mjs';
import { readPreparedSummation } from './summation.mjs';
import { decodeStoredJson } from './storage-codec.mjs';
import { stockColumns, stockFields } from './ai-tools.mjs';

export const researchError = (message, status = 400) => Object.assign(new Error(message), { status });
const currencies = new Set(['close', 'open', 'high', 'low', 'dollarVolume', 'market_cap', 'adv_20d']);
const units = (key) => key.startsWith('return_') || ['relative_return_21d', 'distance_high_252d'].includes(key) ? 'fraction'
  : key.includes('velocity') || key === 'industryVelocity' ? 'percentile points'
    : ['rsPercentile', 'industryRS', 'industryBreadth'].includes(key) ? 'percent'
      : currencies.has(key) ? 'USD' : ['volume', 'float', 'shares'].includes(key) ? 'shares'
        : key.endsWith('Date') || key.endsWith('KnownAt') ? 'ISO date' : 'native';
const monitorKeys = ['down_13pct_34d', 'up_13pct_34d'];
const listKinds = ['watchlist', 'screen', 'chartbook', 'market-chartbook'];
const finite = Number.isFinite;
const normalized = (text) => String(text || '').trim().toLowerCase().replaceAll('&', 'and').replace(/[\s-]+/g, ' ');
const noteText = (q, ...values) => !q || values.some((value) => normalized(value).includes(normalized(q)));
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'").get(name);
const pick = (value, fields) => Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null]));
const summaries = (items) => items.map(({ id, version, name }) => ({ id, version, name }));

function pageRows(items, input) {
  const { offset = 0, limit = 50 } = input;
  return { page: { offset, limit, total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null },
    rows: items.slice(offset, offset + limit) };
}

function response(config, source, { state = 'ready', coverage = {}, data, items, input = {} } = {}) {
  const { pin } = config ?? {};
  return {
    state, source, context: config ? { date: config.date, dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION,
      benchmark: config.benchmark, basis: config.basis, classification: config.classification, reference: config.referenceMode,
      universe: pick(config.universe, ['id', 'version', 'name']), model: pick(config.model, ['id', 'version', 'name']),
      verifiedThrough: pin.date, observedReferenceDate: config.referenceMode === 'as-of' ? config.date : config.observedReferenceDate,
      archiveFrom: pin.dateFrom, proofId: pin.receiptId ?? pin.publicationId } : null,
    coverage, ...(data && { data }), ...(items && pageRows(items, input)),
  };
}

function readyPin(db, requestedVersion) {
  const currentVersion = dataVersion(db);
  const date = db.prepare('SELECT date FROM daily_prices ORDER BY date DESC LIMIT 1').get()?.date;
  if (!requestedVersion || requestedVersion === currentVersion) {
    const active = readAnalysisReadiness(db, { date, dataVersion: currentVersion, calculationVersion: CALCULATION_VERSION });
    if (active.state === 'ready') return active;
  }
  const sources = [];
  if (hasTable(db, 'preparation_publications')) sources.push(`
    SELECT json_extract(manifest,'$.verification.dateTo') AS date, json_extract(manifest,'$.dataVersion') AS version,
      json_extract(manifest,'$.verification.workspaceScopeHash') AS scope
    FROM preparation_publications WHERE state='verified-awaiting-cutover' AND json_valid(manifest)
      AND json_extract(manifest,'$.calculationVersion')=$calculation`);
  if (hasTable(db, 'analysis_daily_receipts')) sources.push(`
    SELECT date, data_version AS version, json_extract(receipt,'$.scopeHash') AS scope
    FROM analysis_daily_receipts WHERE calculation_version=$calculation AND json_valid(receipt)`);
  if (sources.length) {
    const candidates = db.prepare(`SELECT DISTINCT date,version FROM (${sources.join(' UNION ALL ')})
      WHERE scope=$scope AND version<=$current AND ($requested IS NULL OR version=$requested)
      ORDER BY date DESC,version DESC`).iterate({ calculation: CALCULATION_VERSION, current: currentVersion,
      requested: requestedVersion ?? null, scope: analysisWorkspaceScopeHash(db) });
    for (const { date: day, version } of candidates) {
      if (day === date && version === currentVersion) continue;
      const ready = readAnalysisReadiness(db, { date: day, dataVersion: version, calculationVersion: CALCULATION_VERSION });
      if (ready.state === 'ready') return ready;
    }
  }
  throw researchError('No verified analysis publication is available for the requested revision and workspace scope.', 503);
}

function defaults(db, pin) {
  const classifications = db.prepare('SELECT DISTINCT system FROM classifications WHERE industry IS NOT NULL AND version<=?')
    .all(pin.dataVersion).map(({ system }) => system);
  const classificationsPresent = new Set(classifications);
  const classification = ['nasdaq', 'provider', 'sec-sic'].find((id) => classificationsPresent.has(id)) ?? classifications[0] ?? 'provider';
  const benchmarks = db.prepare(`SELECT DISTINCT i.symbol FROM identifiers i JOIN securities s ON i.security_id=s.id
    WHERE s.type IN ('etf','index') AND s.first_seen<=? AND EXISTS (SELECT 1 FROM price_revisions p
      WHERE p.security_id=s.id AND p.version<=? AND p.date<=? LIMIT 1) ORDER BY i.symbol`).all(pin.date, pin.dataVersion, pin.date);
  const symbols = new Set(benchmarks.map(({ symbol }) => symbol));
  const benchmark = ['SPY', 'VTI'].find((symbol) => symbols.has(symbol)) ?? benchmarks[0]?.symbol ?? 'SPY';
  const run = db.prepare(`SELECT started_at,finished_at,CASE WHEN json_valid(detail) THEN json_extract(detail,'$.catalogDate') END AS catalog_date
    FROM ingestion_runs WHERE status='complete' AND version<=? ORDER BY version DESC LIMIT 1`).get(pin.dataVersion);
  const timestamp = [run?.finished_at, run?.started_at].find((item) => Number.isFinite(Date.parse(item)));
  const captured = timestamp ? marketDay(timestamp) : run?.catalog_date;
  const observedReferenceDate = isoDate(captured) && captured >= pin.date && captured <= marketDay() ? captured : pin.date;
  return { benchmark, classification, observedReferenceDate, classifications: [...new Set(['provider', ...classifications])] };
}

function resolvePoint(db, engine, input = {}) {
  if (input.calculationVersion && input.calculationVersion !== CALCULATION_VERSION) {
    throw researchError('Requested calculation version is unavailable.', 409);
  }
  const pin = readyPin(db, input.dataVersion);
  const date = input.asOf ?? pin.date;
  if (!isMarketSession(date) || date < pin.dateFrom || date > pin.date) {
    throw researchError('Choose an exchange session within the verified archive coverage.');
  }
  const base = defaults(db, pin);
  if (input.classification && !base.classifications.includes(input.classification)) throw researchError('Unknown classification for the selected revision.');
  const config = engine.context({
    benchmark: base.benchmark, classification: base.classification, reference: date === pin.date ? 'latest' : 'as-of',
    observedReferenceDate: base.observedReferenceDate, ...input, date, dataVersion: pin.dataVersion,
  });
  if (config.date !== date) throw researchError('Requested exchange session is not available at the selected revision.');
  return { ...config, pin, currentVersion: false };
}

function historyDates(config, input, { defaultCount = 252 } = {}) {
  const { from, to, sessions = defaultCount, cadence = 'daily' } = input;
  if (to && to > config.date || from && to && from > to || from && from > config.date) throw researchError('Dates exceed the analysis pin or are out of order.');
  const start = [from, config.pin.dateFrom, config.earliestDate].filter(Boolean).sort().at(-1);
  const dates = expectedSessions(start, to ?? config.date);
  const selected = cadence === 'weekly' ? dates.filter((date, index) => !dates[index + 1] || weekEnd(dates[index + 1]) !== weekEnd(date)) : dates;
  return selected.slice(-sessions);
}

function preparedSnapshot(db, engine, config, { velocity = false, ids, fields } = {}) {
  const options = { velocity, securityIds: ids, stockFields: fields };
  const compact = readPreparedSnapshot(db, engine, config, options);
  if (compact) return compact;
  const stored = db.prepare(`SELECT value FROM snapshots WHERE kind=? AND date=? AND universe=? AND model=?
    AND data_version=? AND calculation_version=? AND definition_key=?`).get(velocity ? 'market-velocity' : 'market',
    config.date, `${config.universe.id}@${config.universe.version}`, `${config.model.id}@${config.model.version}`,
    config.dataVersion, CALCULATION_VERSION, engine.definitionKey(config));
  if (!stored) return null;
  const archived = decodeStoredJson(stored.value);
  const wanted = ids && new Set(ids);
  return { ...archived, stocks: archived.stocks.filter(({ securityId }) => !wanted || wanted.has(securityId))
    .map((row) => fields ? pick(row, fields) : row) };
}

function requiredSnapshot(db, engine, config, options) {
  const snapshot = preparedSnapshot(db, engine, config, options);
  if (!snapshot) throw researchError('This context has no prepared snapshot for the selected session and calculation.', 503);
  return snapshot;
}

function storedHistory(db, engine, config, dates, keys = []) {
  if (!dates.length) return [];
  const { rows } = readMaterializedHistory(db, engine, config, { from: dates[0], to: dates.at(-1), limit: Math.min(7560, dates.length * 5) });
  const wanted = new Set(dates);
  const selected = new Map(rows.filter(({ date }) => wanted.has(date)).map((row) => [row.date, row]));
  if (keys.some((key) => monitorKeys.includes(key)) && !config.breadthKeys.length) {
    const paired = engine.context({ ...preparationInput(config), breadthKeys: monitorKeys });
    const augmented = readMaterializedHistory(db, engine, paired, { from: dates[0], to: dates.at(-1), limit: Math.min(7560, dates.length * 5) }).rows;
    for (const item of augmented) {
      if (!wanted.has(item.date)) continue;
      const current = selected.get(item.date);
      selected.set(item.date, current ? { ...current, breadth: { ...current.breadth, ...pick(item.breadth, monitorKeys) } } : item);
    }
  }
  return dates.flatMap((date) => selected.has(date) ? [selected.get(date)] : []);
}

function healthRows(db, engine, config, dates, healthModel) {
  if (!dates.length || !hasTable(db, 'prepared_health')) return [];
  const custom = healthModel && healthModel !== 'default' ? getWorkspace(db, 'health-model', healthModel) : null;
  if (healthModel && healthModel !== 'default' && !custom) throw researchError('Saved health model not found', 404);
  const model = custom ? { ...custom.definition, id: custom.id, name: custom.name, version: custom.version } : DEFAULT_HEALTH_MODEL;
  return referenceArchiveScopes(config, dates).flatMap(({ config: context, dates: scopeDates }) => {
    const recipe = createHash('sha256').update(JSON.stringify([engine.definitionKey(context), context.universe.id,
      context.universe.version, context.model.id, context.model.version, model, { coverageMode: 'verified' }])).digest('hex');
    const versions = db.prepare('SELECT DISTINCT data_version FROM prepared_health WHERE recipe=? AND calculation_version=? AND data_version<=?')
      .all(recipe, CALCULATION_VERSION, context.dataVersion).map(({ data_version }) => data_version);
    const lineage = reusableArchiveVersions(db, context, versions);
    const candidates = db.prepare(`SELECT date,data_version,payload FROM prepared_health
      WHERE recipe=? AND calculation_version=? AND date IN (SELECT value FROM json_each(?))
      AND data_version IN (SELECT value FROM json_each(?)) ORDER BY date,data_version DESC`)
      .all(recipe, CALCULATION_VERSION, JSON.stringify(scopeDates), JSON.stringify([...lineage.keys()]));
    const seen = new Set();
    return candidates.filter((row) => usableArchiveRow(lineage, row) && !seen.has(row.date) && seen.add(row.date))
      .map(({ payload, data_version }) => ({ ...decodeStoredJson(payload), sourceDataVersion: data_version }));
  }).sort((left, right) => left.date.localeCompare(right.date));
}

function withGaps(dates, stored, shape = (row) => row) {
  const observed = new Map(stored.map((row) => [row.date, row]));
  const missingDates = dates.filter((date) => !observed.has(date));
  return {
    state: !observed.size ? 'unprepared' : missingDates.length ? 'partial' : 'ready',
    coverage: { requestedSessions: dates.length, preparedSessions: dates.length - missingDates.length, missingDates,
      from: dates[0] ?? null, through: dates.at(-1) ?? null },
    items: dates.map((date) => observed.has(date) ? shape(observed.get(date)) : { date, state: 'missing_prepared_observation' }),
  };
}

function securityAt(engine, config, identifier) {
  const record = engine.findSecurity(config, identifier);
  const alias = record?.identifiers?.filter((item) => item.valid_from <= config.date && (!item.valid_to || item.valid_to >= config.date))
    .toSorted((left, right) => right.valid_from.localeCompare(left.valid_from) || left.symbol.localeCompare(right.symbol))[0];
  if (!alias || record.listing_date > config.date || record.delisting_date && record.delisting_date < config.date) {
    throw researchError('No unique security was found at the selected session and revision', 404);
  }
  return { securityId: record.id, symbol: alias.symbol, name: record.name, exchange: alias.exchange, type: record.type };
}

function windowConfig(config, date) {
  return { ...config, date, requestedDate: date };
}

function selectStockHistory(db, engine, config, input) {
  const security = securityAt(engine, config, input.security);
  const dates = historyDates(config, input);
  if (!dates.length) return response(config, 'prepared stock archives', { state: 'empty', items: [], input, data: { security } });
  const anchor = windowConfig(config, dates.at(-1));
  let archive;
  if (input.series === 'prices') {
    const lookback = expectedSessions(dates[0], dates.at(-1)).length;
    const product = lookback <= 126 ? readPreparedChart(db, anchor, security.securityId, lookback)
      : readPreparedDetail(db, anchor, security.securityId, { lookback: Math.min(lookback, 7560) });
    const wanted = new Set(dates);
    archive = withGaps(dates, (product.bars ?? product.detail?.chartBars ?? []).filter(({ date }) => wanted.has(date)),
      (row) => pick(row, ['date', 'open', 'high', 'low', 'close', 'volume', 'rawVolume', 'dollarVolume', 'traded',
        'source', 'knownAt', 'ingestedAt', 'version', 'unverifiedSplit', 'priceQuarantined']));
    return response(config, 'prepared stock detail chart', { ...archive, input, data: { security, priceBasis: 'split-adjusted OHLC',
      units: { open: 'USD', high: 'USD', low: 'USD', close: 'USD', volume: 'shares' },
      sourceDataVersion: product?.sourceDataVersion ?? null } });
  }
  if (input.series === 'ranks') {
    const compact = readPreparedRanks(db, config, dates, { securityId: security.securityId });
    const legacy = compact.observed.size < dates.length ? readRankArchive(db, engine, config, { from: dates[0], to: dates.at(-1),
      cadence: input.cadence ?? 'daily', limit: dates.length, securityId: security.securityId }) : null;
    const found = new Map([...(legacy?.rows ?? []), ...compact.rows].map((row) => [row.date, row]));
    const observed = new Set([...compact.observed, ...(legacy?.observed ?? [])]);
    archive = withGaps(dates, dates.filter((date) => observed.has(date)).map((date) => found.get(date) ??
      { date, state: 'security_unranked', rank: null, percentile: null, score: null }));
    return response(config, 'prepared rank archive', { ...archive, input, data: { security,
      units: { rank: 'ordinal', percentile: 'percent', score: 'ranking-model score' } } });
  }
  const columns = input.fields ?? stockColumns;
  if (dates.length > 126) throw researchError('Calculated stock history is limited to 126 observations per request. Use a narrower window.');
  const velocity = columns.some((field) => /velocity|rankChange/i.test(field));
  const stored = dates.flatMap((date) => {
    const snapshot = preparedSnapshot(db, engine, windowConfig(config, date), { velocity, ids: [security.securityId], fields: columns });
    return snapshot ? [{ date, state: snapshot.stocks.length ? 'ready' : 'security_outside_universe', ...pick(snapshot.stocks[0], columns) }] : [];
  });
  return response(config, 'prepared stock snapshots', { ...withGaps(dates, stored), input, data: { security,
    units: Object.fromEntries(columns.map((column) => [column, units(column)])) } });
}

function marketHistory(db, engine, config, input) {
  const { series, metrics: keys = ['advancers', 'decliners', 'above_50d', 'above_200d', 'down_25pct_63d'] } = input;
  const point = series === 'nyse-summation' ? engine.context({ ...preparationInput(config), universe: 'nyse', universeVersion: 1,
    model: 'composite', modelVersion: 1, reference: 'as-of', basis: 'reconstructed',
    classification: defaults(db, config.pin).classifications.includes('sec-sic') ? 'sec-sic' : defaults(db, config.pin).classification }) : config;
  const dates = historyDates({ ...point, pin: config.pin }, input);
  if (!dates.length) return response(config, 'prepared market archives', { state: 'empty', input, items: [] });
  if (series === 'health') {
    return response(config, 'prepared market health archive', { ...withGaps(dates, healthRows(db, engine, point, dates, input.healthModel)),
      input, data: { healthModel: input.healthModel ?? 'default', coverageMode: 'verified' } });
  }
  if (series === 'nyse-summation') {
    const nyse = readPreparedSummation(db, point, { from: dates[0], to: dates.at(-1), limit: 2520 });
    return response({ ...point, pin: config.pin }, 'prepared NYSE Summation Index archive',
      { ...withGaps(dates, nyse.rows), input, data: { metadata: nyse.metadata, through: nyse.through } });
  }
  const records = storedHistory(db, engine, config, dates, keys);
  return response(config, 'materialized market history', { ...withGaps(dates, records, (row) => ({
    ...pick(row, ['date', 'coverage', 'referenceDate', 'knownAt', 'materializedAt']),
    sourceDataVersion: row.sourceDataVersion ?? row.dataVersion, breadth: pick(row.breadth, keys),
    ...(series === 'market' && { aggregates: row.aggregates }),
  })), input, data: { breadthUnit: 'percent', returnUnit: 'fraction', metrics: keys,
    metricUnits: Object.fromEntries(keys.map((key) => [key, key === 'adSpread' ? 'percentage points' : key === 'adRatio' ? 'ratio' : 'percent'])) } });
}

function metricConstituents(db, engine, config, input) {
  const { metric, mode = 'matches' } = input;
  const definition = breadthMetric(metric);
  const fields = ['securityId', 'symbol', 'name', 'sector', 'industry', 'traded',
    ...(metric === 'outperform_industry' ? ['industryRelativeReturn'] : []),
    ...(monitorKeys.includes(metric) ? ['return_34d'] : [])];
  const point = monitorKeys.includes(metric) ? engine.context({ ...preparationInput(config), breadthKeys: monitorKeys }) : config;
  const snapshot = requiredSnapshot(db, engine, point);
  const aggregate = snapshot.breadth[metric];
  if (!definition || !aggregate) throw researchError('The selected metric is not prepared for this context.', 503);
  const assessed = snapshot.stocks.filter(({ traded }) => traded).flatMap((row) => {
    const matches = definition.test(row);
    return matches == null ? [] : [{ ...pick(row, fields), matches }];
  });
  const matched = assessed.filter(({ matches }) => matches);
  if (matched.length !== aggregate.numerator || assessed.length !== aggregate.denominator) {
    throw researchError('The stored constituents do not reconcile to the prepared metric denominator.', 503);
  }
  const selected = mode === 'matches' ? matched : assessed;
  return response(config, 'prepared breadth snapshot', { coverage: snapshot.coverage, input,
    items: selected.toSorted((left, right) => left.symbol.localeCompare(right.symbol) || left.securityId.localeCompare(right.securityId)),
    data: { ...aggregate, metric, definition: definition.definition, unit: 'percent', mode } });
}

const defensive = new Set(['consumer staples', 'consumer defensive', 'health care', 'healthcare', 'utilities']);
const nondefensive = new Set(['energy', 'materials', 'basic materials', 'industrials', 'technology', 'information technology',
  'financials', 'financial services', 'finance', 'real estate', 'consumer cyclical', 'consumer discretionary',
  'communication services', 'communications', 'consumer services', 'telecommunications', 'transportation']);
const nondefensiveSicDivisions = new Set(['b mining', 'c construction', 'h finance, insurance and real estate']);
const mixedSicCodes = new Set(['a', 'd', 'e', 'f', 'g', 'i']);

function classifySector(group, sectors, taxonomy, exclusions, excludeDefensive) {
  const sector = sectors.get(group.parent) ?? null;
  if (sector && exclusions.has(normalized(sector))) return { sector, sectorDecision: 'explicitly_excluded' };
  if (!sector) return { sector, sectorDecision: 'unknown_sector' };
  if (!excludeDefensive) return { sector, sectorDecision: 'eligible' };
  const key = normalized(sector);
  if (taxonomy === 'sec-sic') {
    const sectorDecision = nondefensiveSicDivisions.has(key) ? 'eligible'
      : mixedSicCodes.has(key.split(' ')[0]) ? 'mixed_sic_division' : 'unmapped_sector';
    return { sector, sectorDecision };
  }
  if (defensive.has(key)) return { sector, sectorDecision: 'defensive_sector' };
  return { sector, sectorDecision: nondefensive.has(key) ? 'eligible' : 'unmapped_sector' };
}

function industryStrength(db, engine, config, input) {
  const { order = 'rs-improvement', view = 'eligible', excludeDefensive = false, includeUnclassified = false, membership = 'auto' } = input;
  const currentSupported = isCurrentGroupMembership(config);
  if (membership === 'current' && (order !== 'rs-improvement' || !currentSupported)) {
    throw researchError('Current-membership RS improvement requires the selected latest Nasdaq reference.');
  }
  const exclusions = new Set((input.excludedSectors ?? []).map(normalized));
  const velocity = order === 'rs-improvement';
  const available = velocity && currentSupported && membership !== 'dated'
    ? preparedSnapshot(db, engine, config, { velocity: true }) ?? requiredSnapshot(db, engine, config)
    : requiredSnapshot(db, engine, config, { velocity });
  const dated = available.groups.filter(({ level }) => level === 'industry');
  const useProjection = membership === 'current' || membership === 'auto' && velocity && currentSupported &&
    !dated.some((group) => finite(group.velocity4w) || finite(group.velocity12w));
  const projected = useProjection && attachGroupMembershipVelocity(db, config, available);
  const current = membership === 'current' || projected && projected.groups.some((group) => group.level === 'industry' &&
    (finite(group.currentMembership?.velocity4w) || finite(group.currentMembership?.velocity12w)));
  const snapshot = current ? projected : available;
  const sectors = new Map(snapshot.groups.filter(({ level }) => level === 'sector').map(({ id, name }) => [id, name]));
  const groups = snapshot.groups.filter(({ level }) => level === 'industry');
  let latest;
  let expected = 0;
  let returns;
  if (order === 'trailing-return') {
    const baseline = expectedSessions(shiftDate(config.date, -7 * 12 - 14), shiftDate(weekEnd(config.date), -7 * 12))
      .filter((date) => date >= config.pin.dateFrom).at(-1);
    const dates = baseline && expectedSessions(shiftDate(baseline, 1), config.date);
    expected = dates?.length ?? 0;
    const stored = dates?.length ? storedHistory(db, engine, config, dates) : [];
    latest = { baseline: baseline ?? null, through: config.date, expectedSessions: expected, preparedSessions: stored.length };
    returns = new Map();
    for (const day of stored) for (const group of day.groups ?? []) {
      if (group.level !== 'industry' || !finite(group.dailyReturn) || group.dailyReturn <= -1) continue;
      const item = returns.get(group.id) ?? { count: 0, gross: 1 };
      item.count++;
      item.gross *= 1 + group.dailyReturn;
      returns.set(group.id, item);
    }
  }
  const decisions = {};
  const rows = groups.map((group) => {
    const classification = classifySector(group, sectors, config.classification, exclusions, excludeDefensive);
    const stats = returns?.get(group.id);
    const trailing = expected > 0 && stats?.count === expected ? (stats.gross - 1) * 100 : null;
    const score = current ? group.currentMembership?.velocity12w : group.velocity12w;
    const value = order === 'rs-improvement' ? score ?? null : order === 'current-rank' ? group.rank ?? null : trailing;
    const unknown = ['unknown_sector', 'unmapped_sector', 'mixed_sic_division'].includes(classification.sectorDecision);
    const included = classification.sectorDecision === 'eligible' || unknown && includeUnclassified;
    decisions[classification.sectorDecision] = (decisions[classification.sectorDecision] ?? 0) + 1;
    return { ...pick(group, ['id', 'name', 'parent', 'rank', 'percentile', 'count', 'rankedCount', 'medianRS', 'velocity12w', 'rankChange12w']),
      ...classification, included, value, ...(current && { currentMembership: group.currentMembership ?? null }),
      ...(returns && { returnSessions: stats?.count ?? 0 }) };
  });
  const unit = order === 'rs-improvement' ? 'percentile points' : order === 'current-rank' ? 'ordinal' : 'percent';
  const selected = rows.filter(({ included }) => view === 'all' || (view === 'eligible') === included);
  selected.sort((left, right) => {
    if (finite(left.value) !== finite(right.value)) return finite(left.value) ? -1 : 1;
    return (order === 'current-rank' ? left.value - right.value : right.value - left.value) || left.id.localeCompare(right.id);
  });
  const comparableGroups = selected.filter(({ value }) => finite(value)).length;
  const coverage = current ? selected.reduce((summary, { currentMembership: cohort }) => {
    if (!cohort) return summary;
    summary.currentRankedMembers += cohort.cohortCount;
    summary.anchorTradedMembers += cohort.tradedRosterCount;
    summary.paired4wMembers += cohort.horizons['4w'].matchedMembers ?? 0;
    summary.paired12wMembers += cohort.horizons['12w'].matchedMembers ?? 0;
    return summary;
  }, { currentRankedMembers: 0, anchorTradedMembers: 0, paired4wMembers: 0, paired12wMembers: 0 }) : null;
  return response(config, current ? 'prepared current-membership industry RS archive'
    : order === 'trailing-return' ? 'materialized dated industry returns' : 'prepared industry snapshot', {
    state: current && snapshot.groupMembershipProjection?.state === 'unprepared' ? 'unprepared'
      : selected.length > 0 && comparableGroups < selected.length ? 'partial' : 'ready',
    coverage: { ...snapshot.coverage, groups: groups.length, sectorDecisions: decisions, ...latest, comparableGroups,
      ...(coverage && { currentMembership: { ...coverage,
        representativeness: coverage.anchorTradedMembers ? coverage.currentRankedMembers / coverage.anchorTradedMembers : null,
        representativenessMeaning: 'Current RS-ranked members divided by all traded members of the selected industries.',
        pairedCoverageMeaning: 'Within each group, members with finite RS at both endpoints divided by the frozen current RS-ranked members.',
      } }) }, items: selected, input,
    data: { order, unit, membership: current ? groupMembershipBasis : 'dated-membership', requestedMembership: membership,
      ...(projected && { groupMembershipProjection: projected.groupMembershipProjection }),
      excludeDefensive, excludedSectors: input.excludedSectors ?? [], includeUnclassified, view,
      methodology: current ? 'Change in RS percentile across the same eligible peers and comparable members at both endpoints, using today’s frozen RS-eligible cohort. A high matched share can still represent only a small part of the traded industry.'
        : order === 'rs-improvement' ? 'Current industry RS percentile minus its comparable percentile twelve weekly observations earlier.'
          : order === 'current-rank' ? 'Current industry RS rank within the pinned universe.'
            : 'Compounded equal-weight daily returns of dated industry members. A missing session makes that industry’s result unavailable.',
      sectorMethodology: 'Defense uses identified sector labels. Only SEC SIC Mining, Construction, and Finance/Insurance/Real Estate are treated as nondefensive. Other divisions are marked mixed or unmapped.',
      defensiveLabels: excludeDefensive ? [...defensive] : [] } });
}

function studyDates(config, start) {
  if (start && start > config.date) throw researchError('Study start exceeds the analysis pin.');
  const first = start && start > config.pin.dateFrom ? start : config.pin.dateFrom;
  const sessions = expectedSessions(first, config.date);
  if (sessions.length > 2520) throw researchError('Study ranges are limited to 2,520 exchange sessions. Choose a later start date.');
  return sessions;
}

function benchmarkStudy(db, engine, config, input) {
  const { metric, operator = 'gte', horizons = [252], overlap = 'none', coverageMode = 'observed' } = input;
  const benchmark = (input.benchmark ?? 'SPY').toUpperCase();
  const sessions = studyDates(config, input.start);
  const priorDate = sessions.at(-2);
  const eventEnd = input.eventEnd ?? priorDate;
  if (!priorDate || !eventEnd || eventEnd >= config.date || eventEnd < sessions[0]) throw researchError('Select a prior event range within the verified archive.');
  const observations = storedHistory(db, engine, config, sessions, [metric]);
  const current = observations.find(({ date }) => date === config.date);
  const currentReading = current?.breadth?.[metric];
  const threshold = input.threshold ?? currentReading?.value;
  if (!finite(threshold) || threshold < 0 || threshold > 100) {
    throw researchError('The current breadth percentage is unavailable; select a compatible prepared context or provide a threshold from 0 to 100.', 503);
  }
  const common = { sessions, observations, horizons, asOf: config.date, coverageMode };
  const probe = runEventStudy({ ...common, condition: { metric, op: 'eq', value: currentReading?.value ?? threshold },
    start: config.date, end: config.date, overlap: 'none' });
  if (input.threshold == null && !probe.evaluatedCount) {
    throw researchError('The current breadth reading has insufficient coverage for the selected policy.', 503);
  }
  const identity = securityAt(engine, config, benchmark);
  let bars = engine.studyPrices(config, [identity.securityId], sessions[0], config.date).get(identity.securityId) ?? [];
  if (config.basis === 'reconstructed') bars = bars.map((bar) => ({ ...bar, sourceKnownAt: bar.knownAt, knownAt: bar.date }));
  const study = runEventStudy({ ...common, condition: { metric, op: operator, value: threshold }, benchmarks: { [benchmark]: bars },
    start: sessions[0], end: eventEnd, overlap });
  const readings = new Map(observations.map(({ date, breadth }) => [date, breadth?.[metric]]));
  const outcomes = new Map(study.events.map((event) => [event.date, { ...event, reading: readings.get(event.date),
    horizons: Object.fromEntries(horizons.map((horizon) => [horizon, { status: 'suppressedOverlap' }])) }]));
  const summariesByHorizon = study.results.map(({ horizon, events, benchmarks, suppressedCount, eventCount }) => {
    for (const event of events) outcomes.get(event.date).horizons[horizon] = event.benchmarks[benchmark];
    const { values: _individualReturns, ...distribution } = benchmarks[benchmark].distribution;
    return { horizon, eventCount, suppressedCount, ...benchmarks[benchmark], distribution };
  });
  const dateSet = new Set(observations.map(({ date }) => date));
  return response(config, 'materialized breadth history and pinned benchmark price revisions', {
    state: study.unknownCount ? 'partial' : 'ready', items: [...outcomes.values()], input, coverage: {
      policy: coverageMode, observedMinimum: study.observedMinimum ?? null, observedThreshold: study.observedThreshold ?? null,
      coverageWarning: study.coverageWarning ?? null, evaluatedSessions: study.evaluatedCount, unknownSessions: study.unknownCount,
      eventCount: study.eventCount, missingDates: sessions.filter((date) => date <= eventEnd && !dateSet.has(date)),
    }, data: {
      metric, operator, threshold, thresholdUnit: 'percent', thresholdSource: input.threshold == null ? 'current exact metric' : 'explicit',
      currentSignal: { date: config.date, reading: currentReading ?? null, coverage: current?.coverage ?? null,
        coverageEligible: !!probe.evaluatedCount },
      benchmark: identity, returnUnit: 'percent', timeUnit: 'exchange sessions', returnBasis: 'split-adjusted close-to-close price return',
      eventStart: sessions[0], eventEnd, overlap, results: summariesByHorizon, definitions: study.definitions,
      interpretation: 'Historical benchmark outcomes. Completed outcomes form the statistics denominator. Overlapping observations are dependent.',
    },
  });
}

function analogStudy(db, engine, config, input) {
  const metrics = input.metrics ?? ['above_50d', 'positive_21d', 'down_25pct_63d'];
  const sessions = studyDates(config, input.start);
  const records = storedHistory(db, engine, config, sessions, metrics);
  const estimation = findHistoricalAnalogs({
    snapshots: records, sessions, asOf: config.date, metrics: metrics.map((metric) => `breadth.${metric}.value`),
    horizon: input.horizon, limit: input.sampleLimit, minimumHistory: input.minimumHistory,
    overlap: input.overlap, coverageMode: input.coverageMode ?? 'observed',
  });
  const { matches, ...data } = estimation;
  const observed = matches.map(({ forwardReturn }) => forwardReturn).filter(finite).sort((a, b) => a - b);
  return response(config, 'materialized breadth and benchmark return history', {
    state: data.state, data: { ...data, empiricalReturns: observed, returnUnit: 'percent', winRateUnit: 'fraction',
      interpretation: 'This is a historical outcome distribution, without a calibrated forecast or an investment recommendation.' },
    coverage: { requestedSessions: sessions.length, preparedSessions: records.length, eligiblePastSessions: data.sampleCount,
      selectedAnalogs: matches.length, completeOutcomes: data.outcomeCount, missingOutcomes: data.missingOutcomes, rightCensored: data.rightCensored },
    items: matches, input,
  });
}

function screeningOptions(input) {
  const filters = input.filters ?? [];
  for (const { op, value } of filters) {
    if (['in', 'between'].includes(op) && (!Array.isArray(value) || (op === 'between' && value.length !== 2))) {
      throw researchError('Provide an array of comparison values for in or two values for between.');
    }
    if (!['in', 'between'].includes(op) && Array.isArray(value)) throw researchError('This comparison requires a scalar.');
  }
  return { columns: input.fields ?? stockColumns, search: input.q, includeUntraded: input.includeUntraded,
    sort: input.sort?.length ? input.sort : [{ field: 'rsRank', direction: 'asc' }],
    filter: filters.length ? { operator: input.combine ?? 'and', filters } : null };
}

function screenNeedsVelocity(definition) {
  return /(?:velocity|rankChange|industryImproving|industryEmerging)/i.test(JSON.stringify(definition));
}

function savedScreenIsSupported(definition) {
  return !definition.rankingList && !definition.computed?.length && !JSON.stringify(definition.filter ?? {}).includes('"expression"');
}

function savedDefinition(kind, definition) {
  const fields = kind === 'watchlist' ? ['mode', 'members', 'screenId']
    : kind === 'screen' ? ['filter', 'columns', 'computed', 'sort', 'search', 'includeUntraded', 'context', 'groupBy', 'rankingList']
      : kind === 'chartbook' ? ['sources', 'context', 'sort'] : ['view', 'metrics', 'industries', 'lookback', 'context'];
  return pick(definition, fields);
}

function visibleSecurity(engine, config, id) {
  try { return { ...securityAt(engine, config, id), state: 'ready' }; }
  catch (error) {
    if (error.status !== 404) throw error;
    return { input: id, state: 'unavailable' };
  }
}

function screenSaved(db, engine, config, definition) {
  if (!savedScreenIsSupported(definition)) return { state: 'unsupported_definition', rows: [] };
  const archived = preparedSnapshot(db, engine, config, { velocity: screenNeedsVelocity(definition) });
  if (!archived) return { state: 'unprepared', rows: [] };
  const result = screenStocks(archived, definition, { all: true });
  return { state: 'ready', rows: result.rows };
}

async function savedList(db, engine, config, input, bookRoute) {
  const saved = getWorkspace(db, input.kind, input.id, input.version);
  if (!saved) throw researchError('Saved list not found', 404);
  const { kind, id, name, version, definition } = saved;
  const data = { kind, id, name, version, definition: savedDefinition(kind, definition) };
  const screen = kind === 'screen' ? saved : kind === 'watchlist' && definition.screenId
    ? getWorkspace(db, 'screen', definition.screenId) : null;
  if (screen) {
    const options = pick(screen.definition.context, ['universe', 'universeVersion', 'model', 'modelVersion',
      'basis', 'benchmark', 'classification', 'reference', 'observedReferenceDate']);
    const preset = Object.fromEntries(Object.entries(options).filter(([, value]) => value != null));
    const point = resolvePoint(db, engine, { ...preset, ...input.context, asOf: config.date, dataVersion: config.dataVersion });
    const selected = screenSaved(db, engine, point, screen.definition);
    return response(point, 'saved screen and prepared stocks', { state: selected.state, data, input,
      items: selected.rows.map((row) => pick(row, stockColumns)) });
  }
  if (kind === 'watchlist') {
    if (definition.screenId) return response(config, 'saved watchlist', { state: 'source_unavailable', data, items: [], input });
    const items = [...new Set(definition.members ?? [])].map((member) => visibleSecurity(engine, config, member));
    return response(config, 'saved watchlist', { state: items.some(({ state }) => state !== 'ready') ? 'partial' : 'ready',
      coverage: { unresolvedMembers: items.filter(({ state }) => state !== 'ready').length }, data, items, input });
  }
  if (kind === 'chartbook') {
    if (input.version && getWorkspace(db, kind, id)?.version !== input.version) {
      return response(config, 'saved ChartBook version', { state: 'definition_only', data });
    }
    const review = await bookRoute({
      method: 'GET', item: id, action: 'review', query: {}, body: {},
      resolvePoint(preset) {
        const { date: _date, dataVersion: _version, ...dimension } = preset;
        return resolvePoint(db, engine, { ...dimension, ...input.context, asOf: config.date, dataVersion: config.dataVersion });
      },
    });
    const point = resolvePoint(db, engine, { ...review.data.context, asOf: config.date, dataVersion: config.dataVersion });
    const { rows, sources, sort, state } = review.data;
    return response(point, 'saved ChartBook and prepared membership', { state, data: { ...data, sources, sort }, items: rows, input });
  }
  return response(config, 'saved market ChartBook', { state: 'definition_only', data });
}

function readJournals(db, point, input, now) {
  const from = input.from ?? point.pin.dateFrom;
  const through = input.to ?? point.date;
  if (through > point.date || from > through) throw researchError('Journal dates exceed the analysis pin or are out of order.');
  const historical = input.to != null || input.context?.asOf != null ||
    input.context?.dataVersion != null && point.dataVersion < dataVersion(db);
  const timestamp = now.toISOString();
  const sessionCutoff = historical ? through : null;
  const items = [];
  let missingAvailability = 0;
  let unavailableAtCutoff = 0;
  if (hasTable(db, 'journal_entries')) {
    const found = db.prepare(`SELECT id,as_of_date AS date,revision,model,
      data_version AS dataVersion,calculation_version AS calculationVersion,available_at AS availableAt,
      tradable_date AS tradableDate,output_json AS output,generated_at AS generatedAt,retrospective
      FROM journal_entries WHERE as_of_date BETWEEN ? AND ? AND data_version<=? AND calculation_version=?
      AND (? OR retrospective=0) ORDER BY as_of_date DESC,revision DESC,id`)
      .iterate(from, through, point.dataVersion, CALCULATION_VERSION, Number(!!input.includeRetrospective));
    for (const record of found) {
      const stamps = [record.generatedAt, record.availableAt];
      const times = stamps.map((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN);
      if (times.some((time) => !finite(time)) || times[0] > times[1]) {
        missingAvailability++;
      } else if (times.some((time) => time > now.getTime() || sessionCutoff && marketDay(time) > sessionCutoff)) {
        unavailableAtCutoff++;
      } else {
        items.push({ ...record, output: JSON.parse(record.output), retrospective: !!record.retrospective });
      }
    }
  }
  return response(point, 'stored private market journals', { items, input,
    coverage: { missingAvailability, unavailableAtCutoff },
    data: { availabilityCutoff: sessionCutoff ?? timestamp, availabilityCutoffMode: historical ? 'end_of_new_york_session_date' : 'current_instant',
      firstTradableDateMeaning: 'First exchange session after the New York calendar date when the journal became available.',
      includeRetrospective: !!input.includeRetrospective } });
}

export function createResearchEngine(db, { now = () => new Date(), workspaceWriter } = {}) {
  const engine = createEngine(db);
  const notes = createResearchNotes(db, engine);
  const book = createChartBook(db, engine, {
    readSnapshot: (point, options) => preparedSnapshot(db, engine, point, { velocity: options.velocity, ids: options.securityIds }),
    resolveScreen(point, definition) {
      const outcome = screenSaved(db, engine, point, definition);
      return outcome.state === 'ready' ? outcome : { rows: [], materialization: { preparationState: outcome.state } };
    },
  });

  function describe(input) {
    let point = null;
    try { point = resolvePoint(db, engine, input.context); }
    catch (error) {
      if (error.status !== 503) throw error;
    }
    const definitions = [
      ...BREADTH_METRICS.map((metric) => ({ ...metric, unit: 'percent', numeratorDenominator: true })),
      ...monitorKeys.map((key) => { const { test: _test, ...metric } = breadthMetric(key); return { ...metric, unit: 'percent', numeratorDenominator: true }; }),
      { key: 'adSpread', label: 'Advance / decline spread', family: 'Market breadth', unit: 'percentage points',
        definition: 'Percent advancing minus percent declining among comparable stocks.' },
      { key: 'adRatio', label: 'Advance / decline ratio', family: 'Market breadth', unit: 'ratio',
        definition: 'Number of advancing stocks divided by the number declining.' },
      ...stockFields.map((key) => ({ key, label: key, family: 'Prepared stock field', unit: units(key) })),
      { key: 'velocity12w', label: '12-week industry RS improvement', family: 'Industry strength', unit: 'percentile points',
        definition: 'Current industry relative-strength percentile minus the comparable percentile twelve weekly observations earlier.' },
    ];
    return response(point, 'research data dictionary', {
      state: point ? 'ready' : 'no_verified_analysis', items: definitions.filter(({ key, label, definition }) => noteText(input.q, key, label, definition)), input,
      coverage: point ? { firstVerifiedSession: point.pin.dateFrom, lastVerifiedSession: point.pin.date, sessions: point.pin.sessions } : {},
      data: { universes: summaries([...UNIVERSES, ...listWorkspace(db, 'universe')]),
        rankingModels: summaries([...BUILTIN_MODELS, ...listWorkspace(db, 'ranking-model')]),
        classifications: point ? defaults(db, point.pin).classifications : [], lists: listKinds,
        limitations: ['Prepared universe and ranking recipes only.', 'Historical data may contain missing sessions and incomplete comparable coverage.',
          'Historical outcomes are descriptive evidence and do not establish a forecast.'] },
    });
  }

  return {
    async run(name, input, principal) {
      if (name === 'create_watchlist' || name === 'create_screen') {
        if (!workspaceWriter) throw researchError('Workspace creation is unavailable.', 503);
        const saved = name === 'create_watchlist' ? workspaceWriter.createWatchlist(input, principal) : workspaceWriter.createScreen(input, principal);
        return response(null, 'saved workspace', { state: 'created', data: { saved } });
      }
      if (name === 'describe_research') return describe(input);
      const point = resolvePoint(db, engine, input.context);
      try { return await runAt(point, name, input, principal); }
      catch (error) {
        if (error.status !== 503) throw error;
        return response(point, 'prepared research archives', { state: 'unprepared', data: { reason: error.message } });
      }
    },
  };

  async function runAt(point, name, input, principal) {
    switch (name) {
      case 'search_stocks': {
        const snapshot = requiredSnapshot(db, engine, point, { fields: ['securityId', 'symbol', 'name', 'exchange', 'type', 'sector', 'industry', 'traded'] });
        const items = snapshot.stocks.filter((row) => noteText(input.q, row.symbol, row.name, row.securityId));
        const exact = (row) => Number(![row.symbol, row.securityId].some((text) => normalized(text) === normalized(input.q)));
        return response(point, 'prepared stock snapshot', { coverage: snapshot.coverage, input,
          items: items.sort((left, right) => exact(left) - exact(right) || left.symbol.localeCompare(right.symbol) || left.securityId.localeCompare(right.securityId))
            .map((row) => pick(row, ['securityId', 'symbol', 'name', 'exchange', 'type', 'sector', 'industry', 'traded'])) });
      }
      case 'search_groups': {
        const snapshot = requiredSnapshot(db, engine, point, { fields: [] });
        const items = snapshot.groups.filter((group) => (!input.level || group.level === input.level) && noteText(input.q, group.id, group.name));
        items.sort((left, right) => left.name.localeCompare(right.name, 'en') || left.id.localeCompare(right.id, 'en'));
        return response(point, 'prepared group snapshot', { coverage: snapshot.coverage, input,
          items: items.map((row) => pick(row, ['id', 'name', 'level', 'parent', 'rank', 'percentile', 'count', 'rankedCount', 'medianRS'])) });
      }
      case 'list_workspace_lists': {
        const items = (input.kind ? [input.kind] : listKinds).flatMap((kind) =>
          summaries(listWorkspace(db, kind)).map((row) => ({ ...row, kind })));
        return response(point, 'saved workspace list metadata', { items, input });
      }
      case 'read_workspace_list': return savedList(db, engine, point, input, book);
      case 'read_stock': {
        const security = securityAt(engine, point, input.security);
        const fields = input.fields ?? stockColumns;
        const velocity = screenNeedsVelocity(fields);
        const snapshot = requiredSnapshot(db, engine, point, { velocity, ids: [security.securityId], fields });
        return response(point, 'prepared stock snapshot', { state: snapshot.stocks.length ? 'ready' : 'outside_universe',
          coverage: snapshot.coverage, data: { security, fields: pick(snapshot.stocks[0], fields),
            units: Object.fromEntries(fields.map((key) => [key, units(key)])) } });
      }
      case 'read_stock_history': return selectStockHistory(db, engine, point, input);
      case 'read_market_history': return marketHistory(db, engine, point, input);
      case 'market_timing': {
        const { history, state, session, modelVersion, basis, profile, instruments, reason } =
          readPreparedMarketTiming(db, point, { limit: input.sessions ?? 252 });
        const rows = history.filter(({ date }) => date >= point.pin.dateFrom);
        return response(point, 'prepared session timing archive', { state, items: rows, input,
          coverage: { observations: rows.length, from: rows[0]?.date ?? null, through: rows.at(-1)?.date ?? null },
          data: { session, modelVersion, basis, profile, instruments, reason } });
      }
      case 'read_metric_constituents': return metricConstituents(db, engine, point, input);
      case 'screen_stocks': {
        const definition = screeningOptions(input);
        const snapshot = requiredSnapshot(db, engine, point, { velocity: screenNeedsVelocity(definition) });
        const screened = screenStocks(snapshot, definition, { all: true });
        return response(point, 'prepared stock snapshot', { coverage: { ...snapshot.coverage, universeCount: screened.universeCount },
          items: screened.rows.map((row) => ({ ...pick(row, ['securityId', 'symbol', ...definition.columns]), subsetRank: row.subsetRank })), input,
          data: { units: Object.fromEntries(definition.columns.map((key) => [key, units(key)])), filters: input.filters ?? [], sort: definition.sort } });
      }
      case 'industry_strength': return industryStrength(db, engine, point, input);
      case 'benchmark_event_study': return benchmarkStudy(db, engine, point, input);
      case 'historical_analogs': return analogStudy(db, engine, point, input);
      case 'read_research_notes': {
        if (input.subjectType === 'market' && input.subjectId === 'journal' && !principal.scopes.includes('research:journals')) {
          throw researchError('Journal notes also require journal scope.', 403);
        }
        if (input.to && input.to > point.date) throw researchError('Note dates exceed the analysis pin.');
        const stored = notes.route({ method: 'GET', query: { ...input, date: point.date },
          resolvePoint: () => point, resolveIdentity: (config, id) => securityAt(engine, config, id) }).data;
        return response(point, 'saved private research notes', { data: { subject: stored.subject }, items: stored.notes, input });
      }
      case 'read_journals': return readJournals(db, point, input, now());
      default: throw researchError('Research tool not found', 404);
    }
  }
}

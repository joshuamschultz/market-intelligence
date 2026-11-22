import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BREADTH_METRICS } from './breadth.mjs';
import { reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { CALCULATION_VERSION, getWorkspace, isoDate, listWorkspace, normalizeSymbol, storeWorkspace } from './database.mjs';
import { expectedSessions } from './calendar.mjs';
import { readMaterializedHistory } from './materialization.mjs';
import { readPreparedChart, readPreparedDetail } from './prepared-details.mjs';
import { hasPreparedSnapshot, readPreparedSnapshot } from './prepared-snapshots.mjs';
import { rankBy } from './ranking.mjs';

const bookKind = 'chartbook';
const marketBookKind = 'market-chartbook';
const noteKind = 'chartbook-note';
const maxChartSessions = 1260;
const chartWarmup = 50;
const marketWarmup = 9;
const monitorBreadth = ['up_13pct_34d', 'down_13pct_34d'];
const marketViews = ['combined', 'market', 'industries'];
export const chartBookIndustryJob = 'chartbook-industry';
const builtins = [
  ['new-high-20d', 'New 20-session highs', 'new_high_20d'],
  ['new-low-20d', 'New 20-session lows', 'new_low_20d'],
  ['new-high-252d', 'New 252-session highs', 'new_high_252d'],
  ['new-low-252d', 'New 252-session lows', 'new_low_252d'],
  ['leaders-1w', 'Top 2% · 1 week', 'return_5d', true],
  ['leaders-1m', 'Top 2% · 1 month', 'return_21d', true],
  ['leaders-3m', 'Top 2% · 3 months', 'return_63d', true],
  ['leaders-6m', 'Top 2% · 6 months', 'return_126d', true],
  ['leaders-1y', 'Top 2% · 1 year', 'return_252d', true],
  ['top-100-rs', 'Top 100 · Composite RS', 'rsRank'],
].map(([id, label, field, percentile]) => ({ id, label, field, percentile, type: 'builtin' }));
builtins.push(...[
  ['top-rs', 'Top RS'], ['fast-improvers', 'Fast Improvers'], ['new-top-decile', 'New Top-Decile Entries'],
  ['emerging-leaders', 'Emerging Leaders'], ['industry-leaders', 'Industry Leaders'], ['weakening-leaders', 'Weakening Leaders'],
].map(([id, label]) => ({ id, label, rankingList: id, type: 'builtin' })));
const definitions = new Map(builtins.map((source) => [source.id, source]));
const pricePeriods = { '1w': [5, '1W'], '1m': [21, '1M'], '3m': [63, '3M'], '6m': [126, '6M'], '1y': [252, '1Y'] };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = Number.isFinite;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const goodId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\u0000-\u001f]/.test(value);
const openTable = (db) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chartbook_industry_history'").get();

function analysisContext(config) {
  const { date, dataVersion, basis, benchmark, classification, observedReferenceDate, referenceMode: reference,
    averages, windows, volumeWindows, breadthKeys, includeAllTimeHigh, threshold, themes } = config;
  return { date, dataVersion, calculationVersion: CALCULATION_VERSION, basis, benchmark, classification, observedReferenceDate, reference,
    universe: config.universe.id, universeVersion: config.universe.version, model: config.model.id, modelVersion: config.model.version,
    averages, windows, volumeWindows, breadthKeys, includeAllTimeHigh, threshold, themes };
}

function compositeContext(engine, config) {
  return config.model.id === 'composite' ? config
    : engine.context({ ...analysisContext(config), model: 'composite', modelVersion: 1 });
}

function validateSort(value) {
  if (value != null && !isObject(value)) throw bad('ChartBook sort must be an object');
  const { metric = 'composite-rs', direction = 'desc', period = '1m' } = value ?? {};
  if (!['composite-rs', 'selected-rs', 'price-performance'].includes(metric)) throw bad('Choose a supported ChartBook sort metric');
  if (!['asc', 'desc'].includes(direction)) throw bad('Choose highest first or lowest first');
  if (metric === 'price-performance' && !Object.hasOwn(pricePeriods, period)) throw bad('Choose a supported price performance period');
  return { metric, direction, ...(metric === 'price-performance' && { period }) };
}

function chosenContext(value) {
  if (value == null) return {};
  if (!isObject(value)) throw bad('ChartBook context must be an object');
  const keys = ['date', 'dataVersion', 'universe', 'universeVersion', 'model', 'modelVersion', 'basis', 'benchmark',
    'classification', 'reference', 'observedReferenceDate', 'averages', 'windows', 'volumeWindows', 'breadthKeys',
    'includeAllTimeHigh', 'threshold', 'themes'];
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function definedSources(db) {
  const resource = (kind) => listWorkspace(db, kind).map(({ id, name, version, definition }) => ({
    id, name, label: name, version, type: kind, ...(kind === 'watchlist' && {
      writable: !definition.screenId, definition: { screenId: definition.screenId ?? null, members: definition.members ?? [] },
    }),
  }));
  return { builtins: builtins.map(({ type, id, label }) => ({ type, id, label })), screens: resource('screen'), watchlists: resource('watchlist') };
}

function validateDefinition(db, definition) {
  if (!isObject(definition) || !Array.isArray(definition.sources) || definition.sources.length > 64) {
    throw bad('Select up to 64 ChartBook sources');
  }
  const sources = definition.sources.map((source, index) => {
    if (!isObject(source)) throw bad('Invalid ChartBook source');
    if (source.type === 'manual') {
      let members = source.members;
      if (typeof members === 'string') members = members.split(/[\s,]+/).filter(Boolean);
      if (!Array.isArray(members) || members.length > 20_000 || members.some((item) => !goodId(item?.securityId ?? item))) {
        throw bad('Manual sources need up to 20,000 valid ticker symbols or permanent security IDs');
      }
      const label = source.label == null ? 'Manual list' : source.label;
      if (typeof label !== 'string' || !label.trim() || label.length > 100) throw bad('Manual source label must contain 1–100 characters');
      return { type: 'manual', id: goodId(source.id) ? source.id : `manual-${index + 1}`, label: label.trim(),
        members: [...new Set(members.map((item) => typeof item === 'string' ? item.trim() : item.securityId))] };
    }
    if (!['builtin', 'screen', 'watchlist'].includes(source.type) || !goodId(source.id) ||
      source.type === 'builtin' && !definitions.has(source.id)) throw bad('Unknown ChartBook source');
    const version = source.version == null ? null : Number(source.version);
    if (version != null && (!Number.isSafeInteger(version) || version < 1)) throw bad('Source version must be a positive integer');
    return { type: source.type, id: source.id, ...(version != null && source.type !== 'builtin' && { version }) };
  });
  const id = definition.defaultWatchlistId || null;
  const watchlist = id && getWorkspace(db, 'watchlist', id);
  if (id && (!goodId(id) || !watchlist || watchlist.definition.screenId)) throw bad('Choose an existing manual watchlist as the default');
  return { sources, defaultWatchlistId: id, context: chosenContext(definition.context), sort: validateSort(definition.sort) };
}

function readableIdentity(db, config) {
  const exact = db.prepare(`SELECT definition FROM reference_revisions WHERE security_id=? AND version<=?
    AND (?=0 OR known_at<=?) ORDER BY version DESC LIMIT 1`);
  const byAlias = db.prepare('SELECT DISTINCT security_id FROM identifiers WHERE symbol=? ORDER BY security_id');
  const read = (id) => {
    const row = exact.get(id, config.dataVersion, Number(config.basis === 'known'), config.date);
    return row ? JSON.parse(row.definition) : null;
  };
  const active = (ref) => {
    if (!ref || ref.listing_date && ref.listing_date > config.date || ref.delisting_date && ref.delisting_date < config.date) return null;
    const alias = (ref.identifiers ?? []).filter((item) => item.valid_from <= config.date && (!item.valid_to || item.valid_to >= config.date))
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from) || a.symbol.localeCompare(b.symbol))[0];
    return alias ? { securityId: ref.id, symbol: alias.symbol, name: ref.name, exchange: alias.exchange, type: ref.type } : null;
  };
  const cache = new Map();
  return function identify(input) {
    if (cache.has(input)) return cache.get(input);
    const direct = read(input);
    let match = active(direct);
    if (!direct) {
      const symbol = normalizeSymbol(input);
      const candidates = byAlias.all(symbol).flatMap(({ security_id: id }) => {
        const ref = read(id);
        const item = active(ref);
        return item && ref.identifiers.some((alias) => alias.symbol === symbol && alias.valid_from <= config.date) ? [item] : [];
      });
      const current = candidates.filter((item) => item.symbol === symbol);
      if (current.length === 1 || !current.length && candidates.length === 1) match = current[0] ?? candidates[0];
    }
    cache.set(input, match);
    return match;
  };
}

export function readChartBookSnapshot(db, engine, point, { velocity = false, securityIds } = {}) {
  const compact = readPreparedSnapshot(db, engine, point, { velocity, securityIds });
  if (compact) return compact;
  if (!engine.snapshotAvailable(point, { velocity })) return null;
  const archived = engine.snapshot(point, { velocity, persist: false, cache: true });
  if (!securityIds) return archived;
  const wanted = new Set(securityIds);
  return { ...archived, stocks: archived.stocks.filter((row) => wanted.has(row.securityId)) };
}

function pendingState(materialization) {
  return { state: 'pending', count: null, materialization: materialization ?? { preparationState: 'unregistered' } };
}

function identityFields(row) {
  return { securityId: row.securityId, symbol: row.symbol, name: row.name, exchange: row.exchange, type: row.type,
    industryId: row.industryId ?? null };
}

function selectBuiltin(snapshot, source) {
  if (source.percentile) {
    const ranks = rankBy(snapshot.stocks, (row) => row.traded ? row[source.field] : null);
    const count = Math.ceil(ranks.size * 0.02);
    return { rows: snapshot.stocks.filter((row) => (ranks.get(row.securityId)?.rank ?? Infinity) <= count)
      .sort((a, b) => ranks.get(a.securityId).rank - ranks.get(b.securityId).rank), comparable: ranks.size };
  }
  if (source.field === 'rsRank') {
    const comparable = snapshot.stocks.filter((row) => row.traded && finite(row.rsRank));
    return { rows: comparable.toSorted((a, b) => a.rsRank - b.rsRank).slice(0, 100), comparable: comparable.length };
  }
  const comparable = snapshot.stocks.filter((row) => row.traded && typeof row[source.field] === 'boolean');
  return { rows: comparable.filter((row) => row[source.field] === true), comparable: comparable.length };
}

function readNote(db, identity, date) {
  const item = getWorkspace(db, noteKind, digest([identity.securityId, date]));
  return { securityId: identity.securityId, date, markdown: item?.definition.markdown ?? '',
    version: item?.version ?? 0, updatedAt: item?.updated_at ?? null };
}

function saveNote(db, identity, date, markdown) {
  if (typeof markdown !== 'string' || markdown.length > 20_000) throw bad('Use up to 20,000 characters for a stock note');
  const previous = readNote(db, identity, date);
  if (markdown !== previous.markdown) storeWorkspace(db, noteKind, { name: date, definition: { securityId: identity.securityId, date, markdown } },
    digest([identity.securityId, date]));
  return readNote(db, identity, date);
}

function industryRecipe(config, group) {
  return digest([CALCULATION_VERSION, config.dataVersion, config.basis, config.date, config.classification, group.id,
    [...new Set(group.memberIds ?? [])].sort()]);
}

function chartSessions(config, count) {
  return config.earliestDate && config.date ? expectedSessions(config.earliestDate, config.date).slice(-count) : [];
}

function chartLookback(value) {
  const lookback = value == null ? 126 : Number(value);
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > maxChartSessions) throw bad('ChartBook lookback must be 1–1,260 sessions');
  return lookback;
}

function marketDeck(value) {
  if (!isObject(value) || !marketViews.includes(value.view)) throw bad('Choose a Market and Industry ChartBook view');
  const { industryIds = null } = value;
  if (industryIds != null && (!Array.isArray(industryIds) || industryIds.length > 1000 || industryIds.some((id) => !goodId(id)))) {
    throw bad('Choose valid industry groups for this ChartBook');
  }
  return { view: value.view, industryIds: industryIds == null ? null : [...new Set(industryIds)] };
}

function compactBreadth(snapshot, standardKeys) {
  if (!snapshot) return {};
  return Object.fromEntries(standardKeys.flatMap((key) => {
    const metric = snapshot.breadth?.[key];
    return metric ? [[key, [metric.value, metric.numerator, metric.denominator]]] : [];
  }));
}

function visitStoredHistory(db, engine, config, sessions, visit) {
  let prepared = 0;
  for (let start = 0; start < sessions.length; start += 63) {
    const span = sessions.slice(start, start + 63);
    const { rows } = readMaterializedHistory(db, engine, config, { from: span[0], to: span.at(-1), limit: span.length });
    for (const row of rows) visit(row);
    prepared += rows.length;
  }
  return prepared === sessions.length;
}

function storedMarketHistory(db, engine, config, lookback) {
  const sessions = chartSessions(config, lookback + marketWarmup);
  const monitor = engine.context({ ...analysisContext(config), breadthKeys: [...new Set([...config.breadthKeys, ...monitorBreadth])] });
  const keys = ['adSpread', ...BREADTH_METRICS.map(({ key }) => key)];
  const observations = new Map();
  const project = (snapshot, hasMonitor = false) => {
    if (observations.has(snapshot.date)) return;
    const a = snapshot.aggregates || {};
    observations.set(snapshot.date, { date: snapshot.date, state: 'prepared', coverage: snapshot.coverage?.state,
      traded: snapshot.coverage?.traded ?? null, listed: snapshot.coverage?.listed ?? null,
      breadth: compactBreadth(snapshot, hasMonitor ? [...keys, ...monitorBreadth] : keys),
      volume: {
        upDollar: a.dollarVolumeObservations > 0 ? a.upDollar : null, downDollar: a.dollarVolumeObservations > 0 ? a.downDollar : null,
        upVolume: a.volumeObservations > 0 ? a.upVolume : null, downVolume: a.volumeObservations > 0 ? a.downVolume : null,
        dollarVolumeObservations: a.dollarVolumeObservations ?? null, volumeObservations: a.volumeObservations ?? null,
      } });
  };
  const monitorDates = new Set();
  visitStoredHistory(db, engine, monitor, sessions, (snapshot) => { monitorDates.add(snapshot.date); project(snapshot, true); });
  if (observations.size < sessions.length) visitStoredHistory(db, engine, config, sessions, project);
  const rows = sessions.map((date) => observations.get(date) || { date, state: 'unprepared' });
  const visible = rows.slice(-lookback);
  const prepared = visible.filter(({ state }) => state === 'prepared').length;
  return { date: config.date, dataVersion: config.dataVersion, context: analysisContext(config), rows, lookback,
    state: !prepared ? 'unprepared' : prepared === visible.length ? 'ready' : 'partial',
    prepared, expected: visible.length, monitorPrepared: visible.reduce((total, row) => total + Number(monitorDates.has(row.date)), 0) };
}

function usableBar(bar) {
  return !!bar?.traded && !bar.missing && !bar.priceQuarantined && !bar.unverifiedSplit && finite(bar.close) && bar.close > 0;
}

function comparableCurve(sessions, readings) {
  // A missing return breaks the compounding path. Show the continuous segment
  // ending at the latest available observation, leaving other sessions blank.
  let stop = sessions.length - 1;
  while (stop >= 0 && !finite(readings.get(sessions[stop])?.return)) stop--;
  let start = stop;
  while (start > 0 && finite(readings.get(sessions[start - 1])?.return)) start--;
  let level = 100;
  return sessions.map((date, index) => {
    const reading = readings.get(date);
    const inSegment = index >= start && index <= stop && stop >= 0;
    const value = !inSegment ? null : index === start ? 100 : (level *= 1 + reading.return);
    return { date, value, observations: reading?.observations ?? null, expected: reading?.expected ?? null };
  });
}

function datedIndustries(db, engine, config, sessions) {
  const result = new Map();
  if (sessions.length < 2) return { result, complete: true };
  const available = db.prepare('SELECT 1 FROM classifications WHERE system=? AND version<=? AND effective_from<? AND known_at<? LIMIT 1')
    .get(config.classification, config.dataVersion, config.date, config.date);
  if (!available) return { result, complete: false };
  const complete = visitStoredHistory(db, engine, config, sessions, ({ date, groups }) => {
    for (const group of groups ?? []) {
      if (group.level !== 'industry' || !finite(group.dailyReturn)) continue;
      if (!result.has(group.id)) result.set(group.id, new Map());
      result.get(group.id).set(date, { return: group.dailyReturn, expected: group.count,
        observations: group.counts?.dailyReturn ?? null });
    }
  });
  return { result, complete };
}

function curveState(rows) {
  const observations = rows.reduce((count, row) => count + Number(finite(row.value)), 0);
  return observations < 2 ? 'unavailable' : observations < rows.length ? 'partial' : 'ready';
}

function readBenchmark(db, config, identify, sessions, count) {
  const security = identify('SPY');
  const archive = security ? readPreparedDetail(db, config, security.securityId, { lookback: count, benchmark: 'SPY' }) : null;
  const bars = new Map((archive?.detail?.chartBars ?? []).map((row) => [row.date, row]));
  const rows = sessions.map((date) => ({ date, close: usableBar(bars.get(date)) ? bars.get(date).close : null }));
  return { symbol: 'SPY', state: rows.some(({ close }) => close != null) ? 'ready' : archive?.state ?? 'unavailable', rows };
}

function registeredProxy(db, jobKey) {
  const row = db.prepare(`SELECT id,status,progress,error,json_extract(result,'$.state') AS resultState FROM jobs WHERE type=? AND json_extract(payload,'$.jobKey')=?
    ORDER BY rowid DESC LIMIT 1`).get(chartBookIndustryJob, jobKey);
  return row && { jobId: row.id, status: row.status, progress: row.progress, error: row.error, resultState: row.resultState,
    pending: row.status === 'queued' || row.status === 'running' };
}

function industryWorkspaceKey(config) {
  return digest([chartBookIndustryJob, analysisContext(config)]);
}

export function prepareChartBookIndustries(db, engine, payload, progress = () => {}) {
  const config = engine.context(payload.context);
  if (config.basis !== 'reconstructed' || config.date !== config.latestDate) {
    return { state: 'unavailable', reason: 'Current-member industry proxies apply only to the latest reconstructed session.' };
  }
  const snapshot = readChartBookSnapshot(db, engine, config);
  if (!snapshot) return { state: 'waiting-for-snapshot', date: config.date, dataVersion: config.dataVersion };
  const sessions = chartSessions(config, maxChartSessions + chartWarmup + 1);
  if (sessions.length < 2) return { state: 'unavailable', date: config.date };
  db.exec(`CREATE TABLE IF NOT EXISTS chartbook_industry_history (
    recipe TEXT PRIMARY KEY, calculation_version TEXT NOT NULL, data_version INTEGER NOT NULL, anchor_date TEXT NOT NULL,
    industry_id TEXT NOT NULL, value BLOB NOT NULL, prepared_at TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS chartbook_industry_inputs (
      recipe TEXT PRIMARY KEY, value BLOB NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS chartbook_industry_history_anchor ON chartbook_industry_history(calculation_version,anchor_date,data_version)`);
  const read = db.prepare('SELECT 1 FROM chartbook_industry_history WHERE recipe=?');
  const put = db.prepare('INSERT INTO chartbook_industry_history VALUES (?,?,?,?,?,?,?)');
  const saveInputs = db.prepare('INSERT INTO chartbook_industry_inputs VALUES (?,?)');
  const readInputs = db.prepare('SELECT value FROM chartbook_industry_inputs WHERE recipe=?');
  const scopes = snapshot.groups.filter((group) => group.level === 'industry' && group.memberIds?.length)
    .map((group) => ({ group, recipe: industryRecipe(config, group) })).filter(({ recipe }) => !read.get(recipe));
  const positions = new Map(sessions.map((date, index) => [date, index]));
  const priorDate = sessions.at(-2);
  const firstObserved = db.prepare(`SELECT date FROM price_revisions WHERE security_id=? AND date>=? AND date<=? AND version<=?
    ORDER BY date LIMIT 1`);
  const candidates = db.prepare(`SELECT DISTINCT data_version FROM chartbook_industry_history
    WHERE calculation_version=? AND anchor_date=? AND data_version<? ORDER BY data_version DESC`)
    .all(CALCULATION_VERSION, priorDate, config.dataVersion).map(({ data_version }) => data_version);
  const bounds = reusableArchiveVersions(db, { ...config, referenceMode: 'as-of' }, candidates);
  const predecessors = candidates.filter((version) => usableArchiveRow(bounds, { date: priorDate, data_version: version }));
  const splitting = new Set(db.prepare(`SELECT DISTINCT security_id FROM corporate_actions
    WHERE date=? AND version<=? AND type='split' AND factor>0`).all(config.date, config.dataVersion).map(({ security_id }) => security_id));
  let pinned;
  let written = 0;
  let reused = 0;
  let cold = 0;
  for (const [index, { group, recipe }] of scopes.entries()) {
    const members = [...new Set(group.memberIds)].sort();
    const counts = new Uint32Array(sessions.length);
    const totals = new Float64Array(sessions.length);
    let prior;
    if (!members.some((id) => splitting.has(id))) {
      for (const version of predecessors) {
        const row = readInputs.get(industryRecipe({ ...config, date: priorDate, dataVersion: version }, group));
        if (row) { prior = new Map(JSON.parse(gunzipSync(row.value))); break; }
      }
    }
    const current = new Map();
    if (prior) for (const id of members) {
      const { bars, sourceDataVersion } = readPreparedChart(db, config, id, 2);
      if (sourceDataVersion !== config.dataVersion || bars.length !== 2 || bars[0].date !== priorDate || bars[1].date !== config.date) break;
      current.set(id, bars);
    }
    const boundaryMoved = prior && prior.keys().next().value < sessions[0];
    const changedBoundary = boundaryMoved && members.some((id) => {
      const first = firstObserved.get(id, sessions[0], config.date, config.dataVersion)?.date;
      if (!first) return false;
      // Starting a raw history at this quote clears its prior-quote split signal.
      // A flagged statement can therefore change the first comparable return.
      const left = readPreparedChart(db, { ...config, date: first }, id, 1);
      return left.state !== 'ready' || left.bars[0]?.unverifiedSplit;
    });
    const reuse = prior && !changedBoundary && current.size === members.length && sessions.slice(0, -1).every((date) => prior.has(date));
    if (reuse) {
      reused++;
      for (const [previous, bar] of current.values()) if (usableBar(previous) && usableBar(bar)) {
        counts[sessions.length - 1]++;
        totals[sessions.length - 1] += bar.close / previous.close - 1;
      }
    } else {
      cold++;
      pinned ??= engine.historyBatch?.({ ...config, currentVersion: false }, [config.date]) ?? { ...config, currentVersion: false };
      for (let offset = 0; offset < members.length; offset += 32) {
        const histories = engine.studyPrices(pinned, members.slice(offset, offset + 32), sessions[0], config.date);
        for (const bars of histories.values()) {
          let previous;
          for (const bar of bars) {
            const position = positions.get(bar.date);
            if (usableBar(bar) && usableBar(previous) && positions.get(previous.date) === position - 1) {
              counts[position]++;
              totals[position] += bar.close / previous.close - 1;
            }
            previous = bar;
          }
        }
      }
    }
    const minimum = Math.max(1, Math.ceil(members.length / 2));
    const readings = new Map(sessions.map((date, position) => [date, reuse && position > 0 && position < sessions.length - 1 ? prior.get(date)
      : { return: counts[position] >= minimum ? totals[position] / counts[position] : null,
        observations: counts[position], expected: members.length }]));
    const rows = comparableCurve(sessions, readings);
    db.exec('BEGIN IMMEDIATE');
    try {
      put.run(recipe, CALCULATION_VERSION, config.dataVersion, config.date, group.id, gzipSync(JSON.stringify(rows), { level: 1 }), new Date().toISOString());
      saveInputs.run(recipe, gzipSync(JSON.stringify([...readings]), { level: 1 }));
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    written++;
    progress((index + 1) / Math.max(1, scopes.length));
  }
  return { state: 'complete', date: config.date, dataVersion: config.dataVersion, written, reused, cold };
}

export function scheduleChartBookIndustries(db, engine, base, enqueueJob, { prepareNow = false } = {}) {
  const enqueued = [];
  const requested = new Set();
  for (const { definition } of listWorkspace(db, bookKind)) {
    if (definition.context?.date || definition.context?.dataVersion) continue;
    let config;
    try { config = engine.context({ ...base, ...definition.context }); }
    catch { continue; }
    if (config.basis !== 'reconstructed' || !config.date || config.date !== config.latestDate) continue;
    if (!engine.snapshotAvailable(config) && !hasPreparedSnapshot(db, engine, config)) continue;
    const jobKey = industryWorkspaceKey(config);
    if (requested.has(jobKey)) continue;
    requested.add(jobKey);
    const current = registeredProxy(db, jobKey);
    if (!prepareNow && (current?.pending || current?.status === 'failed' || current?.resultState === 'complete')) continue;
    enqueued.push(enqueueJob(chartBookIndustryJob, { context: analysisContext(config), jobKey }, jobKey, current));
  }
  return enqueued;
}

export function createChartBook(db, engine, { readSnapshot, pending, resolveScreen, readHealth, enqueue } = {}) {
  const historyCache = new Map();
  const benchmarkCache = new Map();
  const fullSnapshots = new Map();
  const industryCatalogs = new Map();
  const reader = readSnapshot ?? ((config, flags) => readChartBookSnapshot(db, engine, config, flags));
  const pendingFor = pending ?? (() => ({ preparationState: 'unregistered' }));
  const snapshotFor = (config, flags = {}) => {
    const key = JSON.stringify([analysisContext(config), !!flags.velocity]);
    let value = fullSnapshots.get(key);
    if (value) {
      if (!flags.securityIds) return value;
      const wanted = new Set(flags.securityIds);
      return { ...value, stocks: value.stocks.filter(({ securityId }) => wanted.has(securityId)) };
    }
    value = reader(config, flags);
    if (value && !flags.securityIds) {
      fullSnapshots.set(key, value);
      if (fullSnapshots.size > 3) fullSnapshots.delete(fullSnapshots.keys().next().value);
    }
    return value;
  };

  function evaluate(definition, config) {
    const identify = readableIdentity(db, config);
    const members = new Map();
    const sourceStatus = definition.sources.map((source) => {
      const saved = ['screen', 'watchlist'].includes(source.type) ? getWorkspace(db, source.type, source.id, source.version) : null;
      const signal = definitions.get(source.id);
      const badge = { type: source.type, id: source.id, label: source.label || saved?.name || signal?.label || source.id,
        ...(saved && { version: saved.version }) };
      try {
        let result;
        if (source.type === 'builtin') {
          if (signal.rankingList) result = resolveScreen(config, { rankingList: signal.rankingList }, snapshotFor);
          else {
            const point = source.id === 'top-100-rs' ? compositeContext(engine, config) : config;
            const snapshot = snapshotFor(point);
            if (!snapshot) return { ...badge, ...pendingState(pendingFor(point)) };
            result = selectBuiltin(snapshot, signal);
          }
        } else if (source.type === 'manual' || saved?.kind === 'watchlist' && !saved.definition.screenId) {
          const unavailable = [];
          const rows = [];
          for (const input of source.members ?? saved.definition.members ?? []) {
            const stock = identify(input);
            if (stock) rows.push(stock);
            else unavailable.push({ input, reason: 'No unique security was available at the selected date and revision.' });
          }
          result = { rows, unavailable };
        } else {
          const screen = source.type === 'screen' ? saved : saved?.definition.screenId && getWorkspace(db, 'screen', saved.definition.screenId);
          if (!screen) return { ...badge, state: 'error', count: null, error: saved ? 'The watchlist’s source screen was deleted.' : 'This saved source was deleted or is unavailable.' };
          result = resolveScreen(config, screen.definition, snapshotFor);
        }
        if (result.materialization) return { ...badge, ...pendingState(result.materialization) };
        const identities = new Set();
        for (const stock of result.rows) {
          if (identities.has(stock.securityId)) continue;
          identities.add(stock.securityId);
          if (!members.has(stock.securityId)) members.set(stock.securityId, { ...identityFields(stock), sources: [] });
          const row = members.get(stock.securityId);
          row.industryId ??= stock.industryId ?? null;
          row.sources.push(badge);
        }
        return { ...badge, state: 'ready', count: identities.size, comparable: result.comparable ?? result.rankingList?.ranked,
          ...(result.unavailable?.length && { unavailable: result.unavailable }) };
      } catch (error) {
        if (error.preparation) return { ...badge, ...pendingState(error.preparation.materialization) };
        return { ...badge, state: 'error', count: null, error: error.message };
      }
    });
    const state = sourceStatus.every((source) => source.state === 'ready' && !source.unavailable?.length) ? 'ready'
      : sourceStatus.length && sourceStatus.every((source) => source.state === 'pending') ? 'pending' : 'partial';
    const rows = [...members.values()];
    const sort = orderReview(rows, config, validateSort(definition.sort));
    return { context: analysisContext(config), date: config.date, dataVersion: config.dataVersion,
      sources: sourceStatus, rows, total: members.size, state, sort };
  }

  function orderReview(rows, config, sort) {
    const { metric, direction, period } = sort;
    const price = metric === 'price-performance';
    const point = metric === 'composite-rs' ? compositeContext(engine, config) : config;
    const securityIds = rows.map(({ securityId }) => securityId);
    const snapshot = securityIds.length ? snapshotFor(point, { securityIds }) ?? snapshotFor(point, { securityIds, velocity: true }) : null;
    const selected = new Map(snapshot?.stocks.map((row) => [row.securityId, row]) ?? []);
    const field = price ? `return_${pricePeriods[period][0]}d` : 'rsScore';
    const label = price ? `${pricePeriods[period][1]} price performance` : metric === 'composite-rs' ? 'Composite RS' : config.model.name;
    let comparable = 0;
    for (const row of rows) {
      const stock = selected.get(row.securityId);
      const available = stock?.traded && finite(stock[field]) && (price || finite(stock.rsRank));
      row.sortValue = available ? stock[field] : null;
      row.sortRank = available && !price ? stock.rsRank : null;
      if (available) comparable++;
    }
    rows.sort((a, b) => {
      if ((a.sortValue == null) !== (b.sortValue == null)) return a.sortValue == null ? 1 : -1;
      const order = a.sortValue == null ? 0 : direction === 'desc' ? b.sortValue - a.sortValue : a.sortValue - b.sortValue;
      return order || a.symbol.localeCompare(b.symbol, 'en') || a.securityId.localeCompare(b.securityId, 'en');
    });
    if (price) {
      let rank, previous;
      for (let index = 0; index < comparable; index++) {
        const row = rows[direction === 'desc' ? index : comparable - index - 1];
        if (row.sortValue !== previous) rank = index + 1;
        row.sortRank = rank;
        previous = row.sortValue;
      }
    }
    return { ...sort, label, comparable, rankScope: price ? 'book' : 'universe',
      state: !rows.length || comparable === rows.length ? 'ready' : !snapshot ? 'pending' : comparable ? 'partial' : 'unavailable',
      ...(!snapshot && rows.length && { materialization: pendingFor(point) }) };
  }

  function industryComparison(config, group, sessions) {
    if (!group?.id) return { state: 'unavailable', rows: [], reason: 'No industry was available for this stock in the selected classification.' };
    const identity = { id: group.id, name: group.name };
    const key = JSON.stringify([analysisContext(config), sessions[0], sessions.at(-1)]);
    let dated = historyCache.get(key);
    if (!dated || Date.now() >= dated.expires) {
      const { result, complete } = datedIndustries(db, engine, config, sessions);
      dated = { data: result, expires: complete ? Infinity : Date.now() + 15_000 };
      historyCache.set(key, dated);
      if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
    }
    const exact = comparableCurve(sessions, dated.data.get(group.id) ?? new Map());
    const state = curveState(exact);
    if (state !== 'unavailable') return { ...identity, state, rows: exact, method: 'dated-equal-weight',
      label: 'Industry equal-weight proxy · dated membership', reason: state === 'partial' ? 'Only the latest continuous dated-return segment is shown.' : undefined };
    const eligible = config.basis === 'reconstructed' && config.date === config.latestDate && group.memberIds?.length;
    const saved = eligible && openTable(db) ? db.prepare('SELECT value FROM chartbook_industry_history WHERE recipe=?').get(industryRecipe(config, group)) : null;
    if (saved) {
      const byDate = new Map(JSON.parse(gunzipSync(saved.value)).map((row) => [row.date, row]));
      const rows = sessions.map((date) => byDate.get(date) ?? { date, value: null });
      const proxy = curveState(rows);
      return { ...identity, state: proxy, rows, method: 'current-membership-proxy',
        label: 'Industry equal-weight proxy · current members', reason: proxy === 'unavailable'
          ? 'Too few current members have comparable quotes.' : 'Retrospective price comparison for the current roster. Historical constituents are unavailable.' };
    }
    const preparing = eligible ? registeredProxy(db, industryWorkspaceKey(config)) : null;
    return { ...identity, state: preparing?.pending ? 'pending' : 'unavailable', rows: [], method: 'dated-equal-weight',
      label: 'Industry equal-weight proxy', preparation: preparing ?? undefined,
      canPrepare: !!eligible && !preparing?.pending,
      reason: eligible ? 'Dated industry returns are unavailable. Prepare the current-membership proxy for this session.'
        : 'Dated industry returns are unavailable for the selected historical context.' };
  }

  function marketIndustries(config) {
    const key = JSON.stringify(analysisContext(config));
    if (industryCatalogs.has(key)) return industryCatalogs.get(key);
    const snapshot = snapshotFor(config, { securityIds: [] }) ?? snapshotFor(config, { securityIds: [], velocity: true });
    if (!snapshot) return { state: 'unprepared', industries: [], preparation: pendingFor(config) };
    const groups = snapshot.groups.filter(({ level }) => level === 'industry').sort((left, right) =>
      (left.rank ?? Infinity) - (right.rank ?? Infinity) || (right.medianRS ?? -Infinity) - (left.medianRS ?? -Infinity) ||
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const catalog = { state: 'ready', industries: groups };
    industryCatalogs.set(key, catalog);
    if (industryCatalogs.size > 3) industryCatalogs.delete(industryCatalogs.keys().next().value);
    return catalog;
  }

  function marketIndustry(config, group, lookback) {
    const sessions = chartSessions(config, lookback + chartWarmup);
    const key = JSON.stringify([analysisContext(config), sessions[0], sessions.at(-1)]);
    let cached = benchmarkCache.get(key);
    if (!cached || Date.now() >= cached.expires) {
      const result = readBenchmark(db, config, readableIdentity(db, config), sessions, lookback + chartWarmup);
      cached = { result, expires: result.state === 'ready' ? Infinity : Date.now() + 15_000 };
      benchmarkCache.set(key, cached);
      if (benchmarkCache.size > 3) benchmarkCache.delete(benchmarkCache.keys().next().value);
    }
    return { date: config.date, dataVersion: config.dataVersion, context: analysisContext(config), lookback, sessions,
      industry: industryComparison(config, group, sessions), benchmark: cached.result };
  }

  function marketRoute({ method, action, sub, query, body, resolvePoint }) {
    if (action === 'decks' && ['POST', 'PUT', 'DELETE'].includes(method)) {
      const saved = sub && getWorkspace(db, marketBookKind, sub);
      if (method !== 'POST' && !saved) throw bad('Market ChartBook not found', 404);
      if (method === 'DELETE') return { data: storeWorkspace(db, marketBookKind, saved, sub, true) };
      if (method === 'POST' && sub) throw bad('Market ChartBook creation does not take a deck ID');
      const definition = marketDeck(body.definition);
      return { data: storeWorkspace(db, marketBookKind, { name: body.name, definition }, saved?.id), status: saved ? 200 : 201 };
    }
    const point = resolvePoint(chosenContext(method === 'GET' ? query : body.context));
    if (!action && method === 'GET') {
      const { industries, ...status } = marketIndustries(point);
      return { data: { date: point.date, dataVersion: point.dataVersion, context: analysisContext(point), ...status,
        industries: industries.map(({ id, name, parent, rank, medianRS, count }) => ({ id, name, parent, rank, medianRS, count })),
        metrics: BREADTH_METRICS, decks: listWorkspace(db, marketBookKind) } };
    }
    if (action === 'history' && !sub && method === 'GET') return { data: storedMarketHistory(db, engine, point, chartLookback(query.lookback)) };
    if (action === 'health' && !sub && method === 'GET') {
      const lookback = chartLookback(query.lookback);
      const health = readHealth?.(point, query, lookback) ?? { rows: [] };
      const sessions = chartSessions(point, lookback);
      const archived = new Map(health.rows.map((row) => [row.date, row]));
      const state = !archived.size ? 'unprepared' : sessions.length === archived.size ? 'ready' : 'partial';
      return { data: { ...health, date: point.date, dataVersion: point.dataVersion, state,
        rows: sessions.map((date) => archived.get(date) ?? { date, score: null, state: 'unprepared' }) } };
    }
    if (action === 'industries' && sub && method === 'GET') {
      const { industries, state, preparation } = marketIndustries(point);
      if (state === 'unprepared') return { data: { date: point.date, dataVersion: point.dataVersion, state, preparation } };
      const group = industries.find(({ id }) => id === sub);
      if (!group) throw bad('Industry is unavailable in this dated classification', 404);
      return { data: marketIndustry(point, group, chartLookback(query.lookback)) };
    }
    if (action === 'prepare' && !sub && method === 'POST') return { data: prepare(point, true), status: 202 };
    throw bad('Market ChartBook route not found', 404);
  }

  function stockCard(config, raw, lookback) {
    const identify = readableIdentity(db, config);
    const identity = identify(raw);
    if (!identity) throw bad('Security is unavailable at the selected session and revision', 404);
    const stock = snapshotFor(config, { velocity: true, securityIds: [identity.securityId] }) ??
      snapshotFor(config, { securityIds: [identity.securityId] });
    const stats = stock?.stocks.find((row) => row.securityId === identity.securityId) ?? null;
    const group = stock?.groups.find((item) => item.id === stats?.industryId);
    const count = lookback + chartWarmup;
    const sessions = chartSessions(config, count);
    const chart = readPreparedDetail(db, config, identity.securityId, { lookback: count, benchmark: 'SPY' });
    return { ...identity, date: config.date, dataVersion: config.dataVersion, context: analysisContext(config), stats,
      chartBars: chart.detail?.chartBars ?? [], chartPreparation: { state: chart.state, sourceDataVersion: chart.sourceDataVersion,
        anchorDate: chart.anchorDate, projected: chart.projected,
        ...(chart.state === 'ready' && { priceAvailability: chart.detail?.chartBars.some(usableBar)
          ? 'observations' : config.basis === 'known' ? 'no-known-observations' : 'no-price-observations' }),
      }, benchmark: readBenchmark(db, config, identify, sessions, count),
      industry: industryComparison(config, group, sessions), note: readNote(db, identity, config.date) };
  }

  function prepare(config, retry = false) {
    if (!config.date || config.basis !== 'reconstructed' || config.date !== config.latestDate) {
      throw bad('Prepare an industry proxy for the latest reconstructed session');
    }
    const jobKey = industryWorkspaceKey(config);
    const current = registeredProxy(db, jobKey);
    if (current?.pending) return current;
    if (!retry && current?.resultState === 'complete') return current;
    const payload = { context: analysisContext(config), jobKey };
    return enqueue(chartBookIndustryJob, payload, retry ? null : jobKey);
  }

  return async function route({ method, item, action, sub, query, body, resolvePoint }) {
    if (!item && method === 'GET') return { data: { books: listWorkspace(db, bookKind), ...definedSources(db) } };
    if (item === 'market') return marketRoute({ method, action, sub, query, body, resolvePoint });
    if (item === 'notes' && action && ['GET', 'PUT'].includes(method)) {
      const date = query.date;
      if (!isoDate(date)) throw bad('A stock note needs its pinned YYYY-MM-DD trading session');
      const point = resolvePoint();
      if (date !== point.date) throw bad('The requested note session is unavailable');
      const identity = readableIdentity(db, point)(action);
      if (!identity) throw bad('Security is unavailable at the selected session and revision', 404);
      return { data: method === 'PUT' ? saveNote(db, identity, date, body.markdown) : readNote(db, identity, date) };
    }
    const transient = item === 'review';
    const book = item && !transient ? getWorkspace(db, bookKind, item) : null;
    if (item && !transient && !book) throw bad('ChartBook not found', 404);
    if ((!item && method === 'POST') || book && !action && method === 'PUT') {
      const definition = validateDefinition(db, body.definition);
      const point = resolvePoint(definition.context);
      const identify = readableIdentity(db, point);
      definition.sources = definition.sources.map((source) => source.type === 'manual'
        ? { ...source, members: [...new Set(source.members.map((member) => identify(member)?.securityId ?? member))] } : source);
      const saved = storeWorkspace(db, bookKind, { name: body.name, definition }, book?.id);
      let industryPreparation;
      if (point.date && point.basis === 'reconstructed' && point.date === point.latestDate) {
        try {
          const job = prepare(point);
          industryPreparation = { jobId: job.jobId ?? job.id, status: job.status };
        } catch (error) {
          industryPreparation = { status: 'failed', error: error.message };
        }
      }
      return { data: { ...saved, ...(industryPreparation && { industryPreparation }) }, status: book ? 200 : 201 };
    }
    if (book && !action && method === 'DELETE') return { data: storeWorkspace(db, bookKind, book, book.id, true) };
    if (book && !action && method === 'GET') return { data: book };
    if (method === 'POST' && transient && !action || book && action === 'review' && ['GET', 'POST'].includes(method)) {
      const definition = book?.definition ?? validateDefinition(db, body.definition);
      const point = resolvePoint({ ...definition.context, ...chosenContext(body.context) });
      return { data: { book, ...evaluate(definition, point) } };
    }
    if ((book || transient) && action === 'stocks' && sub && method === 'GET') {
      const point = resolvePoint({ ...book?.definition.context, ...chosenContext(query) });
      return { data: stockCard(point, sub, chartLookback(query.lookback)) };
    }
    if ((book || transient) && action === 'prepare' && method === 'POST') {
      return { data: prepare(resolvePoint({ ...book?.definition.context, ...chosenContext(body.context) }), true), status: 202 };
    }
    throw bad('ChartBook route not found', 404);
  };
}

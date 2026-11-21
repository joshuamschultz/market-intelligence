import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  bulkSessionStatus, CALCULATION_VERSION, createJob, dailyPublication, dataVersion, getWorkspace, importDataset, isoDate, jobById, listWorkspace, storeWorkspace,
  qualityOverrides, recordDailyPublication, today, updateJob, warehouseStatus,
} from './database.mjs';
import { expectedSessions, isMarketSession, latestFinalizableSession, shiftDate, weekEnd } from './calendar.mjs';
import { backupRetention, createCompressedBackup } from './backup.mjs';
import { BREADTH_METRICS, breadthMetric, binaryMetric } from './breadth.mjs';
import { createEngine, UNIVERSES, validateUniverse } from './engine.mjs';
import { AVERAGES, DEFAULT_WINDOWS, alignSeries, finite, mean, quantile, volumeRatio } from './metrics.mjs';
import {
  generateJournal, getJournalDate, getJournalSettings, journalFactorSelection, journalNoteDates,
  listJournalEntries, listJournalPrompts, runJournalBacktest, saveJournalNote, saveJournalPrompt, saveJournalSettings,
} from './journal.mjs';
import { parquetAvailable, parquetBackup, parquetRows } from './parquet.mjs';
import { materializeHistory, readMaterializedHistory } from './materialization.mjs';
import { precomputeProduction, precomputeWorkspace } from './precompute.mjs';
import { BENCHMARKS, EodhdProvider, importProviderData, importProviderReference, providerDates, providerOptions } from './provider.mjs';
import { BUILTIN_MODELS, RANKING_METHODS, rankBy, validateModel } from './ranking.mjs';
import { readRankArchive, writeRankArchive } from './rank-archive.mjs';
import { analyzeCohort, calculateMarketHealth, DEFAULT_HEALTH_MODEL, findHistoricalAnalogs, leadershipTransitionMatrix,
  marketHealthHistory, runEventStudy } from './research.mjs';
import { csvRows, screenStocks, validateFilter, validateScreen } from './screener.mjs';

const collections = {
  screens: 'screen', watchlists: 'watchlist', 'ranking-models': 'ranking-model',
  universes: 'universe', 'health-models': 'health-model', themes: 'theme',
  'alert-rules': 'alert-rule', cohorts: 'cohort',
};

export function scheduledPrecomputeKey(date, version) {
  return `production-precompute:${CALCULATION_VERSION}:${date}:${version}`;
}

export function scheduledJournalReadiness(db, { date, nasdaqEnabled = process.env.MARKET_NASDAQ_SYNC === '1',
  referenceEnabled = process.env.MARKET_SYNC === '1' && !!process.env.EODHD_API_KEY && process.env.MARKET_REFERENCE_SYNC === '1',
  precomputeEnabled = process.env.MARKET_PRECOMPUTE === '1' } = {}) {
  const raw = date ? bulkSessionStatus(db, date, { verifiedOnly: true }) : null;
  const publication = raw && dailyPublication(db, date, raw.version);
  if (!publication) return { state: 'waiting_for_publication', date: date ?? null };
  const active = db.prepare(`SELECT id,type,status FROM jobs WHERE status IN ('queued','running')
    AND type IN ('provider-import','provider-reference','provider-bootstrap','nasdaq-refresh') ORDER BY created_at DESC LIMIT 1`).get();
  if (active) return { state: 'waiting_for_reference_jobs', date, jobId: active.id, jobType: active.type, jobStatus: active.status };
  if (bootstrapProgress(db, { activeOnly: true })) return { state: 'waiting_for_reference_jobs', date, jobType: 'provider-bootstrap', jobStatus: 'running' };
  const version = dataVersion(db);
  const sourceStages = [
    ['nasdaq-refresh', 'captureDate', 'nasdaq_refresh', nasdaqEnabled],
    ['provider-reference', 'referenceDate', 'reference_refresh', referenceEnabled],
  ];
  for (const [type, dateField, state, enabled] of sourceStages) {
    if (!enabled) continue;
    const completed = db.prepare(`SELECT 1 FROM jobs WHERE type=? AND status='complete'
      AND json_extract(result, ?)>=? LIMIT 1`).get(type, `$.${dateField}`, date);
    const captured = type === 'nasdaq-refresh' && db.prepare(`SELECT 1 FROM ingestion_runs
      WHERE provider='nasdaq' AND dataset LIKE 'stocks-screener:%' AND status='complete'
        AND json_extract(detail, '$.catalogDate')>=? LIMIT 1`).get(date);
    if (completed || captured) continue;
    const attempt = db.prepare(`SELECT id,status FROM jobs WHERE type=?
      AND json_extract(payload, '$.scheduledFor')=? ORDER BY created_at DESC LIMIT 1`).get(type, date);
    return { state: attempt?.status === 'failed' ? `${state}_failed` : `waiting_for_${state}`, date,
      ...(attempt ? { jobId: attempt.id, jobStatus: attempt.status } : {}) };
  }
  if (precomputeEnabled) {
    const attempt = db.prepare(`SELECT id,status FROM jobs WHERE type='production-precompute'
      AND json_extract(payload, '$.jobKey')=? ORDER BY status='complete' DESC, created_at DESC LIMIT 1`)
      .get(scheduledPrecomputeKey(date, version));
    if (attempt?.status !== 'complete') return {
      state: attempt?.status === 'failed' ? 'precompute_failed' : 'waiting_for_precompute', date, dataVersion: version,
      ...(attempt ? { jobId: attempt.id, jobStatus: attempt.status } : {}),
    };
  }
  return { state: 'ready', date, dataVersion: version };
}
const monitorMetrics = [
  'up_4pct', 'down_4pct', 'up_25pct_20d', 'down_25pct_20d', 'up_50pct_20d', 'down_50pct_20d',
  'up_25pct_63d', 'down_25pct_63d', 'up_13pct_34d', 'down_13pct_34d',
];
const ratioDefinitions = [5, 10].map((lookback) => ({
  key: `up_down_4pct_${lookback}d`, label: `${lookback}-session participation ratio`,
  lookback, definition: `Sum of daily percentages of comparable stocks up at least 4% over ${lookback} sessions, divided by the corresponding sum for stocks down at least 4%. Each comparable market session carries equal weight.`,
}));
const extremeDefinition = { lookback: 252, minimum: 60, high: 90, low: 10,
  definition: 'Current value compared with the prior 252 sessions, requiring at least 60 valid values. Ties use their midpoint.' };
const defaultColumns = ['symbol', 'name', 'exchange', 'close', 'return_1d', 'return_21d', 'return_63d', 'return_252d',
  'rsRank', 'rsPercentile', 'velocity4w', 'udv_50d', 'adv_20d', 'float', 'distance_high_252d', 'industry'];
const rankingPeriods = [['1w', '1W', 5], ['1m', '1M', 21], ['3m', '3M', 63], ['6m', '6M', 126], ['1y', '1Y', 252]]
  .map(([id, label, sessions]) => ({ id, label, sessions }));
const rankingLists = [
  { id: 'top-rs', label: 'Top RS', description: 'Stocks in the top decile of the selected RS model.', rankField: 'rsRank' },
  { id: 'fast-improvers', label: 'Fast Improvers', description: 'Stocks with a positive four-week RS percentile change, strongest improvement first.',
    rankField: 'velocity4w', direction: 'desc', needsVelocity: true },
  { id: 'new-top-decile', label: 'New Top-Decile Entries', description: 'Now in the top decile after ranking below it at the prior completed weekly observation.',
    rankField: 'rsRank', needsVelocity: true },
  { id: 'emerging-leaders', label: 'Emerging Leaders', description: 'Stocks in the model’s Emerging lifecycle: more than 10 points of four-week RS improvement and a current percentile below 75.',
    rankField: 'velocity4w', direction: 'desc', needsVelocity: true },
  { id: 'industry-leaders', label: 'Industry Leaders', description: 'Highest-ranked stock in each classified industry. Unclassified stocks are excluded.',
    rankField: 'rsRank' },
  { id: 'weakening-leaders', label: 'Weakening Leaders', description: 'Current or prior four-week top-decile stocks with falling RS percentile, largest declines first.',
    rankField: 'velocity4w', direction: 'asc', needsVelocity: true },
];
const periodColumns = ['symbol', 'name', 'periodRank', 'periodPercentile', 'periodReturn', 'rsRank', 'rsPercentile', 'industry'];
const asError = (message, status = 400) => Object.assign(new Error(message), { status });
const dateString = (value, fallback) => {
  if (value == null || value === '') return fallback;
  if (!isoDate(value)) throw asError('Date must be YYYY-MM-DD');
  return value;
};
const parseCount = (value, min, max, fallback) => Math.max(min, Math.min(max, Math.floor(Number(value) || fallback)));
const response = (data, status = 200) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: data });
const download = (data, filename, contentType = 'text/csv; charset=utf-8') => ({
  status: 200, headers: { 'content-type': contentType, 'content-disposition': `attachment; filename="${filename}"` }, body: data,
});
const exportFormats = ['csv', 'parquet'];
const smoothingPeriods = [5, 10, 20, 50];
const changePeriods = [1, 5, 21];
const leadershipHistoryMetrics = new Set(['leadershipPersistence', 'leadershipTurnover']);
const leadershipHistoryContext = ['leadershipRankObservations', 'leaderReturnExpected', 'previousLeaderDate'];

async function exportTable(rows, columns, filename, format, config) {
  const response = format === 'parquet'
    ? download(await parquetRows(rows, columns), `${filename}.parquet`, 'application/vnd.apache.parquet')
    : download(csvRows(rows, columns), `${filename}.csv`);
  if (config) Object.assign(response.headers, {
    'x-market-data-version': String(config.dataVersion), 'x-market-universe': `${config.universe.id}@${config.universe.version}`,
    'x-market-model': `${config.model.id}@${config.model.version}`, 'x-market-price-basis': config.basis,
    'x-market-calculation-version': CALCULATION_VERSION,
    ...(config.date ? { 'x-market-as-of': config.date } : {}),
    ...(config.referenceMode === 'latest' && config.date === config.latestDate ? { 'x-market-reference-date': config.observedReferenceDate } : {}),
  });
  return response;
}
const exists = (value, label) => value ?? (() => { throw asError(`${label} was not found`, 404); })();

function chooseHealthModel(db, modelId) {
  if (!modelId || modelId === 'default') return DEFAULT_HEALTH_MODEL;
  const model = exists(getWorkspace(db, 'health-model', modelId), 'Market health model');
  return { ...model.definition, id: model.id, name: model.name, version: model.version };
}

function project(snapshot) {
  const { stocks, ...thin } = snapshot;
  return { ...thin, groups: thin.groups.map(({ memberIds, ...group }) => group) };
}

function formatHistory(rows, keys, monitor = false) {
  if (!rows.length) return [];
  const selected = [...new Set(keys)];
  const dates = expectedSessions(rows[0].date, rows.at(-1).date);
  const byDate = new Map(rows.map((day) => [day.date, day]));
  const indices = new Map(dates.map((date, index) => [date, index]));
  const valueAt = (key, date) => byDate.get(date)?.breadth[key]?.value;
  const trailing = (key, index, length) => dates.slice(Math.max(0, index + 1 - length), index + 1).map((date) => valueAt(key, date));
  const values = rows.map((snapshot) => {
    const index = indices.get(snapshot.date);
    const row = { date: snapshot.date, coverage: snapshot.coverage.state, eligible: snapshot.coverage.listed,
      traded: snapshot.coverage.traded, benchmarkClose: snapshot.aggregates.benchmarkClose,
      equalWeight: snapshot.aggregates.equalWeightReturn, capWeight: snapshot.aggregates.capWeightReturn,
      largestPositiveDollarShare: finite(snapshot.aggregates.largestPositiveDollarShare)
        ? 100 * snapshot.aggregates.largestPositiveDollarShare : null,
      netAdvances: snapshot.breadth.advancers?.denominator ? snapshot.breadth.adSpread?.numerator : null,
      adSpread: snapshot.breadth.adSpread?.value };
    for (const key of selected) {
      if (leadershipHistoryMetrics.has(key)) {
        const fraction = snapshot.aggregates[key];
        row[key] = finite(fraction) ? 100 * fraction : null;
        for (const field of leadershipHistoryContext) row[field] = snapshot.aggregates[field] ?? null;
        continue;
      }
      const current = snapshot.breadth[key];
      if (!current) continue;
      const prior = trailing(key, index - 1, extremeDefinition.lookback).filter(finite);
      const percentile = prior.length >= extremeDefinition.minimum && finite(current.value)
        ? 100 * prior.reduce((count, value) => count + (value < current.value ? 1 : value === current.value ? 0.5 : 0), 0) / prior.length : null;
      row[key] = current.value;
      row[`${key}_numerator`] = current.numerator;
      row[`${key}_denominator`] = current.denominator;
      for (const n of smoothingPeriods) {
        const sample = trailing(key, index, n);
        row[`${key}_sma${n}`] = sample.length === n && sample.every(finite) ? mean(sample) : null;
      }
      for (const lag of changePeriods) {
        const value = valueAt(key, dates[index - lag]);
        row[`${key}_change${lag}`] = finite(value) && finite(current.value) ? current.value - value : null;
      }
      row[`${key}_historical_percentile`] = percentile;
      row[`${key}_calibration_observations`] = prior.length;
      row[`${key}_calibration_state`] = percentile == null ? 'unavailable' : 'available';
      if (monitor) row[`${key}_extreme_percentile`] = percentile;
    }
    if (monitor) for (const { key, lookback } of ratioDefinitions) {
      const up = trailing('up_4pct', index, lookback);
      const down = trailing('down_4pct', index, lookback);
      const available = up.length === lookback && up.every(finite) && down.every(finite);
      const numerator = available ? up.reduce((sum, value) => sum + value, 0) : null;
      const denominator = available ? down.reduce((sum, value) => sum + value, 0) : null;
      row[key] = denominator > 0 ? numerator / denominator : null;
      row[`${key}_state`] = denominator > 0 ? 'available' : numerator > 0 ? 'infinity' : 'unavailable';
      row[`${key}_numerator`] = numerator;
      row[`${key}_denominator`] = denominator;
    }
    return row;
  });
  return values;
}

function indexSeries(rows, returns) {
  const levels = new Map();
  return rows.map((row) => ({ ...row, ...Object.fromEntries(returns.map(([field, index, anchor]) => {
    if (!levels.has(index) && (finite(row[field]) || anchor && row[anchor])) {
      levels.set(index, 100);
      return [index, 100];
    }
    if (!finite(row[field])) {
      if (levels.has(index)) levels.set(index, null);
      return [index, null];
    }
    const level = levels.get(index) == null ? null : levels.get(index) * (1 + row[field]);
    levels.set(index, level);
    return [index, level];
  })) }));
}

function compound(rows, field, complete) {
  return complete && rows.every((row) => finite(row?.[field])) ? rows.reduce((value, row) => value * (1 + row[field]), 1) - 1 : null;
}

function alignedHistory(rows, start, end) {
  if (!rows.length) return [];
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return expectedSessions(start || rows[0].date, end || rows.at(-1).date).map((date) => byDate.get(date) || { date, missing: true });
}

function weekGroups(rows, start, end) {
  const buckets = new Map();
  for (const row of alignedHistory(rows, start, end)) {
    const week = weekEnd(row.date);
    if (!buckets.has(week)) buckets.set(week, []);
    buckets.get(week).push(row);
  }
  return [...buckets.values()];
}

function marketHistoryRows(rows, { cadence, limit, from, to }) {
  const sliced = cadence === 'weekly' ? weekGroups(rows, from, to).map((days) => {
    const complete = !days.some((row) => row.missing);
    const netAdvances = complete && days.every((day) => finite(day.netAdvances)) ? days.reduce((sum, day) => sum + day.netAdvances, 0) : null;
    const closing = days.at(-1);
    return { ...closing, netAdvances, equalAnchor: finite(closing.equalWeight), capAnchor: finite(closing.capWeight),
      equalWeight: compound(days, 'equalWeight', complete), capWeight: compound(days, 'capWeight', complete) };
  }).slice(-limit) : alignedHistory(rows, from, to).slice(-limit);
  let cumulative;
  return indexSeries(sliced, [['equalWeight', 'equalWeightIndex', 'equalAnchor'], ['capWeight', 'capWeightIndex', 'capAnchor']]).map((row) => {
    if (finite(row.netAdvances)) cumulative = cumulative === undefined ? 0 : cumulative == null ? null : cumulative + row.netAdvances;
    else if (cumulative !== undefined) cumulative = null;
    return { ...row, advanceDeclineLine: finite(cumulative) ? cumulative : null };
  }).filter((row) => !row.missing);
}

function groupHistoryRows(history, ids, { cadence, limit, from, to }) {
  const daily = history.map((row) => ({ date: row.date, groups: row.groups.filter(({ id }) => ids.includes(id)) }));
  const periods = cadence === 'weekly' ? weekGroups(daily, from, to).map((days) => ({
    date: days.at(-1).date,
    groups: ids.flatMap((id) => {
      const groups = days.map((day) => day.groups?.find((group) => group.id === id));
      const closing = groups.at(-1);
      if (!closing) return [];
      const complete = groups.every(Boolean);
      return [{ ...closing, equalAnchor: finite(closing.dailyReturn), capAnchor: finite(closing.capWeightedDaily),
        dailyReturn: compound(groups, 'dailyReturn', complete),
        capWeightedDaily: compound(groups, 'capWeightedDaily', complete) }];
    }),
  })) : alignedHistory(daily, from, to);
  const visible = periods.slice(-limit);
  const indexed = new Map(ids.map((id) => [id, indexSeries(visible.map((row) => row.groups?.find((group) => group.id === id) || {}),
    [['dailyReturn', 'index', 'equalAnchor'], ['capWeightedDaily', 'capWeightIndex', 'capAnchor']])]));
  return visible.map(({ date, groups }, position) => ({
    date, groups: (groups || []).map(({ id }) => indexed.get(id)[position]),
  }));
}

function historyColumns(keys) {
  return [...new Set(keys.flatMap((key) => [key, `${key}_numerator`, `${key}_denominator`,
    ...smoothingPeriods.map((n) => `${key}_sma${n}`), ...changePeriods.map((n) => `${key}_change${n}`),
    `${key}_historical_percentile`, `${key}_calibration_observations`]))];
}

function breadthContributors(snapshot, key, include, page, perPage, all = false) {
  const signed = key === 'adSpread';
  const definition = signed ? { key, label: 'A/D spread', family: 'Participation',
    definition: 'Advancers contribute +1, decliners −1 and unchanged securities zero. Divide the net count by comparable traded stocks.',
    test: (row) => finite(row.return_1d) ? Math.sign(row.return_1d) : null } : breadthMetric(key);
  if (!definition) throw asError('Unknown breadth metric', 404);
  const results = [];
  const exclusions = { untraded: 0, insufficientHistory: 0 };
  const traded = snapshot.stocks.filter((row) => row.traded);
  const metric = snapshot.breadth[key] || binaryMetric(traded, definition.test);
  for (const row of snapshot.stocks) {
    const state = !row.traded ? 'untraded' : definition.test(row);
    if (state === 'untraded') exclusions.untraded++;
    if (state == null) exclusions.insufficientHistory++;
    const comparable = signed ? finite(state) : state === true || state === false;
    const match = include === 'excluded' ? state == null || state === 'untraded'
      : include === 'denominator' ? comparable : signed ? comparable && state !== 0 : state === true;
    if (match) {
      const selection = state === 'untraded' ? state : state == null ? 'insufficient'
        : signed ? state > 0 ? 'advancer' : state < 0 ? 'decliner' : 'unchanged' : state ? 'numerator' : 'nonqualifier';
      results.push({ ...row, breadthSelection: selection, ...(signed && comparable ? { contribution: state } : {}) });
    }
  }
  results.sort((a, b) => a.symbol.localeCompare(b.symbol, 'en'));
  const { test, ...description } = definition;
  return { date: snapshot.date, metric, definition: description, coverage: snapshot.coverage, exclusions,
    total: results.length, page, perPage, rows: all ? results : results.slice((page - 1) * perPage, page * perPage) };
}

function validMembers(input, { dated = false } = {}) {
  if (!Array.isArray(input)) return [];
  if (input.length > 20_000) throw asError('Use at most 20,000 member entries');
  if (!dated) return [...new Set(input.map((item) => typeof item === 'string' ? item : item?.securityId).filter((item) => typeof item === 'string' && item.length <= 180))];
  const knownAt = today();
  return input.map((raw) => {
    const item = typeof raw === 'string' ? { securityId: raw } : raw;
    if (!item?.securityId || typeof item.securityId !== 'string' || item.securityId.length > 180) throw asError('Select valid security identifiers');
    const from = dateString(item.effectiveFrom, knownAt);
    const to = dateString(item.effectiveTo, null);
    if (to && from > to) throw asError('Membership end must follow its start');
    return { securityId: item.securityId, effectiveFrom: from, effectiveTo: to, knownAt: dateString(item.knownAt, knownAt) };
  });
}

function workspaceDefinition(kind, input) {
  const value = input.definition || {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw asError('Definition must be an object');
  switch (kind) {
    case 'ranking-model': return validateModel(value);
    case 'universe': return validateUniverse({ ...value, members: validMembers(value.members, { dated: true }) });
    case 'screen':
      validateScreen(value);
      if (value.rankingPeriod) rankingPeriod(value);
      if (value.rankingList) rankingList(value);
      if (value.rankingPeriod && value.rankingList) throw asError('Choose a period or an RS signal list');
      return { ...value, context: savedScreenContext(value) };
    case 'watchlist': return { mode: value.screenId ? 'dynamic' : 'manual', screenId: value.screenId || null, members: validMembers(value.members) };
    case 'theme': return { members: validMembers(value.members, { dated: true }) };
    case 'health-model':
      calculateMarketHealth({ coverage: { state: 'empty' } }, { model: value });
      return value;
    case 'alert-rule':
      if (!['breadth', 'stocks', 'screen', 'industry', 'regime'].includes(value.type)) throw asError('Unknown alert type');
      if (value.type === 'stocks') validateFilter(value.filter);
      if (value.type === 'breadth' && (!breadthMetric(value.metric) || !finite(value.threshold))) throw asError('Choose a breadth metric and a threshold');
      if (value.type === 'breadth' && value.trigger != null && !['crossing', 'surge'].includes(value.trigger)) throw asError('Unknown breadth trigger');
      if (value.type === 'breadth' && value.trigger === 'surge' && (!(value.threshold > 0 && value.threshold <= 200)
          || !Number.isInteger(value.lookback) || value.lookback < 1 || value.lookback > 252)) {
        throw asError('Choose a positive percentage-point change and a 1–252 session lookback');
      }
      return value;
    default: return value;
  }
}

function savedScreenContext(definition) {
  const context = { ...definition.context };
  if (definition.dateMode === 'latest') {
    delete context.date;
    delete context.dataVersion;
  }
  return context;
}

function rankingPeriod(input) {
  const period = rankingPeriods.find(({ id }) => id === input.rankingPeriod);
  if (!period) throw asError('Choose a supported leadership period');
  const topPercent = input.topPercent == null || input.topPercent === '' ? 2 : Number(input.topPercent);
  if (!finite(topPercent) || topPercent < 0.1 || topPercent > 100) throw asError('Top percentage must be between 0.1 and 100');
  return { ...period, topPercent };
}

function rankingList(input) {
  const list = rankingLists.find(({ id }) => id === input.rankingList);
  if (!list) throw asError('Choose a supported RS signal list');
  return list;
}

function listFilter(input, field) {
  const membership = { field, op: 'true' };
  return input.filter ? { operator: 'and', filters: [membership, input.filter] } : membership;
}

function periodScreen(snapshot, input) {
  const period = rankingPeriod(input);
  const field = `return_${period.sessions}d`;
  const ranks = rankBy(snapshot.stocks, (row) => row.traded ? row[field] : null);
  const cutoff = Math.ceil(ranks.size * period.topPercent / 100);
  const stocks = snapshot.stocks.map((row) => {
    const ranking = ranks.get(row.securityId);
    return { ...row, periodRank: ranking?.rank ?? null, periodPercentile: ranking?.percentile ?? null,
      periodReturn: ranking ? row[field] : null, periodLeader: !!ranking && ranking.rank <= cutoff };
  });
  return {
    snapshot: { ...snapshot, stocks },
    input: { ...input, filter: listFilter(input, 'periodLeader'),
      sort: input.sort || [{ field: 'periodRank', direction: 'asc' }], columns: input.columns || periodColumns },
    period: { ...period, comparable: ranks.size, cutoff, priceMode: 'split',
      selection: 'The cutoff rounds up to a whole stock. Equal returns share a percentile; permanent security ID breaks ties for list membership.' },
  };
}

function signalScreen(snapshot, input) {
  const list = rankingList(input);
  const ranked = snapshot.stocks.filter((row) => row.traded && finite(row.rsRank));
  const bestByIndustry = new Map();
  let unclassified = 0;
  if (list.id === 'industry-leaders') {
    for (const row of ranked) {
      if (!row.industryId) unclassified++;
      else if ((bestByIndustry.get(row.industryId)?.rsRank ?? Infinity) > row.rsRank) bestByIndustry.set(row.industryId, row);
    }
  }
  const industryWinners = new Set([...bestByIndustry.values()].map(({ securityId }) => securityId));
  const matchers = {
    'top-rs': (row) => row.rsPercentile >= 90,
    'fast-improvers': (row) => finite(row.velocity4w) && row.velocity4w > 0,
    'new-top-decile': (row) => row.enteredTop10 === true,
    'emerging-leaders': (row) => row.lifecycle === 'Emerging',
    'industry-leaders': (row) => industryWinners.has(row.securityId),
    'weakening-leaders': (row) => finite(row.velocity4w) && row.velocity4w < 0
      && (row.rsPercentile >= 90 || row.rsPercentile - row.velocity4w >= 90),
  };
  const matches = new Set(ranked.filter(matchers[list.id]).map(({ securityId }) => securityId));
  const stocks = snapshot.stocks.map((row) => ({ ...row, signalLeader: matches.has(row.securityId) }));
  return { snapshot: { ...snapshot, stocks }, input: { ...input, filter: listFilter(input, 'signalLeader'),
    sort: input.sort || [{ field: list.rankField, direction: list.direction || 'asc' }] },
    list: { ...list, ranked: ranked.length, qualifying: matches.size,
      ...(list.id === 'industry-leaders' ? { unclassified, industries: bestByIndustry.size } : {}) } };
}

function sessionsBetween(from, end) {
  if (from > end) throw asError('Start date must be on or before the end date');
  return expectedSessions(from, end);
}

function historicalScreen(engine, config, input, snapshot) {
  if (input.rankingPeriod && input.rankingList) throw asError('Choose a period or an RS signal list');
  const list = input.rankingPeriod ? periodScreen(snapshot, input) : input.rankingList ? signalScreen(snapshot, input) : null;
  if (list) ({ snapshot, input } = list);
  const lags = new Map();
  function previous(field, id, period) {
    const lag = Number(period);
    if (!Number.isInteger(lag) || lag < 1 || lag > 1008 || lags.size >= 12 && !lags.has(lag)) return null;
    if (!lags.has(lag)) {
      const dates = expectedSessions(shiftDate(config.date, -2 * lag - 8), config.date);
      const date = dates.at(-lag - 1);
      lags.set(lag, date ? new Map(engine.snapshot({ ...config, date }).stocks.map((row) => [row.securityId, row])) : new Map());
    }
    return lags.get(lag).get(id)?.[field] ?? null;
  }
  const result = screenStocks(snapshot, input, { previous, all: exportFormats.includes(input.export) || input.all === true });
  return { ...result, ...(list?.period ? { period: list.period } : {}), ...(list?.list ? { rankingList: list.list } : {}), referenceDate: snapshot.referenceDate,
    referenceMode: snapshot.referenceMode, classificationSystem: snapshot.classificationSystem };
}

function screenDataNeeds(body) {
  const source = JSON.stringify(body);
  const context = body.context || {};
  const definitions = [
    ['windows', /\breturn_(\d+)d\b/g, DEFAULT_WINDOWS],
    ['averages', /\b(?:ema|sma|vs_(?:ema|sma)|slope_(?:ema|sma)|above)_(\d+)d\b/g, AVERAGES],
    ['volumeWindows', /\b(?:obv_slope|udv|rvol|adv|avg_volume|float_turnover|up_volume)_(\d+)d\b/g, [1, 10, 20, 50, 100]],
  ];
  return {
    ...(/\bdistance_(?:all_time|loaded_history)_high\b/.test(source) ? { includeAllTimeHigh: true } : {}),
    ...Object.fromEntries(definitions.flatMap(([key, pattern, builtIn]) => {
      const additions = [...source.matchAll(pattern)].map(([, period]) => Number(period)).filter((period) => !builtIn.includes(period));
      if (!additions.length) return [];
      const configured = Array.isArray(context[key]) ? context[key] : context[key] ? String(context[key]).split(',') : [];
      return [[key, [...new Set([...configured.map(Number), ...additions])]]];
    })),
  };
}

function resolveScreen(engine, config, body, { velocity = true } = {}) {
  const snapshot = engine.snapshot(config, { velocity });
  return historicalScreen(engine, config, body, snapshot);
}

function bootstrapProgress(db, { activeOnly = false } = {}) {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='bootstrap_plans' AND type='table'").get();
  if (!exists) return null;
  const activePlan = db.prepare(`SELECT id,requested_from,requested_to,owner_pid,lease_until,catalog_version,published_version
    FROM bootstrap_plans WHERE owner_pid IS NOT NULL AND lease_until>? ORDER BY lease_until DESC LIMIT 1`).get(Date.now());
  const plan = activePlan ?? (!activeOnly ? db.prepare(`SELECT id,requested_from,requested_to,owner_pid,lease_until,catalog_version,published_version
    FROM bootstrap_plans ORDER BY rowid DESC LIMIT 1`).get() : null);
  if (!plan) return null;
  if (activeOnly) return { active: true };
  const stages = {};
  for (const row of db.prepare('SELECT stage,state,count(*) AS observations FROM bootstrap_tasks WHERE plan_id=? GROUP BY stage,state').all(plan.id)) {
    (stages[row.stage] ??= { complete: 0, retry: 0 })[row.state] = row.observations;
  }
  const phase = !plan.catalog_version ? 'catalog' : stages.reference ? 'reference' : stages.actions ? 'actions' : 'prices';
  return { active: !!activePlan, from: plan.requested_from, to: plan.requested_to, phase, stages,
    completed: stages[phase]?.complete ?? 0, failed: stages[phase]?.retry ?? 0, total: null,
    publishedVersion: plan.published_version };
}

function classificationStatus(db) {
  const coverage = db.prepare(`SELECT system, source, count(*) AS observations, count(DISTINCT security_id) AS securities,
    min(effective_from) AS firstDate, max(effective_from) AS lastDate
    FROM classifications WHERE industry IS NOT NULL GROUP BY system, source ORDER BY system, source`).all();
  const systems = [...new Set(['provider', ...coverage.map(({ system }) => system)])];
  const defaultClassification = systems.includes('nasdaq') ? 'nasdaq'
    : coverage.some(({ system }) => system === 'provider') ? 'provider'
    : systems.includes('sec-sic') ? 'sec-sic' : systems[0];
  return { classificationSystems: systems, defaultClassification, classificationCoverage: coverage };
}

function availableBenchmarks(db) {
  return db.prepare(`SELECT DISTINCT symbol FROM identifiers JOIN securities ON id=security_id
    WHERE type IN ('etf','index') AND first_seen IS NOT NULL ORDER BY symbol`).all().map(({ symbol }) => symbol);
}

function workspaceDefaults(db) {
  const benchmarks = availableBenchmarks(db);
  return { basis: 'reconstructed', universe: 'us-core', universeVersion: 1, model: 'composite', modelVersion: 1,
    benchmark: ['SPY', 'VTI'].find((symbol) => benchmarks.includes(symbol)) || benchmarks[0] || 'SPY',
    classification: classificationStatus(db).defaultClassification, reference: 'latest' };
}

function localStatus(db) {
  const status = warehouseStatus(db);
  return { ...status, bootstrap: bootstrapProgress(db), latestAnalysis: latestAnalysis(db, status.dataVersion) };
}

function latestAnalysis(db, version) {
  const published = db.prepare(`SELECT date, data_version AS dataVersion, published_at AS publishedAt
    FROM daily_publications WHERE calculation_version=? AND data_version<=?
    ORDER BY date DESC, data_version DESC LIMIT 1`).get(CALCULATION_VERSION, version);
  const prepared = db.prepare(`
    SELECT json_extract(result,'$.date') AS date, json_extract(result,'$.dataVersion') AS dataVersion, updated_at AS publishedAt
    FROM jobs WHERE type='production-precompute' AND status='complete'
      AND json_extract(result,'$.calculationVersion')=?
      AND json_extract(result,'$.dataVersion')<=?
      AND json_extract(payload,'$.jobKey')=(? || json_extract(result,'$.date') || ':' || json_extract(result,'$.dataVersion'))
      AND EXISTS (SELECT 1 FROM daily_publications p WHERE p.date=json_extract(jobs.result,'$.date')
        AND p.calculation_version=? AND p.data_version<=json_extract(jobs.result,'$.dataVersion'))
    ORDER BY date DESC, dataVersion DESC LIMIT 1
  `).get(CALCULATION_VERSION, version, `production-precompute:${CALCULATION_VERSION}:`, CALCULATION_VERSION);
  const requirePrecompute = process.env.MARKET_PRECOMPUTE === '1';
  const ready = prepared && (requirePrecompute || !published || prepared.date > published.date
    || prepared.date === published.date && prepared.dataVersion >= published.dataVersion)
    ? { ...prepared, stage: 'production-precompute' }
    : !requirePrecompute && published ? { ...published, stage: 'daily-publication' } : null;
  return ready && { ...ready, calculationVersion: CALCULATION_VERSION };
}

function quality(db, engine, config) {
  const status = localStatus(db);
  const snapshot = engine.snapshot(config);
  const last = latestFinalizableSession();
  const sessionDates = config.earliestDate && config.date ? expectedSessions(config.earliestDate, config.date) : [];
  const observedDates = config.currentVersion
    ? db.prepare('SELECT DISTINCT date FROM daily_prices').all()
    : db.prepare('SELECT DISTINCT date FROM price_revisions WHERE version<=?').all(config.dataVersion);
  const actualDates = new Set(observedDates.map(({ date }) => date));
  const missingDates = sessionDates.filter((date) => !actualDates.has(date));
  const fieldCoverage = {};
  for (const [key, sql] of Object.entries({
    corporateActions: 'SELECT count(*) AS observations, min(date) AS firstDate, max(date) AS lastDate FROM corporate_actions WHERE version<=?',
    float: 'SELECT count(*) AS observations, min(effective_date) AS firstDate, max(effective_date) AS lastDate FROM fundamentals WHERE float IS NOT NULL AND version<=?',
    shares: 'SELECT count(*) AS observations, min(effective_date) AS firstDate, max(effective_date) AS lastDate FROM fundamentals WHERE shares IS NOT NULL AND version<=?',
    classification: 'SELECT count(*) AS observations, min(effective_from) AS firstDate, max(effective_from) AS lastDate FROM classifications WHERE industry IS NOT NULL AND version<=?',
  })) fieldCoverage[key] = db.prepare(sql).get(config.dataVersion);
  return {
    ...status, asOf: config.date, coverage: snapshot.coverage, observedSessionCount: actualDates.size,
    expectedSessionCount: sessionDates.length, missingDateCount: missingDates.length, missingDates: missingDates.slice(-200),
    stale: status.latestDate ? status.latestDate < last : null, lastFinalizableSession: last,
    fieldCoverage, sourceBasis: config.basis, ...classificationStatus(db),
    qualityOverrides: qualityOverrides(db, { version: config.dataVersion, knownThrough: config.basis === 'known' ? config.date : undefined })
      .filter((row) => row.effective_from <= config.date),
    referenceDate: snapshot.referenceDate, referenceMode: snapshot.referenceMode, classificationSystem: snapshot.classificationSystem,
    latestReferenceDate: Object.values(fieldCoverage).filter((point) => point !== fieldCoverage.corporateActions)
      .map((point) => point.lastDate).filter(Boolean).sort().at(-1) || null,
    invalidRows: status.runs.reduce((sum, run) => sum + (run.detail?.invalid || 0), 0),
    unresolvedIdentifiers: status.runs.reduce((sum, run) => sum + (run.detail?.unresolved || 0), 0),
    failedJobs: db.prepare("SELECT id,type,status,updated_at,error FROM jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 10").all(),
    availableBenchmarks: availableBenchmarks(db),
  };
}

function riskMetrics(detail, benchmark) {
  const bars = detail.chartBars || detail.bars;
  const benchmarkDates = new Map(benchmark?.map((row) => [row.date, row.close]) || []);
  const returns = [];
  const pairing = [];
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
      if (benchmarkDates.get(previous.date) > 0 && benchmarkDates.get(bar.date) > 0) {
        pairing.push([value, benchmarkDates.get(bar.date) / benchmarkDates.get(previous.date) - 1]);
      }
    }
    previous = bar;
  }
  const x = mean(pairing.map((item) => item[0]));
  const y = mean(pairing.map((item) => item[1]));
  const covariance = mean(pairing.map(([a, b]) => (a - x) * (b - y)));
  const stockVariance = mean(pairing.map(([a]) => (a - x) ** 2));
  const benchmarkVariance = mean(pairing.map(([, b]) => (b - y) ** 2));
  return {
    observations: returns.length, benchmarkObservations: pairing.length,
    maximumDrawdown: priced ? drawdown : null,
    beta: pairing.length >= 20 && benchmarkVariance > 0 ? covariance / benchmarkVariance : null,
    correlation: pairing.length >= 20 && stockVariance > 0 && benchmarkVariance > 0 ? covariance / Math.sqrt(stockVariance * benchmarkVariance) : null,
    dailyHistoricalReturn5pct: returns.length >= 20 ? quantile(returns, 0.05) : null,
    dailyHistoricalVaR95: returns.length >= 20 ? Math.max(0, -quantile(returns, 0.05)) : null,
    annualizedVolatility: detail.volatility_20d, atr14: detail.atr_14d,
  };
}

function updateAlerts(db, engine, params = {}) {
  let fired = 0;
  const at = new Date().toISOString();
  const persist = db.prepare('INSERT OR IGNORE INTO alert_events VALUES (?, ?, ?, ?)');
  const rules = listWorkspace(db, 'alert-rule');
  for (const rule of rules) {
    const def = rule.definition;
    if (def.active === false) continue;
    const saved = def.type === 'screen' ? getWorkspace(db, 'screen', def.screenId) : null;
    if (def.type === 'screen' && !saved) continue;
    const config = engine.context({ ...params, ...def.context, ...saved?.definition.context,
      ...(saved ? { date: params.date, dataVersion: params.dataVersion } : {}),
      ...(def.type === 'breadth' ? { breadthKeys: [def.metric] } : screenDataNeeds(saved?.definition ?? def)) });
    if (!config.date) continue;
    const lag = def.type === 'breadth' && def.trigger === 'surge' ? def.lookback : 1;
    const dates = expectedSessions(shiftDate(config.date, -2 * lag - 16), config.date);
    const previousDate = dates.at(-1 - lag);
    if (!previousDate) continue;
    const beforeConfig = { ...config, date: previousDate, requestedDate: previousDate };
    const stockRule = def.type === 'screen' || def.type === 'stocks';
    const current = engine.snapshot(config, { velocity: stockRule });
    const before = engine.snapshot(beforeConfig, { velocity: stockRule });
    const base = { ruleId: rule.id, name: rule.name, rule: def, date: config.date,
      observedAt: at, sourceTimestamp: db.prepare("SELECT finished_at FROM ingestion_runs WHERE version=? AND status='complete' LIMIT 1").get(config.dataVersion)?.finished_at || null,
      universe: current.universe.id, universeVersion: current.universe.version,
      model: current.model.id, modelVersion: current.model.version, dataVersion: config.dataVersion, coverage: current.coverage.state,
      ...(saved ? { screenId: saved.id, screenVersion: saved.version } : {}) };
    function event(subject, details) {
      fired += persist.run(rule.id, config.date, subject, JSON.stringify({ ...base, subject, ...details })).changes;
    }
    if (def.type === 'breadth') {
      if ([current, before].some((snapshot) => snapshot.coverage.state !== 'complete') && def.context?.universe !== 'sample') continue;
      const todayValue = current.breadth[def.metric]?.value;
      const oldValue = before.breadth[def.metric]?.value;
      if ([todayValue, oldValue].every(finite)) {
        const change = todayValue - oldValue;
        const down = def.direction === 'below';
        const matches = def.trigger === 'surge' ? (down ? change <= -def.threshold : change >= def.threshold)
          : down ? oldValue >= def.threshold && todayValue < def.threshold : oldValue <= def.threshold && todayValue > def.threshold;
        if (matches) event('market', { metric: def.metric, value: todayValue, previous: oldValue, change, comparisonDate: previousDate,
          trigger: def.trigger || 'crossing' });
      }
    }
    if (stockRule) {
      const screen = saved?.definition ?? { filter: def.filter };
      const expression = def.type === 'stocks' ? screen.filter?.expression : null;
      const options = expression ? { all: true, computed: [{ field: 'custom_alert_condition', expression }] } : { ...screen, all: true };
      const latest = historicalScreen(engine, config, options, current).rows;
      const previous = historicalScreen(engine, beforeConfig, options, before).rows;
      const comparable = (snapshot) => new Set(snapshot.stocks.filter((row) => row.traded && alertComparable(def.filter, row)).map((row) => row.securityId));
      const states = (selected, snapshot) => {
        if (expression) return new Map(selected.map((row) => [row.securityId, row.custom_alert_condition]));
        const comparableIds = def.type === 'stocks' ? comparable(snapshot) : new Set();
        return new Map([...comparableIds].map((id) => [id, false]).concat(selected.map((row) => [row.securityId, true])));
      };
      const active = states(latest, current);
      const older = states(previous, before);
      const priorRows = new Map(previous.map((row) => [row.securityId, row]));
      const currentRows = new Map(latest.map((row) => [row.securityId, row]));
      for (const [id, state] of active) if (state === true && (saved ? !older.has(id) : older.get(id) === false) && def.direction !== 'leaves') {
        event(id, { symbol: currentRows.get(id).symbol, action: 'enters' });
      }
      for (const [id, state] of older) if (state === true && (saved ? !active.has(id) : active.get(id) === false) && def.direction !== 'enters') {
        event(id, { symbol: priorRows.get(id).symbol, action: 'leaves' });
      }
    }
    if (def.type === 'industry') {
      const old = new Map(before.groups.map((group) => [group.id, group]));
      for (const group of current.groups) {
        const rank = old.get(group.id)?.rank;
        if (group.level === 'industry' && group.rank != null && group.rank <= (def.top || 10) && rank != null && rank > (def.top || 10)) {
          event(group.id, { group: group.name, rank: group.rank, previousRank: rank });
        }
      }
    }
    if (def.type === 'regime') {
      const health = [beforeConfig, config].map((item) => marketHealth(db, engine, item));
      if (health.every((item) => item.score != null) && health[0].regime.id !== health[1].regime.id) {
        event('market', { regime: health[1].regime, previousRegime: health[0].regime });
      }
    }
  }
  return { evaluated: rules.length, fired };
}

function alertComparable(filter, row) {
  if (!filter) return true;
  const children = filter.filters || filter.rules || filter.children;
  if (children) return children.every((child) => alertComparable(child, row));
  if (filter.expression) return false;
  return filter.op === 'missing' || filter.op === 'present' || row[filter.field] != null
    || /^udv_/.test(filter.field) && row[filter.field.replace(/^udv_/, 'udv_state_')] === 'infinity';
}

function divergenceLedger(db, engine, config, model, events, from, coverage = { coverageMode: 'verified' }) {
  const recipe = createHash('sha256').update(JSON.stringify([
    engine.definitionKey(config), config.universe.id, config.universe.version, config.model.id, config.model.version, model, coverage,
  ])).digest('hex');
  const key = [recipe, config.dataVersion, CALCULATION_VERSION];
  if (events.length) {
    db.exec(`CREATE TABLE IF NOT EXISTS divergence_events (
      recipe TEXT NOT NULL, data_version INTEGER NOT NULL, calculation_version TEXT NOT NULL,
      date TEXT NOT NULL, event TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(recipe, data_version, calculation_version, date, event)
    ) WITHOUT ROWID`);
    const record = db.prepare('INSERT OR IGNORE INTO divergence_events VALUES (?,?,?,?,?,?,?)');
    const observedAt = new Date().toISOString();
    for (const event of events) record.run(...key, event.date, event.id, observedAt, JSON.stringify(event));
  }
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='divergence_events'").get()) return [];
  return db.prepare(`SELECT payload,observed_at FROM divergence_events
    WHERE recipe=? AND data_version=? AND calculation_version=? AND date BETWEEN ? AND ? ORDER BY date,event`)
    .all(...key, from || config.date, config.date).map(({ payload, observed_at }) => ({ ...JSON.parse(payload), observedAt: observed_at,
      dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION }));
}

function materializationContext(config) {
  return {
    date: config.date, dataVersion: config.dataVersion, universe: config.universe.id, universeVersion: config.universe.version,
    model: config.model.id, modelVersion: config.model.version, benchmark: config.benchmark,
    basis: config.basis, classification: config.classification, reference: config.referenceMode,
    observedReferenceDate: config.observedReferenceDate, threshold: config.threshold,
    averages: config.averages, windows: config.windows, volumeWindows: config.volumeWindows,
    breadthKeys: config.breadthKeys, themes: config.themes, includeAllTimeHigh: config.includeAllTimeHigh,
  };
}

function queueHistory(engine, config, options, enqueue) {
  const { from, to, limit, cadence } = options;
  const context = materializationContext(config);
  const key = createHash('sha256').update(JSON.stringify([
    CALCULATION_VERSION, engine.definitionKey(config), config.dataVersion, config.date,
    config.universe.id, config.universe.version, config.model.id, config.model.version, from, to, limit, cadence,
  ])).digest('hex');
  return enqueue('materialize', { context, from, to, limit, cadence }, key);
}

function requiresArchive(db) {
  const coverage = db.prepare('SELECT count(*) AS total, count(first_seen) AS priced FROM securities').get();
  return coverage.priced > 100 || coverage.total > 300;
}

function pendingJob(job) {
  return { pending: true, jobId: job.id, status: job.status, progress: job.progress };
}

function blockedCapture() {
  return { status: 'waiting_for_capture', captureInProgress: true };
}

function rankSeries(db, engine, config, options, enqueue, { supplyDemand = false } = {}) {
  const archive = readRankArchive(db, engine, config, options);
  const stored = new Map(archive.rows.map((row) => [row.date, row]));
  const require = requiresArchive(db);
  const visible = options.materializedOnly === '1' || require ? archive.dates.filter((date) => archive.observed.has(date)) : archive.dates.slice(-260);
  let materialization;
  if (require && archive.observed.size < archive.dates.length && options.materializedOnly !== '1') {
    if (bootstrapProgress(db, { activeOnly: true })) materialization = blockedCapture();
    else {
      const context = materializationContext(config);
      const { from, to, limit, cadence } = options;
      const key = createHash('sha256').update(JSON.stringify(['ranks', context, from, to, limit, cadence])).digest('hex');
      materialization = pendingJob(enqueue('rank-materialize', { context, from, to, limit, cadence }, key));
    }
  }
  let daily;
  if (supplyDemand && visible.length && config.basis === 'reconstructed' && options.securityId) {
    const start = shiftDate(visible[0], -110);
    const dates = expectedSessions(start, visible.at(-1));
    const bars = engine.studyPrices(config, [options.securityId], start, visible.at(-1)).get(options.securityId) || [];
    daily = { dates: new Map(dates.map((date, index) => [date, index])), bars: alignSeries(bars, dates) };
  }
  const rows = visible.map((date) => {
    let row;
    if (stored.has(date)) row = stored.get(date);
    else if (archive.observed.has(date)) row = { date, rank: null, percentile: null, score: null };
    else {
      const snapshot = engine.snapshot({ ...config, date }, { persist: false, cache: false });
      const stock = snapshot.stocks.find((item) => item.securityId === options.securityId || item.symbol === options.symbol);
      row = { date, rank: stock?.rsRank ?? null, percentile: stock?.rsPercentile ?? null, score: stock?.rsScore ?? null, udv_50d: stock?.udv_50d ?? null };
    }
    return daily ? { ...row, udv_50d: volumeRatio(daily.bars, daily.dates.get(date), 50).value } : row;
  });
  return { date: config.date, materialization, rows, archived: archive.observed.size, requested: archive.dates.length };
}

function thinHistory(db, engine, config, options = {}, enqueue = null) {
  const stored = readMaterializedHistory(db, engine, config, options);
  const { rows, ...status } = stored;
  const materialization = { ...status, visibleRequested: options.visibleRequested ?? status.requested };
  if (stored.complete || options.materializedOnly) return { rows, materialization };
  if (bootstrapProgress(db, { activeOnly: true })) {
    return { rows, materialization: { ...materialization, ...blockedCapture() } };
  }

  const coldCap = requiresArchive(db) ? 0 : 520;
  if (stored.requested <= coldCap) {
    return { rows: engine.history(config, { ...options, project, persist: false }), materialization };
  }
  if (enqueue) {
    const job = queueHistory(engine, config, options, enqueue);
    return { rows, materialization: { ...materialization, ...pendingJob(job) } };
  }
  return { rows, materialization };
}

function researchCoverage(input = {}) {
  if (input.coverageMode != null && !['verified', 'observed'].includes(input.coverageMode)) throw asError('Choose verified or observed coverage');
  if (input.coverageMode !== 'observed') return { coverageMode: 'verified' };
  const numeric = (value, fallback) => value == null ? fallback
    : (typeof value === 'number' || typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  const observedMinimum = numeric(input.observedMinimum, 20);
  const observedThreshold = numeric(input.observedThreshold, 0.8);
  if (!Number.isInteger(observedMinimum) || observedMinimum < 1 || observedMinimum > 100_000) {
    throw asError('Observed minimum must be a whole number from 1 to 100,000');
  }
  if (!(observedThreshold > 0 && observedThreshold <= 1)) {
    throw asError('Observed comparable fraction must be greater than 0 and at most 1');
  }
  return { coverageMode: 'observed', observedMinimum, observedThreshold };
}

function healthBaseline(model = DEFAULT_HEALTH_MODEL) {
  const calibration = Object.values(model.calibration || {}).filter((entry) => entry.type === 'percentile')
    .map((entry) => Number(entry.lookback ?? 252));
  return Math.max(44, ...calibration, Number(model.changeLookback ?? 0), Number(model.benchmarkLookback ?? 0), Number(model.weaknessLookback ?? 0));
}

function marketHealth(db, engine, config, { model, history, snapshot = engine.snapshot(config), ...coverage } = {}) {
  const eligible = snapshot.coverage.state === 'complete' || coverage.coverageMode === 'observed';
  let prior = history ?? (eligible
    ? thinHistory(db, engine, config, { limit: healthBaseline(model) + 1, materializedOnly: true }).rows : []);
  const archivedCurrent = prior.find((row) => row.date === snapshot.date);
  if (archivedCurrent) snapshot = { ...snapshot, aggregates: { ...snapshot.aggregates, ...archivedCurrent.aggregates } };
  if (eligible && config.date) {
    const priorWeek = weekEnd(shiftDate(config.date, -28));
    const exact = expectedSessions(shiftDate(priorWeek, -4), priorWeek).at(-1);
    if (exact && !prior.some((row) => row.date === exact)) {
      prior = [...prior, project(engine.snapshot({ ...config, date: exact }))];
    }
  }
  const first = prior.reduce((min, row) => row.date < min ? row.date : min, config.date);
  const sessions = first && config.date ? expectedSessions(first, config.date) : undefined;
  return calculateMarketHealth(snapshot, { model, history: prior, sessions, ...coverage });
}

function researchPrices(engine, config, ids, from, to) {
  const prices = engine.studyPrices(config, ids, from, to);
  if (config.basis !== 'reconstructed') return prices;
  for (const [security, rows] of prices) {
    prices.set(security, rows.map((row) => ({ ...row, sourceKnownAt: row.knownAt, knownAt: row.date })));
  }
  return prices;
}

function conditionMetrics(node) {
  if (!node || typeof node !== 'object') return [];
  const children = node.all || node.any;
  return [node.metric, node.after?.metric, ...(Array.isArray(children) ? children.flatMap(conditionMetrics) : [])].filter((key) => breadthMetric(key));
}

function conditionLookback(node) {
  if (!node || typeof node !== 'object') return 0;
  const children = node.all || node.any;
  return Math.max(['crossesAbove', 'crossesBelow'].includes(node.op) ? 1 : 0,
    node.after ? parseCount(node.after.within, 1, 1008, 20) : 0,
    ...(Array.isArray(children) ? children.map(conditionLookback) : []));
}

async function research(db, engine, kind, payload) {
  const coverage = kind === 'event-study' ? researchCoverage(payload) : {};
  const config = engine.context({ basis: 'known', ...payload.screen?.context, ...payload.context,
    ...screenDataNeeds(payload.screen ?? {}),
    ...(kind === 'event-study' ? { breadthKeys: conditionMetrics(payload.condition) } : {}) });
  const end = dateString(payload.asOf, config.latestDate);
  const start = dateString(payload.start, config.earliestDate);
  if (!start || !end) throw asError('Research requires imported trading sessions');
  if (end > config.latestDate) throw asError('Research end exceeds the latest available session');
  const prior = kind === 'event-study' ? conditionLookback(payload.condition) : 0;
  const beforeStart = prior ? expectedSessions(shiftDate(start, -2 * prior - 16), shiftDate(start, -1)).at(-prior) : start;
  const supportFrom = !beforeStart || beforeStart < config.earliestDate ? config.earliestDate : beforeStart;
  const sessions = sessionsBetween(supportFrom, end);
  if (kind === 'cohort') {
    const date = dateString(payload.date, config.date);
    if (!date || date < start || date > end || !isMarketSession(date)) throw asError('Cohort date is outside the trading session range');
    const dateConfig = { ...config, date };
    const selection = resolveScreen(engine, dateConfig, { ...(payload.screen || {}), all: true });
    const chosen = Array.isArray(payload.members) ? new Set(payload.members) : null;
    const members = (chosen ? selection.rows.filter((row) => chosen.has(row.securityId)) : selection.rows).map((row) => ({
      securityId: row.securityId, industry: row.industry, industryKnownAt: row.classificationKnownAt,
      delistingDate: row.delistingDate,
    }));
    const securityPrices = researchPrices(engine, config, members.map(({ securityId }) => securityId), date, end);
    return { ...analyzeCohort({ sessions, date, members, securityPrices, horizons: payload.horizons, asOf: end, maePrice: payload.maePrice }),
      priceAvailabilityBasis: config.basis, dataVersion: config.dataVersion };
  }
  const dates = sessions.filter((date) => date <= dateString(payload.end, end));
  const symbols = Array.isArray(payload.benchmarks) ? payload.benchmarks.slice(0, 10).map(String) : [config.benchmark, 'QQQ', 'IWM'];
  const historyConfig = { ...config, date: end, requestedDate: end };
  const archived = dates.length ? readMaterializedHistory(db, engine, historyConfig, { from: supportFrom,
    to: dates.at(-1), limit: Math.min(7560, dates.length) }).rows : [];
  const byDate = new Map(archived.map((row) => [row.date, row]));
  const observations = dates.map((date) => byDate.get(date)
    || project(engine.snapshot({ ...config, date, requestedDate: date }, { persist: false, cache: false })));
  const options = { sessions, observations, condition: payload.condition,
    horizons: payload.horizons, asOf: end, start, end: payload.end, overlap: payload.overlap, minEventGap: payload.minEventGap,
    maePrice: payload.maePrice, ...coverage };
  const cohorts = new Map();
  const ids = new Set();
  if (payload.medianStocks) {
    for (const { date } of runEventStudy(options).events) {
      const snapshot = engine.snapshot({ ...config, date, requestedDate: date }, { persist: false, cache: false });
      const members = snapshot.stocks.filter((row) => row.traded).map((row) => ({
        securityId: row.securityId, industry: row.industry, industryKnownAt: row.classificationKnownAt, delistingDate: row.delistingDate,
      }));
      cohorts.set(date, members);
      for (const member of members) ids.add(member.securityId);
    }
  }
  const benchmarks = Object.fromEntries(researchPrices(engine, config, symbols, start, end));
  const securityPrices = payload.medianStocks ? researchPrices(engine, config, ids, start, end) : undefined;
  return { ...runEventStudy({ ...options, benchmarks, cohorts, securityPrices }),
    observationSources: { archived: archived.length, computed: dates.length - archived.length,
      ...(supportFrom < start ? { supportingSessions: dates.filter((date) => date < start).length } : {}) },
    priceAvailabilityBasis: config.basis, dataVersion: config.dataVersion };
}

function publishVerifiedSession(db, engine, date, raw) {
  const revision = dataVersion(db);
  const models = [...BUILTIN_MODELS, ...listWorkspace(db, 'ranking-model')];
  for (const model of models) {
    const config = engine.context({ date, dataVersion: revision, model: model.id, modelVersion: model.version });
    engine.snapshot(config);
    writeRankArchive(db, engine, config, { limit: 1 });
    materializeHistory(db, engine, config, { limit: 1 });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    updateAlerts(db, engine, { date, dataVersion: revision });
    recordDailyPublication(db, { date, rawVersion: raw.version, dataRevision: revision,
      models: models.map(({ id, version }) => ({ id, version })) });
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function journalContext(db, engine, payload) {
  const config = engine.context({
    classification: classificationStatus(db).defaultClassification, ...payload.context,
    date: payload.asOfDate || payload.date,
  });
  if (!config.date || !config.earliestDate) throw new Error('Import prices before generating a market journal');
  if (payload.asOfDate && payload.asOfDate !== config.date) throw new Error('Choose a finalized session with market prices');
  const snapshot = engine.snapshot({ ...config, currentVersion: false }, { cache: false });
  const health = marketHealth(db, engine, config, { snapshot });
  const prior = readMaterializedHistory(db, engine, config, { limit: 21 }).rows.filter((row) => row.date < config.date);
  const traded = snapshot.stocks.filter((row) => row.traded);
  return { config, context: {
    date: snapshot.date, basis: snapshot.basis, referenceDate: snapshot.referenceDate, referenceMode: snapshot.referenceMode,
    dataVersion: snapshot.dataVersion, calculationVersion: snapshot.calculationVersion,
    universe: snapshot.universe, model: snapshot.model, benchmark: snapshot.benchmark,
    classificationSystem: snapshot.classificationSystem,
    coverage: snapshot.coverage, breadth: snapshot.breadth, aggregates: snapshot.aggregates,
    health: { score: health.score, state: health.state, regime: health.regime, components: health.components },
    groups: snapshot.groups.slice(0, 25).map(({ memberIds, ...group }) => group),
    leaders: traded.filter((row) => row.rsRank != null).sort((a, b) => a.rsRank - b.rsRank).slice(0, 12)
      .map(({ symbol, rsRank, rsPercentile, return_1d, return_21d, sector, industry }) =>
        ({ symbol, rsRank, rsPercentile, return_1d, return_21d, sector, industry })),
    prior: prior.map((row) => ({ date: row.date, coverage: row.coverage,
      breadth: Object.fromEntries(['above_20d', 'above_50d', 'above_200d', 'up_4pct', 'down_4pct'].map((metric) => [metric, row.breadth[metric]])),
      benchmarkReturn: row.aggregates.benchmarkReturn })),
  } };
}

function journalCsv(entries) {
  const rows = entries.map((entry) => ({
    asOfDate: entry.asOfDate, availableAt: entry.availableAt, tradableDate: entry.tradableDate,
    dataVersion: entry.dataVersion, calculationVersion: entry.calculationVersion, promptVersion: entry.promptVersion,
    model: entry.model, retrospective: entry.retrospective, sentiment: entry.output.sentiment,
    sentimentScore: entry.output.sentiment_score, health: entry.output.market_health,
    riskPosture: entry.output.risk_posture, confidence: entry.output.confidence,
    ...Object.fromEntries(entry.output.factors.map(({ key, value }) => [`factor_${key}`, value])),
    title: entry.output.title, markdown: entry.output.markdown,
  }));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return csvRows(rows, columns.length ? columns : ['asOfDate', 'availableAt', 'tradableDate', 'sentimentScore']);
}

export async function performJob(db, type, payload, { provider = EodhdProvider(), progress = () => {}, journalClient } = {}) {
  const engine = createEngine(db);
  if (type === 'leadership-transitions') {
    const config = engine.context(payload.context || {});
    if (!config.date || !config.earliestDate) throw asError('Load market history before comparing weekly leadership');
    const count = parseCount(payload.weeks, 2, 25, 8);
    const dates = expectedSessions(shiftDate(config.date, -7 * (count + 2)), config.date)
      .filter((date) => date >= config.earliestDate && expectedSessions(shiftDate(weekEnd(date), -4), weekEnd(date)).at(-1) === date).slice(-count);
    const snapshots = dates.map((date, index) => {
      const snapshot = engine.snapshot({ ...config, date, requestedDate: date }, { persist: false, cache: false });
      progress((index + 1) / dates.length);
      return snapshot;
    });
    return { ...leadershipTransitionMatrix(snapshots), dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION };
  }
  if (type === 'journal-generate') {
    if (!getJournalSettings(db).configured) throw new Error('Configure an Anthropic API key in Market Journal settings');
    const { config, context } = journalContext(db, engine, payload);
    progress(0.3);
    const { promptVersion, force, retrospective, includeNotes } = payload;
    return generateJournal(db, { asOfDate: config.date, context, sourceVersion: config.dataVersion,
      calculationVersion: CALCULATION_VERSION, basis: config.basis, benchmark: config.benchmark, universe: config.universe,
      promptVersion, force, retrospective, includeNotes: includeNotes === true, client: journalClient });
  }
  if (type === 'journal-backtest') {
    const config = engine.context(payload.context || {});
    const start = dateString(payload.start, config.earliestDate);
    const asOf = dateString(payload.asOf, config.latestDate);
    if (!start || !asOf || asOf > config.latestDate) throw new Error('Choose a study range within the loaded prices');
    const end = dateString(payload.end, asOf);
    if (end < start || end > asOf) throw new Error('Study end must be within the selected sessions');
    const sessions = sessionsBetween(start, asOf);
    const symbols = Array.isArray(payload.benchmarks) ? payload.benchmarks.slice(0, 8).map(String) : [config.benchmark];
    const priceBasis = payload.priceBasis === 'reconstructed' ? 'reconstructed' : 'known';
    const benchmarks = Object.fromEntries(researchPrices(engine, { ...config, basis: priceBasis }, symbols, start, asOf));
    const study = runJournalBacktest(db, { ...payload, universe: payload.universe || payload.context?.universe,
      universeVersion: payload.universeVersion || payload.context?.universeVersion,
      basis: payload.basis || payload.context?.basis, priceBasis, sessions, benchmarks, asOf, start, end });
    return { ...study, excludedRetrospective: study.selectionCounts.retrospectiveExcluded };
  }
  if (type === 'provider-probe') return provider.capabilities(payload);
  if (type === 'nasdaq-refresh') {
    const { refreshNasdaq } = await import('../scripts/refresh-nasdaq.mjs');
    progress(0.1);
    return refreshNasdaq(db);
  }
  if (type === 'provider-bootstrap') {
    const { runBootstrap } = await import('../scripts/bootstrap.mjs');
    return runBootstrap({ db, provider, options: payload,
      onProgress: (event) => { if (finite(event.percent)) progress(event.percent / 100); },
    });
  }
  if (type === 'provider-reference') return importProviderReference(payload, {
    db, provider, progress, write: (batch) => importDataset(db, batch),
    finishedPage: (dataset, date) => db.prepare(`SELECT json_extract(detail, '$.catalogRecords') AS records
      FROM ingestion_runs WHERE provider='eodhd' AND dataset=? AND status='complete' AND json_extract(detail, '$.catalogDate')=?
      ORDER BY started_at DESC LIMIT 1`).get(dataset, date)?.records,
  });
  if (type === 'provider-import') {
    const options = providerOptions(payload);
    const dates = providerDates(payload, options);
    if (options.bulk && !dates.length) throw new Error('No exchange sessions in the selected range');
    const captureStatus = (date) => bulkSessionStatus(db, date, { verifiedOnly: !!payload.verifiedOnly });
    const shouldFetch = !options.bulk || payload.force || dates.some((date) => !captureStatus(date));
    let result = { provider: 'eodhd', scope: 'full', dates: [], imported: 0, warnings: [] };
    let sourceError;
    if (shouldFetch) {
      try {
        result = await importProviderData(payload, {
          db, provider, progress: (step) => progress(step * (options.bulk ? 0.7 : 1)), write: (batch) => importDataset(db, batch),
          hasBulkDate: (date) => !!captureStatus(date),
        });
      } catch (error) {
        if (!options.bulk) throw error;
        sourceError = error;
      }
    }
    if (!options.bulk) {
      if (result.imported) updateAlerts(db, engine);
      return result;
    }
    const published = [];
    const stillPending = [];
    const alreadyPublished = [];
    for (const [index, date] of dates.entries()) {
      const raw = bulkSessionStatus(db, date, { verifiedOnly: true });
      if (!raw) stillPending.push(date);
      else if (dailyPublication(db, date, raw.version)) alreadyPublished.push(date);
      else {
        publishVerifiedSession(db, engine, date, raw);
        published.push(date);
      }
      progress(0.7 + 0.3 * (index + 1) / dates.length);
    }
    const hasPublication = published.length > 0 || alreadyPublished.length > 0;
    if (!hasPublication && sourceError) throw sourceError;
    if (payload.verifiedOnly && !hasPublication && stillPending.length) {
      throw new Error('Finalized price response was too incomplete to publish analytics');
    }
    if (sourceError) result.warnings.push(sourceError.message);
    if (stillPending.length) {
      result.warnings.push(`Verified analytics remain pending for ${stillPending.length} requested trading session${stillPending.length === 1 ? '' : 's'} with incomplete coverage.`);
    }
    return { ...result, published, alreadyPublished, stillPending };
  }
  if (type === 'workspace-precompute') return precomputeWorkspace(db, engine, engine.context(payload.context || {}), { ...payload, progress });
  if (type === 'production-precompute') {
    const config = engine.context({ ...workspaceDefaults(db), ...payload.context });
    const result = precomputeProduction(db, engine, config, { ...payload, progress });
    const history = readMaterializedHistory(db, engine, config, { limit: 45 }).rows;
    const sessions = history.length ? expectedSessions(history[0].date, config.date) : [];
    divergenceLedger(db, engine, config, DEFAULT_HEALTH_MODEL,
      marketHealthHistory(history, { sessions }).flatMap((day) => day.divergences), history[0]?.date);
    return result;
  }
  if (type === 'rank-materialize') return writeRankArchive(db, engine, engine.context(payload.context || {}), { ...payload, progress });
  if (type === 'materialize') {
    const config = engine.context(payload.context || {});
    return materializeHistory(db, engine, config, { ...payload, onProgress: ({ percent }) => progress(percent / 100) });
  }
  if (type === 'backup' && payload.format === 'parquet') return parquetBackup(db, progress);
  if (type === 'backup') return createCompressedBackup(db, { retain: payload.retain, sourceDate: payload.scheduledFor, progress });
  if (type === 'event-study' || type === 'cohort') return research(db, engine, type, payload);
  throw asError('Unknown background job');
}

function checkpointJobWrites(db) {
  if (db.isTransaction || !db.location()) return;
  try {
    const { busy, log, checkpointed } = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    if (busy || log <= 0 || log !== checkpointed) return;
    const { timeout } = db.prepare('PRAGMA busy_timeout').get();
    db.exec('PRAGMA busy_timeout=0');
    try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); }
    finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
  } catch {
    // Checkpoint contention or failure must not change the outcome of a finished job.
  }
}

export async function runQueuedJob(db, job, { provider, journalClient } = {}) {
  try {
    const progress = (step) => updateJob(db, job.id, 'running', Math.max(1, Math.min(99, Math.round(step * 99))));
    const result = await performJob(db, job.type, job.payload, { provider, journalClient, progress });
    updateJob(db, job.id, 'complete', 100, result);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    updateJob(db, job.id, 'failed', 0, null, error.message);
  } finally {
    checkpointJobWrites(db);
  }
}

export function createService({ db, provider, journalClient, workers = true } = {}) {
  const engine = createEngine(db);
  const workerPath = new URL('./job-worker.mjs', import.meta.url);
  let pumpScheduled = false;
  let activeJob = null;

  function schedulePump(wait = 0) {
    if (pumpScheduled || activeJob || !db.isOpen) return;
    pumpScheduled = true;
    const run = () => {
      pumpScheduled = false;
      startNext();
    };
    if (wait) setTimeout(run, wait).unref();
    else setImmediate(run);
  }

  function finishJob(job, error) {
    if (activeJob !== job.id) return;
    try {
      if (db.isOpen) {
        const current = db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id);
        if (current?.status === 'running') {
          updateJob(db, job.id, 'failed', 0, null, error || 'Background worker exited before reporting a result');
        }
      }
    } catch (writeError) {
      console.error('Background job result could not be recorded:', writeError.message);
      setTimeout(() => finishJob(job, error), 1000).unref();
      return;
    }
    activeJob = null;
    schedulePump();
  }

  function startNext() {
    if (activeJob || !db.isOpen) return;
    if (db.isTransaction) { schedulePump(1000); return; }
    let job;
    try {
      const waiting = db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
      if (!waiting) return;
      const claimed = db.prepare(`UPDATE jobs SET status='running',progress=1,updated_at=?
        WHERE id=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM jobs WHERE status='running') RETURNING id`)
        .get(new Date().toISOString(), waiting.id);
      if (!claimed) { schedulePump(1000); return; }
      activeJob = claimed.id;
      job = jobById(db, claimed.id);
    } catch (error) {
      if (activeJob) finishJob({ id: activeJob }, error.message);
      else {
        console.error('Background job dispatch could not claim a queued job:', error.message);
        schedulePump(1000);
      }
      return;
    }
    if (!(workers && !provider && !journalClient && db.location())) {
      runQueuedJob(db, job, { provider, journalClient }).then(() => finishJob(job), (error) => finishJob(job, error.message));
      return;
    }
    try {
      let failure;
      const worker = new Worker(workerPath, { workerData: { filename: db.location(), job }, execArgv: [] });
      worker.once('error', (error) => { failure = error.message; });
      worker.once('exit', (code) => finishJob(job, failure || (code === 0 ? null : `Background worker exited with code ${code}`)));
    } catch (error) { finishJob(job, error.message); }
  }

  function enqueue(type, payload, key = null) {
    let job;
    if (key) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const retainAttempt = type === 'backup' && payload.scheduledFor != null;
        const existing = db.prepare(`SELECT id FROM jobs WHERE type=? AND (status IN ('queued','running') OR ?)
          AND json_extract(payload, '$.jobKey')=? ORDER BY created_at DESC LIMIT 1`).get(type, Number(retainAttempt), key);
        if (existing) {
          db.exec('COMMIT');
          schedulePump();
          return jobById(db, existing.id);
        }
        job = createJob(db, type, { ...payload, jobKey: key });
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    } else job = createJob(db, type, payload);
    schedulePump();
    return job;
  }

  if (db.prepare("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").get()) schedulePump();

  function velocityOptions(config) {
    if (!requiresArchive(db) || engine.snapshotAvailable(config, { velocity: true })) return { velocity: true };
    if (!config.date || !config.earliestDate) return { velocity: false };
    if (bootstrapProgress(db, { activeOnly: true })) return { velocity: false, materialization: blockedCapture() };
    const context = materializationContext(config);
    const key = createHash('sha256').update(JSON.stringify(['workspace', context])).digest('hex');
    return { velocity: false, materialization: pendingJob(enqueue('workspace-precompute', { context }, key)) };
  }

  function pendingScreen(config, options, body = {}) {
    const needsSignal = body.rankingList && rankingList(body).needsVelocity;
    if (!(config.includeAllTimeHigh || needsSignal) || !options.materialization) return null;
    return response({ date: config.date, dataVersion: config.dataVersion, rows: [], total: null,
      columns: validateScreen(body).columns, pendingOnly: true,
      pendingReason: needsSignal ? 'Weekly RS signals' : 'Verified high history', ...options }, 202);
  }

  async function dispatch({ method = 'GET', url = '/', body = {} } = {}) {
    try {
      const address = new URL(url, 'http://localhost');
      if (!address.pathname.startsWith('/api/v1/')) return response({ error: 'Route not found' }, 404);
      const [area, item, action, sub] = address.pathname.slice('/api/v1/'.length).split('/').map(decodeURIComponent);
      const query = Object.fromEntries(address.searchParams);
      const asContext = (extra = {}) => {
        const config = engine.context({ ...query, ...extra });
        return bootstrapProgress(db, { activeOnly: true }) ? { ...config, currentVersion: false } : config;
      };
      const listContext = (extra = {}) => {
        const requested = { ...query, ...extra };
        if (requested.date || requested.dataVersion) return asContext(extra);
        const ready = latestAnalysis(db, dataVersion(db));
        return asContext(ready ? { ...extra, date: ready.date, dataVersion: ready.dataVersion } : extra);
      };
      const rowPage = () => [parseCount(query.page, 1, 100_000, 1), parseCount(query.perPage, 1, 250, 50)];

      if (area === 'journal') {
        if (item === 'settings') {
          if (method === 'GET' || method === 'PUT' || method === 'POST') {
            const settings = method === 'GET' ? getJournalSettings(db) : saveJournalSettings(db, body);
            const scheduleEffective = settings.configured && settings.enabled;
            const date = latestFinalizableSession(new Date(), process.env.MARKET_SYNC_AFTER || '20:30');
            const scheduleState = scheduleEffective ? scheduledJournalReadiness(db, { date })
              : { state: settings.configured ? 'disabled' : 'key_required', date };
            return response({ ...settings, schedulerAvailable: true, scheduleEffective, scheduleState });
          }
        }
        if (item === 'prompts') {
          if (method === 'GET') return response(listJournalPrompts(db));
          if (method === 'POST') {
            saveJournalPrompt(db, body);
            return response(listJournalPrompts(db), 201);
          }
        }
        if (item === 'generate' && method === 'POST') {
          if (!getJournalSettings(db).configured) throw asError('Configure an Anthropic API key in Market Journal settings');
          const config = asContext({ ...body.context, date: body.asOfDate || body.date || query.date });
          const { asOfDate, date, promptVersion, force, retrospective, includeNotes } = body;
          if (!config.date || !config.earliestDate || (asOfDate || date) && (asOfDate || date) !== config.date) {
            throw asError('Choose a finalized session with market data');
          }
          const input = { asOfDate: config.date, context: materializationContext(config), promptVersion, force, retrospective, includeNotes };
          const settings = getJournalSettings(db);
          const selectedPrompt = promptVersion ?? listJournalPrompts(db).active?.version;
          const noteVersion = includeNotes ? getJournalDate(db, config.date).notes?.version : null;
          const key = createHash('sha256').update(JSON.stringify(['journal', input.context, settings.model,
            selectedPrompt, !!force, !!retrospective, !!includeNotes, noteVersion])).digest('hex');
          return response(enqueue('journal-generate', input, key), 202);
        }
        if (item === 'backtest' && method === 'POST') return response(enqueue('journal-backtest', body), 202);
        if (item === 'factors' || item === 'series') {
          if (method === 'GET') {
            const selection = journalFactorSelection(db, query);
            const { rows } = selection;
            if (query.export === 'csv') {
              const flat = rows.map(({ factors, ...fields }) => ({ ...fields,
                ...Object.fromEntries(factors.map(({ key, value }) => [`factor_${key}`, value])) }));
              return download(csvRows(flat, [...new Set(flat.flatMap((row) => Object.keys(row)))]), 'journal-factors.csv');
            }
            return response(selection);
          }
        }
        if (item === 'notes' && method === 'POST') return response(saveJournalNote(db, body), 201);
        const entryDate = item === 'entries' ? action : isoDate(item) ? item : null;
        if (entryDate && method === 'GET') {
          const entry = getJournalDate(db, entryDate);
          if (query.export === 'markdown' && entry.entries.length) {
            return download(entry.entries[0].output.markdown, `market-journal-${entry.asOfDate}.md`, 'text/markdown; charset=utf-8');
          }
          return response(entry);
        }
        if (entryDate && method === 'PUT') return response(saveJournalNote(db, { ...body, asOfDate: entryDate }));
        if ((!item || item === 'entries') && method === 'GET') {
          const entries = listJournalEntries(db, query);
          if (query.export === 'csv') return download(journalCsv(entries), 'market-journal.csv');
          return response({ entries, noteDates: journalNoteDates(db, query) });
        }
      }
      if (area === 'data') {
        if (method === 'GET' && item === 'status') return response(localStatus(db));
        if (item === 'quality' && action === 'overrides') {
          if (method === 'GET') {
            const config = asContext();
            return response({ dataVersion: config.dataVersion, overrides: qualityOverrides(db, {
              version: config.dataVersion, knownThrough: config.basis === 'known' ? config.date : undefined,
              includeCleared: query.includeCleared === '1',
            }) });
          }
          if (method === 'POST') {
            const rows = Array.isArray(body.overrides) ? body.overrides : [body];
            if (!rows.length || rows.length > 50 || rows.some((row) => !row?.securityId)) throw asError('Supply 1–50 overrides with permanent security IDs');
            return response(importDataset(db, { provider: 'reviewed-operator', dataset: 'quality-overrides', qualityOverrides: rows }), 201);
          }
        }
        if (method === 'GET' && item === 'quality') return response(quality(db, engine, asContext()));
        if (method === 'POST' && item === 'import') return response(importDataset(db, body), 201);
        if (method === 'POST' && item === 'refresh') {
          providerOptions(body);
          return response(enqueue('provider-import', body), 202);
        }
        if (method === 'POST' && item === 'reference') return response(enqueue('provider-reference', body), 202);
        if (method === 'POST' && item === 'nasdaq-refresh') return response(enqueue('nasdaq-refresh', {}), 202);
        if (method === 'POST' && item === 'bootstrap') return response(enqueue('provider-bootstrap', body), 202);
        if (method === 'POST' && item === 'probe') return response(enqueue('provider-probe', body), 202);
        if (method === 'POST' && item === 'materialize') {
          return response(enqueue(body.kind === 'rankings' ? 'rank-materialize'
            : body.kind === 'workspace' ? 'workspace-precompute'
            : body.kind === 'production' ? 'production-precompute' : 'materialize', body), 202);
        }
        if (method === 'POST' && item === 'backup') {
          const format = body.format ?? 'sqlite';
          if (!['sqlite', 'sqlite-gzip', 'parquet'].includes(format)) throw asError('Backup format must be compressed SQLite or Parquet');
          return response(enqueue('backup', { format, retain: backupRetention(body.retain) }), 202);
        }
      }
      if (area === 'jobs' && method === 'GET') {
        if (item) return response(exists(jobById(db, item), 'Job'));
        return response(db.prepare('SELECT id,type,status,created_at,updated_at,progress,error FROM jobs ORDER BY created_at DESC LIMIT 30').all());
      }
      if (area === 'config' && method === 'GET') {
        const observedBenchmarks = availableBenchmarks(db);
        return response({
          universes: [...UNIVERSES, ...listWorkspace(db, 'universe')],
          models: [...BUILTIN_MODELS, ...listWorkspace(db, 'ranking-model')],
          healthModels: [DEFAULT_HEALTH_MODEL, ...listWorkspace(db, 'health-model')],
          rankingMethods: RANKING_METHODS, rankingPeriods, rankingLists, breadthMetrics: BREADTH_METRICS, columns: defaultColumns,
          benchmarks: [...new Set([...BENCHMARKS, ...observedBenchmarks])], availableBenchmarks: observedBenchmarks,
          ...classificationStatus(db),
          status: localStatus(db), exportFormats: await parquetAvailable() ? exportFormats : ['csv'],
        });
      }
      if (area === 'market' && method === 'GET') {
        const requestedMetrics = query.metrics ? String(query.metrics).split(',').filter((key) => breadthMetric(key) || key === 'adSpread') : [];
        const keys = [...new Set(requestedMetrics.length ? requestedMetrics : item === 'monitor' ? monitorMetrics : [])].slice(0, 24);
        const config = asContext({ breadthKeys: [item === 'breadth' ? action : null, ...keys].filter(Boolean) });
        if (item === 'analogs') {
          const coverage = researchCoverage(query);
          const horizon = parseCount(query.horizon, 1, 126, 20);
          const source = thinHistory(db, engine, config, { cadence: 'daily', limit: parseCount(query.historyLimit, 30, 2600, 252) }, enqueue);
          const sessions = source.rows.length ? expectedSessions(source.rows[0].date, config.date) : [];
          if (source.materialization?.pending || sessions.length < 2) {
            return response({ matches: [], materialization: source.materialization, asOf: config.date,
              descriptive: coverage.coverageMode === 'observed', ...coverage });
          }
          return response({ ...findHistoricalAnalogs({ snapshots: source.rows, sessions, asOf: config.date, horizon,
            limit: parseCount(query.limit, 1, 30, 10), ...coverage }), materialization: source.materialization, dataVersion: config.dataVersion });
        }
        if (item === 'monitor') {
          const metrics = keys.map((key) => {
            const definition = breadthMetric(key);
            if (!definition) return { key, label: 'A/D spread', definition: 'Advancers minus decliners divided by comparable stocks, multiplied by 100.' };
            const { test, ...summary } = definition;
            return summary;
          });
          const limit = parseCount(query.limit, 1, 252, 63);
          const source = thinHistory(db, engine, config, { to: query.to, cadence: 'daily',
            from: query.from ? shiftDate(dateString(query.from), -2 * extremeDefinition.lookback - 16) : undefined,
            limit: limit + extremeDefinition.lookback,
            materializedOnly: query.materializedOnly === '1',
            visibleRequested: limit }, enqueue);
          const rows = formatHistory(source.rows, keys, true)
            .filter((row) => !query.from || row.date >= query.from).slice(-limit);
          if (exportFormats.includes(query.export) && source.materialization?.pending) return response({ materialization: source.materialization }, 202);
          if (exportFormats.includes(query.export)) return await exportTable(rows,
            ['date', ...historyColumns(keys), ...keys.map((key) => `${key}_extreme_percentile`),
              ...ratioDefinitions.flatMap(({ key }) => [key, `${key}_state`, `${key}_numerator`, `${key}_denominator`]), 'coverage', 'eligible', 'traded'],
            'market-monitor', query.export, config);
          const snapshot = engine.snapshot(config);
          return response({ date: config.date, coverage: snapshot.coverage, metrics, rows, ratioDefinitions, extremeDefinition,
            currentReading: snapshot.date ? formatHistory([snapshot], keys, true)[0] : null,
            materialization: source.materialization, dataVersion: config.dataVersion });
        }
        if (item === 'overview') {
          const snapshot = engine.snapshot(config);
          const { stocks, ...thin } = snapshot;
          const traded = stocks.filter((row) => row.traded);
          const leaders = traded.filter(({ rsRank }) => rsRank != null).sort((a, b) => a.rsRank - b.rsRank).slice(0, 8);
          const movers = traded.filter((row) => finite(row.return_1d)).sort((a, b) => b.return_1d - a.return_1d);
          const model = chooseHealthModel(db, query.healthModel);
          const support = snapshot.coverage.state === 'complete' && healthBaseline(model) > 44
            ? thinHistory(db, engine, config, { limit: healthBaseline(model) + 1, cadence: 'daily' }, enqueue) : null;
          return response({ ...thin, groups: thin.groups.slice(0, 12).map(({ memberIds, ...group }) => group), leaders,
            movers: { gainers: movers.slice(0, 5), losers: movers.slice(-5).reverse() },
            ...(support?.materialization ? { materialization: support.materialization } : {}),
            health: marketHealth(db, engine, config, { snapshot, model, history: support?.rows }) });
        }
        if (item === 'breadth') {
          if (sub === 'contributors') {
            const [page, perPage] = rowPage();
            const exportRequested = exportFormats.includes(query.export);
            const result = breadthContributors(engine.snapshot(config), action, query.include, page, perPage, exportRequested);
            if (exportRequested) return await exportTable(result.rows,
              ['symbol', 'name', 'exchange', 'close', 'breadthSelection', ...(action === 'adSpread' ? ['contribution'] : [])],
              'market-breadth-contributors', query.export, config);
            return response(result);
          }
          if (query.series === '1' || query.from || query.to) {
            const keys = String(query.metrics || action || 'above_50d,above_200d,up_4pct,down_4pct').split(',')
              .filter((key) => breadthMetric(key) || key === 'adSpread' || leadershipHistoryMetrics.has(key));
            const limit = parseCount(query.limit, 1, query.materializedOnly ? 7560 : 260, 80);
            const dailyLimit = query.cadence === 'weekly' ? Math.min(7560, limit * 5) : limit;
            const requestedFrom = dateString(query.from, null);
            const onlyStored = query.materializedOnly === '1';
            const history = thinHistory(db, engine, config, { ...query,
              from: requestedFrom && !onlyStored ? shiftDate(requestedFrom, -2 * extremeDefinition.lookback - 16) : requestedFrom,
              cadence: 'daily', limit: Math.min(7560, dailyLimit + (onlyStored ? 0 : extremeDefinition.lookback)),
              materializedOnly: onlyStored, visibleRequested: limit }, enqueue);
            const mapped = formatHistory(history.rows, keys).filter((row) => !requestedFrom || row.date >= requestedFrom);
            const rows = marketHistoryRows(mapped, { cadence: query.cadence, limit,
              from: requestedFrom, to: query.to && query.to < config.date ? query.to : config.date });
            if (exportFormats.includes(query.export) && history.materialization?.pending) return response({ materialization: history.materialization }, 202);
            if (exportFormats.includes(query.export)) {
              const leadership = keys.filter((key) => leadershipHistoryMetrics.has(key));
              return await exportTable(rows, ['date', ...historyColumns(keys.filter((key) => !leadershipHistoryMetrics.has(key))),
                ...leadership, ...(leadership.length ? leadershipHistoryContext : []), 'equalWeight', 'capWeight',
                'equalWeightIndex', 'capWeightIndex', 'largestPositiveDollarShare', 'coverage', 'eligible', 'traded'], 'market-history', query.export, config);
            }
            return response({ date: config.date, metrics: keys, rows, materialization: history.materialization, dataVersion: config.dataVersion });
          }
          const snap = engine.snapshot(config);
          return response({ date: snap.date, referenceDate: snap.referenceDate, referenceMode: snap.referenceMode,
            classificationSystem: snap.classificationSystem, coverage: snap.coverage, metrics: action ? { [action]: snap.breadth[action] } : snap.breadth });
        }
        if (item === 'health' || item === 'events') {
          const coverage = researchCoverage(query);
          const snapshot = engine.snapshot(config);
          const model = chooseHealthModel(db, query.healthModel);
          const visible = parseCount(query.limit, 1, 260, 45);
          const warmup = healthBaseline(model);
          const requestedFrom = dateString(query.from, null);
          const source = snapshot.coverage.state === 'complete' || coverage.coverageMode === 'observed' || query.series === '1' || item === 'events'
            ? thinHistory(db, engine, config, { ...query, cadence: 'daily', limit: visible + warmup, visibleRequested: visible,
              from: requestedFrom && shiftDate(requestedFrom, -2 * warmup - 16) }, enqueue) : { rows: [] };
          const health = marketHealth(db, engine, config, { model, history: source.rows, snapshot, ...coverage });
          const sessions = source.rows.length ? expectedSessions(source.rows[0].date, source.rows.at(-1).date) : [];
          const all = query.series === '1' || item === 'events' ? marketHealthHistory(source.rows, { model, sessions, ...coverage }) : [];
          const series = all.filter((row) => !requestedFrom || row.date >= requestedFrom).slice(-visible);
          const events = divergenceLedger(db, engine, config, model, series.flatMap((day) => day.divergences), series[0]?.date, coverage);
          return response(item === 'events' ? { date: config.date, events, ...coverage, materialization: source.materialization }
            : { ...health, events, history: series, materialization: source.materialization });
        }
      }
      if (area === 'rankings' && method === 'GET') {
        const config = query.series === '1' ? asContext() : listContext();
        if (query.series === '1') {
          return response(rankSeries(db, engine, config, { ...query, cadence: query.cadence || 'weekly',
            limit: parseCount(query.limit, 1, 7560, 60) }, enqueue));
        }
        const options = velocityOptions(config);
        const pending = pendingScreen(config, options, query);
        if (pending) return pending;
        const result = resolveScreen(engine, config, query, options);
        return response({ ...result, ...options, model: config.model, universe: config.universe, dataVersion: config.dataVersion });
      }
      if (area === 'screens' && item === 'query' && method === 'POST') {
        const config = listContext({ ...body.context, ...screenDataNeeds(body) });
        const options = velocityOptions(config);
        const pending = pendingScreen(config, options, body);
        if (pending) return pending;
        const result = resolveScreen(engine, config, body, options);
        if (exportFormats.includes(body.export)) return await exportTable(result.rows, result.columns.length ? result.columns : defaultColumns, 'market-screen', body.export, config);
        return response({ ...result, ...options, dataVersion: config.dataVersion });
      }
      if (area === 'stocks' && method === 'GET' && item) {
        const config = asContext();
        if (action === 'screens') {
          const security = exists(engine.findSecurity(config, item), 'Security');
          const saved = listWorkspace(db, 'screen');
          const matched = [];
          for (const screen of saved) {
            const screenConfig = engine.context({ ...query, ...savedScreenContext(screen.definition), ...screenDataNeeds(screen.definition),
              date: config.date, dataVersion: config.dataVersion });
            const options = velocityOptions(screenConfig);
            const pending = pendingScreen(screenConfig, options, screen.definition);
            if (pending) return response({ date: config.date, screens: matched, evaluated: null,
              pendingOnly: true, materialization: options.materialization }, 202);
            const snapshot = engine.snapshot(screenConfig, options);
            const filters = [screen.definition.filter, { field: 'securityId', op: 'eq', value: security.id }].filter(Boolean);
            const results = historicalScreen(engine, screenConfig, { ...screen.definition, page: 1, perPage: 1,
              filter: { operator: 'and', filters } }, snapshot);
            if (results.total) matched.push({ id: screen.id, name: screen.name, version: screen.version,
              universe: screenConfig.universe.id, model: screenConfig.model.id });
          }
          return response({ date: config.date, securityId: security.id, evaluated: saved.length, screens: matched });
        }
        if (action === 'rankings') {
          const security = exists(engine.findSecurity(config, item), 'Security');
          return response({ securityId: security.id, ...rankSeries(db, engine, config, { ...query, securityId: security.id,
            cadence: query.cadence || 'weekly', limit: parseCount(query.limit, 1, 260, 44) }, enqueue, { supplyDemand: true }) });
        }
        const options = velocityOptions(config);
        const detail = exists(engine.detail(config, item, parseCount(query.lookback, 1, 2600, 252), options), 'Security');
        if (action === 'metrics') return response({ ...detail, bars: undefined, chartBars: undefined, actions: undefined });
        if (exportFormats.includes(query.export)) return await exportTable(detail.bars, ['date', 'open', 'high', 'low', 'close', 'volume', 'dollarVolume'], 'stock-prices', query.export, config);
        const bench = detail.bars.length ? engine.studyPrices(config, [config.benchmark], detail.bars[0].date, config.date).get(config.benchmark) : null;
        const directMembership = listWorkspace(db, 'watchlist').filter((list) => list.definition.members?.includes(detail.securityId)).map(({ name }) => name);
        return response({ ...detail, ...options, benchmark: config.benchmark, risk: riskMetrics(detail, bench), watchlists: directMembership });
      }
      if (area === 'industries' && method === 'GET') {
        const config = asContext();
        const options = velocityOptions(config);
        const snap = engine.snapshot(config, options);
        if (!item) return response({ date: snap.date, ...options, referenceDate: snap.referenceDate, referenceMode: snap.referenceMode,
          classificationSystem: snap.classificationSystem, coverage: snap.coverage, groups: snap.groups.filter((group) => !query.level || group.level === query.level) });
        if (item === 'compare') {
          const ids = String(query.ids || '').split(',').filter(Boolean).slice(0, 8);
          const limit = parseCount(query.limit, 1, 260, 80);
          const cadence = query.cadence === 'weekly' ? 'weekly' : 'daily';
          const { rows: history, materialization } = thinHistory(db, engine, config, { ...query, cadence: 'daily',
            limit: cadence === 'weekly' ? limit * 5 : limit, visibleRequested: limit }, enqueue);
          const rows = groupHistoryRows(history, ids, { cadence, limit, from: query.from,
            to: query.to && query.to < config.date ? query.to : config.date });
          return response({ date: snap.date, cadence, materialization, rows });
        }
        const group = exists(snap.groups.find((g) => g.id === item), 'Industry group');
        if (action === 'members') {
          const selected = new Set(group.memberIds);
          return response(screenStocks({ ...snap, stocks: snap.stocks.filter((stock) => selected.has(stock.securityId)) }, query));
        }
        return response(group);
      }
      if (area === 'research' && method === 'POST') {
        if (item === 'event-studies') return response(enqueue('event-study', { ...body, ...researchCoverage(body) }), 202);
        if (item === 'leadership-transitions') return response(enqueue('leadership-transitions', body), 202);
        if (item === 'cohorts') {
          const config = asContext({ ...body.screen?.context, ...body.context, ...screenDataNeeds(body.screen ?? {}) });
          const date = dateString(body.date, config.date);
          if (body.name && date) {
            const selected = resolveScreen(engine, { ...config, date }, { ...body.screen, all: true });
            const requested = Array.isArray(body.members) ? new Set(body.members) : null;
            body.members = selected.rows.filter((row) => !requested || requested.has(row.securityId)).map(({ securityId }) => securityId);
            storeWorkspace(db, 'cohort', { name: body.name, definition: { ...body, date } });
          }
          return response(enqueue('cohort', body), 202);
        }
      }
      if (area === 'alerts') {
        if (method === 'GET') return response(db.prepare('SELECT payload FROM alert_events ORDER BY date DESC LIMIT 250').all().map(({ payload }) => JSON.parse(payload)));
        if (method === 'POST' && item === 'evaluate') return response(updateAlerts(db, engine, body.context));
      }
      if (area === 'scheduler' && method === 'POST' && item === 'sync') {
        const date = latestFinalizableSession();
        return response(enqueue('provider-import', { bulk: true, date, ...body }), 202);
      }
      if (collections[area]) {
        const kind = collections[area];
        const defaults = kind === 'ranking-model' ? BUILTIN_MODELS : kind === 'universe' ? UNIVERSES : [];
        if (!item && method === 'GET') return response([...defaults, ...listWorkspace(db, kind)]);
        if (!item && method === 'POST') return response(storeWorkspace(db, kind, { name: body.name, definition: workspaceDefinition(kind, body) }), 201);
        if (item) {
          const builtin = defaults.find(({ id }) => id === item);
          const saved = exists(builtin || getWorkspace(db, kind, item, query.version ? Number(query.version) : null), 'Saved item');
          if (method === 'GET' && !action) return response(saved);
          if (method === 'POST' && action === 'duplicate') {
            return response(storeWorkspace(db, kind, { name: body.name || `${saved.name} copy`, definition: saved.definition }), 201);
          }
          if (method === 'POST' && action === 'execute' && kind === 'screen') {
            const config = listContext({ ...savedScreenContext(saved.definition), ...body.context, ...screenDataNeeds({ ...saved.definition, ...body }) });
            const options = velocityOptions(config);
            const pending = pendingScreen(config, options, { ...saved.definition, ...body });
            if (pending) return pending;
            const result = resolveScreen(engine, config, { ...saved.definition, ...body }, options);
            if (exportFormats.includes(body.export)) return await exportTable(result.rows, result.columns.length ? result.columns : defaultColumns, 'saved-screen', body.export, config);
            return response({ ...result, ...options, dataVersion: config.dataVersion });
          }
          if (method === 'POST' && action === 'execute' && kind === 'cohort') return response(enqueue('cohort', { ...saved.definition, ...body }), 202);
          if (kind === 'watchlist' && action === 'members' && method === 'GET') {
            const screen = saved.definition.screenId && getWorkspace(db, 'screen', saved.definition.screenId);
            if (screen) {
              const screenConfig = listContext({ ...savedScreenContext(screen.definition), ...screenDataNeeds(screen.definition) });
              const screenOptions = velocityOptions(screenConfig);
              const pending = pendingScreen(screenConfig, screenOptions, screen.definition);
              if (pending) return pending;
              return response({ ...resolveScreen(engine, screenConfig, { ...screen.definition, page: query.page, perPage: query.perPage }, screenOptions),
                ...screenOptions, dataVersion: screenConfig.dataVersion });
            }
            const config = asContext();
            const options = velocityOptions(config);
            const pending = pendingScreen(config, options);
            if (pending) return pending;
            const snapshot = engine.snapshot(config, options);
            const wanted = new Set(saved.definition.members);
            const list = snapshot.stocks.filter((stock) => wanted.has(stock.securityId));
            const included = new Set(list.map((stock) => stock.securityId));
            return response({ ...screenStocks({ ...snapshot, stocks: list }, { ...query, includeUntraded: true }),
              unavailable: [...wanted].filter((id) => !included.has(id)), ...options });
          }
          if (kind === 'watchlist' && action === 'members' && method === 'POST') {
            if (saved.definition.screenId) throw asError('Edit the dynamic watchlist’s source screen');
            const removed = new Set(validMembers(body.remove));
            const members = validMembers([...(saved.definition.members || []), ...validMembers(body.add)]).filter((id) => !removed.has(id));
            return response(storeWorkspace(db, kind, { name: saved.name, definition: { members, mode: 'manual', screenId: null } }, saved.id));
          }
          if (!builtin && method === 'PUT' && !action) return response(storeWorkspace(db, kind, { name: body.name, definition: workspaceDefinition(kind, body) }, item));
          if (!builtin && method === 'DELETE' && !action) return response(storeWorkspace(db, kind, saved, item, true));
        }
      }
      return response({ error: 'Route not found' }, 404);
    } catch (error) {
      return response({ error: error.message }, error.status || 400);
    }
  }

  return { dispatch, enqueue, engine, workspaceConfiguration: () => workspaceDefaults(db),
    journalConfiguration() {
      const { model, modelVersion, reference, ...context } = workspaceDefaults(db);
      return { ...context, analysisModel: model, analysisModelVersion: modelVersion, referenceMode: reference };
    },
    updateAlerts: (params) => updateAlerts(db, engine, params) };
}

import { createHash } from 'node:crypto';
import { totalmem } from 'node:os';
import { Worker } from 'node:worker_threads';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isAnalysisCalculationJob, readAnalysisReadiness } from './analysis-readiness.mjs';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import {
  bulkSessionStatus, CALCULATION_VERSION, createJob, dailyPublication, dataVersion, getWorkspace, importDataset, isoDate, jobById, listWorkspace, storeWorkspace,
  normalizeSymbol, qualityOverrides, recordDailyPublication, today, updateJob, warehouseStatus,
} from './database.mjs';
import { expectedSessions, isMarketSession, latestFinalizableSession, shiftDate, weekEnd } from './calendar.mjs';
import { backupRetention, createCompressedBackup } from './backup.mjs';
import { runBatchPreparation } from './batch-preparation.mjs';
import { BREADTH_METRICS, breadthMetric, binaryMetric } from './breadth.mjs';
import { chartBookIndustryJob, createChartBook, prepareChartBookIndustries, readChartBookSnapshot, scheduleChartBookIndustries } from './chartbook.mjs';
import { createEngine, UNIVERSES, validateUniverse } from './engine.mjs';
import { AVERAGES, DEFAULT_WINDOWS, alignSeries, finite, mean, volumeRatio } from './metrics.mjs';
import {
  generateJournal, getJournalDate, getJournalSettings, journalFactorSelection, journalNoteDates,
  listJournalEntries, listJournalPrompts, runJournalBacktest, saveJournalNote, saveJournalPrompt, saveJournalSettings,
} from './journal.mjs';
import { parquetAvailable, parquetBackup, parquetRows } from './parquet.mjs';
import { materializeHistory, readMaterializedHistory } from './materialization.mjs';
import { precomputeProduction, precomputeWorkspace } from './precompute.mjs';
import { createPreparedDetailWriter, detailRiskWindows, prepareDetailsBatch, readPreparedDetail, riskMetrics } from './prepared-details.mjs';
import { hasPreparedSnapshot, preparedSnapshotDates, readPreparedSnapshot } from './prepared-snapshots.mjs';
import { batchPreparationSpecs, enqueuePreparation, preparationInput, preparationSpecs, preparationStatus, preparationSuperseded, preparationType, readPreparedRanks,
  recentPreparationSessions, registerPreparation, registeredPreparations, requirePreparationSpace, runPreparation } from './preparation.mjs';
import { applyPreparedRangeMetrics, prepareRangeMetrics, rangeWindowsForScreen, readPreparedRangeMetrics } from './range-metrics.mjs';
import { BENCHMARKS, EodhdProvider, importProviderData, importProviderReference, providerDates, providerOptions } from './provider.mjs';
import { BUILTIN_MODELS, RANKING_METHODS, rankBy, validateModel } from './ranking.mjs';
import { readRankArchive, writeRankArchive } from './rank-archive.mjs';
import { analyzeCohort, calculateMarketHealth, DEFAULT_HEALTH_MODEL, findHistoricalAnalogs, leadershipTransitionMatrix,
  marketHealthHistory, runEventStudy } from './research.mjs';
import { createRiskHistoryWriter, normalizeRiskBenchmarks, normalizeRiskWindows, prepareRiskHistoryBatch, prepareRiskHistoryBenchmarks } from './risk-history.mjs';
import { csvRows, screenStocks, validateFilter, validateScreen } from './screener.mjs';
import { prepareSummation, readPreparedSummation } from './summation.mjs';
import { decodeStoredJson, encodeStoredJson } from './storage-codec.mjs';

const collections = {
  screens: 'screen', watchlists: 'watchlist', 'ranking-models': 'ranking-model',
  universes: 'universe', 'health-models': 'health-model', themes: 'theme',
  'alert-rules': 'alert-rule', cohorts: 'cohort',
};
const resolvedSnapshot = Symbol('prepared snapshot');
const resolvedHistory = Symbol('prepared history reader');

export function scheduledPrecomputeKey(date, version) {
  return `production-precompute:${CALCULATION_VERSION}:${date}:${version}`;
}

export const defaultMarketSyncAfter = '16:30';
export const dailyCaptureOffsets = [0, 10, 25, 50];
const dailyAvailabilityMinutes = 90;
const easternClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function marketSyncAfter(value) {
  const after = value || defaultMarketSyncAfter;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(after)) throw new Error('MARKET_SYNC_AFTER must be an Eastern time in HH:MM format');
  return after;
}

export function rawBulkReceipt(db, date) {
  return db.prepare(`SELECT s.date,s.version,s.received,s.expected FROM session_imports s JOIN ingestion_runs r ON r.id=s.run_id
    WHERE s.date=? AND s.scope='full' AND r.provider='eodhd' AND r.status='complete'
      AND (r.dataset='bulk-eod' OR r.dataset LIKE 'bootstrap-current-coverage:%')
    ORDER BY s.version DESC LIMIT 1`).get(date) || null;
}

function availabilityClock(date, now, after) {
  const clock = Object.fromEntries(easternClock.formatToParts(now).map(({ type, value }) => [type, value]));
  const today = `${clock.year}-${clock.month}-${clock.day}`;
  const [hours, minutes] = marketSyncAfter(after).split(':').map(Number);
  const elapsed = 60 * Number(clock.hour) + Number(clock.minute) - 60 * hours - minutes;
  return { today, elapsed, inWindow: today === date && elapsed >= 0 && elapsed <= dailyAvailabilityMinutes };
}

export function dailyCaptureAvailability(db, date, now, after = defaultMarketSyncAfter) {
  const raw = rawBulkReceipt(db, date);
  const verified = bulkSessionStatus(db, date, { verifiedOnly: true });
  const jobs = db.prepare(`SELECT status,updated_at FROM jobs WHERE type='provider-import'
    AND json_extract(payload,'$.scheduledFor')=? AND json_type(payload,'$.captureAttempt')='integer' ORDER BY rowid`).all(date);
  const previous = jobs.at(-1);
  const { today, elapsed, inWindow } = availabilityClock(date, now, after);
  const attempts = jobs.length;
  const record = { date, after, timezone: 'America/New_York', retryOffsetsMinutes: dailyCaptureOffsets,
    availabilityMinutes: dailyAvailabilityMinutes, attempts, maxAttempts: dailyCaptureOffsets.length, receipt: raw, due: false };
  if (verified) return { ...record, state: 'verified' };
  if (jobs.some(({ status }) => status === 'running' || status === 'queued')) return { ...record, state: 'capturing' };
  if (inWindow && attempts < dailyCaptureOffsets.length) {
    const offset = dailyCaptureOffsets[attempts];
    const delay = attempts ? dailyCaptureOffsets[attempts] - dailyCaptureOffsets[attempts - 1] : 0;
    const eligibleAt = previous ? Date.parse(previous.updated_at) + delay * 60_000 : 0;
    const due = elapsed >= offset && now.getTime() >= eligibleAt;
    return { ...record, state: due ? 'due' : 'waiting', due };
  }
  if (!raw && !attempts && (today > date || today === date && elapsed >= 0)) {
    return { ...record, state: 'due', due: true, catchUp: true };
  }
  return { ...record, state: 'exhausted' };
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

export function savedScreenContext(definition) {
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

const velocityField = /^(?:rsStatus|rankChange(?:1|4|12)w|velocity(?:1|4|12)w|rsScoreChange|rsAcceleration|rsNewHigh|leadingWeeks|leadingWeekCoverage|topDecile(?:Weeks|Persistence)(?:4|8|12)w|enteredTop(?:1|5|10|20)|rsHighBeforePrice|deterioratingOnPriceStrength|momentumImproving|udvChange4w|upVolumeShareChange4w|volumeDemandImproving|priceAndVolumeStrength|lifecycle|industryVelocity|industryImproving|industryEmerging)$/;
const rangeFieldWindow = (field) => Number(/^range_(?:distance|since|age)_(?:high|low)_(\d+)d$/.exec(field)?.[1]) || null;

function previousSession(date, lag) {
  return expectedSessions(shiftDate(date, -2 * lag - 8), date).at(-lag - 1);
}

function knownRangeDependencies(definition, point) {
  if (point.basis !== 'known' || !point.date) return [];
  const { filter, computed } = validateScreen(definition);
  const dates = new Map();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['previous', 'change'].includes(node.fn)) {
      const window = rangeFieldWindow(node.args[0]?.field);
      const lag = node.args[1] ? node.args[1].literal : 20;
      if (window && Number.isInteger(lag) && lag >= 1 && lag <= 1008) {
        const date = previousSession(point.date, lag);
        if (date && date >= point.earliestDate) dates.set(date, [...new Set([...(dates.get(date) || []), window])]);
      }
    }
    for (const entry of Object.values(node)) {
      if (Array.isArray(entry)) entry.forEach(visit);
      else if (entry && typeof entry === 'object') visit(entry);
    }
  }
  visit(filter);
  computed.forEach(visit);
  return [...dates].map(([date, rangeWindows]) => ({ date, rangeWindows }));
}

function screenNeedsVelocity(input) {
  const { columns, sort, computed, filter } = validateScreen(input);
  const usesField = (node) => node && (velocityField.test(node.field || '') || usesField(node.ast)
    || usesField(node.arg) || usesField(node.left) || usesField(node.right)
    || node.args?.some(usesField) || node.filters?.some(usesField));
  return Boolean(input.rankingList && rankingList(input).needsVelocity
    || [...columns, ...sort.map(({ field }) => field)].some((field) => velocityField.test(field))
    || computed.some(usesField) || usesField(filter));
}

function missingScreenHistory(config, point, field, dependency) {
  return Object.assign(new Error(dependency?.prepareAction === 'range'
    ? 'Historical rolling high/low metrics are not prepared for the comparison session'
    : 'A historical comparison snapshot is not prepared'), {
    preparation: { date: config.date, dataVersion: config.dataVersion, rows: [], total: null, pendingOnly: true,
      pendingReason: 'Historical comparison metrics', materialization: { preparationState: 'unregistered', ...dependency,
        requiredDate: point.date, requiredField: field } },
  });
}

function historicalScreen(db, engine, config, input, snapshot, historyReader) {
  if (input.rankingPeriod && input.rankingList) throw asError('Choose a period or an RS signal list');
  const list = input.rankingPeriod ? periodScreen(snapshot, input) : input.rankingList ? signalScreen(snapshot, input) : null;
  if (list) ({ snapshot, input } = list);
  const lags = new Map();
  function previous(field, id, period) {
    const lag = Number(period);
    const velocity = velocityField.test(field);
    const rangeWindow = rangeFieldWindow(field);
    const cacheKey = `${lag}:${velocity}:${rangeWindow ?? ''}`;
    if (!Number.isInteger(lag) || lag < 1 || lag > 1008 || lags.size >= 24 && !lags.has(cacheKey)) return null;
    if (!lags.has(cacheKey)) {
      const date = previousSession(config.date, lag);
      const point = { ...config, date, requestedDate: date };
      let prior = date && date >= config.earliestDate ? historyReader
        ? historyReader(point, { velocity }) : engine.snapshot(point, { velocity }) : null;
      if (date && date >= config.earliestDate && historyReader && !prior) throw missingScreenHistory(config, point, field);
      if (prior && rangeWindow) {
        const rangePoint = rangeContext(engine, point);
        const prepared = readPreparedRangeMetrics(db, rangePoint, [rangeWindow]);
        if (!prepared.ready) throw missingScreenHistory(config, point, field, rangePendingStatus(db, engine, rangePoint, prepared));
        prior = applyPreparedRangeMetrics(prior, prepared);
      }
      lags.set(cacheKey, new Map((prior?.stocks || []).map((row) => [row.securityId, row])));
    }
    return lags.get(cacheKey).get(id)?.[field] ?? null;
  }
  const result = screenStocks(snapshot, input, { previous, all: exportFormats.includes(input.export) || input.all === true });
  return { ...result, ...(list?.period ? { period: list.period } : {}), ...(list?.list ? { rankingList: list.list } : {}), referenceDate: snapshot.referenceDate,
    referenceMode: snapshot.referenceMode, classificationSystem: snapshot.classificationSystem };
}

export function screenDataNeeds(body) {
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

function resolveScreen(db, engine, config, body, options = {}) {
  const { velocity = true, rangeMetrics } = options;
  const snapshot = options[resolvedSnapshot] || engine.snapshot(config, { velocity });
  return historicalScreen(db, engine, config, body, rangeMetrics ? applyPreparedRangeMetrics(snapshot, rangeMetrics) : snapshot, options[resolvedHistory]);
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

export function summationContext(db, engine, config) {
  const sec = db.prepare("SELECT 1 FROM classifications WHERE system='sec-sic' AND industry IS NOT NULL AND version<=? LIMIT 1").get(config.dataVersion);
  return engine.context({ ...workspaceDefaults(db), date: config.date, dataVersion: config.dataVersion,
    universe: 'nyse', universeVersion: 1, reference: 'as-of', ...(sec ? { classification: 'sec-sic' } : {}) });
}

export function prepareNyseSummation(db, engine, config, { batch = false } = {}) {
  const sessions = expectedSessions(config.earliestDate, config.date);
  if (batch && engine.batchAdvanceDecline) {
    return prepareSummation(db, config, sessions, [...engine.batchAdvanceDecline(config, { dates: sessions })]);
  }
  const observations = [];
  for (let index = 0; index < sessions.length; index += 120) {
    const dates = sessions.slice(index, index + 120);
    const stored = readMaterializedHistory(db, engine, config, { from: dates[0], to: dates.at(-1), limit: dates.length });
    if (!stored.complete) throw new Error('NYSE advancing and declining breadth is still being prepared');
    for (const row of stored.rows) observations.push({
      date: row.date, advancers: row.breadth.advancers?.numerator, decliners: row.breadth.decliners?.numerator,
      comparable: row.breadth.advancers?.denominator, traded: row.coverage.traded,
    });
  }
  return prepareSummation(db, config, sessions, observations);
}

const rangeType = 'prepare-range';
const rangeHistoryType = 'prepare-range-history';
const detailType = 'prepare-stock-details';
const riskHistoryType = 'prepare-risk-history';
const versionedPreparationTypes = [preparationType, rangeType, rangeHistoryType, detailType, riskHistoryType];

function scheduledProductionVersion(jobType, spec) {
  if (jobType !== 'production-precompute') return null;
  return /^production-precompute:([^:]+):/.exec(spec.jobKey || '')?.[1] ?? null;
}

function obsoletePreparation(jobType, spec) {
  const version = versionedPreparationTypes.includes(jobType) ? spec.calculationVersion : scheduledProductionVersion(jobType, spec);
  return version != null && version !== CALCULATION_VERSION;
}
export function rangeContext(engine, config) {
  return engine.context({ ...preparationInput(config), universe: 'us-all', universeVersion: 1, model: 'composite', modelVersion: 1,
    benchmark: 'SPY', breadthKeys: [], windows: [], averages: [], volumeWindows: [], includeAllTimeHigh: false });
}

function rangeSpec(engine, input, windows) {
  const config = rangeContext(engine, input);
  const context = preparationInput(config);
  const reference = config.referenceMode === 'latest' && config.date === config.latestDate ? config.observedReferenceDate : null;
  const prefix = createHash('sha256').update(JSON.stringify([CALCULATION_VERSION, config.date, config.dataVersion,
    config.basis, reference])).digest('hex').slice(0, 24);
  return { type: rangeType, context, windows, prefix, jobKey: `${rangeType}:${prefix}:${windows.join(',')}` };
}

function rangeHistoryPrefix(config) {
  return createHash('sha256').update(JSON.stringify([CALCULATION_VERSION, config.latestDate, config.dataVersion,
    config.basis, rangeHistoryType])).digest('hex').slice(0, 24);
}

function rangePendingStatus(db, engine, point, rangeMetrics) {
  const { prefix } = rangeSpec(engine, point, rangeMetrics.windows);
  const historyPrefix = rangeHistoryPrefix(point);
  const attempts = db.prepare(`SELECT id,status,progress,error,payload FROM jobs WHERE
    (type=? AND json_extract(payload,'$.prefix')=?) OR (type=? AND json_extract(payload,'$.prefix')=?)
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,rowid DESC`).all(rangeType, prefix, rangeHistoryType, historyPrefix);
  const relevant = attempts.find((row) => JSON.parse(row.payload).windows.some((window) => rangeMetrics.missingWindows.includes(window)));
  const waiting = relevant && ['queued','running'].includes(relevant.status);
  return { preparationState: relevant?.status === 'complete' ? 'unregistered' : relevant?.status ?? 'unregistered',
    prepareAction: 'range', missingWindows: rangeMetrics.missingWindows, error: relevant?.error ?? null,
    ...(waiting ? pendingJob(relevant) : {}) };
}

function detailSpec(engine, config, { securityIds, benchmarks, riskWindows, followLatest = false } = {}) {
  const point = rangeContext(engine, config);
  const context = preparationInput(point);
  const symbols = [...new Set(benchmarks || ['SPY', 'VTI', config.benchmark])].sort();
  const windows = riskWindows?.length ? [...new Set(riskWindows)].sort((a, b) => a - b) : undefined;
  const ids = securityIds?.length ? [...new Set(securityIds)].sort() : undefined;
  const key = createHash('sha256').update(JSON.stringify([CALCULATION_VERSION, point.date, point.dataVersion, point.basis, symbols, windows, ids])).digest('hex');
  return { type: detailType, context, ...(ids && { securityIds: ids }), benchmarks: symbols,
    ...(windows && { riskWindows: windows }), followLatest, calculationVersion: CALCULATION_VERSION, jobKey: `${detailType}:${key}` };
}

function riskHistorySpec(db, engine, config, { benchmarks, windows, followLatest = true } = {}) {
  if (config.basis !== 'reconstructed' || !config.date || !config.earliestDate) return null;
  const point = rangeContext(engine, config);
  const periods = normalizeRiskWindows(windows);
  const tickers = normalizeRiskBenchmarks(benchmarks, config.benchmark);
  const history = expectedSessions(point.earliestDate, point.date);
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_risk_history_runs'").get();
  const archives = exists ? db.prepare(`SELECT first_date,last_date,data_version FROM prepared_risk_history_runs
    WHERE complete=1 AND calculation_version=? AND basis=? AND windows=? AND benchmarks=? AND data_version<=?`)
    .all(CALCULATION_VERSION, point.basis, JSON.stringify(periods), JSON.stringify(tickers), point.dataVersion) : [];
  const bounds = reusableArchiveVersions(db, { ...point, referenceMode: 'as-of' }, archives.map(({ data_version }) => data_version));
  const earliest = history.find((date) => !archives.some((row) => row.first_date <= date && row.last_date >= date && usableArchiveRow(bounds, { ...row, date })));
  if (!earliest) return null;
  const key = createHash('sha256').update(JSON.stringify([CALCULATION_VERSION, earliest, point.date, point.dataVersion, periods, tickers])).digest('hex');
  return { type: riskHistoryType, context: preparationInput(point), from: earliest, benchmarks: tickers, riskWindows: periods,
    followLatest, calculationVersion: CALCULATION_VERSION, jobKey: `${riskHistoryType}:${key}` };
}

function detailJobs(db, config, securityId, { exact = false, benchmark, lookback } = {}) {
  const riskScope = benchmark ? `AND ? IN (SELECT value FROM json_each(json_extract(payload,'$.benchmarks')))
    AND ? IN (SELECT value FROM json_each(coalesce(json_extract(payload,'$.riskWindows'),?)))` : '';
  const active = db.prepare(`SELECT id,status,progress,error FROM jobs WHERE type=?
    AND json_extract(payload,'$.context.basis')=? AND json_extract(payload,'$.context.dataVersion')=?
    AND json_extract(payload,'$.context.date')${exact ? '=' : '>='}?
    AND (json_type(payload,'$.securityIds') IS NULL OR ? IN (SELECT value FROM json_each(json_extract(payload,'$.securityIds'))))
    ${riskScope}
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,rowid DESC LIMIT 1`)
    .get(detailType, config.basis, config.dataVersion, config.date, securityId,
      ...(benchmark ? [benchmark, lookback, JSON.stringify(detailRiskWindows)] : []));
  return active && ['queued', 'running'].includes(active.status) ? { preparationState: active.status, ...pendingJob(active) }
    : { preparationState: active?.status === 'failed' ? 'failed' : 'unregistered', ...(active?.error && { error: active.error }) };
}

function riskHistoryPending(db, config, lookback) {
  const job = db.prepare(`SELECT id,status,progress,error FROM jobs WHERE type=? AND status IN ('queued','running','failed')
    AND json_extract(payload,'$.context.basis')=? AND json_extract(payload,'$.context.dataVersion')=?
    AND json_extract(payload,'$.from')<=? AND json_extract(payload,'$.context.date')>=?
    AND ? IN (SELECT value FROM json_each(json_extract(payload,'$.benchmarks')))
    AND ? IN (SELECT value FROM json_each(json_extract(payload,'$.riskWindows')))
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,rowid DESC LIMIT 1`)
    .get(riskHistoryType, config.basis, config.dataVersion, config.date, config.date, config.benchmark, lookback);
  return job && { preparationState: job.status, ...(['queued', 'running'].includes(job.status) ? pendingJob(job) : { error: job.error }) };
}

export function preparationWorkspaceScopes(db, engine, { date, version = dataVersion(db) } = {}) {
  const base = { ...workspaceDefaults(db), date, dataVersion: version };
  const basePoint = engine.context(base);
  const savedScreens = listWorkspace(db, 'screen').map(({ definition }) => ({ definition,
    context: { ...savedScreenContext(definition), ...screenDataNeeds(definition), rangeWindows: rangeWindowsForScreen(definition) } }));
  const alerts = listWorkspace(db, 'alert-rule').flatMap(({ definition }) => {
    if (definition.active === false || !['stocks', 'screen'].includes(definition.type)) return [];
    const screen = definition.type === 'screen' ? getWorkspace(db, 'screen', definition.screenId)?.definition : definition;
    if (!screen) return [];
    const rangeWindows = rangeWindowsForScreen(screen);
    const context = { ...definition.context, ...savedScreenContext(screen), ...screenDataNeeds(screen), rangeWindows };
    return [{ screen, context }];
  });
  const custom = [...registeredPreparations(db), ...savedScreens.map(({ context }) => context),
    ...alerts.map(({ context }) => context)];
  const historicalScreenRanges = savedScreens.flatMap(({ definition, context }) => {
    if (context.basis !== 'known' || !context.rangeWindows.length) return [];
    let point;
    try { point = engine.context({ ...base, ...context }); } catch { return []; }
    return knownRangeDependencies(definition, point).map((dependency) => ({ ...context, ...dependency }));
  });
  const alertRangeContexts = alerts.flatMap(({ screen, context }) => {
    const { rangeWindows } = context;
    if (!rangeWindows.length) return [];
    const point = engine.context({ ...base, ...context, date, dataVersion: version });
    if (!point.date) return [];
    const prior = previousSession(point.date, 1);
    const dates = [point, ...(prior ? [{ ...point, date: prior }] : [])];
    return dates.flatMap((entry) => [{ ...context, date: entry.date, rangeWindows },
      ...knownRangeDependencies(screen, entry).map((dependency) => ({ ...context, ...dependency }))]);
  });
  return { base, basePoint, custom, rangeInputs: [{ rangeWindows: [20, 252] }, ...custom, ...historicalScreenRanges, ...alertRangeContexts] };
}

function schedulePreparation(db, engine, { date, version = dataVersion(db), requested, retry } = {}) {
  if (bootstrapProgress(db, { activeOnly: true })) return { jobs: [], queued: 0, waitingForCapture: true };
  const { base, basePoint, custom, rangeInputs } = preparationWorkspaceScopes(db, engine, { date, version });
  const requestedRanges = requested?.rangeWindows?.length > 0;
  const rangeScopes = new Map();
  const rangeHistoryScopes = new Map();
  for (const input of requested ? [requested] : rangeInputs) {
    if (!input.rangeWindows?.length) continue;
    let point;
    try { point = engine.context({ ...base, ...input }); } catch { continue; }
    if (!point.date) continue;
    const spec = rangeSpec(engine, point, input.rangeWindows);
    const existing = rangeScopes.get(spec.prefix);
    const missing = readPreparedRangeMetrics(db, rangeContext(engine, point), input.rangeWindows).missingWindows;
    if (missing.length) rangeScopes.set(spec.prefix, { ...spec, windows: [...new Set([...(existing?.windows || []), ...missing])].sort((a,b) => a-b) });
    if (point.basis === 'reconstructed' && point.date === point.latestDate) {
      const prefix = rangeHistoryPrefix(point);
      const history = rangeHistoryScopes.get(prefix);
      rangeHistoryScopes.set(prefix, { ...spec, prefix, type: rangeHistoryType,
        windows: [...new Set([...(history?.windows || []), ...input.rangeWindows])].sort((a,b) => a-b) });
    }
  }
  const ranges = [...rangeScopes.values(), ...rangeHistoryScopes.values()].flatMap((spec) => {
    const batches = [];
    for (let index = 0; index < spec.windows.length; index += 16) {
      const windows = spec.windows.slice(index, index + 16);
      batches.push({ ...spec, windows, followLatest: !requested && spec.context.dataVersion === version,
        ...(!requested && spec.type === rangeType && spec.context.date === basePoint.date && { persistDetails: true }),
        calculationVersion: CALCULATION_VERSION, jobKey: `${spec.type}:${spec.prefix}:${windows.join(',')}` });
    }
    return batches;
  });
  const detail = [];
  if (!requested) {
    if (basePoint.date) {
      detail.push(detailSpec(engine, basePoint, { followLatest: true }));
      const risk = riskHistorySpec(db, engine, basePoint);
      if (risk) {
        const historical = ranges.find((job) => job.type === rangeHistoryType && job.context.date === risk.context.date &&
          job.context.dataVersion === risk.context.dataVersion && job.context.basis === risk.context.basis);
        if (historical) historical.sharedRisk = { from: risk.from, windows: risk.riskWindows, benchmarks: risk.benchmarks };
        detail.push(risk);
      }
      for (const { definition } of listWorkspace(db, 'stock-detail-preparation')) {
        const { securityId, benchmark, basis, lookback } = definition;
        const registered = engine.context({ ...base, basis, benchmark });
        detail.push(detailSpec(engine, registered, { followLatest: true, securityIds: [securityId],
          benchmarks: [benchmark], riskWindows: [lookback] }));
      }
    }
  }
  const specs = requestedRanges ? [] : preparationSpecs(db, engine, base, { custom, requested });
  const calculations = process.env.MARKET_BATCH_PREPARATION === '0' ? specs : batchPreparationSpecs(engine, specs);
  return enqueuePreparation(db, [...ranges, ...detail, ...calculations],
    { retry, supersedeBefore: requested ? undefined : version });
}

function replaceObsoletePreparation(db, engine) {
  const jobs = db.prepare(`SELECT id,type,payload FROM jobs WHERE status='queued'
    AND type IN (SELECT value FROM json_each(?)) ORDER BY rowid`).all(JSON.stringify([...versionedPreparationTypes, 'production-precompute']));
  const obsolete = jobs.map(({ payload, ...job }) => ({ ...job, spec: JSON.parse(payload) }))
    .filter(({ type, spec }) => obsoletePreparation(type, spec));
  if (!obsolete.length) return;
  if (obsolete.some(({ spec }) => spec.followLatest)) schedulePreparation(db, engine);
  const replacement = [];
  for (const { type, spec } of obsolete) {
    if (spec.followLatest || type === 'production-precompute') continue;
    let point;
    try { point = engine.context(spec.context); } catch { continue; }
    if (type === preparationType) {
      const inputs = spec.members?.map(({ context }) => context) ?? [spec.context];
      const specs = inputs.flatMap((context) => preparationSpecs(db, engine, context,
        { requested: context, historySessions: spec.historySessions }).filter(({ phase }) => phase === spec.phase));
      replacement.push(...(process.env.MARKET_BATCH_PREPARATION === '0' ? specs : batchPreparationSpecs(engine, specs)));
    } else if (type === detailType) {
      replacement.push(detailSpec(engine, point, { followLatest: false, securityIds: spec.securityIds,
        benchmarks: spec.benchmarks, riskWindows: spec.riskWindows }));
    } else if (type === riskHistoryType) {
      const risk = riskHistorySpec(db, engine, point, { followLatest: false, benchmarks: spec.benchmarks, windows: spec.riskWindows });
      if (risk) replacement.push(risk);
    } else {
      const scope = rangeSpec(engine, point, spec.windows);
      const prefix = type === rangeHistoryType ? rangeHistoryPrefix(point) : scope.prefix;
      replacement.push({ ...scope, type, prefix, windows: spec.windows, persistDetails: spec.persistDetails,
        followLatest: false, calculationVersion: CALCULATION_VERSION, jobKey: `${type}:${prefix}:${spec.windows.join(',')}` });
    }
  }
  enqueuePreparation(db, replacement);
  const supersede = db.prepare("UPDATE jobs SET status='superseded',updated_at=?,error=? WHERE id=? AND status='queued'");
  for (const { id } of obsolete) supersede.run(new Date().toISOString(), 'A newer calculation version replaced this preparation', id);
}

const preparationPhaseLabels = { current: 'Current stock metrics', recent: 'Recent breadth and ranks', history: 'Full history' };

function preparationSummary(db, version) {
  const generation = `AND (json_extract(payload,'$.calculationVersion')=?
    OR (json_extract(payload,'$.calculationVersion') IS NULL AND status NOT IN ('failed','superseded','cancelled','interrupted')))`;
  const records = db.prepare(`SELECT id,status,progress,error,payload,result FROM jobs WHERE type=?
    AND json_extract(payload,'$.context.dataVersion')=? ${generation} ORDER BY rowid DESC`).all(preparationType, version, CALCULATION_VERSION);
  const entries = new Map();
  for (const row of records) {
    const spec = JSON.parse(row.payload);
    const { phase, members = [spec] } = spec;
    const detail = row.result ? JSON.parse(row.result) : {};
    for (const { jobKey, context, label } of members) {
      if (entries.has(jobKey)) continue;
      entries.set(jobKey, { id: row.id, universe: context.universe, universeVersion: context.universeVersion,
        model: context.model, modelVersion: context.modelVersion, basis: context.basis, benchmark: context.benchmark, classification: context.classification,
        reference: context.reference, date: context.date, phase, phaseLabel: preparationPhaseLabels[phase], label,
        status: row.status, progress: row.progress, completedSessions: detail.completedSessions ?? 0, totalSessions: detail.totalSessions ?? null,
        error: row.error, estimatedRemainingSeconds: detail.estimatedRemainingSeconds ?? null });
    }
  }
  const targets = [...entries.values()];
  const phaseTotals = () => ({ total: 0, complete: 0, running: 0, queued: 0, failed: 0, superseded: 0 });
  const phases = { current: phaseTotals(), recent: phaseTotals(), history: phaseTotals() };
  const result = { dataVersion: version, total: targets.length, complete: 0, running: 0, queued: 0, failed: 0, superseded: 0, universes: [], phases };
  const groups = new Map();
  const contexts = new Map();
  for (const target of targets) {
    result[target.status]++;
    if (phases[target.phase]) {
      phases[target.phase].total++;
      phases[target.phase][target.status]++;
    }
    const group = groups.get(target.universe) || { universe: target.universe, complete: 0, total: 0, stages: {} };
    group.total++;
    group.complete += Number(target.status === 'complete');
    const stage = group.stages[target.phase] ||= { complete: 0, total: 0 };
    stage.total++;
    stage.complete += Number(target.status === 'complete');
    groups.set(target.universe, group);
    if (target.label !== 'Registered calculation') {
      const key = JSON.stringify([target.universe, target.universeVersion, target.model, target.modelVersion,
        target.basis, target.benchmark, target.classification, target.reference, target.date]);
      const point = contexts.get(key) || { universe: target.universe, universeVersion: target.universeVersion,
        model: target.model, modelVersion: target.modelVersion, basis: target.basis, benchmark: target.benchmark, classification: target.classification,
        reference: target.reference, date: target.date, stages: {} };
      point.stages[target.phase] = target.status;
      contexts.set(key, point);
    }
  }
  result.universes = [...groups.values()];
  const rangeRows = db.prepare(`SELECT type,status,count(*) AS total FROM jobs WHERE type IN (?,?)
    AND json_extract(payload,'$.context.dataVersion')=? ${generation} GROUP BY type,status`).all(rangeType, rangeHistoryType, version, CALCULATION_VERSION);
  const detailRows = db.prepare(`SELECT status,count(*) AS total FROM jobs WHERE type=?
    AND json_extract(payload,'$.context.dataVersion')=? ${generation} GROUP BY status`).all(detailType, version, CALCULATION_VERSION);
  const detailCurrent = db.prepare(`SELECT id,status,progress,updated_at AS updatedAt,result FROM jobs WHERE type=?
    AND json_extract(payload,'$.context.dataVersion')=? ${generation} AND status='running' ORDER BY rowid DESC LIMIT 1`)
    .get(detailType, version, CALCULATION_VERSION);
  const riskRows = db.prepare(`SELECT status,count(*) AS total FROM jobs WHERE type=?
    AND json_extract(payload,'$.context.dataVersion')=? ${generation} GROUP BY status`).all(riskHistoryType, version, CALCULATION_VERSION);
  return { ...result, contexts: [...contexts.values()], current: targets.find(({ status }) => status === 'running') ?? null,
    failures: targets.filter(({ status }) => status === 'failed').slice(0, 8),
    stockDetails: { ...Object.fromEntries(detailRows.map(({ status, total }) => [status, total])),
      history: Object.fromEntries(riskRows.map(({ status, total }) => [status, total])),
      current: detailCurrent ? { ...detailCurrent, result: detailCurrent.result ? JSON.parse(detailCurrent.result) : null } : null },
    ranges: { current: Object.fromEntries(rangeRows.filter(({ type }) => type === rangeType).map(({ status, total }) => [status, total])),
      history: Object.fromEntries(rangeRows.filter(({ type }) => type === rangeHistoryType).map(({ status, total }) => [status, total])) } };
}

function localStatus(db) {
  const status = warehouseStatus(db);
  const now = new Date();
  const after = marketSyncAfter(process.env.MARKET_SYNC_AFTER);
  const session = latestFinalizableSession(now, after);
  const backup = db.prepare(`SELECT id,updated_at,result FROM jobs WHERE type='backup' AND status='complete'
    AND json_extract(result,'$.quickCheck')='ok' ORDER BY updated_at DESC LIMIT 1`).get();
  const verified = backup && JSON.parse(backup.result);
  const analysis = latestAnalysis(db, status.dataVersion);
  const preparation = preparationSummary(db, status.dataVersion);
  const current = preparation.phases.current;
  const currentReadiness = analysis?.date === status.latestDate && analysis?.dataVersion === status.dataVersion ? 'ready'
    : current.running || current.queued ? 'pending' : analysis ? 'prior-revision' : 'unavailable';
  return { ...status, bootstrap: bootstrapProgress(db), latestAnalysis: analysis,
    analysisReadiness: readAnalysisReadiness(db, { date: status.latestDate, dataVersion: status.dataVersion, calculationVersion: CALCULATION_VERSION }),
    currentReadiness: { state: currentReadiness, date: analysis?.date ?? null, dataVersion: analysis?.dataVersion ?? null },
    lastVerifiedBackup: backup ? { jobId: backup.id, completedAt: verified.completedAt ?? backup.updated_at,
      dataVersion: verified.dataVersion, latestDate: verified.latestDate, bytes: verified.bytes, sha256: verified.sha256 } : null,
    preparation, captureSchedule: { enabled: process.env.MARKET_SYNC === '1' && !!process.env.EODHD_API_KEY,
      ...dailyCaptureAvailability(db, session, now, after) } };
}

function securitySearch(db, config, search, limit) {
  if (!config.date || !search) return [];
  const upper = search.toUpperCase();
  const literal = upper.replace(/[!%_]/g, '!$&');
  const prefix = literal + '%';
  const match = '%' + literal + '%';
  return db.prepare(`WITH refs AS (
    SELECT s.id, r.definition FROM securities s JOIN reference_revisions r ON r.security_id=s.id AND r.version=(
      SELECT version FROM reference_revisions WHERE security_id=s.id AND version<=? AND (?=0 OR known_at<=?)
      ORDER BY version DESC LIMIT 1)
  ), aliases AS (
    SELECT refs.id AS securityId,json_extract(definition,'$.name') AS name,json_extract(definition,'$.type') AS type,
      json_extract(a.value,'$.symbol') AS symbol,json_extract(a.value,'$.exchange') AS exchange,
      (SELECT json_extract(old.value,'$.symbol') FROM json_each(json_extract(definition,'$.identifiers')) old
        WHERE json_extract(old.value,'$.valid_from')<=? AND json_extract(old.value,'$.symbol')<>json_extract(a.value,'$.symbol')
          AND upper(json_extract(old.value,'$.symbol')) LIKE ? ESCAPE '!'
        ORDER BY (upper(json_extract(old.value,'$.symbol'))=?) DESC,json_extract(old.value,'$.valid_from') DESC LIMIT 1) AS matchedAlias,
      row_number() OVER (PARTITION BY refs.id ORDER BY json_extract(a.value,'$.valid_from') DESC,json_extract(a.value,'$.symbol')) AS position
    FROM refs,json_each(json_extract(definition,'$.identifiers')) a
    WHERE json_extract(a.value,'$.valid_from')<=? AND (json_extract(a.value,'$.valid_to') IS NULL OR json_extract(a.value,'$.valid_to')>=?)
      AND (json_extract(definition,'$.listing_date') IS NULL OR json_extract(definition,'$.listing_date')<=?)
      AND (json_extract(definition,'$.delisting_date') IS NULL OR json_extract(definition,'$.delisting_date')>=?)
  )
  SELECT securityId,symbol,name,exchange,type,matchedAlias FROM aliases
  WHERE position=1 AND (upper(symbol) LIKE ? ESCAPE '!' OR upper(name) LIKE ? ESCAPE '!' OR matchedAlias IS NOT NULL)
  ORDER BY CASE WHEN upper(symbol)=? THEN 0 WHEN upper(matchedAlias)=? THEN 1
    WHEN upper(symbol) LIKE ? ESCAPE '!' THEN 2 ELSE 3 END,symbol,securityId LIMIT ?`)
    .all(config.dataVersion, Number(config.basis === 'known'), config.date, config.date, match, upper,
      config.date, config.date, config.date, config.date, match, match, upper, upper, prefix, limit);
}

function stockIdentity(db, config, raw) {
  const read = db.prepare(`SELECT definition FROM reference_revisions WHERE security_id=? AND version<=?
    AND (?=0 OR known_at<=?) ORDER BY version DESC LIMIT 1`);
  const lookup = (id) => read.get(id, config.dataVersion, Number(config.basis === 'known'), config.date);
  let reference = lookup(raw);
  if (!reference) {
    const symbol = normalizeSymbol(raw);
    const matches = securitySearch(db, config, symbol, 25).filter((row) => row.symbol === symbol);
    if (matches.length !== 1) return null;
    reference = lookup(matches[0].securityId);
  }
  return reference ? JSON.parse(reference.definition) : null;
}

function requireStockIdentity(db, config, id) {
  const identity = stockIdentity(db, config, id);
  if (!identity && config.basis === 'known') {
    throw asError('No matching security identifier was known for the selected trading session and revision.', 404);
  }
  return exists(identity, 'Security');
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

function quality(db, engine, config, snapshot = engine.snapshot(config)) {
  const status = localStatus(db);
  const last = latestFinalizableSession(new Date(), marketSyncAfter(process.env.MARKET_SYNC_AFTER));
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

function preparedStockDetail(db, config, security, snapshot, archive) {
  const stock = snapshot?.stocks.find((row) => row.securityId === security.id);
  const stored = archive.detail || {};
  const current = stored.chartBars?.find((bar) => bar.date === config.date);
  const quality = stored.quality || qualityOverrides(db, { version: config.dataVersion, knownThrough: config.basis === 'known' ? config.date : undefined })
    .filter((item) => item.security_id === security.id && item.effective_from <= config.date);
  const identity = security.identifiers?.filter((alias) => alias.valid_from <= config.date && (!alias.valid_to || alias.valid_to >= config.date))
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from) || a.symbol.localeCompare(b.symbol))[0];
  const fallback = { symbol: identity?.symbol || security.identifiers?.at(-1)?.symbol || security.id, name: security.name,
    exchange: identity?.exchange || security.exchange, type: security.type, isin: security.isin, listingDate: security.listing_date,
    delistingDate: security.delisting_date, close: current?.close ?? null, traded: current?.traded ?? null };
  return { ...fallback, ...stored, ...stock,
    securityId: security.id, date: config.date, referenceDate: snapshot?.referenceDate || config.date, referenceMode: snapshot?.referenceMode || 'as-of',
    classificationSystem: snapshot?.classificationSystem || config.classification, dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION,
    ...(snapshot?.sourceDataVersion != null ? { sourceDataVersion: snapshot.sourceDataVersion } : {}),
    aliases: security.identifiers, quality, bars: stored.bars || [], chartBars: stored.chartBars || [],
    warnings: [...(stored.warnings || []), snapshot && !stock && 'Security falls outside the prepared universe on this session.',
      !Object.hasOwn(stored, 'loadedHistoryHigh') && (!stock || !Object.hasOwn(stock, 'loadedHistoryHigh'))
        ? 'Lifetime highs are unavailable for this prepared stock view.' : null,
      ...quality.map(({ reason }) => reason)].filter(Boolean) };
}

function updateAlerts(db, engine, params = {}, { rangeOnly = false } = {}) {
  let fired = 0;
  let evaluated = 0;
  const deferred = [];
  const at = new Date().toISOString();
  const persist = db.prepare('INSERT OR IGNORE INTO alert_events VALUES (?, ?, ?, ?)');
  const rules = listWorkspace(db, 'alert-rule');
  for (const rule of rules) {
    const def = rule.definition;
    if (def.active === false) continue;
    const saved = def.type === 'screen' ? getWorkspace(db, 'screen', def.screenId) : null;
    if (def.type === 'screen' && !saved) continue;
    const screen = saved?.definition ?? { filter: def.filter, context: def.context };
    const stockRule = def.type === 'screen' || def.type === 'stocks';
    const windows = stockRule ? rangeWindowsForScreen(screen) : [];
    if (rangeOnly && !windows.length) continue;
    const config = engine.context({ ...params, ...def.context, ...saved?.definition.context,
      ...(params.date ? { date: params.date } : {}), ...(params.dataVersion != null ? { dataVersion: params.dataVersion } : {}),
      ...(def.type === 'breadth' ? { breadthKeys: [def.metric] } : screenDataNeeds(saved?.definition ?? def)) });
    if (!config.date) continue;
    const lag = def.type === 'breadth' && def.trigger === 'surge' ? def.lookback : 1;
    const dates = expectedSessions(shiftDate(config.date, -2 * lag - 16), config.date);
    const previousDate = dates.at(-1 - lag);
    if (!previousDate) continue;
    const beforeConfig = { ...config, date: previousDate, requestedDate: previousDate };
    const ranges = windows.length ? [config, beforeConfig].map((point) => readPreparedRangeMetrics(db, rangeContext(engine, point), windows)) : [];
    if (ranges.some((entry) => !entry.ready)) {
      deferred.push({ ruleId: rule.id, reason: 'Rolling range metrics are not prepared', windows });
      continue;
    }
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
      const expression = def.type === 'stocks' ? screen.filter?.expression : null;
      const options = expression ? { all: true, computed: [{ field: 'custom_alert_condition', expression }] } : { ...screen, all: true };
      const currentRowsWithRange = ranges.length ? applyPreparedRangeMetrics(current, ranges[0]) : current;
      const beforeRowsWithRange = ranges.length ? applyPreparedRangeMetrics(before, ranges[1]) : before;
      let latest, previous;
      try {
        latest = historicalScreen(db, engine, config, options, currentRowsWithRange).rows;
        previous = historicalScreen(db, engine, beforeConfig, options, beforeRowsWithRange).rows;
      } catch (error) {
        if (!error.preparation) throw error;
        deferred.push({ ruleId: rule.id, reason: error.message, ...error.preparation.materialization });
        continue;
      }
      const comparable = (snapshot) => new Set(snapshot.stocks.filter((row) => row.traded && alertComparable(def.filter, row)).map((row) => row.securityId));
      const states = (selected, snapshot) => {
        if (expression) return new Map(selected.map((row) => [row.securityId, row.custom_alert_condition]));
        const comparableIds = def.type === 'stocks' ? comparable(snapshot) : new Set();
        return new Map([...comparableIds].map((id) => [id, false]).concat(selected.map((row) => [row.securityId, true])));
      };
      const active = states(latest, currentRowsWithRange);
      const older = states(previous, beforeRowsWithRange);
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
    evaluated++;
  }
  return { evaluated, fired, deferred };
}

function alertComparable(filter, row) {
  if (!filter) return true;
  const children = filter.filters || filter.rules || filter.children;
  if (children) return children.every((child) => alertComparable(child, row));
  if (filter.expression) return false;
  return filter.op === 'missing' || filter.op === 'present' || row[filter.field] != null
    || /^udv_/.test(filter.field) && row[filter.field.replace(/^udv_/, 'udv_state_')] === 'infinity';
}

function healthRecipe(engine, config, model, coverage) {
  return createHash('sha256').update(JSON.stringify([
    engine.definitionKey(config), config.universe.id, config.universe.version, config.model.id, config.model.version, model, coverage,
  ])).digest('hex');
}

function healthArchiveRows(db, engine, table, config, model, coverage, dates) {
  if (!dates.length || !db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table)) return [];
  return referenceArchiveScopes(config, dates).flatMap((scope) => {
    const recipe = healthRecipe(engine, scope.config, model, coverage);
    const args = [recipe, CALCULATION_VERSION];
    const versions = db.prepare(`SELECT DISTINCT data_version FROM ${table} WHERE recipe=? AND calculation_version=? AND data_version<=?`)
      .all(...args, config.dataVersion).map(({ data_version }) => data_version);
    const bounds = reusableArchiveVersions(db, scope.config, versions);
    const previousVersions = new Map();
    const order = table === 'divergence_events' ? ',event' : '';
    return db.prepare(`SELECT * FROM ${table} WHERE recipe=? AND calculation_version=?
      AND data_version IN (SELECT value FROM json_each(?)) AND date IN (SELECT value FROM json_each(?))
      ORDER BY date,data_version DESC${order}`).all(...args, JSON.stringify([...bounds.keys()]), JSON.stringify(scope.dates))
      .filter((row) => {
        if (!usableArchiveRow(bounds, row)) return false;
        if (!previousVersions.has(row.date)) previousVersions.set(row.date, row.data_version);
        return previousVersions.get(row.date) === row.data_version;
      });
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function writeDivergences(db, engine, config, model, events, coverage) {
  const recipe = healthRecipe(engine, config, model, coverage);
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
}

function divergenceLedger(db, engine, config, model, from, coverage) {
  const dates = config.date ? expectedSessions(from || config.date, config.date) : [];
  const covered = new Map(healthArchiveRows(db, engine, 'prepared_health', config, model, coverage, dates)
    .map((row) => [row.date, row.data_version]));
  return healthArchiveRows(db, engine, 'divergence_events', config, model, coverage, dates)
    .filter((row) => covered.get(row.date) === row.data_version)
    .map(({ payload, observed_at, data_version }) => ({ ...JSON.parse(payload), observedAt: observed_at,
      dataVersion: data_version, requestedDataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION }));
}

function readPreparedHealth(db, engine, config, model, coverage, from, limit) {
  const dates = config.date && config.earliestDate ? expectedSessions(from || config.earliestDate, config.date).slice(-limit) : [];
  return healthArchiveRows(db, engine, 'prepared_health', config, model, coverage, dates)
    .map(({ payload, data_version }) => ({ ...decodeStoredJson(payload),
      dataVersion: data_version, requestedDataVersion: config.dataVersion }));
}

function prepareHealth(db, engine, config, { model, coverage, from, limit = 315, allowCompute = false }) {
  if (!config.earliestDate) return { prepared: 0, date: config.date };
  const warmup = healthBaseline(model);
  const seed = from ? shiftDate(from, -2 * warmup - 16) : null;
  const count = Math.min(7560, limit + warmup);
  const archived = readMaterializedHistory(db, engine, config, { from: seed, limit: count });
  const source = archived.rows.length || !allowCompute ? archived.rows
    : engine.history(config, { from: seed, limit: count, project });
  if (!source.length) return { prepared: 0, date: config.date, missingDates: archived.missingDates };
  const sessions = expectedSessions(seed && seed >= config.earliestDate ? seed : config.earliestDate, config.date).slice(-count);
  const present = new Set(source.map(({ date }) => date));
  const supported = new Set();
  let consecutive = 0;
  for (const [index, date] of sessions.entries()) {
    consecutive = present.has(date) ? consecutive + 1 : 0;
    if (consecutive >= Math.min(warmup + 1, index + 1)) supported.add(date);
  }
  const targetDates = sessions.filter((date) => (!from || date >= from) && supported.has(date)).slice(-limit);
  const reused = healthArchiveRows(db, engine, 'prepared_health', config, model, coverage, targetDates);
  const available = new Set(reused.map(({ date }) => date));
  const latestPrepared = targetDates.at(-1) ?? null;
  if (available.size === targetDates.length) {
    return { prepared: available.size, reused: available.size, date: config.date, dataVersion: config.dataVersion,
      latestPrepared, missingDates: archived.missingDates };
  }
  const targets = new Set(targetDates);
  const rows = marketHealthHistory(source, { model, sessions, ...coverage })
    .filter(({ date }) => targets.has(date) && !available.has(date));
  db.exec(`CREATE TABLE IF NOT EXISTS prepared_health (
    recipe TEXT NOT NULL, data_version INTEGER NOT NULL, calculation_version TEXT NOT NULL, date TEXT NOT NULL, payload BLOB NOT NULL,
    PRIMARY KEY (recipe,data_version,calculation_version,date)
  ) WITHOUT ROWID`);
  const write = db.prepare('INSERT OR REPLACE INTO prepared_health VALUES (?,?,?,?,?)');
  const byDate = new Map(rows.map((row) => [row.date, row]));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const scope of referenceArchiveScopes(config, rows.map(({ date }) => date))) {
      const key = [healthRecipe(engine, scope.config, model, coverage), config.dataVersion, CALCULATION_VERSION];
      const scoped = scope.dates.map((date) => byDate.get(date));
      for (const row of scoped) write.run(...key, row.date, encodeStoredJson(row));
      writeDivergences(db, engine, scope.config, model, scoped.flatMap((row) => row.divergences), coverage);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { prepared: rows.length + reused.length, reused: reused.length, date: config.date, dataVersion: config.dataVersion, latestPrepared,
    missingDates: archived.missingDates };
}

export function prepareStandardHealth(db, engine, config, slice = {}) {
  const runs = [];
  for (const model of [DEFAULT_HEALTH_MODEL, ...listWorkspace(db, 'health-model').map(({ id, name, version, definition }) => ({ ...definition, id, name, version }))]) {
    for (const coverage of [researchCoverage(), researchCoverage({ coverageMode: 'observed' })]) {
      runs.push({ model: model.id, coverageMode: coverage.coverageMode,
        ...prepareHealth(db, engine, config, { model, coverage, ...slice }) });
    }
  }
  return runs;
}

export function preparationHistoryWarmup(db) {
  return Math.max(extremeDefinition.lookback, healthBaseline(),
    ...listWorkspace(db, 'health-model').map(({ definition }) => healthBaseline(definition)));
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

function pairedBreadthContext(engine, config) {
  const keys = new Set(config.breadthKeys);
  for (const key of config.breadthKeys) {
    if (!/^(?:up|down)_\d+(?:\.\d+)?pct(?:_\d+d)?$/.test(key)) continue;
    const opposite = key.startsWith('up_') ? 'down_' + key.slice(3) : 'up_' + key.slice(5);
    if (breadthMetric(opposite)) keys.add(opposite);
  }
  if (keys.size === config.breadthKeys.length) return null;
  return engine.context({ ...materializationContext(config), breadthKeys: [...keys] });
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

function rankSeries(db, engine, config, options, enqueue, { supplyDemand = false, preparedOnly = false } = {}) {
  const archive = readRankArchive(db, engine, config, options);
  if (archive.observed.size < archive.dates.length) {
    const compact = readPreparedRanks(db, config, archive.dates.filter((date) => !archive.observed.has(date)), options);
    for (const date of compact.observed) archive.observed.add(date);
    archive.rows.push(...compact.rows);
  }
  const stored = new Map(archive.rows.map((row) => [row.date, row]));
  const require = requiresArchive(db);
  const visible = options.materializedOnly === '1' || require || preparedOnly
    ? archive.dates.filter((date) => archive.observed.has(date)) : archive.dates.slice(-260);
  let materialization;
  if ((require || preparedOnly) && archive.observed.size < archive.dates.length && options.materializedOnly !== '1') {
    if (bootstrapProgress(db, { activeOnly: true })) materialization = blockedCapture();
    else if (preparedOnly) materialization = preparationStatus(db, engine, config, ['recent', 'history']);
    else {
      const context = materializationContext(config);
      const { from, to, limit, cadence } = options;
      const key = createHash('sha256').update(JSON.stringify(['ranks', context, from, to, limit, cadence])).digest('hex');
      materialization = pendingJob(enqueue('rank-materialize', { context, from, to, limit, cadence }, key));
    }
  }
  let daily;
  const demandDates = supplyDemand && preparedOnly && options.securityId
    ? preparedSnapshotDates(db, engine, config, visible) : null;
  const demandPrepared = [];
  if (supplyDemand && !preparedOnly && visible.length && config.basis === 'reconstructed' && options.securityId) {
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
    if (demandDates) {
      if (Object.hasOwn(row, 'udv_50d')) {
        demandPrepared.push(date);
        return { ...row, supplyDemandPrepared: true };
      }
      const point = { ...config, date, requestedDate: date };
      const compact = demandDates.has(date) ? readPreparedSnapshot(db, engine, point, { securityIds: [options.securityId] }) : null;
      const snapshot = compact || (date === config.date && engine.snapshotAvailable(point)
        ? engine.snapshot(point, { persist: false, cache: true }) : null);
      const stock = snapshot?.stocks.find(({ securityId }) => securityId === options.securityId);
      if (snapshot) demandPrepared.push(date);
      return { ...row, udv_50d: stock?.udv_50d ?? null, udv_state_50d: stock?.udv_state_50d ?? null,
        supplyDemandPrepared: !!snapshot };
    }
    return daily ? { ...row, udv_50d: volumeRatio(daily.bars, daily.dates.get(date), 50).value } : row;
  });
  const supplyDemandStatus = demandDates && { state: demandPrepared.length === archive.dates.length ? 'ready' : 'partial',
    preparedSessions: demandPrepared.length, requestedSessions: archive.dates.length,
    missingSessions: archive.dates.length - demandPrepared.length,
    ...(demandPrepared.length !== archive.dates.length && { reason: 'Some sessions do not yet have prepared stock volume readings for this context.' }) };
  return { date: config.date, materialization, rows, archived: archive.observed.size, requested: archive.dates.length,
    ...(demandDates && { supplyDemand: supplyDemandStatus }) };
}

function thinHistory(db, engine, config, options = {}, enqueue = null, preparedOnly = false) {
  let stored = readMaterializedHistory(db, engine, config, options);
  const paired = !stored.complete && pairedBreadthContext(engine, config);
  if (paired) {
    const superset = readMaterializedHistory(db, engine, paired, options);
    if (superset.rows.length > stored.rows.length) stored = superset;
  }
  const { rows, ...status } = stored;
  const materialization = { ...status, visibleRequested: options.visibleRequested ?? status.requested };
  if (stored.complete || options.materializedOnly) return { rows, materialization };
  if (bootstrapProgress(db, { activeOnly: true })) {
    return { rows, materialization: { ...materialization, ...blockedCapture() } };
  }
  if (preparedOnly) {
    const phases = stored.requested > recentPreparationSessions ? ['history'] : ['recent', 'history'];
    const exact = preparationStatus(db, engine, config, phases);
    const status = exact.preparationState === 'unregistered' && paired ? preparationStatus(db, engine, paired, phases) : exact;
    return { rows, materialization: { ...materialization, ...status } };
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

function marketHealth(db, engine, config, { model, history, snapshot = engine.snapshot(config), preparedOnly = false, ...coverage } = {}) {
  const eligible = snapshot.coverage.state === 'complete' || coverage.coverageMode === 'observed';
  let prior = history ?? (eligible
    ? thinHistory(db, engine, config, { limit: healthBaseline(model) + 1, materializedOnly: true }).rows : []);
  const archivedCurrent = prior.find((row) => row.date === snapshot.date);
  if (archivedCurrent) snapshot = { ...snapshot, aggregates: { ...snapshot.aggregates, ...archivedCurrent.aggregates } };
  if (eligible && config.date) {
    const priorWeek = weekEnd(shiftDate(config.date, -28));
    const exact = expectedSessions(shiftDate(priorWeek, -4), priorWeek).at(-1);
    if (exact && !prior.some((row) => row.date === exact) && (!preparedOnly || engine.snapshotAvailable({ ...config, date: exact }))) {
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
    let frozen = payload.frozen;
    if (!frozen) {
      const dateConfig = { ...config, date, requestedDate: date };
      const windows = rangeWindowsForScreen(payload.screen ?? {});
      const rangeMetrics = windows.length ? readPreparedRangeMetrics(db, rangeContext(engine, dateConfig), windows) : null;
      if (rangeMetrics && !rangeMetrics.ready) throw asError('Prepare the saved rolling high/low metrics for the cohort entry session');
      const selection = resolveScreen(db, engine, dateConfig, { ...(payload.screen || {}), all: true }, { rangeMetrics });
      const chosen = Array.isArray(payload.members) ? new Set(payload.members) : null;
      const members = (chosen ? selection.rows.filter((row) => chosen.has(row.securityId)) : selection.rows).map((row) => ({
        securityId: row.securityId, symbol: row.symbol, industry: row.industry, industryKnownAt: row.classificationKnownAt,
        delistingDate: row.delistingDate,
      }));
      frozen = { context: materializationContext(dateConfig), members, calculationVersion: CALCULATION_VERSION };
    }
    const { members } = frozen;
    const ids = members.map(({ securityId }) => securityId);
    const securityPrices = researchPrices(engine, config, ids, date, end);
    const result = analyzeCohort({ sessions, date, members, securityPrices, horizons: payload.horizons, asOf: end, maePrice: payload.maePrice });
    const saved = payload.name && !payload.frozen ? storeWorkspace(db, 'cohort', { name: payload.name, definition: {
      date, screen: payload.screen, horizons: payload.horizons, maePrice: payload.maePrice, frozen,
    } }) : null;
    return { ...result, frozenMemberCount: members.length, selectionContext: frozen.context, selectionCalculationVersion: frozen.calculationVersion,
      ...(saved && { cohortId: saved.id }), priceAvailabilityBasis: config.basis, dataVersion: config.dataVersion };
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

export async function performJob(db, type, payload, { provider = EodhdProvider(), progress = () => {}, journalClient, now = () => new Date() } = {}) {
  const engine = createEngine(db);
  if (type === chartBookIndustryJob) return prepareChartBookIndustries(db, engine, payload, progress);
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
    if (Number.isInteger(payload.captureAttempt)) {
      const clock = now();
      const after = marketSyncAfter(process.env.MARKET_SYNC_AFTER);
      const obsolete = payload.scheduledFor !== latestFinalizableSession(clock, after);
      const expired = payload.captureAttempt > 1 && !availabilityClock(payload.scheduledFor, clock, after).inWindow;
      if (obsolete || expired) return { imported: 0, dates: [], published: [], alreadyPublished: [], stillPending: [payload.scheduledFor],
        downloadSkipped: true, sourceAvailability: obsolete ? 'superseded' : 'exhausted',
        warnings: [obsolete ? 'A newer finalized session became available before this automatic request started.'
          : 'The source availability retry window ended before this automatic request started.'] };
      if (bulkSessionStatus(db, payload.scheduledFor, { verifiedOnly: true })) payload = { ...payload, localOnly: true };
    }
    const options = providerOptions(payload);
    const dates = providerDates(payload, options);
    if (options.bulk && !dates.length) throw new Error('No exchange sessions in the selected range');
    const captureStatus = (date) => payload.skipCaptured ? rawBulkReceipt(db, date)
      : bulkSessionStatus(db, date, { verifiedOnly: !!payload.verifiedOnly });
    const shouldFetch = !payload.localOnly && (!options.bulk || payload.force || dates.some((date) => !captureStatus(date)));
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
    const partialScheduled = Number.isInteger(payload.captureAttempt) && stillPending.length > 0 && !!rawBulkReceipt(db, dates.at(-1));
    if (payload.verifiedOnly && !hasPublication && stillPending.length && !partialScheduled) {
      throw new Error('Finalized price response was too incomplete to publish analytics');
    }
    if (sourceError) result.warnings.push(sourceError.message);
    if (stillPending.length) {
      result.warnings.push(`Verified analytics remain pending for ${stillPending.length} requested trading session${stillPending.length === 1 ? '' : 's'} with incomplete coverage.`);
    }
    return { ...result, published, alreadyPublished, stillPending, ...(partialScheduled ? { sourceAvailability: 'partial' } : {}),
      ...(!shouldFetch ? { downloadSkipped: true } : {}) };
  }
  if (type === 'health-precompute') {
    const config = engine.context(payload.context);
    const model = chooseHealthModel(db, payload.healthModel);
    const result = prepareHealth(db, engine, config, { model, coverage: researchCoverage(payload),
      limit: parseCount(payload.limit, 1, 7560, 315), from: dateString(payload.from, null), allowCompute: !payload.preparedOnly });
    if (!result.prepared || result.latestPrepared !== config.date) throw asError('Prepare the market history for this exact context before preparing health');
    return result;
  }
  if (type === 'workspace-precompute') return precomputeWorkspace(db, engine, engine.context(payload.context || {}), { ...payload, progress });
  if (type === preparationType) {
    if (payload.contexts) {
      const result = runBatchPreparation(db, engine, payload, progress);
      if (result.from && result.to) for (const member of payload.contexts) {
        if (!member.rank) continue;
        const point = engine.context(member.context);
        const sessions = expectedSessions(result.from, result.to).length;
        prepareStandardHealth(db, engine, { ...point, date: result.to, requestedDate: result.to }, { from: result.from, limit: sessions });
        if (!result.continuation && payload.phase === 'history' && point.universe.id === 'nyse' && point.model.id === 'composite'
          && point.basis === 'reconstructed' && point.referenceMode === 'as-of' && !point.breadthKeys.length
          && point.classification === summationContext(db, engine, point).classification) {
          result.summation = prepareNyseSummation(db, engine, point);
        }
      }
      return result;
    }
    const result = runPreparation(db, engine, payload, progress);
    const point = engine.context(payload.context);
    if (payload.phase === 'history' && !payload.baseComplete && (result.batch?.baseComplete || !result.continuation) && point.universe.id === 'nyse' && point.model.id === 'composite'
      && point.basis === 'reconstructed' && point.referenceMode === 'as-of' && !point.breadthKeys.length
      && point.classification === summationContext(db, engine, point).classification) {
      result.summation = prepareNyseSummation(db, engine, point);
    }
    if (payload.phase === 'history') result.baseComplete = !!(result.batch?.baseComplete || payload.baseComplete);
    if (result.batch?.standard && result.batch.sessions) {
      const { from, to, sessions } = result.batch;
      prepareStandardHealth(db, engine, { ...point, date: to, requestedDate: to }, { from, limit: sessions });
    }
    if (payload.phase === 'recent' && payload.recentOrder && !result.continuation) prepareStandardHealth(db, engine, point);
    return result;
  }
  if (type === rangeType) {
    requirePreparationSpace(db);
    const point = engine.context(payload.context);
    const detail = payload.persistDetails ? createPreparedDetailWriter(db, engine, point) : null;
    const rows = [];
    const onSecurity = detail ? (row) => {
      rows.push(row);
      if (rows.length === 64) detail.batch(rows.splice(0));
    } : undefined;
    const result = prepareRangeMetrics(db, engine, point, payload.windows, { progress, onSecurity });
    if (rows.length) detail.batch(rows);
    if (point.dataVersion === dataVersion(db)) {
      result.alerts = updateAlerts(db, engine, { date: point.latestDate, dataVersion: point.dataVersion }, { rangeOnly: true });
    }
    return result;
  }
  if (type === detailType) {
    requirePreparationSpace(db);
    const config = engine.context(payload.context);
    const result = prepareDetailsBatch(db, engine, config, { cursor: payload.cursor, securityIds: payload.securityIds,
      benchmarks: payload.benchmarks, riskWindows: payload.riskWindows, progress });
    return { ...result, completedSessions: result.processedSecurities, totalSessions: result.totalSecurities,
      ...(result.done ? {} : { continuation: { cursor: result.cursor } }) };
  }
  if (type === rangeHistoryType) {
    requirePreparationSpace(db, 60);
    const { prepareRangeHistoryBatch } = await import('./range-metrics.mjs');
    const config = engine.context(payload.context);
    let writer;
    if (payload.sharedRisk && config.basis === 'reconstructed') {
      const dates = expectedSessions(payload.sharedRisk.from, config.date);
      const { windows, benchmarks } = payload.sharedRisk;
      const risk = { dates, windows, benchmarks, batchSize: 32 };
      const prepared = prepareRiskHistoryBenchmarks(db, engine, config, risk);
      writer = createRiskHistoryWriter(db, config, { ...prepared, ...risk });
    }
    const result = prepareRangeHistoryBatch(db, engine, config, payload.windows, { cursor: payload.cursor, progress,
      ...(writer && { onSecurity: (row) => writer.writeSecurity(row) }) });
    if (writer) result.sharedRisk = writer.flush();
    return { ...result, completedSessions: result.processedSecurities, totalSessions: result.totalSecurities,
      ...(result.done ? {} : { continuation: { cursor: result.cursor } }) };
  }
  if (type === riskHistoryType) {
    requirePreparationSpace(db, 60);
    const config = engine.context(payload.context);
    const dates = expectedSessions(payload.from || config.earliestDate, config.date);
    const result = prepareRiskHistoryBatch(db, engine, config, { dates, windows: payload.riskWindows,
      benchmarks: payload.benchmarks, progress, bucketSize: 64 });
    return { ...result, completedSessions: result.processedSecurities, totalSessions: result.totalSecurities,
      ...(result.done ? {} : { continuation: {} }) };
  }
  if (type === 'production-precompute') {
    const config = engine.context({ ...workspaceDefaults(db), ...payload.context });
    const result = precomputeProduction(db, engine, config, { ...payload, progress });
    prepareStandardHealth(db, engine, config);
    scheduleChartBookIndustries(db, engine, materializationContext(config), (jobType, input) => createJob(db, jobType, input));
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
    if (obsoletePreparation(job.type, job.payload)) {
      updateJob(db, job.id, 'superseded', 0, null, 'A newer calculation version replaced this preparation');
      return;
    }
    const progress = (step) => db.prepare('UPDATE jobs SET updated_at=?,progress=? WHERE id=? AND status=\'running\'')
      .run(new Date().toISOString(), Math.max(1, Math.min(99, Math.round(step * 99))), job.id);
    const result = await performJob(db, job.type, job.payload, { provider, journalClient, progress });
    if ([preparationType, rangeHistoryType, detailType, riskHistoryType].includes(job.type) && result.continuation) {
      const { continuation, ...checkpoint } = result;
      const payload = JSON.stringify({ ...job.payload, ...continuation, ...(checkpoint.baseComplete && { baseComplete: true }) });
      const superseded = preparationSuperseded(db, job.payload);
      db.prepare("UPDATE jobs SET status=?,updated_at=?,progress=?,payload=?,result=?,error=? WHERE id=?")
        .run(superseded ? 'superseded' : 'queued', new Date().toISOString(), Math.floor(100 * checkpoint.completedSessions / checkpoint.totalSessions),
          payload, JSON.stringify(checkpoint), superseded ? 'A newer warehouse revision superseded remaining preparation' : null, job.id);
    } else {
      updateJob(db, job.id, 'complete', 100, result);
      if (job.type === preparationType && job.payload.phase === 'current') {
        try { scheduleChartBookIndustries(db, createEngine(db), workspaceDefaults(db), (type, input) => createJob(db, type, input)); }
        catch (error) { console.error('Unable to plan ChartBook industry preparation:', error.message); }
      }
      if (process.env.MARKET_PRECOMPUTE === '1' && (job.type === 'provider-bootstrap' && result.state === 'complete'
        || job.type === 'provider-import' && !job.payload.verifiedOnly && result.imported > 0
        || job.type === 'production-precompute' && job.payload.scheduledFor && result.dataVersion === dataVersion(db))) {
        try { schedulePreparation(db, createEngine(db)); }
        catch (error) { console.error('Unable to plan post-import preparation:', error.message); }
      }
    }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    updateJob(db, job.id, 'failed', 0, null, error.message);
  } finally {
    checkpointJobWrites(db);
  }
}

export function createService({ db, provider, journalClient, workers = true, preparedOnly = process.env.MARKET_PRECOMPUTE === '1' } = {}) {
  const engine = createEngine(db);
  const workerPath = new URL('./job-worker.mjs', import.meta.url);
  let pumpScheduled = false;
  let activeJob = null;
  let checkedPreparationVersion = false;

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
      if (!checkedPreparationVersion) {
        replaceObsoletePreparation(db, engine);
        checkedPreparationVersion = true;
      }
      const waiting = db.prepare(`WITH queued AS (
          SELECT id,type,updated_at,rowid, result, json_extract(payload,'$.phase') AS phase,
            json_extract(payload,'$.context.universe') AS universe,json_extract(payload,'$.context.model') AS model,
            json_extract(payload,'$.context.basis') AS basis,json_extract(payload,'$.context.reference') AS reference,
            json_type(payload,'$.securityIds')='array' AS selected_details
          FROM jobs WHERE status='queued'
        )
        SELECT id FROM queued ORDER BY CASE
          WHEN type IN ('provider-import','provider-bootstrap','provider-reference','nasdaq-refresh','backup','production-precompute') THEN -1
          WHEN type IN (?,?) THEN 7
          WHEN type=? THEN 2
          WHEN type=? THEN CASE WHEN selected_details THEN 0 ELSE 2 END
          WHEN type='chartbook-industry' THEN 1
          WHEN type<>? THEN 0
          WHEN (phase='current' OR phase='recent') AND universe IN ('us-core','us-all') AND model='composite'
            AND basis='reconstructed' AND reference='latest' THEN CASE phase WHEN 'current' THEN 1 ELSE 3 END
          WHEN phase='history' AND universe='nyse' AND model='composite' AND basis='reconstructed'
            AND reference='as-of' AND coalesce(json_extract(result,'$.baseComplete'),0)=0 THEN 4
          WHEN phase='current' THEN 5
          WHEN phase='recent' THEN 6 ELSE 7 END, updated_at, rowid LIMIT 1`).get(rangeHistoryType, riskHistoryType, rangeType, detailType, preparationType);
      if (!waiting) return;
      const claimed = db.prepare(`UPDATE jobs SET status='running',progress=max(progress,1),updated_at=?
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
      const resourceLimits = job.payload.contexts ? {
        maxOldGenerationSizeMb: Math.min(24576, Math.max(4096, Math.floor(totalmem() / 2 ** 20 * 0.18))),
      } : undefined;
      const worker = new Worker(workerPath, { workerData: { filename: db.location(), job }, execArgv: [], resourceLimits });
      worker.once('error', (error) => { failure = error.message; });
      worker.once('exit', (code) => finishJob(job, failure || (code === 0 ? null : `Background worker exited with code ${code}`)));
    } catch (error) { finishJob(job, error.message); }
  }

  function enqueue(type, payload, key = null) {
    if (isAnalysisCalculationJob(type)) {
      payload = { ...payload, analysisGeneration: { dataVersion: dataVersion(db), calculationVersion: CALCULATION_VERSION } };
    }
    let job;
    if (key) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const retainAttempt = type === 'backup' && payload.scheduledFor != null || type === 'provider-import' && Number.isInteger(payload.captureAttempt);
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

  let scheduledPreparation;
  function prepareStandard({ date, version, requested, retry = false } = {}) {
    const identity = JSON.stringify([date, version ?? dataVersion(db)]);
    if (!requested && !retry && scheduledPreparation === identity) return { jobs: [], queued: 0 };
    const result = schedulePreparation(db, engine, { date, version, requested, retry });
    if (!requested && !retry && !result.waitingForCapture) scheduledPreparation = identity;
    if (result.queued) schedulePump();
    return result;
  }

  const historyFor = (config, options) => thinHistory(db, engine, config, options, enqueue, preparedOnly);
  function pendingPreparation(config, phase = 'current') {
    if (bootstrapProgress(db, { activeOnly: true })) return blockedCapture();
    const status = preparationStatus(db, engine, config, phase);
    if (phase === 'current' && status.preparationState === 'unregistered' && config.date < config.latestDate) {
      return preparationStatus(db, engine, config, ['recent', 'history']);
    }
    return status;
  }

  function preparedView(config, options = {}) {
    const result = readPreparedSnapshot(db, engine, config, options);
    if (result) return { ...result, requestedDate: config.requestedDate };
    const superset = pairedBreadthContext(engine, config);
    if (superset) {
      const compact = readPreparedSnapshot(db, engine, superset, options);
      if (compact) return { ...compact, requestedDate: config.requestedDate };
      if (engine.snapshotAvailable(superset, options)) {
        const wide = engine.snapshot(superset, { ...options, persist: false });
        const ids = options.securityIds == null ? null : new Set(options.securityIds);
        return { ...wide, requestedDate: config.requestedDate, ...(ids && { stocks: wide.stocks.filter(({ securityId }) => ids.has(securityId)) }) };
      }
    }
    return null;
  }

  function preparedTickerSnapshot(config, securityId, velocity) {
    const flags = { velocity, securityIds: [securityId] };
    const compact = preparedView(config, flags);
    if (compact) return compact;
    if (!engine.snapshotAvailable(config, { velocity })) return null;
    const wide = engine.snapshot(config, { velocity, persist: false, cache: true });
    return { ...wide, stocks: wide.stocks.filter((row) => row.securityId === securityId) };
  }

  function readSnapshot(config, { velocity = false, summary = false } = {}) {
    if (!preparedOnly || engine.snapshotAvailable(config, { velocity })) {
      return { snapshot: engine.snapshot(config, { velocity, persist: !preparedOnly }) };
    }
    const compact = preparedView(config, { velocity });
    if (compact) return { snapshot: compact };
    const preparation = pendingPreparation(config);
    if (summary) {
      const [archived] = readMaterializedHistory(db, engine, config, { limit: 1 }).rows;
      if (archived?.date === config.date) return { snapshot: { ...archived, stocks: [] }, preparation };
    }
    return { snapshot: { date: config.date, universe: config.universe, model: config.model, dataVersion: config.dataVersion,
      coverage: { state: 'unprepared', listed: null, traded: null }, stocks: [], groups: [], breadth: {}, aggregates: {} }, preparation };
  }

  function velocityOptions(config) {
    if (preparedOnly) {
      const history = (point, flags = {}) => engine.snapshotAvailable(point, flags)
        ? engine.snapshot(point, { ...flags, persist: false }) : preparedView(point, flags);
      if (engine.snapshotAvailable(config, { velocity: true })) return { velocity: true, [resolvedHistory]: history };
      const velocity = preparedView(config, { velocity: true });
      if (velocity) return { velocity: true, [resolvedSnapshot]: velocity, [resolvedHistory]: history };
      const base = engine.snapshotAvailable(config) ? null : preparedView(config);
      return { velocity: false, ...(base ? { [resolvedSnapshot]: base } : engine.snapshotAvailable(config) ? {} : { unprepared: true }),
        [resolvedHistory]: history, materialization: pendingPreparation(config) };
    }
    if (!requiresArchive(db) || engine.snapshotAvailable(config, { velocity: true })) return { velocity: true };
    if (!config.date || !config.earliestDate) return { velocity: false };
    if (bootstrapProgress(db, { activeOnly: true })) return { velocity: false, materialization: blockedCapture() };
    const context = materializationContext(config);
    const key = createHash('sha256').update(JSON.stringify(['workspace', context])).digest('hex');
    return { velocity: false, materialization: pendingJob(enqueue('workspace-precompute', { context }, key)) };
  }

  function pendingScreen(config, options, body = {}) {
    const needsSignal = screenNeedsVelocity(body);
    if (!(config.includeAllTimeHigh || needsSignal || options.unprepared) || !options.materialization) return null;
    return response({ date: config.date, dataVersion: config.dataVersion, rows: [], total: null,
      columns: validateScreen(body).columns, pendingOnly: true,
      pendingReason: needsSignal ? 'Weekly RS signals' : config.includeAllTimeHigh ? 'Verified high history' : 'Prepared stock calculations', ...options }, 202);
  }

  function preparedScreenOptions(config, body) {
    const options = velocityOptions(config);
    const windows = rangeWindowsForScreen(body);
    if (!windows.length) return options;
    const point = rangeContext(engine, config);
    const rangeMetrics = readPreparedRangeMetrics(db, point, windows);
    if (rangeMetrics.ready) return { ...options, rangeMetrics };
    return { ...options, unprepared: true, materialization: rangePendingStatus(db, engine, point, rangeMetrics) };
  }

  const chartBook = createChartBook(db, engine, {
    enqueue, pending: pendingPreparation,
    readSnapshot: (config, options) => readChartBookSnapshot(db, engine, config, options) ?? preparedView(config, options),
    resolveScreen(config, definition, read) {
      const point = engine.context({ ...materializationContext(config), ...screenDataNeeds(definition) });
      const velocity = screenNeedsVelocity(definition);
      const snapshot = read(point, { velocity });
      if (!snapshot) return { materialization: pendingPreparation(point) };
      const windows = rangeWindowsForScreen(definition);
      const range = windows.length ? readPreparedRangeMetrics(db, rangeContext(engine, point), windows) : null;
      if (range && !range.ready) return { materialization: rangePendingStatus(db, engine, rangeContext(engine, point), range) };
      return historicalScreen(db, engine, point, { ...definition, all: true },
        range ? applyPreparedRangeMetrics(snapshot, range) : snapshot, read);
    },
  });

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
        if (preparedOnly) {
          const current = asContext(extra);
          if ((engine.snapshotAvailable(current) || hasPreparedSnapshot(db, engine, current)) &&
            preparationStatus(db, engine, current, 'recent').preparationState === 'complete') return current;
        }
        const ready = latestAnalysis(db, dataVersion(db));
        return asContext(ready ? { ...extra, date: ready.date, dataVersion: ready.dataVersion } : extra);
      };
      const rowPage = () => [parseCount(query.page, 1, 100_000, 1), parseCount(query.perPage, 1, 250, 50)];

      if (area === 'chartbooks') {
        const { data, status } = await chartBook({ method, item, action, sub, query, body, resolvePoint: listContext });
        return response(data, status);
      }

      if (area === 'journal') {
        if (item === 'settings') {
          if (method === 'GET' || method === 'PUT' || method === 'POST') {
            const settings = method === 'GET' ? getJournalSettings(db) : saveJournalSettings(db, body);
            const scheduleEffective = settings.configured && settings.enabled;
            const date = latestFinalizableSession(new Date(), marketSyncAfter(process.env.MARKET_SYNC_AFTER));
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
        if (item === 'preparation' && method === 'GET') return response(preparationSummary(db, asContext().dataVersion));
        if (item === 'preparation' && method === 'POST') {
          const context = body.context && Object.keys(body.context).length ? body.context : null;
          const rangeWindows = context ? rangeWindowsForScreen({ context }) : [];
          if (context && body.register !== false) registerPreparation(db, asContext(context), { followLatest: context.followLatest === true, rangeWindows });
          return response(prepareStandard({ ...(context ? { requested: { ...context, rangeWindows }, version: context.dataVersion } : {}),
            retry: body.retry === true || !!context }), 202);
        }
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
            const receipt = importDataset(db, { provider: 'reviewed-operator', dataset: 'quality-overrides', qualityOverrides: rows });
            if (preparedOnly && !receipt.duplicate) prepareStandard();
            return response(receipt, 201);
          }
        }
        if (method === 'GET' && item === 'quality') {
          const point = asContext();
          const { snapshot } = readSnapshot(point, { summary: true });
          return response(quality(db, engine, point, snapshot));
        }
        if (method === 'POST' && item === 'import') {
          const receipt = importDataset(db, body);
          if (preparedOnly && !receipt.duplicate) prepareStandard();
          return response(receipt, 201);
        }
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
        return response(db.prepare("SELECT id,type,status,created_at,updated_at,progress,error FROM jobs ORDER BY status='running' DESC,rowid DESC LIMIT 30").all());
      }
      if (area === 'config' && method === 'GET') {
        const observedBenchmarks = availableBenchmarks(db);
        return response({
          universes: [...UNIVERSES, ...listWorkspace(db, 'universe')],
          models: [...BUILTIN_MODELS, ...listWorkspace(db, 'ranking-model')],
          healthModels: [DEFAULT_HEALTH_MODEL, ...listWorkspace(db, 'health-model')],
          rankingMethods: RANKING_METHODS, rankingPeriods, rankingLists, breadthMetrics: BREADTH_METRICS, columns: defaultColumns,
          automaticPreparation: preparedOnly,
          benchmarks: [...new Set([...BENCHMARKS, ...observedBenchmarks])], availableBenchmarks: observedBenchmarks,
          ...classificationStatus(db),
          status: localStatus(db), exportFormats: await parquetAvailable() ? exportFormats : ['csv'],
        });
      }
      if (area === 'market' && item === 'health' && action === 'prepare' && method === 'POST') {
        const config = asContext(body.context);
        const coverage = researchCoverage(body);
        const model = chooseHealthModel(db, body.healthModel);
        const limit = parseCount(body.limit, 1, 7560, 315);
        const from = dateString(body.from, null);
        const recipe = healthRecipe(engine, config, model, coverage);
        const healthKey = `health:${recipe}:${config.dataVersion}:${config.date}`;
        return response(enqueue('health-precompute', { context: preparationInput(config), ...coverage, healthModel: model.id,
          limit, from, preparedOnly, healthKey }, `${healthKey}:${limit}:${from || ''}`), 202);
      }
      if (area === 'market' && method === 'GET') {
        const requestedMetrics = query.metrics ? String(query.metrics).split(',').filter((key) => breadthMetric(key) || key === 'adSpread') : [];
        const keys = [...new Set(requestedMetrics.length ? requestedMetrics : item === 'monitor' ? monitorMetrics : [])].slice(0, 24);
        const config = asContext({ breadthKeys: [item === 'breadth' ? action : null, ...keys].filter(Boolean) });
        if (item === 'summation') {
          const point = summationContext(db, engine, config);
          const result = readPreparedSummation(db, point, { from: query.from, to: query.to,
            limit: parseCount(query.limit, 1, 7560, 252) });
          return response({ ...result, ...(!result.rows.length ? pendingPreparation(point, 'history') : {}) });
        }
        if (item === 'analogs') {
          const coverage = researchCoverage(query);
          const horizon = parseCount(query.horizon, 1, 126, 20);
          const source = historyFor(config, { cadence: 'daily', limit: parseCount(query.historyLimit, 30, 2600, 252) });
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
          const limit = parseCount(query.limit, 1, 1260, 63);
          const source = historyFor(config, { to: query.to, cadence: 'daily',
            from: query.from ? shiftDate(dateString(query.from), -2 * extremeDefinition.lookback - 16) : undefined,
            limit: limit + extremeDefinition.lookback,
            materializedOnly: query.materializedOnly === '1',
            visibleRequested: limit });
          const rows = formatHistory(source.rows, keys, true)
            .filter((row) => !query.from || row.date >= query.from).slice(-limit);
          if (exportFormats.includes(query.export) && source.materialization?.pending) return response({ materialization: source.materialization }, 202);
          if (exportFormats.includes(query.export)) return await exportTable(rows,
            ['date', ...historyColumns(keys), ...keys.map((key) => `${key}_extreme_percentile`),
              ...ratioDefinitions.flatMap(({ key }) => [key, `${key}_state`, `${key}_numerator`, `${key}_denominator`]), 'coverage', 'eligible', 'traded'],
            'market-monitor', query.export, config);
          const { snapshot, preparation } = readSnapshot(config, { summary: true });
          return response({ date: config.date, coverage: snapshot.coverage, metrics, rows, ratioDefinitions, extremeDefinition,
            currentReading: snapshot.date && snapshot.coverage.state !== 'unprepared' ? formatHistory([snapshot], keys, true)[0] : null,
            materialization: source.materialization, preparation, dataVersion: config.dataVersion });
        }
        if (item === 'overview') {
          const { snapshot, preparation } = readSnapshot(config, { summary: true });
          const { stocks, ...thin } = snapshot;
          const traded = stocks.filter((row) => row.traded);
          const leaders = traded.filter(({ rsRank }) => rsRank != null).sort((a, b) => a.rsRank - b.rsRank).slice(0, 8);
          const gainers = traded.filter(({ return_1d }) => finite(return_1d) && return_1d > 0.10 + Number.EPSILON)
            .sort((a, b) => b.return_1d - a.return_1d);
          const losers = traded.filter(({ return_1d }) => finite(return_1d) && return_1d < -0.10 - Number.EPSILON)
            .sort((a, b) => a.return_1d - b.return_1d);
          const model = chooseHealthModel(db, query.healthModel);
          const support = !preparedOnly && snapshot.coverage.state === 'complete' && healthBaseline(model) > 44
            ? historyFor(config, { limit: healthBaseline(model) + 1, cadence: 'daily' }) : null;
          return response({ ...thin, groups: thin.groups.slice(0, 12).map(({ memberIds, ...group }) => group), leaders,
            movers: { gainers: gainers.slice(0, 5), losers: losers.slice(0, 5), counts: { gainers: gainers.length, losers: losers.length } },
            materialization: preparation?.pending || preparation?.captureInProgress ? preparation : support?.materialization, preparation,
            health: preparedOnly ? readPreparedHealth(db, engine, config, model, researchCoverage(), config.date, 1)[0]
              || { date: config.date, score: null, state: 'unprepared', reason: 'Market health calculations are not yet prepared for this context', components: [] }
              : marketHealth(db, engine, config, { snapshot, model, history: support?.rows }) });
        }
        if (item === 'breadth') {
          if (sub === 'contributors') {
            const [page, perPage] = rowPage();
            const exportRequested = exportFormats.includes(query.export);
            const { snapshot, preparation } = readSnapshot(config);
            if (preparation) return response({ date: config.date, materialization: preparation, rows: [], total: null, pendingOnly: true }, 202);
            const result = breadthContributors(snapshot, action, query.include, page, perPage, exportRequested);
            if (exportRequested) return await exportTable(result.rows,
              ['symbol', 'name', 'exchange', 'close', 'breadthSelection', ...(action === 'adSpread' ? ['contribution'] : [])],
              'market-breadth-contributors', query.export, config);
            return response(result);
          }
          if (query.series === '1' || query.from || query.to) {
            const keys = String(query.metrics || action || 'above_50d,above_200d,up_4pct,down_4pct').split(',')
              .filter((key) => breadthMetric(key) || key === 'adSpread' || leadershipHistoryMetrics.has(key));
            const limit = parseCount(query.limit, 1, query.materializedOnly ? 7560 : query.cadence === 'weekly' ? 260 : 1260, 80);
            const dailyLimit = query.cadence === 'weekly' ? Math.min(7560, limit * 5) : limit;
            const requestedFrom = dateString(query.from, null);
            const onlyStored = query.materializedOnly === '1';
            const history = historyFor(config, { ...query,
              from: requestedFrom && !onlyStored ? shiftDate(requestedFrom, -2 * extremeDefinition.lookback - 16) : requestedFrom,
              cadence: 'daily', limit: Math.min(7560, dailyLimit + (onlyStored ? 0 : extremeDefinition.lookback)),
              materializedOnly: onlyStored, visibleRequested: limit });
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
          const { snapshot: snap, preparation } = readSnapshot(config, { summary: true });
          return response({ date: snap.date, referenceDate: snap.referenceDate, referenceMode: snap.referenceMode,
            classificationSystem: snap.classificationSystem, coverage: snap.coverage, metrics: action ? { [action]: snap.breadth[action] } : snap.breadth,
            preparation });
        }
        if (item === 'health' || item === 'events') {
          const coverage = researchCoverage(query);
          const { snapshot, preparation } = readSnapshot(config, { summary: true });
          const model = chooseHealthModel(db, query.healthModel);
          const visible = parseCount(query.limit, 1, 1260, 45);
          const requestedFrom = dateString(query.from, null);
          const stored = readPreparedHealth(db, engine, config, model, coverage, requestedFrom, visible);
          const latest = stored.at(-1);
          if (preparedOnly || latest?.date === config.date) {
            const healthKey = `health:${healthRecipe(engine, config, model, coverage)}:${config.dataVersion}:${config.date}`;
            const job = db.prepare(`SELECT id,status,error,progress FROM jobs WHERE type='health-precompute'
              AND json_extract(payload,'$.healthKey')=? ORDER BY rowid DESC LIMIT 1`).get(healthKey);
            const archived = latest?.date === config.date;
            const startsAt = requestedFrom && requestedFrom > config.earliestDate ? requestedFrom : config.earliestDate;
            const requestedSessions = startsAt && config.date ? expectedSessions(startsAt, config.date).slice(-visible) : [];
            const fullyStored = archived && (item !== 'events' && query.series !== '1'
              || stored.length === requestedSessions.length && stored.every((row, index) => row.date === requestedSessions[index]));
            const events = divergenceLedger(db, engine, config, model, stored[0]?.date, coverage);
            const activeHealth = job && ['queued', 'running'].includes(job.status);
            const contextPreparation = !fullyStored && !activeHealth ? pendingPreparation(config, 'recent') : undefined;
            const materialization = !fullyStored ? activeHealth ? pendingJob(job)
              : { preparationState: job?.status === 'failed' ? 'failed' : 'unregistered', error: job?.error || null, prepareAction: 'health' } : undefined;
            const health = archived ? latest : { date: config.date, score: null, state: 'unprepared', components: [],
              reason: 'Prepare market health for this context and coverage policy', descriptive: coverage.coverageMode === 'observed', ...coverage };
            return response(item === 'events' ? { date: config.date, events, ...coverage, materialization, contextPreparation }
              : { ...health, events, history: query.series === '1' ? stored : [], materialization, preparation, contextPreparation });
          }
          const warmup = healthBaseline(model);
          const source = snapshot.coverage.state === 'complete' || coverage.coverageMode === 'observed' || query.series === '1' || item === 'events'
            ? historyFor(config, { ...query, cadence: 'daily', limit: visible + warmup, visibleRequested: visible,
              from: requestedFrom && shiftDate(requestedFrom, -2 * warmup - 16) }) : { rows: [] };
          const health = marketHealth(db, engine, config, { model, history: source.rows, snapshot, preparedOnly, ...coverage });
          const sessions = source.rows.length ? expectedSessions(source.rows[0].date, source.rows.at(-1).date) : [];
          const all = query.series === '1' || item === 'events' ? marketHealthHistory(source.rows, { model, sessions, ...coverage }) : [];
          const series = all.filter((row) => !requestedFrom || row.date >= requestedFrom).slice(-visible);
          const events = divergenceLedger(db, engine, config, model, series[0]?.date, coverage);
          return response(item === 'events' ? { date: config.date, events, ...coverage, materialization: source.materialization }
            : { ...health, events, history: series, materialization: source.materialization, preparation });
        }
      }
      if (area === 'rankings' && method === 'GET') {
        const config = query.series === '1' ? asContext() : listContext();
        if (query.series === '1') {
          return response(rankSeries(db, engine, config, { ...query, cadence: query.cadence || 'weekly',
            limit: parseCount(query.limit, 1, 7560, 60) }, enqueue, { preparedOnly }));
        }
        const options = velocityOptions(config);
        const pending = pendingScreen(config, options, query);
        if (pending) return pending;
        const result = resolveScreen(db, engine, config, query, options);
        return response({ ...result, ...options, model: config.model, universe: config.universe, dataVersion: config.dataVersion });
      }
      if (area === 'screens' && item === 'query' && method === 'POST') {
        const config = listContext({ ...body.context, ...screenDataNeeds(body) });
        const options = preparedScreenOptions(config, body);
        const pending = pendingScreen(config, options, body);
        if (pending) return pending;
        const result = resolveScreen(db, engine, config, body, options);
        if (exportFormats.includes(body.export)) return await exportTable(result.rows, result.columns.length ? result.columns : defaultColumns, 'market-screen', body.export, config);
        return response({ ...result, ...options, dataVersion: config.dataVersion });
      }
      if (area === 'stocks' && method === 'POST' && item && action === 'prepare') {
        const config = asContext(body.context);
        const security = requireStockIdentity(db, config, item);
        if (!config.date || !config.earliestDate) throw asError('Load a price session before preparing ticker details');
        const lookback = parseCount(body.lookback, 1, 2600, 126);
        const spec = detailSpec(engine, config, { securityIds: [security.id], benchmarks: [config.benchmark], riskWindows: [lookback],
          followLatest: body.followLatest === true });
        if (body.followLatest === true) {
          const kind = 'stock-detail-preparation';
          const definition = { securityId: security.id, basis: config.basis, benchmark: config.benchmark, lookback };
          const id = createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 24);
          if (!getWorkspace(db, kind, id)) storeWorkspace(db, kind, { name: security.id, definition }, id);
        }
        return response(enqueue(detailType, spec, spec.jobKey), 202);
      }
      if (area === 'stocks' && method === 'GET' && item) {
        const config = asContext();
        if (item === 'search' && !action) return response({ date: config.date, dataVersion: config.dataVersion,
          rows: securitySearch(db, config, String(query.q || '').trim().slice(0, 100), parseCount(query.limit, 1, 25, 12)) });
        if (action === 'screens') {
          const security = requireStockIdentity(db, config, item);
          const saved = listWorkspace(db, 'screen');
          const matched = [];
          for (const screen of saved) {
            const screenConfig = engine.context({ ...query, ...savedScreenContext(screen.definition), ...screenDataNeeds(screen.definition),
              date: config.date, dataVersion: config.dataVersion });
            const options = preparedScreenOptions(screenConfig, screen.definition);
            const pending = pendingScreen(screenConfig, options, screen.definition);
            if (pending) return response({ date: config.date, screens: matched, evaluated: null,
              pendingOnly: true, materialization: options.materialization }, 202);
            const snapshot = options[resolvedSnapshot] || engine.snapshot(screenConfig, options);
            const filters = [screen.definition.filter, { field: 'securityId', op: 'eq', value: security.id }].filter(Boolean);
            const results = historicalScreen(db, engine, screenConfig, { ...screen.definition, page: 1, perPage: 1,
              filter: { operator: 'and', filters } }, options.rangeMetrics ? applyPreparedRangeMetrics(snapshot, options.rangeMetrics) : snapshot,
            options[resolvedHistory]);
            if (results.total) matched.push({ id: screen.id, name: screen.name, version: screen.version,
              universe: screenConfig.universe.id, model: screenConfig.model.id });
          }
          return response({ date: config.date, securityId: security.id, evaluated: saved.length, screens: matched });
        }
        if (action === 'rankings') {
          const security = requireStockIdentity(db, config, item);
          return response({ securityId: security.id, ...rankSeries(db, engine, config, { ...query, securityId: security.id,
            cadence: query.cadence || 'weekly', limit: parseCount(query.limit, 1, query.cadence === 'daily' ? 1260 : 260, 44) }, enqueue, { supplyDemand: true, preparedOnly }) });
        }
        const lookback = parseCount(query.lookback, 1, 2600, 252);
        const directMembership = (id) => listWorkspace(db, 'watchlist').filter((list) => list.definition.members?.includes(id)).map(({ name }) => name);
        let detail, risk, options;
        if (preparedOnly) {
          const security = requireStockIdentity(db, config, item);
          const weekly = preparedTickerSnapshot(config, security.id, true);
          const snapshot = weekly || preparedTickerSnapshot(config, security.id, false);
          const archive = readPreparedDetail(db, config, security.id, { lookback, benchmark: config.benchmark });
          detail = preparedStockDetail(db, config, security, snapshot, archive);
          const chartsReady = archive.state === 'ready';
          const riskReady = archive.riskState === 'ready';
          detail.detailPreparation = { state: chartsReady && riskReady && snapshot && weekly ? 'ready' : 'partial',
            chart: { state: archive.state, sourceDataVersion: archive.sourceDataVersion, anchorDate: archive.anchorDate,
              ...(chartsReady && { priceAvailability: archive.detail?.bars.some((bar) => Number.isFinite(bar.close) && !bar.unverifiedSplit)
                ? 'observations' : config.basis === 'known' ? 'no-known-observations' : 'no-price-observations' }),
              projected: archive.projected, ...(!chartsReady && detailJobs(db, config, security.id, { exact: config.basis === 'known' || archive.state === 'requires-exact-date' })) },
            risk: { state: archive.riskState, benchmark: config.benchmark, lookback,
              ...(!riskReady && (riskHistoryPending(db, config, lookback) || detailJobs(db, config, security.id,
                { exact: true, benchmark: config.benchmark, lookback }))) },
            metrics: { state: snapshot ? 'ready' : 'unprepared', ...(!snapshot && pendingPreparation(config)) },
            weekly: { state: weekly ? 'ready' : 'unprepared', ...(!weekly && pendingPreparation(config)) },
          };
          risk = archive.detail?.risk ?? null;
          options = { velocity: !!weekly };
          if (exportFormats.includes(query.export) && !chartsReady) return response({ date: config.date, pendingOnly: true,
            detailPreparation: detail.detailPreparation }, 202);
        } else {
          options = velocityOptions(config);
          detail = exists(engine.detail(config, item, lookback, options), 'Security');
          const benchmark = detail.bars.length ? engine.studyPrices(config, [config.benchmark], detail.bars[0].date, config.date).get(config.benchmark) : null;
          risk = riskMetrics(detail, benchmark);
        }
        if (preparedOnly && detail.loadedHistoryHigh === undefined) {
          const point = { ...config, includeAllTimeHigh: true };
          const enriched = engine.snapshotAvailable(point) ? engine.snapshot(point, { persist: false })
            : preparedView(point, { securityIds: [detail.securityId] });
          const high = enriched?.stocks.find(({ securityId }) => securityId === detail.securityId);
          if (high && Object.hasOwn(high, 'loadedHistoryHigh')) {
            for (const key of ['allTimeHigh', 'loadedHistoryHigh', 'loadedHistoryHighFrom', 'loadedHistoryHighThrough',
              'loadedHistoryHighObservations', 'loadedHistoryHighExpected', 'loadedHistoryHighBoundary',
              'distance_all_time_high', 'distance_loaded_history_high']) detail[key] = high[key];
            detail.warnings = detail.warnings.filter((message) => message !== 'Lifetime highs are unavailable for this prepared stock view.');
          }
        }
        const ranges = readPreparedRangeMetrics(db, rangeContext(engine, config), [20, 252]);
        if (ranges.values.size) Object.assign(detail, applyPreparedRangeMetrics({ stocks: [detail] }, ranges).stocks[0]);
        detail.rangeMetrics = { windows: ranges.windows, missingWindows: ranges.missingWindows };
        if (action === 'metrics') return response({ ...detail, bars: undefined, chartBars: undefined, actions: undefined });
        if (exportFormats.includes(query.export)) return await exportTable(detail.bars, ['date', 'open', 'high', 'low', 'close', 'volume', 'dollarVolume'], 'stock-prices', query.export, config);
        return response({ ...detail, ...options, benchmark: config.benchmark, risk, watchlists: directMembership(detail.securityId) });
      }
      if (area === 'industries' && method === 'GET') {
        const config = asContext();
        const options = velocityOptions(config);
        const { snapshot: snap, preparation } = options[resolvedSnapshot] ? { snapshot: options[resolvedSnapshot] }
          : readSnapshot(config, { velocity: options.velocity, summary: true });
        if (!item) return response({ date: snap.date, ...options, referenceDate: snap.referenceDate, referenceMode: snap.referenceMode,
          classificationSystem: snap.classificationSystem, coverage: snap.coverage, preparation,
          groups: snap.groups.filter((group) => !query.level || group.level === query.level) });
        if (item === 'compare') {
          const ids = String(query.ids || '').split(',').filter(Boolean).slice(0, 8);
          const limit = parseCount(query.limit, 1, query.cadence === 'weekly' ? 260 : 1260, 80);
          const cadence = query.cadence === 'weekly' ? 'weekly' : 'daily';
          const { rows: history, materialization } = historyFor(config, { ...query, cadence: 'daily',
            limit: cadence === 'weekly' ? limit * 5 : limit, visibleRequested: limit });
          const rows = groupHistoryRows(history, ids, { cadence, limit, from: query.from,
            to: query.to && query.to < config.date ? query.to : config.date });
          return response({ date: snap.date, cadence, materialization, rows });
        }
        if (preparation && options.unprepared && action === 'members') {
          return response({ date: config.date, materialization: preparation, rows: [], total: null, pendingOnly: true }, 202);
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
          const config = asContext({ basis: 'known', ...body.screen?.context, ...body.context, ...screenDataNeeds(body.screen ?? {}) });
          const date = dateString(body.date, config.date);
          const { frozen: _, ...input } = body;
          return response(enqueue('cohort', { ...input, date, context: materializationContext(config) }), 202);
        }
      }
      if (area === 'alerts') {
        if (method === 'GET') return response(db.prepare('SELECT payload FROM alert_events ORDER BY date DESC LIMIT 250').all().map(({ payload }) => JSON.parse(payload)));
        if (method === 'POST' && item === 'evaluate') return response(updateAlerts(db, engine, body.context));
      }
      if (area === 'scheduler' && method === 'POST' && item === 'sync') {
        const date = latestFinalizableSession(new Date(), marketSyncAfter(process.env.MARKET_SYNC_AFTER));
        return response(enqueue('provider-import', { bulk: true, date, ...body }), 202);
      }
      if (collections[area]) {
        const kind = collections[area];
        const defaults = kind === 'ranking-model' ? BUILTIN_MODELS : kind === 'universe' ? UNIVERSES : [];
        if (!item && method === 'GET') return response([...defaults, ...listWorkspace(db, kind)]);
        if (!item && method === 'POST') {
          const saved = storeWorkspace(db, kind, { name: body.name, definition: workspaceDefinition(kind, body) });
          if (preparedOnly && ['screen', 'universe', 'ranking-model', 'theme', 'alert-rule', 'health-model'].includes(kind)) {
            scheduledPreparation = null;
            prepareStandard();
          }
          return response(saved, 201);
        }
        if (item) {
          const builtin = defaults.find(({ id }) => id === item);
          const saved = exists(builtin || getWorkspace(db, kind, item, query.version ? Number(query.version) : null), 'Saved item');
          if (method === 'GET' && !action) return response(saved);
          if (method === 'POST' && action === 'duplicate') {
            return response(storeWorkspace(db, kind, { name: body.name || `${saved.name} copy`, definition: saved.definition }), 201);
          }
          if (method === 'POST' && action === 'execute' && kind === 'screen') {
            const config = listContext({ ...savedScreenContext(saved.definition), ...body.context, ...screenDataNeeds({ ...saved.definition, ...body }) });
            const options = preparedScreenOptions(config, { ...saved.definition, ...body });
            const pending = pendingScreen(config, options, { ...saved.definition, ...body });
            if (pending) return pending;
            const result = resolveScreen(db, engine, config, { ...saved.definition, ...body }, options);
            if (exportFormats.includes(body.export)) return await exportTable(result.rows, result.columns.length ? result.columns : defaultColumns, 'saved-screen', body.export, config);
            return response({ ...result, ...options, dataVersion: config.dataVersion });
          }
          if (method === 'POST' && action === 'execute' && kind === 'cohort') {
            const definition = saved.definition;
            const frozen = definition.frozen || (Array.isArray(definition.members) && {
              context: definition.context, members: validMembers(definition.members).map((securityId) => ({ securityId })), calculationVersion: null,
            });
            if (!frozen) throw asError('This cohort has no recorded frozen membership');
            const { basis, benchmark, universe, universeVersion, model, modelVersion, classification, reference } = frozen.context || {};
            const { horizons, asOf, maePrice } = body;
            const context = { basis, benchmark, universe, universeVersion, model, modelVersion, classification, reference,
              dataVersion: body.context?.dataVersion ?? dataVersion(db) };
            return response(enqueue('cohort', { ...definition, frozen, context, horizons: horizons ?? definition.horizons,
              asOf, maePrice: maePrice ?? definition.maePrice }), 202);
          }
          if (kind === 'watchlist' && action === 'members' && method === 'GET') {
            const screen = saved.definition.screenId && getWorkspace(db, 'screen', saved.definition.screenId);
            if (screen) {
              const screenConfig = listContext({ ...savedScreenContext(screen.definition), ...screenDataNeeds(screen.definition) });
              const screenOptions = preparedScreenOptions(screenConfig, screen.definition);
              const pending = pendingScreen(screenConfig, screenOptions, screen.definition);
              if (pending) return pending;
              return response({ ...resolveScreen(db, engine, screenConfig, { ...screen.definition, page: query.page, perPage: query.perPage }, screenOptions),
                ...screenOptions, dataVersion: screenConfig.dataVersion });
            }
            const config = asContext();
            const options = velocityOptions(config);
            const pending = pendingScreen(config, options);
            if (pending) return pending;
            const snapshot = options[resolvedSnapshot] || engine.snapshot(config, options);
            const wanted = new Set(saved.definition.members);
            const list = snapshot.stocks.filter((stock) => wanted.has(stock.securityId));
            const included = new Set(list.map((stock) => stock.securityId));
            return response({ ...screenStocks({ ...snapshot, stocks: list }, { ...query, includeUntraded: true }),
              unavailable: [...wanted].filter((id) => !included.has(id)), ...options });
          }
          if (kind === 'watchlist' && action === 'members' && method === 'POST') {
            if (saved.definition.screenId) throw asError('Edit the dynamic watchlist’s source screen');
            const removed = new Set(validMembers(body.remove));
            const previous = saved.definition.members || [];
            const members = validMembers([...previous, ...validMembers(body.add)]).filter((id) => !removed.has(id));
            if (members.length === previous.length && members.every((id, index) => id === previous[index])) return response(saved);
            return response(storeWorkspace(db, kind, { name: saved.name, definition: { members, mode: 'manual', screenId: null } }, saved.id));
          }
          if (!builtin && method === 'PUT' && !action) {
            const updated = storeWorkspace(db, kind, { name: body.name, definition: workspaceDefinition(kind, body) }, item);
            if (preparedOnly && ['screen', 'universe', 'ranking-model', 'theme', 'alert-rule', 'health-model'].includes(kind)) {
              scheduledPreparation = null;
              prepareStandard();
            }
            return response(updated);
          }
          if (!builtin && method === 'DELETE' && !action) return response(storeWorkspace(db, kind, saved, item, true));
        }
      }
      return response({ error: 'Route not found' }, 404);
    } catch (error) {
      if (error.preparation) return response(error.preparation, 202);
      return response({ error: error.message }, error.status || 400);
    }
  }

  return { dispatch, enqueue, engine, workspaceConfiguration: () => workspaceDefaults(db),
    prepareStandard: (options) => requiresArchive(db) ? prepareStandard(options) : { jobs: [], queued: 0 },
    journalConfiguration() {
      const { model, modelVersion, reference, ...context } = workspaceDefaults(db);
      return { ...context, analysisModel: model, analysisModelVersion: modelVersion, referenceMode: reference };
    },
    updateAlerts: (params) => updateAlerts(db, engine, params) };
}

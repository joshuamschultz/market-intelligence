import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { expectedSessions, shiftDate, weekEnd } from './calendar.mjs';
import { CALCULATION_VERSION, listWorkspace } from './database.mjs';
import { materializeHistory } from './materialization.mjs';
import { annotateVelocity, BUILTIN_MODELS, validateModel } from './ranking.mjs';
import { writeRankArchive } from './rank-archive.mjs';

const monitorKeys = ['up_13pct_34d', 'down_13pct_34d'];

function requireDisk(db) {
  const filename = db.location();
  if (!filename) return;
  const { bavail, bsize } = statfsSync(dirname(filename));
  if (bavail * bsize < 512 * 1024 * 1024) throw new Error('Workspace precomputation ran out of available disk space');
}

function snapshotKey(config, engine) {
  return [`${config.universe.id}@${config.universe.version}`, `${config.model.id}@${config.model.version}`,
    CALCULATION_VERSION, engine.definitionKey(config)];
}

function reusableWorkspaceSnapshots(db, engine, config, dates) {
  const key = snapshotKey(config, engine);
  const scope = "kind='market' AND universe=? AND model=? AND calculation_version=? AND definition_key=?";
  const rows = db.prepare(`SELECT date,data_version FROM snapshots WHERE ${scope} AND data_version<=?
    AND date IN (SELECT value FROM json_each(?)) ORDER BY date,data_version DESC`)
    .all(...key, config.dataVersion, JSON.stringify(dates));
  const bounds = reusableArchiveVersions(db, config, rows.map((row) => row.data_version));
  const read = db.prepare(`SELECT value FROM snapshots WHERE ${scope} AND date=? AND data_version=?`);
  const selected = new Map();
  for (const row of rows) if (!selected.has(row.date) && usableArchiveRow(bounds, row)) selected.set(row.date, row.data_version);
  return {
    has: (date) => selected.has(date),
    read(date) {
      if (!selected.has(date)) return null;
      const value = read.get(...key, date, selected.get(date)).value;
      return JSON.parse(typeof value === 'string' ? value : gunzipSync(value));
    },
  };
}

function velocityInputs(snapshot) {
  return {
    stocks: snapshot.stocks.map(({ securityId, rsRank, rsPercentile, rsScore, udv_50d, up_volume_50d }) =>
      ({ securityId, rsRank, rsPercentile, rsScore, udv_50d, up_volume_50d })),
    groups: snapshot.groups.map(({ id, rank, percentile, above50, medianRS, topDecile, relativeReturn }) =>
      ({ id, rank, percentile, above50, medianRS, topDecile, relativeReturn })),
  };
}

function persistWorkspaceVelocity(db, engine, config, current, weekly) {
  const annotated = { ...current, stocks: current.stocks.map((row) => ({ ...row })), groups: current.groups.map((row) => ({ ...row })) };
  annotateVelocity(annotated, weekly);
  persistSnapshot(db, engine, config, 'market-velocity', annotated);
  return annotated;
}

function persistSnapshot(db, engine, config, kind, snapshot) {
  const json = JSON.stringify(snapshot);
  const [universe, model, calculationVersion, definition] = snapshotKey(config, engine);
  db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?,?,?,?,?)').run(kind, config.date,
    universe, model, config.dataVersion, calculationVersion, definition, json.length < 65_536 ? json : gzipSync(json, { level: 1 }),
    new Date().toISOString());
}

function warmReusableWorkspace(db, engine, source, dates, weeks, progress, signal) {
  const dated = { ...source, referenceMode: 'as-of' };
  const past = dates.filter((date) => date !== source.date);
  const stored = reusableWorkspaceSnapshots(db, engine, dated, past);
  const pending = past.filter((date) => !stored.has(date));
  const timeline = pending.length ? engine.historyBatch(dated, pending) : dated;
  const baselines = new Map();
  let reused = 0;
  let current;
  for (const date of dates) {
    signal?.throwIfAborted();
    requireDisk(db);
    const point = date === source.date ? source : { ...timeline, date, requestedDate: date };
    const saved = date !== source.date ? stored.read(date) : null;
    const snapshot = saved ?? engine.snapshot(point, { cache: false });
    if (saved) reused++;
    if (date === source.date) current = snapshot;
    else if (weeks.includes(date)) baselines.set(date, velocityInputs(snapshot));
    materializeHistory(db, engine, point, { limit: 1, withRanks: true, signal });
    progress();
  }
  signal?.throwIfAborted();
  const weekly = [...weeks].reverse().map((date) => baselines.get(date) ?? { stocks: [], groups: [] });
  return { current: persistWorkspaceVelocity(db, engine, source, current, weekly), reused };
}

export function precomputeWorkspace(db, engine, config, { allModels = false, dailyTail = 1, progress = () => {}, reuseWeekly = false, signal } = {}) {
  if (!config.date || !config.earliestDate || config.date < config.earliestDate) throw new Error('Load prices before precomputing the workspace');
  if (!Number.isInteger(Number(dailyTail)) || dailyTail < 1 || dailyTail > 65) throw new Error('Choose 1–65 recent sessions');
  const end = weekEnd(config.date);
  const weeks = [];
  for (let offset = 12; offset >= 1; offset--) {
    const friday = shiftDate(end, -7 * offset);
    const close = expectedSessions(shiftDate(friday, -4), friday).at(-1);
    if (close && close >= config.earliestDate) weeks.push(close);
  }
  const recent = expectedSessions(shiftDate(config.date, -2 * dailyTail - 12), config.date).slice(-dailyTail);
  const dates = [...new Set([...weeks, ...recent])].filter((date) => date >= config.earliestDate).sort();
  const models = allModels ? [...BUILTIN_MODELS, ...listWorkspace(db, 'ranking-model')] : [config.model];
  const completed = [];
  let reused = 0;
  let processed = 0;
  const total = models.length * (dates.length + 1);
  for (const model of models) {
    const source = { ...viewConfig(engine, config, { model: model.id, modelVersion: model.version,
      breadthKeys: config.breadthKeys, includeAllTimeHigh: config.includeAllTimeHigh && config.model.id === model.id }),
    model: { ...model, definition: validateModel(model.definition) }, currentVersion: false };
    const step = () => progress(++processed / total);
    let current;
    if (reuseWeekly) {
      const warmed = warmReusableWorkspace(db, engine, source, dates, weeks, step, signal);
      current = warmed.current;
      reused += warmed.reused;
    } else {
      const timeline = engine.historyBatch(source, dates);
      for (const date of dates) {
        signal?.throwIfAborted();
        requireDisk(db);
        const point = { ...timeline, date, requestedDate: date };
        engine.snapshot(point, { cache: false });
        materializeHistory(db, engine, point, { limit: 1, signal });
        writeRankArchive(db, engine, point, { limit: 1 });
        step();
      }
      current = engine.snapshot(source, { velocity: true, persistVelocity: true, cache: false });
    }
    completed.push({ model: model.id, version: model.version, listed: current.coverage.listed, ranked: current.coverage.ranked || 0 });
    step();
  }
  return { date: config.date, universe: config.universe.id, benchmark: config.benchmark, classification: config.classification,
    dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION, sessions: dates.length, models: completed,
    ...(reuseWeekly ? { reusedSnapshots: reused } : {}) };
}

function viewConfig(engine, config, overrides) {
  return engine.context({ date: config.date, dataVersion: config.dataVersion, universe: config.universe.id, universeVersion: config.universe.version,
    model: config.model.id, modelVersion: config.model.version, benchmark: config.benchmark, basis: config.basis,
    classification: config.classification, reference: config.referenceMode, observedReferenceDate: config.observedReferenceDate,
    averages: config.averages, windows: config.windows, volumeWindows: config.volumeWindows, threshold: config.threshold,
    includeAllTimeHigh: config.includeAllTimeHigh,
    themes: config.themes, breadthKeys: [], ...overrides });
}

const highFields = [
  'allTimeHigh', 'loadedHistoryHigh', 'loadedHistoryHighFrom', 'loadedHistoryHighThrough',
  'loadedHistoryHighObservations', 'loadedHistoryHighExpected', 'loadedHistoryHighBoundary',
  'distance_all_time_high', 'distance_loaded_history_high',
];

function warmCurrentHighs(db, engine, base, progress, signal) {
  let bySecurity;
  const models = [];
  for (const [index, model] of BUILTIN_MODELS.entries()) {
    signal?.throwIfAborted();
    requireDisk(db);
    const normal = viewConfig(engine, base, { model: model.id, modelVersion: model.version, includeAllTimeHigh: false });
    const enriched = { ...normal, includeAllTimeHigh: true, currentVersion: false };
    if (engine.snapshotAvailable(enriched, { velocity: true })) {
      models.push({ model: model.id, version: model.version, reused: true });
    } else {
      if (!bySecurity) {
        const source = engine.snapshot(enriched, { cache: false });
        bySecurity = new Map(source.stocks.map((row) => [row.securityId,
          Object.fromEntries(highFields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]))]));
      }
      const withHighs = (snapshot) => ({ ...snapshot, stocks: snapshot.stocks.map((row) => ({
        ...row, ...bySecurity.get(row.securityId),
      })) });
      if (!engine.snapshotAvailable(enriched)) {
        persistSnapshot(db, engine, enriched, 'market', withHighs(engine.snapshot(normal, { cache: false })));
      }
      const current = engine.snapshot(normal, { velocity: true, cache: false });
      persistSnapshot(db, engine, enriched, 'market-velocity', withHighs(current));
      models.push({ model: model.id, version: model.version, reused: false });
    }
    progress((index + 1) / BUILTIN_MODELS.length);
  }
  return { models };
}

export function precomputeProduction(db, engine, config, { progress = () => {}, historySessions = 315, warmSec = true, warmHighs = true, signal } = {}) {
  if (!config.date || !config.earliestDate || config.date < config.earliestDate) throw new Error('Load prices before precomputing the production workspace');
  if (!Number.isInteger(historySessions) || historySessions < 1 || historySessions > 7560) throw new RangeError('History must contain 1–7,560 sessions');
  signal?.throwIfAborted();
  const base = viewConfig(engine, config, { includeAllTimeHigh: false });
  const monitor = viewConfig(engine, base, { breadthKeys: monitorKeys });
  const secAvailable = warmSec && (base.classification !== 'sec-sic' || base.referenceMode === 'latest') && db.prepare(`
    SELECT 1 FROM classifications WHERE system='sec-sic' AND industry IS NOT NULL AND effective_from<=?
      AND known_at<=? AND version<=? LIMIT 1`).get(base.date, base.date, base.dataVersion);
  const stages = 3 + Number(Boolean(secAvailable)) + Number(warmHighs);
  const fraction = (stage, completed) => progress((stage + completed) / stages);
  const workspace = precomputeWorkspace(db, engine, base, { allModels: true, reuseWeekly: true, progress: (p) => fraction(0, p), signal });
  const warmHistory = (point, stage) => materializeHistory(db, engine, point, {
    limit: historySessions, withRanks: true, signal, onProgress: ({ completed, total }) => {
      requireDisk(db);
      fraction(stage, total ? completed / total : 1);
    },
  });
  const standard = warmHistory(base, 1);
  signal?.throwIfAborted();
  requireDisk(db);
  engine.snapshot({ ...monitor, currentVersion: false }, { cache: false });
  const monitorHistory = warmHistory(monitor, 2);
  const sec = secAvailable ? warmHistory(viewConfig(engine, base, { classification: 'sec-sic', reference: 'as-of' }), 3) : null;
  const highs = warmHighs ? warmCurrentHighs(db, engine, base, (p) => fraction(secAvailable ? 4 : 3, p), signal) : null;
  return { date: base.date, dataVersion: base.dataVersion, calculationVersion: CALCULATION_VERSION,
    classification: base.classification, universe: base.universe.id, benchmark: base.benchmark,
    reference: base.referenceMode, observedReferenceDate: base.observedReferenceDate,
    workspace, standard, monitor: { ...monitorHistory, breadthKeys: monitor.breadthKeys }, sec, highs };
}

import { createHash } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { expectedSessions, shiftDate, weekEnd } from './calendar.mjs';
import { CALCULATION_VERSION, createJob, jobById, listWorkspace, normalizeSymbol } from './database.mjs';
import { UNIVERSES } from './engine.mjs';
import { materializeHistory } from './materialization.mjs';
import { precomputeWorkspace } from './precompute.mjs';
import { preparedSnapshotDates, readPreparedSnapshot, writePreparedSnapshot } from './prepared-snapshots.mjs';
import { readRankArchive } from './rank-archive.mjs';
import { annotateVelocity, BUILTIN_MODELS } from './ranking.mjs';
import { decodeStoredJson, encodeStoredJson } from './storage-codec.mjs';

export const preparationType = 'prepare-context';
export const recentPreparationSessions = 315;
const monitorKeys = ['up_13pct_34d', 'down_13pct_34d'];
const carryDays = 60;
const maximumSessions = 7560;
const bucketCount = 32;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const compactSchema = `
  CREATE TABLE IF NOT EXISTS prepared_rank_dates (
    recipe TEXT NOT NULL, data_version INTEGER NOT NULL, date TEXT NOT NULL, PRIMARY KEY(recipe,data_version,date)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_rank_blocks (
    recipe TEXT NOT NULL, data_version INTEGER NOT NULL, date TEXT NOT NULL, bucket INTEGER NOT NULL, value BLOB NOT NULL,
    PRIMARY KEY(recipe,data_version,date,bucket)
  ) WITHOUT ROWID;
`;

function bucketFor(id) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) % bucketCount;
}

function rankRecipe(config) {
  return digest([CALCULATION_VERSION, 'rank-block-1', config.universe.id, config.universe.version, config.model.id, config.model.version,
    config.basis, config.benchmark, config.referenceMode, config.referenceMode === 'latest' ? config.observedReferenceDate : null]);
}

function compactScope(db, config, dates) {
  const recipe = rankRecipe(config);
  const versions = db.prepare('SELECT DISTINCT data_version FROM prepared_rank_dates WHERE recipe=? AND data_version<=?')
    .all(recipe, config.dataVersion).map((row) => row.data_version);
  const bounds = reusableArchiveVersions(db, config, versions);
  const selected = new Map();
  for (const row of db.prepare(`SELECT date,data_version FROM prepared_rank_dates WHERE recipe=?
    AND date IN (SELECT value FROM json_each(?)) AND data_version IN (SELECT value FROM json_each(?))
    ORDER BY date,data_version DESC`).iterate(recipe, JSON.stringify(dates), JSON.stringify([...bounds.keys()]))) {
    if (!selected.has(row.date) && usableArchiveRow(bounds, row)) selected.set(row.date, row.data_version);
  }
  return { recipe, selected };
}

export function readPreparedRanks(db, config, dates, { securityId, symbol } = {}) {
  const observed = new Set();
  const rows = [];
  if (!dates.length || !db.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_rank_dates'").get()) return { observed, rows };
  const bySymbol = symbol ? normalizeSymbol(symbol) : null;
  const ids = securityId ? [securityId] : bySymbol ? db.prepare('SELECT DISTINCT security_id FROM identifiers WHERE symbol=?')
    .all(bySymbol).map((row) => row.security_id) : [];
  const buckets = [...new Set(ids.map(bucketFor))];
  const read = db.prepare('SELECT value FROM prepared_rank_blocks WHERE recipe=? AND data_version=? AND date=? AND bucket=?');
  for (const scope of referenceArchiveScopes(config, dates)) {
    const { recipe, selected } = compactScope(db, scope.config, scope.dates);
    for (const [date, version] of selected) {
      observed.add(date);
      for (const bucket of buckets) {
        const block = read.get(recipe, version, date, bucket);
        if (!block) continue;
        const match = decodeStoredJson(block.value).find(([id, ticker]) => securityId ? securityId === id : ticker === bySymbol);
        if (!match) continue;
        const [, , rank, percentile, score, demand, demandState] = match;
        rows.push({ date, rank, percentile, score, ...(match.length > 5 && { udv_50d: demand, udv_state_50d: demandState }),
          ...(version === config.dataVersion ? {}
          : { sourceDataVersion: version, requestedDataVersion: config.dataVersion }) });
      }
    }
  }
  return { observed, rows };
}

const rankWitnessSignature = (buckets) => createHash('sha256').update(JSON.stringify(buckets)).digest('hex');

function rankBlockEvidence(read, recipe, version, date, { values = false } = {}) {
  const buckets = [];
  const percentiles = values ? new Map() : null;
  let count = 0;
  for (const { bucket, value } of read.iterate(recipe, version, date)) {
    const rows = decodeStoredJson(value);
    if (!Array.isArray(rows) || !rows.length) throw new Error(`Empty or invalid rank block for ${date}`);
    const ids = rows.map((row) => {
      const id = row?.[0];
      if (!Array.isArray(row) || typeof id !== 'string' || !id || bucketFor(id) !== bucket) {
        throw new Error(`Rank ID is outside its bucket for ${date}`);
      }
      if (percentiles) {
        const percentile = row[3];
        if (percentile !== null && (!Number.isFinite(percentile) || percentile < 0 || percentile > 100)) {
          throw new Error(`Invalid archived stock percentile for ${date}`);
        }
        percentiles.set(id, percentile);
      }
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate traded ID in rank block for ${date}`);
    count += ids.length;
    buckets.push([bucket, ids.length, rankWitnessSignature(ids)]);
  }
  return { signature: rankWitnessSignature(buckets), blocks: buckets.length, tradedIds: count, percentiles };
}

function rankBlocks(db) {
  return db.prepare(`SELECT bucket,value FROM prepared_rank_blocks
    WHERE recipe=? AND data_version=? AND date=? ORDER BY bucket`);
}

export function verifyPreparedRankCoverage(db, config, dates, witnesses, cache = new Map()) {
  const verified = { dates: 0, blocks: 0, tradedIds: 0 };
  if (!dates.length) return verified;
  const read = rankBlocks(db);
  for (const scope of referenceArchiveScopes(config, dates)) {
    const { recipe, selected } = compactScope(db, scope.config, scope.dates);
    for (const date of scope.dates) {
      const version = selected.get(date);
      const expected = witnesses.get(date);
      if (version == null || !Array.isArray(expected)) throw new Error(`Missing rank date or traded-stock witness for ${date}`);
      const key = `${recipe}:${version}:${date}`;
      if (!cache.has(key)) cache.set(key, rankBlockEvidence(read, recipe, version, date));
      const actual = cache.get(key);
      if (actual.signature !== rankWitnessSignature(expected)) throw new Error(`Rank blocks disagree with the saved traded-stock roster for ${date}`);
      verified.dates++;
      verified.blocks += actual.blocks;
      verified.tradedIds += actual.tradedIds;
    }
  }
  return verified;
}

export function readPreparedRankPercentiles(db, config, dates, witnesses, cache = new Map()) {
  const result = new Map(dates.map((date) => [date, { state: 'unprepared', reason: 'rank_date_unprepared' }]));
  if (!dates.length || !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepared_rank_dates'").get()) return result;
  const read = rankBlocks(db);
  for (const scope of referenceArchiveScopes(config, dates)) {
    const { recipe, selected } = compactScope(db, scope.config, scope.dates);
    for (const [date, version] of selected) {
      const witness = witnesses.get(date);
      if (!Array.isArray(witness)) {
        result.set(date, { state: 'unprepared', reason: 'rank_witness_unprepared' });
        continue;
      }
      const key = `${recipe}:${version}:${date}`;
      if (!(cache.get(key)?.percentiles instanceof Map)) cache.set(key, rankBlockEvidence(read, recipe, version, date, { values: true }));
      const evidence = cache.get(key);
      if (evidence.signature !== rankWitnessSignature(witness)) {
        throw new Error(`Rank blocks disagree with the saved traded-stock roster for ${date}`);
      }
      result.set(date, { state: 'ready', recipe, dataVersion: version,
        blockCount: evidence.blocks, tradedIds: evidence.tradedIds, percentiles: evidence.percentiles });
    }
  }
  return result;
}

export function createPreparedRankWriter(db, config, dates, { codec } = {}) {
  db.exec(compactSchema);
  const addDate = db.prepare('INSERT OR IGNORE INTO prepared_rank_dates VALUES (?,?,?)');
  const addBlock = db.prepare('INSERT INTO prepared_rank_blocks VALUES (?,?,?,?,?)');
  const recipes = new Map();
  for (const scope of referenceArchiveScopes(config, dates)) {
    const recipe = rankRecipe(scope.config);
    for (const date of scope.dates) recipes.set(date, recipe);
  }
  return (snapshot) => {
    const { date } = snapshot;
    const recipe = recipes.get(date);
    if (!recipe) return;
    const nested = db.isTransaction;
    if (!nested) db.exec('BEGIN IMMEDIATE');
    try {
      const written = !!addDate.run(recipe, config.dataVersion, date).changes;
      if (written) {
        const blocks = Array.from({ length: bucketCount }, () => []);
        for (const row of snapshot.stocks) {
          if (!row.traded) continue;
          blocks[bucketFor(row.securityId)].push([row.securityId, row.symbol, row.rsRank ?? null, row.rsPercentile ?? null,
            row.rsScore ?? null, row.udv_50d ?? null, row.udv_state_50d ?? null]);
        }
        for (const [bucket, rows] of blocks.entries()) {
          if (rows.length) addBlock.run(recipe, config.dataVersion, date, bucket, encodeStoredJson(rows, codec));
        }
      }
      if (!nested) db.exec('COMMIT');
      return written;
    } catch (error) {
      if (!nested && db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
}

export function preparationInput(config) {
  return { date: config.date, dataVersion: config.dataVersion, universe: config.universe.id, universeVersion: config.universe.version,
    model: config.model.id, modelVersion: config.model.version, benchmark: config.benchmark, basis: config.basis,
    classification: config.classification, reference: config.referenceMode, observedReferenceDate: config.observedReferenceDate,
    averages: config.averages, windows: config.windows, volumeWindows: config.volumeWindows, breadthKeys: config.breadthKeys,
    includeAllTimeHigh: config.includeAllTimeHigh, threshold: config.threshold, themes: config.themes };
}

export function preparationRecipe(engine, config) {
  return digest([CALCULATION_VERSION, config.date, config.dataVersion, config.universe.id, config.universe.version,
    config.model.id, config.model.version, engine.definitionKey(config)]);
}

function monitored(engine, config) {
  return engine.context({ ...preparationInput(config), breadthKeys: monitorKeys });
}

export function registerPreparation(db, config, { followLatest = true, rangeWindows = [] } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS preparation_definitions (id TEXT PRIMARY KEY, context TEXT NOT NULL) WITHOUT ROWID`);
  const context = { ...preparationInput(config), rangeWindows };
  if (followLatest) {
    delete context.date;
    delete context.dataVersion;
    delete context.observedReferenceDate;
    delete context.themes;
  }
  const id = digest(context);
  db.prepare('INSERT OR IGNORE INTO preparation_definitions VALUES (?,?)').run(id, JSON.stringify(context));
  return id;
}

export function registeredPreparations(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='preparation_definitions'").get()) return [];
  return db.prepare('SELECT context FROM preparation_definitions ORDER BY id').all().map((row) => JSON.parse(row.context));
}

export function preparationSpecs(db, engine, input, { custom = [], requested, historySessions = maximumSessions } = {}) {
  const base = engine.context(input);
  if (!base.date || !base.earliestDate) return [];
  const targets = new Map();
  function add(config, { monitor = false, label = 'Registered calculation' } = {}) {
    if (!config.date) return;
    const recipe = preparationRecipe(engine, config);
    if (!targets.has(recipe)) targets.set(recipe, { recipe, label, config, monitor });
  }
  if (requested) {
    add(engine.context({ ...input, ...requested }));
  } else {
    const defaultUniverse = { 'us-core': 0, 'us-all': 1 };
    const universes = [...UNIVERSES.filter(({ id }) => id !== 'sample'), ...listWorkspace(db, 'universe')].toSorted((first, second) =>
      (defaultUniverse[first.id] ?? 2) - (defaultUniverse[second.id] ?? 2));
    const models = [...BUILTIN_MODELS, ...listWorkspace(db, 'ranking-model')];
    const hasSec = db.prepare("SELECT 1 FROM classifications WHERE system='sec-sic' AND industry IS NOT NULL AND version<=? LIMIT 1").get(base.dataVersion);
    for (const model of models) {
      for (const universe of universes) {
        const identity = { ...input, universe: universe.id, universeVersion: universe.version, model: model.id, modelVersion: model.version };
        add(engine.context(identity), { monitor: true, label: 'Standard' });
        if (hasSec || universe.id === 'nyse' && model.id === 'composite') add(engine.context({ ...identity,
          ...(hasSec ? { classification: 'sec-sic' } : {}), reference: 'as-of' }), { monitor: true, label: hasSec ? 'Historical SEC' : 'Dated reference' });
      }
    }
    for (const context of custom) {
      try { add(engine.context({ ...input, ...context })); }
      catch { /* A saved definition can outlive its universe or model. It must not prevent standard preparation. */ }
    }
  }
  const phases = ['current', 'recent', 'history'];
  return phases.flatMap((phase) => [...targets.values()].map(({ recipe, label, config, monitor }) => {
    const recipes = [recipe, ...(monitor ? [preparationRecipe(engine, monitored(engine, config))] : [])];
    return { phase, recipes, primary: recipe, label, context: preparationInput(config), monitor, historySessions,
      ...(phase === 'recent' ? { recentOrder: 'newest-interleaved' } : {}),
      followLatest: !requested && config.date === base.date && config.dataVersion === base.dataVersion && label !== 'Registered calculation',
      calculationVersion: CALCULATION_VERSION,
      jobKey: `${preparationType}:${recipe}:${phase}` };
  }));
}

export function batchPreparationSpecs(engine, specs) {
  const grouped = new Map();
  for (const spec of specs) {
    const { phase, context, historySessions, followLatest } = spec;
    const currentPrimary = phase === 'current' && ['us-core', 'us-all'].includes(context.universe) && context.model === 'composite' &&
      context.basis === 'reconstructed' && context.reference === 'latest';
    const key = JSON.stringify([phase, context.date, context.dataVersion, context.basis, historySessions, followLatest, currentPrimary]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(spec);
  }
  const batches = [...grouped.values()].map((members) => {
    const first = members[0];
    const variants = new Map();
    for (const spec of members) {
      const base = engine.context(spec.context);
      variants.set(spec.primary, { context: spec.context, rank: true });
      if (spec.monitor && !variants.has(spec.recipes[1])) {
        variants.set(spec.recipes[1], { context: preparationInput(monitored(engine, base)), rank: false });
      }
    }
    const recipes = [...variants.keys()];
    return { ...first, monitor: false, contexts: [...variants.values()], members: members.map(({ jobKey, context, label }) => ({ jobKey, context, label })),
      recipes, jobKey: `${preparationType}:batch:${digest(recipes.toSorted())}:${first.phase}` };
  });
  return batches;
}

export function enqueuePreparation(db, specs, { retry = false, supersedeBefore } = {}) {
  if (!specs.length) return { jobs: [], queued: 0 };
  const existing = db.prepare(`SELECT id,status,error,payload FROM jobs WHERE type=? AND json_extract(payload,'$.jobKey')=?
    ORDER BY CASE status WHEN 'complete' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, rowid DESC LIMIT 1`);
  const jobs = [];
  let queued = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (supersedeBefore != null) {
      db.prepare(`UPDATE jobs SET status='superseded',updated_at=?,error='A newer warehouse revision superseded remaining preparation'
        WHERE status='queued' AND json_extract(payload,'$.followLatest')=1
        AND json_extract(payload,'$.context.dataVersion')<?`).run(new Date().toISOString(), supersedeBefore);
    }
    for (const spec of specs) {
      const type = spec.type ?? preparationType;
      const prior = existing.get(type, spec.jobKey);
      const interrupted = prior?.status === 'failed' && prior.error === 'Workspace stopped before job completion';
      const retryable = ['failed', 'superseded'].includes(prior?.status);
      if (prior && (!retryable || !retry && !interrupted)) jobs.push(jobById(db, prior.id));
      else {
        const blockedBySpace = prior?.status === 'failed' && prior.error?.startsWith('Not enough free disk space to prepare this calculation while preserving ');
        let payload = spec;
        if (interrupted || blockedBySpace) {
          const checkpoint = JSON.parse(prior.payload);
          const { cursor, completedSessions, written, reused, elapsedMs, totals, baseComplete, ...plan } = checkpoint;
          // The recipe key is also used for requests with different history lengths or variant orders.
          if (isDeepStrictEqual(plan, JSON.parse(JSON.stringify(spec)))) payload = checkpoint;
        }
        jobs.push(createJob(db, type, payload));
        queued++;
      }
    }
    db.exec('COMMIT');
    return { jobs, queued };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function preparationSuperseded(db, spec) {
  if (!spec.followLatest) return false;
  return !!db.prepare(`SELECT 1 FROM jobs WHERE type=? AND json_extract(payload,'$.followLatest')=1
    AND json_extract(payload,'$.context.dataVersion')>? LIMIT 1`).get(preparationType, spec.context.dataVersion);
}

export function preparationStatus(db, engine, config, phases) {
  const keys = [preparationRecipe(engine, config)];
  const filters = Array.isArray(phases) ? phases : [phases];
  if (!filters.includes('current') && config.date < config.latestDate) {
    keys.push(preparationRecipe(engine, { ...config, date: config.latestDate }));
  }
  const jobs = db.prepare(`SELECT id,status,progress,error,payload,result FROM jobs WHERE type=?
    AND json_extract(payload,'$.phase') IN (SELECT value FROM json_each(?))
    AND EXISTS (SELECT 1 FROM json_each(json_extract(payload,'$.recipes'))
      WHERE value IN (SELECT value FROM json_each(?)))
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
      CASE json_extract(payload,'$.phase') WHEN 'current' THEN 0 WHEN 'recent' THEN 1 ELSE 2 END,rowid DESC`)
    .all(preparationType, JSON.stringify(filters), JSON.stringify(keys));
  const row = jobs[0];
  if (!row) return { preparationState: 'unregistered', context: preparationInput(config) };
  const { phase, label } = JSON.parse(row.payload);
  const detail = row.result ? JSON.parse(row.result) : {};
  const waiting = ['queued','running'].includes(row.status);
  return { preparationState: row.status, phase, label, ...(waiting ? { pending: true, jobId: row.id, status: row.status } : {}),
    progress: row.progress, completedSessions: detail.completedSessions ?? 0, totalSessions: detail.totalSessions ?? null, error: row.error || null };
}

export function requirePreparationSpace(db, dates = 1, { statfs = statfsSync } = {}) {
  const location = db.location();
  if (!location) return;
  const { bavail, bsize } = statfs(dirname(location), { bigint: true });
  const available = bavail * bsize;
  const priced = BigInt(db.prepare('SELECT count(first_seen) AS count FROM securities').get().count);
  const growth = BigInt(dates) * priced * 160n;
  const warehouseReserve = 2n * 1024n ** 3n;
  // Allow for the batch's new pages and a matching set in the WAL during checkpointing.
  // The backup job checks staging and compression space when it runs.
  const required = warehouseReserve + 2n * growth;
  if (available < required) {
    throw new Error(`Not enough free disk space to prepare this calculation while preserving warehouse and WAL headroom (need ${required} bytes, available ${available} bytes)`);
  }
}

export function compactWeeklySnapshot(snapshot) {
  return {
    stocks: snapshot.stocks.map(({ securityId, rsRank, rsPercentile, rsScore, udv_50d, up_volume_50d }) =>
      ({ securityId, rsRank, rsPercentile, rsScore, udv_50d, up_volume_50d })),
    groups: snapshot.groups.map(({ id, rank, percentile, above50, medianRS, topDecile, relativeReturn }) =>
      ({ id, rank, percentile, above50, medianRS, topDecile, relativeReturn })),
  };
}

function warmBatch(db, engine, config, dates, rank) {
  const window = { from: dates[0], to: dates.at(-1), limit: dates.length };
  const legacy = rank ? readRankArchive(db, engine, config, window).observed : new Set(dates);
  const compact = rank ? readPreparedRanks(db, config, dates).observed : new Set(dates);
  const missingRanks = new Set(dates.filter((date) => !legacy.has(date) && !compact.has(date)));
  const addRank = missingRanks.size ? createPreparedRankWriter(db, config, dates) : null;
  const dated = new Map();
  const missingRows = new Set();
  const missingVelocity = new Set();
  for (const scope of referenceArchiveScopes(config, dates)) {
    const base = preparedSnapshotDates(db, engine, scope.config, scope.dates);
    const velocity = rank ? preparedSnapshotDates(db, engine, scope.config, scope.dates, { velocity: true }) : null;
    for (const date of scope.dates) {
      dated.set(date, { ...scope.config, date, requestedDate: date });
      if (!base.has(date)) missingRows.add(date);
      if (velocity && !velocity.has(date)) missingVelocity.add(date);
    }
  }
  const weekly = new Map();
  const baseline = (date) => {
    if (!date || date < config.earliestDate) return { stocks: [], groups: [] };
    if (!weekly.has(date)) {
      const point = dated.get(date) || { ...config, referenceMode: 'as-of', date, requestedDate: date };
      const snapshot = readPreparedSnapshot(db, engine, point) || engine.snapshot(point, { persist: false, cache: false });
      weekly.set(date, compactWeeklySnapshot(snapshot));
    }
    return weekly.get(date);
  };
  const persist = (snapshot) => {
    const date = snapshot.date;
    const point = dated.get(date);
    if (!point) return;
    if (missingRanks.delete(date)) addRank(snapshot);
    if (missingRows.delete(date)) writePreparedSnapshot(db, engine, point, snapshot);
    if (missingVelocity.delete(date)) {
      const end = weekEnd(date);
      const prior = Array.from({ length: 12 }, (_, index) => {
        const week = shiftDate(end, -7 * (index + 1));
        return baseline(expectedSessions(shiftDate(week, -4), week).at(-1));
      });
      const enriched = { ...snapshot, ...(snapshot.dataVersion === point.dataVersion ? {} : { dataVersion: point.dataVersion,
        sourceDataVersion: snapshot.sourceDataVersion ?? snapshot.dataVersion }),
        stocks: snapshot.stocks.map((row) => ({ ...row })), groups: snapshot.groups.map((row) => ({ ...row })) };
      annotateVelocity(enriched, prior);
      writePreparedSnapshot(db, engine, point, enriched, { velocity: true });
    }
  };
  const wrap = { ...engine, snapshot(point, options) {
    const scoped = dated.get(point.date);
    const snapshot = scoped && readPreparedSnapshot(db, engine, scoped) || engine.snapshot(point, options);
    persist(snapshot);
    return snapshot;
  } };
  const report = materializeHistory(db, wrap, config, window);
  const missing = dates.filter((date) => missingRows.has(date) || missingRanks.has(date) || missingVelocity.has(date));
  if (missing.length) {
    const timeline = engine.historyBatch(config, [...missing]);
    for (const date of missing) {
      const snapshot = readPreparedSnapshot(db, engine, dated.get(date)) ||
        engine.snapshot({ ...timeline, date, requestedDate: date }, { persist: false, cache: false });
      persist(snapshot);
    }
  }
  return report;
}

export function runPreparation(db, engine, spec, progress = () => {}) {
  const config = engine.context(spec.context);
  if (spec.phase === 'current') {
    requirePreparationSpace(db);
    const workspace = engine.snapshotAvailable(config, { velocity: true }) ? { reused: true }
      : precomputeWorkspace(db, engine, config, { reuseWeekly: true, progress: (value) => progress(value * 0.85) });
    if (spec.monitor) {
      const monitor = monitored(engine, config);
      if (!engine.snapshotAvailable(monitor)) engine.snapshot(monitor, { cache: false });
    }
    progress(1);
    return { workspace, date: config.date, dataVersion: config.dataVersion, completedSessions: 1, totalSessions: 1 };
  }
  const sessions = expectedSessions(config.earliestDate, config.date).slice(-(spec.phase === 'recent' ? recentPreparationSessions : spec.historySessions));
  const variants = [config, ...(spec.monitor ? [monitored(engine, config)] : [])];
  const completed = spec.completedSessions ?? 0;
  const total = sessions.length * variants.length;
  let index = Math.floor(completed / sessions.length);
  const start = completed % sessions.length;
  let dates = sessions.slice(start, start + carryDays);
  const recentOrder = spec.phase === 'recent' && (spec.recentOrder || completed === 0 && 'newest-interleaved');
  if (recentOrder === 'newest-interleaved') {
    const batches = [];
    for (let end = sessions.length; end > 0; end -= carryDays) {
      for (const [variant] of variants.entries()) batches.push({ variant, days: sessions.slice(Math.max(0, end - carryDays), end) });
    }
    let offset = 0;
    const selected = batches.find(({ days }) => {
      if (offset === completed) return true;
      offset += days.length;
      return false;
    });
    if (!selected) throw new Error('Invalid recent preparation checkpoint');
    index = selected.variant;
    dates = selected.days;
  }
  requirePreparationSpace(db, dates.length);
  const started = Date.now();
  const batch = warmBatch(db, engine, variants[index], dates, index === 0);
  const next = completed + dates.length;
  const elapsedMs = (spec.elapsedMs ?? 0) + Date.now() - started;
  progress(next / total);
  return { date: config.date, dataVersion: config.dataVersion, completedSessions: next, totalSessions: total,
    written: (spec.written ?? 0) + batch.written, reused: (spec.reused ?? 0) + batch.skipped,
    batch: { from: dates[0], to: dates.at(-1), sessions: dates.length, standard: index === 0,
      baseComplete: index === 0 && completed + dates.length === sessions.length },
    estimatedRemainingSeconds: next ? Math.ceil(elapsedMs / next * (total - next) / 1000) : null,
    ...(next < total ? { continuation: { completedSessions: next, written: (spec.written ?? 0) + batch.written,
      reused: (spec.reused ?? 0) + batch.skipped, elapsedMs, ...(recentOrder && { recentOrder }) } } : {}) };
}

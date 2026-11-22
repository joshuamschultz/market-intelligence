import { referenceArchiveScopes } from './archive-lineage.mjs';
import { performance } from 'node:perf_hooks';
import { expectedSessions, shiftDate, weekEnd } from './calendar.mjs';
import { createMaterializedHistoryWriter } from './materialization.mjs';
import { compactWeeklySnapshot, createPreparedRankWriter, preparationInput, readPreparedRanks, recentPreparationSessions, requirePreparationSpace } from './preparation.mjs';
import { preparedSnapshotDates, readPreparedSnapshot, writePreparedSnapshotBatch } from './prepared-snapshots.mjs';
import { readRankArchive } from './rank-archive.mjs';
import { annotateGroupVelocity, annotateVelocity, createStockVelocityLayer, topDecileIds } from './ranking.mjs';

const emptyWeek = { stocks: [], groups: [] };
const weeklyFields = ['rsRank', 'rsPercentile', 'rsScore', 'udv_50d', 'up_volume_50d'];
const currentVelocityFields = [...weeklyFields, 'new_high_252d', 'return_21d', 'return_63d', 'return_252d', 'udv_state_50d'];

function calculationKey(engine, config, date) {
  const scope = referenceArchiveScopes(config, [date])[0].config;
  return JSON.stringify([scope.dataVersion, scope.basis, scope.universe.id, scope.universe.version,
    scope.model.id, scope.model.version, engine.definitionKey(scope)]);
}

function dateDependencies(dates) {
  return new Map(dates.map((date) => {
    const lastWeek = weekEnd(date);
    const weekly = Array.from({ length: 12 }, (_, index) => {
      const end = shiftDate(lastWeek, -7 * (index + 1));
      return expectedSessions(shiftDate(end, -4), end).at(-1);
    });
    const previous = expectedSessions(shiftDate(date, -12), shiftDate(date, -1)).at(-1);
    return [date, { weekly, previous }];
  }));
}

export function preparationSeedKey(engine, config, kind, date) {
  return JSON.stringify([kind, date, calculationKey(engine, config, date)]);
}

export function preparationDependencies(configurations, dates) {
  const requests = [];
  const dependencies = dateDependencies(dates);
  const inBatch = new Set(dates);
  for (const input of configurations) {
    const { config, rank = true, historyOnly = false } = input.config ? input : { config: input };
    const weekDates = new Set();
    const previousDates = new Set();
    for (const date of dates) {
      if (date < config.earliestDate || date > config.date) continue;
      const { previous, weekly } = dependencies.get(date);
      if (previous >= config.earliestDate && !inBatch.has(previous)) previousDates.add(previous);
      if (rank && !historyOnly) for (const week of weekly) if (week >= config.earliestDate && !inBatch.has(week)) weekDates.add(week);
    }
    for (const date of previousDates) requests.push({ config, kind: 'leaders', date });
    for (const date of weekDates) requests.push({ config, kind: 'weekly', date });
  }
  return requests;
}

function equalStockInputs(left, right, fields) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a.securityId !== b.securityId) return false;
    for (const field of fields) if (!Object.is(a[field], b[field])) return false;
  }
  return true;
}

function sameWeeklyStocks(left, right, checked) {
  if (left === right) return true;
  if (!checked.has(left)) checked.set(left, new WeakMap());
  const matches = checked.get(left);
  if (!matches.has(right)) matches.set(right, equalStockInputs(left.stocks, right.stocks, weeklyFields));
  return matches.get(right);
}

function rankedSnapshot(snapshot, stockRows, weekly, velocityLayer) {
  const enriched = { ...snapshot, groups: snapshot.groups.map((row) => ({ ...row })) };
  enriched.stocks = snapshot.stocks.map((stock, index) => {
    const base = stockRows?.[index]?.base;
    return base ? Object.create(stock) : { ...stock };
  });
  if (velocityLayer) annotateGroupVelocity(enriched, weekly, { memoizeWeeks: true });
  else annotateVelocity(enriched, weekly, { memoizeWeeks: true });
  return { snapshot: enriched, stockRows: stockRows?.map((parts, index) => ({ ...parts,
    parent: parts.base ? parts.overrides ?? snapshot.stocks[index] : null,
    ...(velocityLayer && { velocity: velocityLayer.get(snapshot.stocks[index].securityId) }),
    overrides: enriched.stocks[index] })), membership: snapshot.stocks };
}

// The producer and SQLite writer run in one backpressured loop. Only one
// session's complete context projections are held while its products commit.
export function prepareBatchedSnapshots(db, engine, configurations, {
  dates, signal, onProgress, tileSize, codec, dependencyProvider, requireDependencySeeds = false,
} = {}) {
  if (!Array.isArray(dates) || dates.some((date, index) => index > 0 && date <= dates[index - 1])) {
    throw new RangeError('Preparation requires ascending unique session dates');
  }
  const totals = { sessions: dates.length, contexts: configurations.length, written: { base: 0, velocity: 0, rank: 0, history: 0 },
    reused: { base: 0, velocity: 0, rank: 0, history: 0 }, producedSessions: 0, producedContexts: 0, commits: 0,
    calculationMs: 0, projectionMs: 0, storageMs: 0, velocityLayersWritten: 0, velocityLayersReused: 0,
    seededWeeks: 0, seededLeaderDays: 0 };
  if (!dates.length || !configurations.length) return totals;
  if (db.isTransaction) throw new Error('Batch preparation requires an idle SQLite writer connection');
  signal?.throwIfAborted();
  const dependencies = dateDependencies(dates);
  const inBatch = new Set(dates);
  const producedDates = new Set();
  function seed(config, kind, date) {
    if (inBatch.has(date)) return undefined;
    const value = dependencyProvider?.({ config, kind, date });
    if (value == null && requireDependencySeeds) throw new Error(`Missing preparation ${kind} seed for ${date}`);
    if (value != null && (kind === 'weekly' ? !Array.isArray(value.stocks) || !Array.isArray(value.groups) : !Array.isArray(value))) {
      throw new Error(`Invalid preparation ${kind} seed for ${date}`);
    }
    return value;
  }
  const plans = configurations.map((input) => {
    const { config, rank = true, historyOnly = false } = input.config ? input : { config: input };
    const targetDates = dates.filter((date) => date >= config.earliestDate && date <= config.date);
    const thin = createMaterializedHistoryWriter(db, engine, config, targetDates, { codec, shareGroups: true });
    const base = historyOnly ? new Map() : preparedSnapshotDates(db, engine, config, targetDates);
    const ranks = rank && !historyOnly;
    const velocity = ranks ? preparedSnapshotDates(db, engine, config, targetDates, { velocity: true }) : new Map();
    const compact = ranks ? readPreparedRanks(db, config, targetDates).observed : new Set();
    const previous = new Set();
    const weeklyRefs = new Map();
    const missing = new Map();
    let addRank;
    if (ranks && targetDates.length) {
      const legacy = readRankArchive(db, engine, config, { from: targetDates[0], to: targetDates.at(-1), limit: 7560 }).observed;
      for (const date of legacy) compact.add(date);
    }
    for (const date of targetDates) {
      const eligible = { base: !historyOnly, velocity: ranks, rank: ranks, history: true };
      const needs = { base: eligible.base && !base.has(date), velocity: eligible.velocity && !velocity.has(date),
        rank: eligible.rank && !compact.has(date), history: !thin.has(date) };
      for (const product of Object.keys(needs)) if (eligible[product] && !needs[product]) totals.reused[product]++;
      if (Object.values(needs).every((needed) => !needed)) continue;
      missing.set(date, needs);
      producedDates.add(date);
      const anchor = dependencies.get(date);
      if (needs.history && anchor.previous >= config.earliestDate) previous.add(anchor.previous);
      if (needs.velocity) for (const week of anchor.weekly) {
        if (week >= config.earliestDate) weeklyRefs.set(week, (weeklyRefs.get(week) ?? 0) + 1);
      }
    }
    if ([...missing.values()].some((needs) => needs.rank)) addRank = createPreparedRankWriter(db, config, targetDates, { codec });
    const leaderRefs = thin.previousLeaders([...previous]);
    const archivedWeeks = preparedSnapshotDates(db, engine, config, [...weeklyRefs.keys()]);
    const weeks = new Map();
    for (const date of previous) if (!leaderRefs.has(date)) {
      const value = seed(config, 'leaders', date);
      if (value != null) {
        leaderRefs.set(date, value);
        totals.seededLeaderDays++;
      } else producedDates.add(date);
    }
    for (const date of weeklyRefs.keys()) if (!archivedWeeks.has(date)) {
      const value = seed(config, 'weekly', date);
      if (value != null) {
        weeks.set(date, value);
        totals.seededWeeks++;
      } else producedDates.add(date);
    }
    return { config, thin, addRank, ranks, missing, leaderRefs, previous, archivedWeeks, weeklyRefs, weeks };
  });

  function weeklySnapshot(plan, date) {
    if (!plan.weeklyRefs.has(date)) return emptyWeek;
    if (!plan.weeks.has(date)) {
      const stored = plan.archivedWeeks.has(date) && readPreparedSnapshot(db, engine, { ...plan.config, date, requestedDate: date },
        { stockFields: weeklyFields });
      if (!stored) throw new Error(`Missing shared weekly snapshot for ${date}`);
      plan.weeks.set(date, compactWeeklySnapshot(stored));
    }
    const week = plan.weeks.get(date);
    const count = plan.weeklyRefs.get(date);
    if (count === 1) {
      plan.weeklyRefs.delete(date);
      plan.weeks.delete(date);
    } else plan.weeklyRefs.set(date, count - 1);
    return week;
  }

  const produced = [...producedDates].sort();
  const checkedWeeks = new WeakMap();
  const work = new Map(produced.map((date) => {
    const owners = new Map();
    const assignments = new Map();
    for (const [index, plan] of plans.entries()) {
      const needed = plan.missing.has(date) || plan.previous.has(date) && !plan.leaderRefs.has(date) ||
        plan.weeklyRefs.has(date) && !plan.archivedWeeks.has(date) && !plan.weeks.has(date);
      if (!needed) continue;
      const key = calculationKey(engine, plan.config, date);
      if (!owners.has(key)) owners.set(key, index);
      assignments.set(index, owners.get(key));
    }
    return [date, { assignments, producers: new Set(owners.values()) }];
  }));
  let cursor = 0;
  let previous = performance.now();
  const shouldBuild = (_config, index, date) => work.get(date)?.producers.has(index) ?? false;
  for (const point of engine.batchSnapshots(plans.map(({ config }) => config), { dates: produced, signal, tileSize, sparseRows: true, shouldBuild })) {
    const projectedAt = performance.now();
    totals.calculationMs += projectedAt - previous;
    signal?.throwIfAborted();
    const expected = produced[cursor++];
    const { assignments, producers } = work.get(expected) ?? {};
    if (point.date !== expected || point.results.length !== producers.size) throw new Error('Batch producer returned an unexpected session or context count');
    totals.producedSessions++;
    totals.producedContexts += point.results.length;
    const date = point.date;
    const results = new Map(point.results.map((result) => [result.contextIndex, result]));
    const snapshots = new Map();
    const velocityLayers = new Map();
    const pending = [];
    for (const [index, owner] of assignments) {
      const result = results.get(owner);
      if (!result) throw new Error('Batch producer omitted an assigned calculation context');
      const { config: sourceConfig, snapshot, stockRows } = result;
      const plan = plans[index];
      if (sourceConfig.date !== date || snapshot.date !== date || sourceConfig.basis !== plan.config.basis || sourceConfig.dataVersion !== plan.config.dataVersion) {
        throw new Error('Batch producer returned an inconsistent pinned snapshot');
      }
      const config = owner === index ? sourceConfig : { ...plan.config, date, requestedDate: date, currentVersion: false };
      if (plan.previous.has(date) && !plan.leaderRefs.has(date)) plan.leaderRefs.set(date, topDecileIds(snapshot));
      if (plan.weeklyRefs.has(date)) plan.weeks.set(date, compactWeeklySnapshot(snapshot));
      const needs = plan.missing.get(date);
      if (!needs) continue;
      const axis = JSON.stringify([config.dataVersion, config.basis]);
      if (!snapshots.has(axis)) snapshots.set(axis, []);
      const entries = snapshots.get(axis);
      if (needs.base) entries.push({ config, snapshot, stockRows, rankWitness: plan.ranks });
      if (needs.velocity) {
        const weeks = dependencies.get(date).weekly.map((week) => weeklySnapshot(plan, week));
        let layer;
        if (stockRows?.length && stockRows.every((part) => part.baseAfter === 0 && part.base?.securityId)) {
          const identity = calculationKey(engine, { ...config, classification: null }, date);
          if (!velocityLayers.has(identity)) velocityLayers.set(identity, []);
          const candidates = velocityLayers.get(identity);
          const prior = candidates.find((item) => weeks.every((week, index) => sameWeeklyStocks(week, item.weeks[index], checkedWeeks)) &&
            equalStockInputs(snapshot.stocks, item.stocks, currentVelocityFields));
          if (prior) {
            layer = prior.layer;
            totals.velocityLayersReused++;
          } else {
            layer = createStockVelocityLayer(snapshot.stocks, weeks, { memoizeWeeks: true });
            candidates.push({ stocks: snapshot.stocks, weeks, layer });
            totals.velocityLayersWritten++;
          }
        }
        entries.push({ config, ...rankedSnapshot(snapshot, stockRows, weeks, layer), velocity: true });
      }
      pending.push({ snapshot, plan, needs });
    }
    if (!pending.length) {
      onProgress?.({ ...totals, date, fraction: cursor / produced.length });
      previous = performance.now();
      continue;
    }
    const storageAt = performance.now();
    totals.projectionMs += storageAt - projectedAt;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entries of snapshots.values()) {
        const manifests = writePreparedSnapshotBatch(db, engine, entries, { codec });
        for (const [index, manifest] of manifests.entries()) {
          totals[manifest.written ? 'written' : 'reused'][entries[index].velocity ? 'velocity' : 'base']++;
        }
      }
      for (const { snapshot, plan, needs } of pending) {
        if (needs.rank) totals[plan.addRank(snapshot) ? 'written' : 'reused'].rank++;
        if (needs.history) {
          const { previous } = dependencies.get(date);
          const leaders = plan.leaderRefs.get(previous);
          if (previous >= plan.config.earliestDate && leaders == null) throw new Error(`Missing prior leadership snapshot for ${previous}`);
          totals[plan.thin.write(snapshot, previous, leaders) ? 'written' : 'reused'].history++;
          plan.leaderRefs.delete(previous);
        }
      }
      signal?.throwIfAborted();
      db.exec('COMMIT');
      totals.commits++;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    totals.storageMs += performance.now() - storageAt;
    onProgress?.({ ...totals, date, fraction: cursor / produced.length });
    previous = performance.now();
  }
  if (cursor !== produced.length) throw new Error('Batch producer omitted a requested market session');
  if (!produced.length) onProgress?.({ ...totals, date: dates.at(-1), fraction: 1 });
  return totals;
}

export function runBatchPreparation(db, engine, spec, progress = () => {}) {
  const configs = spec.contexts.map((item) => ({ config: engine.context(item.context), rank: item.rank }));
  const point = configs[0].config;
  const limit = spec.phase === 'current' ? 1 : spec.phase === 'recent' ? recentPreparationSessions : spec.historySessions;
  const sessions = expectedSessions(point.earliestDate, point.date).slice(-limit);
  const completed = spec.completedSessions ?? 0;
  const size = spec.batchSize ?? 60;
  const end = sessions.length - completed;
  const dates = spec.phase === 'recent' ? sessions.slice(Math.max(0, end - size), end) : sessions.slice(completed, completed + size);
  requirePreparationSpace(db, dates.length);
  const started = Date.now();
  let checked = 0;
  const batch = prepareBatchedSnapshots(db, engine, configs, { dates, onProgress: ({ commits, fraction }) => {
    if (commits >= checked + 4 && commits < dates.length) {
      requirePreparationSpace(db, Math.min(4, dates.length - commits));
      checked = commits;
    }
    progress(sessions.length ? (completed + fraction * dates.length) / sessions.length : 1);
  } });
  const next = completed + dates.length;
  const elapsedMs = (spec.elapsedMs ?? 0) + Date.now() - started;
  const totals = { ...spec.totals };
  for (const key of ['written', 'reused']) {
    totals[key] ??= {};
    for (const [product, count] of Object.entries(batch[key])) totals[key][product] = (totals[key][product] ?? 0) + count;
  }
  progress(sessions.length ? next / sessions.length : 1);
  return { date: point.date, dataVersion: point.dataVersion, context: preparationInput(point),
    completedSessions: next, totalSessions: sessions.length, batch, totals, from: dates[0] ?? null, to: dates.at(-1) ?? null,
    estimatedRemainingSeconds: next ? Math.ceil(elapsedMs / next * (sessions.length - next) / 1000) : 0,
    ...(next < sessions.length ? { continuation: { completedSessions: next, totals, elapsedMs } } : {}) };
}

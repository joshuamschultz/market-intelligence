import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from '../backend/archive-lineage.mjs';
import { prepareBatchedSnapshots } from '../backend/batch-preparation.mjs';
import { expectedSessions, shiftDate } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, listWorkspace, openDatabase } from '../backend/database.mjs';
import { readMaterializedHistory } from '../backend/materialization.mjs';
import { batchPreparationSpecs, preparationSpecs, verifyPreparedRankCoverage } from '../backend/preparation.mjs';
import { readPreparedDetail } from '../backend/prepared-details.mjs';
import { preparedSnapshotDates, readPreparedSnapshot, readPreparedSnapshotRankWitnesses } from '../backend/prepared-snapshots.mjs';
import { verifyPreparedExactRanges, verifyPreparedRangeHistory } from '../backend/range-metrics.mjs';
import { DEFAULT_HEALTH_MODEL } from '../backend/research.mjs';
import { normalizeRiskBenchmarks, normalizeRiskWindows, readRiskHistory, riskHistoryManifest } from '../backend/risk-history.mjs';
import { preparationWorkspaceScopes, rangeContext, summationContext } from '../backend/service.mjs';
import { decodeStoredJson } from '../backend/storage-codec.mjs';
import { readPreparedSummation } from '../backend/summation.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name);

export function benchmarkContexts(source, engine, point, scopes = preparationWorkspaceScopes(source, engine, { date: point.date, version: point.dataVersion }),
  { contextLimit = 1000, observedReferenceDate } = {}) {
  const { custom, rangeInputs } = scopes;
  const base = { ...scopes.base, ...(observedReferenceDate && { observedReferenceDate }) };
  const specs = preparationSpecs(source, engine, base, { custom }).filter(({ phase }) => phase === 'history');
  const available = batchPreparationSpecs(engine, specs).flatMap(({ contexts }) => contexts);
  const variants = available.slice(0, contextLimit);
  const ranges = new Map();
  for (const input of rangeInputs) {
    if (!input.rangeWindows?.length) continue;
    let config;
    try { config = rangeContext(engine, engine.context({ ...base, ...input })); } catch { continue; }
    if (!config.date) continue;
    const reference = config.referenceMode === 'latest' && config.date === config.latestDate ? config.observedReferenceDate : null;
    const key = JSON.stringify([config.date, config.dataVersion, config.basis, reference]);
    if (!ranges.has(key)) ranges.set(key, { config, windows: new Set() });
    for (const window of input.rangeWindows) ranges.get(key).windows.add(window);
  }
  const rangePlans = [...ranges.values()].map(({ config, windows }) => ({ config, windows: [...windows].sort((a, b) => a - b) }));
  return { configs: variants.map(({ context, rank }) => ({ config: engine.context(context), rank })),
    availableContexts: available.length,
    rangePlans, rangeWindows: [...new Set(rangePlans.flatMap(({ windows }) => windows))].sort((a, b) => a - b),
    riskWindows: normalizeRiskWindows([...normalizeRiskWindows(), ...listWorkspace(source, 'stock-detail-preparation').map(({ definition }) => definition.lookback)]),
    benchmarks: normalizeRiskBenchmarks(listWorkspace(source, 'stock-detail-preparation').map(({ definition }) => definition.benchmark), point.benchmark) };
}

export function exactRangePlans(recipes, point, dates) {
  const measured = new Set(dates);
  return recipes.rangePlans.filter(({ config }) => config.basis !== 'reconstructed' ||
    config.dataVersion !== point.dataVersion || !measured.has(config.date));
}

export function benchmarkRecipeDigest(recipes, dates, prerequisites, { scope = 'all', calibration = 'full' } = {}) {
  return createHash('sha256').update(JSON.stringify({ calculationVersion: CALCULATION_VERSION,
    recipes, dates, prerequisites, scope, calibration })).digest('hex');
}

function verifyInstrumentRoster(target, source, config, dates, recipes, report) {
  const roster = source.prepare(`SELECT id FROM securities WHERE EXISTS
    (SELECT 1 FROM price_revisions WHERE security_id=securities.id AND version<=? AND date<=? LIMIT 1) ORDER BY id`)
    .all(config.dataVersion, config.date).map(({ id }) => id);
  const products = target.prepare(`SELECT security_id, blocks FROM prepared_detail_products
    WHERE calculation_version=? AND basis=? AND data_version=? AND anchor_date=? ORDER BY security_id`);
  const hasBlock = target.prepare('SELECT 1 FROM prepared_detail_blocks WHERE hash=?');
  const linked = new Set();
  let observed = 0;
  for (const { security_id: id, blocks } of products.iterate(CALCULATION_VERSION, config.basis, config.dataVersion, config.date)) {
    if (id !== roster[observed++]) throw new Error('Prepared ticker detail roster differs from the pinned price source');
    const manifest = decodeStoredJson(blocks);
    if (!Array.isArray(manifest)) throw new Error(`Invalid chart block manifest for ${id}`);
    for (const block of manifest) {
      if (linked.has(block.hash)) continue;
      if (!hasBlock.get(block.hash)) throw new Error(`Missing ticker detail chart block for ${id}`);
      linked.add(block.hash);
    }
  }
  if (observed !== roster.length) throw new Error(`Prepared ticker detail roster is incomplete: ${observed}/${roster.length}`);
  const risk = riskHistoryManifest(target, report.risk.runId);
  const riskDates = dates.filter((date) => date >= report.riskFrom);
  const benchmarks = [...recipes.benchmarks].sort();
  const riskKeyCount = roster.length * riskDates.length * recipes.riskWindows.length * benchmarks.length;
  const riskBlockCount = roster.length * (1 + benchmarks.length);
  if (!risk?.done || risk.calculationVersion !== CALCULATION_VERSION || risk.basis !== config.basis || risk.dataVersion !== config.dataVersion ||
      risk.date !== config.date || riskDates.join() !== risk.dates.join() || recipes.riskWindows.join() !== risk.windows.join() ||
      benchmarks.join() !== risk.benchmarks.join() || risk.actualSecurities !== roster.length || risk.totalSecurities !== roster.length ||
      risk.processedSecurities !== roster.length || risk.actualBlocks !== riskBlockCount || risk.riskBlocks !== riskBlockCount ||
      risk.expectedBlocks !== riskBlockCount || risk.expectedKeys !== riskKeyCount || risk.riskKeys + risk.basisExclusions !== riskKeyCount) {
    throw new Error('Prepared risk archive differs from its pinned roster, date, or coverage manifest');
  }
  const roles = ['', ...benchmarks];
  let riskRows = 0;
  for (const row of target.prepare(`SELECT security_id,benchmark FROM prepared_risk_history_blocks
    WHERE run_id=? ORDER BY security_id,benchmark`).iterate(risk.runId)) {
    if (row.security_id !== roster[Math.floor(riskRows / roles.length)] || row.benchmark !== roles[riskRows % roles.length]) {
      throw new Error('Prepared risk blocks do not match every pinned security/benchmark key');
    }
    riskRows++;
  }
  if (riskRows !== riskBlockCount) throw new Error('Prepared risk blocks are incomplete');
  return { risk, detailProducts: observed, detailChartBlocks: linked.size };
}

export function verifyInstrumentProducts(target, source, engine, point, dates, recipes, instrumentReport) {
  const config = { ...point, referenceMode: 'as-of' };
  const coverage = { pairs: 0, emptyPairs: 0, runs: 0, blocks: 0 };
  for (let start = 0; start < recipes.rangeWindows.length; start += 16) {
    const report = verifyPreparedRangeHistory(target, config, dates, recipes.rangeWindows.slice(start, start + 16), { sourceDb: source });
    for (const [key, value] of Object.entries(report)) coverage[key] += value;
  }
  if (coverage.pairs !== dates.length * recipes.rangeWindows.length) throw new Error('Required range date/window coverage is incomplete');
  coverage.exactPairs = 0;
  for (const { config, windows } of exactRangePlans(recipes, point, dates)) {
    for (let start = 0; start < windows.length; start += 16) {
      coverage.exactPairs += verifyPreparedExactRanges(target, config, windows.slice(start, start + 16));
    }
  }
  coverage.windows = recipes.rangeWindows;
  const sample = engine.findSecurity(config, config.benchmark);
  const id = sample?.id ?? sample?.securityId;
  const detail = id && readPreparedDetail(target, config, id);
  if (!detail?.detail && !detail?.chartBars) throw new Error('Reopened stock detail sample is unavailable');
  const riskSample = readRiskHistory(target, config, id, { lookback: recipes.riskWindows[0] });
  if (riskSample.state !== 'ready') throw new Error('Reopened risk sample is unavailable');
  return { ...verifyInstrumentRoster(target, source, config, dates, recipes, instrumentReport), ranges: coverage };
}

export function dateTiles(dates, size) {
  return Array.from({ length: Math.ceil(dates.length / size) }, (_, index) => dates.slice(index * size, (index + 1) * size));
}

// These are the manifest keys used by the frozen thin-history and health writers.
// Recovery must access them without calling either writer on the archive.
function thinKey(db, engine, config) {
  const themes = config.themes ?? listWorkspace(db, 'theme');
  return [`${config.universe.id}@${config.universe.version}`, `${config.model.id}@${config.model.version}`, CALCULATION_VERSION,
    digest([2, engine.definitionKey({ ...config, themes, currentVersion: false })])];
}

function thinDateRows(db, engine, config, dates, { exact = false, values = false } = {}) {
  const result = new Map();
  const columns = values ? 'date,data_version,value' : 'date,data_version';
  const byDate = db.prepare(`SELECT ${columns} FROM market_history WHERE universe=? AND model=?
    AND calculation_version=? AND definition_key=? AND data_version=? AND date=?`);
  const versions = exact ? null : db.prepare(`SELECT DISTINCT data_version FROM market_history WHERE universe=? AND model=?
    AND calculation_version=? AND definition_key=? AND data_version<=?`);
  for (const scope of referenceArchiveScopes(config, dates)) {
    const key = thinKey(db, engine, scope.config);
    const bounds = versions ? reusableArchiveVersions(db, scope.config, versions.all(...key, config.dataVersion).map(({ data_version }) => data_version))
      : new Map([[config.dataVersion, null]]);
    for (const date of scope.dates) {
      for (const version of bounds.keys()) {
        const row = byDate.get(...key, version, date);
        if (!row || !usableArchiveRow(bounds, row)) continue;
        result.set(date, row);
        break;
      }
    }
  }
  return result;
}

function snapshotBucket(id) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) % 32;
}

function verifyFrameLinks(reader, configurations, dates) {
  if (configurations.every(({ historyOnly }) => historyOnly)) return;
  const axis = 'calculation_version=? AND data_version=? AND basis=? AND date=?';
  const contexts = reader.prepare(`SELECT recipe,layout,header,stock_count,delta_mask FROM prepared_snapshot_contexts WHERE ${axis}`);
  const layoutFor = reader.prepare(`SELECT value FROM prepared_snapshot_layouts WHERE ${axis} AND layout=?`);
  const blob = reader.prepare(`SELECT 1 FROM prepared_snapshot_blobs WHERE ${axis} AND blob=?`);
  const frameFor = hasTable(reader, 'prepared_snapshot_frames')
    ? reader.prepare(`SELECT bucket FROM prepared_snapshot_frames WHERE ${axis} AND frame=?`) : null;
  const baseFor = hasTable(reader, 'prepared_stock_base') ? reader.prepare(`SELECT 1 FROM prepared_stock_base WHERE ${axis} AND bucket=?`) : null;
  const deltaFor = hasTable(reader, 'prepared_snapshot_deltas')
    ? reader.prepare(`SELECT blob FROM prepared_snapshot_deltas WHERE ${axis} AND recipe=? AND bucket=?`) : null;
  for (const date of dates) {
    const axes = new Map();
    for (const { config } of configurations) if (config.earliestDate <= date && date <= config.date) {
      axes.set(`${config.dataVersion}:${config.basis}`, [CALCULATION_VERSION, config.dataVersion, config.basis, date]);
    }
    for (const axisKey of axes.values()) {
      const masks = new Map();
      const layouts = new Map();
      for (const row of contexts.iterate(...axisKey)) {
        if (!blob.get(...axisKey, row.header)) throw new Error(`Prepared snapshot header is missing on ${date}`);
        if (!Number.isSafeInteger(row.stock_count) || row.stock_count < 0) throw new Error(`Invalid prepared row count on ${date}`);
        if (!row.stock_count) continue;
        if (!layouts.has(row.layout)) {
          const value = layoutFor.get(...axisKey, row.layout)?.value;
          if (!value) throw new Error(`Prepared snapshot layout is missing on ${date}`);
          layouts.set(row.layout, decodeStoredJson(value));
        }
        const layout = layouts.get(row.layout);
        if (['typed-stock-1', 'typed-stock-2'].includes(layout?.[0])) {
          const frameId = layout[1];
          if (!masks.has(frameId)) {
            let mask = 0;
            for (const { bucket } of frameFor?.iterate(...axisKey, frameId) ?? []) {
              if (!Number.isInteger(bucket) || bucket < 0 || bucket >= 32) throw new Error(`Unexpected prepared stock bucket on ${date}`);
              mask |= 1 << bucket;
            }
            masks.set(frameId, mask);
          }
          if (!row.delta_mask || ((masks.get(frameId) & row.delta_mask) >>> 0) !== row.delta_mask) {
            throw new Error(`Prepared stock frame block is missing on ${date}`);
          }
        } else {
          const order = layout?.[1];
          if (!Array.isArray(order) || order.length !== row.stock_count) throw new Error(`Invalid prepared stock layout on ${date}`);
          const buckets = new Set(order.map(([id]) => snapshotBucket(id)));
          for (const bucket of buckets) {
            if (!baseFor?.get(...axisKey, bucket)) throw new Error(`Prepared stock base block is missing on ${date}`);
            if (row.delta_mask & (1 << bucket)) {
              const id = deltaFor?.get(...axisKey, row.recipe, bucket)?.blob;
              if (!id || !blob.get(...axisKey, id)) throw new Error(`Prepared stock override block is missing on ${date}`);
            }
          }
        }
      }
    }
  }
}

function verifyThinLinks(reader, config, thin) {
  const group = hasTable(reader, 'market_history_group_blocks') ? reader.prepare(`SELECT 1 FROM market_history_group_blocks
    WHERE calculation_version=? AND data_version=? AND basis=? AND date=? AND blob=?`) : null;
  for (const { date, data_version, value } of thin.values()) {
    const stored = decodeStoredJson(value);
    const linked = Array.isArray(stored) && stored[0] === 'market-history-groups-1';
    const row = linked ? stored[2] : stored;
    if (row?.date !== date || !Array.isArray(row.topDecileIds) || !row.coverage || !row.breadth) {
      throw new Error(`Prepared breadth payload is invalid on ${date}`);
    }
    if (linked && (stored[1] !== config.basis || !group?.get(CALCULATION_VERSION, data_version, stored[1], date, row.groups))) {
      throw new Error(`Prepared breadth group block is missing on ${date}`);
    }
  }
}

function validateSnapshotReadback(reader, engine, point, listed, velocity, fullReadback) {
  const stockFields = fullReadback ? ['securityId'] : ['symbol', 'close', 'return_1d', 'rsRank', 'rsPercentile', 'industry'];
  const listing = readPreparedSnapshot(reader, engine, point, { velocity, stockFields });
  const ids = listing?.stocks.map(({ securityId }) => securityId);
  if (listing?.date !== point.date || !Array.isArray(ids) || ids.length !== listed || new Set(ids).size !== listed) {
    throw new Error(`Reopened sample did not match its prepared manifest on ${point.date}`);
  }
  if (fullReadback) {
    const groups = Array.from({ length: 8 }, () => []);
    for (const id of ids) groups[Math.floor(snapshotBucket(id) / 4)].push(id);
    for (const securityIds of groups.filter((members) => members.length)) {
      const frame = readPreparedSnapshot(reader, engine, point, { velocity, securityIds });
      if (frame?.date !== point.date || frame.stocks.length !== securityIds.length ||
          frame.stocks.some(({ securityId }, index) => securityId !== securityIds[index])) {
        throw new Error(`Full-field snapshot readback failed on ${point.date}`);
      }
    }
  }
  return listed;
}

export function verifyCoreTile(reader, engine, configurations, dates, { exact = true, sampleDates = [], fullReadback = true } = {}) {
  const totals = { base: 0, velocity: 0, ranks: 0, history: 0, monitor: 0, selectedStocks: 0, rankTradeIds: 0 };
  const witnesses = new Map();
  const rankCache = new Map();
  for (const { config, rank = true, historyOnly = false } of configurations) {
    const eligible = dates.filter((date) => date >= config.earliestDate && date <= config.date);
    const label = `${config.universe.id}/${config.model.id}`;
    if (!eligible.length) continue;
    const thin = thinDateRows(reader, engine, config, eligible, { exact, values: exact });
    if (thin.size !== eligible.length) throw new Error(`Missing prepared breadth for ${label} on ${eligible.find((date) => !thin.has(date))}`);
    if (exact) verifyThinLinks(reader, config, thin);
    totals.history += eligible.length;
    if (historyOnly) continue;
    for (const velocity of rank ? [false, true] : [false]) {
      const prepared = preparedSnapshotDates(reader, engine, config, eligible, { velocity });
      const missing = eligible.find((date) => !prepared.has(date) || exact && prepared.get(date) !== config.dataVersion);
      if (missing) throw new Error(`Missing prepared ${velocity ? 'velocity' : 'base'} snapshot for ${label} on ${missing}`);
      totals[velocity ? 'velocity' : 'base'] += eligible.length;
    }
    if (rank) {
      const coverage = verifyPreparedRankCoverage(reader, config, eligible,
        readPreparedSnapshotRankWitnesses(reader, engine, config, eligible, witnesses), rankCache);
      if (coverage.dates !== eligible.length || exact && [...rankCache.keys()].some((key) => Number(key.split(':')[1]) !== config.dataVersion)) {
        throw new Error(`Incomplete pinned rank coverage for ${label}`);
      }
      totals.ranks += coverage.dates;
      totals.rankTradeIds += coverage.tradedIds;
    } else totals.monitor += eligible.length;
    for (const date of sampleDates.filter((day) => eligible.includes(day))) {
      const [row] = readMaterializedHistory(reader, engine, config, { from: date, to: date, limit: 1 }).rows;
      if (row?.date !== date || !Number.isSafeInteger(row.coverage?.listed)) throw new Error(`Missing breadth readback for ${label} on ${date}`);
      const point = { ...config, date };
      totals.selectedStocks += validateSnapshotReadback(reader, engine, point, row.coverage.listed, rank, fullReadback);
      if (rank && fullReadback) validateSnapshotReadback(reader, engine, point, row.coverage.listed, false, true);
    }
  }
  if (exact) verifyFrameLinks(reader, configurations, dates);
  return { ...totals, physicalRankDates: rankCache.size,
    physicalRankBlocks: [...rankCache.values()].reduce((count, row) => count + row.blocks, 0) };
}

function healthKey(engine, config, model, coverage) {
  return digest([engine.definitionKey(config), config.universe.id, config.universe.version,
    config.model.id, config.model.version, model, coverage]);
}

export function verifyCalibrationProducts(reader, source, engine, point, configurations, dates, warmup) {
  const models = [DEFAULT_HEALTH_MODEL, ...listWorkspace(source, 'health-model')
    .map(({ id, name, version, definition }) => ({ ...definition, id, name, version }))];
  const policies = [{ coverageMode: 'verified' }, { coverageMode: 'observed', observedMinimum: 20, observedThreshold: 0.8 }];
  const verifications = new Map();
  let logicalRows = 0;
  let recipes = 0;
  for (const { rank, config } of configurations) {
    if (!rank) continue;
    const eligible = dates.filter((date) => config.earliestDate <= date && date <= config.date);
    if (!eligible.length) continue;
    for (const coverage of policies) for (const model of models) {
      recipes++;
      logicalRows += eligible.length;
      for (const scope of referenceArchiveScopes(config, eligible)) {
        const recipe = healthKey(engine, scope.config, model, coverage);
        const key = `${config.dataVersion}:${recipe}`;
        if (!verifications.has(key)) verifications.set(key, { recipe, version: config.dataVersion, config, coverage, model, dates: new Set() });
        const expected = verifications.get(key).dates;
        for (const date of scope.dates) expected.add(date);
      }
    }
  }
  if (!verifications.size || !hasTable(reader, 'prepared_health')) throw new Error('Prepared health calibration is absent');
  const rows = reader.prepare('SELECT date FROM prepared_health WHERE recipe=? AND data_version=? AND calculation_version=? ORDER BY date');
  const payload = reader.prepare('SELECT payload FROM prepared_health WHERE recipe=? AND data_version=? AND calculation_version=? AND date=?');
  let physicalRows = 0;
  for (const job of verifications.values()) {
    const key = [job.recipe, job.version, CALCULATION_VERSION];
    const expected = [...job.dates].sort();
    let index = 0;
    for (const { date } of rows.iterate(...key)) {
      if (date !== expected[index++]) throw new Error(`Prepared health date mismatch for ${job.config.universe.id}/${job.model.id} at ${date}`);
    }
    if (index !== expected.length) throw new Error(`Prepared health is missing ${expected[index]} for ${job.config.universe.id}/${job.model.id}`);
    for (const date of new Set([expected[0], expected.at(-1)])) {
      const health = decodeStoredJson(payload.get(...key, date).payload);
      if (health?.date !== date || health?.coverageMode !== job.coverage.coverageMode || health?.model?.id !== job.model.id ||
          health?.universe?.id !== job.config.universe.id || !Array.isArray(health.components) || health.components.length !== 7 ||
          health.score != null && !(Number.isFinite(health.score) && health.score >= 0 && health.score <= 100)) {
        throw new Error(`Prepared health payload disagrees with its recipe on ${date}`);
      }
    }
    physicalRows += index;
  }
  if (reader.prepare('SELECT count(*) AS count FROM prepared_health').get().count !== physicalRows) {
    throw new Error('Prepared health has rows outside the accepted recipe scopes');
  }
  const nyse = summationContext(source, engine, point);
  const seedDates = expectedSessions(nyse.earliestDate, nyse.date);
  let verified = 0;
  for (const tile of dateTiles(seedDates, 8)) {
    const result = readPreparedSummation(reader, nyse, { from: tile[0], to: tile.at(-1), limit: tile.length });
    if (result.rows.length !== tile.length || result.rows.some((row, index) => row.date !== tile[index])) {
      throw new Error(`Prepared NYSE Summation is missing a seeded session near ${tile[0]}`);
    }
    verified += tile.length;
  }
  return {
    breadth: { requestedPairs: warmup, readyPairs: warmup },
    health: { requested: logicalRows, prepared: logicalRows, missing: 0, recipes, physicalRows, physicalRecipes: verifications.size },
    sum: { state: 'prepared', verified: dates.length, seedSessions: verified },
  };
}

const stockVelocityFields = ['securityId', 'velocity1w', 'velocity4w', 'velocity12w', 'rankChange1w', 'rankChange4w', 'rankChange12w',
  'industryVelocity', 'industryImproving', 'industryEmerging'];
const groupVelocityFields = ['id', 'velocity4w', 'velocity12w', 'rankChange4w', 'rankChange12w', 'emerging'];
const leaderFields = ['previousLeaderDate', 'leaderReturn', 'leaderReturnExpected', 'leaderReturnObservations',
  'leadershipRankObservations', 'leadershipPersistence', 'leadershipTurnover'];

function equalFields(left, right, fields) {
  return fields.every((name) => {
    const value = left[name], expected = right[name];
    return typeof value === 'number' && typeof expected === 'number'
      ? Math.abs(value - expected) <= 1e-10 * Math.max(1, Math.abs(expected)) : value === expected;
  });
}

function previousTopDecile(reader, engine, config, dates, exact) {
  const records = thinDateRows(reader, engine, { ...config, referenceMode: 'as-of' }, dates, { exact, values: true });
  return new Map([...records].map(([date, { value }]) => {
    const row = decodeStoredJson(value);
    return [date, (Array.isArray(row) && row[0] === 'market-history-groups-1' ? row[2] : row)?.topDecileIds];
  }));
}

const precedingSessions = (dates) => new Map(dates.map((date) => [date, expectedSessions(shiftDate(date, -12), shiftDate(date, -1)).at(-1)]));
const boundaryCounts = (dates) => ({ sessions: dates.length, velocitySnapshots: 0, leaderContexts: 0, priorLeaderRosters: 0 });

export function expectedBoundaryCoverage(configurations, sampled, archiveDates) {
  const previous = precedingSessions(sampled);
  const counts = boundaryCounts(sampled);
  for (const date of sampled) {
    const prior = previous.get(date);
    let covered = false;
    for (const { config, rank = true, historyOnly } of configurations) {
      if (date < config.earliestDate || date > config.date) continue;
      covered = true;
      counts.leaderContexts++;
      if (rank && !historyOnly) counts.velocitySnapshots++;
      if (archiveDates.has(prior) && prior >= config.earliestDate) counts.priorLeaderRosters++;
    }
    if (!covered) throw new Error(`Independent boundary oracle has no eligible context on ${date}`);
  }
  return counts;
}

export function verifyBoundaryWindow(reader, engine, configurations, sampled, archiveDates, { directory, tileSize = 8, codec, exact = true } = {}) {
  const previous = precedingSessions(sampled);
  const priorDates = [...new Set([...previous.values()].filter((date) => archiveDates.has(date)))].sort();
  const priorOnly = priorDates.filter((date) => !sampled.includes(date));
  const working = mkdtempSync(join(directory, '.boundary-oracle-'));
  const verified = boundaryCounts(sampled);
  let spool;
  try {
    spool = openDatabase(join(working, 'oracle.sqlite'));
    spool.exec('PRAGMA journal_mode=DELETE');
    prepareBatchedSnapshots(spool, engine, configurations, { dates: sampled, tileSize, codec });
    if (priorOnly.length) prepareBatchedSnapshots(spool, engine, configurations.map(({ config }) => ({
      config, rank: false, historyOnly: true,
    })), { dates: priorOnly, tileSize, codec });
    for (const { config, rank = true, historyOnly } of configurations) {
      const actualLeaders = previousTopDecile(reader, engine, config, priorDates, exact);
      const expectedLeaders = previousTopDecile(spool, engine, config, priorDates, true);
      for (const date of sampled.filter((day) => day >= config.earliestDate && day <= config.date)) {
        const point = { ...config, date };
        if (rank && !historyOnly) {
          const flags = { velocity: true, stockFields: stockVelocityFields };
          const saved = readPreparedSnapshot(reader, engine, point, flags);
          const baseline = readPreparedSnapshot(spool, engine, point, flags);
          if (!saved || !baseline || saved.stocks.length !== baseline.stocks.length || saved.groups.length !== baseline.groups.length ||
              !saved.stocks.every((stock, index) => equalFields(stock, baseline.stocks[index], stockVelocityFields)) ||
              !saved.groups.every((group, index) => equalFields(group, baseline.groups[index], groupVelocityFields))) {
            throw new Error(`Serial velocity oracle disagrees at shard boundary ${date} for ${config.universe.id}/${config.model.id}`);
          }
          verified.velocitySnapshots++;
        }
        const span = { from: date, to: date, limit: 1 };
        const [saved] = readMaterializedHistory(reader, engine, config, span).rows;
        const [baseline] = readMaterializedHistory(spool, engine, config, span).rows;
        if (!saved || !baseline || !equalFields(saved.aggregates, baseline.aggregates, leaderFields)) {
          throw new Error(`Serial leader oracle disagrees at shard boundary ${date} for ${config.universe.id}/${config.model.id}`);
        }
        const prior = previous.get(date);
        if (archiveDates.has(prior) && prior >= config.earliestDate) {
          const actual = actualLeaders.get(prior), expected = expectedLeaders.get(prior);
          if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length ||
              actual.some((id, index) => id !== expected[index])) {
            throw new Error(`Serial prior leader roster disagrees at shard boundary ${date}`);
          }
          verified.priorLeaderRosters++;
        }
        verified.leaderContexts++;
      }
    }
    return verified;
  } finally {
    spool?.close();
    rmSync(working, { recursive: true, force: true });
  }
}

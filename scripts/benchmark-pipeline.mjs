import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { preparationDependencies, preparationSeedKey, prepareBatchedSnapshots } from '../backend/batch-preparation.mjs';
import { expectedSessions, shiftDate } from '../backend/calendar.mjs';
import { dataVersion, importDataset, listWorkspace, openDatabase, CALCULATION_VERSION } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { createMaterializedHistoryWriter } from '../backend/materialization.mjs';
import { compactWeeklySnapshot } from '../backend/preparation.mjs';
import { createPreparedDetailWriter } from '../backend/prepared-details.mjs';
import { prepareRangeHistoryBatch, prepareRangeMetrics } from '../backend/range-metrics.mjs';
import { createRiskHistoryWriter, prepareRiskHistoryBatch, prepareRiskHistoryBenchmarks } from '../backend/risk-history.mjs';
import { preparationHistoryWarmup, preparationWorkspaceScopes, prepareNyseSummation, prepareStandardHealth, summationContext } from '../backend/service.mjs';
import { preparedCodec } from '../backend/storage-codec.mjs';
import { readPreparedSummation } from '../backend/summation.mjs';
import { topDecileIds } from '../backend/ranking.mjs';
import { benchmarkContexts, benchmarkRecipeDigest, dateTiles, exactRangePlans, verifyBoundaryWindow, verifyCoreTile, verifyInstrumentProducts } from './pipeline-verification.mjs';
import { preparationSourcePin } from '../backend/pipeline-shards.mjs';

const { values: options } = parseArgs({ options: {
  source: { type: 'string' }, output: { type: 'string' }, version: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  sessions: { type: 'string' }, securities: { type: 'string' }, mode: { type: 'string', default: 'cold' },
  scope: { type: 'string', default: 'all' }, 'context-limit': { type: 'string' }, 'tile-size': { type: 'string' },
  'max-output-gib': { type: 'string', default: '20' }, 'max-pending-gib': { type: 'string' },
  codec: { type: 'string' }, progress: { type: 'boolean' },
  calibration: { type: 'string', default: 'report' },
  'five-year-gate': { type: 'boolean' }, 'boundary-oracle': { type: 'boolean' },
  'full-readback': { type: 'boolean' },
  workers: { type: 'string' }, 'chunk-size': { type: 'string' }, 'worker-heap-mib': { type: 'string' },
  'seed-mode': { type: 'string', default: 'shared' },
} });

function integer(value, defaultValue, minimum, maximum) {
  const result = value == null ? defaultValue : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new RangeError(`Expected a whole number from ${minimum} to ${maximum}`);
  return result;
}

const fiveYearSessions = 1260;
const sessionsRequested = integer(options.sessions, options['five-year-gate'] ? fiveYearSessions : options.source ? 756 : 32, 2, 7560);
const tileSize = integer(options['tile-size'], 42, 1, 120);
const contextLimit = integer(options['context-limit'], 1000, 1, 1000);
const workers = integer(options.workers, 1, 1, 16);
const chunkSize = integer(options['chunk-size'], 12, 1, 120);
const workerHeapMb = options['worker-heap-mib'] === undefined ? undefined : integer(options['worker-heap-mib'], undefined, 128, 32768);
const maxBytes = Math.floor(Number(options['max-output-gib']) * 2 ** 30);
if (!Number.isSafeInteger(maxBytes) || maxBytes < 0.01 * 2 ** 30) throw new Error('Choose a positive benchmark output byte budget');
const maxPendingBytes = options['max-pending-gib'] === undefined ? Math.min(maxBytes, 4 * 2 ** 30)
  : Math.floor(Number(options['max-pending-gib']) * 2 ** 30);
if (workers > 1 && (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < workers * 2 ** 20 || maxPendingBytes > 128 * 2 ** 30)) {
  throw new Error('Choose a pending shard budget from 1 MiB per worker through 128 GiB');
}
if (!['core', 'all'].includes(options.scope) || !['cold', 'append', 'correction', 'all'].includes(options.mode)) {
  throw new Error('Use --scope core|all and --mode cold|append|correction|all');
}
if (options.source && options.mode !== 'cold') throw new Error('Append and correction scenarios use synthetic source data to avoid modifying an existing warehouse');
if (options.codec && !['gzip', 'zstd'].includes(options.codec)) throw new Error('Use --codec gzip or zstd');
if (!['report', 'full'].includes(options.calibration)) throw new Error('Use --calibration report|full');
if (options.calibration === 'full' && options.scope !== 'all') throw new Error('Full calibration requires --scope all');
if (options['five-year-gate'] && options.calibration !== 'full') throw new Error('The five-year gate requires --calibration full');
if (!['shared', 'local'].includes(options['seed-mode'])) throw new Error('Use --seed-mode shared|local');
if (workers > 1 && options.mode !== 'cold') throw new Error('Parallel benchmarking currently measures cold preparation only');

const output = resolve(options.output || join(mkdtempSync(join(tmpdir(), 'market-pipeline-')), 'derived.sqlite'));
if (existsSync(output) || existsSync(`${output}-wal`) || existsSync(`${output}-shm`)) throw new Error('Choose a new derived benchmark output filename');
mkdirSync(dirname(output), { recursive: true });
const freeBytes = () => { const stat = statfsSync(dirname(output)); return stat.bavail * stat.bsize; };
if (freeBytes() < maxBytes + 2 ** 30) throw new Error('Insufficient free disk space for the stated benchmark output budget and reserve');
const storageBytes = () => ['', '-wal', '-shm'].reduce((bytes, suffix) => bytes + (existsSync(output + suffix) ? statSync(output + suffix).size : 0), 0);
function guardDisk() {
  if (storageBytes() > maxBytes || freeBytes() < 2 ** 30) throw new Error('Benchmark output reached the disk budget or remaining-space reserve');
}

async function sealArchive() {
  const before = statSync(output, { bigint: true });
  if (existsSync(`${output}-wal`) && statSync(`${output}-wal`).size) throw new Error('Cold output has an uncheckpointed write-ahead log');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(output, { highWaterMark: 2 ** 20 })) hash.update(chunk);
  const after = statSync(output, { bigint: true });
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error('Derived output changed while its checksum was calculated');
  }
  return { bytes: Number(after.size), sha256: hash.digest('hex') };
}

function makeFixture(filename = ':memory:') {
  const stockCount = integer(options.securities, 96, 4, 1000);
  const dates = expectedSessions('1990-01-02', '2026-11-20').slice(-(sessionsRequested + 461));
  const tickers = ['SPY', 'VTI', ...Array.from({ length: stockCount - 2 }, (_, index) => `PIPE${index}`)];
  const securities = tickers.map((symbol, i) => ({ id: `fixture:${symbol}`, symbol, name: `${symbol} benchmark fixture`,
    exchange: i % 3 === 0 ? 'NYSE' : 'NASDAQ', type: i < 2 ? 'etf' : 'common', listingDate: dates[0], knownAt: dates[0] }));
  function quote(security, i, date, index, scale = 1) {
    const close = scale * (20 + i * 0.3) * (1 + index / 1300 + 0.026 * Math.sin(index / (4 + i % 9) + i));
    return { securityId: security.id, date, knownAt: date, high: close * 1.015, low: close * 0.99, open: close * 0.998,
      close, adjustedClose: close, volume: 40000 + (index * 7517 + i * 71) % 180000 };
  }
  const source = openDatabase(filename);
  importDataset(source, { provider: 'pipeline-fixture', securities,
    prices: securities.flatMap((security, i) => dates.slice(0, -1).flatMap((date, index) => i > 2 && (index + i * 7) % 191 === 0
      ? [] : [quote(security, i, date, index)])),
    classifications: securities.flatMap((security, i) => ['nasdaq', 'sec-sic'].map((system) => ({ securityId: security.id,
      system, sector: `Sector ${i % 3}`, industry: `${system} industry ${i % 7}`, effectiveFrom: dates[0], knownAt: dates[0] }))),
  });
  return { source, append: () => importDataset(source, { provider: 'pipeline-fixture', prices: securities.map((security, i) =>
    quote(security, i, dates.at(-1), dates.length - 1)) }),
  correct: () => importDataset(source, { provider: 'pipeline-fixture', prices: [quote(securities[4] ?? securities.at(-1),
    4, dates.at(-3), dates.length - 3, 1.12)] }) };
}

function prepareBoundarySeeds(engine, configurations, dates, sessionsPerShard) {
  const configs = configurations.map(({ config }) => config);
  const indexes = new Map(configs.map((config, index) => [config, index]));
  const requests = new Map();
  for (let first = 0; first < dates.length; first += sessionsPerShard) {
    for (const entry of preparationDependencies(configurations, dates.slice(first, first + sessionsPerShard))) {
      const { config, date, kind } = entry;
      if (!requests.has(date)) requests.set(date, new Map());
      const window = requests.get(date);
      const recipe = preparationSeedKey(engine, config, 'frame', date);
      if (!window.has(recipe)) window.set(recipe, { configIndex: indexes.get(config), keys: new Map() });
      window.get(recipe).keys.set(kind, preparationSeedKey(engine, config, kind, date));
    }
  }
  const indexed = new Map([...requests].map(([date, window]) => [date, new Map([...window.values()].map((entry) => [entry.configIndex, entry.keys]))]));
  const seeds = new Map();
  const seedDates = [...indexed.keys()].sort();
  for (const { date, results } of engine.batchSnapshots(configs, { dates: seedDates, tileSize, sparseRows: true,
    shouldBuild: (_config, index, date) => indexed.get(date).has(index) })) {
    for (const { snapshot, contextIndex } of results) {
      for (const [kind, key] of indexed.get(date).get(contextIndex)) {
        seeds.set(key, kind === 'weekly' ? compactWeeklySnapshot(snapshot) : topDecileIds(snapshot));
      }
    }
  }
  const expected = [...indexed.values()].reduce((count, window) => count + [...window.values()].reduce((count, keys) => count + keys.size, 0), 0);
  if (seeds.size !== expected) throw new Error('Cross-window preparation seeds are incomplete');
  return seeds;
}

async function prepareSnapshotPhase(target, engine, configurations, dates, { label, sourcePath, sessionsPerShard = chunkSize }) {
  if (workers > 1) {
    const { prepareParallelSnapshots } = await import('../backend/pipeline-shards.mjs');
    const seedStart = performance.now();
    const dependencySeeds = options['seed-mode'] === 'shared' ? prepareBoundarySeeds(engine, configurations, dates, sessionsPerShard) : undefined;
    const seedMs = Math.round(performance.now() - seedStart);
    const plans = await prepareParallelSnapshots({ sourcePath, targetDb: target, configurations,
      dates, workers, chunkSize: sessionsPerShard, tileSize, codec: options.codec, directory: dirname(output), workerHeapMb,
      maxPendingBytes, dependencySeeds,
      onProgress: ({ phase, shard, date, completedDates, totalDates, calculationMs, projectionMs, storageMs, bytes }) => {
        guardDisk();
        if (options.progress) {
          const detail = phase === 'merge' ? `${bytes} verified shard bytes` :
            `${Math.round(calculationMs)}ms calculation, ${Math.round(projectionMs)}ms projection, ${Math.round(storageMs)}ms save`;
          console.error(`${label} ${date}: shard ${shard} ${phase}, ${completedDates}/${totalDates} merged sessions, ${detail}`);
        }
      } });
    return { plans, seedMs, chunkSize: sessionsPerShard };
  }
  let lastCommit = 0;
  const plans = prepareBatchedSnapshots(target, engine, configurations, { dates, tileSize, codec: options.codec,
    onProgress: ({ date, commits, producedSessions, producedContexts, calculationMs, projectionMs, storageMs }) => {
      if (commits % 4 === 0) guardDisk();
      if (options.progress && (commits !== lastCommit || producedSessions % 5 === 0)) {
        console.error(`${label} ${date}: ${commits} commits, ${producedSessions} source sessions, ${producedContexts} context projections, ` +
          `${Math.round(calculationMs)}ms calculation, ${Math.round(projectionMs)}ms projection, ${Math.round(storageMs)}ms save`);
      }
      lastCommit = commits;
    } });
  return { plans, seedMs: 0 };
}

function copyMetadata(source, target, version) {
  // A separate writer has lineage records and a symbol directory only. Its OHLCV source remains read-only.
  target.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, rows, values] of [
      ['securities', 'SELECT * FROM securities', []],
      ['identifiers', 'SELECT * FROM identifiers', []],
      ['ingestion_runs', 'SELECT * FROM ingestion_runs WHERE version<=?', [version]],
      ['workspace', 'SELECT * FROM workspace', []],
    ]) {
      const columns = target.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      const write = target.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of source.prepare(rows).iterate(...values)) write.run(...columns.map((column) => row[column] ?? null));
    }
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  }
}

function measuredCorePayload(target, dates, revision) {
  const tables = ['prepared_snapshot_frames', 'prepared_snapshot_layouts', 'prepared_snapshot_blobs',
    'prepared_stock_base', 'prepared_rank_blocks', 'market_history', 'market_history_group_blocks'];
  const exists = target.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
  const bytes = Object.fromEntries(tables.filter((table) => exists.get(table)).map((table) => [table,
    target.prepare(`SELECT coalesce(sum(length(value)),0) AS bytes FROM ${table} WHERE data_version=? AND date BETWEEN ? AND ?`)
      .get(revision, dates[0], dates.at(-1)).bytes]));
  const total = Object.values(bytes).reduce((sum, count) => sum + count, 0);
  return { encodedPayloadBytes: total, averagePerSession: Math.round(total / dates.length), bytesByTable: bytes };
}

function prepareInstruments(target, source, engine, point, dates, recipes, changedFrom = dates[0]) {
  const config = { ...point, referenceMode: 'as-of', currentVersion: false };
  const { rangeWindows, riskWindows: windows, benchmarks } = recipes;
  const riskOptions = { dates: dates.filter((date) => date >= changedFrom), windows, benchmarks, sourceDb: source, bucketSize: 32 };
  const riskInputs = prepareRiskHistoryBenchmarks(source, engine, config, riskOptions);
  const risk = createRiskHistoryWriter(target, config, { ...riskOptions, ...riskInputs });
  const detail = createPreparedDetailWriter(target, engine, config, { sourceDb: source, benchmarks, riskWindows: [] });
  let detailProducts = 0;
  const detailBatch = [];
  const saveDetails = () => {
    detailProducts += detail.batch(detailBatch.splice(0)).filter(({ written }) => written).length;
  };
  function writeDetail(row) {
    if (!detail.ready(row.securityId)) {
      detailBatch.push(row);
      if (detailBatch.length === 64) saveDetails();
    }
  }
  const ranges = [];
  for (let start = 0; start < rangeWindows.length; start += 16) {
    const requested = rangeWindows.slice(start, start + 16);
    let result;
    do {
      result = prepareRangeHistoryBatch(target, engine, config, requested, {
        dates, sourceDb: source, bucketSize: 32, onSecurity: start === 0 ? (row) => {
          risk.writeSecurity(row);
          writeDetail(row);
        } : undefined,
      });
      guardDisk();
      if (options.progress && (result.done || result.processedSecurities % 512 === 0)) {
        console.error(`Range, detail and risk source pass: ${result.processedSecurities}/${result.totalSecurities} securities, ${storageBytes()} bytes`);
      }
    } while (!result.done);
    ranges.push(result);
  }
  let report = risk.flush();
  while (!report.done) {
    // Reused range blocks can skip the price pass on append. Risk's own
    // committed roster cursor still determines which symbols it needs.
    const next = prepareRiskHistoryBatch(target, engine, config, { ...riskOptions, onSecurity: writeDetail });
    if (!next.done && next.processedSecurities <= report.processedSecurities) throw new Error('Risk preparation stopped before covering its pinned roster');
    report = next;
    guardDisk();
  }
  saveDetails();
  for (const { config, windows } of exactRangePlans(recipes, point, dates)) {
    for (let start = 0; start < windows.length; start += 16) {
      prepareRangeMetrics(target, engine, config, windows.slice(start, start + 16));
      guardDisk();
    }
  }
  return { ranges, risk: report, riskFrom: changedFrom, detailProducts };
}

function prepareThinPhase(target, engine, configurations, dates, label, sourcePath) {
  const sessionsPerShard = Math.min(chunkSize, Math.ceil(dates.length / workers));
  return prepareSnapshotPhase(target, engine, configurations.map(({ config }) => ({ config, historyOnly: true, rank: false })),
    dates, { label, sourcePath, sessionsPerShard });
}

async function prepareCalibration(target, source, engine, point, dates, recipes, { sourcePath, calendar, prerequisites, warmup }) {
  const nyse = summationContext(source, engine, point);
  if (options.calibration === 'full' && !engine.batchAdvanceDecline) {
    const stored = createMaterializedHistoryWriter(target, engine, nyse, calendar);
    const missing = calendar.filter((date) => !stored.has(date));
    if (missing.length) await prepareThinPhase(target, engine, [{ config: nyse }], missing, 'NYSE breadth warmup', sourcePath);
  }
  const breadth = { recipes: 0, seedSessions: prerequisites.length, readyRecipes: 0, requestedPairs: 0, readyPairs: 0, warmup };
  const health = { requested: 0, prepared: 0, missing: 0, recipes: 0 };
  for (const { config, rank } of recipes.configs) {
    const scopedDates = dates.filter((date) => date <= config.date && date >= config.earliestDate);
    if (!scopedDates.length) continue;
    const expected = prerequisites.filter((date) => date >= config.earliestDate && date <= config.date);
    const seed = createMaterializedHistoryWriter(target, engine, config, expected);
    const prepared = expected.filter((date) => seed.has(date)).length;
    breadth.recipes++;
    breadth.requestedPairs += expected.length;
    breadth.readyPairs += prepared;
    if (prepared === expected.length) breadth.readyRecipes++;
    if (!rank) continue;
    const runs = prepareStandardHealth(target, engine, config, { from: scopedDates[0], limit: scopedDates.length });
    health.recipes += runs.length;
    for (const run of runs) {
      health.requested += scopedDates.length;
      health.prepared += run.prepared;
    }
  }
  health.missing = health.requested - health.prepared;
  const batchSummation = options.calibration === 'full' && Boolean(engine.batchAdvanceDecline);
  const available = batchSummation ? null : createMaterializedHistoryWriter(target, engine, nyse, calendar);
  const missing = available ? calendar.filter((date) => !available.has(date)).length : 0;
  const sum = missing ? { state: 'missing-seed', missing } : { state: 'prepared', ...prepareNyseSummation(target, engine, nyse, { batch: batchSummation }) };
  if (options.calibration === 'full' && (breadth.readyRecipes !== breadth.recipes || health.missing !== 0 || sum.state !== 'prepared')) {
    throw new Error(`Full calibration incomplete: ${breadth.readyPairs}/${breadth.requestedPairs} breadth seeds, ` +
      `${health.prepared}/${health.requested} health rows, NYSE ${sum.state}`);
  }
  health.savedRows = target.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_health'").get()
    ? target.prepare('SELECT count(*) AS count FROM prepared_health WHERE data_version<=?').get(point.dataVersion).count : 0;
  return { breadth, health, sum, nyse };
}

function verify(target, source, engine, point, dates, recipes, instrumentReport, calibration) {
  const verified = {};
  for (const tile of dateTiles(dates, 8)) {
    const result = verifyCoreTile(target, engine, recipes.configs, tile, {
      exact: false, sampleDates: [dates[0], dates.at(-1)], fullReadback: options['full-readback'] === true,
    });
    for (const [key, value] of Object.entries(result)) verified[key] = (verified[key] ?? 0) + value;
  }
  if (instrumentReport) Object.assign(verified, verifyInstrumentProducts(target, source, engine, point, dates, recipes, instrumentReport));
  if (calibration) {
    const health = target.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_health'").get()
      ? target.prepare('SELECT count(*) AS count FROM prepared_health WHERE data_version<=?').get(point.dataVersion).count : 0;
    if (health !== calibration.health.savedRows) throw new Error('Reopened health row count differs from the prepared coverage');
    const sum = calibration.sum.state === 'prepared' ? readPreparedSummation(target, calibration.nyse, { from: dates[0], limit: dates.length }) : null;
    if (sum && (sum.rows.length !== dates.length || sum.rows.some((row, index) => row.date !== dates[index]))) {
      throw new Error('Reopened summation archive is incomplete');
    }
    verified.calibration = { breadth: calibration.breadth, health: { ...calibration.health, physicalRows: health },
      sum: { ...calibration.sum, verified: sum?.rows.length ?? 0 } };
  }
  return verified;
}

function verifyBoundaryOracle(reader, engine, configurations, dates, prerequisites, sessionsPerShard) {
  const sampled = [...new Set(dateTiles(dates, sessionsPerShard).flatMap((shard) => [shard[0], shard.at(-1)]))];
  const archiveDates = new Set([...dates, ...prerequisites]);
  const verified = {};
  for (const window of dateTiles(sampled, 8)) {
    const result = verifyBoundaryWindow(reader, engine, configurations, window, archiveDates,
      { directory: dirname(output), tileSize: Math.min(tileSize, 8), codec: options.codec, exact: false });
    for (const [key, value] of Object.entries(result)) verified[key] = (verified[key] ?? 0) + value;
  }
  return verified;
}

const started = performance.now();
const fixtureDirectory = !options.source && workers > 1 ? mkdtempSync(join(tmpdir(), 'market-source-')) : null;
const sourcePath = options.source ? resolve(options.source) : fixtureDirectory ? join(fixtureDirectory, 'source.sqlite') : undefined;
const data = options.source ? { source: new DatabaseSync(sourcePath, { readOnly: true }) } : makeFixture(sourcePath);
const source = data.source;
const sourceVersionBefore = dataVersion(source);
const engine = createEngine(source);
const stages = [];
const sourceChecks = [];
const boundaryChecks = [];
let target = openDatabase(output);
try {
  if (options.source) {
    target.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
    if (target.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 2) throw new Error('Unable to initialize incremental vacuum for the cold output');
  }
  async function run(mode, measured, changedFrom) {
    if (!target.isOpen) target = openDatabase(output);
    const stageStart = performance.now();
    const revision = options.version == null ? dataVersion(source) : integer(options.version, 0, 0, sourceVersionBefore);
    const date = mode === 'cold' ? options.to : undefined;
    const selected = engine.context({ date, dataVersion: revision });
    const scopes = preparationWorkspaceScopes(source, engine, { date: selected.date, version: revision });
    const point = engine.context({ ...scopes.base, universe: 'us-all', reference: 'as-of' });
    const calendar = expectedSessions(point.earliestDate, point.date);
    const dates = measured ?? (options.from ? calendar.filter((session) => session >= options.from) : calendar.slice(-sessionsRequested));
    if (!dates.length) throw new Error('No available trading sessions in the requested benchmark range');
    if (options['five-year-gate'] && dates.length < fiveYearSessions) throw new Error(`The five-year gate requires ${fiveYearSessions} prepared market sessions`);
    copyMetadata(source, target, revision);
    const recipes = benchmarkContexts(source, engine, point, scopes, { contextLimit });
    createMaterializedHistoryWriter(target, engine, recipes.configs[0].config, []);
    if (options['five-year-gate'] && recipes.configs.length !== recipes.availableContexts) {
      throw new Error('The five-year gate requires all available preparation recipes');
    }
    const first = calendar.indexOf(dates[0]);
    const prerequisites = options.scope === 'all' ? calendar.slice(Math.max(0, first - preparationHistoryWarmup(source)), first) : [];
    const recipeDigest = benchmarkRecipeDigest(recipes, dates, prerequisites, options);
    const pin = options.source ? preparationSourcePin(source, sourcePath, recipes.configs) : null;
    if (pin) sourceChecks.push({ point, dates, prerequisites, recipeDigest, pin });
    const checkBoundaries = workers > 1 && (options['boundary-oracle'] || options.calibration === 'full');
    if (checkBoundaries) boundaryChecks.push({ phase: 'core', configurations: recipes.configs, dates, prerequisites, sessionsPerShard: chunkSize });
    const warmupStart = performance.now();
    const warmup = options.calibration === 'full' && prerequisites.length
      ? await prepareThinPhase(target, engine, recipes.configs, prerequisites, 'breadth warmup', sourcePath) : null;
    if (checkBoundaries && warmup) boundaryChecks.push({ phase: 'breadth-warmup',
      configurations: recipes.configs.map(({ config }) => ({ config, rank: false, historyOnly: true })),
      dates: prerequisites, prerequisites: [], sessionsPerShard: warmup.chunkSize });
    const calibrationWarmupMs = warmup ? Math.round(performance.now() - warmupStart) : 0;
    const { plans, seedMs } = await prepareSnapshotPhase(target, engine, recipes.configs, dates, { label: mode, sourcePath });
    const coreMs = Math.round(performance.now() - stageStart) - calibrationWarmupMs;
    const instrumentStart = performance.now();
    let instruments;
    if (options.scope === 'all') instruments = prepareInstruments(target, source, engine, point, dates, recipes, changedFrom);
    const instrumentsMs = Math.round(performance.now() - instrumentStart);
    const calibrationStart = performance.now();
    const calibration = options.scope === 'all' ? await prepareCalibration(target, source, engine, point, dates, recipes,
      { sourcePath, calendar, prerequisites, warmup }) : null;
    const calibrationMs = calibrationWarmupMs + Math.round(performance.now() - calibrationStart);
    guardDisk();
    target.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    target.close();
    const reader = new DatabaseSync(output, { readOnly: true });
    let verified;
    let corePayload;
    try {
      verified = verify(reader, source, engine, point, dates, recipes, instruments, calibration);
      corePayload = measuredCorePayload(reader, dates, revision);
    }
    finally { reader.close(); }
    const bars = source.prepare(`SELECT count(*) AS count,count(DISTINCT security_id) AS securities FROM (
      SELECT DISTINCT security_id,date FROM price_revisions WHERE date BETWEEN ? AND ? AND version<=?)`)
      .get(dates[0], dates.at(-1), revision);
    stages.push({ mode, from: dates[0], to: dates.at(-1), dataVersion: revision, sessions: dates.length, bars: bars.count,
      securities: bars.securities, recipes: recipes.configs.length, availableRecipes: recipes.availableContexts, recipeDigest, sourcePin: pin,
      coreMs, seedMs, instrumentsMs, calibrationMs, calibrationWarmupMs,
      elapsedMs: Math.round(performance.now() - stageStart),
      knownContexts: recipes.configs.filter(({ config }) => config.basis === 'known').length,
      multiSessionKnownInstrumentHistory: { state: 'requires-exact-vintage', range: 'exact dates', risk: 'exact dates' },
      plans, verified, corePayload, outputBytes: storageBytes() });
    return dates;
  }
  const cold = await run('cold');
  if (['append', 'correction', 'all'].includes(options.mode)) {
    data.append();
    const next = engine.context().date;
    const dates = [...cold, next];
    await run('append', dates, next);
    if (['correction', 'all'].includes(options.mode)) {
      data.correct();
      await run('correction', dates, dates.at(-3));
    }
  }
  const sealStart = performance.now();
  const archive = await sealArchive();
  const sealMs = Math.round(performance.now() - sealStart);
  const measuredElapsedMs = Math.round(performance.now() - started);
  const oracleStart = performance.now();
  let boundaryOracle = null;
  if (boundaryChecks.length) {
    const reader = new DatabaseSync(output, { readOnly: true });
    try { boundaryOracle = boundaryChecks.map(({ phase, configurations, dates, prerequisites, sessionsPerShard }) =>
      ({ phase, ...verifyBoundaryOracle(reader, engine, configurations, dates, prerequisites, sessionsPerShard) })); }
    finally { reader.close(); }
  }
  const boundaryOracleMs = boundaryOracle ? Math.round(performance.now() - oracleStart) : 0;
  const sourceVersionAfter = dataVersion(source);
  if (options.source && sourceVersionBefore !== sourceVersionAfter) throw new Error('Source warehouse advanced during the benchmark; rerun with a stable source revision');
  for (const { point, dates, prerequisites, recipeDigest, pin } of sourceChecks) {
    const current = benchmarkContexts(source, engine, point, undefined, { contextLimit });
    if (benchmarkRecipeDigest(current, dates, prerequisites, options) !== recipeDigest ||
        JSON.stringify(preparationSourcePin(source, sourcePath, current.configs)) !== JSON.stringify(pin)) {
      throw new Error('Pinned source lineage or workspace recipe changed during benchmark verification');
    }
  }
  console.log(JSON.stringify({ calculationVersion: CALCULATION_VERSION, scope: options.scope, source: options.source ? 'read-only pinned revisions' : 'synthetic', workers,
    codec: options.codec ?? preparedCodec, sourceVersionBefore, sourceVersionAfter, output, stages,
    ...(workers > 1 && { chunkSize, maxPendingBytes }), outputAutoVacuum: options.source ? 'incremental' : 'default',
    archive, sealMs, elapsedMs: measuredElapsedMs, totalElapsedMs: Math.round(performance.now() - started), boundaryOracle, boundaryOracleMs,
    coverageTarget: options['five-year-gate'] ? 'five-year' : 'requested-sessions',
    outputBytes: archive.bytes, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    calibration: options.calibration, readback: options['full-readback'] ? 'all fields on sampled sessions' : 'sampled stock columns and all artifact counts',
    excluded: ['provider imports for a preloaded warehouse', 'historical known-at-time detail exact-vintage preparation'] }, null, 2));
} finally {
  if (target.isOpen) target.close();
  source.close();
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
}

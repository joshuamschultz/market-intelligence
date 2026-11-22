import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analysisWorkspaceScopeHash } from '../backend/analysis-readiness.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, dataVersion, isoDate, listWorkspace, marketDay } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { preparationShardFormat, preparationSourcePin } from '../backend/pipeline-shards.mjs';
import { preparationHistoryWarmup, preparationWorkspaceScopes } from '../backend/service.mjs';
import { benchmarkContexts, benchmarkRecipeDigest, dateTiles, hasTable, verifyBoundaryWindow, verifyCalibrationProducts,
  verifyCoreTile, verifyInstrumentProducts } from './pipeline-verification.mjs';

const receiptFormat = 'market-preparation-recovery-1';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const modelKinds = ['universe', 'ranking-model', 'screen', 'theme', 'health-model', 'stock-detail-preparation', 'alert-rule'];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function numberOption(value, min, max, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new RangeError(`Choose ${label} from ${min} through ${max}`);
  return result;
}

function regularFile(path) {
  const absolute = resolve(path);
  const file = lstatSync(absolute, { bigint: true });
  if (!file.isFile() || file.nlink !== 1n || realpathSync(absolute) !== absolute) throw new Error('Use regular, unlinked source and archive files');
  return absolute;
}

function assertClosedArchive(path) {
  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size !== 0 || existsSync(`${path}-journal`) && statSync(`${path}-journal`).size !== 0) {
    throw new Error('Archive must be checkpointed with no pending journal');
  }
  const file = statSync(path, { bigint: true });
  return { device: String(file.dev), inode: String(file.ino), bytes: Number(file.size), modified: String(file.mtimeNs) };
}

async function archiveSeal(path) {
  const before = assertClosedArchive(path);
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path, { highWaterMark: 2 ** 20 })) digest.update(bytes);
  if (!same(before, assertClosedArchive(path))) throw new Error('Archive changed during checksum verification');
  return { bytes: before.bytes, sha256: digest.digest('hex'), identity: before };
}

function readonly(path, immutable = false) {
  const uri = pathToFileURL(path);
  if (immutable) uri.search = '?mode=ro&immutable=1';
  const db = new DatabaseSync(uri.href, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  return db;
}

function acceptedShards(db) {
  if (!hasTable(db, 'accepted_preparation_shard_dates')) throw new Error('Archive has no accepted shard manifest');
  const phases = new Map();
  for (const row of db.prepare('SELECT * FROM accepted_preparation_shard_dates ORDER BY publication,date').iterate()) {
    const pin = { calculationVersion: row.calculation_version, dataVersion: row.data_version, sourceHash: row.source_hash, contextHash: row.context_hash };
    if (!isHash(pin.sourceHash) || !isHash(pin.contextHash) || !isHash(row.manifest_hash) || !isoDate(row.date) ||
        pin.calculationVersion !== CALCULATION_VERSION || row.publication !== hash([preparationShardFormat, pin]) ||
        !Number.isFinite(Date.parse(row.accepted_at))) throw new Error('Archive contains an invalid shard acceptance record');
    if (!phases.has(row.publication)) phases.set(row.publication, { pin, rows: [] });
    phases.get(row.publication).rows.push(row);
  }
  return [...phases.values()];
}

function shardEdges(rows, dates, expectedChunk) {
  if (!same(rows.map(({ date }) => date), dates)) throw new Error('Accepted shard sessions disagree with the required exchange calendar');
  const seen = new Set();
  const groups = [];
  for (const row of rows) {
    if (groups.at(-1)?.seal !== row.manifest_hash) {
      if (seen.has(row.manifest_hash)) throw new Error('Accepted shard ownership is fragmented');
      seen.add(row.manifest_hash);
      groups.push({ seal: row.manifest_hash, dates: [] });
    }
    groups.at(-1).dates.push(row.date);
  }
  const width = expectedChunk || groups[0]?.dates.length;
  if (!width && dates.length || groups.some((group, index) => index === groups.length - 1 ? group.dates.length > width
    : group.dates.length !== width)) throw new Error('Accepted shard ownership has an invalid chunk boundary');
  return { count: groups.length, width, dates: [...new Set(groups.flatMap((group) => [group.dates[0], group.dates.at(-1)]))] };
}

function workspaceModelHash(db) {
  return hash(modelKinds.map((kind) => [kind, listWorkspace(db, kind)
    .filter(({ definition }) => kind !== 'alert-rule' || definition.active !== false && ['stocks', 'screen'].includes(definition.type))
    .map(({ id, version, name, definition }) => [id, version, name, definition])
    .sort((left, right) => left[0].localeCompare(right[0]))]));
}

function verificationPlan(reader, source, sourcePath, { version, to, sessions, referenceDate, chunkSize, minimumSessions }) {
  const phases = acceptedShards(reader);
  const primary = phases.toSorted((left, right) => right.rows.at(-1).date.localeCompare(left.rows.at(-1).date))[0];
  if (!primary || primary.rows.length < minimumSessions) throw new Error(`At least ${minimumSessions} accepted core sessions are required`);
  const current = dataVersion(source);
  const pinnedVersion = primary.pin.dataVersion;
  if (current !== pinnedVersion || version != null && version !== pinnedVersion) throw new Error('Source revision does not match the accepted shard pin');
  const last = primary.rows.at(-1).date;
  if (to && to !== last || sessions && sessions !== primary.rows.length) throw new Error('Requested dates do not match the accepted archive span');
  const observedReferenceDate = referenceDate ?? marketDay(phases.flatMap(({ rows }) => rows.map(({ accepted_at }) => accepted_at)).sort()[0]);
  const engine = createEngine(source);
  const scopes = preparationWorkspaceScopes(source, engine, { date: last, version: current });
  const point = engine.context({ ...scopes.base, universe: 'us-all', reference: 'as-of', observedReferenceDate });
  if (point.date !== last || point.latestDate !== last) throw new Error('Accepted last session differs from the latest pinned source session');
  const calendar = expectedSessions(point.earliestDate, point.date);
  const dates = calendar.slice(-primary.rows.length);
  const prerequisiteCount = preparationHistoryWarmup(source);
  const prerequisites = calendar.slice(Math.max(0, calendar.length - dates.length - prerequisiteCount), calendar.length - dates.length);
  const recipes = benchmarkContexts(source, engine, point, scopes, { observedReferenceDate });
  if (recipes.configs.length !== recipes.availableContexts) throw new Error('Resolved workspace recipes are incomplete');
  const corePin = preparationSourcePin(source, sourcePath, recipes.configs);
  if (!same(primary.pin, corePin)) throw new Error('Accepted core source/context hash differs from the reconstructed plan');
  const core = shardEdges(primary.rows, dates, chunkSize);
  const warmConfigs = recipes.configs.map(({ config }) => ({ config, historyOnly: true, rank: false }));
  const warmPin = preparationSourcePin(source, sourcePath, warmConfigs);
  const warm = phases.find(({ pin }) => same(pin, warmPin));
  if (phases.length !== 1 + Number(prerequisites.length > 0) || prerequisites.length && !warm) {
    throw new Error('Accepted warmup source/context hash differs from the required plan');
  }
  const warmup = shardEdges(warm?.rows ?? [], prerequisites);
  const definitions = workspaceModelHash(source);
  if (workspaceModelHash(reader) !== definitions) throw new Error('Current workspace definitions differ from the archive workspace');
  const workspaceScopeHash = analysisWorkspaceScopeHash(source);
  const recipeDigest = benchmarkRecipeDigest(recipes, dates, prerequisites);
  return { point, engine, dates, prerequisites, recipes, warmConfigs, observedReferenceDate, core, warmup,
    corePin, warmPin, definitions, workspaceScopeHash, recipeDigest };
}

function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(file);
    } finally { closeSync(file); }
    renameSync(temp, path);
    const folder = openSync(dirname(path), 'r');
    try { fsyncSync(folder); } finally { closeSync(folder); }
  } finally { rmSync(temp, { force: true }); }
}

function receiptStore(directory, identity) {
  const path = join(directory, 'verification-receipts.json');
  let status = { format: receiptFormat, identity, completed: {} };
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw new Error('Receipt must be a private regular file');
    status = JSON.parse(readFileSync(path, 'utf8'));
    if (status.format !== receiptFormat || !same(status.identity, identity) || !status.completed || Array.isArray(status.completed)) {
      throw new Error('Existing receipts belong to a different archive or verification plan');
    }
  } else atomicJson(path, status);
  return (name, work) => {
    if (Object.hasOwn(status.completed, name)) {
      const saved = status.completed[name];
      if (!saved?.result || saved.digest !== hash([identity, name, saved.result])) throw new Error(`Recovery receipt is invalid for ${name}`);
      return { result: saved.result, reused: true };
    }
    const result = work();
    status.completed[name] = { result, digest: hash([identity, name, result]) };
    atomicJson(path, status);
    return { result, reused: false };
  };
}

function riskRunId(reader, plan) {
  const { point, dates, recipes } = plan;
  const readerStatement = reader.prepare(`SELECT id,dates,windows,benchmarks FROM prepared_risk_history_runs
    WHERE format='risk-history-1-le' AND calculation_version=? AND data_version=? AND basis=? AND
      anchor_date=? AND first_date=? AND last_date=? AND complete=1`);
  const rows = readerStatement.all(CALCULATION_VERSION, point.dataVersion, point.basis, point.date, dates[0], dates.at(-1));
  const matches = rows.filter((row) => same(JSON.parse(row.dates), dates) && same(JSON.parse(row.windows), recipes.riskWindows)
    && same(JSON.parse(row.benchmarks), [...recipes.benchmarks].sort()));
  if (matches.length !== 1) throw new Error('Expected exactly one completed risk run for the pinned roster and sessions');
  return matches[0].id;
}

function addCounts(totals, result) {
  for (const [key, count] of Object.entries(result)) totals[key] = (totals[key] ?? 0) + count;
}

function acceptance(plan, core, instruments, calibration) {
  const counts = {
    base: core.base, velocity: core.velocity, ranks: core.ranks, breadth: core.history, monitor: core.monitor,
    detail: instruments.detailProducts, risk: instruments.risk.actualBlocks,
    ranges: instruments.ranges.pairs + instruments.ranges.exactPairs,
    health: calibration.health.prepared, nyseSummation: calibration.sum.verified,
  };
  if (Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 1)) throw new Error('A required archive product is absent');
  return {
    scope: 'all', coverageTarget: 'five-year', dateFrom: plan.dates[0], dateTo: plan.point.date, sessions: plan.dates.length,
    contexts: plan.recipes.configs.length, availableContexts: plan.recipes.availableContexts, calibration: 'full',
    readback: 'all fields on sampled sessions', workspaceScopeHash: plan.workspaceScopeHash, recipeDigest: plan.recipeDigest,
    products: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, { expected: count, verified: count }])),
  };
}

export async function verifyExistingPipeline({ sourcePath, archivePath, reportPath, receiptsDirectory, originalElapsedMs, version, to,
  sessions, referenceDate, archiveSha256, chunkSize, tileSize = 8, minimumSessions = 1260, onProgress = () => {} } = {}) {
  if (!sourcePath || !archivePath || !reportPath || !receiptsDirectory) throw new Error('Provide --source, --archive, --report and --receipts');
  if (!Number.isSafeInteger(originalElapsedMs) || originalElapsedMs < 1) throw new Error('Provide the recorded --original-elapsed-ms');
  numberOption(tileSize, 1, 8, 'verification tile size');
  const started = performance.now();
  const sourceFile = regularFile(sourcePath), archiveFile = regularFile(archivePath);
  if (sourceFile === archiveFile) throw new Error('Source and archive must be separate files');
  const report = resolve(reportPath), receipts = resolve(receiptsDirectory);
  if (report === sourceFile || report === archiveFile || report === join(receipts, 'verification-receipts.json') || existsSync(report)) {
    throw new Error('Choose a new report path separate from the source, archive and receipt ledger');
  }
  if (!lstatSync(dirname(report)).isDirectory()) throw new Error('Report parent directory must exist');
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  if (realpathSync(receipts) !== receipts || !lstatSync(receipts).isDirectory()) throw new Error('Recovery receipts require a regular directory');
  assertClosedArchive(archiveFile);
  const reader = readonly(archiveFile, true);
  let source;
  try {
    source = readonly(sourceFile);
    if (reader.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 2) throw new Error('Archive was not prepared for incremental publication');
    const planArgs = { version, to, sessions, referenceDate, chunkSize, minimumSessions };
    const plan = verificationPlan(reader, source, sourceFile, planArgs);
    onProgress({ phase: 'seal-start' });
    const seal = await archiveSeal(archiveFile);
    if (archiveSha256 && (!isHash(archiveSha256) || archiveSha256 !== seal.sha256)) throw new Error('Archive SHA-256 does not match the supplied seal');
    const identity = { archive: seal, sourceFile, archiveFile, corePin: plan.corePin, warmPin: plan.warmPin,
      workspaceDefinitions: plan.definitions, workspaceScopeHash: plan.workspaceScopeHash, recipeDigest: plan.recipeDigest,
      core: plan.core, warmup: plan.warmup, originalElapsedMs, tileSize };
    const checkpoint = receiptStore(receipts, identity);
    const core = {}, warmup = {};
    function observed(phase, surveyDates, work, totals) {
      let completed = 0;
      for (const tile of dateTiles(surveyDates, tileSize)) {
        const receipt = checkpoint(`${phase}:${tile[0]}:${tile.at(-1)}`, () => work(tile));
        addCounts(totals, receipt.result);
        completed += tile.length;
        onProgress({ phase, completed, total: surveyDates.length, through: tile.at(-1), reused: receipt.reused });
      }
    }
    observed('core-products', plan.dates, (tile) => verifyCoreTile(reader, plan.engine, plan.recipes.configs, tile,
      { sampleDates: [plan.dates[0], plan.dates.at(-1)] }), core);
    observed('warmup-breadth', plan.prerequisites, (tile) => verifyCoreTile(reader, plan.engine, plan.warmConfigs, tile), warmup);
    const instruments = checkpoint('instruments', () => verifyInstrumentProducts(reader, source, plan.engine, plan.point, plan.dates,
      plan.recipes, { risk: { runId: riskRunId(reader, plan) }, riskFrom: plan.dates[0] })).result;
    onProgress({ phase: 'instruments-complete', securities: instruments.detailProducts });
    const calibration = checkpoint('calibration', () => verifyCalibrationProducts(reader, source, plan.engine, plan.point,
      plan.recipes.configs, plan.dates, warmup.history ?? 0)).result;
    onProgress({ phase: 'calibration-complete', healthRows: calibration.health.physicalRows });
    const archiveDates = new Set([...plan.prerequisites, ...plan.dates]);
    const boundaryOracle = [];
    for (const [phase, frames, config, archiveSpan] of [
      ['core', plan.core.dates, plan.recipes.configs, archiveDates],
      ['breadth-warmup', plan.warmup.dates, plan.warmConfigs, new Set(plan.prerequisites)],
    ]) {
      if (!frames.length) continue;
      const totals = {};
      observed(`oracle-${phase}`, frames, (tile) => verifyBoundaryWindow(reader, plan.engine, config, tile, archiveSpan,
        { directory: receipts, tileSize }), totals);
      if (totals.sessions !== frames.length || !(totals.leaderContexts > 0) || phase === 'core' && !(totals.velocitySnapshots > 0)) {
        throw new Error(`Independent ${phase} boundary oracle did not cover its required frames`);
      }
      boundaryOracle.push({ phase, ...totals });
    }
    onProgress({ phase: 'seal-end' });
    const final = await archiveSeal(archiveFile);
    if (!same(final, seal)) throw new Error('Archive seal changed during recovery');
    const ending = verificationPlan(reader, source, sourceFile, { ...planArgs, referenceDate: plan.observedReferenceDate });
    if (!same(ending.corePin, plan.corePin) || !same(ending.warmPin, plan.warmPin) || ending.workspaceScopeHash !== plan.workspaceScopeHash ||
        ending.definitions !== plan.definitions || ending.recipeDigest !== plan.recipeDigest) throw new Error('Source or workspace changed during recovery');
    const verification = acceptance(plan, core, instruments, calibration);
    const result = {
      format: receiptFormat, state: 'verified', source: 'read-only pinned revisions', sourcePin: plan.corePin,
      dataVersion: plan.point.dataVersion, calculationVersion: CALCULATION_VERSION, archive: { bytes: seal.bytes, sha256: seal.sha256 },
      verification, products: { core, warmup, instruments, calibration }, boundaryOracle, referenceDate: plan.observedReferenceDate,
      performance: { measuredColdElapsedMs: originalElapsedMs, targetMs: 600_000, targetMet: originalElapsedMs <= 600_000,
        originalPhaseTimings: null, originalOutcome: 'interrupted-verification', verificationElapsedMs: Math.round(performance.now() - started) },
    };
    atomicJson(report, result);
    return result;
  } finally {
    source?.close();
    reader.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { values } = parseArgs({ options: {
      source: { type: 'string' }, archive: { type: 'string' }, report: { type: 'string' }, receipts: { type: 'string' },
      'original-elapsed-ms': { type: 'string' }, version: { type: 'string' }, to: { type: 'string' }, sessions: { type: 'string' },
      'reference-date': { type: 'string' }, 'archive-sha256': { type: 'string' }, 'chunk-size': { type: 'string' }, 'tile-size': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: node scripts/verify-existing-pipeline.mjs --source FILE --archive FILE --report NEW_FILE --receipts DIRECTORY --original-elapsed-ms MS [--version N --to YYYY-MM-DD --sessions N --reference-date YYYY-MM-DD --chunk-size N --tile-size N --archive-sha256 HEX]');
    else {
      const optional = (key, minimum, maximum) => values[key] == null ? undefined : numberOption(values[key], minimum, maximum, key);
      const result = await verifyExistingPipeline({ sourcePath: values.source, archivePath: values.archive,
        reportPath: values.report, receiptsDirectory: values.receipts, originalElapsedMs: Number(values['original-elapsed-ms']),
        version: optional('version', 1, Number.MAX_SAFE_INTEGER), to: values.to, sessions: optional('sessions', 1260, 7560),
        referenceDate: values['reference-date'], archiveSha256: values['archive-sha256'], chunkSize: optional('chunk-size', 1, 120),
        tileSize: optional('tile-size', 1, 8), onProgress: (event) => console.error(JSON.stringify(event)) });
      console.log(JSON.stringify({ state: result.state, dataVersion: result.dataVersion, calculationVersion: result.calculationVersion,
        archive: result.archive, report: resolve(values.report), performance: result.performance }));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

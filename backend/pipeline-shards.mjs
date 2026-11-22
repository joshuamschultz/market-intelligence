import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { referenceArchiveScopes } from './archive-lineage.mjs';
import { preparationDependencies, preparationSeedKey } from './batch-preparation.mjs';
import { isMarketSession } from './calendar.mjs';
import { CALCULATION_VERSION, dataVersion, isoDate } from './database.mjs';
import { createEngine } from './engine.mjs';
import { decodeStoredJson } from './storage-codec.mjs';

export const preparationShardFormat = 'preparation-shard-1';
const manifestTable = 'accepted_preparation_shard_dates';
const diskReserve = 1024n ** 3n;
const axis = 'calculation_version:T data_version:I basis:T date:T';
const specs = [];

function allowTable(name, fields, primary, nullable = []) {
  const types = { T: 'TEXT', I: 'INTEGER', B: 'BLOB' };
  const columns = fields.split(' ').map((field) => {
    const [name, type] = field.split(':');
    return { name, type: types[type], notnull: Number(!nullable.includes(name)), pk: primary.indexOf(name) + 1 };
  });
  const names = columns.map(({ name }) => name);
  const schema = columns.map(({ name, type, notnull }) => `${name} ${type}${notnull ? ' NOT NULL' : ''}`);
  specs.push({ name, columns, names, create: `CREATE TABLE IF NOT EXISTS ${name} (${schema.join(',')}, PRIMARY KEY(${primary.join(',')})) WITHOUT ROWID` });
}

const primaryAxis = ['calculation_version', 'data_version', 'basis', 'date'];
allowTable('prepared_stock_base', `${axis} bucket:I value:B`, [...primaryAxis, 'bucket']);
allowTable('prepared_snapshot_layouts', `${axis} layout:T value:B`, [...primaryAxis, 'layout']);
allowTable('prepared_snapshot_contexts', `${axis} recipe:T layout:T stock_count:I delta_mask:I header:T`, [...primaryAxis, 'recipe']);
allowTable('prepared_snapshot_deltas', `${axis} recipe:T bucket:I blob:T`, [...primaryAxis, 'recipe', 'bucket']);
allowTable('prepared_snapshot_blobs', `${axis} blob:T value:B`, [...primaryAxis, 'blob']);
allowTable('prepared_snapshot_frames', `${axis} frame:T bucket:I value:B`, [...primaryAxis, 'frame', 'bucket']);
allowTable('prepared_rank_dates', 'recipe:T data_version:I date:T', ['recipe', 'data_version', 'date']);
allowTable('prepared_rank_blocks', 'recipe:T data_version:I date:T bucket:I value:B', ['recipe', 'data_version', 'date', 'bucket']);
allowTable('market_history', 'universe:T model:T data_version:I calculation_version:T definition_key:T date:T value:T created_at:T',
  ['universe', 'model', 'data_version', 'calculation_version', 'definition_key', 'date']);
allowTable('market_history_group_blocks', `${axis} blob:T value:B`, [...primaryAxis, 'blob']);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function preparationSeedSeal(seeds) {
  if (!seeds) return null;
  const hash = createHash('sha256');
  for (const entry of seeds) hash.update(JSON.stringify(entry));
  return hash.digest('hex');
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const configOf = (input) => input.config ?? input;
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);

function requireSchema(db, spec) {
  const actual = db.prepare(`PRAGMA table_info(${spec.name})`).all()
    .map(({ name, type, notnull, pk, dflt_value }) => ({ name, type, notnull, pk, dflt_value }));
  if (!same(actual.map(({ dflt_value, ...field }) => field), spec.columns) || actual.some(({ dflt_value }) => dflt_value != null)) {
    throw new Error(`Invalid archive schema for ${spec.name}`);
  }
}

export function preparationSourcePin(source, sourcePath, configurations) {
  if (!configurations.length) throw new TypeError('At least one resolved preparation context is required');
  const version = configOf(configurations[0]).dataVersion;
  if (!Number.isInteger(version) || version < 0 || version > dataVersion(source)) throw new Error('Preparation revision is unavailable on the pinned source');
  if (configurations.some((input) => {
    const config = configOf(input);
    return config.dataVersion !== version || !['known', 'reconstructed'].includes(config.basis) ||
      !Array.isArray(config.themes) || !config.universe?.id || !config.model?.id || !isoDate(config.date);
  })) throw new Error('Preparation contexts must use one pinned revision and resolved definitions');
  const file = statSync(sourcePath, { bigint: true });
  const lineage = source.prepare(`SELECT id,version,fingerprint FROM ingestion_runs
    WHERE version=? AND status='complete' ORDER BY id`).all(version);
  return { calculationVersion: CALCULATION_VERSION, dataVersion: version,
    sourceHash: digest([String(file.dev), String(file.ino), lineage]), contextHash: digest(configurations) };
}

function expectedArtifacts(engine, configurations, dates) {
  const counts = Object.fromEntries(['prepared_snapshot_contexts', 'prepared_rank_dates', 'market_history'].map((table) => [table, new Set()]));
  for (const input of configurations) {
    const { config, rank: rankEnabled = true, historyOnly = false } = input.config ? input : { config: input };
    const rank = rankEnabled && !historyOnly;
    for (const scope of referenceArchiveScopes(config, dates.filter((date) => config.earliestDate <= date && date <= config.date))) {
      const { universe, model, basis, benchmark, referenceMode, observedReferenceDate } = scope.config;
      const definition = engine.definitionKey(scope.config);
      const history = digest([2, definition]);
      const entries = ['base', ...(rank ? ['velocity'] : [])].map((type) => digest(['prepared-stock-2',
        type, universe.id, universe.version, model.id, model.version, basis, referenceMode, definition]));
      const compact = digest([CALCULATION_VERSION, 'rank-block-1', universe.id, universe.version, model.id, model.version,
        basis, benchmark, referenceMode, referenceMode === 'latest' ? observedReferenceDate : null]).slice(0, 24);
      for (const date of scope.dates) {
        counts.market_history.add(JSON.stringify([date, `${universe.id}@${universe.version}`, `${model.id}@${model.version}`, history]));
        if (!historyOnly) for (const recipe of entries) counts.prepared_snapshot_contexts.add(JSON.stringify([date, basis, recipe]));
        if (rank) counts.prepared_rank_dates.add(JSON.stringify([date, compact]));
      }
    }
  }
  return counts;
}

function confirmRequiredKeys(db, requested, table, columns) {
  const keys = requested[table];
  if (!hasTable(db, table)) {
    if (keys.size) throw new Error(`Shard is missing required ${table}`);
    return;
  }
  for (const row of db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).iterate()) {
    if (!keys.delete(JSON.stringify(columns.map((column) => row[column])))) throw new Error(`Shard contains an unexpected ${table} recipe`);
  }
  if (keys.size) throw new Error(`Shard is missing ${keys.size} expected ${table} recipes`);
}

function requireProducts(db, engine, request) {
  const keys = expectedArtifacts(engine, request.configurations, request.dates);
  confirmRequiredKeys(db, keys, 'prepared_snapshot_contexts', ['date', 'basis', 'recipe']);
  confirmRequiredKeys(db, keys, 'prepared_rank_dates', ['date', 'recipe']);
  confirmRequiredKeys(db, keys, 'market_history', ['date', 'universe', 'model', 'definition_key']);
  if (hasTable(db, 'prepared_rank_blocks') && db.prepare(`SELECT 1 FROM prepared_rank_blocks b
    LEFT JOIN prepared_rank_dates d USING(recipe,data_version,date) WHERE d.recipe IS NULL LIMIT 1`).get()) {
    throw new Error('Shard contains a rank block without its session manifest');
  }
  if (hasTable(db, 'prepared_snapshot_contexts')) {
    const key = 'calculation_version,data_version,basis,date';
    const layout = db.prepare(`SELECT value FROM prepared_snapshot_layouts WHERE calculation_version=? AND data_version=? AND basis=? AND date=? AND layout=?`);
    const frames = hasTable(db, 'prepared_snapshot_frames') ? new Set(db.prepare(`SELECT ${key},frame,bucket FROM prepared_snapshot_frames`)
      .all().map(({ calculation_version, data_version, basis, date, frame, bucket }) => JSON.stringify([calculation_version, data_version, basis, date, frame, bucket]))) : new Set();
    const manifests = db.prepare(`SELECT c.${key.replaceAll(',', ',c.')}, c.layout,c.stock_count,c.delta_mask,b.blob AS header
      FROM prepared_snapshot_contexts c LEFT JOIN prepared_snapshot_blobs b
      ON c.calculation_version=b.calculation_version AND c.data_version=b.data_version AND c.basis=b.basis AND c.date=b.date AND c.header=b.blob`);
    const layouts = new Map();
    for (const row of manifests.iterate()) {
      const axis = [row.calculation_version, row.data_version, row.basis, row.date];
      const id = JSON.stringify([...axis, row.layout]);
      if (!row.header) throw new Error('Shard is missing a prepared snapshot header');
      if (!layouts.has(id)) {
        const value = layout.get(...axis, row.layout)?.value;
        if (!value) throw new Error('Shard is missing a prepared snapshot layout');
        layouts.set(id, decodeStoredJson(value));
      }
      const [format, frame] = layouts.get(id);
      if (typeof format === 'string' && format.startsWith('typed-stock-')) {
        if (row.stock_count && !row.delta_mask) throw new Error('Nonempty shard snapshot has no stock frame');
        for (let bucket = 0; bucket < 32; bucket++) {
          if (row.delta_mask & (1 << bucket) && !frames.has(JSON.stringify([...axis, frame, bucket]))) {
            throw new Error('Shard is missing a referenced prepared stock frame');
          }
        }
      }
    }
  }
}

export function preparationShardInventory(db, request) {
  const dates = new Set(request.dates);
  const bases = new Set(request.configurations.map((input) => configOf(input).basis));
  const inventory = {};
  if (dataVersion(db) !== request.pin.dataVersion) throw new Error('Shard metadata revision does not match its source pin');
  for (const table of ['daily_prices', 'price_revisions', 'jobs', 'workspace']) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error(`Shard unexpectedly contains ${table} rows`);
  }
  for (const spec of specs) {
    const { name, names } = spec;
    if (!hasTable(db, name)) continue;
    requireSchema(db, spec);
    const projection = ['date', 'data_version', ...['calculation_version', 'basis'].filter((column) => names.includes(column))];
    const blobLength = names.includes('value') ? 'sum(length(value))' : '0';
    const rows = db.prepare(`SELECT ${projection.join(',')},count(*) AS count,${blobLength} AS bytes FROM ${name}
      GROUP BY ${projection.join(',')} ORDER BY ${projection.join(',')}`).all();
    for (const row of rows) {
      if (!dates.has(row.date) || row.data_version !== request.pin.dataVersion ||
        Object.hasOwn(row, 'calculation_version') && row.calculation_version !== request.pin.calculationVersion ||
        Object.hasOwn(row, 'basis') && !bases.has(row.basis)) throw new Error(`Shard contains an out-of-scope ${name} row`);
    }
    if (rows.length) inventory[name] = rows;
  }
  return inventory;
}

export async function checksumPreparationShard(filename) {
  const info = lstatSync(filename);
  if (!info.isFile() || info.nlink !== 1) throw new Error('Shard must be a private regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const after = lstatSync(filename);
  if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    throw new Error('Shard file changed while its checksum was verified');
  }
  return { bytes: info.size, sha256: hash.digest('hex') };
}

function publicationId(pin) {
  return digest([preparationShardFormat, pin]);
}

function acceptedDates(target, pin) {
  if (!hasTable(target, manifestTable)) return new Set();
  return new Set(target.prepare(`SELECT date FROM ${manifestTable} WHERE publication=?`)
    .all(publicationId(pin)).map(({ date }) => date));
}

function assertSeparateFiles(source, destination) {
  if (!destination) return;
  const a = statSync(source);
  const b = statSync(destination);
  if (a.ino === b.ino && a.dev === b.dev) throw new Error('The source warehouse cannot be the preparation destination');
}

function availableBytes(path) {
  const { bavail, bsize } = statfsSync(path, { bigint: true });
  return bavail * bsize;
}

export async function mergePreparationShard(target, engine, request, manifest, { signal, sourceDb } = {}) {
  signal?.throwIfAborted();
  if (target.isTransaction) throw new Error('Shard publication requires an idle destination connection');
  if (manifest.format !== preparationShardFormat || !same(manifest.pin, request.pin) || request.pin.calculationVersion !== CALCULATION_VERSION ||
    !same(manifest.dates, request.dates) || manifest.seedHash !== (request.seedHash ?? null)) {
    throw new Error('Shard manifest does not match its requested source, recipe, seeds or date ownership');
  }
  assertSeparateFiles(request.sourcePath, target.location());
  const upstream = sourceDb ?? new DatabaseSync(request.sourcePath, { readOnly: true });
  try {
    if (!same(preparationSourcePin(upstream, request.sourcePath, request.configurations), request.pin)) {
      throw new Error('Shard source or resolved recipe pin does not match the supplied plan');
    }
  } finally { if (!sourceDb) upstream.close(); }
  const seal = await checksumPreparationShard(request.sidecarPath);
  if (!same(seal, manifest.seal) || seal.bytes > request.maxBytes) throw new Error('Shard file checksum, size or budget verification failed');
  const read = new DatabaseSync(request.sidecarPath, { readOnly: true });
  let inventory;
  try {
    read.exec('PRAGMA trusted_schema=OFF');
    inventory = preparationShardInventory(read, request);
    if (!same(inventory, manifest.inventory)) throw new Error('Shard table counts do not match its sealed manifest');
    requireProducts(read, engine, request);
  } finally { read.close(); }
  signal?.throwIfAborted();
  const start = performance.now();
  const destination = target.location();
  if (destination && availableBytes(dirname(destination)) < BigInt(seal.bytes) + diskReserve) {
    throw new Error('Insufficient destination space to merge the sealed shard while preserving warehouse reserve');
  }
  const source = pathToFileURL(request.sidecarPath);
  source.search = '?mode=ro&immutable=1';
  const previousSync = target.prepare('PRAGMA main.synchronous').get().synchronous;
  target.prepare('ATTACH DATABASE ? AS pipeline_shard').run(source.href);
  try {
    target.exec('PRAGMA main.synchronous=FULL');
    target.exec('BEGIN IMMEDIATE');
    const published = acceptedDates(target, request.pin);
    if (request.dates.some((date) => published.has(date))) throw new Error('Shard overlaps an already accepted date');
    for (const spec of specs) {
      if (!inventory[spec.name]) continue;
      target.exec(spec.create);
      requireSchema(target, spec);
      const names = spec.names.join(',');
      const result = target.prepare(`INSERT INTO main.${spec.name} (${names}) SELECT ${names} FROM pipeline_shard.${spec.name}`).run();
      const expected = inventory[spec.name].reduce((sum, row) => sum + row.count, 0);
      if (result.changes !== expected) throw new Error(`Shard copy count did not reconcile for ${spec.name}`);
    }
    if (inventory.prepared_snapshot_contexts) target.exec(`CREATE INDEX IF NOT EXISTS prepared_snapshot_context_history
      ON prepared_snapshot_contexts (calculation_version,basis,recipe,date,data_version)`);
    target.exec(`CREATE TABLE IF NOT EXISTS ${manifestTable} (
      publication TEXT NOT NULL, date TEXT NOT NULL, manifest_hash TEXT NOT NULL,
      source_hash TEXT NOT NULL, calculation_version TEXT NOT NULL, data_version INTEGER NOT NULL,
      context_hash TEXT NOT NULL, accepted_at TEXT NOT NULL, PRIMARY KEY(publication,date)) WITHOUT ROWID`);
    const add = target.prepare(`INSERT INTO ${manifestTable} VALUES (?,?,?,?,?,?,?,?)`);
    const publication = publicationId(request.pin);
    const manifestHash = digest(manifest);
    const timestamp = new Date().toISOString();
    for (const date of request.dates) {
      add.run(publication, date, manifestHash, request.pin.sourceHash, CALCULATION_VERSION, request.pin.dataVersion, request.pin.contextHash, timestamp);
    }
    signal?.throwIfAborted();
    target.exec('COMMIT');
    return { bytes: seal.bytes, mergeMs: performance.now() - start };
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  } finally {
    target.exec(`PRAGMA main.synchronous=${previousSync}`);
    target.exec('DETACH DATABASE pipeline_shard');
  }
}

function within(value, lower, upper, label) {
  if (!Number.isSafeInteger(value) || value < lower || value > upper) throw new RangeError(`${label} must be an integer from ${lower} to ${upper}`);
  return value;
}

export async function prepareParallelSnapshots({ sourcePath, targetDb, configurations, dates, workers = 4, chunkSize = 12,
  tileSize, codec, directory, workerHeapMb = 4096, maxPendingBytes = 4 * 1024 ** 3, signal, onProgress, dependencySeeds } = {}) {
  signal?.throwIfAborted();
  if (!sourcePath || !targetDb?.isOpen || targetDb.isTransaction) throw new TypeError('A file-backed source and idle destination are required');
  if (!Array.isArray(configurations) || !configurations.length || !Array.isArray(dates) ||
    dates.some((date, index) => !isoDate(date) || !isMarketSession(date) || index > 0 && date <= dates[index - 1])) {
    throw new TypeError('Pass resolved contexts and ascending unique market sessions');
  }
  within(workers, 1, 16, 'Worker count');
  within(chunkSize, 1, 120, 'Shard sessions');
  within(workerHeapMb, 128, 32768, 'Worker heap MB');
  within(maxPendingBytes, workers * 1024 ** 2, 128 * 1024 ** 3, 'Pending shard byte budget');
  const source = resolve(sourcePath);
  const destination = targetDb.location();
  assertSeparateFiles(source, destination);
  // Clone once so caller changes after the first await cannot alter the ordered plan.
  const contexts = structuredClone(configurations);
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  const active = new Set();
  const workersDone = [];
  const cancelled = new AbortController();
  let failure;
  let root;
  let settleMerges = Promise.resolve();
  const stop = (reason) => {
    failure ??= reason;
    cancelled.abort(failure);
    for (const worker of active) void worker.terminate();
  };
  const abort = () => stop(signal?.reason ?? new DOMException('Preparation aborted', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const pin = preparationSourcePin(sourceDb, source, contexts);
    if (dates.some((date) => !contexts.some((input) => {
      const config = configOf(input);
      return config.earliestDate <= date && date <= config.date;
    }))) throw new Error('Every shard date must belong to at least one requested recipe');
    const engine = createEngine(sourceDb);
    const already = acceptedDates(targetDb, pin);
    const pending = dates.filter((date) => !already.has(date));
    const queue = [];
    for (let index = 0; index < pending.length; index += chunkSize) queue.push(pending.slice(index, index + chunkSize));
    const count = Math.min(workers, queue.length);
    const totals = { sessions: dates.length, contexts: contexts.length, workers: count, commits: 0, completedDates: dates.length - pending.length,
      resumedDates: dates.length - pending.length, calculationMs: 0, storageMs: 0, projectionMs: 0, mergeMs: 0,
      producedSessions: 0, producedContexts: 0, seededWeeks: 0, seededLeaderDays: 0, bytes: 0, peakRssBytes: 0,
      written: { base: 0, velocity: 0, rank: 0, history: 0 }, reused: { base: 0, velocity: 0, rank: 0, history: 0 },
      boundaryMode: dependencySeeds ? 'sealed-seeds' : 'local-recompute' };
    if (!count) return totals;
    if (dependencySeeds != null && !(dependencySeeds instanceof Map)) throw new TypeError('Preparation dependency seeds must be a Map');
    const scratch = resolve(directory ?? (destination ? dirname(destination) : tmpdir()));
    mkdirSync(scratch, { recursive: true });
    root = mkdtempSync(join(scratch, 'market-preparation-'));
    const maxBytes = Math.floor(maxPendingBytes / count);
    const sameVolume = destination && statSync(root).dev === statSync(destination).dev;
    const inFlight = BigInt(maxBytes) * BigInt(count);
    const mergeSpace = BigInt(maxBytes);
    if (availableBytes(root) < inFlight + (sameVolume ? mergeSpace : 0n) + diskReserve ||
        destination && !sameVolume && availableBytes(dirname(destination)) < mergeSpace + diskReserve) {
      throw new Error('Insufficient disk space for pending shard budget and warehouse reserve');
    }
    let next = 0;
    async function lane() {
      while (!failure && next < queue.length) {
        const index = next++;
        const shardDates = queue[index];
        const seedEntries = new Map();
        if (dependencySeeds) for (const { config, kind, date } of preparationDependencies(contexts, shardDates)) {
          const key = preparationSeedKey(engine, config, kind, date);
          if (dependencySeeds.has(key)) seedEntries.set(key, dependencySeeds.get(key));
        }
        const request = { sourcePath: source, sidecarPath: join(root, `chunk-${index}.sqlite`), pin, configurations: contexts,
          dates: shardDates, maxBytes, tileSize, codec, dependencySeeds: dependencySeeds ? seedEntries : null,
          seedHash: preparationSeedSeal(dependencySeeds ? seedEntries : null) };
        let worker;
        try {
          const manifest = await new Promise((resolve, reject) => {
            worker = new Worker(new URL('./pipeline-shard-worker.mjs', import.meta.url), {
              workerData: request, resourceLimits: { maxOldGenerationSizeMb: workerHeapMb }, execArgv: [],
            });
            active.add(worker);
            let result;
            let error;
            worker.on('message', (message) => {
              if (message.type === 'result') result = message.manifest;
              else if (message.type === 'failure') error = new Error(message.error);
              else if (message.type === 'progress') {
                try { onProgress?.({ phase: 'compute', shard: index + 1, completedDates: totals.completedDates, totalDates: dates.length, ...message.event }); }
                catch (reason) { stop(reason); }
              }
            });
            worker.on('error', (reason) => { error = reason; });
            worker.on('exit', (code) => {
              active.delete(worker);
              if (code === 0 && result && !error) resolve(result);
              else reject(error ?? new Error(`Preparation worker exited without a complete shard (code ${code})`));
            });
          });
          // A checksum await may allow another worker to finish; only one merge
          // may attach a sidecar or mutate the destination at a time.
          const publish = settleMerges.then(async () => {
            if (failure) throw failure;
            const merged = await mergePreparationShard(targetDb, engine, request, manifest, { signal: cancelled.signal, sourceDb });
            totals.completedDates += shardDates.length;
            totals.bytes += merged.bytes;
            totals.mergeMs += merged.mergeMs;
            totals.peakRssBytes = Math.max(totals.peakRssBytes, manifest.peakRssBytes);
            for (const name of ['commits', 'calculationMs', 'projectionMs', 'storageMs', 'producedSessions', 'producedContexts', 'seededWeeks', 'seededLeaderDays']) {
              totals[name] += manifest.totals[name];
            }
            for (const name of ['written', 'reused']) for (const product of Object.keys(totals[name])) totals[name][product] += manifest.totals[name][product];
            rmSync(request.sidecarPath);
            onProgress?.({ phase: 'merge', shard: index + 1, date: shardDates.at(-1),
              completedDates: totals.completedDates, totalDates: dates.length, bytes: totals.bytes });
          });
          settleMerges = publish;
          await publish;
        } catch (error) {
          stop(error);
          throw failure;
        }
      }
    }
    for (let index = 0; index < count; index++) workersDone.push(lane());
    const outcomes = await Promise.allSettled(workersDone);
    const rejected = outcomes.find((item) => item.status === 'rejected');
    if (failure || rejected) {
      const error = failure ?? rejected.reason;
      if (error && Object.isExtensible(error)) error.preparationScratch = root;
      throw error;
    }
    return totals;
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const worker of active) void worker.terminate();
    await Promise.allSettled(workersDone);
    sourceDb.close();
    if (root) {
      // Completed sidecars are unlinked after commit. A partial or rejected
      // sidecar stays isolated in this private directory for diagnosis.
      try { rmdirSync(root); }
      catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
    }
  }
}

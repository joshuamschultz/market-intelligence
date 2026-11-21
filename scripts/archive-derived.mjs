import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createGunzip, createGzip } from 'node:zlib';

const tables = [
  {
    name: 'snapshots',
    columns: ['kind', 'date', 'universe', 'model', 'data_version', 'calculation_version', 'definition_key', 'value', 'created_at'],
    key: 'kind,date,universe,model,data_version,calculation_version,definition_key',
  },
  {
    name: 'market_history',
    columns: ['universe', 'model', 'data_version', 'calculation_version', 'definition_key', 'date', 'value', 'created_at'],
    key: 'universe,model,data_version,calculation_version,definition_key,date',
  },
  {
    name: 'rank_archive_dates',
    columns: ['recipe', 'date', 'data_version', 'calculation_version', 'observations', 'created_at'],
    key: 'recipe,data_version,calculation_version,date',
  },
  {
    name: 'stock_rank_history',
    columns: ['recipe', 'date', 'data_version', 'calculation_version', 'security_id', 'symbol', 'rank', 'percentile', 'score'],
    key: 'recipe,data_version,calculation_version,date,security_id',
  },
].map((table) => ({ ...table, calculation: table.columns.indexOf('calculation_version'), data: table.columns.indexOf('data_version') }));
const byName = new Map(tables.map((table) => [table.name, table]));
const scope = 'data_version=? AND calculation_version=?';
const format = 'market-intelligence-derived-archive-v1';
const payloadName = 'archive.ndjson.gz';
const manifestName = 'manifest.json';
const hash = () => createHash('sha256');
const blankCounts = () => Object.fromEntries(tables.map(({ name }) => [name, 0]));

function selectedVersion({ calculationVersion, dataVersion }) {
  if (typeof calculationVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(calculationVersion)) {
    throw new TypeError('An explicit calculation version is required');
  }
  if (typeof dataVersion === 'string' && /^\d+$/.test(dataVersion)) dataVersion = Number(dataVersion);
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) throw new TypeError('An explicit integer data version is required');
  return { calculationVersion, dataVersion };
}

function presentTables(db) {
  const found = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN (?,?,?,?)")
    .all(...byName.keys());
  return new Set(found.map(({ name }) => name));
}

function countsFor(db, selection, present) {
  const counts = blankCounts();
  for (const { name } of tables) {
    if (present.has(name)) {
      counts[name] = db.prepare(`SELECT count(*) AS n FROM ${name} WHERE ${scope}`)
        .get(selection.dataVersion, selection.calculationVersion).n;
    }
  }
  return counts;
}

export function countDerivedArchive(db, options) {
  const selection = selectedVersion(options);
  db.exec('BEGIN');
  try {
    return { ...selection, counts: countsFor(db, selection, presentTables(db)) };
  } finally {
    db.exec('ROLLBACK');
  }
}

function encode(value) {
  if (value instanceof Uint8Array) return { blob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : { integer: value.toString() };
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { real: Object.is(value, -0) ? '-0' : String(value) };
  }
  return value;
}

function decode(value) {
  if (value === null || typeof value === 'string' || Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && Object.keys(value).length === 1) {
    if (typeof value.blob === 'string') {
      const bytes = Buffer.from(value.blob, 'base64');
      if (bytes.toString('base64') === value.blob) return bytes;
    }
    if (typeof value.integer === 'string' && /^-?\d{1,19}$/.test(value.integer)) {
      const integer = BigInt(value.integer);
      if (integer >= -9223372036854775808n && integer <= 9223372036854775807n) return integer;
    }
    if (['-0', 'Infinity', '-Infinity'].includes(value.real)) return Number(value.real);
  }
  throw new Error('Archive contains an invalid SQLite value');
}

function* linesFromDatabase(db, selection, present, counts, signal) {
  for (const { name, columns, key } of tables) {
    if (!present.has(name)) continue;
    const statement = db.prepare(`SELECT ${columns.join(',')} FROM ${name} WHERE ${scope} ORDER BY ${key}`);
    statement.setReturnArrays(true);
    statement.setReadBigInts(true);
    for (const row of statement.iterate(selection.dataVersion, selection.calculationVersion)) {
      if (counts[name] % 1024 === 0) signal?.throwIfAborted();
      counts[name]++;
      yield JSON.stringify([name, ...row.map(encode)]) + '\n';
    }
  }
}

function* exportChunks(db, selection, present, counts, signal) {
  let chunk = '';
  for (const line of linesFromDatabase(db, selection, present, counts, signal)) {
    chunk += line;
    if (chunk.length >= 256 * 1024) {
      yield chunk;
      chunk = '';
    }
  }
  if (chunk) yield chunk;
}

function digestThrough(digest) {
  return new Transform({
    transform(chunk, _encoding, done) {
      digest.update(chunk);
      done(null, chunk);
    },
  });
}

async function syncPath(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function validateManifest(manifest) {
  if (!manifest || manifest.format !== format || manifest.payload !== payloadName) throw new Error('Unknown archive format');
  const selection = selectedVersion(manifest);
  if (selection.dataVersion !== manifest.dataVersion) throw new Error('Invalid manifest data version');
  for (const digest of [manifest.sha256, manifest.ndjsonSha256]) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid archive checksum');
  }
  if (!manifest.counts || Object.keys(manifest.counts).length !== tables.length ||
    tables.some(({ name }) => !Number.isSafeInteger(manifest.counts[name]) || manifest.counts[name] < 0)) {
    throw new Error('Invalid archive row counts');
  }
  return selection;
}

async function scanBundle(directory, manifest, { signal, onRow } = {}) {
  const selection = validateManifest(manifest);
  const compressed = hash();
  const uncompressed = hash();
  const counts = blankCounts();
  const decoder = new StringDecoder();
  let fragments = [];

  function consume(line) {
    const row = JSON.parse(line);
    const table = Array.isArray(row) && byName.get(row[0]);
    if (!table || row.length !== table.columns.length + 1 ||
      row[table.calculation + 1] !== selection.calculationVersion || row[table.data + 1] !== selection.dataVersion) {
      throw new Error('Archive row is outside the declared scope');
    }
    if (++counts[table.name] > manifest.counts[table.name]) throw new Error('Archive row count exceeds manifest');
    const values = row.slice(1).map(decode);
    onRow?.(table, values);
  }

  await pipeline(createReadStream(join(directory, payloadName)), digestThrough(compressed), createGunzip(),
    async (source) => {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        uncompressed.update(chunk);
        const data = decoder.write(chunk);
        let start = 0;
        for (let end = data.indexOf('\n'); end !== -1; end = data.indexOf('\n', start)) {
          if (fragments.length) {
            fragments.push(data.slice(start, end));
            consume(fragments.join(''));
            fragments = [];
          } else consume(data.slice(start, end));
          start = end + 1;
        }
        if (start < data.length) fragments.push(data.slice(start));
      }
      if (fragments.length || decoder.end()) throw new Error('Archive has an incomplete NDJSON record');
    }, { signal });

  if (compressed.digest('hex') !== manifest.sha256 || uncompressed.digest('hex') !== manifest.ndjsonSha256 ||
    !sameCounts(counts, manifest.counts)) throw new Error('Archive checksum or row count verification failed');
}

const sameCounts = (first, second) => tables.every(({ name }) => first[name] === second[name]);
const commitCounter = (db) => db.prepare('PRAGMA data_version').get().data_version;

function rejectTriggers(db) {
  const trigger = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name IN (?,?,?,?) LIMIT 1")
    .get(...byName.keys());
  if (trigger) throw new Error('Archive tables have a trigger that could affect rows outside the requested slice');
}

function checkpoint(db) {
  try { return { ...db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() }; }
  catch (error) { return { error: error.message }; }
}

export async function archiveDerived(db, options) {
  const selection = selectedVersion(options);
  if (!options.output) throw new Error('--apply requires a new --output directory');
  const directory = resolve(options.output);
  const partial = join(directory, payloadName + '.tmp');
  const manifestPartial = join(directory, manifestName + '.tmp');
  const { onProgress, signal } = options;
  signal?.throwIfAborted();
  await mkdir(directory, { mode: 0o700 });
  let durable = false;
  try {
    const exportedCounts = blankCounts();
    const compressed = hash();
    const uncompressed = hash();
    const beforeExport = commitCounter(db);
    db.exec('BEGIN');
    try {
      const present = presentTables(db);
      await pipeline(Readable.from(exportChunks(db, selection, present, exportedCounts, signal), { objectMode: false }),
        digestThrough(uncompressed), createGzip(), digestThrough(compressed),
        createWriteStream(partial, { mode: 0o600, flags: 'wx' }), { signal });
    } finally {
      db.exec('ROLLBACK');
    }
    await rename(partial, join(directory, payloadName));
    const manifest = { format, ...selection, counts: exportedCounts, payload: payloadName,
      sha256: compressed.digest('hex'), ndjsonSha256: uncompressed.digest('hex'), createdAt: new Date().toISOString() };
    await onProgress?.({ phase: 'exported', directory, counts: exportedCounts });
    await scanBundle(directory, manifest, { signal });
    await syncPath(join(directory, payloadName));
    await writeFile(manifestPartial, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await syncPath(manifestPartial);
    await rename(manifestPartial, join(directory, manifestName));
    await syncPath(directory);
    await syncPath(dirname(directory));
    durable = true;
    await onProgress?.({ phase: 'verified', directory, counts: exportedCounts });
    signal?.throwIfAborted();

    db.exec('BEGIN IMMEDIATE');
    try {
      const present = presentTables(db);
      rejectTriggers(db);
      if (!sameCounts(countsFor(db, selection, present), exportedCounts)) {
        throw new Error('Selected derived row counts changed during export; no rows were deleted');
      }
      if (commitCounter(db) !== beforeExport) {
        const current = hash();
        for (const chunk of exportChunks(db, selection, present, blankCounts(), signal)) current.update(chunk);
        if (current.digest('hex') !== manifest.ndjsonSha256) {
          throw new Error('Selected derived rows changed during export; no rows were deleted');
        }
      }
      for (const { name } of tables) {
        signal?.throwIfAborted();
        if (!exportedCounts[name]) continue;
        const result = db.prepare(`DELETE FROM ${name} WHERE ${scope}`).run(selection.dataVersion, selection.calculationVersion);
        if (result.changes !== exportedCounts[name]) throw new Error('Archive deletion count differs from the manifest');
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return { directory, ...manifest, checkpoint: checkpoint(db) };
  } finally {
    if (!durable) {
      for (const path of [partial, manifestPartial, join(directory, payloadName), join(directory, manifestName)]) {
        await unlink(path).catch(() => {});
      }
      await rmdir(directory).catch(() => {});
    }
  }
}

async function readManifest(directory) {
  return JSON.parse(await readFile(join(directory, manifestName), 'utf8'));
}

export async function verifyDerivedArchive(directory, options) {
  const manifest = await readManifest(directory);
  await scanBundle(directory, manifest, options);
  return manifest;
}

export async function restoreDerived(db, directory, { signal } = {}) {
  const manifest = await verifyDerivedArchive(directory, { signal });
  const inserted = blankCounts();
  db.exec('BEGIN IMMEDIATE');
  try {
    rejectTriggers(db);
    const present = presentTables(db);
    const insert = new Map();
    for (const { name, columns } of tables) {
      if (!manifest.counts[name]) continue;
      if (!present.has(name)) throw new Error(`Restore database is missing archive table ${name}`);
      insert.set(name, db.prepare(`INSERT OR IGNORE INTO ${name} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`));
    }
    await scanBundle(directory, manifest, { signal, onRow: ({ name }, values) => {
      inserted[name] += insert.get(name).run(...values).changes;
    } });
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return { directory: resolve(directory), ...manifest, inserted, checkpoint: checkpoint(db) };
}

const help = `Usage: node scripts/archive-derived.mjs [--db FILE] --calculation-version VERSION --data-version N
       node scripts/archive-derived.mjs [--db FILE] --calculation-version VERSION --data-version N --apply --output NEW_DIRECTORY
       node scripts/archive-derived.mjs verify DIRECTORY
       node scripts/archive-derived.mjs restore DIRECTORY [--db FILE]

The default mode only counts rows. --apply verifies a private gzip bundle before retiring
the exact selected slice. Restore inserts missing rows into the existing archive tables.`;

async function main() {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string' }, 'calculation-version': { type: 'string' }, 'data-version': { type: 'string' },
    apply: { type: 'boolean' }, output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  const [command, bundle, ...extra] = positionals;
  if (extra.length || (command && (!['verify', 'restore'].includes(command) || !bundle)) ||
    (command && (values.apply || values.output || values['calculation-version'] || values['data-version'])) ||
    (values.output && !values.apply)) throw new Error('Run with --help for archive commands');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let db;
  try {
    if (command === 'verify') {
      console.log(JSON.stringify(await verifyDerivedArchive(bundle, { signal: controller.signal }), null, 2));
      return;
    }
    const selection = { calculationVersion: values['calculation-version'], dataVersion: values['data-version'] };
    if (!command) selectedVersion(selection);
    const filename = resolve(values.db || process.env.MARKET_DB || 'data/market.sqlite');
    const readOnly = !command && !values.apply;
    db = new DatabaseSync(filename, { readOnly: true, timeout: 10_000 });
    if (!readOnly) {
      db.close();
      db = undefined;
      db = new DatabaseSync(filename, { timeout: 10_000 });
    }
    const result = command === 'restore' ? await restoreDerived(db, bundle, { signal: controller.signal }) :
      values.apply ? await archiveDerived(db, { ...selection, output: values.output, signal: controller.signal,
        onProgress: ({ phase, directory }) => console.error(`Archive ${phase}: ${directory}`) }) : countDerivedArchive(db, selection);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db?.close();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
